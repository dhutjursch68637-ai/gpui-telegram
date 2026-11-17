import * as fs from 'node:fs';
import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  assertValidPng,
  unwrapBrowserExecResult,
  extractBrowserErrorCode,
  type SharedTierContext,
} from '../../harness/index.ts';

async function resolveTabId(ctx: SharedTierContext, urlPrefix: string): Promise<number> {
  return await pollUntil(
    async () => {
      const serverTabs = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const found = serverTabs?.tabs?.find(
        (t: any) => typeof t?.url === 'string' && t.url.startsWith(urlPrefix),
      );
      if (found && typeof found.tab_id === 'number') return found.tab_id as number;

      return await ctx.browser.evalInServiceWorker(async (prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        const all = await c.tabs.query({});
        const m = all.find((t: any) => typeof t?.url === 'string' && t.url.startsWith(prefix));
        return typeof m?.id === 'number' ? m.id : null;
      }, urlPrefix);
    },
    {
      timeoutMs: 8000,
      intervalMs: 80,
      message: `resolve tab_id for ${urlPrefix}`,
      isDone: (v): v is number => typeof v === 'number' && v > 0,
    },
  );
}

function readProcessVmRssKb(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(raw);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

defineTest({
  id: 'T2-F15-01',
  title: '4 concurrent POST /api/v1/browser/exec calls across 2 distinct tabs (/docs/alpha & /docs/beta) maintain 100% JSON-RPC id + tab_id isolation',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    const betaUrl = `${ctx.fixtureApp.baseUrl}/docs/beta`;

    await ctx.withTargetTab(alphaUrl, async () => {
      await ctx.withTargetTab(betaUrl, async () => {
        const [tabAlphaId, tabBetaId] = await Promise.all([
          resolveTabId(ctx, alphaUrl),
          resolveTabId(ctx, betaUrl),
        ]);
        assert.notEqual(tabAlphaId, tabBetaId, 'Alpha and Beta tabs must have distinct tab_ids');

        // Dispatch 4 simultaneous tool invocations interleaved across both tabs
        const [snapAlphaResp, snapBetaResp, mdAlphaResp, mdBetaResp] = await Promise.all([
          ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: tabAlphaId },
            bot_id: 777000,
          }),
          ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: tabBetaId },
            bot_id: 777000,
          }),
          ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_extract_markdown',
            arguments: { tab_id: tabAlphaId },
            bot_id: 777000,
          }),
          ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_extract_markdown',
            arguments: { tab_id: tabBetaId },
            bot_id: 777000,
          }),
        ]);

        assert.equal(snapAlphaResp.status, 200);
        assert.equal(snapBetaResp.status, 200);
        assert.equal(mdAlphaResp.status, 200);
        assert.equal(mdBetaResp.status, 200);

        const snapAlpha = unwrapBrowserExecResult(snapAlphaResp.data);
        const snapBeta = unwrapBrowserExecResult(snapBetaResp.data);
        const mdAlpha = unwrapBrowserExecResult(mdAlphaResp.data);
        const mdBeta = unwrapBrowserExecResult(mdBetaResp.data);

        assert.equal(snapAlpha.ok, true);
        assert.equal(snapAlpha.tab_id, tabAlphaId);
        assert.equal(snapAlpha.title, 'Alpha Cloud Pricing');
        assert.ok(!String(snapAlpha.markdown_excerpt ?? '').includes('Beta Cloud Pricing'));

        assert.equal(snapBeta.ok, true);
        assert.equal(snapBeta.tab_id, tabBetaId);
        assert.equal(snapBeta.title, 'Beta Cloud Pricing');
        assert.ok(!String(snapBeta.markdown_excerpt ?? '').includes('Alpha Cloud Pricing'));

        assert.equal(mdAlpha.ok, true);
        assert.equal(mdAlpha.tab_id, tabAlphaId);
        assert.ok(String(mdAlpha.markdown ?? '').includes('$19/mo'));
        assert.ok(String(mdAlpha.markdown ?? '').includes('Tokyo'));
        assert.ok(!String(mdAlpha.markdown ?? '').includes('$29/mo'));

        assert.equal(mdBeta.ok, true);
        assert.equal(mdBeta.tab_id, tabBetaId);
        assert.ok(String(mdBeta.markdown ?? '').includes('$29/mo'));
        assert.ok(String(mdBeta.markdown ?? '').includes('Frankfurt'));
        assert.ok(!String(mdBeta.markdown ?? '').includes('$19/mo'));
      });
    });
  },
});

defineTest({
  id: 'T2-F15-02',
  title: 'Killing isolatedDesktopBridge (SIGKILL) mid-execution while Server Relay stays alive cleanly routes bot browser turn via /api/v1/browser/ws',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();
    const gammaUrl = `${ctx.fixtureApp.baseUrl}/docs/gamma`;

    try {
      // Point Extension SW desktop bridge config to isoBridge while keeping server_ws_url alive
      await ctx.browser.evalInServiceWorker(
        async (bCfg: { port: number; token: string; wsUrl: string }) => {
          const c = (globalThis as any).chrome;
          const cur = await c.storage.local.get(['bridge_config']);
          const nextBridge = {
            ...(cur.bridge_config ?? {}),
            enabled: true,
            port: bCfg.port,
            pairing_token: bCfg.token,
            pairingToken: bCfg.token,
            desktop_ws_url: `${bCfg.wsUrl}?token=${encodeURIComponent(bCfg.token)}`,
            desktopWsUrl: `${bCfg.wsUrl}?token=${encodeURIComponent(bCfg.token)}`,
            ws_url: `${bCfg.wsUrl}?token=${encodeURIComponent(bCfg.token)}`,
          };
          await c.storage.local.set({
            bridge_config: nextBridge,
            desktop_bridge: nextBridge,
            browser_bridge: nextBridge,
            pairing_token: bCfg.token,
            desktop_bridge_port: bCfg.port,
          });
          const g = globalThis as any;
          if (typeof g.reconnectBridges === 'function') {
            await g.reconnectBridges();
          }
        },
        {
          port: isoBridge.port,
          token: isoBridge.pairingToken,
          wsUrl: isoBridge.wsUrl,
        },
      );
      await sleep(300);

      await ctx.withTargetTab(gammaUrl, async () => {
        const gammaTabId = await resolveTabId(ctx, gammaUrl);

        // Abruptly SIGKILL isolatedDesktopBridge mid-flight!
        isoBridge.kill('SIGKILL');
        await pollUntil(() => !isoBridge.isRunning(), {
          timeoutMs: 3000,
          intervalMs: 50,
          message: 'isoBridge terminated by SIGKILL',
        });

        // Verify Server Relay (/api/v1/browser/ws) remains connected and executes a real Hermes browser turn
        ctx.mockLlm.registerScenario('t2_f15_relay_survivor', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              reasoning: 'Desktop bridge died; reading /docs/gamma through Server Relay...',
              toolCalls: [
                {
                  id: 'call_f15_gamma_snap',
                  name: 'browser_snapshot',
                  arguments: { tab_id: gammaTabId },
                },
              ],
            };
          }
          const snapJson = turnCtx.latestToolResult?.json ?? {};
          return {
            content: `Server Relay survived SIGKILL: title=${snapJson.title ?? 'missing'} excerpt=${String(snapJson.markdown_excerpt ?? '').slice(0, 120)}`,
          };
        });

        const turn = await ctx.primaryUser.api.createHermesTurn({
          prompt: '[E2E_SCENARIO:t2_f15_relay_survivor] Read Gamma Cloud Pricing tab',
          bot_id: 777000,
        });
        assert.equal(turn.status, 'completed');
        assert.ok(
          String(turn.response ?? '').includes('Gamma Cloud Pricing'),
          `Expected Server Relay turn to read "Gamma Cloud Pricing", got: ${String(turn.response)}`,
        );

        const relayStatus = await ctx.primaryUser.api.getBrowserStatus();
        assert.ok(
          relayStatus.connected || relayStatus.extension_connected || relayStatus.server_relay_connected,
          'Server Relay WS must remain connected after Desktop Bridge SIGKILL',
        );
      });
    } finally {
      await isoBridge.stop().catch(() => undefined);
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F15-03',
  title: 'full_page:true browser_screenshot on 2600px /spa/dashboard (<32 MiB PNG) and paginated browser_extract_markdown on /large-dom?nodes=5000',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const spaUrl = `${ctx.fixtureApp.baseUrl}/spa/dashboard`;
    const largeDomUrl = `${ctx.fixtureApp.baseUrl}/large-dom?nodes=5000`;

    await ctx.withTargetTab(
      spaUrl,
      async () => {
        await ctx.withTargetTab(largeDomUrl, async () => {
          const spaTabId = await resolveTabId(ctx, spaUrl);
          const largeTabId = await resolveTabId(ctx, largeDomUrl);

          // 1. Full-page screenshot on 2600px tall /spa/dashboard
          const shotResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_screenshot',
            arguments: {
              tab_id: spaTabId,
              full_page: true,
              format: 'png',
            },
            bot_id: 777000,
          });
          assert.equal(shotResp.status, 200);
          assert.ok(
            Buffer.byteLength(shotResp.rawText, 'utf-8') < 32 * 1024 * 1024,
            'JSON-RPC screenshot response must stay strictly below 32 MiB wire limit',
          );

          const shot = unwrapBrowserExecResult(shotResp.data);
          assert.equal(shot.ok, true);
          const pngBase64: string = shot.data_base64 ?? shot.artifact?.data_base64 ?? '';
          assert.ok(pngBase64.length > 100, 'Expected non-empty base64 PNG screenshot data');

          const pngMeta = assertValidPng(pngBase64, {
            minWidth: 600,
            minHeight: 1200,
          });
          assert.ok(
            pngMeta.height > 1200 && pngMeta.byteLength < 32 * 1024 * 1024,
            `Expected full-page PNG height > 1200px (< 32 MiB), got ${pngMeta.width}x${pngMeta.height} (${pngMeta.byteLength}B)`,
          );

          // 2. Paginated browser_extract_markdown with offset: 500, max_chars: 1500 on 5000-node DOM
          const [page0Resp, pageOffsetResp] = await Promise.all([
            ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_extract_markdown',
              arguments: { tab_id: largeTabId, max_chars: 1500, offset: 0 },
              bot_id: 777000,
            }),
            ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_extract_markdown',
              arguments: { tab_id: largeTabId, max_chars: 1500, offset: 500 },
              bot_id: 777000,
            }),
          ]);
          assert.equal(page0Resp.status, 200);
          assert.equal(pageOffsetResp.status, 200);

          const md0 = unwrapBrowserExecResult(page0Resp.data);
          const mdOffset = unwrapBrowserExecResult(pageOffsetResp.data);

          assert.equal(mdOffset.ok, true);
          assert.ok(
            Number(mdOffset.total_chars ?? 0) > 10000,
            `Expected total_chars > 10000 on /large-dom?nodes=5000, got ${mdOffset.total_chars}`,
          );
          const sliceText = String(mdOffset.markdown ?? '');
          assert.ok(
            sliceText.length > 0 && sliceText.length <= 1650,
            `Expected markdown slice bounded by max_chars: 1500, got length ${sliceText.length}`,
          );
          assert.notEqual(
            sliceText,
            String(md0.markdown ?? ''),
            'offset: 500 slice must advance past offset: 0 content',
          );
        });
      },
      { viewport: { width: 1280, height: 800 } },
    );
  },
});

defineTest({
  id: 'T2-F15-04',
  title: 'Rapidly opening and closing sidepanel.html and popup.html 5 times during streaming bot turn throws zero disconnected-port SW errors',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();
    const completionMarker = `STREAM_CHURN_SURVIVED_${Date.now()}`;

    ctx.mockLlm.registerScenario('t2_f15_surface_churn', (turnCtx) => {
      if (turnCtx.turnIndex === 0) {
        return {
          delayMs: 250,
          reasoning: 'Checking live browser status while UI surfaces churn...',
          toolCalls: [
            {
              id: 'call_churn_status',
              name: 'browser_status',
              arguments: {},
            },
          ],
        };
      }
      return {
        delayMs: 350,
        reasoning: 'Streaming final chunks across active ports...',
        content: `Completed clean stream: ${completionMarker}`,
      };
    });

    await ctx.withExtensionSurface('workspace', async (workspacePage) => {
      await workspacePage.waitForTestId('conversation-stage', {
        state: 'visible',
        timeoutMs: 10000,
      });

      // Kick off streaming turn delivered to primaryUser's officialBotChatId
      const turnPromise = ctx.primaryUser.api.createHermesTurn({
        prompt: `[E2E_SCENARIO:t2_f15_surface_churn] Stream during surface churn`,
        chat_id: ctx.primaryUser.officialBotChatId,
        bot_id: 777000,
        deliver_to_chat: true,
      });

      // Rapidly open & close sidepanel.html and popup.html 5 times while turn streams
      for (let i = 0; i < 5; i++) {
        const [sp, pp] = await Promise.all([
          ctx.browser.openExtensionSurface('sidepanel'),
          ctx.browser.openExtensionSurface('popup'),
        ]);
        await sleep(45);
        await Promise.all([sp.close(), pp.close()]);
      }

      const turnResult = await turnPromise;
      assert.equal(turnResult.status, 'completed');
      assert.ok(String(turnResult.response ?? '').includes(completionMarker));

      await workspacePage.waitForText(completionMarker, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });

      assert.equal(
        ctx.browser.uncaughtExceptions.length,
        0,
        `Expected zero Service Worker disconnected-port exceptions during 5x surface churn, got ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
      );
      assert.equal(
        workspacePage.pageExceptions.length,
        0,
        `Expected zero workspace.html exceptions during surface churn, got ${JSON.stringify(workspacePage.pageExceptions)}`,
      );
    });
  },
});

defineTest({
  id: 'T2-F15-05',
  title: 'Reloading target tab mid-snapshot completes cleanly or returns structured error without leaving orphaned chrome.debugger attachment',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;

    await ctx.withTargetTab(alphaUrl, async (alphaTab) => {
      const tabId = await resolveTabId(ctx, alphaUrl);

      // Fire browser_snapshot concurrently with a hard page reload on the same tab
      const snapDuringReloadPromise = ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
        bot_id: 777000,
        timeout_ms: 10000,
      });
      await sleep(15);
      const reloadPromise = alphaTab.reload(true);

      const [midSnapResp] = await Promise.all([snapDuringReloadPromise, reloadPromise]);
      assert.notEqual(
        midSnapResp.status,
        500,
        'Concurrent reload during browser_snapshot must not cause HTTP 500',
      );

      const unwrappedMid = unwrapBrowserExecResult(midSnapResp.data);
      if (unwrappedMid?.ok === true) {
        assert.equal(unwrappedMid.tab_id, tabId);
      } else {
        const errInfo = extractBrowserErrorCode(midSnapResp);
        assert.ok(
          errInfo.code !== undefined || errInfo.symbolicCode !== undefined,
          `Expected structured retryable JSON-RPC error on mid-reload snapshot, got ${midSnapResp.rawText}`,
        );
      }

      // Verify follow-up snapshot immediately succeeds cleanly on post-reload DOM
      const postReloadSnapResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
        bot_id: 777000,
      });
      const postSnap = unwrapBrowserExecResult(postReloadSnapResp.data);
      assert.equal(postSnap.ok, true, 'Follow-up browser_snapshot after reload must succeed');
      assert.equal(postSnap.title, 'Alpha Cloud Pricing');

      // Verify zero orphaned chrome.debugger sessions left attached unless actively needed
      const attachedDebuggers = await ctx.browser.evalInServiceWorker(async (tId: number) => {
        const c = (globalThis as any).chrome;
        if (!c?.debugger?.getTargets) return [];
        const all = await c.debugger.getTargets();
        return all.filter((t: any) => t.tabId === tId && t.attached === true);
      }, tabId);
      assert.equal(
        attachedDebuggers.length,
        0,
        `browser_snapshot + concurrent reload must not leave orphaned chrome.debugger attachment on tab ${tabId}`,
      );
    });
  },
});

defineTest({
  id: 'T2-F15-06',
  title: 'Rapid burst of 20 chat messages + 2 bot tool turns produces zero crashes, zero SQLITE_BUSY 500 errors, and stays within RSS budget',
  tier: 2,
  features: ['F15'],
  fn: async (ctx: SharedTierContext) => {
    const burstGroup = await ctx.primaryUser.api.createChat({
      title: 'Burst Load & SQLite WAL Room',
      chat_type: 'group',
    });
    const chatId = Number(burstGroup.chat_id ?? burstGroup.id);

    ctx.mockLlm.registerScenario('t2_f15_burst_turn', (turnCtx) => {
      if (turnCtx.turnIndex === 0) {
        return {
          toolCalls: [
            {
              id: 'call_burst_status',
              name: 'browser_status',
              arguments: {},
            },
          ],
        };
      }
      return { content: 'Burst tool turn completed cleanly' };
    });

    try {
      const msgPromises = Array.from({ length: 20 }, (_, idx) =>
        ctx.primaryUser.api.request('POST', '/api/v1/messages/send', {
          chat_id: chatId,
          text: `Burst concurrent message #${idx + 1}`,
          client_nonce: Date.now() * 1000 + idx + 1,
        }),
      );

      const turnPromises = [
        ctx.primaryUser.api.createHermesTurn({
          prompt: '[E2E_SCENARIO:t2_f15_burst_turn] Concurrent tool turn A',
          bot_id: 777000,
        }),
        ctx.primaryUser.api.createHermesTurn({
          prompt: '[E2E_SCENARIO:t2_f15_burst_turn] Concurrent tool turn B',
          bot_id: 777000,
        }),
      ];

      const [msgResults, turnResults] = await Promise.all([
        Promise.all(msgPromises),
        Promise.all(turnPromises),
      ]);

      // Zero HTTP 500 / SQLITE_BUSY errors across all 20 concurrent writes
      for (const [idx, res] of msgResults.entries()) {
        assert.equal(
          res.status,
          200,
          `Message #${idx + 1} failed during burst (expected 200, got ${res.status}: ${res.rawText})`,
        );
      }
      for (const t of turnResults) {
        assert.equal(t.status, 'completed');
        assert.ok(String(t.response ?? '').includes('Burst tool turn completed cleanly'));
      }

      const history = await ctx.primaryUser.api.getMessages(chatId, { limit: 50 });
      assert.ok(
        history.messages.length >= 20,
        `Expected all 20 burst messages persisted in SQLite WAL, got ${history.messages.length}`,
      );

      // Process health & 2-vCPU / 7.8GiB container RSS budget verification
      assert.equal(ctx.server.isRunning(), true);
      assert.equal(ctx.server.exitCode, null);
      assert.equal(ctx.desktopBridge.isRunning(), true);
      assert.equal(ctx.browser.isRunning(), true);

      const serverRssKb = readProcessVmRssKb(ctx.server.pid);
      const bridgeRssKb = readProcessVmRssKb(ctx.desktopBridge.pid);
      const browserRssKb = readProcessVmRssKb(ctx.browser.pid);
      const combinedRssMb = Math.round((serverRssKb + bridgeRssKb + browserRssKb) / 1024);

      assert.ok(
        serverRssKb > 0 && combinedRssMb < 3072,
        `Combined primary process RSS (${combinedRssMb} MiB) must stay well within 7.8 GiB container envelope`,
      );
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});
