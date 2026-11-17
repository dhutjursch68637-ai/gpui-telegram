import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';

export { assert };

export const BROWSER_RPC_ERROR_CODES = {
  UNAUTHORIZED_BRIDGE: -32001,
  USER_DENIED_APPROVAL: -32002,
  POLICY_DISABLED: -32003,
  RESTRICTED_URL: -32004,
  TAB_NOT_FOUND: -32005,
  ELEMENT_NOT_FOUND: -32006,
  NAVIGATION_TIMEOUT: -32007,
  CDP_ATTACH_FAILED: -32008,
} as const;

export const CANONICAL_BROWSER_TOOLS = [
  'browser_status',
  'browser_list_tabs',
  'browser_get_active_tab',
  'browser_open_tab',
  'browser_activate_tab',
  'browser_close_tab',
  'browser_group_tabs',
  'browser_navigate',
  'browser_reload',
  'browser_back_forward',
  'browser_snapshot',
  'browser_extract_markdown',
  'browser_query_selector',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_scroll',
  'browser_wait_for',
  'browser_screenshot',
  'browser_evaluate',
  'browser_get_console_logs',
  'browser_get_network_log',
  'browser_manage_cookies',
  'browser_download_url',
] as const;

export const CANONICAL_BROWSER_TOOL_ALIASES = [
  'browser_tabs',
  'browser_switch_tab',
] as const;

export const FORBIDDEN_TIR_PARAM_KEYS = [
  'path',
  'file_path',
  'target_path',
  'destination',
  'cwd',
  'workdir',
] as const;

export const CANONICAL_TEST_IDS = [
  'auth-wizard',
  'auth-server-url-input',
  'auth-username-input',
  'auth-password-input',
  'auth-submit-btn',
  'nav-rail',
  'chat-sidebar',
  'chat-search-input',
  'create-menu-btn',
  'conversation-stage',
  'message-bubble',
  'thinking-bubble',
  'tool-steps-list',
  'canonical-composer-input',
  'composer-send-btn',
  'slash-command-popup',
  'context-inspector',
  'hermes-studio-workspace',
  'settings-router',
  'browser-bridge-status-pill',
  'browser-policy-select',
  'emergency-stop-btn',
  'theme-toggle-btn',
  'lang-toggle-btn',
] as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FatalPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalPollError';
  }
}

export interface PollOptions<T> {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
  isDone?: (value: T) => boolean;
}

export async function pollUntil<T>(
  fn: () => Promise<T> | T,
  opts: PollOptions<T> = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const intervalMs = opts.intervalMs ?? 80;
  const isDone = opts.isDone ?? ((val: T) => Boolean(val));
  const deadline = Date.now() + timeoutMs;

  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      lastValue = value;
      lastError = undefined;
      if (isDone(value)) {
        return value;
      }
    } catch (err) {
      if (err instanceof FatalPollError) {
        throw err;
      }
      lastError = err;
    }
    if (Date.now() + intervalMs > deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  const label = opts.message ? `${opts.message} ` : '';
  const detail = lastError
    ? `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : `last value: ${JSON.stringify(lastValue)?.slice(0, 400)}`;
  throw new Error(`pollUntil timed out after ${timeoutMs}ms: ${label}(${detail})`);
}

export function stripDataUrlPrefix(b64OrDataUrl: string): { mimeType?: string; base64: string } {
  const trimmed = b64OrDataUrl.trim();
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (match) {
    return { mimeType: match[1], base64: match[2].replace(/\s+/g, '') };
  }
  return { base64: trimmed.replace(/\s+/g, '') };
}

export interface PngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  byteLength: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parsePngBuffer(input: Buffer | Uint8Array | string): PngMetadata {
  const buf =
    typeof input === 'string'
      ? Buffer.from(stripDataUrlPrefix(input).base64, 'base64')
      : Buffer.from(input);

  assert.ok(buf.length >= 24, `PNG buffer too short (${buf.length} bytes < 24)`);
  assert.ok(
    buf.subarray(0, 8).equals(PNG_MAGIC),
    `Invalid PNG magic header: expected 89504e470d0a1a0a, got ${buf.subarray(0, 8).toString('hex')}`,
  );
  const ihdrTag = buf.subarray(12, 16).toString('ascii');
  assert.equal(ihdrTag, 'IHDR', `Expected PNG IHDR chunk at offset 12, got ${ihdrTag}`);

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24 >= buf.length ? 0 : 24);
  const colorType = buf.length > 25 ? buf.readUInt8(25) : 0;

  assert.ok(width > 0 && height > 0, `PNG dimensions must be positive, got ${width}x${height}`);
  return { width, height, bitDepth, colorType, byteLength: buf.length };
}

export function assertValidPng(
  input: Buffer | Uint8Array | string,
  constraints?: { minWidth?: number; minHeight?: number; minBytes?: number },
): PngMetadata {
  const meta = parsePngBuffer(input);
  if (constraints?.minWidth !== undefined) {
    assert.ok(
      meta.width >= constraints.minWidth,
      `PNG width ${meta.width} < expected minWidth ${constraints.minWidth}`,
    );
  }
  if (constraints?.minHeight !== undefined) {
    assert.ok(
      meta.height >= constraints.minHeight,
      `PNG height ${meta.height} < expected minHeight ${constraints.minHeight}`,
    );
  }
  if (constraints?.minBytes !== undefined) {
    assert.ok(
      meta.byteLength >= constraints.minBytes,
      `PNG byteLength ${meta.byteLength} < expected minBytes ${constraints.minBytes}`,
    );
  }
  return meta;
}

export function assertValidJpeg(input: Buffer | Uint8Array | string): { byteLength: number } {
  const buf =
    typeof input === 'string'
      ? Buffer.from(stripDataUrlPrefix(input).base64, 'base64')
      : Buffer.from(input);
  assert.ok(buf.length > 4, `JPEG buffer too short (${buf.length} bytes)`);
  assert.ok(
    buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    `Invalid JPEG SOI header: got ${buf.subarray(0, 3).toString('hex')}`,
  );
  return { byteLength: buf.length };
}

export function assertWasmMagic(input: Buffer | Uint8Array | string): {
  version: number;
  byteLength: number;
} {
  const buf = typeof input === 'string' ? fs.readFileSync(input) : Buffer.from(input);
  assert.ok(buf.length >= 8, `WASM binary too short (${buf.length} bytes)`);
  assert.ok(
    buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d,
    `Invalid WASM magic header: got ${buf.subarray(0, 4).toString('hex')}`,
  );
  const version = buf.readUInt32LE(4);
  assert.equal(version, 1, `Expected WASM binary version 1, got ${version}`);
  return { version, byteLength: buf.length };
}

export function assertElfBinary(filePath: string): void {
  const st = fs.statSync(filePath);
  assert.ok(st.isFile() && st.size > 0, `Expected non-empty binary file at ${filePath}`);
  fs.accessSync(filePath, fs.constants.X_OK);
  const fd = fs.openSync(filePath, 'r');
  const hdr = Buffer.alloc(4);
  try {
    fs.readSync(fd, hdr, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(
    hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46,
    `Expected ELF header (7f 45 4c 46) at ${filePath}, got ${hdr.toString('hex')}`,
  );
}

export function getFilesystemType(targetPath: string): string {
  const resolved = fs.realpathSync(targetPath);
  const mountsRaw = fs.readFileSync('/proc/mounts', 'utf-8');
  let bestMount = '';
  let bestFsType = 'unknown';

  for (const line of mountsRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const mountPoint = parts[1].replace(/\\040/g, ' ');
    const fsType = parts[2];
    if (
      resolved === mountPoint ||
      mountPoint === '/' ||
      resolved.startsWith(mountPoint + '/')
    ) {
      if (mountPoint.length >= bestMount.length) {
        bestMount = mountPoint;
        bestFsType = fsType;
      }
    }
  }
  return bestFsType;
}

export function assertPathOnXfs(targetPath: string): string {
  const fsType = getFilesystemType(targetPath);
  assert.notEqual(
    fsType,
    'virtiofs',
    `Path ${targetPath} must NOT reside on virtiofs (got ${fsType})`,
  );
  assert.ok(
    fsType === 'xfs' || fsType === 'tmpfs' || fsType === 'ext4' || fsType === 'overlay',
    `Expected ${targetPath} on xfs/local filesystem, got ${fsType}`,
  );
  return fsType;
}

export function unwrapBrowserExecResult<T = Record<string, any>>(resp: any): T {
  if (!resp || typeof resp !== 'object') {
    return resp as T;
  }
  if (resp.data && typeof resp.data === 'object' && ('ok' in resp.data || 'result' in resp.data)) {
    return unwrapBrowserExecResult<T>(resp.data);
  }
  if (resp.result && typeof resp.result === 'object') {
    return {
      ok: resp.ok ?? resp.result.ok ?? true,
      ...resp.result,
      ...(resp.artifact ? { artifact: resp.artifact } : {}),
    } as T;
  }
  return resp as T;
}

export function extractBrowserErrorCode(errOrResp: any): {
  code: number | undefined;
  symbolicCode: string | undefined;
  message: string;
} {
  const payload = errOrResp?.data && typeof errOrResp.data === 'object' && 'status' in errOrResp
    ? errOrResp.data
    : errOrResp;

  const rpcErr = payload?.error && typeof payload.error === 'object' ? payload.error : null;
  const rawCode =
    rpcErr?.code ??
    payload?.code ??
    payload?.result?.error?.code ??
    payload?.result?.code;
  const code = typeof rawCode === 'number' ? rawCode : undefined;

  const rawSymbolic =
    rpcErr?.data?.error_code ??
    payload?.error_code ??
    (typeof payload?.error === 'string' ? payload.error : undefined) ??
    payload?.result?.error_code;
  const symbolicCode = typeof rawSymbolic === 'string' ? rawSymbolic : undefined;

  const message =
    (typeof rpcErr?.message === 'string' && rpcErr.message) ||
    (typeof payload?.message === 'string' && payload.message) ||
    (typeof payload?.error === 'string' && payload.error) ||
    JSON.stringify(payload ?? '');

  return { code, symbolicCode, message };
}

export function assertBrowserRpcError(
  errOrResp: any,
  expectedCode: number | number[],
  expectedSymbolic?: string,
): void {
  const unwrapped = errOrResp?.data && 'status' in errOrResp ? errOrResp.data : errOrResp;
  assert.notEqual(
    unwrapped?.ok,
    true,
    `Expected browser operation to fail with ${JSON.stringify(expectedCode)}, got ok:true (${JSON.stringify(unwrapped).slice(0, 300)})`,
  );

  const { code, symbolicCode, message } = extractBrowserErrorCode(errOrResp);
  const allowedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];

  if (code !== undefined) {
    assert.ok(
      allowedCodes.includes(code),
      `Expected JSON-RPC error code in ${JSON.stringify(allowedCodes)}, got ${code} (symbolic=${symbolicCode}, msg=${message})`,
    );
  } else if (expectedSymbolic) {
    assert.equal(
      symbolicCode?.toUpperCase(),
      expectedSymbolic.toUpperCase(),
      `Expected symbolic error_code ${expectedSymbolic}, got ${symbolicCode} (msg=${message})`,
    );
  } else {
    assert.fail(
      `Missing JSON-RPC numeric error code (expected ${JSON.stringify(allowedCodes)}) in response: ${JSON.stringify(unwrapped).slice(0, 400)}`,
    );
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.slice(0, 6);
  const num = Number.parseInt(full, 16);
  assert.ok(!Number.isNaN(num), `Invalid hex color: ${hex}`);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

export function parseCssRgb(
  cssColor: string,
): { r: number; g: number; b: number; a: number } | null {
  const trimmed = cssColor.trim();
  if (trimmed.startsWith('#')) {
    const { r, g, b } = hexToRgb(trimmed);
    return { r, g, b, a: 1 };
  }
  const m = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
    trimmed,
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

export function assertCssColorMatches(
  actualCss: string,
  expectedHex: string,
  tolerance = 8,
): void {
  const actual = parseCssRgb(actualCss);
  assert.ok(actual !== null, `Unable to parse computed CSS color: ${actualCss}`);
  const expected = hexToRgb(expectedHex);
  const diff =
    Math.abs(actual.r - expected.r) +
    Math.abs(actual.g - expected.g) +
    Math.abs(actual.b - expected.b);
  assert.ok(
    diff <= tolerance * 3,
    `Expected CSS color ~${expectedHex} (${expected.r},${expected.g},${expected.b}), got ${actualCss} (${actual.r},${actual.g},${actual.b})`,
  );
}
