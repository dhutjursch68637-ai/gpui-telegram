# GPUI Telegram — Chrome / Chromium Manifest V3 Browser Extension

Full-featured Chrome/Chromium Manifest V3 (`manifest_version: 3`) Browser Extension delivering:

1. **Full Telegram Messenger Workspace (`workspace.html`)** — Dialogs, real-time `/api/v1/ws` PTS sequence sync + gap recovery (`/api/v1/sync/difference`), offline outbox queue, Signal X3DH/Double-Ratchet E2EE via Rust→WASM, and Hermes Bot Studio.
2. **Side-Panel AI Copilot (`sidepanel.html`, `Ctrl+Shift+Y`)** — Context-aware assistant alongside any active webpage with streaming `<think>` blocks, `🔧 Steps` tool traces, `/browser` slash commands, and OpenAI / Magpie / Anthropic / Gemini / LocalHermes providers.
3. **24-Tool Live `BrowserController` & `[ref=eN]` DOM/ARIA Agent (`background.js` + `content.js`)** — Tab/group orchestration, navigation, `[ref=eN]` interactive element snapshots, WASM HTML-to-Markdown + prompt-injection scanning, React `_valueTracker`-compatible typing, active/background/full-page screenshots, console/network capture, HttpOnly-redacted cookie management, and sanitized downloads.
4. **Dual Outbound JSON-RPC 2.0 WebSocket Bridges** — Connects simultaneously to:
   - **Server Browser Relay**: `ws://<server>/api/v1/browser/ws?token=<jwt>&client=extension` (paired with `/api/v1/browser/*` REST endpoints).
   - **Desktop Loopback Bridge**: `ws://127.0.0.1:19222/ext/ws?token=<pairing_token>` (paired with `gpui_telegram_desktop` CDP-compatible loopback server).
5. **Security Policy & Emergency Kill-Switch (`Alt+Shift+S`)** — Enforces `BrowserRunPolicy` (`always_allow_authorized`, `allow_read_only`, `ask_every_time`, `disabled`), domain allowlists/blocklists, automatic prompt-injection escalation, inline/Studio user approval cards, and instant `Alt+Shift+S` emergency stop.

## Building WASM + Extension Bundle

From the repository root:

```bash
# 1. Build the zero-wasm-bindgen Rust WASM core (target: wasm32-unknown-unknown)
cargo build -p gpui_telegram_ext_wasm --target wasm32-unknown-unknown --release

# 2. Install extension dependencies & build unpacked MV3 bundle into browser-extension/dist/
npm --prefix browser-extension install
npm --prefix browser-extension run typecheck
npm --prefix browser-extension run build
```

## Loading in Chrome / Chromium

- **Interactive**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `browser-extension/dist`.
- **Headless / CLI**: Pass `--disable-extensions-except=/abs/path/to/browser-extension/dist --load-extension=/abs/path/to/browser-extension/dist`.

## Canonical 24-Tool `BrowserController` Surface

`browser_status`, `browser_list_tabs` (`browser_tabs`), `browser_get_active_tab`, `browser_open_tab`, `browser_activate_tab` (`browser_switch_tab`), `browser_close_tab`, `browser_group_tabs`, `browser_navigate`, `browser_reload`, `browser_back_forward`, `browser_snapshot`, `browser_extract_markdown`, `browser_query_selector`, `browser_click`, `browser_hover`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_scroll`, `browser_wait_for`, `browser_screenshot`, `browser_evaluate`, `browser_get_console_logs`, `browser_get_network_log`, `browser_manage_cookies`, `browser_download_url`.
