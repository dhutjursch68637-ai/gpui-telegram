use std::future::Future;
use std::pin::Pin;

use gpui_telegram_proto::browser_contracts::{
    is_restricted_browser_url, BotBrowserProfileDto, BrowserBridgeStatusDto, BrowserCommandRequest,
    BrowserCommandResult, BrowserInjectionFindingDto, BrowserInjectionScanDto,
    BrowserInjectionSeverity, BrowserRpcErrorCode, BrowserRunPolicy, BrowserTabDto,
};

use super::security::{InjectionScanResult, InjectionSeverity};

pub type BrowserBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Pluggable Browser Control Bridge provider wired into `HermesEngine` and `FabushiBotHost`.
///
/// Implemented by:
/// - `BrowserControlService` in `gpui_telegram_server` (per-user Extension/Desktop WebSocket relay + policy engine)
/// - `DesktopBrowserBridgeProvider` in `gpui_telegram_desktop` (local loopback WebSocket bridge `127.0.0.1:19222`)
pub trait BrowserBridgeProvider: Send + Sync {
    /// Returns live bridge connection status, active tab count, and effective policy for the caller.
    fn status<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<BrowserBridgeStatusDto, String>>;

    /// Lists live browser tabs synchronized over the active Extension/Desktop bridge.
    fn list_tabs<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<Vec<BrowserTabDto>, String>>;

    /// Returns `true` when tool execution MUST go through `self.execute(...)` rather than
    /// falling back directly to `CdpBrowserManager` in `gpui_telegram_agent`.
    ///
    /// Specifically returns `true` when:
    /// - A live Extension or Desktop WebSocket session is connected for `user_id`, OR
    /// - The bot/user profile explicitly disables browser control or requires policy/approval gating
    ///   (so CDP fallback can never bypass `Disabled`, `AllowReadOnly`, `AskEveryTime`, or domain blocks).
    fn should_route_via_bridge(&self, user_id: Option<u64>, bot_id: Option<u64>) -> bool;

    /// Executes a browser tool invocation through the relay/bridge with full policy,
    /// domain allow/blocklist, approval gating, and timeout enforcement.
    fn execute<'a>(
        &'a self,
        user_id: Option<u64>,
        req: BrowserCommandRequest,
    ) -> BrowserBoxFuture<'a, Result<BrowserCommandResult, String>>;

    /// Updates the `BrowserRunPolicy` (and `enabled` state) for a bot or user session.
    fn set_policy<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
        policy: BrowserRunPolicy,
    ) -> BrowserBoxFuture<'a, Result<BotBrowserProfileDto, String>>;

    /// Triggers an immediate emergency kill-switch: sets policy to `Disabled`, aborts in-flight
    /// requests and pending approvals, and broadcasts `bridge.emergency_stop` to connected clients.
    fn emergency_stop<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
        reason: Option<String>,
    ) -> BrowserBoxFuture<'a, Result<(), String>>;
}

/// Validates that a navigation or download target URL is safe (`http://`, `https://`, or `about:blank`)
/// and not on the browser restricted-URL blocklist (`chrome://`, `file://`, Web Store, etc.).
pub fn validate_navigable_browser_url(raw_url: &str, allow_about_blank: bool) -> Result<String, (BrowserRpcErrorCode, String)> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err((
            BrowserRpcErrorCode::RestrictedUrl,
            "RESTRICTED_URL (-32004): URL cannot be empty".to_string(),
        ));
    }

    if is_restricted_browser_url(trimmed) {
        return Err((
            BrowserRpcErrorCode::RestrictedUrl,
            format!(
                "RESTRICTED_URL (-32004): Navigation to restricted URL is forbidden: {trimmed}"
            ),
        ));
    }

    let lower = trimmed.to_ascii_lowercase();
    if allow_about_blank && lower == "about:blank" {
        return Ok("about:blank".to_string());
    }

    if lower.starts_with("http://") || lower.starts_with("https://") {
        let rest = if lower.starts_with("https://") {
            &trimmed[8..]
        } else {
            &trimmed[7..]
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.trim().is_empty() {
            return Err((
                BrowserRpcErrorCode::RestrictedUrl,
                format!("RESTRICTED_URL (-32004): Missing host in URL: {trimmed}"),
            ));
        }
        return Ok(trimmed.to_string());
    }

    Err((
        BrowserRpcErrorCode::RestrictedUrl,
        format!(
            "RESTRICTED_URL (-32004): Unsupported or restricted URL scheme (only http:// or https:// allowed): {trimmed}"
        ),
    ))
}

/// Converts a `SecurityEngine` `InjectionScanResult` into the wire `BrowserInjectionScanDto`.
pub fn to_browser_injection_dto(scan: &InjectionScanResult) -> BrowserInjectionScanDto {
    let severity = match scan.severity {
        InjectionSeverity::High => BrowserInjectionSeverity::High,
        InjectionSeverity::Medium => BrowserInjectionSeverity::Medium,
        InjectionSeverity::Low => BrowserInjectionSeverity::Low,
        InjectionSeverity::None => {
            if scan.secrets_detected > 0 {
                BrowserInjectionSeverity::Medium
            } else {
                BrowserInjectionSeverity::None
            }
        }
    };

    let mut findings: Vec<BrowserInjectionFindingDto> = scan
        .findings
        .iter()
        .map(|f| BrowserInjectionFindingDto {
            rule_id: f.rule_id.clone(),
            severity: match f.severity {
                InjectionSeverity::None => BrowserInjectionSeverity::None,
                InjectionSeverity::Low => BrowserInjectionSeverity::Low,
                InjectionSeverity::Medium => BrowserInjectionSeverity::Medium,
                InjectionSeverity::High => BrowserInjectionSeverity::High,
            },
            description: f.description.clone(),
            matched_excerpt: f.matched_excerpt.clone(),
        })
        .collect();

    if scan.secrets_detected > 0
        && !findings.iter().any(|f| f.rule_id == "secret_redacted")
    {
        findings.push(BrowserInjectionFindingDto {
            rule_id: "secret_redacted".to_string(),
            severity: BrowserInjectionSeverity::Medium,
            description: format!("Redacted {} sensitive credential token(s)", scan.secrets_detected),
            matched_excerpt: "[REDACTED_SECRET]".to_string(),
        });
    }

    BrowserInjectionScanDto {
        flagged: scan.flagged || scan.secrets_detected > 0,
        severity,
        findings,
        secrets_detected: scan.secrets_detected,
    }
}

/// Normalizes canonical and alias browser tool names (`browser_tabs`, `browser_switch_tab`, `browser.cdp_send`).
pub fn canonicalize_browser_tool_name(raw_name: &str) -> Option<&'static str> {
    gpui_telegram_proto::browser_contracts::BrowserToolName::normalize_name(raw_name)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use gpui_telegram_proto::browser_contracts::{
        BrowserArtifactDto, BrowserToolName,
    };
    use serde_json::json;

    use super::*;
    use crate::hermes::security::{SecurityEngine, TirVerdict};
    use crate::hermes::toolsets::{all_builtin_tool_specs, find_tool_spec, ToolsetId};
    use crate::hermes::{HermesEngine, HermesTurnRequest};

    struct MockBridge {
        policy: Mutex<BrowserRunPolicy>,
        stopped: Mutex<bool>,
    }

    impl MockBridge {
        fn new() -> Self {
            Self {
                policy: Mutex::new(BrowserRunPolicy::AlwaysAllowAuthorized),
                stopped: Mutex::new(false),
            }
        }
    }

    impl BrowserBridgeProvider for MockBridge {
        fn status<'a>(
            &'a self,
            _user_id: Option<u64>,
            _bot_id: Option<u64>,
        ) -> BrowserBoxFuture<'a, Result<BrowserBridgeStatusDto, String>> {
            let pol = *self.policy.lock().expect("lock");
            let stopped = *self.stopped.lock().expect("lock");
            Box::pin(async move {
                Ok(BrowserBridgeStatusDto {
                    ok: true,
                    connected: !stopped,
                    active_tabs: 1,
                    run_policy: pol,
                    ..Default::default()
                })
            })
        }

        fn list_tabs<'a>(
            &'a self,
            _user_id: Option<u64>,
            _bot_id: Option<u64>,
        ) -> BrowserBoxFuture<'a, Result<Vec<BrowserTabDto>, String>> {
            Box::pin(async move {
                Ok(vec![BrowserTabDto {
                    tab_id: 42,
                    window_id: 1,
                    url: "https://example.com".to_string(),
                    title: "Example Domain".to_string(),
                    active: true,
                    controllable: true,
                    ..Default::default()
                }])
            })
        }

        fn should_route_via_bridge(&self, _user_id: Option<u64>, _bot_id: Option<u64>) -> bool {
            true
        }

        fn execute<'a>(
            &'a self,
            _user_id: Option<u64>,
            req: BrowserCommandRequest,
        ) -> BrowserBoxFuture<'a, Result<BrowserCommandResult, String>> {
            Box::pin(async move {
                if req.tool == "browser_screenshot" {
                    let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
                    let mut res = BrowserCommandResult::success(json!({
                        "mime_type": "image/png",
                        "data_base64": b64,
                        "width": 1,
                        "height": 1
                    }));
                    res.artifact = Some(BrowserArtifactDto {
                        mime_type: "image/png".to_string(),
                        data_base64: b64.to_string(),
                        name: Some("shot.png".to_string()),
                        width: Some(1),
                        height: Some(1),
                    });
                    res.executed_via = "mock_bridge".to_string();
                    return Ok(res);
                }
                let mut res = BrowserCommandResult::success(json!({
                    "tool": req.tool,
                    "snapshot": "[ref=e1] link \"More information\""
                }));
                res.executed_via = "mock_bridge".to_string();
                Ok(res)
            })
        }

        fn set_policy<'a>(
            &'a self,
            _user_id: Option<u64>,
            bot_id: Option<u64>,
            policy: BrowserRunPolicy,
        ) -> BrowserBoxFuture<'a, Result<BotBrowserProfileDto, String>> {
            *self.policy.lock().expect("lock") = policy;
            Box::pin(async move {
                Ok(BotBrowserProfileDto {
                    bot_id: bot_id.unwrap_or(777000),
                    enabled: policy != BrowserRunPolicy::Disabled,
                    run_policy: policy,
                    ..Default::default()
                })
            })
        }

        fn emergency_stop<'a>(
            &'a self,
            _user_id: Option<u64>,
            _bot_id: Option<u64>,
            _reason: Option<String>,
        ) -> BrowserBoxFuture<'a, Result<(), String>> {
            *self.stopped.lock().expect("lock") = true;
            *self.policy.lock().expect("lock") = BrowserRunPolicy::Disabled;
            Box::pin(async move { Ok(()) })
        }
    }

    #[test]
    fn test_24_canonical_browser_tools_and_security_rules() {
        let defs: Vec<_> = all_builtin_tool_specs()
            .into_iter()
            .filter(|s| s.toolset == ToolsetId::Browser)
            .collect();
        assert_eq!(
            defs.len(),
            BrowserToolName::CANONICAL_TOOLS.len(),
            "ToolsetId::Browser must expose all canonical tools without duplicate alias entries"
        );
        for canonical in BrowserToolName::CANONICAL_TOOLS {
            assert!(
                defs.iter().any(|d| d.name == canonical.as_str()),
                "missing canonical tool {}",
                canonical.as_str()
            );
        }
        for alias in ["browser_tabs", "browser_switch_tab", "browser.cdp_send"] {
            let resolved = find_tool_spec(alias)
                .unwrap_or_else(|| panic!("missing alias resolution for {alias}"));
            assert_eq!(resolved.toolset, ToolsetId::Browser);
            assert_eq!(resolved.name, alias);
        }

        assert_eq!(
            canonicalize_browser_tool_name("browser_tabs"),
            Some("browser_list_tabs")
        );
        assert_eq!(
            canonicalize_browser_tool_name("browser_switch_tab"),
            Some("browser_activate_tab")
        );

        assert!(validate_navigable_browser_url("https://example.com/path", true).is_ok());
        assert!(validate_navigable_browser_url("about:blank", true).is_ok());
        for forbidden in [
            "chrome://extensions",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://chromewebstore.google.com/detail/foo",
        ] {
            let err = validate_navigable_browser_url(forbidden, true).unwrap_err();
            assert_eq!(err.0, BrowserRpcErrorCode::RestrictedUrl);
        }

        let sec = SecurityEngine::new("/tmp");
        assert!(matches!(
            sec.pre_execute_check(
                "browser_download_url",
                &json!({ "url": "https://example.com/report.pdf", "filename": "../../etc/passwd" })
            ),
            TirVerdict::Allow
        ));
        assert!(matches!(
            sec.pre_execute_check(
                "browser_download_url",
                &json!({ "url": "https://example.com/report.pdf", "output_path": "/etc/passwd" })
            ),
            TirVerdict::Block { .. }
        ));
    }

    #[tokio::test]
    async fn test_browser_bridge_provider_and_slash_commands() {
        let engine = HermesEngine::in_memory().expect("in_memory engine");
        let mock = Arc::new(MockBridge::new());
        engine.set_browser_provider(mock.clone());

        let st = engine
            .run_turn(HermesTurnRequest::new("/browser status").with_chat_bot(501, "bot_br"))
            .await
            .expect("status turn");
        assert!(st.response_text.contains("always_allow_authorized"));

        let tabs = engine
            .run_turn(HermesTurnRequest::new("/browser tabs").with_chat_bot(501, "bot_br"))
            .await
            .expect("tabs turn");
        assert!(tabs.response_text.contains("https://example.com"));

        let pol = engine
            .run_turn(
                HermesTurnRequest::new("/browser policy allow_read_only")
                    .with_chat_bot(501, "bot_br"),
            )
            .await
            .expect("policy turn");
        assert!(pol.response_text.contains("allow_read_only"));

        let stop = engine
            .run_turn(HermesTurnRequest::new("/browser stop").with_chat_bot(501, "bot_br"))
            .await
            .expect("stop turn");
        assert!(
            stop.response_text.to_ascii_lowercase().contains("stop")
                || stop.response_text.to_ascii_lowercase().contains("disabled")
        );
        assert!(*mock.stopped.lock().expect("lock"));
    }
}


