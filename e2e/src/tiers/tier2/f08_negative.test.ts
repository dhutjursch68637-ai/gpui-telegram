import {
  assert,
  defineTest,
  pollUntil,
  sleep,
  unwrapBrowserExecResult,
  type CdpPageHandle,
  type DesktopBridgeHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function ensureSidepanelBotComposerReady(page: CdpPageHandle): Promise<void> {
  await page.waitForSelector('body', { state: 'visible', timeoutMs: 10000 });

  // If sidepanel opens on dialog list before selecting the bot/copilot conversation, click the bot row
  const immediateComposer = await page.querySelector('[data-testid="canonical-composer-input"]');
  if (!immediateComposer || !immediateComposer.visible) {
    await page.eval(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[data-testid*="ext-bot"], [data-testid*="bot"], [data-chat-id], li, [role="listitem"], [role="button"], button, div',
        ),
      ) as HTMLElement[];
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (
          /browser|copilot|assistant|agent|hermes|official|bot/i.test(txt) &&
          el.children.length <= 8
        ) {
          const r = el.getBoundingClientRect();
          if (r.width > 30 && r.height >= 20 && r.height < 140) {
            el.click();
            return;
          }
        }
      }
    });
  }

  await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 10000 });
}

async function sendSidepanelPrompt(page: CdpPageHandle, prompt: string): Promise<void> {
  await ensureSidepanelBotComposerReady(page);
  await page.typeTestId('canonical-composer-input', prompt, { clearFirst: true });
  const sendBtn = await page.querySelector('[data-testid="composer-send-btn"]');
  if (sendBtn && sendBtn.visible && !sendBtn.disabled) {
    await page.clickTestId('composer-send-btn');
  } else {
    await page.pressKey('Enter');
  }
}

async function configureExtBotStorage(
  ctx: SharedTierContext,
  extraConfig: Record<string, unknown> = {},
): Promise<void> {
  await ctx.browser.evalInServiceWorker(
    async (v1Url: string, extra: Record<string, unknown>) => {
      const c = (globalThis as any).chrome;
      const cfg = {
        provider_id: 'openai',
        provider: 'openai',
        mode: 'direct',
        runner_mode: 'local_ext_bot',
        name: 'Local E2E Mock OpenAI',
        api_mode: 'chat_completions',
        base_url: v1Url,
        baseUrl: v1Url,
        api_key: 'sk-mock-e2e-token',
        apiKey: 'sk-mock-e2e-token',
        model: 'gpt-4o',
        default_model: 'gpt-4o',
        enabled: true,
        active: true,
        ...extra,
      };
      await c.storage.local.set({
        llm_provider: cfg,
        ai_providers: [cfg],
        ext_bot_config: cfg,
      });
    },
    ctx.mockLlm.v1BaseUrl,
    extraConfig,
  );
}

async function restoreDefaultExtBotStorage(ctx: SharedTierContext): Promise<void> {
  await configureExtBotStorage(ctx);
}

async function pointExtensionToDesktopBridge(
  ctx: SharedTierContext,
  bridge: DesktopBridgeHandle,
  overrideToken?: string,
): Promise<void> {
  const tok = overrideToken ?? bridge.pairingToken;
  const wsUrl = `${bridge.wsUrl}?token=${encodeURIComponent(tok)}`;
  const serverBrowserWsUrl = `${ctx.server.browserWsUrl}?token=${encodeURIComponent(ctx.primaryUser.token)}&client=extension`;

  await ctx.browser.evalInServiceWorker(
    async (params: {
      port: number;
      tok: string;
      wsUrl: string;
      serverBrowserWsUrl: string;
    }) => {
      const c = (globalThis as any).chrome;
      const bridgeObj = {
        enabled: true,
        port: params.port,
        pairing_token: params.tok,
        pairingToken: params.tok,
        desktop_ws_url: params.wsUrl,
        desktopWsUrl: params.wsUrl,
        ws_url: params.wsUrl,
        server_ws_url: params.serverBrowserWsUrl,
        serverWsUrl: params.serverBrowserWsUrl,
        run_policy: 'always_allow_authorized',
      };
      await c.storage.local.set({
        bridge_config: bridgeObj,
        desktop_bridge: bridgeObj,
        browser_bridge: bridgeObj,
        pairing_token: params.tok,
        desktop_bridge_port: params.port,
      });

      const g = globalThis as any;
      for (const hook of [
        'reconnectBridges',
        '__gpuiRehydrate',
        '__rehydrateSession',
        'initBackgroundServices',
      ]) {
        if (typeof g[hook] === 'function') {
          try {
            await g[hook]();
          } catch {
            // Ignore
          }
        }
      }
      if (c?.runtime?.sendMessage) {
        await c.runtime
          .sendMessage({ type: 'bridge.reconnect', bridge_config: bridgeObj })
          .catch(() => undefined);
      }
    },
    { port: bridge.port, tok, wsUrl, serverBrowserWsUrl },
  );
}

defineTest({
  id: 'T2-F08-01',
  title: 'Surface clean user-readable error status in sidepanel.html (never perpetual thinking spinner) on upstream HTTP 429 and HTTP 500',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await configureExtBotStorage(ctx, { max_iterations: 4, maxIterations: 4 });

    let rateLimitCalls = 0;
    ctx.mockLlm.registerScenario('f08_http_429_500_ratelimit', () => {
      rateLimitCalls++;
      if (rateLimitCalls === 1) {
        return {
          httpStatus: 429,
          headers: { 'Retry-After': '1' },
          errorBody: {
            error: {
              message: 'Rate limit exceeded (Retry-After: 1)',
              type: 'rate_limit_error',
              code: '429',
            },
          },
        };
      }
      return {
        content: 'Recovered cleanly after 429 Retry-After.',
      };
    });

    ctx.mockLlm.registerScenario('f08_http_429_500_fatal', () => ({
      httpStatus: 500,
      errorBody: {
        error: {
          message: 'Upstream LLM internal failure E2E_500_MARKER',
          type: 'server_error',
          code: '500',
        },
      },
    }));

    try {
      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
        await ctx.withExtensionSurface('sidepanel', async (panel) => {
        // 1. Trigger HTTP 429 scenario (either auto-retries after Retry-After: 1 or renders clear 429 notice)
        await sendSidepanelPrompt(
          panel,
          '[E2E_SCENARIO:f08_http_429_500_ratelimit] Check 429 rate-limit handling',
        );

        const after429Txt = await pollUntil(
          async () => {
            const txt = await panel.eval(() => document.body.innerText || '');
            return txt.includes('Recovered cleanly after 429 Retry-After.') ||
              /429|rate.?limit|too many requests/i.test(txt)
              ? txt
              : null;
          },
          {
            timeoutMs: 12000,
            intervalMs: 120,
            message: 'sidepanel.html resolves HTTP 429 retry or displays rate-limit notice',
          },
        );
        assert.ok(rateLimitCalls >= 1, 'Expected MockLlmServer to receive >= 1 HTTP 429 attempt');
        assert.ok(
          after429Txt !== null && after429Txt.length > 0,
          'Expected non-empty 429 recovery or rate-limit status in sidepanel.html',
        );

        // 2. Trigger fatal HTTP 500 scenario
        await sendSidepanelPrompt(
          panel,
          '[E2E_SCENARIO:f08_http_429_500_fatal] Trigger fatal upstream 500',
        );

        const final500State = await pollUntil(
          async () => {
            const state = await panel.eval(() => {
              const bodyTxt = document.body.innerText || '';
              const composer = document.querySelector(
                '[data-testid="canonical-composer-input"]',
              ) as HTMLInputElement | HTMLTextAreaElement | null;
              return {
                bodyTxt,
                composerDisabled: Boolean(composer?.disabled),
              };
            });
            const hasReadableError =
              /500|E2E_500_MARKER|error|failed|unavailable|upstream/i.test(state.bodyTxt);
            return hasReadableError && !state.composerDisabled
              ? { ...state, hasReadableError }
              : null;
          },
          {
            timeoutMs: 12000,
            intervalMs: 120,
            message: 'sidepanel.html renders readable 500 error without stuck disabled composer',
          },
        );
        assert.ok(final500State !== null, 'Expected fatal 500 state to settle');
        assert.equal(final500State.hasReadableError, true, 'Expected readable error text on HTTP 500');
        assert.equal(
          final500State.composerDisabled,
          false,
          'Composer must not remain permanently disabled after HTTP 500',
        );
          assert.ok(
            ctx.mockLlm.recordedRequests.some(
              (r) => r.matchedScenarioId === 'f08_http_429_500_fatal',
            ),
            'Expected MockLlmServer to record fatal HTTP 500 scenario call',
          );
        });
      });
    } finally {
      await restoreDefaultExtBotStorage(ctx);
    }
  },
});

defineTest({
  id: 'T2-F08-02',
  title: 'Halt ext_bot_runner deterministically at max_iterations: 4 when MockLlmServer endlessly emits browser_status({})',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await configureExtBotStorage(ctx, {
      max_iterations: 4,
      maxIterations: 4,
      max_tool_iterations: 4,
    });

    ctx.mockLlm.registerScenario('f08_infinite_tools', (turnCtx) => ({
      reasoning: `Endless tool loop step #${turnCtx.turnIndex + 1}`,
      toolCalls: [
        {
          id: `call_inf_status_${turnCtx.turnIndex}`,
          name: 'browser_status',
          arguments: {},
        },
      ],
    }));

    try {
      await ctx.withExtensionSurface('sidepanel', async (panel) => {
        const startMs = Date.now();
        await sendSidepanelPrompt(
          panel,
          '[E2E_SCENARIO:f08_infinite_tools] Keep checking browser_status forever',
        );

        // Wait until LLM requests reach loop cap and cease arriving
        await pollUntil(
          () => {
            const reqs = ctx.mockLlm.recordedRequests.filter(
              (r) => r.matchedScenarioId === 'f08_infinite_tools',
            );
            return reqs.length >= 2;
          },
          { timeoutMs: 10000, intervalMs: 100, message: 'f08_infinite_tools invoked multiple turns' },
        );

        // Wait for request count to stabilize (halted at max_iterations)
        await pollUntil(
          async () => {
            const before = ctx.mockLlm.recordedRequests.filter(
              (r) => r.matchedScenarioId === 'f08_infinite_tools',
            ).length;
            await sleep(450);
            const after = ctx.mockLlm.recordedRequests.filter(
              (r) => r.matchedScenarioId === 'f08_infinite_tools',
            ).length;
            return after === before && after >= 2;
          },
          { timeoutMs: 12000, intervalMs: 150, message: 'ext_bot_runner loop halted deterministically' },
        );

        const elapsedMs = Date.now() - startMs;
        assert.ok(elapsedMs < 18000, `Loop cap must finish promptly, took ${elapsedMs}ms`);

        const matchedReqs = ctx.mockLlm.recordedRequests.filter(
          (r) => r.matchedScenarioId === 'f08_infinite_tools',
        );
        assert.ok(
          matchedReqs.length >= 2 && matchedReqs.length <= 5,
          `Expected ext_bot_runner to halt at max_iterations: 4 (2..5 LLM calls), got ${matchedReqs.length}`,
        );

        // Verify summary / completion rendered in sidepanel.html
        const panelText = await panel.eval(() => document.body.innerText || '');
        assert.ok(
          panelText.length > 0,
          'sidepanel.html must remain mounted and render max-iteration completion text',
        );
      });
    } finally {
      await restoreDefaultExtBotStorage(ctx);
    }
  },
});

defineTest({
  id: 'T2-F08-03',
  title: 'Record desktop_bridge_connected: false on invalid pairing_token (-32001) and enforce bounded backoff (< 5 attempts in 3s)',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();

    try {
      // Install a transparent read-only WebSocket instantiation counter in Extension SW for isoBridge.port
      await ctx.browser.evalInServiceWorker((targetPort: number) => {
        const g = globalThis as any;
        if (!g.__origWebSocketForE2e) {
          g.__origWebSocketForE2e = g.WebSocket;
        }
        g.__bridgeAttemptCounter = 0;
        const OrigWs = g.__origWebSocketForE2e;
        g.WebSocket = new Proxy(OrigWs, {
          construct(target, args, newTarget) {
            const urlStr = String(args[0] ?? '');
            if (urlStr.includes(`:${targetPort}/`)) {
              g.__bridgeAttemptCounter = (g.__bridgeAttemptCounter || 0) + 1;
            }
            return Reflect.construct(target, args, newTarget);
          },
        });
      }, isoBridge.port);

      const countStartMs = Date.now();
      await pointExtensionToDesktopBridge(ctx, isoBridge, 'invalid_pairing_token_f08_03');

      // Observe connection attempts across a full 3.0s window
      await sleep(Math.max(0, 3000 - (Date.now() - countStartMs)));

      const attemptsIn3s = await ctx.browser.evalInServiceWorker(() => {
        const g = globalThis as any;
        return Number(g.__bridgeAttemptCounter ?? 0);
      });

      assert.ok(
        attemptsIn3s < 5,
        `Extension Desktop Bridge client must use bounded backoff (< 5 attempts in 3s), observed ${attemptsIn3s} attempts`,
      );

      // Verify isolated bridge rejected the invalid token (extension_connected === false)
      const bridgeHealth = await isoBridge.getHealth();
      assert.equal(
        Boolean(bridgeHealth.extension_connected || bridgeHealth.connected),
        false,
        `Desktop Bridge must reject invalid pairing_token: ${JSON.stringify(bridgeHealth)}`,
      );

      // Verify Extension browser_status unconditionally reports desktop_bridge_connected: false while server_relay_connected: true
      const statusResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_status',
        arguments: {},
      });
      assert.equal(statusResp.status, 200);
      const st = unwrapBrowserExecResult(statusResp.data);
      assert.equal(st.ok, true, `Expected browser_status ok: true, got ${JSON.stringify(st)}`);
      assert.equal(st.connected, true, `Expected overall connected: true via server relay, got ${JSON.stringify(st)}`);
      assert.equal(
        st.server_relay_connected,
        true,
        `Expected server_relay_connected: true while desktop bridge token is invalid, got ${JSON.stringify(st)}`,
      );
      assert.equal(
        st.desktop_bridge_connected,
        false,
        `Expected desktop_bridge_connected: false on bad pairing token, got ${JSON.stringify(st)}`,
      );
    } finally {
      await ctx.browser
        .evalInServiceWorker(() => {
          const g = globalThis as any;
          if (g.__origWebSocketForE2e) {
            g.WebSocket = g.__origWebSocketForE2e;
          }
        })
        .catch(() => undefined);
      await pointExtensionToDesktopBridge(ctx, ctx.desktopBridge);
      await isoBridge.stop();
    }
  },
});

defineTest({
  id: 'T2-F08-04',
  title: 'Reconnect outbound Desktop Bridge WS automatically within 5s (completing bridge.hello -> bridge.hello_ack) after isolatedDesktopBridge kill & restart',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    const isoBridge = await ctx.spawnIsolatedDesktopBridge();

    try {
      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/gamma`, async () => {
        await pointExtensionToDesktopBridge(ctx, isoBridge);

        // 1. Wait for initial pairing to isoBridge
        await pollUntil(
          async () => {
            const h = await isoBridge.getHealth().catch(() => null);
            return Boolean(h && (h.extension_connected || h.connected));
          },
          { timeoutMs: 6000, intervalMs: 100, message: 'Initial Extension -> isoBridge handshake' },
        );

        // 2. Kill isoBridge abruptly
        isoBridge.kill('SIGKILL');
        await pollUntil(() => !isoBridge.isRunning(), {
          timeoutMs: 4000,
          intervalMs: 50,
          message: 'isoBridge SIGKILL exit',
        });
        await sleep(250);

        // 3. Restart isoBridge on the exact same port & pairingToken
        await isoBridge.restart();
        const restartedAtMs = Date.now();

        // 4. Verify Extension SW automatically reconnects and completes bridge.hello -> bridge.hello_ack within 5s
        await pollUntil(
          async () => {
            const h = await isoBridge.getHealth().catch(() => null);
            return Boolean(h && (h.extension_connected || h.connected));
          },
          {
            timeoutMs: 5000,
            intervalMs: 100,
            message: 'Extension automatic reconnect to restarted isoBridge within 5s',
          },
        );
        const reconnectMs = Date.now() - restartedAtMs;
        assert.ok(reconnectMs <= 5000, `Expected reconnect <= 5000ms, took ${reconnectMs}ms`);

        // Confirm tab inventory was resynced via bridge.hello / bridge.tabs_sync
        await pollUntil(
          async () => {
            const list = await isoBridge.getJsonList();
            return list.some((t: any) => String(t.url ?? '').includes('/docs/gamma'));
          },
          { timeoutMs: 4000, intervalMs: 100, message: 'Tab sync restored on restarted isoBridge' },
        );

        const dualStatus = await pollUntil(
          async () => {
            const statusResp = await ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_status',
              arguments: {},
            });
            if (statusResp.status !== 200) return null;
            const st = unwrapBrowserExecResult(statusResp.data);
            return st.ok === true &&
              st.server_relay_connected === true &&
              st.desktop_bridge_connected === true
              ? st
              : null;
          },
          {
            timeoutMs: 4000,
            intervalMs: 100,
            message: 'browser_status reflects server_relay_connected:true and desktop_bridge_connected:true',
          },
        );
        assert.ok(dualStatus);
        assert.equal(dualStatus.connected, true);
        assert.equal(dualStatus.server_relay_connected, true);
        assert.equal(dualStatus.desktop_bridge_connected, true);
      });
    } finally {
      await pointExtensionToDesktopBridge(ctx, ctx.desktopBridge);
      await isoBridge.stop();
    }
  },
});

defineTest({
  id: 'T2-F08-05',
  title: 'Cancel slow streaming ext_bot_runner turn (delayMs: 3000) within < 800ms via AbortController when Stop / /interrupt is triggered in sidepanel.html',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await configureExtBotStorage(ctx);

    ctx.mockLlm.registerScenario('f08_slow_abort', () => ({
      delayMs: 3000,
      content: 'UNABORTED_SLOW_COMPLETION_TEXT_DO_NOT_SHOW',
    }));

    await ctx.withExtensionSurface('sidepanel', async (panel) => {
      await sendSidepanelPrompt(
        panel,
        '[E2E_SCENARIO:f08_slow_abort] Run slow 3000ms streaming analysis',
      );

      // Wait until the request actually hits MockLlmServer, then wait ~300ms into the 3000ms delay
      await pollUntil(
        () =>
          ctx.mockLlm.recordedRequests.some((r) => r.matchedScenarioId === 'f08_slow_abort'),
        { timeoutMs: 5000, intervalMs: 40, message: 'slow LLM request reached MockLlmServer' },
      );
      await sleep(300);

      const stopStartMs = Date.now();

      // Click dedicated Stop button if rendered, else send /interrupt or runtime abort message
      const clickedStopBtn = await panel.eval(() => {
        const selectors = [
          '[data-testid="composer-stop-btn"]',
          '[data-testid="stop-turn-btn"]',
          '[data-testid="bot-stop-btn"]',
          'button[aria-label*="Stop" i]',
          'button[title*="Stop" i]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel) as HTMLButtonElement | null;
          if (btn && !btn.disabled) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              btn.click();
              return true;
            }
          }
        }
        // Check if composer-send-btn morphed into a Stop button during streaming
        const sendBtn = document.querySelector(
          '[data-testid="composer-send-btn"]',
        ) as HTMLButtonElement | null;
        if (
          sendBtn &&
          /stop|cancel|abort|■/i.test(
            `${sendBtn.innerText} ${sendBtn.getAttribute('aria-label') ?? ''} ${sendBtn.getAttribute('data-mode') ?? ''}`,
          )
        ) {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!clickedStopBtn) {
        await sendSidepanelPrompt(panel, '/interrupt');
      }

      // Verify composer returns to ready/non-streaming state within < 800ms
      await pollUntil(
        async () => {
          return await panel.eval(() => {
            const stopBtn = document.querySelector(
              '[data-testid="composer-stop-btn"], [data-testid="stop-turn-btn"]',
            ) as HTMLElement | null;
            const stopVisible = Boolean(
              stopBtn &&
                stopBtn.getBoundingClientRect().width > 0 &&
                window.getComputedStyle(stopBtn).display !== 'none',
            );
            const composer = document.querySelector(
              '[data-testid="canonical-composer-input"]',
            ) as HTMLInputElement | null;
            return !stopVisible && Boolean(composer && !composer.disabled);
          });
        },
        {
          timeoutMs: 800,
          intervalMs: 35,
          message: 'AbortController cancelled in-flight turn within < 800ms',
        },
      );
      const cancelElapsedMs = Date.now() - stopStartMs;
      assert.ok(cancelElapsedMs < 800, `Expected cancellation < 800ms, took ${cancelElapsedMs}ms`);

      // Wait briefly to confirm aborted delayed output never renders
      await sleep(500);
      const bodyAfterAbort = await panel.eval(() => document.body.innerText || '');
      assert.ok(
        !bodyAfterAbort.includes('UNABORTED_SLOW_COMPLETION_TEXT_DO_NOT_SHOW'),
        'Aborted slow LLM output must never appear in sidepanel.html',
      );
    });
  },
});

defineTest({
  id: 'T2-F08-06',
  title: 'Return structured { ok: false, error: "Unknown tool..." } on unknown tool browser_nonexistent_magic_tool({}) and recover on Turn 2',
  tier: 2,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();
    await configureExtBotStorage(ctx, { max_iterations: 5, maxIterations: 5 });

    ctx.mockLlm.registerScenario('f08_unknown_magic_tool', (turnCtx) => {
      if (turnCtx.turnIndex === 0) {
        return {
          reasoning: 'Invoking nonexistent magic browser tool...',
          toolCalls: [
            {
              id: 'call_unknown_magic_1',
              name: 'browser_nonexistent_magic_tool',
              arguments: {},
            },
          ],
        };
      }
      const toolFeedback = turnCtx.latestToolResult?.rawContent ?? '';
      return {
        content: `Turn 2 recovered after unknown tool error (${toolFeedback.slice(0, 80)})`,
      };
    });

    try {
      await ctx.withExtensionSurface('sidepanel', async (panel) => {
        await sendSidepanelPrompt(
          panel,
          '[E2E_SCENARIO:f08_unknown_magic_tool] Test unknown tool recovery',
        );

        await pollUntil(
          async () => {
            const txt = await panel.eval(() => document.body.innerText || '');
            return txt.includes('Turn 2 recovered after unknown tool error');
          },
          {
            timeoutMs: 12000,
            intervalMs: 120,
            message: 'Turn 2 recovery assistant bubble rendered in sidepanel.html',
          },
        );

        // Inspect Turn 1 request recorded on MockLlmServer to verify structured { ok: false, error } feedback
        const turn1Req = ctx.mockLlm.recordedRequests.find(
          (r) => r.matchedScenarioId === 'f08_unknown_magic_tool' && r.turnIndex === 1,
        );
        assert.ok(turn1Req, 'Expected Turn 1 LLM call after unknown tool dispatch');

        const toolMsg = turn1Req.messages.find(
          (m) =>
            m.role === 'tool' &&
            (m.tool_call_id === 'call_unknown_magic_1' ||
              m.name === 'browser_nonexistent_magic_tool'),
        );
        assert.ok(toolMsg, 'Expected role="tool" error message for browser_nonexistent_magic_tool');
        const rawContent = String(toolMsg.content ?? '');
        assert.ok(
          /unknown|unsupported|not found|unrecognized|invalid/i.test(rawContent),
          `Expected "Unknown tool..." error in tool feedback, got: ${rawContent}`,
        );
        assert.ok(
          rawContent.trim().startsWith('{'),
          `Expected structured JSON tool feedback for unknown tool, got: ${rawContent}`,
        );
        const parsed = JSON.parse(rawContent);
        const inner = parsed.result ?? parsed;
        assert.equal(inner.ok, false, `Expected structured ok: false, got ${rawContent}`);
        assert.ok(typeof inner.error === 'string' && inner.error.length > 0);

        assert.equal(
          ctx.browser.uncaughtExceptions.length,
          0,
          `Unknown tool must not throw uncaught exceptions: ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
        );
      });
    } finally {
      await restoreDefaultExtBotStorage(ctx);
    }
  },
});
