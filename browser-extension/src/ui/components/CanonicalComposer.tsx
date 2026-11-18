import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  isRestrictedTabUrl,
  type ExtensionLocale,
  type StoredMessageDto,
} from '../../shared/rpc_types';
import { invokeWasm } from '../../wasm/wasm_bridge';
import { uploadMediaFile } from '../api/server_api';
import { HERMES_SLASH_COMMANDS } from '../data/slash_commands';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';

export interface AttachedPageContext {
  tabId: number;
  title: string;
  url: string;
  markdownExcerpt: string;
}

const QUICK_EMOJIS = ['😀', '🚀', '👍', '❤️', '🔥', '🎉', '✨', '🤖', '✅', '🧠'];

export function CanonicalComposer({
  locale,
  surface,
  chatId,
  botStreaming,
  composerText,
  replyingTo,
  editingMessage,
  onComposerTextChange,
  onCancelReplyOrEdit,
  onEditLastOwnMessage,
  onSendMessage,
  onStopStreaming,
  onOpenPollModal,
}: {
  locale: ExtensionLocale;
  surface: 'workspace' | 'sidepanel';
  chatId: number;
  botStreaming: boolean;
  composerText: string;
  replyingTo: StoredMessageDto | null;
  editingMessage: StoredMessageDto | null;
  onComposerTextChange: (next: string) => void;
  onCancelReplyOrEdit: () => void;
  onEditLastOwnMessage: () => void;
  onSendMessage: (opts: {
    text: string;
    content?: Record<string, any> | null;
    mediaId?: string | null;
  }) => Promise<void>;
  onStopStreaming: () => Promise<void>;
  onOpenPollModal: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  const [slashDismissedForPrefix, setSlashDismissedForPrefix] = useState<string | null>(null);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashNavigatedByArrow, setSlashNavigatedByArrow] = useState(false);

  const [attachedPage, setAttachedPage] = useState<AttachedPageContext | null>(null);
  const [attachingPage, setAttachingPage] = useState(false);
  const [activeTabRestricted, setActiveTabRestricted] = useState(false);
  const [warningMsg, setWarningMsg] = useState('');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Strictly clamp composer height between 44px and 192px (T2-F13-03)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '44px';
    const clamped = Math.min(192, Math.max(44, el.scrollHeight));
    el.style.height = `${clamped}px`;
  }, [composerText]);

  const matchingSlashCommands = useMemo(() => {
    if (!composerText.startsWith('/')) return [];
    if (slashDismissedForPrefix === composerText) return [];
    const q = composerText.trim().toLowerCase();
    return HERMES_SLASH_COMMANDS.filter(
      (entry) =>
        entry.cmd.toLowerCase().startsWith(q) ||
        `${entry.cmd} ${entry.args ?? ''}`.toLowerCase().startsWith(q) ||
        entry.descEn.toLowerCase().includes(q.slice(1)),
    );
  }, [composerText, slashDismissedForPrefix]);

  useEffect(() => {
    setSlashSelectedIdx(0);
    setSlashNavigatedByArrow(false);
  }, [composerText]);

  const inspectActiveExternalTab = async (): Promise<chrome.tabs.Tab | undefined> => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return undefined;
    const tabs = await chrome.tabs.query({});
    const externalTabs = tabs.filter(
      (t) => t.url && !t.url.startsWith('chrome-extension://'),
    );
    // Always inspect the genuinely active external tab first so restricted `chrome://` tabs
    // are never silently bypassed in favor of an inactive background tab (T2-F13-06).
    return (
      externalTabs.find((t) => t.active) ??
      externalTabs.find((t) => !isRestrictedTabUrl(t.url)) ??
      externalTabs[0]
    );
  };

  useEffect(() => {
    let cancelled = false;
    const checkRestriction = async () => {
      try {
        const activeTab = await inspectActiveExternalTab();
        if (cancelled) return;
        const restricted = Boolean(!activeTab || isRestrictedTabUrl(activeTab.url));
        setActiveTabRestricted(restricted);
        if (restricted && /(?:^|\s)@page\b/i.test(composerText)) {
          setWarningMsg(tr(locale, 'composer.restrictedTab'));
        }
      } catch {
        // ignore tab query errors in restricted contexts
      }
    };
    void checkRestriction();
    const onFocus = () => void checkRestriction();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [composerText, locale]);

  const fetchActivePageContext = async (): Promise<AttachedPageContext | null> => {
    const targetTab = await inspectActiveExternalTab();
    if (!targetTab || isRestrictedTabUrl(targetTab.url)) {
      setActiveTabRestricted(true);
      setWarningMsg(tr(locale, 'composer.restrictedTab'));
      return null;
    }
    setActiveTabRestricted(false);

    const rpcRes = await sendSwRpc<{
      ok: boolean;
      result?: Record<string, any>;
      error?: string;
    }>({
      type: 'ui.invoke_browser_tool',
      tool: 'browser_extract_markdown',
      arguments: { tab_id: targetTab.id, max_chars: 2000 },
      bypass_approval: true,
    });

    if (!rpcRes.ok) {
      setWarningMsg(rpcRes.error || tr(locale, 'composer.restrictedTab'));
      return null;
    }

    const md = String(rpcRes.result?.markdown ?? rpcRes.result?.markdown_excerpt ?? '').slice(
      0,
      1800,
    );
    return {
      tabId: targetTab.id ?? 0,
      title: String(rpcRes.result?.title || targetTab.title || 'Active Page'),
      url: String(rpcRes.result?.url || targetTab.url || ''),
      markdownExcerpt: md,
    };
  };

  const handleAttachActivePage = async () => {
    setWarningMsg('');
    setAttachingPage(true);
    try {
      const ctx = await fetchActivePageContext();
      if (ctx) {
        setAttachedPage(ctx);
      }
    } catch (err: any) {
      setWarningMsg(String(err?.message ?? tr(locale, 'composer.restrictedTab')));
    } finally {
      setAttachingPage(false);
    }
  };

  const triggerSend = async () => {
    const raw = composerText.trim();
    if (!raw && !attachedPage) return;

    let pageCtx = attachedPage;
    if (!pageCtx && /(?:^|\s)@page\b/i.test(raw)) {
      const resolved = await fetchActivePageContext().catch(() => null);
      if (resolved) {
        pageCtx = resolved;
      } else {
        // Active tab is restricted (`chrome://`); block sending broken @page context and keep notice visible
        return;
      }
    }

    let finalBody = raw;
    if (pageCtx) {
      const ctxBlock = `[Attached @page: ${pageCtx.title} (${pageCtx.url})]\n${pageCtx.markdownExcerpt}`;
      finalBody = finalBody ? `${finalBody}\n\n${ctxBlock}` : ctxBlock;
    }

    onComposerTextChange('');
    setAttachedPage(null);
    setWarningMsg('');
    await onSendMessage({ text: finalBody });
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingMedia(true);
    setWarningMsg('');
    const up = await uploadMediaFile(file, file.name);
    setUploadingMedia(false);
    if (!up.ok) {
      setWarningMsg(`Upload failed: ${up.error ?? 'error'}`);
      return;
    }
    const mediaId = String(
      up.data?.media_id ?? up.data?.file_id ?? up.data?.id ?? '',
    ).trim();
    const caption = composerText.trim() || `📎 ${file.name}`;
    onComposerTextChange('');
    await onSendMessage({
      text: caption,
      mediaId: mediaId || null,
      content: {
        type: file.type.startsWith('image/')
          ? 'photo'
          : file.type.startsWith('video/')
            ? 'video'
            : 'document',
        media_id: mediaId,
        file_id: mediaId,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        caption,
      },
    });
  };

  const handleSendSyntheticVoiceNote = async () => {
    const sampleBars = Array.from({ length: 100 }, (_, i) =>
      Math.min(31, Math.max(3, Math.round(15 + 13 * Math.sin(i * 0.24)))),
    );
    const enc = await invokeWasm<{ encoded_b64?: string }>('waveform_encode_5bit', {
      bars: sampleBars,
    });
    const waveformB64 = enc.ok && enc.data?.encoded_b64 ? enc.data.encoded_b64 : '';
    await onSendMessage({
      text: '🎤 Voice message (0:04)',
      content: {
        type: 'voice',
        duration_secs: 4,
        mime_type: 'audio/ogg',
        waveform_b64: waveformB64,
      },
    });
  };

  const showSlashPopup = matchingSlashCommands.length > 0;

  return (
    <div className="composer-container" data-testid="canonical-composer">
      {/* Reply / Edit Context Banner */}
      {(replyingTo || editingMessage) && (
        <div
          className="composer-Banner"
          data-testid={editingMessage ? 'composer-edit-banner' : 'composer-reply-banner'}
        >
          <div className="banner-text">
            <strong>
              {editingMessage
                ? `✏️ ${tr(locale, 'stage.editingMsg')} #${editingMessage.message_id}`
                : `↩ ${tr(locale, 'stage.replyingTo')} ${replyingTo?.sender_username ? `@${replyingTo.sender_username}` : `#${replyingTo?.message_id}`}`}
            </strong>
            <div className="muted-xs truncate-1">
              {(editingMessage ?? replyingTo)?.text?.slice(0, 120)}
            </div>
          </div>
          <button
            type="button"
            className="btn ghost xs"
            data-testid="cancel-reply-edit-btn"
            aria-label="Cancel reply or edit"
            onClick={onCancelReplyOrEdit}
          >
            ✕
          </button>
        </div>
      )}

      {/* Attached `@page` Active Tab Chip */}
      {attachedPage && (
        <div className="composer-Banner accent" data-testid="attached-page-chip">
          <div className="banner-text">
            <strong>
              🌐 {tr(locale, 'stage.attachedPage')}: {attachedPage.title}
            </strong>
            <div className="muted-xs truncate-1">{attachedPage.url}</div>
          </div>
          <button
            type="button"
            className="btn ghost xs"
            aria-label="Remove attached page"
            onClick={() => setAttachedPage(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Non-Fatal Warning Banner (e.g. Restricted chrome:// Tab on @page) */}
      {warningMsg && (
        <div className="composer-warning-banner" role="alert" data-testid="composer-warning-banner">
          <span>⚠️ {warningMsg}</span>
          <button type="button" className="btn ghost xs" onClick={() => setWarningMsg('')}>
            ✕
          </button>
        </div>
      )}

      {/* 56+ Hermes Slash Commands Autocomplete Popup */}
      {showSlashPopup && (
        <div
          className="slash-popup"
          role="listbox"
          data-testid={CANONICAL_TEST_IDS.slashCommandPopup}
        >
          {matchingSlashCommands.map((entry, idx) => (
            <button
              key={entry.cmd}
              type="button"
              role="option"
              aria-selected={idx === slashSelectedIdx}
              data-slash-cmd={entry.cmd}
              data-command={entry.cmd}
              className={`slash-item-btn ${idx === slashSelectedIdx ? 'active' : ''}`}
              onClick={() => {
                onComposerTextChange(`${entry.cmd} `);
                setSlashDismissedForPrefix(`${entry.cmd} `);
                textareaRef.current?.focus();
              }}
            >
              <div className="slash-cmd-head">
                <code className="slash-cmd-name">{entry.cmd}</code>
                {entry.args && <span className="slash-cmd-args">{entry.args}</span>}
                <span className="slash-cat-pill">{entry.category}</span>
              </div>
              <div className="slash-cmd-desc">
                {locale === 'zh-CN' ? entry.descZh : entry.descEn}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Quick Emoji Picker Popover */}
      {emojiOpen && (
        <div className="emoji-picker-popover" data-testid="composer-emoji-popover">
          {QUICK_EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              className="emoji-react-btn"
              onClick={() => {
                onComposerTextChange(`${composerText}${em}`);
                setEmojiOpen(false);
                textareaRef.current?.focus();
              }}
            >
              {em}
            </button>
          ))}
        </div>
      )}

      <div className="composer-input-row">
        <input
          ref={fileInputRef}
          type="file"
          hidden
          data-testid="composer-file-input"
          onChange={(e) => void handleFileSelected(e)}
        />

        <button
          type="button"
          className="btn ghost icon-sm"
          data-testid="composer-attach-btn"
          title={tr(locale, 'composer.attachMedia')}
          disabled={uploadingMedia}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>

        <button
          type="button"
          className="btn ghost xs page-chip-btn"
          data-testid="attach-page-btn"
          title={
            activeTabRestricted
              ? tr(locale, 'composer.restrictedTab')
              : tr(locale, 'composer.attachPage')
          }
          disabled={attachingPage || activeTabRestricted}
          onClick={() => void handleAttachActivePage()}
        >
          @page
        </button>

        {chatId > 0 && surface === 'workspace' && (
          <button
            type="button"
            className="btn ghost icon-sm"
            data-testid="composer-poll-btn"
            title={tr(locale, 'composer.createPoll')}
            onClick={onOpenPollModal}
          >
            📊
          </button>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          className="composer-textarea"
          data-testid={CANONICAL_TEST_IDS.canonicalComposerInput}
          value={composerText}
          onChange={(e) => {
            setSlashDismissedForPrefix(null);
            onComposerTextChange(e.target.value);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(e) => {
            // Respect CJK IME active composition (T1-F10-05)
            if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
              return;
            }

            if (showSlashPopup) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashNavigatedByArrow(true);
                setSlashSelectedIdx((i) => (i + 1) % matchingSlashCommands.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashNavigatedByArrow(true);
                setSlashSelectedIdx(
                  (i) => (i - 1 + matchingSlashCommands.length) % matchingSlashCommands.length,
                );
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && slashNavigatedByArrow && !e.shiftKey)) {
                e.preventDefault();
                const picked = matchingSlashCommands[slashSelectedIdx] ?? matchingSlashCommands[0];
                if (picked) {
                  onComposerTextChange(`${picked.cmd} `);
                  setSlashDismissedForPrefix(`${picked.cmd} `);
                  setSlashNavigatedByArrow(false);
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setSlashDismissedForPrefix(composerText);
                return;
              }
            }

            if (e.key === 'Escape' && (replyingTo || editingMessage)) {
              e.preventDefault();
              e.stopPropagation();
              onCancelReplyOrEdit();
              return;
            }

            if (e.key === 'ArrowUp' && composerText.length === 0 && !editingMessage) {
              e.preventDefault();
              onEditLastOwnMessage();
              return;
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void triggerSend();
            }
          }}
          placeholder={tr(locale, 'composer.placeholder')}
        />

        <button
          type="button"
          className="btn ghost icon-sm"
          data-testid="composer-emoji-btn"
          title="Emoji"
          onClick={() => setEmojiOpen((v) => !v)}
        >
          😊
        </button>

        <button
          type="button"
          className="btn ghost icon-sm"
          data-testid="composer-voice-btn"
          title={tr(locale, 'composer.voiceNote')}
          onClick={() => void handleSendSyntheticVoiceNote()}
        >
          🎙️
        </button>

        {botStreaming && (
          <button
            type="button"
            className="btn danger sm"
            data-testid={CANONICAL_TEST_IDS.composerStopBtn}
            aria-label="Stop generation"
            onClick={() => void onStopStreaming()}
          >
            ⏹ {tr(locale, 'composer.stop')}
          </button>
        )}

        <button
          type="button"
          className="btn primary send-btn"
          data-testid={CANONICAL_TEST_IDS.composerSendBtn}
          disabled={!composerText.trim() && !attachedPage}
          onClick={() => void triggerSend()}
        >
          {editingMessage ? '✓' : tr(locale, 'composer.send')}
        </button>
      </div>
    </div>
  );
}
