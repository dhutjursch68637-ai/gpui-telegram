/**
 * Canonical Shared RPC, Policy, Storage, and UI Port Contracts for the MV3 Browser Extension.
 * Aligns 1:1 with `crates/gpui_telegram_proto/src/browser_contracts.rs` and `PROJECT.md § 4–6`.
 */

export const UI_PORT_NAME = 'gpui-ui-port';
export const KEEPALIVE_ALARM_NAME = 'gpui-keepalive-reconnect';
export const INDEXED_DB_NAME = 'gpui_telegram_ext_db';
export const INDEXED_DB_VERSION = 1;
export const OFFICIAL_BOT_USER_ID = 777000;
export const LOCAL_COPILOT_CHAT_ID = -777000;

export const CANONICAL_TEST_IDS = {
  authWizard: 'auth-wizard',
  authServerUrlInput: 'auth-server-url-input',
  authUsernameInput: 'auth-username-input',
  authPasswordInput: 'auth-password-input',
  authSubmitBtn: 'auth-submit-btn',
  navRail: 'nav-rail',
  chatSidebar: 'chat-sidebar',
  chatSearchInput: 'chat-search-input',
  createMenuBtn: 'create-menu-btn',
  conversationStage: 'conversation-stage',
  messageBubble: 'message-bubble',
  thinkingBubble: 'thinking-bubble',
  toolStepsList: 'tool-steps-list',
  canonicalComposerInput: 'canonical-composer-input',
  composerSendBtn: 'composer-send-btn',
  composerStopBtn: 'composer-stop-btn',
  slashCommandPopup: 'slash-command-popup',
  contextInspector: 'context-inspector',
  hermesStudioWorkspace: 'hermes-studio-workspace',
  settingsRouter: 'settings-router',
  browserBridgeStatusPill: 'browser-bridge-status-pill',
  browserPolicySelect: 'browser-policy-select',
  emergencyStopBtn: 'emergency-stop-btn',
  themeToggleBtn: 'theme-toggle-btn',
  langToggleBtn: 'lang-toggle-btn',
  browserApprovalCard: 'browser-approval-card',
  browserApprovalApproveBtn: 'browser-approval-approve-btn',
  browserApprovalSessionBtn: 'browser-approval-session-btn',
  browserApprovalDenyBtn: 'browser-approval-deny-btn',
  approvalRememberSession: 'approval-remember-session',
} as const;

export const BRIDGE_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  EXTENSION_OFFLINE: -32001,
  USER_DENIED_APPROVAL: -32002,
  POLICY_DISABLED: -32003,
  RESTRICTED_URL: -32004,
  TAB_NOT_FOUND: -32005,
  ELEMENT_NOT_FOUND: -32006,
  NAVIGATION_TIMEOUT: -32007,
  CDP_ATTACH_FAILED: -32008,
} as const;

export type BridgeErrorName =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_TOOL'
  | 'INVALID_PARAMS'
  | 'INVALID_SELECTOR'
  | 'INTERNAL_ERROR'
  | 'EXTENSION_OFFLINE'
  | 'USER_DENIED_APPROVAL'
  | 'POLICY_DISABLED'
  | 'RESTRICTED_URL'
  | 'TAB_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  | 'NAVIGATION_TIMEOUT'
  | 'CDP_ATTACH_FAILED';

export class BrowserRpcError extends Error {
  public readonly code: number;
  public readonly errorCode: BridgeErrorName;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: number,
    errorCode: BridgeErrorName,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserRpcError';
    this.code = code;
    this.errorCode = errorCode;
    this.details = details;
  }

  toJsonRpcError(): { code: number; message: string; data: Record<string, unknown> } {
    return {
      code: this.code,
      message: `${this.errorCode}: ${this.message}`,
      data: {
        error_code: this.errorCode,
        ...(this.details ?? {}),
      },
    };
  }
}

export type BrowserRunPolicy =
  | 'always_allow_authorized'
  | 'allow_read_only'
  | 'ask_every_time'
  | 'disabled';

export type BrowserToolRisk = 'read_only' | 'mutating' | 'high_risk';

export const CANONICAL_BROWSER_TOOLS = [
  'browser_status',
  'browser_list_tabs',
  'browser_get_active_tab',
  'browser_open_tab',
  'browser_activate_tab',
  'browser_close_tab',
  'browser_group_tabs',
  'browser_navigate',
  'browser_reload',
  'browser_back_forward',
  'browser_snapshot',
  'browser_extract_markdown',
  'browser_query_selector',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_scroll',
  'browser_wait_for',
  'browser_screenshot',
  'browser_evaluate',
  'browser_get_console_logs',
  'browser_get_network_log',
  'browser_manage_cookies',
  'browser_download_url',
] as const;

export type CanonicalBrowserToolName = (typeof CANONICAL_BROWSER_TOOLS)[number];

export function normalizeBrowserToolName(rawName: string): string {
  const trimmed = String(rawName || '').trim();
  switch (trimmed) {
    case 'browser_tabs':
      return 'browser_list_tabs';
    case 'browser_switch_tab':
      return 'browser_activate_tab';
    default:
      return trimmed;
  }
}

export function classifyBrowserToolRisk(
  toolName: string,
  args?: Record<string, unknown>,
): BrowserToolRisk {
  const canonical = normalizeBrowserToolName(toolName);
  switch (canonical) {
    case 'browser_status':
    case 'browser_list_tabs':
    case 'browser_get_active_tab':
    case 'browser_snapshot':
    case 'browser_extract_markdown':
    case 'browser_query_selector':
    case 'browser_wait_for':
    case 'browser_screenshot':
    case 'browser_get_console_logs':
    case 'browser_get_network_log':
      return 'read_only';

    case 'browser_open_tab':
    case 'browser_activate_tab':
    case 'browser_close_tab':
    case 'browser_group_tabs':
    case 'browser_navigate':
    case 'browser_reload':
    case 'browser_back_forward':
    case 'browser_click':
    case 'browser_hover':
    case 'browser_type':
    case 'browser_press_key':
    case 'browser_select_option':
    case 'browser_scroll':
      return 'mutating';

    case 'browser_manage_cookies': {
      const action = String(args?.action ?? 'list').toLowerCase();
      if (action === 'list' || action === 'get') {
        // Still sensitive cookie inspection, treat as high_risk under ask_every_time/allow_read_only
        // unless read-only list is allowed; per browser_contracts.rs `browser_manage_cookies` is HighRisk.
        return 'high_risk';
      }
      return 'high_risk';
    }

    case 'browser_evaluate':
    case 'browser_download_url':
    case 'browser_cdp_send':
      return 'high_risk';

    default:
      return 'high_risk';
  }
}

export function normalizeRunPolicy(raw: unknown): BrowserRunPolicy {
  const s = String(raw ?? '').trim().toLowerCase();
  switch (s) {
    case 'always_allow_authorized':
    case 'alwaysallowauthorized':
    case 'allow_all':
      return 'always_allow_authorized';
    case 'allow_read_only':
    case 'allowreadonly':
    case 'read_only':
      return 'allow_read_only';
    case 'ask_every_time':
    case 'askeverytime':
    case 'ask':
      return 'ask_every_time';
    case 'disabled':
    case 'off':
    case 'deny_all':
      return 'disabled';
    default:
      return 'always_allow_authorized';
  }
}

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'chrome-search://',
  'chrome-native://',
  'devtools://',
  'edge://',
  'brave://',
  'vivaldi://',
  'opera://',
  'view-source:',
  'javascript:',
  'data:',
  'vbscript:',
  'file://',
  'filesystem:',
  'blob:chrome-extension://',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
  'https://microsoftedge.microsoft.com/addons',
];

/**
 * Checks whether a target navigation URL is forbidden (`-32004 RESTRICTED_URL`).
 */
export function isRestrictedNavigationUrl(rawUrl: string): boolean {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'about:blank') return false;
  if (lower.startsWith('about:')) return true;
  for (const prefix of RESTRICTED_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol !== 'http:' && parsed.protocol !== 'https:';
  } catch {
    return true;
  }
}

/**
 * Checks whether an existing tab URL allows DOM scripting / debugger / screenshot inspection.
 */
export function isRestrictedTabUrl(rawUrl: string | undefined | null): boolean {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'about:blank') return false;
  if (lower.startsWith('about:')) return true;
  for (const prefix of RESTRICTED_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol !== 'http:' && parsed.protocol !== 'https:';
  } catch {
    return true;
  }
}

export function extractUrlHostname(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function matchesDomainPattern(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase();
  let pat = pattern.trim().toLowerCase();
  if (!pat || !host) return false;
  if (pat === '*') return true;
  // Strip protocol/path/port if caller passed URL-like domain pattern
  if (pat.includes('://')) {
    try {
      pat = new URL(pat).hostname.toLowerCase();
    } catch {
      // keep raw
    }
  } else if (pat.includes(':')) {
    pat = pat.split(':')[0] ?? pat;
  }
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pat;
}

export function isUrlAllowedByDomains(
  rawUrl: string | undefined | null,
  allowedDomains: string[],
  blockedDomains: string[],
): { allowed: boolean; reason?: string } {
  if (!rawUrl || rawUrl === 'about:blank') {
    return { allowed: true };
  }
  const hostname = extractUrlHostname(rawUrl);
  if (!hostname) {
    return { allowed: true };
  }
  const cleanBlocked = blockedDomains.map((d) => d.trim()).filter(Boolean);
  for (const pat of cleanBlocked) {
    if (matchesDomainPattern(hostname, pat)) {
      return {
        allowed: false,
        reason: `Host "${hostname}" is blocked by blocked_domains pattern "${pat}"`,
      };
    }
  }
  const cleanAllowed = allowedDomains.map((d) => d.trim()).filter(Boolean);
  if (cleanAllowed.length > 0) {
    const matched = cleanAllowed.some((pat) => matchesDomainPattern(hostname, pat));
    if (!matched) {
      return {
        allowed: false,
        reason: `Host "${hostname}" is not in allowed_domains (${cleanAllowed.join(', ')})`,
      };
    }
  }
  return { allowed: true };
}

export function sanitizeDownloadFilename(rawFilename?: string | null): string | undefined {
  if (!rawFilename || typeof rawFilename !== 'string') return undefined;
  const normalized = rawFilename.replace(/\\/g, '/').trim();
  const parts = normalized
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  if (parts.length === 0) return undefined;
  const basename = parts[parts.length - 1]!.replace(/[\x00-\x1f<>:"|?*]/g, '_');
  return basename.length > 0 ? basename : undefined;
}

export interface BrowserTabDto {
  tab_id: number;
  window_id: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  audible?: boolean;
  muted?: boolean;
  status?: string;
  fav_icon_url?: string;
  group_id?: number | null;
  controllable: boolean;
}

export interface BrowserBoundingRectDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BrowserElementRefDto {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  visible: boolean;
  selector: string;
  rect: BrowserBoundingRectDto;
}

export interface BrowserLinkDto {
  text: string;
  href: string;
}

export interface BrowserInjectionFindingDto {
  rule_id: string;
  severity: 'none' | 'low' | 'medium' | 'high';
  excerpt: string;
}

export interface BrowserInjectionScanDto {
  flagged: boolean;
  severity: 'none' | 'low' | 'medium' | 'high';
  findings: BrowserInjectionFindingDto[];
}

export interface BrowserSnapshotDto {
  ok: true;
  tab_id: number;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scroll_x: number;
    scroll_y: number;
    scroll_width: number;
    scroll_height: number;
  };
  interactive_elements: BrowserElementRefDto[];
  markdown_excerpt: string;
  links: BrowserLinkDto[];
  injection_scan: BrowserInjectionScanDto;
}

export interface PendingBrowserCommandDto {
  command_id: string;
  bot_user_id: number;
  bot_username?: string;
  chat_id?: number | null;
  tool: string;
  risk: BrowserToolRisk;
  arguments: Record<string, unknown>;
  target_url?: string | null;
  reason: string;
  injection_flagged?: boolean;
  created_at_ms: number;
  expires_at_ms: number;
  source?: 'server' | 'local';
}

export interface StoredDialogDto {
  chat_id: number;
  chat_type: string;
  title: string;
  peer_user_id?: number;
  peer_username?: string;
  is_bot?: boolean;
  unread_count: number;
  pts: number;
  last_message_id?: number;
  last_message_preview?: string;
  updated_at_ms: number;
}

export interface StoredReactionDto {
  emoji: string;
  count: number;
  me?: boolean;
}

export interface StoredToolStepDto {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result_summary?: string;
  screenshot_data_url?: string;
}

export interface StoredMessageDto {
  chat_id: number;
  message_id: number;
  sender_id: number;
  sender_username?: string;
  text: string;
  pts?: number;
  client_nonce?: string;
  created_at_ms: number;
  edited_at_ms?: number | null;
  reply_to_message_id?: number | null;
  reactions?: StoredReactionDto[];
  thinking?: string;
  tool_steps?: StoredToolStepDto[];
  media_data_url?: string;
  pending_outbox?: boolean;
  is_error?: boolean;
}

export interface OutboxRecordDto {
  client_nonce: string;
  chat_id: number;
  text: string;
  reply_to_message_id?: number | null;
  created_at_ms: number;
  attempts: number;
}

export interface ExtensionRuntimeStateSummary {
  authenticated: boolean;
  server_url: string;
  user_id: number | null;
  username: string | null;
  extension_id: string;
  run_policy: BrowserRunPolicy;
  emergency_stopped: boolean;
  allowed_domains: string[];
  blocked_domains: string[];
  server_ws_connected: boolean;
  server_relay_connected: boolean;
  desktop_bridge_connected: boolean;
  desktop_ws_url: string | null;
  active_tabs_count: number;
  unread_total: number;
  bot_streaming: boolean;
  active_bot_run_id: string | null;
  theme_mode: 'dark' | 'light';
  language_code: 'en' | 'ru';
  wasm_ready: boolean;
}

export type SwToUiEvent =
  | { type: 'state_snapshot'; state: ExtensionRuntimeStateSummary; dialogs: StoredDialogDto[]; pending_approvals: PendingBrowserCommandDto[] }
  | { type: 'dialogs_updated'; dialogs: StoredDialogDto[]; unread_total: number }
  | { type: 'messages_updated'; chat_id: number; messages: StoredMessageDto[] }
  | { type: 'pending_approvals_updated'; pending_approvals: PendingBrowserCommandDto[] }
  | { type: 'auth_expired'; reason: string }
  | { type: 'bot_stream_delta'; chat_id: number; message: StoredMessageDto; streaming: boolean }
  | { type: 'emergency_stopped'; reason: string };

export const BROWSER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'browser_status',
      description: 'Inspect browser extension connectivity, active run policy, and controllable tabs count.',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: 'List open browser tabs with tab_id, title, url, active state, and controllability.',
      parameters: {
        type: 'object',
        properties: { window_id: { type: 'integer' } },
        additionalProperties: true,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_active_tab',
      description: 'Return the active tab in the current window.',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open_tab',
      description: 'Open a new browser tab at an http/https URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          active: { type: 'boolean' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_activate_tab',
      description: 'Focus/activate a browser tab by tab_id.',
      parameters: {
        type: 'object',
        properties: { tab_id: { type: 'integer' } },
        required: ['tab_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_tab',
      description: 'Close a browser tab by tab_id.',
      parameters: {
        type: 'object',
        properties: { tab_id: { type: 'integer' } },
        required: ['tab_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_group_tabs',
      description: 'Group tabs into a named/colored Chrome tab group.',
      parameters: {
        type: 'object',
        properties: {
          tab_ids: { type: 'array', items: { type: 'integer' } },
          title: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['tab_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate a tab to a target URL and wait for readiness.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          url: { type: 'string' },
          wait_until: { type: 'string', enum: ['complete', 'interactive', 'none'] },
          timeout_ms: { type: 'integer' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_reload',
      description: 'Reload a browser tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          bypass_cache: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back_forward',
      description: 'Navigate browser history back or forward.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          direction: { type: 'string', enum: ['back', 'forward'] },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Capture structured DOM/ARIA snapshot with [ref=eN] interactive elements, markdown excerpt, links, and prompt-injection scan.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          max_chars: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract_markdown',
      description: 'Extract clean Markdown and links from the page HTML with pagination and prompt-injection scan.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          offset: { type: 'integer' },
          max_chars: { type: 'integer' },
          include_links: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_query_selector',
      description: 'Query elements matching a CSS selector and inspect their text, attributes, and bounding rectangles.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          selector: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element by ref (e.g. "e1"), CSS selector, visible text, or coordinates.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string' },
          double_click: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: 'Hover over an element by ref or CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          ref: { type: 'string' },
          selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input/textarea/contenteditable element by ref or CSS selector (React compatible).',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string' },
          clear_first: { type: 'boolean' },
          submit: { type: 'boolean' },
          press_enter: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Press a keyboard key or shortcut (e.g. "Enter", "Escape", "Control+k").',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string' } },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select_option',
      description: 'Select an option in a <select> dropdown by value or label.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          value: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the viewport (up/down/top/bottom) or scroll an element into view.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          amount_px: { type: 'number' },
          ref: { type: 'string' },
          selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for',
      description: 'Wait for a CSS selector state, text substring, or URL substring.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          selector: { type: 'string' },
          text: { type: 'string' },
          url_includes: { type: 'string' },
          state: { type: 'string', enum: ['visible', 'attached', 'hidden'] },
          timeout_ms: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture a PNG or JPEG screenshot of a tab viewport, full page, or element.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          full_page: { type: 'boolean' },
          selector: { type: 'string' },
          format: { type: 'string', enum: ['png', 'jpeg'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Evaluate a JavaScript expression in the page context and return its JSON result.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          expression: { type: 'string' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_console_logs',
      description: 'Retrieve buffered console logs and page errors for a tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          level: { type: 'string' },
          clear: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_network_log',
      description: 'Retrieve buffered HTTP/fetch/XHR network requests and status codes for a tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'integer' },
          url_filter: { type: 'string' },
          clear: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_manage_cookies',
      description: 'List, set, or delete cookies for a URL (HttpOnly values are always redacted).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'delete'] },
          url: { type: 'string' },
          name: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['action', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_download_url',
      description: 'Download an http/https URL to the browser downloads directory with a sanitized filename.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          filename: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
] as const;
