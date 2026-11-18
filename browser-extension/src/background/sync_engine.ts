/**
 * Real-Time Telegram `/api/v1/ws` PTS Sync Coordinator, Gap Recovery (`/api/v1/sync/difference`),
 * Offline Outbox Queue & Reconnect Flush, Unread Badge & Notifications, and 401 Revocation Handler.
 */

import {
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  type OutboxRecordDto,
  type StoredDialogDto,
  type StoredMessageDto,
  type StoredReactionDto,
  type SwToUiEvent,
} from '../shared/rpc_types';
import {
  ensureWasmLoaded,
  wasmDrainContiguousPts,
  wasmEvalPts,
  wasmSetPts,
} from '../wasm/wasm_bridge';
import {
  clearAuthSessionInStorage,
  dbApplyMessageReactions,
  dbDeleteMessages,
  dbEnqueueOutbox,
  dbGetAllDialogs,
  dbGetChatPts,
  dbGetDialog,
  dbGetMessagesForChat,
  dbListOutbox,
  dbRemoveOutbox,
  dbSaveSetting,
  dbSetChatPts,
  dbSetChatUnreadCount,
  dbUpsertDialogs,
  dbUpsertMessages,
  httpToWsBase,
  readNormalizedStorageConfig,
  type NormalizedExtensionConfig,
} from './db';

type BroadcastFn = (event: SwToUiEvent) => void;

function unwrapId(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) {
    return Number(val);
  }
  if (val && typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if (typeof rec[0] === 'number') return rec[0];
    if (typeof rec.id === 'number') return rec.id;
  }
  return null;
}

function parseTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  }
  return Date.now();
}

function extractMessageText(raw: Record<string, any>): string {
  if (typeof raw.text === 'string') return raw.text;
  const content = raw.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.data && typeof content.data.text === 'string') return content.data.text;
    if (content.data && typeof content.data.caption === 'string') return content.data.caption;
    if (typeof content.caption === 'string') return content.caption;
  }
  if (typeof raw.message === 'string') return raw.message;
  return '';
}

function extractReactions(raw: unknown): StoredReactionDto[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: StoredReactionDto[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const r = item as Record<string, any>;
      if (typeof r.emoji === 'string' && r.emoji) {
        out.push({
          emoji: r.emoji,
          count: typeof r.count === 'number' ? r.count : 1,
          me: Boolean(r.is_chosen_by_me ?? r.chosen ?? r.user_reacted ?? r.me),
        });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeServerMessage(
  raw: Record<string, any>,
  fallbackChatId?: number,
): StoredMessageDto | null {
  const chatId = unwrapId(raw.chat_id ?? raw.chatId) ?? fallbackChatId ?? null;
  const messageId = unwrapId(raw.message_id ?? raw.id ?? raw.msg_id);
  if (chatId === null || messageId === null) return null;

  const senderId = unwrapId(raw.sender_id ?? raw.from_user_id ?? raw.author_id) ?? 0;
  const pts = unwrapId(raw.pts) ?? undefined;
  const clientNonce =
    raw.client_nonce !== undefined && raw.client_nonce !== null && String(raw.client_nonce) !== '0'
      ? String(raw.client_nonce)
      : undefined;

  return {
    chat_id: chatId,
    message_id: messageId,
    sender_id: senderId,
    sender_username:
      typeof raw.sender_username === 'string'
        ? raw.sender_username
        : typeof raw.username === 'string'
          ? raw.username
          : undefined,
    text: extractMessageText(raw),
    pts: pts && pts > 0 ? pts : undefined,
    client_nonce: clientNonce,
    created_at_ms: parseTimestampMs(raw.created_at_ms ?? raw.created_at ?? raw.date),
    edited_at_ms:
      raw.edited_at_ms || raw.edited_at || raw.edit_date
        ? parseTimestampMs(raw.edited_at_ms ?? raw.edited_at ?? raw.edit_date)
        : null,
    reply_to_message_id:
      unwrapId(raw.reply_to_message_id ?? raw.reply_to?.reply_to_msg_id ?? raw.reply_to) ?? null,
    reactions: extractReactions(raw.reactions),
    pending_outbox: false,
  };
}

export function normalizeServerDialog(raw: Record<string, any>): StoredDialogDto | null {
  const chatId = unwrapId(raw.chat_id ?? raw.id);
  if (chatId === null) return null;

  const peerUsername =
    typeof raw.peer_username === 'string'
      ? raw.peer_username
      : typeof raw.username === 'string'
        ? raw.username
        : undefined;

  const title =
    (typeof raw.title === 'string' && raw.title.trim()) ||
    (typeof raw.display_name === 'string' && raw.display_name.trim()) ||
    (peerUsername ? `@${peerUsername}` : `Chat #${chatId}`);

  const lastMsg = raw.last_message && typeof raw.last_message === 'object' ? raw.last_message : null;
  const lastPreview =
    typeof raw.last_message_preview === 'string'
      ? raw.last_message_preview
      : lastMsg
        ? extractMessageText(lastMsg)
        : undefined;

  const peerUserId = unwrapId(raw.peer_user_id ?? raw.peer_id ?? raw.bot_user_id) ?? undefined;

  return {
    chat_id: chatId,
    chat_type: String(raw.chat_type ?? raw.type ?? 'dm'),
    title,
    peer_user_id: peerUserId,
    peer_username: peerUsername,
    is_bot: Boolean(raw.is_bot || peerUserId === OFFICIAL_BOT_USER_ID || /bot/i.test(peerUsername ?? '')),
    unread_count: Math.max(0, Number(raw.unread_count ?? 0) || 0),
    pts: Math.max(0, Number(raw.pts ?? lastMsg?.pts ?? 0) || 0),
    last_message_id: unwrapId(raw.last_message_id ?? lastMsg?.message_id ?? lastMsg?.id) ?? undefined,
    last_message_preview: lastPreview,
    updated_at_ms: parseTimestampMs(
      raw.updated_at_ms ?? raw.updated_at ?? lastMsg?.date ?? Date.now(),
    ),
  };
}

export class ExtensionSyncEngine {
  private ws: WebSocket | null = null;
  private activeWsUrl = '';
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private subscribedChats = new Set<number>();
  private gapInFlight = new Set<number>();
  private flushingOutbox = false;
  private authRevoked = false;
  private currentConfig: NormalizedExtensionConfig | null = null;
  private readonly broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
    this.startOutboxWatchdog();
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public getConfig(): NormalizedExtensionConfig | null {
    return this.currentConfig;
  }

  public async rehydrateAndSync(): Promise<void> {
    await ensureWasmLoaded();
    const cfg = await readNormalizedStorageConfig();
    this.currentConfig = cfg;

    if (!cfg.serverUrl || !cfg.token) {
      this.disconnectWs();
      await this.updateUnreadBadge(0);
      return;
    }

    this.authRevoked = false;
    await dbSaveSetting('last_rehydrate_ms', Date.now());

    // 1. Validate session against /api/v1/auth/me (detects 401 session revocation promptly)
    const sessionOk = await this.verifyAuthSession(cfg);
    if (!sessionOk) {
      return;
    }

    // 2. Connect or maintain /api/v1/ws
    const targetWsUrl = `${httpToWsBase(cfg.serverUrl)}/api/v1/ws?token=${encodeURIComponent(cfg.token)}`;
    if (
      !this.ws ||
      this.activeWsUrl !== targetWsUrl ||
      (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)
    ) {
      this.connectWs(targetWsUrl);
    }

    // 3. Flush any pending offline outbox items first, then sync dialogs & chat differences
    await this.flushOutbox();
    await this.syncDialogsAndMissedMessages(cfg);
  }

  private async verifyAuthSession(cfg: NormalizedExtensionConfig): Promise<boolean> {
    try {
      const resp = await fetch(`${cfg.serverUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/json',
        },
      });

      if (resp.status === 401) {
        await this.handleSessionRevoked('401 Unauthorized from /api/v1/auth/me');
        return false;
      }

      if (resp.ok) {
        const me = (await resp.json().catch(() => null)) as Record<string, any> | null;
        if (me) {
          const uid = unwrapId(me.user_id ?? me.id);
          if (uid !== null && this.currentConfig) {
            this.currentConfig.userId = uid;
          }
          if (typeof me.username === 'string' && this.currentConfig) {
            this.currentConfig.username = me.username;
          }
        }
      }
      return true;
    } catch {
      // Network/offline error: preserve local IndexedDB state & session, do NOT clear token!
      return true;
    }
  }

  private async handleSessionRevoked(reason: string): Promise<void> {
    if (this.authRevoked) return;
    this.authRevoked = true;
    this.disconnectWs();
    await clearAuthSessionInStorage();
    if (this.currentConfig) {
      this.currentConfig.token = '';
      this.currentConfig.userId = null;
    }
    await this.updateUnreadBadge(0);
    this.broadcast({ type: 'auth_expired', reason });
  }

  public disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close(1000, 'reconfigure');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.activeWsUrl = '';
    this.subscribedChats.clear();
  }

  private connectWs(wsUrl: string): void {
    this.disconnectWs();
    this.activeWsUrl = wsUrl;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = async () => {
      if (this.ws !== socket) return;
      this.reconnectAttempt = 0;
      this.subscribedChats.clear();

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'Ping', payload: { nonce: Date.now() } }));
        }
      }, 20_000);

      // Subscribe to all known chats & flush outbox on connect
      const dialogs = await dbGetAllDialogs();
      for (const dlg of dialogs) {
        if (dlg.chat_id > 0) {
          this.subscribeChatOnWs(dlg.chat_id);
        }
      }
      void this.flushOutbox();
      if (this.currentConfig) {
        void this.syncDialogsAndMissedMessages(this.currentConfig);
      }
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        void this.handleWsFrame(ev.data);
      }
    };

    socket.onerror = () => {
      // Handled in onclose
    };

    socket.onclose = (ev) => {
      if (this.ws !== socket) return;
      this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (ev.code === 4001 || ev.code === 4401) {
        void this.handleSessionRevoked(`WS closed with unauthorized code ${ev.code}`);
        return;
      }
      if (!this.authRevoked && this.currentConfig?.token) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.authRevoked) return;
    const delayMs = Math.min(800 * Math.pow(1.8, this.reconnectAttempt), 10_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentConfig?.serverUrl && this.currentConfig?.token && !this.authRevoked) {
        void this.rehydrateAndSync();
      }
    }, delayMs);
  }

  public subscribeChatOnWs(chatId: number): void {
    if (chatId <= 0) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.subscribedChats.has(chatId)) {
      this.subscribedChats.add(chatId);
      this.ws.send(JSON.stringify({ type: 'SubscribeChat', payload: { chat_id: chatId } }));
    }
  }

  public async syncDialogsAndMissedMessages(cfg?: NormalizedExtensionConfig): Promise<StoredDialogDto[]> {
    const activeCfg = cfg ?? this.currentConfig ?? (await readNormalizedStorageConfig());
    if (!activeCfg.serverUrl || !activeCfg.token) {
      return dbGetAllDialogs();
    }

    try {
      const resp = await fetch(`${activeCfg.serverUrl}/api/v1/chats`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${activeCfg.token}`,
          Accept: 'application/json',
        },
      });

      if (resp.status === 401) {
        await this.handleSessionRevoked('401 Unauthorized from /api/v1/chats');
        return [];
      }

      if (!resp.ok) {
        return dbGetAllDialogs();
      }

      const body = (await resp.json().catch(() => null)) as any;
      const rawList: any[] = Array.isArray(body)
        ? body
        : Array.isArray(body?.chats)
          ? body.chats
          : Array.isArray(body?.dialogs)
            ? body.dialogs
            : Array.isArray(body?.items)
              ? body.items
              : [];

      const normalized: StoredDialogDto[] = [];
      for (const item of rawList) {
        if (item && typeof item === 'object') {
          const dlg = normalizeServerDialog(item);
          if (dlg) normalized.push(dlg);
        }
      }

      // Check local PTS BEFORE overwriting dialogs so we detect missed messages during SW stop
      const chatsNeedingHistorySync: Array<{ chatId: number; localPts: number; serverPts: number }> = [];
      for (const dlg of normalized) {
        const localPts = await dbGetChatPts(dlg.chat_id);
        const existingMsgs = await dbGetMessagesForChat(dlg.chat_id, 5);
        if (existingMsgs.length === 0 || (dlg.pts > 0 && dlg.pts > localPts)) {
          chatsNeedingHistorySync.push({
            chatId: dlg.chat_id,
            localPts,
            serverPts: dlg.pts,
          });
        }
      }

      await dbUpsertDialogs(normalized);

      for (const dlg of normalized) {
        this.subscribeChatOnWs(dlg.chat_id);
        if (dlg.pts > 0) {
          const localPts = await dbGetChatPts(dlg.chat_id);
          if (localPts > 0) {
            await wasmSetPts(dlg.chat_id, localPts);
          }
        }
      }

      // Reconcile missed messages for chats with PTS gap or empty local store
      for (const item of chatsNeedingHistorySync) {
        if (item.localPts > 0 && item.serverPts > item.localPts) {
          await this.recoverPtsGap(item.chatId, item.localPts, activeCfg);
        } else {
          await this.fetchChatHistory(item.chatId, 50, activeCfg);
        }
      }

      const allDialogs = await dbGetAllDialogs();
      const totalUnread = allDialogs.reduce((acc, d) => acc + (d.unread_count || 0), 0);
      await this.updateUnreadBadge(totalUnread);
      this.broadcast({ type: 'dialogs_updated', dialogs: allDialogs, unread_total: totalUnread });
      return allDialogs;
    } catch {
      return dbGetAllDialogs();
    }
  }

  public async fetchChatHistory(
    chatId: number,
    limit = 50,
    cfg?: NormalizedExtensionConfig,
  ): Promise<StoredMessageDto[]> {
    if (chatId === LOCAL_COPILOT_CHAT_ID) {
      return dbGetMessagesForChat(chatId, limit);
    }

    const activeCfg = cfg ?? this.currentConfig ?? (await readNormalizedStorageConfig());
    if (!activeCfg.serverUrl || !activeCfg.token) {
      return dbGetMessagesForChat(chatId, limit);
    }

    try {
      const resp = await fetch(
        `${activeCfg.serverUrl}/api/v1/chats/${encodeURIComponent(String(chatId))}/messages?limit=${limit}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${activeCfg.token}`,
            Accept: 'application/json',
          },
        },
      );
      if (resp.status === 401) {
        await this.handleSessionRevoked('401 Unauthorized on message history');
        return [];
      }
      if (resp.ok) {
        const body = (await resp.json().catch(() => null)) as any;
        const rawMsgs: any[] = Array.isArray(body)
          ? body
          : Array.isArray(body?.messages)
            ? body.messages
            : Array.isArray(body?.items)
              ? body.items
              : [];

        const parsed: StoredMessageDto[] = [];
        let maxPts = await dbGetChatPts(chatId);
        for (const m of rawMsgs) {
          if (m && typeof m === 'object') {
            const norm = normalizeServerMessage(m, chatId);
            if (norm) {
              parsed.push(norm);
              if (norm.pts && norm.pts > maxPts) maxPts = norm.pts;
            }
          }
        }
        if (parsed.length > 0) {
          await dbUpsertMessages(parsed);
        }
        if (maxPts > 0) {
          await dbSetChatPts(chatId, maxPts);
          await wasmSetPts(chatId, maxPts);
        }
      }
    } catch {
      // Offline: return persisted IndexedDB messages
    }

    const messages = await dbGetMessagesForChat(chatId, Math.max(limit, 100));
    this.broadcast({ type: 'messages_updated', chat_id: chatId, messages });
    return messages;
  }

  private async handleWsFrame(rawText: string): Promise<void> {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(rawText) as Record<string, any>;
    } catch {
      return;
    }

    const frameType = String(frame.type ?? '');
    const payload = frame.payload ?? frame.data ?? frame;

    if (frameType === 'Pong' || frameType === 'Subscribed') {
      return;
    }

    if (frameType === 'Error') {
      if (Number(payload?.code) === 401 || /unauthoriz|invalid_token/i.test(String(payload?.message ?? ''))) {
        await this.handleSessionRevoked(String(payload?.message ?? 'WS unauthorized'));
      }
      return;
    }

    if (frameType === 'PtsPush' && payload && typeof payload === 'object') {
      const chatId = unwrapId(payload.chat_id);
      if (chatId !== null) {
        const evalRes = await wasmEvalPts(payload, true);
        if (evalRes?.outcome === 'duplicate') {
          return;
        }
        if (evalRes?.outcome === 'gap_detected') {
          await this.recoverPtsGap(chatId, evalRes.last_seen);
          return;
        }
        if (typeof payload.pts === 'number' && payload.pts > 0) {
          await dbSetChatPts(chatId, payload.pts);
        }
        if (payload.event && typeof payload.event === 'object') {
          await this.applyUpdateEvent(payload.event, chatId, payload.pts);
        }
      }
      return;
    }

    if (frameType === 'Update' && payload && typeof payload === 'object') {
      await this.applyUpdateEvent(payload);
      return;
    }

    if (frameType === 'SyncDiff' && payload && typeof payload === 'object') {
      const chatId = unwrapId(payload.chat_id);
      if (chatId !== null && Array.isArray(payload.updates)) {
        for (const u of payload.updates) {
          if (u?.event) {
            await this.applyUpdateEvent(u.event, chatId, unwrapId(u.pts) ?? undefined);
          } else {
            await this.applyUpdateEvent(u, chatId);
          }
        }
      }
      return;
    }

    // Fallback if server sends flat event frames
    if (frameType === 'NewMessage' || frameType === 'EditMessage' || frameType === 'ReadHistory' || frameType === 'ReactionUpdated' || frameType === 'MessageReactions') {
      await this.applyUpdateEvent(frame);
    }
  }

  private async recoverPtsGap(
    chatId: number,
    fromPts: number,
    cfg?: NormalizedExtensionConfig,
  ): Promise<void> {
    if (this.gapInFlight.has(chatId)) return;
    this.gapInFlight.add(chatId);
    try {
      const activeCfg = cfg ?? this.currentConfig ?? (await readNormalizedStorageConfig());
      if (!activeCfg.serverUrl || !activeCfg.token) return;

      const diffResp = await fetch(
        `${activeCfg.serverUrl}/api/v1/sync/difference?chat_id=${encodeURIComponent(String(chatId))}&pts=${encodeURIComponent(String(fromPts))}&limit=200`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${activeCfg.token}`,
            Accept: 'application/json',
          },
        },
      );

      if (diffResp.status === 401) {
        await this.handleSessionRevoked('401 Unauthorized on /api/v1/sync/difference');
        return;
      }

      let reconciledPts = fromPts;
      if (diffResp.ok) {
        const diffBody = (await diffResp.json().catch(() => null)) as any;
        const updates: any[] = Array.isArray(diffBody?.updates)
          ? diffBody.updates
          : Array.isArray(diffBody?.events)
            ? diffBody.events
            : [];
        const messages: any[] = Array.isArray(diffBody?.messages)
          ? diffBody.messages
          : Array.isArray(diffBody?.new_messages)
            ? diffBody.new_messages
            : [];

        for (const rawMsg of messages) {
          const norm = normalizeServerMessage(rawMsg, chatId);
          if (norm) {
            await dbUpsertMessages([norm]);
            if (norm.pts && norm.pts > reconciledPts) reconciledPts = norm.pts;
          }
        }

        for (const upd of updates) {
          const uPts = unwrapId(upd?.pts);
          if (uPts && uPts > reconciledPts) reconciledPts = uPts;
          if (upd?.event && typeof upd.event === 'object') {
            await this.applyUpdateEvent(upd.event, chatId, uPts ?? undefined);
          } else if (upd && typeof upd === 'object') {
            await this.applyUpdateEvent(upd, chatId, uPts ?? undefined);
          }
        }

        const topPts = unwrapId(diffBody?.current_pts ?? diffBody?.pts ?? diffBody?.new_pts);
        if (topPts && topPts > reconciledPts) {
          reconciledPts = topPts;
        }

        // Also fetch history if difference endpoint returned empty messages while serverPts > fromPts
        if (messages.length === 0 && updates.length === 0) {
          await this.fetchChatHistory(chatId, 100, activeCfg);
          reconciledPts = Math.max(reconciledPts, await dbGetChatPts(chatId));
        }
      } else {
        await this.fetchChatHistory(chatId, 100, activeCfg);
        reconciledPts = Math.max(reconciledPts, await dbGetChatPts(chatId));
      }

      await dbSetChatPts(chatId, reconciledPts);
      const drained = await wasmDrainContiguousPts(chatId, reconciledPts);
      for (const buffered of drained.drained) {
        const bPts = unwrapId(buffered.pts);
        if (bPts && bPts > reconciledPts) {
          reconciledPts = bPts;
          await dbSetChatPts(chatId, reconciledPts);
        }
        if (buffered.event && typeof buffered.event === 'object') {
          await this.applyUpdateEvent(
            buffered.event as Record<string, any>,
            chatId,
            bPts ?? undefined,
          );
        }
      }

      const allMsgs = await dbGetMessagesForChat(chatId, 200);
      this.broadcast({ type: 'messages_updated', chat_id: chatId, messages: allMsgs });
    } finally {
      this.gapInFlight.delete(chatId);
    }
  }

  private async applyUpdateEvent(
    eventObj: Record<string, any>,
    fallbackChatId?: number,
    ptsOverride?: number,
  ): Promise<void> {
    const evType = String(eventObj.type ?? '');
    const data = (eventObj.data ?? eventObj.payload ?? eventObj) as Record<string, any>;

    if (evType === 'NewMessage' || evType === 'EditMessage' || (!evType && (data.id || data.message_id))) {
      const msg = normalizeServerMessage(data, fallbackChatId);
      if (!msg) return;
      if (ptsOverride && (!msg.pts || ptsOverride > msg.pts)) {
        msg.pts = ptsOverride;
      }
      if (evType === 'EditMessage' && !msg.edited_at_ms) {
        msg.edited_at_ms = Date.now();
      }

      await dbUpsertMessages([msg]);
      if (msg.pts && msg.pts > 0) {
        await dbSetChatPts(msg.chat_id, msg.pts);
      }

      // Update dialog preview & unread badge
      let dlg = await dbGetDialog(msg.chat_id);
      const myUserId = this.currentConfig?.userId;
      const isIncoming = evType === 'NewMessage' && myUserId !== null && msg.sender_id !== myUserId;

      if (!dlg && this.currentConfig) {
        await this.syncDialogsAndMissedMessages(this.currentConfig);
        dlg = await dbGetDialog(msg.chat_id);
      } else if (dlg) {
        dlg.last_message_id = msg.message_id;
        dlg.last_message_preview = msg.text;
        dlg.updated_at_ms = Date.now();
        if (msg.pts && msg.pts > dlg.pts) dlg.pts = msg.pts;
        if (isIncoming) {
          dlg.unread_count = (dlg.unread_count || 0) + 1;
        }
        await dbUpsertDialogs([dlg]);
      }

      const allDialogs = await dbGetAllDialogs();
      const totalUnread = allDialogs.reduce((acc, d) => acc + (d.unread_count || 0), 0);
      await this.updateUnreadBadge(totalUnread);
      this.broadcast({ type: 'dialogs_updated', dialogs: allDialogs, unread_total: totalUnread });

      const chatMessages = await dbGetMessagesForChat(msg.chat_id, 200);
      this.broadcast({ type: 'messages_updated', chat_id: msg.chat_id, messages: chatMessages });

      if (isIncoming && chrome.notifications?.create) {
        try {
          chrome.notifications.create(`msg-${msg.chat_id}-${msg.message_id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: dlg?.title ?? 'New Telegram Message',
            message: msg.text.slice(0, 140) || 'New message received',
          });
        } catch {
          // ignore notification errors in headless environments
        }
      }
      return;
    }

    if (evType === 'DeleteMessages') {
      const chatId = unwrapId(data.chat_id) ?? fallbackChatId ?? null;
      const ids: number[] = Array.isArray(data.message_ids)
        ? data.message_ids.map(unwrapId).filter((n): n is number => n !== null)
        : [];
      if (chatId !== null && ids.length > 0) {
        await dbDeleteMessages(chatId, ids);
        const chatMessages = await dbGetMessagesForChat(chatId, 200);
        this.broadcast({ type: 'messages_updated', chat_id: chatId, messages: chatMessages });
      }
      return;
    }

    if (evType === 'MessageReactions' || evType === 'ReactionUpdated') {
      const chatId = unwrapId(data.chat_id) ?? fallbackChatId ?? null;
      const messageId = unwrapId(data.message_id ?? data.id);
      if (chatId !== null && messageId !== null) {
        let reactions = extractReactions(data.reactions);
        if (!reactions && typeof data.emoji === 'string') {
          reactions = [{ emoji: data.emoji, count: 1, me: false }];
        }
        if (reactions) {
          const updated = await dbApplyMessageReactions(chatId, messageId, reactions);
          if (!updated) {
            await this.fetchChatHistory(chatId, 50);
          } else {
            const chatMessages = await dbGetMessagesForChat(chatId, 200);
            this.broadcast({ type: 'messages_updated', chat_id: chatId, messages: chatMessages });
          }
        }
      }
      return;
    }

    if (evType === 'ReadHistory' || evType === 'ReadHistoryIn' || evType === 'ReadHistoryOut') {
      const chatId = unwrapId(data.chat_id) ?? fallbackChatId ?? null;
      if (chatId !== null) {
        const unreadCount =
          typeof data.unread_count === 'number' ? Math.max(0, data.unread_count) : 0;
        if (!data.is_outbox || evType === 'ReadHistoryIn' || unreadCount === 0) {
          await dbSetChatUnreadCount(chatId, unreadCount);
          const allDialogs = await dbGetAllDialogs();
          const totalUnread = allDialogs.reduce((acc, d) => acc + (d.unread_count || 0), 0);
          await this.updateUnreadBadge(totalUnread);
          this.broadcast({ type: 'dialogs_updated', dialogs: allDialogs, unread_total: totalUnread });
        }
      }
    }
  }

  public async sendMessageWithOutbox(params: {
    chatId: number;
    text: string;
    replyToMessageId?: number | null;
    clientNonce?: string;
  }): Promise<{ ok: boolean; queued?: boolean; message?: StoredMessageDto; error?: string }> {
    const text = params.text.trim();
    if (!text) return { ok: false, error: 'Empty message text' };

    const clientNonce =
      params.clientNonce ||
      `${Date.now()}${Math.floor(Math.random() * 100000)
        .toString()
        .padStart(5, '0')}`;

    const cfg = this.currentConfig ?? (await readNormalizedStorageConfig());
    const optimisticTempId = -Math.abs(Date.now() % 1_000_000_000);
    const optimisticMsg: StoredMessageDto = {
      chat_id: params.chatId,
      message_id: optimisticTempId,
      sender_id: cfg.userId ?? 0,
      sender_username: cfg.username ?? 'me',
      text,
      client_nonce: clientNonce,
      created_at_ms: Date.now(),
      reply_to_message_id: params.replyToMessageId ?? null,
      pending_outbox: true,
    };

    // Persist to outbox & optimistic local message store first so zero data is lost if server is down
    const outboxItem: OutboxRecordDto = {
      client_nonce: clientNonce,
      chat_id: params.chatId,
      text,
      reply_to_message_id: params.replyToMessageId ?? null,
      created_at_ms: Date.now(),
      attempts: 0,
    };
    await dbEnqueueOutbox(outboxItem);
    await dbUpsertMessages([optimisticMsg]);
    this.broadcast({
      type: 'messages_updated',
      chat_id: params.chatId,
      messages: await dbGetMessagesForChat(params.chatId, 200),
    });

    const delivered = await this.trySendSingleOutboxItem(outboxItem, cfg);
    if (delivered) {
      return { ok: true, queued: false, message: delivered };
    }

    return { ok: true, queued: true, message: optimisticMsg };
  }

  private startOutboxWatchdog(): void {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = setInterval(() => {
      void this.flushOutbox();
    }, 1_500);
  }

  public async flushOutbox(): Promise<void> {
    if (this.flushingOutbox || this.authRevoked) return;
    const pending = await dbListOutbox();
    if (pending.length === 0) return;

    const cfg = this.currentConfig ?? (await readNormalizedStorageConfig());
    if (!cfg.serverUrl || !cfg.token) return;

    this.flushingOutbox = true;
    try {
      for (const item of pending) {
        const sent = await this.trySendSingleOutboxItem(item, cfg);
        if (!sent) {
          // Server still unreachable; retry on next watchdog tick
          break;
        }
      }
      // Ensure WS is reconnected once HTTP server comes back online
      if (!this.isConnected() && cfg.serverUrl && cfg.token && !this.authRevoked) {
        const targetWsUrl = `${httpToWsBase(cfg.serverUrl)}/api/v1/ws?token=${encodeURIComponent(cfg.token)}`;
        this.connectWs(targetWsUrl);
      }
    } finally {
      this.flushingOutbox = false;
    }
  }

  private async trySendSingleOutboxItem(
    item: OutboxRecordDto,
    cfg: NormalizedExtensionConfig,
  ): Promise<StoredMessageDto | null> {
    if (!cfg.serverUrl || !cfg.token) return null;

    try {
      const resp = await fetch(`${cfg.serverUrl}/api/v1/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          chat_id: item.chat_id,
          text: item.text,
          client_nonce: item.client_nonce,
          reply_to_message_id: item.reply_to_message_id ?? undefined,
        }),
      });

      if (resp.status === 401) {
        await this.handleSessionRevoked('401 Unauthorized on /api/v1/messages/send');
        return null;
      }

      if (!resp.ok) {
        return null;
      }

      const raw = (await resp.json().catch(() => null)) as Record<string, any> | null;
      await dbRemoveOutbox(item.client_nonce);

      const msgPayload = (raw?.message && typeof raw.message === 'object' ? raw.message : raw) ?? {};
      const confirmed =
        normalizeServerMessage(
          {
            ...msgPayload,
            chat_id: msgPayload.chat_id ?? item.chat_id,
            text: extractMessageText(msgPayload) || item.text,
            client_nonce: item.client_nonce,
          },
          item.chat_id,
        ) ?? {
          chat_id: item.chat_id,
          message_id: Math.abs(Date.now() % 1_000_000_000),
          sender_id: cfg.userId ?? 0,
          text: item.text,
          client_nonce: item.client_nonce,
          created_at_ms: item.created_at_ms,
          pending_outbox: false,
        };

      await dbUpsertMessages([confirmed]);
      if (confirmed.pts && confirmed.pts > 0) {
        await dbSetChatPts(item.chat_id, confirmed.pts);
      }

      const chatMessages = await dbGetMessagesForChat(item.chat_id, 200);
      this.broadcast({ type: 'messages_updated', chat_id: item.chat_id, messages: chatMessages });
      return confirmed;
    } catch {
      return null;
    }
  }

  public async markChatRead(chatId: number, maxMessageId?: number): Promise<void> {
    await dbSetChatUnreadCount(chatId, 0);
    const allDialogs = await dbGetAllDialogs();
    const totalUnread = allDialogs.reduce((acc, d) => acc + (d.unread_count || 0), 0);
    await this.updateUnreadBadge(totalUnread);
    this.broadcast({ type: 'dialogs_updated', dialogs: allDialogs, unread_total: totalUnread });

    const cfg = this.currentConfig ?? (await readNormalizedStorageConfig());
    if (!cfg.serverUrl || !cfg.token || chatId <= 0) return;

    let maxId = maxMessageId;
    if (!maxId) {
      const msgs = await dbGetMessagesForChat(chatId, 5);
      const last = msgs[msgs.length - 1];
      maxId = last && last.message_id > 0 ? last.message_id : 1;
    }

    try {
      await fetch(`${cfg.serverUrl}/api/v1/chats/${encodeURIComponent(String(chatId))}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ max_message_id: maxId, max_id: maxId }),
      });
    } catch {
      // ignore offline
    }
  }

  public async updateUnreadBadge(totalUnread: number): Promise<void> {
    try {
      const text = totalUnread > 0 ? (totalUnread > 99 ? '99+' : String(totalUnread)) : '';
      await chrome.action.setBadgeText({ text });
      if (totalUnread > 0) {
        await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      }
    } catch {
      // ignore if action badge API unavailable
    }
  }
}
