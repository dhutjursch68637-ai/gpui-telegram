import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_SUT_ROOT,
  allocateRunEnvironment,
  findFreePort,
  gracefulKillProcess,
  killPidBestEffort,
  trackChildProcess,
  type RunEnvironment,
} from './env.ts';
import { resolveSutPaths } from './sut_preflight.ts';
import { FatalPollError, pollUntil } from './assertions.ts';

export interface ServerSpawnOptions {
  runEnv?: RunEnvironment;
  sutRoot?: string;
  serverBin?: string;
  port?: number;
  dbPath?: string;
  inMemoryDb?: boolean;
  mockLlmPort?: number;
  mockLlmBaseUrl?: string;
  openAiApiKey?: string;
  model?: string;
  cdpFallbackUrl?: string;
  extraEnv?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}

export interface ServerProcessHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly browserWsUrl: string;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly cwd: string;
  process: ChildProcess;
  pid: number | undefined;
  readonly exitCode: number | null;
  isRunning(): boolean;
  getLogs(): string;
  configureMockLlmProvider(
    authToken: string,
    mockLlmPortOrUrl: number | string,
    model?: string,
  ): Promise<Record<string, any>>;
  kill(signal?: NodeJS.Signals): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export async function spawnServerProcess(
  opts: ServerSpawnOptions = {},
): Promise<ServerProcessHandle> {
  const ownedEnv = opts.runEnv ? null : allocateRunEnvironment('server');
  const runEnv = opts.runEnv ?? ownedEnv!;
  const sutPaths = resolveSutPaths(opts.sutRoot ?? DEFAULT_SUT_ROOT);
  const serverBin = opts.serverBin ?? sutPaths.serverBin;
  const port = opts.port ?? (await findFreePort('127.0.0.1'));

  const dataDir = path.join(runEnv.serverDataDir, `srv-${port}`);
  const mediaDir = path.join(dataDir, 'media');
  const cwd = path.join(runEnv.serverCwd, `srv-${port}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const dbPath = opts.dbPath ?? path.join(dataDir, 'gpui_telegram.db');
  const databaseUrl = opts.inMemoryDb ? 'sqlite::memory:' : `sqlite://${dbPath}`;
  const model = opts.model ?? 'gpt-4o';
  const apiKey = opts.openAiApiKey ?? 'sk-mock-e2e-token';
  const openAiBaseUrl =
    opts.mockLlmBaseUrl ??
    (opts.mockLlmPort !== undefined ? `http://127.0.0.1:${opts.mockLlmPort}/v1` : undefined);

  const envOverrides: Record<string, string | undefined> = {
    HOST: '127.0.0.1',
    PORT: String(port),
    GPUI_TELEGRAM_BIND_ADDR: `127.0.0.1:${port}`,
    DATABASE_URL: databaseUrl,
    GPUI_TELEGRAM_DB_PATH: dbPath,
    GPUI_TELEGRAM_DATA_DIR: dataDir,
    MEDIA_STORAGE_PATH: mediaDir,
    HERMES_ENABLE_PUBLIC_CLOUD_FALLBACK: '0',
    HERMES_PROVIDER: 'openai',
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
    HERMES_MODEL: model,
    DEFAULT_AGENT_MODEL: model,
    ...(openAiBaseUrl ? { OPENAI_BASE_URL: openAiBaseUrl } : {}),
    ...(opts.cdpFallbackUrl ? { HERMES_BROWSER_CDP_URL: opts.cdpFallbackUrl } : {}),
    ...(opts.extraEnv ?? {}),
  };

  // Ensure GPUI_OFFLINE_TEST is deleted so ProviderRouter reads OPENAI_BASE_URL
  const childEnv = runEnv.buildChildEnv(envOverrides, ['GPUI_OFFLINE_TEST']);
  delete childEnv.GPUI_OFFLINE_TEST;

  const logChunks: string[] = [];
  const pushLog = (chunk: Buffer | string): void => {
    logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    if (logChunks.length > 250) logChunks.shift();
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15000;

  let child!: ChildProcess;

  const launchAndWait = async (): Promise<void> => {
    child = spawn(serverBin, [], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChildProcess(child);
    child.stdout?.on('data', pushLog);
    child.stderr?.on('data', pushLog);

    try {
      await pollUntil(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new FatalPollError(
              `gpui_telegram_server exited prematurely (code=${child.exitCode}, signal=${child.signalCode}):\n${logChunks.join('')}`,
            );
          }
          const resp = await fetch(`${baseUrl}/health`);
          if (resp.ok) return true;
          const statusResp = await fetch(`${baseUrl}/api/v1/status`);
          return statusResp.ok;
        },
        {
          timeoutMs: startupTimeoutMs,
          intervalMs: 80,
          message: `gpui_telegram_server readiness on ${baseUrl}`,
        },
      );
    } catch (err) {
      await gracefulKillProcess(child);
      throw err;
    }
  };

  try {
    await launchAndWait();
  } catch (err) {
    if (ownedEnv) await ownedEnv.cleanup();
    throw err;
  }

  const handle: ServerProcessHandle = {
    port,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/api/v1/ws`,
    browserWsUrl: `ws://127.0.0.1:${port}/api/v1/browser/ws`,
    dbPath,
    dataDir,
    mediaDir,
    cwd,
    get process() {
      return child;
    },
    set process(p: ChildProcess) {
      child = p;
    },
    get pid() {
      return child.pid;
    },
    set pid(_v: number | undefined) {
      // Derived from child.pid
    },
    get exitCode() {
      return child.exitCode;
    },
    isRunning(): boolean {
      return child.exitCode === null && child.signalCode === null;
    },
    getLogs(): string {
      return logChunks.join('');
    },
    async configureMockLlmProvider(
      authToken: string,
      mockLlmPortOrUrl: number | string,
      overrideModel = model,
    ): Promise<Record<string, any>> {
      const providerBaseUrl =
        typeof mockLlmPortOrUrl === 'number'
          ? `http://127.0.0.1:${mockLlmPortOrUrl}/v1`
          : mockLlmPortOrUrl.endsWith('/v1')
            ? mockLlmPortOrUrl
            : `${mockLlmPortOrUrl.replace(/\/+$/, '')}/v1`;

      const resp = await fetch(`${baseUrl}/api/v1/hermes/providers`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          provider_id: 'openai',
          name: 'Local E2E Mock OpenAI',
          api_mode: 'chat_completions',
          base_url: providerBaseUrl,
          default_model: overrideModel,
          api_key: apiKey,
          enabled: true,
          set_active: true,
          allow_local_fallback: false,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `PUT /api/v1/hermes/providers failed (${resp.status}): ${text}`,
        );
      }
      return (await resp.json()) as Record<string, any>;
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
      await launchAndWait();
    },
  };

  return handle;
}
