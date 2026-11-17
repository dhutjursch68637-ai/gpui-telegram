import * as crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_SUT_ROOT,
  XVFB_RUN_BIN,
  allocateRunEnvironment,
  findFreePort,
  gracefulKillProcess,
  killPidBestEffort,
  trackChildProcess,
  type RunEnvironment,
} from './env.ts';
import { resolveSutPaths } from './sut_preflight.ts';
import { FatalPollError, pollUntil } from './assertions.ts';

export interface DesktopBridgeSpawnOptions {
  runEnv?: RunEnvironment;
  sutRoot?: string;
  desktopBin?: string;
  serverUrl: string;
  port?: number;
  pairingToken?: string;
  configDir?: string;
  extraArgs?: string[];
  extraEnv?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}

export interface DesktopBridgeHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly pairingToken: string;
  readonly configDir: string;
  readonly bridgeConfigPath: string;
  process: ChildProcess;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly usedXvfb: boolean;
  isRunning(): boolean;
  getLogs(): string;
  getHealth(): Promise<Record<string, any>>;
  getJsonList(token?: string): Promise<any[]>;
  kill(signal?: NodeJS.Signals): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

function isDisplayRelatedFailure(logs: string): boolean {
  return /\b(DISPLAY|WAYLAND_DISPLAY|XOpenDisplay|X11|xcb|wayland|Vulkan|winit|OpenGL|EGL|DRI|GLX)\b|cannot open display|failed to initialize display/i.test(
    logs,
  );
}

export async function spawnDesktopBridgeProcess(
  opts: DesktopBridgeSpawnOptions,
): Promise<DesktopBridgeHandle> {
  const ownedEnv = opts.runEnv ? null : allocateRunEnvironment('desktop-bridge');
  const runEnv = opts.runEnv ?? ownedEnv!;
  const sutPaths = resolveSutPaths(opts.sutRoot ?? DEFAULT_SUT_ROOT);
  const desktopBin = opts.desktopBin ?? sutPaths.desktopBin;

  const port = opts.port ?? (await findFreePort('127.0.0.1'));
  const pairingToken = opts.pairingToken ?? crypto.randomBytes(32).toString('hex');
  const configDir = opts.configDir ?? path.join(runEnv.desktopConfigDir, `bridge-${port}`);
  const cwd = path.join(runEnv.serverCwd, `bridge-${port}`);

  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const bridgeConfigPath = path.join(configDir, 'browser_bridge.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ext/ws`;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15000;

  const childEnv = runEnv.buildChildEnv(
    {
      GPUI_BROWSER_BRIDGE_PORT: String(port),
      GPUI_BROWSER_BRIDGE_TOKEN: pairingToken,
      GPUI_TELEGRAM_CONFIG_DIR: configDir,
      GPUI_TELEGRAM_SERVER_URL: opts.serverUrl,
      ...(opts.extraEnv ?? {}),
    },
    ['GPUI_OFFLINE_TEST'],
  );

  const cliArgs = [
    '--browser-bridge-only',
    '--server-url',
    opts.serverUrl,
    ...(opts.extraArgs ?? []),
  ];

  const logChunks: string[] = [];
  const pushLog = (chunk: Buffer | string): void => {
    logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    if (logChunks.length > 200) logChunks.shift();
  };

  let child!: ChildProcess;
  let usedXvfb = false;

  const spawnOnce = async (withXvfb: boolean): Promise<void> => {
    usedXvfb = withXvfb;
    const cmd = withXvfb ? XVFB_RUN_BIN : desktopBin;
    const args = withXvfb ? ['-a', desktopBin, ...cliArgs] : cliArgs;

    child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChildProcess(child);
    child.stdout?.on('data', pushLog);
    child.stderr?.on('data', pushLog);

    await pollUntil(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new FatalPollError(
            `gpui_telegram_desktop exited prematurely (xvfb=${withXvfb}, code=${child.exitCode}, signal=${child.signalCode}):\n${logChunks.join('')}`,
          );
        }
        const resp = await fetch(`${baseUrl}/health`, {
          headers: { Host: `127.0.0.1:${port}` },
        });
        return resp.ok;
      },
      {
        timeoutMs: startupTimeoutMs,
        intervalMs: 80,
        message: `Desktop Loopback Bridge /health on ${baseUrl}`,
      },
    );
  };

  const launchWithFallback = async (): Promise<void> => {
    try {
      await spawnOnce(false);
    } catch (firstErr) {
      await gracefulKillProcess(child);
      const logsSoFar = logChunks.join('');
      if (fs.existsSync(XVFB_RUN_BIN) && isDisplayRelatedFailure(logsSoFar)) {
        await spawnOnce(true);
      } else {
        throw firstErr;
      }
    }
  };

  try {
    await launchWithFallback();
  } catch (err) {
    await gracefulKillProcess(child);
    if (ownedEnv) await ownedEnv.cleanup();
    throw err;
  }

  const handle: DesktopBridgeHandle = {
    port,
    baseUrl,
    wsUrl,
    pairingToken,
    configDir,
    bridgeConfigPath,
    get process() {
      return child;
    },
    set process(p: ChildProcess) {
      child = p;
    },
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    get usedXvfb() {
      return usedXvfb;
    },
    isRunning(): boolean {
      return child.exitCode === null && child.signalCode === null;
    },
    getLogs(): string {
      return logChunks.join('');
    },
    async getHealth(): Promise<Record<string, any>> {
      const resp = await fetch(`${baseUrl}/health`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      if (!resp.ok) {
        throw new Error(`DesktopBridge GET /health failed: HTTP ${resp.status}`);
      }
      return (await resp.json()) as Record<string, any>;
    },
    async getJsonList(token = pairingToken): Promise<any[]> {
      const url = token
        ? `${baseUrl}/json/list?token=${encodeURIComponent(token)}`
        : `${baseUrl}/json/list`;
      const resp = await fetch(url, {
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) {
        throw new Error(`DesktopBridge GET /json/list failed: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      return Array.isArray(data) ? data : (data as any)?.tabs ?? (data as any)?.targets ?? [];
    },
    kill(signal: NodeJS.Signals = 'SIGKILL'): void {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        killPidBestEffort(child.pid, signal);
      }
    },
    async stop(): Promise<void> {
      await gracefulKillProcess(child);
      if (ownedEnv) {
        await ownedEnv.cleanup();
      }
    },
    async restart(): Promise<void> {
      await gracefulKillProcess(child);
      await spawnOnce(usedXvfb);
    },
  };

  return handle;
}
