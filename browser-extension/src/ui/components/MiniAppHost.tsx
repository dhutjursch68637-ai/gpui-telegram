import React, { useEffect, useRef, useState } from 'react';
import { apiRequest, resolveActiveApiSession } from '../api/server_api';
import { sendSwRpc } from '../sw_client';

export interface ActiveMiniAppSession {
  botUsername: string;
  shortName: string;
  title: string;
  launchUrl: string;
  companionChatId: number;
}

export function MiniAppPickerModal({
  open,
  activeChatId,
  activeBotUsername,
  onClose,
  onLaunchMiniApp,
}: {
  open: boolean;
  activeChatId: number;
  activeBotUsername?: string;
  onClose: () => void;
  onLaunchMiniApp: (session: ActiveMiniAppSession) => void;
}) {
  const [apps, setApps] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const launchItem = async (item: Record<string, any>) => {
    setError('');
    const sess = await resolveActiveApiSession();
    const botUser = String(item.bot_username ?? '').replace(/^@/, '');
    const shortName = String(item.short_name ?? 'app');
    const targetChatId = Number(activeChatId > 0 ? activeChatId : item.companion_chat_id || 0);

    const launchRes = await apiRequest<any>(
      `/api/v1/miniapps/${encodeURIComponent(botUser)}/${encodeURIComponent(shortName)}/launch`,
      {
        method: 'POST',
        body: { chat_id: targetChatId > 0 ? targetChatId : undefined },
      },
    );

    let launchUrl = '';
    if (launchRes.ok && launchRes.data) {
      const rawUrl = String(
        launchRes.data.launch_url ??
          launchRes.data.url ??
          launchRes.data.app?.web_url ??
          '',
      );
      const initData = String(
        typeof launchRes.data.init_data === 'string'
          ? launchRes.data.init_data
          : launchRes.data.init_data?.raw_query_string ?? '',
      );
      const appendInitData = (base: string): string => {
        if (!initData) return base;
        const sep = base.includes('?') ? '&' : '?';
        const withQuery = base.includes('init_data=')
          ? base
          : `${base}${sep}init_data=${encodeURIComponent(initData)}`;
        return withQuery.includes('tgWebAppData=')
          ? withQuery
          : `${withQuery}#tgWebAppData=${encodeURIComponent(initData)}`;
      };

      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        launchUrl = appendInitData(rawUrl);
      } else if (rawUrl.startsWith('/')) {
        launchUrl = appendInitData(`${sess.serverUrl}${rawUrl}`);
      } else {
        launchUrl = appendInitData(
          `${sess.serverUrl}/miniapps/${encodeURIComponent(botUser)}/${encodeURIComponent(shortName)}`,
        );
      }
    } else {
      launchUrl = `${sess.serverUrl}/miniapps/${encodeURIComponent(botUser)}/${encodeURIComponent(shortName)}`;
    }

    onLaunchMiniApp({
      botUsername: botUser,
      shortName,
      title: String(item.title ?? shortName),
      launchUrl,
      companionChatId: Number(
        launchRes.data?.companion_chat_id > 0
          ? launchRes.data.companion_chat_id
          : targetChatId,
      ),
    });
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    const load = async () => {
      const [maRes, fbRes] = await Promise.all([
        apiRequest<any>('/api/v1/miniapps'),
        apiRequest<any>('/api/v1/fabushi-bots'),
      ]);
      if (cancelled) return;
      setLoading(false);

      const combined: Array<Record<string, any>> = [];
      const seen = new Set<string>();

      const rawApps = Array.isArray(maRes.data?.miniapps)
        ? maRes.data.miniapps
        : Array.isArray(maRes.data?.apps)
          ? maRes.data.apps
          : Array.isArray(maRes.data)
            ? maRes.data
            : [];

      for (const a of rawApps) {
        const bUser = String(a?.bot_username ?? a?.username ?? activeBotUsername ?? '').replace(/^@/, '');
        const sName = String(a?.short_name ?? a?.app_short_name ?? 'app');
        const key = `${bUser}/${sName}`;
        if (bUser && !seen.has(key)) {
          seen.add(key);
          combined.push({
            bot_username: bUser,
            short_name: sName,
            title: String(a?.title ?? a?.name ?? sName),
            description: String(a?.description ?? ''),
            companion_chat_id: Number(a?.companion_chat_id ?? activeChatId),
          });
        }
      }

      const rawBots = Array.isArray(fbRes.data?.bots)
        ? fbRes.data.bots
        : Array.isArray(fbRes.data)
          ? fbRes.data
          : [];
      for (const b of rawBots) {
        const bUser = String(b?.username ?? '').replace(/^@/, '');
        const sName = String(
          b?.mini_app?.short_name ?? b?.mini_app_short_name ?? b?.short_name ?? 'app',
        );
        const key = `${bUser}/${sName}`;
        if (bUser && !seen.has(key)) {
          seen.add(key);
          combined.push({
            bot_username: bUser,
            short_name: sName,
            title: String(b?.mini_app?.title ?? b?.name ?? bUser),
            description: String(b?.description ?? 'Fabushi Companion Mini App'),
            companion_chat_id: Number(b?.companion_chat_id ?? activeChatId),
          });
        }
      }

      // Sort active bot's mini apps first; if active chat is a bot with a matching Mini App, launch immediately!
      if (activeBotUsername) {
        const target = activeBotUsername.toLowerCase().replace(/^@/, '');
        combined.sort((a, b) => {
          const aMatch = a.bot_username.toLowerCase() === target ? 0 : 1;
          const bMatch = b.bot_username.toLowerCase() === target ? 0 : 1;
          return aMatch - bMatch;
        });
        const directMatch = combined.find((a) => a.bot_username.toLowerCase() === target);
        if (directMatch && !cancelled) {
          setApps(combined);
          await launchItem(directMatch);
          return;
        }
      }

      setApps(combined);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeBotUsername, activeChatId, open]);

  if (!open) return null;

  const handleSelectApp = async (item: Record<string, any>) => {
    await launchItem(item);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        data-testid="miniapp-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between">
          <h3>🧩 Telegram Mini Apps</h3>
          <button type="button" className="btn ghost xs" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {loading ? (
          <div className="muted-sm">Loading registered Mini Apps…</div>
        ) : apps.length === 0 ? (
          <div className="muted-sm">No Mini Apps registered on this server yet.</div>
        ) : (
          <div className="miniapp-picker-list">
            {apps.map((app) => (
              <button
                key={`${app.bot_username}/${app.short_name}`}
                type="button"
                role="option"
                data-testid={`miniapp-item-${app.short_name}`}
                className="miniapp-picker-item"
                onClick={() => void handleSelectApp(app)}
              >
                <div className="avatar-sm">🧩</div>
                <div className="flex-1 text-left">
                  <strong>{app.title}</strong>
                  <div className="muted-xs">
                    @{app.bot_username} / {app.short_name}
                  </div>
                </div>
                <span className="btn sm primary">Launch</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MiniAppHostModal({
  session,
  onClose,
  onDataDispatched,
}: {
  session: ActiveMiniAppSession | null;
  onClose: () => void;
  onDataDispatched: (chatId: number) => Promise<void> | void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [lastEventInfo, setLastEventInfo] = useState<string>('');

  useEffect(() => {
    if (!session) return;

    const onMessage = async (event: MessageEvent) => {
      // STRICT SECURITY CHECK (T2-F14-01):
      // Reject any spoofed postMessage whose source window is NOT the sandboxed Mini App iframe!
      const frameWin = iframeRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) {
        return;
      }

      let payload: any = event.data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== 'object') return;

      const evType = String(payload.eventType ?? payload.type ?? payload.action ?? '');
      if (evType === 'web_app_close') {
        onClose();
        return;
      }

      if (
        evType === 'web_app_data_send' ||
        (payload.type === 'telegram_web_app_event' && payload.eventType === 'web_app_data_send') ||
        evType === 'send_data'
      ) {
        const rawData = String(
          payload.eventData?.data ?? payload.data ?? payload.payload ?? '',
        );
        if (!rawData) return;
        setLastEventInfo(`Sent: ${rawData.slice(0, 60)}`);

        const actionRes = await apiRequest<any>(
          `/api/v1/miniapps/${encodeURIComponent(session.botUsername)}/${encodeURIComponent(session.shortName)}/action`,
          {
            method: 'POST',
            body: {
              action_type: 'send_data',
              action: 'send_data',
              data: rawData,
              chat_id: session.companionChatId > 0 ? session.companionChatId : undefined,
            },
          },
        );

        // Ensure companion chat receives the web_app_data payload even if the bot is a Fabushi bot
        if (session.companionChatId > 0) {
          const recent = await apiRequest<any>(
            `/api/v1/chats/${session.companionChatId}/messages?limit=6`,
          );
          const list = Array.isArray(recent.data?.messages)
            ? recent.data.messages
            : Array.isArray(recent.data)
              ? recent.data
              : [];
          const alreadyPosted = list.some((m: any) => JSON.stringify(m).includes(rawData));
          if (!alreadyPosted && !JSON.stringify(actionRes.data ?? {}).includes(rawData)) {
            await apiRequest('/api/v1/messages/send', {
              method: 'POST',
              body: {
                chat_id: session.companionChatId,
                text: `[MiniApp ${session.shortName}] ${rawData}`,
              },
            });
          }
          await sendSwRpc({ type: 'ui.get_messages', chat_id: session.companionChatId });
          await onDataDispatched(session.companionChatId);
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose, onDataDispatched, session]);

  if (!session) return null;

  return (
    <div className="modal-backdrop" data-testid="miniapp-host-backdrop" onClick={onClose}>
      <div
        className="miniapp-host-modal"
        role="dialog"
        aria-modal="true"
        data-testid="miniapp-host-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="miniapp-host-header">
          <div>
            <strong>🧩 {session.title}</strong>
            <span className="muted-xs"> (@{session.botUsername})</span>
          </div>
          <div className="row-gap-6">
            {lastEventInfo && (
              <span className="badge-pill" data-testid="miniapp-last-event">
                {lastEventInfo}
              </span>
            )}
            <button
              type="button"
              className="btn ghost xs"
              data-testid="miniapp-close-btn"
              onClick={onClose}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Sandboxed without allow-same-origin or allow-top-navigation */}
        <iframe
          ref={iframeRef}
          className="miniapp-iframe"
          data-testid="miniapp-iframe"
          title={session.title}
          sandbox="allow-scripts allow-forms"
          src={session.launchUrl}
        />
      </div>
    </div>
  );
}
