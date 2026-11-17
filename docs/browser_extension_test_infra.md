# E2E Test Infrastructure (`TEST_INFRA.md`)

## 1. Test Philosophy

1. **Zero-Mock Opaque-Box Verification of the System Under Test (SUT)**:
   - Every E2E test exercises the **real built artifacts** in `/home/antigravity/gpui-telegram` through external user and protocol boundaries — never importing internal source modules or replacing product components with mocks, stubs, or in-memory fakes:
     - **Real Backend Server**: `/home/antigravity/gpui-telegram/target/debug/gpui_telegram_server` running against isolated per-run SQLite WAL & Tantivy data directories under `/home/antigravity/e2e_tests/.e2e-runs/`, accessed via HTTP REST (`/api/v1/*`, `/bot{token}/{method}`) and WebSockets (`/api/v1/ws`, `/api/v1/browser/ws`).
     - **Real Desktop Loopback Bridge**: `/home/antigravity/gpui-telegram/target/debug/gpui_telegram_desktop` (launched in headless bridge mode `--browser-bridge-only` or configured loopback bridge host on `127.0.0.1:${GPUI_BROWSER_BRIDGE_PORT}`), verified over `ws://127.0.0.1:<port>/ext/ws`, `GET /health`, and `GET /json/list`.
     - **Real Unpacked MV3 Extension in Real Chromium 156**: `/home/antigravity/gpui-telegram/browser-extension/dist` (including `assets/gpui_telegram_ext_wasm.wasm`) loaded into **`/usr/lib/chromium/chromium`** (`Chromium 156.0.8078.79`) and driven via CDP (`Page`, `Runtime`, `DOM`, `Input`, `Network`, `Target`) across `workspace.html`, `sidepanel.html`, `popup.html`, `options.html`, and live target web tabs.
   - **External World Boundaries Only**: Only third-party external dependencies outside `gpui-telegram` are served locally inside `/home/antigravity/e2e_tests/`:
     1. **Deterministic OpenAI-Compatible Mock-LLM HTTP Server** (`/v1/models`, `/v1/chat/completions` supporting both JSON & streaming SSE tool-call turns) so `HermesEngine`, `FabushiBotHost`, and `ext_bot_runner` deterministically invoke `browser_*` tools without external cloud API keys.
     2. **Local Multi-Page Fixture Web App Server** serving realistic HTML/JS/CSS/React-like interactive pages (e-commerce storefront, multi-article research portal, dynamic SPA form, cross-origin/same-origin iframe checkout, cookie/download endpoints, console/network telemetry page, and prompt-injection adversarial fixture pages).
2. **Requirement-Driven & Contract-Locked**:
   - All tests derive strictly from `/home/antigravity/.agents/teamwork/ORIGINAL_REQUEST.md` and `/home/antigravity/PROJECT.md` (`F1`–`F16` Feature Inventory + Interface Contracts §1–§6).
   - Default `/home/antigravity/e2e_tests/run_e2e.sh` MUST fail with non-zero exit code whenever any real SUT binary/extension artifact is missing, crashes, or violates any assertion across Tiers 1–4.
3. **Progressive 4-Tier Execution & 2-vCPU Resource Discipline**:
   - Tests are organized into 4 progressive tiers (`--tier 1`, `--tier 2`, `--tier 3`, `--tier 4`) sharing pooled, health-checked Server + Bridge + Chromium 156 sessions per tier suite (with per-test isolated users/tabs/storage state where needed) so all `>= 184` real E2E tests execute rapidly and deterministically on a 2-vCPU Linux VM without exhausting RAM or XFS disk space.
   - Zero files are ever written to `/home/antigravity/gpui-telegram/`, `/tmp`, or `/home/antigravity/.gemini/jetski` (`virtiofs`); all runtime profiles and temporary DBs live strictly under `/home/antigravity/e2e_tests/.e2e-runs/` (`xfs`) or `/dev/shm` and are automatically cleaned up after every run.

---

## 2. Feature Inventory (`F1`–`F16`)

All `N = 16` project features from `PROJECT.md` are covered with `>= 5` happy-path tests in Tier 1 and `>= 5` boundary/corner/negative tests in Tier 2, plus pairwise (Tier 3) and end-to-end workflow (Tier 4) coverage:

| Feature ID | Feature Name | Milestone | Opaque-Box Verification Surface | Tier 1 Min (`>=5`) | Tier 2 Min (`>=5`) | Tier 3 / Tier 4 Coverage |
|---|---|---|---|---|---|---|
| **F1** | Workspace Bootstrap, Non-Root Sysroot & Canonical Browser Wire Contracts | M1 | Built server/bridge/extension artifacts on XFS; 24-tool request/response envelope & JSON-RPC 2.0 wire acceptance over `/api/v1/browser/*` & WS bridges; error code `-32001..-32008` serialization | >= 5 | >= 5 | T3-01, T4-01 |
| **F2** | Shared Rust→WASM Extension Core (`gpui_telegram_ext_wasm`) | M1 | Real `assets/gpui_telegram_ext_wasm.wasm` loaded in Chromium 156 MV3 context (`wasm_alloc`, `wasm_dealloc`, `wasm_invoke_json`) exercising all 15 C-ABI ops: PTS contiguity/gap drain, WS frame validation, X3DH + Double Ratchet E2EE + safety emojis, 5-bit 100-bar waveform codec, `html_to_markdown`, `scan_content_for_injection` | >= 5 | >= 5 | T3-05, T3-06, T4-04 |
| **F3** | Server Browser Control Relay (`/api/v1/browser/*` & `/api/v1/browser/ws`) | M2 | `GET /api/v1/browser/status`, `GET /api/v1/browser/tabs`, `POST /api/v1/browser/exec`, `GET/PUT /api/v1/bots/{bot_id}/browser`, `GET /api/v1/browser/commands/pending`, `POST /api/v1/browser/commands/{id}/approve`, `POST /api/v1/browser/pairing`, `/api/v1/browser/ws` relay wired to both `@telegram_official_bot` (`777000`) & `FabushiBotHost` | >= 5 | >= 5 | T3-01, T3-02, T3-07, T4-02, T4-08 |
| **F4** | Upgraded 24-Tool `ToolsetId::Browser` & `/browser` Command in `gpui_telegram_agent` | M2 | `/api/v1/hermes/toolsets`, `/api/v1/hermes/turns`, `/api/v1/hermes/command` & bot chat turns verifying all 24 `browser_*` tools, Dual-Mode routing (Extension WS Bridge -> Managed/Local CDP fallback via `HERMES_BROWSER_CDP_URL` / `cdp_url`), `/browser` slash subcommands (`status`, `tabs`, `open`, `navigate`, `snapshot`, `cdp`, `on`, `off`), `scan_output` defense | >= 5 | >= 5 | T3-01, T3-03, T3-08, T4-02, T4-05 |
| **F5** | Desktop App Loopback Bridge (`127.0.0.1:19222`) & Desktop Browser Control UI | M2 | Desktop bridge host on `127.0.0.1:${GPUI_BROWSER_BRIDGE_PORT}` (`GET /health`, `GET /json/list`, `ws://127.0.0.1:<port>/ext/ws`), `Host` + `Origin: chrome-extension://` + `pairing_token` validation, `403` rejection on web origins, live tool dispatch to Chromium 156 extension | >= 5 | >= 5 | T3-02, T3-09, T4-02, T4-06 |
| **F6** | MV3 Extension Runtime, Service Worker Lifecycle & Real-Time PTS Sync | M3 | Unpacked `dist/manifest.json` in Chromium 156 (`'wasm-unsafe-eval'` CSP, deterministic dev key, `Ctrl+Shift+Y` & `Alt+Shift+S` commands), SW CDP discovery, `/api/v1/ws` real-time PTS sync & `Ping`/`Pong` keepalive, `chrome.storage.local` + `IndexedDB` (`gpui_telegram_ext_db`) cold-wake hydration, unread badge | >= 5 | >= 5 | T3-05, T3-10, T4-04, T4-07 |
| **F7** | Extension 24-Tool Live Browser Controller & `[ref=eN]` Content-Script Agent | M3 | Live Chromium 156 execution of all 24 `browser_*` tools on fixture pages: tab CRUD & `tabGroups`, `navigate`/`reload`/`back_forward`, `snapshot` `[ref=eN]` interactive map, `extract_markdown`, `query_selector`, `click`, `hover`, React-safe `type` + `submit`, `press_key`, `select_option`, `scroll`, `wait_for`, active & background/full-page `screenshot`, `evaluate`, console/network logs, cookies (HttpOnly redacted) & downloads, highlight overlay | >= 5 | >= 5 | T3-03, T3-04, T3-11, T4-01, T4-03 |
| **F8** | In-Extension AI Bot Runner & Outbound Dual-Bridge WS Clients | M3 | In-Extension `ext_bot_runner` driving multi-step `browser_*` tool-calling turns via Magpie / OpenAI-compatible mock-LLM endpoint & `/browser` commands; simultaneous auto-reconnecting outbound JSON-RPC 2.0 WS bridges to `/api/v1/browser/ws` & `ws://127.0.0.1:<port>/ext/ws` (`bridge.hello` -> `bridge.hello_ack`, `bridge.tabs_sync`, `bridge.ping`/`pong`) | >= 5 | >= 5 | T3-04, T3-09, T4-01, T4-03 |
| **F9** | Browser Control Security, `BrowserRunPolicy` Approval Gates & Kill-Switch | M3 | Enforcement of `AlwaysAllowAuthorized`, `AllowReadOnly`, `AskEveryTime` (inline approval & `-32002` rejection), and `Disabled` (`-32003`); `allowed_domains`/`blocked_domains`; automatic approval escalation on `scan_content_for_injection` hit; `Alt+Shift+S` / `emergency-stop-btn` / `bridge.emergency_stop` aborting ops & detaching debuggers | >= 5 | >= 5 | T3-02, T3-06, T3-12, T4-06, T4-07 |
| **F10** | Extension Multi-Surface Responsive `AppShell`, 4 Themes & Bilingual i18n | M4 | Live DOM/CSS verification in Chromium 156 across `workspace.html` (4-column `52px` + `288px` + stage + `320px`), `sidepanel.html` (`<680px` adaptive + Bot Browser Action bar), `popup.html`, and `options.html`; all 4 `.tdesktop-theme` palettes (`Night`, `Tinted`, `Day`, `Classic`), accent/font/radius customization, `zh-CN`/`en-US` toggle, keyboard shortcuts | >= 5 | >= 5 | T3-13, T3-14, T4-01, T4-04 |
| **F11** | Extension Auth Wizard, Server Selector, Multi-Account & Passcode Lock | M4 | `auth-wizard` in `workspace.html`/`sidepanel.html`: `auth-server-url-input` connectivity check, Password Register/Login, Phone/Email/Alipay/QR/2FA/Passkey wizard steps, Multi-Account Switcher, active session list/revoke, Logout, Passcode Lock Screen | >= 5 | >= 5 | T3-10, T3-13, T4-04 |
| **F12** | Extension Chat Sidebar, Folders, Universal Search & Bot/Group Creation | M4 | `chat-sidebar` dialog list, `Cmd/Ctrl+K` `chat-search-input` (categories + tags), `create-menu-btn` (Create Fabushi AI Bot, `@BotFather` NL bot creation, New Group, New Channel, Add Contact), Stories/Top Peers, Folder tabs + unread badges, Forum Topics, Archive, dialog context menu (Pin/Mute/Read/Archive/Clear/Delete) | >= 5 | >= 5 | T3-07, T3-15, T4-08 |
| **F13** | Extension Conversation Stage, 12 Message Cards, AI Streaming & Composer | M4 | `conversation-stage` rendering all 12 `MessageContent` card types (Text, Media, Voice 5-bit waveform, Album, Location, Poll/Quiz, Service, Call, Story, Invoice, BotKeyboard, GenerativeCard), Markdown & `<pre>` 1-click Copy, `<think>` `thinking-bubble` & `tool-steps-list` + browser screenshot cards, Reactions/Replies/Edits/Pins/Forwards, `canonical-composer-input` (54 slash commands, `@page`/`@tab`/`@url` pills, chunked upload, voice/emoji) | >= 5 | >= 5 | T3-04, T3-11, T3-15, T4-01, T4-03 |
| **F14** | Extension Hermes Studio (7 Tabs), Settings (26 Sections), Inspector, Mini Apps & Calls | M4 | `hermes-studio-workspace` 7 tabs (Tasks/Kanban, Skills, Memory/Soul/Honcho, MCP & Toolsets, Cron/Heartbeat, Sessions, Approvals), `settings-router` 26 sections (`AiProviders`, `Computers`/Browser Bridge, etc.), `context-inspector` (Profile/Members/SharedMedia/Settings + Bot Studio & Browser Policy binding), sandboxed Mini App `<iframe>` (`Telegram.WebApp`), `CallOverlay`/Talk Mode, modal dialogs | >= 5 | >= 5 | T3-07, T3-14, T3-16, T4-05, T4-08 |
| **F15** | Zero-Mock Full-Stack Integration & Adversarial Hardening | M5 | Cross-plane live integration across `gpui_telegram_server` + Desktop Bridge + MV3 Extension (`workspace.html`, `sidepanel.html`, `popup.html`) + In-Extension Bot + Desktop Bot controlling real Chromium 156 tabs simultaneously; crash/disconnect recovery; zero uncaught page/SW errors; concurrency & payload resilience | >= 5 | >= 5 | T3-01..T3-16, T4-01..T4-08 |
| **F16** | Monorepo Packaging, CI Workflow & GitHub Repository Publish | M6 | Read-only pre-push verification of `/home/antigravity/gpui-telegram`: valid git repo & branch state, `.gitignore` hygiene (excluding `target/`, `node_modules/`, `.e2e-runs/`, `.local-sysroot/`, secrets), root & `browser-extension/` `README.md` completeness, `.github/workflows/ci.yml` YAML & job coverage for Rust + WASM + Extension | >= 5 | >= 5 | T3-16, T4-08 |

---

## 3. Test Architecture

### 3.1 Directory Layout (`/home/antigravity/e2e_tests/`)
```text
/home/antigravity/e2e_tests/
├── run_e2e.sh                          # Canonical executable E2E runner (--tier 1..4, --check-harness, full run)
├── package.json                        # Node/TypeScript test dependencies (ws, typescript, tsx/node test or playwright-core)
├── tsconfig.json                       # Strict TypeScript configuration
├── .e2e-runs/                          # Ephemeral per-run XFS profiles, SQLite DBs & logs (auto-cleaned)
└── src/
    ├── runner/
    │   ├── cli.ts                      # Orchestrates --check-harness, --tier <1|2|3|4>, or full Tiers 1->4 execution
    │   └── registry.ts                 # Test case registration, metadata (tier, featureIds), reporting & threshold check
    ├── harness/
    │   ├── env.ts                      # XFS/.dev/shm temp dir allocator, free TCP port finder, cleanup traps
    │   ├── server_proc.ts              # Spawns & health-checks real gpui_telegram_server with isolated DB/data dir
    │   ├── desktop_bridge_proc.ts      # Spawns & health-checks real gpui_telegram_desktop loopback bridge (127.0.0.1:<port>)
    │   ├── chromium_ext.ts             # Spawns /usr/lib/chromium/chromium 156 with unpacked MV3 extension + raw CDP client
    │   ├── telegram_api_client.ts      # Typed opaque-box REST (/api/v1/*, /bot*) + WS (/api/v1/ws, /api/v1/browser/ws) client
    │   └── assertions.ts               # Rich opaque-box assertions (PNG header/dimensions, JSON-RPC error codes, DOM, PTS)
    ├── fixtures/
    │   ├── web_app_server.ts           # Multi-page local HTTP fixture web app (shop, wiki/research, React SPA form, iframe, cookies, downloads, injection)
    │   └── mock_llm_server.ts          # Deterministic OpenAI-compatible (/v1/models, /v1/chat/completions JSON + SSE) tool-call scriptable server
    └── tiers/
        ├── tier1/                      # >= 80 happy-path feature tests (>= 5 per F1..F16)
        ├── tier2/                      # >= 80 boundary, corner & negative tests (>= 5 per F1..F16)
        ├── tier3/                      # >= 16 cross-feature pairwise interaction tests
        └── tier4/                      # >= 8 realistic multi-step end-user scenario tests
```

### 3.2 Runner CLI Contract (`/home/antigravity/e2e_tests/run_e2e.sh`)
- `/home/antigravity/e2e_tests/run_e2e.sh`:
  - Runs the complete 4-tier E2E suite sequentially (Tier 1 -> Tier 2 -> Tier 3 -> Tier 4) against the real built artifacts in `/home/antigravity/gpui-telegram`.
  - Exits `0` **if and only if** all required SUT artifacts exist, all 4 tiers meet minimum test counts (`>= 184` total), and **100% of executed tests pass**.
- `/home/antigravity/e2e_tests/run_e2e.sh --tier <1|2|3|4>`:
  - Runs only the specified tier against the real SUT artifacts and exits `0` iff 100% of tests in that tier pass and meet that tier's coverage threshold.
- `/home/antigravity/e2e_tests/run_e2e.sh --check-harness`:
  - Runs TypeScript typechecking (`tsc --noEmit`), boots and verifies the local Multi-Page Fixture Web App Server and Deterministic Mock-LLM HTTP Server, launches `/usr/lib/chromium/chromium` 156 with a minimal self-check or CDP health check on XFS/`/dev/shm`, validates the registered test inventory (`>= 184` total, `>= 80` Tier 1 with `>= 5` per `F1`–`F16`, `>= 80` Tier 2 with `>= 5` per `F1`–`F16`, `>= 16` Tier 3, `>= 8` Tier 4), cleans up all temporary directories, and exits `0`.

---

## 4. Real-World Application Scenarios (Tier 4 — `>= 8` End-to-End Workflows)

| Scenario ID | Scenario Name | Features Exercised | End-to-End User Workflow |
|---|---|---|---|
| **T4-01** | E-Commerce Search, Filter, Cart & Checkout via In-Extension Bot | F6, F7, F8, F10, F13, F15 | User opens `sidepanel.html`, configures/selects bot, attaches `@page` on fixture storefront, instructs bot to search products, filter by price, select size (`browser_select_option`), add item to cart (`browser_click` via `[ref=eN]`), fill checkout shipping form (`browser_type` React inputs), submit order, and return confirmation number + `browser_screenshot` card in chat. |
| **T4-02** | Multi-Tab Research & Markdown Comparison Synthesis via Desktop Bot | F1, F3, F4, F5, F7, F15 | Desktop/API user prompts `@telegram_official_bot` (`HermesEngine` routed via Desktop Bridge / Server Relay to Extension) to open 3 fixture documentation/pricing tabs (`browser_open_tab` with `group_with_bot: true`), extract structured facts (`browser_snapshot` & `browser_extract_markdown`), close scratch tabs (`browser_close_tab`), and post a synthesized Markdown comparison table streamed over `/api/v1/ws` to both Desktop client and `workspace.html`. |
| **T4-03** | Dynamic SPA Form Automation, Console/Network Audit & Cookie/Download Flow | F7, F8, F13, F15 | Bot navigates to SPA dashboard fixture, logs in (`browser_type` + `submit: true`), waits for async table render (`browser_wait_for`), scrolls to load lazy rows (`browser_scroll`), inspects `browser_get_console_logs` & `browser_get_network_log`, verifies session cookie with HttpOnly redaction (`browser_manage_cookies`), triggers report export (`browser_download_url`), and captures full-page screenshot (`browser_screenshot` `full_page: true`). |
| **T4-04** | Multi-Device Auth, Real-Time PTS Gap Recovery, E2EE Chat & Theme/i18n Sync | F2, F6, F10, F11, F13, F15 | User registers via `auth-wizard` in `workspace.html`, exchanges messages + 5-bit voice note + poll with second user, establishes X3DH/Double-Ratchet E2EE session (verifying safety-number emojis via `gpui_telegram_ext_wasm`), simulates missed updates + SW cold restart, reconciles gap via PTS `get_difference`, and switches `Night` -> `Classic` theme & `zh-CN` -> `en-US` across `workspace.html` and `sidepanel.html`. |
| **T4-05** | Standalone Managed Local CDP Fallback When Extension Disconnects | F3, F4, F14, F15 | User configures Hermes Studio / `/browser` in standalone mode with no Extension WS connected (`HERMES_BROWSER_CDP_URL` pointing to headless Chromium 156); bot seamlessly falls back to Dual-Mode CDP execution (`browser_navigate` -> `browser_snapshot` `[ref=eN]` -> `browser_click` -> `browser_type` -> `browser_screenshot`) and returns live page artifacts. |
| **T4-06** | `AskEveryTime` Policy Approval Gate + Prompt-Injection Escalation Defense | F2, F3, F5, F9, F14, F15 | User sets `BrowserRunPolicy` to `AllowReadOnly` / `AskEveryTime`; bot snapshots a fixture page containing hidden indirect prompt-injection text (`Ignore previous instructions...`); `scan_content_for_injection` flags high severity, escalates mutating `browser_click` to pending approval (`/api/v1/browser/commands/pending` & UI approval dock), rejects unauthorized click (`-32002`) when denied, and executes cleanly once explicitly approved. |
| **T4-07** | Mid-Workflow Emergency Kill-Switch (`Alt+Shift+S` / Popup Stop) & Safe Resume | F6, F7, F8, F9, F10, F15 | While bot is executing a multi-step browser automation sequence with an attached debugger/wait operation, user triggers Emergency Stop (`emergency-stop-btn` in `popup.html` / `bridge.emergency_stop` / `Alt+Shift+S`); active and queued operations immediately abort with `-32003 POLICY_DISABLED`, debugger detaches cleanly, and subsequent re-enabling of `AlwaysAllowAuthorized` restores normal operation. |
| **T4-08** | Custom Fabushi Bot Creation via `@BotFather`, Browser Policy Binding & Mini App Co-Pilot | F3, F12, F13, F14, F15, F16 | User creates a custom companion AI bot via `@BotFather` / `/api/v1/botfather/nl-create` in `workspace.html`, binds its `BotBrowserProfileDto` (`allowed_domains`, `AlwaysAllowAuthorized`) in `ContextInspector` Bot Studio, launches a sandboxed Mini App `<iframe>` (`Telegram.WebApp` SDK interaction), runs the custom Fabushi bot (`FabushiBotHost`) to automate an allowed fixture domain while blocking a disallowed domain, and validates monorepo packaging/CI readiness (`F16`). |

---

## 5. Coverage Thresholds

Given `N = 16` user-facing & architectural features (`F1`–`F16`):

| Tier | Name | Formula | Minimum Required | Target Planned | Pass Requirement |
|---|---|---|---|---|---|
| **Tier 1** | Feature Coverage (Happy Path) | `>= 5 * N` (`>= 5` per feature `F1`–`F16`) | **80** | >= 96 (`6/feature`) | **100%** |
| **Tier 2** | Boundary, Corner & Negative Cases | `>= 5 * N` (`>= 5` per feature `F1`–`F16`) | **80** | >= 96 (`6/feature`) | **100%** |
| **Tier 3** | Cross-Feature Pairwise Combinations | `>= 1 * N` | **16** | >= 18 | **100%** |
| **Tier 4** | Real-World Application Scenarios | `>= 0.5 * N` (min 5) | **8** | >= 8 | **100%** |
| **Total** | **Complete Opaque-Box E2E Suite** | `Tier 1 + Tier 2 + Tier 3 + Tier 4` | **>= 184** | **>= 218** | **100% (`exit 0`)** |
