import React, { useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  type BrowserRunPolicy,
  type DesktopThemePreset,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../../shared/rpc_types';
import { tr, type TranslationKey } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';
import { PendingApprovalBannerList } from './ConversationStage';

export function PopupView({
  state,
  locale,
  themePreset,
  dialogs,
  copilotMessages,
  pendingApprovals,
  onPolicyChange,
  onEmergencyStop,
  onApprovalDecision,
  onCycleTheme,
  onToggleLocale,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  themePreset: DesktopThemePreset;
  dialogs: StoredDialogDto[];
  copilotMessages: StoredMessageDto[];
  pendingApprovals: PendingBrowserCommandDto[];
  onPolicyChange: (next: BrowserRunPolicy) => void;
  onEmergencyStop: () => void;
  onApprovalDecision: (cmdId: string, approved: boolean, remember: boolean) => void;
  onCycleTheme: () => void;
  onToggleLocale: () => void;
}) {
  const [summarizing, setSummarizing] = useState(false);
  const [quickPrompt, setQuickPrompt] = useState('');
  const quickInputRef = useRef<HTMLInputElement | null>(null);

  const isStopped = state.emergency_stopped || state.run_policy === 'disabled';
  const baseStatusLabel = isStopped
    ? tr(locale, 'bridge.stopped')
    : state.server_relay_connected && state.desktop_bridge_connected
      ? `${tr(locale, 'bridge.online')} (Relay+Desktop)`
      : state.server_relay_connected
        ? tr(locale, 'bridge.relay')
        : state.desktop_bridge_connected
          ? tr(locale, 'bridge.desktop')
          : tr(locale, 'bridge.online');
  const policyLabel = tr(locale, `policy.${state.run_policy}` as TranslationKey);
  const bridgeStatusLabel = isStopped ? baseStatusLabel : `${baseStatusLabel} · ${policyLabel}`;

  const handleSummarizeTab = async () => {
    setSummarizing(true);
    try {
      await sendSwRpc({
        type: 'ui.send_message',
        surface: 'sidepanel',
        chat_id: LOCAL_COPILOT_CHAT_ID,
        text: 'Please summarize the current active tab.',
        use_local_bot: true,
      });
      await sendSwRpc({
        type: 'ui.get_messages',
        chat_id: LOCAL_COPILOT_CHAT_ID,
      });
    } finally {
      setSummarizing(false);
    }
  };

  const handleQuickSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = (quickInputRef.current?.value ?? quickPrompt).trim();
    if (!q) return;
    setQuickPrompt('');
    if (quickInputRef.current) quickInputRef.current.value = '';
    await sendSwRpc({
      type: 'ui.send_message',
      surface: 'sidepanel',
      chat_id: LOCAL_COPILOT_CHAT_ID,
      text: q,
      use_local_bot: true,
    });
  };

  const latestCopilotReply = [...copilotMessages]
    .reverse()
    .find((m) => m.sender_id !== 0 && m.text.trim().length > 0);

  return (
    <div className="popup-shell" data-theme={themePreset}>
      <header className="popup-header">
        <div className="row-gap-6">
          <span>✈️</span>
          <strong>{tr(locale, 'app.title')}</strong>
        </div>

        <div className="row-gap-4">
          <span
            data-testid={CANONICAL_TEST_IDS.browserBridgeStatusPill}
            data-status={isStopped ? 'stopped' : 'ready'}
            className={`status-pill ${isStopped ? 'stopped' : 'ok'}`}
          >
            {bridgeStatusLabel}
          </span>
          <button
            type="button"
            className="btn ghost xs"
            data-testid={CANONICAL_TEST_IDS.themeToggleBtn}
            onClick={onCycleTheme}
            title={tr(locale, 'nav.theme')}
          >
            🌓
          </button>
          <button
            type="button"
            className="btn ghost xs"
            data-testid={CANONICAL_TEST_IDS.langToggleBtn}
            onClick={onToggleLocale}
            title={tr(locale, 'nav.language')}
          >
            {locale === 'zh-CN' ? '中' : 'EN'}
          </button>
        </div>
      </header>

      <div className="popup-section">
        <label className="field-stack">
          <span className="field-label">Browser Control Policy</span>
          <select
            className="select"
            aria-label="Browser Run Policy"
            data-testid={CANONICAL_TEST_IDS.browserPolicySelect}
            value={state.run_policy}
            onChange={(e) => onPolicyChange(e.target.value as BrowserRunPolicy)}
          >
            <option value="always_allow_authorized">always_allow_authorized</option>
            <option value="allow_read_only">allow_read_only</option>
            <option value="ask_every_time">ask_every_time</option>
            <option value="disabled">disabled</option>
          </select>
        </label>

        <div className="row-gap-6">
          <button
            type="button"
            className="btn primary flex-1"
            data-testid="popup-summarize-tab-btn"
            disabled={summarizing}
            onClick={() => void handleSummarizeTab()}
          >
            ✨ {summarizing ? 'Summarizing…' : tr(locale, 'popup.summarizeTab')}
          </button>

          <button
            type="button"
            className="btn danger"
            data-testid={CANONICAL_TEST_IDS.emergencyStopBtn}
            onClick={onEmergencyStop}
          >
            ⏹ {tr(locale, 'bridge.emergencyStop')}
          </button>
        </div>
      </div>

      <form className="row-gap-6" onSubmit={(e) => void handleQuickSend(e)}>
        <input
          ref={quickInputRef}
          className="input sm flex-1"
          data-testid="popup-quick-prompt-input"
          value={quickPrompt}
          onChange={(e) => setQuickPrompt(e.target.value)}
          placeholder="Ask Hermes Copilot or /browser status…"
        />
        <button type="submit" className="btn sm primary">
          {tr(locale, 'composer.send')}
        </button>
      </form>

      {latestCopilotReply && (
        <div
          className="popup-summary-card"
          data-testid="popup-summary-output"
        >
          <div className="muted-xs">🤖 Hermes Copilot:</div>
          <div className="popup-reply-text">{latestCopilotReply.text}</div>
        </div>
      )}

      <PendingApprovalBannerList items={pendingApprovals} onDecision={onApprovalDecision} />

      <div className="popup-chats-box">
        <div className="row-between muted-xs">
          <span>
            {tr(locale, 'popup.unreadChats')} ({state.unread_total} unread)
          </span>
          <span>Tabs: {state.active_tabs_count}</span>
        </div>
        <div className="popup-chats-scroll">
          {dialogs.slice(0, 5).map((d) => (
            <button
              key={d.chat_id}
              type="button"
              className="dialog-row compact"
              data-chat-id={d.chat_id}
              onClick={() =>
                chrome.tabs.create({
                  url: chrome.runtime.getURL(`workspace.html#chat=${d.chat_id}`),
                  active: true,
                })
              }
            >
              <span className="dialog-title flex-1 text-left">{d.title}</span>
              {d.unread_count > 0 && <span className="unread-badge xs">{d.unread_count}</span>}
            </button>
          ))}
        </div>
      </div>

      <footer className="popup-footer">
        <button
          type="button"
          className="btn primary flex-1"
          data-testid="popup-open-workspace-btn"
          onClick={() =>
            chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html'), active: true })
          }
        >
          {tr(locale, 'popup.openWorkspace')}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="popup-open-options-btn"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          {tr(locale, 'popup.openOptions')}
        </button>
      </footer>
    </div>
  );
}
