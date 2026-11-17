import {
  assert,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function ensureSidepanelComposerReady(panel: CdpPageHandle): Promise<void> {
  const quickComposer = await panel
    .waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 2000 })
    .catch(() => null);
  if (quickComposer?.visible) {
    return;
  }

  // If sidepanel requires selecting the Extension Bot / Official Bot dialog row first, click it
  await panel.eval(() => {
    const candidates = Array.from(
      document.querySelectorAll('[data-testid="chat-sidebar"] *, button, [role="listitem"], [role="button"]'),
    ) as HTMLElement[];
    const botRow = candidates.find((el) => {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return (
        txt.includes('bot') ||
        txt.includes('assistant') ||
        txt.includes('hermes') ||
        txt.includes('fabushi')
      );
    });
    if (botRow) botRow.click();
  });

  await panel.waitForTestId('canonical-composer-input', {
    state: 'visible',
    timeoutMs: 6000,
  });
}

async function sendPromptInSidepanel(panel: CdpPageHandle, promptText: string): Promise<void> {
  await ensureSidepanelComposerReady(panel);
  await panel.typeTestId('canonical-composer-input', promptText, { clearFirst: true });
  const sendBtn = await panel.querySelector('[data-testid="composer-send-btn"]');
  if (sendBtn?.visible && !sendBtn.disabled) {
    await panel.clickTestId('composer-send-btn');
  } else {
    await panel.pressKey('Enter');
  }
}

async function configureExtBotProvider(
  ctx: SharedTierContext,
  providerCfg: Record<string, unknown>,
): Promise<void> {
  await ctx.browser.evalInServiceWorker(async (cfg: Record<string, unknown>) => {
    const c = (globalThis as any).chrome;
    if (c?.storage?.local) {
      await c.storage.local.set({
        llm_provider: cfg,
        ext_bot_config: cfg,
        ai_providers: [cfg],
        ext_bot_enabled: true,
        local_bot_mode: true,
      });
    }
  }, providerCfg);
}

async function restoreDefaultExtBotProvider(ctx: SharedTierContext): Promise<void> {
  const defaultCfg = {
    provider_id: 'openai',
    provider: 'openai',
    name: 'Local E2E Mock OpenAI',
    api_mode: 'chat_completions',
    base_url: ctx.mockLlm.v1BaseUrl,
    baseUrl: ctx.mockLlm.v1BaseUrl,
    api_key: 'sk-mock-e2e-token',
    apiKey: 'sk-mock-e2e-token',
    model: 'gpt-4o',
    default_model: 'gpt-4o',
    enabled: true,
    active: true,
  };
  await ctx.browser.evalInServiceWorker(async (cfg: Record<string, unknown>) => {
    const c = (globalThis as any).chrome;
    if (c?.storage?.local) {
      await c.storage.local.remove(['ext_bot_enabled', 'local_bot_mode']);
      await c.storage.local.set({
        llm_provider: cfg,
        ext_bot_config: cfg,
        ai_providers: [cfg],
      });
    }
  }, defaultCfg);
}

defineTest({
  id: 'T1-F08-01',
  title: 'Run In-Extension Bot (ext_bot_runner) OpenAI tool-call loop from sidepanel.html to add item to cart on /shop',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await configureExtBotProvider(ctx, {
      provider_id: 'openai',
      provider: 'openai',
      name: 'Local E2E Mock OpenAI',
      api_mode: 'chat_completions',
      base_url: ctx.mockLlm.v1BaseUrl,
      baseUrl: ctx.mockLlm.v1BaseUrl,
      api_key: 'sk-mock-e2e-token',
      apiKey: 'sk-mock-e2e-token',
      model: 'gpt-4o',
      default_model: 'gpt-4o',
      enabled: true,
      active: true,
    });

    try {
      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async (shopTab) => {
        const serverShopTab = await pollUntil(
          async () => {
            const r = await ctx.primaryUser.api.getBrowserTabs();
            return r.tabs?.find((t: any) => String(t?.url ?? '').includes('/shop')) ?? null;
          },
          { timeoutMs: 5000, intervalMs: 80, message: '/shop tab synced' },
        );
        const shopTabId = Number(serverShopTab!.tab_id);

        ctx.mockLlm.registerScenario('f08_local_bot', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              reasoning: 'Taking snapshot of active storefront tab from Extension Bot...',
              toolCalls: [{ name: 'browser_snapshot', arguments: { tab_id: shopTabId } }],
            };
          }
          if (turnCtx.turnIndex === 1) {
            const els: any[] = turnCtx.latestToolResult?.json?.interactive_elements ?? [];
            const addBtn = els.find(
              (e) =>
                String(e?.selector ?? '').includes('SKU-KB-02') ||
                String(e?.label ?? '').includes('Compact Travel Keyboard') ||
                String(e?.label ?? '').includes('Add to Cart'),
            );
            return {
              reasoning: 'Clicking Add to Cart on storefront...',
              toolCalls: [
                {
                  name: 'browser_click',
                  arguments: addBtn?.ref
                    ? { tab_id: shopTabId, ref: addBtn.ref }
                    : { tab_id: shopTabId, selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]' },
                },
              ],
            };
          }
          return {
            content: 'F08_LOCAL_BOT_DONE: Added Compact Travel Keyboard to cart.',
          };
        });

        await ctx.withExtensionSurface('sidepanel', async (panel) => {
          await sendPromptInSidepanel(
            panel,
            '[E2E_SCENARIO:f08_local_bot] Add Compact Travel Keyboard to cart on the open store tab.',
          );

          await pollUntil(
            async () => (await shopTab.querySelector('#cart-count'))?.text === '1',
            { timeoutMs: 12000, intervalMs: 100, message: 'Live /shop #cart-count === "1"' },
          );

          await panel.waitForText('F08_LOCAL_BOT_DONE', { timeoutMs: 12000 });
        });

        assert.ok(
          ctx.mockLlm.recordedRequests.some(
            (r) => r.matchedScenarioId === 'f08_local_bot' && r.turnIndex >= 2,
          ),
          'Expected multi-step tool loop recorded on MockLlmServer',
        );
      });
    } finally {
      await restoreDefaultExtBotProvider(ctx);
    }
  },
});

defineTest({
  id: 'T1-F08-02',
  title: 'Route In-Extension Bot through Server Magpie Gateway with SSE streaming tool-call synthesis',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    const magpieBaseUrl = `${ctx.server.baseUrl}/api/v1/magpie/v1`;
    await ctx.primaryUser.api.put('/api/v1/hermes/magpie/providers', {
      provider_id: 'openai',
      name: 'Magpie Mock OpenAI',
      api_mode: 'chat_completions',
      base_url: ctx.mockLlm.v1BaseUrl,
      default_model: 'gpt-4o',
      api_key: 'sk-mock-e2e-token',
      enabled: true,
      activate: true,
      allow_local_fallback: false,
    });

    await configureExtBotProvider(ctx, {
      provider_id: 'magpie',
      provider: 'magpie',
      name: 'Server Magpie Gateway',
      api_mode: 'chat_completions',
      base_url: magpieBaseUrl,
      baseUrl: magpieBaseUrl,
      api_key: ctx.primaryUser.token,
      apiKey: ctx.primaryUser.token,
      model: 'gpt-4o',
      default_model: 'gpt-4o',
      enabled: true,
      active: true,
    });

    try {
      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
        const alphaTab = await pollUntil(
          async () => {
            const r = await ctx.primaryUser.api.getBrowserTabs();
            return r.tabs?.find((t: any) => String(t?.url ?? '').includes('/docs/alpha')) ?? null;
          },
          { timeoutMs: 5000, intervalMs: 80, message: '/docs/alpha synced' },
        );
        await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_activate_tab',
          arguments: { tab_id: alphaTab.tab_id },
        });

        ctx.mockLlm.registerScenario('f08_magpie_stream', (turnCtx) => {
          if (turnCtx.turnIndex === 0) {
            return {
              reasoning: 'Checking active browser tab via Magpie SSE gateway...',
              toolCalls: [{ name: 'browser_list_tabs', arguments: {} }],
            };
          }
          const raw = turnCtx.latestToolResult?.rawContent ?? '';
          const foundAlpha = raw.includes('Alpha Cloud Pricing') || raw.includes('/docs/alpha');
          return {
            reasoning: 'Formatting final active tab answer...',
            content: foundAlpha
              ? 'F08_MAGPIE_STREAM_OK: Found Alpha Cloud Pricing'
              : `F08_MAGPIE_MISSING: ${raw.slice(0, 120)}`,
          };
        });

        await ctx.withExtensionSurface('sidepanel', async (panel) => {
          await sendPromptInSidepanel(
            panel,
            '[E2E_SCENARIO:f08_magpie_stream] Which cloud pricing tab do I have open?',
          );
          await panel.waitForText('F08_MAGPIE_STREAM_OK: Found Alpha Cloud Pricing', {
            timeoutMs: 12000,
          });
        });
      });
    } finally {
      await restoreDefaultExtBotProvider(ctx);
    }
  },
});

defineTest({
  id: 'T1-F08-03',
  title: 'Execute /browser status and /browser snapshot slash commands directly in sidepanel.html without external LLM calls',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    ctx.mockLlm.reset();

    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/beta`, async () => {
      const betaTab = await pollUntil(
        async () => {
          const r = await ctx.primaryUser.api.getBrowserTabs();
          return r.tabs?.find((t: any) => String(t?.url ?? '').includes('/docs/beta')) ?? null;
        },
        { timeoutMs: 5000, intervalMs: 80, message: '/docs/beta synced' },
      );
      await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_activate_tab',
        arguments: { tab_id: betaTab.tab_id },
      });

      await ctx.withExtensionSurface('sidepanel', async (panel) => {
        await sendPromptInSidepanel(panel, '/browser status');
        await pollUntil(
          async () => {
            const stageText = await panel.eval(() => {
              const el = document.querySelector('[data-testid="conversation-stage"]') ?? document.body;
              return (el as HTMLElement).innerText || el.textContent || '';
            });
            return /connect|online|active|always_allow_authorized/i.test(stageText);
          },
          { timeoutMs: 6000, intervalMs: 80, message: '/browser status bubble in sidepanel.html' },
        );

        await sendPromptInSidepanel(panel, '/browser snapshot');
        await panel.waitForText('Beta Cloud', { timeoutMs: 8000 });
      });

      assert.equal(
        ctx.mockLlm.recordedRequests.length,
        0,
        '/browser slash commands must execute locally/directly without calling external LLM completions',
      );
    });
  },
});

defineTest({
  id: 'T1-F08-04',
  title: 'Verify simultaneous Dual-Bridge connectivity to both Server Relay (/api/v1/browser/ws) and Desktop Bridge (127.0.0.1:<port>/ext/ws)',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      const dualState = await pollUntil(
        async () => {
          const [execResp, srvStatus, deskHealth] = await Promise.all([
            ctx.primaryUser.api.execBrowserTool({ tool: 'browser_status', arguments: {} }),
            ctx.primaryUser.api.getBrowserStatus(),
            ctx.desktopBridge.getHealth(),
          ]);
          if (execResp.status !== 200) return null;
          const toolStatus = unwrapBrowserExecResult(execResp.data);
          const srvOk = Boolean(
            srvStatus.connected ??
              srvStatus.extension_connected ??
              srvStatus.server_relay_connected,
          );
          const deskOk = Boolean(deskHealth.extension_connected ?? deskHealth.connected);
          if (
            toolStatus.ok === true &&
            toolStatus.server_relay_connected === true &&
            toolStatus.desktop_bridge_connected === true &&
            srvOk &&
            deskOk
          ) {
            return { toolStatus, srvStatus, deskHealth };
          }
          return null;
        },
        {
          timeoutMs: 6000,
          intervalMs: 100,
          message: 'Simultaneous server_relay_connected && desktop_bridge_connected',
        },
      );

      assert.ok(dualState);
      assert.equal(dualState.toolStatus.connected, true);
      assert.equal(dualState.toolStatus.server_relay_connected, true);
      assert.equal(dualState.toolStatus.desktop_bridge_connected, true);
    });
  },
});

defineTest({
  id: 'T1-F08-05',
  title: 'Push automatic bridge.tabs_sync updates to BOTH Server (/api/v1/browser/tabs) and Desktop Bridge (/json/list) on tab open and close',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    const gammaUrl = `${ctx.fixtureApp.baseUrl}/docs/gamma`;

    const preServerTabs = await ctx.primaryUser.api.getBrowserTabs();
    assert.ok(
      !(preServerTabs.tabs ?? []).some((t: any) => String(t?.url ?? '').includes('/docs/gamma')),
      '/docs/gamma must not exist in server tabs before open',
    );

    await ctx.withTargetTab(gammaUrl, async () => {
      // Without invoking any browser_exec tool, wait <= 2.5s for automatic bridge.tabs_sync push to BOTH endpoints
      const synced = await pollUntil(
        async () => {
          const [srvTabsResp, deskTargets] = await Promise.all([
            ctx.primaryUser.api.getBrowserTabs(),
            ctx.desktopBridge.getJsonList(),
          ]);
          const srvGamma = (srvTabsResp.tabs ?? []).find((t: any) =>
            String(t?.url ?? '').includes('/docs/gamma'),
          );
          const deskGamma = deskTargets.find((t: any) =>
            String(t?.url ?? '').includes('/docs/gamma'),
          );
          return srvGamma && deskGamma ? { srvGamma, deskGamma } : null;
        },
        {
          timeoutMs: 2500,
          intervalMs: 60,
          message: 'Automatic bridge.tabs_sync push of /docs/gamma to both Server and Desktop Bridge',
        },
      );

      assert.ok(synced);
      assert.equal(synced.srvGamma.title, 'Gamma Cloud Pricing');
      assert.equal(synced.deskGamma.title, 'Gamma Cloud Pricing');
    });

    // After closing /docs/gamma tab, both inventories must automatically remove it
    await pollUntil(
      async () => {
        const [srvTabsResp, deskTargets] = await Promise.all([
          ctx.primaryUser.api.getBrowserTabs(),
          ctx.desktopBridge.getJsonList(),
        ]);
        const srvGone = !(srvTabsResp.tabs ?? []).some((t: any) =>
          String(t?.url ?? '').includes('/docs/gamma'),
        );
        const deskGone = !deskTargets.some((t: any) =>
          String(t?.url ?? '').includes('/docs/gamma'),
        );
        return srvGone && deskGone;
      },
      {
        timeoutMs: 3000,
        intervalMs: 60,
        message: 'Automatic removal of closed /docs/gamma tab from both bridges',
      },
    );
  },
});

defineTest({
  id: 'T1-F08-06',
  title: 'Run ext_bot_runner in LocalHermes deterministic offline mode when external LLM endpoints are unconfigured',
  tier: 1,
  features: ['F8'],
  fn: async (ctx: SharedTierContext) => {
    await configureExtBotProvider(ctx, {
      provider_id: 'local_hermes',
      provider: 'local_hermes',
      name: 'LocalHermes Offline Engine',
      api_mode: 'local_hermes',
      base_url: '',
      baseUrl: '',
      api_key: '',
      apiKey: '',
      model: 'local-hermes',
      default_model: 'local-hermes',
      enabled: true,
      active: true,
    });
    ctx.mockLlm.setStickyError(503, { error: { message: 'External LLM intentionally offline' } });

    try {
      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
        await pollUntil(
          async () => {
            const r = await ctx.primaryUser.api.getBrowserTabs();
            return r.tabs?.some((t: any) => String(t?.url ?? '').includes('/docs/alpha'));
          },
          { timeoutMs: 5000, intervalMs: 80, message: '/docs/alpha synced for LocalHermes' },
        );

        await ctx.withExtensionSurface('sidepanel', async (panel) => {
          await sendPromptInSidepanel(panel, '/browser tabs');
          await pollUntil(
            async () => {
              const stageText = await panel.eval(() => {
                const el =
                  document.querySelector('[data-testid="conversation-stage"]') ?? document.body;
                return (el as HTMLElement).innerText || el.textContent || '';
              });
              return (
                stageText.includes('Alpha Cloud Pricing') || stageText.includes('/docs/alpha')
              );
            },
            {
              timeoutMs: 8000,
              intervalMs: 80,
              message: 'LocalHermes offline /browser tabs output in sidepanel.html',
            },
          );

          const statusResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_status',
            arguments: {},
          });
          assert.equal(statusResp.status, 200);
          const browserStatus = unwrapBrowserExecResult(statusResp.data);
          assert.equal(
            browserStatus.server_relay_connected,
            true,
            `Expected browserStatus.server_relay_connected === true, got ${JSON.stringify(browserStatus)}`,
          );
          assert.equal(
            browserStatus.desktop_bridge_connected,
            true,
            `Expected browserStatus.desktop_bridge_connected === true, got ${JSON.stringify(browserStatus)}`,
          );
        });
      });
    } finally {
      ctx.mockLlm.clearStickyError();
      await restoreDefaultExtBotProvider(ctx);
    }
  },
});
