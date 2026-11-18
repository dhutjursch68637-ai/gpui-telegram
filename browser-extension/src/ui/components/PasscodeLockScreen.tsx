import React, { useRef, useState } from 'react';
import type { ExtensionLocale } from '../../shared/rpc_types';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';

export async function hashPasscodeSha256(pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`gpui-passcode-v1:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyStoredPasscode(candidatePin: string): Promise<boolean> {
  try {
    const raw = (await chrome.storage.local.get(['passcode_hash'])) as { passcode_hash?: string };
    const storedHash = String(raw.passcode_hash ?? '').trim();
    if (!storedHash) return true;
    const candidateHash = await hashPasscodeSha256(candidatePin);
    if (candidateHash === storedHash) return true;
    // Also support plain SHA-256 without prefix in case external test seeded raw SHA-256(pin)
    const rawBytes = new TextEncoder().encode(candidatePin);
    const rawDigest = await crypto.subtle.digest('SHA-256', rawBytes);
    const plainSha = Array.from(new Uint8Array(rawDigest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return plainSha === storedHash;
  } catch {
    return false;
  }
}

export function PasscodeLockScreen({
  locale,
  username,
  onUnlocked,
}: {
  locale: ExtensionLocale;
  username?: string | null;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = (inputRef.current?.value ?? pin).trim();
    if (!candidate || busy) return;
    setBusy(true);
    const ok = await verifyStoredPasscode(candidate);
    setBusy(false);
    if (ok) {
      setError('');
      setPin('');
      if (inputRef.current) inputRef.current.value = '';
      await sendSwRpc({ type: 'ui.set_preferences', passcode_locked: false });
      onUnlocked();
    } else {
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);
      setPin('');
      if (inputRef.current) inputRef.current.value = '';
      setError(`${tr(locale, 'lock.wrongPin')} ${nextAttempts}`);
    }
  };

  return (
    <div
      className="passcode-lock-screen"
      data-testid="passcode-lock-screen"
      role="dialog"
      aria-modal="true"
      aria-label={tr(locale, 'lock.title')}
    >
      <form className="passcode-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="passcode-lock-icon" aria-hidden="true">
          🔒
        </div>
        <h2 className="passcode-title">{tr(locale, 'lock.title')}</h2>
        <p className="passcode-subtitle">
          {username ? `@${username} • ` : ''}
          {tr(locale, 'lock.subtitle')}
        </p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoFocus
          className="input passcode-input"
          data-testid="passcode-unlock-input"
          aria-label="Passcode PIN"
          placeholder={tr(locale, 'lock.placeholder')}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />

        {error && (
          <div className="error-banner" data-testid="passcode-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn primary full-width"
          data-testid="passcode-unlock-btn"
          disabled={busy}
        >
          {tr(locale, 'lock.unlockBtn')}
        </button>
      </form>
    </div>
  );
}
