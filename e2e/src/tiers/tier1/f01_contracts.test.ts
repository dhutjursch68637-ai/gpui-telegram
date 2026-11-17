import * as fs from 'node:fs';
import {
  CANONICAL_BROWSER_TOOLS,
  FORBIDDEN_TIR_PARAM_KEYS,
  assert,
  assertElfBinary,
  assertPathOnXfs,
  assertWasmMagic,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  verifySutArtifactsOrFail,
  type SharedTierContext,
} from '../../harness/index.ts';

defineTest({
  id: 'T1-F01-01',
  title: 'Verify built SUT ELF binaries, MV3 manifest_version 3, HTML surfaces, and WASM magic bytes on XFS',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const verified = verifySutArtifactsOrFail(ctx.sutRoot);

    assertPathOnXfs(ctx.sutRoot);
    assertPathOnXfs(verified.paths.serverBin);
    assertPathOnXfs(verified.paths.desktopBin);
    assertPathOnXfs(verified.paths.extDistDir);
    assertPathOnXfs(verified.paths.wasmPath);

    assertElfBinary(verified.paths.serverBin);
    assertElfBinary(verified.paths.desktopBin);

    assert.equal(
      verified.manifest.manifest_version,
      3,
      `Expected MV3 manifest_version === 3, got ${JSON.stringify(verified.manifest.manifest_version)}`,
    );
    assert.ok(
      typeof verified.manifest.name === 'string' && verified.manifest.name.trim().length > 0,
      'Expected non-empty extension name in manifest.json',
    );

    for (const entryPath of [
      verified.resolvedBackgroundEntry,
      verified.resolvedContentEntry,
      verified.paths.workspaceHtmlPath,
      verified.paths.sidepanelHtmlPath,
      verified.paths.popupHtmlPath,
      verified.paths.optionsHtmlPath,
    ]) {
      const st = fs.statSync(entryPath);
      assert.ok(st.isFile() && st.size > 0, `Expected non-empty built extension file: ${entryPath}`);
    }

    const wasmMeta = assertWasmMagic(verified.paths.wasmPath);
    assert.equal(wasmMeta.version, 1);
    assert.ok(
      wasmMeta.byteLength > 1024,
      `Expected compiled gpui_telegram_ext_wasm.wasm > 1024 bytes, got ${wasmMeta.byteLength}`,
    );
  },
});

defineTest({
  id: 'T1-F01-02',
  title: 'Verify browser toolset registration and absence of forbidden TIR filesystem parameter keys',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const toolsetsResp = await ctx.primaryUser.api.getHermesToolsets();
    assert.ok(Array.isArray(toolsetsResp.toolsets), 'Expected toolsets array from GET /api/v1/hermes/toolsets');

    const browserToolset = toolsetsResp.toolsets.find(
      (ts: any) => String(ts?.name ?? ts?.id ?? '').toLowerCase() === 'browser',
    );
    assert.ok(browserToolset, 'Expected "browser" toolset in /api/v1/hermes/toolsets');
    assert.equal(
      Boolean(browserToolset.enabled),
      true,
      'Expected "browser" toolset to be enabled in default preset',
    );

    const declaredTools: string[] = Array.isArray(browserToolset.tools)
      ? browserToolset.tools.map((t: any) => (typeof t === 'string' ? t : String(t?.name ?? '')))
      : [];
    assert.ok(
      declaredTools.length >= 24,
      `Expected >= 24 tools in browser toolset, got ${declaredTools.length}`,
    );
    for (const canonicalTool of CANONICAL_BROWSER_TOOLS) {
      assert.ok(
        declaredTools.includes(canonicalTool),
        `Browser toolset missing canonical tool "${canonicalTool}" (found: ${declaredTools.join(', ')})`,
      );
    }

    ctx.mockLlm.registerScenario('t1_f01_02_schema', [
      { content: 'Verified canonical browser parameter schemas.' },
    ]);
    const turn = await ctx.primaryUser.api.createHermesTurn({
      prompt: '[E2E_SCENARIO:t1_f01_02_schema] Inspect browser tool schemas',
      preset: 'hermes-telegram',
      yolo: true,
    });
    assert.equal(turn.status, 'completed');

    const llmReq = ctx.mockLlm.recordedRequests.find(
      (r) => r.matchedScenarioId === 't1_f01_02_schema',
    );
    assert.ok(llmReq, 'Expected MockLlmServer to record schema inspection turn');

    const browserToolSpecs = llmReq.tools.filter((t: any) => {
      const fnName = String(t?.function?.name ?? t?.name ?? '');
      return fnName.startsWith('browser_');
    });
    assert.ok(
      browserToolSpecs.length >= 24,
      `Expected >= 24 browser_* function specs sent to LLM, got ${browserToolSpecs.length}`,
    );

    for (const spec of browserToolSpecs) {
      const fnObj = spec.function ?? spec;
      const props = fnObj?.parameters?.properties ?? {};
      const propKeys = Object.keys(props);
      for (const forbiddenKey of FORBIDDEN_TIR_PARAM_KEYS) {
        assert.ok(
          !propKeys.includes(forbiddenKey),
          `Tool "${fnObj.name}" defines forbidden TIR path parameter "${forbiddenKey}" (keys: ${propKeys.join(', ')})`,
        );
      }
    }
  },
});

defineTest({
  id: 'T1-F01-03',
  title: 'Complete canonical JSON-RPC 2.0 bridge.hello -> bridge.hello_ack handshake on /api/v1/browser/ws',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const isolatedUser = await ctx.createIsolatedUser('f01_hello');
    const wsClient = await isolatedUser.api.connectServerBrowserWs({
      clientKind: 'extension',
      origin: `chrome-extension://${ctx.browser.extensionId}`,
    });

    try {
      const ack = await wsClient.sendHello({
        protocol_version: 1,
        extension_id: ctx.browser.extensionId,
        device_id: 'f01-probe-device',
        pairing_token: '',
        run_policy: 'always_allow_authorized',
        tabs_summary: [
          {
            tab_id: 701,
            window_id: 1,
            active: true,
            pinned: false,
            audible: false,
            status: 'complete',
            title: 'Fabushi Gear Store',
            url: `${ctx.fixtureApp.baseUrl}/shop`,
            controllable: true,
          },
        ],
      });

      assert.equal(ack.jsonrpc, '2.0', 'Expected jsonrpc: "2.0" on bridge.hello_ack');
      assert.equal(ack.method, 'bridge.hello_ack', `Expected method bridge.hello_ack, got ${ack?.method}`);
      assert.ok(ack.params && typeof ack.params === 'object', 'Expected params object in bridge.hello_ack');
      assert.equal(ack.params.accepted, true, 'Expected params.accepted === true');
      assert.equal(ack.params.host_kind, 'server', 'Expected params.host_kind === "server"');
      assert.ok(
        typeof ack.params.host_version === 'string' && ack.params.host_version.length > 0,
        `Expected non-empty host_version, got ${JSON.stringify(ack.params.host_version)}`,
      );
      assert.ok(
        typeof ack.params.ping_interval_secs === 'number' && ack.params.ping_interval_secs > 0,
        `Expected positive ping_interval_secs, got ${JSON.stringify(ack.params.ping_interval_secs)}`,
      );
    } finally {
      await wsClient.close();
    }
  },
});

defineTest({
  id: 'T1-F01-04',
  title: 'Exchange JSON-RPC 2.0 bridge.ping/pong and synchronize BrowserTabDto inventory via bridge.tabs_sync',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const isolatedUser = await ctx.createIsolatedUser('f01_sync');
    const wsClient = await isolatedUser.api.connectServerBrowserWs({
      clientKind: 'extension',
      origin: `chrome-extension://${ctx.browser.extensionId}`,
    });

    try {
      const ack = await wsClient.sendHello({
        protocol_version: 1,
        extension_id: ctx.browser.extensionId,
        device_id: 'f01-sync-device',
        run_policy: 'always_allow_authorized',
        tabs_summary: [],
      });
      assert.equal(ack.params?.accepted, true);

      const sentTs = 1763399000000;
      const pong = await wsClient.sendPing(sentTs);
      assert.equal(pong.jsonrpc, '2.0');
      assert.equal(pong.method, 'bridge.pong');

      const syncedTabs = [
        {
          tab_id: 8101,
          window_id: 10,
          active: true,
          pinned: false,
          audible: false,
          status: 'complete',
          title: 'Fabushi Gear Store',
          url: `${ctx.fixtureApp.baseUrl}/shop`,
          controllable: true,
        },
        {
          tab_id: 8102,
          window_id: 10,
          active: false,
          pinned: true,
          audible: false,
          status: 'complete',
          title: 'Alpha Cloud Pricing',
          url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
          controllable: true,
        },
      ];

      await wsClient.sendTabsSync(syncedTabs, 'always_allow_authorized');

      const tabsBody = await pollUntil(
        async () => {
          const resp = await isolatedUser.api.getBrowserTabs();
          return Array.isArray(resp.tabs) && resp.tabs.length === 2 ? resp : null;
        },
        { timeoutMs: 3000, intervalMs: 60, message: 'GET /api/v1/browser/tabs after bridge.tabs_sync' },
      );

      assert.ok(tabsBody);
      assert.equal(tabsBody.ok, true);
      assert.equal(tabsBody.tabs.length, 2);

      const tab1 = tabsBody.tabs.find((t: any) => t.tab_id === 8101);
      const tab2 = tabsBody.tabs.find((t: any) => t.tab_id === 8102);
      assert.ok(tab1, 'Missing synced tab 8101');
      assert.ok(tab2, 'Missing synced tab 8102');

      assert.equal(tab1.window_id, 10);
      assert.equal(tab1.active, true);
      assert.equal(tab1.title, 'Fabushi Gear Store');
      assert.equal(tab1.url, `${ctx.fixtureApp.baseUrl}/shop`);
      assert.equal(tab1.controllable, true);

      assert.equal(tab2.window_id, 10);
      assert.equal(tab2.active, false);
      assert.equal(tab2.pinned, true);
      assert.equal(tab2.title, 'Alpha Cloud Pricing');
      assert.equal(tab2.url, `${ctx.fixtureApp.baseUrl}/docs/alpha`);
      assert.equal(tab2.controllable, true);
    } finally {
      await wsClient.close();
    }
  },
});

defineTest({
  id: 'T1-F01-05',
  title: 'Execute browser_status via POST /api/v1/browser/exec and validate canonical result envelope',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const execResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_status',
        arguments: {},
      });
      assert.equal(
        execResp.status,
        200,
        `Expected HTTP 200 from POST /api/v1/browser/exec, got ${execResp.status}: ${execResp.rawText}`,
      );

      const status = unwrapBrowserExecResult(execResp.data);
      assert.equal(status.ok, true, `Expected ok: true in browser_status result: ${JSON.stringify(status)}`);
      assert.equal(status.connected, true, 'Expected connected: true in browser_status');
      assert.equal(
        status.server_relay_connected,
        true,
        'Expected server_relay_connected: true in browser_status',
      );
      assert.ok(
        typeof status.run_policy === 'string' && status.run_policy.length > 0,
        `Expected snake_case run_policy string, got ${JSON.stringify(status.run_policy)}`,
      );
      assert.ok(
        typeof status.active_tabs === 'number' && status.active_tabs >= 1,
        `Expected active_tabs >= 1 while /shop tab is open, got ${JSON.stringify(status.active_tabs)}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F01-06',
  title: 'Verify BrowserRunPolicy snake_case wire roundtrip across PUT/GET /api/v1/bots/777000/browser',
  tier: 1,
  features: ['F1'],
  fn: async (ctx: SharedTierContext) => {
    const policies = [
      'always_allow_authorized',
      'allow_read_only',
      'ask_every_time',
      'disabled',
    ] as const;

    try {
      for (const policy of policies) {
        const putResp = await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: policy !== 'disabled',
          run_policy: policy,
          allowed_domains: ['127.0.0.1'],
          blocked_domains: ['localhost'],
          preferred_target: 'extension',
        });
        assert.equal(
          putResp.run_policy,
          policy,
          `PUT /api/v1/bots/777000/browser should echo run_policy="${policy}"`,
        );

        const got = await ctx.primaryUser.api.getBotBrowserProfile(777000);
        assert.equal(
          got.run_policy,
          policy,
          `GET /api/v1/bots/777000/browser should persist canonical snake_case run_policy="${policy}"`,
        );
        assert.equal(Boolean(got.enabled), policy !== 'disabled');
        assert.ok(
          Array.isArray(got.allowed_domains) && got.allowed_domains.includes('127.0.0.1'),
          `Expected allowed_domains to include "127.0.0.1", got ${JSON.stringify(got.allowed_domains)}`,
        );
        assert.ok(
          Array.isArray(got.blocked_domains) && got.blocked_domains.includes('localhost'),
          `Expected blocked_domains to include "localhost", got ${JSON.stringify(got.blocked_domains)}`,
        );
      }
    } finally {
      await ctx.primaryUser.api.setBotBrowserProfile(777000, {
        enabled: true,
        run_policy: 'always_allow_authorized',
        allowed_domains: [],
        blocked_domains: [],
        preferred_target: 'extension',
      });
    }
  },
});
