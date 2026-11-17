import WebSocket from 'ws';
import {
  BROWSER_RPC_ERROR_CODES,
  assert,
  assertBrowserRpcError,
  defineTest,
  extractBrowserErrorCode,
  pollUntil,
  sleep,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function resolveTabId(ctx: SharedTierContext, urlPrefix: string): Promise<number> {
  return await pollUntil(
    async () => {
      const swId = await ctx.browser.evalInServiceWorker((prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        return c.tabs.query({}).then((tabs: any[]) => {
          const m = tabs.find(
            (t) => typeof t.url === 'string' && t.url.startsWith(prefix) && typeof t.id === 'number',
          );
          return m ? Number(m.id) : null;
        });
      }, urlPrefix);
      if (typeof swId === 'number' && swId > 0) return swId;
      const list = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const found = list?.tabs?.find(
        (t: any) => typeof t.url === 'string' && t.url.startsWith(urlPrefix),
      );
      return typeof found?.tab_id === 'number' ? found.tab_id : null;
    },
    { timeoutMs: 6000, intervalMs: 70, message: `resolve tab_id for ${urlPrefix}` },
  ).then((id) => {
    assert.ok(typeof id === 'number' && id > 0);
    return id;
  });
}

async function createChromeInternalTab(ctx: SharedTierContext, url: string): Promise<number> {
  const id = await ctx.browser.evalInServiceWorker(async (targetUrl: string) => {
    const c = (globalThis as any).chrome;
    const created = await c.tabs.create({ url: targetUrl, active: false });
    return Number(created.id);
  }, url);
  assert.ok(id > 0);

  await pollUntil(
    async () => {
      const currentUrl = await ctx.browser.evalInServiceWorker(async (tabId: number) => {
        const c = (globalThis as any).chrome;
        const t = await c.tabs.get(tabId);
        return String(t.url ?? t.pendingUrl ?? '');
      }, id);
      return currentUrl.startsWith(url);
    },
    { timeoutMs: 5000, intervalMs: 60, message: `wait for ${url} tab ready` },
  );
  return id;
}

async function removeTabSafe(ctx: SharedTierContext, tabId: number): Promise<void> {
  await ctx.browser
    .evalInServiceWorker(async (id: number) => {
      const c = (globalThis as any).chrome;
      await c.tabs.remove(id);
    }, tabId)
    .catch(() => undefined);
}

defineTest({
  id: 'T2-F07-01',
  title: 'Mark chrome://version & chrome://extensions as controllable: false in browser_list_tabs and fail snapshot/click/evaluate with -32004 RESTRICTED_URL',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    const versionTabId = await createChromeInternalTab(ctx, 'chrome://version');
    const extMgmtTabId = await createChromeInternalTab(ctx, 'chrome://extensions');

    try {
      const listResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_list_tabs',
        arguments: {},
      });
      assert.equal(listResp.status, 200);
      const listData = unwrapBrowserExecResult(listResp.data);
      assert.equal(listData.ok, true);
      const tabs: any[] = listData.tabs ?? [];

      const versionEntry = tabs.find(
        (t) => t.tab_id === versionTabId || String(t.url ?? '').startsWith('chrome://version'),
      );
      const extEntry = tabs.find(
        (t) => t.tab_id === extMgmtTabId || String(t.url ?? '').startsWith('chrome://extensions'),
      );
      assert.ok(versionEntry, 'browser_list_tabs must include chrome://version tab');
      assert.ok(extEntry, 'browser_list_tabs must include chrome://extensions tab');
      assert.equal(
        versionEntry.controllable,
        false,
        `chrome://version must be marked controllable: false, got ${JSON.stringify(versionEntry)}`,
      );
      assert.equal(
        extEntry.controllable,
        false,
        `chrome://extensions must be marked controllable: false, got ${JSON.stringify(extEntry)}`,
      );

      // browser_snapshot, browser_click, and browser_evaluate on chrome://version must all fail fast with -32004 RESTRICTED_URL
      const snapResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: versionTabId },
      });
      assertBrowserRpcError(
        snapResp,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
      );

      const clickResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_click',
        arguments: { tab_id: versionTabId, selector: 'body' },
      });
      assertBrowserRpcError(
        clickResp,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
      );

      const evalResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_evaluate',
        arguments: { tab_id: versionTabId, expression: 'document.title' },
      });
      assertBrowserRpcError(
        evalResp,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
      );
    } finally {
      await removeTabSafe(ctx, versionTabId);
      await removeTabSafe(ctx, extMgmtTabId);
    }
  },
});

defineTest({
  id: 'T2-F07-02',
  title: 'Reject javascript: and file:// schemes with -32004 RESTRICTED_URL while permitting browser_navigate AWAY from chrome:// to http://127.0.0.1/docs/alpha',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    // 1. browser_open_tab with javascript:alert(1) -> -32004 RESTRICTED_URL
    const openJsResp = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_open_tab',
      arguments: { url: 'javascript:alert(1)' },
    });
    assertBrowserRpcError(
      openJsResp,
      BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
      'RESTRICTED_URL',
    );

    // 2. Open chrome://version tab, reject file:///etc/passwd, then succeed navigating AWAY to /docs/alpha
    const scratchTabId = await createChromeInternalTab(ctx, 'chrome://version');
    try {
      const navFileResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_navigate',
        arguments: {
          tab_id: scratchTabId,
          url: 'file:///etc/passwd',
        },
      });
      assertBrowserRpcError(
        navFileResp,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
        'RESTRICTED_URL',
      );

      // Navigate AWAY from chrome://version to benign HTTP URL
      const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
      const navAwayResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_navigate',
        arguments: {
          tab_id: scratchTabId,
          url: alphaUrl,
          wait_until: 'complete',
        },
      });
      assert.equal(navAwayResp.status, 200);
      const navResult = unwrapBrowserExecResult(navAwayResp.data);
      assert.equal(
        navResult.ok,
        true,
        `Navigating away from chrome:// to HTTP must succeed: ${navAwayResp.rawText}`,
      );
      assert.ok(String(navResult.url ?? '').startsWith(alphaUrl));
      assert.equal(navResult.title, 'Alpha Cloud Pricing');
    } finally {
      await removeTabSafe(ctx, scratchTabId);
    }
  },
});

defineTest({
  id: 'T2-F07-03',
  title: 'Abort pending browser_wait_for(timeout_ms: 15000) within < 1.5s with -32005 TAB_NOT_FOUND when target tab closes mid-action',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    const openResp = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_open_tab',
      arguments: {
        url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`,
        active: true,
      },
    });
    assert.equal(openResp.status, 200);
    const opened = unwrapBrowserExecResult(openResp.data);
    assert.equal(opened.ok, true);
    const tabId = Number(opened.tab?.tab_id ?? opened.tab_id);
    assert.ok(tabId > 0);

    try {
      const waitFuture = ctx.primaryUser.api.execBrowserTool(
        {
          tool: 'browser_wait_for',
          arguments: {
            tab_id: tabId,
            selector: '#never-appears-mid-close',
            timeout_ms: 15000,
          },
          timeout_ms: 20000,
        },
        22000,
      );

      // Give browser_wait_for 150ms to enter active polling on tabId, then close tabId
      await sleep(150);
      const closedAtMs = Date.now();
      await removeTabSafe(ctx, tabId);

      const waitResp = await waitFuture;
      const abortElapsedMs = Date.now() - closedAtMs;

      assert.ok(
        abortElapsedMs < 1500,
        `chrome.tabs.onRemoved must abort in-flight browser_wait_for within <1500ms (not 15s!), took ${abortElapsedMs}ms`,
      );
      assertBrowserRpcError(
        waitResp,
        BROWSER_RPC_ERROR_CODES.TAB_NOT_FOUND,
        'TAB_NOT_FOUND',
      );

      // Confirm zero leaked chrome.debugger sessions after closed-tab abort
      const attachedDebuggers = await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        if (!c?.debugger?.getTargets) return [];
        const list = await c.debugger.getTargets();
        return list.filter((t: any) => Boolean(t.attached));
      });
      assert.equal(
        attachedDebuggers.length,
        0,
        `Expected zero leaked debugger sessions after tab close, got ${JSON.stringify(attachedDebuggers)}`,
      );
    } finally {
      await removeTabSafe(ctx, tabId);
    }
  },
});

defineTest({
  id: 'T2-F07-04',
  title: 'Return -32006 ELEMENT_NOT_FOUND on detached stale [ref=eN] & #missing-input and structured INVALID_SELECTOR / -32602 on malformed CSS without content-script crash',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (tab) => {
      const tabId = await resolveTabId(ctx, shopUrl);

      // 1. Capture snapshot to obtain a live [ref=eN] for .add-to-cart-btn
      const snapResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
      });
      assert.equal(snapResp.status, 200);
      const snapData = unwrapBrowserExecResult(snapResp.data);
      assert.equal(snapData.ok, true);

      const interactive: any[] = snapData.interactive_elements ?? [];
      const cartBtnItem = interactive.find((el) =>
        /add.*cart|compact travel keyboard/i.test(`${el.name ?? ''} ${el.text ?? ''}`),
      ) ?? interactive.find((el) => el.tag === 'button');
      assert.ok(cartBtnItem?.ref, `Expected [ref=eN] on .add-to-cart-btn, got ${JSON.stringify(interactive.slice(0, 5))}`);
      const staleRef = String(cartBtnItem.ref);

      // 2. Detach all .add-to-cart-btn buttons from the DOM via JS
      await tab.eval(() => {
        document.querySelectorAll('.add-to-cart-btn').forEach((btn) => btn.remove());
      });

      // 3. Click detached stale ref -> -32006 ELEMENT_NOT_FOUND
      const staleClickResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_click',
        arguments: { tab_id: tabId, ref: staleRef },
      });
      assertBrowserRpcError(
        staleClickResp,
        BROWSER_RPC_ERROR_CODES.ELEMENT_NOT_FOUND,
        'ELEMENT_NOT_FOUND',
      );

      // 4. Type into nonexistent #missing-input -> -32006 ELEMENT_NOT_FOUND
      const missingInputResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_type',
        arguments: {
          tab_id: tabId,
          selector: '#missing-input',
          text: 'x',
        },
      });
      assertBrowserRpcError(
        missingInputResp,
        BROWSER_RPC_ERROR_CODES.ELEMENT_NOT_FOUND,
        'ELEMENT_NOT_FOUND',
      );

      // 5. Query invalid CSS selector "div[[[invalid" -> structured INVALID_SELECTOR / -32602
      const invalidCssResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_query_selector',
        arguments: {
          tab_id: tabId,
          selector: 'div[[[invalid',
        },
      });
      assert.notEqual(invalidCssResp.status, 500);
      const unwrappedInvalid = unwrapBrowserExecResult(invalidCssResp.data);
      assert.notEqual(
        unwrappedInvalid?.ok,
        true,
        `Malformed CSS selector must fail, got ${invalidCssResp.rawText}`,
      );
      const parsedCssErr = extractBrowserErrorCode(invalidCssResp);
      assert.ok(
        parsedCssErr.code === -32602 ||
          parsedCssErr.code === BROWSER_RPC_ERROR_CODES.ELEMENT_NOT_FOUND ||
          parsedCssErr.code === -32000 ||
          /invalid_selector|invalid selector|syntax|selector/i.test(
            `${parsedCssErr.symbolicCode ?? ''} ${parsedCssErr.message}`,
          ),
        `Expected INVALID_SELECTOR / -32602 diagnostic, got ${JSON.stringify(parsedCssErr)}`,
      );

      // 6. Prove content script on tabId did NOT crash by running a valid query immediately afterward
      const validQuery = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_query_selector',
        arguments: {
          tab_id: tabId,
          selector: '#shop-search-input',
        },
      });
      assert.equal(validQuery.status, 200);
      const validData = unwrapBrowserExecResult(validQuery.data);
      assert.equal(validData.ok, true, 'Content script must remain responsive after selector errors');
    });
  },
});

defineTest({
  id: 'T2-F07-05',
  title: 'Reject browser_wait_for(timeout_ms: 400) and browser_navigate(/slow?ms=5000, timeout_ms: 500) within < 1.5s with -32007 NAVIGATION_TIMEOUT',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async () => {
      const tabId = await resolveTabId(ctx, shopUrl);

      // 1. browser_wait_for timeout_ms: 400 on /shop
      const t0 = Date.now();
      const waitTimeoutResp = await ctx.primaryUser.api.execBrowserTool(
        {
          tool: 'browser_wait_for',
          arguments: {
            tab_id: tabId,
            selector: '#ghost-node',
            timeout_ms: 400,
          },
          timeout_ms: 5000,
        },
        8000,
      );
      const waitElapsedMs = Date.now() - t0;
      assert.ok(
        waitElapsedMs < 1500,
        `browser_wait_for(timeout_ms: 400) must reject within <1500ms, took ${waitElapsedMs}ms`,
      );
      assertBrowserRpcError(
        waitTimeoutResp,
        BROWSER_RPC_ERROR_CODES.NAVIGATION_TIMEOUT,
        'NAVIGATION_TIMEOUT',
      );

      // 2. browser_navigate to /slow?ms=5000 with timeout_ms: 500
      const slowUrl = `${ctx.fixtureApp.baseUrl}/slow?ms=5000`;
      const t1 = Date.now();
      const navTimeoutResp = await ctx.primaryUser.api.execBrowserTool(
        {
          tool: 'browser_navigate',
          arguments: {
            tab_id: tabId,
            url: slowUrl,
            timeout_ms: 500,
          },
          timeout_ms: 5000,
        },
        8000,
      );
      const navElapsedMs = Date.now() - t1;
      assert.ok(
        navElapsedMs < 1500,
        `browser_navigate(timeout_ms: 500) must reject within <1500ms (not 5000ms), took ${navElapsedMs}ms`,
      );
      assertBrowserRpcError(
        navTimeoutResp,
        BROWSER_RPC_ERROR_CODES.NAVIGATION_TIMEOUT,
        'NAVIGATION_TIMEOUT',
      );
      const navErr = extractBrowserErrorCode(navTimeoutResp);
      assert.ok(
        navErr.message.length > 0 &&
          (navTimeoutResp.rawText.includes(String(tabId)) ||
            navTimeoutResp.rawText.includes('/slow') ||
            /timeout/i.test(navErr.message)),
        `NAVIGATION_TIMEOUT must include diagnostic url/tab_id/timeout context: ${navTimeoutResp.rawText}`,
      );
    });
  },
});

defineTest({
  id: 'T2-F07-06',
  title: 'Handle conflicting external CDP debugger (-32008 CDP_ATTACH_FAILED or graceful fallback) and cap /large-dom?nodes=8000 snapshot (< 2s, markdown_excerpt <= 4500)',
  tier: 2,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();

    // Part A: External raw CDP debugger conflict on inactive tab
    const bgUrl = `${ctx.fixtureApp.baseUrl}/spa/dashboard`;
    const activeUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;

    await ctx.withTargetTab(bgUrl, async () => {
      const bgTabId = await resolveTabId(ctx, bgUrl);
      await ctx.withTargetTab(activeUrl, async () => {
        await resolveTabId(ctx, activeUrl);

        const listResp = await fetch(`${ctx.browser.cdpHttpUrl}/json/list`);
        const targets = (await listResp.json()) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        const pageTarget = targets.find(
          (t) => t.type === 'page' && t.url.startsWith(bgUrl) && Boolean(t.webSocketDebuggerUrl),
        );
        assert.ok(pageTarget?.webSocketDebuggerUrl);

        const extDebugger = new WebSocket(pageTarget.webSocketDebuggerUrl!);
        try {
          await new Promise<void>((resolve, reject) => {
            extDebugger.once('open', () => resolve());
            extDebugger.once('error', reject);
          });
          extDebugger.send(JSON.stringify({ id: 1, method: 'Debugger.enable', params: {} }));
          await sleep(80);

          const conflictStartMs = Date.now();
          const cdpDependentResp = await ctx.primaryUser.api.execBrowserTool(
            {
              tool: 'browser_screenshot',
              arguments: { tab_id: bgTabId, full_page: true },
              timeout_ms: 4000,
            },
            6000,
          );
          const conflictDurationMs = Date.now() - conflictStartMs;

          assert.ok(
            conflictDurationMs < 4500,
            `Conflicting debugger call must not enter infinite reattach loop (took ${conflictDurationMs}ms)`,
          );
          const unwrappedConflict = unwrapBrowserExecResult(cdpDependentResp.data);
          if (unwrappedConflict?.ok !== true) {
            assertBrowserRpcError(
              cdpDependentResp,
              BROWSER_RPC_ERROR_CODES.CDP_ATTACH_FAILED,
              'CDP_ATTACH_FAILED',
            );
          } else {
            assert.ok(
              typeof unwrappedConflict.data_base64 === 'string' &&
                unwrappedConflict.data_base64.length > 0,
            );
          }
        } finally {
          extDebugger.terminate();
        }
      });
    });

    // Part B: Large DOM stress cap (/large-dom?nodes=8000 with max_chars: 4000)
    const largeDomUrl = `${ctx.fixtureApp.baseUrl}/large-dom?nodes=8000`;
    await ctx.withTargetTab(largeDomUrl, async () => {
      const largeTabId = await resolveTabId(ctx, largeDomUrl);

      const snapStartMs = Date.now();
      const largeSnapResp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: {
          tab_id: largeTabId,
          max_chars: 4000,
        },
      });
      const snapElapsedMs = Date.now() - snapStartMs;

      assert.equal(largeSnapResp.status, 200);
      assert.ok(
        snapElapsedMs < 2000,
        `/large-dom?nodes=8000 snapshot must complete in < 2000ms, took ${snapElapsedMs}ms`,
      );

      const snapData = unwrapBrowserExecResult(largeSnapResp.data);
      assert.equal(snapData.ok, true);
      const excerpt = String(snapData.markdown_excerpt ?? '');
      assert.ok(
        excerpt.length > 0 && excerpt.length <= 4500,
        `Expected capped markdown_excerpt length in (0, 4500], got ${excerpt.length}`,
      );
      const elements: any[] = snapData.interactive_elements ?? [];
      assert.ok(
        Array.isArray(elements) && elements.length > 0 && elements.length < 400,
        `Expected interactive_elements on 400-button page to be capped (< 400), got ${elements.length}`,
      );
    });

    const swErrs = ctx.browser.uncaughtExceptions.filter((e) => e.targetType === 'service_worker');
    assert.equal(swErrs.length, 0, `Unexpected SW exceptions: ${JSON.stringify(swErrs)}`);
  },
});
