import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  type BrowserRunPolicy,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../../shared/rpc_types';
import { apiRequest } from '../api/server_api';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';
import { CanonicalComposer } from './CanonicalComposer';
import { MessageCard } from './MessageCard';

export function PendingApprovalBannerList({
  items,
  onDecision,
}: {
  items: PendingBrowserCommandDto[];
  onDecision: (commandId: string, approved: boolean, rememberForSession: boolean) => void;
}) {
  const [rememberMap, setRememberMap] = useState<Record<string, boolean>>({});
  if (items.length === 0) return null;

  return (
    <div className="approval-stack">
      {items.map((cmd) => {
        const remember = Boolean(rememberMap[cmd.command_id]);
        return (
          <div
            key={cmd.command_id}
            className={`approval-card ${cmd.injection_flagged ? 'escalated' : ''}`}
            role="alert"
            data-testid={CANONICAL_TEST_IDS.browserApprovalCard}
            data-command-id={cmd.command_id}
          >
            <div className="approval-head">
              <strong>
                {cmd.injection_flagged
                  ? '⚠️ Escalated Security Approval: '
                  : '🔒 Browser Action Approval: '}
                <code>{cmd.tool}</code>
              </strong>
              <span className="risk-pill">{cmd.risk}</span>
            </div>
            <div className="approval-reason">
              {cmd.reason}
              {cmd.target_url ? ` — ${cmd.target_url}` : ''}
            </div>
            <div className="muted-xs">
              ID: <code>{cmd.command_id}</code> • Args: <code>{JSON.stringify(cmd.arguments)}</code>
            </div>
            <div className="approval-actions">
              {!cmd.injection_flagged && (
                <label className="checkbox-row xs">
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
                  <span>Remember for session</span>
                </label>
              )}
              <button
                type="button"
                className="btn success sm"
                data-testid={CANONICAL_TEST_IDS.browserApprovalApproveBtn}
                data-action="approve"
                onClick={() => onDecision(cmd.command_id, true, remember)}
              >
                Approve
              </button>
              {!cmd.injection_flagged && (
                <button
                  type="button"
                  className="btn primary sm"
                  data-testid={CANONICAL_TEST_IDS.browserApprovalSessionBtn}
                  data-action="approve-session"
                  onClick={() => onDecision(cmd.command_id, true, true)}
                >
                  Allow for Session
                </button>
              )}
              <button
                type="button"
                className="btn danger sm"
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

export function BridgeHeaderControls({
  state,
  locale,
  compact,
  onPolicyChange,
  onEmergencyStop,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  compact?: boolean;
  onPolicyChange: (next: BrowserRunPolicy) => void;
  onEmergencyStop: () => void;
}) {
  const isStopped = state.emergency_stopped || state.run_policy === 'disabled';
  const statusText = isStopped
    ? tr(locale, 'bridge.stopped')
    : state.server_relay_connected && state.desktop_bridge_connected
      ? `${tr(locale, 'bridge.online')} (Relay+Desktop)`
      : state.server_relay_connected
        ? tr(locale, 'bridge.relay')
        : state.desktop_bridge_connected
          ? tr(locale, 'bridge.desktop')
          : tr(locale, 'bridge.online');

  return (
    <div className={`bridge-controls-bar ${compact ? 'compact' : ''}`}>
      <span
        data-testid={CANONICAL_TEST_IDS.browserBridgeStatusPill}
        data-status={isStopped ? 'stopped' : 'ready'}
        className={`status-pill ${isStopped ? 'stopped' : 'ok'}`}
      >
        {statusText}
      </span>

      <select
        className="select sm"
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

      <button
        type="button"
        className="btn danger sm"
        data-testid={CANONICAL_TEST_IDS.emergencyStopBtn}
        title="Emergency Stop (Alt+Shift+S)"
        onClick={onEmergencyStop}
      >
        {compact ? '⏹ Stop' : tr(locale, 'bridge.emergencyStop')}
      </button>
    </div>
  );
}

export function ConversationStage({
  surface,
  state,
  locale,
  activeDialog,
  selectedTopicId,
  messages,
  pendingApprovals,
  inspectorOpen,
  onPolicyChange,
  onEmergencyStop,
  onApprovalDecision,
  onToggleInspector,
  onOpenBotStudio,
  onOpenMiniAppPicker,
  onOpenMiniAppUrl,
  onStartCall,
  onStartTalkMode,
  onOpenPollModal,
  onOpenForwardModal,
  onOpenE2eeVerify,
  onMessagesMutated,
}: {
  surface: 'workspace' | 'sidepanel';
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  activeDialog: StoredDialogDto | null;
  selectedTopicId: number | null;
  messages: StoredMessageDto[];
  pendingApprovals: PendingBrowserCommandDto[];
  inspectorOpen: boolean;
  onPolicyChange: (next: BrowserRunPolicy) => void;
  onEmergencyStop: () => void;
  onApprovalDecision: (cmdId: string, approved: boolean, remember: boolean) => void;
  onToggleInspector: () => void;
  onOpenBotStudio: () => void;
  onOpenMiniAppPicker: () => void;
  onOpenMiniAppUrl: (url: string, title?: string) => void;
  onStartCall: (video: boolean) => void;
  onStartTalkMode: () => void;
  onOpenPollModal: () => void;
  onOpenForwardModal: (msg: StoredMessageDto) => void;
  onOpenE2eeVerify: () => void;
  onMessagesMutated: () => Promise<void> | void;
}) {
  const chatId = activeDialog?.chat_id ?? LOCAL_COPILOT_CHAT_ID;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [composerText, setComposerText] = useState('');
  const [replyingTo, setReplyingTo] = useState<StoredMessageDto | null>(null);
  const [editingMsg, setEditingMsg] = useState<StoredMessageDto | null>(null);
  const [inChatSearchOpen, setInChatSearchOpen] = useState(false);
  const [inChatQuery, setInChatQuery] = useState('');
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [pinnedBannerMsg, setPinnedBannerMsg] = useState<StoredMessageDto | null>(null);

  // Reset per-chat ephemeral edit/reply when switching dialogs
  useEffect(() => {
    setReplyingTo(null);
    setEditingMsg(null);
    setInChatSearchOpen(false);
    setInChatQuery('');
  }, [chatId]);

  // Auto-scroll to newest message
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, chatId]);

  // Resolve pinned message banner
  useEffect(() => {
    const fromLocal = [...messages].reverse().find((m) => m.pinned);
    if (fromLocal) {
      setPinnedBannerMsg(fromLocal);
      return;
    }
    if (activeDialog?.pinned_message_id && activeDialog.pinned_message_preview) {
      setPinnedBannerMsg({
        chat_id: chatId,
        message_id: activeDialog.pinned_message_id,
        sender_id: 0,
        text: activeDialog.pinned_message_preview,
        created_at_ms: Date.now(),
        pinned: true,
      });
      return;
    }
    setPinnedBannerMsg(null);
  }, [activeDialog?.pinned_message_id, activeDialog?.pinned_message_preview, chatId, messages]);

  const filteredMessages = useMemo(() => {
    let list = messages;
    if (selectedTopicId !== null) {
      list = list.filter((m) => !m.topic_id || m.topic_id === selectedTopicId);
    }
    const q = inChatQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => (m.text ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [inChatQuery, messages, selectedTopicId]);

  const messageMap = useMemo(() => {
    const m = new Map<number, StoredMessageDto>();
    for (const item of messages) {
      m.set(item.message_id, item);
    }
    return m;
  }, [messages]);

  const handleSendOrEdit = async (opts: {
    text: string;
    content?: Record<string, any> | null;
    mediaId?: string | null;
  }) => {
    if (editingMsg && chatId > 0 && editingMsg.message_id > 0) {
      const targetId = editingMsg.message_id;
      setEditingMsg(null);
      await apiRequest(`/api/v1/chats/${chatId}/messages/${targetId}`, {
        method: 'PUT',
        body: { chat_id: chatId, text: opts.text },
      });
      await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
      await onMessagesMutated();
      return;
    }

    const replyId = replyingTo?.message_id ?? null;
    const quoteText = replyingTo?.text ? replyingTo.text.slice(0, 140) : null;
    setReplyingTo(null);

    await sendSwRpc({
      type: 'ui.send_message',
      surface,
      chat_id: chatId,
      text: opts.text,
      reply_to_message_id: replyId && replyId > 0 ? replyId : null,
      quote_text: quoteText,
      topic_id: selectedTopicId,
      content: opts.content ?? null,
      media_id: opts.mediaId ?? null,
      use_local_bot: chatId === LOCAL_COPILOT_CHAT_ID,
    });
  };

  const handleReact = async (msg: StoredMessageDto, emoji: string) => {
    if (chatId <= 0 || msg.message_id <= 0) return;
    await apiRequest(`/api/v1/chats/${chatId}/messages/${msg.message_id}/reactions`, {
      method: 'POST',
      body: { emoji },
    });
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onMessagesMutated();
  };

  const handleTogglePin = async (msg: StoredMessageDto) => {
    if (chatId <= 0 || msg.message_id <= 0) return;
    if (msg.pinned) {
      await apiRequest(`/api/v1/chats/${chatId}/pins/${msg.message_id}`, { method: 'DELETE' });
      setPinnedBannerMsg(null);
    } else {
      await apiRequest(`/api/v1/chats/${chatId}/pins`, {
        method: 'POST',
        body: { message_id: msg.message_id },
      });
      setPinnedBannerMsg({ ...msg, pinned: true });
    }
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onMessagesMutated();
  };

  const handleDeleteMsg = async (msg: StoredMessageDto) => {
    if (chatId > 0 && msg.message_id > 0) {
      await apiRequest('/api/v1/messages/delete', {
        method: 'POST',
        body: { chat_id: chatId, message_ids: [msg.message_id], revoke: true },
      });
      await apiRequest(`/api/v1/chats/${chatId}/messages/${msg.message_id}`, {
        method: 'DELETE',
      });
    }
    await sendSwRpc({
      type: 'ui.delete_messages',
      chat_id: chatId,
      message_ids: [msg.message_id],
    });
    await onMessagesMutated();
  };

  const handleVotePoll = async (pollId: string | number, optionIds: number[]) => {
    await apiRequest(`/api/v1/polls/${encodeURIComponent(String(pollId))}/vote`, {
      method: 'POST',
      body: {
        option_ids: optionIds,
        option_index: optionIds[0] ?? 0,
      },
    });
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onMessagesMutated();
  };

  const handleClosePoll = async (pollId: string | number) => {
    await apiRequest(`/api/v1/polls/${encodeURIComponent(String(pollId))}/close`, {
      method: 'POST',
      body: {},
    });
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onMessagesMutated();
  };

  const handleCallbackBtn = async (msg: StoredMessageDto, callbackData: string) => {
    if (chatId <= 0) return;
    await apiRequest(`/api/v1/chats/${chatId}/callback`, {
      method: 'POST',
      body: {
        message_id: msg.message_id,
        callback_data: callbackData,
        data: callbackData,
      },
    });
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onMessagesMutated();
  };

  const handleTranslate = (msg: StoredMessageDto) => {
    setTranslations((prev) => ({
      ...prev,
      [msg.message_id]:
        locale === 'zh-CN'
          ? `[中文翻译] ${msg.text}`
          : `[Translated EN] ${msg.text}`,
    }));
  };

  const isBotDialog = Boolean(
    activeDialog?.is_bot || activeDialog?.chat_type === 'bot' || chatId === LOCAL_COPILOT_CHAT_ID,
  );

  return (
    <main
      className={`conversation-stage ${surface === 'sidepanel' ? 'sidepanel-stage' : ''}`}
      data-testid={CANONICAL_TEST_IDS.conversationStage}
      data-active-chat-id={chatId}
    >
      {/* Top Conversation & Bridge Bar */}
      <header className="stage-topbar">
        <div className="stage-peer-info">
          <div className="dialog-avatar sm">
            {chatId === LOCAL_COPILOT_CHAT_ID
              ? '🤖'
              : (activeDialog?.title || 'TG').slice(0, 2).toUpperCase()}
          </div>
          <div className="stage-title-col">
            <div className="stage-chat-title" data-testid="stage-chat-title">
              {activeDialog?.title || tr(locale, 'sidebar.localCopilot')}
              {selectedTopicId !== null && (
                <span className="topic-tag"> #{selectedTopicId}</span>
              )}
            </div>
            <div className="stage-chat-sub">
              {activeDialog?.peer_username
                ? `@${activeDialog.peer_username}`
                : activeDialog?.chat_type || 'ready'}
              {state.server_ws_connected ? ' • sync live' : ''}
            </div>
          </div>
        </div>

        <div className="stage-actions-group">
          <BridgeHeaderControls
            state={state}
            locale={locale}
            compact={surface === 'sidepanel'}
            onPolicyChange={onPolicyChange}
            onEmergencyStop={onEmergencyStop}
          />

          {isBotDialog && (
            <button
              type="button"
              className="btn sm primary-soft"
              data-testid="stage-open-miniapp-btn"
              title={tr(locale, 'stage.openMiniApp')}
              onClick={onOpenMiniAppPicker}
            >
              🧩 {surface === 'workspace' ? tr(locale, 'stage.openMiniApp') : 'App'}
            </button>
          )}

          {isBotDialog && surface === 'workspace' && chatId > 0 && (
            <button
              type="button"
              className="btn sm"
              data-testid="stage-bot-studio-btn"
              onClick={onOpenBotStudio}
            >
              🤖 {tr(locale, 'stage.botStudio')}
            </button>
          )}

          {surface === 'workspace' && (
            <>
              <button
                type="button"
                className="btn ghost icon-sm"
                data-testid="stage-voice-call-btn"
                title={tr(locale, 'stage.startCall')}
                onClick={() => onStartCall(false)}
              >
                📞
              </button>
              <button
                type="button"
                className="btn ghost icon-sm"
                data-testid="stage-talk-mode-btn"
                title={tr(locale, 'stage.talkMode')}
                onClick={onStartTalkMode}
              >
                🎙️
              </button>
              <button
                type="button"
                className="btn ghost icon-sm"
                data-testid="stage-search-btn"
                title={tr(locale, 'stage.searchInChat')}
                onClick={() => setInChatSearchOpen((v) => !v)}
              >
                🔍
              </button>
              <button
                type="button"
                className="btn ghost icon-sm"
                data-testid="stage-e2ee-btn"
                title={tr(locale, 'stage.e2eeVerified')}
                onClick={onOpenE2eeVerify}
              >
                🔐
              </button>
              <button
                type="button"
                className={`btn ghost icon-sm ${inspectorOpen ? 'active' : ''}`}
                data-testid="toggle-inspector-btn"
                title={tr(locale, 'stage.toggleInspector')}
                onClick={onToggleInspector}
              >
                ◫
              </button>
            </>
          )}
        </div>
      </header>

      {/* In-Chat Search Bar */}
      {inChatSearchOpen && (
        <div className="in-chat-search-bar" data-testid="in-chat-search-bar">
          <input
            className="input sm flex-1"
            autoFocus
            data-testid="in-chat-search-input"
            value={inChatQuery}
            onChange={(e) => setInChatQuery(e.target.value)}
            placeholder="Find in conversation…"
          />
          <span className="muted-xs">{filteredMessages.length} matches</span>
          <button
            type="button"
            className="btn ghost xs"
            onClick={() => {
              setInChatSearchOpen(false);
              setInChatQuery('');
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Sticky Pinned Message Banner */}
      {pinnedBannerMsg && (
        <div className="pinned-banner" data-testid="pinned-message-banner">
          <div className="pinned-banner-content">
            <span className="pinned-label">📌 {tr(locale, 'stage.pinnedMessage')}</span>
            <span className="pinned-preview">{pinnedBannerMsg.text}</span>
          </div>
          <button
            type="button"
            className="btn ghost xs"
            aria-label="Unpin message"
            onClick={() => void handleTogglePin(pinnedBannerMsg)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Scrollable Transcript Stream */}
      <div className="messages-scroll" ref={scrollRef} data-testid="messages-transcript">
        <PendingApprovalBannerList items={pendingApprovals} onDecision={onApprovalDecision} />

        {filteredMessages.length === 0 ? (
          <div className="empty-stage-placeholder" data-testid="empty-stage-state">
            <div className="empty-icon">✈️</div>
            <div>
              {chatId === LOCAL_COPILOT_CHAT_ID
                ? 'Hermes Browser Copilot Ready — try /browser status or @page'
                : tr(locale, 'stage.selectChat')}
            </div>
          </div>
        ) : (
          filteredMessages.map((msg, idx) => {
            const isMine =
              (state.user_id !== null && msg.sender_id === state.user_id) ||
              (chatId === LOCAL_COPILOT_CHAT_ID && msg.sender_id === 0);
            const prev = idx > 0 ? filteredMessages[idx - 1] : null;
            const dayLabel = new Date(msg.created_at_ms || Date.now()).toLocaleDateString();
            const prevDay = prev
              ? new Date(prev.created_at_ms || Date.now()).toLocaleDateString()
              : '';
            const showDateHeader = dayLabel !== prevDay;
            const replyTarget = msg.reply_to_message_id
              ? messageMap.get(msg.reply_to_message_id)?.text
              : undefined;

            return (
              <React.Fragment key={`${msg.chat_id}:${msg.message_id}:${msg.client_nonce ?? idx}`}>
                {showDateHeader && (
                  <div className="sticky-date-pill" data-testid="transcript-date-pill">
                    {dayLabel}
                  </div>
                )}
                <MessageCard
                  msg={msg}
                  isMine={isMine}
                  locale={locale}
                  replyTargetPreview={replyTarget}
                  translatedText={translations[msg.message_id]}
                  onReply={(target) => {
                    setEditingMsg(null);
                    setReplyingTo(target);
                  }}
                  onEdit={(target) => {
                    setReplyingTo(null);
                    setEditingMsg(target);
                    setComposerText(target.text ?? '');
                  }}
                  onTogglePin={(target) => void handleTogglePin(target)}
                  onForward={(target) => onOpenForwardModal(target)}
                  onDelete={(target) => void handleDeleteMsg(target)}
                  onTranslate={handleTranslate}
                  onReact={(target, emo) => void handleReact(target, emo)}
                  onVotePoll={(pid, opts) => void handleVotePoll(pid, opts)}
                  onClosePoll={(pid) => void handleClosePoll(pid)}
                  onCallbackButton={(target, cb) => void handleCallbackBtn(target, cb)}
                  onOpenMiniAppUrl={onOpenMiniAppUrl}
                  onStartCall={onStartCall}
                  onOpenE2eeVerify={onOpenE2eeVerify}
                />
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Canonical Composer */}
      <CanonicalComposer
        locale={locale}
        surface={surface}
        chatId={chatId}
        botStreaming={state.bot_streaming}
        composerText={composerText}
        replyingTo={replyingTo}
        editingMessage={editingMsg}
        onComposerTextChange={setComposerText}
        onCancelReplyOrEdit={() => {
          if (editingMsg) setComposerText('');
          setEditingMsg(null);
          setReplyingTo(null);
        }}
        onEditLastOwnMessage={() => {
          const own = [...messages]
            .reverse()
            .find((m) => state.user_id !== null && m.sender_id === state.user_id && m.message_id > 0);
          if (own) {
            setEditingMsg(own);
            setComposerText(own.text ?? '');
          }
        }}
        onSendMessage={handleSendOrEdit}
        onStopStreaming={async () => {
          await sendSwRpc({ type: 'ui.stop_bot' });
        }}
        onOpenPollModal={onOpenPollModal}
      />
    </main>
  );
}
