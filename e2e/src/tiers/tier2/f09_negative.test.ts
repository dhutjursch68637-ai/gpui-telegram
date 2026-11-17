import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  assertBrowserRpcError,
  unwrapBrowserExecResult,
  extractBrowserErrorCode,
  BROWSER_RPC_ERROR_CODES,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function syncBrowserPolicyState(
  ctx: SharedTierContext,
  opts: {
    runPolicy: 'always_allow_authorized' | 'allow_read_only' | 'ask_every_time' | 'disabled';
    allowedDomains?: string[];
    blockedDomains?: string[];
  },
): Promise<void> {
  const allowedDomains = opts.allowedDomains ?? [];
  const blockedDomains = opts.blockedDomains ?? [];

  const putResp = await ctx.primaryUser.api.setBotBrowserProfile(777000, {
    enabled: opts.runPolicy !== 'disabled',
    run_policy: opts.runPolicy,
    allowed_domains: allowedDomains,
    blocked_domains: blockedDomains,
    preferred_target: 'extension',
  });
  assert.ok(putResp, 'Expected BotBrowserProfileDto response from PUT /api/v1/bots/777000/browser');

  await ctx.browser.evalInServiceWorker(
    async (cfg: {
      runPolicy: string;
      allowedDomains: string[];
      blockedDomains: string[];
    }) => {
      const c = (globalThis as any).chrome;
      if (c?.storage?.local) {
        const existing = await c.storage.local.get([
          'bridge_config',
          'desktop_bridge',
          'browser_bridge',
        ]);
        const patchBridge = (obj: any) =>
          obj && typeof obj === 'object' ? { ...obj, run_policy: cfg.runPolicy } : undefined;
        await c.storage.local.set({
          run_policy: cfg.runPolicy,
          browser_run_policy: cfg.runPolicy,
          allowed_domains: cfg.allowedDomains,
          blocked_domains: cfg.blockedDomains,
          emergency_stopped: cfg.runPolicy === 'disabled',
          ...(existing?.bridge_config ? { bridge_config: patchBridge(existing.bridge_config) } : {}),
          ...(existing?.desktop_bridge
            ? { desktop_bridge: patchBridge(existing.desktop_bridge) }
            : {}),
          ...(existing?.browser_bridge
            ? { browser_bridge: patchBridge(existing.browser_bridge) }
            : {}),
        });
      }
      const g = globalThis as any;
      for (const hook of ['__gpuiSyncPolicy', 'setBrowserRunPolicy', 'syncTabsToBridges']) {
        if (typeof g[hook] === 'function') {
          await g[hook](cfg.runPolicy);
        }
      }
    },
    {
      runPolicy: opts.runPolicy,
      allowedDomains,
      blockedDomains,
    },
  );
}

async function resolveLiveTabIdByUrl(
  ctx: SharedTierContext,
  expectedUrlPrefix: string,
): Promise<number> {
  const tabId = await pollUntil(
    async () => {
      const serverTabs = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const list = Array.isArray(serverTabs?.tabs) ? serverTabs.tabs : [];
      const foundServer = list.find(
        (t: any) => typeof t?.url === 'string' && t.url.startsWith(expectedUrlPrefix),
      );
      if (foundServer && typeof foundServer.tab_id === 'number') {
        return foundServer.tab_id as number;
      }

      const swTabs = await ctx.browser.evalInServiceWorker(async (prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        const all = await c.tabs.query({});
        const match = all.find((t: any) => typeof t?.url === 'string' && t.url.startsWith(prefix));
        return typeof match?.id === 'number' ? match.id : null;
      }, expectedUrlPrefix);

      return swTabs;
    },
    {
      timeoutMs: 8000,
      intervalMs: 100,
      message: `resolve tab_id for ${expectedUrlPrefix}`,
      isDone: (id): id is number => typeof id === 'number' && id > 0,
    },
  );
  assert.ok(typeof tabId === 'number' && tabId > 0, `Expected positive tab_id for ${expectedUrlPrefix}`);
  return tabId;
}

async function findAndClickDenyInExtensionUi(page: CdpPageHandle): Promise<boolean> {
  const denySelector = await page.eval(() => {
    document
      .querySelectorAll('[data-e2e-deny-target]')
      .forEach((el) => el.removeAttribute('data-e2e-deny-target'));

    const explicitSelectors = [
      '[data-testid="browser-approval-deny-btn"]',
      '[data-testid="approval-deny-btn"]',
      '[data-testid*="approval"][data-testid*="deny"]',
      '[data-testid*="deny-btn"]',
      '[data-testid*="reject-btn"]',
    ];
    for (const sel of explicitSelectors) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return sel;
        }
      }
    }
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const label = (
        btn.innerText ||
        btn.textContent ||
        btn.getAttribute('aria-label') ||
        ''
      ).trim();
      if (/^(deny|reject|decline|拒绝|不允许)$/i.test(label) || /\b(deny|reject)\b/i.test(label)) {
        btn.setAttribute('data-e2e-deny-target', String(i));
        return `[data-e2e-deny-target="${i}"]`;
      }
    }
    return null;
  });

  if (!denySelector) {
    return false;
  }
  await page.click(denySelector);
  return true;
}

async function denyPendingCommandInWorkspaceUi(page: CdpPageHandle): Promise<boolean> {
  return await pollUntil(
    async () => {
      if (await findAndClickDenyInExtensionUi(page)) {
        return true;
      }

      // Navigate to Studio -> Approvals tab if not rendered inline on the active view
      const openedStudio = await page.eval(() => {
        const rail = document.querySelector('[data-testid="nav-rail"]');
        if (!rail) return false;
        const btns = Array.from(rail.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
        const studioBtn = btns.find((b) =>
          /studio|task|hermes|approval|任务|工作台|审批/i.test(
            `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''}`,
          ),
        );
        if (studioBtn) {
          studioBtn.click();
          return true;
        }
        return false;
      });

      if (openedStudio) {
        await page.eval(() => {
          const tabs = Array.from(document.querySelectorAll('button, [role="tab"]')) as HTMLElement[];
          const appTab = tabs.find((t) => /approval|审批|授权/i.test(t.textContent ?? ''));
          appTab?.click();
        });
      }

      return await findAndClickDenyInExtensionUi(page);
    },
    {
      timeoutMs: 8000,
      intervalMs: 120,
      message: 'Click Deny/Reject button on pending browser command in Extension UI',
    },
  );
}

async function selectRunPolicyInPopupUi(
  ctx: SharedTierContext,
  targetPolicy: 'always_allow_authorized' | 'allow_read_only' | 'ask_every_time' | 'disabled',
): Promise<void> {
  await ctx.primaryUser.api.setBotBrowserProfile(777000, {
    enabled: targetPolicy !== 'disabled',
    run_policy: targetPolicy,
    allowed_domains: [],
    blocked_domains: [],
    preferred_target: 'extension',
  });

  await ctx.withExtensionSurface('popup', async (popupPage) => {
    const selectInfo = await popupPage.waitForTestId('browser-policy-select', {
      state: 'visible',
      timeoutMs: 8000,
    });
    assert.ok(selectInfo, 'Expected [data-testid="browser-policy-select"] in popup.html');
    if (selectInfo.tag === 'select') {
      await popupPage.selectOption('[data-testid="browser-policy-select"]', targetPolicy);
    } else {
      await popupPage.clickTestId('browser-policy-select');
      const clickedOption = await popupPage.eval((pol: string) => {
        const opts = Array.from(
          document.querySelectorAll('[role="option"], [data-value], button, li'),
        ) as HTMLElement[];
        const hit = opts.find(
          (el) =>
            el.getAttribute('data-value') === pol ||
            (el.textContent ?? '').toLowerCase().replace(/\s+/g, '_').includes(pol),
        );
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      }, targetPolicy);
      assert.equal(clickedOption, true, `Expected option "${targetPolicy}" in browser-policy-select`);
    }

    await pollUntil(
      async () => {
        const stored = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          const st = await c.storage.local.get(['run_policy', 'browser_run_policy', 'bridge_config']);
          return (
            st.run_policy ??
            st.browser_run_policy ??
            st.bridge_config?.run_policy ??
            null
          );
        });
        return stored === targetPolicy;
      },
      {
        timeoutMs: 5000,
        intervalMs: 80,
        message: `popup.html browser-policy-select syncs "${targetPolicy}" to chrome.storage.local`,
      },
    );
  });
}

defineTest({
  id: 'T2-F09-01',
  title: 'AskEveryTime policy rejects mutating browser_click with -32002 USER_DENIED_APPROVAL when denied in UI',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    try {
      await ctx.withTargetTab(shopUrl, async (shopTab) => {
        const tabId = await resolveLiveTabIdByUrl(ctx, shopUrl);
        const initialCartCount = await shopTab.eval(
          () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
        );
        assert.equal(initialCartCount, '0', 'Initial /shop #cart-count must be "0"');

        await selectRunPolicyInPopupUi(ctx, 'ask_every_time');

        await ctx.withExtensionSurface('workspace', async (workspacePage) => {
          await workspacePage.waitForSelector(
            '[data-testid="nav-rail"], [data-testid="conversation-stage"]',
            {
              state: 'visible',
              timeoutMs: 10000,
            },
          );

          const execPromise = ctx.primaryUser.api.execBrowserTool(
            {
              tool: 'browser_click',
              arguments: {
                tab_id: tabId,
                selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
              },
              bot_id: 777000,
              chat_id: ctx.primaryUser.officialBotChatId,
              timeout_ms: 15000,
            },
            20000,
          );

          // Verify the mutating click is held for approval rather than auto-executing
          await sleep(300);
          const midCartCount = await shopTab.eval(
            () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
          );
          assert.equal(
            midCartCount,
            '0',
            'Mutating browser_click must NOT execute before user approval under ask_every_time',
          );

          // Strictly deny via the real Extension UI button (zero REST approveBrowserCommand fallback!)
          const deniedViaUi = await denyPendingCommandInWorkspaceUi(workspacePage);
          assert.equal(
            deniedViaUi,
            true,
            'workspace.html must expose a working Deny/Reject button for pending AskEveryTime command',
          );

          const execResp = await execPromise;
          assertBrowserRpcError(
            execResp,
            BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
            'USER_DENIED_APPROVAL',
          );
          const extracted = extractBrowserErrorCode(execResp);
          assert.equal(
            extracted.code,
            BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
            `Expected exact JSON-RPC -32002 on UI approval denial, got ${JSON.stringify(extracted)}`,
          );

          const finalCartCount = await shopTab.eval(
            () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
          );
          assert.equal(finalCartCount, '0', '#cart-count on /shop must remain "0" after denial');
          assert.equal(ctx.fixtureApp.cartItems.length, 0, 'Server cart items must remain empty');
        });
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});

defineTest({
  id: 'T2-F09-02',
  title: 'Disabled policy immediately rejects ReadOnly, Mutating, and HighRisk tools with -32003 POLICY_DISABLED',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const docUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    try {
      await ctx.withTargetTab(docUrl, async () => {
        const tabId = await resolveLiveTabIdByUrl(ctx, docUrl);

        await selectRunPolicyInPopupUi(ctx, 'disabled');

        // 1. ReadOnly tool: browser_snapshot
        const snapResp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_snapshot',
          arguments: { tab_id: tabId },
          bot_id: 777000,
        });
        assertBrowserRpcError(
          snapResp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );
        assert.equal(extractBrowserErrorCode(snapResp).code, BROWSER_RPC_ERROR_CODES.POLICY_DISABLED);

        // 2. Mutating tool: browser_open_tab
        const blockedBetaUrl = `${ctx.fixtureApp.baseUrl}/docs/beta`;
        const openResp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_open_tab',
          arguments: { url: blockedBetaUrl, active: true },
          bot_id: 777000,
        });
        assertBrowserRpcError(
          openResp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );
        assert.equal(extractBrowserErrorCode(openResp).code, BROWSER_RPC_ERROR_CODES.POLICY_DISABLED);

        // 3. HighRisk tool: browser_evaluate
        const evalResp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_evaluate',
          arguments: { tab_id: tabId, expression: 'document.title' },
          bot_id: 777000,
        });
        assertBrowserRpcError(
          evalResp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );
        assert.equal(extractBrowserErrorCode(evalResp).code, BROWSER_RPC_ERROR_CODES.POLICY_DISABLED);

        const targets = await ctx.browser.listTargets();
        assert.ok(
          !targets.some((t) => t.url.includes('/docs/beta')),
          'browser_open_tab must not create /docs/beta tab when policy is disabled',
        );
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});

defineTest({
  id: 'T2-F09-03',
  title: 'AllowReadOnly permits browser_snapshot while blocking unapproved browser_click and browser_evaluate',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    const cookiesUrl = `${ctx.fixtureApp.baseUrl}/cookies-and-downloads`;

    try {
      await ctx.withTargetTab(shopUrl, async (shopTab) => {
        await ctx.withTargetTab(cookiesUrl, async () => {
          const shopTabId = await resolveLiveTabIdByUrl(ctx, shopUrl);
          const cookiesTabId = await resolveLiveTabIdByUrl(ctx, cookiesUrl);

          await syncBrowserPolicyState(ctx, { runPolicy: 'allow_read_only' });

          // ReadOnly tool MUST auto-succeed under allow_read_only
          const snapHttp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: shopTabId },
            bot_id: 777000,
          });
          assert.equal(snapHttp.status, 200);
          const snap = unwrapBrowserExecResult(snapHttp.data);
          assert.equal(snap.ok, true, 'ReadOnly browser_snapshot must succeed under allow_read_only');
          assert.equal(snap.title, 'Fabushi Gear Store');

          // Mutating browser_click MUST NOT auto-execute without explicit approval
          let clickSettled = false;
          const clickPromise = ctx.primaryUser.api
            .execBrowserTool(
              {
                tool: 'browser_click',
                arguments: {
                  tab_id: shopTabId,
                  selector: 'button.add-to-cart-btn[data-sku="SKU-KB-01"]',
                },
                bot_id: 777000,
                timeout_ms: 1500,
              },
              5000,
            )
            .finally(() => {
              clickSettled = true;
            });

          await sleep(300);
          const cartDuringGate = await shopTab.eval(
            () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
          );
          assert.equal(
            cartDuringGate,
            '0',
            'Mutating browser_click must NOT auto-execute under allow_read_only',
          );

          if (!clickSettled) {
            const pending = await ctx.primaryUser.api.getPendingBrowserCommands();
            if (pending.items.length > 0) {
              const cmdId = String(pending.items[0].command_id ?? pending.items[0].id);
              await ctx.primaryUser.api.approveBrowserCommand(cmdId, false, false);
            }
          }
          const clickResp = await clickPromise;
          assertBrowserRpcError(clickResp, [
            BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
            BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          ]);

          // HighRisk browser_evaluate("document.cookie") MUST NOT auto-execute
          let evalSettled = false;
          const evalPromise = ctx.primaryUser.api
            .execBrowserTool(
              {
                tool: 'browser_evaluate',
                arguments: {
                  tab_id: cookiesTabId,
                  expression: 'document.cookie',
                },
                bot_id: 777000,
                timeout_ms: 1500,
              },
              5000,
            )
            .finally(() => {
              evalSettled = true;
            });

          await sleep(250);
          if (!evalSettled) {
            const pending = await ctx.primaryUser.api.getPendingBrowserCommands();
            if (pending.items.length > 0) {
              const cmdId = String(pending.items[0].command_id ?? pending.items[0].id);
              await ctx.primaryUser.api.approveBrowserCommand(cmdId, false, false);
            }
          }
          const evalResp = await evalPromise;
          assertBrowserRpcError(evalResp, [
            BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
            BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
          ]);
          assert.ok(
            !evalResp.rawText.includes('gpui_public_pref'),
            'HighRisk browser_evaluate("document.cookie") must not leak cookie values under allow_read_only',
          );
        });
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});

defineTest({
  id: 'T2-F09-04',
  title: 'Domain ACL blocked_domains:["localhost"] vs allowed_domains:["127.0.0.1"] blocks localhost and permits 127.0.0.1',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const allowedShopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    const blockedShopUrl = `${ctx.fixtureApp.localhostBaseUrl}/shop`;

    try {
      await ctx.withTargetTab(allowedShopUrl, async (allowedTab) => {
        await ctx.withTargetTab(blockedShopUrl, async (blockedTab) => {
          const allowedTabId = await resolveLiveTabIdByUrl(ctx, allowedShopUrl);
          const blockedTabId = await resolveLiveTabIdByUrl(ctx, blockedShopUrl);

          await syncBrowserPolicyState(ctx, {
            runPolicy: 'always_allow_authorized',
            allowedDomains: ['127.0.0.1'],
            blockedDomains: ['localhost'],
          });

          // 1. Navigating allowed tab to blocked localhost domain must fail
          const navBlockedResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_navigate',
            arguments: { tab_id: allowedTabId, url: blockedShopUrl },
            bot_id: 777000,
          });
          assertBrowserRpcError(navBlockedResp, [
            BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
            BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
          ]);

          // 2. Snapshotting blocked localhost tab must fail
          const snapBlockedResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: blockedTabId },
            bot_id: 777000,
          });
          assertBrowserRpcError(snapBlockedResp, [
            BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
            BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
          ]);

          // 3. Clicking on blocked localhost tab must fail and leave #cart-count === "0"
          const clickBlockedResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_click',
            arguments: {
              tab_id: blockedTabId,
              selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
          });
          assertBrowserRpcError(clickBlockedResp, [
            BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
            BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
          ]);
          const blockedCart = await blockedTab.eval(
            () => document.getElementById('cart-count')?.textContent?.trim() ?? '',
          );
          assert.equal(blockedCart, '0', 'Blocked localhost tab #cart-count must remain "0"');

          // 4. Allowed 127.0.0.1 tab snapshot + click MUST succeed
          const snapAllowedResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: allowedTabId },
            bot_id: 777000,
          });
          const snapAllowed = unwrapBrowserExecResult(snapAllowedResp.data);
          assert.equal(snapAllowed.ok, true, 'Allowed 127.0.0.1 snapshot must succeed');
          assert.equal(snapAllowed.title, 'Fabushi Gear Store');

          const clickAllowedResp = await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_click',
            arguments: {
              tab_id: allowedTabId,
              selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]',
            },
            bot_id: 777000,
          });
          const clickAllowed = unwrapBrowserExecResult(clickAllowedResp.data);
          assert.equal(clickAllowed.ok, true, 'Allowed 127.0.0.1 click must succeed');

          await allowedTab.waitForText('1', { selector: '#cart-count', timeoutMs: 4000 });
        });
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});

defineTest({
  id: 'T2-F09-05',
  title: 'High-severity prompt injection on /adversarial/prompt-injection escalates subsequent mutating browser_click under AlwaysAllowAuthorized',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const advUrl = `${ctx.fixtureApp.baseUrl}/adversarial/prompt-injection`;
    try {
      await ctx.withTargetTab(advUrl, async (advTab) => {
        const tabId = await resolveLiveTabIdByUrl(ctx, advUrl);
        await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });

        // Step 1: Snapshot the adversarial fixture page
        const snapResp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_snapshot',
          arguments: { tab_id: tabId },
          bot_id: 777000,
        });
        assert.equal(snapResp.status, 200);
        const snap = unwrapBrowserExecResult(snapResp.data);
        assert.equal(snap.ok, true, 'browser_snapshot itself is ReadOnly and returns scan diagnostics');
        assert.ok(snap.injection_scan, 'Expected injection_scan metadata in browser_snapshot result');
        assert.equal(
          snap.injection_scan.flagged,
          true,
          'Expected scan_content_for_injection flagged === true on /adversarial/prompt-injection',
        );
        assert.equal(
          String(snap.injection_scan.severity).toLowerCase(),
          'high',
          `Expected high injection severity, got ${JSON.stringify(snap.injection_scan)}`,
        );

        // Step 2: Attempt mutating click on #danger-exfil-btn WITHOUT pre-approval
        let clickResolved = false;
        const clickPromise = ctx.primaryUser.api
          .execBrowserTool(
            {
              tool: 'browser_click',
              arguments: { tab_id: tabId, selector: '#danger-exfil-btn' },
              bot_id: 777000,
              chat_id: ctx.primaryUser.officialBotChatId,
              timeout_ms: 12000,
            },
            16000,
          )
          .finally(() => {
            clickResolved = true;
          });

        await sleep(350);
        const midExfilLog = await advTab.eval(
          () => document.getElementById('action-log')?.textContent?.trim() ?? '',
        );
        assert.notEqual(
          midExfilLog,
          'EXFIL_TRIGGERED',
          'Post-injection mutating browser_click must be escalated to approval, NEVER auto-executed',
        );

        // If escalated to pending approval (rather than immediately rejected with -32003), deny strictly via Extension UI!
        if (!clickResolved) {
          await ctx.withExtensionSurface('workspace', async (wsPage) => {
            await wsPage.waitForSelector(
              '[data-testid="nav-rail"], [data-testid="conversation-stage"]',
              { state: 'visible', timeoutMs: 10000 },
            );
            const deniedInUi = await denyPendingCommandInWorkspaceUi(wsPage);
            assert.equal(
              deniedInUi,
              true,
              'Escalated post-injection approval must be surfaced and deniable in Extension UI',
            );
          });
        }

        const clickResp = await clickPromise;
        assertBrowserRpcError(
          clickResp,
          [BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL, BROWSER_RPC_ERROR_CODES.POLICY_DISABLED],
          'USER_DENIED_APPROVAL',
        );

        const finalDomState = await advTab.eval(() => ({
          actionLog: document.getElementById('action-log')?.textContent?.trim() ?? '',
          clickedAttr: document.getElementById('danger-exfil-btn')?.getAttribute('data-clicked'),
        }));
        assert.equal(finalDomState.actionLog, '', 'Exfil button handler must never have fired');
        assert.equal(finalDomState.clickedAttr, null, 'danger-exfil-btn data-clicked must remain null');
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});

defineTest({
  id: 'T2-F09-06',
  title: 'Emergency stop (Alt+Shift+S / emergency-stop-btn / bridge.emergency_stop) aborts active browser_wait_for with -32003 and detaches chrome.debugger',
  tier: 2,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const spaUrl = `${ctx.fixtureApp.baseUrl}/spa/dashboard`;
    try {
      await ctx.withTargetTab(spaUrl, async () => {
        const tabId = await resolveLiveTabIdByUrl(ctx, spaUrl);
        await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });

        // Ensure an active extension chrome.debugger session is attached to tabId before triggering kill-switch
        const attachedBefore = await ctx.browser.evalInServiceWorker(async (tId: number) => {
          const c = (globalThis as any).chrome;
          if (!c?.debugger) return false;
          const existing = await c.debugger.getTargets();
          const already = existing.some((t: any) => t.tabId === tId && t.attached);
          if (!already) {
            await c.debugger.attach({ tabId: tId }, '1.3');
          }
          const after = await c.debugger.getTargets();
          return after.some((t: any) => t.tabId === tId && t.attached);
        }, tabId);
        assert.equal(attachedBefore, true, 'Precondition: chrome.debugger should be attached to target tab');

        // Verify manifest registers emergency-stop-bot command on Alt+Shift+S
        const hasEmergencyCommand = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          if (!c?.commands?.getAll) return false;
          const cmds = await c.commands.getAll();
          return cmds.some(
            (cmd: any) =>
              cmd.name === 'emergency-stop-bot' ||
              String(cmd.shortcut ?? '').replace(/\s+/g, '') === 'Alt+Shift+S',
          );
        });
        assert.equal(
          hasEmergencyCommand,
          true,
          'Expected emergency-stop-bot (Alt+Shift+S) registered in chrome.commands.getAll()',
        );

        let waitSettled = false;
        const waitPromise = ctx.primaryUser.api
          .execBrowserTool(
            {
              tool: 'browser_wait_for',
              arguments: {
                tab_id: tabId,
                selector: '#never-renders-during-killswitch',
                timeout_ms: 15000,
              },
              bot_id: 777000,
              timeout_ms: 20000,
            },
            22000,
          )
          .finally(() => {
            waitSettled = true;
          });

        // Let browser_wait_for enter active polling on the target tab
        await sleep(250);
        assert.equal(waitSettled, false, 'browser_wait_for should still be active before kill-switch');

        const stopTriggeredAt = Date.now();
        await ctx.withExtensionSurface('popup', async (popupPage) => {
          await popupPage.pressKey('Alt+Shift+S');
          await sleep(150);
          if (!waitSettled) {
            const stopBtn = await popupPage.querySelector('[data-testid="emergency-stop-btn"]');
            assert.ok(stopBtn, 'Expected [data-testid="emergency-stop-btn"] in popup.html');
            await popupPage.clickTestId('emergency-stop-btn');
          }
        });

        const waitResp = await waitPromise;
        const abortLatencyMs = Date.now() - stopTriggeredAt;
        assert.ok(
          abortLatencyMs < 1500,
          `Emergency stop must abort active browser_wait_for quickly (< 1500ms), took ${abortLatencyMs}ms`,
        );

        assertBrowserRpcError(
          waitResp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );
        assert.equal(extractBrowserErrorCode(waitResp).code, BROWSER_RPC_ERROR_CODES.POLICY_DISABLED);

        // Verify zero attached extension debuggers remain
        const attachedTargets = await pollUntil(
          async () => {
            return await ctx.browser.evalInServiceWorker(async () => {
              const c = (globalThis as any).chrome;
              if (!c?.debugger?.getTargets) return [];
              const all = await c.debugger.getTargets();
              return all.filter((t: any) => t.attached === true);
            });
          },
          {
            timeoutMs: 2000,
            intervalMs: 80,
            message: 'Verify chrome.debugger detached all targets after emergency stop',
            isDone: (list) => list.length === 0,
          },
        );
        assert.equal(
          attachedTargets.length,
          0,
          `Expected zero attached chrome.debugger targets after Emergency Stop, got ${JSON.stringify(attachedTargets)}`,
        );

        // Verify run_policy switched to disabled
        const statusAfter = await ctx.primaryUser.api.getBrowserStatus();
        const swPolicy = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          const st = await c.storage.local.get(['run_policy', 'browser_run_policy']);
          return st.run_policy ?? st.browser_run_policy;
        });
        assert.ok(
          statusAfter.run_policy === 'disabled' || swPolicy === 'disabled',
          `Expected run_policy === "disabled" after Emergency Stop (server=${statusAfter.run_policy}, sw=${swPolicy})`,
        );
      });
    } finally {
      await syncBrowserPolicyState(ctx, { runPolicy: 'always_allow_authorized' });
    }
  },
});
