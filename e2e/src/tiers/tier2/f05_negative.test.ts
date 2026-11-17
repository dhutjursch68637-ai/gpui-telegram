import * as http from 'node:http';
import WebSocket from 'ws';
import {
  BROWSER_RPC_ERROR_CODES,
  assert,
  connectBrowserBridgeWs,
  defineTest,
  pollUntil,
  probeWsUpgradeRejection,
  sleep,
  type SharedTierContext,
} from '../../harness/index.ts';

function rawHttpGetWithHost(
  port: number,
  pathAndQuery: string,
  spoofedHost: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: pathAndQuery,
        headers: {
          Host: spoofedHost,
          Connection: 'close',
          ...extraHeaders,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.once('timeout', () => {
      req.destroy(new Error('rawHttpGetWithHost timed out'));
    });
    req.once('error', reject);
    req.end();
  });
}

defineTest({
  id: 'T2-F05-01',
  title: 'Reject Desktop Loopback Bridge WebSocket upgrades from web origins (https://evil.example, http://localhost:<port>, null) with HTTP 403 Forbidden',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.desktopBridge.isRunning(), 'Desktop Bridge must be running before Origin checks');
    const preHealth = await ctx.desktopBridge.getHealth();
    assert.equal(preHealth.ok, true);

    const authedWsUrl = `${ctx.desktopBridge.wsUrl}?token=${encodeURIComponent(ctx.desktopBridge.pairingToken)}`;

    const forbiddenOrigins = [
      'https://evil.example',
      ctx.fixtureApp.localhostBaseUrl,
      'null',
    ];

    for (const badOrigin of forbiddenOrigins) {
      const probe = await probeWsUpgradeRejection(authedWsUrl, {
        origin: badOrigin,
        host: `127.0.0.1:${ctx.desktopBridge.port}`,
      });
      assert.equal(
        probe.rejected,
        true,
        `Desktop Bridge must reject WS upgrade with Origin "${badOrigin}"`,
      );
      assert.ok(
        !String(probe.errorMessage ?? '').includes('ECONNREFUSED'),
        `Origin rejection must not be ECONNREFUSED: ${probe.errorMessage}`,
      );
      assert.equal(
        probe.statusCode,
        403,
        `Expected exact HTTP 403 Forbidden for web Origin "${badOrigin}", got ${JSON.stringify(probe)}`,
      );
    }

    // Confirm Desktop Bridge remains healthy afterward
    const postHealth = await ctx.desktopBridge.getHealth();
    assert.equal(postHealth.ok, true);
  },
});

defineTest({
  id: 'T2-F05-02',
  title: 'Reject DNS-rebinding Host header (evil-rebind.attacker.com) on GET /health, GET /json/list, and WS /ext/ws with HTTP 403 or 400',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.desktopBridge.isRunning());
    const spoofedHost = 'evil-rebind.attacker.com';

    // 1. GET /health with spoofed Host header via raw node:http (Undici fetch strips Host!)
    const healthSpoof = await rawHttpGetWithHost(ctx.desktopBridge.port, '/health', spoofedHost);
    assert.ok(
      healthSpoof.statusCode === 403 || healthSpoof.statusCode === 400,
      `Expected HTTP 403 or 400 on DNS-rebinding Host for GET /health, got ${healthSpoof.statusCode}: ${healthSpoof.body}`,
    );

    // 2. GET /json/list with valid pairingToken but spoofed Host header
    const listSpoof = await rawHttpGetWithHost(
      ctx.desktopBridge.port,
      `/json/list?token=${encodeURIComponent(ctx.desktopBridge.pairingToken)}`,
      spoofedHost,
      { Authorization: `Bearer ${ctx.desktopBridge.pairingToken}` },
    );
    assert.ok(
      listSpoof.statusCode === 403 || listSpoof.statusCode === 400,
      `Expected HTTP 403 or 400 on DNS-rebinding Host for GET /json/list, got ${listSpoof.statusCode}: ${listSpoof.body}`,
    );

    // 3. WS upgrade /ext/ws with valid Origin & token but spoofed Host header
    const wsSpoof = await probeWsUpgradeRejection(
      `${ctx.desktopBridge.wsUrl}?token=${encodeURIComponent(ctx.desktopBridge.pairingToken)}`,
      {
        host: spoofedHost,
        origin: `chrome-extension://${ctx.browser.extensionId}`,
      },
    );
    assert.equal(wsSpoof.rejected, true, 'WS upgrade with spoofed DNS-rebinding Host must be rejected');
    assert.ok(
      wsSpoof.statusCode === 403 || wsSpoof.statusCode === 400,
      `Expected HTTP 403 or 400 on WS DNS-rebinding Host, got ${JSON.stringify(wsSpoof)}`,
    );

    // 4. Legitimate loopback Host continues to succeed
    const okHealth = await ctx.desktopBridge.getHealth();
    assert.equal(okHealth.ok, true);
  },
});

defineTest({
  id: 'T2-F05-03',
  title: 'Reject wrong or missing pairing_token on Desktop Bridge WS even with valid chrome-extension:// Origin (401/403 or -32001 UNAUTHORIZED_BRIDGE)',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    assert.ok(ctx.desktopBridge.isRunning());
    const validExtOrigin = `chrome-extension://${ctx.browser.extensionId}`;
    const wrongUrl = `${ctx.desktopBridge.wsUrl}?token=wrong_token_0000`;

    const wrongProbe = await probeWsUpgradeRejection(wrongUrl, {
      origin: validExtOrigin,
      host: `127.0.0.1:${ctx.desktopBridge.port}`,
    });

    if (wrongProbe.rejected) {
      assert.ok(
        wrongProbe.statusCode === 401 ||
          wrongProbe.statusCode === 403 ||
          wrongProbe.firstMessage?.error?.code === BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE ||
          (wrongProbe.closeCode !== undefined && wrongProbe.closeCode !== 1000),
        `Expected HTTP 401/403 or -32001 for wrong pairing_token, got ${JSON.stringify(wrongProbe)}`,
      );
    } else {
      // If bridge validates pairing_token inside bridge.hello frame, verify -32001 rejection there
      const ws = new WebSocket(wrongUrl, {
        headers: {
          Origin: validExtOrigin,
          Host: `127.0.0.1:${ctx.desktopBridge.port}`,
        },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
        const helloOutcome = await new Promise<{ msg?: any; closeCode?: number }>((resolve) => {
          const t = setTimeout(() => resolve({}), 3000);
          ws.once('message', (raw) => {
            clearTimeout(t);
            resolve({ msg: JSON.parse(raw.toString('utf-8')) });
          });
          ws.once('close', (code) => {
            clearTimeout(t);
            resolve({ closeCode: code });
          });
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'bad_tok_hello',
              method: 'bridge.hello',
              params: {
                protocol_version: 1,
                extension_id: ctx.browser.extensionId,
                device_id: 'probe-bad-tok',
                pairing_token: 'wrong_token_0000',
                user_agent: 'Chrome/156',
                capabilities: [],
                run_policy: 'always_allow_authorized',
                tabs_summary: [],
              },
            }),
          );
        });
        assert.ok(
          helloOutcome.msg?.error?.code === BROWSER_RPC_ERROR_CODES.UNAUTHORIZED_BRIDGE ||
            helloOutcome.msg?.params?.accepted === false ||
            (helloOutcome.closeCode !== undefined && helloOutcome.closeCode !== 1000),
          `Expected -32001 UNAUTHORIZED_BRIDGE on wrong pairing_token hello, got ${JSON.stringify(helloOutcome)}`,
        );
      } finally {
        ws.terminate();
      }
    }

    const postHealth = await ctx.desktopBridge.getHealth();
    assert.equal(postHealth.ok, true);
  },
});

defineTest({
  id: 'T2-F05-04',
  title: 'Reject unauthenticated and wrong-token GET /json/list requests on Desktop Loopback Bridge with HTTP 401 or 403',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    // Positive control with valid pairingToken
    const authedTargets = await ctx.desktopBridge.getJsonList(ctx.desktopBridge.pairingToken);
    assert.ok(Array.isArray(authedTargets), 'Valid pairingToken must return target list');

    // 1. Missing token entirely
    const noTokResp = await fetch(`${ctx.desktopBridge.baseUrl}/json/list`);
    assert.ok(
      noTokResp.status === 401 || noTokResp.status === 403,
      `GET /json/list without pairing_token must return HTTP 401 or 403, got ${noTokResp.status}`,
    );

    // 2. Wrong query token
    const badQueryResp = await fetch(
      `${ctx.desktopBridge.baseUrl}/json/list?token=forged_token_999`,
    );
    assert.ok(
      badQueryResp.status === 401 || badQueryResp.status === 403,
      `GET /json/list with wrong query token must return HTTP 401 or 403, got ${badQueryResp.status}`,
    );

    // 3. Wrong Authorization Bearer header
    const badBearerResp = await fetch(`${ctx.desktopBridge.baseUrl}/json/list`, {
      headers: { Authorization: 'Bearer forged_token_999' },
    });
    assert.ok(
      badBearerResp.status === 401 || badBearerResp.status === 403,
      `GET /json/list with wrong Bearer token must return HTTP 401 or 403, got ${badBearerResp.status}`,
    );
  },
});

defineTest({
  id: 'T2-F05-05',
  title: 'Report { ok: true, extension_connected: false, active_tabs: 0 } on isolated unpaired DesktopBridge and fail tool dispatch cleanly without crashing',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();
    try {
      const health = await isoBridge.getHealth();
      assert.equal(health.ok, true);
      assert.equal(
        Boolean(health.extension_connected || health.connected),
        false,
        `Unpaired isolated bridge must report extension_connected: false, got ${JSON.stringify(health)}`,
      );
      assert.equal(
        Number(health.active_tabs ?? 0),
        0,
        `Unpaired isolated bridge must report active_tabs: 0, got ${JSON.stringify(health)}`,
      );

      const emptyList = await isoBridge.getJsonList();
      assert.deepEqual(emptyList, [], 'Unpaired isolated bridge /json/list must be empty');

      // Probe tool invocation on unpaired bridge over HTTP (/exec, /api/v1/browser/exec)
      for (const pathCandidate of ['/exec', '/api/v1/browser/exec', '/ext/exec']) {
        const resp = await fetch(`${isoBridge.baseUrl}${pathCandidate}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${isoBridge.pairingToken}`,
          },
          body: JSON.stringify({
            tool: 'browser_status',
            arguments: {},
          }),
        });
        assert.notEqual(
          resp.status,
          500,
          `Unpaired DesktopBridge ${pathCandidate} must not panic/500`,
        );
        if (resp.status === 200) {
          const body = (await resp.json()) as any;
          assert.notEqual(
            body?.ok === true && body?.connected === true,
            true,
            'Unpaired bridge must never claim connected: true on exec',
          );
        }
      }

      assert.ok(isoBridge.isRunning(), 'Isolated DesktopBridge must remain alive after unpaired tool dispatch');
      const healthAfter = await isoBridge.getHealth();
      assert.equal(healthAfter.ok, true);
    } finally {
      await isoBridge.stop();
    }
  },
});

defineTest({
  id: 'T2-F05-06',
  title: 'Preserve extension_connected: true when a superseded old extension WS socket closes after a newer extension WS connects',
  tier: 2,
  features: ['F5'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();
    const extOrigin = `chrome-extension://${ctx.browser.extensionId}`;
    const wsEndpoint = `${isoBridge.wsUrl}?token=${encodeURIComponent(isoBridge.pairingToken)}`;

    let oldSocket: Awaited<ReturnType<typeof connectBrowserBridgeWs>> | null = null;
    let newSocket: Awaited<ReturnType<typeof connectBrowserBridgeWs>> | null = null;

    try {
      // 1. Connect generation-1 extension WS
      oldSocket = await connectBrowserBridgeWs(wsEndpoint, {
        origin: extOrigin,
        host: `127.0.0.1:${isoBridge.port}`,
      });
      const ack1 = await oldSocket.sendHello({
        extension_id: ctx.browser.extensionId,
        device_id: 'ext-gen-1',
        pairing_token: isoBridge.pairingToken,
        tabs_summary: [
          {
            tab_id: 101,
            window_id: 1,
            active: true,
            pinned: false,
            audible: false,
            status: 'complete',
            title: 'Gen1 Alpha',
            url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
            controllable: true,
          },
        ],
      });
      assert.equal(ack1?.params?.accepted, true);

      await pollUntil(
        async () => {
          const h = await isoBridge.getHealth();
          return Boolean(h.extension_connected || h.connected);
        },
        { timeoutMs: 4000, intervalMs: 60, message: 'gen1 extension_connected: true' },
      );

      // 2. Connect generation-2 extension WS BEFORE closing generation-1 (simulating MV3 SW cold-restart overlap)
      newSocket = await connectBrowserBridgeWs(wsEndpoint, {
        origin: extOrigin,
        host: `127.0.0.1:${isoBridge.port}`,
      });
      const ack2 = await newSocket.sendHello({
        extension_id: ctx.browser.extensionId,
        device_id: 'ext-gen-2',
        pairing_token: isoBridge.pairingToken,
        tabs_summary: [
          {
            tab_id: 202,
            window_id: 1,
            active: true,
            pinned: false,
            audible: false,
            status: 'complete',
            title: 'Gen2 Beta',
            url: `${ctx.fixtureApp.baseUrl}/docs/beta`,
            controllable: true,
          },
        ],
      });
      assert.equal(ack2?.params?.accepted, true);

      // 3. Close the superseded generation-1 socket and give disconnect task time to run
      await oldSocket.close();
      await sleep(300);

      // 4. Verify generation-2 remains active and extension_connected stays true!
      const healthAfterOldClose = await isoBridge.getHealth();
      assert.equal(
        Boolean(healthAfterOldClose.extension_connected || healthAfterOldClose.connected),
        true,
        `Closing superseded old WS must not clobber active new WS: ${JSON.stringify(healthAfterOldClose)}`,
      );
      assert.equal(newSocket.isOpen(), true, 'New extension WS must remain open');

      const pong = await newSocket.sendPing();
      assert.equal(pong?.method, 'bridge.pong');

      const targets = await isoBridge.getJsonList();
      assert.ok(
        targets.some((t: any) => String(t.title ?? '').includes('Gen2 Beta') || String(t.url ?? '').includes('/docs/beta')),
        `Expected Gen2 tab inventory to remain registered, got ${JSON.stringify(targets)}`,
      );
    } finally {
      await oldSocket?.close().catch(() => undefined);
      await newSocket?.close().catch(() => undefined);
      await isoBridge.stop();
    }
  },
});
