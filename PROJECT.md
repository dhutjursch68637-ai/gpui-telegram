# Project: GPUI Telegram — MV3 Browser Extension & Dual-Bot Browser Control

## Architecture

### 1. System Overview
`gpui-telegram` ("Fabushi") is a full-stack Rust Telegram-UX + AI Agent platform (`gpui_telegram_desktop` + `gpui_telegram_client` + `gpui_telegram_agent` + `gpui_telegram_server` + `magpie_gateway` + `fabushi_miniapp`). Rather than speaking raw `api.telegram.org` MTProto, clients communicate over Bearer/query-authenticated HTTP REST (`/api/v1/*`, permissive CORS enabled) and real-time PTS WebSocket sync (`/api/v1/ws?token=...`), while `gpui_telegram_server` hosts `@BotFather` (`900000`), `@telegram_official_bot` (`777000`, `AppState.hermes`), per-bot `FabushiBotHost` instances (`AppState.fabushi_bots`), Magpie multi-LLM gateway (including offline deterministic `LocalHermes`), and a 1:1 Telegram Bot API layer (`/bot{token}/{method}`).

To achieve **100% UI/UX parity in a Chrome/Chromium Manifest V3 Browser Extension** while empowering **both the extension's bot AND the desktop `gpui-telegram` bot to genuinely control the browser**, the system is structured into four tightly integrated planes inside a single monorepo (`/home/antigravity/gpui-telegram`):

1. **Shared Contracts & Rust→WASM Core (`gpui_telegram_proto` + `gpui_telegram_ext_wasm`)**:
   - Canonical wire schemas (`crates/gpui_telegram_proto/src/browser_contracts.rs`) for 24 `browser_*` tools, `[ref=eN]` interactive DOM snapshots, `BrowserRunPolicy` (`AskEveryTime`, `AllowReadOnly`, `AlwaysAllowAuthorized`, `Disabled`), and JSON-RPC 2.0 bridge frames (`bridge.hello`, `browser.invoke`, `bridge.tabs_sync`, `bridge.ping`/`pong`, `bridge.emergency_stop`).
   - Standalone `wasm32-unknown-unknown` `cdylib` (`crates/gpui_telegram_ext_wasm`, C-ABI JSON envelope, zero `wasm-pack` dependency, loaded under MV3 `'wasm-unsafe-eval'` CSP) reusing real Rust `ClientSyncCoordinator` PTS gap/order state machine, X3DH + Double Ratchet + SenderKey E2EE, 5-bit 100-bar voice waveform codec, `html_to_markdown`, and `scan_content_for_injection`.

2. **MV3 Browser Extension Runtime, 24-Tool Browser Controller & In-Extension Bot (`browser-extension/`)**:
   - **Background Service Worker (`src/background/`)**: Maintains `/api/v1/ws?token=...` real-time sync (20–25s `Ping`/`Pong` keepalive + `chrome.alarms` 0.5-min cold-wake hydration), `chrome.storage.local` + `IndexedDB` (`gpui_telegram_ext_db`) persistence, In-Extension AI Bot loop (`ext_bot_runner.ts` supporting Magpie/OpenAI/Anthropic/Gemini/LocalHermes + `/browser` commands), and **Dual Outbound WS Bridge Clients** connecting to both `gpui_telegram_server` (`/api/v1/browser/ws`) and `gpui_telegram_desktop` (`ws://127.0.0.1:19222/ext/ws`).
   - **Live Browser Controller & Content Script (`src/background/browser_controller.ts` + `src/content/dom_agent.ts`)**: Executes all 24 `browser_*` tools via `chrome.tabs`, `chrome.tabGroups`, `chrome.scripting` (`[ref=eN]` DOM/ARIA snapshot + React-compatible input setter + click/hover/scroll/select/wait), `chrome.tabs.captureVisibleTab` + `chrome.debugger` CDP 1.3 (background-tab/full-page screenshots, console/network capture, trusted input), `chrome.cookies`, and `chrome.downloads`, with `scan_content_for_injection`, `BrowserRunPolicy` approval prompts, visual agent-highlight border, `RESTRICTED_URL (-32004)` safety, and `Alt+Shift+S` emergency kill-switch.

3. **1:1 `gpui-telegram` Extension UI Surfaces (`browser-extension/src/ui/`)**:
   - **Full-Tab Workspace (`workspace.html`)**: Exact 1:1 4-column desktop `AppShell` (`52px NavRail` + `288px resizable ChatSidebar` + `ConversationStage & CanonicalComposer` + `320px ContextInspector` + 7-tab `GlobalTasksWorkspace` Hermes Studio + 26-section `SettingsRouter` + `Browser/Computer Workbench`).
   - **Chrome Side Panel (`sidepanel.html`)**: Persistent responsive companion panel (`<680px` adaptive layout) alongside any active webpage with live Bot Browser Action feed & active-tab `@page` attachment.
   - **Action Popup (`popup.html`) & Options (`options.html`)**: Quick unread switcher, active tab summarize/control prompt, Desktop Bridge pairing status, `BrowserRunPolicy` selector, and 1-click Emergency Stop.
   - **Visual & Behavioral Parity**: All 4 `.tdesktop-theme` palettes (`Night`, `Tinted`, `Day`, `Classic`), custom accent/font/radius, `zh-CN`/`en-US` i18n, Auth Wizard, 12 message card types, `<think>` `ThinkingBubble` & `🔧 Steps` streaming, 54 Hermes slash commands, Mini App sandboxed `<iframe>` (`Telegram.WebApp` bridge), WebRTC `CallOverlay`/Talk Mode, 24 modal dialogs, and keyboard shortcuts.

4. **Rust Backend Relay, Upgraded `ToolsetId::Browser` & Desktop App Browser Control (`gpui_telegram_agent`, `gpui_telegram_server`, `gpui_telegram_client`, `gpui_telegram_desktop`)**:
   - **`gpui_telegram_server`**: `BrowserControlService` (`routes/browser_bridge.rs`) implementing `BrowserBridgeProvider`, mounted at `/api/v1/browser/ws` + `/api/v1/browser/*` and wired into **both** `state.hermes` and `state.fabushi_bots`.
   - **`gpui_telegram_agent`**: Expands `ToolsetId::Browser` to the canonical 24 tools with **Dual-Mode Execution** — (1) Extension WS Bridge (`BrowserBridgeProvider` / Desktop loopback bridge) -> (2) Managed/Local CDP fallback (capable of attaching or auto-launching Chromium/Chrome with `--remote-debugging-port` when standalone Desktop runs without an extension connected). Upgrades `/browser` slash command with real subcommands (`status`, `tabs`, `open`, `navigate`, `snapshot`, `cdp`, `on`, `off`).
   - **`gpui_telegram_desktop` & `gpui_telegram_client`**: Embedded loopback WS RPC server (`127.0.0.1:19222/ext/ws` + `/health` + `/json/list` validating `Host`, `Origin: chrome-extension://`, and `pairing_token`), `TelegramClient` browser API methods, and live Browser Bridge controls/previews in Desktop Hermes Studio (`toolsets_terminal_tab.rs`), `ContextInspector`, `Settings::Computers`, and `ComputerWorkbench`.

### 2. Data Flow
- **Extension Bot -> Browser**: User chats in `sidepanel.html` / `workspace.html` -> either `gpui_telegram_server` (`HermesEngine` / `FabushiBotHost`) dispatches `browser.invoke` over `/api/v1/browser/ws` to Extension SW, OR In-Extension Bot (`ext_bot_runner.ts`) invokes `BrowserController` directly in Extension SW -> Content Script / `chrome.*` executes on live tab -> `[ref=eN]` DOM / PNG screenshot returned -> streamed into chat bubble (`🔧 Steps` + preview).
- **Desktop Bot -> Browser**: User chats in `gpui_telegram_desktop` (or via `/api/v1/messages/send` / `/api/v1/hermes/turns`) -> `HermesEngine` invokes `ToolsetId::Browser` -> routes via Desktop loopback bridge (`ws://127.0.0.1:19222/ext/ws`) or Server relay (`/api/v1/browser/ws`) to connected Browser Extension (or falls back to managed local CDP browser if no extension connected) -> executes on live browser -> result + screenshot returned to Desktop bot & Workbench.

---

## Feature Inventory

Every Survey feature from `survey_1`, `survey_2`, and `survey_3` is assigned a concrete Milestone (zero unassigned features):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Workspace Bootstrap, Non-Root Sysroot & Canonical Browser Wire Contracts | Clone `bhrum/gpui-telegram` to `/home/antigravity/gpui-telegram` (XFS), configure non-root Linux build sysroot if required for native crates, add `crates/gpui_telegram_proto/src/browser_contracts.rs` (24-tool schemas, DTOs, JSON-RPC 2.0 frames, error codes `-32001..-32008`), and gate non-WASM `inherited/*` imports behind `host` feature. | M1 | survey_2, survey_3 |
| F2 | Shared Rust→WASM Extension Core (`gpui_telegram_ext_wasm`) | Standalone `wasm32-unknown-unknown` `cdylib` exposing C-ABI JSON ops reusing Rust `ClientSyncCoordinator` (PTS contiguity/gap buffer), E2EE (X3DH, Double Ratchet, SenderKeys, safety-number emojis), 5-bit 100-bar voice waveform codec, `html_to_markdown`, and `scan_content_for_injection`. | M1 | survey_3 |
| F3 | Server Browser Control Relay (`/api/v1/browser/*` & `/api/v1/browser/ws`) | `BrowserControlService` in `gpui_telegram_server` holding per-user Extension/Desktop WS sessions, live tab inventories, `BrowserRunPolicy` approval waiters, pairing tokens, and REST/WS endpoints, wired into BOTH `AppState.hermes` (`@telegram_official_bot`) and `AppState.fabushi_bots`. | M2 | survey_1, survey_2, survey_3 |
| F4 | Upgraded 24-Tool `ToolsetId::Browser` & `/browser` Command in `gpui_telegram_agent` | Expand `ToolsetId::Browser` to all 24 canonical `browser_*` tools (`[ref=eN]` snapshots, `browser_type` `submit` + React setter fix, tab/nav/DOM/screenshot/devtools tools), Dual-Mode routing (Extension WS Bridge -> Managed Local CDP fallback), `SecurityEngine` TIR path-check compatibility + `scan_output` defense, and full `/browser` slash subcommands. | M2 | survey_2, survey_3 |
| F5 | Desktop App Loopback Bridge (`127.0.0.1:19222`) & Desktop Browser Control UI | Embedded loopback WS RPC + `/health` + `/json/list` bridge in `gpui_telegram_desktop` (`Host` + `Origin: chrome-extension://` + `pairing_token` verification), `gpui_telegram_client` browser API methods, and Desktop UI controls (Hermes Studio, Inspector, Settings Computers, Workbench, 1-click managed local CDP browser launch). | M2 | survey_1, survey_2, survey_3 |
| F6 | MV3 Extension Runtime, Service Worker Lifecycle & Real-Time PTS Sync | Manifest V3 package (`manifest.json` with `'wasm-unsafe-eval'` CSP, deterministic dev key, permissions, `Ctrl+Shift+Y` & `Alt+Shift+S` commands), `/api/v1/ws` 20–25s `Ping`/`Pong` keepalive + `chrome.alarms` cold-wake hydration, `chrome.storage.local` + `IndexedDB` (`gpui_telegram_ext_db`) sync/outbox/E2EE cache, unread action badge & notifications. | M3 | survey_1, survey_3 |
| F7 | Extension 24-Tool Live Browser Controller & `[ref=eN]` Content-Script Agent | Complete MV3 execution engine across `chrome.tabs`, `chrome.tabGroups`, `chrome.scripting` (`[ref=eN]` interactive DOM/ARIA indexing, click, hover, React-safe type + submit, press_key, select_option, scroll, wait_for, query_selector, extract_markdown), `captureVisibleTab` + `chrome.debugger` CDP background/full-page screenshots & console/network logs, cookies, downloads, `RESTRICTED_URL` handling, and in-page visual highlight overlay. | M3 | survey_1, survey_2, survey_3 |
| F8 | In-Extension AI Bot Runner & Outbound Dual-Bridge WS Clients | Local tool-calling bot agent loop inside Extension SW (supporting Magpie `/api/v1/magpie/v1/chat/completions`, OpenAI, Anthropic, Gemini, LocalHermes, and `/browser` commands) executing `browser_*` directly via extension APIs, plus auto-reconnecting outbound JSON-RPC 2.0 WS clients to `/api/v1/browser/ws` and Desktop `ws://127.0.0.1:19222/ext/ws`. | M3 | survey_2, survey_3 |
| F9 | Browser Control Security, `BrowserRunPolicy` Approval Gates & Kill-Switch | Enforce `AskEveryTime`, `AllowReadOnly`, `AlwaysAllowAuthorized`, and `Disabled` policies, domain allow/block lists, automatic approval escalation on `scan_content_for_injection` hits, inline approval prompts, and instant `Alt+Shift+S` / Popup Emergency Stop detaching debuggers and aborting queued operations. | M3 | survey_1, survey_2, survey_3 |
| F10 | Extension Multi-Surface Responsive `AppShell`, 4 Themes & Bilingual i18n | `workspace.html` (1:1 4-column desktop layout: `52px NavRail` + `288px resizable ChatSidebar` + `ConversationStage` + `320px ContextInspector`), `sidepanel.html` (responsive companion panel with live Bot Browser Action bar), `popup.html` & `options.html`, all 4 `.tdesktop-theme` palettes (`Night`, `Tinted`, `Day`, `Classic`) + accent/font/radius controls, `zh-CN`/`en-US` i18n, and desktop keyboard shortcuts. | M4 | survey_1, survey_3 |
| F11 | Extension Auth Wizard, Server Selector, Multi-Account & Passcode Lock | Full Auth Wizard (Password Login/Register, Alipay QR, Email OTP, Phone OTP, QR Pairing, 2FA & Passkey), inline `server_url` selector with connectivity check, Multi-Account Switcher, active session management, and local Passcode Lock Screen. | M4 | survey_1, survey_3 |
| F12 | Extension Chat Sidebar, Folders, Universal Search & Bot/Group Creation | Universal search (`Cmd/Ctrl+K`, 10 categories + 6 tags), `+` creation menu (Create Fabushi AI Bot, `@BotFather` NL bot creation, New Group, New Channel, Add Contact), Stories & Top Peers strips, custom Folder tabs with unread badges, Forum Topics, Archived Chats, and dialog context menu (Pin, Mute, Read/Unread, Archive, Clear, Delete/Leave). | M4 | survey_1, survey_3 |
| F13 | Extension Conversation Stage, 12 Message Cards, AI Streaming & Composer | Virtualized transcript with sticky date/unread pills, pinned banner, all 12 `MessageContent` card types (Text, Media, Voice 5-bit waveform player, Album, Location, Poll/Quiz, Service, Call, Story, Invoice, BotKeyboard, GenerativeCard), Markdown & `<pre>` 1-click Copy, `<think>` `ThinkingBubble` & `🔧 Steps` + browser screenshot action cards, Reactions/Replies/Edits/Pins/Forwards/Translate, and `CanonicalComposer` (54 Hermes slash commands, `@page`/`@tab`/`@url` context pills, chunked uploads, voice recording, emoji/stickers/GIFs). | M4 | survey_1, survey_3 |
| F14 | Extension Hermes Studio (7 Tabs), Settings (26 Sections), Inspector, Mini Apps & Calls | 7-tab `GlobalTasksWorkspace` (Tasks/Kanban, Skills, Memory/Soul/Honcho, MCP & Toolsets, Cron/Heartbeat, Sessions, Approvals), 26-section `SettingsRouter` (including Magpie `AiProviders` & `Computers`/Browser Bridge), `ContextInspector` (Profile/Members/SharedMedia/Settings + Bot Studio & Browser Policy binding), sandboxed Mini App `<iframe>` (`Telegram.WebApp` SDK), WebRTC `CallOverlay`/Talk Mode, and 24 modal dialogs. | M4 | survey_1, survey_3 |
| F15 | Zero-Mock Full-Stack Integration & Adversarial Hardening | End-to-end integration across `gpui_telegram_server`, `gpui_telegram_desktop` bridge, MV3 Extension (`workspace.html`/`sidepanel.html`/`popup.html`), In-Extension Bot, and Desktop Bot controlling real Chromium 156 tabs without mocks; pass 100% of E2E Tiers 1–4 and Tier 5 white-box adversarial coverage hardening. | M5 | survey_1, survey_2, survey_3 |
| F16 | Monorepo Packaging, CI Workflow & GitHub Repository Publish | Clean git repository hygiene, comprehensive root & `browser-extension/` documentation (`README.md`), `.github/workflows/ci.yml` covering Rust + Extension + WASM builds/tests, public repository creation (`dhutjursch68637-ai/gpui-telegram`) via `gh repo create`, code push, and remote clone/status verification. | M6 | survey_2, ORIGINAL_REQUEST |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|--------------|--------|
| M1 | Foundation, Repo Bootstrap, Browser Contracts & WASM Core | Clone `bhrum/gpui-telegram` to `/home/antigravity/gpui-telegram`; configure non-root sysroot (`scripts/setup_sysroot.sh` -> `/home/antigravity/.local-sysroot`) if needed so full Rust workspace compiles; implement `crates/gpui_telegram_proto/src/browser_contracts.rs` (24-tool schemas & JSON-RPC frames) + `host` feature gate for WASM portability; implement & test `crates/gpui_telegram_ext_wasm` (`wasm32-unknown-unknown` `cdylib`). | none | IN_PROGRESS (`0047e2597be630abaa94c15864223eed`) |
| M2 | Rust Backend Browser Relay, 24-Tool Agent & Desktop Bridge/UI | Implement `BrowserBridgeProvider` + 24-tool `ToolsetId::Browser` (Dual-Mode WS Relay + Managed CDP fallback) + `/browser` subcommands in `gpui_telegram_agent`; implement `BrowserControlService` (`/api/v1/browser/ws` + `/api/v1/browser/*`) wired to `state.hermes` & `state.fabushi_bots` in `gpui_telegram_server`; implement `api_browser.rs` in `gpui_telegram_client`; implement `127.0.0.1:19222/ext/ws` loopback bridge + Browser Bridge UI panels in `gpui_telegram_desktop`. | M1 | PLANNED |
| M3 | MV3 Extension Runtime, 24-Tool Browser Controller & In-Extension Bot | Scaffold `browser-extension/` (TypeScript + Vite + React, MV3 `manifest.json` with deterministic dev key & `'wasm-unsafe-eval'` CSP); integrate `gpui_telegram_ext_wasm`; implement Service Worker `/api/v1/ws` sync + `chrome.storage.local` + `IndexedDB` cache; implement full 24-tool `BrowserController` + `[ref=eN]` content script + `BrowserRunPolicy` approvals + `Alt+Shift+S` kill-switch; implement `ext_bot_runner` + Dual Outbound WS Bridge clients (`/api/v1/browser/ws` & `ws://127.0.0.1:19222/ext/ws`) + typed UI port RPC (`src/shared/`). | M1 | PLANNED |
| M4 | MV3 Extension 1:1 `gpui-telegram` UI/UX Parity | Implement complete frontend UI in `browser-extension/src/ui/` across `workspace.html` (4-column desktop parity), `sidepanel.html` (responsive companion), `popup.html`, and `options.html`: 4 `.tdesktop-theme` presets, `zh-CN`/`en-US` i18n, Auth Wizard, NavRail, MainMenuDrawer, ChatSidebar, ConversationStage (12 message card types, Markdown/code copy, `<think>` & `🔧 Steps` + browser screenshot cards), CanonicalComposer (54 slash commands, `@page`/`@tab` pills, media/voice), ContextInspector + Bot Studio, 7-tab Hermes Studio, 26-section Settings, Mini App host, CallOverlay/Talk Mode, 24 Modals, and shortcuts. | M3 | PLANNED |
| M5 | Final Milestone: E2E Suite Pass (Tiers 1–4) & Tier 5 Adversarial Hardening | Phase 1: Wait for `/home/antigravity/TEST_READY.md`, execute sequential sub-milestones Tier 1 -> Tier 2 -> Tier 3 -> Tier 4 fixing any integration bugs until 100% of opaque-box E2E tests pass (whole-project audit at Tier 4). Phase 2: Dedicated Tier-5 sub-orchestrator running inverted white-box Challenger -> Worker -> Reviewer + Auditor loop until zero adversarial gaps remain. | M2, M4, TEST_READY.md | PLANNED |
| M6 | GitHub Repository Creation, Push & Remote Verification | Vendor verified E2E suite into `/home/antigravity/gpui-telegram/e2e/` (preserving `/home/antigravity/e2e_tests/` runner), finalize `README.md` & `.github/workflows/ci.yml`, ensure `.gitignore` hygiene (no `target/`, `node_modules/`, `.e2e-runs/`, `.local-sysroot/`, or secrets), create public repo `dhutjursch68637-ai/gpui-telegram` via `gh repo create`, push `main`, and verify remote commits & clean test run. | M5 | PLANNED |
| E2E | Parallel E2E Testing Track (`TEST_INFRA.md` -> `TEST_READY.md`) | Requirement-driven opaque-box 4-tier E2E test infrastructure (`/home/antigravity/TEST_INFRA.md`) and automated zero-mock test suite in `/home/antigravity/e2e_tests/` exercising `/home/antigravity/gpui-telegram` server, desktop bridge, and unpacked MV3 extension in real Chromium 156; publishes `/home/antigravity/TEST_READY.md` upon completion. | none (runs in parallel) | IN_PROGRESS (`c201c3fc4a9f772c18b80dd7afbe8da0`) |

---

## Interface Contracts

### 1. Canonical Paths, Binaries & Environment Variables
- **Git Repository Root**: `/home/antigravity/gpui-telegram` (MUST reside on `/home/antigravity` XFS; NEVER `/tmp` or `/home/antigravity/.gemini/jetski` `virtiofs`).
- **Built Unpacked MV3 Extension Path**: `/home/antigravity/gpui-telegram/browser-extension/dist`
  - Build command: `npm --prefix /home/antigravity/gpui-telegram/browser-extension run build`
  - Required entry files inside `dist/`: `manifest.json`, `background.js`, `content.js`, `workspace.html`, `sidepanel.html`, `popup.html`, `options.html`, `assets/gpui_telegram_ext_wasm.wasm`.
- **Server Binary & Config**:
  - Build command: `cargo build --manifest-path /home/antigravity/gpui-telegram/Cargo.toml -p gpui_telegram_server`
  - Binary path: `/home/antigravity/gpui-telegram/target/debug/gpui_telegram_server`
  - Env vars supported: `GPUI_TELEGRAM_BIND_ADDR` (e.g. `127.0.0.1:18080`, default `0.0.0.0:8080`), `GPUI_TELEGRAM_DB_PATH` / `GPUI_TELEGRAM_DATA_DIR`, `HERMES_BROWSER_CDP_URL` (optional CDP fallback URL).
- **Desktop Loopback Bridge Host / CLI Mode**:
  - `gpui_telegram_desktop` (and a lightweight headless/CLI flag `--browser-bridge-only` or `gpui_telegram_server` / desktop bridge helper for headless E2E environments without GPU windows) binds `127.0.0.1:${GPUI_BROWSER_BRIDGE_PORT:-19222}` with pairing token `${GPUI_BROWSER_BRIDGE_TOKEN}` (persisted at `${GPUI_TELEGRAM_CONFIG_DIR}/browser_bridge.json`).
- **Linux VM Real Chromium 156 Launch Contract (Mandatory for E2E & Managed CDP)**:
  - Binary: `/usr/lib/chromium/chromium` (**NEVER** `/usr/bin/chromium` or `/usr/bin/google-chrome`, whose `/etc/chromium.d/extensions` wrapper breaks `--load-extension`).
  - Required flags for unpacked MV3 extension E2E:
    `--headless=new --no-sandbox --no-zygote --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=<xfs_or_dev_shm_dir> --disable-features=DisableLoadExtensionCommandLineSwitch --enable-unsafe-extension-debugging --disable-extensions-except=<dist_dir> --load-extension=<dist_dir> --remote-debugging-port=<port>`

### 2. Canonical 24-Tool `ToolsetId::Browser` Contract (`gpui_telegram_proto` <-> `gpui_telegram_agent` <-> `browser-extension`)
All 24 tools below MUST be defined in `gpui_telegram_proto::browser_contracts`, exposed in `gpui_telegram_agent` (`ToolsetId::Browser`), and implemented in `browser-extension` (`BrowserController` + `ext_bot_runner`):

| # | Tool Name | Policy Risk | Accepted Arguments | Result Envelope (`ok: true`) |
|---|-----------|-------------|--------------------|------------------------------|
| 1 | `browser_status` | `ReadOnly` | `{}` | `{ ok, connected, mode, active_tabs, extension_id?, run_policy, desktop_bridge_connected, server_relay_connected }` |
| 2 | `browser_list_tabs` (alias: `browser_tabs`) | `ReadOnly` | `{ window_id?: u64, current_window_only?: bool }` | `{ ok, tabs: [{ tab_id, window_id, group_id?, active, pinned, audible, status, title, url, controllable }] }` |
| 3 | `browser_get_active_tab` | `ReadOnly` | `{ window_id?: u64 }` | `{ ok, tab: BrowserTabDto }` |
| 4 | `browser_open_tab` | `Mutating` | `{ url: string, active?: bool, group_with_bot?: bool }` | `{ ok, tab: BrowserTabDto }` |
| 5 | `browser_activate_tab` (alias: `browser_switch_tab`) | `Mutating` | `{ tab_id: u64 }` | `{ ok, tab: BrowserTabDto }` |
| 6 | `browser_close_tab` | `Mutating` | `{ tab_id: u64 }` | `{ ok, closed_tab_id: u64 }` |
| 7 | `browser_group_tabs` | `Mutating` | `{ tab_ids: u64[], title?: string, color?: string }` | `{ ok, group_id: i64, tab_ids: u64[] }` |
| 8 | `browser_navigate` | `Mutating` | `{ url: string, tab_id?: u64, wait_until?: "complete"\|"interactive", timeout_ms?: u64, cdp_url?: string }` | `{ ok, tab_id, url, title, status }` |
| 9 | `browser_reload` | `Mutating` | `{ tab_id?: u64, bypass_cache?: bool }` | `{ ok, tab_id, url, title }` |
| 10 | `browser_back_forward` | `Mutating` | `{ direction: "back"\|"forward", tab_id?: u64 }` | `{ ok, tab_id, url, title }` |
| 11 | `browser_snapshot` | `ReadOnly` | `{ tab_id?: u64, max_chars?: usize, include_hidden?: bool, selector_scope?: string, cdp_url?: string }` | `{ ok, tab_id, url, title, viewport: { width, height, scroll_x, scroll_y, scroll_height }, interactive_elements: [{ ref, tag, type?, role, label, selector, value?, rect: { x, y, w, h } }], markdown_excerpt, links, injection_scan }` |
| 12 | `browser_extract_markdown` | `ReadOnly` | `{ tab_id?: u64, max_chars?: usize, offset?: usize }` | `{ ok, tab_id, url, title, markdown, total_chars, injection_scan }` |
| 13 | `browser_query_selector` | `ReadOnly` | `{ selector: string, tab_id?: u64, limit?: usize }` | `{ ok, tab_id, matches: [{ ref, tag, text, attrs, visible, rect }] }` |
| 14 | `browser_click` | `Mutating` | `{ ref?: string, selector?: string, text?: string, x?: f64, y?: f64, button?: "left"\|"right", double_click?: bool, tab_id?: u64, cdp_url?: string }` | `{ ok, tab_id, clicked_target, url_after, title_after }` |
| 15 | `browser_hover` | `Mutating` | `{ ref?: string, selector?: string, x?: f64, y?: f64, tab_id?: u64 }` | `{ ok, tab_id, hovered_target }` |
| 16 | `browser_type` | `Mutating` | `{ ref?: string, selector?: string, text?: string, value?: string, clear_first?: bool, submit?: bool, press_enter?: bool, tab_id?: u64, cdp_url?: string }` | `{ ok, tab_id, value_after, submitted: bool }` |
| 17 | `browser_press_key` | `Mutating` | `{ key: string, modifiers?: string[], tab_id?: u64 }` | `{ ok, tab_id, key }` |
| 18 | `browser_select_option` | `Mutating` | `{ ref?: string, selector?: string, value?: string, label?: string, tab_id?: u64 }` | `{ ok, tab_id, selected_value, selected_label }` |
| 19 | `browser_scroll` | `Mutating` | `{ direction?: "up"\|"down"\|"top"\|"bottom", amount_px?: i64, ref?: string, selector?: string, tab_id?: u64 }` | `{ ok, tab_id, viewport }` |
| 20 | `browser_wait_for` | `Mutating` | `{ selector?: string, text?: string, url_includes?: string, state?: "visible"\|"attached"\|"hidden", timeout_ms?: u64, tab_id?: u64 }` | `{ ok, tab_id, matched: true, elapsed_ms, url, title }` |
| 21 | `browser_screenshot` | `ReadOnly` | `{ tab_id?: u64, full_page?: bool, selector?: string, format?: "png"\|"jpeg", cdp_url?: string }` | `{ ok, tab_id, url, title, mime_type, data_base64, width?, height? }` (+ `HermesToolArtifact` image) |
| 22 | `browser_evaluate` | `HighRisk` | `{ expression: string, tab_id?: u64 }` | `{ ok, tab_id, value }` |
| 23 | `browser_get_console_logs` & `browser_get_network_log` | `ReadOnly` | `{ tab_id?: u64, limit?: usize, level?: string }` | `{ ok, tab_id, entries: [...] }` |
| 24 | `browser_manage_cookies` & `browser_download_url` | `Mutating` | `{ op: "list"\|"set"\|"delete", url: string, name?: string, value?: string }` / `{ url: string, filename?: string }` | `{ ok, cookies?: [...], download_id?: u64 }` (HttpOnly values redacted on read) |

*(Note: Parameter names MUST NOT use `"path"`, `"file_path"`, `"target_path"`, `"destination"`, `"cwd"`, or `"workdir"`, avoiding `SecurityEngine::pre_execute_check` workspace-containment false positives; `filename` in `browser_download_url` is sanitized to basename only.)*

### 3. JSON-RPC 2.0 WebSocket Bridge Protocol (`gpui_telegram_server` & `gpui_telegram_desktop` <-> `browser-extension`)
Shared identically by:
- **Server Relay WS**: `ws(s)://<server>/api/v1/browser/ws?token=<BearerToken>&client=extension`
- **Desktop Loopback WS**: `ws://127.0.0.1:${GPUI_BROWSER_BRIDGE_PORT:-19222}/ext/ws?token=<pairing_token>` (validates `Host` in `127.0.0.1`/`localhost` and `Origin` starting with `chrome-extension://` if header present; rejects web pages with `403 Forbidden`).

Wire messages (UTF-8 JSON text frames, max message size `32 MiB`):
- `bridge.hello` (Extension -> Host): `{ "jsonrpc": "2.0", "method": "bridge.hello", "params": { "protocol_version": 1, "extension_id": "...", "device_id": "...", "pairing_token": "...", "user_agent": "...", "capabilities": [...], "run_policy": "always_allow_authorized"|"allow_read_only"|"ask_every_time"|"disabled", "tabs_summary": [...] } }`
- `bridge.hello_ack` (Host -> Extension): `{ "jsonrpc": "2.0", "method": "bridge.hello_ack", "params": { "accepted": true, "host_kind": "server"|"desktop", "host_version": "1.2.0", "ping_interval_secs": 20 } }`
- `bridge.tabs_sync` (Extension -> Host notification): `{ "jsonrpc": "2.0", "method": "bridge.tabs_sync", "params": { "tabs": [...], "run_policy": "..." } }`
- `browser.invoke` (Host -> Extension request): `{ "jsonrpc": "2.0", "id": "<req_id>", "method": "browser.invoke", "params": { "tool": "browser_click", "arguments": { ... }, "caller": { "kind": "bot"|"user"|"desktop", "bot_id": 777000, "bot_name": "...", "chat_id": 700000001 }, "timeout_ms": 20000 } }`
- Result response (Extension -> Host): `{ "jsonrpc": "2.0", "id": "<req_id>", "result": { "ok": true, ... } }` or `{ "jsonrpc": "2.0", "id": "<req_id>", "error": { "code": -32004, "message": "...", "data": { "error_code": "RESTRICTED_URL" } } }`
- Keepalive & Kill-Switch: `bridge.ping` <-> `bridge.pong` every 20s; `bridge.emergency_stop` aborts all active/pending browser ops.
- Canonical JSON-RPC error codes: `-32001` `UNAUTHORIZED_BRIDGE`, `-32002` `USER_DENIED_APPROVAL`, `-32003` `POLICY_DISABLED`, `-32004` `RESTRICTED_URL`, `-32005` `TAB_NOT_FOUND`, `-32006` `ELEMENT_NOT_FOUND`, `-32007` `NAVIGATION_TIMEOUT`, `-32008` `CDP_ATTACH_FAILED`.

### 4. Server REST Browser Control Endpoints (`gpui_telegram_server`)
All protected by `AuthBearer` (`Authorization: Bearer <token>` or `?token=<token>`):
- `GET /api/v1/browser/status` -> `BrowserBridgeStatusDto`
- `GET /api/v1/browser/tabs` -> `{ ok: bool, tabs: Vec<BrowserTabDto> }`
- `POST /api/v1/browser/exec` -> `{ tool: String, arguments: Value, bot_id: Option<u64>, chat_id: Option<i64>, timeout_ms: Option<u64> }` -> `BrowserCommandResult`
- `GET /api/v1/bots/{bot_id}/browser` & `PUT /api/v1/bots/{bot_id}/browser` -> `BotBrowserProfileDto` (`enabled`, `run_policy`, `allowed_domains`, `blocked_domains`, `preferred_target`)
- `GET /api/v1/browser/commands/pending` & `POST /api/v1/browser/commands/{command_id}/approve` -> `{ approved: bool, remember_for_session: Option<bool> }`
- `POST /api/v1/browser/pairing` -> issues/rotates/verifies `pairing_token` for Desktop↔Extension pairing.

### 5. Rust→WASM C-ABI Contract (`crates/gpui_telegram_ext_wasm` <-> `browser-extension/src/wasm/`)
- Exported WASM symbols: `wasm_alloc(len: usize) -> *mut u8`, `wasm_dealloc(ptr: *mut u8, len: usize)`, `wasm_invoke_json(ptr: *const u8, len: usize) -> u64` (upper 32 bits = output pointer, lower 32 bits = output byte length; UTF-8 JSON `{ "op": "<op_name>", "payload": { ... } }` -> `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`).
- Required `op` handlers: `pts_eval`, `pts_buffer_gap`, `pts_drain_contiguous`, `validate_ws_frame`, `e2ee_generate_identity`, `e2ee_x3dh_initiator`, `e2ee_x3dh_responder`, `e2ee_ratchet_init`, `e2ee_ratchet_encrypt`, `e2ee_ratchet_decrypt`, `safety_number_emojis`, `waveform_encode_5bit`, `waveform_decode_5bit`, `html_to_markdown`, `scan_content_for_injection`.

### 6. Extension Background ↔ UI Surface Port Contract (`browser-extension/src/shared/rpc_types.ts`)
- UI surfaces (`workspace.html`, `sidepanel.html`, `popup.html`, `options.html`) connect via `chrome.runtime.connect({ name: "gpui-ui-surface" })` and `chrome.runtime.sendMessage`.
- Stable `data-testid` hooks exposed across Extension UI for opaque-box E2E accessibility:
  `auth-wizard`, `auth-server-url-input`, `auth-username-input`, `auth-password-input`, `auth-submit-btn`, `nav-rail`, `chat-sidebar`, `chat-search-input`, `create-menu-btn`, `conversation-stage`, `message-bubble`, `thinking-bubble`, `tool-steps-list`, `canonical-composer-input`, `composer-send-btn`, `slash-command-popup`, `context-inspector`, `hermes-studio-workspace`, `settings-router`, `browser-bridge-status-pill`, `browser-policy-select`, `emergency-stop-btn`, `theme-toggle-btn`, `lang-toggle-btn`.

---

## Code Layout

Exclusive write ownership per milestone (concurrent workers MUST NOT write to the same path):

```text
/home/antigravity/
├── PROJECT.md                          # Project Orchestrator global architecture & contracts
├── TEST_INFRA.md                       # E2E Testing Orchestrator test infrastructure index
├── TEST_READY.md                       # E2E Testing Orchestrator completion & coverage signal
├── .local-sysroot/                     # [M1] Optional non-root extracted .deb headers/protoc (XFS, gitignored)
├── e2e_tests/                          # [E2E Track] Opaque-box 4-tier E2E runner, harness & test cases
└── gpui-telegram/                      # Git monorepo cloned from bhrum/gpui-telegram -> pushed to dhutjursch68637-ai/gpui-telegram
    ├── Cargo.toml / Cargo.lock         # [M1 baseline; M2 if adding crate deps after M1 completes]
    ├── .gitignore                      # [M1 baseline; M6 final hygiene audit]
    ├── scripts/setup_sysroot.sh        # [M1] Repeatable non-root build env helper
    ├── crates/
    │   ├── gpui_telegram_core/         # [M1] WASM portability feature gate (`host`)
    │   ├── gpui_telegram_proto/        # [M1] `src/browser_contracts.rs` + `host` gate
    │   ├── gpui_telegram_ext_wasm/     # [M1] Standalone `wasm32-unknown-unknown` `cdylib`
    │   ├── gpui_telegram_agent/        # [M2] `BrowserBridgeProvider`, 24-tool `ToolsetId::Browser`, `/browser`
    │   ├── gpui_telegram_server/       # [M2] `routes/browser_bridge.rs`, `server.rs` wiring
    │   ├── gpui_telegram_client/       # [M2] `src/net/api_browser.rs` + `TelegramClient` methods
    │   └── gpui_telegram_desktop/      # [M2] `127.0.0.1:19222` loopback WS bridge + Desktop Browser UI panels
    ├── browser-extension/
    │   ├── package.json / vite.config.ts / tsconfig.json / public/manifest.json  # [M3 baseline; M4 read-only or additive UI assets after M3]
    │   ├── src/wasm/                   # [M3] WASM bridge loader & typed wrappers
    │   ├── src/shared/                 # [M3] Shared RPC, theme tokens, DTO types
    │   ├── src/background/             # [M3] MV3 Service Worker, sync, 24-tool BrowserController, In-Extension Bot, Dual WS Bridges
    │   ├── src/content/                # [M3] `[ref=eN]` DOM/ARIA snapshot & interaction agent + highlight overlay
    │   └── src/ui/ + *.html            # [M4] Full 1:1 `gpui-telegram` UI across `workspace.html`, `sidepanel.html`, `popup.html`, `options.html`
    └── e2e/ + README.md + .github/     # [M5 integration fixes across owned modules; M6 repo docs, CI, E2E vendoring & GitHub push]
```
