use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use gpui_telegram_proto::browser_contracts::{
    sanitize_download_filename, BrowserBridgeStatusDto, BrowserCommandResult,
    BrowserConsoleLogEntryDto, BrowserCookieDto, BrowserElementRefDto, BrowserNetworkLogEntryDto,
    BrowserRpcErrorCode, BrowserRunPolicy, BrowserSnapshotResult, BrowserTabDto,
    BrowserViewportDto, MAX_BROWSER_WS_FRAME_BYTES,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::process::Child;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{
    client_async_with_config, connect_async_with_config, MaybeTlsStream, WebSocketStream,
};

use super::browser_bridge::{to_browser_injection_dto, validate_navigable_browser_url};
use super::security::scan_content_for_injection;

type CdpWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Deserialize)]
struct CdpJsonTarget {
    id: String,
    #[serde(default, rename = "type")]
    target_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    ws_debugger_url: Option<String>,
    #[serde(default, rename = "faviconUrl")]
    favicon_url: Option<String>,
}

#[derive(Debug, Clone)]
struct CdpResolvedTarget {
    tab_id: u64,
    target_id: String,
    title: String,
    url: String,
    ws_url: String,
    favicon_url: Option<String>,
    active: bool,
    group_title: Option<String>,
}

struct ManagedChromiumProc {
    cdp_http_url: String,
    child: Child,
    _profile_dir: tempfile::TempDir,
}

#[derive(Default)]
struct CdpState {
    next_tab_id: u64,
    target_to_tab: HashMap<String, u64>,
    tab_to_target: HashMap<u64, String>,
    active_tab_id: Option<u64>,
    tab_groups: HashMap<u64, String>,
    console_logs: HashMap<u64, Vec<BrowserConsoleLogEntryDto>>,
    network_logs: HashMap<u64, Vec<BrowserNetworkLogEntryDto>>,
    managed_chromium: Option<ManagedChromiumProc>,
    downloads_dir: Option<PathBuf>,
}

/// Authentic Chrome DevTools Protocol (CDP) WebSocket client for standalone/fallback execution
/// of all 24+ canonical `ToolsetId::Browser` tools.
pub struct CdpBrowserManager {
    http: reqwest::Client,
    state: Mutex<CdpState>,
    rpc_seq: AtomicU64,
}

static GLOBAL_CDP_MANAGER: OnceLock<Arc<CdpBrowserManager>> = OnceLock::new();

pub fn global_cdp_manager() -> &'static Arc<CdpBrowserManager> {
    GLOBAL_CDP_MANAGER.get_or_init(|| Arc::new(CdpBrowserManager::new()))
}

impl Default for CdpBrowserManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CdpBrowserManager {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(2000))
            .timeout(Duration::from_millis(5000))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            state: Mutex::new(CdpState {
                next_tab_id: 1,
                ..Default::default()
            }),
            rpc_seq: AtomicU64::new(1),
        }
    }

    /// Normalizes a CDP HTTP or WS endpoint string into an HTTP base URL (`http://host:port`).
    pub fn normalize_cdp_http_base(raw: &str) -> Option<String> {
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("ws://") {
            let host_port = rest.split('/').next().unwrap_or("").trim();
            if host_port.is_empty() {
                return None;
            }
            return Some(format!("http://{host_port}"));
        }
        if let Some(rest) = trimmed.strip_prefix("wss://") {
            let host_port = rest.split('/').next().unwrap_or("").trim();
            if host_port.is_empty() {
                return None;
            }
            return Some(format!("https://{host_port}"));
        }
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let scheme_end = trimmed.find("://").map(|i| i + 3).unwrap_or(0);
            let after_scheme = &trimmed[scheme_end..];
            let host_port = after_scheme.split('/').next().unwrap_or("").trim();
            if host_port.is_empty() {
                return None;
            }
            return Some(format!("{}{}", &trimmed[..scheme_end], host_port));
        }
        Some(format!("http://{trimmed}"))
    }

    /// Resolves the effective CDP HTTP base URL from explicit tool arg, session/context override,
    /// `HERMES_BROWSER_CDP_URL` environment variable, or an active managed Chromium subprocess.
    pub fn resolve_endpoint(
        &self,
        arg_cdp_url: Option<&str>,
        ctx_cdp_url: Option<&str>,
    ) -> Option<String> {
        if let Some(explicit) = arg_cdp_url.and_then(Self::normalize_cdp_http_base) {
            return Some(explicit);
        }
        if let Some(ctx_override) = ctx_cdp_url.and_then(Self::normalize_cdp_http_base) {
            return Some(ctx_override);
        }
        if let Ok(env_val) = std::env::var("HERMES_BROWSER_CDP_URL") {
            if let Some(env_base) = Self::normalize_cdp_http_base(&env_val) {
                return Some(env_base);
            }
        }
        let mut st = self.state.lock();
        if let Some(proc_ref) = st.managed_chromium.as_mut() {
            if proc_ref.child.try_wait().ok().flatten().is_none() {
                return Some(proc_ref.cdp_http_url.clone());
            }
            st.managed_chromium = None;
        }
        None
    }

    pub fn managed_cdp_url(&self) -> Option<String> {
        let mut st = self.state.lock();
        if let Some(proc_ref) = st.managed_chromium.as_mut() {
            if proc_ref.child.try_wait().ok().flatten().is_none() {
                return Some(proc_ref.cdp_http_url.clone());
            }
            st.managed_chromium = None;
        }
        None
    }

    /// Spawns a managed local headless Chromium instance on an ephemeral loopback port (`127.0.0.1:<port>`).
    pub async fn launch_managed_chromium(&self) -> Result<String, String> {
        if let Some(existing) = self.managed_cdp_url() {
            return Ok(existing);
        }

        let candidates = [
            std::env::var("CHROMIUM_BIN").ok(),
            Some("/usr/lib/chromium/chromium".to_string()),
            Some("/usr/bin/chromium".to_string()),
            Some("/usr/bin/chromium-browser".to_string()),
            Some("/usr/bin/google-chrome".to_string()),
            Some("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string()),
        ];

        let bin = candidates
            .into_iter()
            .flatten()
            .find(|p| !p.trim().is_empty() && std::path::Path::new(p).exists())
            .ok_or_else(|| "No local Chromium/Chrome binary found on host".to_string())?;

        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .map_err(|e| format!("Failed to allocate ephemeral port for Chromium CDP: {e}"))?;
            listener
                .local_addr()
                .map_err(|e| format!("Failed to read ephemeral port: {e}"))?
                .port()
        };

        let profile_dir = tempfile::Builder::new()
            .prefix("gpui_managed_chromium_")
            .tempdir()
            .map_err(|e| format!("Failed to create Chromium profile dir: {e}"))?;

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("--headless=new")
            .arg("--no-sandbox")
            .arg("--disable-gpu")
            .arg("--disable-dev-shm-usage")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={}", profile_dir.path().display()))
            .arg("--window-size=1280,800")
            .arg("about:blank")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn managed Chromium ({bin}): {e}"))?;

        let cdp_http_url = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut ready = false;
        while Instant::now() < deadline {
            if let Ok(resp) = self
                .http
                .get(format!("{cdp_http_url}/json/version"))
                .send()
                .await
            {
                if resp.status().is_success() {
                    ready = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }

        if !ready {
            return Err(format!(
                "Managed Chromium started on {cdp_http_url} but /json/version did not become ready within 8s"
            ));
        }

        let mut st = self.state.lock();
        st.managed_chromium = Some(ManagedChromiumProc {
            cdp_http_url: cdp_http_url.clone(),
            child,
            _profile_dir: profile_dir,
        });
        Ok(cdp_http_url)
    }

    pub fn stop_managed_chromium(&self) {
        let mut st = self.state.lock();
        if let Some(mut proc_ref) = st.managed_chromium.take() {
            let _ = proc_ref.child.start_kill();
        }
    }

    async fn fetch_page_targets(
        &self,
        base_url: &str,
    ) -> Result<Vec<CdpResolvedTarget>, (BrowserRpcErrorCode, String)> {
        let list_url = format!("{base_url}/json/list");
        let resp = self.http.get(&list_url).send().await.map_err(|e| {
            (
                BrowserRpcErrorCode::CdpAttachFailed,
                format!(
                    "BROWSER_EXTENSION_NOT_CONNECTED (-32008): No browser extension connected and CDP endpoint {base_url} is unreachable: {e}"
                ),
            )
        })?;

        if !resp.status().is_success() {
            return Err((
                BrowserRpcErrorCode::CdpAttachFailed,
                format!(
                    "BROWSER_EXTENSION_NOT_CONNECTED (-32008): CDP endpoint {base_url}/json/list returned HTTP {}",
                    resp.status()
                ),
            ));
        }

        let raw_targets: Vec<CdpJsonTarget> = resp.json().await.map_err(|e| {
            (
                BrowserRpcErrorCode::CdpAttachFailed,
                format!("Invalid JSON from {list_url}: {e}"),
            )
        })?;

        let mut st = self.state.lock();
        let mut page_targets = Vec::new();
        for t in raw_targets {
            if !t.target_type.is_empty() && t.target_type != "page" {
                continue;
            }
            let ws_url = t.ws_debugger_url.unwrap_or_else(|| {
                let host_port = base_url
                    .trim_start_matches("http://")
                    .trim_start_matches("https://");
                format!("ws://{host_port}/devtools/page/{}", t.id)
            });
            let tab_id = if let Some(&existing) = st.target_to_tab.get(&t.id) {
                existing
            } else {
                let id = st.next_tab_id.max(1);
                st.next_tab_id = id + 1;
                st.target_to_tab.insert(t.id.clone(), id);
                st.tab_to_target.insert(id, t.id.clone());
                id
            };
            let group_title = st.tab_groups.get(&tab_id).cloned();
            page_targets.push(CdpResolvedTarget {
                tab_id,
                target_id: t.id,
                title: t.title,
                url: t.url,
                ws_url,
                favicon_url: t.favicon_url,
                active: false,
                group_title,
            });
        }

        if let Some(active_id) = st.active_tab_id {
            if !page_targets.iter().any(|t| t.tab_id == active_id) {
                st.active_tab_id = page_targets.first().map(|t| t.tab_id);
            }
        } else {
            st.active_tab_id = page_targets.first().map(|t| t.tab_id);
        }

        let active_id = st.active_tab_id;
        for t in &mut page_targets {
            t.active = Some(t.tab_id) == active_id;
        }
        Ok(page_targets)
    }

    async fn create_page_target(
        &self,
        base_url: &str,
        initial_url: &str,
    ) -> Result<CdpResolvedTarget, (BrowserRpcErrorCode, String)> {
        let encoded_url = percent_encode_query_component(initial_url);
        let new_endpoint = format!("{base_url}/json/new?{encoded_url}");

        let mut created: Option<CdpJsonTarget> = None;
        if let Ok(resp) = self.http.put(&new_endpoint).send().await {
            if resp.status().is_success() {
                created = resp.json::<CdpJsonTarget>().await.ok();
            }
        }
        if created.is_none() {
            if let Ok(resp) = self.http.get(&new_endpoint).send().await {
                if resp.status().is_success() {
                    created = resp.json::<CdpJsonTarget>().await.ok();
                }
            }
        }

        if created.is_none() {
            let ver_resp = self
                .http
                .get(format!("{base_url}/json/version"))
                .send()
                .await
                .map_err(|e| {
                    (
                        BrowserRpcErrorCode::CdpAttachFailed,
                        format!("Failed to reach {base_url}/json/version: {e}"),
                    )
                })?;
            let ver_json: Value = ver_resp.json().await.map_err(|e| {
                (
                    BrowserRpcErrorCode::CdpAttachFailed,
                    format!("Invalid /json/version payload: {e}"),
                )
            })?;
            if let Some(browser_ws) = ver_json.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                let mut ws = self.connect_cdp_ws(browser_ws).await?;
                let res = self
                    .cdp_call(
                        &mut ws,
                        "Target.createTarget",
                        json!({ "url": initial_url }),
                        Duration::from_secs(5),
                    )
                    .await?;
                let _ = ws.close(None).await;
                if let Some(tid) = res.get("targetId").and_then(Value::as_str) {
                    let targets = self.fetch_page_targets(base_url).await?;
                    if let Some(found) = targets.into_iter().find(|t| t.target_id == tid) {
                        self.state.lock().active_tab_id = Some(found.tab_id);
                        return Ok(found);
                    }
                }
            }
        }

        if let Some(t) = created {
            let tab_id = {
                let mut st = self.state.lock();
                let id = if let Some(&existing) = st.target_to_tab.get(&t.id) {
                    existing
                } else {
                    let next = st.next_tab_id.max(1);
                    st.next_tab_id = next + 1;
                    st.target_to_tab.insert(t.id.clone(), next);
                    st.tab_to_target.insert(next, t.id.clone());
                    next
                };
                st.active_tab_id = Some(id);
                id
            };
            let ws_url = t.ws_debugger_url.unwrap_or_else(|| {
                let host_port = base_url
                    .trim_start_matches("http://")
                    .trim_start_matches("https://");
                format!("ws://{host_port}/devtools/page/{}", t.id)
            });
            return Ok(CdpResolvedTarget {
                tab_id,
                target_id: t.id,
                title: t.title,
                url: if t.url.is_empty() {
                    initial_url.to_string()
                } else {
                    t.url
                },
                ws_url,
                favicon_url: t.favicon_url,
                active: true,
                group_title: None,
            });
        }

        Err((
            BrowserRpcErrorCode::CdpAttachFailed,
            format!("Failed to create new browser tab via CDP endpoint {base_url}"),
        ))
    }

    async fn resolve_target_or_create(
        &self,
        base_url: &str,
        requested_tab_id: Option<u64>,
        auto_create_if_empty: bool,
    ) -> Result<CdpResolvedTarget, (BrowserRpcErrorCode, String)> {
        let targets = self.fetch_page_targets(base_url).await?;
        if let Some(tab_id) = requested_tab_id {
            return targets
                .into_iter()
                .find(|t| t.tab_id == tab_id)
                .ok_or_else(|| {
                    (
                        BrowserRpcErrorCode::TabNotFound,
                        format!("TAB_NOT_FOUND (-32005): Browser tab {tab_id} does not exist"),
                    )
                });
        }
        if let Some(active) = targets.iter().find(|t| t.active).cloned() {
            return Ok(active);
        }
        if let Some(first) = targets.into_iter().next() {
            self.state.lock().active_tab_id = Some(first.tab_id);
            return Ok(first);
        }
        if auto_create_if_empty {
            return self.create_page_target(base_url, "about:blank").await;
        }
        Err((
            BrowserRpcErrorCode::TabNotFound,
            "TAB_NOT_FOUND (-32005): No open page targets in CDP browser".to_string(),
        ))
    }

    async fn connect_cdp_ws(
        &self,
        ws_url: &str,
    ) -> Result<CdpWsStream, (BrowserRpcErrorCode, String)> {
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = Some(MAX_BROWSER_WS_FRAME_BYTES);
        cfg.max_frame_size = Some(MAX_BROWSER_WS_FRAME_BYTES);

        if ws_url.starts_with("ws://")
            && let Ok(parsed) = reqwest::Url::parse(ws_url)
            && let Some(host) = parsed.host_str()
        {
            let port = parsed.port_or_known_default().unwrap_or(80);
            let host_clean = host.trim_start_matches('[').trim_end_matches(']');
            let addr_str = if host_clean.contains(':') {
                format!("[{host_clean}]:{port}")
            } else {
                format!("{host_clean}:{port}")
            };
            let tcp_fut = async {
                let tcp = TcpStream::connect(&addr_str).await.map_err(|e| {
                    (
                        BrowserRpcErrorCode::CdpAttachFailed,
                        format!("CDP TCP connection failed ({addr_str}): {e}"),
                    )
                })?;
                let _ = tcp.set_nodelay(true);
                let (ws_stream, _) =
                    client_async_with_config(ws_url, MaybeTlsStream::Plain(tcp), Some(cfg))
                        .await
                        .map_err(|e| {
                            (
                                BrowserRpcErrorCode::CdpAttachFailed,
                                format!("CDP WebSocket handshake failed ({ws_url}): {e}"),
                            )
                        })?;
                Ok::<CdpWsStream, (BrowserRpcErrorCode, String)>(ws_stream)
            };
            return tokio::time::timeout(Duration::from_millis(3500), tcp_fut)
                .await
                .map_err(|_| {
                    (
                        BrowserRpcErrorCode::NavigationTimeout,
                        format!("Timed out connecting to CDP WebSocket {ws_url}"),
                    )
                })?;
        }

        let connect_fut = connect_async_with_config(ws_url, Some(cfg), false);
        let (ws_stream, _) = tokio::time::timeout(Duration::from_millis(3500), connect_fut)
            .await
            .map_err(|_| {
                (
                    BrowserRpcErrorCode::NavigationTimeout,
                    format!("Timed out connecting to CDP WebSocket {ws_url}"),
                )
            })?
            .map_err(|e| {
                (
                    BrowserRpcErrorCode::CdpAttachFailed,
                    format!("CDP WebSocket connection failed ({ws_url}): {e}"),
                )
            })?;
        Ok(ws_stream)
    }

    async fn cdp_call(
        &self,
        ws: &mut CdpWsStream,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, (BrowserRpcErrorCode, String)> {
        self.cdp_call_recording(ws, None, method, params, timeout)
            .await
    }

    async fn cdp_call_recording(
        &self,
        ws: &mut CdpWsStream,
        record_tab_id: Option<u64>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, (BrowserRpcErrorCode, String)> {
        let id = self.rpc_seq.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        ws.send(WsMessage::Text(payload.to_string().into()))
            .await
            .map_err(|e| {
                (
                    BrowserRpcErrorCode::CdpAttachFailed,
                    format!("Failed sending CDP command {method}: {e}"),
                )
            })?;

        let wait_fut = async {
            while let Some(frame_res) = ws.next().await {
                let msg = frame_res.map_err(|e| {
                    (
                        BrowserRpcErrorCode::CdpAttachFailed,
                        format!("CDP WebSocket stream error awaiting {method}: {e}"),
                    )
                })?;
                let text = match msg {
                    WsMessage::Text(t) => t.to_string(),
                    WsMessage::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    WsMessage::Ping(p) => {
                        let _ = ws.send(WsMessage::Pong(p)).await;
                        continue;
                    }
                    WsMessage::Close(_) => {
                        return Err((
                            BrowserRpcErrorCode::TabNotFound,
                            format!(
                                "TAB_NOT_FOUND (-32005): CDP target closed while awaiting {method}"
                            ),
                        ));
                    }
                    _ => continue,
                };

                let Ok(val) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };

                if let Some(tab_id) = record_tab_id {
                    self.capture_cdp_event(tab_id, &val);
                }

                if val.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(err_obj) = val.get("error") {
                        let err_msg = err_obj
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("CDP protocol error");
                        return Err((
                            BrowserRpcErrorCode::CdpAttachFailed,
                            format!("CDP {method} error: {err_msg}"),
                        ));
                    }
                    return Ok(val.get("result").cloned().unwrap_or_else(|| json!({})));
                }
            }
            Err((
                BrowserRpcErrorCode::TabNotFound,
                format!("TAB_NOT_FOUND (-32005): CDP socket ended while awaiting {method}"),
            ))
        };

        tokio::time::timeout(timeout, wait_fut).await.map_err(|_| {
            (
                BrowserRpcErrorCode::NavigationTimeout,
                format!("NAVIGATION_TIMEOUT (-32007): CDP {method} timed out after {:?}", timeout),
            )
        })?
    }

    fn capture_cdp_event(&self, tab_id: u64, frame: &Value) {
        let Some(method) = frame.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = frame.get("params").unwrap_or(&Value::Null);
        match method {
            "Runtime.consoleAPICalled" => {
                let level = params
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("log")
                    .to_string();
                let text = params
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| {
                                a.get("value")
                                    .map(|v| {
                                        if let Some(s) = v.as_str() {
                                            s.to_string()
                                        } else {
                                            v.to_string()
                                        }
                                    })
                                    .or_else(|| {
                                        a.get("description")
                                            .and_then(Value::as_str)
                                            .map(ToString::to_string)
                                    })
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                let timestamp_ms = chrono::Utc::now().timestamp_millis();
                let mut st = self.state.lock();
                let buf = st.console_logs.entry(tab_id).or_default();
                buf.push(BrowserConsoleLogEntryDto {
                    timestamp_ms,
                    level,
                    text,
                    url: None,
                    line_number: None,
                });
                if buf.len() > 200 {
                    let drain = buf.len() - 200;
                    buf.drain(0..drain);
                }
            }
            "Network.responseReceived" => {
                if let Some(resp) = params.get("response") {
                    let url = resp
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !url.is_empty() {
                        let status = resp
                            .get("status")
                            .and_then(Value::as_u64)
                            .map(|n| n as u16);
                        let request_id = params
                            .get("requestId")
                            .and_then(Value::as_str)
                            .unwrap_or("cdp_req")
                            .to_string();
                        let resource_type = params
                            .get("type")
                            .and_then(Value::as_str)
                            .map(ToString::to_string);
                        let timestamp_ms = chrono::Utc::now().timestamp_millis();
                        let mut st = self.state.lock();
                        let buf = st.network_logs.entry(tab_id).or_default();
                        buf.push(BrowserNetworkLogEntryDto {
                            request_id,
                            timestamp_ms,
                            method: "GET".to_string(),
                            url,
                            status,
                            resource_type,
                            duration_ms: None,
                            error_text: None,
                        });
                        if buf.len() > 200 {
                            let drain = buf.len() - 200;
                            buf.drain(0..drain);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    async fn eval_js_json(
        &self,
        ws: &mut CdpWsStream,
        tab_id: u64,
        expression: &str,
        timeout: Duration,
    ) -> Result<Value, (BrowserRpcErrorCode, String)> {
        let res = self
            .cdp_call_recording(
                ws,
                Some(tab_id),
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
                timeout,
            )
            .await?;

        if let Some(exc) = res.get("exceptionDetails") {
            let msg = exc
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .or_else(|| exc.get("text").and_then(Value::as_str))
                .unwrap_or("JavaScript runtime exception");
            return Err((
                BrowserRpcErrorCode::InternalError,
                format!("JavaScript evaluation failed: {msg}"),
            ));
        }

        Ok(res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn status(&self, ctx_cdp_url: Option<&str>) -> BrowserBridgeStatusDto {
        let Some(base_url) = self.resolve_endpoint(None, ctx_cdp_url) else {
            return BrowserBridgeStatusDto {
                ok: true,
                connected: false,
                mode: "disconnected".to_string(),
                active_tabs: 0,
                extension_id: None,
                device_id: None,
                run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
                desktop_bridge_connected: false,
                server_relay_connected: false,
                local_cdp_available: false,
                sessions: Vec::new(),
                pending_approvals_count: 0,
            };
        };

        match self.fetch_page_targets(&base_url).await {
            Ok(tabs) => BrowserBridgeStatusDto {
                ok: true,
                connected: true,
                mode: "local_cdp".to_string(),
                active_tabs: tabs.len(),
                extension_id: None,
                device_id: None,
                run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
                desktop_bridge_connected: false,
                server_relay_connected: false,
                local_cdp_available: true,
                sessions: Vec::new(),
                pending_approvals_count: 0,
            },
            Err(_) => BrowserBridgeStatusDto {
                ok: true,
                connected: false,
                mode: "disconnected".to_string(),
                active_tabs: 0,
                extension_id: None,
                device_id: None,
                run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
                desktop_bridge_connected: false,
                server_relay_connected: false,
                local_cdp_available: false,
                sessions: Vec::new(),
                pending_approvals_count: 0,
            },
        }
    }

    pub async fn list_tabs(
        &self,
        ctx_cdp_url: Option<&str>,
    ) -> Result<Vec<BrowserTabDto>, (BrowserRpcErrorCode, String)> {
        let base_url = self.resolve_endpoint(None, ctx_cdp_url).ok_or_else(|| {
            (
                BrowserRpcErrorCode::CdpAttachFailed,
                "BROWSER_EXTENSION_NOT_CONNECTED (-32008): No browser extension connected and no local CDP endpoint configured".to_string(),
            )
        })?;
        let targets = self.fetch_page_targets(&base_url).await?;
        Ok(targets.iter().map(target_to_tab_dto).collect())
    }

    /// Executes any canonical `browser_*` tool directly over Chrome DevTools Protocol.
    pub async fn execute_tool(
        &self,
        tool_name: &str,
        args: &Value,
        ctx_cdp_url: Option<&str>,
    ) -> Result<BrowserCommandResult, (BrowserRpcErrorCode, String)> {
        Box::pin(self.execute_tool_inner(tool_name, args, ctx_cdp_url)).await
    }

    async fn execute_tool_inner(
        &self,
        tool_name: &str,
        args: &Value,
        ctx_cdp_url: Option<&str>,
    ) -> Result<BrowserCommandResult, (BrowserRpcErrorCode, String)> {
        let started = Instant::now();
        let command_id = format!("cdp_{}", uuid::Uuid::new_v4().simple());
        let arg_cdp = args.get("cdp_url").and_then(Value::as_str);
        let base_url = self.resolve_endpoint(arg_cdp, ctx_cdp_url).ok_or_else(|| {
            (
                BrowserRpcErrorCode::CdpAttachFailed,
                "BROWSER_EXTENSION_NOT_CONNECTED (-32008): No browser extension WebSocket session is connected and no reachable local CDP endpoint (HERMES_BROWSER_CDP_URL / /browser cdp <url>) is configured.".to_string(),
            )
        })?;

        let requested_tab_id = args.get("tab_id").and_then(Value::as_u64);
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(15_000)
            .clamp(500, 60_000);
        let op_timeout = Duration::from_millis(timeout_ms);

        let result_val: Value = match tool_name {
            "browser_status" => {
                let st = self.status(Some(&base_url)).await;
                let mut val = serde_json::to_value(&st).unwrap_or_else(|_| json!({}));
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("ok".to_string(), Value::Bool(true));
                    obj.insert("cdp_url".to_string(), Value::String(base_url));
                }
                val
            }
            "browser_list_tabs" => {
                let targets = self.fetch_page_targets(&base_url).await?;
                let tabs: Vec<BrowserTabDto> = targets.iter().map(target_to_tab_dto).collect();
                json!({
                    "ok": true,
                    "tabs": tabs,
                    "count": tabs.len(),
                })
            }
            "browser_get_active_tab" => {
                let target = self
                    .resolve_target_or_create(&base_url, None, true)
                    .await?;
                json!({
                    "ok": true,
                    "tab": target_to_tab_dto(&target),
                })
            }
            "browser_open_tab" => {
                let raw_url = args
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("about:blank");
                let safe_url = validate_navigable_browser_url(raw_url, true)?;
                let mut created = self.create_page_target(&base_url, &safe_url).await?;
                if safe_url != "about:blank" {
                    let mut ws = self.connect_cdp_ws(&created.ws_url).await?;
                    let _ = self
                        .cdp_call(&mut ws, "Page.enable", json!({}), Duration::from_secs(3))
                        .await;
                    let _ = self
                        .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                        .await;
                    if created.url != safe_url {
                        let _ = self
                            .cdp_call(
                                &mut ws,
                                "Page.navigate",
                                json!({ "url": safe_url }),
                                op_timeout,
                            )
                            .await?;
                    }
                    self.wait_for_page_ready(&mut ws, created.tab_id, op_timeout)
                        .await;
                    if let Ok(meta) = self
                        .eval_js_json(
                            &mut ws,
                            created.tab_id,
                            "({ url: String(location.href || ''), title: String(document.title || '') })",
                            Duration::from_secs(3),
                        )
                        .await
                    {
                        if let Some(u) = meta.get("url").and_then(Value::as_str) {
                            created.url = u.to_string();
                        }
                        if let Some(t) = meta.get("title").and_then(Value::as_str) {
                            created.title = t.to_string();
                        }
                    }
                    let _ = ws.close(None).await;
                }
                if args.get("active").and_then(Value::as_bool) != Some(false) {
                    self.state.lock().active_tab_id = Some(created.tab_id);
                }
                json!({
                    "ok": true,
                    "tab_id": created.tab_id,
                    "tab": target_to_tab_dto(&created),
                    "url": created.url,
                    "title": created.title,
                })
            }
            "browser_activate_tab" => {
                let tab_id = requested_tab_id.ok_or_else(|| {
                    (
                        BrowserRpcErrorCode::TabNotFound,
                        "TAB_NOT_FOUND (-32005): tab_id is required for browser_activate_tab"
                            .to_string(),
                    )
                })?;
                let mut target = self
                    .resolve_target_or_create(&base_url, Some(tab_id), false)
                    .await?;
                let _ = self
                    .http
                    .get(format!("{base_url}/json/activate/{}", target.target_id))
                    .send()
                    .await;
                self.state.lock().active_tab_id = Some(tab_id);
                target.active = true;
                json!({
                    "ok": true,
                    "tab_id": tab_id,
                    "tab": target_to_tab_dto(&target),
                })
            }
            "browser_close_tab" => {
                let tab_id = requested_tab_id.ok_or_else(|| {
                    (
                        BrowserRpcErrorCode::TabNotFound,
                        "TAB_NOT_FOUND (-32005): tab_id is required for browser_close_tab"
                            .to_string(),
                    )
                })?;
                let target = self
                    .resolve_target_or_create(&base_url, Some(tab_id), false)
                    .await?;
                let _ = self
                    .http
                    .get(format!("{base_url}/json/close/{}", target.target_id))
                    .send()
                    .await;
                {
                    let mut st = self.state.lock();
                    st.target_to_tab.remove(&target.target_id);
                    st.tab_to_target.remove(&tab_id);
                    st.tab_groups.remove(&tab_id);
                    if st.active_tab_id == Some(tab_id) {
                        st.active_tab_id = None;
                    }
                }
                json!({
                    "ok": true,
                    "closed_tab_id": tab_id,
                })
            }
            "browser_group_tabs" => {
                let tab_ids: Vec<u64> = args
                    .get("tab_ids")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Fabushi Agent")
                    .to_string();
                let color = args
                    .get("color")
                    .and_then(Value::as_str)
                    .unwrap_or("blue")
                    .to_string();
                {
                    let mut st = self.state.lock();
                    for &tid in &tab_ids {
                        st.tab_groups.insert(tid, title.clone());
                    }
                }
                json!({
                    "ok": true,
                    "group_id": 1,
                    "title": title,
                    "color": color,
                    "tab_ids": tab_ids,
                })
            }
            "browser_navigate" => {
                let raw_url = args.get("url").and_then(Value::as_str).unwrap_or("");
                let safe_url = validate_navigable_browser_url(raw_url, true)?;
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                self.state.lock().active_tab_id = Some(target.tab_id);

                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Page.enable", json!({}), Duration::from_secs(3))
                    .await;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;
                let _ = self
                    .cdp_call(&mut ws, "Network.enable", json!({}), Duration::from_secs(3))
                    .await;
                let nav_res = self
                    .cdp_call_recording(
                        &mut ws,
                        Some(target.tab_id),
                        "Page.navigate",
                        json!({ "url": safe_url }),
                        op_timeout,
                    )
                    .await?;
                if let Some(err_txt) = nav_res.get("errorText").and_then(Value::as_str) {
                    if !err_txt.is_empty() && err_txt != "net::ERR_ABORTED" {
                        let _ = ws.close(None).await;
                        return Err((
                            BrowserRpcErrorCode::NavigationTimeout,
                            format!("NAVIGATION_TIMEOUT (-32002): Navigation to {safe_url} failed: {err_txt}"),
                        ));
                    }
                }
                self.wait_for_page_ready(&mut ws, target.tab_id, op_timeout)
                    .await;
                let meta = self
                    .eval_js_json(
                        &mut ws,
                        target.tab_id,
                        "({ url: String(location.href || ''), title: String(document.title || '') })",
                        Duration::from_secs(4),
                    )
                    .await
                    .unwrap_or_else(|_| json!({ "url": safe_url, "title": target.title }));
                let _ = ws.close(None).await;

                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "url": meta.get("url").and_then(Value::as_str).unwrap_or(&safe_url),
                    "title": meta.get("title").and_then(Value::as_str).unwrap_or(""),
                    "status": "complete",
                })
            }
            "browser_reload" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let bypass = args
                    .get("bypass_cache")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Page.enable", json!({}), Duration::from_secs(3))
                    .await;
                let _ = self
                    .cdp_call(
                        &mut ws,
                        "Page.reload",
                        json!({ "ignoreCache": bypass }),
                        op_timeout,
                    )
                    .await?;
                self.wait_for_page_ready(&mut ws, target.tab_id, op_timeout)
                    .await;
                let meta = self
                    .eval_js_json(
                        &mut ws,
                        target.tab_id,
                        "({ url: String(location.href || ''), title: String(document.title || '') })",
                        Duration::from_secs(3),
                    )
                    .await
                    .unwrap_or_else(|_| json!({}));
                let _ = ws.close(None).await;
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "url": meta.get("url").and_then(Value::as_str).unwrap_or(&target.url),
                    "title": meta.get("title").and_then(Value::as_str).unwrap_or(&target.title),
                })
            }
            "browser_back_forward" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let direction = args
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or("back");
                let delta: i64 = if direction.eq_ignore_ascii_case("forward") {
                    1
                } else {
                    -1
                };
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let hist = self
                    .cdp_call(
                        &mut ws,
                        "Page.getNavigationHistory",
                        json!({}),
                        Duration::from_secs(4),
                    )
                    .await?;
                let cur_idx = hist
                    .get("currentIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let entries = hist
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let target_idx = cur_idx + delta;
                if target_idx >= 0 && (target_idx as usize) < entries.len() {
                    if let Some(entry_id) = entries[target_idx as usize]
                        .get("id")
                        .and_then(Value::as_i64)
                    {
                        let _ = self
                            .cdp_call(
                                &mut ws,
                                "Page.navigateToHistoryEntry",
                                json!({ "entryId": entry_id }),
                                op_timeout,
                            )
                            .await?;
                        self.wait_for_page_ready(&mut ws, target.tab_id, op_timeout)
                            .await;
                    }
                }
                let meta = self
                    .eval_js_json(
                        &mut ws,
                        target.tab_id,
                        "({ url: String(location.href || ''), title: String(document.title || '') })",
                        Duration::from_secs(3),
                    )
                    .await
                    .unwrap_or_else(|_| json!({}));
                let _ = ws.close(None).await;
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "direction": direction,
                    "url": meta.get("url").and_then(Value::as_str).unwrap_or(&target.url),
                    "title": meta.get("title").and_then(Value::as_str).unwrap_or(&target.title),
                })
            }
            "browser_snapshot" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                let max_chars = args
                    .get("max_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(12_000)
                    .clamp(256, 100_000) as usize;
                let include_links = args
                    .get("include_links")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let root_selector = args
                    .get("selector")
                    .and_then(Value::as_str)
                    .unwrap_or("");

                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;
                let snap_js = build_snapshot_js(root_selector, max_chars, include_links);
                let raw = self
                    .eval_js_json(&mut ws, target.tab_id, &snap_js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;

                let raw_excerpt = raw
                    .get("markdown_excerpt")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let scan = scan_content_for_injection(raw_excerpt);
                let inj_dto = to_browser_injection_dto(&scan);

                let viewport: BrowserViewportDto = raw
                    .get("viewport")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or(BrowserViewportDto {
                        width: 1280,
                        height: 800,
                        scroll_x: 0.0,
                        scroll_y: 0.0,
                        scroll_height: 800.0,
                    });

                let interactive_elements: Vec<BrowserElementRefDto> = raw
                    .get("interactive_elements")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();

                let links = raw
                    .get("links")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();

                let payload = BrowserSnapshotResult {
                    ok: true,
                    tab_id: target.tab_id,
                    url: raw
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or(&target.url)
                        .to_string(),
                    title: raw
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(&target.title)
                        .to_string(),
                    viewport,
                    interactive_elements,
                    markdown_excerpt: scan.sanitized_text,
                    links,
                    injection_scan: inj_dto,
                };
                let mut v = serde_json::to_value(&payload).unwrap_or_else(|_| json!({}));
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "truncated".to_string(),
                        Value::Bool(
                            raw.get("truncated")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        ),
                    );
                }
                v
            }
            "browser_extract_markdown" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                let max_chars = args
                    .get("max_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(20_000)
                    .clamp(256, 200_000) as usize;
                let root_selector = args
                    .get("selector")
                    .or_else(|| args.get("selector_scope"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;
                let snap_js = build_snapshot_js(root_selector, max_chars, true);
                let raw = self
                    .eval_js_json(&mut ws, target.tab_id, &snap_js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;

                let raw_md = raw
                    .get("markdown_excerpt")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let scan = scan_content_for_injection(raw_md);
                let inj_dto = to_browser_injection_dto(&scan);
                let total_chars = scan.sanitized_text.chars().count();
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "url": raw.get("url").and_then(Value::as_str).unwrap_or(&target.url),
                    "title": raw.get("title").and_then(Value::as_str).unwrap_or(&target.title),
                    "markdown": scan.sanitized_text,
                    "total_chars": total_chars,
                    "truncated": raw.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                    "injection_scan": inj_dto,
                })
            }
            "browser_query_selector" => {
                let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(20)
                    .clamp(1, 200);
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let js = format!(
                    r#"(() => {{
                        const sel = {};
                        const lim = {};
                        const nodes = Array.from(document.querySelectorAll(sel)).slice(0, lim);
                        return nodes.map((el, idx) => {{
                            const r = el.getBoundingClientRect();
                            return {{
                                index: idx,
                                tag: el.tagName.toLowerCase(),
                                id: el.id || null,
                                ref: el.getAttribute('data-hermes-ref') || `q${{idx + 1}}`,
                                text: (el.innerText || el.textContent || '').trim().slice(0, 400),
                                value: 'value' in el ? String(el.value ?? '') : null,
                                href: el.href ? String(el.href) : null,
                                visible: r.width > 0 && r.height > 0,
                                rect: {{ x: r.x, y: r.y, w: r.width, h: r.height }},
                                bbox: {{ x: r.x, y: r.y, width: r.width, height: r.height }}
                            }};
                        }});
                    }})()"#,
                    serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
                    limit
                );
                let matches = self
                    .eval_js_json(&mut ws, target.tab_id, &js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                let count = matches.as_array().map(|a| a.len()).unwrap_or(0);
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "selector": selector,
                    "count": count,
                    "matches": matches,
                })
            }
            "browser_click" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Page.enable", json!({}), Duration::from_secs(3))
                    .await;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;

                if let (Some(x), Some(y)) = (
                    args.get("x").and_then(Value::as_f64),
                    args.get("y").and_then(Value::as_f64),
                ) {
                    if args.get("ref").is_none()
                        && args.get("selector").is_none()
                        && args.get("text").is_none()
                    {
                        let click_count = if args
                            .get("double_click")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            2
                        } else {
                            1
                        };
                        let button = args
                            .get("button")
                            .and_then(Value::as_str)
                            .unwrap_or("left");
                        let _ = self
                            .cdp_call(
                                &mut ws,
                                "Input.dispatchMouseEvent",
                                json!({
                                    "type": "mousePressed",
                                    "x": x,
                                    "y": y,
                                    "button": button,
                                    "clickCount": click_count
                                }),
                                Duration::from_secs(3),
                            )
                            .await?;
                        let _ = self
                            .cdp_call(
                                &mut ws,
                                "Input.dispatchMouseEvent",
                                json!({
                                    "type": "mouseReleased",
                                    "x": x,
                                    "y": y,
                                    "button": button,
                                    "clickCount": click_count
                                }),
                                Duration::from_secs(3),
                            )
                            .await?;
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        let meta = self
                            .eval_js_json(
                                &mut ws,
                                target.tab_id,
                                "({ url: String(location.href || ''), title: String(document.title || '') })",
                                Duration::from_secs(3),
                            )
                            .await
                            .unwrap_or_else(|_| json!({}));
                        let _ = ws.close(None).await;
                        let url_after = meta
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or(&target.url)
                            .to_string();
                        let title_after = meta
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or(&target.title)
                            .to_string();
                        let out = json!({
                            "ok": true,
                            "tab_id": target.tab_id,
                            "clicked": { "x": x, "y": y },
                            "clicked_target": format!("({x}, {y})"),
                            "url": url_after,
                            "url_after": url_after,
                            "title": title_after,
                            "title_after": title_after,
                        });
                        return Ok(BrowserCommandResult {
                            command_id: Some(command_id),
                            ok: true,
                            tab_id: Some(target.tab_id),
                            url: Some(url_after),
                            title: Some(title_after),
                            data: out,
                            artifact: None,
                            error_code: None,
                            rpc_code: None,
                            error_message: None,
                            executed_via: "local_cdp".to_string(),
                            duration_ms: started.elapsed().as_millis() as u64,
                        });
                    }
                }

                let click_js = build_click_js(args);
                let click_res = self
                    .eval_js_json(&mut ws, target.tab_id, &click_js, op_timeout)
                    .await?;
                if click_res.get("found").and_then(Value::as_bool) != Some(true) {
                    let _ = ws.close(None).await;
                    let desc = click_res
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Target element not found");
                    return Err((
                        BrowserRpcErrorCode::ElementNotFound,
                        format!("ELEMENT_NOT_FOUND (-32006): {desc}"),
                    ));
                }

                tokio::time::sleep(Duration::from_millis(160)).await;
                self.wait_for_page_ready(&mut ws, target.tab_id, Duration::from_secs(4))
                    .await;
                let meta = self
                    .eval_js_json(
                        &mut ws,
                        target.tab_id,
                        "({ url: String(location.href || ''), title: String(document.title || '') })",
                        Duration::from_secs(3),
                    )
                    .await
                    .unwrap_or_else(|_| json!({}));
                let _ = ws.close(None).await;

                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "clicked": click_res.get("clicked").cloned().unwrap_or(Value::Null),
                    "url": meta.get("url").and_then(Value::as_str).unwrap_or(&target.url),
                    "title": meta.get("title").and_then(Value::as_str).unwrap_or(&target.title),
                })
            }
            "browser_hover" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let ref_str = args.get("ref").and_then(Value::as_str).unwrap_or("");
                let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
                let js = format!(
                    r#"(() => {{
                        const refId = {};
                        const sel = {};
                        let el = refId ? document.querySelector(`[data-hermes-ref="${{CSS.escape(refId)}}"]`) : null;
                        if (!el && sel) el = document.querySelector(sel);
                        if (!el) return {{ found: false }};
                        el.scrollIntoView({{ block: 'center', inline: 'center' }});
                        const r = el.getBoundingClientRect();
                        const cx = r.left + r.width / 2;
                        const cy = r.top + r.height / 2;
                        for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove']) {{
                            el.dispatchEvent(new MouseEvent(t, {{ bubbles: true, clientX: cx, clientY: cy }}));
                        }}
                        return {{ found: true, x: cx, y: cy, tag: el.tagName.toLowerCase() }};
                    }})()"#,
                    serde_json::to_string(ref_str).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
                );
                let res = self
                    .eval_js_json(&mut ws, target.tab_id, &js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                if res.get("found").and_then(Value::as_bool) != Some(true) {
                    return Err((
                        BrowserRpcErrorCode::ElementNotFound,
                        "ELEMENT_NOT_FOUND (-32006): Hover target element not found".to_string(),
                    ));
                }
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "hovered": res,
                })
            }
            "browser_type" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;
                let type_js = build_react_safe_type_js(args);
                let res = self
                    .eval_js_json(&mut ws, target.tab_id, &type_js, op_timeout)
                    .await?;
                if res.get("found").and_then(Value::as_bool) != Some(true) {
                    let _ = ws.close(None).await;
                    let reason = res
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Input element not found");
                    return Err((
                        BrowserRpcErrorCode::ElementNotFound,
                        format!("ELEMENT_NOT_FOUND (-32006): {reason}"),
                    ));
                }
                if args.get("submit").and_then(Value::as_bool).unwrap_or(false) {
                    tokio::time::sleep(Duration::from_millis(180)).await;
                    self.wait_for_page_ready(&mut ws, target.tab_id, Duration::from_secs(4))
                        .await;
                }
                let _ = ws.close(None).await;
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "typed": res,
                })
            }
            "browser_press_key" => {
                let key = args.get("key").and_then(Value::as_str).unwrap_or("Enter");
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let js = format!(
                    r#"(() => {{
                        const key = {};
                        const el = document.activeElement || document.body;
                        const opts = {{ key, code: key, bubbles: true, cancelable: true }};
                        el.dispatchEvent(new KeyboardEvent('keydown', opts));
                        el.dispatchEvent(new KeyboardEvent('keypress', opts));
                        el.dispatchEvent(new KeyboardEvent('keyup', opts));
                        if (key === 'Enter' && el && el.form) {{
                            if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
                            else el.form.dispatchEvent(new Event('submit', {{ bubbles: true, cancelable: true }}));
                        }}
                        return {{ key, activeTag: el ? el.tagName.toLowerCase() : 'body' }};
                    }})()"#,
                    serde_json::to_string(key).unwrap_or_else(|_| "\"Enter\"".into())
                );
                let res = self
                    .eval_js_json(&mut ws, target.tab_id, &js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "pressed": res,
                })
            }
            "browser_select_option" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let ref_str = args.get("ref").and_then(Value::as_str).unwrap_or("");
                let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
                let val_opt = args.get("value").and_then(Value::as_str);
                let label_opt = args.get("label").and_then(Value::as_str);
                let js = format!(
                    r#"(() => {{
                        const refId = {};
                        const sel = {};
                        const wantVal = {};
                        const wantLabel = {};
                        let el = refId ? document.querySelector(`[data-hermes-ref="${{CSS.escape(refId)}}"]`) : null;
                        if (!el && sel) el = document.querySelector(sel);
                        if (!el || el.tagName.toLowerCase() !== 'select') return {{ found: false }};
                        const opts = Array.from(el.options || []);
                        const match = opts.find(o => (wantVal !== null && o.value === wantVal) || (wantLabel !== null && o.text.trim() === wantLabel));
                        if (!match) return {{ found: false, reason: 'Matching <option> not found' }};
                        const prev = el.value;
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
                        if (setter) setter.call(el, match.value);
                        else el.value = match.value;
                        if (el._valueTracker) el._valueTracker.setValue(prev);
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        return {{ found: true, value: el.value, label: match.text.trim() }};
                    }})()"#,
                    serde_json::to_string(ref_str).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(&val_opt).unwrap_or_else(|_| "null".into()),
                    serde_json::to_string(&label_opt).unwrap_or_else(|_| "null".into()),
                );
                let res = self
                    .eval_js_json(&mut ws, target.tab_id, &js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                if res.get("found").and_then(Value::as_bool) != Some(true) {
                    return Err((
                        BrowserRpcErrorCode::ElementNotFound,
                        "ELEMENT_NOT_FOUND (-32006): Select element or option not found".to_string(),
                    ));
                }
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "selected": res,
                })
            }
            "browser_scroll" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let direction = args
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or("down");
                let amount = args.get("amount").and_then(Value::as_i64).unwrap_or(500);
                let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
                let ref_str = args.get("ref").and_then(Value::as_str).unwrap_or("");
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let js = format!(
                    r#"(() => {{
                        const dir = {};
                        const amt = {};
                        const sel = {};
                        const refId = {};
                        if (refId || sel) {{
                            const el = refId
                                ? document.querySelector(`[data-hermes-ref="${{CSS.escape(refId)}}"]`)
                                : document.querySelector(sel);
                            if (el) el.scrollIntoView({{ behavior: 'instant', block: 'center' }});
                        }} else if (dir === 'top') {{
                            window.scrollTo(0, 0);
                        }} else if (dir === 'bottom') {{
                            window.scrollTo(0, document.documentElement.scrollHeight);
                        }} else {{
                            const dx = dir === 'left' ? -amt : (dir === 'right' ? amt : 0);
                            const dy = dir === 'up' ? -amt : (dir === 'down' ? amt : 0);
                            window.scrollBy(dx, dy);
                        }}
                        return {{
                            scroll_x: Math.round(window.scrollX),
                            scroll_y: Math.round(window.scrollY),
                            width: Math.round(window.innerWidth || 0),
                            height: Math.round(window.innerHeight || 0),
                            scroll_width: Math.round(document.documentElement?.scrollWidth || 0),
                            scroll_height: Math.round(document.documentElement?.scrollHeight || 0),
                        }};
                    }})()"#,
                    serde_json::to_string(direction).unwrap_or_else(|_| "\"down\"".into()),
                    amount,
                    serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(ref_str).unwrap_or_else(|_| "\"\"".into()),
                );
                let res = self
                    .eval_js_json(&mut ws, target.tab_id, &js, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                let sx = res.get("scroll_x").and_then(Value::as_i64).unwrap_or(0);
                let sy = res.get("scroll_y").and_then(Value::as_i64).unwrap_or(0);
                let vw = res.get("width").and_then(Value::as_i64).unwrap_or(1280);
                let vh = res.get("height").and_then(Value::as_i64).unwrap_or(800);
                let sw = res.get("scroll_width").and_then(Value::as_i64).unwrap_or(vw);
                let sh = res.get("scroll_height").and_then(Value::as_i64).unwrap_or(vh);
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "scroll_x": sx,
                    "scroll_y": sy,
                    "viewport": {
                        "width": vw,
                        "height": vh,
                        "scroll_x": sx,
                        "scroll_y": sy,
                        "scroll_width": sw,
                        "scroll_height": sh,
                    }
                })
            }
            "browser_wait_for" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let selector = args.get("selector").and_then(Value::as_str);
                let text_contains = args.get("text_contains").and_then(Value::as_str);
                let url_contains = args.get("url_contains").and_then(Value::as_str);
                let state_mode = args
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("visible");
                let wait_ms = args
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(5_000)
                    .clamp(50, 30_000);

                if selector.is_none() && text_contains.is_none() && url_contains.is_none() {
                    tokio::time::sleep(Duration::from_millis(wait_ms.min(2000))).await;
                    json!({ "ok": true, "tab_id": target.tab_id, "matched": true })
                } else {
                    let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                    let check_js = format!(
                        r#"(() => {{
                            const sel = {};
                            const txt = {};
                            const urlSub = {};
                            const st = {};
                            if (urlSub && !String(location.href || '').includes(urlSub)) return false;
                            if (txt && !String(document.body?.innerText || '').includes(txt)) return false;
                            if (sel) {{
                                const el = document.querySelector(sel);
                                if (st === 'detached') return !el;
                                if (!el) return false;
                                const r = el.getBoundingClientRect();
                                const vis = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
                                if (st === 'hidden') return !vis;
                                if (st === 'visible') return vis;
                            }}
                            return true;
                        }})()"#,
                        serde_json::to_string(&selector).unwrap_or_else(|_| "null".into()),
                        serde_json::to_string(&text_contains).unwrap_or_else(|_| "null".into()),
                        serde_json::to_string(&url_contains).unwrap_or_else(|_| "null".into()),
                        serde_json::to_string(state_mode).unwrap_or_else(|_| "\"visible\"".into()),
                    );
                    let deadline = Instant::now() + Duration::from_millis(wait_ms);
                    let mut matched = false;
                    while Instant::now() < deadline {
                        if let Ok(Value::Bool(true)) = self
                            .eval_js_json(&mut ws, target.tab_id, &check_js, Duration::from_secs(2))
                            .await
                        {
                            matched = true;
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                    let _ = ws.close(None).await;
                    if !matched {
                        return Err((
                            BrowserRpcErrorCode::NavigationTimeout,
                            format!(
                                "NAVIGATION_TIMEOUT (-32002): browser_wait_for condition did not match within {wait_ms}ms"
                            ),
                        ));
                    }
                    json!({
                        "ok": true,
                        "tab_id": target.tab_id,
                        "matched": true,
                    })
                }
            }
            "browser_screenshot" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                let fmt = match args.get("format").and_then(Value::as_str) {
                    Some(f) if f.eq_ignore_ascii_case("jpeg") || f.eq_ignore_ascii_case("jpg") => {
                        "jpeg"
                    }
                    _ => "png",
                };
                let full_page = args
                    .get("full_page")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let quality = args.get("quality").and_then(Value::as_u64).unwrap_or(85);
                let selector = args.get("selector").and_then(Value::as_str);

                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Page.enable", json!({}), Duration::from_secs(3))
                    .await;
                let mut shot_params = json!({
                    "format": fmt,
                    "fromSurface": true,
                    "captureBeyondViewport": full_page,
                });
                if fmt == "jpeg" {
                    shot_params["quality"] = json!(quality.clamp(10, 100));
                }
                if let Some(sel) = selector.filter(|s| !s.trim().is_empty()) {
                    let clip_js = format!(
                        r#"(() => {{
                            const el = document.querySelector({});
                            if (!el) return null;
                            const r = el.getBoundingClientRect();
                            return {{ x: Math.max(0, r.x + window.scrollX), y: Math.max(0, r.y + window.scrollY), width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 }};
                        }})()"#,
                        serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
                    );
                    if let Ok(clip_val) = self
                        .eval_js_json(&mut ws, target.tab_id, &clip_js, Duration::from_secs(3))
                        .await
                    {
                        if clip_val.is_object() {
                            shot_params["clip"] = clip_val;
                        }
                    }
                }

                let shot = self
                    .cdp_call(&mut ws, "Page.captureScreenshot", shot_params, op_timeout)
                    .await?;
                let meta = self
                    .eval_js_json(
                        &mut ws,
                        target.tab_id,
                        "({ url: String(location.href || ''), title: String(document.title || ''), w: window.innerWidth || 1280, h: window.innerHeight || 800 })",
                        Duration::from_secs(3),
                    )
                    .await
                    .unwrap_or_else(|_| json!({}));
                let _ = ws.close(None).await;

                let data_b64 = shot
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if data_b64.is_empty() {
                    return Err((
                        BrowserRpcErrorCode::CdpAttachFailed,
                        "CDP Page.captureScreenshot returned empty image payload".to_string(),
                    ));
                }

                let (width, height) = parse_image_dimensions_from_b64(&data_b64).unwrap_or_else(|| {
                    (
                        meta.get("w").and_then(Value::as_u64).unwrap_or(1280) as u32,
                        meta.get("h").and_then(Value::as_u64).unwrap_or(800) as u32,
                    )
                });
                let mime_type = if fmt == "jpeg" {
                    "image/jpeg"
                } else {
                    "image/png"
                };

                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "url": meta.get("url").and_then(Value::as_str).unwrap_or(&target.url),
                    "title": meta.get("title").and_then(Value::as_str).unwrap_or(&target.title),
                    "mime_type": mime_type,
                    "width": width,
                    "height": height,
                    "data_base64": data_b64,
                })
            }
            "browser_evaluate" => {
                let expr = args
                    .get("expression")
                    .and_then(Value::as_str)
                    .unwrap_or("null");
                let await_promise = args
                    .get("await_promise")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Runtime.enable", json!({}), Duration::from_secs(3))
                    .await;
                let res = self
                    .cdp_call_recording(
                        &mut ws,
                        Some(target.tab_id),
                        "Runtime.evaluate",
                        json!({
                            "expression": expr,
                            "returnByValue": true,
                            "awaitPromise": await_promise,
                        }),
                        op_timeout,
                    )
                    .await?;
                let _ = ws.close(None).await;
                let val = res
                    .get("result")
                    .and_then(|r| r.get("value"))
                    .cloned()
                    .unwrap_or(Value::Null);
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "value": val,
                })
            }
            "browser_get_console_logs" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let clear = args.get("clear").and_then(Value::as_bool).unwrap_or(false);
                let level_filter = args
                    .get("level")
                    .and_then(Value::as_str)
                    .unwrap_or("all")
                    .to_ascii_lowercase();

                let entries = {
                    let mut st = self.state.lock();
                    let list = st.console_logs.entry(target.tab_id).or_default();
                    let filtered: Vec<BrowserConsoleLogEntryDto> = list
                        .iter()
                        .filter(|e| level_filter == "all" || e.level.eq_ignore_ascii_case(&level_filter))
                        .rev()
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    if clear {
                        list.clear();
                    }
                    filtered
                };
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "entries": entries,
                    "logs": entries,
                    "count": entries.len(),
                })
            }
            "browser_get_network_log" => {
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, false)
                    .await?;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                let url_filter = args.get("url_filter").and_then(Value::as_str).unwrap_or("");
                let clear = args.get("clear").and_then(Value::as_bool).unwrap_or(false);

                let mut entries: Vec<BrowserNetworkLogEntryDto> = {
                    let mut st = self.state.lock();
                    let list = st.network_logs.entry(target.tab_id).or_default();
                    let out = list.clone();
                    if clear {
                        list.clear();
                    }
                    out
                };

                if entries.is_empty() {
                    if let Ok(mut ws) = self.connect_cdp_ws(&target.ws_url).await {
                        let perf_js = r#"(() => {
                            try {
                                return performance.getEntriesByType('resource').slice(-50).map((e, idx) => ({
                                    request_id: `res_${idx + 1}`,
                                    timestamp_ms: Date.now(),
                                    method: 'GET',
                                    url: String(e.name || ''),
                                    status: e.responseStatus || 200,
                                    resource_type: String(e.initiatorType || 'other'),
                                    duration_ms: Math.round(e.duration || 0),
                                    error_text: null
                                }));
                            } catch { return []; }
                        })()"#;
                        if let Ok(val) = self
                            .eval_js_json(&mut ws, target.tab_id, perf_js, Duration::from_secs(3))
                            .await
                        {
                            if let Ok(parsed) =
                                serde_json::from_value::<Vec<BrowserNetworkLogEntryDto>>(val)
                            {
                                entries = parsed;
                            }
                        }
                        let _ = ws.close(None).await;
                    }
                }

                if !url_filter.is_empty() {
                    entries.retain(|e| e.url.contains(url_filter));
                }
                if entries.len() > limit {
                    entries = entries.split_off(entries.len() - limit);
                }
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "entries": entries,
                    "count": entries.len(),
                })
            }
            "browser_manage_cookies" => {
                let action = args
                    .get("op")
                    .or_else(|| args.get("action"))
                    .and_then(Value::as_str)
                    .unwrap_or("list");
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let _ = self
                    .cdp_call(&mut ws, "Network.enable", json!({}), Duration::from_secs(3))
                    .await;

                let out = match action {
                    "list" => {
                        let mut p = json!({});
                        if let Some(u) = args.get("url").and_then(Value::as_str) {
                            p["urls"] = json!([u]);
                        }
                        let res = self
                            .cdp_call(&mut ws, "Network.getCookies", p, op_timeout)
                            .await?;
                        let domain_filter = args.get("domain").and_then(Value::as_str);
                        let name_filter = args.get("name").and_then(Value::as_str);
                        let cookies: Vec<BrowserCookieDto> = res
                            .get("cookies")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|c| {
                                        let name = c.get("name")?.as_str()?.to_string();
                                        let domain = c.get("domain")?.as_str()?.to_string();
                                        if let Some(df) = domain_filter {
                                            if !domain.contains(df) {
                                                return None;
                                            }
                                        }
                                        if let Some(nf) = name_filter {
                                            if name != nf {
                                                return None;
                                            }
                                        }
                                        let mut dto = BrowserCookieDto {
                                            name,
                                            value: c
                                                .get("value")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string(),
                                            domain,
                                            secure: c
                                                .get("secure")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false),
                                            http_only: c
                                                .get("httpOnly")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false),
                                            same_site: c
                                                .get("sameSite")
                                                .and_then(Value::as_str)
                                                .map(ToString::to_string),
                                            expiration_date: c
                                                .get("expires")
                                                .and_then(Value::as_f64),
                                            redacted: false,
                                        };
                                        dto.redact_if_http_only();
                                        Some(dto)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        json!({
                            "ok": true,
                            "op": "list",
                            "action": "list",
                            "cookies": cookies,
                            "count": cookies.len(),
                        })
                    }
                    "set" => {
                        let url = args
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or(&target.url);
                        let name = args.get("name").and_then(Value::as_str).unwrap_or("");
                        let value = args.get("value").and_then(Value::as_str).unwrap_or("");
                        let mut p = json!({
                            "url": url,
                            "name": name,
                            "value": value,
                        });
                        if let Some(dom) = args.get("domain").and_then(Value::as_str) {
                            p["domain"] = json!(dom);
                        }
                        if let Some(path) = args.get("path").and_then(Value::as_str) {
                            p["path"] = json!(path);
                        }
                        if let Some(sec) = args.get("secure").and_then(Value::as_bool) {
                            p["secure"] = json!(sec);
                        }
                        if let Some(ho) = args.get("http_only").and_then(Value::as_bool) {
                            p["httpOnly"] = json!(ho);
                        }
                        if let Some(exp) = args.get("expiration_date").and_then(Value::as_f64) {
                            p["expires"] = json!(exp);
                        }
                        let res = self
                            .cdp_call(&mut ws, "Network.setCookie", p, op_timeout)
                            .await?;
                        json!({
                            "ok": res.get("success").and_then(Value::as_bool).unwrap_or(true),
                            "op": "set",
                            "action": "set",
                            "name": name,
                            "affected": 1,
                        })
                    }
                    "delete" => {
                        let name = args.get("name").and_then(Value::as_str).unwrap_or("");
                        let mut p = json!({ "name": name });
                        if let Some(u) = args.get("url").and_then(Value::as_str) {
                            p["url"] = json!(u);
                        } else {
                            p["url"] = json!(target.url);
                        }
                        if let Some(dom) = args.get("domain").and_then(Value::as_str) {
                            p["domain"] = json!(dom);
                        }
                        let _ = self
                            .cdp_call(&mut ws, "Network.deleteCookies", p, op_timeout)
                            .await?;
                        json!({ "ok": true, "op": "delete", "action": "delete", "name": name, "affected": 1 })
                    }
                    "clear_domain" => {
                        let dom = args.get("domain").and_then(Value::as_str).unwrap_or("");
                        let res = self
                            .cdp_call(&mut ws, "Network.getCookies", json!({}), op_timeout)
                            .await?;
                        let mut removed = 0usize;
                        if let Some(arr) = res.get("cookies").and_then(Value::as_array) {
                            for c in arr {
                                let cdom = c.get("domain").and_then(Value::as_str).unwrap_or("");
                                let cname = c.get("name").and_then(Value::as_str).unwrap_or("");
                                if (dom.is_empty() || cdom.contains(dom)) && !cname.is_empty() {
                                    let _ = self
                                        .cdp_call(
                                            &mut ws,
                                            "Network.deleteCookies",
                                            json!({ "name": cname, "domain": cdom }),
                                            Duration::from_secs(3),
                                        )
                                        .await;
                                    removed += 1;
                                }
                            }
                        }
                        json!({ "ok": true, "action": "clear_domain", "removed": removed, "affected": removed })
                    }
                    other => {
                        let _ = ws.close(None).await;
                        return Err((
                            BrowserRpcErrorCode::InvalidParams,
                            format!("Unsupported cookie action: {other}"),
                        ));
                    }
                };
                let _ = ws.close(None).await;
                out
            }
            "browser_download_url" => {
                let raw_url = args.get("url").and_then(Value::as_str).unwrap_or("");
                let safe_url = validate_navigable_browser_url(raw_url, false)?;
                let suggested = args
                    .get("filename")
                    .and_then(Value::as_str)
                    .and_then(sanitize_download_filename)
                    .or_else(|| {
                        let tail = safe_url
                            .split(['?', '#'])
                            .next()
                            .and_then(|p| p.rsplit('/').next())
                            .unwrap_or("download.bin");
                        sanitize_download_filename(tail)
                    })
                    .unwrap_or_else(|| "download.bin".to_string());

                let dl_dir = {
                    let mut st = self.state.lock();
                    if let Some(ref existing) = st.downloads_dir {
                        existing.clone()
                    } else {
                        let dir = std::env::temp_dir().join("gpui_browser_downloads");
                        let _ = std::fs::create_dir_all(&dir);
                        st.downloads_dir = Some(dir.clone());
                        dir
                    }
                };
                let dest = dl_dir.join(&suggested);
                let resp = self.http.get(&safe_url).send().await.map_err(|e| {
                    (
                        BrowserRpcErrorCode::NavigationTimeout,
                        format!("Download request failed for {safe_url}: {e}"),
                    )
                })?;
                let status_code = resp.status().as_u16();
                let bytes = resp.bytes().await.map_err(|e| {
                    (
                        BrowserRpcErrorCode::NavigationTimeout,
                        format!("Failed reading download body from {safe_url}: {e}"),
                    )
                })?;
                tokio::fs::write(&dest, &bytes).await.map_err(|e| {
                    (
                        BrowserRpcErrorCode::InternalError,
                        format!("Failed saving download to {}: {e}", dest.display()),
                    )
                })?;
                let dl_id = self.rpc_seq.fetch_add(1, Ordering::Relaxed);
                json!({
                    "ok": (200..400).contains(&status_code),
                    "download_id": dl_id,
                    "url": safe_url,
                    "filename": suggested,
                    "bytes": bytes.len(),
                    "status": status_code,
                })
            }
            "browser_cdp_send" => {
                let method = args
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("Runtime.evaluate");
                let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
                let target = self
                    .resolve_target_or_create(&base_url, requested_tab_id, true)
                    .await?;
                let mut ws = self.connect_cdp_ws(&target.ws_url).await?;
                let res = self
                    .cdp_call_recording(&mut ws, Some(target.tab_id), method, params, op_timeout)
                    .await?;
                let _ = ws.close(None).await;
                json!({
                    "ok": true,
                    "tab_id": target.tab_id,
                    "method": method,
                    "result": res,
                })
            }
            other => {
                return Err((
                    BrowserRpcErrorCode::MethodNotFound,
                    format!("Unsupported browser tool: {other}"),
                ));
            }
        };

        let resolved_tab_id = result_val
            .get("tab_id")
            .and_then(Value::as_u64)
            .or(requested_tab_id);
        let resolved_url = result_val
            .get("url")
            .or_else(|| result_val.get("url_after"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let resolved_title = result_val
            .get("title")
            .or_else(|| result_val.get("title_after"))
            .and_then(Value::as_str)
            .map(ToString::to_string);

        Ok(BrowserCommandResult {
            command_id: Some(command_id),
            ok: true,
            tab_id: resolved_tab_id,
            url: resolved_url,
            title: resolved_title,
            data: result_val,
            artifact: None,
            error_code: None,
            rpc_code: None,
            error_message: None,
            executed_via: "local_cdp".to_string(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn wait_for_page_ready(&self, ws: &mut CdpWsStream, tab_id: u64, max_wait: Duration) {
        let cap = max_wait.min(Duration::from_secs(6));
        let deadline = Instant::now() + cap;
        while Instant::now() < deadline {
            if let Ok(Value::String(rs)) = self
                .eval_js_json(
                    ws,
                    tab_id,
                    "String(document.readyState || '')",
                    Duration::from_millis(1200),
                )
                .await
            {
                if rs == "complete" {
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }
}

fn target_to_tab_dto(t: &CdpResolvedTarget) -> BrowserTabDto {
    BrowserTabDto {
        tab_id: t.tab_id,
        window_id: 1,
        group_id: t.group_title.as_ref().map(|_| 1),
        active: t.active,
        pinned: false,
        audible: false,
        status: "complete".to_string(),
        title: t.title.clone(),
        url: t.url.clone(),
        controllable: !gpui_telegram_proto::browser_contracts::is_restricted_browser_url(&t.url),
        fav_icon_url: t.favicon_url.clone(),
    }
}

fn percent_encode_query_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

pub fn parse_image_dimensions_from_b64(data_b64: &str) -> Option<(u32, u32)> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .ok()?;
    if bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" && &bytes[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((w, h));
    }
    if bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        let mut i = 2usize;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if marker == 0xFF {
                i += 1;
                continue;
            }
            if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if seg_len < 2 {
                break;
            }
            i += 2 + seg_len;
        }
    }
    None
}

fn build_snapshot_js(root_selector: &str, max_chars: usize, include_links: bool) -> String {
    format!(
        r#"(() => {{
            const rootSel = {root_sel};
            const maxChars = {max_chars};
            const includeLinks = {include_links};
            const root = (rootSel && document.querySelector(rootSel)) || document.body || document.documentElement;

            const isVisible = (el) => {{
                if (!el || typeof el.getBoundingClientRect !== 'function') return false;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }};

            const cssSelectorFor = (el) => {{
                if (el.id) return '#' + CSS.escape(el.id);
                const tag = el.tagName.toLowerCase();
                for (const attr of ['data-sku', 'data-testid', 'data-test', 'name']) {{
                    const v = el.getAttribute(attr);
                    if (v) return `${{tag}}[${{attr}}="${{CSS.escape(v)}}"]`;
                }}
                if (el.className && typeof el.className === 'string') {{
                    const cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
                    if (cls.length > 0) {{
                        const cand = `${{tag}}.${{cls.map(c => CSS.escape(c)).join('.')}}`;
                        if (document.querySelectorAll(cand).length === 1) return cand;
                    }}
                }}
                return tag;
            }};

            const inferRole = (el) => {{
                const explicit = el.getAttribute('role');
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'a') return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'select') return 'combobox';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'input') {{
                    const t = (el.getAttribute('type') || 'text').toLowerCase();
                    if (t === 'checkbox') return 'checkbox';
                    if (t === 'radio') return 'radio';
                    if (t === 'submit' || t === 'button') return 'button';
                    return 'textbox';
                }}
                return tag;
            }};

            const computeLabel = (el) => {{
                const aria = el.getAttribute('aria-label');
                if (aria && aria.trim()) return aria.trim();
                if (el.id) {{
                    const lbl = document.querySelector(`label[for="${{CSS.escape(el.id)}}"]`);
                    if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
                }}
                const parentLabel = el.closest('label');
                if (parentLabel && parentLabel.innerText.trim()) return parentLabel.innerText.trim();
                let txt = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
                const card = el.closest('[data-sku], article, .product-card, .card, li, tr');
                if (card) {{
                    const heading = card.querySelector('h1, h2, h3, h4, [data-title], strong');
                    if (heading && heading.innerText.trim() && !txt.includes(heading.innerText.trim())) {{
                        txt = txt ? `${{txt}} (${{heading.innerText.trim()}})` : heading.innerText.trim();
                    }}
                }}
                return txt.slice(0, 200);
            }};

            const query = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [onclick]';
            const candidates = Array.from(root ? root.querySelectorAll(query) : []);
            const interactive = [];
            let seq = 1;
            for (const el of candidates) {{
                if (!isVisible(el)) continue;
                if (interactive.length >= 250) break;
                const ref = `e${{seq++}}`;
                el.setAttribute('data-hermes-ref', ref);
                const r = el.getBoundingClientRect();
                const tag = el.tagName.toLowerCase();
                interactive.push({{
                    ref,
                    role: inferRole(el),
                    tag,
                    type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
                    label: computeLabel(el),
                    selector: cssSelectorFor(el),
                    value: 'value' in el && el.value !== undefined && tag !== 'button' ? String(el.value) : null,
                    placeholder: el.getAttribute('placeholder') || null,
                    href: el.href ? String(el.href) : null,
                    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
                    checked: typeof el.checked === 'boolean' ? el.checked : null,
                    rect: {{
                        x: Math.round(r.x * 10) / 10,
                        y: Math.round(r.y * 10) / 10,
                        w: Math.round(r.width * 10) / 10,
                        h: Math.round(r.height * 10) / 10
                    }},
                    bbox: {{
                        x: Math.round(r.x * 10) / 10,
                        y: Math.round(r.y * 10) / 10,
                        width: Math.round(r.width * 10) / 10,
                        height: Math.round(r.height * 10) / 10
                    }}
                }});
            }}

            const lines = [];
            if (document.title) lines.push(`# ${{document.title}}`);
            const bodyText = (root ? (root.innerText || root.textContent || '') : '').trim();
            if (bodyText) lines.push(bodyText);
            for (const item of interactive) {{
                lines.push(`[ref=${{item.ref}}] <${{item.tag}} role="${{item.role}}"> ${{item.label}}`);
            }}
            const fullMd = lines.join('\n\n');
            const truncated = fullMd.length > maxChars;
            const markdown_excerpt = truncated ? fullMd.slice(0, maxChars) : fullMd;

            const links = [];
            if (includeLinks && root) {{
                const seen = new Set();
                for (const a of Array.from(root.querySelectorAll('a[href]'))) {{
                    const href = String(a.href || '').trim();
                    if (!href || seen.has(href)) continue;
                    seen.add(href);
                    links.push({{
                        text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
                        href,
                        ref: a.getAttribute('data-hermes-ref') || null
                    }});
                    if (links.length >= 100) break;
                }}
            }}

            return {{
                url: String(location.href || ''),
                title: String(document.title || ''),
                viewport: {{
                    width: window.innerWidth || 1280,
                    height: window.innerHeight || 800,
                    scroll_x: Math.round(window.scrollX || 0),
                    scroll_y: Math.round(window.scrollY || 0),
                    scroll_height: Math.round((document.documentElement && document.documentElement.scrollHeight) || (window.innerHeight || 800)),
                    device_pixel_ratio: window.devicePixelRatio || 1
                }},
                interactive_elements: interactive,
                markdown_excerpt,
                links,
                truncated
            }};
        }})()"#,
        root_sel = serde_json::to_string(root_selector).unwrap_or_else(|_| "\"\"".into()),
        max_chars = max_chars,
        include_links = include_links,
    )
}

fn build_click_js(args: &Value) -> String {
    let ref_str = args.get("ref").and_then(Value::as_str).unwrap_or("");
    let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
    let text = args.get("text").and_then(Value::as_str).unwrap_or("");
    let dbl = args
        .get("double_click")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    format!(
        r#"(() => {{
            const refId = {ref_id};
            const sel = {sel};
            const txt = {txt};
            const dbl = {dbl};
            let el = null;
            if (refId) {{
                el = document.querySelector(`[data-hermes-ref="${{CSS.escape(refId)}}"]`);
            }}
            if (!el && sel) {{
                try {{ el = document.querySelector(sel); }} catch (e) {{
                    return {{ found: false, reason: `Invalid selector '${{sel}}': ${{e.message}}` }};
                }}
            }}
            if (!el && txt) {{
                const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"], label, span, div'));
                el = candidates.find(c => (c.innerText || c.value || '').trim().includes(txt)) || null;
            }}
            if (!el) {{
                return {{ found: false, reason: `No element matched ref='${{refId}}' selector='${{sel}}' text='${{txt}}'` }};
            }}
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            if (typeof el.focus === 'function') el.focus();
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const evInit = {{ bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }};
            el.dispatchEvent(new PointerEvent('pointerdown', evInit));
            el.dispatchEvent(new MouseEvent('mousedown', evInit));
            el.dispatchEvent(new PointerEvent('pointerup', evInit));
            el.dispatchEvent(new MouseEvent('mouseup', evInit));
            if (typeof el.click === 'function') el.click();
            else el.dispatchEvent(new MouseEvent('click', evInit));
            if (dbl) el.dispatchEvent(new MouseEvent('dblclick', evInit));
            return {{
                found: true,
                clicked: {{
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    ref: el.getAttribute('data-hermes-ref') || null,
                    text: (el.innerText || el.value || '').trim().slice(0, 120)
                }}
            }};
        }})()"#,
        ref_id = serde_json::to_string(ref_str).unwrap_or_else(|_| "\"\"".into()),
        sel = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
        txt = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        dbl = dbl,
    )
}

fn build_react_safe_type_js(args: &Value) -> String {
    let ref_str = args.get("ref").and_then(Value::as_str).unwrap_or("");
    let selector = args.get("selector").and_then(Value::as_str).unwrap_or("");
    let text = args.get("text").and_then(Value::as_str).unwrap_or("");
    let clear_first = args
        .get("clear_first")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let submit = args
        .get("submit")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    format!(
        r#"(() => {{
            const refId = {ref_id};
            const sel = {sel};
            const text = {text};
            const clearFirst = {clear_first};
            const submit = {submit};
            let el = null;
            if (refId) {{
                el = document.querySelector(`[data-hermes-ref="${{CSS.escape(refId)}}"]`);
            }}
            if (!el && sel) {{
                try {{ el = document.querySelector(sel); }} catch (e) {{
                    return {{ found: false, reason: `Invalid selector '${{sel}}': ${{e.message}}` }};
                }}
            }}
            if (!el && !refId && !sel && document.activeElement && document.activeElement !== document.body) {{
                el = document.activeElement;
            }}
            if (!el) {{
                return {{ found: false, reason: `Input element not found for ref='${{refId}}' selector='${{sel}}'` }};
            }}
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            if (typeof el.focus === 'function') el.focus();

            if (el.isContentEditable) {{
                el.textContent = clearFirst ? text : (el.textContent || '') + text;
                el.dispatchEvent(new InputEvent('input', {{ bubbles: true, data: text, inputType: 'insertText' }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return {{ found: true, value: el.textContent, submitted: false }};
            }}

            const prevVal = String(el.value ?? '');
            const nextVal = clearFirst ? text : (prevVal + text);
            const proto = el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {{
                nativeSetter.call(el, nextVal);
            }} else {{
                el.value = nextVal;
            }}
            if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {{
                el._valueTracker.setValue(prevVal);
            }}
            el.dispatchEvent(new InputEvent('input', {{ bubbles: true, cancelable: true, data: text, inputType: 'insertText' }}));
            el.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));

            let submitted = false;
            if (submit) {{
                const keyInit = {{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }};
                el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
                el.dispatchEvent(new KeyboardEvent('keypress', keyInit));
                el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
                const form = el.form || el.closest('form');
                if (form) {{
                    if (typeof form.requestSubmit === 'function') {{
                        form.requestSubmit();
                    }} else {{
                        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                        if (submitBtn && typeof submitBtn.click === 'function') submitBtn.click();
                        else form.dispatchEvent(new Event('submit', {{ bubbles: true, cancelable: true }}));
                    }}
                    submitted = true;
                }}
            }}
            return {{
                found: true,
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                value: String(el.value ?? ''),
                submitted
            }};
        }})()"#,
        ref_id = serde_json::to_string(ref_str).unwrap_or_else(|_| "\"\"".into()),
        sel = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into()),
        text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        clear_first = clear_first,
        submit = submit,
    )
}
