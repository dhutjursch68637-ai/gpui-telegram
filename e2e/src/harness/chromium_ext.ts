import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import {
  CHROMIUM_BIN,
  allocateRunEnvironment,
  findFreePort,
  gracefulKillProcess,
  trackChildProcess,
  type RunEnvironment,
} from './env.ts';
import { FatalPollError, pollUntil, sleep } from './assertions.ts';
import {
  buildBrowserWasmEvalScript,
  buildBrowserWasmInspectScript,
  buildBrowserWasmRawEvalScript,
  type WasmOpEnvelope,
} from './wasm_client.ts';

export const CDP_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
}

export interface UncaughtExceptionRecord {
  timestampMs: number;
  sessionId?: string;
  targetType?: string;
  text: string;
  description?: string;
  url?: string;
  lineNumber?: number;
}

export interface ConsoleEntry {
  timestampMs: number;
  type: string;
  text: string;
}

export interface DomElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomElementInfo {
  tag: string;
  text: string;
  value?: string;
  attrs: Record<string, string>;
  visible: boolean;
  disabled: boolean;
  rect: DomElementRect;
}

type CdpEventListener = (params: any, sessionId?: string) => void;

export class CdpClient {
  readonly wsUrl: string;
  private readonly ws: WebSocket;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly wildcardListeners = new Set<
    (method: string, params: any, sessionId?: string) => void
  >();

  private constructor(wsUrl: string, ws: WebSocket) {
    this.wsUrl = wsUrl;
    this.ws = ws;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
        msg = JSON.parse(str);
      } catch {
        return;
      }

      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const codePart = msg.error.code !== undefined ? ` (${msg.error.code})` : '';
          const dataPart = msg.error.data ? `: ${msg.error.data}` : '';
          entry.reject(
            new Error(`CDP ${entry.method} failed${codePart}: ${msg.error.message}${dataPart}`),
          );
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }

      if (typeof msg.method === 'string') {
        const set = this.listeners.get(msg.method);
        if (set) {
          for (const fn of Array.from(set)) {
            try {
              fn(msg.params ?? {}, msg.sessionId);
            } catch {
              // Ignore listener errors
            }
          }
        }
        for (const fn of Array.from(this.wildcardListeners)) {
          try {
            fn(msg.method, msg.params ?? {}, msg.sessionId);
          } catch {
            // Ignore
          }
        }
      }
    });

    const handleCloseOrError = (reason: string): void => {
      if (this.closed) return;
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`CDP socket closed during ${entry.method}: ${reason}`));
      }
      this.pending.clear();
    };

    ws.on('close', (code) => handleCloseOrError(`close code ${code}`));
    ws.on('error', (err) => handleCloseOrError(err.message));
  }

  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl, { maxPayload: CDP_MAX_PAYLOAD_BYTES });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting to CDP WebSocket ${wsUrl}`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new CdpClient(wsUrl, ws);
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 20000,
  ): Promise<T> {
    if (!this.isOpen()) {
      return Promise.reject(new Error(`CDP client is closed (cannot send ${method})`));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  on(event: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  onAny(listener: (method: string, params: any, sessionId?: string) => void): () => void {
    this.wildcardListeners.add(listener);
    return () => {
      this.wildcardListeners.delete(listener);
    };
  }

  once(
    event: string,
    filter?: (params: any, sessionId?: string) => boolean,
    timeoutMs = 15000,
  ): Promise<{ params: any; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event ${event} after ${timeoutMs}ms`));
      }, timeoutMs);

      const off = this.on(event, (params, sessionId) => {
        if (!filter || filter(params, sessionId)) {
          clearTimeout(timer);
          off();
          resolve({ params, sessionId });
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP client closed'));
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
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

function buildEvalExpression(
  expressionOrFn: string | ((...args: any[]) => any),
  args: any[],
): string {
  if (typeof expressionOrFn === 'string') {
    return expressionOrFn;
  }
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(', ');
  return `(${expressionOrFn.toString()})(${serializedArgs})`;
}

export interface PageEvalOptions {
  allowUnsafeEvalBlockedByCSP?: boolean;
  timeoutMs?: number;
}

interface ParsedKeyCombo {
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<
  string,
  { key: string; shiftKey?: string; code: string; vk: number; text?: string }
> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ',': { key: ',', shiftKey: '<', code: 'Comma', vk: 188, text: ',' },
  '.': { key: '.', shiftKey: '>', code: 'Period', vk: 190, text: '.' },
  '/': { key: '/', shiftKey: '?', code: 'Slash', vk: 191, text: '/' },
  '[': { key: '[', shiftKey: '{', code: 'BracketLeft', vk: 219, text: '[' },
  ']': { key: ']', shiftKey: '}', code: 'BracketRight', vk: 221, text: ']' },
  ';': { key: ';', shiftKey: ':', code: 'Semicolon', vk: 186, text: ';' },
  '\\': { key: '\\', shiftKey: '|', code: 'Backslash', vk: 220, text: '\\' },
  "'": { key: "'", shiftKey: '"', code: 'Quote', vk: 222, text: "'" },
  '`': { key: '`', shiftKey: '~', code: 'Backquote', vk: 192, text: '`' },
  '-': { key: '-', shiftKey: '_', code: 'Minus', vk: 189, text: '-' },
  '=': { key: '=', shiftKey: '+', code: 'Equal', vk: 187, text: '=' },
};

function parseKeyCombo(combo: string): ParsedKeyCombo {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  const mainKey = parts[parts.length - 1] ?? combo;

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === 'alt' || mod === 'option') modifiers |= 1;
    else if (mod === 'ctrl' || mod === 'control') modifiers |= 2;
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command') modifiers |= 4;
    else if (mod === 'shift') modifiers |= 8;
  }

  const lower = mainKey.toLowerCase();
  const named = NAMED_KEYS[lower] ?? NAMED_KEYS[mainKey];
  if (named) {
    const hasNonShiftMod = (modifiers & ~8) !== 0;
    const isShifted = (modifiers & 8) !== 0;
    const keyOut = isShifted && named.shiftKey ? named.shiftKey : named.key;
    const textOut = !hasNonShiftMod
      ? isShifted && named.shiftKey
        ? named.shiftKey
        : named.text
      : undefined;
    return {
      modifiers,
      key: keyOut,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      ...(textOut ? { text: textOut } : {}),
    };
  }

  if (mainKey.length === 1) {
    const upper = mainKey.toUpperCase();
    const isAlpha = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(mainKey);
    const keyOut = modifiers & 8 && isAlpha ? upper : mainKey;
    const code = isAlpha ? `Key${upper}` : isDigit ? `Digit${mainKey}` : mainKey;
    const vk = upper.charCodeAt(0);
    return {
      modifiers,
      key: keyOut,
      code,
      windowsVirtualKeyCode: vk,
      ...(modifiers === 0 || modifiers === 8 ? { text: keyOut } : {}),
    };
  }

  return {
    modifiers,
    key: mainKey,
    code: mainKey,
    windowsVirtualKeyCode: 0,
  };
}

export class CdpPageHandle {
  readonly targetId: string;
  readonly sessionId: string;
  readonly cdp: CdpClient;
  readonly consoleMessages: ConsoleEntry[] = [];
  readonly pageExceptions: UncaughtExceptionRecord[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private isClosed = false;

  constructor(
    cdp: CdpClient,
    targetId: string,
    sessionId: string,
    globalExceptionSink?: UncaughtExceptionRecord[],
  ) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;

    this.unsubscribers.push(
      cdp.on('Runtime.consoleAPICalled', (params, sid) => {
        if (sid !== this.sessionId) return;
        const text = Array.isArray(params.args)
          ? params.args
              .map((a: any) => (a.value !== undefined ? String(a.value) : a.description ?? ''))
              .join(' ')
          : '';
        this.consoleMessages.push({
          timestampMs: Date.now(),
          type: String(params.type ?? 'log'),
          text,
        });
      }),
      cdp.on('Runtime.exceptionThrown', (params, sid) => {
        if (sid !== this.sessionId) return;
        const details = params.exceptionDetails ?? {};
        const rec: UncaughtExceptionRecord = {
          timestampMs: Date.now(),
          sessionId: sid,
          targetType: 'page',
          text: String(details.text ?? 'Uncaught exception'),
          description: details.exception?.description,
          url: details.url,
          lineNumber: details.lineNumber,
        };
        this.pageExceptions.push(rec);
        globalExceptionSink?.push(rec);
      }),
    );
  }

  async goto(
    url: string,
    opts: { waitUntil?: 'load' | 'domcontentloaded' | 'none'; timeoutMs?: number } = {},
  ): Promise<void> {
    const waitUntil = opts.waitUntil ?? 'load';
    const timeoutMs = opts.timeoutMs ?? 15000;

    const waitEvent =
      waitUntil === 'load'
        ? this.cdp.once('Page.loadEventFired', (_, sid) => sid === this.sessionId, timeoutMs)
        : waitUntil === 'domcontentloaded'
          ? this.cdp.once(
              'Page.domContentEventFired',
              (_, sid) => sid === this.sessionId,
              timeoutMs,
            )
          : null;

    const navResult = await this.cdp.send<{ errorText?: string }>(
      'Page.navigate',
      { url },
      this.sessionId,
      timeoutMs,
    );
    if (navResult.errorText && !url.startsWith('chrome://')) {
      throw new Error(`Page.navigate(${url}) failed: ${navResult.errorText}`);
    }
    if (waitEvent && !url.startsWith('chrome://')) {
      await Promise.race([
        waitEvent.catch(() => undefined),
        pollUntil(
          async () => {
            const state = await this.eval<string>('document.readyState').catch(() => 'loading');
            return waitUntil === 'domcontentloaded'
              ? state === 'interactive' || state === 'complete'
              : state === 'complete';
          },
          { timeoutMs, intervalMs: 50, message: `readyState for ${url}` },
        ),
      ]);
    }
  }

  async reload(bypassCache = false, timeoutMs = 15000): Promise<void> {
    await this.cdp.send(
      'Page.reload',
      { ignoreCache: bypassCache },
      this.sessionId,
      timeoutMs,
    );
    await pollUntil(
      async () => (await this.eval<string>('document.readyState').catch(() => '')) === 'complete',
      { timeoutMs, intervalMs: 50, message: 'Page.reload complete' },
    );
  }

  async url(): Promise<string> {
    return await this.eval<string>('window.location.href');
  }

  async title(): Promise<string> {
    return await this.eval<string>('document.title');
  }

  async evalWithOptions<T = any>(
    opts: PageEvalOptions,
    expressionOrFn: string | ((...args: any[]) => T | Promise<T>),
    ...args: any[]
  ): Promise<T> {
    const expression = buildEvalExpression(expressionOrFn, args);
    const res = await this.cdp.send<{
      result?: { type: string; subtype?: string; value?: any; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: any } };
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(opts.allowUnsafeEvalBlockedByCSP !== undefined
          ? { allowUnsafeEvalBlockedByCSP: opts.allowUnsafeEvalBlockedByCSP }
          : {}),
      },
      this.sessionId,
      opts.timeoutMs ?? 20000,
    );

    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.exception?.value ??
        res.exceptionDetails.text ??
        'Evaluation threw exception';
      throw new Error(`Page eval error: ${String(desc)}`);
    }
    return res.result?.value as T;
  }

  async evalWithCsp<T = any>(
    expressionOrFn: string | ((...args: any[]) => T | Promise<T>),
    ...args: any[]
  ): Promise<T> {
    return await this.evalWithOptions(
      { allowUnsafeEvalBlockedByCSP: false },
      expressionOrFn,
      ...args,
    );
  }

  async eval<T = any>(
    expressionOrFn: string | ((...args: any[]) => T | Promise<T>),
    ...args: any[]
  ): Promise<T> {
    if (
      args.length === 1 &&
      typeof args[0] === 'object' &&
      args[0] !== null &&
      'allowUnsafeEvalBlockedByCSP' in args[0] &&
      (typeof expressionOrFn === 'string' || expressionOrFn.length === 0)
    ) {
      return await this.evalWithOptions(args[0] as PageEvalOptions, expressionOrFn);
    }
    return await this.evalWithOptions({}, expressionOrFn, ...args);
  }

  async querySelector(selector: string): Promise<DomElementInfo | null> {
    return await this.eval(
      (sel: string): DomElementInfo | null => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          r.width > 0 &&
          r.height > 0;
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) {
          attrs[a.name] = a.value;
        }
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim(),
          value: 'value' in el ? String((el as HTMLInputElement).value ?? '') : undefined,
          attrs,
          visible,
          disabled: Boolean((el as HTMLButtonElement).disabled),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      },
      selector,
    );
  }

  async querySelectorAll(selector: string): Promise<DomElementInfo[]> {
    return await this.eval(
      (sel: string): DomElementInfo[] => {
        return Array.from(document.querySelectorAll(sel)).map((node) => {
          const el = node as HTMLElement;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0 &&
            r.width > 0 &&
            r.height > 0;
          const attrs: Record<string, string> = {};
          for (const a of Array.from(el.attributes)) {
            attrs[a.name] = a.value;
          }
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim(),
            value: 'value' in el ? String((el as HTMLInputElement).value ?? '') : undefined,
            attrs,
            visible,
            disabled: Boolean((el as HTMLButtonElement).disabled),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        });
      },
      selector,
    );
  }

  async waitForSelector(
    selector: string,
    opts: { state?: 'visible' | 'attached' | 'hidden'; timeoutMs?: number } = {},
  ): Promise<DomElementInfo | null> {
    const state = opts.state ?? 'visible';
    const timeoutMs = opts.timeoutMs ?? 10000;

    return await pollUntil(
      async () => await this.querySelector(selector),
      {
        timeoutMs,
        intervalMs: 60,
        message: `waitForSelector(${selector}, state=${state})`,
        isDone: (info) => {
          if (state === 'attached') return info !== null;
          if (state === 'hidden') return info === null || !info.visible;
          return info !== null && info.visible;
        },
      },
    );
  }

  async waitForTestId(
    testId: string,
    opts: { state?: 'visible' | 'attached' | 'hidden'; timeoutMs?: number } = {},
  ): Promise<DomElementInfo | null> {
    return await this.waitForSelector(`[data-testid="${testId}"]`, opts);
  }

  async waitForText(
    text: string,
    opts: { selector?: string; timeoutMs?: number } = {},
  ): Promise<void> {
    const selector = opts.selector ?? 'body';
    await pollUntil(
      async () => {
        const content = await this.eval(
          (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el ? el.innerText || el.textContent || '' : '';
          },
          selector,
        );
        return content.includes(text);
      },
      {
        timeoutMs: opts.timeoutMs ?? 10000,
        intervalMs: 75,
        message: `waitForText(${JSON.stringify(text)} in ${selector})`,
      },
    );
  }

  private async scrollIntoViewAndGetCenter(
    selector: string,
    timeoutMs = 10000,
  ): Promise<{ x: number; y: number }> {
    await this.waitForSelector(selector, { state: 'visible', timeoutMs });
    const pt = await this.eval(
      (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      },
      selector,
    );
    if (!pt) {
      throw new Error(`Element disappeared before coordinate resolution: ${selector}`);
    }
    return pt;
  }

  async click(
    selector: string,
    opts: { button?: 'left' | 'right'; clickCount?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;
    const { x, y } = await this.scrollIntoViewAndGetCenter(selector, opts.timeoutMs);

    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none' },
      this.sessionId,
    );
    for (let i = 1; i <= clickCount; i++) {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button, clickCount: i },
        this.sessionId,
      );
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button, clickCount: i },
        this.sessionId,
      );
    }
  }

  async clickTestId(
    testId: string,
    opts: { button?: 'left' | 'right'; clickCount?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    await this.click(`[data-testid="${testId}"]`, opts);
  }

  async hover(selector: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const { x, y } = await this.scrollIntoViewAndGetCenter(selector, opts.timeoutMs);
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none' },
      this.sessionId,
    );
  }

  async type(
    selector: string,
    text: string,
    opts: { clearFirst?: boolean; submit?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    await this.click(selector, { timeoutMs: opts.timeoutMs });

    if (opts.clearFirst !== false) {
      const hadContent = await this.eval((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
        if (!el) return false;
        el.focus();
        if ('select' in el && typeof el.select === 'function') {
          const len = String(el.value ?? '').length;
          if (len > 0) {
            el.select();
            return true;
          }
          return false;
        }
        if (el.isContentEditable) {
          const len = (el.textContent ?? '').length;
          if (len > 0) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selObj = window.getSelection();
            selObj?.removeAllRanges();
            selObj?.addRange(range);
            return true;
          }
        }
        return false;
      }, selector);

      if (hadContent) {
        await this.pressKey('Backspace');
      }
    }

    if (text.length > 0) {
      await this.cdp.send('Input.insertText', { text }, this.sessionId);
    }

    if (opts.submit) {
      await this.pressKey('Enter');
    }
  }

  async typeTestId(
    testId: string,
    text: string,
    opts: { clearFirst?: boolean; submit?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    await this.type(`[data-testid="${testId}"]`, text, opts);
  }

  async selectOption(selector: string, value: string, timeoutMs = 10000): Promise<void> {
    await this.waitForSelector(selector, { state: 'attached', timeoutMs });
    const ok = await this.eval(
      (sel: string, val: string) => {
        const selectEl = document.querySelector(sel) as HTMLSelectElement | null;
        if (!selectEl) return false;
        const protoSetter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )?.set;
        if (protoSetter) {
          protoSetter.call(selectEl, val);
        } else {
          selectEl.value = val;
        }
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return selectEl.value === val;
      },
      selector,
      value,
    );
    if (!ok) {
      throw new Error(`selectOption(${selector}, ${value}) failed to match option value`);
    }
  }

  async pressKey(keyCombo: string): Promise<void> {
    const parsed = parseKeyCombo(keyCombo);
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: parsed.text ? 'keyDown' : 'rawKeyDown',
        modifiers: parsed.modifiers,
        key: parsed.key,
        code: parsed.code,
        windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
        nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
        ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
      },
      this.sessionId,
    );
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        modifiers: parsed.modifiers,
        key: parsed.key,
        code: parsed.code,
        windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
        nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
      },
      this.sessionId,
    );
  }

  async setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<void> {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile: viewport.mobile ?? false,
      },
      this.sessionId,
    );
  }

  async getComputedStyle(selector: string): Promise<Record<string, string>>;
  async getComputedStyle(selector: string, property: string): Promise<string>;
  async getComputedStyle(
    selector: string,
    property?: string,
  ): Promise<Record<string, string> | string> {
    return await this.eval(
      (sel: string, prop?: string) => {
        const el = document.querySelector(sel);
        if (!el) {
          throw new Error(`getComputedStyle: element not found (${sel})`);
        }
        const cs = window.getComputedStyle(el);
        if (prop) {
          return cs.getPropertyValue(prop) || (cs as any)[prop] || '';
        }
        const out: Record<string, string> = {};
        for (const name of [
          'display',
          'visibility',
          'opacity',
          'width',
          'height',
          'color',
          'backgroundColor',
          'borderColor',
          'fontSize',
          'borderRadius',
          'overflowX',
          'overflowY',
        ]) {
          out[name] = (cs as any)[name] ?? '';
        }
        return out;
      },
      selector,
      property,
    );
  }

  async captureScreenshot(
    opts: { format?: 'png' | 'jpeg'; fullPage?: boolean; clipSelector?: string } = {},
  ): Promise<Buffer> {
    const format = opts.format ?? 'png';
    let clip: Record<string, unknown> | undefined;

    if (opts.clipSelector) {
      const info = await this.waitForSelector(opts.clipSelector, { state: 'visible' });
      if (info) {
        clip = {
          x: Math.max(0, info.rect.x),
          y: Math.max(0, info.rect.y),
          width: Math.max(1, info.rect.width),
          height: Math.max(1, info.rect.height),
          scale: 1,
        };
      }
    } else if (opts.fullPage) {
      const metrics = await this.cdp.send<{
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      }>('Page.getLayoutMetrics', {}, this.sessionId);
      const sz = metrics.cssContentSize ?? metrics.contentSize;
      if (sz && sz.width > 0 && sz.height > 0) {
        clip = {
          x: 0,
          y: 0,
          width: Math.ceil(sz.width),
          height: Math.min(Math.ceil(sz.height), 16384),
          scale: 1,
        };
      }
    }

    const shot = await this.cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      {
        format,
        fromSurface: true,
        ...(opts.fullPage ? { captureBeyondViewport: true } : {}),
        ...(clip ? { clip } : {}),
      },
      this.sessionId,
    );
    return Buffer.from(shot.data, 'base64');
  }

  async invokeWasm<T = any>(
    op: string,
    payload: Record<string, unknown> = {},
    wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm',
  ): Promise<WasmOpEnvelope<T>> {
    const script = buildBrowserWasmEvalScript(op, payload, wasmRelativePath);
    return await this.evalWithCsp<WasmOpEnvelope<T>>(script);
  }

  async invokeWasmRaw<T = any>(
    rawBytesOrText: number[] | string,
    wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm',
  ): Promise<WasmOpEnvelope<T>> {
    const script = buildBrowserWasmRawEvalScript(rawBytesOrText, wasmRelativePath);
    return await this.evalWithCsp<WasmOpEnvelope<T>>(script);
  }

  async inspectWasm(wasmRelativePath = 'assets/gpui_telegram_ext_wasm.wasm'): Promise<{
    exports: string[];
    exportTypes: Record<string, string>;
    imports: Array<{ module: string; name: string; kind: string }>;
    memoryByteLength: number;
  }> {
    const script = buildBrowserWasmInspectScript(wasmRelativePath);
    return await this.evalWithCsp(script);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const off of this.unsubscribers) {
      off();
    }
    this.unsubscribers.length = 0;
    try {
      await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      // Target may already be closed
    }
  }
}

export type ExtensionSurfaceName = 'workspace' | 'sidepanel' | 'popup' | 'options';

const DEFAULT_SURFACE_VIEWPORTS: Record<
  ExtensionSurfaceName,
  { width: number; height: number }
> = {
  workspace: { width: 1440, height: 900 },
  sidepanel: { width: 420, height: 820 },
  popup: { width: 380, height: 560 },
  options: { width: 1024, height: 768 },
};

export interface ChromiumSpawnOptions {
  runEnv?: RunEnvironment;
  cdpPort?: number;
  loadExtension?: boolean;
  extDistDir?: string;
  profileDir?: string;
  downloadsDir?: string;
  extraArgs?: string[];
  startupTimeoutMs?: number;
}

export interface ChromiumExtensionHandle {
  readonly cdpPort: number;
  readonly cdpHttpUrl: string;
  readonly wsDebuggerUrl: string;
  readonly cdp: CdpClient;
  readonly process: ChildProcess;
  readonly pid: number | undefined;
  readonly profileDir: string;
  readonly downloadsDir: string;
  readonly extensionLoaded: boolean;
  readonly extensionId: string;
  readonly anchorTargetId: string;
  readonly uncaughtExceptions: UncaughtExceptionRecord[];
  swTargetId: string;
  swSessionId: string;
  isRunning(): boolean;
  getLogs(): string;
  clearUncaughtExceptions(): void;
  listTargets(): Promise<CdpTargetInfo[]>;
  openPage(
    url: string,
    viewport?: { width: number; height: number },
  ): Promise<CdpPageHandle>;
  openExtensionSurface(
    surface: ExtensionSurfaceName,
    opts?: { query?: string; hash?: string; viewport?: { width: number; height: number } },
  ): Promise<CdpPageHandle>;
  evalInServiceWorker<T = any>(
    expressionOrFn: string | ((...args: any[]) => T | Promise<T>),
    ...args: any[]
  ): Promise<T>;
  stopServiceWorkerForColdWake(): Promise<void>;
  wakeServiceWorker(timeoutMs?: number): Promise<{ targetId: string; sessionId: string }>;
  closeExtraTabs(): Promise<void>;
  stop(): Promise<void>;
}

export async function spawnChromiumWithExtension(
  opts: ChromiumSpawnOptions = {},
): Promise<ChromiumExtensionHandle> {
  const ownedEnv = opts.runEnv ? null : allocateRunEnvironment('chromium');
  const runEnv = opts.runEnv ?? ownedEnv!;
  const cdpPort = opts.cdpPort ?? (await findFreePort('127.0.0.1'));
  const loadExtension = opts.loadExtension !== false;
  const extDistDir = opts.extDistDir;
  if (loadExtension && !extDistDir) {
    throw new Error('spawnChromiumWithExtension requires extDistDir when loadExtension !== false');
  }

  const profileDir =
    opts.profileDir ?? path.join(runEnv.shmDir, `p-${cdpPort}`);
  const downloadsDir = opts.downloadsDir ?? runEnv.downloadsDir;
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });

  const args: string[] = [
    '--headless=new',
    '--no-sandbox',
    '--no-zygote',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profileDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    ...(loadExtension && extDistDir
      ? [
          `--disable-extensions-except=${extDistDir}`,
          `--load-extension=${extDistDir}`,
        ]
      : []),
    ...(opts.extraArgs ?? []),
    `--remote-debugging-port=${cdpPort}`,
    'about:blank',
  ];

  const logChunks: string[] = [];
  const pushLog = (chunk: Buffer | string): void => {
    logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    if (logChunks.length > 200) logChunks.shift();
  };

  // Pass compact shmTmpDir (/dev/shm/gpui-e2e-<id>/t) so Chromium SingletonSocket stays < 80 bytes
  const child = spawn(CHROMIUM_BIN, args, {
    cwd: runEnv.serverCwd,
    env: runEnv.buildChildEnv({
      TMPDIR: runEnv.shmTmpDir,
      TMP: runEnv.shmTmpDir,
      TEMP: runEnv.shmTmpDir,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  trackChildProcess(child);
  child.stdout?.on('data', pushLog);
  child.stderr?.on('data', pushLog);

  const startupTimeoutMs = opts.startupTimeoutMs ?? 15000;
  const cdpHttpUrl = `http://127.0.0.1:${cdpPort}`;

  let versionInfo: { webSocketDebuggerUrl: string };
  try {
    versionInfo = await pollUntil(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new FatalPollError(
            `Chromium exited prematurely (code=${child.exitCode}, signal=${child.signalCode}):\n${logChunks.join('')}`,
          );
        }
        const resp = await fetch(`${cdpHttpUrl}/json/version`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = (await resp.json()) as { webSocketDebuggerUrl?: string };
        if (!json.webSocketDebuggerUrl) throw new Error('Missing webSocketDebuggerUrl');
        return { webSocketDebuggerUrl: json.webSocketDebuggerUrl };
      },
      {
        timeoutMs: startupTimeoutMs,
        intervalMs: 100,
        message: `Chromium 156 CDP /json/version on port ${cdpPort}`,
      },
    );
  } catch (err) {
    await gracefulKillProcess(child);
    if (ownedEnv) await ownedEnv.cleanup();
    throw err;
  }

  const cdp = await CdpClient.connect(versionInfo.webSocketDebuggerUrl, startupTimeoutMs);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp
    .send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadsDir,
      eventsEnabled: true,
    })
    .catch(() => undefined);

  const uncaughtExceptions: UncaughtExceptionRecord[] = [];

  // Identify initial about:blank anchor page target so closing test tabs never exits Chromium
  const initialTargetsResp = await cdp.send<{ targetInfos: CdpTargetInfo[] }>('Target.getTargets');
  let anchorTarget = initialTargetsResp.targetInfos.find(
    (t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''),
  );
  if (!anchorTarget) {
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    anchorTarget = {
      targetId: created.targetId,
      type: 'page',
      title: 'about:blank',
      url: 'about:blank',
    };
  }
  const anchorTargetId = anchorTarget.targetId;

  let extensionId = '';
  let swTargetId = '';
  let swSessionId = '';

  const attachServiceWorker = async (timeoutMs = 12000): Promise<{
    extensionId: string;
    targetId: string;
    sessionId: string;
  }> => {
    const swTarget = await pollUntil(
      async () => {
        const { targetInfos } = await cdp.send<{ targetInfos: CdpTargetInfo[] }>(
          'Target.getTargets',
        );
        return (
          targetInfos.find(
            (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
          ) ?? null
        );
      },
      {
        timeoutMs,
        intervalMs: 100,
        message: 'MV3 Extension service_worker target discovery',
      },
    );
    if (!swTarget) {
      throw new Error(
        `MV3 Extension service_worker target not found.\nChromium logs:\n${logChunks.join('')}`,
      );
    }
    const extId = new URL(swTarget.url).hostname;
    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: swTarget.targetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, attached.sessionId);
    extensionId = extId;
    swTargetId = swTarget.targetId;
    swSessionId = attached.sessionId;
    return {
      extensionId: extId,
      targetId: swTarget.targetId,
      sessionId: attached.sessionId,
    };
  };

  cdp.on('Runtime.exceptionThrown', (params, sid) => {
    if (!swSessionId || sid !== swSessionId) return;
    const details = params.exceptionDetails ?? {};
    uncaughtExceptions.push({
      timestampMs: Date.now(),
      sessionId: sid,
      targetType: 'service_worker',
      text: String(details.text ?? 'SW Uncaught exception'),
      description: details.exception?.description,
      url: details.url,
      lineNumber: details.lineNumber,
    });
  });

  cdp.on('Target.detachedFromTarget', (params) => {
    if (params.sessionId === swSessionId) {
      swSessionId = '';
    }
  });

  if (loadExtension) {
    try {
      await attachServiceWorker(startupTimeoutMs);
    } catch (err) {
      await cdp.close();
      await gracefulKillProcess(child);
      if (ownedEnv) await ownedEnv.cleanup();
      throw err;
    }
  }

  const openPage = async (
    url: string,
    viewport: { width: number; height: number } = { width: 1280, height: 800 },
  ): Promise<CdpPageHandle> => {
    const startUrl = url || 'about:blank';
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await Promise.all([
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('DOM.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
    ]);

    const page = new CdpPageHandle(cdp, targetId, sessionId, uncaughtExceptions);
    await page.setViewport(viewport);
    if (startUrl !== 'about:blank') {
      await page.goto(startUrl, { waitUntil: 'load' });
    }
    return page;
  };

  const openExtensionSurface = async (
    surface: ExtensionSurfaceName,
    surfaceOpts: {
      query?: string;
      hash?: string;
      viewport?: { width: number; height: number };
    } = {},
  ): Promise<CdpPageHandle> => {
    if (!extensionId) {
      throw new Error('Cannot open extension surface when loadExtension === false');
    }
    const q = surfaceOpts.query
      ? surfaceOpts.query.startsWith('?')
        ? surfaceOpts.query
        : `?${surfaceOpts.query}`
      : '';
    const h = surfaceOpts.hash
      ? surfaceOpts.hash.startsWith('#')
        ? surfaceOpts.hash
        : `#${surfaceOpts.hash}`
      : '';
    const url = `chrome-extension://${extensionId}/${surface}.html${q}${h}`;
    const vp = surfaceOpts.viewport ?? DEFAULT_SURFACE_VIEWPORTS[surface];
    return await openPage(url, vp);
  };

  const handle: ChromiumExtensionHandle = {
    cdpPort,
    cdpHttpUrl,
    wsDebuggerUrl: versionInfo.webSocketDebuggerUrl,
    cdp,
    process: child,
    pid: child.pid,
    profileDir,
    downloadsDir,
    extensionLoaded: loadExtension,
    get extensionId() {
      return extensionId;
    },
    anchorTargetId,
    uncaughtExceptions,
    get swTargetId() {
      return swTargetId;
    },
    set swTargetId(v: string) {
      swTargetId = v;
    },
    get swSessionId() {
      return swSessionId;
    },
    set swSessionId(v: string) {
      swSessionId = v;
    },
    isRunning(): boolean {
      return child.exitCode === null && child.signalCode === null && cdp.isOpen();
    },
    getLogs(): string {
      return logChunks.join('');
    },
    clearUncaughtExceptions(): void {
      uncaughtExceptions.length = 0;
    },
    async listTargets(): Promise<CdpTargetInfo[]> {
      const { targetInfos } = await cdp.send<{ targetInfos: CdpTargetInfo[] }>(
        'Target.getTargets',
      );
      return targetInfos;
    },
    openPage,
    openExtensionSurface,
    async evalInServiceWorker<T = any>(
      expressionOrFn: string | ((...args: any[]) => T | Promise<T>),
      ...args: any[]
    ): Promise<T> {
      if (!loadExtension) {
        throw new Error('Extension not loaded in this Chromium instance');
      }
      if (!swSessionId) {
        await handle.wakeServiceWorker(10000);
      }
      const expression = buildEvalExpression(expressionOrFn, args);
      let res: any;
      try {
        res = await cdp.send(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
          swSessionId,
        );
      } catch (err) {
        // SW may have gone idle; wake and retry once
        await handle.wakeServiceWorker(10000);
        res = await cdp.send(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
          swSessionId,
        );
      }
      if (res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ??
          res.exceptionDetails.exception?.value ??
          res.exceptionDetails.text ??
          'SW evaluation threw exception';
        throw new Error(`SW eval error: ${String(desc)}`);
      }
      return res.result?.value as T;
    },
    async stopServiceWorkerForColdWake(): Promise<void> {
      if (!loadExtension) return;
      // Attach briefly to anchor target or browser session to invoke ServiceWorker.stopAllWorkers
      const { sessionId: pageSession } = await cdp.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: anchorTargetId, flatten: true },
      );
      try {
        await cdp.send('ServiceWorker.enable', {}, pageSession).catch(() => undefined);
        await cdp.send('ServiceWorker.stopAllWorkers', {}, pageSession).catch(async () => {
          await cdp.send('ServiceWorker.enable').catch(() => undefined);
          await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
        });
      } finally {
        await cdp
          .send('Target.detachFromTarget', { sessionId: pageSession })
          .catch(() => undefined);
      }
      if (swTargetId) {
        await cdp.send('Target.closeTarget', { targetId: swTargetId }).catch(() => undefined);
      }
      swSessionId = '';
      swTargetId = '';
      await sleep(150);
    },
    async wakeServiceWorker(timeoutMs = 10000): Promise<{ targetId: string; sessionId: string }> {
      if (!loadExtension) {
        throw new Error('Cannot wake service worker when extension is not loaded');
      }
      try {
        const attached = await attachServiceWorker(1500);
        return { targetId: attached.targetId, sessionId: attached.sessionId };
      } catch {
        // Open a transient extension page and send a runtime wake message to trigger MV3 SW cold-wake
        const wakeUrl = `chrome-extension://${extensionId}/popup.html`;
        const { targetId: tempId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
          url: wakeUrl,
        });
        let wakePageSession = '';
        try {
          const attachedPage = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: tempId,
            flatten: true,
          });
          wakePageSession = attachedPage.sessionId;
          await cdp.send('Runtime.enable', {}, wakePageSession).catch(() => undefined);

          await pollUntil(
            async () => {
              const evalRes = await cdp
                .send<{ result?: { value?: boolean } }>(
                  'Runtime.evaluate',
                  {
                    expression: `(() => {
                      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
                        try {
                          const p = chrome.runtime.sendMessage({ type: '__gpui_e2e_wake' });
                          if (p && typeof p.catch === 'function') p.catch(() => {});
                        } catch {}
                        return true;
                      }
                      return false;
                    })()`,
                    returnByValue: true,
                    awaitPromise: false,
                  },
                  wakePageSession,
                  2000,
                )
                .catch(() => null);
              return Boolean(evalRes?.result?.value);
            },
            {
              timeoutMs: Math.min(3000, Math.max(1000, Math.floor(timeoutMs / 2))),
              intervalMs: 60,
              message: 'Dispatch __gpui_e2e_wake via chrome.runtime.sendMessage in popup.html',
            },
          ).catch(() => false);

          const attached = await attachServiceWorker(timeoutMs);
          return { targetId: attached.targetId, sessionId: attached.sessionId };
        } finally {
          if (wakePageSession) {
            await cdp
              .send('Target.detachFromTarget', { sessionId: wakePageSession })
              .catch(() => undefined);
          }
          await cdp.send('Target.closeTarget', { targetId: tempId }).catch(() => undefined);
        }
      }
    },
    async closeExtraTabs(): Promise<void> {
      const { targetInfos } = await cdp.send<{ targetInfos: CdpTargetInfo[] }>(
        'Target.getTargets',
      );
      for (const t of targetInfos) {
        if (t.type === 'page' && t.targetId !== anchorTargetId) {
          await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
        }
      }
    },
    async stop(): Promise<void> {
      await cdp.close().catch(() => undefined);
      await gracefulKillProcess(child);
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      if (ownedEnv) {
        await ownedEnv.cleanup();
      }
    },
  };

  return handle;
}
