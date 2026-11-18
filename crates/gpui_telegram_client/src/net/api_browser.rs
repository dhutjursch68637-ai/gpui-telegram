//! Client REST API bindings for Server Browser Control Relay (`/api/v1/browser/*`, Feature F5).

use crate::net::http_client::{HttpClient, HttpClientError};
use crate::net::http_helpers::{decode_json_response, percent_encode_rfc3986};
use gpui_telegram_proto::browser_contracts::{
    BotBrowserProfileDto, BrowserApprovalDecisionDto, BrowserBridgeStatusDto,
    BrowserCommandRequest, BrowserCommandResult, BrowserPairingAction, BrowserPairingDto,
    BrowserPairingRequest, BrowserTabDto, BrowserTabsListResponse, PendingBrowserCommandDto,
    UpdateBotBrowserProfileRequest,
};
use reqwest::{Method, StatusCode};

impl HttpClient {
    /// Queries live browser bridge status (`GET /api/v1/browser/status`).
    pub async fn get_browser_status(
        &self,
        token: &str,
        bot_id: Option<u64>,
    ) -> Result<BrowserBridgeStatusDto, HttpClientError> {
        let path = match bot_id {
            Some(id) => format!("/api/v1/browser/status?bot_id={id}"),
            None => "/api/v1/browser/status".to_string(),
        };
        self.request_json(Method::GET, &path, Some(token), None::<&()>)
            .await
    }

    /// Lists open tabs synced from the user's connected Extension or Desktop bridge (`GET /api/v1/browser/tabs`).
    pub async fn list_browser_tabs(
        &self,
        token: &str,
    ) -> Result<BrowserTabsListResponse, HttpClientError> {
        self.request_json(Method::GET, "/api/v1/browser/tabs", Some(token), None::<&()>)
            .await
    }

    /// Convenience helper returning just the `Vec<BrowserTabDto>` from `/api/v1/browser/tabs`.
    pub async fn list_browser_tab_items(
        &self,
        token: &str,
    ) -> Result<Vec<BrowserTabDto>, HttpClientError> {
        let resp = self.list_browser_tabs(token).await?;
        Ok(resp.tabs)
    }

    /// Dispatches one of the 24 canonical `browser_*` tools via `/api/v1/browser/exec`.
    /// Preserves structured `BrowserCommandResult` payloads (including `-32001..-32008` RPC error codes
    /// and `AskEveryTime` `pending_command_id` metadata) even when the server responds with a 4xx/5xx status,
    /// while surfacing HTTP 401 session authentication failures as `HttpClientError::Unauthorized`.
    pub async fn exec_browser_command(
        &self,
        token: &str,
        req: &BrowserCommandRequest,
    ) -> Result<BrowserCommandResult, HttpClientError> {
        let client = self.client.clone();
        let url = self.endpoint_url("/api/v1/browser/exec");
        let bearer = token.to_string();
        let json_body = serde_json::to_value(req)?;

        self.run_on_tokio(async move {
            let resp = client
                .request(Method::POST, &url)
                .bearer_auth(&bearer)
                .json(&json_body)
                .send()
                .await?;
            let status = resp.status();
            let text = resp.text().await?;
            if status == StatusCode::UNAUTHORIZED {
                return decode_json_response(status, text);
            }
            if let Ok(parsed) = serde_json::from_str::<BrowserCommandResult>(&text) {
                if status.is_success()
                    || parsed.rpc_code.is_some()
                    || parsed.error_code.is_some()
                    || parsed.command_id.is_some()
                {
                    return Ok(parsed);
                }
            }
            decode_json_response(status, text)
        })
        .await
    }

    /// Reads the per-bot browser control profile (`GET /api/v1/bots/{bot_id}/browser`).
    pub async fn get_bot_browser_profile(
        &self,
        token: &str,
        bot_id: u64,
    ) -> Result<BotBrowserProfileDto, HttpClientError> {
        let path = format!("/api/v1/bots/{bot_id}/browser");
        self.request_json(Method::GET, &path, Some(token), None::<&()>)
            .await
    }

    /// Updates the per-bot browser control profile (`PUT /api/v1/bots/{bot_id}/browser`).
    pub async fn update_bot_browser_profile(
        &self,
        token: &str,
        bot_id: u64,
        req: &UpdateBotBrowserProfileRequest,
    ) -> Result<BotBrowserProfileDto, HttpClientError> {
        let path = format!("/api/v1/bots/{bot_id}/browser");
        self.request_json(Method::PUT, &path, Some(token), Some(req))
            .await
    }

    /// Lists pending `AskEveryTime` browser commands awaiting user approval (`GET /api/v1/browser/commands/pending`).
    pub async fn list_pending_browser_commands(
        &self,
        token: &str,
    ) -> Result<Vec<PendingBrowserCommandDto>, HttpClientError> {
        self.request_vec_or_field(
            Method::GET,
            "/api/v1/browser/commands/pending",
            Some(token),
            &["pending_commands", "commands", "items"],
        )
        .await
    }

    /// Approves or rejects a pending `AskEveryTime` browser command (`POST /api/v1/browser/commands/{command_id}/approve`).
    pub async fn approve_browser_command(
        &self,
        token: &str,
        command_id: &str,
        req: &BrowserApprovalDecisionDto,
    ) -> Result<PendingBrowserCommandDto, HttpClientError> {
        let path = format!(
            "/api/v1/browser/commands/{}/approve",
            percent_encode_rfc3986(command_id)
        );
        self.request_json(Method::POST, &path, Some(token), Some(req))
            .await
    }

    /// Issues, rotates, or verifies the user's browser bridge pairing token (`POST /api/v1/browser/pairing`).
    pub async fn manage_browser_pairing(
        &self,
        token: &str,
        req: &BrowserPairingRequest,
    ) -> Result<BrowserPairingDto, HttpClientError> {
        self.request_json(Method::POST, "/api/v1/browser/pairing", Some(token), Some(req))
            .await
    }

    /// Convenience helper returning the active pairing token metadata (`action: Issue`).
    pub async fn get_or_create_browser_pairing(
        &self,
        token: &str,
    ) -> Result<BrowserPairingDto, HttpClientError> {
        self.manage_browser_pairing(
            token,
            &BrowserPairingRequest {
                action: BrowserPairingAction::Issue,
                ..Default::default()
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::TelegramClient;
    use crate::config::ClientConfig;
    use gpui_telegram_proto::browser_contracts::{
        BrowserPreferredTarget, BrowserRpcErrorCode, BrowserRunPolicy,
    };
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_mock_browser_api() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    let raw = String::from_utf8_lossy(&buf[..n]);
                    let first_line = raw.lines().next().unwrap_or("");
                    let (status, body) = if first_line.starts_with("GET /api/v1/browser/status") {
                        (
                            "200 OK",
                            json!({
                                "connected": true,
                                "mode": "server_ws_relay",
                                "run_policy": "always_allow_authorized",
                                "active_tabs": 2,
                                "server_relay_connected": true,
                                "desktop_bridge_connected": false,
                                "local_cdp_available": false,
                                "desktop_bridge_port": 19222,
                                "sessions": [],
                                "pending_approvals": 0
                            })
                            .to_string(),
                        )
                    } else if first_line.starts_with("GET /api/v1/browser/tabs") {
                        (
                            "200 OK",
                            json!({
                                "connected": true,
                                "tabs": [
                                    {
                                        "tab_id": 42,
                                        "window_id": 1,
                                        "active": true,
                                        "title": "Alpha Docs",
                                        "url": "http://127.0.0.1:8080/docs/alpha",
                                        "controllable": true
                                    }
                                ]
                            })
                            .to_string(),
                        )
                    } else if first_line.starts_with("POST /api/v1/browser/exec") {
                        if raw.contains("chrome://settings") {
                            (
                                "403 Forbidden",
                                json!({
                                    "ok": false,
                                    "data": serde_json::Value::Null,
                                    "error_code": "RESTRICTED_URL",
                                    "rpc_code": -32004,
                                    "error_message": "Restricted scheme chrome://",
                                    "executed_via": "policy_gate",
                                    "duration_ms": 1
                                })
                                .to_string(),
                            )
                        } else {
                            (
                                "200 OK",
                                json!({
                                    "ok": true,
                                    "data": { "ok": true, "tab_id": 42, "title": "Opened" },
                                    "executed_via": "server_ws_relay",
                                    "duration_ms": 8
                                })
                                .to_string(),
                            )
                        }
                    } else if first_line.starts_with("PUT /api/v1/bots/777000/browser")
                        || first_line.starts_with("GET /api/v1/bots/777000/browser")
                    {
                        (
                            "200 OK",
                            json!({
                                "bot_id": 777000,
                                "enabled": true,
                                "run_policy": "allow_read_only",
                                "allowed_domains": ["example.com"],
                                "blocked_domains": [],
                                "preferred_target": "auto",
                                "updated_at_ms": 1763399000000_i64
                            })
                            .to_string(),
                        )
                    } else if first_line.starts_with("POST /api/v1/browser/pairing") {
                        (
                            "200 OK",
                            json!({
                                "ok": true,
                                "pairing_token": "pair_tok_abc123",
                                "desktop_ws_url": "ws://127.0.0.1:19222/ext/ws",
                                "server_ws_url": "/api/v1/browser/ws",
                                "verified": true,
                                "created_at_ms": 1763399000000_i64
                            })
                            .to_string(),
                        )
                    } else {
                        ("404 Not Found", json!({"error": "not found"}).to_string())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn test_telegram_client_browser_api_roundtrip() {
        let mut cfg = ClientConfig::default();
        cfg.proxy = None;
        let client = TelegramClient::new(cfg.clone());
        let (base_url, srv_handle) = client.runtime().block_on(spawn_mock_browser_api());

        let mut live_cfg = ClientConfig::default();
        live_cfg.server_url = base_url;
        live_cfg.proxy = None;
        let live_client = TelegramClient::new(live_cfg);
        live_client.set_token(Some("tok_test_browser".to_string()));

        let st = live_client.get_browser_status(None).expect("status");
        assert!(st.connected);
        assert_eq!(st.active_tabs, 2);

        let tabs = live_client.list_browser_tabs().expect("tabs");
        assert_eq!(tabs.tabs.len(), 1);
        assert_eq!(tabs.tabs[0].tab_id, 42);

        let ok_exec = live_client
            .exec_browser_command(&BrowserCommandRequest {
                tool: "browser_open_tab".to_string(),
                arguments: json!({ "url": "https://example.com" }),
                bot_id: Some(777_000),
                timeout_ms: Some(5_000),
                ..Default::default()
            })
            .expect("exec ok");
        assert!(ok_exec.ok);

        let restricted_exec = live_client
            .exec_browser_command(&BrowserCommandRequest {
                tool: "browser_open_tab".to_string(),
                arguments: json!({ "url": "chrome://settings" }),
                bot_id: Some(777_000),
                timeout_ms: Some(5_000),
                ..Default::default()
            })
            .expect("exec structured error");
        assert!(!restricted_exec.ok);
        assert_eq!(
            restricted_exec.rpc_code,
            Some(BrowserRpcErrorCode::RestrictedUrl.code())
        );

        let prof = live_client
            .update_bot_browser_profile(
                777_000,
                &UpdateBotBrowserProfileRequest {
                    enabled: Some(true),
                    run_policy: Some(BrowserRunPolicy::AllowReadOnly),
                    allowed_domains: Some(vec!["example.com".to_string()]),
                    blocked_domains: Some(Vec::new()),
                    preferred_target: Some(BrowserPreferredTarget::Auto),
                },
            )
            .expect("update profile");
        assert_eq!(prof.run_policy, BrowserRunPolicy::AllowReadOnly);

        let pairing = live_client
            .get_or_create_browser_pairing()
            .expect("pairing");
        assert_eq!(pairing.pairing_token, "pair_tok_abc123");

        srv_handle.abort();
    }
}
