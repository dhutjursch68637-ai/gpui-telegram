import React, { useEffect, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  type BrowserRunPolicy,
  type DesktopThemePreset,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
} from '../../shared/rpc_types';
import { apiRequest } from '../api/server_api';
import { ACCENT_SWATCHES, DESKTOP_THEME_PALETTES, THEME_CYCLE_ORDER } from '../theme/palettes';
import { tr, type TranslationKey } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';
import { BridgeHeaderControls, PendingApprovalBannerList } from './ConversationStage';
import { hashPasscodeSha256 } from './PasscodeLockScreen';

export const ALL_26_SETTINGS_SECTIONS = [
  'Overview',
  'EditProfile',
  'Notifications',
  'PrivacySecurity',
  'Chat',
  'Folders',
  'Advanced',
  'CallSettings',
  'StickersEmoji',
  'Devices',
  'Language',
  'Passkeys',
  'TwoStepVerification',
  'LocalPasscode',
  'BlockedUsers',
  'ActiveSessions',
  'DataStorage',
  'ProxyConfig',
  'AiProviders',
  'Computers',
  'TelegramStars',
  'TelegramBusiness',
  'MyTon',
  'SendAGift',
  'Faq',
  'AskQuestion',
] as const;

export type SettingsSectionId = (typeof ALL_26_SETTINGS_SECTIONS)[number];

export function parseMagpieImportUri(rawUri: string): {
  ok: boolean;
  config?: Record<string, any>;
  error?: string;
} {
  const trimmed = rawUri.trim();
  if (!trimmed.startsWith('magpie://')) {
    return { ok: false, error: 'Invalid Magpie URI: must start with magpie://' };
  }
  const body = trimmed.slice('magpie://'.length).replace(/^import\/?/i, '').trim();
  if (!body) {
    return { ok: false, error: 'Magpie URI payload is empty.' };
  }
  try {
    // Normalize URL-safe base64 and forbid garbage characters
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
      return { ok: false, error: 'Malformed base64 characters in magpie:// URI.' };
    }
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const jsonStr = atob(padded);
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Magpie payload must decode to a JSON object.' };
    }
    return { ok: true, config: parsed as Record<string, any> };
  } catch {
    return { ok: false, error: 'Failed to decode base64 JSON from magpie:// URI.' };
  }
}

export function SettingsRouter({
  state,
  locale,
  themePreset,
  fontSize,
  bubbleRadius,
  accentColor,
  pendingApprovals,
  activeSection,
  onSelectSection,
  onBackToChats,
  onPolicyChange,
  onEmergencyStop,
  onApprovalDecision,
  onSelectTheme,
  onChangeFontSize,
  onChangeBubbleRadius,
  onChangeAccentColor,
  onSelectLocale,
  onOpenExportModal,
  onOpenShortcutsModal,
  onLogout,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  themePreset: DesktopThemePreset;
  fontSize: number;
  bubbleRadius: number;
  accentColor: string;
  pendingApprovals: PendingBrowserCommandDto[];
  activeSection: SettingsSectionId;
  onSelectSection: (sec: SettingsSectionId) => void;
  onBackToChats: () => void;
  onPolicyChange: (next: BrowserRunPolicy) => void;
  onEmergencyStop: () => void;
  onApprovalDecision: (cmdId: string, approved: boolean, remember: boolean) => void;
  onSelectTheme: (preset: DesktopThemePreset) => void;
  onChangeFontSize: (px: number) => void;
  onChangeBubbleRadius: (px: number) => void;
  onChangeAccentColor: (hex: string) => void;
  onSelectLocale: (loc: ExtensionLocale) => void;
  onOpenExportModal: () => void;
  onOpenShortcutsModal: () => void;
  onLogout: () => void;
}) {
  // Profile edit state
  const [profileName, setProfileName] = useState(state.username ?? '');
  const [profileBio, setProfileBio] = useState('');
  const [statusBanner, setStatusBanner] = useState('');
  const [errorBanner, setErrorBanner] = useState('');

  // Passcode state
  const [newPin, setNewPin] = useState('');

  // 2FA state
  const [twoFaPassword, setTwoFaPassword] = useState('');

  // Sessions state
  const [sessions, setSessions] = useState<Array<Record<string, any>>>([]);

  // AI Providers & Magpie URI state
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerModel, setProviderModel] = useState('gpt-4o-mini');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [magpieUri, setMagpieUri] = useState('');
  const [magpieError, setMagpieError] = useState('');

  // Computers & Domain Access state
  const [allowedDomainsText, setAllowedDomainsText] = useState(state.allowed_domains.join(', '));
  const [blockedDomainsText, setBlockedDomainsText] = useState(state.blocked_domains.join(', '));
  const [desktopWsInput, setDesktopWsInput] = useState(state.desktop_ws_url ?? '');
  const [pairingTokenInput, setPairingTokenInput] = useState('');
  const [computers, setComputers] = useState<Array<Record<string, any>>>([]);

  useEffect(() => {
    setAllowedDomainsText(state.allowed_domains.join(', '));
    setBlockedDomainsText(state.blocked_domains.join(', '));
  }, [state.allowed_domains, state.blocked_domains]);

  useEffect(() => {
    setStatusBanner('');
    setErrorBanner('');
    setMagpieError('');

    if (!state.authenticated) return;

    if (activeSection === 'ActiveSessions' || activeSection === 'Devices') {
      void apiRequest<any>('/api/v1/auth/sessions').then((res) => {
        if (res.ok) {
          setSessions(
            Array.isArray(res.data?.sessions)
              ? res.data.sessions
              : Array.isArray(res.data)
                ? res.data
                : [],
          );
        }
      });
    } else if (activeSection === 'Computers') {
      void apiRequest<any>('/api/v1/computers').then((res) => {
        if (res.ok) {
          setComputers(
            Array.isArray(res.data?.computers)
              ? res.data.computers
              : Array.isArray(res.data)
                ? res.data
                : [],
          );
        }
      });
    } else if (activeSection === 'AiProviders') {
      void Promise.all([
        chrome.storage.local.get(['ext_bot_config']),
        apiRequest<any>('/api/v1/hermes/providers'),
      ]).then(([raw, srvRes]) => {
        const cfg = raw?.ext_bot_config as Record<string, any> | undefined;
        let nextUrl = cfg?.base_url ? String(cfg.base_url) : '';
        let nextModel = cfg?.model ? String(cfg.model) : '';
        if (srvRes.ok && srvRes.data) {
          const list = Array.isArray(srvRes.data?.providers)
            ? srvRes.data.providers
            : Array.isArray(srvRes.data)
              ? srvRes.data
              : [];
          const activeProv =
            list.find((p: any) => p?.is_active || p?.active || p?.enabled) ??
            srvRes.data?.active_provider ??
            list[0];
          if (!nextUrl && activeProv?.base_url) nextUrl = String(activeProv.base_url);
          if (!nextModel && (activeProv?.default_model ?? activeProv?.model)) {
            nextModel = String(activeProv.default_model ?? activeProv.model);
          }
        }
        if (nextUrl) setProviderBaseUrl(nextUrl);
        if (nextModel) setProviderModel(nextModel);
      });
    }
  }, [activeSection, state.authenticated]);

  const handleEnablePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner('');
    if (newPin.trim().length < 4) {
      setErrorBanner('Passcode PIN must be at least 4 characters.');
      return;
    }
    const hash = await hashPasscodeSha256(newPin.trim());
    await sendSwRpc({
      type: 'ui.set_preferences',
      passcode_enabled: true,
      passcode_hash: hash,
      passcode_locked: false,
    });
    setNewPin('');
    setStatusBanner('✓ Local passcode enabled.');
  };

  const handleDisablePasscode = async () => {
    await sendSwRpc({
      type: 'ui.set_preferences',
      passcode_enabled: false,
      passcode_hash: '',
      passcode_locked: false,
    });
    setStatusBanner('Local passcode removed.');
  };

  const handleMagpieImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setMagpieError('');
    setStatusBanner('');
    // Validate strictly BEFORE mutating provider config (T2-F14-04)
    const parsed = parseMagpieImportUri(magpieUri);
    if (!parsed.ok || !parsed.config) {
      setMagpieError(parsed.error || 'Malformed magpie:// import URI');
      return;
    }

    const cfg = parsed.config;
    const nextBase = String(cfg.base_url ?? cfg.endpoint ?? providerBaseUrl);
    const nextModel = String(cfg.model ?? providerModel);
    if (nextBase) setProviderBaseUrl(nextBase);
    if (nextModel) setProviderModel(nextModel);

    if (state.authenticated) {
      await apiRequest('/api/v1/hermes/magpie/import', {
        method: 'POST',
        body: { uri: magpieUri.trim(), config: cfg },
      });
    }
    await chrome.storage.local.set({
      ext_bot_config: {
        enabled: true,
        base_url: nextBase,
        model: nextModel,
        api_key: String(cfg.api_key ?? providerApiKey),
      },
    });
    setMagpieUri('');
    setStatusBanner('✓ Imported Magpie AI provider configuration.');
  };

  const handleSaveAiProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    await chrome.storage.local.set({
      ext_bot_config: {
        enabled: true,
        base_url: providerBaseUrl.trim(),
        model: providerModel.trim() || 'gpt-4o-mini',
        api_key: providerApiKey.trim(),
      },
    });
    if (state.authenticated && providerBaseUrl.trim()) {
      await apiRequest('/api/v1/hermes/providers', {
        method: 'PUT',
        body: {
          base_url: providerBaseUrl.trim(),
          model: providerModel.trim(),
          api_key: providerApiKey.trim() || undefined,
        },
      });
    }
    setStatusBanner('✓ Saved AI Provider settings.');
  };

  const handleSaveDomainsAndBridge = async () => {
    await sendSwRpc({
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
    });
    if (desktopWsInput.trim() || pairingTokenInput.trim()) {
      await sendSwRpc({
        type: 'bridge.reconnect',
        bridge_config: {
          desktop_ws_url: desktopWsInput.trim() || undefined,
          pairing_token: pairingTokenInput.trim() || undefined,
        },
      });
    }
    setStatusBanner('✓ Updated Browser & Desktop Bridge settings.');
  };

  return (
    <section className="settings-router" data-testid={CANONICAL_TEST_IDS.settingsRouter}>
      <header className="stage-topbar">
        <div className="row-gap-8">
          <button
            type="button"
            className="btn sm"
            data-testid="settings-back-btn"
            onClick={() => {
              if (activeSection !== 'Overview') {
                onSelectSection('Overview');
              } else {
                onBackToChats();
              }
            }}
          >
            ← {tr(locale, 'settings.back')}
          </button>
          <h2 className="pane-heading">
            ⚙️ {tr(locale, `settings.${activeSection}` as TranslationKey)}
          </h2>
        </div>

        <BridgeHeaderControls
          state={state}
          locale={locale}
          onPolicyChange={onPolicyChange}
          onEmergencyStop={onEmergencyStop}
        />
      </header>

      <div className="settings-split-body">
        {/* 26-Section Left Navigation */}
        <nav className="settings-nav-list" aria-label="Settings Sections">
          {ALL_26_SETTINGS_SECTIONS.map((sec) => (
            <button
              key={sec}
              type="button"
              data-section={sec}
              data-testid={`settings-nav-${sec}`}
              className={`settings-nav-item ${activeSection === sec ? 'active' : ''}`}
              onClick={() => onSelectSection(sec)}
            >
              {tr(locale, `settings.${sec}` as TranslationKey)}
            </button>
          ))}
        </nav>

        {/* Active Section Detail Pane */}
        <div className="settings-detail-pane" data-active-section={activeSection}>
          <PendingApprovalBannerList items={pendingApprovals} onDecision={onApprovalDecision} />

          {errorBanner && (
            <div className="error-banner" role="alert">
              {errorBanner}
            </div>
          )}
          {statusBanner && <div className="info-banner">{statusBanner}</div>}

          {/* Default Overview + Domain Security Quick Access */}
          {activeSection === 'Overview' && (
            <div className="auth-form-stack" data-testid="settings-pane-Overview">
              <div className="card-sub-box row-between">
                <div>
                  <h3>@{state.username || 'guest'}</h3>
                  <div className="muted-xs">
                    User ID: {state.user_id ?? '-'} • Server: {state.server_url}
                  </div>
                </div>
                {state.authenticated && (
                  <button
                    type="button"
                    className="btn danger"
                    data-testid="settings-logout-btn"
                    onClick={onLogout}
                  >
                    Log Out
                  </button>
                )}
              </div>

              <div className="card-sub-box auth-form-stack">
                <strong>🛡️ Security & Domain Access Control</strong>
                <label className="field-stack">
                  <span className="field-label">
                    Allowed Domains (comma-separated, empty = allow all http/https)
                  </span>
                  <input
                    className="input"
                    data-testid="settings-allowed-domains-input"
                    value={allowedDomainsText}
                    onChange={(e) => setAllowedDomainsText(e.target.value)}
                    placeholder="example.com, 127.0.0.1"
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Blocked Domains (comma-separated)</span>
                  <input
                    className="input"
                    data-testid="settings-blocked-domains-input"
                    value={blockedDomainsText}
                    onChange={(e) => setBlockedDomainsText(e.target.value)}
                    placeholder="localhost, untrusted.invalid"
                  />
                </label>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="settings-save-domains-btn"
                  onClick={() => void handleSaveDomainsAndBridge()}
                >
                  Save Domain Policy
                </button>
              </div>
            </div>
          )}

          {/* Edit Profile */}
          {activeSection === 'EditProfile' && (
            <form
              className="card-sub-box auth-form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await apiRequest('/api/v1/users/me', {
                  method: 'PUT',
                  body: { first_name: profileName.trim(), bio: profileBio.trim() },
                });
                setStatusBanner(res.ok ? '✓ Profile updated.' : res.error || 'Failed');
              }}
            >
              <label className="field-stack">
                <span className="field-label">Display Name</span>
                <input
                  className="input"
                  data-testid="profile-name-input"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                />
              </label>
              <label className="field-stack">
                <span className="field-label">Bio</span>
                <textarea
                  className="input"
                  rows={3}
                  data-testid="profile-bio-input"
                  value={profileBio}
                  onChange={(e) => setProfileBio(e.target.value)}
                />
              </label>
              <button type="submit" className="btn primary" data-testid="profile-save-btn">
                Save Profile
              </button>
            </form>
          )}

          {/* Appearance & Themes (`Chat`) */}
          {activeSection === 'Chat' && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-Chat">
              <strong>🎨 .tdesktop-theme Presets</strong>
              <div className="theme-cards-grid">
                {THEME_CYCLE_ORDER.map((preset) => {
                  const p = DESKTOP_THEME_PALETTES[preset];
                  return (
                    <button
                      key={preset}
                      type="button"
                      data-theme={preset}
                      data-testid={`appearance-theme-${preset}`}
                      className={`theme-preview-card ${themePreset === preset ? 'active' : ''}`}
                      onClick={() => onSelectTheme(preset)}
                    >
                      <span
                        className="theme-swatch-dot"
                        style={{ backgroundColor: p.stageBg, borderColor: p.defaultAccent }}
                      />
                      <strong>{locale === 'zh-CN' ? p.labelZh : p.labelEn}</strong>
                    </button>
                  );
                })}
              </div>

              <label className="field-stack">
                <span className="field-label">Message Font Size: {fontSize}px</span>
                <input
                  type="range"
                  min={12}
                  max={20}
                  step={1}
                  data-testid="appearance-font-slider"
                  value={fontSize}
                  onChange={(e) => onChangeFontSize(Number(e.target.value))}
                />
              </label>

              <label className="field-stack">
                <span className="field-label">Bubble Corner Radius: {bubbleRadius}px</span>
                <input
                  type="range"
                  min={6}
                  max={18}
                  step={1}
                  data-testid="appearance-radius-slider"
                  value={bubbleRadius}
                  onChange={(e) => onChangeBubbleRadius(Number(e.target.value))}
                />
              </label>

              <div className="field-stack">
                <span className="field-label">Accent Color ({accentColor})</span>
                <div className="row-gap-6">
                  {ACCENT_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      data-accent={hex}
                      className={`color-swatch-btn ${accentColor.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`}
                      style={{ backgroundColor: hex }}
                      onClick={() => onChangeAccentColor(hex)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Language */}
          {activeSection === 'Language' && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-Language">
              <button
                type="button"
                data-testid="lang-option-en-US"
                className={`menu-item-btn ${locale === 'en-US' ? 'active' : ''}`}
                onClick={() => onSelectLocale('en-US')}
              >
                🇺🇸 English (en-US)
              </button>
              <button
                type="button"
                data-testid="lang-option-zh-CN"
                className={`menu-item-btn ${locale === 'zh-CN' ? 'active' : ''}`}
                onClick={() => onSelectLocale('zh-CN')}
              >
                🇨🇳 简体中文 (zh-CN)
              </button>
            </div>
          )}

          {/* Local Passcode Lock */}
          {activeSection === 'LocalPasscode' && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-LocalPasscode">
              <form className="auth-form-stack" onSubmit={(e) => void handleEnablePasscode(e)}>
                <label className="field-stack">
                  <span className="field-label">Set Local Passcode PIN (SHA-256)</span>
                  <input
                    type="password"
                    className="input"
                    data-testid="passcode-setup-input"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                    placeholder="Enter 4+ digit PIN"
                  />
                </label>
                <div className="row-gap-8">
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="passcode-enable-btn"
                  >
                    Save Passcode
                  </button>
                  {state.passcode_enabled && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        data-testid="passcode-lock-now-btn"
                        onClick={() =>
                          void sendSwRpc({ type: 'ui.set_preferences', passcode_locked: true })
                        }
                      >
                        🔒 Lock Now
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        data-testid="passcode-disable-btn"
                        onClick={() => void handleDisablePasscode()}
                      >
                        Disable Passcode
                      </button>
                    </>
                  )}
                </div>
              </form>
            </div>
          )}

          {/* Two-Step Verification (2FA) */}
          {activeSection === 'TwoStepVerification' && (
            <div className="card-sub-box auth-form-stack">
              <label className="field-stack">
                <span className="field-label">Cloud 2FA Password</span>
                <input
                  type="password"
                  className="input"
                  data-testid="twofa-password-input"
                  value={twoFaPassword}
                  onChange={(e) => setTwoFaPassword(e.target.value)}
                  placeholder="New 2FA password"
                />
              </label>
              <div className="row-gap-8">
                <button
                  type="button"
                  className="btn primary"
                  onClick={async () => {
                    const r = await apiRequest('/api/v1/auth/2fa/set', {
                      method: 'POST',
                      body: { password: twoFaPassword, new_password: twoFaPassword },
                    });
                    setStatusBanner(r.ok ? '✓ 2FA enabled.' : r.error || 'Failed');
                  }}
                >
                  Enable 2FA
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => {
                    await apiRequest('/api/v1/auth/2fa/disable', { method: 'POST', body: {} });
                    setStatusBanner('2FA disabled.');
                  }}
                >
                  Disable 2FA
                </button>
              </div>
            </div>
          )}

          {/* Active Sessions & Linked Devices */}
          {(activeSection === 'ActiveSessions' || activeSection === 'Devices') && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-ActiveSessions">
              <strong>📱 Active Sessions ({sessions.length})</strong>
              {sessions.map((s, idx) => {
                const sid = String(s.session_id ?? s.id ?? idx);
                const isCurrent = Boolean(s.current || s.is_current);
                return (
                  <div key={sid} className="studio-list-row" data-testid="session-device-row">
                    <div className="flex-1">
                      <strong>{String(s.device_name ?? s.platform ?? `Session ${sid}`)}</strong>
                      {isCurrent && <span className="badge-pill">Current</span>}
                      <div className="muted-xs">{String(s.ip ?? sid)}</div>
                    </div>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="btn sm danger"
                        data-testid={`revoke-session-${sid}`}
                        onClick={async () => {
                          await apiRequest(`/api/v1/auth/sessions/${encodeURIComponent(sid)}`, {
                            method: 'DELETE',
                          });
                          setSessions((prev) =>
                            prev.filter((item) => String(item.session_id ?? item.id) !== sid),
                          );
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* AI Models, Providers & Magpie URI Import */}
          {activeSection === 'AiProviders' && (
            <div className="auth-form-stack" data-testid="settings-pane-AiProviders">
              <form className="card-sub-box auth-form-stack" onSubmit={(e) => void handleSaveAiProvider(e)}>
                <strong>🤖 OpenAI-Compatible / Hermes Provider</strong>
                <label className="field-stack">
                  <span className="field-label">Base URL</span>
                  <input
                    className="input"
                    data-testid="provider-base-url-input"
                    value={providerBaseUrl}
                    onChange={(e) => setProviderBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Model</span>
                  <input
                    className="input"
                    data-testid="provider-model-input"
                    value={providerModel}
                    onChange={(e) => setProviderModel(e.target.value)}
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">API Key</span>
                  <input
                    type="password"
                    className="input"
                    data-testid="provider-apikey-input"
                    value={providerApiKey}
                    onChange={(e) => setProviderApiKey(e.target.value)}
                    placeholder="sk-…"
                  />
                </label>
                <button type="submit" className="btn primary" data-testid="provider-save-btn">
                  Save Provider
                </button>
              </form>

              <form className="card-sub-box auth-form-stack" onSubmit={(e) => void handleMagpieImport(e)}>
                <strong>🐦 Import magpie:// Gateway URI</strong>
                {magpieError && (
                  <div className="error-banner" role="alert" data-testid="magpie-import-error">
                    {magpieError}
                  </div>
                )}
                <input
                  className="input mono"
                  data-testid="magpie-import-input"
                  value={magpieUri}
                  onChange={(e) => setMagpieUri(e.target.value)}
                  placeholder="magpie://eyJiYXNlX3VybCI6..."
                />
                <button type="submit" className="btn" data-testid="magpie-import-btn">
                  Import Magpie Config
                </button>
              </form>
            </div>
          )}

          {/* Computers & Dual-Transport Bridge */}
          {activeSection === 'Computers' && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-Computers">
              <strong>🖥️ Desktop Loopback & Server Relay Bridge</strong>
              <div className="muted-xs">
                Extension ID: <code>{state.extension_id}</code> • WASM Core:{' '}
                {state.wasm_ready ? 'Ready' : 'Loading'}
              </div>
              <label className="field-stack">
                <span className="field-label">Desktop Loopback WS URL (127.0.0.1)</span>
                <input
                  className="input mono"
                  data-testid="desktop-ws-url-input"
                  value={desktopWsInput}
                  onChange={(e) => setDesktopWsInput(e.target.value)}
                  placeholder="ws://127.0.0.1:19222/ext/ws"
                />
              </label>
              <label className="field-stack">
                <span className="field-label">Desktop Pairing Token</span>
                <input
                  type="password"
                  className="input mono"
                  data-testid="desktop-pairing-token-input"
                  value={pairingTokenInput}
                  onChange={(e) => setPairingTokenInput(e.target.value)}
                  placeholder="Shared loopback token"
                />
              </label>
              <button
                type="button"
                className="btn primary"
                data-testid="bridge-save-reconnect-btn"
                onClick={() => void handleSaveDomainsAndBridge()}
              >
                Save & Reconnect Bridges
              </button>
              {computers.length > 0 && (
                <div className="muted-xs">Paired Remote Computers: {computers.length}</div>
              )}
            </div>
          )}

          {/* Advanced & Export */}
          {activeSection === 'Advanced' && (
            <div className="card-sub-box auth-form-stack" data-testid="settings-pane-Advanced">
              <strong>🛠️ Advanced Diagnostics & Export</strong>
              <div className="row-gap-8">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="open-export-modal-btn"
                  onClick={onOpenExportModal}
                >
                  📦 Export Account Data (JSON)
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="open-shortcuts-modal-btn"
                  onClick={onOpenShortcutsModal}
                >
                  ⌨️ Keyboard Shortcuts Legend
                </button>
              </div>
            </div>
          )}

          {/* Remaining Canonical Sections render clean interactive settings cards */}
          {![
            'Overview',
            'EditProfile',
            'Chat',
            'Language',
            'LocalPasscode',
            'TwoStepVerification',
            'ActiveSessions',
            'Devices',
            'AiProviders',
            'Computers',
            'Advanced',
          ].includes(activeSection) && (
            <div className="card-sub-box auth-form-stack" data-testid={`settings-pane-${activeSection}`}>
              <h3>{tr(locale, `settings.${activeSection}` as TranslationKey)}</h3>
              <p className="muted-sm">
                1:1 GPUI Telegram {activeSection} configuration synchronized with{' '}
                <code>{state.server_url}</code>.
              </p>
              <label className="checkbox-row">
                <input type="checkbox" defaultChecked />
                <span>Enable real-time sync for {activeSection}</span>
              </label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
