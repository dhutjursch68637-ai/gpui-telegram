/**
 * Dual Outbound JSON-RPC 2.0 WebSocket Bridge Clients:
 * 1. Server Browser Relay: `ws://<server>/api/v1/browser/ws?token=<jwt>&client=extension`
 * 2. Desktop Loopback Bridge: `ws://127.0.0.1:<port>/ext/ws?token=<pairing_token>`
 */

import {
  BRIDGE_ERROR_CODES,
  BrowserRpcError,
  type BrowserTabDto,
} from '../shared/rpc_types';
import { readNormalizedStorageConfig } from './db';
import type { BrowserController } from './browser_controller';
import type { BrowserPolicyEngine } from './policy_engine';

const CAPABILITIES = [
  'tabs',
  'tabGroups',
  'scripting',
  'debugger',
  'screenshots',
  'cookies',
  'downloads',
];

class SingleOutboundBridgeClient {
  public readonly label: 'server' | 'desktop';
  private ws: WebSocket | null = null;
  private targetUrl = '';
  private pairingToken = '';
  private deviceId = 'chrome-ext-mv3-device';
  private handshakeAccepted = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;

  private readonly controller: BrowserController;
  private readonly policy: BrowserPolicyEngine;
  private readonly onStateChange: () => void;

  constructor(
    label: 'server' | 'desktop',
    controller: BrowserController,
    policy: BrowserPolicyEngine,
    onStateChange: () => void,
  ) {
    this.label = label;
    this.controller = controller;
    this.policy = policy;
    this.onStateChange = onStateChange;
  }

  public isConnected(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.handshakeAccepted
    );
  }

  public getTargetUrl(): string {
    return this.targetUrl;
  }

  public configure(params: {
    wsUrl: string;
    enabled: boolean;
    pairingToken?: string;
    deviceId?: string;
    forceReconnect?: boolean;
  }): void {
    const nextUrl = params.wsUrl.trim();
    const nextEnabled = params.enabled && nextUrl.length > 0;
    this.pairingToken = params.pairingToken ?? '';
    this.deviceId = params.deviceId || 'chrome-ext-mv3-device';

    if (!nextEnabled) {
      this.enabled = false;
      this.targetUrl = '';
      this.disconnect();
      return;
    }

    const urlChanged = this.targetUrl !== nextUrl;
    this.enabled = true;
    this.targetUrl = nextUrl;

    if (
      params.forceReconnect ||
      urlChanged ||
      !this.ws ||
      (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)
    ) {
      this.reconnectAttempt = 0;
      this.connectNow();
    }
  }

  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const wasAccepted = this.handshakeAccepted;
    this.handshakeAccepted = false;
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close(1000, 'bridge_disconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (wasAccepted) {
      this.onStateChange();
    }
  }

  private connectNow(): void {
    this.disconnect();
    if (!this.enabled || !this.targetUrl) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.targetUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = async () => {
      if (this.ws !== socket) return;

      const tabs = await this.controller.listTabsSummary().catch(() => [] as BrowserTabDto[]);
      const helloFrame = {
        jsonrpc: '2.0',
        method: 'bridge.hello',
        params: {
          protocol_version: 1,
          extension_id: chrome.runtime.id,
          extension_version: chrome.runtime.getManifest().version || '0.1.0',
          device_id: this.deviceId,
          pairing_token: this.pairingToken || undefined,
          user_agent: navigator.userAgent,
          capabilities: CAPABILITIES,
          run_policy: this.policy.getRunPolicy(),
          tabs_summary: tabs,
        },
      };

      if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(helloFrame));
      }

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'bridge.ping',
              params: { ts: Date.now() },
            }),
          );
        }
      }, 20_000);
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        void this.handleMessage(socket, ev.data);
      }
    };

    socket.onerror = () => {
      // Handled in onclose
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      const wasAccepted = this.handshakeAccepted;
      this.handshakeAccepted = false;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (wasAccepted) {
        this.onStateChange();
      }
      if (this.enabled && this.targetUrl) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.enabled || !this.targetUrl) return;
    // Bounded exponential backoff: 950ms -> 1900ms -> 3800ms -> 7600ms -> 15000ms
    const delayMs = Math.min(950 * Math.pow(2, this.reconnectAttempt), 15_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && this.targetUrl) {
        this.connectNow();
      }
    }, delayMs);
  }

  public sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch {
        // ignore closed race
      }
    }
  }

  public pushTabsSync(tabs: BrowserTabDto[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeAccepted) {
      return;
    }
    this.sendJson({
      jsonrpc: '2.0',
      method: 'bridge.tabs_sync',
      params: {
        tabs,
        run_policy: this.policy.getRunPolicy(),
      },
    });
  }

  private async handleMessage(socket: WebSocket, rawText: string): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(rawText) as Record<string, any>;
    } catch {
      return;
    }

    // Reject handshake if server/bridge replies with JSON-RPC error frame
    if (msg.error && !msg.method) {
      this.handshakeAccepted = false;
      this.onStateChange();
      return;
    }

    const method = String(msg.method ?? '');
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<
      string,
      any
    >;

    if (method === 'bridge.hello_ack') {
      if (params.accepted === false) {
        this.handshakeAccepted = false;
        this.onStateChange();
        socket.close(4003, 'bridge_hello_rejected');
        return;
      }
      this.reconnectAttempt = 0;
      this.handshakeAccepted = true;
      this.onStateChange();

      // Immediately push current tab inventory upon handshake ack
      const tabs = await this.controller.listTabsSummary().catch(() => [] as BrowserTabDto[]);
      this.pushTabsSync(tabs);
      return;
    }

    if (method === 'bridge.ping') {
      this.sendJson({
        jsonrpc: '2.0',
        method: 'bridge.pong',
        params: { ts: params.ts ?? Date.now() },
      });
      return;
    }

    if (method === 'bridge.pong') {
      return;
    }

    if (method === 'bridge.emergency_stop') {
      await this.policy.triggerEmergencyStop(
        String(params.reason ?? `Emergency stop received over ${this.label} bridge`),
      );
      return;
    }

    if (method === 'browser.invoke' && msg.id !== undefined) {
      // Mark connected if server begins sending requests directly after hello
      if (!this.handshakeAccepted) {
        this.handshakeAccepted = true;
        this.reconnectAttempt = 0;
        this.onStateChange();
      }

      const reqId = msg.id;
      const toolName = String(params.tool ?? '');
      const toolArgs =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      const caller = params.caller && typeof params.caller === 'object' ? params.caller : {};

      try {
        const result = await this.controller.invokeTool(toolName, toolArgs, {
          botUserId: typeof caller.bot_user_id === 'number' ? caller.bot_user_id : undefined,
          botUsername: typeof caller.bot_username === 'string' ? caller.bot_username : undefined,
          chatId: typeof caller.chat_id === 'number' ? caller.chat_id : null,
          preApprovedByCaller: Boolean(params.approved ?? caller.approved),
          timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
        });

        this.sendJson({
          jsonrpc: '2.0',
          id: reqId,
          result,
        });
      } catch (err: any) {
        const rpcErr =
          err instanceof BrowserRpcError
            ? err.toJsonRpcError()
            : {
                code: BRIDGE_ERROR_CODES.INTERNAL_ERROR,
                message: `INTERNAL_ERROR: ${String(err?.message ?? err)}`,
                data: { error_code: 'INTERNAL_ERROR' },
              };
        this.sendJson({
          jsonrpc: '2.0',
          id: reqId,
          error: rpcErr,
        });
      }

      // Push fresh tab state if tab/nav mutation occurred
      if (
        toolName.includes('tab') ||
        toolName.includes('navigate') ||
        toolName.includes('reload') ||
        toolName.includes('back_forward') ||
        toolName.includes('click')
      ) {
        const tabs = await this.controller.listTabsSummary().catch(() => [] as BrowserTabDto[]);
        this.pushTabsSync(tabs);
      }
    }
  }
}

export class DualBridgeManager {
  public readonly serverRelay: SingleOutboundBridgeClient;
  public readonly desktopBridge: SingleOutboundBridgeClient;
  private readonly controller: BrowserController;
  private readonly policy: BrowserPolicyEngine;
  private readonly onStateChange: () => void;
  private tabsSyncDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    controller: BrowserController,
    policy: BrowserPolicyEngine,
    onStateChange: () => void,
  ) {
    this.controller = controller;
    this.policy = policy;
    this.onStateChange = onStateChange;

    this.serverRelay = new SingleOutboundBridgeClient(
      'server',
      controller,
      policy,
      onStateChange,
    );
    this.desktopBridge = new SingleOutboundBridgeClient(
      'desktop',
      controller,
      policy,
      onStateChange,
    );

    this.policy.onEmergencyStop(async (reason) => {
      const payload = {
        jsonrpc: '2.0',
        method: 'bridge.emergency_stop',
        params: {
          reason,
          triggered_by: 'extension_killswitch',
          timestamp_ms: Date.now(),
        },
      };
      this.serverRelay.sendJson(payload);
      this.desktopBridge.sendJson(payload);
      await this.syncTabsImmediate();
    });
  }

  public installTabSyncListeners(): void {
    const schedule = () => this.scheduleTabsSync();
    chrome.tabs.onCreated.addListener(schedule);
    chrome.tabs.onRemoved.addListener(schedule);
    chrome.tabs.onActivated.addListener(schedule);
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
        schedule();
      }
    });
    if (chrome.tabGroups?.onUpdated) {
      chrome.tabGroups.onUpdated.addListener(schedule);
    }
  }

  public getStatus(): {
    serverRelayConnected: boolean;
    desktopBridgeConnected: boolean;
    desktopWsUrl: string | null;
  } {
    return {
      serverRelayConnected: this.serverRelay.isConnected(),
      desktopBridgeConnected: this.desktopBridge.isConnected(),
      desktopWsUrl: this.desktopBridge.getTargetUrl() || null,
    };
  }

  public async reloadAndConnect(forceReconnect = false): Promise<void> {
    const cfg = await readNormalizedStorageConfig();

    this.serverRelay.configure({
      wsUrl: cfg.serverBridgeWsUrl,
      enabled: Boolean(cfg.serverBridgeWsUrl && cfg.token),
      deviceId: cfg.deviceId,
      forceReconnect,
    });

    this.desktopBridge.configure({
      wsUrl: cfg.desktopBridgeWsUrl,
      enabled: cfg.desktopBridgeEnabled,
      pairingToken: cfg.pairingToken,
      deviceId: cfg.deviceId,
      forceReconnect,
    });

    this.onStateChange();
  }

  public scheduleTabsSync(): void {
    if (this.tabsSyncDebounce) {
      clearTimeout(this.tabsSyncDebounce);
    }
    this.tabsSyncDebounce = setTimeout(() => {
      this.tabsSyncDebounce = null;
      void this.syncTabsImmediate();
    }, 60);
  }

  public async syncTabsImmediate(): Promise<void> {
    const tabs = await this.controller.listTabsSummary().catch(() => [] as BrowserTabDto[]);
    this.serverRelay.pushTabsSync(tabs);
    this.desktopBridge.pushTabsSync(tabs);
  }
}
