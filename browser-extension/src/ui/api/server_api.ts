/**
 * Typed REST API Client for Extension UI Surfaces (`workspace.html`, `sidepanel.html`, `popup.html`, `options.html`).
 * Resolves the active account's `(server_url, token, user_id, username)` directly from `chrome.storage.local`
 * so multi-account switches and E2E seeded sessions work seamlessly.
 */

export interface ActiveApiSession {
  serverUrl: string;
  token: string;
  userId: number | null;
  username: string | null;
}

export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export async function resolveActiveApiSession(
  overrideServerUrl?: string,
  overrideToken?: string,
): Promise<ActiveApiSession> {
  let raw: Record<string, any> = {};
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      raw = (await chrome.storage.local.get(null)) as Record<string, any>;
    }
  } catch {
    raw = {};
  }

  const sessionObj = raw.session ?? raw.auth_session ?? null;
  const baseServerUrl = String(
    overrideServerUrl ||
      raw.server_url ||
      raw.serverUrl ||
      sessionObj?.server_url ||
      sessionObj?.serverUrl ||
      '',
  )
    .trim()
    .replace(/\/+$/, '');

  const accounts: Array<Record<string, any>> = Array.isArray(raw.accounts) ? raw.accounts : [];
  const rawActiveId = raw.active_account_id ?? raw.activeAccountId ?? null;
  const matchedActive =
    rawActiveId !== null && rawActiveId !== undefined
      ? accounts.find(
          (a) =>
            String(a?.user_id ?? a?.userId ?? a?.id ?? '') === String(rawActiveId) ||
            String(a?.username ?? '') === String(rawActiveId),
        )
      : accounts.find((a) => Boolean(a?.active));

  const topToken = String(overrideToken || raw.token || raw.auth_token || sessionObj?.token || '').trim();
  const useAccountOverride =
    !overrideToken &&
    matchedActive &&
    String(matchedActive.token ?? matchedActive.auth_token ?? '').trim().length > 0 &&
    (!topToken ||
      (rawActiveId !== null &&
        rawActiveId !== undefined &&
        String(raw.user_id ?? sessionObj?.user_id ?? '') !==
          String(matchedActive.user_id ?? matchedActive.userId ?? '')));

  const serverUrl = String(
    overrideServerUrl ||
      (useAccountOverride ? matchedActive?.server_url ?? matchedActive?.serverUrl : '') ||
      baseServerUrl ||
      matchedActive?.server_url ||
      'http://127.0.0.1:8080',
  )
    .trim()
    .replace(/\/+$/, '');

  const token = String(
    overrideToken ||
      (useAccountOverride ? matchedActive?.token ?? matchedActive?.auth_token : '') ||
      topToken ||
      matchedActive?.token ||
      matchedActive?.auth_token ||
      '',
  ).trim();

  const rawUid = useAccountOverride
    ? matchedActive?.user_id ?? matchedActive?.userId
    : raw.user_id ?? sessionObj?.user_id ?? matchedActive?.user_id;
  const userId =
    typeof rawUid === 'number' && Number.isFinite(rawUid)
      ? rawUid
      : typeof rawUid === 'string' && rawUid.trim() !== '' && Number.isFinite(Number(rawUid))
        ? Number(rawUid)
        : null;

  const rawUname = useAccountOverride
    ? matchedActive?.username
    : raw.username ?? sessionObj?.username ?? matchedActive?.username;
  const username = typeof rawUname === 'string' && rawUname.trim() ? rawUname.trim() : null;

  return { serverUrl, token, userId, username };
}

export function isValidHttpServerUrl(rawUrl: string): boolean {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export async function apiRequest<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    serverUrl?: string;
    token?: string;
    skipAuth?: boolean;
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult<T>> {
  const sess = await resolveActiveApiSession(options.serverUrl, options.token);
  if (!isValidHttpServerUrl(sess.serverUrl)) {
    return {
      ok: false,
      status: 0,
      data: null as unknown as T,
      error: 'Invalid HTTP/HTTPS server URL',
    };
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${sess.serverUrl}${normalizedPath}`;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  if (!options.skipAuth && sess.token) {
    headers.Authorization = `Bearer ${sess.token}`;
  }

  let fetchBody: BodyInit | undefined;
  if (options.body !== undefined && options.body !== null) {
    if (
      options.body instanceof FormData ||
      options.body instanceof Blob ||
      options.body instanceof ArrayBuffer ||
      options.body instanceof Uint8Array
    ) {
      fetchBody = options.body as BodyInit;
    } else if (typeof options.body === 'string') {
      fetchBody = options.body;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    } else {
      fetchBody = JSON.stringify(options.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);

  try {
    const resp = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: fetchBody,
      signal: controller.signal,
    });

    const contentType = resp.headers.get('content-type') ?? '';
    let parsed: any = null;
    if (contentType.includes('application/json')) {
      parsed = await resp.json().catch(() => null);
    } else {
      const txt = await resp.text().catch(() => '');
      try {
        parsed = txt ? JSON.parse(txt) : {};
      } catch {
        parsed = { raw: txt };
      }
    }

    if (!resp.ok) {
      const errMsg =
        parsed?.error?.message ??
        parsed?.error ??
        parsed?.message ??
        parsed?.detail ??
        (typeof parsed?.raw === 'string' && parsed.raw ? parsed.raw.slice(0, 200) : '') ??
        `HTTP ${resp.status}`;
      return {
        ok: false,
        status: resp.status,
        data: parsed as T,
        error: String(errMsg || `HTTP ${resp.status}`),
      };
    }

    return { ok: true, status: resp.status, data: parsed as T };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: null as unknown as T,
      error:
        err?.name === 'AbortError'
          ? 'Request timed out — server unreachable'
          : String(err?.message ?? err ?? 'Network error'),
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function probeServerHealth(rawServerUrl: string): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  const clean = String(rawServerUrl ?? '').trim().replace(/\/+$/, '');
  if (!isValidHttpServerUrl(clean)) {
    return { ok: false, error: 'Invalid HTTP/HTTPS Server URL' };
  }

  const statusRes = await apiRequest<Record<string, any>>('/api/v1/status', {
    serverUrl: clean,
    skipAuth: true,
    timeoutMs: 4000,
  });
  if (statusRes.ok) {
    return {
      ok: true,
      version: String(statusRes.data?.version ?? statusRes.data?.status ?? 'ok'),
    };
  }

  const healthRes = await apiRequest<Record<string, any>>('/health', {
    serverUrl: clean,
    skipAuth: true,
    timeoutMs: 4000,
  });
  if (healthRes.ok) {
    return { ok: true, version: String(healthRes.data?.status ?? 'healthy') };
  }

  return { ok: false, error: statusRes.error || healthRes.error || 'Server unreachable' };
}

const mediaBlobUrlCache = new Map<string, string>();

export async function fetchAuthenticatedMediaBlobUrl(mediaIdOrUrl: string): Promise<{
  ok: boolean;
  blobUrl?: string;
  mimeType?: string;
  status?: number;
}> {
  const raw = String(mediaIdOrUrl ?? '').trim();
  if (!raw) return { ok: false };
  if (raw.startsWith('data:') || raw.startsWith('blob:')) {
    return { ok: true, blobUrl: raw };
  }
  const cached = mediaBlobUrlCache.get(raw);
  if (cached) {
    return { ok: true, blobUrl: cached };
  }

  const sess = await resolveActiveApiSession();
  const url =
    raw.startsWith('http://') || raw.startsWith('https://')
      ? raw
      : raw.startsWith('/')
        ? `${sess.serverUrl}${raw}`
        : `${sess.serverUrl}/api/v1/media/${encodeURIComponent(raw)}`;

  try {
    const resp = await fetch(url, {
      headers: sess.token ? { Authorization: `Bearer ${sess.token}` } : {},
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status };
    }
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    mediaBlobUrlCache.set(raw, objUrl);
    return { ok: true, blobUrl: objUrl, mimeType: blob.type, status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function uploadMediaFile(file: File | Blob, filename?: string): Promise<ApiResult<any>> {
  const sess = await resolveActiveApiSession();
  const actualName = filename || (file instanceof File ? file.name : 'upload.bin');
  const mime = file.type || 'application/octet-stream';

  // Use multipart FormData upload for standard files <= 2MB, chunked upload for larger files
  if (file.size > 2 * 1024 * 1024) {
    const initRes = await apiRequest('/api/v1/media/upload/init', {
      method: 'POST',
      body: {
        filename: actualName,
        mime_type: mime,
        total_size: file.size,
        size_bytes: file.size,
      },
    });
    const uploadId = initRes.data?.upload_id ?? initRes.data?.id;
    if (initRes.ok && uploadId) {
      const chunkSize = 1024 * 1024;
      let partIndex = 0;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
        const buf = await slice.arrayBuffer();
        const partRes = await apiRequest(
          `/api/v1/media/upload/${encodeURIComponent(String(uploadId))}/part/${partIndex}`,
          {
            method: 'PUT',
            body: buf,
            headers: { 'Content-Type': 'application/octet-stream' },
          },
        );
        if (!partRes.ok) break;
        partIndex++;
      }
      const completeRes = await apiRequest(
        `/api/v1/media/upload/${encodeURIComponent(String(uploadId))}/complete`,
        { method: 'POST', body: {} },
      );
      if (completeRes.ok) return completeRes;
    }
  }

  const form = new FormData();
  form.append('file', file, actualName);
  form.append('filename', actualName);
  form.append('mime_type', mime);

  const formRes = await apiRequest('/api/v1/media/upload', {
    method: 'POST',
    body: form,
    serverUrl: sess.serverUrl,
    token: sess.token,
  });
  if (formRes.ok) return formRes;

  // Fallback raw binary upload if server expects raw bytes + headers
  const rawBuf = await file.arrayBuffer();
  return apiRequest(`/api/v1/media/upload?filename=${encodeURIComponent(actualName)}`, {
    method: 'POST',
    body: rawBuf,
    headers: {
      'Content-Type': mime,
      'X-File-Name': encodeURIComponent(actualName),
    },
  });
}
