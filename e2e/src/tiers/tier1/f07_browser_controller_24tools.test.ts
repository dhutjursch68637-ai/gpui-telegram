import {
  assert,
  assertValidPng,
  defineTest,
  pollUntil,
  unwrapBrowserExecResult,
  type SharedTierContext,
} from '../../harness/index.ts';

async function execToolOk(
  ctx: SharedTierContext,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const resp = await ctx.primaryUser.api.execBrowserTool({ tool, arguments: args });
  assert.equal(
    resp.status,
    200,
    `execBrowserTool(${tool}) failed with HTTP ${resp.status}: ${resp.rawText}`,
  );
  const unwrapped = unwrapBrowserExecResult(resp.data);
  assert.equal(
    unwrapped.ok,
    true,
    `Expected ok: true from ${tool}, got: ${JSON.stringify(unwrapped).slice(0, 400)}`,
  );
  return unwrapped;
}

async function resolveTabIdForUrl(
  ctx: SharedTierContext,
  urlFragment: string,
): Promise<number> {
  const tab = await pollUntil(
    async () => {
      const list = await execToolOk(ctx, 'browser_list_tabs', {});
      const tabs: any[] = Array.isArray(list.tabs) ? list.tabs : [];
      return tabs.find((t) => String(t?.url ?? '').includes(urlFragment)) ?? null;
    },
    { timeoutMs: 5000, intervalMs: 80, message: `Resolve tab_id for "${urlFragment}"` },
  );
  return Number(tab!.tab_id);
}

defineTest({
  id: 'T1-F07-01',
  title: 'Execute Tab & Group Tools (#1-#7 + aliases browser_tabs and browser_switch_tab) in live Chromium 156',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    const status = await execToolOk(ctx, 'browser_status', {});
    assert.equal(status.connected, true);

    let tabAId = 0;
    let tabBId = 0;
    try {
      const openA = await execToolOk(ctx, 'browser_open_tab', {
        url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
        active: true,
        group_with_bot: true,
      });
      tabAId = Number(openA.tab?.tab_id ?? openA.tab_id);
      assert.ok(tabAId > 0, 'Expected positive tab_id for /docs/alpha');

      const openB = await execToolOk(ctx, 'browser_open_tab', {
        url: `${ctx.fixtureApp.baseUrl}/docs/beta`,
        active: false,
      });
      tabBId = Number(openB.tab?.tab_id ?? openB.tab_id);
      assert.ok(tabBId > 0 && tabBId !== tabAId, 'Expected distinct positive tab_id for /docs/beta');

      const listCanonical = await execToolOk(ctx, 'browser_list_tabs', {});
      const tabIds = (listCanonical.tabs as any[]).map((t) => Number(t.tab_id));
      assert.ok(tabIds.includes(tabAId) && tabIds.includes(tabBId));

      const listAlias = await execToolOk(ctx, 'browser_tabs', { current_window_only: true });
      const aliasIds = (listAlias.tabs as any[]).map((t) => Number(t.tab_id));
      assert.ok(aliasIds.includes(tabAId) && aliasIds.includes(tabBId));

      const grouped = await execToolOk(ctx, 'browser_group_tabs', {
        tab_ids: [tabAId, tabBId],
        title: 'Research',
        color: 'blue',
      });
      const groupId = Number(grouped.group_id);
      assert.ok(groupId >= 0, `Expected group_id >= 0, got ${JSON.stringify(grouped)}`);

      const groupMeta = await ctx.browser.evalInServiceWorker(async (gid: number) => {
        const c = (globalThis as any).chrome;
        return await c.tabGroups.get(gid);
      }, groupId);
      assert.equal(groupMeta.title, 'Research');
      assert.equal(groupMeta.color, 'blue');

      const actB = await execToolOk(ctx, 'browser_activate_tab', { tab_id: tabBId });
      assert.equal(Number(actB.tab?.tab_id ?? actB.tab_id), tabBId);

      const switchA = await execToolOk(ctx, 'browser_switch_tab', { tab_id: tabAId });
      assert.equal(Number(switchA.tab?.tab_id ?? switchA.tab_id), tabAId);

      const activeNow = await execToolOk(ctx, 'browser_get_active_tab', {});
      assert.equal(Number(activeNow.tab?.tab_id ?? activeNow.tab_id), tabAId);

      const closedB = await execToolOk(ctx, 'browser_close_tab', { tab_id: tabBId });
      assert.equal(Number(closedB.closed_tab_id), tabBId);
      tabBId = 0;

      await pollUntil(
        async () => {
          const targets = await ctx.browser.listTargets();
          return !targets.some((t) => t.type === 'page' && t.url.includes('/docs/beta'));
        },
        { timeoutMs: 4000, intervalMs: 60, message: 'Closed tabB removed from CDP targets' },
      );
    } finally {
      if (tabBId > 0) await execToolOk(ctx, 'browser_close_tab', { tab_id: tabBId }).catch(() => undefined);
      if (tabAId > 0) await execToolOk(ctx, 'browser_close_tab', { tab_id: tabAId }).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T1-F07-02',
  title: 'Execute Navigation & Read Tools (#8-#13): navigate, back_forward, reload, snapshot, extract_markdown, query_selector',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
      const tabId = await resolveTabIdForUrl(ctx, '/docs/alpha');

      const navAlpha = await execToolOk(ctx, 'browser_navigate', {
        tab_id: tabId,
        url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
        wait_until: 'complete',
      });
      assert.equal(navAlpha.title, 'Alpha Cloud Pricing');

      // Click #next-doc-link to push /docs/beta onto session history
      await execToolOk(ctx, 'browser_click', {
        tab_id: tabId,
        selector: '#next-doc-link',
      });
      await pollUntil(
        async () => {
          const snap = await execToolOk(ctx, 'browser_snapshot', { tab_id: tabId });
          return String(snap.url ?? '').includes('/docs/beta');
        },
        { timeoutMs: 5000, intervalMs: 80, message: 'Navigate to /docs/beta via link click' },
      );

      const backRes = await execToolOk(ctx, 'browser_back_forward', {
        tab_id: tabId,
        direction: 'back',
      });
      assert.ok(String(backRes.url).includes('/docs/alpha'));

      const fwdRes = await execToolOk(ctx, 'browser_back_forward', {
        tab_id: tabId,
        direction: 'forward',
      });
      assert.ok(String(fwdRes.url).includes('/docs/beta'));

      const reloadRes = await execToolOk(ctx, 'browser_reload', {
        tab_id: tabId,
        bypass_cache: true,
      });
      assert.equal(reloadRes.title, 'Beta Cloud Pricing');

      const snap = await execToolOk(ctx, 'browser_snapshot', { tab_id: tabId });
      assert.ok(snap.viewport?.width > 0 && snap.viewport?.height > 0);
      assert.ok(Array.isArray(snap.interactive_elements) && snap.interactive_elements.length >= 2);
      const firstEl = snap.interactive_elements[0];
      assert.match(String(firstEl.ref), /^e\d+$/);
      assert.ok((firstEl.rect?.w ?? firstEl.rect?.width ?? 0) > 0);
      assert.equal(snap.injection_scan?.flagged, false);

      const md = await execToolOk(ctx, 'browser_extract_markdown', {
        tab_id: tabId,
        max_chars: 4000,
        offset: 0,
      });
      assert.ok(String(md.markdown).includes('Beta Cloud'));
      assert.ok(String(md.markdown).includes('$29/mo'));
      assert.ok(Number(md.total_chars) > 20);
      assert.equal(md.injection_scan?.flagged, false);

      const qs = await execToolOk(ctx, 'browser_query_selector', {
        tab_id: tabId,
        selector: '#pricing-table tr',
        limit: 10,
      });
      assert.ok(Array.isArray(qs.matches) && qs.matches.length >= 2);
      assert.ok(qs.matches.some((m: any) => String(m.text).includes('$29/mo')));
    });
  },
});

defineTest({
  id: 'T1-F07-03',
  title: 'Execute DOM Action Tools (#14-#18): select_option, click [ref=eN] + highlight overlay, React type+submit, hover, press_key',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async (tab) => {
      const tabId = await resolveTabIdForUrl(ctx, '/shop');

      // Observe highlight overlay DOM injection (either persistent or transient flash)
      await tab.eval(() => {
        (window as any).__gpuiHighlightObserved = false;
        const checkNode = (node: Element) => {
          const id = (node.id || '').toLowerCase();
          const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
          if (
            id.includes('gpui') ||
            id.includes('highlight') ||
            id.includes('agent') ||
            cls.includes('gpui') ||
            cls.includes('highlight') ||
            node.hasAttribute('data-gpui-ref') ||
            node.hasAttribute('data-gpui-highlight')
          ) {
            (window as any).__gpuiHighlightObserved = true;
          }
        };
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.target instanceof Element) {
              checkNode(m.target);
            }
            for (const added of Array.from(m.addedNodes)) {
              if (added instanceof Element) {
                checkNode(added);
                for (const sub of Array.from(added.querySelectorAll('*'))) checkNode(sub);
              }
            }
          }
        });
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      });

      const selPrice = await execToolOk(ctx, 'browser_select_option', {
        tab_id: tabId,
        selector: '#shop-price-filter',
        value: 'under100',
      });
      assert.equal(selPrice.selected_value, 'under100');

      const selSize = await execToolOk(ctx, 'browser_select_option', {
        tab_id: tabId,
        selector: '#shop-size-select',
        value: 'M',
      });
      assert.equal(selSize.selected_value, 'M');

      const snap = await execToolOk(ctx, 'browser_snapshot', { tab_id: tabId });
      const kb02Btn = (snap.interactive_elements as any[]).find(
        (e) =>
          String(e?.selector ?? '').includes('SKU-KB-02') ||
          String(e?.label ?? '').includes('Compact Travel Keyboard'),
      );
      assert.ok(kb02Btn?.ref, 'Expected [ref=eN] for visible SKU-KB-02 Add to Cart button');

      await execToolOk(ctx, 'browser_click', { tab_id: tabId, ref: kb02Btn.ref });
      await pollUntil(
        async () => (await tab.querySelector('#cart-count'))?.text === '1',
        { timeoutMs: 4000, intervalMs: 60, message: '#cart-count === "1" after browser_click' },
      );

      const highlightSeen = await tab.eval<boolean>(() => Boolean((window as any).__gpuiHighlightObserved));
      assert.equal(highlightSeen, true, 'Expected content script DOM ref/highlight overlay during agent control');

      // Navigate to React _valueTracker checkout and test browser_type + submit: true
      await execToolOk(ctx, 'browser_navigate', {
        tab_id: tabId,
        url: `${ctx.fixtureApp.baseUrl}/shop/checkout`,
      });
      await execToolOk(ctx, 'browser_type', {
        tab_id: tabId,
        selector: '#checkout-fullname',
        text: 'Grace Hopper',
        clear_first: true,
      });
      await execToolOk(ctx, 'browser_type', {
        tab_id: tabId,
        selector: '#checkout-email',
        text: 'grace@navy.example',
        clear_first: true,
      });
      await execToolOk(ctx, 'browser_type', {
        tab_id: tabId,
        selector: '#checkout-address',
        text: '1 Compiler Plaza',
        clear_first: true,
        submit: true,
      });

      const confirmEl = await tab.waitForSelector('#order-confirmation', {
        state: 'visible',
        timeoutMs: 5000,
      });
      assert.ok(confirmEl?.text.includes('ORD-2026-8841'));

      // Navigate to /spa/dashboard and verify browser_hover + browser_press_key
      await execToolOk(ctx, 'browser_navigate', {
        tab_id: tabId,
        url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`,
      });
      await execToolOk(ctx, 'browser_hover', {
        tab_id: tabId,
        selector: '#sla-tooltip-trigger',
      });
      const tooltip = await tab.waitForSelector('#sla-tooltip', {
        state: 'visible',
        timeoutMs: 3000,
      });
      assert.ok(tooltip?.text.includes('P99 Latency: 18.4ms'));

      await execToolOk(ctx, 'browser_press_key', {
        tab_id: tabId,
        key: 'k',
        modifiers: ['Control'],
      });
      await pollUntil(
        async () => (await tab.querySelector('#last-key-badge'))?.text === 'Control+k',
        { timeoutMs: 3000, intervalMs: 60, message: '#last-key-badge === "Control+k"' },
      );
    });
  },
});

defineTest({
  id: 'T1-F07-04',
  title: 'Execute Scroll & Async Wait Tools (#19-#20) on /spa/dashboard and iframe verification on /iframe-host',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/spa/dashboard`, async (tab) => {
      const tabId = await resolveTabIdForUrl(ctx, '/spa/dashboard');

      await execToolOk(ctx, 'browser_type', {
        tab_id: tabId,
        selector: '#spa-username',
        text: 'ops_lead',
        clear_first: true,
      });
      await execToolOk(ctx, 'browser_type', {
        tab_id: tabId,
        selector: '#spa-password',
        text: 'secret99',
        clear_first: true,
        submit: true,
      });

      const waitTable = await execToolOk(ctx, 'browser_wait_for', {
        tab_id: tabId,
        selector: '#async-metrics-table',
        state: 'visible',
        timeout_ms: 5000,
      });
      assert.equal(waitTable.matched, true);
      assert.ok(Number(waitTable.elapsed_ms ?? 0) >= 100, 'Expected async 350ms render wait');

      const scrollRes = await execToolOk(ctx, 'browser_scroll', {
        tab_id: tabId,
        direction: 'bottom',
      });
      assert.ok(
        Number(scrollRes.viewport?.scroll_y ?? 0) >= 1400,
        `Expected scroll_y >= 1400, got ${JSON.stringify(scrollRes.viewport)}`,
      );

      const waitFooter = await execToolOk(ctx, 'browser_wait_for', {
        tab_id: tabId,
        selector: '#lazy-footer-row',
        state: 'visible',
        timeout_ms: 4000,
      });
      assert.equal(waitFooter.matched, true);
      const footerInfo = await tab.querySelector('#lazy-footer-row');
      assert.ok(footerInfo?.text.includes('Lazy Row #50'));

      // Same-origin nested iframe verification on /iframe-host
      await execToolOk(ctx, 'browser_navigate', {
        tab_id: tabId,
        url: `${ctx.fixtureApp.baseUrl}/iframe-host`,
      });

      const iframeSnap = await execToolOk(ctx, 'browser_snapshot', { tab_id: tabId });
      const verifyBtn = (iframeSnap.interactive_elements as any[] | undefined)?.find(
        (e) =>
          String(e?.selector ?? '').includes('iframe-verify-btn') ||
          String(e?.label ?? '').includes('Verify Code'),
      );

      if (verifyBtn?.ref) {
        await execToolOk(ctx, 'browser_click', { tab_id: tabId, ref: verifyBtn.ref });
      } else {
        await execToolOk(ctx, 'browser_click', {
          tab_id: tabId,
          selector: '#iframe-verify-btn',
        });
      }

      await pollUntil(
        async () =>
          (await tab.querySelector('#host-iframe-status'))?.text.includes('IFRAME_VERIFIED_OK'),
        { timeoutMs: 4000, intervalMs: 60, message: 'Parent received IFRAME_VERIFIED_OK' },
      );
    });
  },
});

defineTest({
  id: 'T1-F07-05',
  title: 'Execute Screenshots & JS Eval (#21-#22): active-tab PNG, background inactive-tab PNG without focus steal, full_page PNG, and browser_evaluate',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/spa/dashboard`, async () => {
      const spaTabId = await resolveTabIdForUrl(ctx, '/spa/dashboard');

      await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
        const shopTabId = await resolveTabIdForUrl(ctx, '/shop');

        await execToolOk(ctx, 'browser_activate_tab', { tab_id: shopTabId });
        const activeBefore = await execToolOk(ctx, 'browser_get_active_tab', {});
        assert.equal(Number(activeBefore.tab?.tab_id ?? activeBefore.tab_id), shopTabId);

        // 1. Active tab screenshot
        const activeShot = await execToolOk(ctx, 'browser_screenshot', {
          tab_id: shopTabId,
          format: 'png',
        });
        assert.equal(activeShot.mime_type, 'image/png');
        const activeMeta = assertValidPng(activeShot.data_base64, {
          minWidth: 400,
          minHeight: 300,
        });

        // 2. Inactive background tab screenshot (must NOT steal foreground active tab)
        const bgShot = await execToolOk(ctx, 'browser_screenshot', {
          tab_id: spaTabId,
          format: 'png',
        });
        assertValidPng(bgShot.data_base64, { minWidth: 400, minHeight: 300 });
        const activeAfterBg = await execToolOk(ctx, 'browser_get_active_tab', {});
        assert.equal(
          Number(activeAfterBg.tab?.tab_id ?? activeAfterBg.tab_id),
          shopTabId,
          'Background tab screenshot must not steal active foreground tab focus',
        );

        // 3. Full-page screenshot on 2600px tall /spa/dashboard
        const fullShot = await execToolOk(ctx, 'browser_screenshot', {
          tab_id: spaTabId,
          full_page: true,
          format: 'png',
        });
        const fullMeta = assertValidPng(fullShot.data_base64, { minWidth: 400 });
        assert.ok(
          fullMeta.height > activeMeta.height && fullMeta.height >= 1800,
          `Expected full_page PNG height >= 1800px (> viewport ${activeMeta.height}px), got ${fullMeta.height}px`,
        );

        // 4. browser_evaluate in page world
        const evalRes = await execToolOk(ctx, 'browser_evaluate', {
          tab_id: spaTabId,
          expression: 'document.title + ":" + String(21 * 2)',
        });
        const val = evalRes.value ?? evalRes.result;
        assert.equal(val, 'Ops Telemetry SPA:42');
      });
    });
  },
});

defineTest({
  id: 'T1-F07-06',
  title: 'Execute DevTools Telemetry, Cookies & Downloads (#23-#24): console/network logs, HttpOnly cookie redaction, and browser_download_url',
  tier: 1,
  features: ['F7'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/spa/dashboard`, async () => {
      const spaTabId = await resolveTabIdForUrl(ctx, '/spa/dashboard');

      // Prime DevTools log collectors in case CDP listeners attach lazily
      await execToolOk(ctx, 'browser_get_console_logs', { tab_id: spaTabId, limit: 10 });
      await execToolOk(ctx, 'browser_get_network_log', { tab_id: spaTabId, limit: 10 });

      await execToolOk(ctx, 'browser_type', {
        tab_id: spaTabId,
        selector: '#spa-username',
        text: 'telemetry_user',
        clear_first: true,
      });
      await execToolOk(ctx, 'browser_type', {
        tab_id: spaTabId,
        selector: '#spa-password',
        text: 'telemetry_pass',
        clear_first: true,
        submit: true,
      });
      await execToolOk(ctx, 'browser_wait_for', {
        tab_id: spaTabId,
        selector: '#async-metrics-table',
        state: 'visible',
        timeout_ms: 5000,
      });

      const consoleRes = await execToolOk(ctx, 'browser_get_console_logs', {
        tab_id: spaTabId,
        limit: 50,
      });
      const consoleEntries = consoleRes.entries ?? consoleRes.logs ?? [];
      assert.ok(
        JSON.stringify(consoleEntries).includes('[SPA] Metrics fetch initiated'),
        `Expected "[SPA] Metrics fetch initiated" in console logs: ${JSON.stringify(consoleEntries)}`,
      );

      const netRes = await execToolOk(ctx, 'browser_get_network_log', {
        tab_id: spaTabId,
        limit: 50,
      });
      const netEntries = netRes.entries ?? netRes.requests ?? [];
      assert.ok(
        JSON.stringify(netEntries).includes('/api/metrics'),
        `Expected "/api/metrics" in network log: ${JSON.stringify(netEntries)}`,
      );
    });

    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/cookies-and-downloads`, async () => {
      const cookieUrl = `${ctx.fixtureApp.baseUrl}/cookies-and-downloads`;

      const listRes = await execToolOk(ctx, 'browser_manage_cookies', {
        op: 'list',
        url: cookieUrl,
      });
      const cookies: any[] = Array.isArray(listRes.cookies) ? listRes.cookies : [];
      const pubCookie = cookies.find((c) => c.name === 'gpui_public_pref');
      const secCookie = cookies.find((c) => c.name === 'gpui_session_secret');

      assert.ok(pubCookie, 'Expected gpui_public_pref cookie');
      assert.equal(pubCookie.value, 'theme_night');

      assert.ok(secCookie, 'Expected gpui_session_secret metadata entry');
      assert.equal(Boolean(secCookie.http_only ?? secCookie.httpOnly), true);
      assert.notEqual(
        secCookie.value,
        'SUPER_SECRET_HTTPONLY_TOKEN_991',
        'HttpOnly cookie value MUST be redacted by browser_manage_cookies',
      );
      assert.ok(
        !JSON.stringify(cookies).includes('SUPER_SECRET_HTTPONLY_TOKEN_991'),
        'Serialized cookie list must never leak SUPER_SECRET_HTTPONLY_TOKEN_991',
      );

      await execToolOk(ctx, 'browser_manage_cookies', {
        op: 'set',
        url: ctx.fixtureApp.baseUrl,
        name: 'gpui_e2e_custom',
        value: 'val_2026',
      });
      const afterSet = await execToolOk(ctx, 'browser_manage_cookies', {
        op: 'list',
        url: cookieUrl,
      });
      assert.ok(
        (afterSet.cookies as any[]).some(
          (c) => c.name === 'gpui_e2e_custom' && c.value === 'val_2026',
        ),
      );

      await execToolOk(ctx, 'browser_manage_cookies', {
        op: 'delete',
        url: ctx.fixtureApp.baseUrl,
        name: 'gpui_e2e_custom',
      });
      const afterDel = await execToolOk(ctx, 'browser_manage_cookies', {
        op: 'list',
        url: cookieUrl,
      });
      assert.ok(!(afterDel.cookies as any[]).some((c) => c.name === 'gpui_e2e_custom'));

      const dlRes = await execToolOk(ctx, 'browser_download_url', {
        url: `${ctx.fixtureApp.baseUrl}/download/report.csv`,
        filename: 'e2e_report.csv',
      });
      const downloadId = Number(dlRes.download_id);
      assert.ok(
        Number.isFinite(downloadId) && downloadId >= 0,
        `Expected numeric download_id from browser_download_url, got ${JSON.stringify(dlRes)}`,
      );

      const dlItems = await pollUntil(
        async () => {
          const found = await ctx.browser.evalInServiceWorker(async (id: number) => {
            const c = (globalThis as any).chrome;
            return await c.downloads.search({ id });
          }, downloadId);
          return Array.isArray(found) && found.length > 0 ? found : null;
        },
        { timeoutMs: 5000, intervalMs: 80, message: 'chrome.downloads.search record' },
      );
      assert.ok(dlItems && dlItems[0].url.includes('/download/report.csv'));
    });
  },
});
