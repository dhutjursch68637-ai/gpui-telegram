import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

export const E2E_ROOT = process.env.GPUI_E2E_ROOT
  ? path.resolve(process.env.GPUI_E2E_ROOT)
  : path.resolve(import.meta.dirname, '..', '..');
export const E2E_RUNS_ROOT = process.env.GPUI_E2E_RUNS_ROOT
  ? path.resolve(process.env.GPUI_E2E_RUNS_ROOT)
  : path.join(E2E_ROOT, '.e2e-runs');
export const SHM_ROOT = '/dev/shm';
export const SHM_PREFIX = 'gpui-e2e-';
export const DEFAULT_SUT_ROOT = fs.existsSync(path.join(E2E_ROOT, '..', 'Cargo.toml'))
  ? path.resolve(E2E_ROOT, '..')
  : '/home/antigravity/gpui-telegram';
export const CHROMIUM_BIN = '/usr/lib/chromium/chromium';
export const XVFB_RUN_BIN = '/usr/bin/xvfb-run';
export const CANONICAL_NO_PROXY = 'localhost,127.0.0.1,::1,[::1]';

export function isVmDaemonTmpEntry(name: string): boolean {
  return (
    name.startsWith('agy-plugin-proxy.') ||
    name.startsWith('agy-plugin-tokens-') ||
    name.startsWith('initgoogle_syslog') ||
    name.startsWith('exebox-') ||
    name === '.X11-unix' ||
    name === '.jetski-proxy-init-ran'
  );
}

export function isE2eRelatedTmpEntry(name: string): boolean {
  return /^(gpui|fabushi|hermes|magpie|e2e|\.org\.chromium|org\.chromium|chromium|chrome|crashpad|Singleton|v8-compile-cache|node-compile-cache|npm-|tsx-|tsserver|xvfb-run\.|\.X\d+-lock)/i.test(
    name,
  );
}

export interface RunEnvironment {
  readonly runId: string;
  readonly label?: string;
  readonly runDir: string;
  readonly shmDir: string;
  readonly shmTmpDir: string;
  readonly chromeProfileDir: string;
  readonly tmpDir: string;
  readonly serverCwd: string;
  readonly serverDataDir: string;
  readonly mediaDir: string;
  readonly desktopConfigDir: string;
  readonly fakeHomeDir: string;
  readonly xdgConfigDir: string;
  readonly xdgCacheDir: string;
  readonly xdgDataDir: string;
  readonly downloadsDir: string;
  buildChildEnv(
    overrides?: Record<string, string | undefined>,
    unsetKeys?: string[],
  ): NodeJS.ProcessEnv;
  allocateSubRun(subLabel?: string): RunEnvironment;
  cleanup(): Promise<void>;
}

const trackedProcesses = new Set<ChildProcess>();
const trackedPids = new Set<number>();
const trackedDirs = new Set<string>();
const asyncCleanupHooks = new Set<() => Promise<void> | void>();
let cleanupHooksInstalled = false;
let shuttingDown = false;

export function hasLiveNonZombieInProcessGroup(pgid: number): boolean {
  if (pgid <= 1) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const name of entries) {
    const c0 = name.charCodeAt(0);
    if (c0 < 48 || c0 > 57) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf-8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) continue;
      const rest = stat.slice(closeParen + 2).split(' ');
      const state = rest[0];
      const procPgid = Number(rest[2]);
      if (procPgid === pgid && state !== 'Z' && state !== 'X' && state !== 'x') {
        return true;
      }
    } catch {
      // Process exited during /proc scan
    }
  }
  return false;
}

export function killPidBestEffort(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group may not exist (if not group leader) or already exited
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited or inaccessible
  }
}

function syncEmergencyCleanup(): void {
  for (const proc of trackedProcesses) {
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      killPidBestEffort(proc.pid, 'SIGTERM');
      killPidBestEffort(proc.pid, 'SIGKILL');
    }
  }
  for (const pid of trackedPids) {
    killPidBestEffort(pid, 'SIGTERM');
    killPidBestEffort(pid, 'SIGKILL');
  }
  for (const dir of Array.from(trackedDirs)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore best-effort sync rm errors
    }
    trackedDirs.delete(dir);
  }
  cleanEmptyRunsRootBestEffort();
}

export function cleanEmptyRunsRootBestEffort(): void {
  try {
    if (fs.existsSync(E2E_RUNS_ROOT)) {
      const entries = fs.readdirSync(E2E_RUNS_ROOT);
      if (entries.length === 0) {
        // Keep .e2e-runs directory clean and empty
      }
    }
  } catch {
    // Ignore
  }
}

export function installGlobalCleanupHooks(): void {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;

  process.on('exit', () => {
    syncEmergencyCleanup();
  });

  const handleSignal = (sig: 'SIGINT' | 'SIGTERM', code: number): void => {
    if (shuttingDown) {
      syncEmergencyCleanup();
      process.exit(code);
    }
    shuttingDown = true;
    void cleanupAllTrackedResources()
      .catch(() => undefined)
      .finally(() => {
        syncEmergencyCleanup();
        process.exit(code);
      });
  };

  process.once('SIGINT', () => handleSignal('SIGINT', 130));
  process.once('SIGTERM', () => handleSignal('SIGTERM', 143));
}

export function registerCleanupDir(dirPath: string): void {
  installGlobalCleanupHooks();
  const resolved = path.resolve(dirPath);
  if (
    !resolved.startsWith(E2E_RUNS_ROOT + path.sep) &&
    !resolved.startsWith(path.join(SHM_ROOT, SHM_PREFIX))
  ) {
    throw new Error(
      `Refusing to register cleanup dir outside allowed XFS/.dev/shm prefixes: ${resolved}`,
    );
  }
  trackedDirs.add(resolved);
}

export function registerAsyncCleanupHook(fn: () => Promise<void> | void): () => void {
  installGlobalCleanupHooks();
  asyncCleanupHooks.add(fn);
  return () => {
    asyncCleanupHooks.delete(fn);
  };
}

export function trackChildProcess(proc: ChildProcess): void {
  installGlobalCleanupHooks();
  trackedProcesses.add(proc);
  if (proc.pid) {
    trackedPids.add(proc.pid);
  }
  const pid = proc.pid;
  proc.once('exit', () => {
    trackedProcesses.delete(proc);
    if (pid && !hasLiveNonZombieInProcessGroup(pid)) {
      trackedPids.delete(pid);
    }
  });
}

export async function gracefulKillProcess(
  proc: ChildProcess | null | undefined,
  timeoutMs = 2500,
): Promise<void> {
  if (!proc) return;
  const pid = proc.pid;
  if (!pid) {
    trackedProcesses.delete(proc);
    return;
  }

  const leaderDone = proc.exitCode !== null || proc.signalCode !== null;
  if (leaderDone && !hasLiveNonZombieInProcessGroup(pid)) {
    trackedProcesses.delete(proc);
    trackedPids.delete(pid);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let groupPollTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (groupPollTimer) clearInterval(groupPollTimer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      trackedProcesses.delete(proc);
      trackedPids.delete(pid);
      resolve();
    };

    const checkAllExited = (): void => {
      const isLeaderExited = proc.exitCode !== null || proc.signalCode !== null;
      if (isLeaderExited && !hasLiveNonZombieInProcessGroup(pid)) {
        finish();
      }
    };

    proc.once('exit', checkAllExited);
    proc.once('error', checkAllExited);
    groupPollTimer = setInterval(checkAllExited, 25);

    killPidBestEffort(pid, 'SIGTERM');

    const killTimer = setTimeout(() => {
      killPidBestEffort(pid, 'SIGKILL');
      checkAllExited();
    }, timeoutMs);

    const hardTimer = setTimeout(() => {
      killPidBestEffort(pid, 'SIGKILL');
      finish();
    }, timeoutMs + 1000);
  });
}

export async function cleanupAllTrackedResources(): Promise<void> {
  for (const hook of Array.from(asyncCleanupHooks)) {
    try {
      await hook();
    } catch {
      // Best-effort cleanup
    }
    asyncCleanupHooks.delete(hook);
  }

  const procs = Array.from(trackedProcesses);
  await Promise.all(procs.map((p) => gracefulKillProcess(p, 1500)));

  for (const pid of Array.from(trackedPids)) {
    killPidBestEffort(pid, 'SIGKILL');
    trackedPids.delete(pid);
  }

  for (const dir of Array.from(trackedDirs)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
    trackedDirs.delete(dir);
  }

  cleanEmptyRunsRootBestEffort();
}

function createEnvironmentFromPaths(
  runId: string,
  runDir: string,
  shmDir: string,
  label?: string,
): RunEnvironment {
  // Keep shmTmpDir & chromeProfileDir short (< 40 chars) so UNIX domain sockets
  // like Chromium's SingletonSocket stay well under Linux's 108-byte sun_path limit!
  const shmTmpDir = path.join(shmDir, 't');
  const chromeProfileDir = path.join(shmDir, 'p');
  const tmpDir = path.join(runDir, 't');
  const serverCwd = path.join(runDir, 'server_cwd');
  const serverDataDir = path.join(runDir, 'server_data');
  const mediaDir = path.join(serverDataDir, 'media');
  const desktopConfigDir = path.join(runDir, 'desktop_config');
  const fakeHomeDir = path.join(runDir, 'fake-home');
  const xdgConfigDir = path.join(runDir, 'xdg_config');
  const xdgCacheDir = path.join(runDir, 'xdg_cache');
  const xdgDataDir = path.join(runDir, 'xdg_data');
  const downloadsDir = path.join(runDir, 'downloads');

  for (const dir of [
    runDir,
    shmDir,
    shmTmpDir,
    chromeProfileDir,
    tmpDir,
    serverCwd,
    serverDataDir,
    mediaDir,
    desktopConfigDir,
    fakeHomeDir,
    xdgConfigDir,
    xdgCacheDir,
    xdgDataDir,
    downloadsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  registerCleanupDir(runDir);
  registerCleanupDir(shmDir);

  return {
    runId,
    label,
    runDir,
    shmDir,
    shmTmpDir,
    chromeProfileDir,
    tmpDir,
    serverCwd,
    serverDataDir,
    mediaDir,
    desktopConfigDir,
    fakeHomeDir,
    xdgConfigDir,
    xdgCacheDir,
    xdgDataDir,
    downloadsDir,
    buildChildEnv(
      overrides: Record<string, string | undefined> = {},
      unsetKeys: string[] = [],
    ): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.GPUI_OFFLINE_TEST;
      for (const k of unsetKeys) {
        delete env[k];
      }
      env.TMPDIR = tmpDir;
      env.TMP = tmpDir;
      env.TEMP = tmpDir;
      env.HOME = fakeHomeDir;
      env.CODEX_HOME = fakeHomeDir;
      env.XDG_CONFIG_HOME = xdgConfigDir;
      env.XDG_CACHE_HOME = xdgCacheDir;
      env.XDG_DATA_HOME = xdgDataDir;
      env.XDG_RUNTIME_DIR = shmTmpDir;
      env.NO_PROXY = CANONICAL_NO_PROXY;
      env.no_proxy = CANONICAL_NO_PROXY;

      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      return env;
    },
    allocateSubRun(subLabel?: string): RunEnvironment {
      return allocateRunEnvironment(subLabel);
    },
    async cleanup(): Promise<void> {
      try {
        fs.rmSync(shmDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      trackedDirs.delete(path.resolve(shmDir));
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      trackedDirs.delete(path.resolve(runDir));
    },
  };
}

export function allocateRunEnvironment(label?: string): RunEnvironment {
  installGlobalCleanupHooks();
  fs.mkdirSync(E2E_RUNS_ROOT, { recursive: true });
  const rand = crypto.randomBytes(4).toString('hex');
  // Compact runId (< 16 chars) prevents UNIX sun_path > 107-byte overflow
  const runId = `${process.pid}-${rand}`;
  const runDir = path.join(E2E_RUNS_ROOT, runId);
  const shmAvailable = fs.existsSync(SHM_ROOT);
  const shmDir = shmAvailable
    ? path.join(SHM_ROOT, `${SHM_PREFIX}${runId}`)
    : path.join(runDir, 's');

  return createEnvironmentFromPaths(runId, runDir, shmDir, label);
}

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to obtain TCP port address')));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function findFreeDualStackPort(maxAttempts = 15): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidatePort = await findFreePort('127.0.0.1');
    const ipv6Free = await new Promise<boolean>((resolve) => {
      const srv6 = net.createServer();
      srv6.unref();
      srv6.once('error', () => resolve(false));
      srv6.listen(candidatePort, '::1', () => {
        srv6.close(() => resolve(true));
      });
    });
    if (ipv6Free) {
      return candidatePort;
    }
  }
  throw new Error(`Unable to allocate free dual-stack (127.0.0.1 + ::1) TCP port after ${maxAttempts} attempts`);
}
