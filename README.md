# GPUI Telegram — Full-Stack Rust Client, MV3 Browser Extension & Dual-Bot Browser Control

GPUI Telegram ("Fabushi") is a full-stack Rust Telegram-UX + AI Agent platform combining:
- **Native Rust Desktop Client (`gpui_telegram_desktop`)** with embedded loopback Browser Control Bridge (`127.0.0.1:19222/ext/ws`)
- **Chrome/Chromium Manifest V3 Browser Extension (`browser-extension/`)** with 1:1 UI/UX parity (`workspace.html`, `sidepanel.html`, `popup.html`, `options.html`)
- **Shared Rust→WASM Core (`gpui_telegram_ext_wasm`, `wasm32-unknown-unknown`)** reusing real PTS contiguity/gap state machines, X3DH + Double Ratchet + SenderKey E2EE, 5-bit 100-bar voice waveforms, HTML-to-Markdown extraction, and prompt-injection defense
- **Unified 24-Tool Live Browser Control (`browser_*`)** empowering **both** the In-Extension Bot and the Desktop `gpui-telegram` Bot (`HermesEngine` & `FabushiBotHost`) to inspect and control real browser tabs safely.

---

## Architecture Overview

1. **Shared Contracts & Rust→WASM Core (`crates/gpui_telegram_proto` + `crates/gpui_telegram_ext_wasm`)**
   - `crates/gpui_telegram_proto/src/browser_contracts.rs`: Canonical schemas for all 24 `browser_*` tools, `[ref=eN]` DOM/ARIA interactive snapshots, `BrowserRunPolicy` (`always_allow_authorized`, `allow_read_only`, `ask_every_time`, `disabled`), and JSON-RPC 2.0 WebSocket bridge frames (`bridge.hello`, `bridge.tabs_sync`, `browser.invoke`, `bridge.ping`/`pong`, `bridge.emergency_stop`).
   - `crates/gpui_telegram_ext_wasm`: Zero-import `wasm32-unknown-unknown` `cdylib` loaded under MV3 `'wasm-unsafe-eval'` CSP.

2. **MV3 Browser Extension Runtime & 1:1 UI (`browser-extension/`)**
   - **Surfaces**: 4-column desktop-parity `workspace.html` (`52px NavRail` + `288px` resizable `ChatSidebar` + `ConversationStage` + `320px ContextInspector`), companion `sidepanel.html`, quick `popup.html`, and 26-section `options.html` (`SettingsRouter`).
   - **Visual & Feature Parity**: 4 `.tdesktop-theme` palettes (`Night`, `Tinted`, `Day`, `Classic`), live `zh-CN` / `en-US` i18n, Auth Wizard + Multi-Account + Passcode Lock, 12 `MessageContent` card types, `<think>` `ThinkingBubble` & `🔧 Steps` streaming, 60 Hermes slash commands, `@page`/`@tab` context pills, 7-tab Hermes Studio, sandboxed `Telegram.WebApp` Mini App host, and `CallOverlay`.
   - **In-Extension AI Bot & Dual Outbound WS Bridges**: Executes multi-turn tool calls directly inside the extension Service Worker AND maintains auto-reconnecting JSON-RPC 2.0 WebSocket bridges to both `gpui_telegram_server` (`/api/v1/browser/ws`) and `gpui_telegram_desktop` (`ws://127.0.0.1:19222/ext/ws`).

3. **Backend Relay & Desktop Bot Browser Control (`gpui_telegram_server`, `gpui_telegram_agent`, `gpui_telegram_desktop`)**
   - **Server Relay**: `/api/v1/browser/ws`, `/api/v1/browser/status`, `/api/v1/browser/tabs`, `/api/v1/browser/exec`, `/api/v1/bots/{bot_id}/browser`, `/api/v1/browser/commands/pending`, `/api/v1/browser/commands/{id}/approve`, and `/api/v1/browser/pairing`.
   - **Desktop Bridge (`127.0.0.1:19222`)**: Loopback `/ext/ws`, `/health`, and `/json/list` validating `Host`, `Origin: chrome-extension://`, and `pairing_token`, with Dual-Mode fallback to local/managed Chrome DevTools Protocol (CDP) when running standalone without an extension attached.

---

## Canonical 24 `browser_*` Tools

| Category | Tools |
|---|---|
| Status & Tabs (7) | `browser_status`, `browser_list_tabs` (`browser_tabs`), `browser_get_active_tab`, `browser_open_tab`, `browser_activate_tab` (`browser_switch_tab`), `browser_close_tab`, `browser_group_tabs` |
| Navigation (3) | `browser_navigate`, `browser_reload`, `browser_back_forward` |
| DOM Inspection (3) | `browser_snapshot` (`[ref=eN]` indexing + injection scan), `browser_extract_markdown`, `browser_query_selector` |
| Interaction (7) | `browser_click`, `browser_hover`, `browser_type` (React `_valueTracker`-safe + `submit`), `browser_press_key`, `browser_select_option`, `browser_scroll`, `browser_wait_for` |
| Capture & DevTools (4) | `browser_screenshot` (active, background & full-page PNG/JPEG), `browser_evaluate`, `browser_get_console_logs` & `browser_get_network_log`, `browser_manage_cookies` (HttpOnly redacted) & `browser_download_url` |

Safety & Security:
- Restricted URL schemes (`chrome://`, `chrome-extension://`, `devtools://`, `about:`, `file://`, `javascript:`, `data:`) are blocked with `-32004 RESTRICTED_URL`.
- Untrusted page text is scanned via WASM `scan_content_for_injection` with automatic approval escalation under `BrowserRunPolicy`.
- Instant Emergency Kill-Switch (`Alt+Shift+S` or Popup button) detaches all `chrome.debugger` sessions and aborts queued operations.

---

## Build & Run Guide

### 1. Rust Workspace (Server & Desktop)
```bash
# Optional on non-root Debian/Ubuntu VMs without global *-dev headers:
bash scripts/setup_sysroot.sh

# Build server and desktop binaries with Cargo
cargo build -p gpui_telegram_server -p gpui_telegram_desktop

# Start server (default 0.0.0.0:8080 or custom GPUI_TELEGRAM_BIND_ADDR)
GPUI_TELEGRAM_BIND_ADDR=127.0.0.1:8080 ./target/debug/gpui_telegram_server

# Start desktop app (or standalone headless loopback bridge on 127.0.0.1:19222)
./target/debug/gpui_telegram_desktop
# Headless bridge mode:
GPUI_BROWSER_BRIDGE_PORT=19222 ./target/debug/gpui_telegram_desktop --browser-bridge-only --server-url http://127.0.0.1:8080
```

### 2. Shared Rust→WASM Extension Core (`wasm32-unknown-unknown`)
```bash
cargo build --manifest-path crates/gpui_telegram_ext_wasm/Cargo.toml --target wasm32-unknown-unknown --release
cargo test --manifest-path crates/gpui_telegram_ext_wasm/Cargo.toml
node crates/gpui_telegram_ext_wasm/tests/wasm_node_test.mjs
```

### 3. MV3 Browser Extension (`browser-extension/`)
```bash
npm --prefix browser-extension install
npm --prefix browser-extension run typecheck
npm --prefix browser-extension run build
```
This outputs the complete unpacked Manifest V3 bundle in `browser-extension/dist/` (`manifest.json`, `background.js`, `content.js`, `workspace.html`, `sidepanel.html`, `popup.html`, `options.html`, and `assets/gpui_telegram_ext_wasm.wasm`).

Load in Chrome / Chromium:
- **Interactive UI**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `browser-extension/dist`.
- **Command-line / Automation**: Launch Chromium with `--disable-extensions-except=$(pwd)/browser-extension/dist --load-extension=$(pwd)/browser-extension/dist`.

### 4. Zero-Mock End-to-End Test Suite (`e2e/`)
```bash
npm --prefix e2e install
./e2e/run_e2e.sh --check-harness
./e2e/run_e2e.sh --tier 1   # or --tier 2, --tier 3, --tier 4
./e2e/run_e2e.sh            # run all 218 tests across Tiers 1–4
```