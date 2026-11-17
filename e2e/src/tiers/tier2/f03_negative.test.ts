import {
  BROWSER_RPC_ERROR_CODES,
  assert,
  assertBrowserRpcError,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function resolvePrimaryTabId(
  ctx: SharedTierContext,
  urlPrefix: string,
): Promise<number> {
  return await pollUntil(
    async () => {
      const swId = await ctx.browser.evalInServiceWorker((prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        return c.tabs.query({}).then((tabs: any[]) => {
          const m = tabs.find(
            (t) => typeof t.url === 'string' && t.url.startsWith(prefix) && typeof t.id === 'number',
          );
          return m ? Number(m.id) : null;
        });
      }, urlPrefix);
      if (typeof swId === 'number' && swId > 0) return swId;
      const list = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const found = list?.tabs?.find(
        (t: any) => typeof t.url === 'string' && t.url.startsWith(urlPrefix),
      );
      return typeof found?.tab_id === 'number' ? found.tab_id : null;
    },
    { timeoutMs: 6000, intervalMs: 80, message: `resolve tab_id for ${urlPrefix}` },
  ).then((id) => {
    assert.ok(typeof id === 'number' && id > 0);
    return id;
  });
}

// Deterministic valid 1x1 PNG header/image bytes for constructing valid 2.5 MiB screenshot payloads
const MINIMAL_VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

defineTest({
  id: 'T2-F03-01',
  title: 'Reject missing and forged Bearer tokens across /api/v1/browser/* and /api/v1/bots/777000/browser with HTTP 401 invalid_token',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.server.isRunning(), 'gpui_telegram_server must be running before 401 checks');

    const endpoints: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/v1/browser/status' },
      { method: 'GET', path: '/api/v1/browser/tabs' },
      {
        method: 'POST',
        path: '/api/v1/browser/exec',
        body: { tool: 'browser_status', arguments: {} },
      },
      {
        method: 'PUT',
        path: '/api/v1/bots/777000/browser',
        body: { enabled: true, run_policy: 'always_allow_authorized' },
      },
    ];

    for (const ep of endpoints) {
      // 1. Missing Authorization header
      const missingRes = await ctx.primaryUser.api.request(ep.method, ep.path, ep.body, {
        token: null,
      });
      assert.equal(
        missingRes.status,
        401,
        `Expected HTTP 401 for unauthenticated ${ep.method} ${ep.path}, got ${missingRes.status}: ${missingRes.rawText}`,
      );
      assert.ok(
        /missing_token|invalid_token|unauthorized/i.test(missingRes.rawText),
        `Expected structured auth error code on ${ep.method} ${ep.path}, got ${missingRes.rawText}`,
      );

      // 2. Forged Bearer token ("bad_token_xyz")
      const forgedRes = await ctx.primaryUser.api.request(ep.method, ep.path, ep.body, {
        token: 'bad_token_xyz',
      });
      assert.equal(
        forgedRes.status,
        401,
        `Expected HTTP 401 for forged Bearer token on ${ep.method} ${ep.path}, got ${forgedRes.status}: ${forgedRes.rawText}`,
      );
      assert.ok(
        /invalid_token|unauthorized/i.test(forgedRes.rawText),
        `Expected invalid_token error on ${ep.method} ${ep.path}, got ${forgedRes.rawText}`,
      );
    }

    // Verify authenticated primaryUser request succeeds immediately afterward
    const validStatus = await ctx.primaryUser.api.getBrowserStatus();
    assert.ok(validStatus.connected || validStatus.extension_connected);
  },
});

defineTest({
  id: 'T2-F03-02',
  title: 'Enforce cross-user ACL isolation preventing intruderUser from reading primaryUser tabs or approving primaryUser pending commands',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    const intruderUser = await ctx.createIsolatedUser('intruder_f03');

    await ctx.withTargetTab(shopUrl, async (tab) => {
      const primaryTabId = await resolvePrimaryTabId(ctx, shopUrl);

      // Ensure primaryUser genuinely sees the tab
      await pollUntil(
        async () => {
          const primaryTabs = await ctx.primaryUser.api.getBrowserTabs();
          return primaryTabs.tabs.some((t: any) => t.tab_id === primaryTabId || String(t.url).startsWith(shopUrl));
        },
        { timeoutMs: 5000, intervalMs: 80, message: 'primaryUser /api/v1/browser/tabs synced' },
      );

      // 1. Intruder has no connected extension and sees zero tabs of primaryUser
      const intruderStatus = await intruderUser.api.getBrowserStatus();
      assert.equal(
        Boolean(intruderStatus.connected || intruderStatus.extension_connected),
        false,
        `intruderUser must not inherit primaryUser extension connection: ${JSON.stringify(intruderStatus)}`,
      );
      const intruderTabs = await intruderUser.api.getBrowserTabs();
      assert.equal(
        intruderTabs.tabs.length,
        0,
        `intruderUser must see 0 tabs, got ${JSON.stringify(intruderTabs.tabs)}`,
      );

      // 2. Intruder attempts POST /api/v1/browser/exec targeting primaryUser's tab_id
      const hijackExec = await intruderUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: primaryTabId },
      });
      assert.notEqual(hijackExec.status, 500);
      const hijackUnwrapped = unwrapBrowserExecResult(hijackExec.data);
      assert.notEqual(
        hijackUnwrapped?.ok,
        true,
        `intruderUser must never succeed executing browser_snapshot on primaryUser tab: ${hijackExec.rawText}`,
      );
      assert.ok(
        !hijackExec.rawText.includes('Fabushi Gear Store'),
        'Cross-user exec error must never leak primaryUser page content',
      );
      assert.ok(
        hijackExec.status === 403 ||
          hijackExec.status === 404 ||
          hijackExec.status === 400 ||
          hijackExec.status === 409 ||
          hijackExec.status === 503 ||
          /not_connected|not connected|no browser|unauthorized|forbidden|tab_not_found/i.test(
            hijackExec.rawText,
          ),
        `Expected disconnected/ACL rejection for intruderUser exec, got HTTP ${hijackExec.status}: ${hijackExec.rawText}`,
      );

      // 3. Queue a pending approval for primaryUser, then attempt cross-user approval hijack by intruderUser
      await ctx.primaryUser.api.setBotBrowserProfile(777000, {
        enabled: true,
        run_policy: 'ask_every_time',
        allowed_domains: [],
        blocked_domains: [],
        preferred_target: 'extension',
      });

      const pendingExecPromise = ctx.primaryUser.api.execBrowserTool(
        {
          tool: 'browser_click',
          arguments: {
            tab_id: primaryTabId,
            selector: 'button.add-to-cart-btn[data-sku="SKU-KB-01"]',
          },
          bot_id: 777000,
          timeout_ms: 12000,
        },
        15000,
      );

      try {
        const pendingItem = await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return items.find((i: any) => i.tool === 'browser_click') ?? items[0] ?? null;
          },
          { timeoutMs: 6000, intervalMs: 80, message: 'primaryUser pending command' },
        );
        const primaryCommandId = String(pendingItem.command_id ?? pendingItem.id);

        // Intruder cannot list primaryUser's pending command
        const intruderPending = await intruderUser.api.getPendingBrowserCommands();
        assert.ok(
          !intruderPending.items.some(
            (i: any) => String(i.command_id ?? i.id) === primaryCommandId,
          ),
          'intruderUser must not see primaryUser pending browser commands',
        );

        // Intruder attempts to approve primaryUser's command_id
        const hijackApprove = await intruderUser.api.request(
          'POST',
          `/api/v1/browser/commands/${encodeURIComponent(primaryCommandId)}/approve`,
          { approved: true },
        );
        assert.ok(
          hijackApprove.status === 403 ||
            hijackApprove.status === 404 ||
            hijackApprove.data?.ok === false,
          `Expected 403/404 when intruderUser attempts to approve primaryCommandId, got HTTP ${hijackApprove.status}: ${hijackApprove.rawText}`,
        );

        // Verify live DOM was NOT mutated by intruder's forged approval
        const cartCountAfterHijack = await tab.eval(
          () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
        );
        assert.equal(cartCountAfterHijack, '0', 'Cart count must remain 0 after rejected cross-user approval');

        // Cleanly deny as legitimate primaryUser
        await ctx.primaryUser.api.approveBrowserCommand(primaryCommandId, false);
        const settled = await pendingExecPromise;
        assertBrowserRpcError(
          settled,
          BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          'USER_DENIED_APPROVAL',
        );
      } finally {
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });
      }
    });
  },
});

defineTest({
  id: 'T2-F03-03',
  title: 'Fail pending AskEveryTime browser_click immediately with -32002 USER_DENIED_APPROVAL upon approved: false while keeping #cart-count at 0',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (tab) => {
      const tabId = await resolvePrimaryTabId(ctx, shopUrl);
      assert.equal(
        await tab.eval(() => document.getElementById('cart-count')?.textContent?.trim()),
        '0',
      );

      await ctx.primaryUser.api.setBotBrowserProfile(777000, {
        enabled: true,
        run_policy: 'ask_every_time',
        allowed_domains: [],
        blocked_domains: [],
        preferred_target: 'extension',
      });

      try {
        const execFuture = ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: {
              tab_id: tabId,
              selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
            timeout_ms: 15000,
          },
          20000,
        );

        const pending = await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return items.find((i: any) => i.tool === 'browser_click') ?? items[0] ?? null;
          },
          { timeoutMs: 6000, intervalMs: 70, message: 'pending browser_click waiter' },
        );
        const cmdId = String(pending.command_id ?? pending.id);

        const denyStartMs = Date.now();
        await ctx.primaryUser.api.approveBrowserCommand(cmdId, false, false);
        const deniedResp = await execFuture;
        const denyLatencyMs = Date.now() - denyStartMs;

        assert.ok(
          denyLatencyMs < 2000,
          `Expected pending exec to fail immediately (<2000ms) after denial, took ${denyLatencyMs}ms`,
        );
        assertBrowserRpcError(
          deniedResp,
          BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          'USER_DENIED_APPROVAL',
        );

        const cartCount = await tab.eval(
          () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
        );
        assert.equal(cartCount, '0', '#cart-count on live /shop tab must stay 0');
        assert.equal(ctx.fixtureApp.cartItems.length, 0, 'Zero cart POST requests may fire on denied click');
      } finally {
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });
      }
    });
  },
});

defineTest({
  id: 'T2-F03-04',
  title: 'Expire unapproved AskEveryTime waiter cleanly after timeout_ms: 600 and purge stale command from /api/v1/browser/commands/pending',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (tab) => {
      const tabId = await resolvePrimaryTabId(ctx, shopUrl);

      await ctx.primaryUser.api.setBotBrowserProfile(777000, {
        enabled: true,
        run_policy: 'ask_every_time',
        allowed_domains: [],
        blocked_domains: [],
        preferred_target: 'extension',
      });

      try {
        const startMs = Date.now();
        const expiredResp = await ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: {
              tab_id: tabId,
              selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
            timeout_ms: 600,
          },
          8000,
        );
        const elapsedMs = Date.now() - startMs;

        assert.ok(
          elapsedMs >= 450 && elapsedMs < 3500,
          `Expected ~600ms approval timeout expiry, got ${elapsedMs}ms`,
        );
        assert.notEqual(expiredResp.status, 500);
        const unwrapped = unwrapBrowserExecResult(expiredResp.data);
        assert.notEqual(
          unwrapped?.ok,
          true,
          `Unapproved command must not succeed after timeout_ms: 600: ${expiredResp.rawText}`,
        );

        // Verify stale waiter was cleaned up from pending commands list
        await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return items.length === 0;
          },
          {
            timeoutMs: 2000,
            intervalMs: 80,
            message: 'stale expired approval waiter purged from pending queue',
          },
        );

        const cartCount = await tab.eval(
          () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
        );
        assert.equal(cartCount, '0', 'Expired unapproved click must not mutate target DOM');
      } finally {
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });
      }
    });
  },
});

defineTest({
  id: 'T2-F03-05',
  title: 'Resolve in-flight POST /api/v1/browser/exec fast (< 1.5s, not 20s) when extension WS abruptly terminates mid-request and mark connected: false',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const isoUser = await ctx.createIsolatedUser('f03_drop_ws');
    const synthExt = await isoUser.api.connectServerBrowserWs();

    await synthExt.sendHello({
      tabs_summary: [
        {
          tab_id: 7701,
          window_id: 1,
          active: true,
          pinned: false,
          audible: false,
          status: 'complete',
          title: 'Mid-Flight Drop Tab',
          url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
          controllable: true,
        },
      ],
    });

    await pollUntil(
      async () => {
        const st = await isoUser.api.getBrowserStatus();
        return Boolean(st.connected || st.extension_connected || st.server_relay_connected);
      },
      { timeoutMs: 4000, intervalMs: 60, message: 'isoUser extension connected: true' },
    );

    let terminatedAtMs = 0;
    synthExt.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf-8'));
        if (msg?.method === 'browser.invoke') {
          terminatedAtMs = Date.now();
          synthExt.ws.terminate();
        }
      } catch {
        // Ignore
      }
    });

    const execResp = await isoUser.api.execBrowserTool(
      {
        tool: 'browser_snapshot',
        arguments: { tab_id: 7701 },
        timeout_ms: 20000,
      },
      10000,
    );
    const resolvedAtMs = Date.now();

    assert.ok(terminatedAtMs > 0, 'Expected server to dispatch browser.invoke over WS before socket drop');
    const abortDurationMs = resolvedAtMs - terminatedAtMs;
    assert.ok(
      abortDurationMs < 1500,
      `In-flight waiter must fast-abort upon WS socket drop (<1500ms, not 20s); took ${abortDurationMs}ms`,
    );

    const unwrapped = unwrapBrowserExecResult(execResp.data);
    assert.notEqual(unwrapped?.ok, true, 'Aborted mid-flight exec must not return ok: true');

    // Status for isoUser must reflect disconnected state
    await pollUntil(
      async () => {
        const st = await isoUser.api.getBrowserStatus();
        return !st.connected && !st.extension_connected;
      },
      { timeoutMs: 3000, intervalMs: 60, message: 'isoUser connected: false after WS drop' },
    );

    // Primary user's extension session must remain completely unaffected
    const primaryStatus = await ctx.primaryUser.api.getBrowserStatus();
    assert.ok(
      primaryStatus.connected || primaryStatus.extension_connected,
      'primaryUser browser relay must remain connected',
    );
  },
});

defineTest({
  id: 'T2-F03-06',
  title: 'Transfer 2.5 MiB base64 screenshot payload cleanly over /api/v1/browser/ws while rejecting > 33 MiB oversized WS frames without panicking server',
  tier: 2,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const isoUser = await ctx.createIsolatedUser('f03_payload_bounds');
    const wsBridge = await isoUser.api.connectServerBrowserWs();

    try {
      await wsBridge.sendHello({
        tabs_summary: [
          {
            tab_id: 8801,
            window_id: 1,
            active: true,
            pinned: false,
            audible: false,
            status: 'complete',
            title: 'Large Screenshot Tab',
            url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`,
            controllable: true,
          },
        ],
      });

      // 1. Construct >= 2.5 MiB base64 payload (~1.95 MiB binary -> ~2.60 MiB base64, well within 32 MiB max frame limit)
      const binaryBuf = Buffer.concat([MINIMAL_VALID_PNG, Buffer.alloc(1_950_000, 0x5a)]);
      const largeBase64 = binaryBuf.toString('base64');
      assert.ok(
        largeBase64.length >= 2_500_000,
        `Expected >= 2.5M base64 chars, got ${largeBase64.length}`,
      );

      wsBridge.onInvoke(async (_id, params) => {
        assert.equal(params.tool, 'browser_screenshot');
        return {
          ok: true,
          tab_id: 8801,
          url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`,
          title: 'Large Screenshot Tab',
          mime_type: 'image/png',
          data_base64: largeBase64,
          width: 1440,
          height: 2600,
        };
      });

      const okShotResp = await isoUser.api.execBrowserTool(
        {
          tool: 'browser_screenshot',
          arguments: { tab_id: 8801, full_page: true },
          timeout_ms: 15000,
        },
        20000,
      );
      assert.equal(
        okShotResp.status,
        200,
        `2.5 MiB screenshot WS result must return HTTP 200, got ${okShotResp.status}`,
      );
      const unwrappedShot = unwrapBrowserExecResult(okShotResp.data);
      assert.equal(unwrappedShot.ok, true);
      const returnedB64 =
        unwrappedShot.data_base64 ?? unwrappedShot.artifact?.data_base64 ?? '';
      assert.equal(
        returnedB64.length,
        largeBase64.length,
        '2.5 MiB base64 screenshot must arrive intact without truncation',
      );

      // 2. Send oversized > 33 MiB JSON-RPC frame (exceeding 32 MiB max frame limit)
      const oversizedPad = 'A'.repeat(33_800_000);
      const oversizedFrame = JSON.stringify({
        jsonrpc: '2.0',
        method: 'bridge.tabs_sync',
        params: {
          tabs: [],
          run_policy: 'always_allow_authorized',
          oversized_pad: oversizedPad,
        },
      });
      assert.ok(oversizedFrame.length > 33 * 1024 * 1024);

      await new Promise<void>((resolve) => {
        wsBridge.ws.send(oversizedFrame, () => resolve());
      });

      const rejectedOversized = await pollUntil(
        async () => {
          if (!wsBridge.isOpen()) return true;
          return wsBridge.messages.some((m) => m?.error !== undefined);
        },
        {
          timeoutMs: 5000,
          intervalMs: 80,
          message: '>33 MiB WS frame rejected or closed by server',
        },
      );
      assert.equal(rejectedOversized, true, 'Server must reject or close > 33 MiB WebSocket frame');
    } finally {
      await wsBridge.close();
    }

    // Confirm gpui_telegram_server did NOT panic and still serves primaryUser cleanly
    assert.ok(ctx.server.isRunning(), 'gpui_telegram_server must remain alive after > 33 MiB frame');
    const postHealth = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_status',
      arguments: {},
    });
    assert.equal(postHealth.status, 200);
    assert.equal(unwrapBrowserExecResult(postHealth.data).ok, true);
  },
});
