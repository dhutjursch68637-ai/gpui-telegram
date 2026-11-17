import WebSocket from 'ws';
import {
  BROWSER_RPC_ERROR_CODES,
  assert,
  assertBrowserRpcError,
  defineTest,
  extractBrowserErrorCode,
  pollUntil,
  probeWsUpgradeRejection,
  sleep,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function resolveTabIdForUrl(
  ctx: SharedTierContext,
  expectedUrlPrefix: string,
): Promise<number> {
  return await pollUntil(
    async () => {
      const swTabId = await ctx.browser.evalInServiceWorker((prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        return c.tabs.query({}).then((tabs: any[]) => {
          const match = tabs.find(
            (t) => typeof t.url === 'string' && t.url.startsWith(prefix) && typeof t.id === 'number',
          );
          return match ? Number(match.id) : null;
        });
      }, expectedUrlPrefix);
      if (typeof swTabId === 'number' && swTabId > 0) {
        return swTabId;
      }
      const tabsResp = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const found = tabsResp?.tabs?.find(
        (t: any) => typeof t.url === 'string' && t.url.startsWith(expectedUrlPrefix),
      );
      return typeof found?.tab_id === 'number' ? found.tab_id : null;
    },
    {
      timeoutMs: 6000,
      intervalMs: 80,
      message: `resolve numeric tab_id for ${expectedUrlPrefix}`,
    },
  ).then((id) => {
    assert.ok(typeof id === 'number' && id > 0, `Failed to resolve tab_id for ${expectedUrlPrefix}`);
    return id;
  });
}

async function setUnifiedRunPolicy(
  ctx: SharedTierContext,
  policy: 'always_allow_authorized' | 'allow_read_only' | 'ask_every_time' | 'disabled',
): Promise<void> {
  await ctx.primaryUser.api.setBotBrowserProfile(777000, {
    enabled: true,
    run_policy: policy,
    allowed_domains: [],
    blocked_domains: [],
    preferred_target: 'extension',
  });
  await ctx.browser.evalInServiceWorker(async (nextPolicy: string) => {
    const c = (globalThis as any).chrome;
    if (c?.storage?.local) {
      await c.storage.local.set({
        run_policy: nextPolicy,
        browser_run_policy: nextPolicy,
        emergency_stopped: nextPolicy === 'disabled',
      });
    }
  }, policy);
}

defineTest({
  id: 'T2-F01-01',
  title: 'Reject unauthenticated /api/v1/browser/ws upgrades and invalid bridge.hello protocol/token with 401/403 or -32001 UNAUTHORIZED_BRIDGE',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.server.isRunning(), 'gpui_telegram_server must be running before negative WS auth test');
    assert.ok(ctx.desktopBridge.isRunning(), 'Desktop Loopback Bridge must be running before negative WS auth test');

    // 1. Server Browser WS without any token
    const noTokenProbe = await probeWsUpgradeRejection(`${ctx.server.browserWsUrl}?client=extension`);
    assert.equal(noTokenProbe.rejected, true, 'Server /api/v1/browser/ws without token must be rejected');
    assert.ok(
      !String(noTokenProbe.errorMessage ?? '').includes('ECONNREFUSED'),
      `Server WS rejection must not be ECONNREFUSED: ${noTokenProbe.errorMessage}`,
    );
    if (noTokenProbe.statusCode !== undefined) {
      assert.ok(
        noTokenProbe.statusCode === 401 || noTokenProbe.statusCode === 403,
        `Expected HTTP 401 or 403 on missing token WS upgrade, got ${noTokenProbe.statusCode}`,
      );
    } else if (noTokenProbe.firstMessage?.error) {
      assert.equal(
        noTokenProbe.firstMessage.error.code,
        BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE,
      );
    } else {
      assert.ok(
        noTokenProbe.closeCode !== undefined && noTokenProbe.closeCode !== 1000,
        `Expected abnormal auth close code on missing token WS, got ${noTokenProbe.closeCode}`,
      );
    }

    // 2. Server Browser WS with forged Bearer token
    const badTokenProbe = await probeWsUpgradeRejection(
      `${ctx.server.browserWsUrl}?token=forged_invalid_token_f01_01&client=extension`,
    );
    assert.equal(badTokenProbe.rejected, true, 'Forged token on /api/v1/browser/ws must be rejected');
    if (badTokenProbe.statusCode !== undefined) {
      assert.ok(
        badTokenProbe.statusCode === 401 || badTokenProbe.statusCode === 403,
        `Expected HTTP 401/403 for forged WS token, got ${badTokenProbe.statusCode}`,
      );
    } else if (badTokenProbe.firstMessage?.error) {
      assert.equal(
        badTokenProbe.firstMessage.error.code,
        BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE,
      );
    } else {
      assert.ok(
        badTokenProbe.closeCode !== undefined && badTokenProbe.closeCode !== 1000,
        `Expected abnormal auth close code on forged token WS, got ${badTokenProbe.closeCode}`,
      );
    }

    // 3. Desktop Bridge WS with empty pairing_token and unsupported protocol_version: 999
    const emptyBridgeTokUrl = `${ctx.desktopBridge.wsUrl}?token=`;
    const bridgeEmptyProbe = await probeWsUpgradeRejection(emptyBridgeTokUrl, {
      origin: `chrome-extension://${ctx.browser.extensionId}`,
    });
    if (bridgeEmptyProbe.rejected) {
      assert.ok(
        bridgeEmptyProbe.statusCode === 401 ||
          bridgeEmptyProbe.statusCode === 403 ||
          bridgeEmptyProbe.firstMessage?.error?.code === BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE ||
          (bridgeEmptyProbe.closeCode !== undefined && bridgeEmptyProbe.closeCode !== 1000),
        `Expected HTTP 401/403 or -32001 on Desktop Bridge empty pairing_token, got ${JSON.stringify(bridgeEmptyProbe)}`,
      );
    } else {
      // If socket opened prior to hello frame auth, send bridge.hello with empty pairing_token & protocol_version: 999
      const ws = new WebSocket(emptyBridgeTokUrl, {
        headers: { Origin: `chrome-extension://${ctx.browser.extensionId}` },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
        const responseOrClose = await new Promise<{ msg?: any; closedCode?: number }>((resolve) => {
          const timer = setTimeout(() => resolve({}), 3000);
          ws.once('message', (raw) => {
            clearTimeout(timer);
            resolve({ msg: JSON.parse(raw.toString('utf-8')) });
          });
          ws.once('close', (code) => {
            clearTimeout(timer);
            resolve({ closedCode: code });
          });
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'hello_bad_1',
              method: 'bridge.hello',
              params: {
                protocol_version: 999,
                extension_id: ctx.browser.extensionId,
                device_id: 'bad-proto-probe',
                pairing_token: '',
                user_agent: 'E2E',
                capabilities: [],
                run_policy: 'always_allow_authorized',
                tabs_summary: [],
              },
            }),
          );
        });
        const rejectedInFrame =
          responseOrClose.msg?.error?.code === BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE ||
          responseOrClose.msg?.params?.accepted === false ||
          (responseOrClose.closedCode !== undefined && responseOrClose.closedCode !== 1000);
        assert.ok(
          rejectedInFrame,
          `Expected -32001 UNAUTHORIZED_BRIDGE or connection rejection on invalid bridge.hello, got ${JSON.stringify(responseOrClose)}`,
        );
      } finally {
        ws.terminate();
      }
    }

    // 4. Also test invalid protocol_version: 999 on authenticated isolated user's /api/v1/browser/ws
    const isoUser = await ctx.createIsolatedUser('f01_badproto');
    const protoWs = await isoUser.api.connectServerBrowserWs();
    try {
      let protoCloseCode: number | undefined;
      protoWs.ws.once('close', (code) => {
        protoCloseCode = code;
      });

      await protoWs.sendRaw({
        jsonrpc: '2.0',
        id: 'proto_999',
        method: 'bridge.hello',
        params: {
          protocol_version: 999,
          extension_id: ctx.browser.extensionId,
          device_id: 'bad-proto',
          pairing_token: '',
          user_agent: 'Chrome/156',
          capabilities: [],
          run_policy: 'always_allow_authorized',
          tabs_summary: [],
        },
      });

      const protoReaction = await pollUntil(
        () => {
          if (protoWs.messages.length > 0) {
            return { kind: 'message' as const, first: protoWs.messages[0] };
          }
          if (!protoWs.isOpen()) {
            return { kind: 'closed' as const, closeCode: protoCloseCode };
          }
          return null;
        },
        {
          timeoutMs: 4000,
          intervalMs: 40,
          message: 'Server response or rejection close for bridge.hello protocol_version: 999',
        },
      );

      assert.ok(protoReaction, 'Expected server response or close for protocol_version 999');
      if (protoReaction.kind === 'message') {
        const first = protoReaction.first;
        if (first?.error) {
          assert.ok(
            first.error.code === BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE ||
              first.error.code === -32602 ||
              first.error.code === -32600,
            `Unexpected JSON-RPC error code for protocol_version 999: ${JSON.stringify(first)}`,
          );
        } else {
          assert.equal(
            first?.method,
            'bridge.hello_ack',
            `Expected bridge.hello_ack or JSON-RPC error for protocol_version 999, got ${JSON.stringify(first)}`,
          );
          assert.ok(
            first.params?.accepted === false || first.params?.protocol_version !== 999,
            `Server must reject or downgrade unsupported protocol_version 999: ${JSON.stringify(first)}`,
          );
        }
      } else {
        assert.equal(protoWs.isOpen(), false);
        assert.notEqual(
          protoReaction.closeCode,
          1000,
          'Unsupported protocol_version 999 socket close must use a non-1000 protocol/policy close code',
        );
      }
    } finally {
      await protoWs.close();
    }

    // Verify both server and desktop bridge remain healthy afterward
    const srvStatus = await ctx.primaryUser.api.getBrowserStatus();
    assert.ok(srvStatus.connected || srvStatus.extension_connected, 'Primary extension relay must remain connected');
    const bridgeHealth = await ctx.desktopBridge.getHealth();
    assert.equal(bridgeHealth.ok, true, 'Desktop bridge /health must remain ok:true');
  },
});

defineTest({
  id: 'T2-F01-02',
  title: 'Serialize exact JSON-RPC -32003 POLICY_DISABLED when disabled and -32002 USER_DENIED_APPROVAL when AskEveryTime is rejected',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (tab) => {
      const tabId = await resolveTabIdForUrl(ctx, shopUrl);

      try {
        // Part A: run_policy === 'disabled' -> -32003 POLICY_DISABLED
        await setUnifiedRunPolicy(ctx, 'disabled');
        const disabledResp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_click',
          arguments: {
            tab_id: tabId,
            selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
          },
          bot_id: 777000,
          timeout_ms: 8000,
        });

        assert.notEqual(disabledResp.status, 500, 'Disabled policy must never return 500 Internal Server Error');
        assertBrowserRpcError(
          disabledResp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );
        const disabledErr = extractBrowserErrorCode(disabledResp);
        assert.equal(
          disabledErr.code,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          `Expected exact numeric code -32003, got ${disabledErr.code} (${JSON.stringify(disabledResp.data)})`,
        );

        // Part B: run_policy === 'ask_every_time' + explicit denial -> -32002 USER_DENIED_APPROVAL
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'ask_every_time',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });
        await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          if (c?.storage?.local) {
            await c.storage.local.set({
              run_policy: 'ask_every_time',
              browser_run_policy: 'ask_every_time',
              emergency_stopped: false,
            });
          }
        });

        const pendingExecPromise = ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: {
              tab_id: tabId,
              selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
            timeout_ms: 12000,
          },
          15000,
        );

        const pendingCmd = await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return items.find((c: any) => c.tool === 'browser_click') ?? items[0] ?? null;
          },
          {
            timeoutMs: 6000,
            intervalMs: 80,
            message: 'pending browser_click approval entry',
          },
        );
        const cmdId = String(pendingCmd.command_id ?? pendingCmd.id);
        assert.ok(cmdId.length > 0, 'Pending command must expose command_id');

        const approveHttp = await ctx.primaryUser.api.approveBrowserCommand(cmdId, false, false);
        assert.ok(approveHttp !== null, 'Denial request must succeed over HTTP');

        const deniedResp = await pendingExecPromise;
        assert.notEqual(deniedResp.status, 500, 'Approval denial must never return 500 Internal Server Error');
        assertBrowserRpcError(
          deniedResp,
          BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          'USER_DENIED_APPROVAL',
        );
        const deniedErr = extractBrowserErrorCode(deniedResp);
        assert.equal(
          deniedErr.code,
          BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          `Expected exact numeric code -32002, got ${deniedErr.code} (${JSON.stringify(deniedResp.data)})`,
        );

        const cartCount = await tab.eval(
          () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
        );
        assert.equal(cartCount, '0', 'Cart count must remain 0 after -32003 and -32002 rejections');
      } finally {
        await setUnifiedRunPolicy(ctx, 'always_allow_authorized');
      }

      // Post-check health
      const okStatus = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_status',
        arguments: {},
      });
      assert.equal(okStatus.status, 200);
      assert.equal(unwrapBrowserExecResult(okStatus.data).ok, true);
    });
  },
});

defineTest({
  id: 'T2-F01-03',
  title: 'Serialize exact JSON-RPC -32004 RESTRICTED_URL on chrome://version and -32005 TAB_NOT_FOUND on nonexistent tab_id 99999999',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const chromeTabId = await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      const created = await c.tabs.create({ url: 'chrome://version', active: false });
      return Number(created.id);
    });
    assert.ok(chromeTabId > 0, `Expected valid chrome.tabs id for chrome://version, got ${chromeTabId}`);

    try {
      // Wait briefly for tab URL to settle & sync
      await pollUntil(
        async () => {
          const info = await ctx.browser.evalInServiceWorker(async (id: number) => {
            const c = (globalThis as any).chrome;
            const t = await c.tabs.get(id);
            return { url: t.url ?? t.pendingUrl ?? '', status: t.status };
          }, chromeTabId);
          return info.url.startsWith('chrome://version');
        },
        { timeoutMs: 5000, intervalMs: 60, message: 'chrome://version tab ready' },
      );

      // 1. Snapshot restricted chrome://version -> -32004 RESTRICTED_URL
      const restrictedResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: chromeTabId },
      });
      assert.notEqual(restrictedResp.status, 500);
      assertBrowserRpcError(
        restrictedResp,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
      );
      const restrictedErr = extractBrowserErrorCode(restrictedResp);
      assert.equal(
        restrictedErr.code,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        `Expected exact code -32004, got ${restrictedErr.code}`,
      );
      assert.ok(restrictedErr.message.length > 0, 'RESTRICTED_URL error must include structured message');
    } finally {
      await ctx.browser
        .evalInServiceWorker(async (id: number) => {
          const c = (globalThis as any).chrome;
          await c.tabs.remove(id);
        }, chromeTabId)
        .catch(() => undefined);
    }

    // 2. Snapshot nonexistent tab_id: 99999999 -> -32005 TAB_NOT_FOUND
    const missingTabResp = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_snapshot',
      arguments: { tab_id: 99999999 },
    });
    assert.notEqual(missingTabResp.status, 500);
    assertBrowserRpcError(
      missingTabResp,
      BROWSER_RPC_ERROR_CODES.TAB_NOT_FOUND,
      'TAB_NOT_FOUND',
    );
    const missingTabErr = extractBrowserErrorCode(missingTabResp);
    assert.equal(
      missingTabErr.code,
      BROWSER_RPC_ERROR_CODES.TAB_NOT_FOUND,
      `Expected exact code -32005, got ${missingTabErr.code}`,
    );
    assert.ok(missingTabErr.message.length > 0, 'TAB_NOT_FOUND error must include structured message');

    // Verify healthy follow-up
    const statusCheck = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_status',
      arguments: {},
    });
    assert.equal(unwrapBrowserExecResult(statusCheck.data).ok, true);
  },
});

defineTest({
  id: 'T2-F01-04',
  title: 'Serialize exact JSON-RPC -32006 ELEMENT_NOT_FOUND on missing selector and -32007 NAVIGATION_TIMEOUT on /slow?ms=4000',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async () => {
      const tabId = await resolveTabIdForUrl(ctx, shopUrl);

      // 1. Missing selector -> -32006 ELEMENT_NOT_FOUND
      const missingElResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_click',
        arguments: {
          tab_id: tabId,
          selector: '#does-not-exist',
        },
      });
      assert.notEqual(missingElResp.status, 500);
      assertBrowserRpcError(
        missingElResp,
        BROWSER_RPC_ERROR_CODES.ELEMENT_NOT_FOUND,
        'ELEMENT_NOT_FOUND',
      );
      const missingElErr = extractBrowserErrorCode(missingElResp);
      assert.equal(
        missingElErr.code,
        BROWSER_RPC_ERROR_CODES.ELEMENT_NOT_FOUND,
        `Expected exact code -32006, got ${missingElErr.code}`,
      );

      // 2. Navigation exceeding timeout_ms -> -32007 NAVIGATION_TIMEOUT
      const slowNavResp = await ctx.primaryUser.api.execBrowserTool(
        {
          tool: 'browser_navigate',
          arguments: {
            tab_id: tabId,
            url: `${ctx.fixtureApp.baseUrl}/slow?ms=4000`,
            timeout_ms: 400,
          },
          timeout_ms: 6000,
        },
        10000,
      );
      assert.notEqual(slowNavResp.status, 500);
      assertBrowserRpcError(
        slowNavResp,
        BROWSER_RPC_ERROR_CODES.NAVIGATION_TIMEOUT,
        'NAVIGATION_TIMEOUT',
      );
      const slowNavErr = extractBrowserErrorCode(slowNavResp);
      assert.equal(
        slowNavErr.code,
        BROWSER_RPC_ERROR_CODES.NAVIGATION_TIMEOUT,
        `Expected exact code -32007, got ${slowNavErr.code}`,
      );
    });

    // Verify server + extension remain operational afterward
    const statusAfter = await ctx.primaryUser.api.getBrowserStatus();
    assert.ok(statusAfter.connected || statusAfter.extension_connected);
  },
});

defineTest({
  id: 'T2-F01-05',
  title: 'Serialize -32008 CDP_ATTACH_FAILED over wire contract and handle conflicting external CDP debugger session without crashing Extension SW',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    // Part A: Verify canonical -32008 CDP_ATTACH_FAILED JSON-RPC wire roundtrip through real gpui_telegram_server relay
    const isoUser = await ctx.createIsolatedUser('f01_cdp_wire');
    const probeBridge = await isoUser.api.connectServerBrowserWs();
    try {
      await probeBridge.sendHello({
        tabs_summary: [
          {
            tab_id: 505,
            window_id: 1,
            active: false,
            pinned: false,
            audible: false,
            status: 'complete',
            title: 'Debugger Conflict Tab',
            url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`,
            controllable: true,
          },
        ],
      });

      probeBridge.onInvoke(async () => {
        throw Object.assign(
          new Error('Another debugger is already attached to the tab with id: 505'),
          {
            code: BROWSER_RPC_ERROR_CODES.CDP_ATTACH_FAILED,
            errorCode: 'CDP_ATTACH_FAILED',
          },
        );
      });

      const wireResp = await isoUser.api.execBrowserTool({
        tool: 'browser_screenshot',
        arguments: { tab_id: 505, full_page: true },
      });
      assert.notEqual(wireResp.status, 500);
      assertBrowserRpcError(
        wireResp,
        BROWSER_RPC_ERROR_CODES.CDP_ATTACH_FAILED,
        'CDP_ATTACH_FAILED',
      );
      assert.equal(
        extractBrowserErrorCode(wireResp).code,
        BROWSER_RPC_ERROR_CODES.CDP_ATTACH_FAILED,
        'Server relay must preserve exact -32008 CDP_ATTACH_FAILED wire code',
      );
    } finally {
      await probeBridge.close();
    }

    // Part B: Attach a real exclusive raw CDP page debugger to a live background tab in Chromium 156
    ctx.browser.clearUncaughtExceptions();
    const bgUrl = `${ctx.fixtureApp.baseUrl}/spa/dashboard`;
    const fgUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;

    await ctx.withTargetTab(bgUrl, async () => {
      const bgTabId = await resolveTabIdForUrl(ctx, bgUrl);
      await ctx.withTargetTab(fgUrl, async () => {
        await resolveTabIdForUrl(ctx, fgUrl);

        // Locate page-level webSocketDebuggerUrl on Chromium's /json/list
        const jsonListResp = await fetch(`${ctx.browser.cdpHttpUrl}/json/list`);
        assert.equal(jsonListResp.status, 200);
        const targets = (await jsonListResp.json()) as Array<{
          id: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        const bgTarget = targets.find(
          (t) => t.type === 'page' && t.url.startsWith(bgUrl) && Boolean(t.webSocketDebuggerUrl),
        );
        assert.ok(bgTarget?.webSocketDebuggerUrl, 'Expected page webSocketDebuggerUrl for background tab');

        const externalDebuggerWs = new WebSocket(bgTarget.webSocketDebuggerUrl!);
        try {
          await new Promise<void>((resolve, reject) => {
            externalDebuggerWs.once('open', () => resolve());
            externalDebuggerWs.once('error', reject);
          });
          externalDebuggerWs.send(JSON.stringify({ id: 1, method: 'Debugger.enable', params: {} }));
          await sleep(100);

          // Invoke CDP-dependent operation on background tab while external debugger holds attachment
          const conflictResp = await ctx.primaryUser.api.execBrowserTool(
            {
              tool: 'browser_screenshot',
              arguments: { tab_id: bgTabId, full_page: true },
              timeout_ms: 6000,
            },
            8000,
          );
          assert.notEqual(conflictResp.status, 500, 'CDP conflict must not cause 500 server error');

          const unwrapped = unwrapBrowserExecResult(conflictResp.data);
          if (unwrapped?.ok !== true) {
            assertBrowserRpcError(
              conflictResp,
              BROWSER_RPC_ERROR_CODES.CDP_ATTACH_FAILED,
              'CDP_ATTACH_FAILED',
            );
          } else {
            // Clean fallback diagnostic/capture succeeded without crashing SW
            assert.ok(
              typeof unwrapped.data_base64 === 'string' && unwrapped.data_base64.length > 0,
              'Fallback screenshot must still return non-empty base64 image',
            );
          }

          const swExceptions = ctx.browser.uncaughtExceptions.filter(
            (e) => e.targetType === 'service_worker',
          );
          assert.equal(
            swExceptions.length,
            0,
            `Extension Service Worker must not throw uncaught exceptions on CDP conflict: ${JSON.stringify(swExceptions)}`,
          );
        } finally {
          externalDebuggerWs.terminate();
        }
      });
    });

    // Verify Extension SW remains healthy
    const postCheck = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_status',
      arguments: {},
    });
    assert.equal(unwrapBrowserExecResult(postCheck.data).ok, true);
  },
});

defineTest({
  id: 'T2-F01-06',
  title: 'Handle malformed non-JSON WS frames (-32700), unknown JSON-RPC methods (-32601), and malformed REST browser/exec payloads (400/422)',
  tier: 2,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.server.isRunning());
    const isoUser = await ctx.createIsolatedUser('f01_malformed');

    // 1. Send malformed non-JSON text frame "{not_json" over /api/v1/browser/ws -> must yield -32700 or non-1000 protocol close
    let wsProbe = await isoUser.api.connectServerBrowserWs();
    try {
      let malformedCloseCode: number | undefined;
      wsProbe.ws.once('close', (code) => {
        malformedCloseCode = code;
      });

      await wsProbe.sendHello();
      const msgCountBefore = wsProbe.messages.length;
      await new Promise<void>((resolve, reject) => {
        wsProbe.ws.send('{not_json', (err) => (err ? reject(err) : resolve()));
      });

      const parseErrOrClose = await pollUntil(
        async () => {
          const newer = wsProbe.messages.slice(msgCountBefore);
          const errFrame = newer.find((m) => m?.error !== undefined);
          if (errFrame) return { closed: false, msg: errFrame };
          if (!wsProbe.isOpen()) return { closed: true, msg: null };
          return null;
        },
        {
          timeoutMs: 4000,
          intervalMs: 50,
          message: 'JSON-RPC -32700 Parse error or protocol close for "{not_json"',
        },
      );

      assert.ok(parseErrOrClose, 'Expected -32700 Parse error or protocol close for "{not_json"');
      if (parseErrOrClose.msg !== null) {
        assert.ok(
          parseErrOrClose.msg?.error,
          `Expected JSON-RPC error object for "{not_json", got ${JSON.stringify(parseErrOrClose.msg)}`,
        );
        assert.equal(
          parseErrOrClose.msg.error.code,
          -32700,
          `Expected JSON-RPC -32700 Parse error for "{not_json", got ${JSON.stringify(parseErrOrClose.msg)}`,
        );
      } else {
        assert.equal(parseErrOrClose.closed, true);
        assert.ok(
          malformedCloseCode !== undefined && malformedCloseCode !== 1000,
          `Malformed JSON close must use non-1000 protocol/policy close code, got ${String(malformedCloseCode)}`,
        );
      }
      assert.ok(ctx.server.isRunning(), 'Server must remain running after malformed WS frame');

      // 2. Send unknown JSON-RPC method: "bridge.nonexistent" -> must unconditionally return -32601 Method not found
      if (!wsProbe.isOpen()) {
        wsProbe = await isoUser.api.connectServerBrowserWs();
        await wsProbe.sendHello();
      }
      const beforeUnknownIdx = wsProbe.messages.length;
      await wsProbe.sendRaw({
        jsonrpc: '2.0',
        id: 'unknown_method_req_1',
        method: 'bridge.nonexistent',
        params: {},
      });

      const methodErr = await pollUntil(
        () =>
          wsProbe.messages
            .slice(beforeUnknownIdx)
            .find((m) => m?.id === 'unknown_method_req_1' || m?.error !== undefined) ?? null,
        {
          timeoutMs: 4000,
          intervalMs: 50,
          message: 'JSON-RPC -32601 Method not found for bridge.nonexistent',
        },
      );
      assert.ok(
        methodErr?.error,
        `Expected JSON-RPC error frame for bridge.nonexistent, got ${JSON.stringify(methodErr)}`,
      );
      assert.equal(
        methodErr.error.code,
        -32601,
        `Expected JSON-RPC -32601 Method not found for bridge.nonexistent, got ${JSON.stringify(methodErr)}`,
      );
    } finally {
      await wsProbe.close();
    }

    // 3. Malformed REST body on POST /api/v1/browser/exec (missing required `tool` field)
    const missingToolResp = await ctx.primaryUser.api.request(
      'POST',
      '/api/v1/browser/exec',
      { arguments: { tab_id: 1 } },
    );
    assert.ok(
      missingToolResp.status === 400 || missingToolResp.status === 422,
      `Expected HTTP 400 or 422 when missing required 'tool' field, got ${missingToolResp.status}: ${missingToolResp.rawText}`,
    );

    // 4. Truncated raw JSON body on POST /api/v1/browser/exec
    const truncatedJsonResp = await ctx.primaryUser.api.request(
      'POST',
      '/api/v1/browser/exec',
      undefined,
      {
        rawBody: '{"tool":"browser_status","arguments":',
        contentType: 'application/json',
      },
    );
    assert.ok(
      truncatedJsonResp.status === 400 || truncatedJsonResp.status === 422,
      `Expected HTTP 400 or 422 on truncated JSON body, got ${truncatedJsonResp.status}`,
    );

    // Verify server and extension relay remain healthy
    assert.ok(ctx.server.isRunning(), 'Server must remain healthy after malformed frame/REST tests');
    const finalStatus = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_status',
      arguments: {},
    });
    assert.equal(finalStatus.status, 200);
    assert.equal(unwrapBrowserExecResult(finalStatus.data).ok, true);
  },
});
