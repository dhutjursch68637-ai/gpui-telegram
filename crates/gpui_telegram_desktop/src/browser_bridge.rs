use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use gpui_telegram_agent::hermes::browser_bridge::{
    to_browser_injection_dto, validate_navigable_browser_url, BrowserBoxFuture,
    BrowserBridgeProvider,
};
use gpui_telegram_agent::hermes::browser_cdp::global_cdp_manager;
use gpui_telegram_agent::hermes::security::SecurityEngine;
use gpui_telegram_client::ClientConfig;
use gpui_telegram_proto::browser_contracts::{
    sanitize_download_filename, validate_browser_tool_arguments, BotBrowserProfileDto,
    BridgeEmergencyStopParams, BridgeHelloAckParams, BridgeHelloParams, BridgePingPongParams,
    BridgeTabsSyncParams, BrowserArtifactDto, BrowserBridgeFrame, BrowserBridgeHostKind,
    BrowserBridgeStatusDto, BrowserCallerInfo, BrowserCallerKind, BrowserCommandRequest,
    BrowserCommandResult, BrowserInvokeParams, BrowserJsonRpcError, BrowserJsonRpcId,
    BrowserJsonRpcResponse, BrowserPolicyRisk, BrowserPreferredTarget, BrowserRpcErrorCode,
    BrowserRunPolicy, BrowserSessionDto, BrowserTabDto, BrowserToolName,
    DEFAULT_BRIDGE_PING_INTERVAL_SECS, DEFAULT_BROWSER_INVOKE_TIMEOUT_MS,
    MAX_BROWSER_INVOKE_TIMEOUT_MS, MAX_BROWSER_WS_FRAME_BYTES,
};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use uuid::Uuid;

pub const DEFAULT_DESKTOP_BRIDGE_PORT: u16 = 19222;
pub const BRIDGE_CONFIG_FILENAME: &str = "browser_bridge.json";

/// Persisted loopback bridge discovery configuration written to
/// `${GPUI_TELEGRAM_CONFIG_DIR}/browser_bridge.json` with mode `0600`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedDesktopBridgeConfig {
    pub port: u16,
    pub bridge_port: u16,
    pub pairing_token: String,
    pub ws_url: String,
    pub base_url: String,
    pub updated_at: i64,
}

/// Read-only snapshot of the Desktop Browser Control Bridge state for GPUI views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopBrowserBridgeSnapshot {
    pub running: bool,
    pub port: u16,
    pub base_url: String,
    pub ws_url: String,
    pub config_path: String,
    pub pairing_token: String,
    pub extension_connected: bool,
    pub extension_id: Option<String>,
    pub device_id: Option<String>,
    pub active_tabs: usize,
    pub tabs: Vec<BrowserTabDto>,
    pub run_policy: BrowserRunPolicy,
    pub emergency_stopped: bool,
    pub local_cdp_available: bool,
    pub local_cdp_url: Option<String>,
    pub upstream_server_connected: bool,
    pub last_error: Option<String>,
}

impl Default for DesktopBrowserBridgeSnapshot {
    fn default() -> Self {
        let port = resolve_bridge_port_from_env();
        Self {
            running: false,
            port,
            base_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/ext/ws"),
            config_path: ClientConfig::get_app_dir()
                .join(BRIDGE_CONFIG_FILENAME)
                .to_string_lossy()
                .into_owned(),
            pairing_token: String::new(),
            extension_connected: false,
            extension_id: None,
            device_id: None,
            active_tabs: 0,
            tabs: Vec::new(),
            run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
            emergency_stopped: false,
            local_cdp_available: false,
            local_cdp_url: None,
            upstream_server_connected: false,
            last_error: None,
        }
    }
}

impl DesktopBrowserBridgeSnapshot {
    pub fn masked_token(&self) -> String {
        let tok = self.pairing_token.trim();
        if tok.len() <= 12 {
            if tok.is_empty() {
                "not-initialized".to_string()
            } else {
                tok.to_string()
            }
        } else {
            format!("{}…{}", &tok[..6], &tok[tok.len() - 4..])
        }
    }
}

#[derive(Debug, Clone)]
pub struct DesktopBrowserBridgeStartOptions {
    pub port: u16,
    pub config_dir: PathBuf,
    pub explicit_pairing_token: Option<String>,
}

impl DesktopBrowserBridgeStartOptions {
    pub fn from_env_and_args(args: &[String]) -> Self {
        let mut cli_port: Option<u16> = None;
        let mut i = 1;
        while i < args.len() {
            if args[i] == "--browser-bridge-port" && i + 1 < args.len() {
                if let Ok(p) = args[i + 1].trim().parse::<u16>() {
                    if p > 0 {
                        cli_port = Some(p);
                    }
                }
                i += 1;
            } else if let Some(val) = args[i].strip_prefix("--browser-bridge-port=") {
                if let Ok(p) = val.trim().parse::<u16>() {
                    if p > 0 {
                        cli_port = Some(p);
                    }
                }
            }
            i += 1;
        }

        let port = cli_port.unwrap_or_else(resolve_bridge_port_from_env);
        let explicit_pairing_token = std::env::var("GPUI_BROWSER_BRIDGE_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Self {
            port,
            config_dir: ClientConfig::get_app_dir(),
            explicit_pairing_token,
        }
    }
}

pub fn resolve_bridge_port_from_env() -> u16 {
    std::env::var("GPUI_BROWSER_BRIDGE_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(DEFAULT_DESKTOP_BRIDGE_PORT)
}

fn generate_random_pairing_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::getrandom(&mut buf).is_ok() {
        let mut hex = String::with_capacity(64);
        for b in buf {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{b:02x}");
        }
        hex
    } else {
        format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
    }
}

fn constant_time_token_eq(candidate: &str, expected: &str) -> bool {
    let a = candidate.as_bytes();
    let b = expected.as_bytes();
    if b.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn persist_bridge_config_file(
    config_dir: &Path,
    port: u16,
    pairing_token: &str,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|e| format!("Failed to create config dir {}: {e}", config_dir.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(config_dir, std::fs::Permissions::from_mode(0o700));
    }

    let final_path = config_dir.join(BRIDGE_CONFIG_FILENAME);
    let tmp_path = config_dir.join(format!(
        ".{}.{}.{}.tmp",
        BRIDGE_CONFIG_FILENAME,
        std::process::id(),
        Uuid::new_v4().simple()
    ));

    let payload = PersistedDesktopBridgeConfig {
        port,
        bridge_port: port,
        pairing_token: pairing_token.to_string(),
        ws_url: format!("ws://127.0.0.1:{port}/ext/ws"),
        base_url: format!("http://127.0.0.1:{port}"),
        updated_at: Utc::now().timestamp_millis(),
    };
    let serialized = serde_json::to_vec_pretty(&payload)
        .map_err(|e| format!("Failed to serialize browser_bridge.json: {e}"))?;

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("Failed to open {}: {e}", tmp_path.display()))?;
        f.write_all(&serialized)
            .map_err(|e| format!("Failed to write {}: {e}", tmp_path.display()))?;
        f.sync_all()
            .map_err(|e| format!("Failed to sync {}: {e}", tmp_path.display()))?;
        let _ = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600));
    }

    #[cfg(not(unix))]
    {
        std::fs::write(&tmp_path, &serialized)
            .map_err(|e| format!("Failed to write {}: {e}", tmp_path.display()))?;
    }

    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!(
            "Failed to atomically move {} -> {}: {e}",
            tmp_path.display(),
            final_path.display()
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(final_path)
}

fn load_existing_persisted_token(config_dir: &Path) -> Option<String> {
    let path = config_dir.join(BRIDGE_CONFIG_FILENAME);
    let raw = std::fs::read_to_string(path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    val.get("pairing_token")
        .or_else(|| val.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

struct ExtensionWsSession {
    generation_id: u64,
    session_id: String,
    extension_id: RwLock<String>,
    device_id: RwLock<String>,
    user_agent: RwLock<String>,
    capabilities: RwLock<Vec<String>>,
    reported_policy: RwLock<BrowserRunPolicy>,
    tabs: RwLock<Vec<BrowserTabDto>>,
    connected_at_ms: i64,
    last_seen_ms: AtomicU64,
    outbound_tx: mpsc::UnboundedSender<String>,
}

struct PendingRpcCall {
    generation_id: u64,
    tx: oneshot::Sender<Result<Value, BrowserJsonRpcError>>,
}

#[derive(Default)]
struct UpstreamRelayState {
    server_url: String,
    auth_token: Option<String>,
    connected: bool,
    stop_tx: Option<watch::Sender<bool>>,
}

/// Embedded loopback HTTP + WebSocket Browser Control Bridge (`127.0.0.1:19222`).
pub struct DesktopBrowserBridge {
    port: AtomicU16,
    running: AtomicBool,
    config_dir: RwLock<PathBuf>,
    pairing_token: RwLock<String>,
    run_policy: RwLock<BrowserRunPolicy>,
    emergency_stopped: AtomicBool,
    next_generation_id: AtomicU64,
    next_rpc_seq: AtomicU64,
    active_session: RwLock<Option<Arc<ExtensionWsSession>>>,
    in_flight: Mutex<HashMap<String, PendingRpcCall>>,
    upstream: Mutex<UpstreamRelayState>,
    tabs_notify_tx: watch::Sender<u64>,
    last_error: RwLock<Option<String>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    local_hermes: OnceLock<Arc<gpui_telegram_agent::HermesEngine>>,
}

static GLOBAL_DESKTOP_BRIDGE: OnceLock<Arc<DesktopBrowserBridge>> = OnceLock::new();

pub fn global_desktop_browser_bridge() -> &'static Arc<DesktopBrowserBridge> {
    GLOBAL_DESKTOP_BRIDGE.get_or_init(|| {
        Arc::new(DesktopBrowserBridge::new(
            resolve_bridge_port_from_env(),
            ClientConfig::get_app_dir(),
            std::env::var("GPUI_BROWSER_BRIDGE_TOKEN")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        ))
    })
}

impl DesktopBrowserBridge {
    pub fn new(
        port: u16,
        config_dir: PathBuf,
        explicit_pairing_token: Option<String>,
    ) -> Self {
        let initial_token = explicit_pairing_token
            .filter(|s| !s.trim().is_empty())
            .or_else(|| load_existing_persisted_token(&config_dir))
            .unwrap_or_else(generate_random_pairing_token);

        let (tabs_notify_tx, _) = watch::channel(0u64);

        Self {
            port: AtomicU16::new(port),
            running: AtomicBool::new(false),
            config_dir: RwLock::new(config_dir),
            pairing_token: RwLock::new(initial_token),
            run_policy: RwLock::new(BrowserRunPolicy::AlwaysAllowAuthorized),
            emergency_stopped: AtomicBool::new(false),
            next_generation_id: AtomicU64::new(1),
            next_rpc_seq: AtomicU64::new(1),
            active_session: RwLock::new(None),
            in_flight: Mutex::new(HashMap::new()),
            upstream: Mutex::new(UpstreamRelayState::default()),
            tabs_notify_tx,
            last_error: RwLock::new(None),
            shutdown_tx: Mutex::new(None),
            local_hermes: OnceLock::new(),
        }
    }

    /// Returns Desktop's embedded `HermesEngine` wired with `DesktopBrowserBridgeProvider`.
    pub fn local_hermes_engine(self: &Arc<Self>) -> Option<Arc<gpui_telegram_agent::HermesEngine>> {
        if let Some(existing) = self.local_hermes.get() {
            return Some(Arc::clone(existing));
        }
        let cfg_dir = self.config_dir.read().clone();
        let engine = gpui_telegram_agent::HermesEngine::open(cfg_dir.join("hermes_desktop"), &cfg_dir)
            .or_else(|_| gpui_telegram_agent::HermesEngine::in_memory())
            .ok()?;
        engine.set_browser_provider(Arc::new(DesktopBrowserBridgeProvider::new(Arc::clone(self))));
        let arc_engine = Arc::new(engine);
        let _ = self.local_hermes.set(Arc::clone(&arc_engine));
        Some(arc_engine)
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn pairing_token(&self) -> String {
        self.pairing_token.read().clone()
    }

    pub fn config_file_path(&self) -> PathBuf {
        self.config_dir.read().join(BRIDGE_CONFIG_FILENAME)
    }

    pub fn snapshot(&self) -> DesktopBrowserBridgeSnapshot {
        let port = self.port();
        let config_path = self.config_file_path().to_string_lossy().into_owned();
        let pairing_token = self.pairing_token();
        let run_policy = *self.run_policy.read();
        let emergency_stopped = self.emergency_stopped.load(Ordering::Acquire);
        let cdp_url = global_cdp_manager().resolve_endpoint(None, None);
        let local_cdp_available = cdp_url.is_some();
        let upstream_server_connected = self.upstream.lock().connected;
        let last_error = self.last_error.read().clone();

        if let Some(sess) = self.active_session.read().clone() {
            let tabs = sess.tabs.read().clone();
            let ext_id = sess.extension_id.read().clone();
            let dev_id = sess.device_id.read().clone();
            DesktopBrowserBridgeSnapshot {
                running: self.is_running(),
                port,
                base_url: format!("http://127.0.0.1:{port}"),
                ws_url: format!("ws://127.0.0.1:{port}/ext/ws"),
                config_path,
                pairing_token,
                extension_connected: true,
                extension_id: (!ext_id.is_empty()).then_some(ext_id),
                device_id: (!dev_id.is_empty()).then_some(dev_id),
                active_tabs: tabs.len(),
                tabs,
                run_policy,
                emergency_stopped,
                local_cdp_available,
                local_cdp_url: cdp_url,
                upstream_server_connected,
                last_error,
            }
        } else {
            DesktopBrowserBridgeSnapshot {
                running: self.is_running(),
                port,
                base_url: format!("http://127.0.0.1:{port}"),
                ws_url: format!("ws://127.0.0.1:{port}/ext/ws"),
                config_path,
                pairing_token,
                extension_connected: false,
                extension_id: None,
                device_id: None,
                active_tabs: 0,
                tabs: Vec::new(),
                run_policy,
                emergency_stopped,
                local_cdp_available,
                local_cdp_url: cdp_url,
                upstream_server_connected,
                last_error,
            }
        }
    }

    pub fn build_router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/health", get(http_health))
            .route("/json/list", get(http_json_list))
            .route("/ext/ws", get(http_ext_ws))
            .route("/exec", post(http_exec))
            .route("/api/v1/browser/exec", post(http_exec))
            .route("/ext/exec", post(http_exec))
            .route("/invoke", post(http_exec))
            .route("/rpc", post(http_rpc))
            .layer(DefaultBodyLimit::max(40 * 1024 * 1024))
            .with_state(Arc::clone(self))
    }

    /// Starts the loopback HTTP/WebSocket server on `127.0.0.1:<port>` (pass `port = 0` in tests
    /// for OS-assigned ephemeral loopback port) and atomically writes `browser_bridge.json`.
    pub async fn start_loopback_server(
        self: &Arc<Self>,
        opts: DesktopBrowserBridgeStartOptions,
    ) -> Result<u16, String> {
        if self.is_running() {
            return Ok(self.port());
        }

        {
            *self.config_dir.write() = opts.config_dir.clone();
            if let Some(tok) = opts.explicit_pairing_token.filter(|s| !s.trim().is_empty()) {
                *self.pairing_token.write() = tok;
            } else if let Some(existing) = load_existing_persisted_token(&opts.config_dir) {
                *self.pairing_token.write() = existing;
            }
        }

        let bind_addr = SocketAddr::from(([127, 0, 0, 1], opts.port));
        let listener = tokio::net::TcpListener::bind(bind_addr)
            .await
            .map_err(|e| {
                let msg = format!("Failed to bind Desktop Browser Bridge on {bind_addr}: {e}");
                *self.last_error.write() = Some(msg.clone());
                msg
            })?;

        let actual_port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(opts.port);
        self.port.store(actual_port, Ordering::Release);

        let token_now = self.pairing_token();
        persist_bridge_config_file(&opts.config_dir, actual_port, &token_now)?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shutdown_tx.lock() = Some(shutdown_tx);
        self.running.store(true, Ordering::Release);
        *self.last_error.write() = None;

        let router = self.build_router();
        let bridge_ref = Arc::clone(self);

        tokio::spawn(async move {
            let serve_res = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
            bridge_ref.running.store(false, Ordering::Release);
            if let Err(err) = serve_res {
                *bridge_ref.last_error.write() =
                    Some(format!("Desktop Browser Bridge server error: {err}"));
            }
        });

        Ok(actual_port)
    }

    pub fn stop(&self) {
        if let Some(tx) = self.shutdown_tx.lock().take() {
            let _ = tx.send(());
        }
        if let Some(stop_up) = self.upstream.lock().stop_tx.take() {
            let _ = stop_up.send(true);
        }
        self.running.store(false, Ordering::Release);
    }

    pub fn rotate_pairing_token(&self) -> Result<String, String> {
        let new_token = generate_random_pairing_token();
        *self.pairing_token.write() = new_token.clone();
        let cfg_dir = self.config_dir.read().clone();
        let port = self.port();
        persist_bridge_config_file(&cfg_dir, port, &new_token)?;

        // Disconnect existing session so it must re-authenticate with the rotated token
        if let Some(old) = self.active_session.write().take() {
            let stop_frame = BrowserBridgeFrame::emergency_stop(
                Some("Pairing token rotated on Desktop".to_string()),
                Utc::now().timestamp_millis(),
            );
            if let Ok(raw) = stop_frame.to_json_string() {
                let _ = old.outbound_tx.send(raw);
            }
            self.abort_in_flight_for_generation(
                old.generation_id,
                BrowserRpcErrorCode::UnauthorizedBridge,
                "Pairing token rotated",
            );
        }
        self.bump_tabs_notify();
        Ok(new_token)
    }

    pub fn set_run_policy(&self, policy: BrowserRunPolicy) {
        *self.run_policy.write() = policy;
        if policy != BrowserRunPolicy::Disabled {
            self.emergency_stopped.store(false, Ordering::Release);
        }
        self.bump_tabs_notify();
    }

    pub fn trigger_emergency_stop(&self, reason: Option<String>) {
        self.trigger_emergency_stop_internal(reason, true);
    }

    fn trigger_emergency_stop_internal(&self, reason: Option<String>, notify_extension: bool) {
        *self.run_policy.write() = BrowserRunPolicy::Disabled;
        self.emergency_stopped.store(true, Ordering::Release);

        let msg = reason
            .clone()
            .unwrap_or_else(|| "Emergency stop activated by user".to_string());

        if notify_extension {
            if let Some(sess) = self.active_session.read().clone() {
                let frame =
                    BrowserBridgeFrame::emergency_stop(Some(msg.clone()), Utc::now().timestamp_millis());
                if let Ok(raw) = frame.to_json_string() {
                    let _ = sess.outbound_tx.send(raw);
                }
            }
        }

        let mut in_flight = self.in_flight.lock();
        for (_, waiter) in in_flight.drain() {
            let _ = waiter.tx.send(Err(BrowserJsonRpcError::from_code(
                BrowserRpcErrorCode::PolicyDisabled,
                format!("POLICY_DISABLED (-32003): Aborted by emergency stop ({msg})"),
            )));
        }
        drop(in_flight);
        self.bump_tabs_notify();
    }

    pub async fn launch_managed_chromium(&self) -> Result<String, String> {
        match global_cdp_manager().launch_managed_chromium().await {
            Ok(url) => {
                *self.last_error.write() = None;
                self.bump_tabs_notify();
                Ok(url)
            }
            Err(err) => {
                *self.last_error.write() = Some(err.clone());
                Err(err)
            }
        }
    }

    /// Starts or updates the outbound Desktop -> Server `/api/v1/browser/ws?client=desktop` relay
    /// whenever an authenticated user token is available.
    pub fn connect_upstream_server(self: &Arc<Self>, server_url: String, auth_token: Option<String>) {
        let clean_url = server_url.trim().trim_end_matches('/').to_string();
        let clean_tok = auth_token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        {
            let mut up = self.upstream.lock();
            if up.server_url == clean_url && up.auth_token == clean_tok && up.stop_tx.is_some() {
                return;
            }
            if let Some(prev_stop) = up.stop_tx.take() {
                let _ = prev_stop.send(true);
            }
            up.server_url = clean_url.clone();
            up.auth_token = clean_tok.clone();
            up.connected = false;
        }

        let Some(token) = clean_tok else {
            return;
        };
        if clean_url.is_empty() {
            return;
        }

        let (stop_tx, mut stop_rx) = watch::channel(false);
        self.upstream.lock().stop_tx = Some(stop_tx);

        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let mut backoff_ms = 500u64;
            loop {
                if *stop_rx.borrow() {
                    break;
                }

                let ws_base = if let Some(rest) = clean_url.strip_prefix("https://") {
                    format!("wss://{rest}")
                } else if let Some(rest) = clean_url.strip_prefix("http://") {
                    format!("ws://{rest}")
                } else {
                    format!("ws://{clean_url}")
                };
                let ws_url = format!(
                    "{ws_base}/api/v1/browser/ws?token={}&client=desktop",
                    percent_encode_query_val(&token)
                );

                let connect_res = connect_ws_bypassing_proxy_for_loopback(&ws_url).await;
                match connect_res {
                    Ok(ws_stream) => {
                        backoff_ms = 500;
                        bridge.upstream.lock().connected = true;
                        let _ = run_upstream_ws_loop(&bridge, ws_stream, &mut stop_rx).await;
                        bridge.upstream.lock().connected = false;
                    }
                    Err(err) => {
                        bridge.upstream.lock().connected = false;
                        tracing::debug!("Desktop upstream browser WS connect deferred: {err}");
                    }
                }

                if *stop_rx.borrow() {
                    break;
                }

                tokio::select! {
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
                }
                backoff_ms = (backoff_ms * 2).min(8_000);
            }
        });
    }

    fn bump_tabs_notify(&self) {
        let next = self.tabs_notify_tx.borrow().wrapping_add(1);
        let _ = self.tabs_notify_tx.send(next);
    }

    fn abort_in_flight_for_generation(
        &self,
        generation_id: u64,
        code: BrowserRpcErrorCode,
        reason: &str,
    ) {
        let mut map = self.in_flight.lock();
        let keys: Vec<String> = map
            .iter()
            .filter_map(|(k, v)| (v.generation_id == generation_id).then(|| k.clone()))
            .collect();
        for k in keys {
            if let Some(waiter) = map.remove(&k) {
                let _ = waiter.tx.send(Err(BrowserJsonRpcError::from_code(
                    code,
                    format!("{} ({}): {}", code.as_str(), code.code(), reason),
                )));
            }
        }
    }

    pub async fn execute_command(&self, mut req: BrowserCommandRequest) -> BrowserCommandResult {
        let started = Instant::now();
        let command_id = req
            .command_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("desk_cmd_{}", Uuid::new_v4().simple()));

        let Some(tool_enum) = BrowserToolName::parse(&req.tool) else {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::MethodNotFound,
                format!("METHOD_NOT_FOUND (-32601): Unknown browser tool '{}'", req.tool),
            );
            fail.command_id = Some(command_id);
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return fail;
        };
        let canonical_tool = tool_enum.as_str().to_string();

        if req.arguments.is_null() {
            req.arguments = json!({});
        }
        if let Err(arg_err) = validate_browser_tool_arguments(&req.arguments) {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::InvalidParams,
                format!("INVALID_PARAMS (-32602): {arg_err}"),
            );
            fail.command_id = Some(command_id);
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return fail;
        }

        // Validate URL arguments & sanitize download filenames before dispatching
        match tool_enum {
            BrowserToolName::BrowserOpenTab => {
                if let Some(raw_url) = req.arguments.get("url").and_then(Value::as_str) {
                    if !raw_url.trim().is_empty() {
                        if let Err((code, msg)) = validate_navigable_browser_url(raw_url, true) {
                            let mut fail = BrowserCommandResult::failure(code, msg);
                            fail.command_id = Some(command_id);
                            fail.duration_ms = started.elapsed().as_millis() as u64;
                            return fail;
                        }
                    }
                }
            }
            BrowserToolName::BrowserNavigate
            | BrowserToolName::BrowserManageCookies
            | BrowserToolName::BrowserDownloadUrl => {
                let raw_url = req
                    .arguments
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let allow_blank = tool_enum == BrowserToolName::BrowserNavigate;
                if let Err((code, msg)) = validate_navigable_browser_url(raw_url, allow_blank) {
                    let mut fail = BrowserCommandResult::failure(code, msg);
                    fail.command_id = Some(command_id);
                    fail.duration_ms = started.elapsed().as_millis() as u64;
                    return fail;
                }
                if tool_enum == BrowserToolName::BrowserDownloadUrl {
                    if let Some(obj) = req.arguments.as_object_mut() {
                        if let Some(raw_fn) = obj
                            .get("filename")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                        {
                            match sanitize_download_filename(&raw_fn) {
                                Some(clean) => {
                                    obj.insert("filename".to_string(), Value::String(clean));
                                }
                                None => {
                                    obj.remove("filename");
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        let policy = *self.run_policy.read();
        let stopped = self.emergency_stopped.load(Ordering::Acquire);

        if stopped || policy == BrowserRunPolicy::Disabled {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::PolicyDisabled,
                "POLICY_DISABLED (-32003): Browser control is disabled on Desktop Bridge",
            );
            fail.command_id = Some(command_id);
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return fail;
        }

        // Fast-path `browser_status` directly from live bridge snapshot
        if tool_enum == BrowserToolName::BrowserStatus {
            let snap = self.snapshot();
            let connected = snap.extension_connected || snap.local_cdp_available;
            let mode = if snap.extension_connected {
                "desktop_bridge"
            } else if snap.local_cdp_available {
                "local_cdp"
            } else {
                "disconnected"
            };
            let data = json!({
                "ok": true,
                "connected": connected,
                "extension_connected": snap.extension_connected,
                "mode": mode,
                "host_kind": "desktop",
                "port": snap.port,
                "active_tabs": snap.active_tabs,
                "extension_id": snap.extension_id,
                "device_id": snap.device_id,
                "run_policy": snap.run_policy,
                "desktop_bridge_connected": snap.extension_connected,
                "server_relay_connected": snap.upstream_server_connected,
                "local_cdp_available": snap.local_cdp_available,
            });
            let mut ok_res = BrowserCommandResult::success(data);
            ok_res.command_id = Some(command_id);
            ok_res.executed_via = mode.to_string();
            ok_res.duration_ms = started.elapsed().as_millis() as u64;
            return ok_res;
        }

        if policy == BrowserRunPolicy::AllowReadOnly
            && tool_enum.risk() != BrowserPolicyRisk::ReadOnly
        {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::PolicyDisabled,
                "POLICY_DISABLED (-32003): Mutating browser command blocked under allow_read_only policy",
            );
            fail.command_id = Some(command_id);
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return fail;
        }

        if policy == BrowserRunPolicy::AskEveryTime {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::UserDeniedApproval,
                "USER_DENIED_APPROVAL (-32002): Desktop Bridge policy is ask_every_time; interactive approval required",
            );
            fail.command_id = Some(command_id);
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return fail;
        }

        let timeout_ms = req
            .timeout_ms
            .unwrap_or(DEFAULT_BROWSER_INVOKE_TIMEOUT_MS)
            .clamp(200, MAX_BROWSER_INVOKE_TIMEOUT_MS);

        // Primary execution: paired Extension WebSocket session
        let active_sess = self.active_session.read().clone();
        let mut cmd_res = if let Some(sess) = active_sess {
            let caller = BrowserCallerInfo {
                kind: if req.bot_id.is_some() {
                    BrowserCallerKind::Bot
                } else {
                    BrowserCallerKind::Desktop
                },
                user_id: None,
                bot_id: req.bot_id,
                bot_name: req.bot_name.clone(),
                chat_id: req.chat_id,
            };
            self.invoke_extension_session(&sess, &canonical_tool, req.arguments.clone(), caller, timeout_ms)
                .await
        } else {
            let arg_cdp = req.arguments.get("cdp_url").and_then(Value::as_str);
            if global_cdp_manager().resolve_endpoint(arg_cdp, None).is_some() {
                match global_cdp_manager()
                    .execute_tool(&canonical_tool, &req.arguments, None)
                    .await
                {
                    Ok(mut res) => {
                        if res.executed_via.is_empty() {
                            res.executed_via = "local_cdp".to_string();
                        }
                        res
                    }
                    Err((code, msg)) => BrowserCommandResult::failure(code, msg),
                }
            } else {
                BrowserCommandResult::failure(
                    BrowserRpcErrorCode::CdpAttachFailed,
                    "CDP_ATTACH_FAILED (-32008): No browser extension paired with Desktop Loopback Bridge and no local Chromium CDP active",
                )
            }
        };

        if cmd_res.ok {
            self.post_process_tool_result(tool_enum, &mut cmd_res);
        }

        cmd_res.command_id = Some(command_id);
        cmd_res.duration_ms = started.elapsed().as_millis() as u64;
        cmd_res
    }

    async fn invoke_extension_session(
        &self,
        sess: &Arc<ExtensionWsSession>,
        canonical_tool: &str,
        arguments: Value,
        caller: BrowserCallerInfo,
        timeout_ms: u64,
    ) -> BrowserCommandResult {
        let seq = self.next_rpc_seq.fetch_add(1, Ordering::Relaxed);
        let rpc_id = format!("desk_rpc_{}_{}", sess.generation_id, seq);

        let frame = BrowserBridgeFrame::invoke(
            rpc_id.clone(),
            BrowserInvokeParams {
                tool: canonical_tool.to_string(),
                arguments,
                caller,
                timeout_ms,
                approved: true,
            },
        );
        let raw_frame = match frame.to_json_string() {
            Ok(s) => s,
            Err(e) => {
                return BrowserCommandResult::failure(
                    BrowserRpcErrorCode::InternalError,
                    format!("Failed to serialize browser.invoke frame: {e}"),
                );
            }
        };

        let (tx, rx) = oneshot::channel();
        self.in_flight.lock().insert(
            rpc_id.clone(),
            PendingRpcCall {
                generation_id: sess.generation_id,
                tx,
            },
        );

        if sess.outbound_tx.send(raw_frame).is_err() {
            self.in_flight.lock().remove(&rpc_id);
            return BrowserCommandResult::failure(
                BrowserRpcErrorCode::CdpAttachFailed,
                "CDP_ATTACH_FAILED (-32008): Extension WebSocket channel closed",
            );
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(mut val))) => {
                if let Some(obj) = val.as_object_mut() {
                    obj.entry("ok".to_string()).or_insert(Value::Bool(true));
                }
                let tab_id = val
                    .get("tab_id")
                    .and_then(Value::as_u64)
                    .or_else(|| val.get("tab").and_then(|t| t.get("tab_id")).and_then(Value::as_u64));
                let url = val
                    .get("url")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| {
                        val.get("tab")
                            .and_then(|t| t.get("url"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    });
                let mut ok_res = BrowserCommandResult::success(val);
                ok_res.tab_id = tab_id;
                ok_res.url = url;
                ok_res.executed_via = "desktop_bridge".to_string();
                ok_res
            }
            Ok(Ok(Err(rpc_err))) => {
                let code = rpc_err
                    .rpc_code()
                    .unwrap_or(BrowserRpcErrorCode::InternalError);
                BrowserCommandResult {
                    command_id: None,
                    ok: false,
                    tab_id: None,
                    url: None,
                    title: None,
                    data: Value::Null,
                    artifact: None,
                    error_code: Some(code.as_str().to_string()),
                    rpc_code: Some(rpc_err.code),
                    error_message: Some(rpc_err.message),
                    executed_via: "desktop_bridge".to_string(),
                    duration_ms: 0,
                }
            }
            Ok(Err(_)) => BrowserCommandResult::failure(
                BrowserRpcErrorCode::CdpAttachFailed,
                "CDP_ATTACH_FAILED (-32008): Extension RPC waiter dropped",
            ),
            Err(_) => {
                self.in_flight.lock().remove(&rpc_id);
                BrowserCommandResult::failure(
                    BrowserRpcErrorCode::NavigationTimeout,
                    format!("NAVIGATION_TIMEOUT (-32007): Extension tool '{canonical_tool}' timed out after {timeout_ms}ms"),
                )
            }
        }
    }

    fn post_process_tool_result(&self, tool: BrowserToolName, res: &mut BrowserCommandResult) {
        // Sync cached tab list opportunistically on tab-lifecycle tools
        if let Some(sess) = self.active_session.read().clone() {
            if !res.data.is_null() {
                let data = &res.data;
                match tool {
                    BrowserToolName::BrowserListTabs => {
                        if let Some(arr) = data.get("tabs") {
                            if let Ok(parsed) = serde_json::from_value::<Vec<BrowserTabDto>>(arr.clone()) {
                                *sess.tabs.write() = parsed;
                                self.bump_tabs_notify();
                            }
                        }
                    }
                    BrowserToolName::BrowserOpenTab | BrowserToolName::BrowserNavigate => {
                        if let Some(tab_val) = data.get("tab") {
                            if let Ok(tab_dto) = serde_json::from_value::<BrowserTabDto>(tab_val.clone()) {
                                if tab_dto.tab_id > 0 {
                                    let mut tabs = sess.tabs.write();
                                    if let Some(existing) = tabs.iter_mut().find(|t| t.tab_id == tab_dto.tab_id) {
                                        *existing = tab_dto;
                                    } else {
                                        tabs.push(tab_dto);
                                    }
                                    drop(tabs);
                                    self.bump_tabs_notify();
                                }
                            }
                        }
                    }
                    BrowserToolName::BrowserCloseTab => {
                        if let Some(closed_id) = data.get("tab_id").and_then(Value::as_u64) {
                            let mut tabs = sess.tabs.write();
                            let before = tabs.len();
                            tabs.retain(|t| t.tab_id != closed_id);
                            if tabs.len() != before {
                                drop(tabs);
                                self.bump_tabs_notify();
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // Attach screenshot artifact if missing
        if tool == BrowserToolName::BrowserScreenshot && res.artifact.is_none() && !res.data.is_null() {
            let data = &res.data;
            if let Some(b64) = data.get("data_base64").and_then(Value::as_str) {
                if !b64.is_empty() {
                    let mime_type = data
                        .get("mime_type")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png")
                        .to_string();
                    res.artifact = Some(BrowserArtifactDto {
                        mime_type,
                        data_base64: b64.to_string(),
                        name: Some("browser_screenshot.png".to_string()),
                        width: data.get("width").and_then(Value::as_u64).map(|n| n as u32),
                        height: data.get("height").and_then(Value::as_u64).map(|n| n as u32),
                    });
                }
            }
        }

        // Run prompt-injection scan on untrusted web text outputs
        if matches!(
            tool,
            BrowserToolName::BrowserSnapshot | BrowserToolName::BrowserExtractMarkdown
        ) && !res.data.is_null()
        {
            let text_field = if tool == BrowserToolName::BrowserSnapshot {
                "text_digest"
            } else {
                "markdown"
            };
            if let Some(raw_text) = res
                .data
                .get(text_field)
                .and_then(Value::as_str)
                .map(ToString::to_string)
            {
                let sec = SecurityEngine::new(self.config_dir.read().clone());
                let scan = sec.scan_output(&raw_text);
                let dto = to_browser_injection_dto(&scan);
                if let Some(obj) = res.data.as_object_mut() {
                    obj.insert(
                        text_field.to_string(),
                        Value::String(scan.sanitized_text),
                    );
                    obj.insert(
                        "injection_scan".to_string(),
                        serde_json::to_value(&dto).unwrap_or_else(|_| json!({})),
                    );
                }
            }
        }
    }
}

/// `BrowserBridgeProvider` adapter wiring `DesktopBrowserBridge` into `gpui_telegram_agent::HermesEngine`.
#[derive(Clone)]
pub struct DesktopBrowserBridgeProvider {
    bridge: Arc<DesktopBrowserBridge>,
}

impl DesktopBrowserBridgeProvider {
    pub fn new(bridge: Arc<DesktopBrowserBridge>) -> Self {
        Self { bridge }
    }

    pub fn global() -> Self {
        Self {
            bridge: Arc::clone(global_desktop_browser_bridge()),
        }
    }
}

impl BrowserBridgeProvider for DesktopBrowserBridgeProvider {
    fn status<'a>(
        &'a self,
        _user_id: Option<u64>,
        _bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<BrowserBridgeStatusDto, String>> {
        Box::pin(async move {
            let snap = self.bridge.snapshot();
            let connected = snap.extension_connected || snap.local_cdp_available;
            let mode = if snap.extension_connected {
                "desktop_bridge".to_string()
            } else if snap.local_cdp_available {
                "local_cdp".to_string()
            } else {
                "disconnected".to_string()
            };
            let sessions = if snap.extension_connected {
                vec![BrowserSessionDto {
                    session_id: format!("desktop-{}", snap.port),
                    owner_user_id: 0,
                    extension_id: snap.extension_id.clone().unwrap_or_default(),
                    device_id: snap.device_id.clone().unwrap_or_default(),
                    user_agent: String::new(),
                    protocol_version: 1,
                    capabilities: Vec::new(),
                    run_policy: snap.run_policy,
                    host_kind: BrowserBridgeHostKind::Desktop,
                    online: true,
                    active_tabs: snap.active_tabs,
                    tabs: snap.tabs,
                    connected_at_ms: 0,
                    last_seen_ms: Utc::now().timestamp_millis(),
                }]
            } else {
                Vec::new()
            };

            Ok(BrowserBridgeStatusDto {
                ok: true,
                connected,
                mode,
                active_tabs: snap.active_tabs,
                extension_id: snap.extension_id,
                device_id: snap.device_id,
                run_policy: snap.run_policy,
                desktop_bridge_connected: snap.extension_connected,
                server_relay_connected: snap.upstream_server_connected,
                local_cdp_available: snap.local_cdp_available,
                sessions,
                pending_approvals_count: 0,
            })
        })
    }

    fn list_tabs<'a>(
        &'a self,
        _user_id: Option<u64>,
        _bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<Vec<BrowserTabDto>, String>> {
        Box::pin(async move {
            let snap = self.bridge.snapshot();
            if snap.extension_connected {
                return Ok(snap.tabs);
            }
            if snap.local_cdp_available {
                return global_cdp_manager()
                    .list_tabs(None)
                    .await
                    .map_err(|(_, msg)| msg);
            }
            Ok(Vec::new())
        })
    }

    fn should_route_via_bridge(&self, _user_id: Option<u64>, _bot_id: Option<u64>) -> bool {
        let snap = self.bridge.snapshot();
        snap.extension_connected
            || snap.emergency_stopped
            || snap.run_policy != BrowserRunPolicy::AlwaysAllowAuthorized
    }

    fn execute<'a>(
        &'a self,
        _user_id: Option<u64>,
        req: BrowserCommandRequest,
    ) -> BrowserBoxFuture<'a, Result<BrowserCommandResult, String>> {
        Box::pin(async move { Ok(self.bridge.execute_command(req).await) })
    }

    fn set_policy<'a>(
        &'a self,
        _user_id: Option<u64>,
        bot_id: Option<u64>,
        policy: BrowserRunPolicy,
    ) -> BrowserBoxFuture<'a, Result<BotBrowserProfileDto, String>> {
        Box::pin(async move {
            self.bridge.set_run_policy(policy);
            Ok(BotBrowserProfileDto {
                bot_id: bot_id.unwrap_or(777000),
                enabled: policy != BrowserRunPolicy::Disabled,
                run_policy: policy,
                allowed_domains: Vec::new(),
                blocked_domains: Vec::new(),
                preferred_target: BrowserPreferredTarget::DesktopBridge,
                updated_at_ms: Utc::now().timestamp_millis(),
            })
        })
    }

    fn emergency_stop<'a>(
        &'a self,
        _user_id: Option<u64>,
        _bot_id: Option<u64>,
        reason: Option<String>,
    ) -> BrowserBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.bridge.trigger_emergency_stop(reason);
            Ok(())
        })
    }
}

// ============================================================================
// HTTP & WebSocket Handlers + Loopback Security Guards
// ============================================================================

#[derive(Debug, Default, Deserialize)]
struct BridgeTokenQuery {
    #[serde(default)]
    token: Option<String>,
}

fn json_http_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": code,
            "message": message,
        })),
    )
        .into_response()
}

/// Strict DNS-rebinding defense: `Host` MUST be `127.0.0.1`, `localhost`, or `[::1]`/`::1`.
fn validate_loopback_host(headers: &HeaderMap) -> Result<(), Response> {
    let raw_host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            json_http_error(
                StatusCode::FORBIDDEN,
                "forbidden_host",
                "Missing or invalid Host header on loopback bridge",
            )
        })?;

    let allowed = if let Some(rest) = raw_host.strip_prefix('[') {
        if let Some((ipv6_host, tail)) = rest.split_once(']') {
            let port_ok = tail.is_empty()
                || tail
                    .strip_prefix(':')
                    .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
            ipv6_host == "::1" && port_ok
        } else {
            false
        }
    } else if raw_host == "::1" {
        true
    } else {
        let (host_part, port_ok) = match raw_host.split_once(':') {
            Some((h, p)) => (h, !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
            None => (raw_host, true),
        };
        let lower = host_part.to_ascii_lowercase();
        port_ok && (lower == "127.0.0.1" || lower == "localhost")
    };

    if allowed {
        Ok(())
    } else {
        Err(json_http_error(
            StatusCode::FORBIDDEN,
            "forbidden_host",
            &format!("DNS-rebinding Host '{raw_host}' rejected; loopback required"),
        ))
    }
}

/// Strict WebSocket `Origin` guard: if `Origin` header is present, it MUST be `chrome-extension://<id>`.
fn validate_extension_origin(headers: &HeaderMap) -> Result<(), Response> {
    let Some(origin_val) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let raw_origin = origin_val.to_str().unwrap_or("").trim();
    let lower = raw_origin.to_ascii_lowercase();

    let Some(ext_rest) = lower.strip_prefix("chrome-extension://") else {
        return Err(json_http_error(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            &format!(
                "Forbidden WebSocket Origin '{raw_origin}'; only chrome-extension:// origins are permitted"
            ),
        ));
    };

    let ext_id = ext_rest.trim_end_matches('/');
    if ext_id.is_empty()
        || ext_id.contains('/')
        || ext_id.contains(char::is_whitespace)
        || ext_id.contains('@')
    {
        return Err(json_http_error(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "Malformed chrome-extension:// Origin header",
        ));
    }

    Ok(())
}

/// Extracts explicit credentials from `?token=` or `Authorization: Bearer <tok>`.
/// Returns `Some(token)` if either credential carrier was supplied on the request, or `None` if neither was present.
fn extract_explicit_token(headers: &HeaderMap, query: &BridgeTokenQuery) -> Option<String> {
    if let Some(q_tok) = query.token.as_ref() {
        return Some(q_tok.trim().to_string());
    }
    if let Some(auth_hdr) = headers.get(header::AUTHORIZATION) {
        let raw = auth_hdr.to_str().unwrap_or("").trim();
        if let Some(rest) = raw
            .strip_prefix("Bearer ")
            .or_else(|| raw.strip_prefix("bearer "))
        {
            return Some(rest.trim().to_string());
        }
        return Some(raw.to_string());
    }
    None
}

fn require_valid_pairing_token(
    headers: &HeaderMap,
    query: &BridgeTokenQuery,
    expected: &str,
) -> Result<(), Response> {
    let Some(candidate) = extract_explicit_token(headers, query) else {
        return Err(json_http_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized_bridge",
            "Missing pairing_token (?token= or Authorization: Bearer)",
        ));
    };
    if !constant_time_token_eq(&candidate, expected) {
        return Err(json_http_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized_bridge",
            "Invalid pairing_token",
        ));
    }
    Ok(())
}

async fn http_health(
    headers: HeaderMap,
    State(bridge): State<Arc<DesktopBrowserBridge>>,
) -> Response {
    if let Err(resp) = validate_loopback_host(&headers) {
        return resp;
    }

    let snap = bridge.snapshot();
    let (session_id, connected_at_ms) = bridge
        .active_session
        .read()
        .as_ref()
        .map(|s| (Some(s.session_id.clone()), Some(s.connected_at_ms)))
        .unwrap_or((None, None));
    Json(json!({
        "ok": true,
        "status": "ok",
        "host_kind": "desktop",
        "port": snap.port,
        "extension_connected": snap.extension_connected,
        "connected": snap.extension_connected,
        "session_id": session_id,
        "connected_at_ms": connected_at_ms,
        "active_tabs": snap.active_tabs,
        "extension_id": snap.extension_id,
        "device_id": snap.device_id,
        "run_policy": snap.run_policy,
        "emergency_stopped": snap.emergency_stopped,
        "cdp_available": snap.local_cdp_available,
        "cdp_url": snap.local_cdp_url,
        "upstream_connected": snap.upstream_server_connected,
        "ws_url": snap.ws_url,
    }))
    .into_response()
}

async fn http_json_list(
    headers: HeaderMap,
    Query(query): Query<BridgeTokenQuery>,
    State(bridge): State<Arc<DesktopBrowserBridge>>,
) -> Response {
    if let Err(resp) = validate_loopback_host(&headers) {
        return resp;
    }
    let expected = bridge.pairing_token();
    if let Err(resp) = require_valid_pairing_token(&headers, &query, &expected) {
        return resp;
    }

    let snap = bridge.snapshot();
    let descriptors: Vec<Value> = snap
        .tabs
        .into_iter()
        .map(|tab| {
            json!({
                "id": tab.tab_id.to_string(),
                "tab_id": tab.tab_id,
                "window_id": tab.window_id,
                "group_id": tab.group_id,
                "type": "page",
                "title": tab.title,
                "url": tab.url,
                "active": tab.active,
                "pinned": tab.pinned,
                "audible": tab.audible,
                "status": tab.status,
                "controllable": tab.controllable,
                "fav_icon_url": tab.fav_icon_url,
            })
        })
        .collect();

    Json(descriptors).into_response()
}

async fn http_ext_ws(
    headers: HeaderMap,
    Query(query): Query<BridgeTokenQuery>,
    ws: WebSocketUpgrade,
    State(bridge): State<Arc<DesktopBrowserBridge>>,
) -> Response {
    if let Err(resp) = validate_loopback_host(&headers) {
        return resp;
    }
    if let Err(resp) = validate_extension_origin(&headers) {
        return resp;
    }

    let expected = bridge.pairing_token();
    let pre_authenticated = match extract_explicit_token(&headers, &query) {
        Some(candidate) => {
            if !constant_time_token_eq(&candidate, &expected) {
                return json_http_error(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized_bridge",
                    "UNAUTHORIZED_BRIDGE (-32001): Invalid pairing_token on WebSocket upgrade",
                );
            }
            true
        }
        None => false,
    };

    ws.max_message_size(MAX_BROWSER_WS_FRAME_BYTES)
        .max_frame_size(MAX_BROWSER_WS_FRAME_BYTES)
        .on_upgrade(move |socket| handle_extension_ws(socket, bridge, pre_authenticated))
}

async fn handle_extension_ws(
    socket: WebSocket,
    bridge: Arc<DesktopBrowserBridge>,
    pre_authenticated: bool,
) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = outbound_rx.recv().await {
            if ws_sink.send(AxumWsMessage::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sink
            .send(AxumWsMessage::Close(Some(CloseFrame {
                code: 1000,
                reason: "closed".into(),
            })))
            .await;
    });

    let mut registered_session: Option<Arc<ExtensionWsSession>> = None;
    let hello_deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    loop {
        let next_msg = if registered_session.is_none() {
            match tokio::time::timeout_at(hello_deadline, ws_stream.next()).await {
                Ok(item) => item,
                Err(_) => {
                    let err_resp = BrowserBridgeFrame::Response(BrowserJsonRpcResponse::err(
                        None,
                        BrowserRpcErrorCode::UnauthorizedBridge,
                        "UNAUTHORIZED_BRIDGE (-32001): Timed out waiting for bridge.hello handshake",
                    ));
                    if let Ok(raw) = err_resp.to_json_string() {
                        let _ = outbound_tx.send(raw);
                    }
                    break;
                }
            }
        } else {
            ws_stream.next().await
        };

        let Some(Ok(msg)) = next_msg else {
            break;
        };

        let raw_text = match msg {
            AxumWsMessage::Text(t) => t.to_string(),
            AxumWsMessage::Binary(b) => match String::from_utf8(b.to_vec()) {
                Ok(s) => s,
                Err(_) => continue,
            },
            AxumWsMessage::Ping(_) | AxumWsMessage::Pong(_) => continue,
            AxumWsMessage::Close(_) => break,
        };

        let frame = match BrowserBridgeFrame::parse_json(&raw_text) {
            Ok(f) => f,
            Err(parse_err) => {
                let err_resp = BrowserBridgeFrame::Response(BrowserJsonRpcResponse::err(
                    None,
                    BrowserRpcErrorCode::ParseError,
                    format!("Invalid JSON-RPC frame: {parse_err}"),
                ));
                if let Ok(raw) = err_resp.to_json_string() {
                    let _ = outbound_tx.send(raw);
                }
                if registered_session.is_none() {
                    break;
                }
                continue;
            }
        };

        match frame {
            BrowserBridgeFrame::Hello { id, params } => {
                let expected = bridge.pairing_token();
                let hello_tok = params
                    .pairing_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());

                let token_valid = if pre_authenticated {
                    hello_tok.map_or(true, |cand| constant_time_token_eq(cand, &expected))
                } else {
                    hello_tok.is_some_and(|cand| constant_time_token_eq(cand, &expected))
                };

                if !token_valid {
                    let err_resp = BrowserBridgeFrame::Response(BrowserJsonRpcResponse::err(
                        id,
                        BrowserRpcErrorCode::UnauthorizedBridge,
                        "UNAUTHORIZED_BRIDGE (-32001): Invalid or missing pairing_token in bridge.hello",
                    ));
                    if let Ok(raw) = err_resp.to_json_string() {
                        let _ = outbound_tx.send(raw);
                    }
                    break;
                }

                let now_ms = Utc::now().timestamp_millis();
                *bridge.run_policy.write() = params.run_policy;
                if params.run_policy != BrowserRunPolicy::Disabled {
                    bridge.emergency_stopped.store(false, Ordering::Release);
                }
                let sess = if let Some(existing) = registered_session.as_ref() {
                    *existing.extension_id.write() = params.extension_id;
                    *existing.device_id.write() = params.device_id;
                    *existing.user_agent.write() = params.user_agent;
                    *existing.capabilities.write() = params.capabilities;
                    *existing.reported_policy.write() = params.run_policy;
                    *existing.tabs.write() = params.tabs_summary;
                    existing
                        .last_seen_ms
                        .store(now_ms.max(0) as u64, Ordering::Relaxed);
                    Arc::clone(existing)
                } else {
                    let generation_id = bridge.next_generation_id.fetch_add(1, Ordering::SeqCst);
                    let new_sess = Arc::new(ExtensionWsSession {
                        generation_id,
                        session_id: format!("desk_ext_{generation_id}"),
                        extension_id: RwLock::new(params.extension_id),
                        device_id: RwLock::new(params.device_id),
                        user_agent: RwLock::new(params.user_agent),
                        capabilities: RwLock::new(params.capabilities),
                        reported_policy: RwLock::new(params.run_policy),
                        tabs: RwLock::new(params.tabs_summary),
                        connected_at_ms: now_ms,
                        last_seen_ms: AtomicU64::new(now_ms.max(0) as u64),
                        outbound_tx: outbound_tx.clone(),
                    });
                    *bridge.active_session.write() = Some(Arc::clone(&new_sess));
                    registered_session = Some(Arc::clone(&new_sess));
                    new_sess
                };

                let ack = BrowserBridgeFrame::HelloAck {
                    id,
                    params: BridgeHelloAckParams {
                        accepted: true,
                        host_kind: BrowserBridgeHostKind::Desktop,
                        host_version: env!("CARGO_PKG_VERSION").to_string(),
                        ping_interval_secs: DEFAULT_BRIDGE_PING_INTERVAL_SECS,
                        reason: None,
                    },
                };
                if let Ok(raw) = ack.to_json_string() {
                    let _ = sess.outbound_tx.send(raw);
                }
                bridge.bump_tabs_notify();
            }
            BrowserBridgeFrame::TabsSync { params } => {
                let Some(sess) = registered_session.as_ref() else {
                    break;
                };
                sess.last_seen_ms
                    .store(Utc::now().timestamp_millis().max(0) as u64, Ordering::Relaxed);
                *sess.reported_policy.write() = params.run_policy;
                *bridge.run_policy.write() = params.run_policy;
                if params.run_policy != BrowserRunPolicy::Disabled {
                    bridge.emergency_stopped.store(false, Ordering::Release);
                }
                *sess.tabs.write() = params.tabs;
                bridge.bump_tabs_notify();
            }
            BrowserBridgeFrame::Ping { id, params } => {
                if let Some(sess) = registered_session.as_ref() {
                    sess.last_seen_ms
                        .store(Utc::now().timestamp_millis().max(0) as u64, Ordering::Relaxed);
                }
                let pong = BrowserBridgeFrame::Pong {
                    id,
                    params: BridgePingPongParams {
                        ts: params.ts,
                        nonce: params.nonce,
                    },
                };
                if let Ok(raw) = pong.to_json_string() {
                    let _ = outbound_tx.send(raw);
                }
            }
            BrowserBridgeFrame::Pong { .. } => {
                if let Some(sess) = registered_session.as_ref() {
                    sess.last_seen_ms
                        .store(Utc::now().timestamp_millis().max(0) as u64, Ordering::Relaxed);
                }
            }
            BrowserBridgeFrame::EmergencyStop {
                params: BridgeEmergencyStopParams { reason, .. },
                ..
            } => {
                if registered_session.is_some() {
                    bridge.trigger_emergency_stop_internal(reason, false);
                }
            }
            BrowserBridgeFrame::Response(resp) => {
                if let Some(id) = resp.id {
                    let key = rpc_id_key(&id);
                    if let Some(waiter) = bridge.in_flight.lock().remove(&key) {
                        if let Some(err) = resp.error {
                            let _ = waiter.tx.send(Err(err));
                        } else {
                            let _ = waiter
                                .tx
                                .send(Ok(resp.result.unwrap_or_else(|| json!({ "ok": true }))));
                        }
                    }
                }
            }
            BrowserBridgeFrame::HelloAck { .. } | BrowserBridgeFrame::Invoke { .. } => {}
        }
    }

    if let Some(sess) = registered_session {
        // Generation-fenced disconnect: NEVER clobber a newer active session!
        let mut guard = bridge.active_session.write();
        if guard
            .as_ref()
            .is_some_and(|active| active.generation_id == sess.generation_id)
        {
            *guard = None;
        }
        drop(guard);

        bridge.abort_in_flight_for_generation(
            sess.generation_id,
            BrowserRpcErrorCode::CdpAttachFailed,
            "Extension WebSocket disconnected before tool completed",
        );
        bridge.bump_tabs_notify();
    }

    drop(outbound_tx);
    let _ = tokio::time::timeout(Duration::from_millis(250), writer_task).await;
}

fn rpc_id_key(id: &BrowserJsonRpcId) -> String {
    match id {
        BrowserJsonRpcId::Str(s) => s.clone(),
        BrowserJsonRpcId::Num(n) => n.to_string(),
    }
}

fn rpc_error_from_command_result(res: &BrowserCommandResult, fallback_msg: &str) -> BrowserJsonRpcError {
    let code = res
        .rpc_code
        .and_then(BrowserRpcErrorCode::from_code)
        .or_else(|| {
            res.error_code
                .as_deref()
                .and_then(BrowserRpcErrorCode::from_error_str)
        })
        .unwrap_or(BrowserRpcErrorCode::InternalError);
    let msg = res
        .error_message
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_msg.to_string());
    BrowserJsonRpcError::from_code(code, msg)
}

fn status_for_command_result(res: &BrowserCommandResult) -> StatusCode {
    if res.ok {
        return StatusCode::OK;
    }
    let rpc_code = res
        .rpc_code
        .and_then(BrowserRpcErrorCode::from_code)
        .or_else(|| {
            res.error_code
                .as_deref()
                .and_then(BrowserRpcErrorCode::from_error_str)
        });
    match rpc_code {
        Some(BrowserRpcErrorCode::UnauthorizedBridge) => StatusCode::UNAUTHORIZED,
        Some(BrowserRpcErrorCode::UserDeniedApproval)
        | Some(BrowserRpcErrorCode::PolicyDisabled)
        | Some(BrowserRpcErrorCode::RestrictedUrl) => StatusCode::FORBIDDEN,
        Some(BrowserRpcErrorCode::TabNotFound) | Some(BrowserRpcErrorCode::ElementNotFound) => {
            StatusCode::NOT_FOUND
        }
        Some(BrowserRpcErrorCode::NavigationTimeout) => StatusCode::GATEWAY_TIMEOUT,
        Some(BrowserRpcErrorCode::CdpAttachFailed) => StatusCode::SERVICE_UNAVAILABLE,
        Some(BrowserRpcErrorCode::ParseError)
        | Some(BrowserRpcErrorCode::InvalidRequest)
        | Some(BrowserRpcErrorCode::MethodNotFound)
        | Some(BrowserRpcErrorCode::InvalidParams) => StatusCode::BAD_REQUEST,
        Some(BrowserRpcErrorCode::InternalError) | None => StatusCode::BAD_GATEWAY,
    }
}

async fn http_exec(
    headers: HeaderMap,
    Query(query): Query<BridgeTokenQuery>,
    State(bridge): State<Arc<DesktopBrowserBridge>>,
    bytes: Bytes,
) -> Response {
    if let Err(resp) = validate_loopback_host(&headers) {
        return resp;
    }
    let expected = bridge.pairing_token();
    if let Err(resp) = require_valid_pairing_token(&headers, &query, &expected) {
        return resp;
    }

    let req: BrowserCommandRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(BrowserCommandResult::failure(
                    BrowserRpcErrorCode::InvalidParams,
                    format!("INVALID_PARAMS (-32602): Invalid BrowserCommandRequest JSON: {e}"),
                )),
            )
                .into_response();
        }
    };

    let res = bridge.execute_command(req).await;
    let status = status_for_command_result(&res);
    (status, Json(res)).into_response()
}

async fn http_rpc(
    headers: HeaderMap,
    Query(query): Query<BridgeTokenQuery>,
    State(bridge): State<Arc<DesktopBrowserBridge>>,
    bytes: Bytes,
) -> Response {
    if let Err(resp) = validate_loopback_host(&headers) {
        return resp;
    }
    let expected = bridge.pairing_token();
    if let Err(resp) = require_valid_pairing_token(&headers, &query, &expected) {
        return resp;
    }

    let raw_str = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(BrowserJsonRpcResponse::err(
                    None,
                    BrowserRpcErrorCode::ParseError,
                    format!("Invalid UTF-8 body: {e}"),
                )),
            )
                .into_response();
        }
    };

    if let Ok(BrowserBridgeFrame::Invoke { id, params }) = BrowserBridgeFrame::parse_json(raw_str) {
        let cmd_req = BrowserCommandRequest {
            command_id: Some(rpc_id_key(&id)),
            tool: params.tool,
            arguments: params.arguments,
            bot_id: params.caller.bot_id,
            bot_name: params.caller.bot_name,
            chat_id: params.caller.chat_id,
            timeout_ms: Some(params.timeout_ms),
        };
        let res = bridge.execute_command(cmd_req).await;
        if res.ok {
            let payload = if res.data.is_null() {
                json!({ "ok": true })
            } else {
                res.data
            };
            return (StatusCode::OK, Json(BrowserJsonRpcResponse::ok(id, payload))).into_response();
        }
        let err = rpc_error_from_command_result(&res, "Browser command failed");
        return (
            StatusCode::OK,
            Json(BrowserJsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: Some(id),
                result: None,
                error: Some(err),
            }),
        )
            .into_response();
    }

    // Also accept plain BrowserCommandRequest on /rpc for flexibility
    http_exec(headers, Query(query), State(bridge), bytes).await
}

// ============================================================================
// Upstream Desktop -> Server WebSocket Relay (`?client=desktop`)
// ============================================================================

type UpstreamWsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn percent_encode_query_val(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(&mut out, "%{b:02X}");
        }
    }
    out
}

async fn connect_ws_bypassing_proxy_for_loopback(ws_url: &str) -> Result<UpstreamWsStream, String> {
    let mut ws_cfg = WebSocketConfig::default();
    ws_cfg.max_message_size = Some(MAX_BROWSER_WS_FRAME_BYTES);
    ws_cfg.max_frame_size = Some(MAX_BROWSER_WS_FRAME_BYTES);

    if let Some(rest) = ws_url.strip_prefix("ws://") {
        let authority = rest.split('/').next().unwrap_or("");
        let addr = if authority.contains(':') {
            authority.to_string()
        } else {
            format!("{authority}:80")
        };
        let tcp = tokio::net::TcpStream::connect(&addr)
            .await
            .map_err(|e| format!("Upstream TCP connect to {addr} failed: {e}"))?;
        let _ = tcp.set_nodelay(true);
        let (stream, _) = tokio_tungstenite::client_async_with_config(
            ws_url,
            tokio_tungstenite::MaybeTlsStream::Plain(tcp),
            Some(ws_cfg),
        )
        .await
        .map_err(|e| format!("Upstream WS handshake failed: {e}"))?;
        return Ok(stream);
    }

    let (stream, _) =
        tokio_tungstenite::connect_async_with_config(ws_url, Some(ws_cfg), false)
            .await
            .map_err(|e| format!("Upstream WS connect failed: {e}"))?;
    Ok(stream)
}

async fn run_upstream_ws_loop(
    bridge: &Arc<DesktopBrowserBridge>,
    ws_stream: UpstreamWsStream,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let (mut sink, mut stream) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let snap = bridge.snapshot();
    let hello = BrowserBridgeFrame::Hello {
        id: Some(BrowserJsonRpcId::Str("desktop_hello_1".to_string())),
        params: BridgeHelloParams {
            protocol_version: 1,
            extension_id: snap
                .extension_id
                .unwrap_or_else(|| "desktop-loopback-bridge".to_string()),
            device_id: format!("desktop-bridge-{}", snap.port),
            pairing_token: None,
            user_agent: format!("FabushiDesktop/{}", env!("CARGO_PKG_VERSION")),
            capabilities: vec!["desktop_loopback_bridge".to_string(), "cdp_fallback".to_string()],
            run_policy: snap.run_policy,
            tabs_summary: snap.tabs,
            desktop_bridge_connected: true,
        },
    };
    if let Ok(raw) = hello.to_json_string() {
        let _ = tx.send(raw);
    }

    let mut tabs_rx = bridge.tabs_notify_tx.subscribe();
    let mut ping_interval =
        tokio::time::interval(Duration::from_secs(DEFAULT_BRIDGE_PING_INTERVAL_SECS));
    ping_interval.tick().await;

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
            }
            Some(out_raw) = rx.recv() => {
                if sink.send(TungsteniteMessage::Text(out_raw.into())).await.is_err() {
                    break;
                }
            }
            Ok(()) = tabs_rx.changed() => {
                let cur = bridge.snapshot();
                let sync_frame = BrowserBridgeFrame::tabs_sync(BridgeTabsSyncParams {
                    tabs: cur.tabs,
                    run_policy: cur.run_policy,
                    desktop_bridge_connected: true,
                });
                if let Ok(raw) = sync_frame.to_json_string() {
                    let _ = tx.send(raw);
                }
            }
            _ = ping_interval.tick() => {
                let ping = BrowserBridgeFrame::ping(Utc::now().timestamp_millis());
                if let Ok(raw) = ping.to_json_string() {
                    let _ = tx.send(raw);
                }
            }
            maybe_in = stream.next() => {
                let Some(Ok(msg)) = maybe_in else {
                    break;
                };
                let text = match msg {
                    TungsteniteMessage::Text(t) => t.to_string(),
                    TungsteniteMessage::Binary(b) => match String::from_utf8(b.to_vec()) {
                        Ok(s) => s,
                        Err(_) => continue,
                    },
                    TungsteniteMessage::Ping(_) | TungsteniteMessage::Pong(_) => continue,
                    TungsteniteMessage::Close(_) => break,
                    TungsteniteMessage::Frame(_) => continue,
                };

                let Ok(frame) = BrowserBridgeFrame::parse_json(&text) else {
                    continue;
                };

                match frame {
                    BrowserBridgeFrame::Ping { id, params } => {
                        let pong = BrowserBridgeFrame::Pong { id, params };
                        if let Ok(raw) = pong.to_json_string() {
                            let _ = tx.send(raw);
                        }
                    }
                    BrowserBridgeFrame::EmergencyStop { params, .. } => {
                        bridge.trigger_emergency_stop_internal(params.reason, false);
                    }
                    BrowserBridgeFrame::Invoke { id, params } => {
                        let bridge_clone = Arc::clone(bridge);
                        let tx_clone = tx.clone();
                        tokio::spawn(async move {
                            let req = BrowserCommandRequest {
                                command_id: Some(rpc_id_key(&id)),
                                tool: params.tool,
                                arguments: params.arguments,
                                bot_id: params.caller.bot_id,
                                bot_name: params.caller.bot_name,
                                chat_id: params.caller.chat_id,
                                timeout_ms: Some(params.timeout_ms),
                            };
                            let res = bridge_clone.execute_command(req).await;
                            let resp_frame = if res.ok {
                                let payload = if res.data.is_null() {
                                    json!({ "ok": true })
                                } else {
                                    res.data
                                };
                                BrowserBridgeFrame::Response(BrowserJsonRpcResponse::ok(
                                    id,
                                    payload,
                                ))
                            } else {
                                let err = rpc_error_from_command_result(
                                    &res,
                                    "Desktop bridge invocation failed",
                                );
                                BrowserBridgeFrame::Response(BrowserJsonRpcResponse {
                                    jsonrpc: "2.0".to_string(),
                                    id: Some(id),
                                    result: None,
                                    error: Some(err),
                                })
                            };
                            if let Ok(raw) = resp_frame.to_json_string() {
                                let _ = tx_clone.send(raw);
                            }
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = sink.close().await;
    Ok(())
}

/// Runs the standalone headless `--browser-bridge-only` daemon without touching X11/Wayland/GPUI.
pub fn run_headless_browser_bridge_daemon(args: &[String]) -> Result<(), String> {
    let client_cfg = ClientConfig::resolve_with_args(args);
    let start_opts = DesktopBrowserBridgeStartOptions::from_env_and_args(args);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .thread_stack_size(8 * 1024 * 1024)
        .enable_all()
        .build()
        .map_err(|e| format!("Failed to initialize Tokio runtime for Desktop Bridge: {e}"))?;

    rt.block_on(async move {
        let bridge = global_desktop_browser_bridge();
        let actual_port = bridge.start_loopback_server(start_opts).await?;

        let auth_token = std::env::var("GPUI_TELEGRAM_AUTH_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| ClientConfig::load_session().map(|s| s.token));

        if auth_token.is_some() {
            bridge.connect_upstream_server(client_cfg.server_url.clone(), auth_token);
        }

        println!(
            "[Fabushi Desktop Bridge] Listening on http://127.0.0.1:{actual_port} (ws://127.0.0.1:{actual_port}/ext/ws) | config={}",
            bridge.config_file_path().display()
        );

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate())
                .map_err(|e| format!("Failed to register SIGTERM handler: {e}"))?;
            let mut sigint = signal(SignalKind::interrupt())
                .map_err(|e| format!("Failed to register SIGINT handler: {e}"))?;
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
        }

        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }

        bridge.stop();
        Ok(())
    })
}
