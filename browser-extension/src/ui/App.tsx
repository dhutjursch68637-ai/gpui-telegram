import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  clampBubbleRadiusPx,
  clampFontSizePx,
  normalizeExtensionLocale,
  normalizeThemePreset,
  type BrowserRunPolicy,
  type DesktopThemePreset,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../shared/rpc_types';
import { ensureWasmLoaded } from '../wasm/wasm_bridge';
import { AuthWizard } from './components/AuthWizard';
import { CallOverlay, TalkModeOverlay } from './components/CallOverlay';
import { ChatSidebar } from './components/ChatSidebar';
import { ContextInspector, type InspectorTabId } from './components/ContextInspector';
import { ConversationStage } from './components/ConversationStage';
import { HermesStudio } from './components/HermesStudio';
import {
  MiniAppHostModal,
  MiniAppPickerModal,
  type ActiveMiniAppSession,
} from './components/MiniAppHost';
import {
  BrowserWorkbenchModal,
  CreatePollModal,
  E2eeVerifyModal,
  ExportDataModal,
  ForwardMessageModal,
  ShortcutsLegendModal,
} from './components/Modals';
import { MainMenuDrawer, NavRail, type WorkspacePrimaryTab } from './components/NavRail';
import { PasscodeLockScreen } from './components/PasscodeLockScreen';
import { PopupView } from './components/PopupView';
import { SettingsRouter, type SettingsSectionId } from './components/SettingsRouter';
import { tr } from './i18n/translations';
import { sendSwRpc, subscribeSwEvents } from './sw_client';
import { applyAppearanceToDocument, getNextThemePreset, sanitizeHexColor } from './theme/palettes';
import './styles.css';

export type ExtensionSurfaceKind = 'workspace' | 'sidepanel' | 'popup' | 'options';

const DEFAULT_STATE: ExtensionRuntimeStateSummary = {
  authenticated: false,
  server_url: 'http://127.0.0.1:8080',
  user_id: null,
  username: null,
  extension_id: '',
  run_policy: 'always_allow_authorized',
  emergency_stopped: false,
  allowed_domains: [],
  blocked_domains: [],
  server_ws_connected: false,
  server_relay_connected: false,
  desktop_bridge_connected: false,
  desktop_ws_url: null,
  active_tabs_count: 0,
  unread_total: 0,
  bot_streaming: false,
  active_bot_run_id: null,
  theme_mode: 'dark',
  theme_preset: 'night',
  font_size: 13,
  bubble_radius: 17,
  accent_color: '#40A7E3',
  language_code: 'en-US',
  passcode_enabled: false,
  passcode_locked: false,
  accounts: [],
  active_account_id: null,
  wasm_ready: false,
};

export function ExtensionApp({ surface }: { surface: ExtensionSurfaceKind }) {
  const [state, setState] = useState<ExtensionRuntimeStateSummary>(DEFAULT_STATE);
  const [dialogs, setDialogs] = useState<StoredDialogDto[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingBrowserCommandDto[]>([]);
  const [messagesByChat, setMessagesByChat] = useState<Record<number, StoredMessageDto[]>>({});

  // Navigation & layout state
  const [activeNavTab, setActiveNavTab] = useState<WorkspacePrimaryTab>(
    surface === 'options' ? 'settings' : 'chats',
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('Overview');
  const [selectedChatId, setSelectedChatId] = useState<number>(
    surface === 'sidepanel' ? LOCAL_COPILOT_CHAT_ID : 0,
  );
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(288);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth >= 980 : true,
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId | undefined>(undefined);
  const [showArchivedDrawer, setShowArchivedDrawer] = useState<boolean>(false);
  const [addingAccountMode, setAddingAccountMode] = useState<boolean>(false);

  // Overlays & Modals
  const [mainMenuOpen, setMainMenuOpen] = useState<boolean>(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState<boolean>(false);
  const [miniAppPickerOpen, setMiniAppPickerOpen] = useState<boolean>(false);
  const [activeMiniApp, setActiveMiniApp] = useState<ActiveMiniAppSession | null>(null);
  const [callOverlay, setCallOverlay] = useState<{ open: boolean; video: boolean }>({
    open: false,
    video: false,
  });
  const [talkModeOpen, setTalkModeOpen] = useState<boolean>(false);
  const [pollModalOpen, setPollModalOpen] = useState<boolean>(false);
  const [forwardMsg, setForwardMsg] = useState<StoredMessageDto | null>(null);
  const [e2eeModalOpen, setE2eeModalOpen] = useState<boolean>(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [browserWorkbenchOpen, setBrowserWorkbenchOpen] = useState<boolean>(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedChatRef = useRef<number>(selectedChatId);
  selectedChatRef.current = selectedChatId;
  const msgFetchSeqRef = useRef<number>(0);

  const themePreset: DesktopThemePreset = useMemo(
    () => normalizeThemePreset(state.theme_preset, state.theme_mode),
    [state.theme_mode, state.theme_preset],
  );
  const locale: ExtensionLocale = useMemo(
    () => normalizeExtensionLocale(state.language_code),
    [state.language_code],
  );
  const fontSize = clampFontSizePx(state.font_size, 13);
  const bubbleRadius = clampBubbleRadiusPx(state.bubble_radius, 17);
  const accentColor = sanitizeHexColor(state.accent_color, '#40A7E3');

  // Synchronously apply `.tdesktop-theme`, `data-theme`, `lang`, and CSS custom properties
  useEffect(() => {
    applyAppearanceToDocument({
      themePreset,
      themeMode: state.theme_mode,
      fontSize,
      bubbleRadius,
      accentColor,
      locale,
    });
  }, [accentColor, bubbleRadius, fontSize, locale, state.theme_mode, themePreset]);

  const refreshAll = useCallback(async () => {
    const snap = await sendSwRpc<{
      ok: boolean;
      state?: ExtensionRuntimeStateSummary;
      dialogs?: StoredDialogDto[];
      pending_approvals?: PendingBrowserCommandDto[];
    }>({ type: 'ui.get_snapshot' });

    if (snap?.state) {
      setState(snap.state);
    }
    if (Array.isArray(snap?.dialogs)) {
      setDialogs(snap.dialogs);
    }
    if (Array.isArray(snap?.pending_approvals)) {
      setPendingApprovals(snap.pending_approvals);
    }
  }, []);

  // Hydrate initial appearance & sidebar width directly from chrome.storage.local for zero-flash startup
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local.get(null).then((raw) => {
        if (!raw) return;
        const app = raw.appearance && typeof raw.appearance === 'object' ? raw.appearance : {};
        const initPreset = normalizeThemePreset(
          raw.theme_preset ?? raw.theme ?? app.theme_preset,
          raw.theme_mode ?? app.theme_mode,
        );
        const initLocale = normalizeExtensionLocale(
          raw.language_code ?? raw.lang ?? raw.locale ?? app.language_code ?? 'en-US',
        );
        const initFont = clampFontSizePx(raw.font_size ?? app.font_size, 13);
        const initRadius = clampBubbleRadiusPx(raw.bubble_radius ?? app.bubble_radius, 17);
        const initAccent = sanitizeHexColor(raw.accent_color ?? app.accent_color, '#40A7E3');
        if (typeof raw.sidebar_width === 'number') {
          setSidebarWidth(Math.min(360, Math.max(240, Math.round(raw.sidebar_width))));
        }
        applyAppearanceToDocument({
          themePreset: initPreset,
          fontSize: initFont,
          bubbleRadius: initRadius,
          accentColor: initAccent,
          locale: initLocale,
        });
      });
    }
  }, []);

  // Subscribe to SW events + direct chrome.storage.onChanged cross-surface sync + viewport responsiveness
  useEffect(() => {
    void ensureWasmLoaded();
    void refreshAll();

    // Support URL hash `#chat=<id>` from popup quick-switcher
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#chat=')) {
      const parsedId = Number(window.location.hash.slice('#chat='.length));
      if (Number.isFinite(parsedId) && parsedId !== 0) {
        setSelectedChatId(parsedId);
      }
    }

    const unsubscribe = subscribeSwEvents((ev) => {
      if (ev.type === 'state_snapshot') {
        setState(ev.state);
        setDialogs(ev.dialogs);
        setPendingApprovals(ev.pending_approvals);
      } else if (ev.type === 'dialogs_updated') {
        setDialogs(ev.dialogs);
        setState((prev) => ({ ...prev, unread_total: ev.unread_total }));
      } else if (ev.type === 'messages_updated') {
        setMessagesByChat((prev) => ({ ...prev, [ev.chat_id]: ev.messages }));
      } else if (ev.type === 'pending_approvals_updated') {
        setPendingApprovals(ev.pending_approvals);
      } else if (ev.type === 'auth_expired') {
        setState((prev) => ({ ...prev, authenticated: false, user_id: null }));
        setDialogs([]);
        setMessagesByChat({});
      } else if (ev.type === 'bot_stream_delta') {
        setState((prev) => ({ ...prev, bot_streaming: ev.streaming }));
        setMessagesByChat((prev) => {
          const existing = prev[ev.chat_id] ?? [];
          const idx = existing.findIndex((m) => m.message_id === ev.message.message_id);
          const next =
            idx >= 0
              ? existing.map((m, i) => (i === idx ? ev.message : m))
              : [...existing, ev.message];
          return { ...prev, [ev.chat_id]: next };
        });
      } else if (ev.type === 'emergency_stopped') {
        setState((prev) => ({
          ...prev,
          emergency_stopped: true,
          run_policy: 'disabled',
          bot_streaming: false,
        }));
        setPendingApprovals([]);
      }
    });

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return;
      if (
        changes.theme_preset ||
        changes.theme ||
        changes.theme_mode ||
        changes.language_code ||
        changes.lang ||
        changes.font_size ||
        changes.bubble_radius ||
        changes.accent_color ||
        changes.run_policy ||
        changes.emergency_stopped ||
        changes.passcode_locked ||
        changes.active_account_id ||
        changes.token
      ) {
        void refreshAll();
      }
    };
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }

    const onResize = () => {
      if (window.innerWidth < 980) {
        setInspectorOpen(false);
      } else if (window.innerWidth >= 1200) {
        setInspectorOpen(true);
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      unsubscribe();
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      }
      window.removeEventListener('resize', onResize);
    };
  }, [refreshAll]);

  // Sync dialogs from server whenever authenticated session becomes active or account switches
  useEffect(() => {
    if (!state.authenticated) return;
    void sendSwRpc<{ ok: boolean; dialogs?: StoredDialogDto[] }>({ type: 'ui.sync_dialogs' }).then(
      (res) => {
        if (Array.isArray(res?.dialogs)) {
          setDialogs(res.dialogs);
        }
      },
    );
  }, [state.authenticated, state.active_account_id]);

  // Auto-select initial dialog
  useEffect(() => {
    if (surface === 'sidepanel' || surface === 'popup') {
      if (selectedChatId === 0) {
        setSelectedChatId(LOCAL_COPILOT_CHAT_ID);
      }
      return;
    }
    if (surface === 'workspace' && selectedChatId === 0) {
      const firstUnarchived = dialogs.find((d) => !d.is_archived);
      if (firstUnarchived) {
        setSelectedChatId(firstUnarchived.chat_id);
      } else if (dialogs.length > 0) {
        setSelectedChatId(dialogs[0]!.chat_id);
      } else {
        setSelectedChatId(LOCAL_COPILOT_CHAT_ID);
      }
    }
  }, [dialogs, selectedChatId, surface]);

  // Monotonic generation-guarded message loader (prevents rapid dialog switch race — T2-F12-06)
  const loadChatMessages = useCallback(async (targetChatId: number) => {
    if (!targetChatId) return;
    const seq = ++msgFetchSeqRef.current;
    const res = await sendSwRpc<{ ok: boolean; chat_id: number; messages: StoredMessageDto[] }>({
      type: 'ui.get_messages',
      chat_id: targetChatId,
    });
    if (seq !== msgFetchSeqRef.current && selectedChatRef.current !== targetChatId) {
      return;
    }
    if (Array.isArray(res?.messages)) {
      setMessagesByChat((prev) => ({ ...prev, [targetChatId]: res.messages }));
    }
  }, []);

  useEffect(() => {
    if (selectedChatId !== 0) {
      void loadChatMessages(selectedChatId);
    }
    if (surface === 'popup') {
      void loadChatMessages(LOCAL_COPILOT_CHAT_ID);
    }
  }, [loadChatMessages, selectedChatId, surface]);

  // Global Keyboard Shortcuts (`Ctrl+K`, `Ctrl+,`, `Ctrl+B`, `Ctrl+I`, `Ctrl+E`, `Ctrl+L`, `Ctrl+/`, `Alt+Shift+S`, layered `Escape`)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          emergency_stopped: true,
          run_policy: 'disabled',
          bot_streaming: false,
        }));
        void sendSwRpc({ type: 'ui.emergency_stop', reason: 'Alt+Shift+S shortcut' });
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'k') {
          e.preventDefault();
          setActiveNavTab('chats');
          window.setTimeout(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          }, 20);
          return;
        }
        if (e.key === ',') {
          e.preventDefault();
          setActiveNavTab('settings');
          return;
        }
        if (k === 'b' && !e.shiftKey) {
          e.preventDefault();
          setSidebarCollapsed((v) => !v);
          return;
        }
        if (k === 'i' && !e.shiftKey) {
          e.preventDefault();
          setInspectorOpen((v) => !v);
          return;
        }
        if (k === 'e' && !e.shiftKey) {
          e.preventDefault();
          setAccountMenuOpen((v) => !v);
          return;
        }
        if (k === 'l' && !e.shiftKey) {
          e.preventDefault();
          if (state.passcode_enabled) {
            void sendSwRpc({ type: 'ui.set_preferences', passcode_locked: true });
          } else {
            setActiveNavTab('settings');
            setSettingsSection('LocalPasscode');
          }
          return;
        }
        if (e.key === '/' || e.key === '?') {
          e.preventDefault();
          setShortcutsModalOpen((v) => !v);
          return;
        }
        if (e.key === '[' && activeNavTab === 'settings') {
          e.preventDefault();
          if (settingsSection !== 'Overview') {
            setSettingsSection('Overview');
          } else {
            setActiveNavTab('chats');
          }
          return;
        }
      }

      // Layered Escape (closes topmost modal/overlay without wiping composer draft — T1-F10-06)
      if (e.key === 'Escape') {
        if (activeMiniApp) {
          e.preventDefault();
          setActiveMiniApp(null);
          return;
        }
        if (miniAppPickerOpen) {
          e.preventDefault();
          setMiniAppPickerOpen(false);
          return;
        }
        if (callOverlay.open) {
          e.preventDefault();
          setCallOverlay({ open: false, video: false });
          return;
        }
        if (talkModeOpen) {
          e.preventDefault();
          setTalkModeOpen(false);
          return;
        }
        if (pollModalOpen) {
          e.preventDefault();
          setPollModalOpen(false);
          return;
        }
        if (forwardMsg) {
          e.preventDefault();
          setForwardMsg(null);
          return;
        }
        if (e2eeModalOpen) {
          e.preventDefault();
          setE2eeModalOpen(false);
          return;
        }
        if (shortcutsModalOpen) {
          e.preventDefault();
          setShortcutsModalOpen(false);
          return;
        }
        if (exportModalOpen) {
          e.preventDefault();
          setExportModalOpen(false);
          return;
        }
        if (browserWorkbenchOpen) {
          e.preventDefault();
          setBrowserWorkbenchOpen(false);
          return;
        }
        if (mainMenuOpen) {
          e.preventDefault();
          setMainMenuOpen(false);
          return;
        }
        if (accountMenuOpen) {
          e.preventDefault();
          setAccountMenuOpen(false);
          return;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    accountMenuOpen,
    activeMiniApp,
    activeNavTab,
    browserWorkbenchOpen,
    callOverlay.open,
    e2eeModalOpen,
    exportModalOpen,
    forwardMsg,
    mainMenuOpen,
    miniAppPickerOpen,
    pollModalOpen,
    settingsSection,
    shortcutsModalOpen,
    state.passcode_enabled,
    talkModeOpen,
  ]);

  // Preference & Bridge Handlers
  const handlePolicyChange = async (nextPolicy: BrowserRunPolicy) => {
    setState((prev) => ({
      ...prev,
      run_policy: nextPolicy,
      emergency_stopped: nextPolicy === 'disabled' ? prev.emergency_stopped : false,
    }));
    await sendSwRpc({ type: 'ui.set_policy', policy: nextPolicy });
  };

  const handleEmergencyStop = async () => {
    setState((prev) => ({
      ...prev,
      emergency_stopped: true,
      run_policy: 'disabled',
      bot_streaming: false,
    }));
    await sendSwRpc({ type: 'ui.emergency_stop', reason: 'UI emergency-stop-btn' });
  };

  const handleApprovalDecision = async (
    commandId: string,
    approved: boolean,
    rememberForSession: boolean,
  ) => {
    setPendingApprovals((prev) => prev.filter((c) => c.command_id !== commandId));
    await sendSwRpc({
      type: 'ui.approve_command',
      command_id: commandId,
      approved,
      remember_for_session: rememberForSession,
    });
  };

  const handleSelectTheme = async (nextPreset: DesktopThemePreset) => {
    setState((prev) => ({
      ...prev,
      theme_preset: nextPreset,
      theme_mode: nextPreset === 'day' || nextPreset === 'classic' ? 'light' : 'dark',
    }));
    await sendSwRpc({ type: 'ui.set_preferences', theme_preset: nextPreset });
  };

  const handleCycleTheme = () => {
    void handleSelectTheme(getNextThemePreset(themePreset));
  };

  const handleSelectLocale = async (nextLocale: ExtensionLocale) => {
    setState((prev) => ({ ...prev, language_code: nextLocale }));
    await sendSwRpc({ type: 'ui.set_preferences', language_code: nextLocale });
  };

  const handleToggleLocale = () => {
    void handleSelectLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN');
  };

  const handleSwitchAccount = async (accountId: number | string) => {
    setAccountMenuOpen(false);
    setMessagesByChat({});
    setSelectedChatId(0);
    await sendSwRpc({ type: 'ui.switch_account', account_id: accountId });
    await refreshAll();
  };

  const handleLogoutAccount = async (accountId?: number | string) => {
    setAccountMenuOpen(false);
    setMessagesByChat({});
    setSelectedChatId(0);
    await sendSwRpc({
      type: 'ui.logout',
      ...(accountId !== undefined ? { account_id: accountId } : {}),
    });
    await refreshAll();
  };

  const handleSelectDialog = (dlg: StoredDialogDto) => {
    setSelectedChatId(dlg.chat_id);
    setSelectedTopicId(null);
    setActiveNavTab('chats');
    if (dlg.unread_count > 0 && dlg.chat_id > 0) {
      void sendSwRpc({
        type: 'ui.mark_read',
        chat_id: dlg.chat_id,
        max_message_id: dlg.last_message_id,
      });
    }
  };

  // =========================================================================
  // Gate 1: Local Passcode Lock Screen (blocks ALL message DOM access when locked)
  // =========================================================================
  if (state.passcode_locked) {
    return (
      <PasscodeLockScreen
        locale={locale}
        username={state.username}
        onUnlocked={() => {
          setState((prev) => ({ ...prev, passcode_locked: false }));
          void refreshAll();
        }}
      />
    );
  }

  // =========================================================================
  // Surface 1: Compact Popup (`popup.html`)
  // =========================================================================
  if (surface === 'popup') {
    return (
      <PopupView
        state={state}
        locale={locale}
        themePreset={themePreset}
        dialogs={dialogs}
        copilotMessages={messagesByChat[LOCAL_COPILOT_CHAT_ID] ?? []}
        pendingApprovals={pendingApprovals}
        onPolicyChange={(p) => void handlePolicyChange(p)}
        onEmergencyStop={() => void handleEmergencyStop()}
        onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
        onCycleTheme={handleCycleTheme}
        onToggleLocale={handleToggleLocale}
      />
    );
  }

  // =========================================================================
  // Gate 2: Auth Wizard (`workspace.html` when logged out or adding account)
  // =========================================================================
  if (surface === 'workspace' && (!state.authenticated || addingAccountMode)) {
    return (
      <AuthWizard
        initialServerUrl={state.server_url}
        locale={locale}
        themePreset={themePreset}
        onAuthenticated={async () => {
          setAddingAccountMode(false);
          setMessagesByChat({});
          setSelectedChatId(0);
          await refreshAll();
        }}
        onCycleTheme={handleCycleTheme}
        onToggleLocale={handleToggleLocale}
        onCancelAddAccount={
          addingAccountMode && state.authenticated ? () => setAddingAccountMode(false) : undefined
        }
      />
    );
  }

  const effectiveChatId = selectedChatId || LOCAL_COPILOT_CHAT_ID;
  const activeDialog: StoredDialogDto =
    dialogs.find((d) => d.chat_id === effectiveChatId) ?? {
      chat_id: LOCAL_COPILOT_CHAT_ID,
      chat_type: 'bot',
      title: tr(locale, 'sidebar.localCopilot'),
      peer_user_id: OFFICIAL_BOT_USER_ID,
      peer_username: 'hermes_browser_copilot',
      is_bot: true,
      unread_count: 0,
      pts: 0,
      updated_at_ms: 0,
    };

  const activeMessages = messagesByChat[effectiveChatId] ?? [];

  // =========================================================================
  // Surface 2: Extension Options Page (`options.html`)
  // =========================================================================
  if (surface === 'options') {
    return (
      <div className="workspace-shell" data-theme={themePreset}>
        <SettingsRouter
          state={state}
          locale={locale}
          themePreset={themePreset}
          fontSize={fontSize}
          bubbleRadius={bubbleRadius}
          accentColor={accentColor}
          pendingApprovals={pendingApprovals}
          activeSection={settingsSection}
          onSelectSection={setSettingsSection}
          onBackToChats={() =>
            chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html'), active: true })
          }
          onPolicyChange={(p) => void handlePolicyChange(p)}
          onEmergencyStop={() => void handleEmergencyStop()}
          onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
          onSelectTheme={(p) => void handleSelectTheme(p)}
          onChangeFontSize={(px) => {
            setState((prev) => ({ ...prev, font_size: px }));
            void sendSwRpc({ type: 'ui.set_preferences', font_size: px });
          }}
          onChangeBubbleRadius={(px) => {
            setState((prev) => ({ ...prev, bubble_radius: px }));
            void sendSwRpc({ type: 'ui.set_preferences', bubble_radius: px });
          }}
          onChangeAccentColor={(hex) => {
            setState((prev) => ({ ...prev, accent_color: hex }));
            void sendSwRpc({ type: 'ui.set_preferences', accent_color: hex });
          }}
          onSelectLocale={(loc) => void handleSelectLocale(loc)}
          onOpenExportModal={() => setExportModalOpen(true)}
          onOpenShortcutsModal={() => setShortcutsModalOpen(true)}
          onLogout={() => void handleLogoutAccount()}
        />
        <ExportDataModal
          open={exportModalOpen}
          dialogs={dialogs}
          onClose={() => setExportModalOpen(false)}
        />
        <ShortcutsLegendModal
          open={shortcutsModalOpen}
          onClose={() => setShortcutsModalOpen(false)}
        />
      </div>
    );
  }

  // =========================================================================
  // Surface 3: Adaptive Companion Sidepanel (`sidepanel.html`)
  // =========================================================================
  if (surface === 'sidepanel') {
    return (
      <div className="sidepanel-shell" data-theme={themePreset}>
        <header className="sidepanel-header">
          <div className="row-gap-4">
            <button
              type="button"
              className={`btn ghost xs ${activeNavTab === 'chats' ? 'primary-soft' : ''}`}
              onClick={() => setActiveNavTab('chats')}
            >
              💬 {tr(locale, 'nav.chats')}
            </button>
            <button
              type="button"
              className={`btn ghost xs ${activeNavTab === 'studio' ? 'primary-soft' : ''}`}
              onClick={() => setActiveNavTab('studio')}
            >
              🧠 {tr(locale, 'nav.studio')}
            </button>
            <button
              type="button"
              className={`btn ghost xs ${activeNavTab === 'settings' ? 'primary-soft' : ''}`}
              onClick={() => setActiveNavTab('settings')}
            >
              ⚙️ {tr(locale, 'nav.settings')}
            </button>
          </div>
          <div className="row-gap-4">
            <button
              type="button"
              className="btn ghost xs"
              data-testid={CANONICAL_TEST_IDS.themeToggleBtn}
              title={tr(locale, 'nav.theme')}
              onClick={handleCycleTheme}
            >
              🌓
            </button>
            <button
              type="button"
              className="btn ghost xs"
              data-testid={CANONICAL_TEST_IDS.langToggleBtn}
              title={tr(locale, 'nav.language')}
              onClick={handleToggleLocale}
            >
              {locale === 'zh-CN' ? '中' : 'EN'}
            </button>
          </div>
        </header>

        {activeNavTab === 'chats' ? (
          <>
            <ChatSidebar
              surface="sidepanel"
              locale={locale}
              authenticated={state.authenticated}
              dialogs={dialogs}
              selectedChatId={effectiveChatId}
              selectedTopicId={selectedTopicId}
              sidebarWidth={sidebarWidth}
              collapsed={false}
              searchInputRef={searchInputRef}
              showArchivedDrawer={showArchivedDrawer}
              onToggleArchivedDrawer={setShowArchivedDrawer}
              onResizeWidth={setSidebarWidth}
              onSelectDialog={handleSelectDialog}
              onSelectTopic={setSelectedTopicId}
              onDialogsChanged={refreshAll}
            />
            <ConversationStage
              surface="sidepanel"
              state={state}
              locale={locale}
              activeDialog={activeDialog}
              selectedTopicId={selectedTopicId}
              messages={activeMessages}
              pendingApprovals={pendingApprovals}
              inspectorOpen={false}
              onPolicyChange={(p) => void handlePolicyChange(p)}
              onEmergencyStop={() => void handleEmergencyStop()}
              onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
              onToggleInspector={() => {}}
              onOpenBotStudio={() => {}}
              onOpenMiniAppPicker={() => setMiniAppPickerOpen(true)}
              onOpenMiniAppUrl={(url, title) =>
                setActiveMiniApp({
                  botUsername: activeDialog.peer_username || 'bot',
                  shortName: 'app',
                  title: title || 'Mini App',
                  launchUrl: url,
                  companionChatId: effectiveChatId,
                })
              }
              onStartCall={(video) => setCallOverlay({ open: true, video })}
              onStartTalkMode={() => setTalkModeOpen(true)}
              onOpenPollModal={() => setPollModalOpen(true)}
              onOpenForwardModal={(m) => setForwardMsg(m)}
              onOpenE2eeVerify={() => setE2eeModalOpen(true)}
              onMessagesMutated={() => void loadChatMessages(effectiveChatId)}
            />
          </>
        ) : activeNavTab === 'studio' ? (
          <HermesStudio
            state={state}
            locale={locale}
            pendingApprovals={pendingApprovals}
            initialTab="approvals"
            onPolicyChange={(p) => void handlePolicyChange(p)}
            onEmergencyStop={() => void handleEmergencyStop()}
            onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
          />
        ) : (
          <SettingsRouter
            state={state}
            locale={locale}
            themePreset={themePreset}
            fontSize={fontSize}
            bubbleRadius={bubbleRadius}
            accentColor={accentColor}
            pendingApprovals={pendingApprovals}
            activeSection={settingsSection}
            onSelectSection={setSettingsSection}
            onBackToChats={() => setActiveNavTab('chats')}
            onPolicyChange={(p) => void handlePolicyChange(p)}
            onEmergencyStop={() => void handleEmergencyStop()}
            onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
            onSelectTheme={(p) => void handleSelectTheme(p)}
            onChangeFontSize={(px) => {
              setState((prev) => ({ ...prev, font_size: px }));
              void sendSwRpc({ type: 'ui.set_preferences', font_size: px });
            }}
            onChangeBubbleRadius={(px) => {
              setState((prev) => ({ ...prev, bubble_radius: px }));
              void sendSwRpc({ type: 'ui.set_preferences', bubble_radius: px });
            }}
            onChangeAccentColor={(hex) => {
              setState((prev) => ({ ...prev, accent_color: hex }));
              void sendSwRpc({ type: 'ui.set_preferences', accent_color: hex });
            }}
            onSelectLocale={(loc) => void handleSelectLocale(loc)}
            onOpenExportModal={() => setExportModalOpen(true)}
            onOpenShortcutsModal={() => setShortcutsModalOpen(true)}
            onLogout={() => void handleLogoutAccount()}
          />
        )}

        <MiniAppPickerModal
          open={miniAppPickerOpen}
          activeChatId={effectiveChatId}
          activeBotUsername={activeDialog.peer_username}
          onClose={() => setMiniAppPickerOpen(false)}
          onLaunchMiniApp={(sess) => {
            setMiniAppPickerOpen(false);
            setActiveMiniApp(sess);
          }}
        />
        <MiniAppHostModal
          session={activeMiniApp}
          onClose={() => setActiveMiniApp(null)}
          onDataDispatched={(cid) => void loadChatMessages(cid)}
        />
      </div>
    );
  }

  // =========================================================================
  // Surface 4: Full 4-Column Desktop `AppShell` (`workspace.html`)
  // =========================================================================
  return (
    <div className="workspace-shell" data-theme={themePreset}>
      {/* Column 1: 52px NavRail at x=0 */}
      <NavRail
        state={state}
        locale={locale}
        themePreset={themePreset}
        activeTab={activeNavTab}
        pendingApprovalsCount={pendingApprovals.length}
        accountMenuOpen={accountMenuOpen}
        onToggleAccountMenu={() => setAccountMenuOpen((v) => !v)}
        onSelectTab={setActiveNavTab}
        onOpenMainMenu={() => setMainMenuOpen(true)}
        onOpenBrowserWorkbench={() => setBrowserWorkbenchOpen(true)}
        onOpenMiniAppLauncher={() => setMiniAppPickerOpen(true)}
        onCycleTheme={handleCycleTheme}
        onSelectTheme={(p) => void handleSelectTheme(p)}
        onToggleLocale={handleToggleLocale}
        onLockApp={() => {
          if (state.passcode_enabled) {
            void sendSwRpc({ type: 'ui.set_preferences', passcode_locked: true });
          } else {
            setActiveNavTab('settings');
            setSettingsSection('LocalPasscode');
          }
        }}
        onSwitchAccount={(id) => void handleSwitchAccount(id)}
        onAddAccount={() => {
          setAccountMenuOpen(false);
          setAddingAccountMode(true);
        }}
        onLogoutAccount={(id) => void handleLogoutAccount(id)}
      />

      {/* Column 2: 288px Resizable [240..360] ChatSidebar */}
      {activeNavTab === 'chats' && (
        <ChatSidebar
          surface="workspace"
          locale={locale}
          authenticated={state.authenticated}
          dialogs={dialogs}
          selectedChatId={effectiveChatId}
          selectedTopicId={selectedTopicId}
          sidebarWidth={sidebarWidth}
          collapsed={sidebarCollapsed}
          searchInputRef={searchInputRef}
          showArchivedDrawer={showArchivedDrawer}
          onToggleArchivedDrawer={setShowArchivedDrawer}
          onResizeWidth={(w) => {
            setSidebarWidth(w);
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
              void chrome.storage.local.set({ sidebar_width: w });
            }
          }}
          onSelectDialog={handleSelectDialog}
          onSelectTopic={setSelectedTopicId}
          onDialogsChanged={refreshAll}
        />
      )}

      {/* Column 3: Flexible Center Stage (ConversationStage | HermesStudio | SettingsRouter) */}
      {activeNavTab === 'studio' ? (
        <HermesStudio
          state={state}
          locale={locale}
          pendingApprovals={pendingApprovals}
          initialTab={pendingApprovals.length > 0 ? 'approvals' : 'tasks'}
          onPolicyChange={(p) => void handlePolicyChange(p)}
          onEmergencyStop={() => void handleEmergencyStop()}
          onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
        />
      ) : activeNavTab === 'settings' ? (
        <SettingsRouter
          state={state}
          locale={locale}
          themePreset={themePreset}
          fontSize={fontSize}
          bubbleRadius={bubbleRadius}
          accentColor={accentColor}
          pendingApprovals={pendingApprovals}
          activeSection={settingsSection}
          onSelectSection={setSettingsSection}
          onBackToChats={() => setActiveNavTab('chats')}
          onPolicyChange={(p) => void handlePolicyChange(p)}
          onEmergencyStop={() => void handleEmergencyStop()}
          onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
          onSelectTheme={(p) => void handleSelectTheme(p)}
          onChangeFontSize={(px) => {
            setState((prev) => ({ ...prev, font_size: px }));
            void sendSwRpc({ type: 'ui.set_preferences', font_size: px });
          }}
          onChangeBubbleRadius={(px) => {
            setState((prev) => ({ ...prev, bubble_radius: px }));
            void sendSwRpc({ type: 'ui.set_preferences', bubble_radius: px });
          }}
          onChangeAccentColor={(hex) => {
            setState((prev) => ({ ...prev, accent_color: hex }));
            void sendSwRpc({ type: 'ui.set_preferences', accent_color: hex });
          }}
          onSelectLocale={(loc) => void handleSelectLocale(loc)}
          onOpenExportModal={() => setExportModalOpen(true)}
          onOpenShortcutsModal={() => setShortcutsModalOpen(true)}
          onLogout={() => void handleLogoutAccount()}
        />
      ) : (
        <ConversationStage
          surface="workspace"
          state={state}
          locale={locale}
          activeDialog={activeDialog}
          selectedTopicId={selectedTopicId}
          messages={activeMessages}
          pendingApprovals={pendingApprovals}
          inspectorOpen={inspectorOpen}
          onPolicyChange={(p) => void handlePolicyChange(p)}
          onEmergencyStop={() => void handleEmergencyStop()}
          onApprovalDecision={(id, app, rem) => void handleApprovalDecision(id, app, rem)}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          onOpenBotStudio={() => {
            setInspectorTab('studio');
            setInspectorOpen(true);
          }}
          onOpenMiniAppPicker={() => setMiniAppPickerOpen(true)}
          onOpenMiniAppUrl={(url, title) =>
            setActiveMiniApp({
              botUsername: activeDialog.peer_username || 'bot',
              shortName: 'app',
              title: title || 'Mini App',
              launchUrl: url,
              companionChatId: effectiveChatId,
            })
          }
          onStartCall={(video) => setCallOverlay({ open: true, video })}
          onStartTalkMode={() => setTalkModeOpen(true)}
          onOpenPollModal={() => setPollModalOpen(true)}
          onOpenForwardModal={(m) => setForwardMsg(m)}
          onOpenE2eeVerify={() => setE2eeModalOpen(true)}
          onMessagesMutated={() => void loadChatMessages(effectiveChatId)}
        />
      )}

      {/* Column 4: 320px Toggleable ContextInspector */}
      {activeNavTab === 'chats' && inspectorOpen && (
        <ContextInspector
          state={state}
          locale={locale}
          activeDialog={activeDialog}
          messages={activeMessages}
          initialTab={inspectorTab}
          onClose={() => setInspectorOpen(false)}
          onStartCall={(video) => setCallOverlay({ open: true, video })}
          onOpenMiniAppPicker={() => setMiniAppPickerOpen(true)}
        />
      )}

      {/* Main Menu Drawer & Global Modals */}
      <MainMenuDrawer
        open={mainMenuOpen}
        state={state}
        locale={locale}
        themePreset={themePreset}
        onClose={() => setMainMenuOpen(false)}
        onOpenSavedMessages={() => {
          setSelectedChatId(LOCAL_COPILOT_CHAT_ID);
          setActiveNavTab('chats');
        }}
        onOpenArchivedChats={() => {
          setShowArchivedDrawer(true);
          setActiveNavTab('chats');
        }}
        onOpenStudio={() => setActiveNavTab('studio')}
        onOpenSettings={(sec) => {
          if (sec) setSettingsSection(sec as SettingsSectionId);
          setActiveNavTab('settings');
        }}
        onOpenShortcuts={() => setShortcutsModalOpen(true)}
        onCycleTheme={handleCycleTheme}
        onSelectTheme={(p) => void handleSelectTheme(p)}
        onToggleLocale={handleToggleLocale}
        onAddAccount={() => setAddingAccountMode(true)}
        onLogout={() => void handleLogoutAccount()}
      />

      <MiniAppPickerModal
        open={miniAppPickerOpen}
        activeChatId={effectiveChatId}
        activeBotUsername={activeDialog.peer_username}
        onClose={() => setMiniAppPickerOpen(false)}
        onLaunchMiniApp={(sess) => {
          setMiniAppPickerOpen(false);
          setActiveMiniApp(sess);
        }}
      />

      <MiniAppHostModal
        session={activeMiniApp}
        onClose={() => setActiveMiniApp(null)}
        onDataDispatched={(cid) => void loadChatMessages(cid)}
      />

      <CallOverlay
        open={callOverlay.open}
        chatId={effectiveChatId}
        peerTitle={activeDialog.title}
        initialVideo={callOverlay.video}
        onClose={() => setCallOverlay({ open: false, video: false })}
      />

      <TalkModeOverlay
        open={talkModeOpen}
        chatId={effectiveChatId}
        onClose={() => setTalkModeOpen(false)}
      />

      <CreatePollModal
        open={pollModalOpen}
        chatId={effectiveChatId}
        onClose={() => setPollModalOpen(false)}
        onCreated={() => void loadChatMessages(effectiveChatId)}
      />

      <ForwardMessageModal
        message={forwardMsg}
        dialogs={dialogs}
        onClose={() => setForwardMsg(null)}
        onForwarded={(cid) => {
          setSelectedChatId(cid);
          void loadChatMessages(cid);
        }}
      />

      <E2eeVerifyModal
        open={e2eeModalOpen}
        peerUserId={activeDialog.peer_user_id}
        peerTitle={activeDialog.title}
        onClose={() => setE2eeModalOpen(false)}
      />

      <ShortcutsLegendModal
        open={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />

      <ExportDataModal
        open={exportModalOpen}
        dialogs={dialogs}
        onClose={() => setExportModalOpen(false)}
      />

      <BrowserWorkbenchModal
        open={browserWorkbenchOpen}
        onClose={() => setBrowserWorkbenchOpen(false)}
      />
    </div>
  );
}
