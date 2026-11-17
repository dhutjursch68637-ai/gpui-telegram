import {
  defineTest,
  assert,
  pollUntil,
  assertValidPng,
  assertBrowserRpcError,
  unwrapBrowserExecResult,
  BROWSER_RPC_ERROR_CODES,
  type SharedTierContext,
} from '../../harness/index.ts';

async function findExtensionTabIdByUrl(
  ctx: SharedTierContext,
  targetUrlPrefix: string,
): Promise<number> {
  const matched = await pollUntil(
    async () => {
      const tabsResp = await ctx.primaryUser.api.getBrowserTabs();
      assert.equal(tabsResp.ok, true, 'GET /api/v1/browser/tabs must return ok:true');
      const tab = tabsResp.tabs.find((t: any) => String(t.url ?? '').startsWith(targetUrlPrefix));
      return tab ?? null;
    },
    {
      timeoutMs: 6000,
      intervalMs: 100,
      message: `Wait for tab ${targetUrlPrefix} in /api/v1/browser/tabs`,
    },
  );
  const tabId = Number(matched.tab_id ?? matched.id);
  assert.ok(Number.isFinite(tabId) && tabId > 0, `Expected numeric tab_id, got ${JSON.stringify(matched)}`);
  return tabId;
}

async function setRunPolicyThroughPopup(
  ctx: SharedTierContext,
  policy: 'always_allow_authorized' | 'allow_read_only' | 'ask_every_time' | 'disabled',
): Promise<void> {
  await ctx.withExtensionSurface('popup', async (popup) => {
    const selectInfo = await popup.waitForTestId('browser-policy-select', {
      state: 'visible',
      timeoutMs: 8000,
    });
    assert.ok(selectInfo && selectInfo.visible, 'popup.html must render visible [data-testid="browser-policy-select"]');
    await popup.selectOption('[data-testid="browser-policy-select"]', policy);
    const updated = await popup.querySelector('[data-testid="browser-policy-select"]');
    assert.equal(updated?.value, policy, `browser-policy-select value must become ${policy}`);
  });

  await ctx.primaryUser.api.setBotBrowserProfile(777000, {
    enabled: policy !== 'disabled',
    run_policy: policy,
    allowed_domains: [],
    blocked_domains: [],
    preferred_target: 'extension',
  });
}

defineTest({
  id: 'T1-F09-01',
  title: 'AlwaysAllowAuthorized policy executes ReadOnly and Mutating tools immediately with zero approval prompts',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    await setRunPolicyThroughPopup(ctx, 'always_allow_authorized');

    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (tab) => {
      const tabId = await findExtensionTabIdByUrl(ctx, shopUrl);

      const startedAt = Date.now();
      const snapHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
        bot_id: 777000,
      });
      assert.equal(snapHttp.status, 200, `browser_snapshot HTTP status: ${snapHttp.rawText}`);
      const snap = unwrapBrowserExecResult(snapHttp.data);
      assert.equal(snap.ok, true, 'browser_snapshot must succeed under AlwaysAllowAuthorized');
      assert.ok(Array.isArray(snap.interactive_elements) && snap.interactive_elements.length > 0);

      const addBtnRef = snap.interactive_elements.find(
        (el: any) =>
          String(el.selector ?? '').includes('SKU-KB-02') ||
          (String(el.label ?? '').includes('Add to Cart') && typeof el.ref === 'string'),
      );
      assert.ok(addBtnRef?.ref, 'Snapshot must assign a [ref=eN] to Add to Cart button on /shop');

      const clickHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_click',
        arguments: { tab_id: tabId, ref: addBtnRef.ref },
        bot_id: 777000,
      });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(clickHttp.status, 200, `browser_click HTTP status: ${clickHttp.rawText}`);
      const clickRes = unwrapBrowserExecResult(clickHttp.data);
      assert.equal(clickRes.ok, true, 'browser_click must succeed immediately under AlwaysAllowAuthorized');
      assert.ok(elapsedMs < 5000, `Expected immediate execution (<5s), took ${elapsedMs}ms`);

      const pending = await ctx.primaryUser.api.getPendingBrowserCommands();
      assert.equal(pending.items.length, 0, 'Zero approval prompts should be queued under AlwaysAllowAuthorized');

      await pollUntil(
        async () => (await tab.querySelector('#cart-count'))?.text === '1',
        { timeoutMs: 4000, message: 'Live /shop #cart-count increments to 1' },
      );
    });
  },
});

defineTest({
  id: 'T1-F09-02',
  title: 'AllowReadOnly policy auto-approves all ReadOnly browser tools without blocking',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    await setRunPolicyThroughPopup(ctx, 'allow_read_only');

    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    await ctx.withTargetTab(alphaUrl, async () => {
      const tabId = await findExtensionTabIdByUrl(ctx, alphaUrl);

      const statusRes = unwrapBrowserExecResult(
        (await ctx.primaryUser.api.execBrowserTool({ tool: 'browser_status', arguments: {}, bot_id: 777000 })).data,
      );
      assert.equal(statusRes.ok, true, 'browser_status must succeed under AllowReadOnly');
      assert.equal(statusRes.run_policy, 'allow_read_only');

      const listRes = unwrapBrowserExecResult(
        (await ctx.primaryUser.api.execBrowserTool({ tool: 'browser_list_tabs', arguments: {}, bot_id: 777000 })).data,
      );
      assert.equal(listRes.ok, true, 'browser_list_tabs must succeed under AllowReadOnly');
      assert.ok(
        Array.isArray(listRes.tabs) && listRes.tabs.some((t: any) => Number(t.tab_id) === tabId),
        'browser_list_tabs must include /docs/alpha tab',
      );

      const snapRes = unwrapBrowserExecResult(
        (
          await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_snapshot',
            arguments: { tab_id: tabId },
            bot_id: 777000,
          })
        ).data,
      );
      assert.equal(snapRes.ok, true, 'browser_snapshot must succeed under AllowReadOnly');
      assert.equal(snapRes.title, 'Alpha Cloud Pricing');

      const mdRes = unwrapBrowserExecResult(
        (
          await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_extract_markdown',
            arguments: { tab_id: tabId },
            bot_id: 777000,
          })
        ).data,
      );
      assert.equal(mdRes.ok, true, 'browser_extract_markdown must succeed under AllowReadOnly');
      assert.ok(String(mdRes.markdown ?? '').includes('Alpha Cloud'));
      assert.ok(String(mdRes.markdown ?? '').includes('$19/mo'));

      const qsRes = unwrapBrowserExecResult(
        (
          await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_query_selector',
            arguments: { tab_id: tabId, selector: '#pricing-table tr' },
            bot_id: 777000,
          })
        ).data,
      );
      assert.equal(qsRes.ok, true, 'browser_query_selector must succeed under AllowReadOnly');
      assert.ok(Array.isArray(qsRes.matches) && qsRes.matches.length >= 2);

      const shotRes = unwrapBrowserExecResult(
        (
          await ctx.primaryUser.api.execBrowserTool({
            tool: 'browser_screenshot',
            arguments: { tab_id: tabId, format: 'png' },
            bot_id: 777000,
          })
        ).data,
      );
      assert.equal(shotRes.ok, true, 'browser_screenshot must succeed under AllowReadOnly');
      const pngBase64 = shotRes.data_base64 ?? shotRes.artifact?.data_base64;
      assert.ok(typeof pngBase64 === 'string' && pngBase64.length > 100, 'Expected PNG base64 screenshot');
      assertValidPng(pngBase64, { minWidth: 200, minHeight: 200 });

      const pending = await ctx.primaryUser.api.getPendingBrowserCommands();
      assert.equal(pending.items.length, 0, 'No ReadOnly tool may queue an approval request');
    });
  },
});

defineTest({
  id: 'T1-F09-03',
  title: 'AskEveryTime queues mutating browser_click for inline UI approval and honors remember_for_session',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    await setRunPolicyThroughPopup(ctx, 'ask_every_time');

    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async (shopTab) => {
      const tabId = await findExtensionTabIdByUrl(ctx, shopUrl);

      await ctx.withExtensionSurface('workspace', async (workspace) => {
        await workspace.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

        // Select @telegram_official_bot dialog row if present so inline chat approval prompts mount visibly
        await workspace.eval((botChatId: number) => {
          const byId = document.querySelector(
            `[data-chat-id="${botChatId}"], [data-dialog-id="${botChatId}"]`,
          ) as HTMLElement | null;
          if (byId) {
            byId.click();
            return;
          }
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
          const botRow = rows.find(
            (el) =>
              /official|hermes|bot|777000/i.test(el.textContent ?? '') &&
              el.getBoundingClientRect().height >= 32 &&
              el.getBoundingClientRect().height <= 110,
          );
          botRow?.click();
        }, ctx.primaryUser.officialBotChatId);

        // Dispatch mutating browser_click asynchronously — must block awaiting user approval
        const firstClickPromise = ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: { tab_id: tabId, selector: '.add-to-cart-btn[data-sku="SKU-KB-02"]' },
            bot_id: 777000,
            chat_id: ctx.primaryUser.officialBotChatId,
          },
          20000,
        );

        const pendingCmd = await pollUntil(
          async () => {
            const { items } = await ctx.primaryUser.api.getPendingBrowserCommands();
            return items.find((item: any) => item.tool === 'browser_click') ?? null;
          },
          {
            timeoutMs: 6000,
            intervalMs: 80,
            message: 'Pending browser_click command in /api/v1/browser/commands/pending',
          },
        );
        const commandId = String(pendingCmd.command_id ?? pendingCmd.id ?? '');
        assert.ok(commandId.length > 0, 'Pending browser command must expose a non-empty command_id');

        // Verify target DOM has NOT mutated prior to approval
        const preApproveCount = (await shopTab.querySelector('#cart-count'))?.text;
        assert.equal(preApproveCount, '0', 'Cart count must remain 0 before AskEveryTime approval');

        // Verify Extension UI surfaces the pending browser_click item (inline banner or Studio -> Approvals tab)
        const uiShowsPending = await pollUntil(
          async () => {
            const bodyText = await workspace.eval(() => document.body.innerText || '');
            if (bodyText.includes('browser_click') || bodyText.includes(commandId)) {
              return true;
            }
            // Navigate to Studio -> Approvals tab if not shown inline on current view
            const studioBtn = await workspace.eval(() => {
              const rail = document.querySelector('[data-testid="nav-rail"]');
              if (!rail) return false;
              const btns = Array.from(rail.querySelectorAll('button, [role="button"], a'));
              const target = btns.find((b) =>
                /studio|task|hermes|approval|任务|工作台/i.test(
                  `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''}`,
                ),
              ) as HTMLElement | undefined;
              if (target) {
                target.click();
                return true;
              }
              return false;
            });
            if (studioBtn) {
              await workspace.eval(() => {
                const tabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
                const appTab = tabs.find((t) => /approval|审批|授权/i.test(t.textContent ?? '')) as
                  | HTMLElement
                  | undefined;
                appTab?.click();
              });
            }
            const afterText = await workspace.eval(() => document.body.innerText || '');
            return afterText.includes('browser_click') || afterText.includes(commandId);
          },
          {
            timeoutMs: 6000,
            intervalMs: 120,
            message: 'Extension UI displays pending browser_click approval item',
          },
        );
        assert.equal(uiShowsPending, true, 'Extension UI must surface the pending browser_click approval item');

        // Click UI Remember-for-session + Approve control inside workspace.html (zero direct REST approveBrowserCommand bypass)
        const approvedViaUi = await pollUntil(
          async () => {
            return await workspace.eval((cmdId: string) => {
              const isVisible = (el: HTMLElement): boolean => {
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
              };

              const containers = Array.from(
                document.querySelectorAll(
                  '[data-command-id], [data-testid*="approval" i], [role="alert"], [role="dialog"], article, section, li, div',
                ),
              ) as HTMLElement[];
              const matchingContainers = containers
                .filter((el) => {
                  if (!isVisible(el)) return false;
                  const hay = `${el.getAttribute('data-command-id') ?? ''} ${el.innerText || ''}`;
                  return hay.includes('browser_click') || (cmdId.length > 0 && hay.includes(cmdId));
                })
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

              const scope =
                matchingContainers.find((c) => c.querySelectorAll('button, [role="button"]').length > 0) ??
                (document.querySelector('[data-testid="hermes-studio-workspace"]') as HTMLElement | null) ??
                document.body;

              // Option A: Dedicated single-click "Allow for Session" / "Approve for Session" / "Remember & Approve" button
              const candidates = Array.from(
                scope.querySelectorAll('button:not([role="tab"]), [role="button"]:not([role="tab"])'),
              ).filter((el) => isVisible(el as HTMLElement) && !el.hasAttribute('data-tab')) as HTMLElement[];

              const sessionApproveBtn = candidates.find((b) => {
                const label = `${b.getAttribute('data-action') ?? ''} ${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${(b.textContent ?? '').trim()}`;
                return (
                  !/deny|reject|block|cancel|拒绝|阻止|取消/i.test(label) &&
                  /allow.*session|approve.*session|remember.*session|always.*session|session.*allow|本次会话.*(允许|批准)|记住.*(批准|允许)/i.test(
                    label,
                  )
                );
              });
              if (sessionApproveBtn) {
                sessionApproveBtn.click();
                return true;
              }

              // Option B: Toggle "Remember for session" checkbox/switch if present, then click Approve/Allow button
              const checkboxes = Array.from(
                scope.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]'),
              ) as HTMLElement[];
              const rememberToggle = checkboxes.find((cb) => {
                const ctxText = `${cb.getAttribute('name') ?? ''} ${cb.getAttribute('aria-label') ?? ''} ${cb.getAttribute('data-testid') ?? ''} ${cb.closest('label, div')?.textContent ?? ''}`;
                return /remember|session|记住|本次会话/i.test(ctxText);
              });
              if (rememberToggle) {
                if (rememberToggle instanceof HTMLInputElement) {
                  if (!rememberToggle.checked) {
                    rememberToggle.click();
                  }
                } else if (rememberToggle.getAttribute('aria-checked') !== 'true') {
                  rememberToggle.click();
                }
              } else {
                const rememberLabel = Array.from(scope.querySelectorAll('label')).find((lbl) =>
                  /remember|session|记住|本次会话/i.test(lbl.textContent ?? ''),
                );
                const lblInput = rememberLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
                if (lblInput && !lblInput.checked) {
                  lblInput.click();
                } else if (rememberLabel && !lblInput) {
                  rememberLabel.click();
                }
              }

              const approveBtn = candidates.find((b) => {
                const rawText = (b.textContent ?? '').trim();
                if (/^approvals$/i.test(rawText)) return false;
                const label = `${b.getAttribute('data-action') ?? ''} ${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${rawText}`;
                return (
                  !/deny|reject|block|cancel|拒绝|阻止|取消/i.test(label) &&
                  (/\b(approve|allow|accept|permit)\b|批准|允许|同意/i.test(label) ||
                    /approve|allow/i.test(b.getAttribute('data-action') ?? ''))
                );
              });
              if (!approveBtn) return false;
              approveBtn.click();
              return true;
            }, commandId);
          },
          {
            timeoutMs: 6000,
            intervalMs: 100,
            message: 'Click Approve / Remember-for-session control inside workspace.html UI',
          },
        );
        assert.equal(
          approvedViaUi,
          true,
          'Extension UI must render interactive Approve / Remember-for-session control and dispatch approval',
        );

        const firstClickHttp = await firstClickPromise;
        assert.equal(firstClickHttp.status, 200, `Approved browser_click status: ${firstClickHttp.rawText}`);
        const firstClickRes = unwrapBrowserExecResult(firstClickHttp.data);
        assert.equal(firstClickRes.ok, true, 'Approved browser_click must resolve with ok:true');

        await pollUntil(
          async () => (await shopTab.querySelector('#cart-count'))?.text === '1',
          { timeoutMs: 4000, message: 'First approved browser_click increments #cart-count to 1' },
        );

        // Second mutating browser_click in the same session must auto-succeed without blocking
        const secondStartedAt = Date.now();
        const secondClickHttp = await ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_click',
            arguments: { tab_id: tabId, selector: '.add-to-cart-btn[data-sku="SKU-KB-01"]' },
            bot_id: 777000,
            chat_id: ctx.primaryUser.officialBotChatId,
          },
          6000,
        );
        const secondElapsed = Date.now() - secondStartedAt;
        const secondClickRes = unwrapBrowserExecResult(secondClickHttp.data);
        assert.equal(
          secondClickRes.ok,
          true,
          'Second browser_click in same session must auto-succeed after remember_for_session:true',
        );
        assert.ok(secondElapsed < 5000, `Expected remembered session click <5s, took ${secondElapsed}ms`);

        await pollUntil(
          async () => (await shopTab.querySelector('#cart-count'))?.text === '2',
          { timeoutMs: 4000, message: 'Second auto-approved browser_click increments #cart-count to 2' },
        );
      });
    });
  },
});

defineTest({
  id: 'T1-F09-04',
  title: 'Domain allowlist permits browser_navigate and browser_snapshot on allowed 127.0.0.1 host',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const updatedProfile = await ctx.primaryUser.api.setBotBrowserProfile(777000, {
      enabled: true,
      run_policy: 'always_allow_authorized',
      allowed_domains: ['127.0.0.1'],
      blocked_domains: [],
      preferred_target: 'extension',
    });
    assert.ok(
      Array.isArray(updatedProfile.allowed_domains) &&
        updatedProfile.allowed_domains.includes('127.0.0.1'),
      `Expected allowed_domains to include 127.0.0.1, got ${JSON.stringify(updatedProfile)}`,
    );

    await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      if (c?.storage?.local) {
        await c.storage.local.set({
          run_policy: 'always_allow_authorized',
          browser_run_policy: 'always_allow_authorized',
          allowed_domains: ['127.0.0.1'],
          blocked_domains: [],
        });
      }
    });

    const shopUrl = `http://127.0.0.1:${ctx.fixtureApp.port}/shop`;
    const alphaUrl = `http://127.0.0.1:${ctx.fixtureApp.port}/docs/alpha`;

    await ctx.withTargetTab(shopUrl, async () => {
      const tabId = await findExtensionTabIdByUrl(ctx, shopUrl);

      const navHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_navigate',
        arguments: { tab_id: tabId, url: alphaUrl, wait_until: 'complete' },
        bot_id: 777000,
      });
      assert.equal(navHttp.status, 200, `browser_navigate on allowed domain failed: ${navHttp.rawText}`);
      const navRes = unwrapBrowserExecResult(navHttp.data);
      assert.equal(navRes.ok, true, 'browser_navigate on 127.0.0.1 must succeed');
      assert.equal(navRes.title, 'Alpha Cloud Pricing');

      const snapHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
        bot_id: 777000,
      });
      assert.equal(snapHttp.status, 200);
      const snapRes = unwrapBrowserExecResult(snapHttp.data);
      assert.equal(snapRes.ok, true, 'browser_snapshot on allowed domain 127.0.0.1 must succeed');
      assert.equal(snapRes.title, 'Alpha Cloud Pricing');
      assert.ok(
        String(snapRes.markdown_excerpt ?? '').includes('$19/mo') ||
          JSON.stringify(snapRes.interactive_elements ?? []).includes('Beta Cloud'),
        'Snapshot from /docs/alpha must include live page pricing/link data',
      );
    });
  },
});

defineTest({
  id: 'T1-F09-05',
  title: 'Popup emergency-stop-btn immediately disables browser control and re-selecting AlwaysAllowAuthorized restores operation',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    await ctx.withTargetTab(alphaUrl, async () => {
      const tabId = await findExtensionTabIdByUrl(ctx, alphaUrl);

      await ctx.withExtensionSurface('popup', async (popup) => {
        await popup.waitForTestId('emergency-stop-btn', { state: 'visible', timeoutMs: 8000 });
        await popup.waitForTestId('browser-bridge-status-pill', { state: 'visible', timeoutMs: 8000 });

        await popup.clickTestId('emergency-stop-btn');

        // Verify popup UI reflects disabled / emergency-stopped state
        await pollUntil(
          async () => {
            const pill = await popup.querySelector('[data-testid="browser-bridge-status-pill"]');
            const select = await popup.querySelector('[data-testid="browser-policy-select"]');
            const pillStr = `${pill?.text ?? ''} ${JSON.stringify(pill?.attrs ?? {})}`.toLowerCase();
            return (
              select?.value === 'disabled' ||
              pillStr.includes('stop') ||
              pillStr.includes('disabled') ||
              pillStr.includes('off') ||
              pillStr.includes('停止') ||
              pillStr.includes('禁用')
            );
          },
          { timeoutMs: 5000, intervalMs: 80, message: 'Popup status pill / policy select shows emergency-stopped state' },
        );

        // Verify browser tool execution is blocked with -32003 POLICY_DISABLED while stopped
        const blockedHttp = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_click',
          arguments: { tab_id: tabId, selector: '#next-doc-link' },
          bot_id: 777000,
        });
        assertBrowserRpcError(
          blockedHttp,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );

        // Re-enable AlwaysAllowAuthorized in popup.html and verify full recovery
        await popup.selectOption('[data-testid="browser-policy-select"]', 'always_allow_authorized');
        await ctx.primaryUser.api.setBotBrowserProfile(777000, {
          enabled: true,
          run_policy: 'always_allow_authorized',
          allowed_domains: [],
          blocked_domains: [],
          preferred_target: 'extension',
        });

        const resumedSnap = await pollUntil(
          async () => {
            const resp = await ctx.primaryUser.api.execBrowserTool({
              tool: 'browser_snapshot',
              arguments: { tab_id: tabId },
              bot_id: 777000,
            });
            const unwrapped = unwrapBrowserExecResult(resp.data);
            return unwrapped?.ok === true ? unwrapped : null;
          },
          { timeoutMs: 6000, intervalMs: 120, message: 'browser_snapshot resumes cleanly after re-enabling policy' },
        );

        assert.ok(resumedSnap, 'Expected non-null resumed snapshot');
        assert.equal(resumedSnap.ok, true);
        assert.equal(resumedSnap.title, 'Alpha Cloud Pricing');
      });
    });
  },
});

defineTest({
  id: 'T1-F09-06',
  title: 'Benign page snapshot and markdown extraction report injection_scan flagged=false severity=none without escalation',
  tier: 1,
  features: ['F9'],
  fn: async (ctx: SharedTierContext) => {
    await setRunPolicyThroughPopup(ctx, 'always_allow_authorized');

    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    await ctx.withTargetTab(alphaUrl, async (tab) => {
      const tabId = await findExtensionTabIdByUrl(ctx, alphaUrl);

      const snapHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_snapshot',
        arguments: { tab_id: tabId },
        bot_id: 777000,
      });
      assert.equal(snapHttp.status, 200);
      const snap = unwrapBrowserExecResult(snapHttp.data);
      assert.equal(snap.ok, true);
      assert.ok(snap.injection_scan && typeof snap.injection_scan === 'object', 'browser_snapshot must return injection_scan metadata');
      assert.equal(snap.injection_scan.flagged, false, 'Benign /docs/alpha must have injection_scan.flagged === false');
      assert.equal(
        String(snap.injection_scan.severity ?? '').toLowerCase(),
        'none',
        `Expected severity "none" on benign page, got ${JSON.stringify(snap.injection_scan)}`,
      );

      const mdHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_extract_markdown',
        arguments: { tab_id: tabId },
        bot_id: 777000,
      });
      assert.equal(mdHttp.status, 200);
      const md = unwrapBrowserExecResult(mdHttp.data);
      assert.equal(md.ok, true);
      assert.ok(md.injection_scan && typeof md.injection_scan === 'object', 'browser_extract_markdown must return injection_scan metadata');
      assert.equal(md.injection_scan.flagged, false, 'Benign markdown must have injection_scan.flagged === false');
      assert.equal(String(md.injection_scan.severity ?? '').toLowerCase(), 'none');

      // Mutating click immediately after benign scan must NOT escalate to pending approval
      const clickHttp = await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_click',
        arguments: { tab_id: tabId, selector: '#next-doc-link' },
        bot_id: 777000,
      });
      const clickRes = unwrapBrowserExecResult(clickHttp.data);
      assert.equal(clickRes.ok, true, 'Mutating click on benign page must execute without false-positive escalation');

      await pollUntil(
        async () => (await tab.title()) === 'Beta Cloud Pricing',
        { timeoutMs: 4000, message: 'Clicking #next-doc-link navigates tab to /docs/beta' },
      );
    });
  },
});
