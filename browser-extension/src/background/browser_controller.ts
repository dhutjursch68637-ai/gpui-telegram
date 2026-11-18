/**
 * 24-Row (26 Canonical Tools + Aliases) Live Chrome MV3 `BrowserController`.
 * Executes real `chrome.tabs`, `chrome.tabGroups`, `chrome.scripting`, `chrome.debugger` (CDP 1.3),
 * `chrome.cookies`, and `chrome.downloads` operations paired with `content.js` (`gpui_dom_agent`)
 * and `gpui_telegram_ext_wasm.wasm`.
 */

import {
  BRIDGE_ERROR_CODES,
  BrowserRpcError,
  CANONICAL_BROWSER_TOOLS,
  isRestrictedNavigationUrl,
  isRestrictedTabUrl,
  normalizeBrowserToolName,
  sanitizeDownloadFilename,
  type BrowserElementRefDto,
  type BrowserLinkDto,
  type BrowserSnapshotDto,
  type BrowserTabDto,
} from '../shared/rpc_types';
import { wasmHtmlToMarkdown } from '../wasm/wasm_bridge';
import type { BrowserPolicyEngine } from './policy_engine';

export interface ConsoleLogEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
  timestamp_ms: number;
}

export interface NetworkLogEntry {
  request_id: string;
  method: string;
  url: string;
  resource_type?: string;
  status?: number;
  mime_type?: string;
  error_text?: string;
  timestamp_ms: number;
}

interface TabTelemetryState {
  debuggerOwnedByTelemetry: boolean;
  consoleLogs: ConsoleLogEntry[];
  networkLogs: Map<string, NetworkLogEntry>;
  networkOrder: string[];
}

interface PendingOpHandle {
  tabId?: number;
  reject: (err: BrowserRpcError) => void;
}

const MAX_RING_BUFFER = 500;

function mapChromeTabToDto(tab: chrome.tabs.Tab): BrowserTabDto {
  const url = tab.url || tab.pendingUrl || 'about:blank';
  const controllable = typeof tab.id === 'number' && tab.id > 0 && !isRestrictedTabUrl(url);
  return {
    tab_id: tab.id ?? -1,
    window_id: tab.windowId ?? -1,
    index: tab.index ?? 0,
    url,
    title: tab.title ?? '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    status: tab.status,
    fav_icon_url: tab.favIconUrl,
    group_id: typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : null,
    controllable,
  };
}

function parseImageDimensionsFromBase64(
  b64: string,
  format: 'png' | 'jpeg',
): { width: number; height: number } {
  try {
    const raw = atob(b64.slice(0, 4096));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    if (
      format === 'png' &&
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      const view = new DataView(bytes.buffer);
      return {
        width: view.getUint32(16, false),
        height: view.getUint32(20, false),
      };
    }
    if (format === 'jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const segLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        if (marker >= 0xc0 && marker <= 0xc3) {
          const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
          const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
          return { width, height };
        }
        if (segLen < 2) break;
        offset += 2 + segLen;
      }
    }
  } catch {
    // fallback dimensions below
  }
  return { width: 1280, height: 800 };
}

export class BrowserController {
  private readonly policy: BrowserPolicyEngine;
  private readonly bridgeStatusProvider: () => {
    serverRelayConnected: boolean;
    desktopBridgeConnected: boolean;
  };

  /** Maps `tabId -> Map<ref, frameId>` from the most recent `browser_snapshot`. */
  private tabRefFrames = new Map<number, Map<string, number>>();

  /** Per-tab CDP console & network ring buffers. */
  private telemetry = new Map<number, TabTelemetryState>();

  /** Active cancellable operations (aborted immediately on tab close or emergency stop). */
  private activeOps = new Set<PendingOpHandle>();

  constructor(
    policy: BrowserPolicyEngine,
    bridgeStatusProvider: () => {
      serverRelayConnected: boolean;
      desktopBridgeConnected: boolean;
    },
  ) {
    this.policy = policy;
    this.bridgeStatusProvider = bridgeStatusProvider;

    this.policy.onEmergencyStop(async (reason) => {
      await this.abortAllForEmergencyStop(reason);
    });
  }

  public installChromeListeners(): void {
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabRefFrames.delete(tabId);
      this.telemetry.delete(tabId);
      this.policy.clearTabState(tabId);

      // Immediately reject any in-flight wait_for / navigate on the closed tab (-32005)
      for (const op of [...this.activeOps]) {
        if (op.tabId === tabId) {
          this.activeOps.delete(op);
          op.reject(
            new BrowserRpcError(
              BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
              'TAB_NOT_FOUND',
              `Tab ${tabId} was closed during active browser operation`,
              { tab_id: tabId },
            ),
          );
        }
      }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.url) {
        this.policy.clearTabState(tabId, changeInfo.url);
      }
    });

    if (chrome.debugger?.onEvent) {
      chrome.debugger.onEvent.addListener((source, method, params: any) => {
        if (typeof source.tabId !== 'number') return;
        this.handleDebuggerEvent(source.tabId, method, params);
      });
    }

    if (chrome.debugger?.onDetach) {
      chrome.debugger.onDetach.addListener((source) => {
        if (typeof source.tabId === 'number') {
          const st = this.telemetry.get(source.tabId);
          if (st) st.debuggerOwnedByTelemetry = false;
        }
      });
    }
  }

  private async abortAllForEmergencyStop(reason: string): Promise<void> {
    for (const op of [...this.activeOps]) {
      this.activeOps.delete(op);
      op.reject(
        new BrowserRpcError(
          BRIDGE_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
          `Aborted by emergency stop: ${reason}`,
        ),
      );
    }

    // Detach ALL attached chrome.debugger sessions immediately
    if (chrome.debugger?.getTargets) {
      try {
        const targets = await chrome.debugger.getTargets();
        for (const t of targets) {
          if (t.attached) {
            const debugee: chrome.debugger.Debuggee =
              typeof t.tabId === 'number' ? { tabId: t.tabId } : { targetId: t.id };
            await chrome.debugger.detach(debugee).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    }

    for (const st of this.telemetry.values()) {
      st.debuggerOwnedByTelemetry = false;
    }

    // Clear highlight overlays across all open tabs
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id === 'number' && !isRestrictedTabUrl(tab.url)) {
          chrome.tabs
            .sendMessage(tab.id, { target: 'gpui_dom_agent', action: 'clear_highlights' })
            .catch(() => {});
        }
      }
    } catch {
      // ignore
    }
  }

  public async listTabsSummary(): Promise<BrowserTabDto[]> {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => typeof t.id === 'number' && t.id > 0)
      .map(mapChromeTabToDto);
  }

  /**
   * Executes a canonical browser tool with full `BrowserRunPolicy`, domain ACL,
   * restricted-URL, and prompt-injection escalation checks.
   */
  public async invokeTool(
    rawToolName: string,
    rawArgs: Record<string, unknown> = {},
    context?: {
      botUserId?: number;
      botUsername?: string;
      chatId?: number | null;
      preApprovedByCaller?: boolean;
      timeoutMs?: number;
      bypassInteractiveApproval?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const tool = normalizeBrowserToolName(rawToolName);
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

    const isKnown =
      (CANONICAL_BROWSER_TOOLS as readonly string[]).includes(tool) || tool === 'browser_cdp_send';
    if (!isKnown) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.METHOD_NOT_FOUND,
        'UNKNOWN_TOOL',
        `Unsupported browser tool "${rawToolName}"`,
      );
    }

    // Pre-resolve target tab metadata if this tool operates on a tab so domain ACL & injection escalation know the URL/tabId
    let preTab: chrome.tabs.Tab | null = null;
    const toolsWithoutExistingTab = new Set([
      'browser_status',
      'browser_list_tabs',
      'browser_open_tab',
      'browser_group_tabs',
      'browser_manage_cookies',
      'browser_download_url',
    ]);

    if (!toolsWithoutExistingTab.has(tool)) {
      if (args.tab_id !== undefined && args.tab_id !== null) {
        preTab = await this.getTabOrThrow(Number(args.tab_id));
      } else if (tool !== 'browser_get_active_tab') {
        preTab = await this.resolveDefaultControllableTab();
      }
    }

    // Determine URL to check against domain allowlist/blocklist:
    // Note: for `browser_navigate`, check destination `args.url` (navigating AWAY from an unrestricted/restricted tab to an allowed URL is checked by destination!)
    const domainCheckUrl =
      tool === 'browser_navigate' || tool === 'browser_open_tab'
        ? typeof args.url === 'string'
          ? args.url
          : null
        : preTab?.url ?? (typeof args.url === 'string' ? args.url : null);

    await this.policy.authorizeExecution({
      tool,
      args,
      targetUrl: domainCheckUrl,
      targetTabId: preTab?.id,
      botUserId: context?.botUserId,
      botUsername: context?.botUsername,
      chatId: context?.chatId,
      preApprovedByCaller: context?.preApprovedByCaller,
      timeoutMs: context?.timeoutMs ?? (typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined),
      bypassInteractiveApproval: context?.bypassInteractiveApproval,
    });

    switch (tool) {
      case 'browser_status':
        return this.toolStatus();
      case 'browser_list_tabs':
        return this.toolListTabs(args);
      case 'browser_get_active_tab':
        return this.toolGetActiveTab();
      case 'browser_open_tab':
        return this.toolOpenTab(args);
      case 'browser_activate_tab':
        return this.toolActivateTab(args);
      case 'browser_close_tab':
        return this.toolCloseTab(args);
      case 'browser_group_tabs':
        return this.toolGroupTabs(args);
      case 'browser_navigate':
        return this.toolNavigate(args, preTab);
      case 'browser_reload':
        return this.toolReload(args, preTab);
      case 'browser_back_forward':
        return this.toolBackForward(args, preTab);
      case 'browser_snapshot':
        return this.toolSnapshot(args, preTab);
      case 'browser_extract_markdown':
        return this.toolExtractMarkdown(args, preTab);
      case 'browser_query_selector':
        return this.toolQuerySelector(args, preTab);
      case 'browser_click':
        return this.toolClick(args, preTab);
      case 'browser_hover':
        return this.toolHover(args, preTab);
      case 'browser_type':
        return this.toolType(args, preTab);
      case 'browser_press_key':
        return this.toolPressKey(args, preTab);
      case 'browser_select_option':
        return this.toolSelectOption(args, preTab);
      case 'browser_scroll':
        return this.toolScroll(args, preTab);
      case 'browser_wait_for':
        return this.toolWaitFor(args, preTab);
      case 'browser_screenshot':
        return this.toolScreenshot(args, preTab);
      case 'browser_evaluate':
        return this.toolEvaluate(args, preTab);
      case 'browser_get_console_logs':
        return this.toolGetConsoleLogs(args, preTab);
      case 'browser_get_network_log':
        return this.toolGetNetworkLog(args, preTab);
      case 'browser_manage_cookies':
        return this.toolManageCookies(args);
      case 'browser_download_url':
        return this.toolDownloadUrl(args);
      case 'browser_cdp_send':
        return this.toolCdpSend(args, preTab);
      default:
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.METHOD_NOT_FOUND,
          'UNKNOWN_TOOL',
          `Unsupported browser tool "${tool}"`,
        );
    }
  }

  private async getTabOrThrow(tabId: number): Promise<chrome.tabs.Tab> {
    if (!Number.isFinite(tabId) || tabId <= 0) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
        `Invalid tab_id: ${String(tabId)}`,
      );
    }
    try {
      const tab = await chrome.tabs.get(Math.floor(tabId));
      if (!tab || typeof tab.id !== 'number') {
        throw new Error('Tab missing');
      }
      return tab;
    } catch {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
        `Tab ${tabId} not found`,
        { tab_id: tabId },
      );
    }
  }

  private async resolveDefaultControllableTab(): Promise<chrome.tabs.Tab> {
    const activeInLastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const candidate = activeInLastFocused.find((t) => !isRestrictedTabUrl(t.url));
    if (candidate) return candidate;

    const allTabs = await chrome.tabs.query({});
    const anyControllable =
      allTabs.find((t) => t.active && !isRestrictedTabUrl(t.url)) ??
      allTabs.find((t) => !isRestrictedTabUrl(t.url)) ??
      activeInLastFocused[0] ??
      allTabs[0];

    if (!anyControllable || typeof anyControllable.id !== 'number') {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
        'No active browser tab available',
      );
    }
    return anyControllable;
  }

  private assertTabControllable(tab: chrome.tabs.Tab): number {
    const tabId = tab.id;
    if (typeof tabId !== 'number' || tabId <= 0) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
        'Tab has no valid numeric tab_id',
      );
    }
    const url = tab.url || tab.pendingUrl || '';
    if (isRestrictedTabUrl(url)) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
        `Cannot control restricted URL "${url}" on tab ${tabId}`,
        { tab_id: tabId, url },
      );
    }
    return tabId;
  }

  private runCancellable<T>(
    tabId: number | undefined,
    executor: (signal: { aborted: () => boolean }) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle: PendingOpHandle = {
        tabId,
        reject: (err) => {
          if (settled) return;
          settled = true;
          this.activeOps.delete(handle);
          reject(err);
        },
      };
      this.activeOps.add(handle);

      executor({ aborted: () => settled })
        .then((val) => {
          if (settled) return;
          settled = true;
          this.activeOps.delete(handle);
          resolve(val);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          this.activeOps.delete(handle);
          reject(err);
        });
    });
  }

  private async ensureContentScriptInTab(tabId: number, frameId = 0): Promise<void> {
    try {
      const pong = await chrome.tabs.sendMessage(
        tabId,
        { target: 'gpui_dom_agent', action: 'ping' },
        { frameId },
      );
      if (pong?.ok) return;
    } catch {
      // Not injected yet in this frame — inject dynamically via scripting API
    }

    try {
      await chrome.scripting.executeScript({
        target: frameId === 0 ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
        files: ['content.js'],
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/cannot access|chrome:\/\/|chrome-extension:\/\/|extensions gallery/i.test(msg)) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.RESTRICTED_URL,
          'RESTRICTED_URL',
          `Cannot inject content script into restricted page: ${msg}`,
          { tab_id: tabId },
        );
      }
      const stillAlive = await chrome.tabs.get(tabId).catch(() => null);
      if (!stillAlive) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
          'TAB_NOT_FOUND',
          `Tab ${tabId} closed during content script injection`,
          { tab_id: tabId },
        );
      }
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        `Content script injection failed on tab ${tabId}: ${msg}`,
      );
    }
  }

  private async sendDomAgentCommand(
    tabId: number,
    action: string,
    args: Record<string, unknown> = {},
    frameId = 0,
  ): Promise<Record<string, any>> {
    await this.ensureContentScriptInTab(tabId, frameId);
    let res: Record<string, any>;
    try {
      res = await chrome.tabs.sendMessage(
        tabId,
        { target: 'gpui_dom_agent', action, args },
        { frameId },
      );
    } catch (err: any) {
      const alive = await chrome.tabs.get(tabId).catch(() => null);
      if (!alive) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
          'TAB_NOT_FOUND',
          `Tab ${tabId} closed during ${action}`,
          { tab_id: tabId },
        );
      }
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        `Failed messaging content script on tab ${tabId} (frame ${frameId}): ${String(err?.message ?? err)}`,
      );
    }

    if (!res || typeof res !== 'object') {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        `Empty response from content script for ${action}`,
      );
    }

    if (res.ok === false) {
      throw new BrowserRpcError(
        typeof res.code === 'number' ? res.code : BRIDGE_ERROR_CODES.ELEMENT_NOT_FOUND,
        (res.error_code as any) || 'ELEMENT_NOT_FOUND',
        String(res.error ?? `${action} failed`),
      );
    }

    return res;
  }

  private async discoverTabFrameIds(tabId: number): Promise<number[]> {
    try {
      const probes = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => window.location.href,
      });
      const ids = probes
        .filter((p) => typeof p.frameId === 'number' && !isRestrictedTabUrl(String(p.result ?? '')))
        .map((p) => p.frameId);
      const unique = [...new Set([0, ...ids])];
      return unique.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
    } catch {
      return [0];
    }
  }

  /**
   * Dispatches a DOM action to the appropriate frame:
   * - If `args.ref` is specified, routes strictly to the frame recorded during `browser_snapshot`.
   * - Otherwise tries main frame `0` first, and if `ELEMENT_NOT_FOUND`, tries child iframes!
   */
  private async sendDomActionAcrossFrames(
    tabId: number,
    action: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    if (typeof args.ref === 'string' && args.ref.trim()) {
      const cleanRef = args.ref.trim().replace(/^\[?ref=/i, '').replace(/\]$/, '');
      const frameMap = this.tabRefFrames.get(tabId);
      const targetFrameId = frameMap?.get(cleanRef) ?? 0;
      return this.sendDomAgentCommand(tabId, action, { ...args, ref: cleanRef }, targetFrameId);
    }

    try {
      return await this.sendDomAgentCommand(tabId, action, args, 0);
    } catch (err) {
      if (!(err instanceof BrowserRpcError) || err.code !== BRIDGE_ERROR_CODES.ELEMENT_NOT_FOUND) {
        throw err;
      }
      const frames = await this.discoverTabFrameIds(tabId);
      for (const fid of frames) {
        if (fid === 0) continue;
        try {
          return await this.sendDomAgentCommand(tabId, action, args, fid);
        } catch (subErr) {
          if (subErr instanceof BrowserRpcError && subErr.code === BRIDGE_ERROR_CODES.INVALID_PARAMS) {
            throw subErr;
          }
        }
      }
      throw err;
    }
  }

  private async waitForTabComplete(
    tabId: number,
    timeoutMs = 15_000,
    waitUntil: 'complete' | 'interactive' | 'none' = 'complete',
  ): Promise<chrome.tabs.Tab> {
    if (waitUntil === 'none') {
      return this.getTabOrThrow(tabId);
    }

    return this.runCancellable(tabId, async (sig) => {
      const deadline = Date.now() + Math.max(100, timeoutMs);
      while (!sig.aborted()) {
        const tab = await this.getTabOrThrow(tabId);
        if (tab.status === 'complete') {
          return tab;
        }
        if (waitUntil === 'interactive' && tab.url && tab.url !== 'about:blank') {
          return tab;
        }
        if (Date.now() >= deadline) {
          throw new BrowserRpcError(
            BRIDGE_ERROR_CODES.NAVIGATION_TIMEOUT,
            'NAVIGATION_TIMEOUT',
            `Navigation timed out after ${timeoutMs}ms on tab ${tabId} (url=${tab.pendingUrl || tab.url || ''})`,
            { tab_id: tabId, timeout_ms: timeoutMs },
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
        `Navigation cancelled on tab ${tabId}`,
      );
    });
  }

  // =========================================================================
  // Tool Implementations (#1 – #26)
  // =========================================================================

  private async toolStatus(): Promise<Record<string, unknown>> {
    const tabs = await this.listTabsSummary();
    const bridges = this.bridgeStatusProvider();
    return {
      ok: true,
      connected: true,
      extension_connected: true,
      extension_id: chrome.runtime.id,
      server_relay_connected: bridges.serverRelayConnected,
      desktop_bridge_connected: bridges.desktopBridgeConnected,
      run_policy: this.policy.getRunPolicy(),
      emergency_stopped: this.policy.isEmergencyStopped(),
      active_tabs: tabs.length,
      controllable_tabs: tabs.filter((t) => t.controllable).length,
      tools_count: CANONICAL_BROWSER_TOOLS.length,
    };
  }

  private async toolListTabs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const queryInfo: chrome.tabs.QueryInfo = {};
    if (typeof args.window_id === 'number') {
      queryInfo.windowId = args.window_id;
    } else if (args.current_window_only === true) {
      queryInfo.lastFocusedWindow = true;
    }
    const rawTabs = await chrome.tabs.query(queryInfo);
    const tabs = rawTabs
      .filter((t) => typeof t.id === 'number' && t.id > 0)
      .map(mapChromeTabToDto);
    return {
      ok: true,
      count: tabs.length,
      tabs,
    };
  }

  private async toolGetActiveTab(): Promise<Record<string, unknown>> {
    const tab = await this.resolveDefaultControllableTab();
    const dto = mapChromeTabToDto(tab);
    return {
      ok: true,
      tab_id: dto.tab_id,
      tab: dto,
    };
  }

  private async toolOpenTab(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(args.url ?? '').trim();
    if (isRestrictedNavigationUrl(url)) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
        `Forbidden URL scheme in browser_open_tab: "${url}"`,
        { url },
      );
    }

    const active = args.active !== false;
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 15_000;
    const created = await chrome.tabs.create({ url, active });
    if (!created || typeof created.id !== 'number') {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        'chrome.tabs.create returned no tab id',
      );
    }

    let groupId: number | null = null;
    if (args.group_with_bot && chrome.tabs.group) {
      try {
        groupId = await chrome.tabs.group({ tabIds: [created.id] });
        if (chrome.tabGroups?.update) {
          await chrome.tabGroups.update(groupId, { title: 'Hermes Bot', color: 'cyan' });
        }
      } catch {
        // non-fatal if window type doesn't support tab groups
      }
    }

    const loaded = await this.waitForTabComplete(created.id, timeoutMs, 'complete');
    const dto = mapChromeTabToDto(loaded);
    if (groupId !== null) dto.group_id = groupId;
    return {
      ok: true,
      tab_id: dto.tab_id,
      url: dto.url,
      title: dto.title,
      group_id: dto.group_id,
      tab: dto,
    };
  }

  private async toolActivateTab(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tab = await this.getTabOrThrow(Number(args.tab_id));
    const updated = await chrome.tabs.update(tab.id!, { active: true });
    if (updated?.windowId) {
      await chrome.windows.update(updated.windowId, { focused: true }).catch(() => {});
    }
    const dto = mapChromeTabToDto(updated ?? tab);
    return {
      ok: true,
      tab_id: dto.tab_id,
      tab: dto,
    };
  }

  private async toolCloseTab(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tab = await this.getTabOrThrow(Number(args.tab_id));
    const tabId = tab.id!;
    await chrome.tabs.remove(tabId);
    return {
      ok: true,
      closed_tab_id: tabId,
    };
  }

  private async toolGroupTabs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rawIds = Array.isArray(args.tab_ids) ? args.tab_ids : [];
    const tabIds = rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (tabIds.length === 0) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INVALID_PARAMS,
        'INVALID_PARAMS',
        'browser_group_tabs requires non-empty tab_ids array',
      );
    }

    for (const id of tabIds) {
      await this.getTabOrThrow(id);
    }

    const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
    const validColors = new Set([
      'grey',
      'blue',
      'red',
      'yellow',
      'green',
      'pink',
      'purple',
      'cyan',
      'orange',
    ]);
    const requestedColor = String(args.color ?? 'blue').toLowerCase();
    const color = (validColors.has(requestedColor)
      ? requestedColor
      : 'blue') as chrome.tabGroups.ColorEnum;
    const title = typeof args.title === 'string' ? args.title : 'Agent Tabs';

    if (chrome.tabGroups?.update) {
      await chrome.tabGroups.update(groupId, { title, color });
    }

    return {
      ok: true,
      group_id: groupId,
      title,
      color,
      tab_ids: tabIds,
    };
  }

  private async toolNavigate(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const url = String(args.url ?? '').trim();
    if (isRestrictedNavigationUrl(url)) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
        `Forbidden navigation URL: "${url}"`,
        { url },
      );
    }

    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = tab.id!;
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 15_000;
    const waitUntil =
      args.wait_until === 'none' || args.wait_until === 'interactive'
        ? args.wait_until
        : 'complete';

    this.policy.clearTabState(tabId, url);
    await chrome.tabs.update(tabId, { url });
    const loaded = await this.waitForTabComplete(tabId, timeoutMs, waitUntil);
    const dto = mapChromeTabToDto(loaded);

    return {
      ok: true,
      tab_id: dto.tab_id,
      url: dto.url,
      title: dto.title,
      status: dto.status ?? 'complete',
    };
  }

  private async toolReload(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const bypassCache = Boolean(args.bypass_cache);
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 15_000;

    await chrome.tabs.reload(tabId, { bypassCache });
    const loaded = await this.waitForTabComplete(tabId, timeoutMs, 'complete');
    return {
      ok: true,
      tab_id: tabId,
      url: loaded.url ?? tab.url ?? '',
      title: loaded.title ?? '',
    };
  }

  private async toolBackForward(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const direction = String(args.direction ?? 'back').toLowerCase();
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 10_000;

    if (direction === 'forward') {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.goBack(tabId);
    }

    await new Promise((r) => setTimeout(r, 60));
    const loaded = await this.waitForTabComplete(tabId, timeoutMs, 'complete');
    return {
      ok: true,
      tab_id: tabId,
      direction,
      url: loaded.url ?? '',
      title: loaded.title ?? '',
    };
  }

  private async toolSnapshot(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<BrowserSnapshotDto & Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const maxChars = Math.min(32_000, Math.max(200, Number(args.max_chars ?? 4000)));

    const frameIds = await this.discoverTabFrameIds(tabId);
    const refFrameMap = new Map<string, number>();
    const allElements: BrowserElementRefDto[] = [];
    const allLinks: BrowserLinkDto[] = [];

    let topUrl = tab.url ?? '';
    let topTitle = tab.title ?? '';
    let topViewport = {
      width: 1280,
      height: 800,
      scroll_x: 0,
      scroll_y: 0,
      scroll_width: 1280,
      scroll_height: 800,
    };
    let combinedHtml = '';

    for (const fid of frameIds) {
      if (allElements.length >= 250) break;
      try {
        const remaining = 250 - allElements.length;
        const frameSnap = await this.sendDomAgentCommand(
          tabId,
          'collect_frame_snapshot',
          {
            start_ref_index: allElements.length + 1,
            max_elements: remaining,
            include_html: fid === 0 || combinedHtml.length < 256_000,
          },
          fid,
        );

        if (fid === 0) {
          topUrl = frameSnap.url || topUrl;
          topTitle = frameSnap.title || topTitle;
          if (frameSnap.viewport) topViewport = frameSnap.viewport;
        }

        if (Array.isArray(frameSnap.interactive_elements)) {
          for (const el of frameSnap.interactive_elements as BrowserElementRefDto[]) {
            allElements.push(el);
            refFrameMap.set(el.ref, fid);
          }
        }
        if (Array.isArray(frameSnap.links)) {
          for (const lnk of frameSnap.links as BrowserLinkDto[]) {
            if (allLinks.length < 100) allLinks.push(lnk);
          }
        }
        if (typeof frameSnap.html === 'string' && frameSnap.html) {
          combinedHtml += `\n${frameSnap.html}`;
        }
      } catch (err) {
        if (fid === 0) throw err;
      }
    }

    this.tabRefFrames.set(tabId, refFrameMap);

    const extracted = await wasmHtmlToMarkdown(combinedHtml, {
      includeLinks: true,
      offset: 0,
      maxChars,
      scanInjection: true,
    });

    const injectionScan = extracted.injection_scan ?? {
      flagged: false,
      severity: 'none' as const,
      findings: [],
    };

    this.policy.recordTabInjectionScan(tabId, topUrl, injectionScan);

    const excerpt =
      extracted.markdown.length > maxChars
        ? extracted.markdown.slice(0, maxChars)
        : extracted.markdown;

    return {
      ok: true,
      tab_id: tabId,
      url: topUrl,
      title: topTitle || extracted.title,
      viewport: topViewport,
      interactive_elements: allElements,
      markdown_excerpt: excerpt,
      links: allLinks.length > 0 ? allLinks : extracted.links.slice(0, 100),
      injection_scan: injectionScan,
    };
  }

  private async toolExtractMarkdown(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const offset = Math.max(0, Number(args.offset ?? 0));
    const maxChars = Math.min(64_000, Math.max(100, Number(args.max_chars ?? 12_000)));
    const includeLinks = args.include_links !== false;

    const frameSnap = await this.sendDomAgentCommand(
      tabId,
      'collect_frame_snapshot',
      { start_ref_index: 1, max_elements: 1, include_html: true },
      0,
    );

    const extracted = await wasmHtmlToMarkdown(String(frameSnap.html ?? ''), {
      includeLinks,
      offset,
      maxChars,
      scanInjection: true,
    });

    const injectionScan = extracted.injection_scan ?? {
      flagged: false,
      severity: 'none' as const,
      findings: [],
    };
    this.policy.recordTabInjectionScan(tabId, String(frameSnap.url || tab.url || ''), injectionScan);

    return {
      ok: true,
      tab_id: tabId,
      url: frameSnap.url || tab.url || '',
      title: frameSnap.title || extracted.title || tab.title || '',
      markdown: extracted.markdown,
      offset,
      max_chars: maxChars,
      total_chars: extracted.total_chars,
      truncated: offset + extracted.markdown.length < extracted.total_chars,
      links: includeLinks ? extracted.links : [],
      injection_scan: injectionScan,
    };
  }

  private async toolQuerySelector(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomAgentCommand(tabId, 'query_selector', args, 0);

    if (res.count === 0) {
      // Check child frames if main frame had zero matches
      const frames = await this.discoverTabFrameIds(tabId);
      for (const fid of frames) {
        if (fid === 0) continue;
        try {
          const childRes = await this.sendDomAgentCommand(tabId, 'query_selector', args, fid);
          if (childRes.count > 0) {
            return { ...childRes, tab_id: tabId };
          }
        } catch {
          // ignore
        }
      }
    }

    return {
      ...res,
      tab_id: tabId,
    };
  }

  private async toolClick(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomActionAcrossFrames(tabId, 'click', args);
    const latestTab = await chrome.tabs.get(tabId).catch(() => tab);
    return {
      ...res,
      tab_id: tabId,
      url_after: latestTab?.url || res.url_after || tab.url || '',
      title_after: latestTab?.title || res.title_after || tab.title || '',
    };
  }

  private async toolHover(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomActionAcrossFrames(tabId, 'hover', args);
    return { ...res, tab_id: tabId };
  }

  private async toolType(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomActionAcrossFrames(tabId, 'type', args);
    return { ...res, tab_id: tabId };
  }

  private async toolPressKey(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomAgentCommand(tabId, 'press_key', args, 0);
    return { ...res, tab_id: tabId };
  }

  private async toolSelectOption(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomActionAcrossFrames(tabId, 'select_option', args);
    return { ...res, tab_id: tabId };
  }

  private async toolScroll(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const res = await this.sendDomActionAcrossFrames(tabId, 'scroll', args);
    return { ...res, tab_id: tabId };
  }

  private async toolWaitFor(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const timeoutMs = Math.min(60_000, Math.max(100, Number(args.timeout_ms ?? 10_000)));
    const startedAt = Date.now();

    return this.runCancellable(tabId, async (sig) => {
      const deadline = startedAt + timeoutMs;
      while (!sig.aborted()) {
        const liveTab = await this.getTabOrThrow(tabId);
        if (isRestrictedTabUrl(liveTab.url)) {
          throw new BrowserRpcError(
            BRIDGE_ERROR_CODES.RESTRICTED_URL,
            'RESTRICTED_URL',
            `Tab ${tabId} navigated to restricted URL "${liveTab.url}"`,
          );
        }

        const frames = await this.discoverTabFrameIds(tabId);
        for (const fid of frames) {
          try {
            const check = await this.sendDomAgentCommand(tabId, 'check_wait_condition', args, fid);
            if (check.matched) {
              return {
                ok: true,
                tab_id: tabId,
                matched: true,
                elapsed_ms: Date.now() - startedAt,
                url: liveTab.url ?? check.url ?? '',
                title: liveTab.title ?? check.title ?? '',
              };
            }
          } catch (err) {
            if (
              err instanceof BrowserRpcError &&
              (err.code === BRIDGE_ERROR_CODES.INVALID_PARAMS ||
                err.code === BRIDGE_ERROR_CODES.TAB_NOT_FOUND ||
                err.code === BRIDGE_ERROR_CODES.POLICY_DISABLED)
            ) {
              throw err;
            }
          }
        }

        if (Date.now() >= deadline) {
          throw new BrowserRpcError(
            BRIDGE_ERROR_CODES.NAVIGATION_TIMEOUT,
            'NAVIGATION_TIMEOUT',
            `browser_wait_for timed out after ${timeoutMs}ms on tab ${tabId} waiting for ${JSON.stringify({
              selector: args.selector,
              text: args.text,
              url_includes: args.url_includes,
              state: args.state,
            })}`,
            { tab_id: tabId, timeout_ms: timeoutMs },
          );
        }

        await new Promise((r) => setTimeout(r, 55));
      }

      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.POLICY_DISABLED,
        'POLICY_DISABLED',
        'browser_wait_for cancelled',
      );
    });
  }

  private async withTemporaryDebugger<T>(
    tabId: number,
    fn: (debuggee: chrome.debugger.Debuggee) => Promise<T>,
  ): Promise<T> {
    const debuggee: chrome.debugger.Debuggee = { tabId };
    const tel = this.telemetry.get(tabId);
    const alreadyOwned = Boolean(tel?.debuggerOwnedByTelemetry);

    let attachedHere = false;
    if (!alreadyOwned) {
      try {
        await chrome.debugger.attach(debuggee, '1.3');
        attachedHere = true;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/already attached/i.test(msg)) {
          // Check if attached by another external client vs our own extension
          const targets = await chrome.debugger.getTargets().catch(() => []);
          const target = targets.find((t) => t.tabId === tabId);
          if (!target?.attached) {
            throw new BrowserRpcError(
              BRIDGE_ERROR_CODES.CDP_ATTACH_FAILED,
              'CDP_ATTACH_FAILED',
              `Failed attaching chrome.debugger to tab ${tabId}: ${msg}`,
              { tab_id: tabId },
            );
          }
          // Try sending a lightweight command; if another external debugger owns it, Chrome rejects sendCommand
          try {
            await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
              expression: '1',
              returnByValue: true,
            });
          } catch (probeErr: any) {
            throw new BrowserRpcError(
              BRIDGE_ERROR_CODES.CDP_ATTACH_FAILED,
              'CDP_ATTACH_FAILED',
              `CDP debugger busy / already attached by external client on tab ${tabId}: ${String(probeErr?.message ?? probeErr)}`,
              { tab_id: tabId },
            );
          }
        } else if (/cannot access|chrome:\/\/|restricted/i.test(msg)) {
          throw new BrowserRpcError(
            BRIDGE_ERROR_CODES.RESTRICTED_URL,
            'RESTRICTED_URL',
            `Cannot attach debugger to restricted tab ${tabId}: ${msg}`,
          );
        } else {
          throw new BrowserRpcError(
            BRIDGE_ERROR_CODES.CDP_ATTACH_FAILED,
            'CDP_ATTACH_FAILED',
            `CDP attach failed on tab ${tabId}: ${msg}`,
            { tab_id: tabId },
          );
        }
      }
    }

    try {
      return await fn(debuggee);
    } finally {
      if (attachedHere && !this.telemetry.get(tabId)?.debuggerOwnedByTelemetry) {
        await chrome.debugger.detach(debuggee).catch(() => {});
      }
    }
  }

  private async toolScreenshot(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const format: 'png' | 'jpeg' =
      String(args.format ?? 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const fullPage = Boolean(args.full_page);
    const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : null;

    // Fast infobar-free path for active visible viewport screenshots without full_page/selector clip
    if (tab.active && !fullPage && !selector && typeof tab.windowId === 'number') {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality: format === 'jpeg' ? 85 : undefined,
        });
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx > 0) {
          const b64 = dataUrl.slice(commaIdx + 1);
          const dims = parseImageDimensionsFromBase64(b64, format);
          return {
            ok: true,
            tab_id: tabId,
            url: tab.url ?? '',
            title: tab.title ?? '',
            mime_type: mimeType,
            data_base64: b64,
            width: dims.width,
            height: dims.height,
            artifact: {
              mime_type: mimeType,
              data_base64: b64,
              width: dims.width,
              height: dims.height,
            },
          };
        }
      } catch {
        // Fall through to CDP Page.captureScreenshot (e.g. unfocused headless window)
      }
    }

    // Background tab, full-page, or element-clipped screenshot via CDP Page.captureScreenshot (never switches active tab!)
    let clipRect:
      | { x: number; y: number; width: number; height: number; scale: number }
      | undefined;

    if (selector) {
      const rectRes = await this.sendDomActionAcrossFrames(tabId, 'get_element_rect', { selector });
      clipRect = rectRes.rect;
    }

    const shot = await this.withTemporaryDebugger(tabId, async (debuggee) => {
      await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {});

      const shotParams: Record<string, unknown> = {
        format,
        fromSurface: true,
      };
      if (format === 'jpeg') {
        shotParams.quality = 85;
      }

      if (fullPage && !clipRect) {
        const metrics = (await chrome.debugger.sendCommand(
          debuggee,
          'Page.getLayoutMetrics',
        )) as Record<string, any>;
        const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
        const fullW = Math.min(8192, Math.max(320, Math.ceil(Number(contentSize?.width ?? 1280))));
        const fullH = Math.min(16384, Math.max(240, Math.ceil(Number(contentSize?.height ?? 1600))));
        shotParams.captureBeyondViewport = true;
        shotParams.clip = { x: 0, y: 0, width: fullW, height: fullH, scale: 1 };
      } else if (clipRect) {
        shotParams.captureBeyondViewport = true;
        shotParams.clip = clipRect;
      }

      const res = (await chrome.debugger.sendCommand(
        debuggee,
        'Page.captureScreenshot',
        shotParams,
      )) as { data?: string };
      return res?.data ?? '';
    });

    if (!shot) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        `Empty screenshot buffer returned for tab ${tabId}`,
      );
    }

    const dims = parseImageDimensionsFromBase64(shot, format);
    return {
      ok: true,
      tab_id: tabId,
      url: tab.url ?? '',
      title: tab.title ?? '',
      mime_type: mimeType,
      data_base64: shot,
      width: dims.width,
      height: dims.height,
      artifact: {
        mime_type: mimeType,
        data_base64: shot,
        width: dims.width,
        height: dims.height,
      },
    };
  }

  private async toolEvaluate(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const expression = String(args.expression ?? args.script ?? '').trim();
    if (!expression) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INVALID_PARAMS,
        'INVALID_PARAMS',
        'browser_evaluate requires non-empty "expression" string',
      );
    }

    return this.withTemporaryDebugger(tabId, async (debuggee) => {
      const evalRes = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })) as Record<string, any>;

      if (evalRes?.exceptionDetails) {
        const excText =
          evalRes.exceptionDetails?.exception?.description ||
          evalRes.exceptionDetails?.text ||
          'JavaScript evaluation exception';
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.INTERNAL_ERROR,
          'INTERNAL_ERROR',
          `Evaluation error: ${excText}`,
        );
      }

      const value = evalRes?.result ? evalRes.result.value : undefined;
      return {
        ok: true,
        tab_id: tabId,
        value,
        result: value,
        type: String(evalRes?.result?.type ?? typeof value),
      };
    });
  }

  private getOrCreateTelemetryState(tabId: number): TabTelemetryState {
    let st = this.telemetry.get(tabId);
    if (!st) {
      st = {
        debuggerOwnedByTelemetry: false,
        consoleLogs: [],
        networkLogs: new Map(),
        networkOrder: [],
      };
      this.telemetry.set(tabId, st);
    }
    return st;
  }

  private async ensureTelemetryDebuggerAttached(tabId: number): Promise<TabTelemetryState> {
    const st = this.getOrCreateTelemetryState(tabId);
    if (st.debuggerOwnedByTelemetry) {
      return st;
    }

    const debuggee: chrome.debugger.Debuggee = { tabId };
    try {
      await chrome.debugger.attach(debuggee, '1.3');
      st.debuggerOwnedByTelemetry = true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (!/already attached/i.test(msg)) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.CDP_ATTACH_FAILED,
          'CDP_ATTACH_FAILED',
          `Failed attaching telemetry debugger on tab ${tabId}: ${msg}`,
        );
      }
    }

    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable').catch(() => {});
    await chrome.debugger.sendCommand(debuggee, 'Log.enable').catch(() => {});
    await chrome.debugger.sendCommand(debuggee, 'Network.enable').catch(() => {});
    st.debuggerOwnedByTelemetry = true;
    return st;
  }

  private handleDebuggerEvent(tabId: number, method: string, params: Record<string, any>): void {
    const st = this.getOrCreateTelemetryState(tabId);

    if (method === 'Runtime.consoleAPICalled') {
      const parts = Array.isArray(params?.args)
        ? params.args.map((a: any) =>
            a?.value !== undefined ? String(a.value) : String(a?.description ?? ''),
          )
        : [];
      st.consoleLogs.push({
        level: String(params?.type ?? 'log'),
        text: parts.join(' '),
        url: params?.stackTrace?.callFrames?.[0]?.url,
        line: params?.stackTrace?.callFrames?.[0]?.lineNumber,
        timestamp_ms: Date.now(),
      });
      if (st.consoleLogs.length > MAX_RING_BUFFER) {
        st.consoleLogs.splice(0, st.consoleLogs.length - MAX_RING_BUFFER);
      }
      return;
    }

    if (method === 'Log.entryAdded' && params?.entry) {
      st.consoleLogs.push({
        level: String(params.entry.level ?? 'info'),
        text: String(params.entry.text ?? ''),
        url: params.entry.url,
        line: params.entry.lineNumber,
        timestamp_ms: Date.now(),
      });
      if (st.consoleLogs.length > MAX_RING_BUFFER) {
        st.consoleLogs.splice(0, st.consoleLogs.length - MAX_RING_BUFFER);
      }
      return;
    }

    if (method === 'Network.requestWillBeSent' && params?.requestId && params?.request) {
      const reqId = String(params.requestId);
      const entry: NetworkLogEntry = {
        request_id: reqId,
        method: String(params.request.method ?? 'GET'),
        url: String(params.request.url ?? ''),
        resource_type: params.type ? String(params.type) : undefined,
        timestamp_ms: Date.now(),
      };
      if (!st.networkLogs.has(reqId)) {
        st.networkOrder.push(reqId);
      }
      st.networkLogs.set(reqId, entry);
      while (st.networkOrder.length > MAX_RING_BUFFER) {
        const oldest = st.networkOrder.shift();
        if (oldest) st.networkLogs.delete(oldest);
      }
      return;
    }

    if (method === 'Network.responseReceived' && params?.requestId && params?.response) {
      const reqId = String(params.requestId);
      const existing = st.networkLogs.get(reqId) ?? {
        request_id: reqId,
        method: 'GET',
        url: String(params.response.url ?? ''),
        timestamp_ms: Date.now(),
      };
      existing.status = Number(params.response.status ?? 200);
      existing.mime_type = params.response.mimeType ? String(params.response.mimeType) : undefined;
      if (!st.networkLogs.has(reqId)) {
        st.networkOrder.push(reqId);
      }
      st.networkLogs.set(reqId, existing);
      return;
    }

    if (method === 'Network.loadingFailed' && params?.requestId) {
      const reqId = String(params.requestId);
      const existing = st.networkLogs.get(reqId);
      if (existing) {
        existing.error_text = String(params.errorText ?? 'Failed');
      }
    }
  }

  private async toolGetConsoleLogs(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const st = await this.ensureTelemetryDebuggerAttached(tabId);

    const levelFilter = typeof args.level === 'string' ? args.level.toLowerCase() : null;
    const limit = Math.min(MAX_RING_BUFFER, Math.max(1, Number(args.limit ?? 100)));

    let entries = [...st.consoleLogs];
    if (levelFilter && levelFilter !== 'all') {
      entries = entries.filter((e) => e.level.toLowerCase() === levelFilter);
    }
    entries = entries.slice(-limit);

    if (args.clear === true) {
      st.consoleLogs = [];
    }

    return {
      ok: true,
      tab_id: tabId,
      count: entries.length,
      entries,
      logs: entries,
    };
  }

  private async toolGetNetworkLog(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const st = await this.ensureTelemetryDebuggerAttached(tabId);

    // Merge PerformanceResourceTiming entries for requests initiated prior to debugger attach
    try {
      const perf = await this.sendDomAgentCommand(tabId, 'get_performance_resources', {}, 0);
      if (Array.isArray(perf.entries)) {
        const knownUrls = new Set([...st.networkLogs.values()].map((e) => e.url));
        for (const p of perf.entries) {
          if (p?.url && !knownUrls.has(String(p.url))) {
            const synId = `perf-${p.url}`;
            st.networkOrder.push(synId);
            st.networkLogs.set(synId, {
              request_id: synId,
              method: 'GET',
              url: String(p.url),
              resource_type: String(p.initiator_type ?? 'fetch'),
              status: Number(p.status ?? 200),
              timestamp_ms: Number(p.timestamp_ms ?? Date.now()),
            });
          }
        }
      }
    } catch {
      // non-fatal
    }

    const urlFilter = typeof args.url_filter === 'string' ? args.url_filter : null;
    const limit = Math.min(MAX_RING_BUFFER, Math.max(1, Number(args.limit ?? 100)));

    let entries = st.networkOrder
      .map((id) => st.networkLogs.get(id))
      .filter((e): e is NetworkLogEntry => Boolean(e));

    if (urlFilter) {
      entries = entries.filter((e) => e.url.includes(urlFilter));
    }
    entries = entries.slice(-limit);

    if (args.clear === true) {
      st.networkLogs.clear();
      st.networkOrder = [];
    }

    return {
      ok: true,
      tab_id: tabId,
      count: entries.length,
      entries,
      requests: entries,
    };
  }

  private async toolManageCookies(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(args.op ?? args.action ?? 'list').trim().toLowerCase();
    const url = String(args.url ?? '').trim();
    if (!url || isRestrictedNavigationUrl(url)) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
        `Invalid or restricted cookie URL: "${url}"`,
      );
    }

    if (action === 'list' || action === 'get') {
      const rawCookies = await chrome.cookies.getAll({ url });
      const cookies = rawCookies.map((c) => {
        const isHttpOnly = Boolean(c.httpOnly);
        return {
          name: c.name,
          // SECURITY INVARIANT: Never leak HttpOnly cookie values!
          value: isHttpOnly ? '[REDACTED_HTTPONLY]' : c.value,
          domain: c.domain,
          path: c.path,
          secure: Boolean(c.secure),
          http_only: isHttpOnly,
          httpOnly: isHttpOnly,
          redacted: isHttpOnly,
          same_site: c.sameSite,
          expiration_date: c.expirationDate ?? null,
        };
      });
      return {
        ok: true,
        op: 'list',
        count: cookies.length,
        cookies,
      };
    }

    if (action === 'set') {
      const name = String(args.name ?? '').trim();
      if (!name) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.INVALID_PARAMS,
          'INVALID_PARAMS',
          'browser_manage_cookies "set" requires cookie "name"',
        );
      }
      const value = String(args.value ?? '');
      const created = await chrome.cookies.set({
        url,
        name,
        value,
        path: typeof args.path === 'string' ? args.path : '/',
        secure: typeof args.secure === 'boolean' ? args.secure : url.startsWith('https://'),
        httpOnly: Boolean(args.http_only ?? args.httpOnly ?? false),
      });
      return {
        ok: true,
        op: 'set',
        name,
        set: Boolean(created),
      };
    }

    if (action === 'delete' || action === 'remove') {
      const name = String(args.name ?? '').trim();
      if (!name) {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.INVALID_PARAMS,
          'INVALID_PARAMS',
          'browser_manage_cookies "delete" requires cookie "name"',
        );
      }
      const removed = await chrome.cookies.remove({ url, name });
      return {
        ok: true,
        op: 'delete',
        name,
        removed: Boolean(removed),
      };
    }

    throw new BrowserRpcError(
      BRIDGE_ERROR_CODES.INVALID_PARAMS,
      'INVALID_PARAMS',
      `Unsupported browser_manage_cookies op "${action}" (expected list, set, or delete)`,
    );
  }

  private async toolDownloadUrl(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(args.url ?? '').trim();
    if (isRestrictedNavigationUrl(url)) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
        `Forbidden download URL: "${url}"`,
      );
    }

    const sanitizedFilename = sanitizeDownloadFilename(
      typeof args.filename === 'string' ? args.filename : undefined,
    );

    const downloadId = await chrome.downloads.download({
      url,
      filename: sanitizedFilename,
      conflictAction: 'uniquify',
      saveAs: false,
    });

    if (typeof downloadId !== 'number') {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        `chrome.downloads.download failed for "${url}"`,
      );
    }

    return {
      ok: true,
      download_id: downloadId,
      url,
      filename: sanitizedFilename ?? null,
    };
  }

  private async toolCdpSend(
    args: Record<string, unknown>,
    preTab: chrome.tabs.Tab | null,
  ): Promise<Record<string, unknown>> {
    const tab = preTab ?? (await this.resolveDefaultControllableTab());
    const tabId = this.assertTabControllable(tab);
    const method = String(args.method ?? '').trim();
    if (!method) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.INVALID_PARAMS,
        'INVALID_PARAMS',
        'browser_cdp_send requires CDP "method" string',
      );
    }
    const cdpParams =
      args.params && typeof args.params === 'object'
        ? (args.params as Record<string, unknown>)
        : {};

    return this.withTemporaryDebugger(tabId, async (debuggee) => {
      const result = await chrome.debugger.sendCommand(debuggee, method, cdpParams);
      return {
        ok: true,
        tab_id: tabId,
        method,
        result: result ?? {},
      };
    });
  }
}
