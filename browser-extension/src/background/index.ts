/**
 * Chrome / Chromium Manifest V3 Background Service Worker Entrypoint (`dist/background.js`).
 * Registers all `chrome.*` event listeners synchronously at top-level evaluation, initializes
 * WASM (`gpui_telegram_ext_wasm.wasm`) + IndexedDB (`gpui_telegram_ext_db`), and coordinates:
 * - F6: `ExtensionSyncEngine` (`/api/v1/ws`, PTS sync, gap recovery, offline outbox, unread badge)
 * - F7: `BrowserController` (all 24 canonical `browser_*` tools + aliases)
 * - F8: `DualBridgeManager` (Server Relay + Desktop Loopback) & `ExtensionBotRunner`
 * - F9: `BrowserPolicyEngine` (`BrowserRunPolicy`, domain ACLs, approvals, `Alt+Shift+S` kill-switch)
 */

import {
  BrowserRpcError,
  KEEPALIVE_ALARM_NAME,
  LOCAL_COPILOT_CHAT_ID,
  UI_PORT_NAME,
  clampBubbleRadiusPx,
  clampFontSizePx,
  normalizeExtensionLocale,
  normalizeThemePreset,
  type BrowserRunPolicy,
  type ExtensionRuntimeStateSummary,
  type SwToUiEvent,
} from '../shared/rpc_types';
import { ensureWasmLoaded, invokeWasm, isWasmReady } from '../wasm/wasm_bridge';
import { BrowserController } from './browser_controller';
import {
  dbClearChatMessages,
  dbDeleteDialog,
  dbDeleteMessages,
  dbGetAllDialogs,
  dbGetMessagesForChat,
  dbSetChatUnreadCount,
  logoutActiveAccountInStorage,
  openExtDb,
  readNormalizedStorageConfig,
  switchActiveAccountInStorage,
  upsertAccountSessionInStorage,
} from './db';
import { ExtensionBotRunner } from './ext_bot_runner';
import { BrowserPolicyEngine } from './policy_engine';
import { ExtensionSyncEngine } from './sync_engine';
import { DualBridgeManager } from './ws_bridges';

const uiPorts = new Set<chrome.runtime.Port>();

function broadcastToUi(event: SwToUiEvent): void {
  for (const port of [...uiPorts]) {
    try {
      port.postMessage(event);
    } catch {
      uiPorts.delete(port);
    }
  }
}

const policyEngine = new BrowserPolicyEngine(broadcastToUi);

let bridgesRef: DualBridgeManager | null = null;
const browserController = new BrowserController(policyEngine, () => {
  if (!bridgesRef) {
    return { serverRelayConnected: false, desktopBridgeConnected: false };
  }
  const st = bridgesRef.getStatus();
  return {
    serverRelayConnected: st.serverRelayConnected,
    desktopBridgeConnected: st.desktopBridgeConnected,
  };
});

const dualBridges = new DualBridgeManager(browserController, policyEngine, () => {
  void emitStateSnapshot();
});
bridgesRef = dualBridges;

const syncEngine = new ExtensionSyncEngine(broadcastToUi);
const botRunner = new ExtensionBotRunner(browserController, policyEngine, broadcastToUi);

async function buildRuntimeStateSummary(): Promise<ExtensionRuntimeStateSummary> {
  const cfg = await readNormalizedStorageConfig();
  const dialogs = await dbGetAllDialogs().catch(() => []);
  const tabs = await browserController.listTabsSummary().catch(() => []);
  const bridgeSt = dualBridges.getStatus();
  const unreadTotal = dialogs
    .filter((d) => !d.is_archived)
    .reduce((acc, d) => acc + (d.unread_count || 0), 0);

  return {
    authenticated: Boolean(cfg.serverUrl && cfg.token),
    server_url: cfg.serverUrl,
    user_id: cfg.userId,
    username: cfg.username,
    extension_id: chrome.runtime.id,
    run_policy: policyEngine.getRunPolicy(),
    emergency_stopped: policyEngine.isEmergencyStopped(),
    allowed_domains: policyEngine.getAllowedDomains(),
    blocked_domains: policyEngine.getBlockedDomains(),
    server_ws_connected: syncEngine.isConnected(),
    server_relay_connected: bridgeSt.serverRelayConnected,
    desktop_bridge_connected: bridgeSt.desktopBridgeConnected,
    desktop_ws_url: bridgeSt.desktopWsUrl,
    active_tabs_count: tabs.length,
    unread_total: unreadTotal,
    bot_streaming: botRunner.isStreaming(),
    active_bot_run_id: botRunner.getActiveRunId(),
    theme_mode: cfg.themeMode,
    theme_preset: cfg.themePreset,
    font_size: cfg.fontSize,
    bubble_radius: cfg.bubbleRadius,
    accent_color: cfg.accentColor,
    language_code: cfg.languageCode,
    passcode_enabled: cfg.passcodeEnabled,
    passcode_locked: cfg.passcodeLocked,
    accounts: cfg.accounts,
    active_account_id: cfg.activeAccountId,
    wasm_ready: isWasmReady(),
  };
}

async function emitStateSnapshot(targetPort?: chrome.runtime.Port): Promise<void> {
  const [state, dialogs] = await Promise.all([
    buildRuntimeStateSummary(),
    dbGetAllDialogs().catch(() => []),
  ]);
  const pendingApprovals = policyEngine.getCombinedPendingApprovals();
  const payload: SwToUiEvent = {
    type: 'state_snapshot',
    state,
    dialogs,
    pending_approvals: pendingApprovals,
  };
  if (targetPort) {
    try {
      targetPort.postMessage(payload);
    } catch {
      uiPorts.delete(targetPort);
    }
  } else {
    broadcastToUi(payload);
  }
}

async function configureChromeSurfacesAndAlarm(): Promise<void> {
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: 0.5,
    });
  } catch {
    // ignore
  }

  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({
        path: 'sidepanel.html',
        enabled: true,
      });
    }
  } catch {
    // ignore
  }
}

let rehydrateInFlight: Promise<void> | null = null;

async function rehydrateAll(forceBridgeReconnect = false): Promise<void> {
  if (rehydrateInFlight && !forceBridgeReconnect) {
    return rehydrateInFlight;
  }

  const run = (async () => {
    await Promise.all([openExtDb(), ensureWasmLoaded(), configureChromeSurfacesAndAlarm()]);
    await policyEngine.reloadFromStorage();
    await Promise.all([
      dualBridges.reloadAndConnect(forceBridgeReconnect),
      syncEngine.rehydrateAndSync(),
    ]);
    await emitStateSnapshot();
  })();

  rehydrateInFlight = run;
  try {
    await run;
  } finally {
    if (rehydrateInFlight === run) {
      rehydrateInFlight = null;
    }
  }
}

// ============================================================================
// Top-Level Synchronous MV3 Chrome Event Listeners
// ============================================================================

browserController.installChromeListeners();
dualBridges.installTabSyncListeners();

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus?.create({
        id: 'gpui-open-workspace',
        title: 'Open GPUI Telegram Workspace',
        contexts: ['action', 'page'],
      });
    });
  } catch {
    // ignore
  }
  void rehydrateAll(false);
});

chrome.runtime.onStartup.addListener(() => {
  void rehydrateAll(false);
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'gpui-open-workspace') {
      chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html'), active: true });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    void rehydrateAll(false);
    void dualBridges.syncTabsImmediate();
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'emergency-stop-bot' || command === 'emergency-stop') {
    void policyEngine.triggerEmergencyStop('Keyboard shortcut Alt+Shift+S').then(() => {
      void emitStateSnapshot();
    });
    return;
  }
  if (command === 'open-side-panel') {
    chrome.windows.getLastFocused((win) => {
      if (win?.id && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
      }
    });
  }
});

let storageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // Immediate policy sync without waiting for debounce when run_policy / domains change
  if (
    changes.run_policy ||
    changes.browser_run_policy ||
    changes.allowed_domains ||
    changes.blocked_domains ||
    changes.emergency_stopped
  ) {
    void policyEngine.reloadFromStorage().then(() => {
      void dualBridges.syncTabsImmediate();
      void emitStateSnapshot();
    });
  }

  if (changes.accounts || changes.active_account_id) {
    void emitStateSnapshot();
  }

  if (storageDebounceTimer) {
    clearTimeout(storageDebounceTimer);
  }
  storageDebounceTimer = setTimeout(() => {
    storageDebounceTimer = null;
    const bridgeChanged = Boolean(
      changes.bridge_config ||
        changes.desktop_bridge ||
        changes.browser_bridge ||
        changes.pairing_token ||
        changes.desktop_bridge_port ||
        changes.accounts ||
        changes.active_account_id ||
        changes.token ||
        changes.auth_token ||
        changes.server_url,
    );
    void rehydrateAll(bridgeChanged);
  }, 40);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === UI_PORT_NAME || port.name.startsWith('gpui-')) {
    uiPorts.add(port);
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
    });
    port.onMessage.addListener((msg) => {
      void handleUiRpcMessage(msg).then((resp) => {
        if (msg?.request_id) {
          try {
            port.postMessage({ type: 'rpc_response', request_id: msg.request_id, ...resp });
          } catch {
            uiPorts.delete(port);
          }
        }
      });
    });
    void emitStateSnapshot(port);
    void policyEngine.refreshServerPendingCommands();
  }
});

async function handleUiRpcMessage(msg: Record<string, any>): Promise<Record<string, unknown>> {
  const msgType = String(msg?.type ?? '');

  switch (msgType) {
    case '__gpui_e2e_wake': {
      await rehydrateAll(false);
      return { ok: true, awake: true };
    }

    case 'bridge.reconnect': {
      if (msg.bridge_config && typeof msg.bridge_config === 'object') {
        await chrome.storage.local.set({ bridge_config: msg.bridge_config });
      }
      await policyEngine.reloadFromStorage();
      await dualBridges.reloadAndConnect(true);
      await emitStateSnapshot();
      return { ok: true, ...dualBridges.getStatus() };
    }

    case 'ui.get_snapshot': {
      const [state, dialogs] = await Promise.all([
        buildRuntimeStateSummary(),
        dbGetAllDialogs().catch(() => []),
      ]);
      const pending = await policyEngine.refreshServerPendingCommands();
      return {
        ok: true,
        state,
        dialogs,
        pending_approvals: pending,
      };
    }

    case 'ui.sync_dialogs': {
      const dialogs = await syncEngine.syncDialogsAndMissedMessages();
      return { ok: true, dialogs };
    }

    case 'ui.get_messages': {
      const chatId = Number(msg.chat_id ?? LOCAL_COPILOT_CHAT_ID);
      let localMsgs = await dbGetMessagesForChat(chatId, 200);
      if (chatId > 0) {
        if (localMsgs.length === 0) {
          localMsgs = await syncEngine.fetchChatHistory(chatId, 80);
        } else {
          void syncEngine.fetchChatHistory(chatId, 80);
        }
      }
      return { ok: true, chat_id: chatId, messages: localMsgs };
    }

    case 'ui.send_message': {
      const chatId = Number(msg.chat_id ?? LOCAL_COPILOT_CHAT_ID);
      const text = String(msg.text ?? '');
      const surface = String(msg.surface ?? '');

      if (
        chatId === LOCAL_COPILOT_CHAT_ID ||
        msg.use_local_bot === true ||
        (surface === 'sidepanel' && chatId <= 0)
      ) {
        return botRunner.handleUserPrompt({ chatId, text });
      }

      return syncEngine.sendMessageWithOutbox({
        chatId,
        text,
        replyToMessageId: typeof msg.reply_to_message_id === 'number' ? msg.reply_to_message_id : null,
        quoteText: typeof msg.quote_text === 'string' ? msg.quote_text : null,
        topicId: typeof msg.topic_id === 'number' ? msg.topic_id : null,
        content: msg.content && typeof msg.content === 'object' ? msg.content : null,
        mediaId: typeof msg.media_id === 'string' ? msg.media_id : null,
        clientNonce: typeof msg.client_nonce === 'string' ? msg.client_nonce : undefined,
      });
    }

    case 'ui.stop_bot': {
      const cancelled = botRunner.cancelActiveRun('Stopped from UI button');
      await emitStateSnapshot();
      return { ok: true, cancelled };
    }

    case 'ui.set_policy': {
      const nextPolicy = String(msg.policy ?? 'always_allow_authorized') as BrowserRunPolicy;
      await policyEngine.setPolicy(nextPolicy, {
        allowedDomains: Array.isArray(msg.allowed_domains) ? msg.allowed_domains : undefined,
        blockedDomains: Array.isArray(msg.blocked_domains) ? msg.blocked_domains : undefined,
      });
      await dualBridges.syncTabsImmediate();
      await emitStateSnapshot();
      return { ok: true, run_policy: policyEngine.getRunPolicy() };
    }

    case 'ui.emergency_stop': {
      await policyEngine.triggerEmergencyStop(String(msg.reason ?? 'Emergency Stop button clicked'));
      await emitStateSnapshot();
      return { ok: true, emergency_stopped: true, run_policy: 'disabled' };
    }

    case 'ui.approve_command': {
      const res = await policyEngine.resolvePendingCommand({
        commandId: String(msg.command_id ?? ''),
        approved: Boolean(msg.approved),
        rememberForSession: Boolean(msg.remember_for_session),
      });
      await emitStateSnapshot();
      return res;
    }

    case 'ui.mark_read': {
      const chatId = Number(msg.chat_id);
      if (Number.isFinite(chatId)) {
        await syncEngine.markChatRead(
          chatId,
          typeof msg.max_message_id === 'number' ? msg.max_message_id : undefined,
        );
      }
      return { ok: true };
    }

    case 'ui.mark_unread': {
      const chatId = Number(msg.chat_id);
      if (Number.isFinite(chatId)) {
        await dbSetChatUnreadCount(chatId, 1);
        await emitStateSnapshot();
      }
      return { ok: true };
    }

    case 'ui.delete_dialog': {
      const chatId = Number(msg.chat_id);
      if (Number.isFinite(chatId)) {
        await dbDeleteDialog(chatId);
        await emitStateSnapshot();
      }
      return { ok: true };
    }

    case 'ui.clear_chat': {
      const chatId = Number(msg.chat_id);
      if (Number.isFinite(chatId)) {
        await dbClearChatMessages(chatId);
        broadcastToUi({ type: 'messages_updated', chat_id: chatId, messages: [] });
      }
      return { ok: true };
    }

    case 'ui.delete_messages': {
      const chatId = Number(msg.chat_id);
      const ids = Array.isArray(msg.message_ids) ? msg.message_ids.map(Number).filter(Number.isFinite) : [];
      if (Number.isFinite(chatId) && ids.length > 0) {
        await dbDeleteMessages(chatId, ids);
        const remaining = await dbGetMessagesForChat(chatId, 200);
        broadcastToUi({ type: 'messages_updated', chat_id: chatId, messages: remaining });
      }
      return { ok: true };
    }

    case 'ui.login_success': {
      const serverUrl = String(msg.server_url ?? '').trim().replace(/\/+$/, '');
      const token = String(msg.token ?? '').trim();
      const userId = typeof msg.user_id === 'number' ? msg.user_id : null;
      const username = typeof msg.username === 'string' ? msg.username : null;
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      const firstName = typeof msg.first_name === 'string' ? msg.first_name : undefined;

      await upsertAccountSessionInStorage({
        serverUrl,
        token,
        userId,
        username,
        sessionId,
        firstName,
      });
      await rehydrateAll(true);
      return { ok: true };
    }

    case 'ui.switch_account': {
      syncEngine.disconnectWs();
      const switched = await switchActiveAccountInStorage(msg.account_id ?? '');
      if (!switched.ok) {
        return { ok: false, error: switched.error };
      }
      await rehydrateAll(true);
      const dialogs = await dbGetAllDialogs().catch(() => []);
      return { ok: true, account: switched.switchedTo, dialogs };
    }

    case 'ui.logout': {
      syncEngine.disconnectWs();
      const res = await logoutActiveAccountInStorage(
        msg.account_id !== undefined ? msg.account_id : null,
      );
      await rehydrateAll(true);
      return { ok: true, remaining_account: res.remainingAccount };
    }

    case 'ui.set_preferences': {
      const patch: Record<string, unknown> = {};
      if (msg.theme_preset !== undefined || msg.theme !== undefined) {
        const preset = normalizeThemePreset(
          msg.theme_preset ?? msg.theme,
          msg.theme_mode,
        );
        patch.theme_preset = preset;
        patch.theme = preset;
        patch.theme_mode = preset === 'day' || preset === 'classic' ? 'light' : 'dark';
      } else if (msg.theme_mode === 'light' || msg.theme_mode === 'dark') {
        patch.theme_mode = msg.theme_mode;
        patch.theme_preset = msg.theme_mode === 'light' ? 'day' : 'night';
        patch.theme = patch.theme_preset;
      }
      if (msg.language_code !== undefined || msg.lang !== undefined) {
        const loc = normalizeExtensionLocale(msg.language_code ?? msg.lang);
        patch.language_code = loc;
        patch.lang = loc;
      }
      if (msg.font_size !== undefined) {
        patch.font_size = clampFontSizePx(msg.font_size, 13);
      }
      if (msg.bubble_radius !== undefined) {
        patch.bubble_radius = clampBubbleRadiusPx(msg.bubble_radius, 17);
      }
      if (typeof msg.accent_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.accent_color)) {
        patch.accent_color = msg.accent_color;
      }
      if (typeof msg.passcode_enabled === 'boolean') {
        patch.passcode_enabled = msg.passcode_enabled;
      }
      if (msg.passcode_hash !== undefined) {
        patch.passcode_hash = msg.passcode_hash;
      }
      if (typeof msg.passcode_locked === 'boolean') {
        patch.passcode_locked = msg.passcode_locked;
      }
      if (Object.keys(patch).length > 0) {
        await chrome.storage.local.set(patch);
      }
      await emitStateSnapshot();
      return { ok: true };
    }

    case 'ui.invoke_wasm': {
      try {
        await ensureWasmLoaded();
        const out = await invokeWasm(
          String(msg.op ?? ''),
          msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
        );
        return out as unknown as Record<string, unknown>;
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    }

    case 'ui.invoke_browser_tool': {
      try {
        const result = await browserController.invokeTool(
          String(msg.tool ?? ''),
          msg.arguments && typeof msg.arguments === 'object' ? msg.arguments : {},
          { bypassInteractiveApproval: msg.bypass_approval === true },
        );
        return { ok: true, result };
      } catch (err: any) {
        if (err instanceof BrowserRpcError) {
          return {
            ok: false,
            code: err.code,
            error_code: err.errorCode,
            error: err.message,
          };
        }
        return {
          ok: false,
          code: -32603,
          error_code: 'INTERNAL_ERROR',
          error: String(err?.message ?? err),
        };
      }
    }

    default:
      return { ok: false, error: `Unknown message type "${msgType}"` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'gpui_dom_agent') {
    return undefined;
  }
  handleUiRpcMessage(msg)
    .then((res) => sendResponse(res))
    .catch((err) =>
      sendResponse({
        ok: false,
        error: String(err?.message ?? err),
      }),
    );
  return true;
});

// ============================================================================
// Global Service Worker Inspection & Rehydration Hooks (E2E & Diagnostics)
// ============================================================================

const swGlobal = globalThis as unknown as Record<string, unknown>;

swGlobal.__gpuiRehydrate = async () => {
  await rehydrateAll(true);
  return buildRuntimeStateSummary();
};
swGlobal.__rehydrateSession = swGlobal.__gpuiRehydrate;
swGlobal.initBackgroundServices = swGlobal.__gpuiRehydrate;

swGlobal.reconnectBridges = async () => {
  await policyEngine.reloadFromStorage();
  await dualBridges.reloadAndConnect(true);
  await emitStateSnapshot();
  return dualBridges.getStatus();
};

swGlobal.__gpuiSyncPolicy = async (nextPolicy?: BrowserRunPolicy) => {
  if (typeof nextPolicy === 'string' && nextPolicy.trim()) {
    await policyEngine.setPolicy(nextPolicy);
  } else {
    await policyEngine.reloadFromStorage();
  }
  await dualBridges.syncTabsImmediate();
  await emitStateSnapshot();
  return { ok: true, run_policy: policyEngine.getRunPolicy() };
};
swGlobal.setBrowserRunPolicy = swGlobal.__gpuiSyncPolicy;

swGlobal.syncTabsToBridges = async () => {
  await dualBridges.syncTabsImmediate();
  return { ok: true };
};

swGlobal.__gpuiInvokeBrowserTool = async (
  tool: string,
  args: Record<string, unknown> = {},
  bypassApproval = false,
) => {
  return browserController.invokeTool(tool, args, {
    bypassInteractiveApproval: bypassApproval,
  });
};

swGlobal.__gpuiTriggerEmergencyStop = async (reason?: string) => {
  await policyEngine.triggerEmergencyStop(reason ?? 'SW hook emergency stop');
  await emitStateSnapshot();
  return { ok: true, emergency_stopped: true, run_policy: policyEngine.getRunPolicy() };
};

swGlobal.__gpuiInvokeWasm = invokeWasm;

// Kick off initial background bootstrap immediately on Service Worker evaluation
void rehydrateAll(false);
