import * as crypto from 'node:crypto';
import WebSocket from 'ws';
import { CDP_MAX_PAYLOAD_BYTES } from './chromium_ext.ts';
import { pollUntil } from './assertions.ts';

export interface ApiHttpResponse<T = any> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  rawText: string;
}

export interface HttpRequestOptions {
  token?: string | null;
  headers?: Record<string, string>;
  rawBody?: Buffer | Uint8Array | string;
  contentType?: string;
  timeoutMs?: number;
}

export interface SignedPreKeyBundleGenerated {
  deviceId: string;
  identityKeyB64: string;
  identityPrivateKeyDer: Buffer;
  identitySigningKeyB64: string;
  identitySigningPrivateKeyDer: Buffer;
  signedPrekey: {
    key_id: number;
    public_key: string;
    signature: string;
    created_at_ms: number;
  };
  signedPrekeyPrivateKeyDer: Buffer;
  oneTimePrekeys: Array<{ key_id: number; public_key: string }>;
  requestPayload: Record<string, unknown>;
}

export function generateSignedPreKeyBundle(
  deviceId = `dev_${crypto.randomBytes(4).toString('hex')}`,
  otpkCount = 4,
): SignedPreKeyBundleGenerated {
  const extractRaw32Public = (keyObj: crypto.KeyObject): Buffer => {
    const spki = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
    return Buffer.from(spki.subarray(spki.length - 32));
  };

  const ik = crypto.generateKeyPairSync('x25519');
  const isk = crypto.generateKeyPairSync('ed25519');
  const spk = crypto.generateKeyPairSync('x25519');

  const ikPub = extractRaw32Public(ik.publicKey);
  const iskPub = extractRaw32Public(isk.publicKey);
  const spkPub = extractRaw32Public(spk.publicKey);

  // Server verifies Ed25519 signature over b"gpui-e2ee-spk-v1" || signed_prekey_public_key_32_bytes
  const signInput = Buffer.concat([Buffer.from('gpui-e2ee-spk-v1', 'utf-8'), spkPub]);
  const signature = crypto.sign(null, signInput, isk.privateKey);

  const oneTimePrekeys: Array<{ key_id: number; public_key: string }> = [];
  for (let i = 0; i < otpkCount; i++) {
    const otpk = crypto.generateKeyPairSync('x25519');
    oneTimePrekeys.push({
      key_id: 100 + i,
      public_key: extractRaw32Public(otpk.publicKey).toString('base64'),
    });
  }

  const createdAtMs = Date.now();
  const signedPrekey = {
    key_id: 1,
    public_key: spkPub.toString('base64'),
    signature: signature.toString('base64'),
    created_at_ms: createdAtMs,
  };

  const requestPayload = {
    device_id: deviceId,
    device_name: `E2E Device ${deviceId}`,
    identity_key: ikPub.toString('base64'),
    identity_signing_key: iskPub.toString('base64'),
    signed_prekey: signedPrekey,
    one_time_prekeys: oneTimePrekeys,
  };

  return {
    deviceId,
    identityKeyB64: ikPub.toString('base64'),
    identityPrivateKeyDer: ik.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    identitySigningKeyB64: iskPub.toString('base64'),
    identitySigningPrivateKeyDer: isk.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    signedPrekey,
    signedPrekeyPrivateKeyDer: spk.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    oneTimePrekeys,
    requestPayload,
  };
}

export class PtsWsClient {
  readonly ws: WebSocket;
  readonly frames: Array<{ type: string; payload: any; receivedAtMs: number }> = [];
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.type === 'string') {
          this.frames.push({
            type: parsed.type,
            payload: parsed.payload,
            receivedAtMs: Date.now(),
          });
        }
      } catch {
        // Ignore malformed frame
      }
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  sendFrame(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify({ type, payload }), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async ping(nonce = Math.floor(Math.random() * 1_000_000)): Promise<{ nonce: number }> {
    const startIdx = this.frames.length;
    await this.sendFrame('Ping', { nonce });
    const pong = await this.waitForFrame(
      (f, idx) => idx >= startIdx && f.type === 'Pong' && f.payload?.nonce === nonce,
      5000,
    );
    return pong.payload;
  }

  async subscribeChat(chatId: number): Promise<void> {
    await this.sendFrame('SubscribeChat', { chat_id: chatId });
  }

  async sendTextMessage(
    chatId: number,
    text: string,
    clientNonce = Date.now(),
  ): Promise<void> {
    await this.sendFrame('SendMessage', {
      chat_id: chatId,
      client_nonce: clientNonce,
      content: { type: 'Text', data: { text, entities: [] } },
    });
  }

  async waitForFrame(
    predicate: (
      frame: { type: string; payload: any; receivedAtMs: number },
      index: number,
    ) => boolean,
    timeoutMs = 8000,
  ): Promise<{ type: string; payload: any; receivedAtMs: number }> {
    return await pollUntil(
      () => {
        for (let i = 0; i < this.frames.length; i++) {
          if (predicate(this.frames[i], i)) {
            return this.frames[i];
          }
        }
        return null as any;
      },
      { timeoutMs, intervalMs: 40, message: 'PtsWsClient.waitForFrame' },
    );
  }

  async waitForPtsPush(
    chatId: number,
    predicate?: (pushPayload: any) => boolean,
    timeoutMs = 8000,
  ): Promise<any> {
    const frame = await this.waitForFrame(
      (f) =>
        f.type === 'PtsPush' &&
        f.payload?.chat_id === chatId &&
        (!predicate || predicate(f.payload)),
      timeoutMs,
    );
    return frame.payload;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

export type BridgeInvokeHandler = (
  reqId: string | number,
  params: {
    tool: string;
    arguments: Record<string, any>;
    caller?: Record<string, any>;
    timeout_ms?: number;
  },
) => Promise<Record<string, any>> | Record<string, any>;

export class BrowserBridgeWsClient {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  private invokeHandler: BridgeInvokeHandler | null = null;
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', async (raw) => {
      let msg: any;
      try {
        const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
        msg = JSON.parse(str);
      } catch {
        return;
      }
      this.messages.push(msg);

      if (msg?.method === 'bridge.ping') {
        void this.sendNotification('bridge.pong', {
          ts: msg.params?.ts ?? Date.now(),
        }).catch(() => undefined);
      } else if (msg?.method === 'browser.invoke' && msg.id !== undefined && this.invokeHandler) {
        try {
          const result = await this.invokeHandler(msg.id, msg.params ?? {});
          await this.sendResult(msg.id, result);
        } catch (err: any) {
          const code = typeof err?.code === 'number' ? err.code : -32000;
          const errorCode = err?.errorCode ?? err?.error_code;
          await this.sendError(
            msg.id,
            code,
            err instanceof Error ? err.message : String(err),
            errorCode,
          );
        }
      }
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  onInvoke(handler: BridgeInvokeHandler): void {
    this.invokeHandler = handler;
  }

  sendRaw(frame: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(frame), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  sendNotification(method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  sendResult(id: string | number, result: Record<string, unknown>): Promise<void> {
    return this.sendRaw({ jsonrpc: '2.0', id, result });
  }

  sendError(
    id: string | number,
    code: number,
    message: string,
    errorCode?: string,
  ): Promise<void> {
    return this.sendRaw({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(errorCode ? { data: { error_code: errorCode } } : {}),
      },
    });
  }

  async sendHello(params: {
    protocol_version?: number;
    extension_id?: string;
    device_id?: string;
    pairing_token?: string;
    user_agent?: string;
    capabilities?: string[];
    run_policy?: string;
    tabs_summary?: any[];
  } = {}): Promise<any> {
    const startIdx = this.messages.length;
    await this.sendNotification('bridge.hello', {
      protocol_version: params.protocol_version ?? 1,
      extension_id: params.extension_id ?? 'nkikencljfojglplncicaknnpcclfgph',
      device_id: params.device_id ?? 'e2e-probe-ext',
      pairing_token: params.pairing_token ?? '',
      user_agent: params.user_agent ?? 'Mozilla/5.0 Chrome/156.0.8078.79',
      capabilities: params.capabilities ?? [
        'tabs',
        'tabGroups',
        'scripting',
        'debugger',
        'screenshots',
        'cookies',
        'downloads',
      ],
      run_policy: params.run_policy ?? 'always_allow_authorized',
      tabs_summary: params.tabs_summary ?? [],
    });
    return await this.waitForMessage(
      (m, idx) => idx >= startIdx && (m?.method === 'bridge.hello_ack' || m?.error !== undefined),
      6000,
    );
  }

  async sendPing(ts = Date.now()): Promise<any> {
    const startIdx = this.messages.length;
    await this.sendNotification('bridge.ping', { ts });
    return await this.waitForMessage(
      (m, idx) => idx >= startIdx && m?.method === 'bridge.pong',
      5000,
    );
  }

  async sendTabsSync(
    tabs: any[],
    runPolicy = 'always_allow_authorized',
  ): Promise<void> {
    await this.sendNotification('bridge.tabs_sync', {
      tabs,
      run_policy: runPolicy,
    });
  }

  async sendEmergencyStop(reason = 'user_triggered'): Promise<void> {
    await this.sendNotification('bridge.emergency_stop', { reason });
  }

  async waitForMessage(
    predicate: (msg: any, index: number) => boolean,
    timeoutMs = 8000,
  ): Promise<any> {
    return await pollUntil(
      () => {
        for (let i = 0; i < this.messages.length; i++) {
          if (predicate(this.messages[i], i)) {
            return this.messages[i];
          }
        }
        return null;
      },
      { timeoutMs, intervalMs: 40, message: 'BrowserBridgeWsClient.waitForMessage' },
    );
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

export async function connectBrowserBridgeWs(
  wsUrl: string,
  opts: {
    origin?: string;
    host?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<BrowserBridgeWsClient> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.host !== undefined) headers.Host = opts.host;

  const ws = new WebSocket(wsUrl, {
    headers,
    maxPayload: CDP_MAX_PAYLOAD_BYTES,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting BrowserBridgeWsClient to ${wsUrl}`));
    }, opts.timeoutMs ?? 8000);

    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      reject(
        Object.assign(
          new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`),
          { statusCode: res.statusCode },
        ),
      );
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return new BrowserBridgeWsClient(ws);
}

export async function probeWsUpgradeRejection(
  wsUrl: string,
  opts: {
    origin?: string;
    host?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<{
  rejected: boolean;
  statusCode?: number;
  closeCode?: number;
  firstMessage?: any;
  errorMessage?: string;
}> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.host !== undefined) headers.Host = opts.host;

  return await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers,
      maxPayload: CDP_MAX_PAYLOAD_BYTES,
    });
    let finished = false;
    let firstMessage: any;

    const done = (result: {
      rejected: boolean;
      statusCode?: number;
      closeCode?: number;
      firstMessage?: any;
      errorMessage?: string;
    }): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ rejected: false, firstMessage });
    }, opts.timeoutMs ?? 2500);

    ws.once('unexpected-response', (_req, res) => {
      done({
        rejected: true,
        statusCode: res.statusCode,
        errorMessage: `HTTP ${res.statusCode}`,
      });
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        if (!firstMessage) firstMessage = parsed;
        if (parsed?.error) {
          done({
            rejected: true,
            firstMessage: parsed,
            errorMessage: parsed.error.message,
          });
        }
      } catch {
        // Ignore
      }
    });

    ws.once('close', (code) => {
      done({
        rejected: code !== 1000,
        closeCode: code,
        firstMessage,
      });
    });

    ws.once('error', (err) => {
      done({
        rejected: true,
        errorMessage: err.message,
      });
    });
  });
}

export class TelegramApiClient {
  readonly baseUrl: string;
  readonly token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  withToken(token?: string): TelegramApiClient {
    return new TelegramApiClient(this.baseUrl, token);
  }

  async request<T = any>(
    method: string,
    pathOrUrl: string,
    body?: unknown,
    opts: HttpRequestOptions = {},
  ): Promise<ApiHttpResponse<T>> {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const effectiveToken = opts.token === null ? undefined : (opts.token ?? this.token);
    if (effectiveToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${effectiveToken}`;
    }

    let payload: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      payload =
        typeof opts.rawBody === 'string'
          ? opts.rawBody
          : new Uint8Array(opts.rawBody);
      if (opts.contentType && !headers['Content-Type']) {
        headers['Content-Type'] = opts.contentType;
      }
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const rawText = await resp.text();
      let data: any = rawText;
      if (rawText.length > 0) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = rawText;
        }
      } else {
        data = null;
      }
      return {
        status: resp.status,
        ok: resp.ok,
        headers: resp.headers,
        data: data as T,
        rawText,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async unwrap<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts?: HttpRequestOptions,
  ): Promise<T> {
    const res = await this.request<T>(method, path, body, opts);
    if (!res.ok) {
      throw Object.assign(
        new Error(
          `${method} ${path} failed with HTTP ${res.status}: ${res.rawText.slice(0, 500)}`,
        ),
        { status: res.status, response: res },
      );
    }
    return res.data;
  }

  get<T = any>(path: string, opts?: HttpRequestOptions): Promise<T> {
    return this.unwrap<T>('GET', path, undefined, opts);
  }

  post<T = any>(path: string, body?: unknown, opts?: HttpRequestOptions): Promise<T> {
    return this.unwrap<T>('POST', path, body, opts);
  }

  put<T = any>(path: string, body?: unknown, opts?: HttpRequestOptions): Promise<T> {
    return this.unwrap<T>('PUT', path, body, opts);
  }

  patch<T = any>(path: string, body?: unknown, opts?: HttpRequestOptions): Promise<T> {
    return this.unwrap<T>('PATCH', path, body, opts);
  }

  delete<T = any>(path: string, body?: unknown, opts?: HttpRequestOptions): Promise<T> {
    return this.unwrap<T>('DELETE', path, body, opts);
  }

  // --- Auth & Sessions ---
  register(params: {
    username: string;
    password: string;
    first_name?: string;
    last_name?: string | null;
    device_name?: string;
    auto_welcome?: boolean;
  }) {
    return this.post<{
      user_id: number;
      username: string;
      first_name: string;
      session_id: string;
      token: string;
      created_at: string;
    }>('/api/v1/auth/register', {
      first_name: params.first_name ?? params.username,
      last_name: params.last_name ?? null,
      device_name: params.device_name ?? 'GPUI E2E Client',
      auto_welcome: params.auto_welcome ?? true,
      ...params,
    }, { token: null });
  }

  login(params: { username: string; password: string; device_name?: string }) {
    return this.post<{
      user_id: number;
      username: string;
      session_id: string;
      token: string;
      requires_2fa?: boolean;
      challenge_token?: string;
    }>('/api/v1/auth/login', {
      device_name: 'GPUI E2E Client',
      ...params,
    }, { token: null });
  }

  getMe() {
    return this.get<Record<string, any>>('/api/v1/auth/me');
  }

  updateProfile(patch: Record<string, unknown>) {
    return this.put<Record<string, any>>('/api/v1/auth/profile', patch);
  }

  listSessions() {
    return this.get<{ user_id: number; sessions: any[] }>('/api/v1/auth/sessions');
  }

  revokeSession(sessionId: string) {
    return this.delete<{ revoked: boolean; session_id: string }>(
      `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  revokeOtherSessions() {
    return this.delete<{ revoked_count: number }>('/api/v1/auth/sessions/others');
  }

  sendPhoneCode(phone: string) {
    return this.post<Record<string, any>>('/api/v1/auth/phone/send-code', { phone }, { token: null });
  }

  verifyPhoneCode(req: Record<string, unknown>) {
    return this.post<Record<string, any>>('/api/v1/auth/phone/verify', req, { token: null });
  }

  initQrPair() {
    return this.post<{ pair_token: string; qr_url: string; expires_at_ms: number }>(
      '/api/v1/auth/pair/init',
      {},
      { token: null },
    );
  }

  acceptQrPair(pairToken: string) {
    return this.post<Record<string, any>>('/api/v1/auth/pair/accept', { pair_token: pairToken });
  }

  pollQrPair(pairToken: string) {
    return this.get<Record<string, any>>(
      `/api/v1/auth/pair/poll/${encodeURIComponent(pairToken)}`,
      { token: null },
    );
  }

  // --- Chats & Folders ---
  listChats() {
    return this.get<{ chats: any[]; total: number }>('/api/v1/chats');
  }

  createChat(req: {
    title?: string;
    chat_type: string | number;
    peer_user_id?: number | null;
    username?: string | null;
    about?: string;
    is_forum?: boolean;
    member_ids?: number[];
    member_usernames?: string[];
  }) {
    return this.post<Record<string, any>>('/api/v1/chats', {
      peer_user_id: null,
      username: null,
      about: '',
      is_forum: false,
      member_ids: [],
      member_usernames: [],
      ...req,
    });
  }

  getChat(chatId: number) {
    return this.get<Record<string, any>>(`/api/v1/chats/${chatId}`);
  }

  updateChat(chatId: number, patch: Record<string, unknown>) {
    return this.put<Record<string, any>>(`/api/v1/chats/${chatId}`, patch);
  }

  deleteChat(chatId: number) {
    return this.delete<{ deleted: boolean; chat_id: number }>(`/api/v1/chats/${chatId}`);
  }

  archiveChat(chatId: number, archived = true) {
    return this.post(`/api/v1/chats/${chatId}/archive`, { archived });
  }

  pinChat(chatId: number, pinned = true) {
    return this.post(`/api/v1/chats/${chatId}/pin`, { pinned });
  }

  muteChat(chatId: number, muted = true, muteUntilMs: number | null = null) {
    return this.post(`/api/v1/chats/${chatId}/mute`, { muted, mute_until_ms: muteUntilMs });
  }

  listFolders() {
    return this.get<{ folders: any[] }>('/api/v1/folders');
  }

  createFolder(req: { title: string; emoticon?: string; include_chats?: number[]; [k: string]: any }) {
    return this.post<Record<string, any>>('/api/v1/folders', {
      include_chats: [],
      exclude_chats: [],
      pinned_chats: [],
      ...req,
    });
  }

  updateFolder(folderId: number | string, req: Record<string, unknown>) {
    return this.put<Record<string, any>>(`/api/v1/folders/${folderId}`, req);
  }

  deleteFolder(folderId: number | string) {
    return this.delete(`/api/v1/folders/${folderId}`);
  }

  // --- Messaging, Polls, Reactions & PTS Sync ---
  sendMessage(req: {
    chat_id: number;
    text?: string;
    content?: any;
    entities?: any[];
    reply_to?: number | null;
    quote_text?: string | null;
    topic_id?: number | null;
    client_nonce?: number;
    media_id?: string | null;
    inline_keyboard?: any;
  }) {
    return this.post<Record<string, any>>('/api/v1/messages/send', {
      entities: [],
      reply_to: null,
      quote_text: null,
      topic_id: null,
      client_nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      media_id: null,
      inline_keyboard: null,
      ...req,
    });
  }

  getMessages(
    chatId: number,
    query: { limit?: number; before_id?: number; after_id?: number; topic_id?: number } = {},
  ) {
    const qs = new URLSearchParams();
    qs.set('limit', String(query.limit ?? 50));
    if (query.before_id !== undefined) qs.set('before_id', String(query.before_id));
    if (query.after_id !== undefined) qs.set('after_id', String(query.after_id));
    if (query.topic_id !== undefined) qs.set('topic_id', String(query.topic_id));
    return this.get<{
      chat_id: number;
      messages: any[];
      has_more: boolean;
      pts: number;
      current_pts: number;
    }>(`/api/v1/chats/${chatId}/messages?${qs.toString()}`);
  }

  editMessage(chatId: number, messageId: number, text: string, entities: any[] = []) {
    return this.put<Record<string, any>>(
      `/api/v1/chats/${chatId}/messages/${messageId}`,
      { text, entities },
    );
  }

  deleteMessages(chatId: number, messageIds: number[], revoke = true) {
    return this.post<Record<string, any>>('/api/v1/messages/delete', {
      chat_id: chatId,
      message_ids: messageIds,
      revoke,
    });
  }

  toggleReaction(chatId: number, messageId: number, emoji: string, action = 'toggle') {
    return this.post<Record<string, any>>(
      `/api/v1/chats/${chatId}/messages/${messageId}/reactions`,
      { emoji, action },
    );
  }

  markRead(chatId: number, maxId: number, topicId = 0) {
    return this.post<Record<string, any>>(`/api/v1/chats/${chatId}/read`, {
      max_id: maxId,
      topic_id: topicId,
    });
  }

  createPoll(
    chatId: number,
    req: {
      question: string;
      options: string[];
      is_anonymous?: boolean;
      multiple_choice?: boolean;
      is_quiz?: boolean;
    },
  ) {
    return this.post<Record<string, any>>(`/api/v1/chats/${chatId}/polls`, {
      is_anonymous: true,
      multiple_choice: false,
      is_quiz: false,
      ...req,
    });
  }

  votePoll(pollId: number | string, optionIds: number[]) {
    return this.post<Record<string, any>>(`/api/v1/polls/${pollId}/vote`, {
      option_ids: optionIds,
    });
  }

  closePoll(pollId: number | string) {
    return this.post<Record<string, any>>(`/api/v1/polls/${pollId}/close`, {});
  }

  getDifference(chatId: number, pts: number, limit = 100) {
    return this.get<Record<string, any>>(
      `/api/v1/sync/difference?chat_id=${chatId}&pts=${pts}&limit=${limit}`,
    );
  }

  // --- Media CAS & Search & E2EE ---
  uploadMedia(
    bytes: Buffer | Uint8Array,
    opts: { filename: string; mimeType: string; chatId?: number },
  ) {
    const qs = new URLSearchParams({
      filename: opts.filename,
      mime_type: opts.mimeType,
    });
    if (opts.chatId !== undefined) {
      qs.set('chat_id', String(opts.chatId));
    }
    return this.post<Record<string, any>>(`/api/v1/media/upload?${qs.toString()}`, undefined, {
      rawBody: bytes,
      contentType: opts.mimeType,
    });
  }

  initChunkedUpload(req: {
    size_bytes: number;
    filename: string;
    chunk_size: number;
    expected_sha256?: string;
  }) {
    return this.post<Record<string, any>>('/api/v1/media/upload/init', req);
  }

  uploadChunkPart(uploadId: string, partIndex: number, bytes: Buffer | Uint8Array) {
    return this.put<Record<string, any>>(
      `/api/v1/media/upload/${encodeURIComponent(uploadId)}/part/${partIndex}`,
      undefined,
      { rawBody: bytes, contentType: 'application/octet-stream' },
    );
  }

  completeChunkedUpload(
    uploadId: string,
    req: { filename: string; mime_type: string; chat_id?: number },
  ) {
    return this.post<Record<string, any>>(
      `/api/v1/media/upload/${encodeURIComponent(uploadId)}/complete`,
      req,
    );
  }

  async downloadMedia(fileId: string, rangeHeader?: string): Promise<{
    status: number;
    headers: Headers;
    bytes: Buffer;
  }> {
    const url = `${this.baseUrl}/api/v1/media/${encodeURIComponent(fileId)}`;
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (rangeHeader) headers.Range = rangeHeader;
    const resp = await fetch(url, { headers });
    const ab = await resp.arrayBuffer();
    return {
      status: resp.status,
      headers: resp.headers,
      bytes: Buffer.from(ab),
    };
  }

  search(
    query: string,
    opts: { category?: string; chatId?: number; limit?: number; mode?: string } = {},
  ) {
    const qs = new URLSearchParams({ q: query });
    if (opts.category) qs.set('category', opts.category);
    if (opts.chatId !== undefined) qs.set('chat_id', String(opts.chatId));
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.mode) qs.set('mode', opts.mode);
    return this.get<Record<string, any>>(`/api/v1/search?${qs.toString()}`);
  }

  publishPreKeys(payload: Record<string, unknown>) {
    return this.post<Record<string, any>>('/api/v1/e2ee/prekeys', payload);
  }

  getPreKeyCount(deviceId: string) {
    return this.get<Record<string, any>>(
      `/api/v1/e2ee/prekeys/count?device_id=${encodeURIComponent(deviceId)}`,
    );
  }

  fetchUserPreKeyBundles(userId: number) {
    return this.get<Record<string, any>>(`/api/v1/e2ee/prekeys/${userId}`);
  }

  // --- Browser Control Relay REST (F1, F3, F9) ---
  getBrowserStatus() {
    return this.get<Record<string, any>>('/api/v1/browser/status');
  }

  getBrowserTabs() {
    return this.get<{ ok: boolean; tabs: any[] }>('/api/v1/browser/tabs');
  }

  execBrowserTool(
    req: {
      tool: string;
      arguments?: Record<string, unknown>;
      bot_id?: number | null;
      chat_id?: number | null;
      timeout_ms?: number;
    },
    timeoutMs = 30000,
  ) {
    return this.request<Record<string, any>>(
      'POST',
      '/api/v1/browser/exec',
      {
        arguments: {},
        ...req,
      },
      { timeoutMs },
    );
  }

  getBotBrowserProfile(botId: number | string) {
    return this.get<Record<string, any>>(`/api/v1/bots/${encodeURIComponent(String(botId))}/browser`);
  }

  setBotBrowserProfile(botId: number | string, profile: Record<string, unknown>) {
    return this.put<Record<string, any>>(
      `/api/v1/bots/${encodeURIComponent(String(botId))}/browser`,
      profile,
    );
  }

  async getPendingBrowserCommands(): Promise<{ items: any[]; raw: any }> {
    const raw = await this.get<any>('/api/v1/browser/commands/pending');
    const items = Array.isArray(raw)
      ? raw
      : raw?.pending ?? raw?.commands ?? raw?.items ?? [];
    return { items, raw };
  }

  approveBrowserCommand(
    commandId: string,
    approved: boolean,
    rememberForSession = false,
  ) {
    return this.post<Record<string, any>>(
      `/api/v1/browser/commands/${encodeURIComponent(commandId)}/approve`,
      { approved, remember_for_session: rememberForSession },
    );
  }

  issueBrowserPairing(body: Record<string, unknown> = {}) {
    return this.post<Record<string, any>>('/api/v1/browser/pairing', body);
  }

  // --- Hermes Studio, Fabushi Bots, BotFather & Mini Apps ---
  getHermesStatus(botId?: number) {
    const qs = botId !== undefined ? `?bot_id=${botId}` : '';
    return this.get<Record<string, any>>(`/api/v1/hermes/status${qs}`);
  }

  getHermesProviders(botId?: number) {
    const qs = botId !== undefined ? `?bot_id=${botId}` : '';
    return this.get<Record<string, any>>(`/api/v1/hermes/providers${qs}`);
  }

  upsertHermesProvider(req: Record<string, unknown>, botId?: number) {
    const qs = botId !== undefined ? `?bot_id=${botId}` : '';
    return this.put<Record<string, any>>(`/api/v1/hermes/providers${qs}`, req);
  }

  createHermesTurn(
    req: {
      prompt: string;
      session_id?: string | null;
      chat_id?: number | null;
      bot_id?: number | null;
      model?: string | null;
      provider?: string | null;
      system_prompt?: string | null;
      preset?: string;
      yolo?: boolean;
      deliver_to_chat?: boolean;
      max_iterations?: number;
    },
    timeoutMs = 45000,
  ) {
    return this.post<Record<string, any>>(
      '/api/v1/hermes/turns',
      {
        session_id: null,
        chat_id: null,
        bot_id: null,
        yolo: true,
        deliver_to_chat: false,
        max_iterations: 10,
        ...req,
      },
      { timeoutMs },
    );
  }

  getHermesTurnEvents(turnId: string) {
    return this.get<Record<string, any>>(
      `/api/v1/hermes/turns/${encodeURIComponent(turnId)}/events`,
    );
  }

  runHermesCommand(
    command: string,
    opts: { session_id?: string; chat_id?: number; bot_id?: number } = {},
  ) {
    return this.post<Record<string, any>>('/api/v1/hermes/command', {
      command,
      ...opts,
    });
  }

  getHermesCommands() {
    return this.get<Record<string, any>>('/api/v1/hermes/commands');
  }

  getHermesToolsets(botId?: number) {
    const qs = botId !== undefined ? `?bot_id=${botId}` : '';
    return this.get<{ toolsets: any[]; total: number }>(`/api/v1/hermes/toolsets${qs}`);
  }

  updateHermesToolsets(body: Record<string, unknown>, botId?: number) {
    const qs = botId !== undefined ? `?bot_id=${botId}` : '';
    return this.put<Record<string, any>>(`/api/v1/hermes/toolsets${qs}`, body);
  }

  listSkills() {
    return this.get<{ skills: any[]; total: number }>('/api/v1/hermes/skills');
  }

  createSkill(req: { name: string; description: string; content: string; tags?: string[] }) {
    return this.post<Record<string, any>>('/api/v1/hermes/skills', req);
  }

  approveSkill(name: string, allowHighRisk = true) {
    return this.post<Record<string, any>>(
      `/api/v1/hermes/skills/${encodeURIComponent(name)}/approve`,
      { allow_high_risk: allowHighRisk },
    );
  }

  deleteSkill(name: string) {
    return this.delete(`/api/v1/hermes/skills/${encodeURIComponent(name)}`);
  }

  getMemory() {
    return this.get<Record<string, any>>('/api/v1/hermes/memory');
  }

  updateMemory(req: Record<string, unknown>) {
    return this.put<Record<string, any>>('/api/v1/hermes/memory', req);
  }

  memoryAction(req: Record<string, unknown>) {
    return this.post<Record<string, any>>('/api/v1/hermes/memory/action', req);
  }

  getSoul() {
    return this.get<Record<string, any>>('/api/v1/hermes/soul');
  }

  updateSoul(req: Record<string, unknown>) {
    return this.put<Record<string, any>>('/api/v1/hermes/soul', req);
  }

  listKanbanBoards() {
    return this.get<{ boards: any[]; total: number }>('/api/v1/hermes/kanban/boards');
  }

  createKanbanBoard(req: { name: string; description?: string; columns?: string[] }) {
    return this.post<Record<string, any>>('/api/v1/hermes/kanban/boards', req);
  }

  createKanbanCard(req: {
    board_id: string;
    title: string;
    column?: string;
    description?: string;
    priority?: string;
  }) {
    return this.post<Record<string, any>>('/api/v1/hermes/kanban/cards', req);
  }

  patchKanbanCard(cardId: string, patch: Record<string, unknown>) {
    return this.patch<Record<string, any>>(
      `/api/v1/hermes/kanban/cards/${encodeURIComponent(cardId)}`,
      patch,
    );
  }

  listCronJobs() {
    return this.get<{ jobs: any[]; total: number }>('/api/v1/hermes/cron');
  }

  createCronJob(req: {
    name: string;
    schedule: string;
    prompt: string;
    chat_id?: number;
    enabled?: boolean;
  }) {
    return this.post<Record<string, any>>('/api/v1/hermes/cron', req);
  }

  runCronJob(jobId: string) {
    return this.post<Record<string, any>>(
      `/api/v1/hermes/cron/${encodeURIComponent(jobId)}/run`,
      {},
    );
  }

  deleteCronJob(jobId: string) {
    return this.delete(`/api/v1/hermes/cron/${encodeURIComponent(jobId)}`);
  }

  listHermesApprovals() {
    return this.get<{ approvals: any[]; total: number }>('/api/v1/hermes/approvals');
  }

  decideHermesApproval(approvalId: string, decision: string, reason?: string) {
    return this.post<Record<string, any>>(
      `/api/v1/hermes/approvals/${encodeURIComponent(approvalId)}/decide`,
      { decision, ...(reason ? { reason } : {}) },
    );
  }

  botFatherNlCreate(req: { prompt: string; avatar_shape?: string; avatar_color?: string }) {
    return this.post<{
      bot: Record<string, any>;
      app: Record<string, any>;
      bot_token: string;
      companion_chat_id: number;
      summary_markdown: string;
    }>('/api/v1/botfather/nl-create', req);
  }

  createFabushiBot(req: {
    display_name: string;
    username?: string;
    description?: string;
    title?: string;
    preferred_model?: string;
    approval_mode?: string;
    toolset_preset?: string;
  }) {
    return this.post<{
      bot: Record<string, any>;
      registry: Record<string, any>;
      bot_token: string;
      companion_chat_id: number;
    }>('/api/v1/fabushi-bots', req);
  }

  listFabushiBots() {
    return this.get<{ bots: any[]; total: number }>('/api/v1/fabushi-bots');
  }

  getFabushiBot(botId: number | string) {
    return this.get<Record<string, any>>(
      `/api/v1/fabushi-bots/${encodeURIComponent(String(botId))}`,
    );
  }

  patchFabushiBot(botId: number | string, patch: Record<string, unknown>) {
    return this.patch<Record<string, any>>(
      `/api/v1/fabushi-bots/${encodeURIComponent(String(botId))}`,
      patch,
    );
  }

  listMiniApps(q = '', category = '') {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    return this.get<{ apps: any[]; total: number }>(`/api/v1/miniapps?${qs.toString()}`);
  }

  createMiniApp(req: Record<string, unknown>) {
    return this.post<Record<string, any>>('/api/v1/miniapps', req);
  }

  installMiniApp(botUsername: string, shortName: string, allowWriteAccess = true) {
    return this.post<Record<string, any>>(
      `/api/v1/miniapps/${encodeURIComponent(botUsername)}/${encodeURIComponent(shortName)}/install`,
      { allow_write_access: allowWriteAccess },
    );
  }

  launchMiniApp(
    botUsername: string,
    shortName: string,
    req: Record<string, unknown> = {},
  ) {
    return this.post<Record<string, any>>(
      `/api/v1/miniapps/${encodeURIComponent(botUsername)}/${encodeURIComponent(shortName)}/launch`,
      req,
    );
  }

  validateMiniAppInitData(botUsername: string, shortName: string, initData: string) {
    return this.post<Record<string, any>>(
      `/api/v1/miniapps/${encodeURIComponent(botUsername)}/${encodeURIComponent(shortName)}/validate-init-data`,
      { init_data: initData },
    );
  }

  miniAppAction(
    botUsername: string,
    shortName: string,
    req: Record<string, unknown>,
  ) {
    return this.post<Record<string, any>>(
      `/api/v1/miniapps/${encodeURIComponent(botUsername)}/${encodeURIComponent(shortName)}/action`,
      req,
    );
  }

  callBotApi(botToken: string, method: string, params: Record<string, unknown> = {}) {
    return this.post<{ ok: boolean; result?: any; error_code?: number; description?: string }>(
      `/bot${botToken}/${method}`,
      params,
      { token: null },
    );
  }

  // --- WebSocket Connections ---
  async connectPtsWs(
    opts: { token?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<PtsWsClient> {
    const tok = opts.token ?? this.token;
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const url = tok
      ? `${wsBase}/api/v1/ws?token=${encodeURIComponent(tok)}`
      : `${wsBase}/api/v1/ws`;

    const ws = new WebSocket(url, {
      headers: opts.headers,
      maxPayload: CDP_MAX_PAYLOAD_BYTES,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting PtsWsClient to ${url}`));
      }, opts.timeoutMs ?? 8000);
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        ws.terminate();
        reject(
          Object.assign(
            new Error(`PTS WS upgrade rejected: HTTP ${res.statusCode}`),
            { statusCode: res.statusCode },
          ),
        );
      });
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new PtsWsClient(ws);
  }

  async connectServerBrowserWs(
    opts: {
      token?: string;
      clientKind?: 'extension' | 'desktop';
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<BrowserBridgeWsClient> {
    const tok = opts.token ?? this.token;
    const clientKind = opts.clientKind ?? 'extension';
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams({ client: clientKind });
    if (tok) qs.set('token', tok);
    return await connectBrowserBridgeWs(`${wsBase}/api/v1/browser/ws?${qs.toString()}`, {
      origin: opts.origin,
      headers: opts.headers,
    });
  }
}
