/**
 * Zero-`wasm-bindgen` C-ABI WebAssembly Loader & Typed Wrapper for `gpui_telegram_ext_wasm.wasm`.
 * Works identically inside MV3 Service Worker (`background.js`) and Extension UI pages under
 * `script-src 'self' 'wasm-unsafe-eval'`.
 */

import type { BrowserInjectionScanDto, BrowserLinkDto } from '../shared/rpc_types';

interface WasmRawExports {
  memory: WebAssembly.Memory;
  wasm_alloc: (len: number) => number;
  wasm_dealloc: (ptr: number, len: number) => void;
  wasm_invoke_json: (ptr: number, len: number) => bigint;
  wasm_reset_state?: () => void;
}

export interface WasmResponseEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  error_code?: string;
}

export type PtsEvalResult =
  | { outcome: 'contiguous'; chat_id: number; current_pts: number; buffered_count?: number }
  | { outcome: 'duplicate'; chat_id: number; current_pts: number; buffered_count?: number }
  | {
      outcome: 'gap_detected';
      chat_id: number;
      last_seen: number;
      incoming: number;
      missing_start: number;
      missing_end: number;
      buffered_count?: number;
    };

export interface ExtractedMarkdownResult {
  title: string;
  markdown: string;
  total_chars: number;
  links: BrowserLinkDto[];
  injection_scan?: BrowserInjectionScanDto;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

let wasmExports: WasmRawExports | null = null;
let wasmInitPromise: Promise<boolean> | null = null;

function buildDynamicImports(mod: WebAssembly.Module): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};

  for (const imp of WebAssembly.Module.imports(mod)) {
    if (!imports[imp.module]) {
      imports[imp.module] = {};
    }
    if (imp.kind === 'function') {
      if (imp.name.includes('random') || imp.name.includes('getrandom')) {
        imports[imp.module]![imp.name] = (ptr: number, len: number): number => {
          const mem = wasmExports?.memory;
          if (mem && len > 0) {
            const view = new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0);
            crypto.getRandomValues(view);
          }
          return 0;
        };
      } else if (imp.name.includes('now') || imp.name.includes('time')) {
        imports[imp.module]![imp.name] = (): bigint => BigInt(Date.now());
      } else {
        imports[imp.module]![imp.name] = () => 0;
      }
    }
  }

  return imports;
}

export async function ensureWasmLoaded(): Promise<boolean> {
  if (wasmExports) return true;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    try {
      const wasmUrl =
        typeof chrome !== 'undefined' && chrome.runtime?.getURL
          ? chrome.runtime.getURL('assets/gpui_telegram_ext_wasm.wasm')
          : './assets/gpui_telegram_ext_wasm.wasm';

      const resp = await fetch(wasmUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch WASM (${resp.status})`);
      }
      const bytes = await resp.arrayBuffer();
      const mod = await WebAssembly.compile(bytes);
      const imports = buildDynamicImports(mod);
      const instance = await WebAssembly.instantiate(mod, imports);
      wasmExports = instance.exports as unknown as WasmRawExports;
      return true;
    } catch (err) {
      console.warn('[wasm_bridge] WASM load warning:', err);
      wasmInitPromise = null;
      return false;
    }
  })();

  return wasmInitPromise;
}

export function isWasmReady(): boolean {
  return wasmExports !== null;
}

export function invokeWasmSync<T = unknown>(
  op: string,
  payload: Record<string, unknown> = {},
): WasmResponseEnvelope<T> {
  if (!wasmExports) {
    return {
      ok: false,
      error: 'WASM_NOT_INITIALIZED: gpui_telegram_ext_wasm is not yet loaded',
      error_code: 'WASM_NOT_INITIALIZED',
    };
  }

  const reqJson = JSON.stringify({ op, payload });
  const reqBytes = utf8Encoder.encode(reqJson);
  const inLen = reqBytes.byteLength;
  const inPtr = wasmExports.wasm_alloc(inLen) >>> 0;
  if (inPtr === 0 && inLen > 0) {
    return {
      ok: false,
      error: `ALLOC_FAILED: wasm_alloc(${inLen}) returned null`,
      error_code: 'ALLOC_FAILED',
    };
  }

  let packed: bigint;
  try {
    new Uint8Array(wasmExports.memory.buffer, inPtr, inLen).set(reqBytes);
    packed = wasmExports.wasm_invoke_json(inPtr, inLen);
  } finally {
    wasmExports.wasm_dealloc(inPtr, inLen);
  }

  const outPtr = Number((packed >> 32n) & 0xffffffffn) >>> 0;
  const outLen = Number(packed & 0xffffffffn) >>> 0;
  if (outPtr === 0 || outLen === 0) {
    return {
      ok: false,
      error: 'EMPTY_WASM_OUTPUT: wasm_invoke_json returned empty slice',
      error_code: 'EMPTY_WASM_OUTPUT',
    };
  }

  let outJson = '';
  try {
    const outSlice = new Uint8Array(wasmExports.memory.buffer, outPtr, outLen);
    outJson = utf8Decoder.decode(outSlice);
  } finally {
    wasmExports.wasm_dealloc(outPtr, outLen);
  }

  return JSON.parse(outJson) as WasmResponseEnvelope<T>;
}

export async function invokeWasm<T = unknown>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<WasmResponseEnvelope<T>> {
  await ensureWasmLoaded();
  return invokeWasmSync<T>(op, payload);
}

export async function wasmSetPts(chatId: number, pts: number): Promise<void> {
  await invokeWasm('pts_get_set', { chat_id: chatId, set_pts: Math.max(0, Math.floor(pts)) });
}

export async function wasmEvalPts(
  update: Record<string, unknown>,
  autoBufferGap = true,
): Promise<PtsEvalResult | null> {
  const res = await invokeWasm<PtsEvalResult>('pts_eval', {
    update,
    auto_buffer_gap: autoBufferGap,
  });
  return res.ok && res.data ? res.data : null;
}

export async function wasmDrainContiguousPts(
  chatId: number,
  reconciledPts?: number,
): Promise<{ current_pts: number; drained: Array<Record<string, unknown>> }> {
  const payload: Record<string, unknown> = { chat_id: chatId };
  if (typeof reconciledPts === 'number') {
    payload.set_pts = Math.max(0, Math.floor(reconciledPts));
  }
  const res = await invokeWasm<{
    current_pts: number;
    drained: Array<Record<string, unknown>>;
  }>('pts_drain_contiguous', payload);
  if (res.ok && res.data) {
    return {
      current_pts: res.data.current_pts,
      drained: Array.isArray(res.data.drained) ? res.data.drained : [],
    };
  }
  return { current_pts: reconciledPts ?? 0, drained: [] };
}

function fallbackScanInjection(text: string): BrowserInjectionScanDto {
  const normalized = text.replace(/[\u200B-\u200F\uFEFF\u2060]/g, '');
  const patterns: Array<{ rule_id: string; re: RegExp; severity: 'high' | 'medium' }> = [
    { rule_id: 'system_override', re: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'high' },
    { rule_id: 'system_override_tag', re: /system\s+override/i, severity: 'high' },
    { rule_id: 'exfiltrate_secrets', re: /exfiltrat(e|ion)|\.env|OPENAI_API_KEY/i, severity: 'high' },
    { rule_id: 'role_hijack', re: /you\s+are\s+now\s+in\s+developer\s+mode/i, severity: 'medium' },
  ];
  const findings: BrowserInjectionScanDto['findings'] = [];
  let highest: BrowserInjectionScanDto['severity'] = 'none';
  for (const p of patterns) {
    const m = p.re.exec(normalized);
    if (m) {
      findings.push({
        rule_id: p.rule_id,
        severity: p.severity,
        excerpt: m[0].slice(0, 120),
      });
      if (p.severity === 'high') highest = 'high';
      else if (highest === 'none') highest = 'medium';
    }
  }
  return {
    flagged: findings.length > 0,
    severity: highest,
    findings,
  };
}

export async function wasmHtmlToMarkdown(
  html: string,
  options?: {
    includeLinks?: boolean;
    offset?: number;
    maxChars?: number;
    scanInjection?: boolean;
  },
): Promise<ExtractedMarkdownResult> {
  const cappedHtml = html.length > 512_000 ? html.slice(0, 512_000) : html;
  const payload: Record<string, unknown> = {
    html: cappedHtml,
    include_links: options?.includeLinks ?? true,
    offset: options?.offset ?? 0,
    scan_injection: options?.scanInjection ?? true,
  };
  if (typeof options?.maxChars === 'number' && options.maxChars > 0) {
    payload.max_chars = Math.floor(options.maxChars);
  }

  const res = await invokeWasm<ExtractedMarkdownResult>('html_to_markdown', payload);
  if (res.ok && res.data) {
    return res.data;
  }

  // Fallback sanitizer if WASM binary unavailable
  const stripped = cappedHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/(sk-[a-zA-Z0-9_-]{16,})/g, '[REDACTED_SECRET]')
    .replace(/\s+/g, ' ')
    .trim();
  const totalChars = stripped.length;
  const start = Math.min(options?.offset ?? 0, totalChars);
  const end =
    typeof options?.maxChars === 'number'
      ? Math.min(start + options.maxChars, totalChars)
      : totalChars;
  return {
    title: '',
    markdown: stripped.slice(start, end),
    total_chars: totalChars,
    links: [],
    injection_scan: fallbackScanInjection(stripped),
  };
}

export async function wasmScanContentForInjection(text: string): Promise<BrowserInjectionScanDto> {
  const capped = text.length > 256_000 ? text.slice(0, 256_000) : text;
  const res = await invokeWasm<{
    flagged: boolean;
    severity: 'none' | 'low' | 'medium' | 'high';
    findings: BrowserInjectionScanDto['findings'];
  }>('scan_content_for_injection', { text: capped });
  if (res.ok && res.data) {
    return {
      flagged: Boolean(res.data.flagged),
      severity: res.data.severity ?? 'none',
      findings: Array.isArray(res.data.findings) ? res.data.findings : [],
    };
  }
  return fallbackScanInjection(capped);
}
