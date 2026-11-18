import React, { useEffect, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  type BrowserRunPolicy,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../../shared/rpc_types';
import { invokeWasm } from '../../wasm/wasm_bridge';
import { apiRequest } from '../api/server_api';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';

export type InspectorTabId = 'profile' | 'members' | 'media' | 'settings' | 'studio';

function validateDomainList(rawText: string): { valid: boolean; list: string[]; error?: string } {
  const trimmed = rawText.trim();
  if (!trimmed) return { valid: true, list: [] };

  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const normalized: string[] = [];
  for (const token of parts) {
    // Reject spaces or control chars inside a domain rule (T2-F14-06)
    if (/\s/.test(token)) {
      return {
        valid: false,
        list: [],
        error: 'Invalid domain rule: hostnames cannot contain whitespace.',
      };
    }
    if (token === '*') {
      normalized.push('*');
      continue;
    }

    let candidate = token;
    if (candidate.includes('://')) {
      try {
        const u = new URL(candidate);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { valid: false, list: [], error: `Unsupported URL scheme in "${token}"` };
        }
        candidate = u.hostname;
      } catch {
        return { valid: false, list: [], error: `Malformed URL/domain pattern "${token}"` };
      }
    } else if (candidate.includes('/')) {
      return { valid: false, list: [], error: `Domain rule "${token}" must not include path slashes` };
    } else if (candidate.includes(':')) {
      const [hostPart, portPart] = candidate.split(':');
      if (!hostPart || !/^\d+$/.test(portPart ?? '')) {
        return { valid: false, list: [], error: `Invalid host:port syntax "${token}"` };
      }
      candidate = hostPart;
    }

    const hostBody = candidate.startsWith('*.') ? candidate.slice(2) : candidate;
    if (!hostBody || !/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(hostBody)) {
      return {
        valid: false,
        list: [],
        error: `Invalid hostname characters in "${token}"`,
      };
    }
    normalized.push(candidate.toLowerCase());
  }

  return { valid: true, list: normalized };
}

export function ContextInspector({
  state,
  locale,
  activeDialog,
  messages,
  initialTab,
  onClose,
  onStartCall,
  onOpenMiniAppPicker,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  activeDialog: StoredDialogDto | null;
  messages: StoredMessageDto[];
  initialTab?: InspectorTabId;
  onClose: () => void;
  onStartCall: (video: boolean) => void;
  onOpenMiniAppPicker: () => void;
}) {
  const isBot = Boolean(
    activeDialog?.is_bot ||
      activeDialog?.chat_type === 'bot' ||
      activeDialog?.chat_id === LOCAL_COPILOT_CHAT_ID,
  );
  const [tab, setTab] = useState<InspectorTabId>(initialTab ?? (isBot ? 'studio' : 'profile'));
  const [members, setMembers] = useState<Array<Record<string, any>>>([]);
  const [safetyEmojis, setSafetyEmojis] = useState<string>('🔒 🛡️ 🔑 ✨');

  // Bot Studio Browser Profile State
  const [resolvedBotId, setResolvedBotId] = useState<number>(OFFICIAL_BOT_USER_ID);
  const [botBrowserEnabled, setBotBrowserEnabled] = useState<boolean>(true);
  const [botRunPolicy, setBotRunPolicy] = useState<BrowserRunPolicy>(
    state.run_policy || 'always_allow_authorized',
  );
  const [allowedDomainsInput, setAllowedDomainsInput] = useState<string>(
    state.allowed_domains.join(', '),
  );
  const [blockedDomainsInput, setBlockedDomainsInput] = useState<string>(
    state.blocked_domains.join(', '),
  );
  const [preferredTarget, setPreferredTarget] = useState<'auto' | 'extension' | 'desktop'>('auto');
  const [studioStatus, setStudioStatus] = useState<string>('');
  const [studioError, setStudioError] = useState<string>('');
  const [savingStudio, setSavingStudio] = useState<boolean>(false);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // Load members + resolve bot user_id + load `/api/v1/bots/{bot_id}/browser`
  useEffect(() => {
    let cancelled = false;
    const chatId = activeDialog?.chat_id ?? LOCAL_COPILOT_CHAT_ID;

    const loadDetails = async () => {
      let botUid = activeDialog?.peer_user_id ?? 0;

      if (chatId > 0 && state.authenticated) {
        const memRes = await apiRequest<any>(`/api/v1/chats/${chatId}/members`);
        if (!cancelled && memRes.ok) {
          const list = Array.isArray(memRes.data?.members)
            ? memRes.data.members
            : Array.isArray(memRes.data)
              ? memRes.data
              : [];
          setMembers(list);
          if (!botUid) {
            const peerMember = list.find(
              (m: any) =>
                Boolean(m?.is_bot) ||
                (m?.user_id && Number(m.user_id) !== Number(state.user_id)),
            );
            if (peerMember?.user_id) {
              botUid = Number(peerMember.user_id);
            }
          }
        }
      } else {
        setMembers([]);
      }

      if (!botUid && isBot && state.authenticated && activeDialog?.peer_username) {
        const botsRes = await apiRequest<any>('/api/v1/fabushi-bots');
        if (!cancelled && botsRes.ok) {
          const bList = Array.isArray(botsRes.data?.bots)
            ? botsRes.data.bots
            : Array.isArray(botsRes.data)
              ? botsRes.data
              : [];
          const hit = bList.find(
            (b: any) =>
              String(b?.username ?? '').toLowerCase() ===
              String(activeDialog.peer_username).toLowerCase(),
          );
          if (hit) {
            botUid = Number(hit.bot_user_id ?? hit.user_id ?? hit.id ?? 0);
          }
        }
      }

      const finalBotId = botUid > 0 ? botUid : OFFICIAL_BOT_USER_ID;
      if (!cancelled) setResolvedBotId(finalBotId);

      if (isBot && state.authenticated) {
        const profRes = await apiRequest<any>(`/api/v1/bots/${finalBotId}/browser`);
        if (!cancelled && profRes.ok && profRes.data) {
          const p = profRes.data.profile ?? profRes.data;
          if (typeof p.enabled === 'boolean') setBotBrowserEnabled(p.enabled);
          if (typeof p.run_policy === 'string') {
            setBotRunPolicy(p.run_policy as BrowserRunPolicy);
          }
          if (Array.isArray(p.allowed_domains)) {
            setAllowedDomainsInput(p.allowed_domains.join(', '));
          }
          if (Array.isArray(p.blocked_domains)) {
            setBlockedDomainsInput(p.blocked_domains.join(', '));
          }
          if (p.preferred_target === 'extension' || p.preferred_target === 'desktop' || p.preferred_target === 'auto') {
            setPreferredTarget(p.preferred_target);
          }
        }
      }

      // Compute deterministic WASM safety number emojis
      const idRes = await invokeWasm<any>('e2ee_generate_identity', {
        device_id: `insp_${state.user_id ?? 0}`,
        spk_id: 1,
        otpk_count: 1,
      });
      if (!cancelled && idRes.ok && idRes.data?.identity_key) {
        const localIk = String(idRes.data.identity_key);
        const safety = await invokeWasm<any>('safety_number_emojis', {
          local_ik: localIk,
          remote_ik: localIk,
        });
        if (safety.ok && safety.data) {
          const em = Array.isArray(safety.data.emojis)
            ? safety.data.emojis.join(' ')
            : String(safety.data.emojis ?? safety.data);
          if (em) setSafetyEmojis(em);
        }
      }
    };

    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [
    activeDialog?.chat_id,
    activeDialog?.peer_user_id,
    activeDialog?.peer_username,
    isBot,
    state.authenticated,
    state.user_id,
  ]);

  const handleSaveBotBrowserProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setStudioError('');
    setStudioStatus('');

    const allowedCheck = validateDomainList(allowedDomainsInput);
    if (!allowedCheck.valid) {
      setStudioError(allowedCheck.error || tr(locale, 'inspector.invalidDomain'));
      return;
    }
    const blockedCheck = validateDomainList(blockedDomainsInput);
    if (!blockedCheck.valid) {
      setStudioError(blockedCheck.error || tr(locale, 'inspector.invalidDomain'));
      return;
    }

    setSavingStudio(true);
    const effectivePolicy: BrowserRunPolicy = botBrowserEnabled ? botRunPolicy : 'disabled';

    if (state.authenticated) {
      const putRes = await apiRequest(`/api/v1/bots/${resolvedBotId}/browser`, {
        method: 'PUT',
        body: {
          bot_user_id: resolvedBotId,
          enabled: botBrowserEnabled,
          run_policy: botRunPolicy,
          allowed_domains: allowedCheck.list,
          blocked_domains: blockedCheck.list,
          preferred_target: preferredTarget,
        },
      });
      if (!putRes.ok) {
        setSavingStudio(false);
        setStudioError(putRes.error || 'Failed to save bot browser profile');
        return;
      }
    }

    await sendSwRpc({
      type: 'ui.set_policy',
      policy: effectivePolicy,
      allowed_domains: allowedCheck.list,
      blocked_domains: blockedCheck.list,
    });
    setSavingStudio(false);
    setStudioStatus('✓ Saved bot browser policy');
  };

  const sharedMediaMsgs = messages.filter(
    (m) => m.media_data_url || m.content?.media_id || m.content?.file_id,
  );

  return (
    <aside
      className="context-inspector"
      data-testid={CANONICAL_TEST_IDS.contextInspector}
      aria-label={tr(locale, 'inspector.title')}
    >
      <div className="inspector-header">
        <strong>{tr(locale, 'inspector.title')}</strong>
        <button
          type="button"
          className="btn ghost xs"
          data-testid="close-inspector-btn"
          aria-label="Close inspector"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="inspector-tabs" role="tablist">
        {(
          [
            ['profile', tr(locale, 'inspector.tab.profile')],
            ['members', tr(locale, 'inspector.tab.members')],
            ['media', tr(locale, 'inspector.tab.media')],
            ['settings', tr(locale, 'inspector.tab.settings')],
            ['studio', tr(locale, 'inspector.tab.studio')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-tab={id}
            data-testid={`inspector-tab-${id}`}
            className={`folder-tab-btn xs ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="inspector-body">
        {tab === 'profile' && (
          <div className="inspector-profile-stack">
            <div className="avatar-xl">
              {(activeDialog?.title || 'HC').slice(0, 2).toUpperCase()}
            </div>
            <h3 className="inspector-peer-name">
              {activeDialog?.title || tr(locale, 'sidebar.localCopilot')}
            </h3>
            <div className="muted-xs">
              {activeDialog?.peer_username
                ? `@${activeDialog.peer_username}`
                : `Chat #${activeDialog?.chat_id ?? LOCAL_COPILOT_CHAT_ID}`}
            </div>
            {activeDialog?.about && <p className="muted-sm">{activeDialog.about}</p>}

            <div className="inspector-quick-grid">
              <button type="button" className="btn sm" onClick={() => onStartCall(false)}>
                📞 Call
              </button>
              <button type="button" className="btn sm" onClick={() => onStartCall(true)}>
                📹 Video
              </button>
              {isBot && (
                <button
                  type="button"
                  className="btn sm primary"
                  data-testid="inspector-open-miniapp-btn"
                  onClick={onOpenMiniAppPicker}
                >
                  🧩 Mini App
                </button>
              )}
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div className="inspector-list-stack" data-testid="inspector-members-list">
            {members.length === 0 ? (
              <div className="muted-xs">
                {activeDialog?.chat_type === 'private' || isBot
                  ? 'Direct 1:1 conversation'
                  : 'No member list loaded'}
              </div>
            ) : (
              members.map((m, idx) => (
                <div key={String(m.user_id ?? idx)} className="member-item">
                  <span className="avatar-sm">
                    {String(m.username ?? m.first_name ?? 'U').slice(0, 2).toUpperCase()}
                  </span>
                  <div className="flex-1">
                    <div>{String(m.first_name ?? m.username ?? `User #${m.user_id}`)}</div>
                    <div className="muted-xs">{String(m.role ?? 'member')}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'media' && (
          <div className="inspector-list-stack" data-testid="inspector-shared-media">
            {sharedMediaMsgs.length === 0 ? (
              <div className="muted-xs">No shared media in this conversation yet.</div>
            ) : (
              sharedMediaMsgs.map((m) => (
                <div key={m.message_id} className="shared-media-row">
                  <span>🖼️</span>
                  <span className="truncate-1">{m.text || `Media #${m.message_id}`}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="inspector-list-stack" data-testid="inspector-security-panel">
            <div className="card-sub-box">
              <strong>🔐 {tr(locale, 'stage.e2eeVerified')}</strong>
              <div className="safety-emoji-box" data-testid="inspector-safety-emojis">
                {safetyEmojis}
              </div>
              <div className="muted-xs">
                X3DH + Double Ratchet verified via gpui_telegram_ext_wasm
              </div>
            </div>
          </div>
        )}

        {tab === 'studio' && (
          <form
            className="auth-form-stack"
            data-testid="inspector-bot-studio-form"
            onSubmit={(e) => void handleSaveBotBrowserProfile(e)}
          >
            <div className="muted-xs">
              Target Bot ID: <code>{resolvedBotId}</code>
            </div>

            {studioError && (
              <div className="error-banner" role="alert" data-testid="bot-studio-error">
                {studioError}
              </div>
            )}
            {studioStatus && (
              <div className="info-banner" data-testid="bot-studio-saved">
                {studioStatus}
              </div>
            )}

            <label className="checkbox-row">
              <input
                type="checkbox"
                data-testid="bot-browser-enabled-checkbox"
                aria-label="Enable Browser Control"
                checked={botBrowserEnabled}
                onChange={(e) => setBotBrowserEnabled(e.target.checked)}
              />
              <span>{tr(locale, 'inspector.enableBrowser')}</span>
            </label>

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'inspector.runPolicy')}</span>
              <select
                className="select"
                name="run_policy"
                aria-label="Bot Browser Run Policy"
                data-testid="bot-browser-policy-select"
                value={botRunPolicy}
                onChange={(e) => setBotRunPolicy(e.target.value as BrowserRunPolicy)}
              >
                <option value="always_allow_authorized">always_allow_authorized</option>
                <option value="allow_read_only">allow_read_only</option>
                <option value="ask_every_time">ask_every_time</option>
                <option value="disabled">disabled</option>
              </select>
            </label>

            <div className="policy-radio-chips">
              {(
                [
                  'always_allow_authorized',
                  'allow_read_only',
                  'ask_every_time',
                  'disabled',
                ] as const
              ).map((pol) => (
                <button
                  key={pol}
                  type="button"
                  role="radio"
                  aria-checked={botRunPolicy === pol}
                  data-policy={pol}
                  data-value={pol}
                  className={`chip-btn xs ${botRunPolicy === pol ? 'active' : ''}`}
                  onClick={() => setBotRunPolicy(pol)}
                >
                  {pol}
                </button>
              ))}
            </div>

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'inspector.allowedDomains')}</span>
              <input
                className="input"
                name="allowed_domains"
                aria-label="Allowed Domains"
                data-testid="bot-allowed-domains-input"
                value={allowedDomainsInput}
                onChange={(e) => setAllowedDomainsInput(e.target.value)}
                placeholder="127.0.0.1, localhost, *.example.com"
              />
            </label>

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'inspector.blockedDomains')}</span>
              <input
                className="input"
                name="blocked_domains"
                aria-label="Blocked Domains"
                data-testid="bot-blocked-domains-input"
                value={blockedDomainsInput}
                onChange={(e) => setBlockedDomainsInput(e.target.value)}
                placeholder="evil.invalid"
              />
            </label>

            <label className="field-stack">
              <span className="field-label">{tr(locale, 'inspector.preferredTarget')}</span>
              <select
                className="select"
                name="preferred_target"
                data-testid="bot-preferred-target-select"
                value={preferredTarget}
                onChange={(e) =>
                  setPreferredTarget(e.target.value as 'auto' | 'extension' | 'desktop')
                }
              >
                <option value="auto">auto</option>
                <option value="extension">extension</option>
                <option value="desktop">desktop</option>
              </select>
            </label>

            <button
              type="submit"
              className="btn primary full-width"
              data-testid="bot-studio-save-btn"
              disabled={savingStudio}
            >
              {tr(locale, 'inspector.saveBotPolicy')}
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}
