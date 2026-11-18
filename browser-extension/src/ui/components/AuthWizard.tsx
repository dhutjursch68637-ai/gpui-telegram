import React, { useEffect, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  type DesktopThemePreset,
  type ExtensionLocale,
} from '../../shared/rpc_types';
import { apiRequest, isValidHttpServerUrl, probeServerHealth } from '../api/server_api';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';

type AuthTabId = 'login' | 'register' | 'phone' | 'email' | 'qr' | 'alipay';

export function AuthWizard({
  initialServerUrl,
  locale,
  themePreset,
  onAuthenticated,
  onCycleTheme,
  onToggleLocale,
  onCancelAddAccount,
}: {
  initialServerUrl: string;
  locale: ExtensionLocale;
  themePreset: DesktopThemePreset;
  onAuthenticated: () => Promise<void> | void;
  onCycleTheme: () => void;
  onToggleLocale: () => void;
  onCancelAddAccount?: () => void;
}) {
  const [tab, setTab] = useState<AuthTabId>('login');
  const [serverUrl, setServerUrl] = useState(initialServerUrl || 'http://127.0.0.1:8080');
  const [probeState, setProbeState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [probeDetail, setProbeDetail] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [twoFaCode, setTwoFaCode] = useState('');
  const [needsTwoFa, setNeedsTwoFa] = useState(false);

  const [phone, setPhone] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');

  const [email, setEmail] = useState('');
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');

  const [qrToken, setQrToken] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [alipayAttemptId, setAlipayAttemptId] = useState('');
  const [alipayPortalUrl, setAlipayPortalUrl] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialServerUrl && initialServerUrl !== serverUrl && !username && !password) {
      setServerUrl(initialServerUrl);
    }
  }, [initialServerUrl]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const finishLogin = async (base: string, data: Record<string, any>, fallbackUsername?: string) => {
    const token = String(
      data?.token ?? data?.access_token ?? data?.session?.token ?? '',
    ).trim();
    if (!token) {
      setError('Server did not return an authentication token.');
      return;
    }
    const uidRaw = data?.user_id ?? data?.user?.id ?? data?.user?.user_id ?? null;
    const uid = typeof uidRaw === 'number' ? uidRaw : uidRaw ? Number(uidRaw) : null;
    const uname = String(
      data?.username ?? data?.user?.username ?? fallbackUsername ?? `user_${uid ?? '1'}`,
    ).trim();
    const sessionId =
      typeof (data?.session_id ?? data?.session?.session_id) === 'string'
        ? String(data.session_id ?? data.session?.session_id)
        : undefined;
    const fName =
      typeof (data?.first_name ?? data?.user?.first_name) === 'string'
        ? String(data.first_name ?? data.user?.first_name)
        : undefined;

    await sendSwRpc({
      type: 'ui.login_success',
      server_url: base,
      token,
      user_id: Number.isFinite(uid) ? uid : null,
      username: uname,
      session_id: sessionId,
      first_name: fName,
    });
    await onAuthenticated();
  };

  const handleProbe = async () => {
    setError('');
    const trimmed = serverUrl.trim().replace(/\/+$/, '');
    if (!isValidHttpServerUrl(trimmed)) {
      setProbeState('error');
      setProbeDetail(tr(locale, 'auth.serverInvalid'));
      setError(tr(locale, 'auth.serverInvalid'));
      return;
    }
    setProbeState('checking');
    const res = await probeServerHealth(trimmed);
    if (res.ok) {
      setProbeState('ok');
      setProbeDetail(`${tr(locale, 'auth.serverHealthy')} (${res.version ?? 'v1'})`);
    } else {
      setProbeState('error');
      setProbeDetail(`${tr(locale, 'auth.serverOffline')}: ${res.error ?? ''}`);
      setError(`${tr(locale, 'auth.serverOffline')}: ${res.error ?? ''}`);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMsg('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!isValidHttpServerUrl(base)) {
      setError(tr(locale, 'auth.serverInvalid'));
      return;
    }

    if (tab === 'login' || tab === 'register') {
      const cleanUser = username.trim();
      if (!cleanUser) {
        setError(tr(locale, 'auth.errEmptyUsername'));
        return;
      }
      if (!password || password.length === 0) {
        setError(tr(locale, 'auth.errEmptyPassword'));
        return;
      }

      setBusy(true);
      try {
        if (tab === 'login') {
          // STRICT: Login NEVER auto-registers on 401 (T2-F11-02)
          const res = await apiRequest<Record<string, any>>('/api/v1/auth/login', {
            method: 'POST',
            serverUrl: base,
            skipAuth: true,
            body: {
              username: cleanUser,
              password,
              ...(twoFaCode.trim() ? { two_fa_code: twoFaCode.trim(), password_2fa: twoFaCode.trim() } : {}),
            },
          });
          if (!res.ok) {
            if (
              res.status === 403 ||
              String(res.error ?? '').toLowerCase().includes('2fa') ||
              res.data?.two_factor_required
            ) {
              setNeedsTwoFa(true);
              setError('Two-Step Verification (2FA) password required.');
              return;
            }
            setError(
              res.status === 401
                ? `${tr(locale, 'auth.errInvalidCreds')} ${res.error ?? ''}`.trim()
                : `Login failed (${res.status || 'Network'}): ${res.error ?? 'Unreachable'}`,
            );
            return;
          }
          await finishLogin(base, res.data, cleanUser);
        } else {
          const res = await apiRequest<Record<string, any>>('/api/v1/auth/register', {
            method: 'POST',
            serverUrl: base,
            skipAuth: true,
            body: {
              username: cleanUser,
              password,
              first_name: firstName.trim() || cleanUser,
              display_name: firstName.trim() || cleanUser,
            },
          });
          if (!res.ok) {
            setError(`Registration failed (${res.status || 'Error'}): ${res.error ?? ''}`);
            return;
          }
          await finishLogin(base, res.data, cleanUser);
        }
      } finally {
        setBusy(false);
      }
    }
  };

  const handleSendPhoneCode = async () => {
    setError('');
    setInfoMsg('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!isValidHttpServerUrl(base)) {
      setError(tr(locale, 'auth.serverInvalid'));
      return;
    }
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      setError('Phone number is required.');
      return;
    }
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/phone/send-code', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: { phone: cleanPhone, phone_number: cleanPhone },
    });
    setBusy(false);
    if (!res.ok) {
      setError(`Failed to send SMS code (${res.status}): ${res.error ?? ''}`);
      return;
    }
    setPhoneCodeSent(true);
    setPhoneCodeHash(String(res.data?.phone_code_hash ?? ''));
    const devCode = res.data?.dev_code ?? res.data?.code ?? '';
    setInfoMsg(devCode ? `Verification code sent (Dev OTP: ${devCode})` : 'Verification code sent.');
  };

  const handleVerifyPhoneCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!phone.trim() || !otpCode.trim()) {
      setError('Phone number and verification code are required.');
      return;
    }
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/phone/verify', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: {
        phone: phone.trim(),
        phone_number: phone.trim(),
        code: otpCode.trim(),
        phone_code_hash: phoneCodeHash || undefined,
      },
    });
    setBusy(false);
    if (!res.ok) {
      // Preserve `phone` input value on invalid OTP (T2-F11-04)
      setError(`Invalid OTP verification code (${res.status}): ${res.error ?? 'Invalid code'}`);
      return;
    }
    await finishLogin(base, res.data, phone.trim());
  };

  const handleSendEmailCode = async () => {
    setError('');
    setInfoMsg('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/email/send-code', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: { email: email.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      setError(`Email code error (${res.status}): ${res.error ?? ''}`);
      return;
    }
    setEmailCodeSent(true);
    const devCode = res.data?.dev_code ?? res.data?.code ?? '';
    setInfoMsg(devCode ? `Email code sent (Code: ${devCode})` : 'Verification code sent to email.');
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/email/register', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: {
        email: email.trim(),
        code: emailCode.trim(),
        username: username.trim() || email.trim().split('@')[0],
        password: password || 'email-otp-auth-pass',
      },
    });
    setBusy(false);
    if (!res.ok) {
      setError(`Email verification failed (${res.status}): ${res.error ?? ''}`);
      return;
    }
    await finishLogin(base, res.data, email.trim().split('@')[0]);
  };

  const handleStartQrPairing = async () => {
    setError('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!isValidHttpServerUrl(base)) {
      setError(tr(locale, 'auth.serverInvalid'));
      return;
    }
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/pair/init', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: { device_name: 'GPUI Telegram Chrome Extension', platform: 'chrome-mv3' },
    });
    setBusy(false);
    if (!res.ok) {
      setError(`QR pairing init failed (${res.status}): ${res.error ?? ''}`);
      return;
    }
    const pToken = String(res.data?.pair_token ?? res.data?.token ?? '');
    setQrToken(pToken);
    setQrUrl(String(res.data?.qr_url ?? `tg://login?token=${pToken}`));

    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    if (pToken) {
      pollTimerRef.current = window.setInterval(async () => {
        const pollRes = await apiRequest<Record<string, any>>(
          `/api/v1/auth/pair/poll/${encodeURIComponent(pToken)}`,
          { serverUrl: base, skipAuth: true },
        );
        if (pollRes.ok && (pollRes.data?.token || pollRes.data?.status === 'approved' || pollRes.data?.approved)) {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          await finishLogin(base, pollRes.data);
        }
      }, 800);
    }
  };

  const handleStartAlipay = async () => {
    setError('');
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!isValidHttpServerUrl(base)) {
      setError(tr(locale, 'auth.serverInvalid'));
      return;
    }
    setBusy(true);
    const res = await apiRequest<Record<string, any>>('/api/v1/auth/alipay/start', {
      method: 'POST',
      serverUrl: base,
      skipAuth: true,
      body: {},
    });
    setBusy(false);
    if (!res.ok) {
      setError(`Alipay start failed (${res.status}): ${res.error ?? ''}`);
      return;
    }
    const attemptId = String(res.data?.attempt_id ?? res.data?.id ?? '');
    setAlipayAttemptId(attemptId);
    setAlipayPortalUrl(String(res.data?.login_url ?? res.data?.qr_url ?? `${base}/api/v1/auth/alipay/portal`));
    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    if (attemptId) {
      pollTimerRef.current = window.setInterval(async () => {
        const pollRes = await apiRequest<Record<string, any>>(
          `/api/v1/auth/alipay/poll/${encodeURIComponent(attemptId)}`,
          { serverUrl: base, skipAuth: true },
        );
        if (pollRes.ok && pollRes.data?.token) {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          await finishLogin(base, pollRes.data);
        }
      }, 900);
    }
  };

  return (
    <div className="auth-shell" data-testid={CANONICAL_TEST_IDS.authWizard}>
      <div className="auth-top-controls">
        {onCancelAddAccount && (
          <button type="button" className="btn ghost" onClick={onCancelAddAccount}>
            ← {tr(locale, 'settings.back')}
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          data-testid={CANONICAL_TEST_IDS.themeToggleBtn}
          onClick={onCycleTheme}
          title={tr(locale, 'nav.theme')}
        >
          🎨 {themePreset.toUpperCase()}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid={CANONICAL_TEST_IDS.langToggleBtn}
          onClick={onToggleLocale}
          title={tr(locale, 'nav.language')}
        >
          🌐 {locale === 'zh-CN' ? '中文' : 'EN'}
        </button>
      </div>

      <div className="auth-card-modern">
        <div className="auth-brand">
          <div className="auth-logo-circle">✈️</div>
          <div>
            <h1 className="auth-heading">{tr(locale, 'auth.welcome')}</h1>
            <p className="auth-sub">{tr(locale, 'auth.subtitle')}</p>
          </div>
        </div>

        <div className="auth-server-box">
          <label className="field-label" htmlFor="auth-server-url">
            {tr(locale, 'auth.serverUrl')}
          </label>
          <div className="row-gap-6">
            <input
              id="auth-server-url"
              className="input flex-1"
              data-testid={CANONICAL_TEST_IDS.authServerUrlInput}
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value);
                setProbeState('idle');
              }}
              placeholder="http://127.0.0.1:8080"
            />
            <button
              type="button"
              className="btn"
              data-testid="auth-probe-server-btn"
              onClick={() => void handleProbe()}
            >
              {probeState === 'checking' ? '…' : tr(locale, 'auth.probeBtn')}
            </button>
          </div>
          {probeState !== 'idle' && (
            <div
              className={`probe-status ${probeState === 'ok' ? 'ok' : 'err'}`}
              data-testid="auth-server-status"
            >
              {probeState === 'ok' ? '● ' : '▲ '}
              {probeDetail}
            </div>
          )}
        </div>

        <div className="auth-tabs" role="tablist">
          {(
            [
              ['login', tr(locale, 'auth.tab.login')],
              ['register', tr(locale, 'auth.tab.register')],
              ['phone', tr(locale, 'auth.tab.phone')],
              ['email', tr(locale, 'auth.tab.email')],
              ['qr', tr(locale, 'auth.tab.qr')],
              ['alipay', tr(locale, 'auth.tab.alipay')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-tab={id}
              data-testid={`auth-tab-${id}`}
              className={`auth-tab-btn ${tab === id ? 'active' : ''}`}
              onClick={() => {
                setTab(id);
                setError('');
                setInfoMsg('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="error-banner" data-testid="auth-error-banner" role="alert">
            {error}
          </div>
        )}
        {infoMsg && (
          <div className="info-banner" data-testid="auth-info-banner">
            {infoMsg}
          </div>
        )}

        {(tab === 'login' || tab === 'register') && (
          <form className="auth-form-stack" onSubmit={(e) => void handlePasswordSubmit(e)}>
            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.username')}</span>
              <input
                className="input"
                data-testid={CANONICAL_TEST_IDS.authUsernameInput}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice"
                autoComplete="username"
              />
            </label>

            {tab === 'register' && (
              <label className="field-stack">
                <span className="field-label">{tr(locale, 'auth.firstName')}</span>
                <input
                  className="input"
                  data-testid="auth-display-name-input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Alice"
                />
              </label>
            )}

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.password')}</span>
              <input
                className="input"
                type="password"
                data-testid={CANONICAL_TEST_IDS.authPasswordInput}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              />
            </label>

            {(needsTwoFa || twoFaCode.length > 0) && tab === 'login' && (
              <label className="field-stack">
                <span className="field-label">{tr(locale, 'auth.twoFaCode')}</span>
                <input
                  className="input"
                  type="password"
                  data-testid="auth-2fa-input"
                  value={twoFaCode}
                  onChange={(e) => setTwoFaCode(e.target.value)}
                  placeholder="2FA Cloud Password"
                />
              </label>
            )}

            <button
              type="submit"
              className="btn primary full-width"
              data-testid={CANONICAL_TEST_IDS.authSubmitBtn}
              disabled={busy}
            >
              {busy
                ? tr(locale, 'auth.signingIn')
                : tab === 'login'
                  ? tr(locale, 'auth.submitLogin')
                  : tr(locale, 'auth.submitRegister')}
            </button>
          </form>
        )}

        {tab === 'phone' && (
          <form className="auth-form-stack" onSubmit={(e) => void handleVerifyPhoneCode(e)}>
            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.phone')}</span>
              <div className="row-gap-6">
                <input
                  className="input flex-1"
                  data-testid="auth-phone-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+14155550101"
                />
                <button
                  type="button"
                  className="btn"
                  data-testid="auth-send-code-btn"
                  disabled={busy}
                  onClick={() => void handleSendPhoneCode()}
                >
                  {tr(locale, 'auth.sendCode')}
                </button>
              </div>
            </label>

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.otpCode')}</span>
              <input
                className="input"
                data-testid="auth-otp-input"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                placeholder="123456"
              />
            </label>

            <button
              type="submit"
              className="btn primary full-width"
              data-testid={CANONICAL_TEST_IDS.authSubmitBtn}
              disabled={busy || (!phoneCodeSent && !otpCode.trim())}
            >
              {tr(locale, 'auth.verifySignIn')}
            </button>
          </form>
        )}

        {tab === 'email' && (
          <form className="auth-form-stack" onSubmit={(e) => void handleVerifyEmail(e)}>
            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.email')}</span>
              <div className="row-gap-6">
                <input
                  className="input flex-1"
                  type="email"
                  data-testid="auth-email-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alice@example.com"
                />
                <button
                  type="button"
                  className="btn"
                  data-testid="auth-email-send-btn"
                  disabled={busy}
                  onClick={() => void handleSendEmailCode()}
                >
                  {tr(locale, 'auth.sendCode')}
                </button>
              </div>
            </label>
            <label className="field-stack">
              <span className="field-label">{tr(locale, 'auth.otpCode')}</span>
              <input
                className="input"
                data-testid="auth-email-code-input"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                placeholder="6-digit code"
              />
            </label>
            {emailCodeSent && (
              <div className="muted-xs">Code dispatched to {email}</div>
            )}
            <button
              type="submit"
              className="btn primary full-width"
              data-testid={CANONICAL_TEST_IDS.authSubmitBtn}
              disabled={busy}
            >
              {tr(locale, 'auth.verifySignIn')}
            </button>
          </form>
        )}

        {tab === 'qr' && (
          <div className="auth-form-stack center-col">
            {!qrToken ? (
              <button
                type="button"
                className="btn primary"
                data-testid="auth-qr-init-btn"
                onClick={() => void handleStartQrPairing()}
                disabled={busy}
              >
                {tr(locale, 'auth.qrInit')}
              </button>
            ) : (
              <>
                <div className="qr-frame" data-testid="auth-qr-code">
                  <svg viewBox="0 0 120 120" width="148" height="148" aria-label="QR Pairing Code">
                    <rect width="120" height="120" rx="8" fill="#FFFFFF" />
                    <rect x="10" y="10" width="28" height="28" fill="#111111" />
                    <rect x="15" y="15" width="18" height="18" fill="#FFFFFF" />
                    <rect x="19" y="19" width="10" height="10" fill="#111111" />
                    <rect x="82" y="10" width="28" height="28" fill="#111111" />
                    <rect x="87" y="15" width="18" height="18" fill="#FFFFFF" />
                    <rect x="91" y="19" width="10" height="10" fill="#111111" />
                    <rect x="10" y="82" width="28" height="28" fill="#111111" />
                    <rect x="15" y="87" width="18" height="18" fill="#FFFFFF" />
                    <rect x="19" y="91" width="10" height="10" fill="#111111" />
                    {Array.from({ length: 24 }).map((_, idx) => {
                      const code = qrToken.charCodeAt(idx % qrToken.length) + idx * 17;
                      const gx = 44 + (idx % 6) * 6;
                      const gy = 44 + Math.floor(idx / 6) * 9;
                      return code % 2 === 0 ? (
                        <rect key={idx} x={gx} y={gy} width="5" height="5" fill="#111111" />
                      ) : null;
                    })}
                  </svg>
                </div>
                <code className="qr-token-pill" data-testid="auth-qr-token">
                  {qrToken}
                </code>
                <div className="muted-xs">{qrUrl}</div>
                <p className="muted-xs">{tr(locale, 'auth.qrWaiting')}</p>
              </>
            )}
          </div>
        )}

        {tab === 'alipay' && (
          <div className="auth-form-stack center-col">
            {!alipayAttemptId ? (
              <button
                type="button"
                className="btn primary"
                data-testid="auth-alipay-start-btn"
                onClick={() => void handleStartAlipay()}
                disabled={busy}
              >
                {tr(locale, 'auth.tab.alipay')}
              </button>
            ) : (
              <>
                <div className="qr-token-pill" data-testid="auth-alipay-attempt">
                  Attempt: {alipayAttemptId}
                </div>
                <div className="muted-xs">{alipayPortalUrl}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
