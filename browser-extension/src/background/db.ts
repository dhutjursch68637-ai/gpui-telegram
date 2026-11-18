/**
 * MV3 Extension Persistence Layer:
 * 1. `IndexedDB` (`gpui_telegram_ext_db`) stores for `dialogs`, `messages`, `pts_state`, `outbox`, `e2ee_sessions`, `settings`
 * 2. Normalized `chrome.storage.local` reader/writer supporting all E2E harness & multi-account session keys.
 */

import {
  INDEXED_DB_NAME,
  INDEXED_DB_VERSION,
  normalizeRunPolicy,
  type BrowserRunPolicy,
  type OutboxRecordDto,
  type StoredDialogDto,
  type StoredMessageDto,
} from '../shared/rpc_types';

export interface NormalizedExtensionConfig {
  serverUrl: string;
  token: string;
  userId: number | null;
  username: string | null;
  deviceId: string;
  runPolicy: BrowserRunPolicy;
  emergencyStopped: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  serverBridgeWsUrl: string;
  desktopBridgeWsUrl: string;
  desktopBridgeEnabled: boolean;
  pairingToken: string;
  desktopBridgePort: number;
  extBotEnabled: boolean;
  extBotConfig: Record<string, unknown> | null;
  themeMode: 'dark' | 'light';
  languageCode: 'en' | 'ru';
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openExtDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('dialogs')) {
        db.createObjectStore('dialogs', { keyPath: 'chat_id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: ['chat_id', 'message_id'] });
        msgStore.createIndex('by_chat', 'chat_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('pts_state')) {
        db.createObjectStore('pts_state', { keyPath: 'chat_id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const outboxStore = db.createObjectStore('outbox', { keyPath: 'client_nonce' });
        outboxStore.createIndex('by_chat', 'chat_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('e2ee_sessions')) {
        db.createObjectStore('e2ee_sessions', { keyPath: 'session_id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbUpsertDialogs(dialogs: StoredDialogDto[]): Promise<void> {
  if (dialogs.length === 0) return;
  const db = await openExtDb();
  const tx = db.transaction(['dialogs', 'pts_state'], 'readwrite');
  const dialogStore = tx.objectStore('dialogs');
  const ptsStore = tx.objectStore('pts_state');

  for (const dlg of dialogs) {
    dialogStore.put(dlg);
    if (typeof dlg.pts === 'number' && dlg.pts > 0) {
      const existingReq = ptsStore.get(dlg.chat_id);
      existingReq.onsuccess = () => {
        const prev = existingReq.result as { chat_id: number; pts: number } | undefined;
        if (!prev || dlg.pts > prev.pts) {
          ptsStore.put({ chat_id: dlg.chat_id, pts: dlg.pts, updated_at_ms: Date.now() });
        }
      };
    }
  }
  await idbTxDone(tx);
}

export async function dbGetAllDialogs(): Promise<StoredDialogDto[]> {
  const db = await openExtDb();
  const tx = db.transaction('dialogs', 'readonly');
  const all = await idbReq<StoredDialogDto[]>(tx.objectStore('dialogs').getAll());
  return all.sort((a, b) => (b.updated_at_ms || 0) - (a.updated_at_ms || 0));
}

export async function dbGetDialog(chatId: number): Promise<StoredDialogDto | undefined> {
  const db = await openExtDb();
  const tx = db.transaction('dialogs', 'readonly');
  return idbReq<StoredDialogDto | undefined>(tx.objectStore('dialogs').get(chatId));
}

export async function dbSetChatUnreadCount(chatId: number, unreadCount: number): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction('dialogs', 'readwrite');
  const store = tx.objectStore('dialogs');
  const existing = await idbReq<StoredDialogDto | undefined>(store.get(chatId));
  if (existing) {
    existing.unread_count = Math.max(0, unreadCount);
    store.put(existing);
  }
  await idbTxDone(tx);
}

export async function dbGetChatPts(chatId: number): Promise<number> {
  const db = await openExtDb();
  const tx = db.transaction('pts_state', 'readonly');
  const rec = await idbReq<{ chat_id: number; pts: number } | undefined>(
    tx.objectStore('pts_state').get(chatId),
  );
  return rec?.pts ?? 0;
}

export async function dbSetChatPts(chatId: number, pts: number): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction('pts_state', 'readwrite');
  tx.objectStore('pts_state').put({
    chat_id: chatId,
    pts: Math.max(0, Math.floor(pts)),
    updated_at_ms: Date.now(),
  });
  await idbTxDone(tx);
}

export async function dbGetMessagesForChat(
  chatId: number,
  limit = 200,
): Promise<StoredMessageDto[]> {
  const db = await openExtDb();
  const tx = db.transaction('messages', 'readonly');
  const idx = tx.objectStore('messages').index('by_chat');
  const rows = await idbReq<StoredMessageDto[]>(idx.getAll(IDBKeyRange.only(chatId)));

  // Deduplicate by message_id and client_nonce while preserving chronological order
  const byNonce = new Map<string, StoredMessageDto>();
  const byId = new Map<number, StoredMessageDto>();

  for (const row of rows) {
    if (row.client_nonce) {
      const prevNonce = byNonce.get(row.client_nonce);
      if (prevNonce) {
        // Prefer confirmed positive server message_id over negative optimistic id
        if (prevNonce.message_id < 0 && row.message_id > 0) {
          byId.delete(prevNonce.message_id);
          byNonce.set(row.client_nonce, row);
          byId.set(row.message_id, row);
          continue;
        }
        if (row.message_id < 0 && prevNonce.message_id > 0) {
          continue;
        }
      } else {
        byNonce.set(row.client_nonce, row);
      }
    }
    byId.set(row.message_id, row);
  }

  const deduped = [...byId.values()].sort((a, b) => {
    // Positive confirmed messages sort by message_id ascending; optimistic negative ids go at the end
    if (a.message_id > 0 && b.message_id > 0) {
      return a.message_id - b.message_id;
    }
    if (a.created_at_ms !== b.created_at_ms) {
      return a.created_at_ms - b.created_at_ms;
    }
    return a.message_id - b.message_id;
  });

  return deduped.length > limit ? deduped.slice(deduped.length - limit) : deduped;
}

export async function dbUpsertMessages(messages: StoredMessageDto[]): Promise<void> {
  if (messages.length === 0) return;
  const db = await openExtDb();
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  const idx = store.index('by_chat');

  const chatIds = [...new Set(messages.map((m) => m.chat_id))];
  const existingByChat = new Map<number, StoredMessageDto[]>();
  for (const cid of chatIds) {
    const rows = await idbReq<StoredMessageDto[]>(idx.getAll(IDBKeyRange.only(cid)));
    existingByChat.set(cid, rows);
  }

  for (const incoming of messages) {
    const existingList = existingByChat.get(incoming.chat_id) ?? [];
    if (incoming.client_nonce && incoming.message_id > 0) {
      for (const old of existingList) {
        if (old.client_nonce === incoming.client_nonce && old.message_id < 0) {
          store.delete([old.chat_id, old.message_id]);
        }
      }
    }
    const priorSameId = existingList.find((m) => m.message_id === incoming.message_id);
    const merged: StoredMessageDto = priorSameId
      ? {
          ...priorSameId,
          ...incoming,
          reactions: incoming.reactions?.length ? incoming.reactions : priorSameId.reactions,
          thinking: incoming.thinking ?? priorSameId.thinking,
          tool_steps: incoming.tool_steps ?? priorSameId.tool_steps,
          pending_outbox: false,
        }
      : incoming;
    store.put(merged);
  }

  await idbTxDone(tx);
}

export async function dbApplyMessageReactions(
  chatId: number,
  messageId: number,
  reactions: StoredMessageDto['reactions'],
): Promise<boolean> {
  const db = await openExtDb();
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  const existing = await idbReq<StoredMessageDto | undefined>(store.get([chatId, messageId]));
  if (!existing) {
    await idbTxDone(tx);
    return false;
  }
  existing.reactions = reactions;
  store.put(existing);
  await idbTxDone(tx);
  return true;
}

export async function dbDeleteMessages(chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  const db = await openExtDb();
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  for (const mid of messageIds) {
    store.delete([chatId, mid]);
  }
  await idbTxDone(tx);
}

export async function dbEnqueueOutbox(entry: OutboxRecordDto): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put(entry);
  await idbTxDone(tx);
}

export async function dbListOutbox(): Promise<OutboxRecordDto[]> {
  const db = await openExtDb();
  const tx = db.transaction('outbox', 'readonly');
  const rows = await idbReq<OutboxRecordDto[]>(tx.objectStore('outbox').getAll());
  return rows.sort((a, b) => a.created_at_ms - b.created_at_ms);
}

export async function dbRemoveOutbox(clientNonce: string): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(clientNonce);
  await idbTxDone(tx);
}

export async function dbSaveSetting(key: string, value: unknown): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value, updated_at_ms: Date.now() });
  await idbTxDone(tx);
}

export async function dbClearUserSessionData(): Promise<void> {
  const db = await openExtDb();
  const tx = db.transaction(['dialogs', 'messages', 'pts_state', 'outbox'], 'readwrite');
  tx.objectStore('dialogs').clear();
  tx.objectStore('messages').clear();
  tx.objectStore('pts_state').clear();
  tx.objectStore('outbox').clear();
  await idbTxDone(tx);
}

export function httpToWsBase(httpUrl: string): string {
  const trimmed = httpUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  return trimmed;
}

export async function readNormalizedStorageConfig(): Promise<NormalizedExtensionConfig> {
  const raw = (await chrome.storage.local.get(null)) as Record<string, any>;
  const sessionObj = raw.session ?? raw.auth_session ?? null;

  const serverUrl = String(
    raw.server_url || raw.serverUrl || sessionObj?.server_url || '',
  )
    .trim()
    .replace(/\/+$/, '');

  const token = String(
    raw.token || raw.auth_token || sessionObj?.token || '',
  ).trim();

  const rawUserId = raw.user_id ?? sessionObj?.user_id ?? null;
  const userId =
    typeof rawUserId === 'number' && Number.isFinite(rawUserId)
      ? rawUserId
      : typeof rawUserId === 'string' && rawUserId.trim() !== '' && Number.isFinite(Number(rawUserId))
        ? Number(rawUserId)
        : null;

  const username =
    typeof (raw.username ?? sessionObj?.username) === 'string'
      ? String(raw.username ?? sessionObj?.username)
      : null;

  const deviceId = String(raw.device_id || sessionObj?.device_id || 'chrome-ext-mv3-device');
  const emergencyStopped = Boolean(raw.emergency_stopped);

  const policyCandidate =
    raw.run_policy ??
    raw.browser_run_policy ??
    raw.bridge_config?.run_policy ??
    raw.browser_bridge?.run_policy ??
    'always_allow_authorized';
  const runPolicy: BrowserRunPolicy = emergencyStopped
    ? 'disabled'
    : normalizeRunPolicy(policyCandidate);

  const allowedDomains: string[] = Array.isArray(raw.allowed_domains)
    ? raw.allowed_domains.map(String)
    : Array.isArray(raw.bridge_config?.allowed_domains)
      ? raw.bridge_config.allowed_domains.map(String)
      : [];

  const blockedDomains: string[] = Array.isArray(raw.blocked_domains)
    ? raw.blocked_domains.map(String)
    : Array.isArray(raw.bridge_config?.blocked_domains)
      ? raw.bridge_config.blocked_domains.map(String)
      : [];

  const pairingToken = String(
    raw.pairing_token ??
      raw.desktop_bridge?.pairing_token ??
      raw.bridge_config?.pairing_token ??
      '',
  ).trim();

  const desktopBridgePort = Number(
    raw.desktop_bridge_port ?? raw.desktop_bridge?.port ?? 19222,
  );

  const wsBase = httpToWsBase(serverUrl);
  const serverBridgeWsUrl = String(
    raw.bridge_config?.server_ws_url ||
      raw.browser_bridge?.server_ws_url ||
      (wsBase && token
        ? `${wsBase}/api/v1/browser/ws?token=${encodeURIComponent(token)}&client=extension`
        : ''),
  ).trim();

  const explicitDesktopWsUrl = String(
    raw.bridge_config?.desktop_ws_url || raw.desktop_bridge?.ws_url || '',
  ).trim();

  const desktopBridgeWsUrl =
    explicitDesktopWsUrl ||
    (pairingToken && Number.isFinite(desktopBridgePort) && desktopBridgePort > 0
      ? `ws://127.0.0.1:${desktopBridgePort}/ext/ws?token=${encodeURIComponent(pairingToken)}`
      : '');

  const desktopBridgeEnabled =
    raw.desktop_bridge?.enabled !== false && desktopBridgeWsUrl.length > 0;

  const providerCandidate =
    raw.ext_bot_config ??
    raw.llm_provider ??
    (Array.isArray(raw.ai_providers) && raw.ai_providers.length > 0 ? raw.ai_providers[0] : null);

  const extBotEnabled = Boolean(
    raw.ext_bot_enabled ?? raw.local_bot_mode ?? providerCandidate?.enabled ?? true,
  );

  const themeMode = raw.theme_mode === 'light' ? 'light' : 'dark';
  const languageCode = raw.language_code === 'ru' ? 'ru' : 'en';

  return {
    serverUrl,
    token,
    userId,
    username,
    deviceId,
    runPolicy,
    emergencyStopped,
    allowedDomains,
    blockedDomains,
    serverBridgeWsUrl,
    desktopBridgeWsUrl,
    desktopBridgeEnabled,
    pairingToken,
    desktopBridgePort,
    extBotEnabled,
    extBotConfig: providerCandidate && typeof providerCandidate === 'object' ? providerCandidate : null,
    themeMode,
    languageCode,
  };
}

export async function clearAuthSessionInStorage(): Promise<void> {
  await chrome.storage.local.remove([
    'token',
    'auth_token',
    'session',
    'auth_session',
    'accounts',
    'active_account_id',
    'user_id',
  ]);
  await dbClearUserSessionData();
}
