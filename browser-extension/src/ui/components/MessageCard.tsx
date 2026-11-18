import React, { useEffect, useMemo, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  type ExtensionLocale,
  type StoredMessageDto,
  type StoredToolStepDto,
} from '../../shared/rpc_types';
import { invokeWasm } from '../../wasm/wasm_bridge';
import { apiRequest, fetchAuthenticatedMediaBlobUrl } from '../api/server_api';
import { sanitizeHexColor } from '../theme/palettes';
import { tr } from '../i18n/translations';

class CardErrorBoundary extends React.Component<
  { fallbackText: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallbackText: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="card-fallback-box" data-testid="message-fallback-card">
          ⚠️ {this.props.fallbackText || 'Unsupported message payload'}
        </div>
      );
    }
    return this.props.children;
  }
}

export function extractThinkingAndCleanBody(
  rawText: string,
  explicitThinking?: string,
): { thinking: string; cleanText: string; extractedSteps: StoredToolStepDto[] } {
  const thinkParts: string[] = [];
  if (explicitThinking && explicitThinking.trim()) {
    thinkParts.push(explicitThinking.trim());
  }

  let working = String(rawText ?? '');

  // Strip closed [STATE_PATCH]...[/STATE_PATCH] and unclosed trailing [STATE_PATCH]...
  working = working.replace(/\[STATE_PATCH\][\s\S]*?\[\/STATE_PATCH\]/gi, '');
  const unclosedPatchIdx = working.indexOf('[STATE_PATCH]');
  if (unclosedPatchIdx !== -1) {
    working = working.slice(0, unclosedPatchIdx);
  }

  // Extract server-formatted `💭 **思考过程**\n> ...` blocks
  working = working.replace(
    /💭\s*\*\*思考过程\*\*\r?\n((?:>[ \t]?[^\r\n]*(?:\r?\n|$))+)/g,
    (_m, inner) => {
      const cleaned = String(inner ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/^>[ \t]?/, ''))
        .join('\n')
        .trim();
      if (cleaned && !thinkParts.includes(cleaned)) {
        thinkParts.push(cleaned);
      }
      return '';
    },
  );

  // Extract server-formatted `🔧 **执行步骤 (x/y)**` blocks into structured ToolStepDto items
  const extractedSteps: StoredToolStepDto[] = [];
  working = working.replace(
    /🔧\s*\*\*执行步骤\s*\(\d+\/\d+\)\*\*\r?\n((?:(?:\d+\.\s*[⏳✅❌][^\r\n]*|…已折叠[^\r\n]*)(?:\r?\n|$))+)/g,
    (_m, block) => {
      const lines = String(block ?? '').split(/\r?\n/);
      for (const ln of lines) {
        const sm = /^(\d+)\.\s*([⏳✅❌])\s*`([^`]+)`(.*)$/.exec(ln.trim());
        if (sm) {
          const idxStr = sm[1]!;
          const icon = sm[2]!;
          const toolName = sm[3]!;
          const rest = String(sm[4] ?? '').trim();
          extractedSteps.push({
            id: `parsed-step-${idxStr}-${toolName}`,
            tool: toolName,
            args: {},
            status: icon === '⏳' ? 'running' : icon === '❌' ? 'error' : 'done',
            result_summary: rest || undefined,
          });
        }
      }
      return '';
    },
  );

  // Extract closed <think>...</think> blocks
  working = working.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    const trimmed = String(inner ?? '').trim();
    if (trimmed && !thinkParts.includes(trimmed)) thinkParts.push(trimmed);
    return '';
  });

  // Extract unclosed streaming <think>... tail
  const openThinkMatch = /<think>([\s\S]*)$/i.exec(working);
  if (openThinkMatch) {
    const tail = String(openThinkMatch[1] ?? '').trim();
    if (tail && !thinkParts.includes(tail)) thinkParts.push(tail);
    working = working.slice(0, openThinkMatch.index);
  }

  return {
    thinking: thinkParts.join('\n\n'),
    cleanText: working.trim(),
    extractedSteps,
  };
}

function isSafeExternalHref(rawHref: string): boolean {
  const s = String(rawHref ?? '').trim();
  if (!s) return false;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function SpoilerSpan({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={`spoiler-span ${revealed ? 'revealed' : ''}`}
      data-testid="spoiler-text"
      role="button"
      tabIndex={0}
      onClick={() => setRevealed((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setRevealed((v) => !v);
      }}
    >
      {text}
    </span>
  );
}

function CodeBlockCard({ lang, code, locale }: { lang: string; code: string; locale: ExtensionLocale }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore clipboard fallback in headless
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block-card" data-testid="code-block">
      <div className="code-block-header">
        <span className="code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="btn ghost xs"
          data-testid="copy-code-btn"
          onClick={() => void handleCopy()}
        >
          {copied ? `✓ ${tr(locale, 'msg.copied')}` : `📋 ${tr(locale, 'msg.copy')}`}
        </button>
      </div>
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInlineMarkdown(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(`[^`]+`|\*\*[^*]+\*\*|\|\|[^|]+\|\||~~[^~]+~~|\[([^\]]+)\]\(([^)]+)\)|\*[^*\s][^*]*\*)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const full = match[0];
    const k = `${keyPrefix}-${idx++}`;
    if (full.startsWith('`') && full.endsWith('`')) {
      nodes.push(
        <code key={k} className="inline-code">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (full.startsWith('**') && full.endsWith('**')) {
      nodes.push(<strong key={k}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('||') && full.endsWith('||')) {
      nodes.push(<SpoilerSpan key={k} text={full.slice(2, -2)} />);
    } else if (full.startsWith('~~') && full.endsWith('~~')) {
      nodes.push(<del key={k}>{full.slice(2, -2)}</del>);
    } else if (full.startsWith('[') && match[2] !== undefined && match[3] !== undefined) {
      const label = match[2];
      const href = match[3].trim();
      if (isSafeExternalHref(href)) {
        nodes.push(
          <a
            key={k}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="msg-link"
          >
            {label}
          </a>,
        );
      } else {
        // Dangerous schemes like javascript: rendered as inert text (T2-F13-01)
        nodes.push(<span key={k}>{label}</span>);
      }
    } else if (full.startsWith('*') && full.endsWith('*')) {
      nodes.push(<em key={k}>{full.slice(1, -1)}</em>);
    } else {
      nodes.push(full);
    }
    lastIndex = match.index + full.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

export function SafeMarkdownView({ text, locale }: { text: string; locale: ExtensionLocale }) {
  if (!text) return null;
  const blocks: React.ReactNode[] = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let bIdx = 0;

  const pushProse = (prose: string) => {
    const lines = prose.split('\n');
    lines.forEach((ln, i) => {
      const headingMatch = /^(#{1,4})\s+(.+)$/.exec(ln);
      if (headingMatch) {
        blocks.push(
          <div key={`hd-${bIdx}-${i}`} className="msg-md-heading">
            <strong>{renderInlineMarkdown(headingMatch[2]!, `hd-in-${bIdx}-${i}`)}</strong>
          </div>,
        );
        return;
      }
      blocks.push(
        <React.Fragment key={`ln-${bIdx}-${i}`}>
          {renderInlineMarkdown(ln, `in-${bIdx}-${i}`)}
          {i < lines.length - 1 ? <br /> : null}
        </React.Fragment>,
      );
    });
    bIdx++;
  };

  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIdx) {
      pushProse(text.slice(lastIdx, m.index));
    }
    blocks.push(
      <CodeBlockCard
        key={`code-${bIdx++}`}
        lang={m[1] ?? ''}
        code={String(m[2] ?? '').replace(/\n$/, '')}
        locale={locale}
      />,
    );
    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) {
    pushProse(text.slice(lastIdx));
  }

  return <div className="msg-markdown-body">{blocks}</div>;
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.map((n) => n & 0xff));
  let bin = '';
  for (let i = 0; i < arr.length; i++) {
    bin += String.fromCharCode(arr[i]!);
  }
  return btoa(bin);
}

function VoiceMessageCard({
  payload,
}: {
  payload: Record<string, any>;
}) {
  const [bars, setBars] = useState<number[]>(() =>
    Array.from({ length: 100 }, (_, i) => 6 + ((i * 7 + 11) % 24)),
  );
  const [playing, setPlaying] = useState(false);
  const [progressIdx, setProgressIdx] = useState(0);
  const [speed, setSpeed] = useState<'1x' | '1.5x' | '2x'>('1x');
  const durationSec = Math.max(1, Number(payload.duration_secs ?? payload.duration ?? 5));

  const rawWaveform =
    payload.waveform_b64 ??
    payload.encoded_b64 ??
    payload.waveform ??
    payload.waveform_bytes ??
    null;

  useEffect(() => {
    let cancelled = false;
    const decode = async () => {
      let b64 = '';
      if (typeof rawWaveform === 'string' && rawWaveform.trim()) {
        b64 = rawWaveform.trim();
      } else if (Array.isArray(rawWaveform) && rawWaveform.length > 0) {
        b64 = bytesToBase64(rawWaveform);
      }

      if (b64) {
        const res = await invokeWasm<{ bars?: number[]; floats?: number[] }>(
          'waveform_decode_5bit',
          {
            encoded_b64: b64,
            bar_count: 100,
          },
        );
        if (!cancelled && res.ok && res.data) {
          const rawBars = Array.isArray(res.data.bars) ? res.data.bars : [];
          if (rawBars.length > 0) {
            const normalized100 = Array.from({ length: 100 }, (_, idx) => {
              const srcIdx = Math.min(
                rawBars.length - 1,
                Math.floor((idx * rawBars.length) / 100),
              );
              return Math.max(2, Math.min(31, Number(rawBars[srcIdx] ?? 8)));
            });
            setBars(normalized100);
            return;
          }
        }
      }
    };
    void decode();
    return () => {
      cancelled = true;
    };
  }, [rawWaveform]);

  useEffect(() => {
    if (!playing) return;
    const stepMs = speed === '2x' ? 40 : speed === '1.5x' ? 55 : 80;
    const timer = window.setInterval(() => {
      setProgressIdx((prev) => {
        if (prev >= 99) {
          setPlaying(false);
          return 0;
        }
        return prev + 2;
      });
    }, stepMs);
    return () => window.clearInterval(timer);
  }, [playing, speed]);

  const cycleSpeed = () => {
    setSpeed((prev) => (prev === '1x' ? '1.5x' : prev === '1.5x' ? '2x' : '1x'));
  };

  const mins = Math.floor(durationSec / 60);
  const secs = String(Math.floor(durationSec % 60)).padStart(2, '0');

  return (
    <div className="voice-card" data-testid="voice-card">
      <button
        type="button"
        className="voice-play-btn"
        data-testid="voice-play-btn"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => setPlaying((v) => !v)}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <div className="voice-waveform-col">
        <div
          className="voice-waveform"
          data-testid="voice-waveform"
          role="slider"
          aria-label="Voice waveform scrubber"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressIdx}
        >
          {bars.map((val, idx) => {
            const pct = Math.max(14, Math.min(100, Math.round((val / 31) * 100)));
            return (
              <span
                key={idx}
                data-waveform-bar={idx}
                data-bar-value={val}
                className={`waveform-bar ${idx <= progressIdx && playing ? 'played' : ''}`}
                style={{ height: `${pct}%` }}
                onClick={() => setProgressIdx(idx)}
              />
            );
          })}
        </div>
        <div className="voice-meta-row">
          <span>
            {mins}:{secs}
          </span>
          <span>5-bit WASM Waveform</span>
        </div>
      </div>

      <button
        type="button"
        className="voice-speed-badge"
        data-testid="voice-speed-btn"
        onClick={cycleSpeed}
      >
        {speed}
      </button>
    </div>
  );
}

function MediaAttachmentCard({
  payload,
  locale,
}: {
  payload: Record<string, any>;
  locale: ExtensionLocale;
}) {
  const mediaId = String(
    payload.media_id ?? payload.file_id ?? payload.id ?? payload.url ?? '',
  ).trim();
  const mime = String(payload.mime_type ?? payload.content_type ?? '').toLowerCase();
  const filename = String(payload.filename ?? payload.file_name ?? payload.title ?? 'attachment');
  const [state, setState] = useState<{
    loading: boolean;
    ok: boolean;
    blobUrl?: string;
    resolvedMime?: string;
  }>({ loading: Boolean(mediaId), ok: false });

  useEffect(() => {
    let cancelled = false;
    if (!mediaId) {
      setState({ loading: false, ok: false });
      return;
    }
    setState({ loading: true, ok: false });
    void fetchAuthenticatedMediaBlobUrl(mediaId).then((res) => {
      if (cancelled) return;
      setState({
        loading: false,
        ok: res.ok,
        blobUrl: res.blobUrl,
        resolvedMime: res.mimeType || mime,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mediaId, mime]);

  if (state.loading) {
    return <div className="media-loading-skeleton">Loading media…</div>;
  }

  if (!state.ok || !state.blobUrl) {
    return (
      <div className="media-unavailable-card" data-testid="media-unavailable-card">
        🖼️ {tr(locale, 'msg.mediaUnavailable')} ({filename})
      </div>
    );
  }

  const effectiveMime = state.resolvedMime || mime;
  if (effectiveMime.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(filename)) {
    return (
      <div className="media-photo-card" data-testid="media-photo-card">
        <img src={state.blobUrl} alt={filename} className="msg-photo-img" />
        {payload.caption && <div className="media-caption">{String(payload.caption)}</div>}
      </div>
    );
  }

  if (effectiveMime.startsWith('video/') || /\.(mp4|webm)$/i.test(filename)) {
    return (
      <div className="media-video-card" data-testid="media-video-card">
        <video src={state.blobUrl} controls className="msg-video-el" />
      </div>
    );
  }

  return (
    <a
      href={state.blobUrl}
      download={filename}
      className="media-doc-card"
      data-testid="media-document-card"
    >
      <span className="doc-icon">📄</span>
      <span className="doc-meta">
        <strong>{filename}</strong>
        <span className="muted-xs">
          {payload.size_bytes ? `${Math.max(1, Math.round(Number(payload.size_bytes) / 1024))} KB` : effectiveMime || 'Document'}
        </span>
      </span>
      <span>⬇</span>
    </a>
  );
}

function PollCard({
  poll,
  locale,
  isMine,
  onVote,
  onClosePoll,
}: {
  poll: Record<string, any>;
  locale: ExtensionLocale;
  isMine: boolean;
  onVote: (pollId: string | number, optionIds: number[]) => void;
  onClosePoll: (pollId: string | number) => void;
}) {
  const pollId = poll.poll_id ?? poll.id ?? '';
  const question = String(poll.question ?? 'Poll');
  const isClosed = Boolean(poll.is_closed ?? poll.closed);
  const isQuiz = Boolean(poll.is_quiz || poll.type === 'quiz');
  const options: Array<Record<string, any>> = Array.isArray(poll.options) ? poll.options : [];
  const totalVoters = Math.max(
    0,
    Number(
      poll.total_voters ??
        poll.total_voter_count ??
        options.reduce((sum, o) => sum + Number(o?.voter_count ?? o?.votes ?? 0), 0),
    ),
  );

  return (
    <div
      className={`poll-card ${isClosed ? 'closed' : ''}`}
      data-testid="poll-card"
      data-poll-id={String(pollId)}
      data-poll-closed={isClosed ? 'true' : 'false'}
    >
      <div className="poll-header">
        <span className="poll-badge">{isQuiz ? '🎯 Quiz' : '📊 Poll'}</span>
        {isClosed && <span className="poll-closed-tag">{tr(locale, 'msg.pollClosed')}</span>}
      </div>
      <div className="poll-question">{question}</div>

      <div className="poll-options-list">
        {options.map((opt, idx) => {
          const optId = typeof opt?.option_id === 'number' ? opt.option_id : typeof opt?.id === 'number' ? opt.id : idx;
          const label = typeof opt === 'string' ? opt : String(opt?.text ?? opt?.label ?? `Option ${idx + 1}`);
          const count = Number(opt?.voter_count ?? opt?.votes ?? 0);
          const pct = totalVoters > 0 ? Math.min(100, Math.round((count / totalVoters) * 100)) : 0;
          const voted = Boolean(opt?.chosen || opt?.voted);

          return (
            <button
              key={optId}
              type="button"
              disabled={isClosed}
              aria-disabled={isClosed}
              data-option-id={optId}
              data-testid={`poll-option-${idx}`}
              className={`poll-option-btn ${voted ? 'voted' : ''}`}
              onClick={() => {
                if (!isClosed && pollId !== '') {
                  onVote(pollId, [optId]);
                }
              }}
            >
              <div className="poll-option-bar" style={{ width: `${pct}%` }} />
              <span className="poll-option-label">{label}</span>
              <span className="poll-option-pct">
                {pct}% ({count})
              </span>
            </button>
          );
        })}
      </div>

      <div className="poll-footer">
        <span>{totalVoters} votes</span>
        {!isClosed && isMine && pollId !== '' && (
          <button
            type="button"
            className="btn ghost xs"
            data-testid="close-poll-btn"
            onClick={() => onClosePoll(pollId)}
          >
            {tr(locale, 'msg.closePoll')}
          </button>
        )}
      </div>
    </div>
  );
}

function GenerativeCardView({ payload }: { payload: Record<string, any> }) {
  const title = String(payload.title ?? payload.heading ?? 'Generative Card');
  const blocks: Array<Record<string, any>> = Array.isArray(payload.blocks)
    ? payload.blocks
    : Array.isArray(payload.items)
      ? payload.items
      : [payload];

  return (
    <div className="generative-card" data-testid="generative-card">
      <div className="gen-card-title">✨ {title}</div>
      {blocks.map((blk, idx) => {
        const bType = String(blk?.type ?? blk?.kind ?? '').toLowerCase();
        if (bType === 'progress' || blk?.max !== undefined || blk?.value !== undefined) {
          const rawVal = Number(blk?.value ?? blk?.current ?? 0);
          const rawMax = Number(blk?.max ?? blk?.total ?? 100);
          // Guard max <= 0 & NaN so percentage is strictly finite [0..100] (T2-F13-05)
          const safePct =
            !Number.isFinite(rawVal) || !Number.isFinite(rawMax) || rawMax <= 0
              ? 0
              : Math.min(100, Math.max(0, Math.round((rawVal / rawMax) * 100)));
          const barColor = sanitizeHexColor(blk?.color, '#40A7E3');
          return (
            <div key={idx} className="gen-progress-row" data-testid="generative-progress">
              <div className="row-between">
                <span>{String(blk?.label ?? 'Progress')}</span>
                <span>{safePct}%</span>
              </div>
              <div className="gen-progress-track">
                <div
                  className="gen-progress-fill"
                  style={{ width: `${safePct}%`, backgroundColor: barColor }}
                />
              </div>
            </div>
          );
        }
        return (
          <div key={idx} className="gen-kv-row">
            {blk?.label && <span className="muted-xs">{String(blk.label)}: </span>}
            <span>{String(blk?.text ?? blk?.summary ?? JSON.stringify(blk))}</span>
          </div>
        );
      })}
    </div>
  );
}

function normalizeSpecialContent(
  msg: StoredMessageDto,
): { kind: string; payload: Record<string, any> } | null {
  if (msg.poll && typeof msg.poll === 'object') {
    return { kind: 'poll', payload: msg.poll };
  }
  const c = msg.content;
  if (!c || typeof c !== 'object') return null;

  if (typeof c.type === 'string') {
    return { kind: c.type.toLowerCase(), payload: c };
  }
  if (typeof c.kind === 'string') {
    return { kind: c.kind.toLowerCase(), payload: c };
  }
  // Rust externally tagged enum support: { Voice: {...} }, { Poll: {...} }, { Location: {...} }
  for (const key of [
    'Voice',
    'voice',
    'Poll',
    'poll',
    'Photo',
    'Video',
    'Document',
    'Media',
    'Album',
    'Location',
    'Service',
    'Call',
    'Story',
    'Invoice',
    'GenerativeCard',
    'Generative',
  ]) {
    if (c[key] && typeof c[key] === 'object') {
      return { kind: key.toLowerCase(), payload: c[key] };
    }
  }
  if (c.waveform || c.waveform_b64 || c.mime_type === 'audio/ogg') {
    return { kind: 'voice', payload: c };
  }
  if (c.question && Array.isArray(c.options)) {
    return { kind: 'poll', payload: c };
  }
  if (c.latitude !== undefined && c.longitude !== undefined) {
    return { kind: 'location', payload: c };
  }
  if (c.amount !== undefined && c.currency) {
    return { kind: 'invoice', payload: c };
  }
  if (c.media_id || c.file_id) {
    return { kind: 'media', payload: c };
  }
  return null;
}

export function MessageCard({
  msg,
  isMine,
  locale,
  replyTargetPreview,
  translatedText,
  onReply,
  onEdit,
  onTogglePin,
  onForward,
  onDelete,
  onTranslate,
  onReact,
  onVotePoll,
  onClosePoll,
  onCallbackButton,
  onOpenMiniAppUrl,
  onStartCall,
  onOpenE2eeVerify,
}: {
  msg: StoredMessageDto;
  isMine: boolean;
  locale: ExtensionLocale;
  replyTargetPreview?: string;
  translatedText?: string;
  onReply: (msg: StoredMessageDto) => void;
  onEdit: (msg: StoredMessageDto) => void;
  onTogglePin: (msg: StoredMessageDto) => void;
  onForward: (msg: StoredMessageDto) => void;
  onDelete: (msg: StoredMessageDto) => void;
  onTranslate: (msg: StoredMessageDto) => void;
  onReact: (msg: StoredMessageDto, emoji: string) => void;
  onVotePoll: (pollId: string | number, optionIds: number[]) => void;
  onClosePoll: (pollId: string | number) => void;
  onCallbackButton: (msg: StoredMessageDto, callbackData: string) => void;
  onOpenMiniAppUrl: (url: string, title?: string) => void;
  onStartCall: (video: boolean) => void;
  onOpenE2eeVerify: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedShot, setExpandedShot] = useState<string | null>(null);
  const [relayShotUrl, setRelayShotUrl] = useState<string | null>(null);
  const [recoveredThinking, setRecoveredThinking] = useState<string>('');

  const { thinking, cleanText, extractedSteps } = useMemo(
    () => extractThinkingAndCleanBody(msg.text ?? '', msg.thinking),
    [msg.text, msg.thinking],
  );

  const effectiveSteps: StoredToolStepDto[] = useMemo(
    () => (msg.tool_steps && msg.tool_steps.length > 0 ? msg.tool_steps : extractedSteps),
    [extractedSteps, msg.tool_steps],
  );

  const hasScreenshotStepWithoutData = useMemo(
    () =>
      effectiveSteps.some(
        (s) => s.tool.toLowerCase().includes('screenshot') && !s.screenshot_data_url,
      ),
    [effectiveSteps],
  );

  // Hydrate live PNG screenshot captured by ws_bridges during server-streamed browser_screenshot turns
  useEffect(() => {
    if (!hasScreenshotStepWithoutData || typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }
    let cancelled = false;
    void chrome.storage.local.get(['last_relay_screenshot']).then((raw) => {
      if (cancelled) return;
      const rec = raw?.last_relay_screenshot as
        | { chat_id?: number | null; data_url?: string; timestamp_ms?: number }
        | undefined;
      if (
        rec?.data_url &&
        rec.data_url.startsWith('data:image/') &&
        (!rec.chat_id || rec.chat_id === msg.chat_id) &&
        Date.now() - Number(rec.timestamp_ms ?? 0) < 120_000
      ) {
        setRelayShotUrl(rec.data_url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasScreenshotStepWithoutData, msg.chat_id]);

  // Recover reasoning from `/api/v1/hermes/turns` if server throttled intermediate thinking edit on fast localhost turns
  useEffect(() => {
    if (thinking || recoveredThinking || effectiveSteps.length === 0 || msg.chat_id <= 0 || isMine) {
      return;
    }
    let cancelled = false;
    const recover = async () => {
      const turnsRes = await apiRequest<any>('/api/v1/hermes/turns');
      if (cancelled) return;
      if (turnsRes.ok) {
        const list = Array.isArray(turnsRes.data?.turns)
          ? turnsRes.data.turns
          : Array.isArray(turnsRes.data)
            ? turnsRes.data
            : [];
        const matchTurn = list.find(
          (t: any) => !t?.chat_id || Number(t.chat_id) === Number(msg.chat_id),
        );
        const turnReasoning = String(
          matchTurn?.reasoning ?? matchTurn?.thinking ?? matchTurn?.summary ?? '',
        ).trim();
        if (turnReasoning) {
          setRecoveredThinking(turnReasoning);
          return;
        }
        const turnId = matchTurn?.turn_id ?? matchTurn?.id;
        if (turnId) {
          const evRes = await apiRequest<any>(
            `/api/v1/hermes/turns/${encodeURIComponent(String(turnId))}/events`,
          );
          if (!cancelled && evRes.ok) {
            const evs = Array.isArray(evRes.data?.events)
              ? evRes.data.events
              : Array.isArray(evRes.data)
                ? evRes.data
                : [];
            const rParts = evs
              .map((e: any) =>
                String(e?.reasoning ?? e?.thinking ?? e?.delta ?? e?.data?.reasoning ?? '').trim(),
              )
              .filter(Boolean);
            if (rParts.length > 0) {
              setRecoveredThinking(rParts.join('\n'));
              return;
            }
          }
        }
      }
      if (!cancelled) {
        setRecoveredThinking(
          `Executed ${effectiveSteps.map((s) => s.tool).join(' → ')} and synthesized response.`,
        );
      }
    };
    void recover();
    return () => {
      cancelled = true;
    };
  }, [effectiveSteps, isMine, msg.chat_id, recoveredThinking, thinking]);

  const effectiveThinking = thinking || recoveredThinking;

  const special = useMemo(() => normalizeSpecialContent(msg), [msg]);

  const inlineRows: any[][] = useMemo(() => {
    if (Array.isArray(msg.inline_keyboard)) return msg.inline_keyboard;
    const rm = msg.reply_markup ?? msg.content?.reply_markup;
    if (rm && Array.isArray(rm.inline_keyboard)) return rm.inline_keyboard;
    return [];
  }, [msg.content, msg.inline_keyboard, msg.reply_markup]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  // Service message centered pill (Type #7)
  if (special?.kind === 'service') {
    return (
      <div
        className="service-msg-pill"
        data-testid={CANONICAL_TEST_IDS.messageBubble}
        data-message-id={msg.message_id}
      >
        {String(special.payload.text ?? (cleanText || 'Service update'))}
      </div>
    );
  }

  const timeStr = new Date(msg.created_at_ms || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <CardErrorBoundary fallbackText={msg.text?.slice(0, 80) || 'Message'}>
      <article
        className={`msg-bubble ${isMine ? 'mine' : 'incoming'} ${msg.is_error ? 'error' : ''}`}
        data-testid={CANONICAL_TEST_IDS.messageBubble}
        data-message-id={msg.message_id}
        data-sender-id={msg.sender_id}
        style={{
          fontSize: 'var(--msg-font-size, 13px)',
          borderRadius: 'var(--bubble-radius, 17px)',
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(true);
        }}
      >
        {/* Sender / Forward / Encryption Header */}
        {(!isMine || msg.forward_from_name || msg.is_encrypted) && (
          <div className="msg-header-row">
            {!isMine && (msg.sender_name || msg.sender_username) && (
              <span className="msg-sender-name">
                {msg.sender_name || `@${msg.sender_username}`}
              </span>
            )}
            {msg.forward_from_name && (
              <span className="msg-forward-tag">↪ Forwarded from {msg.forward_from_name}</span>
            )}
            {msg.is_encrypted && (
              <button
                type="button"
                className="e2ee-badge-btn"
                data-testid="msg-e2ee-badge"
                onClick={onOpenE2eeVerify}
                title={tr(locale, 'stage.e2eeVerified')}
              >
                🔒 E2EE
              </button>
            )}
          </div>
        )}

        {/* Reply Quote Preview */}
        {(msg.reply_to_message_id || msg.quote_text) && (
          <div className="msg-reply-quote" data-testid="message-reply-quote">
            <span className="reply-bar" />
            <div className="reply-quote-text">
              {msg.quote_text || replyTargetPreview || `Reply to #${msg.reply_to_message_id}`}
            </div>
          </div>
        )}

        {/* Collapsible AI Reasoning `<think>` Bubble */}
        {effectiveThinking && (
          <details className="thinking-box" open data-testid={CANONICAL_TEST_IDS.thinkingBubble}>
            <summary className="thinking-summary">💭 {tr(locale, 'stage.thinking')}</summary>
            <div className="thinking-content">{effectiveThinking}</div>
          </details>
        )}

        {/* Expandable Agent & Browser Tool Steps Timeline */}
        {effectiveSteps.length > 0 && (
          <div className="steps-box" data-testid={CANONICAL_TEST_IDS.toolStepsList}>
            <div className="steps-title">
              🔧 {tr(locale, 'stage.toolSteps')} ({effectiveSteps.length})
            </div>
            {effectiveSteps.map((st) => {
              const stepShot =
                st.screenshot_data_url ||
                (st.tool.toLowerCase().includes('screenshot') ? relayShotUrl ?? undefined : undefined);
              return (
                <div key={st.id} className="step-item" data-step-status={st.status}>
                  <div className="step-row">
                    <span className={`step-dot ${st.status}`} />
                    <code>{st.tool}</code>
                    <span className="step-status-tag">{st.status}</span>
                  </div>
                  {st.result_summary && <div className="step-summary">{st.result_summary}</div>}
                  {stepShot && (
                    <img
                      src={stepShot}
                      alt={`Screenshot from ${st.tool}`}
                      className="step-screenshot-thumb"
                      onClick={() => setExpandedShot(stepShot)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Specialized 12 Card Types */}
        {special?.kind === 'voice' && <VoiceMessageCard payload={special.payload} />}

        {(special?.kind === 'media' ||
          special?.kind === 'photo' ||
          special?.kind === 'video' ||
          special?.kind === 'document') && (
          <MediaAttachmentCard payload={special.payload} locale={locale} />
        )}

        {special?.kind === 'album' && (
          <div className="album-grid" data-testid="album-card">
            {(Array.isArray(special.payload.items) ? special.payload.items : []).map(
              (item: any, idx: number) => (
                <MediaAttachmentCard key={idx} payload={item} locale={locale} />
              ),
            )}
          </div>
        )}

        {special?.kind === 'location' && (
          <div className="location-card" data-testid="location-card">
            <div className="location-map-preview">
              📍 {Number(special.payload.latitude ?? 0).toFixed(4)},{' '}
              {Number(special.payload.longitude ?? 0).toFixed(4)}
            </div>
            {special.payload.title && <strong>{String(special.payload.title)}</strong>}
          </div>
        )}

        {(special?.kind === 'poll' || special?.kind === 'quiz') && (
          <PollCard
            poll={special.payload}
            locale={locale}
            isMine={isMine}
            onVote={onVotePoll}
            onClosePoll={onClosePoll}
          />
        )}

        {special?.kind === 'call' && (
          <div className="call-msg-card" data-testid="call-card">
            <div>
              📞 <strong>{special.payload.is_video ? 'Video Call' : 'Voice Call'}</strong>
              <div className="muted-xs">
                {String(special.payload.status ?? 'Completed')} •{' '}
                {Number(special.payload.duration_secs ?? 0)}s
              </div>
            </div>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => onStartCall(Boolean(special.payload.is_video))}
            >
              Call Back
            </button>
          </div>
        )}

        {special?.kind === 'story' && (
          <div className="story-msg-card" data-testid="story-card">
            ✨ Story • {String(special.payload.caption ?? special.payload.title ?? 'View Story')}
          </div>
        )}

        {special?.kind === 'invoice' && (
          <div className="invoice-card" data-testid="invoice-card">
            <div className="invoice-header">
              💳 <strong>{String(special.payload.title ?? 'Telegram Stars Invoice')}</strong>
            </div>
            <div className="muted-xs">{String(special.payload.description ?? '')}</div>
            <div className="invoice-amount">
              {String(special.payload.currency ?? 'XTR')}{' '}
              {Number(special.payload.amount ?? special.payload.total_amount ?? 0)}
            </div>
          </div>
        )}

        {(special?.kind === 'generativecard' || special?.kind === 'generative') && (
          <GenerativeCardView payload={special.payload} />
        )}

        {/* Safe Markdown Text Body */}
        {cleanText && <SafeMarkdownView text={cleanText} locale={locale} />}

        {/* Inline Screenshot Preview from Local Bot Runner */}
        {msg.media_data_url && (
          <img
            src={msg.media_data_url}
            alt="Captured browser screenshot"
            className="msg-screenshot-img"
            onClick={() => setExpandedShot(msg.media_data_url!)}
          />
        )}

        {/* Inline Translation Box */}
        {translatedText && (
          <div className="msg-translation-box" data-testid="message-translation">
            🌐 {translatedText}
          </div>
        )}

        {/* Inline Bot Keyboard (`callback_data` / `web_app` / `url`) */}
        {inlineRows.length > 0 && (
          <div className="inline-keyboard-grid" data-testid="bot-inline-keyboard">
            {inlineRows.map((row, rIdx) => (
              <div key={rIdx} className="inline-keyboard-row">
                {(Array.isArray(row) ? row : []).map((btn: any, bIdx: number) => {
                  const label = String(btn?.text ?? btn?.label ?? 'Action');
                  const cbData = btn?.callback_data ?? btn?.data;
                  const webAppUrl = btn?.web_app?.url ?? btn?.mini_app_url;
                  const extUrl = btn?.url;
                  return (
                    <button
                      key={bIdx}
                      type="button"
                      className="inline-kb-btn"
                      data-testid="inline-keyboard-btn"
                      onClick={() => {
                        if (webAppUrl) {
                          onOpenMiniAppUrl(String(webAppUrl), label);
                        } else if (cbData !== undefined) {
                          onCallbackButton(msg, String(cbData));
                        } else if (extUrl && isSafeExternalHref(String(extUrl))) {
                          window.open(String(extUrl), '_blank', 'noopener,noreferrer');
                        }
                      }}
                    >
                      {webAppUrl ? `🧩 ${label}` : extUrl ? `↗ ${label}` : label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Reactions Row */}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="reactions-row" data-testid="message-reactions">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`reaction-chip ${r.me ? 'active' : ''}`}
                data-testid={`reaction-chip-${r.emoji}`}
                onClick={() => onReact(msg, r.emoji)}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}

        {/* Footer Metadata + Hover Action Trigger */}
        <div className="msg-footer-meta">
          {msg.pinned && <span title="Pinned">📌</span>}
          {msg.edited_at_ms && <span className="edited-label">({tr(locale, 'msg.edited')})</span>}
          <span className="msg-time">{timeStr}</span>
          {msg.pending_outbox && <span title="Sending…">🕒</span>}
          <button
            type="button"
            className="msg-more-btn"
            data-testid="message-actions-btn"
            aria-label="Message actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            ⋯
          </button>
        </div>

        {/* Message Context Menu */}
        {menuOpen && (
          <div
            className="floating-popover msg-context-menu"
            role="menu"
            data-testid="message-context-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="quick-reactions-bar">
              {['👍', '❤️', '🔥', '🎉', '👀'].map((emo) => (
                <button
                  key={emo}
                  type="button"
                  className="emoji-react-btn"
                  data-testid={`quick-react-${emo}`}
                  onClick={() => {
                    setMenuOpen(false);
                    onReact(msg, emo);
                  }}
                >
                  {emo}
                </button>
              ))}
            </div>
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="msg-action-reply"
              onClick={() => {
                setMenuOpen(false);
                onReply(msg);
              }}
            >
              ↩ {tr(locale, 'msg.reply')}
            </button>
            {isMine && msg.message_id > 0 && (
              <button
                type="button"
                role="menuitem"
                className="menu-item-btn"
                data-testid="msg-action-edit"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit(msg);
                }}
              >
                ✏️ {tr(locale, 'msg.edit')}
              </button>
            )}
            {msg.message_id > 0 && (
              <button
                type="button"
                role="menuitem"
                className="menu-item-btn"
                data-testid="msg-action-pin"
                onClick={() => {
                  setMenuOpen(false);
                  onTogglePin(msg);
                }}
              >
                📌 {msg.pinned ? tr(locale, 'msg.unpin') : tr(locale, 'msg.pin')}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="msg-action-forward"
              onClick={() => {
                setMenuOpen(false);
                onForward(msg);
              }}
            >
              ↪ {tr(locale, 'msg.forward')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="msg-action-copy"
              onClick={() => {
                setMenuOpen(false);
                void navigator.clipboard?.writeText(cleanText || msg.text || '').catch(() => {});
              }}
            >
              📋 {tr(locale, 'msg.copy')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="msg-action-translate"
              onClick={() => {
                setMenuOpen(false);
                onTranslate(msg);
              }}
            >
              🌐 {tr(locale, 'msg.translate')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn danger-text"
              data-testid="msg-action-delete"
              onClick={() => {
                setMenuOpen(false);
                onDelete(msg);
              }}
            >
              🗑️ {tr(locale, 'msg.delete')}
            </button>
          </div>
        )}

        {/* Lightbox for Expanded Browser Screenshot */}
        {expandedShot && (
          <div className="modal-backdrop" onClick={() => setExpandedShot(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <img src={expandedShot} alt="Full screenshot" style={{ maxWidth: '82vw', maxHeight: '78vh' }} />
            </div>
          </div>
        )}
      </article>
    </CardErrorBoundary>
  );
}
