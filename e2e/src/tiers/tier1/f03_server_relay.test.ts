import {
  assert,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function waitForTabInServerRelay(
  ctx: SharedTierContext,
  urlFragment: string,
  timeoutMs = 5000,
): Promise<Record<string, any>> {
  return await pollUntil(
    async () => {
      const resp = await ctx.primaryUser.api.getBrowserTabs();
      const tabs = Array.isArray(resp.tabs) ? resp.tabs : [];
      return tabs.find((t: any) => String(t?.url ?? '').includes(urlFragment)) ?? null;
    },
    {
      timeoutMs,
      intervalMs: 80,
      message: `Wait for server relay tab matching "${urlFragment}"`,
    },
  );
}

defineTest({
  id: 'T1-F03-01',
  title: 'Verify GET /api/v1/browser/status and GET /api/v1/browser/tabs reflect live Chromium /shop tab',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const status = await pollUntil(
        async () => {
          const st = await ctx.primaryUser.api.getBrowserStatus();
          const connected = Boolean(
            st.connected ?? st.extension_connected ?? st.server_relay_connected,
          );
          return connected ? st : null;
        },
        { timeoutMs: 5000, intervalMs: 80, message: 'GET /api/v1/browser/status connected' },
      );

      assert.ok(status);
      assert.equal(
        Boolean(status.connected ?? status.extension_connected ?? status.server_relay_connected),
        true,
      );

      const shopTab = await waitForTabInServerRelay(ctx, '/shop');
      assert.equal(shopTab.title, 'Fabushi Gear Store');
      assert.equal(shopTab.controllable, true);
      assert.equal(typeof shopTab.tab_id, 'number');
    });
  },
});

defineTest({
  id: 'T1-F03-02',
  title: 'Execute browser_snapshot on /shop via POST /api/v1/browser/exec and verify [ref=eN] interactive map',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const shopTab = await waitForTabInServerRelay(ctx, '/shop');

      const execResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: shopTab.tab_id },
      });
      assert.equal(
        execResp.status,
        200,
        `POST /api/v1/browser/exec failed (${execResp.status}): ${execResp.rawText}`,
      );

      const snap = unwrapBrowserExecResult(execResp.data);
      assert.equal(snap.ok, true, `Expected ok: true in snapshot result: ${JSON.stringify(snap)}`);
      assert.equal(snap.title, 'Fabushi Gear Store');
      assert.ok(String(snap.url).includes('/shop'));
      assert.ok(
        Array.isArray(snap.interactive_elements) && snap.interactive_elements.length >= 4,
        `Expected >= 4 interactive_elements on /shop, got ${JSON.stringify(snap.interactive_elements?.length)}`,
      );

      const hasSearchInput = snap.interactive_elements.some(
        (el: any) =>
          /^e\d+$/.test(String(el?.ref ?? '')) &&
          (String(el?.selector ?? '').includes('shop-search-input') ||
            String(el?.label ?? '').toLowerCase().includes('search') ||
            el?.tag === 'input'),
      );
      const hasAddToCartBtn = snap.interactive_elements.some(
        (el: any) =>
          /^e\d+$/.test(String(el?.ref ?? '')) &&
          (String(el?.selector ?? '').includes('add-to-cart') ||
            String(el?.label ?? '').toLowerCase().includes('cart')),
      );

      assert.ok(hasSearchInput, 'Expected [ref=eN] entry for #shop-search-input');
      assert.ok(hasAddToCartBtn, 'Expected [ref=eN] entry for .add-to-cart-btn');
    });
  },
});

defineTest({
  id: 'T1-F03-03',
  title: 'Mint and rotate cryptographic pairing_token via POST /api/v1/browser/pairing',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    const first = await ctx.primaryUser.api.issueBrowserPairing({ action: 'issue' });
    const firstToken = String(first.pairing_token ?? first.token ?? '');
    assert.ok(
      firstToken.length >= 32,
      `Expected cryptographic pairing_token length >= 32, got "${firstToken}" (${JSON.stringify(first)})`,
    );
    if (first.user_id !== undefined) {
      assert.equal(first.user_id, ctx.primaryUser.userId);
    }

    const rotated = await ctx.primaryUser.api.issueBrowserPairing({ action: 'rotate' });
    const secondToken = String(rotated.pairing_token ?? rotated.token ?? '');
    assert.ok(
      secondToken.length >= 32,
      `Expected rotated pairing_token length >= 32, got "${secondToken}"`,
    );
    assert.notEqual(
      secondToken,
      firstToken,
      'Rotating pairing_token via POST /api/v1/browser/pairing must mint a new distinct token',
    );
  },
});

defineTest({
  id: 'T1-F03-04',
  title: 'Gate mutating browser_click under ask_every_time policy and unblock via POST /api/v1/browser/commands/{id}/approve',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async (tab) => {
      const shopTab = await waitForTabInServerRelay(ctx, '/shop');

      await ctx.primaryUser.api.setBotBrowserProfile(777000, {
        enabled: true,
        run_policy: 'ask_every_time',
        allowed_domains: ['127.0.0.1'],
        blocked_domains: ['localhost'],
        preferred_target: 'extension',
      });
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        if (c?.storage?.local) {
          await c.storage.local.set({
            run_policy: 'ask_every_time',
            browser_run_policy: 'ask_every_time',
          });
        }
      });

      try {
        // Start mutating browser_click without awaiting yet — must block on pending approval
        const pendingExecPromise = ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: {
              tab_id: shopTab.tab_id,
              selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
            chat_id: ctx.primaryUser.officialBotChatId,
            timeout_ms: 20000,
          },
          25000,
        );

        const pendingCmd = await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return (
              items.find(
                (item: any) =>
                  item?.tool === 'browser_click' &&
                  typeof (item?.command_id ?? item?.id) === 'string',
              ) ?? null
            );
          },
          {
            timeoutMs: 6000,
            intervalMs: 80,
            message: 'Pending browser_click command in GET /api/v1/browser/commands/pending',
          },
        );

        const cmdId = String(pendingCmd.command_id ?? pendingCmd.id);
        assert.ok(cmdId.length > 0, 'Expected non-empty command_id on pending command');

        // Before approval, cart count on live page must still be "0"
        const preApproveCart = await tab.querySelector('#cart-count');
        assert.equal(preApproveCart?.text, '0', 'Click must not execute before explicit approval');

        const approveResp = await ctx.primaryUser.api.approveBrowserCommand(cmdId, true, false);
        assert.ok(approveResp, 'Expected JSON response from approve endpoint');

        const execResp = await pendingExecPromise;
        assert.equal(
          execResp.status,
          200,
          `Approved browser_click should resolve HTTP 200, got ${execResp.status}: ${execResp.rawText}`,
        );
        const clickResult = unwrapBrowserExecResult(execResp.data);
        assert.equal(clickResult.ok, true, `Expected ok: true after approval: ${JSON.stringify(clickResult)}`);

        await pollUntil(
          async () => (await tab.querySelector('#cart-count'))?.text === '1',
          { timeoutMs: 4000, intervalMs: 60, message: 'Live #cart-count === "1" after approval' },
        );
      } finally {
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });
        await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          if (c?.storage?.local) {
            await c.storage.local.set({
              run_policy: 'always_allow_authorized',
              browser_run_policy: 'always_allow_authorized',
            });
          }
        });
      }
    });
  },
});

defineTest({
  id: 'T1-F03-05',
  title: 'Verify @telegram_official_bot (777000 / AppState.hermes) dispatches browser_snapshot over /api/v1/browser/ws',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const shopTab = await waitForTabInServerRelay(ctx, '/shop');

      ctx.mockLlm.registerScenario('f03_official_bot', (turnCtx) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Taking live browser snapshot of open storefront tab...',
            toolCalls: [
              {
                name: 'browser_snapshot',
                arguments: { tab_id: shopTab.tab_id },
              },
            ],
          };
        }
        const raw = turnCtx.latestToolResult?.rawContent ?? '';
        const title = turnCtx.latestToolResult?.json?.title ?? '';
        const verifiedTitle = title || (raw.includes('Fabushi Gear Store') ? 'Fabushi Gear Store' : 'MISSING');
        return {
          content: `OfficialBot Relay Summary: ${verifiedTitle}`,
        };
      });

      const beforeHistory = await ctx.primaryUser.api.getMessages(ctx.primaryUser.officialBotChatId);
      const maxBeforeId = beforeHistory.messages.reduce(
        (m: number, item: any) => Math.max(m, Number(item?.id ?? item?.message_id ?? 0)),
        0,
      );

      await ctx.primaryUser.api.sendMessage({
        chat_id: ctx.primaryUser.officialBotChatId,
        text: '[E2E_SCENARIO:f03_official_bot] Snapshot the open store tab and tell me its title.',
      });

      const botReply = await pollUntil(
        async () => {
          const hist = await ctx.primaryUser.api.getMessages(ctx.primaryUser.officialBotChatId, {
            limit: 20,
          });
          return (
            hist.messages.find(
              (m: any) =>
                Number(m?.id ?? m?.message_id ?? 0) > maxBeforeId &&
                Number(m?.sender_id ?? 0) !== ctx.primaryUser.userId &&
                String(m?.text ?? JSON.stringify(m?.content ?? '')).includes('Fabushi Gear Store'),
            ) ?? null
          );
        },
        {
          timeoutMs: 15000,
          intervalMs: 120,
          message: '@telegram_official_bot reply with live snapshot title "Fabushi Gear Store"',
        },
      );

      assert.ok(botReply, 'Expected @telegram_official_bot reply in chat history');
      assert.ok(
        ctx.mockLlm.recordedRequests.some(
          (r) => r.matchedScenarioId === 'f03_official_bot' && r.turnIndex >= 1,
        ),
        'Expected multi-turn tool execution roundtrip through MockLlmServer',
      );
    });
  },
});

defineTest({
  id: 'T1-F03-06',
  title: 'Verify custom Fabushi AI Bot (AppState.fabushi_bots) also executes browser_list_tabs via BrowserBridgeProvider',
  tier: 1,
  features: ['F3'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
      await waitForTabInServerRelay(ctx, '/docs/alpha');

      const created = await ctx.primaryUser.api.createFabushiBot({
        display_name: 'F03 Tab Inspector Bot',
        description: 'Inspects open Chromium tabs over Server Relay',
        title: 'Tab Inspector',
        preferred_model: 'gpt-4o',
        approval_mode: 'yolo',
        toolset_preset: 'full',
      });

      const companionChatId = created.companion_chat_id;
      const botUserId = Number(
        created.bot?.bot_user_id ??
          created.bot?.user_id ??
          created.registry?.bot_user_id ??
          created.registry?.bot_id ??
          created.bot?.id ??
          created.registry?.id ??
          0,
      );
      assert.ok(companionChatId > 0, 'Expected valid companion_chat_id for created Fabushi bot');
      assert.ok(
        Number.isFinite(botUserId) && botUserId > 0,
        `Expected valid positive botUserId for created Fabushi bot: ${JSON.stringify(created)}`,
      );

      await ctx.primaryUser.api.setBotBrowserProfile(botUserId, {
        enabled: true,
        run_policy: 'always_allow_authorized',
        allowed_domains: [],
        blocked_domains: [],
        preferred_target: 'extension',
      });
      await ctx.server.configureMockLlmProvider(ctx.primaryUser.token, ctx.mockLlm.port, 'gpt-4o');

      ctx.mockLlm.registerScenario('f03_fabushi_bot', (turnCtx) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Listing open browser tabs from custom FabushiBotHost...',
            toolCalls: [{ name: 'browser_list_tabs', arguments: {} }],
          };
        }
        const raw = turnCtx.latestToolResult?.rawContent ?? '';
        const tabs = turnCtx.latestToolResult?.json?.tabs ?? [];
        const alphaTab = Array.isArray(tabs)
          ? tabs.find((t: any) => String(t?.url ?? '').includes('/docs/alpha'))
          : null;
        const label = alphaTab
          ? `${alphaTab.title} (${alphaTab.url})`
          : raw.includes('/docs/alpha')
            ? 'Alpha Cloud Pricing (/docs/alpha)'
            : 'TAB_MISSING';
        return {
          content: `FabushiBot Tabs Report: count=${Array.isArray(tabs) ? tabs.length : '?'} -> ${label}`,
        };
      });

      const beforeHist = await ctx.primaryUser.api.getMessages(companionChatId);
      const maxBeforeId = beforeHist.messages.reduce(
        (m: number, item: any) => Math.max(m, Number(item?.id ?? item?.message_id ?? 0)),
        0,
      );

      await ctx.primaryUser.api.sendMessage({
        chat_id: companionChatId,
        text: '[E2E_SCENARIO:f03_fabushi_bot] List my open browser tabs.',
      });

      const reply = await pollUntil(
        async () => {
          const hist = await ctx.primaryUser.api.getMessages(companionChatId, { limit: 20 });
          return (
            hist.messages.find(
              (m: any) =>
                Number(m?.id ?? m?.message_id ?? 0) > maxBeforeId &&
                Number(m?.sender_id ?? 0) !== ctx.primaryUser.userId &&
                String(m?.text ?? JSON.stringify(m?.content ?? '')).includes('/docs/alpha'),
            ) ?? null
          );
        },
        {
          timeoutMs: 15000,
          intervalMs: 120,
          message: 'Custom Fabushi bot reply containing live /docs/alpha tab URL',
        },
      );

      assert.ok(reply, 'Expected custom Fabushi bot reply with live tab inventory');
      const replyText = String(reply.text ?? JSON.stringify(reply.content ?? ''));
      assert.ok(replyText.includes('Alpha Cloud Pricing'));
      assert.ok(replyText.includes('/docs/alpha'));
    });
  },
});
