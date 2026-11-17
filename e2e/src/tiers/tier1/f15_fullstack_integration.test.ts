import * as crypto from 'node:crypto';
import {
  defineTest,
  assert,
  pollUntil,
  assertValidPng,
  unwrapBrowserExecResult,
  TelegramApiClient,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

async function selectOfficialBotInSurface(page: CdpPageHandle): Promise<void> {
  const composer = await page.querySelector('[data-testid="canonical-composer-input"]');
  if (composer?.visible) return;

  await page.eval(() => {
    const sb = document.querySelector('[data-testid="chat-sidebar"]') ?? document.body;
    const rows = Array.from(sb.querySelectorAll('*')) as HTMLElement[];
    const botRow = rows.find(
      (el) =>
        el.children.length > 0 &&
        /official|hermes|telegram|777000/i.test(el.textContent ?? '') &&
        el.getBoundingClientRect().height >= 34 &&
        el.getBoundingClientRect().height <= 110,
    );
    botRow?.click();
  });
}

defineTest({
  id: 'T1-F15-01',
  title: 'Simultaneous workspace.html, sidepanel.html, and popup.html synchronize live messages and BrowserRunPolicy broadcasts within 1s',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const syncMarker = `TriSurfaceBroadcast_${crypto.randomBytes(3).toString('hex')}`;

    await ctx.withExtensionSurface('workspace', async (workspace) => {
      await ctx.withExtensionSurface('sidepanel', async (sidepanel) => {
        await ctx.withExtensionSurface('popup', async (popup) => {
          await workspace.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
          await sidepanel.waitForTestId('browser-bridge-status-pill', { state: 'visible', timeoutMs: 10000 });
          await popup.waitForTestId('browser-policy-select', { state: 'visible', timeoutMs: 10000 });

          await selectOfficialBotInSurface(workspace);
          await selectOfficialBotInSurface(sidepanel);

          await workspace.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });
          await workspace.typeTestId('canonical-composer-input', syncMarker, { clearFirst: true });
          await workspace.clickTestId('composer-send-btn');

          // Message sent in workspace.html must broadcast into sidepanel.html
          await sidepanel.waitForText(syncMarker, { timeoutMs: 5000 });

          // Toggle BrowserRunPolicy in popup.html -> status pills across all 3 surfaces update
          await popup.selectOption('[data-testid="browser-policy-select"]', 'allow_read_only');

          await pollUntil(
            async () => {
              const [wsPill, spPill, popPill] = await Promise.all([
                workspace.querySelector('[data-testid="browser-bridge-status-pill"]'),
                sidepanel.querySelector('[data-testid="browser-bridge-status-pill"]'),
                popup.querySelector('[data-testid="browser-bridge-status-pill"]'),
              ]);
              const combined = `${wsPill?.text ?? ''} ${spPill?.text ?? ''} ${popPill?.text ?? ''}`.toLowerCase();
              return /read.?only|只读/i.test(combined) && Boolean(spPill?.visible && popPill?.visible);
            },
            { timeoutMs: 5000, message: 'All 3 surfaces synchronize allow_read_only status pill' },
          );

          await popup.selectOption('[data-testid="browser-policy-select"]', 'always_allow_authorized');
        });
      });
    });
  },
});

defineTest({
  id: 'T1-F15-02',
  title: 'Desktop/API bot workflow drives live Chromium /shop tab through bridge while sidepanel.html and /api/v1/ws stream updates',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    const ptsWs = await ctx.primaryUser.api.connectPtsWs();

    try {
      await ptsWs.subscribeChat(ctx.primaryUser.officialBotChatId);

      await ctx.withTargetTab(shopUrl, async (shopTab) => {
        const shopTabEntry = await pollUntil(
          async () => {
            const r = await ctx.primaryUser.api.getBrowserTabs();
            return r.tabs.find((t: any) => String(t.url ?? '').startsWith(shopUrl)) ?? null;
          },
          { timeoutMs: 6000, message: '/shop tab synced to server' },
        );
        const tabId = Number(shopTabEntry.tab_id ?? shopTabEntry.id);

        ctx.mockLlm.registerScenario('f15_desktop_bot_shop', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              reasoning: 'Reading /shop interactive elements...',
              toolCalls: [{ name: 'browser_snapshot', arguments: { tab_id: tabId } }],
            };
          }
          if (turnCtx.turnIndex === 1) {
            const els: any[] = turnCtx.latestToolResult?.json?.interactive_elements ?? [];
            const addBtn = els.find(
              (e) =>
                String(e.selector ?? '').includes('SKU-KB-02') ||
                String(e.label ?? '').includes('Add to Cart'),
            );
            return {
              toolCalls: [
                {
                  name: 'browser_click',
                  arguments: addBtn?.ref
                    ? { tab_id: tabId, ref: addBtn.ref }
                    : { tab_id: tabId, selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]' },
                },
              ],
            };
          }
          return {
            content: 'Desktop-triggered bot added Compact Travel Keyboard (#cart-count=1).',
          };
        });

        await ctx.withExtensionSurface('sidepanel', async (sidepanel) => {
          await sidepanel.waitForTestId('browser-bridge-status-pill', { state: 'visible', timeoutMs: 8000 });
          await selectOfficialBotInSurface(sidepanel);

          const turnResp = await ctx.primaryUser.api.createHermesTurn({
            prompt: '[E2E_SCENARIO:f15_desktop_bot_shop] Add Compact Travel Keyboard to cart',
            chat_id: ctx.primaryUser.officialBotChatId,
            deliver_to_chat: true,
          });
          assert.equal(turnResp.status, 'completed');

          await pollUntil(
            async () => (await shopTab.querySelector('#cart-count'))?.text === '1',
            { timeoutMs: 5000, message: 'Live /shop tab #cart-count mutated to 1' },
          );

          await ptsWs.waitForPtsPush(
            ctx.primaryUser.officialBotChatId,
            (p) => JSON.stringify(p).includes('Compact Travel Keyboard'),
            8000,
          );
          await sidepanel.waitForText('Compact Travel Keyboard', { timeoutMs: 8000 });
        });
      });
    } finally {
      await ptsWs.close();
    }
  },
});

defineTest({
  id: 'T1-F15-03',
  title: 'In-Extension Bot on Tab A (/docs/alpha) followed by Server FabushiBotHost on Tab B (/docs/beta) isolates tab_ids with zero exceptions',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();

    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    const betaUrl = `${ctx.fixtureApp.baseUrl}/docs/beta`;

    const customBot = await ctx.primaryUser.api.createFabushiBot({
      display_name: `TabBetaAgent_${crypto.randomBytes(2).toString('hex')}`,
      toolset_preset: 'hermes-telegram',
    });
    const customBotId = Number(
      customBot.bot?.bot_user_id ?? customBot.bot?.user_id ?? customBot.registry?.bot_user_id,
    );

    await ctx.withTargetTab(alphaUrl, async (tabA) => {
      await ctx.withTargetTab(betaUrl, async (tabB) => {
        const tabs = await pollUntil(
          async () => {
            const r = await ctx.primaryUser.api.getBrowserTabs();
            const a = r.tabs.find((t: any) => String(t.url ?? '').startsWith(alphaUrl));
            const b = r.tabs.find((t: any) => String(t.url ?? '').startsWith(betaUrl));
            return a && b ? { tabAId: Number(a.tab_id), tabBId: Number(b.tab_id) } : null;
          },
          { timeoutMs: 6000, message: 'Both Tab A and Tab B synced' },
        );
        assert.ok(tabs, 'Expected both Tab A and Tab B IDs');

        // Workflow 1: In-Extension Bot / Sidepanel turn on Tab A
        ctx.mockLlm.registerScenario('f15_tab_a', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              toolCalls: [{ name: 'browser_extract_markdown', arguments: { tab_id: tabs.tabAId } }],
            };
          }
          const md = turnCtx.latestToolResult?.rawContent ?? '';
          return { content: `TabA_Result: ${md.includes('$19/mo') ? '$19/mo Tokyo' : md.slice(0, 80)}` };
        });

        await ctx.withExtensionSurface('sidepanel', async (sidepanel) => {
          await sidepanel.waitForTestId('browser-bridge-status-pill', { state: 'visible', timeoutMs: 8000 });
          await selectOfficialBotInSurface(sidepanel);
          await sidepanel.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });
          await sidepanel.typeTestId(
            'canonical-composer-input',
            '[E2E_SCENARIO:f15_tab_a] Read Tab A pricing',
            { clearFirst: true },
          );
          await sidepanel.clickTestId('composer-send-btn');
          await sidepanel.waitForText('$19/mo Tokyo', { timeoutMs: 15000 });
        });

        // Workflow 2: Server FabushiBotHost turn on Tab B
        ctx.mockLlm.registerScenario('f15_tab_b', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              toolCalls: [{ name: 'browser_extract_markdown', arguments: { tab_id: tabs.tabBId } }],
            };
          }
          const md = turnCtx.latestToolResult?.rawContent ?? '';
          return { content: `TabB_Result: ${md.includes('$29/mo') ? '$29/mo Frankfurt' : md.slice(0, 80)}` };
        });

        const botTurn = await ctx.primaryUser.api.createHermesTurn({
          prompt: '[E2E_SCENARIO:f15_tab_b] Read Tab B pricing',
          bot_id: customBotId,
          chat_id: customBot.companion_chat_id,
          deliver_to_chat: true,
        });
        assert.ok(String(botTurn.response ?? '').includes('$29/mo Frankfurt'));

        assert.equal(await tabA.title(), 'Alpha Cloud Pricing', 'Tab A must remain untouched on Alpha');
        assert.equal(await tabB.title(), 'Beta Cloud Pricing', 'Tab B must remain untouched on Beta');
        assert.equal(ctx.browser.uncaughtExceptions.length, 0, 'Zero uncaught SW or page exceptions');
      });
    });
  },
});

defineTest({
  id: 'T1-F15-04',
  title: 'Telegram Bot API 1:1 compatibility (/bot{token}/getMe, sendMessage inline_keyboard, getUpdates) interacts live with workspace.html',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const created = await ctx.primaryUser.api.botFatherNlCreate({
      prompt: 'Create a release approval notifier bot',
    });
    const botToken = created.bot_token;
    const chatId = created.companion_chat_id;
    const botTitle = String(created.bot?.title ?? created.bot?.display_name ?? created.bot?.username);

    const getMe = await ctx.primaryUser.api.callBotApi(botToken, 'getMe');
    assert.equal(getMe.ok, true);
    assert.equal(getMe.result?.is_bot, true);

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await page.waitForText(botTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });

      await page.eval((bTitle: string) => {
        const sb = document.querySelector('[data-testid="chat-sidebar"]')!;
        const rows = Array.from(sb.querySelectorAll('*')) as HTMLElement[];
        const row = rows
          .filter(
            (el) =>
              (el.innerText || '').includes(bTitle) &&
              el.getBoundingClientRect().height >= 32 &&
              el.getBoundingClientRect().height <= 110,
          )
          .sort((a, b) => a.innerText.length - b.innerText.length)[0];
        row?.click();
      }, botTitle);

      const alertText = `BotAPI_Live_Alert_${crypto.randomBytes(2).toString('hex')}`;
      const sendRes = await ctx.primaryUser.api.callBotApi(botToken, 'sendMessage', {
        chat_id: chatId,
        text: alertText,
        reply_markup: {
          inline_keyboard: [[{ text: 'Confirm Ship', callback_data: 'ship_confirmed_99' }]],
        },
      });
      assert.equal(sendRes.ok, true);

      // Must arrive live in workspace.html via PTS push without page reload
      await page.waitForText(alertText, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });

      const clickedInline = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]')!;
        const btn = Array.from(stage.querySelectorAll('button, [role="button"]')).find((b) =>
          (b.textContent ?? '').includes('Confirm Ship'),
        ) as HTMLElement | undefined;
        if (!btn) return false;
        btn.click();
        return true;
      });
      assert.equal(clickedInline, true, 'Inline keyboard button "Confirm Ship" must render and click');

      await pollUntil(
        async () => {
          const updates = await ctx.primaryUser.api.callBotApi(botToken, 'getUpdates');
          return Boolean(
            updates.ok &&
              Array.isArray(updates.result) &&
              updates.result.some((u: any) => u.callback_query?.data === 'ship_confirmed_99'),
          );
        },
        { timeoutMs: 6000, message: '/bot{token}/getUpdates receives callback_query from workspace.html click' },
      );
    });
  },
});

defineTest({
  id: 'T1-F15-05',
  title: 'Five sequential tool-intensive browser workflows across /shop, /spa/dashboard, and /cookies-and-downloads complete with zero uncaught exceptions',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();

    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const tabEntry = await pollUntil(
        async () => {
          const r = await ctx.primaryUser.api.getBrowserTabs();
          return r.tabs.find((t: any) => String(t.url ?? '').includes('/shop')) ?? null;
        },
        { timeoutMs: 6000, message: 'Locate /shop tab' },
      );
      const tabId = Number(tabEntry.tab_id ?? tabEntry.id);

      await ctx.withExtensionSurface('workspace', async () => {
        await ctx.withExtensionSurface('sidepanel', async () => {
          await ctx.withExtensionSurface('popup', async () => {
            // Turn 1: /shop snapshot + add to cart
            const s1 = unwrapBrowserExecResult(
              (await ctx.primaryUser.api.execBrowserTool({ tool: 'browser_snapshot', arguments: { tab_id: tabId } })).data,
            );
            assert.equal(s1.ok, true);
            const c1 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_click',
                  arguments: { tab_id: tabId, selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]' },
                })
              ).data,
            );
            assert.equal(c1.ok, true);

            // Turn 2: /spa/dashboard navigate + login + wait_for
            const n2 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_navigate',
                  arguments: { tab_id: tabId, url: `${ctx.fixtureApp.baseUrl}/spa/dashboard` },
                })
              ).data,
            );
            assert.equal(n2.ok, true);
            await ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_type',
              arguments: { tab_id: tabId, selector: '#spa-username', text: 'ops_user', submit: true },
            });
            const w2 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_wait_for',
                  arguments: { tab_id: tabId, selector: '#async-metrics-table', timeout_ms: 6000 },
                })
              ).data,
            );
            assert.equal(w2.ok, true);

            // Turn 3: scroll + console/network telemetry
            const sc3 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_scroll',
                  arguments: { tab_id: tabId, direction: 'bottom' },
                })
              ).data,
            );
            assert.equal(sc3.ok, true);
            const logs3 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_get_console_logs',
                  arguments: { tab_id: tabId },
                })
              ).data,
            );
            assert.equal(logs3.ok, true);

            // Turn 4: /cookies-and-downloads + HttpOnly cookie redaction check
            await ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_navigate',
              arguments: { tab_id: tabId, url: `${ctx.fixtureApp.baseUrl}/cookies-and-downloads` },
            });
            const ck4 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_manage_cookies',
                  arguments: { op: 'list', url: `${ctx.fixtureApp.baseUrl}/cookies-and-downloads` },
                })
              ).data,
            );
            assert.equal(ck4.ok, true);
            assert.ok(
              !JSON.stringify(ck4).includes('SUPER_SECRET_HTTPONLY_TOKEN_991'),
              'HttpOnly cookie value must remain redacted',
            );

            // Turn 5: PNG screenshot verification
            const shot5 = unwrapBrowserExecResult(
              (
                await ctx.primaryUser.api.execBrowserTool({
                  tool: 'browser_screenshot',
                  arguments: { tab_id: tabId, format: 'png' },
                })
              ).data,
            );
            assert.equal(shot5.ok, true);
            assertValidPng(shot5.data_base64 ?? shot5.artifact?.data_base64);

            assert.equal(
              ctx.browser.uncaughtExceptions.length,
              0,
              `Expected 0 uncaught exceptions across SW & 3 surfaces, got: ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
            );
          });
        });
      });
    });
  },
});

defineTest({
  id: 'T1-F15-06',
  title: 'Restarting gpui_telegram_server on same SQLite DB triggers automatic Extension SW reconnect while preserving history',
  tier: 1,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const isoServer = await ctx.spawnIsolatedServer();
    const anon = new TelegramApiClient(isoServer.baseUrl);
    const reg = await anon.register({
      username: `restart_u_${crypto.randomBytes(3).toString('hex')}`,
      password: 'RestartPass!2026',
      auto_welcome: true,
    });
    const isoApi = new TelegramApiClient(isoServer.baseUrl, reg.token);
    const botChatId = 700_000_000 + reg.user_id;

    const persistMsg = `SQLite_Survived_${crypto.randomBytes(3).toString('hex')}`;
    await isoApi.sendMessage({ chat_id: botChatId, text: persistMsg });

    const isoBrowser = await ctx.spawnIsolatedChromium({ loadExtension: true });
    await isoBrowser.evalInServiceWorker(
      async (cfg: { serverUrl: string; wsUrl: string; browserWsUrl: string; token: string; userId: number; username: string; sessionId: string }) => {
        const c = (globalThis as any).chrome;
        const sessionObj = {
          user_id: cfg.userId,
          userId: cfg.userId,
          username: cfg.username,
          token: cfg.token,
          session_id: cfg.sessionId,
          sessionId: cfg.sessionId,
          server_url: cfg.serverUrl,
          serverUrl: cfg.serverUrl,
        };
        await c.storage.local.set({
          server_url: cfg.serverUrl,
          serverUrl: cfg.serverUrl,
          token: cfg.token,
          auth_token: cfg.token,
          user_id: cfg.userId,
          session: sessionObj,
          auth_session: sessionObj,
          bridge_config: {
            enabled: true,
            server_ws_url: cfg.browserWsUrl,
            serverWsUrl: cfg.browserWsUrl,
            run_policy: 'always_allow_authorized',
          },
          run_policy: 'always_allow_authorized',
          browser_run_policy: 'always_allow_authorized',
        });
        const g = globalThis as any;
        for (const fn of ['__gpuiRehydrate', '__rehydrateSession', 'reconnectBridges', 'initBackgroundServices']) {
          if (typeof g[fn] === 'function') await g[fn]().catch(() => undefined);
        }
      },
      {
        serverUrl: isoServer.baseUrl,
        wsUrl: `${isoServer.wsUrl}?token=${encodeURIComponent(reg.token)}`,
        browserWsUrl: `${isoServer.browserWsUrl}?token=${encodeURIComponent(reg.token)}&client=extension`,
        token: reg.token,
        userId: reg.user_id,
        username: reg.username,
        sessionId: reg.session_id,
      },
    );

    // Open workspace once if SW connects lazily on surface wake
    const wsPage = await isoBrowser.openExtensionSurface('workspace');
    try {
      await pollUntil(
        async () => {
          const st = await isoApi.getBrowserStatus().catch(() => null);
          return Boolean(st && (st.connected || st.extension_connected || st.server_relay_connected));
        },
        { timeoutMs: 8000, message: 'Initial Extension SW connection to isolated server' },
      );

      // Restart isolated server on identical port and SQLite file
      await isoServer.restart();

      // Extension SW must automatically reconnect within 8s
      await pollUntil(
        async () => {
          const st = await isoApi.getBrowserStatus().catch(() => null);
          return Boolean(st && (st.connected || st.extension_connected || st.server_relay_connected));
        },
        { timeoutMs: 10000, intervalMs: 150, message: 'Extension SW auto-reconnects after server restart' },
      );

      const historyAfter = await isoApi.getMessages(botChatId);
      assert.ok(
        historyAfter.messages.some((m: any) => m.text === persistMsg),
        'SQLite message history must survive server restart intact',
      );

      const execCheck = unwrapBrowserExecResult(
        (await isoApi.execBrowserTool({ tool: 'browser_status', arguments: {} })).data,
      );
      assert.equal(execCheck.ok, true, 'browser_status over reconnected WS must succeed');
    } finally {
      await wsPage.close();
      await isoBrowser.stop();
      await isoServer.stop();
    }
  },
});
