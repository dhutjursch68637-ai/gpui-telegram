import * as crypto from 'node:crypto';
import {
  DEFAULT_SUT_ROOT,
  allocateRunEnvironment,
  type RunEnvironment,
} from './env.ts';
import {
  resolveSutPaths,
  type SutArtifactPaths,
} from './sut_preflight.ts';
import {
  spawnServerProcess,
  type ServerProcessHandle,
  type ServerSpawnOptions,
} from './server_proc.ts';
import {
  spawnDesktopBridgeProcess,
  type DesktopBridgeHandle,
  type DesktopBridgeSpawnOptions,
} from './desktop_bridge_proc.ts';
import {
  spawnChromiumWithExtension,
  type CdpPageHandle,
  type ChromiumExtensionHandle,
  type ChromiumSpawnOptions,
  type ExtensionSurfaceName,
} from './chromium_ext.ts';
import { TelegramApiClient } from './telegram_api_client.ts';
import {
  startFixtureWebAppServer,
  type FixtureWebAppHandle,
} from '../fixtures/web_app_server.ts';
import {
  startMockLlmServer,
  type MockLlmServerHandle,
} from '../fixtures/mock_llm_server.ts';
import { pollUntil } from './assertions.ts';

export type TierNumber = 1 | 2 | 3 | 4;

export type FeatureId =
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'F13'
  | 'F14'
  | 'F15'
  | 'F16';

export const ALL_FEATURE_IDS: readonly FeatureId[] = [
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'F13',
  'F14',
  'F15',
  'F16',
] as const;

export interface IsolatedUserSession {
  userId: number;
  username: string;
  password: string;
  token: string;
  sessionId: string;
  officialBotChatId: number;
  api: TelegramApiClient;
}

export type IsolatedServerOptions = Omit<ServerSpawnOptions, 'runEnv'>;
export type IsolatedBridgeOptions = Omit<DesktopBridgeSpawnOptions, 'runEnv' | 'serverUrl'> & {
  serverUrl?: string;
};
export type IsolatedChromiumOptions = Omit<ChromiumSpawnOptions, 'runEnv'>;

export interface SharedTierContext {
  readonly tier: TierNumber;
  readonly runEnv: RunEnvironment;
  readonly runDir: string;
  readonly shmDir: string;
  readonly sutRoot: string;
  readonly sutPaths: SutArtifactPaths;
  readonly fixtureApp: FixtureWebAppHandle;
  readonly mockLlm: MockLlmServerHandle;
  readonly server: ServerProcessHandle;
  readonly desktopBridge: DesktopBridgeHandle;
  readonly browser: ChromiumExtensionHandle;
  readonly primaryUser: IsolatedUserSession;

  createIsolatedUser(
    prefix?: string,
    opts?: { password?: string; autoWelcome?: boolean },
  ): Promise<IsolatedUserSession>;
  withTargetTab<T>(
    url: string,
    fn: (tab: CdpPageHandle) => Promise<T>,
    opts?: { viewport?: { width: number; height: number } },
  ): Promise<T>;
  withExtensionSurface<T>(
    surface: ExtensionSurfaceName,
    fn: (page: CdpPageHandle) => Promise<T>,
    opts?: { query?: string; hash?: string; viewport?: { width: number; height: number } },
  ): Promise<T>;
  signInExtensionAs(user: IsolatedUserSession): Promise<void>;
  resetBetweenTests(): Promise<void>;

  spawnIsolatedServer(opts?: IsolatedServerOptions): Promise<ServerProcessHandle>;
  spawnIsolatedDesktopBridge(opts?: IsolatedBridgeOptions): Promise<DesktopBridgeHandle>;
  spawnIsolatedChromium(opts?: IsolatedChromiumOptions): Promise<ChromiumExtensionHandle>;
  teardown(): Promise<void>;
}

async function registerIsolatedUser(
  serverBaseUrl: string,
  prefix = 'e2e_user',
  opts: { password?: string; autoWelcome?: boolean } = {},
): Promise<IsolatedUserSession> {
  const suffix = crypto.randomBytes(4).toString('hex');
  const username = `${prefix}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const password = opts.password ?? 'FabushiE2e!2026';
  const anonApi = new TelegramApiClient(serverBaseUrl);
  const reg = await anonApi.register({
    username,
    password,
    first_name: prefix,
    device_name: 'GPUI E2E Harness',
    auto_welcome: opts.autoWelcome ?? true,
  });

  const userId = reg.user_id;
  const token = reg.token;
  const sessionId = reg.session_id;
  const officialBotChatId = 700_000_000 + userId;
  const api = new TelegramApiClient(serverBaseUrl, token);

  return {
    userId,
    username,
    password,
    token,
    sessionId,
    officialBotChatId,
    api,
  };
}

async function seedExtensionStorageForUser(
  browser: ChromiumExtensionHandle,
  server: ServerProcessHandle,
  desktopBridge: DesktopBridgeHandle,
  mockLlm: MockLlmServerHandle,
  user: IsolatedUserSession,
): Promise<void> {
  const payload = {
    serverUrl: server.baseUrl,
    serverWsUrl: `${server.wsUrl}?token=${encodeURIComponent(user.token)}`,
    serverBrowserWsUrl: `${server.browserWsUrl}?token=${encodeURIComponent(user.token)}&client=extension`,
    desktopBridgePort: desktopBridge.port,
    desktopBridgeUrl: desktopBridge.baseUrl,
    desktopBridgeWsUrl: `${desktopBridge.wsUrl}?token=${encodeURIComponent(desktopBridge.pairingToken)}`,
    pairingToken: desktopBridge.pairingToken,
    mockLlmV1Url: mockLlm.v1BaseUrl,
    user: {
      userId: user.userId,
      username: user.username,
      token: user.token,
      sessionId: user.sessionId,
      officialBotChatId: user.officialBotChatId,
    },
  };

  await browser.evalInServiceWorker(async (cfg: typeof payload) => {
    const sessionObj = {
      user_id: cfg.user.userId,
      userId: cfg.user.userId,
      username: cfg.user.username,
      token: cfg.user.token,
      session_id: cfg.user.sessionId,
      sessionId: cfg.user.sessionId,
      server_url: cfg.serverUrl,
      serverUrl: cfg.serverUrl,
    };

    const bridgeObj = {
      enabled: true,
      port: cfg.desktopBridgePort,
      pairing_token: cfg.pairingToken,
      pairingToken: cfg.pairingToken,
      desktop_ws_url: cfg.desktopBridgeWsUrl,
      desktopWsUrl: cfg.desktopBridgeWsUrl,
      ws_url: cfg.desktopBridgeWsUrl,
      server_ws_url: cfg.serverBrowserWsUrl,
      serverWsUrl: cfg.serverBrowserWsUrl,
      run_policy: 'always_allow_authorized',
    };

    const llmProviderObj = {
      provider_id: 'openai',
      provider: 'openai',
      name: 'Local E2E Mock OpenAI',
      api_mode: 'chat_completions',
      base_url: cfg.mockLlmV1Url,
      baseUrl: cfg.mockLlmV1Url,
      api_key: 'sk-mock-e2e-token',
      apiKey: 'sk-mock-e2e-token',
      model: 'gpt-4o',
      default_model: 'gpt-4o',
      enabled: true,
      active: true,
    };

    const c = (globalThis as any).chrome;
    if (c?.storage?.local) {
      await c.storage.local.set({
        server_url: cfg.serverUrl,
        serverUrl: cfg.serverUrl,
        token: cfg.user.token,
        auth_token: cfg.user.token,
        user_id: cfg.user.userId,
        session: sessionObj,
        auth_session: sessionObj,
        accounts: [{ ...sessionObj, active: true }],
        active_account_id: cfg.user.userId,
        bridge_config: bridgeObj,
        desktop_bridge: bridgeObj,
        browser_bridge: bridgeObj,
        pairing_token: cfg.pairingToken,
        desktop_bridge_port: cfg.desktopBridgePort,
        run_policy: 'always_allow_authorized',
        browser_run_policy: 'always_allow_authorized',
        allowed_domains: [],
        blocked_domains: [],
        emergency_stopped: false,
        passcode_locked: false,
        passcode_enabled: false,
        passcode_hash: null,
        llm_provider: llmProviderObj,
        ai_providers: [llmProviderObj],
        ext_bot_config: llmProviderObj,
      });
    }

    // If background worker exposes an explicit rehydrate/reconnect hook, invoke it safely
    const g = globalThis as any;
    for (const fnName of [
      '__gpuiRehydrate',
      '__rehydrateSession',
      'reconnectBridges',
      'initBackgroundServices',
    ]) {
      if (typeof g[fnName] === 'function') {
        try {
          await g[fnName]();
        } catch {
          // Ignore
        }
      }
    }
  }, payload);
}

export async function bootSharedTierContext(
  tier: TierNumber,
  sutRoot = DEFAULT_SUT_ROOT,
): Promise<SharedTierContext> {
  const runEnv = allocateRunEnvironment(`tier${tier}`);
  const sutPaths = resolveSutPaths(sutRoot);

  let fixtureAppHandle: FixtureWebAppHandle | undefined;
  let mockLlmHandle: MockLlmServerHandle | undefined;
  let serverHandle: ServerProcessHandle | undefined;
  let desktopBridgeHandle: DesktopBridgeHandle | undefined;
  let browserHandle: ChromiumExtensionHandle | undefined;
  let primaryUserSession: IsolatedUserSession | undefined;

  try {
    fixtureAppHandle = await startFixtureWebAppServer();
    mockLlmHandle = await startMockLlmServer();

    serverHandle = await spawnServerProcess({
      runEnv,
      sutRoot,
      mockLlmPort: mockLlmHandle.port,
    });

    desktopBridgeHandle = await spawnDesktopBridgeProcess({
      runEnv,
      sutRoot,
      serverUrl: serverHandle.baseUrl,
    });

    primaryUserSession = await registerIsolatedUser(serverHandle.baseUrl, `t${tier}_primary`, {
      autoWelcome: true,
    });

    await serverHandle
      .configureMockLlmProvider(primaryUserSession.token, mockLlmHandle.port, 'gpt-4o')
      .catch(() => undefined);

    browserHandle = await spawnChromiumWithExtension({
      runEnv,
      loadExtension: true,
      extDistDir: sutPaths.extDistDir,
      profileDir: runEnv.chromeProfileDir,
      downloadsDir: runEnv.downloadsDir,
    });
  } catch (err) {
    await browserHandle?.stop().catch(() => undefined);
    await desktopBridgeHandle?.stop().catch(() => undefined);
    await serverHandle?.stop().catch(() => undefined);
    await mockLlmHandle?.stop().catch(() => undefined);
    await fixtureAppHandle?.stop().catch(() => undefined);
    await runEnv.cleanup().catch(() => undefined);
    throw err;
  }

  const fixtureApp = fixtureAppHandle;
  const mockLlm = mockLlmHandle;
  let server = serverHandle;
  let desktopBridge = desktopBridgeHandle;
  let browser = browserHandle;
  const primaryUser = primaryUserSession;

  const ephemeralStoppers = new Set<() => Promise<void>>();
  let activeExtUserId = 0;

  const signInExtensionAs = async (user: IsolatedUserSession): Promise<void> => {
    await server
      .configureMockLlmProvider(user.token, mockLlm.port, 'gpt-4o')
      .catch(() => undefined);

    await seedExtensionStorageForUser(browser, server, desktopBridge, mockLlm, user);

    // Check if Server Relay WS connected; if not yet connected, drive Auth Wizard once if present
    const relayQuickConnected = await pollUntil(
      async () => {
        const st = await user.api.getBrowserStatus().catch(() => null);
        return Boolean(
          st && (st.connected || st.extension_connected || st.server_relay_connected),
        );
      },
      { timeoutMs: 2200, intervalMs: 120 },
    ).catch(() => false);

    if (!relayQuickConnected) {
      const page = await browser.openExtensionSurface('workspace');
      try {
        const wizardInfo = await page.querySelector('[data-testid="auth-wizard"]');
        if (wizardInfo && wizardInfo.visible) {
          const srvInput = await page.querySelector('[data-testid="auth-server-url-input"]');
          if (srvInput && srvInput.visible) {
            await page.typeTestId('auth-server-url-input', server.baseUrl, { clearFirst: true });
          }
          const userInput = await page.querySelector('[data-testid="auth-username-input"]');
          const passInput = await page.querySelector('[data-testid="auth-password-input"]');
          const submitBtn = await page.querySelector('[data-testid="auth-submit-btn"]');
          if (userInput?.visible && passInput?.visible && submitBtn?.visible) {
            await page.typeTestId('auth-username-input', user.username, { clearFirst: true });
            await page.typeTestId('auth-password-input', user.password, { clearFirst: true });
            await page.clickTestId('auth-submit-btn');
          }
        }
        await seedExtensionStorageForUser(browser, server, desktopBridge, mockLlm, user);
      } finally {
        await page.close();
      }
    }

    await pollUntil(
      async () => {
        const [srvStatus, bridgeHealth] = await Promise.all([
          user.api.getBrowserStatus().catch(() => null),
          desktopBridge.getHealth().catch(() => null),
        ]);
        const srvOk = Boolean(
          srvStatus &&
            (srvStatus.connected ||
              srvStatus.extension_connected ||
              srvStatus.server_relay_connected),
        );
        const bridgeOk = Boolean(
          bridgeHealth && (bridgeHealth.extension_connected || bridgeHealth.connected),
        );
        return srvOk || bridgeOk;
      },
      {
        timeoutMs: 6000,
        intervalMs: 150,
        message: 'Extension WS bridge connection readiness',
      },
    ).catch(() => undefined);

    activeExtUserId = user.userId;
  };

  try {
    await signInExtensionAs(primaryUser);
  } catch (err) {
    await browser.stop().catch(() => undefined);
    await desktopBridge.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await mockLlm.stop().catch(() => undefined);
    await fixtureApp.stop().catch(() => undefined);
    await runEnv.cleanup().catch(() => undefined);
    throw err;
  }

  const cleanupEphemerals = async (): Promise<void> => {
    for (const stopFn of Array.from(ephemeralStoppers)) {
      try {
        await stopFn();
      } catch {
        // Best effort
      }
      ephemeralStoppers.delete(stopFn);
    }
  };

  const ctx: SharedTierContext = {
    tier,
    runEnv,
    runDir: runEnv.runDir,
    shmDir: runEnv.shmDir,
    sutRoot: sutPaths.sutRoot,
    sutPaths,
    fixtureApp,
    mockLlm,
    get server() {
      return server;
    },
    get desktopBridge() {
      return desktopBridge;
    },
    get browser() {
      return browser;
    },
    primaryUser,

    async createIsolatedUser(
      prefix = `t${tier}_u`,
      userOpts?: { password?: string; autoWelcome?: boolean },
    ): Promise<IsolatedUserSession> {
      return await registerIsolatedUser(server.baseUrl, prefix, userOpts);
    },

    async withTargetTab<T>(
      url: string,
      fn: (tab: CdpPageHandle) => Promise<T>,
      tabOpts?: { viewport?: { width: number; height: number } },
    ): Promise<T> {
      const tab = await browser.openPage(url, tabOpts?.viewport);
      try {
        return await fn(tab);
      } finally {
        await tab.close();
      }
    },

    async withExtensionSurface<T>(
      surface: ExtensionSurfaceName,
      fn: (page: CdpPageHandle) => Promise<T>,
      surfaceOpts?: {
        query?: string;
        hash?: string;
        viewport?: { width: number; height: number };
      },
    ): Promise<T> {
      const page = await browser.openExtensionSurface(surface, surfaceOpts);
      try {
        return await fn(page);
      } finally {
        await page.close();
      }
    },

    signInExtensionAs,

    async resetBetweenTests(): Promise<void> {
      await cleanupEphemerals();

      // Auto-heal pooled processes if a negative test terminated any of them
      if (!server.isRunning()) {
        await server.restart();
      }
      if (!desktopBridge.isRunning()) {
        await desktopBridge.restart();
      }
      if (!browser.isRunning()) {
        await browser.stop().catch(() => undefined);
        browser = await spawnChromiumWithExtension({
          runEnv,
          loadExtension: true,
          extDistDir: sutPaths.extDistDir,
          downloadsDir: runEnv.downloadsDir,
        });
        activeExtUserId = 0;
      }

      await browser.closeExtraTabs().catch(() => undefined);
      mockLlm.reset();
      fixtureApp.resetState();
      await browser.cdp
        .send('Storage.clearDataForOrigin', { origin: fixtureApp.baseUrl, storageTypes: 'all' })
        .catch(() => undefined);
      await browser.cdp
        .send('Storage.clearDataForOrigin', {
          origin: fixtureApp.localhostBaseUrl,
          storageTypes: 'all',
        })
        .catch(() => undefined);

      await server
        .configureMockLlmProvider(primaryUser.token, mockLlm.port, 'gpt-4o')
        .catch(() => undefined);

      await primaryUser.api
        .setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        })
        .catch(() => undefined);

      // Detach any leftover chrome.debugger attachments and purge transient test override keys in Extension SW
      await browser
        .evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          if (c?.debugger?.getTargets) {
            try {
              const targets = await c.debugger.getTargets();
              for (const t of targets) {
                if (t.attached && t.tabId !== undefined) {
                  await c.debugger.detach({ tabId: t.tabId }).catch(() => undefined);
                }
              }
            } catch {
              // Ignore
            }
          }
          if (c?.storage?.local) {
            await c.storage.local.remove([
              'ext_bot_enabled',
              'local_bot_mode',
              'passcode',
              'local_passcode',
              'passcode_locked',
              'font_size',
              'fontSize',
              'bubble_radius',
              'bubbleRadius',
              'corner_radius',
              'theme',
              'theme_mode',
              'palette',
              'appearance',
              'ui_settings',
              'theme_settings',
            ]);
          }
        })
        .catch(() => undefined);

      // Unconditionally re-seed primaryUser session, dual-bridge URLs, policy, and default mockLlm provider
      await seedExtensionStorageForUser(
        browser,
        server,
        desktopBridge,
        mockLlm,
        primaryUser,
      ).catch(() => undefined);

      if (activeExtUserId !== primaryUser.userId) {
        await signInExtensionAs(primaryUser);
      }

      browser.clearUncaughtExceptions();
    },

    async spawnIsolatedServer(
      srvOpts: IsolatedServerOptions = {},
    ): Promise<ServerProcessHandle> {
      const subEnv = runEnv.allocateSubRun('iso-srv');
      const handle = await spawnServerProcess({
        runEnv: subEnv,
        sutRoot: sutPaths.sutRoot,
        mockLlmPort: mockLlm.port,
        ...srvOpts,
      });
      const origStop = handle.stop.bind(handle);
      const wrappedStop = async (): Promise<void> => {
        ephemeralStoppers.delete(wrappedStop);
        await origStop();
        await subEnv.cleanup();
      };
      handle.stop = wrappedStop;
      ephemeralStoppers.add(wrappedStop);
      return handle;
    },

    async spawnIsolatedDesktopBridge(
      bridgeOpts: IsolatedBridgeOptions = {},
    ): Promise<DesktopBridgeHandle> {
      const subEnv = runEnv.allocateSubRun('iso-bridge');
      const handle = await spawnDesktopBridgeProcess({
        runEnv: subEnv,
        sutRoot: sutPaths.sutRoot,
        serverUrl: bridgeOpts.serverUrl ?? server.baseUrl,
        ...bridgeOpts,
      });
      const origStop = handle.stop.bind(handle);
      const wrappedStop = async (): Promise<void> => {
        ephemeralStoppers.delete(wrappedStop);
        await origStop();
        await subEnv.cleanup();
      };
      handle.stop = wrappedStop;
      ephemeralStoppers.add(wrappedStop);
      return handle;
    },

    async spawnIsolatedChromium(
      chrOpts: IsolatedChromiumOptions = {},
    ): Promise<ChromiumExtensionHandle> {
      const subEnv = runEnv.allocateSubRun('iso-chrome');
      const loadExt = chrOpts.loadExtension ?? false;
      const handle = await spawnChromiumWithExtension({
        runEnv: subEnv,
        loadExtension: loadExt,
        extDistDir: loadExt ? (chrOpts.extDistDir ?? sutPaths.extDistDir) : undefined,
        profileDir: chrOpts.profileDir ?? subEnv.chromeProfileDir,
        downloadsDir: chrOpts.downloadsDir ?? subEnv.downloadsDir,
        ...chrOpts,
      });
      const origStop = handle.stop.bind(handle);
      const wrappedStop = async (): Promise<void> => {
        ephemeralStoppers.delete(wrappedStop);
        await origStop();
        await subEnv.cleanup();
      };
      handle.stop = wrappedStop;
      ephemeralStoppers.add(wrappedStop);
      return handle;
    },

    async teardown(): Promise<void> {
      await cleanupEphemerals();
      await browser.stop().catch(() => undefined);
      await desktopBridge.stop().catch(() => undefined);
      await server.stop().catch(() => undefined);
      await mockLlm.stop().catch(() => undefined);
      await fixtureApp.stop().catch(() => undefined);
      await runEnv.cleanup();
    },
  };

  return ctx;
}
