import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface ExtWasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc: (len: number) => number;
  wasm_dealloc: (ptr: number, len: number) => void;
  wasm_invoke_json: (ptr: number, len: number) => bigint | number;
  [key: string]: WebAssembly.ExportValue;
}

export type WasmOpEnvelope<T = any> =
  | { ok: true; data: T; [extra: string]: any }
  | { ok: false; error: string; [extra: string]: any };

export function buildDynamicWasmImports(
  mod: WebAssembly.Module,
  memoryGetter?: () => WebAssembly.Memory | undefined,
): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  const decls = WebAssembly.Module.imports(mod);
  for (const decl of decls) {
    if (!imports[decl.module]) {
      imports[decl.module] = {};
    }
    const ns = imports[decl.module] as Record<string, WebAssembly.ImportValue>;
    if (decl.kind === 'function') {
      if (/random/i.test(decl.name)) {
        ns[decl.name] = (ptr: number, len: number): number => {
          const mem = memoryGetter?.();
          if (mem && len > 0) {
            const view = new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0);
            crypto.randomFillSync(view);
          }
          return 0;
        };
      } else if (/now|time/i.test(decl.name)) {
        ns[decl.name] = (): number => Date.now();
      } else {
        ns[decl.name] = (): number => 0;
      }
    } else if (decl.kind === 'memory') {
      ns[decl.name] = new WebAssembly.Memory({ initial: 16 });
    } else if (decl.kind === 'table') {
      ns[decl.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    } else if (decl.kind === 'global') {
      ns[decl.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
    }
  }
  return imports;
}

export function invokeExtWasmRawBytes<T = any>(
  exports: ExtWasmExports,
  reqBytes: Uint8Array,
): WasmOpEnvelope<T> {
  if (typeof exports.wasm_alloc !== 'function') {
    throw new Error('Missing WASM export: wasm_alloc');
  }
  if (typeof exports.wasm_dealloc !== 'function') {
    throw new Error('Missing WASM export: wasm_dealloc');
  }
  if (typeof exports.wasm_invoke_json !== 'function') {
    throw new Error('Missing WASM export: wasm_invoke_json');
  }
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('Missing WASM export: memory');
  }

  const byteLen = reqBytes.byteLength;
  const allocLen = Math.max(byteLen, 1);
  const inPtr = exports.wasm_alloc(allocLen);
  if (!inPtr) {
    throw new Error(`wasm_alloc(${allocLen}) returned null pointer (0)`);
  }

  let packed: bigint;
  try {
    // Re-create Uint8Array AFTER wasm_alloc in case memory.grow detached previous ArrayBuffer
    if (byteLen > 0) {
      new Uint8Array(exports.memory.buffer, inPtr >>> 0, byteLen).set(reqBytes);
    }
    const rawRet = exports.wasm_invoke_json(inPtr, byteLen);
    packed = typeof rawRet === 'bigint' ? rawRet : BigInt(rawRet);
  } finally {
    exports.wasm_dealloc(inPtr, allocLen);
  }

  const outPtr = Number((packed >> 32n) & 0xffffffffn);
  const outLen = Number(packed & 0xffffffffn);
  if (!outPtr || outLen === 0) {
    throw new Error(`wasm_invoke_json returned empty slice (packed=${packed.toString()})`);
  }

  try {
    // Re-create Uint8Array AFTER wasm_invoke_json in case memory.grow occurred during op
    const outBytes = new Uint8Array(exports.memory.buffer, outPtr >>> 0, outLen);
    const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(outBytes);
    return JSON.parse(jsonStr) as WasmOpEnvelope<T>;
  } finally {
    exports.wasm_dealloc(outPtr, outLen);
  }
}

export function invokeExtWasm<T = any>(
  exports: ExtWasmExports,
  op: string,
  payload: Record<string, unknown> = {},
): WasmOpEnvelope<T> {
  const reqBytes = new TextEncoder().encode(JSON.stringify({ op, payload }));
  return invokeExtWasmRawBytes<T>(exports, reqBytes);
}

export async function instantiateExtWasmBuffer(wasmBytes: Buffer | Uint8Array): Promise<{
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  exports: ExtWasmExports;
  invoke: <T = any>(op: string, payload?: Record<string, unknown>) => WasmOpEnvelope<T>;
  invokeRaw: <T = any>(rawBytes: Uint8Array) => WasmOpEnvelope<T>;
}> {
  const mod = await WebAssembly.compile(new Uint8Array(wasmBytes));
  let instanceRef: WebAssembly.Instance | undefined;
  const imports = buildDynamicWasmImports(
    mod,
    () => instanceRef?.exports?.memory as WebAssembly.Memory | undefined,
  );
  const instance = await WebAssembly.instantiate(mod, imports);
  instanceRef = instance;
  const exports = instance.exports as unknown as ExtWasmExports;

  return {
    module: mod,
    instance,
    exports,
    invoke: <T = any>(op: string, payload: Record<string, unknown> = {}) =>
      invokeExtWasm<T>(exports, op, payload),
    invokeRaw: <T = any>(rawBytes: Uint8Array) => invokeExtWasmRawBytes<T>(exports, rawBytes),
  };
}

export async function instantiateExtWasmFromFile(wasmFilePath: string) {
  const bytes = fs.readFileSync(wasmFilePath);
  return await instantiateExtWasmBuffer(bytes);
}

const BROWSER_WASM_BOOTSTRAP_SNIPPET = `
  async function __ensureGpuiE2eWasm(relPath) {
    const targetPath = relPath || 'assets/gpui_telegram_ext_wasm.wasm';
    const cacheKey = '__gpuiE2eWasmCache__' + targetPath;
    if (globalThis[cacheKey]) {
      return globalThis[cacheKey];
    }
    const url = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function')
      ? chrome.runtime.getURL(targetPath)
      : targetPath;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error('Failed to fetch WASM module ' + url + ': HTTP ' + resp.status);
    }
    const bytes = await resp.arrayBuffer();
    const mod = await WebAssembly.compile(bytes);
    let instRef = null;
    const imports = {};
    for (const decl of WebAssembly.Module.imports(mod)) {
      if (!imports[decl.module]) imports[decl.module] = {};
      if (decl.kind === 'function') {
        if (/random/i.test(decl.name)) {
          imports[decl.module][decl.name] = (ptr, len) => {
            const mem = instRef && instRef.exports && instRef.exports.memory;
            if (mem && len > 0) {
              crypto.getRandomValues(new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0));
            }
            return 0;
          };
        } else if (/now|time/i.test(decl.name)) {
          imports[decl.module][decl.name] = () => Date.now();
        } else {
          imports[decl.module][decl.name] = () => 0;
        }
      }
    }
    const instance = await WebAssembly.instantiate(mod, imports);
    instRef = instance;
    const entry = { mod, instance, exports: instance.exports };
    globalThis[cacheKey] = entry;
    return entry;
  }

  function __invokeGpuiWasmBytes(exports, reqBytes) {
    if (typeof exports.wasm_alloc !== 'function' ||
        typeof exports.wasm_dealloc !== 'function' ||
        typeof exports.wasm_invoke_json !== 'function' ||
        !exports.memory) {
      throw new Error('Missing canonical C-ABI exports on gpui_telegram_ext_wasm');
    }
    const byteLen = reqBytes.byteLength;
    const allocLen = Math.max(byteLen, 1);
    const inPtr = exports.wasm_alloc(allocLen);
    if (!inPtr) throw new Error('wasm_alloc returned null');
    let packed;
    try {
      if (byteLen > 0) {
        new Uint8Array(exports.memory.buffer, inPtr >>> 0, byteLen).set(reqBytes);
      }
      const rawRet = exports.wasm_invoke_json(inPtr, byteLen);
      packed = typeof rawRet === 'bigint' ? rawRet : BigInt(rawRet);
    } finally {
      exports.wasm_dealloc(inPtr, allocLen);
    }
    const outPtr = Number((packed >> 32n) & 0xffffffffn);
    const outLen = Number(packed & 0xffffffffn);
    if (!outPtr || outLen === 0) {
      throw new Error('wasm_invoke_json returned empty slice: ' + String(packed));
    }
    try {
      const outBytes = new Uint8Array(exports.memory.buffer, outPtr >>> 0, outLen);
      const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(outBytes);
      return JSON.parse(jsonStr);
    } finally {
      exports.wasm_dealloc(outPtr, outLen);
    }
  }
`;

export function buildBrowserWasmEvalScript(
  op: string,
  payload: Record<string, unknown> = {},
  wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm',
): string {
  const serializedReq = JSON.stringify({ op, payload });
  return `(async () => {
    ${BROWSER_WASM_BOOTSTRAP_SNIPPET}
    const { exports } = await __ensureGpuiE2eWasm(${JSON.stringify(wasmRelativePath)});
    const reqBytes = new TextEncoder().encode(${JSON.stringify(serializedReq)});
    return __invokeGpuiWasmBytes(exports, reqBytes);
  })()`;
}

export function buildBrowserWasmRawEvalScript(
  rawBytesOrText: number[] | string,
  wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm',
): string {
  const bytesExpr =
    typeof rawBytesOrText === 'string'
      ? `new TextEncoder().encode(${JSON.stringify(rawBytesOrText)})`
      : `new Uint8Array(${JSON.stringify(rawBytesOrText)})`;
  return `(async () => {
    ${BROWSER_WASM_BOOTSTRAP_SNIPPET}
    const { exports } = await __ensureGpuiE2eWasm(${JSON.stringify(wasmRelativePath)});
    return __invokeGpuiWasmBytes(exports, ${bytesExpr});
  })()`;
}

export function buildBrowserWasmInspectScript(
  wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm',
): string {
  return `(async () => {
    ${BROWSER_WASM_BOOTSTRAP_SNIPPET}
    const { mod, exports } = await __ensureGpuiE2eWasm(${JSON.stringify(wasmRelativePath)});
    return {
      exports: Object.keys(exports),
      exportTypes: Object.fromEntries(Object.entries(exports).map(([k, v]) => [k, typeof v])),
      imports: WebAssembly.Module.imports(mod),
      memoryByteLength: exports.memory ? exports.memory.buffer.byteLength : 0,
    };
  })()`;
}
