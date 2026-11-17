import {
  CANONICAL_BROWSER_TOOLS,
  TelegramApiClient,
  assert,
  assertValidPng,
  defineTest,
  pollUntil,
  type SharedTierContext,
} from '../../harness/index.ts';

function extractBase64ScreenshotFromTurn(
  turn: Record<string, any>,
  eventsBody: Record<string, any>,
  llmToolResults: Array<{ rawContent: string; json: Record<string, any> | null }>,
): string | null {
  const allEvents: any[] = [
    ...(Array.isArray(turn.events) ? turn.events : []),
    ...(Array.isArray(eventsBody?.events) ? eventsBody.events : []),
    ...(Array.isArray(eventsBody?.items) ? eventsBody.items : []),
  ];

  for (const ev of allEvents) {
    if (typeof ev?.artifact?.data_base64 === 'string' && ev.artifact.data_base64.length > 32) {
      return ev.artifact.data_base64;
    }
    if (Array.isArray(ev?.artifacts)) {
      for (const art of ev.artifacts) {
        if (typeof art?.data_base64 === 'string' && art.data_base64.length > 32) {
          return art.data_base64;
        }
      }
    }
    if (typeof ev?.data_base64 === 'string' && ev.data_base64.length > 32) {
      return ev.data_base64;
    }
    if (typeof ev?.output === 'string' && ev.output.includes('data_base64')) {
      try {
        const parsed = JSON.parse(ev.output);
        const b64 = parsed?.data_base64 ?? parsed?.result?.data_base64 ?? parsed?.artifact?.data_base64;
        if (typeof b64 === 'string' && b64.length > 32) return b64;
      } catch {
        // Continue scanning
      }
    }
  }

  for (const tr of llmToolResults) {
    const b64 =
      tr.json?.data_base64 ??
      tr.json?.result?.data_base64 ??
      tr.json?.artifact?.data_base64;
    if (typeof b64 === 'string' && b64.length > 32) {
      return b64;
    }
  }

  return null;
}

defineTest({
  id: 'T1-F04-01',
  title: 'Verify all canonical browser_* tools are advertised to the LLM in ToolsetId::Browser turns',
  tier: 1,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const toolsets = await ctx.primaryUser.api.getHermesToolsets();
    const browserTs = toolsets.toolsets.find(
      (t: any) => String(t?.name ?? t?.id ?? '').toLowerCase() === 'browser',
    );
    assert.ok(browserTs, 'Expected "browser" toolset in /api/v1/hermes/toolsets');

    ctx.mockLlm.registerScenario('f04_toolspecs', [
      { content: 'All canonical browser_* tools verified.' },
    ]);

    const turn = await ctx.primaryUser.api.createHermesTurn({
      prompt: '[E2E_SCENARIO:f04_toolspecs] Verify available browser tools',
      preset: 'hermes-telegram',
      yolo: true,
    });
    assert.equal(turn.status, 'completed');

    const req = ctx.mockLlm.recordedRequests.find((r) => r.matchedScenarioId === 'f04_toolspecs');
    assert.ok(req, 'Expected recorded LLM request for f04_toolspecs');

    for (const toolName of CANONICAL_BROWSER_TOOLS) {
      assert.ok(
        req.availableToolNames.includes(toolName),
        `Expected LLM tools payload to advertise "${toolName}" (advertised: ${req.availableToolNames.join(', ')})`,
      );
    }

    for (const toolName of CANONICAL_BROWSER_TOOLS) {
      const spec: Record<string, any> | undefined = req.tools.find(
        (t: any) => (t?.function?.name ?? t?.name) === toolName,
      );
      const fnDef: Record<string, any> = spec?.function ?? spec ?? {};
      assert.ok(
        typeof fnDef.description === 'string' && fnDef.description.trim().length > 0,
        `Tool "${toolName}" must include a non-empty description`,
      );
      assert.equal(
        fnDef.parameters?.type,
        'object',
        `Tool "${toolName}" parameters must be JSON Schema type "object"`,
      );
    }
  },
});

defineTest({
  id: 'T1-F04-02',
  title: 'Execute /browser status and /browser tabs slash subcommands via POST /api/v1/hermes/command',
  tier: 1,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      await pollUntil(
        async () => {
          const tabs = await ctx.primaryUser.api.getBrowserTabs();
          return tabs.tabs?.some((t: any) => String(t?.url ?? '').includes('/shop'));
        },
        { timeoutMs: 5000, intervalMs: 80, message: '/shop tab synced before /browser tabs' },
      );

      const statusRes = await ctx.primaryUser.api.runHermesCommand('/browser status', {
        chat_id: ctx.primaryUser.officialBotChatId,
      });
      assert.equal(statusRes.handled, true, `/browser status not handled: ${JSON.stringify(statusRes)}`);
      assert.notEqual(statusRes.data?.is_error, true, `/browser status returned error: ${JSON.stringify(statusRes)}`);
      const statusOut = String(statusRes.output || statusRes.reply_text || '');
      assert.ok(statusOut.length > 0, 'Expected non-empty output from /browser status');
      assert.match(
        statusOut,
        /connect|online|active|extension|always_allow_authorized|bridge/i,
        `Expected live bridge status in /browser status output, got: ${statusOut}`,
      );

      const tabsRes = await ctx.primaryUser.api.runHermesCommand('/browser tabs', {
        session_id: statusRes.session_id,
        chat_id: ctx.primaryUser.officialBotChatId,
      });
      assert.equal(tabsRes.handled, true, `/browser tabs not handled: ${JSON.stringify(tabsRes)}`);
      assert.notEqual(tabsRes.data?.is_error, true, `/browser tabs returned error: ${JSON.stringify(tabsRes)}`);
      const tabsOut = String(tabsRes.output || tabsRes.reply_text || '');
      assert.ok(
        tabsOut.includes('Fabushi Gear Store') || tabsOut.includes('/shop'),
        `Expected /browser tabs output to list open /shop tab, got: ${tabsOut}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F04-03',
  title: 'Execute /browser open, /browser navigate, and /browser snapshot slash subcommands on live tabs',
  tier: 1,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    const betaUrl = `${ctx.fixtureApp.baseUrl}/docs/beta`;

    const openRes = await ctx.primaryUser.api.runHermesCommand(`/browser open ${alphaUrl}`, {
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(openRes.handled, true, `/browser open not handled: ${JSON.stringify(openRes)}`);
    assert.notEqual(openRes.data?.is_error, true, `/browser open failed: ${JSON.stringify(openRes)}`);

    await pollUntil(
      async () => {
        const targets = await ctx.browser.listTargets();
        return targets.some((t) => t.type === 'page' && t.url.includes('/docs/alpha'));
      },
      { timeoutMs: 5000, intervalMs: 80, message: 'Chromium tab opened at /docs/alpha' },
    );

    const navRes = await ctx.primaryUser.api.runHermesCommand(`/browser navigate ${betaUrl}`, {
      session_id: openRes.session_id,
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(navRes.handled, true, `/browser navigate not handled: ${JSON.stringify(navRes)}`);
    assert.notEqual(navRes.data?.is_error, true, `/browser navigate failed: ${JSON.stringify(navRes)}`);

    await pollUntil(
      async () => {
        const targets = await ctx.browser.listTargets();
        return targets.some(
          (t) => t.type === 'page' && t.url.includes('/docs/beta') && t.title.includes('Beta Cloud'),
        );
      },
      { timeoutMs: 5000, intervalMs: 80, message: 'Chromium tab navigated to /docs/beta' },
    );

    const snapRes = await ctx.primaryUser.api.runHermesCommand('/browser snapshot', {
      session_id: openRes.session_id,
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(snapRes.handled, true, `/browser snapshot not handled: ${JSON.stringify(snapRes)}`);
    assert.notEqual(snapRes.data?.is_error, true, `/browser snapshot failed: ${JSON.stringify(snapRes)}`);
    const snapOut = String(snapRes.output || snapRes.reply_text || '');
    assert.ok(
      snapOut.includes('Beta Cloud') && snapOut.includes('$29/mo'),
      `Expected /browser snapshot output to include "Beta Cloud" and "$29/mo", got: ${snapOut}`,
    );
  },
});

defineTest({
  id: 'T1-F04-04',
  title: 'Execute /browser off, /browser on, and /browser cdp <url> session configuration subcommands',
  tier: 1,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const offRes = await ctx.primaryUser.api.runHermesCommand('/browser off', {
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(offRes.handled, true);
    assert.notEqual(offRes.data?.is_error, true);
    assert.match(String(offRes.output || offRes.reply_text || ''), /off|disable|false/i);

    const onRes = await ctx.primaryUser.api.runHermesCommand('/browser on', {
      session_id: offRes.session_id,
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(onRes.handled, true);
    assert.notEqual(onRes.data?.is_error, true);
    assert.match(String(onRes.output || onRes.reply_text || ''), /on|enable|active|true/i);

    const cdpUrl = `http://127.0.0.1:${ctx.browser.cdpPort}`;
    const cdpRes = await ctx.primaryUser.api.runHermesCommand(`/browser cdp ${cdpUrl}`, {
      session_id: offRes.session_id,
      chat_id: ctx.primaryUser.officialBotChatId,
    });
    assert.equal(cdpRes.handled, true);
    assert.notEqual(cdpRes.data?.is_error, true);
    assert.ok(
      String(cdpRes.output || cdpRes.reply_text || '').includes(String(ctx.browser.cdpPort)),
      `Expected /browser cdp output to confirm port ${ctx.browser.cdpPort}, got: ${JSON.stringify(cdpRes)}`,
    );
  },
});

defineTest({
  id: 'T1-F04-05',
  title: 'Complete React _valueTracker controlled checkout via browser_type (submit: true) + browser_screenshot artifact',
  tier: 1,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop/checkout`, async (tab) => {
      const checkoutTab = await pollUntil(
        async () => {
          const resp = await ctx.primaryUser.api.getBrowserTabs();
          return resp.tabs?.find((t: any) => String(t?.url ?? '').includes('/shop/checkout')) ?? null;
        },
        { timeoutMs: 5000, intervalMs: 80, message: '/shop/checkout tab in server relay' },
      );

      let observedToolResults: Array<{ rawContent: string; json: Record<string, any> | null }> = [];

      ctx.mockLlm.registerScenario('f04_react_submit', (turnCtx) => {
        observedToolResults = turnCtx.allHistoryToolResults;
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Inspecting React controlled checkout form inputs...',
            toolCalls: [{ name: 'browser_snapshot', arguments: { tab_id: checkoutTab.tab_id } }],
          };
        }
        if (turnCtx.turnIndex === 1) {
          return {
            reasoning: 'Filling React controlled fields and submitting form...',
            toolCalls: [
              {
                name: 'browser_type',
                arguments: {
                  tab_id: checkoutTab.tab_id,
                  selector: '#checkout-fullname',
                  text: 'Ada Lovelace',
                  clear_first: true,
                },
              },
              {
                name: 'browser_type',
                arguments: {
                  tab_id: checkoutTab.tab_id,
                  selector: '#checkout-email',
                  text: 'ada@analytical.engine',
                  clear_first: true,
                },
              },
              {
                name: 'browser_type',
                arguments: {
                  tab_id: checkoutTab.tab_id,
                  selector: '#checkout-address',
                  text: '10 Babbage Mews',
                  clear_first: true,
                  submit: true,
                },
              },
            ],
          };
        }
        if (turnCtx.turnIndex === 2) {
          return {
            reasoning: 'Capturing PNG screenshot of order confirmation...',
            toolCalls: [
              {
                name: 'browser_screenshot',
                arguments: { tab_id: checkoutTab.tab_id, format: 'png' },
              },
            ],
          };
        }
        return {
          content: 'Order ORD-2026-8841 confirmed and screenshot captured.',
        };
      });

      const turn = await ctx.primaryUser.api.createHermesTurn({
        prompt: '[E2E_SCENARIO:f04_react_submit] Fill shipping form, submit order, and capture screenshot',
        preset: 'hermes-telegram',
        yolo: true,
      });
      assert.equal(turn.status, 'completed', `Turn failed: ${JSON.stringify(turn)}`);

      const confirmBanner = await tab.waitForSelector('#order-confirmation', {
        state: 'visible',
        timeoutMs: 5000,
      });
      assert.ok(confirmBanner, 'Expected #order-confirmation to render after React submit');
      assert.ok(confirmBanner.text.includes('ORD-2026-8841'));

      assert.ok(ctx.fixtureApp.submittedOrders.length >= 1, 'Expected order POST recorded on server');
      const latestOrder = ctx.fixtureApp.submittedOrders[ctx.fixtureApp.submittedOrders.length - 1];
      assert.equal(latestOrder.fullName, 'Ada Lovelace');
      assert.equal(latestOrder.email, 'ada@analytical.engine');
      assert.equal(latestOrder.address, '10 Babbage Mews');

      const eventsBody = await ctx.primaryUser.api.getHermesTurnEvents(turn.turn_id);
      const shotB64 = extractBase64ScreenshotFromTurn(turn, eventsBody, observedToolResults);
      assert.ok(
        shotB64,
        'Expected base64 PNG screenshot in Hermes turn events/artifacts or tool result',
      );
      assertValidPng(shotB64, { minWidth: 200, minHeight: 200 });
    });
  },
});

defineTest({
  id: 'T1-F04-06',
  title: 'Verify Dual-Mode Managed/Local CDP fallback when zero extension is connected (HERMES_BROWSER_CDP_URL)',
  tier: 1,
  features: ['F4'],
  timeoutMs: 60000,
  fn: async (ctx: SharedTierContext) => {
    const standaloneChrome = await ctx.spawnIsolatedChromium({ loadExtension: false });
    const standaloneServer = await ctx.spawnIsolatedServer({
      cdpFallbackUrl: standaloneChrome.cdpHttpUrl,
      mockLlmPort: ctx.mockLlm.port,
    });

    try {
      const anonClient = new TelegramApiClient(standaloneServer.baseUrl);
      const reg = await anonClient.register({
        username: 'cdp_solo_user',
        password: 'SoloPassword123!',
        auto_welcome: true,
      });
      const soloApi = new TelegramApiClient(standaloneServer.baseUrl, reg.token);
      await standaloneServer.configureMockLlmProvider(reg.token, ctx.mockLlm.port, 'gpt-4o');

      const bridgeStatus = await soloApi.getBrowserStatus();
      assert.notEqual(
        bridgeStatus.extension_connected,
        true,
        'Standalone isolated server must have zero extension WS connected',
      );

      let observedToolResults: Array<{ rawContent: string; json: Record<string, any> | null }> = [];
      let snapshotAssignedRefs = false;

      ctx.mockLlm.registerScenario('f04_cdp_fallback', (turnCtx) => {
        observedToolResults = turnCtx.allHistoryToolResults;
        if (turnCtx.turnIndex === 0) {
          return {
            toolCalls: [
              {
                name: 'browser_navigate',
                arguments: { url: `${ctx.fixtureApp.baseUrl}/shop` },
              },
            ],
          };
        }
        if (turnCtx.turnIndex === 1) {
          return {
            toolCalls: [{ name: 'browser_snapshot', arguments: {} }],
          };
        }
        if (turnCtx.turnIndex === 2) {
          const els: any[] = turnCtx.latestToolResult?.json?.interactive_elements ?? [];
          snapshotAssignedRefs = els.some((e) => /^e\d+$/.test(String(e?.ref ?? '')));
          const addBtn = els.find(
            (e) =>
              String(e?.selector ?? '').includes('SKU-KB-02') ||
              String(e?.label ?? '').includes('Compact Travel Keyboard') ||
              String(e?.label ?? '').includes('Add to Cart'),
          );
          return {
            toolCalls: [
              {
                name: 'browser_click',
                arguments: addBtn?.ref
                  ? { ref: addBtn.ref }
                  : { selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]' },
              },
            ],
          };
        }
        if (turnCtx.turnIndex === 3) {
          return {
            toolCalls: [{ name: 'browser_screenshot', arguments: { format: 'png' } }],
          };
        }
        return {
          content: 'Standalone CDP fallback added item to cart and captured screenshot.',
        };
      });

      const cartBefore = ctx.fixtureApp.cartItems.length;
      const turn = await soloApi.createHermesTurn({
        prompt: '[E2E_SCENARIO:f04_cdp_fallback] Navigate to shop, click Add to Cart, and screenshot via CDP',
        preset: 'hermes-telegram',
        yolo: true,
      });

      assert.equal(turn.status, 'completed', `Standalone CDP turn failed: ${JSON.stringify(turn)}`);
      assert.equal(
        snapshotAssignedRefs,
        true,
        'Standalone CDP browser_snapshot must index [ref=eN] interactive elements',
      );
      assert.ok(
        ctx.fixtureApp.cartItems.length > cartBefore,
        'Expected standalone Chromium CDP browser_click to add item to cart (/api/shop/cart)',
      );

      const eventsBody = await soloApi.getHermesTurnEvents(turn.turn_id);
      const shotB64 = extractBase64ScreenshotFromTurn(turn, eventsBody, observedToolResults);
      assert.ok(shotB64, 'Expected PNG screenshot from standalone CDP browser_screenshot');
      assertValidPng(shotB64, { minWidth: 200, minHeight: 200 });
    } finally {
      await standaloneServer.stop();
      await standaloneChrome.stop();
    }
  },
});
