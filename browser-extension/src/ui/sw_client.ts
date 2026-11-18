/**
 * UI <-> MV3 Background Service Worker Port & RPC Client (`src/ui/sw_client.ts`).
 */

import { UI_PORT_NAME, type SwToUiEvent } from '../shared/rpc_types';

export async function sendSwRpc<T = Record<string, any>>(
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        void chrome.runtime.lastError;
        resolve((resp ?? { ok: false }) as T);
      });
    } catch {
      resolve({ ok: false } as unknown as T);
    }
  });
}

export function subscribeSwEvents(onEvent: (ev: SwToUiEvent) => void): () => void {
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: number | null = null;
  let disposed = false;

  const connect = () => {
    if (disposed) return;
    try {
      port = chrome.runtime.connect({ name: UI_PORT_NAME });
      port.onMessage.addListener((msg: SwToUiEvent) => {
        if (msg && typeof msg === 'object' && 'type' in msg) {
          onEvent(msg);
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = null;
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 400);
        }
      });
    } catch {
      if (!disposed) {
        reconnectTimer = window.setTimeout(connect, 600);
      }
    }
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
    try {
      port?.disconnect();
    } catch {
      // ignore
    }
  };
}
