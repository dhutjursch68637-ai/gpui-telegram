//! Server Browser Control Relay (`PROJECT.md §§ 1–4`, Feature F3).
//!
//! Provides per-user Chrome/Chromium MV3 Extension & Desktop WebSocket relay sessions
//! at `/api/v1/browser/ws` alongside `AuthBearer`-protected REST endpoints:
//! - `GET  /api/v1/browser/status`
//! - `GET  /api/v1/browser/tabs`
//! - `POST /api/v1/browser/exec`
//! - `GET  /api/v1/bots/{bot_id}/browser`
//! - `PUT  /api/v1/bots/{bot_id}/browser`
//! - `GET  /api/v1/browser/commands/pending`
//! - `POST /api/v1/browser/commands/{command_id}/approve`
//! - `POST /api/v1/browser/pairing`

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use gpui_telegram_agent::hermes::browser_bridge::{
    to_browser_injection_dto, validate_navigable_browser_url, BrowserBoxFuture,
    BrowserBridgeProvider,
};
use gpui_telegram_agent::hermes::browser_cdp::global_cdp_manager;
use gpui_telegram_agent::hermes::security::scan_content_for_injection;
use gpui_telegram_core::error::TelegramError;
use gpui_telegram_proto::browser_contracts::{
    sanitize_download_filename, validate_browser_tool_arguments, BotBrowserProfileDto,
    BridgeHelloAckParams, BrowserApprovalDecisionDto, BrowserArtifactDto, BrowserBridgeFrame,
    BrowserBridgeHostKind, BrowserBridgeStatusDto, BrowserCallerInfo, BrowserCallerKind,
    BrowserCommandRequest, BrowserCommandResult, BrowserInjectionScanDto,
    BrowserInjectionSeverity, BrowserInvokeParams, BrowserJsonRpcId, BrowserJsonRpcResponse,
    BrowserPairingAction, BrowserPairingDto, BrowserPairingRequest, BrowserPolicyDecision,
    BrowserPreferredTarget, BrowserRpcErrorCode, BrowserRunPolicy, BrowserSessionDto,
    BrowserTabDto, BrowserTabsListResponse, BrowserToolName, PendingBrowserCommandDto,
    UpdateBotBrowserProfileRequest, DEFAULT_BRIDGE_PING_INTERVAL_SECS,
    DEFAULT_BROWSER_INVOKE_TIMEOUT_MS, DEFAULT_DESKTOP_BRIDGE_PORT, MAX_BROWSER_INVOKE_TIMEOUT_MS,
    MAX_BROWSER_WS_FRAME_BYTES,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::auth::AuthBearer;
use crate::db::ServerDatabase;
use crate::routes::{err_resp, parse_json_object};
use crate::server::AppState;

const OFFICIAL_BOT_ID: u64 = 777_000;

#[derive(Debug, Clone)]
struct StoredPairingRecord {
    owner_user_id: u64,
    pairing_token: String,
    desktop_port: u16,
    extension_id: Option<String>,
    verified: bool,
    created_at_ms: i64,
    expires_at_ms: Option<i64>,
}

struct ActiveBridgeSession {
    generation: u64,
    session_id: String,
    owner_user_id: u64,
    host_kind: BrowserBridgeHostKind,
    extension_id: String,
    device_id: String,
    user_agent: String,
    protocol_version: u32,
    capabilities: Vec<String>,
    run_policy: BrowserRunPolicy,
    tabs: Vec<BrowserTabDto>,
    desktop_bridge_connected: bool,
    connected_at_ms: i64,
    last_seen_ms: i64,
    tx: mpsc::UnboundedSender<String>,
    in_flight: Arc<Mutex<HashMap<String, oneshot::Sender<BrowserJsonRpcResponse>>>>,
}

impl ActiveBridgeSession {
    fn to_dto(&self) -> BrowserSessionDto {
        BrowserSessionDto {
            session_id: self.session_id.clone(),
            owner_user_id: self.owner_user_id,
            extension_id: self.extension_id.clone(),
            device_id: self.device_id.clone(),
            user_agent: self.user_agent.clone(),
            protocol_version: self.protocol_version,
            capabilities: self.capabilities.clone(),
            run_policy: self.run_policy,
            host_kind: self.host_kind,
            online: true,
            active_tabs: self.tabs.len(),
            tabs: self.tabs.clone(),
            connected_at_ms: self.connected_at_ms,
            last_seen_ms: self.last_seen_ms,
        }
    }

    fn abort_all_in_flight(&self, code: BrowserRpcErrorCode, message: &str) {
        let waiters: Vec<(String, oneshot::Sender<BrowserJsonRpcResponse>)> = {
            let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            guard.drain().collect()
        };
        for (req_id, tx) in waiters {
            let _ = tx.send(BrowserJsonRpcResponse::err(
                Some(BrowserJsonRpcId::Str(req_id)),
                code,
                message.to_string(),
            ));
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PendingApprovalResolution {
    Approved { remember_for_session: bool },
    Denied,
    EmergencyStopped,
}

struct PendingApprovalEntry {
    dto: PendingBrowserCommandDto,
    tx: Option<oneshot::Sender<PendingApprovalResolution>>,
}

struct PendingWaiterCleanupGuard<'a> {
    service: &'a BrowserControlService,
    command_id: String,
    disarmed: bool,
}

impl Drop for PendingWaiterCleanupGuard<'_> {
    fn drop(&mut self) {
        if !self.disarmed {
            let mut guard = self
                .service
                .pending_approvals
                .write()
                .unwrap_or_else(|e| e.into_inner());
            guard.remove(&self.command_id);
        }
    }
}

pub struct BrowserControlService {
    db: Arc<ServerDatabase>,
    next_generation: AtomicU64,
    next_rpc_seq: AtomicU64,
    active_sessions: RwLock<HashMap<(u64, BrowserBridgeHostKind), Arc<ActiveBridgeSession>>>,
    bot_profiles: RwLock<HashMap<(u64, u64), BotBrowserProfileDto>>,
    pairings: RwLock<HashMap<u64, StoredPairingRecord>>,
    pending_approvals: RwLock<HashMap<String, PendingApprovalEntry>>,
    session_remembered: RwLock<HashSet<(u64, u64, i64)>>,
    injection_flagged_tabs: RwLock<HashSet<(u64, u64)>>,
    emergency_stopped_users: RwLock<HashSet<u64>>,
}

impl BrowserControlService {
    pub fn new(db: Arc<ServerDatabase>) -> Self {
        let svc = Self {
            db,
            next_generation: AtomicU64::new(1),
            next_rpc_seq: AtomicU64::new(1),
            active_sessions: RwLock::new(HashMap::new()),
            bot_profiles: RwLock::new(HashMap::new()),
            pairings: RwLock::new(HashMap::new()),
            pending_approvals: RwLock::new(HashMap::new()),
            session_remembered: RwLock::new(HashSet::new()),
            injection_flagged_tabs: RwLock::new(HashSet::new()),
            emergency_stopped_users: RwLock::new(HashSet::new()),
        };
        svc.init_and_hydrate();
        svc
    }

    fn init_and_hydrate(&self) {
        let _ = self.db.pool().with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS bot_browser_profiles (
                    owner_user_id INTEGER NOT NULL,
                    bot_id INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    run_policy TEXT NOT NULL DEFAULT 'always_allow_authorized',
                    allowed_domains_json TEXT NOT NULL DEFAULT '[]',
                    blocked_domains_json TEXT NOT NULL DEFAULT '[]',
                    preferred_target TEXT NOT NULL DEFAULT 'auto',
                    updated_at_ms INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (owner_user_id, bot_id)
                );
                CREATE TABLE IF NOT EXISTS browser_pairings (
                    owner_user_id INTEGER NOT NULL PRIMARY KEY,
                    pairing_token TEXT NOT NULL,
                    desktop_port INTEGER NOT NULL DEFAULT 19222,
                    extension_id TEXT,
                    verified INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER
                );",
            )
            .map_err(|e| TelegramError::Database(e.to_string()))?;

            if let Ok(mut stmt) = conn.prepare(
                "SELECT owner_user_id, bot_id, enabled, run_policy, allowed_domains_json, blocked_domains_json, preferred_target, updated_at_ms
                 FROM bot_browser_profiles",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    let owner_id: i64 = row.get(0)?;
                    let bot_id: i64 = row.get(1)?;
                    let enabled: i64 = row.get(2)?;
                    let run_policy_raw: String = row.get(3)?;
                    let allowed_raw: String = row.get(4)?;
                    let blocked_raw: String = row.get(5)?;
                    let preferred_raw: String = row.get(6)?;
                    let updated_at_ms: i64 = row.get(7)?;
                    Ok((
                        owner_id as u64,
                        bot_id as u64,
                        enabled != 0,
                        run_policy_raw,
                        allowed_raw,
                        blocked_raw,
                        preferred_raw,
                        updated_at_ms,
                    ))
                }) {
                    let mut map = self.bot_profiles.write().unwrap_or_else(|e| e.into_inner());
                    for item in rows.flatten() {
                        let (
                            owner_id,
                            bot_id,
                            enabled,
                            run_policy_raw,
                            allowed_raw,
                            blocked_raw,
                            preferred_raw,
                            updated_at_ms,
                        ) = item;
                        let run_policy = parse_run_policy_flexible(&run_policy_raw)
                            .unwrap_or(BrowserRunPolicy::AlwaysAllowAuthorized);
                        let preferred_target = parse_preferred_target_flexible(&preferred_raw)
                            .unwrap_or(BrowserPreferredTarget::Auto);
                        let allowed_domains: Vec<String> =
                            serde_json::from_str(&allowed_raw).unwrap_or_default();
                        let blocked_domains: Vec<String> =
                            serde_json::from_str(&blocked_raw).unwrap_or_default();
                        map.insert(
                            (owner_id, bot_id),
                            BotBrowserProfileDto {
                                bot_id,
                                enabled,
                                run_policy,
                                allowed_domains,
                                blocked_domains,
                                preferred_target,
                                updated_at_ms,
                            },
                        );
                    }
                }
            }

            if let Ok(mut stmt) = conn.prepare(
                "SELECT owner_user_id, pairing_token, desktop_port, extension_id, verified, created_at_ms, expires_at_ms
                 FROM browser_pairings",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok(StoredPairingRecord {
                        owner_user_id: row.get::<_, i64>(0)? as u64,
                        pairing_token: row.get(1)?,
                        desktop_port: row.get::<_, i64>(2)? as u16,
                        extension_id: row.get(3)?,
                        verified: row.get::<_, i64>(4)? != 0,
                        created_at_ms: row.get(5)?,
                        expires_at_ms: row.get(6)?,
                    })
                }) {
                    let mut map = self.pairings.write().unwrap_or_else(|e| e.into_inner());
                    for rec in rows.flatten() {
                        map.insert(rec.owner_user_id, rec);
                    }
                }
            }

            Ok(())
        });
    }

    pub fn shutdown(&self) {
        let sessions: Vec<Arc<ActiveBridgeSession>> = {
            let mut guard = self
                .active_sessions
                .write()
                .unwrap_or_else(|e| e.into_inner());
            guard.drain().map(|(_, s)| s).collect()
        };
        for s in sessions {
            s.abort_all_in_flight(
                BrowserRpcErrorCode::CdpAttachFailed,
                "Server shutting down",
            );
        }
        let mut pending = self
            .pending_approvals
            .write()
            .unwrap_or_else(|e| e.into_inner());
        for (_, mut entry) in pending.drain() {
            if let Some(tx) = entry.tx.take() {
                let _ = tx.send(PendingApprovalResolution::EmergencyStopped);
            }
        }
    }

    pub fn get_bot_profile(&self, owner_user_id: u64, bot_id: u64) -> BotBrowserProfileDto {
        let guard = self.bot_profiles.read().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = guard.get(&(owner_user_id, bot_id)) {
            return found.clone();
        }
        BotBrowserProfileDto {
            bot_id,
            enabled: true,
            run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
            allowed_domains: Vec::new(),
            blocked_domains: Vec::new(),
            preferred_target: BrowserPreferredTarget::Auto,
            updated_at_ms: 0,
        }
    }

    pub fn upsert_bot_profile(
        &self,
        owner_user_id: u64,
        bot_id: u64,
        patch: UpdateBotBrowserProfileRequest,
    ) -> BotBrowserProfileDto {
        let now_ms = Utc::now().timestamp_millis();
        let mut current = self.get_bot_profile(owner_user_id, bot_id);
        let prev_policy = current.run_policy;
        if let Some(enabled) = patch.enabled {
            current.enabled = enabled;
        }
        if let Some(run_policy) = patch.run_policy {
            current.run_policy = run_policy;
        }
        if let Some(allowed) = patch.allowed_domains {
            current.allowed_domains = allowed
                .into_iter()
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty())
                .collect();
        }
        if let Some(blocked) = patch.blocked_domains {
            current.blocked_domains = blocked
                .into_iter()
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty())
                .collect();
        }
        if let Some(preferred) = patch.preferred_target {
            current.preferred_target = preferred;
        }
        current.bot_id = bot_id;
        current.updated_at_ms = now_ms;

        {
            let mut guard = self.bot_profiles.write().unwrap_or_else(|e| e.into_inner());
            guard.insert((owner_user_id, bot_id), current.clone());
        }

        if prev_policy != current.run_policy || !current.enabled {
            let mut rem = self
                .session_remembered
                .write()
                .unwrap_or_else(|e| e.into_inner());
            rem.retain(|&(uid, bid, _)| !(uid == owner_user_id && (bid == bot_id || bid == 0)));
        }

        if current.enabled && current.run_policy != BrowserRunPolicy::Disabled {
            {
                let mut stopped = self
                    .emergency_stopped_users
                    .write()
                    .unwrap_or_else(|e| e.into_inner());
                stopped.remove(&owner_user_id);
            }
            let mut sessions = self
                .active_sessions
                .write()
                .unwrap_or_else(|e| e.into_inner());
            for ((uid, _), sess) in sessions.iter_mut() {
                if *uid == owner_user_id && sess.run_policy == BrowserRunPolicy::Disabled {
                    if let Some(mut_sess) = Arc::get_mut(sess) {
                        mut_sess.run_policy = current.run_policy;
                    } else {
                        let mut cloned = (**sess).clone_with_policy(current.run_policy);
                        cloned.last_seen_ms = now_ms;
                        *sess = Arc::new(cloned);
                    }
                }
            }
        }

        let allowed_json =
            serde_json::to_string(&current.allowed_domains).unwrap_or_else(|_| "[]".into());
        let blocked_json =
            serde_json::to_string(&current.blocked_domains).unwrap_or_else(|_| "[]".into());
        let preferred_str = preferred_target_as_str(current.preferred_target);
        let policy_str = current.run_policy.as_str().to_string();
        let enabled_int = i64::from(current.enabled);
        let _ = self.db.pool().with_conn(|conn| {
            conn.execute(
                "INSERT INTO bot_browser_profiles (
                    owner_user_id, bot_id, enabled, run_policy, allowed_domains_json,
                    blocked_domains_json, preferred_target, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(owner_user_id, bot_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    run_policy = excluded.run_policy,
                    allowed_domains_json = excluded.allowed_domains_json,
                    blocked_domains_json = excluded.blocked_domains_json,
                    preferred_target = excluded.preferred_target,
                    updated_at_ms = excluded.updated_at_ms",
                params![
                    owner_user_id as i64,
                    bot_id as i64,
                    enabled_int,
                    policy_str,
                    allowed_json,
                    blocked_json,
                    preferred_str,
                    now_ms
                ],
            )
            .map_err(|e| TelegramError::Database(e.to_string()))?;
            Ok(())
        });

        current
    }

    pub fn build_status_for_user(
        &self,
        owner_user_id: u64,
        bot_id: Option<u64>,
    ) -> BrowserBridgeStatusDto {
        let now_ms = Utc::now().timestamp_millis();
        let pending_count = {
            let guard = self
                .pending_approvals
                .read()
                .unwrap_or_else(|e| e.into_inner());
            guard
                .values()
                .filter(|e| e.dto.owner_user_id == owner_user_id && e.dto.expires_at_ms > now_ms)
                .count()
        };

        let is_emergency_stopped = self
            .emergency_stopped_users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&owner_user_id);

        let (ext_sess, desk_sess) = {
            let guard = self
                .active_sessions
                .read()
                .unwrap_or_else(|e| e.into_inner());
            (
                guard
                    .get(&(owner_user_id, BrowserBridgeHostKind::Server))
                    .cloned(),
                guard
                    .get(&(owner_user_id, BrowserBridgeHostKind::Desktop))
                    .cloned(),
            )
        };

        let mut sessions = Vec::new();
        if let Some(ref s) = ext_sess {
            sessions.push(s.to_dto());
        }
        if let Some(ref s) = desk_sess {
            sessions.push(s.to_dto());
        }

        let server_relay_connected = ext_sess.is_some();
        let desktop_bridge_connected =
            desk_sess.is_some() || ext_sess.as_ref().is_some_and(|s| s.desktop_bridge_connected);
        let primary = ext_sess.as_ref().or(desk_sess.as_ref());
        let local_cdp_available = global_cdp_manager().resolve_endpoint(None, None).is_some();

        let effective_policy = self.resolve_effective_policy(owner_user_id, bot_id, primary);

        let (connected, mode, active_tabs, extension_id, device_id) = if let Some(sess) = primary {
            let mode = match sess.host_kind {
                BrowserBridgeHostKind::Server => "server_ws_relay".to_string(),
                BrowserBridgeHostKind::Desktop => "desktop_ws_bridge".to_string(),
            };
            (
                true,
                mode,
                sess.tabs.len(),
                (!sess.extension_id.is_empty()).then(|| sess.extension_id.clone()),
                (!sess.device_id.is_empty()).then(|| sess.device_id.clone()),
            )
        } else if local_cdp_available {
            (false, "local_cdp_fallback".to_string(), 0, None, None)
        } else {
            (false, "disconnected".to_string(), 0, None, None)
        };

        BrowserBridgeStatusDto {
            ok: true,
            connected,
            mode: if is_emergency_stopped {
                "emergency_stopped".to_string()
            } else {
                mode
            },
            active_tabs,
            extension_id,
            device_id,
            run_policy: effective_policy,
            desktop_bridge_connected,
            server_relay_connected,
            local_cdp_available,
            sessions,
            pending_approvals_count: pending_count,
        }
    }

    pub fn list_tabs_for_user(&self, owner_user_id: u64) -> Vec<BrowserTabDto> {
        let guard = self
            .active_sessions
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(ext) = guard.get(&(owner_user_id, BrowserBridgeHostKind::Server)) {
            return ext.tabs.clone();
        }
        if let Some(desk) = guard.get(&(owner_user_id, BrowserBridgeHostKind::Desktop)) {
            return desk.tabs.clone();
        }
        Vec::new()
    }

    pub fn list_pending_for_user(&self, owner_user_id: u64) -> Vec<PendingBrowserCommandDto> {
        let now_ms = Utc::now().timestamp_millis();
        let mut guard = self
            .pending_approvals
            .write()
            .unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, entry| entry.dto.expires_at_ms > now_ms);
        let mut items: Vec<PendingBrowserCommandDto> = guard
            .values()
            .filter(|entry| entry.dto.owner_user_id == owner_user_id)
            .map(|entry| entry.dto.clone())
            .collect();
        items.sort_by_key(|c| c.created_at_ms);
        items
    }

    pub fn trigger_emergency_stop(&self, owner_user_id: u64, reason: Option<String>) {
        self.trigger_emergency_stop_excluding(owner_user_id, reason, None);
    }

    fn trigger_emergency_stop_excluding(
        &self,
        owner_user_id: u64,
        reason: Option<String>,
        exclude_generation: Option<u64>,
    ) {
        let now_ms = Utc::now().timestamp_millis();
        {
            let mut stopped = self
                .emergency_stopped_users
                .write()
                .unwrap_or_else(|e| e.into_inner());
            stopped.insert(owner_user_id);
        }
        {
            let mut rem = self
                .session_remembered
                .write()
                .unwrap_or_else(|e| e.into_inner());
            rem.retain(|&(uid, _, _)| uid != owner_user_id);
        }

        let stop_frame = BrowserBridgeFrame::emergency_stop(reason.clone(), now_ms)
            .to_json_string()
            .ok();

        let user_sessions: Vec<Arc<ActiveBridgeSession>> = {
            let mut guard = self
                .active_sessions
                .write()
                .unwrap_or_else(|e| e.into_inner());
            let mut found = Vec::new();
            for ((uid, _), sess) in guard.iter_mut() {
                if *uid == owner_user_id {
                    let updated = Arc::new((**sess).clone_with_policy(BrowserRunPolicy::Disabled));
                    *sess = Arc::clone(&updated);
                    found.push(updated);
                }
            }
            found
        };

        for sess in user_sessions {
            if exclude_generation != Some(sess.generation)
                && let Some(ref raw) = stop_frame
            {
                let _ = sess.tx.send(raw.clone());
            }
            sess.abort_all_in_flight(
                BrowserRpcErrorCode::PolicyDisabled,
                reason
                    .as_deref()
                    .unwrap_or("Emergency stop activated: browser control disabled"),
            );
        }

        let mut pending = self
            .pending_approvals
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let to_cancel: Vec<String> = pending
            .iter()
            .filter(|(_, e)| e.dto.owner_user_id == owner_user_id)
            .map(|(k, _)| k.clone())
            .collect();
        for cmd_id in to_cancel {
            if let Some(mut entry) = pending.remove(&cmd_id) {
                if let Some(tx) = entry.tx.take() {
                    let _ = tx.send(PendingApprovalResolution::EmergencyStopped);
                }
            }
        }
    }

    fn resolve_effective_policy(
        &self,
        owner_user_id: u64,
        bot_id: Option<u64>,
        session: Option<&Arc<ActiveBridgeSession>>,
    ) -> BrowserRunPolicy {
        if self
            .emergency_stopped_users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&owner_user_id)
        {
            return BrowserRunPolicy::Disabled;
        }
        if let Some(sess) = session {
            if sess.run_policy == BrowserRunPolicy::Disabled {
                return BrowserRunPolicy::Disabled;
            }
        }

        let lookup_bot_id = bot_id.unwrap_or(OFFICIAL_BOT_ID);
        let guard = self.bot_profiles.read().unwrap_or_else(|e| e.into_inner());
        if let Some(prof) = guard.get(&(owner_user_id, lookup_bot_id)) {
            if !prof.enabled || prof.run_policy == BrowserRunPolicy::Disabled {
                return BrowserRunPolicy::Disabled;
            }
            return prof.run_policy;
        }

        if let Some(sess) = session {
            return sess.run_policy;
        }
        BrowserRunPolicy::AlwaysAllowAuthorized
    }

    fn select_bridge_session(
        &self,
        owner_user_id: u64,
        preferred: BrowserPreferredTarget,
    ) -> Option<Arc<ActiveBridgeSession>> {
        let guard = self
            .active_sessions
            .read()
            .unwrap_or_else(|e| e.into_inner());
        match preferred {
            BrowserPreferredTarget::LocalCdp => None,
            BrowserPreferredTarget::DesktopBridge => guard
                .get(&(owner_user_id, BrowserBridgeHostKind::Desktop))
                .or_else(|| guard.get(&(owner_user_id, BrowserBridgeHostKind::Server)))
                .cloned(),
            BrowserPreferredTarget::ExtensionBridge | BrowserPreferredTarget::Auto => guard
                .get(&(owner_user_id, BrowserBridgeHostKind::Server))
                .or_else(|| guard.get(&(owner_user_id, BrowserBridgeHostKind::Desktop)))
                .cloned(),
        }
    }

    fn resolve_target_url_for_check(
        &self,
        owner_user_id: u64,
        tool: BrowserToolName,
        args: &Value,
    ) -> Option<(Option<u64>, String)> {
        if let Some(explicit_url) = args
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let tid = args.get("tab_id").and_then(Value::as_u64);
            return Some((tid, explicit_url.to_string()));
        }

        if matches!(
            tool,
            BrowserToolName::BrowserStatus
                | BrowserToolName::BrowserListTabs
                | BrowserToolName::BrowserGetActiveTab
        ) {
            return None;
        }

        let tabs = self.list_tabs_for_user(owner_user_id);
        if tabs.is_empty() {
            return None;
        }

        if let Some(tid) = args.get("tab_id").and_then(Value::as_u64) {
            if let Some(tab) = tabs.iter().find(|t| t.tab_id == tid) {
                if !tab.url.trim().is_empty() {
                    return Some((Some(tid), tab.url.clone()));
                }
            }
            return None;
        }

        tabs.iter()
            .find(|t| t.active)
            .or_else(|| tabs.first())
            .filter(|t| !t.url.trim().is_empty())
            .map(|t| (Some(t.tab_id), t.url.clone()))
    }

    pub async fn execute_for_user(
        &self,
        owner_user_id: u64,
        mut req: BrowserCommandRequest,
    ) -> Result<BrowserCommandResult, (StatusCode, String, String)> {
        let started = Instant::now();
        let raw_tool = req.tool.trim();
        let Some(tool_enum) = BrowserToolName::parse(raw_tool) else {
            return Err((
                StatusCode::BAD_REQUEST,
                "METHOD_NOT_FOUND".to_string(),
                format!("Unknown browser tool '{}'", req.tool),
            ));
        };
        let canonical_tool = tool_enum.as_str().to_string();

        if req.arguments.is_null() {
            req.arguments = json!({});
        }
        if let Err(validation_err) = validate_browser_tool_arguments(&req.arguments) {
            return Err((
                StatusCode::BAD_REQUEST,
                "INVALID_PARAMS".to_string(),
                validation_err,
            ));
        }

        // Sanitize download filename if present before dispatching
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

        let lookup_bot_id = req.bot_id.unwrap_or(OFFICIAL_BOT_ID);
        let profile = self.get_bot_profile(owner_user_id, lookup_bot_id);
        let bridge_session = self.select_bridge_session(owner_user_id, profile.preferred_target);
        let effective_policy =
            self.resolve_effective_policy(owner_user_id, req.bot_id, bridge_session.as_ref());

        if !profile.enabled || effective_policy == BrowserRunPolicy::Disabled {
            let mut fail = BrowserCommandResult::failure(
                BrowserRpcErrorCode::PolicyDisabled,
                "POLICY_DISABLED (-32003): Browser control is disabled by policy",
            );
            fail.command_id = req.command_id;
            fail.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(fail);
        }

        // Check URL scheme & restricted URLs for navigation/open/download/cookies + active target tab
        if matches!(
            tool_enum,
            BrowserToolName::BrowserOpenTab
                | BrowserToolName::BrowserNavigate
                | BrowserToolName::BrowserDownloadUrl
                | BrowserToolName::BrowserManageCookies
        ) {
            if let Some(raw_url) = req
                .arguments
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let allow_blank = matches!(
                    tool_enum,
                    BrowserToolName::BrowserOpenTab | BrowserToolName::BrowserNavigate
                );
                if let Err((code, msg)) = validate_navigable_browser_url(raw_url, allow_blank) {
                    let mut fail = BrowserCommandResult::failure(code, msg);
                    fail.command_id = req.command_id;
                    fail.duration_ms = started.elapsed().as_millis() as u64;
                    return Ok(fail);
                }
            }
        }

        let resolved_target =
            self.resolve_target_url_for_check(owner_user_id, tool_enum, &req.arguments);
        if let Some((_, ref target_url)) = resolved_target {
            if gpui_telegram_proto::browser_contracts::is_restricted_browser_url(target_url) {
                let mut fail = BrowserCommandResult::failure(
                    BrowserRpcErrorCode::RestrictedUrl,
                    format!(
                        "RESTRICTED_URL (-32004): Target URL is restricted and cannot be controlled: {target_url}"
                    ),
                );
                fail.command_id = req.command_id;
                fail.duration_ms = started.elapsed().as_millis() as u64;
                return Ok(fail);
            }
            if (!profile.allowed_domains.is_empty() || !profile.blocked_domains.is_empty())
                && target_url != "about:blank"
                && !profile.is_url_allowed(target_url)
            {
                let mut fail = BrowserCommandResult::failure(
                    BrowserRpcErrorCode::RestrictedUrl,
                    format!(
                        "RESTRICTED_URL (-32004): Domain policy blocks access to URL '{target_url}'"
                    ),
                );
                fail.command_id = req.command_id;
                fail.duration_ms = started.elapsed().as_millis() as u64;
                return Ok(fail);
            }
        }

        let resolved_tab_id = req
            .arguments
            .get("tab_id")
            .and_then(Value::as_u64)
            .or_else(|| resolved_target.as_ref().and_then(|(tid, _)| *tid));

        let injection_flagged = resolved_tab_id.is_some_and(|tid| {
            self.injection_flagged_tabs
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&(owner_user_id, tid))
        });

        let caller_kind = if req.bot_id.is_some() {
            BrowserCallerKind::Bot
        } else {
            BrowserCallerKind::User
        };
        let caller_info = BrowserCallerInfo {
            kind: caller_kind,
            user_id: Some(owner_user_id),
            bot_id: req.bot_id,
            bot_name: req.bot_name.clone(),
            chat_id: req.chat_id,
        };

        // Direct authenticated human user calls (`bot_id: None`) under `AlwaysAllowAuthorized`
        // without prompt-injection flags are pre-authorized by the user's own session, whereas
        // Bot calls and AskEveryTime / AllowReadOnly / injection-escalated calls enforce full gating.
        let policy_decision = if caller_kind == BrowserCallerKind::User
            && effective_policy == BrowserRunPolicy::AlwaysAllowAuthorized
            && !injection_flagged
        {
            BrowserPolicyDecision::Allow
        } else {
            effective_policy.evaluate(tool_enum.risk(), injection_flagged)
        };

        let command_id = req
            .command_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("bcmd_{}", Uuid::new_v4().simple()));
        let timeout_ms = req
            .timeout_ms
            .unwrap_or(DEFAULT_BROWSER_INVOKE_TIMEOUT_MS)
            .clamp(100, MAX_BROWSER_INVOKE_TIMEOUT_MS);

        let mut pre_approved = false;
        match policy_decision {
            BrowserPolicyDecision::Allow => {}
            BrowserPolicyDecision::Deny { code, reason } => {
                let mut fail = BrowserCommandResult::failure(code, reason);
                fail.command_id = Some(command_id);
                fail.duration_ms = started.elapsed().as_millis() as u64;
                return Ok(fail);
            }
            BrowserPolicyDecision::RequireApproval { reason } => {
                let session_key = (
                    owner_user_id,
                    req.bot_id.unwrap_or(0),
                    req.chat_id.unwrap_or(0),
                );
                let remembered = !injection_flagged
                    && self
                        .session_remembered
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .contains(&session_key);

                if remembered {
                    pre_approved = true;
                } else {
                    let now_ms = Utc::now().timestamp_millis();
                    let pending_dto = PendingBrowserCommandDto {
                        command_id: command_id.clone(),
                        owner_user_id,
                        tool: canonical_tool.clone(),
                        risk: tool_enum.risk(),
                        arguments: req.arguments.clone(),
                        caller: caller_info.clone(),
                        reason: reason.to_string(),
                        target_url: resolved_target.as_ref().map(|(_, u)| u.clone()),
                        injection_flagged,
                        created_at_ms: now_ms,
                        expires_at_ms: now_ms + (timeout_ms as i64),
                    };
                    let (tx, rx) = oneshot::channel();
                    {
                        let mut guard = self
                            .pending_approvals
                            .write()
                            .unwrap_or_else(|e| e.into_inner());
                        guard.insert(
                            command_id.clone(),
                            PendingApprovalEntry {
                                dto: pending_dto,
                                tx: Some(tx),
                            },
                        );
                    }
                    let mut cleanup_guard = PendingWaiterCleanupGuard {
                        service: self,
                        command_id: command_id.clone(),
                        disarmed: false,
                    };

                    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
                        Ok(Ok(PendingApprovalResolution::Approved {
                            remember_for_session,
                        })) => {
                            cleanup_guard.disarmed = true;
                            pre_approved = true;
                            if remember_for_session && !injection_flagged {
                                let mut rem = self
                                    .session_remembered
                                    .write()
                                    .unwrap_or_else(|e| e.into_inner());
                                rem.insert(session_key);
                            }
                        }
                        Ok(Ok(PendingApprovalResolution::EmergencyStopped)) => {
                            cleanup_guard.disarmed = true;
                            let mut fail = BrowserCommandResult::failure(
                                BrowserRpcErrorCode::PolicyDisabled,
                                "POLICY_DISABLED (-32003): Aborted by emergency stop",
                            );
                            fail.command_id = Some(command_id);
                            fail.duration_ms = started.elapsed().as_millis() as u64;
                            return Ok(fail);
                        }
                        Ok(Ok(PendingApprovalResolution::Denied)) | Ok(Err(_)) => {
                            cleanup_guard.disarmed = true;
                            let mut fail = BrowserCommandResult::failure(
                                BrowserRpcErrorCode::UserDeniedApproval,
                                "USER_DENIED_APPROVAL (-32002): Browser command denied by user",
                            );
                            fail.command_id = Some(command_id);
                            fail.duration_ms = started.elapsed().as_millis() as u64;
                            return Ok(fail);
                        }
                        Err(_) => {
                            drop(cleanup_guard);
                            let mut fail = BrowserCommandResult::failure(
                                BrowserRpcErrorCode::UserDeniedApproval,
                                format!(
                                    "USER_DENIED_APPROVAL (-32002): Approval timed out after {timeout_ms}ms"
                                ),
                            );
                            fail.command_id = Some(command_id);
                            fail.duration_ms = started.elapsed().as_millis() as u64;
                            return Ok(fail);
                        }
                    }
                }
            }
        }

        // Fast-path `browser_status` directly from live relay state (and live Extension status when connected)
        if tool_enum == BrowserToolName::BrowserStatus {
            let mut status_dto = self.build_status_for_user(owner_user_id, req.bot_id);
            if let Some(ref sess) = bridge_session {
                if sess.host_kind == BrowserBridgeHostKind::Server {
                    let live_probe = self
                        .invoke_via_ws_session(
                            sess,
                            "browser_status",
                            json!({}),
                            caller_info.clone(),
                            2_500,
                            true,
                        )
                        .await;
                    if live_probe.ok {
                        if let Some(desk_conn) = live_probe
                            .data
                            .get("desktop_bridge_connected")
                            .and_then(Value::as_bool)
                        {
                            status_dto.desktop_bridge_connected =
                                status_dto.desktop_bridge_connected || desk_conn;
                        }
                    }
                }
            }
            let mut status_val = serde_json::to_value(&status_dto).unwrap_or_else(|_| json!({}));
            if let Some(obj) = status_val.as_object_mut() {
                obj.insert(
                    "extension_connected".to_string(),
                    Value::Bool(status_dto.server_relay_connected),
                );
            }
            let mut res = BrowserCommandResult::success(status_val);
            res.command_id = Some(command_id);
            res.executed_via = status_dto.mode;
            res.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(res);
        }

        // Primary execution: connected Extension or Desktop WebSocket bridge
        let arg_cdp_url = req.arguments.get("cdp_url").and_then(Value::as_str);
        let mut cmd_result = if let Some(sess) = bridge_session {
            self.invoke_via_ws_session(
                &sess,
                &canonical_tool,
                req.arguments.clone(),
                caller_info,
                timeout_ms,
                pre_approved,
            )
            .await
        } else if profile.preferred_target != BrowserPreferredTarget::ExtensionBridge
            && global_cdp_manager().resolve_endpoint(arg_cdp_url, None).is_some()
        {
            // Secondary fallback: configured local CDP endpoint (`HERMES_BROWSER_CDP_URL`)
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
                "BROWSER_EXTENSION_NOT_CONNECTED (-32008): No browser extension or desktop bridge is connected for this user, and no local CDP fallback is available",
            )
        };

        cmd_result.command_id = Some(command_id);
        cmd_result.duration_ms = started.elapsed().as_millis() as u64;

        if cmd_result.ok {
            self.post_process_tool_result(
                owner_user_id,
                tool_enum,
                resolved_tab_id,
                &mut cmd_result,
            );
        }

        Ok(cmd_result)
    }

    async fn invoke_via_ws_session(
        &self,
        sess: &Arc<ActiveBridgeSession>,
        canonical_tool: &str,
        arguments: Value,
        caller: BrowserCallerInfo,
        timeout_ms: u64,
        approved: bool,
    ) -> BrowserCommandResult {
        let seq = self.next_rpc_seq.fetch_add(1, Ordering::Relaxed);
        let rpc_id_str = format!("inv_{seq}");
        let frame = BrowserBridgeFrame::invoke(
            rpc_id_str.clone(),
            BrowserInvokeParams {
                tool: canonical_tool.to_string(),
                arguments,
                caller,
                timeout_ms,
                approved,
            },
        );
        let Ok(serialized) = frame.to_json_string() else {
            return BrowserCommandResult::failure(
                BrowserRpcErrorCode::InternalError,
                "Failed to serialize browser.invoke JSON-RPC frame",
            );
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut in_flight = sess.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight.insert(rpc_id_str.clone(), tx);
        }

        if sess.tx.send(serialized).is_err() {
            let mut in_flight = sess.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight.remove(&rpc_id_str);
            return BrowserCommandResult::failure(
                BrowserRpcErrorCode::CdpAttachFailed,
                "BROWSER_EXTENSION_NOT_CONNECTED (-32008): Browser bridge WebSocket closed before dispatch",
            );
        }

        let via = match sess.host_kind {
            BrowserBridgeHostKind::Server => "server_ws_relay",
            BrowserBridgeHostKind::Desktop => "desktop_ws_bridge",
        };

        match tokio::time::timeout(Duration::from_millis(timeout_ms + 500), rx).await {
            Ok(Ok(rpc_resp)) => {
                if let Some(err) = rpc_resp.error {
                    let code = err.rpc_code().unwrap_or(BrowserRpcErrorCode::InternalError);
                    let mut fail = BrowserCommandResult::failure(code, err.message);
                    fail.executed_via = via.to_string();
                    return fail;
                }
                let mut result_val = rpc_resp.result.unwrap_or_else(|| json!({ "ok": true }));
                if let Some(err_obj) = result_val.get("error").and_then(Value::as_object) {
                    if result_val.get("ok").and_then(Value::as_bool) == Some(false) {
                        let code_num = err_obj
                            .get("code")
                            .and_then(Value::as_i64)
                            .map(|n| n as i32)
                            .and_then(BrowserRpcErrorCode::from_code)
                            .unwrap_or(BrowserRpcErrorCode::InternalError);
                        let msg = err_obj
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Browser tool failed");
                        let mut fail = BrowserCommandResult::failure(code_num, msg);
                        fail.executed_via = via.to_string();
                        return fail;
                    }
                }
                if result_val.get("ok").and_then(Value::as_bool) == Some(false) {
                    let code = result_val
                        .get("rpc_code")
                        .or_else(|| result_val.get("code"))
                        .and_then(Value::as_i64)
                        .map(|n| n as i32)
                        .and_then(BrowserRpcErrorCode::from_code)
                        .or_else(|| {
                            result_val
                                .get("error_code")
                                .and_then(Value::as_str)
                                .and_then(BrowserRpcErrorCode::from_error_str)
                        })
                        .unwrap_or(BrowserRpcErrorCode::InternalError);
                    let msg = result_val
                        .get("error_message")
                        .or_else(|| result_val.get("message"))
                        .or_else(|| result_val.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or("Browser tool returned ok: false");
                    let mut fail = BrowserCommandResult::failure(code, msg);
                    fail.executed_via = via.to_string();
                    return fail;
                }

                if let Some(obj) = result_val.as_object_mut() {
                    obj.entry("ok".to_string()).or_insert(Value::Bool(true));
                }

                let artifact = extract_screenshot_artifact(canonical_tool, &result_val);
                let mut ok_res = BrowserCommandResult::success(result_val);
                ok_res.artifact = artifact;
                ok_res.executed_via = via.to_string();
                ok_res
            }
            Ok(Err(_)) => {
                let mut fail = BrowserCommandResult::failure(
                    BrowserRpcErrorCode::CdpAttachFailed,
                    "BROWSER_EXTENSION_NOT_CONNECTED (-32008): Browser bridge WebSocket disconnected mid-request",
                );
                fail.executed_via = via.to_string();
                fail
            }
            Err(_) => {
                {
                    let mut in_flight = sess.in_flight.lock().unwrap_or_else(|e| e.into_inner());
                    in_flight.remove(&rpc_id_str);
                }
                let mut fail = BrowserCommandResult::failure(
                    BrowserRpcErrorCode::NavigationTimeout,
                    format!(
                        "NAVIGATION_TIMEOUT (-32007): Browser bridge invocation '{}' timed out after {timeout_ms}ms",
                        canonical_tool
                    ),
                );
                fail.executed_via = via.to_string();
                fail
            }
        }
    }

    fn post_process_tool_result(
        &self,
        owner_user_id: u64,
        tool: BrowserToolName,
        fallback_tab_id: Option<u64>,
        res: &mut BrowserCommandResult,
    ) {
        let effective_tid = res.tab_id.or(fallback_tab_id);

        if matches!(
            tool,
            BrowserToolName::BrowserNavigate | BrowserToolName::BrowserOpenTab
        ) {
            if let Some(tid) = effective_tid {
                let mut guard = self
                    .injection_flagged_tabs
                    .write()
                    .unwrap_or_else(|e| e.into_inner());
                guard.remove(&(owner_user_id, tid));
            }
        }

        if matches!(
            tool,
            BrowserToolName::BrowserSnapshot | BrowserToolName::BrowserExtractMarkdown
        ) {
            let text_field = if tool == BrowserToolName::BrowserSnapshot {
                "markdown_excerpt"
            } else {
                "markdown"
            };
            if let Some(obj) = res.data.as_object_mut() {
                let raw_text = obj
                    .get(text_field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let title_text = obj
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let combined_for_scan = if title_text.is_empty() {
                    raw_text.clone()
                } else {
                    format!("{title_text}\n{raw_text}")
                };

                let rust_scan = scan_content_for_injection(&combined_for_scan);
                let mut scan_dto = to_browser_injection_dto(&rust_scan);

                // Merge any findings already reported by the Extension WASM scanner
                if let Some(existing_val) = obj.get("injection_scan") {
                    if let Ok(existing_dto) =
                        serde_json::from_value::<BrowserInjectionScanDto>(existing_val.clone())
                    {
                        if existing_dto.flagged {
                            scan_dto.flagged = true;
                        }
                        if existing_dto.severity > scan_dto.severity {
                            scan_dto.severity = existing_dto.severity;
                        }
                        if existing_dto.secrets_detected > scan_dto.secrets_detected {
                            scan_dto.secrets_detected = existing_dto.secrets_detected;
                        }
                        for f in existing_dto.findings {
                            if !scan_dto.findings.iter().any(|ef| ef.rule_id == f.rule_id) {
                                scan_dto.findings.push(f);
                            }
                        }
                    }
                }

                if !raw_text.is_empty() {
                    let field_scan = scan_content_for_injection(&raw_text);
                    obj.insert(
                        text_field.to_string(),
                        Value::String(field_scan.sanitized_text),
                    );
                }

                if let Some(tid) = effective_tid {
                    let mut guard = self
                        .injection_flagged_tabs
                        .write()
                        .unwrap_or_else(|e| e.into_inner());
                    if scan_dto.severity == BrowserInjectionSeverity::High {
                        guard.insert((owner_user_id, tid));
                    } else if !scan_dto.flagged {
                        guard.remove(&(owner_user_id, tid));
                    }
                }

                if let Ok(scan_json) = serde_json::to_value(&scan_dto) {
                    obj.insert("injection_scan".to_string(), scan_json);
                }
            }
        }

        if let Some(obj) = res.data.as_object_mut() {
            obj.entry("ok".to_string()).or_insert(Value::Bool(true));
        }
    }

    fn handle_pairing(
        &self,
        owner_user_id: u64,
        req: BrowserPairingRequest,
        server_ws_url: String,
    ) -> BrowserPairingDto {
        let now_ms = Utc::now().timestamp_millis();
        let desktop_port = req
            .desktop_port
            .filter(|&p| p > 0)
            .unwrap_or(DEFAULT_DESKTOP_BRIDGE_PORT);

        let record = match req.action {
            BrowserPairingAction::Verify => {
                let candidate = req
                    .pairing_token
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("");
                let mut guard = self.pairings.write().unwrap_or_else(|e| e.into_inner());
                if let Some(existing) = guard.get_mut(&owner_user_id) {
                    let is_match = !candidate.is_empty()
                        && constant_time_eq(existing.pairing_token.as_bytes(), candidate.as_bytes());
                    if is_match {
                        existing.verified = true;
                        if req.extension_id.is_some() {
                            existing.extension_id = req.extension_id.clone();
                        }
                    }
                    let mut out = existing.clone();
                    out.verified = is_match;
                    out
                } else {
                    StoredPairingRecord {
                        owner_user_id,
                        pairing_token: String::new(),
                        desktop_port,
                        extension_id: req.extension_id,
                        verified: false,
                        created_at_ms: now_ms,
                        expires_at_ms: None,
                    }
                }
            }
            BrowserPairingAction::Issue | BrowserPairingAction::Rotate => {
                let mut guard = self.pairings.write().unwrap_or_else(|e| e.into_inner());
                if req.action == BrowserPairingAction::Issue {
                    if let Some(existing) = guard.get(&owner_user_id) {
                        if !existing.pairing_token.is_empty() {
                            let rec = existing.clone();
                            drop(guard);
                            return BrowserPairingDto {
                                ok: true,
                                pairing_token: rec.pairing_token.clone(),
                                desktop_ws_url: format!(
                                    "ws://127.0.0.1:{}/ext/ws?token={}",
                                    rec.desktop_port, rec.pairing_token
                                ),
                                server_ws_url,
                                verified: rec.verified,
                                created_at_ms: rec.created_at_ms,
                                expires_at_ms: rec.expires_at_ms,
                            };
                        }
                    }
                }

                let token = mint_csprng_hex_token();
                let rec = StoredPairingRecord {
                    owner_user_id,
                    pairing_token: token,
                    desktop_port,
                    extension_id: req.extension_id,
                    verified: false,
                    created_at_ms: now_ms,
                    expires_at_ms: Some(now_ms + 30 * 24 * 3600 * 1000),
                };
                guard.insert(owner_user_id, rec.clone());
                drop(guard);
                self.persist_pairing(&rec);
                rec
            }
        };

        if req.action == BrowserPairingAction::Verify && record.verified {
            self.persist_pairing(&record);
        }

        BrowserPairingDto {
            ok: req.action != BrowserPairingAction::Verify || record.verified,
            pairing_token: record.pairing_token.clone(),
            desktop_ws_url: format!(
                "ws://127.0.0.1:{}/ext/ws?token={}",
                record.desktop_port, record.pairing_token
            ),
            server_ws_url,
            verified: record.verified,
            created_at_ms: record.created_at_ms,
            expires_at_ms: record.expires_at_ms,
        }
    }

    fn persist_pairing(&self, rec: &StoredPairingRecord) {
        let _ = self.db.pool().with_conn(|conn| {
            conn.execute(
                "INSERT INTO browser_pairings (
                    owner_user_id, pairing_token, desktop_port, extension_id, verified, created_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(owner_user_id) DO UPDATE SET
                    pairing_token = excluded.pairing_token,
                    desktop_port = excluded.desktop_port,
                    extension_id = excluded.extension_id,
                    verified = excluded.verified,
                    created_at_ms = excluded.created_at_ms,
                    expires_at_ms = excluded.expires_at_ms",
                params![
                    rec.owner_user_id as i64,
                    rec.pairing_token,
                    i64::from(rec.desktop_port),
                    rec.extension_id,
                    i64::from(rec.verified),
                    rec.created_at_ms,
                    rec.expires_at_ms
                ],
            )
            .map_err(|e| TelegramError::Database(e.to_string()))?;
            Ok(())
        });
    }
}

impl ActiveBridgeSession {
    fn clone_with_policy(&self, run_policy: BrowserRunPolicy) -> Self {
        Self {
            generation: self.generation,
            session_id: self.session_id.clone(),
            owner_user_id: self.owner_user_id,
            host_kind: self.host_kind,
            extension_id: self.extension_id.clone(),
            device_id: self.device_id.clone(),
            user_agent: self.user_agent.clone(),
            protocol_version: self.protocol_version,
            capabilities: self.capabilities.clone(),
            run_policy,
            tabs: self.tabs.clone(),
            desktop_bridge_connected: self.desktop_bridge_connected,
            connected_at_ms: self.connected_at_ms,
            last_seen_ms: Utc::now().timestamp_millis(),
            tx: self.tx.clone(),
            in_flight: Arc::clone(&self.in_flight),
        }
    }
}

impl BrowserBridgeProvider for BrowserControlService {
    fn status<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<BrowserBridgeStatusDto, String>> {
        Box::pin(async move {
            let Some(uid) = user_id else {
                let mut dto = BrowserBridgeStatusDto::default();
                dto.local_cdp_available = global_cdp_manager().resolve_endpoint(None, None).is_some();
                return Ok(dto);
            };
            Ok(self.build_status_for_user(uid, bot_id))
        })
    }

    fn list_tabs<'a>(
        &'a self,
        user_id: Option<u64>,
        _bot_id: Option<u64>,
    ) -> BrowserBoxFuture<'a, Result<Vec<BrowserTabDto>, String>> {
        Box::pin(async move {
            let Some(uid) = user_id else {
                return Ok(Vec::new());
            };
            Ok(self.list_tabs_for_user(uid))
        })
    }

    fn should_route_via_bridge(&self, user_id: Option<u64>, bot_id: Option<u64>) -> bool {
        let Some(uid) = user_id else {
            return false;
        };
        if self
            .emergency_stopped_users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&uid)
        {
            return true;
        }
        let lookup_bot_id = bot_id.unwrap_or(OFFICIAL_BOT_ID);
        let profile = self.get_bot_profile(uid, lookup_bot_id);
        if !profile.enabled
            || profile.run_policy != BrowserRunPolicy::AlwaysAllowAuthorized
            || !profile.allowed_domains.is_empty()
            || !profile.blocked_domains.is_empty()
            || profile.preferred_target == BrowserPreferredTarget::ExtensionBridge
        {
            return true;
        }
        if profile.preferred_target == BrowserPreferredTarget::LocalCdp {
            return false;
        }
        let guard = self
            .active_sessions
            .read()
            .unwrap_or_else(|e| e.into_inner());
        guard.contains_key(&(uid, BrowserBridgeHostKind::Server))
            || guard.contains_key(&(uid, BrowserBridgeHostKind::Desktop))
    }

    fn execute<'a>(
        &'a self,
        user_id: Option<u64>,
        req: BrowserCommandRequest,
    ) -> BrowserBoxFuture<'a, Result<BrowserCommandResult, String>> {
        Box::pin(async move {
            let Some(uid) = user_id else {
                return Ok(BrowserCommandResult::failure(
                    BrowserRpcErrorCode::UnauthorizedBridge,
                    "UNAUTHORIZED_BRIDGE (-32001): Missing user_id context for server browser relay",
                ));
            };
            match self.execute_for_user(uid, req).await {
                Ok(res) => Ok(res),
                Err((_, code, msg)) => {
                    let rpc = BrowserRpcErrorCode::from_error_str(&code)
                        .unwrap_or(BrowserRpcErrorCode::InvalidParams);
                    Ok(BrowserCommandResult::failure(rpc, msg))
                }
            }
        })
    }

    fn set_policy<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
        policy: BrowserRunPolicy,
    ) -> BrowserBoxFuture<'a, Result<BotBrowserProfileDto, String>> {
        Box::pin(async move {
            let Some(uid) = user_id else {
                return Err("user_id is required to update browser policy".to_string());
            };
            let target_bot = bot_id.unwrap_or(OFFICIAL_BOT_ID);
            Ok(self.upsert_bot_profile(
                uid,
                target_bot,
                UpdateBotBrowserProfileRequest {
                    enabled: Some(policy != BrowserRunPolicy::Disabled),
                    run_policy: Some(policy),
                    allowed_domains: None,
                    blocked_domains: None,
                    preferred_target: None,
                },
            ))
        })
    }

    fn emergency_stop<'a>(
        &'a self,
        user_id: Option<u64>,
        bot_id: Option<u64>,
        reason: Option<String>,
    ) -> BrowserBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if let Some(uid) = user_id {
                self.trigger_emergency_stop(uid, reason);
                let target_bot = bot_id.unwrap_or(OFFICIAL_BOT_ID);
                self.upsert_bot_profile(
                    uid,
                    target_bot,
                    UpdateBotBrowserProfileRequest {
                        enabled: Some(false),
                        run_policy: Some(BrowserRunPolicy::Disabled),
                        allowed_domains: None,
                        blocked_domains: None,
                        preferred_target: None,
                    },
                );
            }
            Ok(())
        })
    }
}

// ============================================================================
// HTTP & WebSocket Route Handlers (`/api/v1/browser/*` & `/api/v1/bots/{bot_id}/browser`)
// ============================================================================

#[derive(Debug, Deserialize, Default)]
pub struct BrowserWsQuery {
    pub client: Option<String>,
    pub bot_id: Option<u64>,
}

/// Validates `Origin` header for `/api/v1/browser/ws` before upgrading:
/// - Absent `Origin` (native Rust Desktop bridge / headless CLI WS client) -> allowed (`true`)
/// - `chrome-extension://<id>` -> allowed (`true`)
/// - Any web origin (`http://`, `https://`, `null`, etc.) -> rejected (`false` -> `403 Forbidden`)
fn is_allowed_browser_ws_origin(headers: &HeaderMap) -> bool {
    let Some(origin_hdr) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin_str) = origin_hdr.to_str() else {
        return false;
    };
    let trimmed = origin_str.trim();
    trimmed.starts_with("chrome-extension://") && trimmed.len() > "chrome-extension://".len()
}

pub async fn browser_ws_handler(
    headers: HeaderMap,
    auth_res: Result<AuthBearer, (StatusCode, Json<Value>)>,
    Query(query): Query<BrowserWsQuery>,
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Response {
    if !is_allowed_browser_ws_origin(&headers) {
        return err_resp(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "WebSocket Origin must be chrome-extension:// or omitted for native bridge clients",
        );
    }

    let auth = match auth_res {
        Ok(a) => a,
        Err((status, body)) => return (status, body).into_response(),
    };

    let host_kind = match query
        .client
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("desktop") => BrowserBridgeHostKind::Desktop,
        _ => BrowserBridgeHostKind::Server,
    };

    let owner_user_id = auth.user_id.0;
    let service = Arc::clone(&state.browser);

    ws.max_message_size(MAX_BROWSER_WS_FRAME_BYTES)
        .max_frame_size(MAX_BROWSER_WS_FRAME_BYTES)
        .on_upgrade(move |socket| run_browser_ws_session(service, owner_user_id, host_kind, socket))
}

async fn run_browser_ws_session(
    service: Arc<BrowserControlService>,
    owner_user_id: u64,
    host_kind: BrowserBridgeHostKind,
    socket: WebSocket,
) {
    let generation = service.next_generation.fetch_add(1, Ordering::SeqCst);
    let session_id = format!("bsess_{}", Uuid::new_v4().simple());
    let now_ms = Utc::now().timestamp_millis();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let in_flight: Arc<Mutex<HashMap<String, oneshot::Sender<BrowserJsonRpcResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let initial_policy = service
        .get_bot_profile(owner_user_id, OFFICIAL_BOT_ID)
        .run_policy;
    let session = Arc::new(ActiveBridgeSession {
        generation,
        session_id: session_id.clone(),
        owner_user_id,
        host_kind,
        extension_id: String::new(),
        device_id: String::new(),
        user_agent: String::new(),
        protocol_version: 1,
        capabilities: Vec::new(),
        run_policy: initial_policy,
        tabs: Vec::new(),
        desktop_bridge_connected: host_kind == BrowserBridgeHostKind::Desktop,
        connected_at_ms: now_ms,
        last_seen_ms: now_ms,
        tx: tx.clone(),
        in_flight: Arc::clone(&in_flight),
    });

    // Replace any prior WS session for `(owner_user_id, host_kind)` cleanly
    let replaced = {
        let mut guard = service
            .active_sessions
            .write()
            .unwrap_or_else(|e| e.into_inner());
        guard.insert((owner_user_id, host_kind), Arc::clone(&session))
    };
    if let Some(old) = replaced {
        old.abort_all_in_flight(
            BrowserRpcErrorCode::CdpAttachFailed,
            "Superseded by newer browser bridge WebSocket connection",
        );
    }

    let (mut ws_sink, mut ws_stream) = socket.split();

    let writer_task = tokio::spawn(async move {
        let mut ping_interval =
            tokio::time::interval(Duration::from_secs(DEFAULT_BRIDGE_PING_INTERVAL_SECS));
        ping_interval.tick().await;
        loop {
            tokio::select! {
                maybe_msg = rx.recv() => {
                    let Some(raw_text) = maybe_msg else {
                        break;
                    };
                    if ws_sink.send(Message::Text(raw_text.into())).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    let ts = Utc::now().timestamp_millis();
                    if let Ok(ping_json) = BrowserBridgeFrame::ping(ts).to_json_string() {
                        if ws_sink.send(Message::Text(ping_json.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    while let Some(msg_res) = ws_stream.next().await {
        let msg = match msg_res {
            Ok(m) => m,
            Err(_) => break,
        };

        match msg {
            Message::Text(text_bytes) => {
                let raw_str: &str = &text_bytes;
                if raw_str.len() > MAX_BROWSER_WS_FRAME_BYTES {
                    let err_resp = BrowserJsonRpcResponse::err(
                        None,
                        BrowserRpcErrorCode::InvalidRequest,
                        "WebSocket frame exceeds 32 MiB maximum size",
                    );
                    if let Ok(s) = serde_json::to_string(&err_resp) {
                        let _ = tx.send(s);
                    }
                    break;
                }

                let parsed = match BrowserBridgeFrame::parse_json(raw_str) {
                    Ok(f) => f,
                    Err(parse_err) => {
                        let err_frame = BrowserJsonRpcResponse::err(
                            None,
                            BrowserRpcErrorCode::ParseError,
                            format!("Invalid JSON-RPC 2.0 frame: {parse_err}"),
                        );
                        if let Ok(s) = serde_json::to_string(&err_frame) {
                            let _ = tx.send(s);
                        }
                        continue;
                    }
                };

                let seen_ms = Utc::now().timestamp_millis();
                match parsed {
                    BrowserBridgeFrame::Hello { id, params } => {
                        {
                            let mut guard = service
                                .active_sessions
                                .write()
                                .unwrap_or_else(|e| e.into_inner());
                            if let Some(curr) = guard.get_mut(&(owner_user_id, host_kind)) {
                                if curr.generation == generation {
                                    *curr = Arc::new(ActiveBridgeSession {
                                        generation,
                                        session_id: curr.session_id.clone(),
                                        owner_user_id,
                                        host_kind,
                                        extension_id: params.extension_id.clone(),
                                        device_id: params.device_id.clone(),
                                        user_agent: params.user_agent.clone(),
                                        protocol_version: params.protocol_version,
                                        capabilities: params.capabilities.clone(),
                                        run_policy: params.run_policy,
                                        tabs: params.tabs_summary.clone(),
                                        desktop_bridge_connected: params.desktop_bridge_connected
                                            || host_kind == BrowserBridgeHostKind::Desktop,
                                        connected_at_ms: curr.connected_at_ms,
                                        last_seen_ms: seen_ms,
                                        tx: curr.tx.clone(),
                                        in_flight: Arc::clone(&curr.in_flight),
                                    });
                                }
                            }
                        }
                        if params.run_policy != BrowserRunPolicy::Disabled {
                            let mut stopped = service
                                .emergency_stopped_users
                                .write()
                                .unwrap_or_else(|e| e.into_inner());
                            stopped.remove(&owner_user_id);
                        }
                        let ack = BrowserBridgeFrame::HelloAck {
                            id,
                            params: BridgeHelloAckParams {
                                accepted: true,
                                host_kind: BrowserBridgeHostKind::Server,
                                host_version: env!("CARGO_PKG_VERSION").to_string(),
                                ping_interval_secs: DEFAULT_BRIDGE_PING_INTERVAL_SECS,
                                reason: None,
                            },
                        };
                        if let Ok(ack_json) = ack.to_json_string() {
                            let _ = tx.send(ack_json);
                        }
                    }
                    BrowserBridgeFrame::TabsSync { params } => {
                        let mut prev_policy = None;
                        {
                            let mut guard = service
                                .active_sessions
                                .write()
                                .unwrap_or_else(|e| e.into_inner());
                            if let Some(curr) = guard.get_mut(&(owner_user_id, host_kind)) {
                                if curr.generation == generation {
                                    prev_policy = Some(curr.run_policy);
                                    *curr = Arc::new(ActiveBridgeSession {
                                        generation,
                                        session_id: curr.session_id.clone(),
                                        owner_user_id,
                                        host_kind,
                                        extension_id: curr.extension_id.clone(),
                                        device_id: curr.device_id.clone(),
                                        user_agent: curr.user_agent.clone(),
                                        protocol_version: curr.protocol_version,
                                        capabilities: curr.capabilities.clone(),
                                        run_policy: params.run_policy,
                                        tabs: params.tabs,
                                        desktop_bridge_connected: params.desktop_bridge_connected
                                            || host_kind == BrowserBridgeHostKind::Desktop,
                                        connected_at_ms: curr.connected_at_ms,
                                        last_seen_ms: seen_ms,
                                        tx: curr.tx.clone(),
                                        in_flight: Arc::clone(&curr.in_flight),
                                    });
                                }
                            }
                        }
                        if prev_policy.is_some_and(|p| p != params.run_policy) {
                            let mut rem = service
                                .session_remembered
                                .write()
                                .unwrap_or_else(|e| e.into_inner());
                            rem.retain(|&(uid, _, _)| uid != owner_user_id);
                        }
                        if params.run_policy != BrowserRunPolicy::Disabled {
                            let mut stopped = service
                                .emergency_stopped_users
                                .write()
                                .unwrap_or_else(|e| e.into_inner());
                            stopped.remove(&owner_user_id);
                        }
                    }
                    BrowserBridgeFrame::Ping { id, params } => {
                        let pong = BrowserBridgeFrame::Pong { id, params };
                        if let Ok(pong_json) = pong.to_json_string() {
                            let _ = tx.send(pong_json);
                        }
                    }
                    BrowserBridgeFrame::Pong { .. } => {
                        let mut guard = service
                            .active_sessions
                            .write()
                            .unwrap_or_else(|e| e.into_inner());
                        if let Some(curr) = guard.get_mut(&(owner_user_id, host_kind)) {
                            if curr.generation == generation {
                                if let Some(mut_curr) = Arc::get_mut(curr) {
                                    mut_curr.last_seen_ms = seen_ms;
                                }
                            }
                        }
                    }
                    BrowserBridgeFrame::EmergencyStop { id, params } => {
                        service.trigger_emergency_stop_excluding(
                            owner_user_id,
                            params.reason,
                            Some(generation),
                        );
                        if let Some(req_id) = id {
                            let ack = BrowserJsonRpcResponse::ok(req_id, json!({ "ok": true }));
                            if let Ok(s) = serde_json::to_string(&ack) {
                                let _ = tx.send(s);
                            }
                        }
                    }
                    BrowserBridgeFrame::Response(resp) => {
                        if let Some(ref resp_id) = resp.id {
                            let key = resp_id.as_key_string();
                            let waiter = {
                                let mut guard = in_flight.lock().unwrap_or_else(|e| e.into_inner());
                                guard.remove(&key)
                            };
                            if let Some(sender) = waiter {
                                let _ = sender.send(resp);
                            }
                        }
                    }
                    BrowserBridgeFrame::Invoke { id, params } => {
                        // Allow Desktop bridge client connected to `/api/v1/browser/ws?client=desktop`
                        // to invoke the user's Extension session via the server relay if desired
                        let svc = Arc::clone(&service);
                        let reply_tx = tx.clone();
                        tokio::spawn(async move {
                            let cmd_req = BrowserCommandRequest {
                                command_id: None,
                                tool: params.tool,
                                arguments: params.arguments,
                                bot_id: params.caller.bot_id,
                                bot_name: params.caller.bot_name,
                                chat_id: params.caller.chat_id,
                                timeout_ms: Some(params.timeout_ms),
                            };
                            let rpc_resp = match svc.execute_for_user(owner_user_id, cmd_req).await
                            {
                                Ok(res) if res.ok => BrowserJsonRpcResponse::ok(id, res.data),
                                Ok(res) => {
                                    let code = res
                                        .rpc_code
                                        .and_then(BrowserRpcErrorCode::from_code)
                                        .unwrap_or(BrowserRpcErrorCode::InternalError);
                                    BrowserJsonRpcResponse::err(
                                        Some(id),
                                        code,
                                        res.error_message
                                            .unwrap_or_else(|| "Browser invoke failed".into()),
                                    )
                                }
                                Err((_, code_str, msg)) => {
                                    let code = BrowserRpcErrorCode::from_error_str(&code_str)
                                        .unwrap_or(BrowserRpcErrorCode::InvalidParams);
                                    BrowserJsonRpcResponse::err(Some(id), code, msg)
                                }
                            };
                            if let Ok(raw) = serde_json::to_string(&rpc_resp) {
                                let _ = reply_tx.send(raw);
                            }
                        });
                    }
                    BrowserBridgeFrame::HelloAck { .. } => {}
                }
            }
            Message::Binary(_) => {
                let err_frame = BrowserJsonRpcResponse::err(
                    None,
                    BrowserRpcErrorCode::InvalidRequest,
                    "Binary WebSocket frames are not supported; expected UTF-8 JSON-RPC 2.0 text",
                );
                if let Ok(s) = serde_json::to_string(&err_frame) {
                    let _ = tx.send(s);
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    writer_task.abort();

    // Generation-fenced disconnect cleanup + immediate `<10ms` in-flight waiter abort
    let removed = {
        let mut guard = service
            .active_sessions
            .write()
            .unwrap_or_else(|e| e.into_inner());
        if guard
            .get(&(owner_user_id, host_kind))
            .is_some_and(|s| s.generation == generation)
        {
            guard.remove(&(owner_user_id, host_kind))
        } else {
            None
        }
    };
    if let Some(dead_sess) = removed {
        dead_sess.abort_all_in_flight(
            BrowserRpcErrorCode::CdpAttachFailed,
            "BROWSER_EXTENSION_NOT_CONNECTED (-32008): Browser bridge WebSocket disconnected mid-request",
        );
    } else {
        session.abort_all_in_flight(
            BrowserRpcErrorCode::CdpAttachFailed,
            "BROWSER_EXTENSION_NOT_CONNECTED (-32008): Browser bridge WebSocket disconnected mid-request",
        );
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OptionalBotQuery {
    pub bot_id: Option<u64>,
}

pub async fn browser_status_get(
    auth: AuthBearer,
    Query(query): Query<OptionalBotQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let dto = state.browser.build_status_for_user(auth.user_id.0, query.bot_id);
    let mut val = serde_json::to_value(&dto).unwrap_or_else(|_| json!({}));
    if let Some(obj) = val.as_object_mut() {
        obj.insert(
            "extension_connected".to_string(),
            Value::Bool(dto.server_relay_connected),
        );
    }
    (StatusCode::OK, Json(val)).into_response()
}

pub async fn browser_tabs_get(
    auth: AuthBearer,
    State(state): State<Arc<AppState>>,
) -> Response {
    let tabs = state.browser.list_tabs_for_user(auth.user_id.0);
    let resp = BrowserTabsListResponse { ok: true, tabs };
    (StatusCode::OK, Json(resp)).into_response()
}

pub async fn browser_exec_post(
    auth: AuthBearer,
    State(state): State<Arc<AppState>>,
    bytes: Bytes,
) -> Response {
    let raw_obj = match parse_json_object(&bytes) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let req: BrowserCommandRequest = match serde_json::from_value(raw_obj) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error_code": "INVALID_PARAMS",
                    "rpc_code": -32602,
                    "code": -32602,
                    "error_message": format!("Invalid BrowserCommandRequest: {e}"),
                    "error": {
                        "code": -32602,
                        "message": format!("Invalid BrowserCommandRequest: {e}"),
                        "data": { "error_code": "INVALID_PARAMS" }
                    }
                })),
            )
                .into_response();
        }
    };

    match state.browser.execute_for_user(auth.user_id.0, req).await {
        Ok(cmd_res) => {
            let mut body = serde_json::to_value(&cmd_res).unwrap_or_else(|_| json!({}));
            if !cmd_res.ok {
                let code_num = cmd_res.rpc_code.unwrap_or(-32603);
                let code_sym = cmd_res
                    .error_code
                    .clone()
                    .unwrap_or_else(|| "INTERNAL_ERROR".to_string());
                let msg = cmd_res
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "Browser command failed".to_string());
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("code".to_string(), json!(code_num));
                    obj.insert("message".to_string(), json!(msg));
                    obj.insert(
                        "error".to_string(),
                        json!({
                            "code": code_num,
                            "message": msg,
                            "data": { "error_code": code_sym }
                        }),
                    );
                }
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err((status, sym_code, msg)) => {
            let rpc_num = BrowserRpcErrorCode::from_error_str(&sym_code)
                .map(|c| c.code())
                .unwrap_or(-32602);
            (
                status,
                Json(json!({
                    "ok": false,
                    "error_code": sym_code,
                    "rpc_code": rpc_num,
                    "code": rpc_num,
                    "error_message": msg,
                    "message": msg,
                    "error": {
                        "code": rpc_num,
                        "message": msg,
                        "data": { "error_code": sym_code }
                    }
                })),
            )
                .into_response()
        }
    }
}

pub async fn bot_browser_profile_get(
    auth: AuthBearer,
    Path(bot_id): Path<u64>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let profile = state.browser.get_bot_profile(auth.user_id.0, bot_id);
    (StatusCode::OK, Json(profile)).into_response()
}

pub async fn bot_browser_profile_put(
    auth: AuthBearer,
    Path(bot_id): Path<u64>,
    State(state): State<Arc<AppState>>,
    bytes: Bytes,
) -> Response {
    let mut raw_val = match parse_json_object(&bytes) {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if let Some(obj) = raw_val.as_object_mut() {
        if let Some(pref_raw) = obj
            .get("preferred_target")
            .and_then(Value::as_str)
            .map(ToString::to_string)
        {
            if let Some(mapped) = parse_preferred_target_flexible(&pref_raw) {
                obj.insert(
                    "preferred_target".to_string(),
                    Value::String(preferred_target_as_str(mapped).to_string()),
                );
            } else {
                return err_resp(
                    StatusCode::BAD_REQUEST,
                    "invalid_preferred_target",
                    &format!("Unsupported preferred_target '{pref_raw}'"),
                );
            }
        }
        if let Some(pol_raw) = obj
            .get("run_policy")
            .and_then(Value::as_str)
            .map(ToString::to_string)
        {
            if let Some(mapped) = parse_run_policy_flexible(&pol_raw) {
                obj.insert(
                    "run_policy".to_string(),
                    Value::String(mapped.as_str().to_string()),
                );
            } else {
                return err_resp(
                    StatusCode::BAD_REQUEST,
                    "invalid_run_policy",
                    &format!("Unsupported run_policy '{pol_raw}'"),
                );
            }
        }
    }

    let patch: UpdateBotBrowserProfileRequest = match serde_json::from_value(raw_val) {
        Ok(p) => p,
        Err(e) => {
            return err_resp(
                StatusCode::BAD_REQUEST,
                "invalid_profile",
                &format!("Invalid bot browser profile payload: {e}"),
            )
        }
    };

    let updated = state.browser.upsert_bot_profile(auth.user_id.0, bot_id, patch);
    (StatusCode::OK, Json(updated)).into_response()
}

pub async fn browser_commands_pending_get(
    auth: AuthBearer,
    State(state): State<Arc<AppState>>,
) -> Response {
    let items = state.browser.list_pending_for_user(auth.user_id.0);
    let total = items.len();
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "items": items,
            "pending": items,
            "commands": items,
            "total": total,
        })),
    )
        .into_response()
}

pub async fn browser_command_approve_post(
    auth: AuthBearer,
    Path(command_id): Path<String>,
    State(state): State<Arc<AppState>>,
    bytes: Bytes,
) -> Response {
    let raw_val = match parse_json_object(&bytes) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let decision: BrowserApprovalDecisionDto = match serde_json::from_value(raw_val) {
        Ok(d) => d,
        Err(e) => {
            return err_resp(
                StatusCode::BAD_REQUEST,
                "invalid_decision",
                &format!("Invalid approval payload: {e}"),
            )
        }
    };

    let mut entry = {
        let mut guard = state
            .browser
            .pending_approvals
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let Some(existing) = guard.get(&command_id) else {
            return err_resp(
                StatusCode::NOT_FOUND,
                "not_found",
                "Pending browser command not found or already resolved",
            );
        };
        if existing.dto.owner_user_id != auth.user_id.0 {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": "forbidden",
                    "message": "Cannot approve or deny another user's pending browser command"
                })),
            )
                .into_response();
        }
        guard
            .remove(&command_id)
            .expect("entry verified under write lock")
    };

    let remember = decision.remember_for_session.unwrap_or(false);
    if let Some(tx) = entry.tx.take() {
        let res = if decision.approved {
            PendingApprovalResolution::Approved {
                remember_for_session: remember,
            }
        } else {
            PendingApprovalResolution::Denied
        };
        let _ = tx.send(res);
    }

    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "command_id": command_id,
            "approved": decision.approved,
            "remember_for_session": remember,
        })),
    )
        .into_response()
}

pub async fn browser_pairing_post(
    auth: AuthBearer,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    bytes: Bytes,
) -> Response {
    let req: BrowserPairingRequest = if bytes.is_empty() {
        BrowserPairingRequest::default()
    } else {
        let raw_val = match parse_json_object(&bytes) {
            Ok(v) => v,
            Err(resp) => return resp,
        };
        match serde_json::from_value(raw_val) {
            Ok(r) => r,
            Err(e) => {
                return err_resp(
                    StatusCode::BAD_REQUEST,
                    "invalid_pairing_request",
                    &format!("Invalid pairing request: {e}"),
                )
            }
        }
    };

    let host_hdr = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{}:{}", state.config.host, state.config.port));
    let server_ws_url = format!("ws://{host_hdr}/api/v1/browser/ws?client=extension");

    let dto = state
        .browser
        .handle_pairing(auth.user_id.0, req, server_ws_url);
    let mut out = serde_json::to_value(&dto).unwrap_or_else(|_| json!({}));
    if let Some(obj) = out.as_object_mut() {
        obj.insert("user_id".to_string(), json!(auth.user_id.0));
        obj.insert("token".to_string(), json!(dto.pairing_token));
    }
    (StatusCode::OK, Json(out)).into_response()
}

// ============================================================================
// Internal Helpers
// ============================================================================

fn parse_run_policy_flexible(raw: &str) -> Option<BrowserRunPolicy> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "ask_every_time" | "askeverytime" | "ask" => Some(BrowserRunPolicy::AskEveryTime),
        "allow_read_only" | "allowreadonly" | "read_only" | "readonly" => {
            Some(BrowserRunPolicy::AllowReadOnly)
        }
        "always_allow_authorized" | "alwaysallowauthorized" | "always" | "authorized" | "yolo" => {
            Some(BrowserRunPolicy::AlwaysAllowAuthorized)
        }
        "disabled" | "off" | "none" => Some(BrowserRunPolicy::Disabled),
        _ => None,
    }
}

fn parse_preferred_target_flexible(raw: &str) -> Option<BrowserPreferredTarget> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto" | "" => Some(BrowserPreferredTarget::Auto),
        "extension" | "extension_bridge" | "ext" => Some(BrowserPreferredTarget::ExtensionBridge),
        "desktop" | "desktop_bridge" => Some(BrowserPreferredTarget::DesktopBridge),
        "cdp" | "local_cdp" | "managed_cdp" => Some(BrowserPreferredTarget::LocalCdp),
        _ => None,
    }
}

const fn preferred_target_as_str(target: BrowserPreferredTarget) -> &'static str {
    match target {
        BrowserPreferredTarget::Auto => "auto",
        BrowserPreferredTarget::ExtensionBridge => "extension_bridge",
        BrowserPreferredTarget::DesktopBridge => "desktop_bridge",
        BrowserPreferredTarget::LocalCdp => "local_cdp",
    }
}

fn extract_screenshot_artifact(tool_name: &str, data: &Value) -> Option<BrowserArtifactDto> {
    if tool_name != "browser_screenshot" {
        return None;
    }
    if let Some(art_val) = data.get("artifact") {
        if let Ok(dto) = serde_json::from_value::<BrowserArtifactDto>(art_val.clone()) {
            if !dto.data_base64.is_empty() {
                return Some(dto);
            }
        }
    }
    let b64 = data
        .get("data_base64")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let mime = data
        .get("mime_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png")
        .to_string();
    let width = data
        .get("width")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let height = data
        .get("height")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    Some(BrowserArtifactDto {
        mime_type: mime,
        data_base64: b64.to_string(),
        name: Some("browser_screenshot.png".to_string()),
        width,
        height,
    })
}

fn mint_csprng_hex_token() -> String {
    let u1 = Uuid::new_v4();
    let u2 = Uuid::new_v4();
    format!("{}{}", u1.simple(), u2.simple())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn test_ws_origin_validation() {
        let mut empty = HeaderMap::new();
        assert!(is_allowed_browser_ws_origin(&empty));

        empty.insert(
            header::ORIGIN,
            HeaderValue::from_static("chrome-extension://nkikencljfojglplncicaknnpcclfgph"),
        );
        assert!(is_allowed_browser_ws_origin(&empty));

        for bad in [
            "http://127.0.0.1:8080",
            "https://evil.example.com",
            "null",
            "chrome-extension://",
        ] {
            let mut h = HeaderMap::new();
            h.insert(header::ORIGIN, HeaderValue::from_str(bad).unwrap());
            assert!(
                !is_allowed_browser_ws_origin(&h),
                "Origin '{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn test_pairing_mint_rotate_and_verify() {
        let db = Arc::new(ServerDatabase::open_in_memory().unwrap());
        let svc = BrowserControlService::new(db);

        let issued = svc.handle_pairing(
            1001,
            BrowserPairingRequest {
                action: BrowserPairingAction::Issue,
                ..Default::default()
            },
            "ws://127.0.0.1:8080/api/v1/browser/ws?client=extension".into(),
        );
        assert!(issued.ok);
        assert_eq!(issued.pairing_token.len(), 64);

        let same = svc.handle_pairing(
            1001,
            BrowserPairingRequest {
                action: BrowserPairingAction::Issue,
                ..Default::default()
            },
            "ws://127.0.0.1:8080/api/v1/browser/ws?client=extension".into(),
        );
        assert_eq!(same.pairing_token, issued.pairing_token);

        let rotated = svc.handle_pairing(
            1001,
            BrowserPairingRequest {
                action: BrowserPairingAction::Rotate,
                ..Default::default()
            },
            "ws://127.0.0.1:8080/api/v1/browser/ws?client=extension".into(),
        );
        assert_eq!(rotated.pairing_token.len(), 64);
        assert_ne!(rotated.pairing_token, issued.pairing_token);

        let verified = svc.handle_pairing(
            1001,
            BrowserPairingRequest {
                action: BrowserPairingAction::Verify,
                pairing_token: Some(rotated.pairing_token.clone()),
                ..Default::default()
            },
            "ws://127.0.0.1:8080/api/v1/browser/ws?client=extension".into(),
        );
        assert!(verified.verified);
    }

    #[tokio::test]
    async fn test_cross_user_isolation_and_disabled_policy() {
        let db = Arc::new(ServerDatabase::open_in_memory().unwrap());
        let svc = BrowserControlService::new(db);

        svc.upsert_bot_profile(
            42,
            OFFICIAL_BOT_ID,
            UpdateBotBrowserProfileRequest {
                enabled: Some(false),
                run_policy: Some(BrowserRunPolicy::Disabled),
                allowed_domains: None,
                blocked_domains: None,
                preferred_target: None,
            },
        );

        let res_u42 = svc
            .execute_for_user(
                42,
                BrowserCommandRequest {
                    tool: "browser_snapshot".into(),
                    bot_id: Some(OFFICIAL_BOT_ID),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!res_u42.ok);
        assert_eq!(res_u42.rpc_code, Some(-32003));

        // User 99 profile remains unaffected (fails with disconnected -32008, not -32003)
        let res_u99 = svc
            .execute_for_user(
                99,
                BrowserCommandRequest {
                    tool: "browser_snapshot".into(),
                    bot_id: Some(OFFICIAL_BOT_ID),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!res_u99.ok);
        assert_eq!(res_u99.rpc_code, Some(-32008));
    }
}
