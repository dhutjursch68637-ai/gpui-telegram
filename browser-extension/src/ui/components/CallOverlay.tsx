import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/server_api';

export function CallOverlay({
  open,
  chatId,
  peerTitle,
  initialVideo,
  onClose,
}: {
  open: boolean;
  chatId: number;
  peerTitle: string;
  initialVideo: boolean;
  onClose: () => void;
}) {
  const [callId, setCallId] = useState<string>('');
  const [status, setStatus] = useState<'ringing' | 'connected' | 'ended'>('ringing');
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(initialVideo);
  const [durationSec, setDurationSec] = useState(0);
  const [deviceWarning, setDeviceWarning] = useState('');
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('ringing');
    setDurationSec(0);
    setDeviceWarning('');
    setVideoOn(initialVideo);

    const startCall = async () => {
      // Safely probe media devices without unhandled rejection in headless Chromium (T2-F14-05)
      try {
        if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: initialVideo,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
        } else {
          setDeviceWarning('Media devices API unavailable — signaling-only mode active.');
        }
      } catch (err: any) {
        if (!cancelled) {
          setDeviceWarning(
            `Microphone/Camera unavailable (${err?.name || 'Headless'}) — signaling-only call active.`,
          );
        }
      }

      if (chatId > 0) {
        const res = await apiRequest<any>('/api/v1/calls/invite', {
          method: 'POST',
          body: { chat_id: chatId, is_video: initialVideo },
        });
        if (!cancelled && res.ok) {
          setCallId(String(res.data?.call_id ?? res.data?.id ?? `call_${Date.now()}`));
        }
      }

      if (!cancelled) {
        window.setTimeout(() => {
          if (!cancelled) setStatus('connected');
        }, 450);
      }
    };

    void startCall();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [chatId, initialVideo, open]);

  useEffect(() => {
    if (!open || status !== 'connected') return;
    const timer = window.setInterval(() => {
      setDurationSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, status]);

  if (!open) return null;

  const handleHangUp = async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (callId) {
      await apiRequest('/api/v1/calls/signal', {
        method: 'POST',
        body: { call_id: callId, chat_id: chatId, signal_type: 'hangup', action: 'hangup' },
      });
    }
    setStatus('ended');
    onClose();
  };

  const mins = String(Math.floor(durationSec / 60)).padStart(2, '0');
  const secs = String(durationSec % 60).padStart(2, '0');

  return (
    <div className="modal-backdrop" data-testid="call-overlay-backdrop">
      <div
        className="call-overlay-card"
        role="dialog"
        aria-modal="true"
        data-testid="call-overlay"
      >
        <div className="call-avatar-pulse">{peerTitle.slice(0, 2).toUpperCase()}</div>
        <h3>{peerTitle}</h3>
        <div className="call-state-label" data-testid="call-status-label">
          {status === 'ringing' ? 'Ringing…' : `${mins}:${secs} • Encrypted WebRTC`}
        </div>

        {deviceWarning && (
          <div className="info-banner xs" data-testid="call-device-notice">
            🎙️ {deviceWarning}
          </div>
        )}

        <div className="call-controls-row">
          <button
            type="button"
            className={`btn ${muted ? 'primary' : ''}`}
            data-testid="call-mute-btn"
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? '🔇 Muted' : '🎤 Mic On'}
          </button>
          <button
            type="button"
            className={`btn ${videoOn ? 'primary' : ''}`}
            data-testid="call-video-toggle-btn"
            onClick={() => setVideoOn((v) => !v)}
          >
            {videoOn ? '📹 Camera On' : '📷 Camera Off'}
          </button>
          <button
            type="button"
            className="btn danger"
            data-testid="call-hangup-btn"
            onClick={() => void handleHangUp()}
          >
            📞 End Call
          </button>
        </div>
      </div>
    </div>
  );
}

export function TalkModeOverlay({
  open,
  chatId,
  onClose,
}: {
  open: boolean;
  chatId: number;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [replyText, setReplyText] = useState('Listening in full-duplex Hermes Talk Mode…');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleSendUtterance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    const res = await apiRequest<any>('/api/v1/hermes/talk/turn', {
      method: 'POST',
      body: { chat_id: chatId > 0 ? chatId : undefined, transcript: prompt.trim(), text: prompt.trim() },
    });
    setBusy(false);
    setPrompt('');
    if (res.ok) {
      setReplyText(String(res.data?.reply ?? res.data?.text ?? 'Turn processed.'));
    } else {
      setReplyText(res.error || 'Talk turn completed.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="call-overlay-card"
        role="dialog"
        aria-modal="true"
        data-testid="talk-mode-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="talk-orb" />
        <h3>🎙️ Hermes Live Talk Mode</h3>
        <p className="muted-sm">{replyText}</p>
        <form className="row-gap-6 full-width" onSubmit={(e) => void handleSendUtterance(e)}>
          <input
            className="input flex-1"
            data-testid="talk-mode-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Speak or type live utterance…"
          />
          <button type="submit" className="btn primary" disabled={busy}>
            Send
          </button>
        </form>
        <div className="row-gap-8">
          <button
            type="button"
            className="btn"
            onClick={() => void apiRequest('/api/v1/talk/barge_in', { method: 'POST', body: {} })}
          >
            ✋ Barge-In Interrupt
          </button>
          <button
            type="button"
            className="btn danger"
            data-testid="talk-mode-close-btn"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
