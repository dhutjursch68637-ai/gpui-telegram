//! Canonical Browser Control Toolset, Server Relay DTOs, and JSON-RPC 2.0 WebSocket Bridge Contracts.
//!
//! Shared between:
//! - `gpui_telegram_ext_wasm` (`wasm32-unknown-unknown` MV3 Extension WASM core)
//! - `gpui_telegram_agent` (`ToolsetId::Browser` & `BrowserBridgeProvider`)
//! - `gpui_telegram_server` (`BrowserControlService` `/api/v1/browser/*` & `/api/v1/browser/ws`)
//! - `gpui_telegram_client` & `gpui_telegram_desktop` (`127.0.0.1:19222` Desktop Bridge & UI)

use crate::computer_contracts::ComputerRunPolicy;
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

/// JSON-RPC 2.0 wire version constant.
pub const JSONRPC_VERSION: &str = "2.0";

/// Default localhost Desktop↔Extension WebSocket Bridge port (`127.0.0.1:19222`).
pub const DEFAULT_DESKTOP_BRIDGE_PORT: u16 = 19222;

/// Default WebSocket ping interval in seconds (`< 30s` Chrome 116+ MV3 Service Worker idle window).
pub const DEFAULT_BRIDGE_PING_INTERVAL_SECS: u64 = 20;

/// Default tool invocation timeout in milliseconds.
pub const DEFAULT_BROWSER_INVOKE_TIMEOUT_MS: u64 = 20_000;

/// Maximum tool invocation timeout in milliseconds.
pub const MAX_BROWSER_INVOKE_TIMEOUT_MS: u64 = 60_000;

/// Maximum WebSocket / HTTP body payload for browser bridge frames (`32 MiB`).
pub const MAX_BROWSER_WS_FRAME_BYTES: usize = 32 * 1024 * 1024;

/// Argument keys inspected by `SecurityEngine::pre_execute_check` for filesystem containment.
/// Browser tool schemas NEVER use these keys so browser URLs/selectors never collide with TIR path checks.
pub const FORBIDDEN_BROWSER_ARG_KEYS: [&str; 12] = [
    "path",
    "file_path",
    "target_path",
    "target",
    "destination",
    "cwd",
    "workdir",
    "working_dir",
    "output_path",
    "audio_path",
    "image_path",
    "source",
];

fn default_true() -> bool {
    true
}

fn default_protocol_version() -> u32 {
    1
}

fn default_ping_interval_secs() -> u64 {
    DEFAULT_BRIDGE_PING_INTERVAL_SECS
}

fn default_invoke_timeout_ms() -> u64 {
    DEFAULT_BROWSER_INVOKE_TIMEOUT_MS
}

fn default_jsonrpc_version() -> String {
    JSONRPC_VERSION.to_string()
}

fn default_empty_object() -> Value {
    Value::Object(Map::new())
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn deserialize_some_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

// ============================================================================
// 1. Risk Classification, Run Policy & Canonical Tool Registry (Rows 1–24)
// ============================================================================

/// Security risk tier for browser control tools (`PROJECT.md § 2`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPolicyRisk {
    #[default]
    ReadOnly,
    Mutating,
    HighRisk,
}

impl BrowserPolicyRisk {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Mutating => "mutating",
            Self::HighRisk => "high_risk",
        }
    }
}

/// User/Bot execution policy for browser control (`PROJECT.md §§ 1–3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum BrowserRunPolicy {
    #[default]
    #[serde(
        rename = "ask_every_time",
        alias = "AskEveryTime",
        alias = "askEveryTime"
    )]
    AskEveryTime,
    #[serde(
        rename = "allow_read_only",
        alias = "AllowReadOnly",
        alias = "allowReadOnly"
    )]
    AllowReadOnly,
    #[serde(
        rename = "always_allow_authorized",
        alias = "AlwaysAllowAuthorized",
        alias = "alwaysAllowAuthorized"
    )]
    AlwaysAllowAuthorized,
    #[serde(rename = "disabled", alias = "Disabled")]
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserPolicyDecision {
    Allow,
    RequireApproval { reason: &'static str },
    Deny {
        code: BrowserRpcErrorCode,
        reason: &'static str,
    },
}

impl BrowserRunPolicy {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::AskEveryTime => "ask_every_time",
            Self::AllowReadOnly => "allow_read_only",
            Self::AlwaysAllowAuthorized => "always_allow_authorized",
            Self::Disabled => "disabled",
        }
    }

    pub const fn evaluate(
        &self,
        risk: BrowserPolicyRisk,
        injection_flagged: bool,
    ) -> BrowserPolicyDecision {
        match self {
            Self::Disabled => BrowserPolicyDecision::Deny {
                code: BrowserRpcErrorCode::PolicyDisabled,
                reason: "Browser control is disabled by policy",
            },
            Self::AskEveryTime => BrowserPolicyDecision::RequireApproval {
                reason: "BrowserRunPolicy::AskEveryTime requires user confirmation",
            },
            Self::AllowReadOnly => match risk {
                BrowserPolicyRisk::ReadOnly => BrowserPolicyDecision::Allow,
                BrowserPolicyRisk::Mutating => BrowserPolicyDecision::RequireApproval {
                    reason: "Mutating browser tool requires approval under allow_read_only policy",
                },
                BrowserPolicyRisk::HighRisk => BrowserPolicyDecision::RequireApproval {
                    reason: "High-risk browser tool requires explicit user approval",
                },
            },
            Self::AlwaysAllowAuthorized => {
                if matches!(risk, BrowserPolicyRisk::HighRisk) {
                    BrowserPolicyDecision::RequireApproval {
                        reason: "High-risk browser tool (JS evaluate / raw CDP) requires approval",
                    }
                } else if injection_flagged && !matches!(risk, BrowserPolicyRisk::ReadOnly) {
                    BrowserPolicyDecision::RequireApproval {
                        reason: "Prompt-injection signature flagged on page; mutating action requires approval",
                    }
                } else {
                    BrowserPolicyDecision::Allow
                }
            }
        }
    }
}

impl From<ComputerRunPolicy> for BrowserRunPolicy {
    fn from(value: ComputerRunPolicy) -> Self {
        match value {
            ComputerRunPolicy::AskEveryTime => Self::AskEveryTime,
            ComputerRunPolicy::AllowReadOnly => Self::AllowReadOnly,
            ComputerRunPolicy::AlwaysAllowAuthorized => Self::AlwaysAllowAuthorized,
            ComputerRunPolicy::Disabled => Self::Disabled,
        }
    }
}

impl From<BrowserRunPolicy> for ComputerRunPolicy {
    fn from(value: BrowserRunPolicy) -> Self {
        match value {
            BrowserRunPolicy::AskEveryTime => Self::AskEveryTime,
            BrowserRunPolicy::AllowReadOnly => Self::AllowReadOnly,
            BrowserRunPolicy::AlwaysAllowAuthorized => Self::AlwaysAllowAuthorized,
            BrowserRunPolicy::Disabled => Self::Disabled,
        }
    }
}

/// Canonical Browser Control Tool identifier covering all 24 rows (26 canonical tools +
/// `browser_tabs` / `browser_switch_tab` aliases + optional raw CDP `browser_cdp_send`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BrowserToolName {
    BrowserStatus,
    BrowserListTabs,
    BrowserGetActiveTab,
    BrowserOpenTab,
    BrowserActivateTab,
    BrowserCloseTab,
    BrowserGroupTabs,
    BrowserNavigate,
    BrowserReload,
    BrowserBackForward,
    BrowserSnapshot,
    BrowserExtractMarkdown,
    BrowserQuerySelector,
    BrowserClick,
    BrowserHover,
    BrowserType,
    BrowserPressKey,
    BrowserSelectOption,
    BrowserScroll,
    BrowserWaitFor,
    BrowserScreenshot,
    BrowserEvaluate,
    BrowserGetConsoleLogs,
    BrowserGetNetworkLog,
    BrowserManageCookies,
    BrowserDownloadUrl,
    BrowserCdpSend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserToolDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_row: Option<u8>,
    pub risk: BrowserPolicyRisk,
    pub description: String,
    pub parameters_schema: Value,
}

impl BrowserToolName {
    pub const CANONICAL_TOOLS: [Self; 26] = [
        Self::BrowserStatus,
        Self::BrowserListTabs,
        Self::BrowserGetActiveTab,
        Self::BrowserOpenTab,
        Self::BrowserActivateTab,
        Self::BrowserCloseTab,
        Self::BrowserGroupTabs,
        Self::BrowserNavigate,
        Self::BrowserReload,
        Self::BrowserBackForward,
        Self::BrowserSnapshot,
        Self::BrowserExtractMarkdown,
        Self::BrowserQuerySelector,
        Self::BrowserClick,
        Self::BrowserHover,
        Self::BrowserType,
        Self::BrowserPressKey,
        Self::BrowserSelectOption,
        Self::BrowserScroll,
        Self::BrowserWaitFor,
        Self::BrowserScreenshot,
        Self::BrowserEvaluate,
        Self::BrowserGetConsoleLogs,
        Self::BrowserGetNetworkLog,
        Self::BrowserManageCookies,
        Self::BrowserDownloadUrl,
    ];

    pub const ALL_TOOLS: [Self; 27] = [
        Self::BrowserStatus,
        Self::BrowserListTabs,
        Self::BrowserGetActiveTab,
        Self::BrowserOpenTab,
        Self::BrowserActivateTab,
        Self::BrowserCloseTab,
        Self::BrowserGroupTabs,
        Self::BrowserNavigate,
        Self::BrowserReload,
        Self::BrowserBackForward,
        Self::BrowserSnapshot,
        Self::BrowserExtractMarkdown,
        Self::BrowserQuerySelector,
        Self::BrowserClick,
        Self::BrowserHover,
        Self::BrowserType,
        Self::BrowserPressKey,
        Self::BrowserSelectOption,
        Self::BrowserScroll,
        Self::BrowserWaitFor,
        Self::BrowserScreenshot,
        Self::BrowserEvaluate,
        Self::BrowserGetConsoleLogs,
        Self::BrowserGetNetworkLog,
        Self::BrowserManageCookies,
        Self::BrowserDownloadUrl,
        Self::BrowserCdpSend,
    ];

    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::BrowserStatus => "browser_status",
            Self::BrowserListTabs => "browser_list_tabs",
            Self::BrowserGetActiveTab => "browser_get_active_tab",
            Self::BrowserOpenTab => "browser_open_tab",
            Self::BrowserActivateTab => "browser_activate_tab",
            Self::BrowserCloseTab => "browser_close_tab",
            Self::BrowserGroupTabs => "browser_group_tabs",
            Self::BrowserNavigate => "browser_navigate",
            Self::BrowserReload => "browser_reload",
            Self::BrowserBackForward => "browser_back_forward",
            Self::BrowserSnapshot => "browser_snapshot",
            Self::BrowserExtractMarkdown => "browser_extract_markdown",
            Self::BrowserQuerySelector => "browser_query_selector",
            Self::BrowserClick => "browser_click",
            Self::BrowserHover => "browser_hover",
            Self::BrowserType => "browser_type",
            Self::BrowserPressKey => "browser_press_key",
            Self::BrowserSelectOption => "browser_select_option",
            Self::BrowserScroll => "browser_scroll",
            Self::BrowserWaitFor => "browser_wait_for",
            Self::BrowserScreenshot => "browser_screenshot",
            Self::BrowserEvaluate => "browser_evaluate",
            Self::BrowserGetConsoleLogs => "browser_get_console_logs",
            Self::BrowserGetNetworkLog => "browser_get_network_log",
            Self::BrowserManageCookies => "browser_manage_cookies",
            Self::BrowserDownloadUrl => "browser_download_url",
            Self::BrowserCdpSend => "browser_cdp_send",
        }
    }

    pub const fn aliases(&self) -> &'static [&'static str] {
        match self {
            Self::BrowserListTabs => &["browser_tabs"],
            Self::BrowserActivateTab => &["browser_switch_tab"],
            Self::BrowserCdpSend => &["browser.cdp_send"],
            _ => &[],
        }
    }

    pub const fn table_row(&self) -> Option<u8> {
        match self {
            Self::BrowserStatus => Some(1),
            Self::BrowserListTabs => Some(2),
            Self::BrowserGetActiveTab => Some(3),
            Self::BrowserOpenTab => Some(4),
            Self::BrowserActivateTab => Some(5),
            Self::BrowserCloseTab => Some(6),
            Self::BrowserGroupTabs => Some(7),
            Self::BrowserNavigate => Some(8),
            Self::BrowserReload => Some(9),
            Self::BrowserBackForward => Some(10),
            Self::BrowserSnapshot => Some(11),
            Self::BrowserExtractMarkdown => Some(12),
            Self::BrowserQuerySelector => Some(13),
            Self::BrowserClick => Some(14),
            Self::BrowserHover => Some(15),
            Self::BrowserType => Some(16),
            Self::BrowserPressKey => Some(17),
            Self::BrowserSelectOption => Some(18),
            Self::BrowserScroll => Some(19),
            Self::BrowserWaitFor => Some(20),
            Self::BrowserScreenshot => Some(21),
            Self::BrowserEvaluate => Some(22),
            Self::BrowserGetConsoleLogs | Self::BrowserGetNetworkLog => Some(23),
            Self::BrowserManageCookies | Self::BrowserDownloadUrl => Some(24),
            Self::BrowserCdpSend => None,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "browser_status" => Some(Self::BrowserStatus),
            "browser_list_tabs" | "browser_tabs" => Some(Self::BrowserListTabs),
            "browser_get_active_tab" => Some(Self::BrowserGetActiveTab),
            "browser_open_tab" => Some(Self::BrowserOpenTab),
            "browser_activate_tab" | "browser_switch_tab" => Some(Self::BrowserActivateTab),
            "browser_close_tab" => Some(Self::BrowserCloseTab),
            "browser_group_tabs" => Some(Self::BrowserGroupTabs),
            "browser_navigate" => Some(Self::BrowserNavigate),
            "browser_reload" => Some(Self::BrowserReload),
            "browser_back_forward" => Some(Self::BrowserBackForward),
            "browser_snapshot" => Some(Self::BrowserSnapshot),
            "browser_extract_markdown" => Some(Self::BrowserExtractMarkdown),
            "browser_query_selector" => Some(Self::BrowserQuerySelector),
            "browser_click" => Some(Self::BrowserClick),
            "browser_hover" => Some(Self::BrowserHover),
            "browser_type" => Some(Self::BrowserType),
            "browser_press_key" => Some(Self::BrowserPressKey),
            "browser_select_option" => Some(Self::BrowserSelectOption),
            "browser_scroll" => Some(Self::BrowserScroll),
            "browser_wait_for" => Some(Self::BrowserWaitFor),
            "browser_screenshot" => Some(Self::BrowserScreenshot),
            "browser_evaluate" => Some(Self::BrowserEvaluate),
            "browser_get_console_logs" => Some(Self::BrowserGetConsoleLogs),
            "browser_get_network_log" => Some(Self::BrowserGetNetworkLog),
            "browser_manage_cookies" => Some(Self::BrowserManageCookies),
            "browser_download_url" => Some(Self::BrowserDownloadUrl),
            "browser_cdp_send" | "browser.cdp_send" => Some(Self::BrowserCdpSend),
            _ => None,
        }
    }

    pub fn normalize_name(raw: &str) -> Option<&'static str> {
        Self::parse(raw).map(|t| t.as_str())
    }

    pub const fn risk(&self) -> BrowserPolicyRisk {
        match self {
            Self::BrowserStatus
            | Self::BrowserListTabs
            | Self::BrowserGetActiveTab
            | Self::BrowserSnapshot
            | Self::BrowserExtractMarkdown
            | Self::BrowserQuerySelector
            | Self::BrowserScreenshot
            | Self::BrowserGetConsoleLogs
            | Self::BrowserGetNetworkLog => BrowserPolicyRisk::ReadOnly,

            Self::BrowserOpenTab
            | Self::BrowserActivateTab
            | Self::BrowserCloseTab
            | Self::BrowserGroupTabs
            | Self::BrowserNavigate
            | Self::BrowserReload
            | Self::BrowserBackForward
            | Self::BrowserClick
            | Self::BrowserHover
            | Self::BrowserType
            | Self::BrowserPressKey
            | Self::BrowserSelectOption
            | Self::BrowserScroll
            | Self::BrowserWaitFor
            | Self::BrowserManageCookies
            | Self::BrowserDownloadUrl => BrowserPolicyRisk::Mutating,

            Self::BrowserEvaluate | Self::BrowserCdpSend => BrowserPolicyRisk::HighRisk,
        }
    }

    pub const fn description(&self) -> &'static str {
        match self {
            Self::BrowserStatus => {
                "Inspect browser control connection status, active tab count, bridge mode, and BrowserRunPolicy."
            }
            Self::BrowserListTabs => {
                "List open browser tabs across windows with tab_id, title, URL, active/group state, and controllability."
            }
            Self::BrowserGetActiveTab => "Get metadata for the currently active browser tab.",
            Self::BrowserOpenTab => {
                "Open a URL in a new browser tab, optionally grouping it in the bot tab group."
            }
            Self::BrowserActivateTab => "Focus and switch to a specific browser tab by tab_id.",
            Self::BrowserCloseTab => "Close a browser tab by tab_id.",
            Self::BrowserGroupTabs => {
                "Group one or more browser tabs under an optional title and color."
            }
            Self::BrowserNavigate => {
                "Navigate a target or active browser tab to an http(s) URL and wait for readiness."
            }
            Self::BrowserReload => {
                "Reload a target or active browser tab, optionally bypassing browser cache."
            }
            Self::BrowserBackForward => "Navigate browser tab history backward or forward.",
            Self::BrowserSnapshot => {
                "Capture an interactive DOM/ARIA snapshot with [ref=eN] element indices, bounding rects, markdown excerpt, links, and prompt-injection scan."
            }
            Self::BrowserExtractMarkdown => {
                "Extract cleaned Markdown content from a browser tab with pagination and prompt-injection scan."
            }
            Self::BrowserQuerySelector => {
                "Query elements matching a CSS selector and return assigned [ref=eN] IDs, text, attributes, visibility, and rects."
            }
            Self::BrowserClick => {
                "Click an element by [ref=eN], CSS selector, visible text, or viewport coordinates (x, y)."
            }
            Self::BrowserHover => {
                "Hover pointer over an element by [ref=eN], CSS selector, or viewport coordinates (x, y)."
            }
            Self::BrowserType => {
                "Type text into an input, textarea, or contenteditable element by [ref=eN] or CSS selector, with React-safe setter and optional submit."
            }
            Self::BrowserPressKey => {
                "Dispatch a keyboard key press (e.g. Enter, Escape, Tab, ArrowDown) with optional modifiers."
            }
            Self::BrowserSelectOption => {
                "Select an option in a <select> element by value or visible label."
            }
            Self::BrowserScroll => {
                "Scroll the page or a specific element up, down, top, bottom, or into view."
            }
            Self::BrowserWaitFor => {
                "Wait until a CSS selector, text substring, or URL substring satisfies a target state within timeout_ms."
            }
            Self::BrowserScreenshot => {
                "Capture a PNG or JPEG screenshot of the visible viewport, full page, or element selector."
            }
            Self::BrowserEvaluate => {
                "Evaluate a JavaScript expression in the target tab page context (HighRisk policy gated)."
            }
            Self::BrowserGetConsoleLogs => {
                "Read buffered browser console log entries for the target tab."
            }
            Self::BrowserGetNetworkLog => {
                "Read buffered browser network request/response log entries for the target tab."
            }
            Self::BrowserManageCookies => {
                "List, set, or delete cookies for a URL (HttpOnly values are automatically redacted on read)."
            }
            Self::BrowserDownloadUrl => {
                "Download an http(s) URL via the browser download manager using a sanitized basename."
            }
            Self::BrowserCdpSend => {
                "Send a raw Chrome DevTools Protocol (CDP 1.3) command to a tab debugger session (HighRisk policy gated)."
            }
        }
    }

    pub fn parameters_schema(&self) -> Value {
        match self {
            Self::BrowserStatus => json!({ "type": "object", "properties": {} }),
            Self::BrowserListTabs => json!({
                "type": "object",
                "properties": {
                    "window_id": { "type": "integer", "minimum": 0 },
                    "current_window_only": { "type": "boolean" }
                }
            }),
            Self::BrowserGetActiveTab => json!({
                "type": "object",
                "properties": { "window_id": { "type": "integer", "minimum": 0 } }
            }),
            Self::BrowserOpenTab => json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "active": { "type": "boolean" },
                    "group_with_bot": { "type": "boolean" }
                },
                "required": ["url"]
            }),
            Self::BrowserActivateTab | Self::BrowserCloseTab => json!({
                "type": "object",
                "properties": { "tab_id": { "type": "integer", "minimum": 0 } },
                "required": ["tab_id"]
            }),
            Self::BrowserGroupTabs => json!({
                "type": "object",
                "properties": {
                    "tab_ids": { "type": "array", "items": { "type": "integer", "minimum": 0 }, "minItems": 1 },
                    "title": { "type": "string" },
                    "color": { "type": "string" }
                },
                "required": ["tab_ids"]
            }),
            Self::BrowserNavigate => json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "wait_until": { "type": "string", "enum": ["complete", "interactive"] },
                    "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 60000 },
                    "cdp_url": { "type": "string" }
                },
                "required": ["url"]
            }),
            Self::BrowserReload => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "bypass_cache": { "type": "boolean" }
                }
            }),
            Self::BrowserBackForward => json!({
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["back", "forward"] },
                    "tab_id": { "type": "integer", "minimum": 0 }
                },
                "required": ["direction"]
            }),
            Self::BrowserSnapshot => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "max_chars": { "type": "integer", "minimum": 1 },
                    "include_hidden": { "type": "boolean" },
                    "selector_scope": { "type": "string" },
                    "cdp_url": { "type": "string" }
                }
            }),
            Self::BrowserExtractMarkdown => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "max_chars": { "type": "integer", "minimum": 1 },
                    "offset": { "type": "integer", "minimum": 0 }
                }
            }),
            Self::BrowserQuerySelector => json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string" },
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["selector"]
            }),
            Self::BrowserClick => json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "text": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "button": { "type": "string", "enum": ["left", "right"] },
                    "double_click": { "type": "boolean" },
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "cdp_url": { "type": "string" }
                }
            }),
            Self::BrowserHover => json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "tab_id": { "type": "integer", "minimum": 0 }
                }
            }),
            Self::BrowserType => json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "text": { "type": "string" },
                    "value": { "type": "string" },
                    "clear_first": { "type": "boolean" },
                    "submit": { "type": "boolean" },
                    "press_enter": { "type": "boolean" },
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "cdp_url": { "type": "string" }
                }
            }),
            Self::BrowserPressKey => json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string" },
                    "modifiers": { "type": "array", "items": { "type": "string" } },
                    "tab_id": { "type": "integer", "minimum": 0 }
                },
                "required": ["key"]
            }),
            Self::BrowserSelectOption => json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "value": { "type": "string" },
                    "label": { "type": "string" },
                    "tab_id": { "type": "integer", "minimum": 0 }
                }
            }),
            Self::BrowserScroll => json!({
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down", "top", "bottom"] },
                    "amount_px": { "type": "integer" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "tab_id": { "type": "integer", "minimum": 0 }
                }
            }),
            Self::BrowserWaitFor => json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string" },
                    "text": { "type": "string" },
                    "url_includes": { "type": "string" },
                    "state": { "type": "string", "enum": ["visible", "attached", "hidden"] },
                    "timeout_ms": { "type": "integer", "minimum": 50, "maximum": 60000 },
                    "tab_id": { "type": "integer", "minimum": 0 }
                }
            }),
            Self::BrowserScreenshot => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "full_page": { "type": "boolean" },
                    "selector": { "type": "string" },
                    "format": { "type": "string", "enum": ["png", "jpeg"] },
                    "cdp_url": { "type": "string" }
                }
            }),
            Self::BrowserEvaluate => json!({
                "type": "object",
                "properties": {
                    "expression": { "type": "string" },
                    "tab_id": { "type": "integer", "minimum": 0 }
                },
                "required": ["expression"]
            }),
            Self::BrowserGetConsoleLogs | Self::BrowserGetNetworkLog => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1 },
                    "level": { "type": "string" }
                }
            }),
            Self::BrowserManageCookies => json!({
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "set", "delete"] },
                    "url": { "type": "string" },
                    "name": { "type": "string" },
                    "value": { "type": "string" }
                },
                "required": ["op", "url"]
            }),
            Self::BrowserDownloadUrl => json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "filename": { "type": "string" }
                },
                "required": ["url"]
            }),
            Self::BrowserCdpSend => json!({
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "minimum": 0 },
                    "method": { "type": "string" },
                    "params": { "type": "object" }
                },
                "required": ["method"]
            }),
        }
    }

    pub fn descriptor(&self) -> BrowserToolDescriptor {
        BrowserToolDescriptor {
            name: self.as_str().to_string(),
            aliases: self.aliases().iter().map(|s| (*s).to_string()).collect(),
            table_row: self.table_row(),
            risk: self.risk(),
            description: self.description().to_string(),
            parameters_schema: self.parameters_schema(),
        }
    }
}

pub fn canonical_browser_tool_descriptors() -> Vec<BrowserToolDescriptor> {
    BrowserToolName::CANONICAL_TOOLS
        .iter()
        .map(BrowserToolName::descriptor)
        .collect()
}

impl fmt::Display for BrowserToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BrowserToolName {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s).ok_or_else(|| format!("unknown browser tool name: '{s}'"))
    }
}

impl Serialize for BrowserToolName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BrowserToolName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| DeError::custom(format!("unknown browser tool: '{raw}'")))
    }
}

pub fn validate_browser_tool_arguments(args: &Value) -> Result<(), String> {
    match args {
        Value::Null => Ok(()),
        Value::Object(map) => {
            for key in map.keys() {
                if FORBIDDEN_BROWSER_ARG_KEYS.contains(&key.as_str()) {
                    return Err(format!(
                        "forbidden browser tool argument key '{key}' (conflicts with SecurityEngine TIR path check)"
                    ));
                }
            }
            Ok(())
        }
        _ => Err("browser tool arguments must be a JSON object".to_string()),
    }
}

pub fn sanitize_download_filename(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let basename = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.');
    let cleaned: String = basename
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned.to_string())
    }
}

pub fn is_restricted_browser_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.starts_with("chrome:")
        || lower.starts_with("chrome-extension:")
        || lower.starts_with("chrome-untrusted:")
        || lower.starts_with("chrome-search:")
        || lower.starts_with("devtools:")
        || lower.starts_with("edge:")
        || lower.starts_with("brave:")
        || lower.starts_with("vivaldi:")
        || lower.starts_with("opera:")
        || lower.starts_with("file:")
        || lower.starts_with("view-source:")
        || lower.starts_with("javascript:")
        || lower.starts_with("https://chromewebstore.google.com")
        || lower.starts_with("https://chrome.google.com/webstore")
}

// ============================================================================
// 2. Core Browser DTOs & Server REST Contracts (`PROJECT.md §§ 2, 4`)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserRectDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserViewportDto {
    pub width: u32,
    pub height: u32,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub scroll_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserElementRefDto {
    #[serde(rename = "ref")]
    pub element_ref: String,
    pub tag: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    pub role: String,
    pub label: String,
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub rect: BrowserRectDto,
    #[serde(skip_serializing_if = "is_false")]
    pub disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

impl BrowserElementRefDto {
    pub fn ref_id(&self) -> &str {
        &self.element_ref
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserLinkDto {
    #[serde(alias = "label")]
    pub text: String,
    pub href: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "snake_case")]
pub enum BrowserInjectionSeverity {
    #[default]
    None,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserInjectionFindingDto {
    pub rule_id: String,
    pub severity: BrowserInjectionSeverity,
    pub description: String,
    pub matched_excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserInjectionScanDto {
    pub flagged: bool,
    pub severity: BrowserInjectionSeverity,
    pub findings: Vec<BrowserInjectionFindingDto>,
    #[serde(default)]
    pub secrets_detected: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserTabDto {
    pub tab_id: u64,
    pub window_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<i64>,
    pub active: bool,
    pub pinned: bool,
    pub audible: bool,
    pub status: String,
    pub title: String,
    pub url: String,
    #[serde(default = "default_true")]
    pub controllable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fav_icon_url: Option<String>,
}

impl Default for BrowserTabDto {
    fn default() -> Self {
        Self {
            tab_id: 0,
            window_id: 0,
            group_id: None,
            active: false,
            pinned: false,
            audible: false,
            status: "complete".to_string(),
            title: String::new(),
            url: String::new(),
            controllable: true,
            fav_icon_url: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserBridgeHostKind {
    #[default]
    Server,
    Desktop,
}

impl BrowserBridgeHostKind {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Desktop => "desktop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserSessionDto {
    pub session_id: String,
    pub owner_user_id: u64,
    pub extension_id: String,
    pub device_id: String,
    pub user_agent: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
    pub run_policy: BrowserRunPolicy,
    pub host_kind: BrowserBridgeHostKind,
    pub online: bool,
    pub active_tabs: usize,
    pub tabs: Vec<BrowserTabDto>,
    pub connected_at_ms: i64,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPreferredTarget {
    #[default]
    Auto,
    ExtensionBridge,
    DesktopBridge,
    LocalCdp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BotBrowserProfileDto {
    pub bot_id: u64,
    pub enabled: bool,
    pub run_policy: BrowserRunPolicy,
    pub allowed_domains: Vec<String>,
    pub blocked_domains: Vec<String>,
    pub preferred_target: BrowserPreferredTarget,
    pub updated_at_ms: i64,
}

impl Default for BotBrowserProfileDto {
    fn default() -> Self {
        Self {
            bot_id: 0,
            enabled: true,
            run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
            allowed_domains: Vec::new(),
            blocked_domains: Vec::new(),
            preferred_target: BrowserPreferredTarget::Auto,
            updated_at_ms: 0,
        }
    }
}

impl BotBrowserProfileDto {
    pub fn is_url_allowed(&self, url: &str) -> bool {
        if !self.enabled {
            return false;
        }
        let Some(host) = extract_url_host(url) else {
            return self.allowed_domains.is_empty();
        };
        if self
            .blocked_domains
            .iter()
            .any(|d| domain_matches(&host, d))
        {
            return false;
        }
        if self.allowed_domains.is_empty() {
            return true;
        }
        self.allowed_domains
            .iter()
            .any(|d| domain_matches(&host, d))
    }
}

fn extract_url_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, hp)| hp)
        .unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        host_port.split(']').next()?.trim_start_matches('[')
    } else {
        host_port.split(':').next()?
    };
    let lower = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if lower.is_empty() {
        None
    } else {
        Some(lower)
    }
}

fn domain_matches(host: &str, pattern: &str) -> bool {
    let pat = pattern
        .trim()
        .trim_start_matches("*.")
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if pat.is_empty() {
        return false;
    }
    host == pat || host.ends_with(&format!(".{pat}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UpdateBotBrowserProfileRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_policy: Option<BrowserRunPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_target: Option<BrowserPreferredTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserBridgeStatusDto {
    pub ok: bool,
    pub connected: bool,
    pub mode: String,
    pub active_tabs: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub run_policy: BrowserRunPolicy,
    pub desktop_bridge_connected: bool,
    pub server_relay_connected: bool,
    #[serde(default)]
    pub local_cdp_available: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<BrowserSessionDto>,
    #[serde(default)]
    pub pending_approvals_count: usize,
}

impl Default for BrowserBridgeStatusDto {
    fn default() -> Self {
        Self {
            ok: true,
            connected: false,
            mode: "disconnected".to_string(),
            active_tabs: 0,
            extension_id: None,
            device_id: None,
            run_policy: BrowserRunPolicy::AskEveryTime,
            desktop_bridge_connected: false,
            server_relay_connected: false,
            local_cdp_available: false,
            sessions: Vec::new(),
            pending_approvals_count: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserTabsListResponse {
    pub ok: bool,
    pub tabs: Vec<BrowserTabDto>,
}

impl Default for BrowserTabsListResponse {
    fn default() -> Self {
        Self {
            ok: true,
            tabs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCallerKind {
    #[default]
    Bot,
    User,
    Desktop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCallerInfo {
    pub kind: BrowserCallerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserArtifactDto {
    pub mime_type: String,
    pub data_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserCommandRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub tool: String,
    #[serde(default = "default_empty_object")]
    pub arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for BrowserCommandRequest {
    fn default() -> Self {
        Self {
            command_id: None,
            tool: String::new(),
            arguments: default_empty_object(),
            bot_id: None,
            bot_name: None,
            chat_id: None,
            timeout_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCommandResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<BrowserArtifactDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub executed_via: String,
    #[serde(default)]
    pub duration_ms: u64,
}

impl BrowserCommandResult {
    pub fn success(data: Value) -> Self {
        let tab_id = data.get("tab_id").and_then(|v| v.as_u64());
        let url = data.get("url").and_then(|v| v.as_str()).map(String::from);
        let title = data.get("title").and_then(|v| v.as_str()).map(String::from);
        Self {
            ok: true,
            tab_id,
            url,
            title,
            data,
            ..Self::default()
        }
    }

    pub fn failure(code: BrowserRpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error_code: Some(code.as_str().to_string()),
            rpc_code: Some(code.code()),
            error_message: Some(message.into()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PendingBrowserCommandDto {
    pub command_id: String,
    pub owner_user_id: u64,
    pub tool: String,
    pub risk: BrowserPolicyRisk,
    #[serde(default = "default_empty_object")]
    pub arguments: Value,
    pub caller: BrowserCallerInfo,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_url: Option<String>,
    pub injection_flagged: bool,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserApprovalDecisionDto {
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember_for_session: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPairingAction {
    #[default]
    Issue,
    Rotate,
    Verify,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserPairingRequest {
    pub action: BrowserPairingAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserPairingDto {
    pub ok: bool,
    pub pairing_token: String,
    pub desktop_ws_url: String,
    pub server_ws_url: String,
    pub verified: bool,
    pub created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

// ============================================================================
// 3. Strongly-Typed Tool Argument & Result Envelopes (Rows 1–24)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserStatusArgs {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserListTabsArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_window_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserGetActiveTabArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserTabResult {
    pub ok: bool,
    pub tab: BrowserTabDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserOpenTabArgs {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_with_bot: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserActivateTabArgs {
    pub tab_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCloseTabArgs {
    pub tab_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCloseTabResult {
    pub ok: bool,
    pub closed_tab_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserGroupTabsArgs {
    pub tab_ids: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserGroupTabsResult {
    pub ok: bool,
    pub group_id: i64,
    pub tab_ids: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWaitUntil {
    #[default]
    Complete,
    Interactive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserNavigateArgs {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<BrowserWaitUntil>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserNavigateResult {
    pub ok: bool,
    pub tab_id: u64,
    pub url: String,
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserReloadArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bypass_cache: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserHistoryDirection {
    #[default]
    Back,
    Forward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserBackForwardArgs {
    pub direction: BrowserHistoryDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserNavSimpleResult {
    pub ok: bool,
    pub tab_id: u64,
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserSnapshotArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
    #[serde(alias = "selector", skip_serializing_if = "Option::is_none")]
    pub selector_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserSnapshotResult {
    pub ok: bool,
    pub tab_id: u64,
    pub url: String,
    pub title: String,
    pub viewport: BrowserViewportDto,
    pub interactive_elements: Vec<BrowserElementRefDto>,
    pub markdown_excerpt: String,
    pub links: Vec<BrowserLinkDto>,
    pub injection_scan: BrowserInjectionScanDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserExtractMarkdownArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserExtractMarkdownResult {
    pub ok: bool,
    pub tab_id: u64,
    pub url: String,
    pub title: String,
    pub markdown: String,
    pub total_chars: usize,
    pub injection_scan: BrowserInjectionScanDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserQuerySelectorArgs {
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserQueryMatchDto {
    #[serde(rename = "ref")]
    pub element_ref: String,
    pub tag: String,
    pub text: String,
    pub attrs: BTreeMap<String, String>,
    pub visible: bool,
    pub rect: BrowserRectDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserQuerySelectorResult {
    pub ok: bool,
    pub tab_id: u64,
    pub matches: Vec<BrowserQueryMatchDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserMouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserClickArgs {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<BrowserMouseButton>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub double_click: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserClickResult {
    pub ok: bool,
    pub tab_id: u64,
    pub clicked_target: String,
    pub url_after: String,
    pub title_after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserHoverArgs {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserHoverResult {
    pub ok: bool,
    pub tab_id: u64,
    pub hovered_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserTypeArgs {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_first: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub press_enter: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
}

impl BrowserTypeArgs {
    pub fn effective_text(&self) -> Option<&str> {
        self.text.as_deref().or(self.value.as_deref())
    }

    pub fn should_submit(&self) -> bool {
        self.submit.unwrap_or(false) || self.press_enter.unwrap_or(false)
    }

    pub fn should_clear_first(&self) -> bool {
        self.clear_first.unwrap_or(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserTypeResult {
    pub ok: bool,
    pub tab_id: u64,
    pub value_after: String,
    pub submitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserPressKeyArgs {
    pub key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserPressKeyResult {
    pub ok: bool,
    pub tab_id: u64,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserSelectOptionArgs {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserSelectOptionResult {
    pub ok: bool,
    pub tab_id: u64,
    pub selected_value: String,
    pub selected_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserScrollDirection {
    Up,
    #[default]
    Down,
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserScrollArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<BrowserScrollDirection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_px: Option<i64>,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub element_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserScrollResult {
    pub ok: bool,
    pub tab_id: u64,
    pub viewport: BrowserViewportDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWaitState {
    #[default]
    Visible,
    Attached,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserWaitForArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_includes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<BrowserWaitState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserWaitForResult {
    pub ok: bool,
    pub tab_id: u64,
    pub matched: bool,
    pub elapsed_ms: u64,
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserImageFormat {
    #[default]
    Png,
    Jpeg,
}

impl BrowserImageFormat {
    pub const fn mime_type(&self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserScreenshotArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_page: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<BrowserImageFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserScreenshotResult {
    pub ok: bool,
    pub tab_id: u64,
    pub url: String,
    pub title: String,
    pub mime_type: String,
    pub data_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserEvaluateArgs {
    pub expression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserEvaluateResult {
    pub ok: bool,
    pub tab_id: u64,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserGetLogsArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserConsoleLogEntryDto {
    pub timestamp_ms: i64,
    pub level: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserConsoleLogsResult {
    pub ok: bool,
    pub tab_id: u64,
    pub entries: Vec<BrowserConsoleLogEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserNetworkLogEntryDto {
    pub request_id: String,
    pub timestamp_ms: i64,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserNetworkLogResult {
    pub ok: bool,
    pub tab_id: u64,
    pub entries: Vec<BrowserNetworkLogEntryDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCookieOp {
    #[default]
    List,
    Set,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserManageCookiesArgs {
    pub op: BrowserCookieOp,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCookieDto {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub http_only: bool,
    pub secure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub redacted: bool,
}

impl BrowserCookieDto {
    pub fn redact_if_http_only(&mut self) {
        if self.http_only {
            self.value = "[REDACTED_HTTPONLY]".to_string();
            self.redacted = true;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserManageCookiesResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cookies: Vec<BrowserCookieDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserDownloadUrlArgs {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

impl BrowserDownloadUrlArgs {
    pub fn sanitized_filename(&self) -> Option<String> {
        self.filename
            .as_deref()
            .and_then(sanitize_download_filename)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserDownloadUrlResult {
    pub ok: bool,
    pub download_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCdpSendArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
    pub method: String,
    #[serde(default = "default_empty_object")]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BrowserCdpSendResult {
    pub ok: bool,
    pub tab_id: u64,
    pub result: Value,
}

// ============================================================================
// 4. JSON-RPC 2.0 WebSocket Bridge Protocol (`PROJECT.md § 3`)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrowserRpcErrorCode {
    UnauthorizedBridge,
    UserDeniedApproval,
    PolicyDisabled,
    RestrictedUrl,
    TabNotFound,
    ElementNotFound,
    NavigationTimeout,
    CdpAttachFailed,
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    InternalError,
}

impl BrowserRpcErrorCode {
    pub const DOMAIN_CODES: [Self; 8] = [
        Self::UnauthorizedBridge,
        Self::UserDeniedApproval,
        Self::PolicyDisabled,
        Self::RestrictedUrl,
        Self::TabNotFound,
        Self::ElementNotFound,
        Self::NavigationTimeout,
        Self::CdpAttachFailed,
    ];

    pub const fn code(&self) -> i32 {
        match self {
            Self::UnauthorizedBridge => -32001,
            Self::UserDeniedApproval => -32002,
            Self::PolicyDisabled => -32003,
            Self::RestrictedUrl => -32004,
            Self::TabNotFound => -32005,
            Self::ElementNotFound => -32006,
            Self::NavigationTimeout => -32007,
            Self::CdpAttachFailed => -32008,
            Self::ParseError => -32700,
            Self::InvalidRequest => -32600,
            Self::MethodNotFound => -32601,
            Self::InvalidParams => -32602,
            Self::InternalError => -32603,
        }
    }

    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::UnauthorizedBridge => "UNAUTHORIZED_BRIDGE",
            Self::UserDeniedApproval => "USER_DENIED_APPROVAL",
            Self::PolicyDisabled => "POLICY_DISABLED",
            Self::RestrictedUrl => "RESTRICTED_URL",
            Self::TabNotFound => "TAB_NOT_FOUND",
            Self::ElementNotFound => "ELEMENT_NOT_FOUND",
            Self::NavigationTimeout => "NAVIGATION_TIMEOUT",
            Self::CdpAttachFailed => "CDP_ATTACH_FAILED",
            Self::ParseError => "PARSE_ERROR",
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::MethodNotFound => "METHOD_NOT_FOUND",
            Self::InvalidParams => "INVALID_PARAMS",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }

    pub const fn from_code(code: i32) -> Option<Self> {
        match code {
            -32001 => Some(Self::UnauthorizedBridge),
            -32002 => Some(Self::UserDeniedApproval),
            -32003 => Some(Self::PolicyDisabled),
            -32004 => Some(Self::RestrictedUrl),
            -32005 => Some(Self::TabNotFound),
            -32006 => Some(Self::ElementNotFound),
            -32007 => Some(Self::NavigationTimeout),
            -32008 => Some(Self::CdpAttachFailed),
            -32700 => Some(Self::ParseError),
            -32600 => Some(Self::InvalidRequest),
            -32601 => Some(Self::MethodNotFound),
            -32602 => Some(Self::InvalidParams),
            -32603 => Some(Self::InternalError),
            _ => None,
        }
    }

    pub fn from_error_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "UNAUTHORIZED_BRIDGE" => Some(Self::UnauthorizedBridge),
            "USER_DENIED_APPROVAL" => Some(Self::UserDeniedApproval),
            "POLICY_DISABLED" => Some(Self::PolicyDisabled),
            "RESTRICTED_URL" => Some(Self::RestrictedUrl),
            "TAB_NOT_FOUND" => Some(Self::TabNotFound),
            "ELEMENT_NOT_FOUND" => Some(Self::ElementNotFound),
            "NAVIGATION_TIMEOUT" => Some(Self::NavigationTimeout),
            "CDP_ATTACH_FAILED" => Some(Self::CdpAttachFailed),
            "PARSE_ERROR" => Some(Self::ParseError),
            "INVALID_REQUEST" => Some(Self::InvalidRequest),
            "METHOD_NOT_FOUND" => Some(Self::MethodNotFound),
            "INVALID_PARAMS" => Some(Self::InvalidParams),
            "INTERNAL_ERROR" => Some(Self::InternalError),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BrowserJsonRpcId {
    Str(String),
    Num(i64),
}

impl BrowserJsonRpcId {
    pub fn as_key_string(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            Self::Num(n) => n.to_string(),
        }
    }
}

impl From<String> for BrowserJsonRpcId {
    fn from(value: String) -> Self {
        Self::Str(value)
    }
}

impl From<&str> for BrowserJsonRpcId {
    fn from(value: &str) -> Self {
        Self::Str(value.to_string())
    }
}

impl From<i64> for BrowserJsonRpcId {
    fn from(value: i64) -> Self {
        Self::Num(value)
    }
}

impl From<u64> for BrowserJsonRpcId {
    fn from(value: u64) -> Self {
        Self::Num(value as i64)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeHelloParams {
    #[serde(default = "default_protocol_version")]
    pub protocol_version: u32,
    pub extension_id: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_token: Option<String>,
    pub user_agent: String,
    pub capabilities: Vec<String>,
    pub run_policy: BrowserRunPolicy,
    pub tabs_summary: Vec<BrowserTabDto>,
    #[serde(default)]
    pub desktop_bridge_connected: bool,
}

impl Default for BridgeHelloParams {
    fn default() -> Self {
        Self {
            protocol_version: 1,
            extension_id: String::new(),
            device_id: String::new(),
            pairing_token: None,
            user_agent: String::new(),
            capabilities: Vec::new(),
            run_policy: BrowserRunPolicy::AskEveryTime,
            tabs_summary: Vec::new(),
            desktop_bridge_connected: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeHelloAckParams {
    pub accepted: bool,
    pub host_kind: BrowserBridgeHostKind,
    pub host_version: String,
    #[serde(default = "default_ping_interval_secs")]
    pub ping_interval_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Default for BridgeHelloAckParams {
    fn default() -> Self {
        Self {
            accepted: true,
            host_kind: BrowserBridgeHostKind::Server,
            host_version: "1.2.0".to_string(),
            ping_interval_secs: DEFAULT_BRIDGE_PING_INTERVAL_SECS,
            reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BridgeTabsSyncParams {
    pub tabs: Vec<BrowserTabDto>,
    pub run_policy: BrowserRunPolicy,
    #[serde(default)]
    pub desktop_bridge_connected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserInvokeParams {
    pub tool: String,
    #[serde(default = "default_empty_object")]
    pub arguments: Value,
    pub caller: BrowserCallerInfo,
    #[serde(default = "default_invoke_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub approved: bool,
}

impl Default for BrowserInvokeParams {
    fn default() -> Self {
        Self {
            tool: String::new(),
            arguments: default_empty_object(),
            caller: BrowserCallerInfo::default(),
            timeout_ms: DEFAULT_BROWSER_INVOKE_TIMEOUT_MS,
            approved: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BridgePingPongParams {
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BridgeEmergencyStopParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserJsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl BrowserJsonRpcError {
    pub fn from_code(code: BrowserRpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.code(),
            message: message.into(),
            data: Some(json!({ "error_code": code.as_str() })),
        }
    }

    pub fn rpc_code(&self) -> Option<BrowserRpcErrorCode> {
        BrowserRpcErrorCode::from_code(self.code).or_else(|| {
            self.data
                .as_ref()
                .and_then(|d| d.get("error_code"))
                .and_then(|v| v.as_str())
                .and_then(BrowserRpcErrorCode::from_error_str)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserJsonRpcRequest {
    #[serde(default = "default_jsonrpc_version")]
    pub jsonrpc: String,
    pub id: BrowserJsonRpcId,
    pub method: String,
    #[serde(default = "default_empty_object")]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserJsonRpcNotification {
    #[serde(default = "default_jsonrpc_version")]
    pub jsonrpc: String,
    pub method: String,
    #[serde(default = "default_empty_object")]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserJsonRpcResponse {
    #[serde(default = "default_jsonrpc_version")]
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<BrowserJsonRpcId>,
    #[serde(
        default,
        deserialize_with = "deserialize_some_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserJsonRpcError>,
}

impl BrowserJsonRpcResponse {
    pub fn ok(id: impl Into<BrowserJsonRpcId>, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id: Some(id.into()),
            result: Some(result),
            error: None,
        }
    }

    pub fn err(
        id: Option<BrowserJsonRpcId>,
        code: BrowserRpcErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result: None,
            error: Some(BrowserJsonRpcError::from_code(code, message)),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BrowserBridgeFrame {
    Hello {
        id: Option<BrowserJsonRpcId>,
        params: BridgeHelloParams,
    },
    HelloAck {
        id: Option<BrowserJsonRpcId>,
        params: BridgeHelloAckParams,
    },
    TabsSync {
        params: BridgeTabsSyncParams,
    },
    Invoke {
        id: BrowserJsonRpcId,
        params: BrowserInvokeParams,
    },
    Ping {
        id: Option<BrowserJsonRpcId>,
        params: BridgePingPongParams,
    },
    Pong {
        id: Option<BrowserJsonRpcId>,
        params: BridgePingPongParams,
    },
    EmergencyStop {
        id: Option<BrowserJsonRpcId>,
        params: BridgeEmergencyStopParams,
    },
    Response(BrowserJsonRpcResponse),
}

#[derive(Serialize, Deserialize)]
struct RawJsonRpcEnvelope {
    jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<BrowserJsonRpcId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(
        default,
        deserialize_with = "deserialize_some_value",
        skip_serializing_if = "Option::is_none"
    )]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<BrowserJsonRpcError>,
}

impl BrowserBridgeFrame {
    pub fn hello(params: BridgeHelloParams) -> Self {
        Self::Hello { id: None, params }
    }

    pub fn hello_ack(params: BridgeHelloAckParams) -> Self {
        Self::HelloAck { id: None, params }
    }

    pub fn tabs_sync(params: BridgeTabsSyncParams) -> Self {
        Self::TabsSync { params }
    }

    pub fn invoke(id: impl Into<BrowserJsonRpcId>, params: BrowserInvokeParams) -> Self {
        Self::Invoke {
            id: id.into(),
            params,
        }
    }

    pub fn ping(ts: i64) -> Self {
        Self::Ping {
            id: None,
            params: BridgePingPongParams { ts, nonce: None },
        }
    }

    pub fn pong(ts: i64) -> Self {
        Self::Pong {
            id: None,
            params: BridgePingPongParams { ts, nonce: None },
        }
    }

    pub fn emergency_stop(reason: Option<String>, ts: i64) -> Self {
        Self::EmergencyStop {
            id: None,
            params: BridgeEmergencyStopParams { reason, ts },
        }
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
        if raw.len() > MAX_BROWSER_WS_FRAME_BYTES {
            return Err(format!(
                "BrowserBridgeFrame exceeds max frame size ({} > {})",
                raw.len(),
                MAX_BROWSER_WS_FRAME_BYTES
            ));
        }
        serde_json::from_str(raw).map_err(|e| e.to_string())
    }

    pub fn to_json_string(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

impl Serialize for BrowserBridgeFrame {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::Error as SerError;
        let raw = match self {
            Self::Hello { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: id.clone(),
                method: Some("bridge.hello".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::HelloAck { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: id.clone(),
                method: Some("bridge.hello_ack".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::TabsSync { params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: None,
                method: Some("bridge.tabs_sync".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::Invoke { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: Some(id.clone()),
                method: Some("browser.invoke".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::Ping { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: id.clone(),
                method: Some("bridge.ping".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::Pong { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: id.clone(),
                method: Some("bridge.pong".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::EmergencyStop { id, params } => RawJsonRpcEnvelope {
                jsonrpc: JSONRPC_VERSION.to_string(),
                id: id.clone(),
                method: Some("bridge.emergency_stop".to_string()),
                params: Some(serde_json::to_value(params).map_err(SerError::custom)?),
                result: None,
                error: None,
            },
            Self::Response(resp) => {
                let normalized = BrowserJsonRpcResponse {
                    jsonrpc: JSONRPC_VERSION.to_string(),
                    id: resp.id.clone(),
                    result: resp.result.clone(),
                    error: resp.error.clone(),
                };
                return normalized.serialize(serializer);
            }
        };
        raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for BrowserBridgeFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let env = RawJsonRpcEnvelope::deserialize(deserializer)?;
        if env.jsonrpc != JSONRPC_VERSION {
            return Err(DeError::custom(format!(
                "invalid jsonrpc version '{}', expected '2.0'",
                env.jsonrpc
            )));
        }

        if let Some(method) = env.method {
            let params_val = env.params.unwrap_or_else(default_empty_object);
            match method.as_str() {
                "bridge.hello" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::Hello {
                        id: env.id,
                        params,
                    })
                }
                "bridge.hello_ack" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::HelloAck {
                        id: env.id,
                        params,
                    })
                }
                "bridge.tabs_sync" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::TabsSync { params })
                }
                "browser.invoke" => {
                    let id = env
                        .id
                        .ok_or_else(|| DeError::custom("browser.invoke requires JSON-RPC 'id'"))?;
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::Invoke { id, params })
                }
                "bridge.ping" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::Ping {
                        id: env.id,
                        params,
                    })
                }
                "bridge.pong" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::Pong {
                        id: env.id,
                        params,
                    })
                }
                "bridge.emergency_stop" => {
                    let params = serde_json::from_value(params_val).map_err(DeError::custom)?;
                    Ok(Self::EmergencyStop {
                        id: env.id,
                        params,
                    })
                }
                other => Err(DeError::custom(format!(
                    "unsupported BrowserBridgeFrame method '{other}'"
                ))),
            }
        } else {
            if env.result.is_some() && env.error.is_some() {
                return Err(DeError::custom(
                    "JSON-RPC response cannot contain both 'result' and 'error'",
                ));
            }
            if env.result.is_none() && env.error.is_none() {
                return Err(DeError::custom(
                    "JSON-RPC response must contain either 'result' or 'error'",
                ));
            }
            Ok(Self::Response(BrowserJsonRpcResponse {
                jsonrpc: env.jsonrpc,
                id: env.id,
                result: env.result,
                error: env.error,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn test_canonical_tool_registry_completeness_aliases_and_no_forbidden_keys() {
        let descriptors = canonical_browser_tool_descriptors();
        assert_eq!(descriptors.len(), 26);
        assert_eq!(BrowserToolName::ALL_TOOLS.len(), 27);

        let mut covered_rows = BTreeSet::new();
        for desc in &descriptors {
            let row = desc
                .table_row
                .expect("canonical tool must map to table row 1..=24");
            assert!((1..=24).contains(&row));
            covered_rows.insert(row);

            let parsed = BrowserToolName::parse(&desc.name).expect("parse canonical name");
            assert_eq!(parsed.as_str(), desc.name);
            assert_eq!(parsed.to_string(), desc.name);
            assert_eq!(BrowserToolName::from_str(&desc.name).unwrap(), parsed);
            assert_eq!(
                BrowserToolName::normalize_name(&desc.name),
                Some(parsed.as_str())
            );

            if let Some(props) = desc
                .parameters_schema
                .get("properties")
                .and_then(|v| v.as_object())
            {
                for prop_key in props.keys() {
                    assert!(
                        !FORBIDDEN_BROWSER_ARG_KEYS.contains(&prop_key.as_str()),
                        "Tool '{}' schema contains forbidden TIR path key '{}'",
                        desc.name,
                        prop_key
                    );
                }
            }
        }
        assert_eq!(covered_rows.len(), 24);

        let tabs_alias: BrowserToolName = serde_json::from_str("\"browser_tabs\"").unwrap();
        assert_eq!(tabs_alias, BrowserToolName::BrowserListTabs);
        assert_eq!(
            serde_json::to_string(&tabs_alias).unwrap(),
            "\"browser_list_tabs\""
        );

        let switch_alias: BrowserToolName = serde_json::from_str("\"browser_switch_tab\"").unwrap();
        assert_eq!(switch_alias, BrowserToolName::BrowserActivateTab);
        assert_eq!(
            serde_json::to_string(&switch_alias).unwrap(),
            "\"browser_activate_tab\""
        );

        let cdp_alias = BrowserToolName::parse("browser.cdp_send").unwrap();
        assert_eq!(cdp_alias, BrowserToolName::BrowserCdpSend);
        assert_eq!(cdp_alias.risk(), BrowserPolicyRisk::HighRisk);
        assert_eq!(cdp_alias.risk().as_str(), "high_risk");
        assert_eq!(BrowserToolName::parse("unknown_tool"), None);
    }

    #[test]
    fn test_browser_run_policy_roundtrip_aliases_and_evaluation() {
        let cases = [
            (BrowserRunPolicy::AskEveryTime, "\"ask_every_time\""),
            (BrowserRunPolicy::AllowReadOnly, "\"allow_read_only\""),
            (
                BrowserRunPolicy::AlwaysAllowAuthorized,
                "\"always_allow_authorized\"",
            ),
            (BrowserRunPolicy::Disabled, "\"disabled\""),
        ];
        for (policy, expected_json) in cases {
            let json = serde_json::to_string(&policy).unwrap();
            assert_eq!(json, expected_json);
            let parsed: BrowserRunPolicy = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, policy);
            assert!(!policy.as_str().is_empty());

            let comp: ComputerRunPolicy = policy.into();
            let back: BrowserRunPolicy = comp.into();
            assert_eq!(back, policy);
        }

        assert_eq!(
            serde_json::from_str::<BrowserRunPolicy>("\"AskEveryTime\"").unwrap(),
            BrowserRunPolicy::AskEveryTime
        );
        assert_eq!(
            serde_json::from_str::<BrowserRunPolicy>("\"allowReadOnly\"").unwrap(),
            BrowserRunPolicy::AllowReadOnly
        );
        assert_eq!(
            serde_json::from_str::<BrowserRunPolicy>("\"AlwaysAllowAuthorized\"").unwrap(),
            BrowserRunPolicy::AlwaysAllowAuthorized
        );

        assert_eq!(
            BrowserRunPolicy::Disabled.evaluate(BrowserPolicyRisk::ReadOnly, false),
            BrowserPolicyDecision::Deny {
                code: BrowserRpcErrorCode::PolicyDisabled,
                reason: "Browser control is disabled by policy"
            }
        );
        assert_eq!(
            BrowserRunPolicy::AllowReadOnly.evaluate(BrowserPolicyRisk::ReadOnly, true),
            BrowserPolicyDecision::Allow
        );
        assert!(matches!(
            BrowserRunPolicy::AllowReadOnly.evaluate(BrowserPolicyRisk::Mutating, false),
            BrowserPolicyDecision::RequireApproval { .. }
        ));
        assert_eq!(
            BrowserRunPolicy::AlwaysAllowAuthorized.evaluate(BrowserPolicyRisk::Mutating, false),
            BrowserPolicyDecision::Allow
        );
        assert!(matches!(
            BrowserRunPolicy::AlwaysAllowAuthorized.evaluate(BrowserPolicyRisk::Mutating, true),
            BrowserPolicyDecision::RequireApproval { .. }
        ));
        assert!(matches!(
            BrowserRunPolicy::AlwaysAllowAuthorized.evaluate(BrowserPolicyRisk::HighRisk, false),
            BrowserPolicyDecision::RequireApproval { .. }
        ));
    }

    #[test]
    fn test_argument_safety_filename_sanitization_and_domain_matching() {
        assert!(validate_browser_tool_arguments(&json!({"url": "https://example.com", "selector": "#btn"})).is_ok());
        assert!(validate_browser_tool_arguments(&json!({"path": "/etc/passwd"})).is_err());
        assert!(validate_browser_tool_arguments(&json!({"target": "/dashboard"})).is_err());
        assert!(validate_browser_tool_arguments(&json!({"output_path": "a.png"})).is_err());

        assert_eq!(
            sanitize_download_filename("../../etc/secret/report.pdf"),
            Some("report.pdf".to_string())
        );
        assert_eq!(
            sanitize_download_filename("C:\\Users\\admin\\.env"),
            Some("env".to_string())
        );
        assert_eq!(sanitize_download_filename(".."), None);
        assert_eq!(sanitize_download_filename("   "), None);

        let dl_args = BrowserDownloadUrlArgs {
            url: "https://example.com/files/a.pdf".into(),
            filename: Some("../evil/a.pdf".into()),
        };
        assert_eq!(dl_args.sanitized_filename().as_deref(), Some("a.pdf"));

        assert!(is_restricted_browser_url("chrome://extensions"));
        assert!(is_restricted_browser_url(
            "https://chromewebstore.google.com/detail/abc"
        ));
        assert!(!is_restricted_browser_url("https://example.com/path"));

        let mut profile = BotBrowserProfileDto {
            bot_id: 777_000,
            enabled: true,
            run_policy: BrowserRunPolicy::AlwaysAllowAuthorized,
            allowed_domains: vec!["example.com".into()],
            blocked_domains: vec!["admin.example.com".into()],
            preferred_target: BrowserPreferredTarget::Auto,
            updated_at_ms: 100,
        };
        assert!(profile.is_url_allowed("https://app.example.com/login"));
        assert!(!profile.is_url_allowed("https://admin.example.com/panel"));
        assert!(!profile.is_url_allowed("https://evil.org"));
        profile.enabled = false;
        assert!(!profile.is_url_allowed("https://example.com"));
    }

    #[test]
    fn test_snapshot_type_helpers_and_cookie_redaction_roundtrip() {
        let raw_snapshot = r##"{
            "ok": true,
            "tab_id": 42,
            "url": "https://example.com/login",
            "title": "Sign In",
            "viewport": { "width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0, "scroll_height": 1640 },
            "interactive_elements": [
                { "ref": "e1", "tag": "input", "type": "email", "role": "textbox", "label": "Email", "selector": "#email", "value": "", "rect": { "x": 420, "y": 210, "w": 320, "h": 40 } },
                { "ref": "e2", "tag": "button", "role": "button", "label": "Continue", "selector": "button[type=\"submit\"]", "rect": { "x": 420, "y": 270, "w": 320, "h": 42 } }
            ],
            "markdown_excerpt": "# Sign In",
            "links": [{ "text": "Forgot?", "href": "https://example.com/reset", "ref": "e3" }],
            "injection_scan": { "flagged": false, "severity": "none", "findings": [] }
        }"##;

        let parsed: BrowserSnapshotResult = serde_json::from_str(raw_snapshot).unwrap();
        assert_eq!(parsed.tab_id, 42);
        assert_eq!(parsed.interactive_elements.len(), 2);
        assert_eq!(parsed.interactive_elements[0].ref_id(), "e1");
        assert_eq!(
            parsed.interactive_elements[0].input_type.as_deref(),
            Some("email")
        );
        let reserialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(reserialized["interactive_elements"][0]["ref"], "e1");
        assert_eq!(reserialized["interactive_elements"][0]["type"], "email");

        let type_args = BrowserTypeArgs {
            value: Some("legacy".into()),
            press_enter: Some(true),
            ..BrowserTypeArgs::default()
        };
        assert_eq!(type_args.effective_text(), Some("legacy"));
        assert!(type_args.should_submit());
        assert!(type_args.should_clear_first());
        assert_eq!(BrowserImageFormat::Png.mime_type(), "image/png");
        assert_eq!(BrowserImageFormat::Jpeg.mime_type(), "image/jpeg");

        let mut cookie = BrowserCookieDto {
            name: "sid".into(),
            value: "super_secret".into(),
            domain: ".example.com".into(),
            http_only: true,
            secure: true,
            same_site: Some("Lax".into()),
            expiration_date: None,
            redacted: false,
        };
        cookie.redact_if_http_only();
        assert_eq!(cookie.value, "[REDACTED_HTTPONLY]");
        assert!(cookie.redacted);
    }

    #[test]
    fn test_jsonrpc_bridge_frames_and_error_codes_roundtrip() {
        assert_eq!(BrowserRpcErrorCode::DOMAIN_CODES.len(), 8);
        let expected_codes = [
            (
                -32001,
                "UNAUTHORIZED_BRIDGE",
                BrowserRpcErrorCode::UnauthorizedBridge,
            ),
            (
                -32002,
                "USER_DENIED_APPROVAL",
                BrowserRpcErrorCode::UserDeniedApproval,
            ),
            (
                -32003,
                "POLICY_DISABLED",
                BrowserRpcErrorCode::PolicyDisabled,
            ),
            (
                -32004,
                "RESTRICTED_URL",
                BrowserRpcErrorCode::RestrictedUrl,
            ),
            (-32005, "TAB_NOT_FOUND", BrowserRpcErrorCode::TabNotFound),
            (
                -32006,
                "ELEMENT_NOT_FOUND",
                BrowserRpcErrorCode::ElementNotFound,
            ),
            (
                -32007,
                "NAVIGATION_TIMEOUT",
                BrowserRpcErrorCode::NavigationTimeout,
            ),
            (
                -32008,
                "CDP_ATTACH_FAILED",
                BrowserRpcErrorCode::CdpAttachFailed,
            ),
        ];
        for (num, name, variant) in expected_codes {
            assert_eq!(variant.code(), num);
            assert_eq!(variant.as_str(), name);
            assert_eq!(BrowserRpcErrorCode::from_code(num), Some(variant));
            assert_eq!(BrowserRpcErrorCode::from_error_str(name), Some(variant));
        }

        let num_id = BrowserJsonRpcId::from(42u64);
        assert_eq!(num_id.as_key_string(), "42");
        let str_id = BrowserJsonRpcId::from(String::from("req-1"));
        assert_eq!(str_id.as_key_string(), "req-1");

        let hello_raw = r#"{
            "jsonrpc": "2.0",
            "method": "bridge.hello",
            "params": {
                "protocol_version": 1,
                "extension_id": "nkikencljfojglplncicaknnpcclfgph",
                "device_id": "ext-8c1e9b20",
                "pairing_token": "tok_123",
                "user_agent": "Chrome/156.0.8078.79",
                "capabilities": ["tabs", "scripting", "debugger"],
                "run_policy": "ask_every_time",
                "tabs_summary": [{ "tab_id": 42, "active": true, "title": "Docs", "url": "https://example.com" }]
            }
        }"#;
        let hello = BrowserBridgeFrame::parse_json(hello_raw).unwrap();
        match &hello {
            BrowserBridgeFrame::Hello { id, params } => {
                assert!(id.is_none());
                assert_eq!(params.extension_id, "nkikencljfojglplncicaknnpcclfgph");
                assert_eq!(params.run_policy, BrowserRunPolicy::AskEveryTime);
                assert_eq!(params.tabs_summary.len(), 1);
                assert_eq!(params.tabs_summary[0].tab_id, 42);
            }
            other => panic!("expected Hello, got {other:?}"),
        }
        assert_eq!(
            BrowserBridgeFrame::parse_json(&hello.to_json_string().unwrap()).unwrap(),
            hello
        );
        let constructed_hello = BrowserBridgeFrame::hello(BridgeHelloParams::default());
        assert_eq!(
            BrowserBridgeFrame::parse_json(&constructed_hello.to_json_string().unwrap()).unwrap(),
            constructed_hello
        );

        let ack = BrowserBridgeFrame::hello_ack(BridgeHelloAckParams {
            accepted: true,
            host_kind: BrowserBridgeHostKind::Desktop,
            host_version: "1.2.0".into(),
            ping_interval_secs: 20,
            reason: None,
        });
        assert_eq!(BrowserBridgeHostKind::Desktop.as_str(), "desktop");
        assert_eq!(BrowserBridgeHostKind::Server.as_str(), "server");
        assert_eq!(
            BrowserBridgeFrame::parse_json(&ack.to_json_string().unwrap()).unwrap(),
            ack
        );

        let sync_frame = BrowserBridgeFrame::tabs_sync(BridgeTabsSyncParams {
            tabs: vec![BrowserTabDto::default()],
            run_policy: BrowserRunPolicy::AllowReadOnly,
            desktop_bridge_connected: false,
        });
        assert_eq!(
            BrowserBridgeFrame::parse_json(&sync_frame.to_json_string().unwrap()).unwrap(),
            sync_frame
        );

        let invoke = BrowserBridgeFrame::invoke(
            "br_01J8Z9K2",
            BrowserInvokeParams {
                tool: "browser_click".into(),
                arguments: json!({ "tab_id": 42, "ref": "e2" }),
                caller: BrowserCallerInfo {
                    kind: BrowserCallerKind::Bot,
                    user_id: Some(1),
                    bot_id: Some(777_000),
                    bot_name: Some("Telegram Official Bot".into()),
                    chat_id: Some(700_000_001),
                },
                timeout_ms: 20_000,
                approved: false,
            },
        );
        let invoke_json = invoke.to_json_string().unwrap();
        assert!(invoke_json.contains("\"method\":\"browser.invoke\""));
        assert_eq!(
            BrowserBridgeFrame::parse_json(&invoke_json).unwrap(),
            invoke
        );

        let ok_resp = BrowserBridgeFrame::Response(BrowserJsonRpcResponse::ok(
            -99i64,
            serde_json::to_value(BrowserCommandResult::success(
                json!({ "tab_id": 42, "url": "https://example.com", "title": "Example" }),
            ))
            .unwrap(),
        ));
        assert_eq!(
            BrowserBridgeFrame::parse_json(&ok_resp.to_json_string().unwrap()).unwrap(),
            ok_resp
        );

        let fail_cmd = BrowserCommandResult::failure(
            BrowserRpcErrorCode::ElementNotFound,
            "ref e99 not found",
        );
        assert!(!fail_cmd.ok);
        assert_eq!(fail_cmd.rpc_code, Some(-32006));

        let err_resp = BrowserBridgeFrame::Response(BrowserJsonRpcResponse::err(
            Some("br_01J8Z9K2".into()),
            BrowserRpcErrorCode::RestrictedUrl,
            "Cannot access a chrome:// URL",
        ));
        let err_val: Value = serde_json::from_str(&err_resp.to_json_string().unwrap()).unwrap();
        assert_eq!(err_val["error"]["code"], -32004);
        assert_eq!(err_val["error"]["data"]["error_code"], "RESTRICTED_URL");
        let parsed_err = BrowserBridgeFrame::parse_json(&err_resp.to_json_string().unwrap()).unwrap();
        if let BrowserBridgeFrame::Response(ref r) = parsed_err {
            assert_eq!(
                r.error.as_ref().unwrap().rpc_code(),
                Some(BrowserRpcErrorCode::RestrictedUrl)
            );
        }
        assert_eq!(parsed_err, err_resp);

        let ping = BrowserBridgeFrame::ping(1_763_399_000_000);
        let pong = BrowserBridgeFrame::pong(1_763_399_000_005);
        let stop =
            BrowserBridgeFrame::emergency_stop(Some("user_hotkey".into()), 1_763_399_000_010);
        for f in [ping, pong, stop] {
            let s = f.to_json_string().unwrap();
            let v: Value = serde_json::from_str(&s).unwrap();
            assert!(
                v.get("id").is_none(),
                "notification frames must omit 'id' when None: {s}"
            );
            assert_eq!(BrowserBridgeFrame::parse_json(&s).unwrap(), f);
        }
    }

    #[test]
    fn test_jsonrpc_null_result_roundtrip_and_null_id_error_response() {
        // 1. Explicit `"result": null` response MUST roundtrip through both BrowserBridgeFrame and BrowserJsonRpcResponse
        let null_ok_frame =
            BrowserBridgeFrame::Response(BrowserJsonRpcResponse::ok("req_null", Value::Null));
        let null_ok_json = null_ok_frame.to_json_string().unwrap();
        let null_ok_val: Value = serde_json::from_str(&null_ok_json).unwrap();
        assert_eq!(null_ok_val["jsonrpc"], "2.0");
        assert_eq!(null_ok_val["id"], "req_null");
        assert!(null_ok_val.as_object().unwrap().contains_key("result"));
        assert!(null_ok_val["result"].is_null());

        let reparsed_frame = BrowserBridgeFrame::parse_json(&null_ok_json).unwrap();
        assert_eq!(reparsed_frame, null_ok_frame);

        let direct_resp: BrowserJsonRpcResponse =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":"req_null","result":null}"#).unwrap();
        assert_eq!(direct_resp.result, Some(Value::Null));
        assert!(direct_resp.error.is_none());

        // 2. Error response with `id: None` MUST emit `"id": null` per JSON-RPC 2.0 § 5
        let parse_err_resp = BrowserJsonRpcResponse::err(
            None,
            BrowserRpcErrorCode::ParseError,
            "Invalid JSON payload",
        );
        let standalone_err_json = serde_json::to_string(&parse_err_resp).unwrap();
        let standalone_err_val: Value = serde_json::from_str(&standalone_err_json).unwrap();
        assert!(standalone_err_val.as_object().unwrap().contains_key("id"));
        assert!(standalone_err_val["id"].is_null());
        assert!(!standalone_err_val
            .as_object()
            .unwrap()
            .contains_key("result"));

        let err_frame = BrowserBridgeFrame::Response(parse_err_resp);
        let frame_err_json = err_frame.to_json_string().unwrap();
        let frame_err_val: Value = serde_json::from_str(&frame_err_json).unwrap();
        assert!(frame_err_val.as_object().unwrap().contains_key("id"));
        assert!(frame_err_val["id"].is_null());
        assert_eq!(
            BrowserBridgeFrame::parse_json(&frame_err_json).unwrap(),
            err_frame
        );

        // 3. Responses with BOTH `"result": null` and `"error"` or NEITHER must be rejected
        assert!(BrowserBridgeFrame::parse_json(
            r#"{"jsonrpc":"2.0","id":"bad1","result":null,"error":{"code":-32600,"message":"Invalid"}}"#
        )
        .is_err());
        assert!(BrowserBridgeFrame::parse_json(r#"{"jsonrpc":"2.0","id":"bad2"}"#).is_err());
    }

    #[test]
    fn test_all_12_forbidden_arg_keys_and_hardened_restricted_urls() {
        let expected_12_keys = [
            "path",
            "file_path",
            "target_path",
            "target",
            "destination",
            "cwd",
            "workdir",
            "working_dir",
            "output_path",
            "audio_path",
            "image_path",
            "source",
        ];
        assert_eq!(FORBIDDEN_BROWSER_ARG_KEYS.len(), 12);
        for key in expected_12_keys {
            assert!(
                FORBIDDEN_BROWSER_ARG_KEYS.contains(&key),
                "missing forbidden key {key}"
            );
            let mut obj = Map::new();
            obj.insert(key.to_string(), json!("/etc/passwd"));
            assert!(
                validate_browser_tool_arguments(&Value::Object(obj)).is_err(),
                "validate_browser_tool_arguments should reject '{key}'"
            );
        }

        for restricted in [
            "file:///etc/passwd",
            "FILE:///C:/Windows/win.ini",
            "chrome://settings",
            "chrome-extension://nkikencljfojglplncicaknnpcclfgph/workspace.html",
            "chrome-untrusted://terminal",
            "vivaldi://settings",
            "opera://settings",
            "brave://wallet",
            "edge://flags",
            "devtools://devtools/bundled/inspector.html",
            "javascript:alert(1)",
            "view-source:https://example.com",
        ] {
            assert!(
                is_restricted_browser_url(restricted),
                "expected restricted URL: {restricted}"
            );
        }
        assert!(!is_restricted_browser_url("https://chrome.dev/docs"));
        assert!(!is_restricted_browser_url("https://opera.com/download"));
    }
}
