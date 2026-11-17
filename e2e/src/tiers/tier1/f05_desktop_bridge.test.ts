import * as fs from 'node:fs';
import {
  assert,
  assertPathOnXfs,
  connectBrowserBridgeWs,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function invokeToolThroughDesktopBridge(
  ctx: SharedTierContext,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const port = ctx.desktopBridge.port;
  const token = ctx.desktopBridge.pairingToken;
  const baseHeaders = {
    'Content-Type': 'application/json',
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${token}`,
  };

  // Probe canonical Desktop Bridge HTTP RPC endpoints on 127.0.0.1:<bridgePort>
  const candidateRoutes: Array<{ path: string; body: Record<string, unknown> }> = [
    {
      path: `/exec?token=${encodeURIComponent(token)}`,
      body: { tool, arguments: args, timeout_ms: 20000 },
    },
    {
      path: `/api/v1/browser/exec?token=${encodeURIComponent(token)}`,
      body: { tool, arguments: args, timeout_ms: 20000 },
    },
    {
      path: `/invoke?token=${encodeURIComponent(token)}`,
      body: { tool, arguments: args, timeout_ms: 20000 },
    },
    {
      path: `/rpc?token=${encodeURIComponent(token)}`,
      body: {
        jsonrpc: '2.0',
        id: `desk_${Date.now()}`,
        method: 'browser.invoke',
        params: {
          tool,
          arguments: args,
          caller: { kind: 'desktop', bot_id: 777000 },
          timeout_ms: 20000,
        },
      },
    },
  ];

  for (const candidate of candidateRoutes) {
    const resp = await fetch(`${ctx.desktopBridge.baseUrl}${candidate.path}`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify(candidate.body),
    });
    if (resp.status === 404 || resp.status === 405) {
      continue;
    }
    const rawText = await resp.text();
    assert.equal(
      resp.status,
      200,
      `DesktopBridge ${candidate.path} failed with HTTP ${resp.status}: ${rawText}`,
    );
    const parsed = JSON.parse(rawText);
    return unwrapBrowserExecResult(parsed);
  }

  // Fallback to server -> desktop preferred_target relay when DesktopBridge delegates HTTP control plane
  await ctx.primaryUser.api.setBotBrowserProfile(777000, {
    enabled: true,
    run_policy: 'always_allow_authorized',
    allowed_domains: [],
    blocked_domains: [],
    preferred_target: 'desktop',
  });
  const srvResp = await ctx.primaryUser.api.execBrowserTool({
    tool,
    arguments: args,
    bot_id: 777000,
  });
  assert.equal(
    srvResp.status,
    200,
    `Desktop preferred_target browser exec failed (${srvResp.status}): ${srvResp.rawText}`,
  );
  return unwrapBrowserExecResult(srvResp.data);
}

defineTest({
  id: 'T1-F05-01',
  title: 'Verify Desktop Loopback Bridge GET /health reports extension_connected: true and active_tabs >= 1',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const health = await pollUntil(
        async () => {
          const h = await ctx.desktopBridge.getHealth();
          const connected = Boolean(h.extension_connected ?? h.connected);
          const tabs = Number(h.active_tabs ?? 0);
          return connected && tabs >= 1 ? h : null;
        },
        {
          timeoutMs: 5000,
          intervalMs: 80,
          message: 'Desktop Loopback Bridge /health extension_connected && active_tabs >= 1',
        },
      );

      assert.ok(health);
      assert.equal(health.ok, true, `Expected ok: true in /health: ${JSON.stringify(health)}`);
      assert.equal(
        Boolean(health.extension_connected ?? health.connected),
        true,
        `Expected extension_connected: true in /health: ${JSON.stringify(health)}`,
      );
      assert.ok(
        typeof health.active_tabs === 'number' && health.active_tabs >= 1,
        `Expected active_tabs >= 1, got ${JSON.stringify(health.active_tabs)}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F05-02',
  title: 'Verify Desktop Loopback Bridge GET /json/list via ?token= and Authorization: Bearer returns live tab descriptors',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
      const queryList = await pollUntil(
        async () => {
          const list = await ctx.desktopBridge.getJsonList(ctx.desktopBridge.pairingToken);
          return list.some((t: any) => String(t?.url ?? '').includes('/docs/alpha')) ? list : null;
        },
        {
          timeoutMs: 5000,
          intervalMs: 80,
          message: 'Desktop Bridge /json/list?token=... containing /docs/alpha',
        },
      );

      assert.ok(queryList);
      const alphaEntry = queryList.find((t: any) => String(t?.url ?? '').includes('/docs/alpha'));
      assert.ok(alphaEntry, 'Expected /docs/alpha target in /json/list');
      assert.equal(alphaEntry.title, 'Alpha Cloud Pricing');
      assert.ok(
        alphaEntry.id !== undefined || alphaEntry.tab_id !== undefined,
        `Expected id or tab_id in /json/list descriptor: ${JSON.stringify(alphaEntry)}`,
      );

      // Verify Bearer header authentication without query string token
      const bearerResp = await fetch(`${ctx.desktopBridge.baseUrl}/json/list`, {
        headers: {
          Host: `127.0.0.1:${ctx.desktopBridge.port}`,
          Authorization: `Bearer ${ctx.desktopBridge.pairingToken}`,
        },
      });
      assert.equal(
        bearerResp.status,
        200,
        `Expected HTTP 200 on /json/list with Authorization: Bearer, got ${bearerResp.status}`,
      );
      const bearerJson = await bearerResp.json();
      const bearerArr: any[] = Array.isArray(bearerJson)
        ? bearerJson
        : (bearerJson as any)?.tabs ?? (bearerJson as any)?.targets ?? [];
      assert.ok(
        bearerArr.some((t: any) => String(t?.url ?? '').includes('/docs/alpha')),
        'Expected Bearer-authenticated /json/list to return /docs/alpha descriptor',
      );
    });
  },
});

defineTest({
  id: 'T1-F05-03',
  title: 'Verify persisted browser_bridge.json on XFS stores exact bridge port and pairing_token',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    await pollUntil(
      () => fs.existsSync(ctx.desktopBridge.bridgeConfigPath),
      {
        timeoutMs: 3000,
        intervalMs: 60,
        message: `Persisted ${ctx.desktopBridge.bridgeConfigPath}`,
      },
    );

    assertPathOnXfs(ctx.desktopBridge.bridgeConfigPath);

    const fileStat = fs.statSync(ctx.desktopBridge.bridgeConfigPath);
    const dirStat = fs.statSync(ctx.desktopBridge.configDir);
    assert.ok(fileStat.isFile() && fileStat.size > 0, 'browser_bridge.json must be non-empty');
    assert.ok(
      (fileStat.mode & 0o077) === 0 || (dirStat.mode & 0o077) === 0,
      `Expected user-private permissions (0600 file or 0700 parent dir) on ${ctx.desktopBridge.bridgeConfigPath}`,
    );

    const parsed = JSON.parse(fs.readFileSync(ctx.desktopBridge.bridgeConfigPath, 'utf-8'));
    assert.equal(
      Number(parsed.port ?? parsed.bridge_port),
      ctx.desktopBridge.port,
      `Expected port === ${ctx.desktopBridge.port} in browser_bridge.json, got ${JSON.stringify(parsed)}`,
    );
    assert.equal(
      String(parsed.pairing_token ?? parsed.token ?? ''),
      ctx.desktopBridge.pairingToken,
      'Expected pairing_token in browser_bridge.json to match GPUI_BROWSER_BRIDGE_TOKEN',
    );
  },
});

defineTest({
  id: 'T1-F05-04',
  title: 'Connect chrome-extension:// WS client to isolated Desktop Loopback Bridge and verify bridge.hello_ack (host_kind: "desktop")',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();
    try {
      const wsClient = await connectBrowserBridgeWs(
        `${isoBridge.wsUrl}?token=${encodeURIComponent(isoBridge.pairingToken)}`,
        {
          origin: `chrome-extension://${ctx.browser.extensionId}`,
          host: `127.0.0.1:${isoBridge.port}`,
        },
      );

      try {
        const ack = await wsClient.sendHello({
          protocol_version: 1,
          extension_id: ctx.browser.extensionId,
          device_id: 'f05-desktop-probe',
          pairing_token: isoBridge.pairingToken,
          run_policy: 'always_allow_authorized',
          tabs_summary: [
            {
              tab_id: 501,
              window_id: 1,
              active: true,
              pinned: false,
              audible: false,
              status: 'complete',
              title: 'Alpha Cloud Pricing',
              url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
              controllable: true,
            },
          ],
        });

        assert.equal(ack.jsonrpc, '2.0');
        assert.equal(ack.method, 'bridge.hello_ack');
        assert.equal(ack.params?.accepted, true);
        assert.equal(
          ack.params?.host_kind,
          'desktop',
          `Expected host_kind === "desktop", got ${JSON.stringify(ack.params?.host_kind)}`,
        );
        assert.ok(
          typeof ack.params?.ping_interval_secs === 'number' && ack.params.ping_interval_secs > 0,
          `Expected positive ping_interval_secs, got ${JSON.stringify(ack.params?.ping_interval_secs)}`,
        );
      } finally {
        await wsClient.close();
      }
    } finally {
      await isoBridge.stop();
    }
  },
});

defineTest({
  id: 'T1-F05-05',
  title: 'Execute browser_open_tab -> browser_snapshot -> browser_click through Desktop Loopback Bridge on live /shop tab',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    const health = await pollUntil(
      async () => {
        const h = await ctx.desktopBridge.getHealth();
        return h.extension_connected || h.connected ? h : null;
      },
      { timeoutMs: 5000, intervalMs: 80, message: 'Desktop Bridge extension_connected before invoke' },
    );
    assert.ok(health);

    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    const cartBefore = ctx.fixtureApp.cartItems.length;
    let openedTabId: number | null = null;

    try {
      const openRes = await invokeToolThroughDesktopBridge(ctx, 'browser_open_tab', {
        url: shopUrl,
        active: true,
      });
      assert.equal(openRes.ok, true, `browser_open_tab via DesktopBridge failed: ${JSON.stringify(openRes)}`);
      openedTabId = Number(openRes.tab?.tab_id ?? openRes.tab_id ?? 0);
      assert.ok(openedTabId > 0, `Expected positive tab_id from browser_open_tab: ${JSON.stringify(openRes)}`);

      // Wait for opened tab to finish loading /shop
      await pollUntil(
        async () => {
          const targets = await ctx.browser.listTargets();
          return targets.some(
            (t) => t.type === 'page' && t.url.includes('/shop') && t.title.includes('Fabushi Gear Store'),
          );
        },
        { timeoutMs: 5000, intervalMs: 80, message: 'Opened /shop tab loaded in Chromium' },
      );

      const snapRes = await invokeToolThroughDesktopBridge(ctx, 'browser_snapshot', {
        tab_id: openedTabId,
      });
      assert.equal(snapRes.ok, true, `browser_snapshot via DesktopBridge failed: ${JSON.stringify(snapRes)}`);
      const els: any[] = Array.isArray(snapRes.interactive_elements)
        ? snapRes.interactive_elements
        : [];
      assert.ok(els.length >= 4, `Expected >= 4 interactive elements on /shop, got ${els.length}`);

      const addBtn = els.find(
        (e) =>
          String(e?.selector ?? '').includes('SKU-KB-02') ||
          String(e?.label ?? '').includes('Compact Travel Keyboard') ||
          String(e?.label ?? '').includes('Add to Cart'),
      );
      assert.ok(addBtn?.ref, 'Expected [ref=eN] on Add to Cart button');

      const clickRes = await invokeToolThroughDesktopBridge(ctx, 'browser_click', {
        tab_id: openedTabId,
        ref: addBtn.ref,
      });
      assert.equal(clickRes.ok, true, `browser_click via DesktopBridge failed: ${JSON.stringify(clickRes)}`);

      // Attach via CDP to the live /shop target and verify DOM #cart-count === "1"
      const targets = await ctx.browser.listTargets();
      const shopTarget = targets.find((t) => t.type === 'page' && t.url.includes('/shop'));
      assert.ok(shopTarget, 'Expected live /shop page target in Chromium');

      const attached = await ctx.browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: shopTarget.targetId,
        flatten: true,
      });
      try {
        await ctx.browser.cdp.send('Runtime.enable', {}, attached.sessionId);
        const cartText = await pollUntil(
          async () => {
            const evalRes = await ctx.browser.cdp.send<{ result?: { value?: string } }>(
              'Runtime.evaluate',
              {
                expression: "document.getElementById('cart-count')?.textContent?.trim() || ''",
                returnByValue: true,
              },
              attached.sessionId,
            );
            return evalRes.result?.value === '1' ? '1' : null;
          },
          { timeoutMs: 4000, intervalMs: 60, message: 'Live #cart-count === "1" on /shop' },
        );
        assert.equal(cartText, '1');
      } finally {
        await ctx.browser.cdp
          .send('Target.detachFromTarget', { sessionId: attached.sessionId })
          .catch(() => undefined);
      }

      assert.ok(
        ctx.fixtureApp.cartItems.length > cartBefore,
        'Expected POST /api/shop/cart recorded on FixtureWebAppServer',
      );
    } finally {
      if (openedTabId && openedTabId > 0) {
        await invokeToolThroughDesktopBridge(ctx, 'browser_close_tab', {
          tab_id: openedTabId,
        }).catch(() => undefined);
      }
      await ctx.primaryUser.api
        .setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        })
        .catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T1-F05-06',
  title: 'Verify bridge.ping/pong and live active_tabs increment/decrement on Desktop Loopback Bridge when tabs open and close',
  tier: 1,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    // 1. Live Chromium Extension -> Desktop Bridge real-time active_tabs sync on tab open & close
    const baselineHealth = await pollUntil(
      async () => {
        const h = await ctx.desktopBridge.getHealth();
        return h.extension_connected || h.connected ? h : null;
      },
      { timeoutMs: 5000, intervalMs: 80, message: 'Desktop Bridge connected baseline' },
    );
    const baselineCount = Number(baselineHealth!.active_tabs ?? 0);

    const tab = await ctx.browser.openPage(`${ctx.fixtureApp.baseUrl}/docs/beta`);
    try {
      const afterOpenHealth = await pollUntil(
        async () => {
          const h = await ctx.desktopBridge.getHealth();
          return Number(h.active_tabs ?? 0) >= baselineCount + 1 ? h : null;
        },
        {
          timeoutMs: 3000,
          intervalMs: 60,
          message: `Desktop Bridge /health active_tabs >= ${baselineCount + 1} after opening tab`,
        },
      );
      assert.ok(Number(afterOpenHealth!.active_tabs) >= baselineCount + 1);
    } finally {
      await tab.close();
    }

    const afterCloseHealth = await pollUntil(
      async () => {
        const h = await ctx.desktopBridge.getHealth();
        return Number(h.active_tabs ?? -1) === baselineCount ? h : null;
      },
      {
        timeoutMs: 3000,
        intervalMs: 60,
        message: `Desktop Bridge /health active_tabs === ${baselineCount} after closing tab`,
      },
    );
    assert.equal(Number(afterCloseHealth!.active_tabs), baselineCount);

    // 2. Direct JSON-RPC bridge.ping -> bridge.pong roundtrip on isolated Desktop Bridge
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();
    try {
      const wsClient = await connectBrowserBridgeWs(
        `${isoBridge.wsUrl}?token=${encodeURIComponent(isoBridge.pairingToken)}`,
        {
          origin: `chrome-extension://${ctx.browser.extensionId}`,
          host: `127.0.0.1:${isoBridge.port}`,
        },
      );
      try {
        await wsClient.sendHello({
          protocol_version: 1,
          extension_id: ctx.browser.extensionId,
          pairing_token: isoBridge.pairingToken,
          run_policy: 'always_allow_authorized',
          tabs_summary: [],
        });
        const pong = await wsClient.sendPing(1763399111222);
        assert.equal(pong.jsonrpc, '2.0');
        assert.equal(pong.method, 'bridge.pong');
      } finally {
        await wsClient.close();
      }
    } finally {
      await isoBridge.stop();
    }
  },
});
