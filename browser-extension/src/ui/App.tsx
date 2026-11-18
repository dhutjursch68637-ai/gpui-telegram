import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  type BrowserRunPolicy,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../shared/rpc_types';
import { ensureWasmLoaded } from '../wasm/wasm_bridge';
import { sendSwRpc, subscribeSwEvents } from './sw_client';
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
  language_code: 'en',
  wasm_ready: false,
};

const SLASH_SUGGESTIONS = [
  '/browser status',
  '/browser tabs',
  '/browser snapshot',
  '/browser screenshot',
  '/interrupt',
];

function PendingApprovalList({
  items,
  onDecision,
}: {
  items: PendingBrowserCommandDto[];
  onDecision: (commandId: string, approved: boolean, rememberForSession: boolean) => void;
}) {
  const [rememberMap, setRememberMap] = useState<Record<string, boolean>>({});

  if (items.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((cmd) => {
        const remember = Boolean(rememberMap[cmd.command_id]);
        return (
          <div
            key={cmd.command_id}
            className="approval-card"
            role="alert"
            data-testid={CANONICAL_TEST_IDS.browserApprovalCard}
            data-command-id={cmd.command_id}
          >
            <div style={{ fontWeight: 700 }}>
              {cmd.injection_flagged ? '⚠️ Escalated Security Approval: ' : '🔒 Browser Action Approval: '}
              <code>{cmd.tool}</code>
            </div>
            <div style={{ fontSize: 12, marginTop: 3 }}>
              {cmd.reason}
              {cmd.target_url ? ` — ${cmd.target_url}` : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              ID: {cmd.command_id} • Args: <code>{JSON.stringify(cmd.arguments)}</code>
            </div>
            <div className="approval-actions">
              {!cmd.injection_flagged && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    data-testid={CANONICAL_TEST_IDS.approvalRememberSession}
                    checked={remember}
                    onChange={(e) =>
                      setRememberMap((prev) => ({
                        ...prev,
                        [cmd.command_id]: e.target.checked,
                      }))
                    }
                  />
                  Remember for session
                </label>
              )}
              <button
                type="button"
                className="btn success"
                data-testid={CANONICAL_TEST_IDS.browserApprovalApproveBtn}
                data-action="approve"
                onClick={() => onDecision(cmd.command_id, true, remember)}
              >
                Approve
              </button>
              {!cmd.injection_flagged && (
                <button
                  type="button"
                  className="btn primary"
                  data-testid={CANONICAL_TEST_IDS.browserApprovalSessionBtn}
                  data-action="approve-session"
                  onClick={() => onDecision(cmd.command_id, true, true)}
                >
                  Allow for Session
                </button>
              )}
              <button
                type="button"
                className="btn danger"
                data-testid={CANONICAL_TEST_IDS.browserApprovalDenyBtn}
                data-action="deny"
                onClick={() => onDecision(cmd.command_id, false, false)}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ExtensionApp({ surface }: { surface: ExtensionSurfaceKind }) {
  const [state, setState] = useState<ExtensionRuntimeStateSummary>(DEFAULT_STATE);
  const [dialogs, setDialogs] = useState<StoredDialogDto[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingBrowserCommandDto[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number>(
    surface === 'sidepanel' ? LOCAL_COPILOT_CHAT_ID : 0,
  );
  const [messagesByChat, setMessagesByChat] = useState<Record<number, StoredMessageDto[]>>({});
  const [activeNavTab, setActiveNavTab] = useState<'chats' | 'studio' | 'settings'>(
    surface === 'options' ? 'settings' : 'chats',
  );
  const [studioSubTab, setStudioSubTab] = useState<'approvals' | 'overview'>('approvals');
  const [searchQuery, setSearchQuery] = useState('');
  const [composerText, setComposerText] = useState('');

  // Auth Wizard form state
  const [authServerUrl, setAuthServerUrl] = useState('http://127.0.0.1:8080');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // Options domain config inputs
  const [allowedDomainsText, setAllowedDomainsText] = useState('');
  const [blockedDomainsText, setBlockedDomainsText] = useState('');

  const selectedChatRef = useRef(selectedChatId);
  selectedChatRef.current = selectedChatId;

  const refreshAll = useCallback(async () => {
    const snap = await sendSwRpc<{
      ok: boolean;
      state?: ExtensionRuntimeStateSummary;
      dialogs?: StoredDialogDto[];
      pending_approvals?: PendingBrowserCommandDto[];
    }>({ type: 'ui.get_snapshot' });

    if (snap?.state) {
      setState(snap.state);
      if (snap.state.server_url) setAuthServerUrl(snap.state.server_url);
      setAllowedDomainsText(snap.state.allowed_domains.join(', '));
      setBlockedDomainsText(snap.state.blocked_domains.join(', '));
    }
    if (Array.isArray(snap?.dialogs)) {
      setDialogs(snap.dialogs);
    }
    if (Array.isArray(snap?.pending_approvals)) {
      setPendingApprovals(snap.pending_approvals);
    }
  }, []);

  useEffect(() => {
    void ensureWasmLoaded();
    void refreshAll();

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

    // Global Alt+Shift+S emergency kill-switch listener inside every Extension UI surface
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void sendSwRpc({ type: 'ui.emergency_stop', reason: 'Alt+Shift+S shortcut' });
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [refreshAll]);

  // Auto-select first real synced dialog in workspace mode when dialogs arrive
  useEffect(() => {
    if (surface === 'sidepanel') {
      if (selectedChatId === 0) {
        setSelectedChatId(LOCAL_COPILOT_CHAT_ID);
      }
      return;
    }
    if (surface === 'workspace' && selectedChatId === 0) {
      if (dialogs.length > 0) {
        setSelectedChatId(dialogs[0]!.chat_id);
      } else {
        setSelectedChatId(LOCAL_COPILOT_CHAT_ID);
      }
    }
  }, [dialogs, selectedChatId, surface]);

  // Load messages whenever selectedChatId changes
  useEffect(() => {
    if (!selectedChatId) return;
    void sendSwRpc<{ ok: boolean; chat_id: number; messages: StoredMessageDto[] }>({
      type: 'ui.get_messages',
      chat_id: selectedChatId,
    }).then((res) => {
      if (Array.isArray(res?.messages)) {
        setMessagesByChat((prev) => ({ ...prev, [selectedChatId]: res.messages }));
      }
    });
  }, [selectedChatId]);

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

  const handleSelectDialog = (dlg: StoredDialogDto) => {
    setSelectedChatId(dlg.chat_id);
    setActiveNavTab('chats');
    if (dlg.unread_count > 0) {
      void sendSwRpc({
        type: 'ui.mark_read',
        chat_id: dlg.chat_id,
        max_message_id: dlg.last_message_id,
      });
    }
  };

  const handleSendComposer = async () => {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    const targetChat =
      surface === 'sidepanel' ? LOCAL_COPILOT_CHAT_ID : selectedChatId || LOCAL_COPILOT_CHAT_ID;
    setComposerText('');
    await sendSwRpc({
      type: 'ui.send_message',
      surface,
      chat_id: targetChat,
      text: trimmed,
    });
  };

  const handleStopBot = async () => {
    await sendSwRpc({ type: 'ui.stop_bot' });
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const base = authServerUrl.trim().replace(/\/+$/, '');
    const username = authUsername.trim();
    const password = authPassword;
    if (!base || !username || !password) {
      setAuthError('Server URL, username, and password are required.');
      return;
    }

    try {
      let resp = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (resp.status === 401 || resp.status === 404) {
        resp = await fetch(`${base}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, display_name: username }),
        });
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        setAuthError(`Authentication failed (${resp.status}): ${txt}`);
        return;
      }
      const data = (await resp.json()) as Record<string, any>;
      const token = String(data.token ?? data.access_token ?? '');
      if (!token) {
        setAuthError('Server returned empty token.');
        return;
      }
      await sendSwRpc({
        type: 'ui.login_success',
        server_url: base,
        token,
        user_id: typeof data.user_id === 'number' ? data.user_id : data.user?.id ?? null,
        username: data.username ?? data.user?.username ?? username,
      });
      await refreshAll();
    } catch (err: any) {
      setAuthError(String(err?.message ?? err));
    }
  };

  const bridgeStatusLabel = useMemo(() => {
    if (state.emergency_stopped || state.run_policy === 'disabled') {
      return 'Stopped / Disabled';
    }
    if (state.server_relay_connected && state.desktop_bridge_connected) {
      return 'Connected (Server + Desktop)';
    }
    if (state.server_relay_connected) {
      return 'Connected (Server Relay)';
    }
    if (state.desktop_bridge_connected) {
      return 'Connected (Desktop Bridge)';
    }
    return 'Standby / Offline';
  }, [
    state.desktop_bridge_connected,
    state.emergency_stopped,
    state.run_policy,
    state.server_relay_connected,
  ]);

  const copilotDialog: StoredDialogDto = useMemo(
    () => ({
      chat_id: LOCAL_COPILOT_CHAT_ID,
      chat_type: 'bot',
      title: 'Hermes Browser Copilot',
      peer_user_id: OFFICIAL_BOT_USER_ID,
      peer_username: 'hermes_browser_copilot',
      is_bot: true,
      unread_count: 0,
      pts: 0,
      last_message_preview: 'Side-Panel AI & 24-Tool Browser Agent',
      updated_at_ms: 0,
    }),
    [],
  );

  const visibleDialogs = useMemo(() => {
    const all = [copilotDialog, ...dialogs.filter((d) => d.chat_id !== LOCAL_COPILOT_CHAT_ID)];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.peer_username ?? '').toLowerCase().includes(q),
    );
  }, [copilotDialog, dialogs, searchQuery]);

  const activeChatId =
    surface === 'sidepanel' ? LOCAL_COPILOT_CHAT_ID : selectedChatId || LOCAL_COPILOT_CHAT_ID;
  const activeMessages = messagesByChat[activeChatId] ?? [];

  // =========================================================================
  // Surface 1: Compact Popup (`popup.html`)
  // =========================================================================
  if (surface === 'popup') {
    return (
      <div className="popup-shell" data-theme={state.theme_mode}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>GPUI Telegram</strong>
          <span
            data-testid={CANONICAL_TEST_IDS.browserBridgeStatusPill}
            className={`status-pill ${
              state.emergency_stopped || state.run_policy === 'disabled' ? 'stopped' : 'ok'
            }`}
          >
            {bridgeStatusLabel}
          </span>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Browser Control Policy</span>
          <select
            className="select"
            data-testid={CANONICAL_TEST_IDS.browserPolicySelect}
            value={state.run_policy}
            onChange={(e) => void handlePolicyChange(e.target.value as BrowserRunPolicy)}
          >
            <option value="always_allow_authorized">always_allow_authorized</option>
            <option value="allow_read_only">allow_read_only</option>
            <option value="ask_every_time">ask_every_time</option>
            <option value="disabled">disabled</option>
          </select>
        </label>

        <button
          type="button"
          className="btn danger"
          data-testid={CANONICAL_TEST_IDS.emergencyStopBtn}
          onClick={() => void handleEmergencyStop()}
        >
          Emergency Stop (Alt+Shift+S)
        </button>

        <PendingApprovalList items={pendingApprovals} onDecision={handleApprovalDecision} />

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Unread Messages: <strong>{state.unread_total}</strong> • Open Tabs:{' '}
          <strong>{state.active_tabs_count}</strong>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
          <button
            type="button"
            className="btn primary"
            style={{ flex: 1 }}
            onClick={() =>
              chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html'), active: true })
            }
          >
            Open Workspace
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            Options
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // Auth Wizard Gate (when logged out on workspace.html)
  // =========================================================================
  if (surface === 'workspace' && !state.authenticated) {
    return (
      <div className="ext-shell" data-theme={state.theme_mode}>
        <form
          className="auth-card"
          data-testid={CANONICAL_TEST_IDS.authWizard}
          onSubmit={(e) => void handleAuthSubmit(e)}
        >
          <h2 style={{ margin: 0 }}>Sign in to GPUI Telegram</h2>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Server URL</span>
            <input
              className="input"
              data-testid={CANONICAL_TEST_IDS.authServerUrlInput}
              value={authServerUrl}
              onChange={(e) => setAuthServerUrl(e.target.value)}
              placeholder="http://127.0.0.1:8080"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Username</span>
            <input
              className="input"
              data-testid={CANONICAL_TEST_IDS.authUsernameInput}
              value={authUsername}
              onChange={(e) => setAuthUsername(e.target.value)}
              placeholder="alice"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Password</span>
            <input
              className="input"
              type="password"
              data-testid={CANONICAL_TEST_IDS.authPasswordInput}
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>
          {authError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{authError}</div>}
          <button
            type="submit"
            className="btn primary"
            data-testid={CANONICAL_TEST_IDS.authSubmitBtn}
          >
            Sign In
          </button>
        </form>
      </div>
    );
  }

  // =========================================================================
  // Workspace / Sidepanel / Options Unified Layout
  // =========================================================================
  return (
    <div className="ext-shell" data-theme={state.theme_mode}>
      <header className="ext-topbar">
        <div className="ext-topbar-group">
          <strong>
            {surface === 'sidepanel'
              ? 'Hermes Side-Panel Copilot'
              : surface === 'options'
                ? 'GPUI Telegram Settings'
                : 'GPUI Telegram Workspace'}
          </strong>
          <span
            data-testid={CANONICAL_TEST_IDS.browserBridgeStatusPill}
            className={`status-pill ${
              state.emergency_stopped || state.run_policy === 'disabled' ? 'stopped' : 'ok'
            }`}
          >
            {bridgeStatusLabel}
          </span>
        </div>

        <div className="ext-topbar-group">
          <select
            className="select"
            aria-label="Browser Run Policy"
            data-testid={CANONICAL_TEST_IDS.browserPolicySelect}
            value={state.run_policy}
            onChange={(e) => void handlePolicyChange(e.target.value as BrowserRunPolicy)}
          >
            <option value="always_allow_authorized">always_allow_authorized</option>
            <option value="allow_read_only">allow_read_only</option>
            <option value="ask_every_time">ask_every_time</option>
            <option value="disabled">disabled</option>
          </select>

          <button
            type="button"
            className="btn danger"
            data-testid={CANONICAL_TEST_IDS.emergencyStopBtn}
            onClick={() => void handleEmergencyStop()}
          >
            Stop Bot
          </button>

          <button
            type="button"
            className="btn"
            data-testid={CANONICAL_TEST_IDS.themeToggleBtn}
            onClick={() =>
              void sendSwRpc({
                type: 'ui.set_preferences',
                theme_mode: state.theme_mode === 'dark' ? 'light' : 'dark',
              })
            }
          >
            {state.theme_mode === 'dark' ? 'Light' : 'Dark'}
          </button>

          <button
            type="button"
            className="btn"
            data-testid={CANONICAL_TEST_IDS.langToggleBtn}
            onClick={() =>
              void sendSwRpc({
                type: 'ui.set_preferences',
                language_code: state.language_code === 'en' ? 'ru' : 'en',
              })
            }
          >
            {state.language_code.toUpperCase()}
          </button>
        </div>
      </header>

      <div className="ext-body">
        {surface === 'workspace' && (
          <nav className="nav-rail" data-testid={CANONICAL_TEST_IDS.navRail}>
            <button
              type="button"
              className={`nav-btn ${activeNavTab === 'chats' ? 'active' : ''}`}
              onClick={() => setActiveNavTab('chats')}
            >
              Chats
            </button>
            <button
              type="button"
              className={`nav-btn ${activeNavTab === 'studio' ? 'active' : ''}`}
              aria-label="Hermes Studio & Approvals"
              onClick={() => setActiveNavTab('studio')}
            >
              Studio{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}
            </button>
            <button
              type="button"
              className={`nav-btn ${activeNavTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveNavTab('settings')}
            >
              Settings
            </button>
          </nav>
        )}

        {surface === 'workspace' && activeNavTab === 'chats' && (
          <aside className="chat-sidebar" data-testid={CANONICAL_TEST_IDS.chatSidebar}>
            <div className="sidebar-header">
              <input
                className="input"
                style={{ flex: 1 }}
                data-testid={CANONICAL_TEST_IDS.chatSearchInput}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats..."
              />
              <button
                type="button"
                className="btn"
                data-testid={CANONICAL_TEST_IDS.createMenuBtn}
                onClick={() => void sendSwRpc({ type: 'ui.sync_dialogs' })}
                title="Refresh / Create"
              >
                +
              </button>
            </div>

            <div className="dialog-list">
              {visibleDialogs.map((dlg) => (
                <button
                  key={dlg.chat_id}
                  type="button"
                  className={`dialog-row ${activeChatId === dlg.chat_id ? 'selected' : ''}`}
                  data-chat-id={dlg.chat_id}
                  data-dialog-id={dlg.chat_id}
                  onClick={() => handleSelectDialog(dlg)}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {dlg.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {dlg.last_message_preview || (dlg.peer_username ? `@${dlg.peer_username}` : '')}
                    </div>
                  </div>
                  {dlg.unread_count > 0 && (
                    <span className="unread-badge">{dlg.unread_count}</span>
                  )}
                </button>
              ))}
            </div>
          </aside>
        )}

        {activeNavTab === 'studio' && surface === 'workspace' ? (
          <section
            className="stage-wrap"
            style={{ padding: 16, overflowY: 'auto' }}
            data-testid={CANONICAL_TEST_IDS.hermesStudioWorkspace}
          >
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                role="tab"
                data-tab="approvals"
                className={`btn ${studioSubTab === 'approvals' ? 'primary' : ''}`}
                onClick={() => setStudioSubTab('approvals')}
              >
                Approvals ({pendingApprovals.length})
              </button>
              <button
                type="button"
                role="tab"
                data-tab="overview"
                className={`btn ${studioSubTab === 'overview' ? 'primary' : ''}`}
                onClick={() => setStudioSubTab('overview')}
              >
                Bridge Overview
              </button>
            </div>

            {studioSubTab === 'approvals' ? (
              <div>
                <h3>Pending Browser Command Approvals</h3>
                {pendingApprovals.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)' }}>No pending browser commands.</p>
                ) : (
                  <PendingApprovalList
                    items={pendingApprovals}
                    onDecision={handleApprovalDecision}
                  />
                )}
              </div>
            ) : (
              <div>
                <h3>24-Tool Browser Bridge Status</h3>
                <p>Extension ID: <code>{state.extension_id}</code></p>
                <p>Server Relay: <strong>{state.server_relay_connected ? 'Connected' : 'Disconnected'}</strong></p>
                <p>Desktop Loopback Bridge: <strong>{state.desktop_bridge_connected ? 'Connected' : 'Disconnected'}</strong></p>
                <p>WASM Core Ready: <strong>{state.wasm_ready ? 'Yes' : 'Loading'}</strong></p>
              </div>
            )}
          </section>
        ) : activeNavTab === 'settings' || surface === 'options' ? (
          <section
            className="stage-wrap"
            style={{ padding: 16, overflowY: 'auto', gap: 12 }}
            data-testid={CANONICAL_TEST_IDS.settingsRouter}
          >
            <h3 style={{ margin: 0 }}>Security & Domain Access Control</h3>
            <PendingApprovalList items={pendingApprovals} onDecision={handleApprovalDecision} />

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 480 }}>
              <span>Allowed Domains (comma-separated, empty = allow all http/https)</span>
              <input
                className="input"
                value={allowedDomainsText}
                onChange={(e) => setAllowedDomainsText(e.target.value)}
                placeholder="example.com, 127.0.0.1"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 480 }}>
              <span>Blocked Domains (comma-separated)</span>
              <input
                className="input"
                value={blockedDomainsText}
                onChange={(e) => setBlockedDomainsText(e.target.value)}
                placeholder="localhost, untrusted.invalid"
              />
            </label>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  void sendSwRpc({
                    type: 'ui.set_policy',
                    policy: state.run_policy,
                    allowed_domains: allowedDomainsText
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                    blocked_domains: blockedDomainsText
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              >
                Save Domain Policy
              </button>

              {state.authenticated && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => void sendSwRpc({ type: 'ui.logout' })}
                >
                  Log Out
                </button>
              )}
            </div>
          </section>
        ) : (
          <main className="stage-wrap" data-testid={CANONICAL_TEST_IDS.conversationStage}>
            <div className="messages-scroll">
              <PendingApprovalList items={pendingApprovals} onDecision={handleApprovalDecision} />

              {activeMessages.map((msg) => {
                const isMine =
                  state.user_id !== null && msg.sender_id === state.user_id;
                return (
                  <article
                    key={`${msg.chat_id}:${msg.message_id}`}
                    className={`msg-bubble ${isMine ? 'mine' : ''} ${msg.is_error ? 'error' : ''}`}
                    data-testid={CANONICAL_TEST_IDS.messageBubble}
                    data-message-id={msg.message_id}
                  >
                    {msg.thinking && (
                      <div
                        className="thinking-box"
                        data-testid={CANONICAL_TEST_IDS.thinkingBubble}
                      >
                        💭 {msg.thinking}
                      </div>
                    )}

                    {msg.tool_steps && msg.tool_steps.length > 0 && (
                      <div
                        className="steps-box"
                        data-testid={CANONICAL_TEST_IDS.toolStepsList}
                      >
                        <div style={{ fontWeight: 700, marginBottom: 3 }}>
                          🔧 Steps ({msg.tool_steps.length})
                        </div>
                        {msg.tool_steps.map((st) => (
                          <div key={st.id}>
                            • <code>{st.tool}</code> [{st.status}]
                            {st.result_summary ? ` — ${st.result_summary}` : ''}
                          </div>
                        ))}
                      </div>
                    )}

                    <div>{msg.text}</div>

                    {msg.media_data_url && (
                      <img
                        src={msg.media_data_url}
                        alt="Captured browser screenshot"
                        style={{
                          maxWidth: '100%',
                          maxHeight: 220,
                          borderRadius: 6,
                          marginTop: 6,
                          border: '1px solid var(--border)',
                        }}
                      />
                    )}

                    {msg.edited_at_ms && (
                      <span style={{ fontSize: 10, opacity: 0.75, marginLeft: 6 }}>(edited)</span>
                    )}

                    {msg.reactions && msg.reactions.length > 0 && (
                      <div className="reactions-row">
                        {msg.reactions.map((r) => (
                          <span key={r.emoji} className="reaction-chip">
                            {r.emoji} {r.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            <div className="composer-bar">
              {composerText.startsWith('/') && (
                <div
                  className="slash-popup"
                  data-testid={CANONICAL_TEST_IDS.slashCommandPopup}
                >
                  {SLASH_SUGGESTIONS.filter((cmd) =>
                    cmd.startsWith(composerText.toLowerCase()),
                  ).map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      className="btn"
                      style={{ textAlign: 'left' }}
                      onClick={() => setComposerText(`${cmd} `)}
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                className="composer-input"
                data-testid={CANONICAL_TEST_IDS.canonicalComposerInput}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendComposer();
                  }
                }}
                placeholder={
                  surface === 'sidepanel'
                    ? 'Ask Hermes Copilot or run /browser status...'
                    : 'Write a message...'
                }
              />

              {state.bot_streaming && (
                <button
                  type="button"
                  className="btn danger"
                  data-testid={CANONICAL_TEST_IDS.composerStopBtn}
                  aria-label="Stop generation"
                  onClick={() => void handleStopBot()}
                >
                  Stop
                </button>
              )}

              <button
                type="button"
                className="btn primary"
                data-testid={CANONICAL_TEST_IDS.composerSendBtn}
                onClick={() => void handleSendComposer()}
              >
                Send
              </button>
            </div>
          </main>
        )}

        {surface === 'workspace' && activeNavTab === 'chats' && (
          <aside
            className="context-inspector"
            data-testid={CANONICAL_TEST_IDS.contextInspector}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Inspector</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div>WS Sync: {state.server_ws_connected ? 'Online' : 'Standby'}</div>
              <div>Server Relay: {state.server_relay_connected ? 'Connected' : 'Standby'}</div>
              <div>Desktop Bridge: {state.desktop_bridge_connected ? 'Connected' : 'Standby'}</div>
              <div>WASM Core: {state.wasm_ready ? 'Loaded' : 'Init'}</div>
              <div>Policy: {state.run_policy}</div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
