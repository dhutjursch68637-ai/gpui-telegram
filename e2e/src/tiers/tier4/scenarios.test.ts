import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BROWSER_RPC_ERROR_CODES,
  TelegramApiClient,
  assert,
  assertBrowserRpcError,
  assertCssColorMatches,
  assertValidPng,
  defineTest,
  generateSignedPreKeyBundle,
  parseCssRgb,
  pollUntil,
  sleep,
  unwrapBrowserExecResult,
  type CdpPageHandle,
  type MockLlmTurnContext,
  type SharedTierContext,
} from '../../harness/index.ts';

function extractInteractiveElements(snapRaw: any): Array<Record<string, any>> {
  const snap = unwrapBrowserExecResult(snapRaw);
  if (!snap || typeof snap !== 'object') return [];
  const list = snap.interactive_elements ?? snap.elements ?? [];
  return Array.isArray(list) ? list : [];
}

function findElementRef(
  snapRaw: any,
  matcher: (el: Record<string, any>, haystack: string) => boolean,
): string | undefined {
  for (const el of extractInteractiveElements(snapRaw)) {
    if (!el || typeof el.ref !== 'string' || !el.ref.trim()) continue;
    const haystack = [
      el.selector,
      el.id,
      el.label,
      el.text,
      el.aria_label,
      el.ariaLabel,
      el.placeholder,
      el.name,
      el.role,
      el.tag,
      el.href,
      el.value,
    ]
      .filter((v) => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    if (matcher(el, haystack)) {
      return el.ref;
    }
  }
  return undefined;
}

async function waitForBrowserTabByUrl(
  api: TelegramApiClient,
  urlFragment: string,
  timeoutMs = 8000,
): Promise<Record<string, any>> {
  return await pollUntil(
    async () => {
      const res = await api.getBrowserTabs();
      const tabs = Array.isArray(res?.tabs) ? res.tabs : [];
      return (
        tabs.find(
          (t: any) => typeof t?.url === 'string' && t.url.includes(urlFragment),
        ) ?? null
      );
    },
    {
      timeoutMs,
      intervalMs: 80,
      message: `waitForBrowserTabByUrl(${urlFragment})`,
    },
  );
}

async function resolveEditableSelectorForTestId(
  page: CdpPageHandle,
  testId: string,
): Promise<string> {
  await page.waitForTestId(testId, { state: 'visible', timeoutMs: 12000 });
  return await page.eval((tid: string) => {
    const root = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null;
    if (!root) return `[data-testid="${tid}"]`;
    const tag = root.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || root.isContentEditable) {
      return `[data-testid="${tid}"]`;
    }
    if (root.querySelector('textarea')) {
      return `[data-testid="${tid}"] textarea`;
    }
    if (root.querySelector('input:not([type="hidden"]):not([type="file"])')) {
      return `[data-testid="${tid}"] input:not([type="hidden"]):not([type="file"])`;
    }
    if (root.querySelector('[contenteditable="true"]')) {
      return `[data-testid="${tid}"] [contenteditable="true"]`;
    }
    return `[data-testid="${tid}"]`;
  }, testId);
}

async function typeIntoTestId(
  page: CdpPageHandle,
  testId: string,
  text: string,
  opts: { clearFirst?: boolean; submit?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const selector = await resolveEditableSelectorForTestId(page, testId);
  await page.type(selector, text, opts);
}

async function sendComposerMessageInSurface(
  page: CdpPageHandle,
  text: string,
  opts: { clearFirst?: boolean } = {},
): Promise<void> {
  await typeIntoTestId(page, 'canonical-composer-input', text, {
    clearFirst: opts.clearFirst ?? true,
    submit: false,
  });
  const sendBtn = await page.querySelector('[data-testid="composer-send-btn"]');
  if (sendBtn && sendBtn.visible && !sendBtn.disabled) {
    await page.clickTestId('composer-send-btn');
  } else {
    await page.pressKey('Enter');
  }
}

async function selectDialogInSidebar(
  page: CdpPageHandle,
  opts: { chatId?: number; titleHints: string[] },
): Promise<boolean> {
  const targetSelector = await page.eval(
    (arg: { chatId?: number; titleHints: string[] }) => {
      const prev = document.querySelectorAll('[data-e2e-t4-select-chat]');
      prev.forEach((el) => el.removeAttribute('data-e2e-t4-select-chat'));

      if (arg.chatId !== undefined) {
        const byAttr = document.querySelector(
          `[data-chat-id="${arg.chatId}"], [data-dialog-id="${arg.chatId}"], [data-peer-id="${arg.chatId}"]`,
        ) as HTMLElement | null;
        if (byAttr) {
          byAttr.setAttribute('data-e2e-t4-select-chat', '1');
          return '[data-e2e-t4-select-chat="1"]';
        }
      }

      const container =
        document.querySelector('[data-testid="chat-sidebar"]') ?? document.body;
      const candidates = Array.from(
        container.querySelectorAll(
          '[role="listitem"], [role="option"], [role="button"], button, a, li, [data-chat-id], .chat-item, .dialog-item',
        ),
      ) as HTMLElement[];

      const lowerHints = arg.titleHints.map((h) => h.toLowerCase());
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const txt = (el.innerText || el.textContent || '').toLowerCase();
        if (lowerHints.some((h) => txt.includes(h))) {
          el.setAttribute('data-e2e-t4-select-chat', '1');
          return '[data-e2e-t4-select-chat="1"]';
        }
      }
      return null;
    },
    opts,
  );

  if (!targetSelector) return false;
  await page.click(targetSelector);
  await sleep(120);
  return true;
}

async function selectBrowserPolicyInPopupUi(
  ctx: SharedTierContext,
  popupPage: CdpPageHandle,
  runPolicy: 'always_allow_authorized' | 'allow_read_only' | 'ask_every_time' | 'disabled',
  opts: {
    botId?: number;
  } = {},
): Promise<void> {
  const botId = opts.botId ?? 777000;

  const policyEl = await popupPage.waitForTestId('browser-policy-select', {
    state: 'visible',
    timeoutMs: 8000,
  });
  assert.ok(
    policyEl && policyEl.visible,
    'popup.html must render visible [data-testid="browser-policy-select"]',
  );

  const selectTargetSel =
    policyEl.tag === 'select'
      ? '[data-testid="browser-policy-select"]'
      : '[data-testid="browser-policy-select"] select';
  await popupPage.selectOption(selectTargetSel, runPolicy);

  const updatedSelect = await popupPage.querySelector(selectTargetSel);
  assert.equal(
    updatedSelect?.value,
    runPolicy,
    `[data-testid="browser-policy-select"] <select> value must equal "${runPolicy}"`,
  );

  const verifiedInStorage = await pollUntil(
    async () => {
      return await ctx.browser.evalInServiceWorker(async (expectedPolicy: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.storage?.local) return null;
        const st = await c.storage.local.get([
          'run_policy',
          'browser_run_policy',
          'emergency_stopped',
          'bridge_config',
        ]);
        const norm = (v: unknown) => String(v ?? '').replace(/_/g, '').toLowerCase();
        const target = norm(expectedPolicy);
        const polMatched =
          norm(st.run_policy) === target ||
          norm(st.browser_run_policy) === target ||
          norm(st.bridge_config?.run_policy) === target;
        const stoppedOk =
          expectedPolicy === 'disabled' ? true : !Boolean(st.emergency_stopped);
        return polMatched && stoppedOk
          ? { polMatched, emergencyStopped: Boolean(st.emergency_stopped) }
          : null;
      }, runPolicy);
    },
    {
      timeoutMs: 6000,
      intervalMs: 80,
      message: `Popup UI [data-testid="browser-policy-select"] persisted "${runPolicy}" in chrome.storage.local`,
    },
  );
  assert.ok(verifiedInStorage, 'Expected Popup UI policy change to persist in chrome.storage.local');
  assert.equal(verifiedInStorage.polMatched, true);
  if (runPolicy !== 'disabled') {
    assert.equal(
      verifiedInStorage.emergencyStopped,
      false,
      'Selecting active policy in Popup UI must clear emergency_stopped',
    );
  }

  await ctx.primaryUser.api.setBotBrowserProfile(botId, {
    enabled: runPolicy !== 'disabled',
    run_policy: runPolicy,
    allowed_domains: [],
    blocked_domains: [],
    preferred_target: 'extension',
  });
}

function buildVoiceNoteOggBytes(): Buffer {
  const header = Buffer.from(
    '4f6767530002000000000000000002000000000000004f707573486561640101380180bb0000000000',
    'hex',
  );
  const body = Buffer.alloc(640, 0x3c);
  return Buffer.concat([header, body]);
}

// ============================================================================
// T4-01: E-Commerce Search, Filter, Cart & Checkout via In-Extension Bot
// ============================================================================
defineTest({
  id: 'T4-01',
  title:
    'E-Commerce Search, Filter, Cart & Checkout via In-Extension Bot: searches Compact Travel Keyboard under $100 in size M, completes React _valueTracker checkout, and streams ORD-2026-8841 + PNG screenshot into sidepanel.html',
  tier: 4,
  features: ['F1', 'F6', 'F7', 'F8', 'F10', 'F13', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async (shopTab) => {
      const liveShopDto = await waitForBrowserTabByUrl(ctx.primaryUser.api, '/shop');
      const shopTabId = Number(liveShopDto.tab_id);
      assert.ok(shopTabId > 0, 'Expected valid numeric tab_id for /shop');

      await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_activate_tab',
        arguments: { tab_id: shopTabId },
      });

      const observed: {
        searchRef?: string;
        priceRef?: string;
        sizeRef?: string;
        addCartRef?: string;
        checkoutLinkRef?: string;
        fullNameRef?: string;
        emailRef?: string;
        addressRef?: string;
        placeOrderRef?: string;
        orderConfirmationText?: string;
        screenshotB64?: string;
      } = {};

      ctx.mockLlm.registerScenario('t4_01_ecommerce', (turnCtx: MockLlmTurnContext) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Snapshotting storefront controls on Fabushi Gear Store...',
            toolCalls: [
              {
                id: 'call_t401_snap_shop',
                name: 'browser_snapshot',
                arguments: { tab_id: shopTabId },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 1) {
          const snap = turnCtx.latestToolResult?.json;
          observed.searchRef = findElementRef(
            snap,
            (_el, h) => h.includes('shop-search-input') || h.includes('search products'),
          );
          observed.priceRef = findElementRef(
            snap,
            (_el, h) => h.includes('shop-price-filter') || h.includes('max price'),
          );
          observed.sizeRef = findElementRef(
            snap,
            (_el, h) => h.includes('shop-size-select') || h.includes('size'),
          );
          return {
            reasoning:
              'Filtering catalog to Compact Travel Keyboard under $100 and selecting size M...',
            toolCalls: [
              {
                id: 'call_t401_type_search',
                name: 'browser_type',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.searchRef
                    ? { ref: observed.searchRef }
                    : { selector: '#shop-search-input' }),
                  text: 'Compact Travel Keyboard',
                  clear_first: true,
                },
              },
              {
                id: 'call_t401_filter_price',
                name: 'browser_select_option',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.priceRef
                    ? { ref: observed.priceRef }
                    : { selector: '#shop-price-filter' }),
                  value: 'under100',
                },
              },
              {
                id: 'call_t401_select_size',
                name: 'browser_select_option',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.sizeRef
                    ? { ref: observed.sizeRef }
                    : { selector: '#shop-size-select' }),
                  value: 'M',
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 2) {
          return {
            reasoning: 'Re-snapshotting filtered product catalog to locate SKU-KB-02 and checkout link...',
            toolCalls: [
              {
                id: 'call_t401_snap_filtered',
                name: 'browser_snapshot',
                arguments: { tab_id: shopTabId },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 3) {
          const snapFiltered = turnCtx.latestToolResult?.json;
          observed.addCartRef = findElementRef(
            snapFiltered,
            (_el, h) =>
              h.includes('sku-kb-02') || h.includes('compact travel keyboard'),
          );
          observed.checkoutLinkRef = findElementRef(
            snapFiltered,
            (_el, h) =>
              h.includes('proceed-checkout-link') || h.includes('proceed to checkout'),
          );
          return {
            reasoning: 'Adding SKU-KB-02 (Compact Travel Keyboard, Size M) to cart...',
            toolCalls: [
              {
                id: 'call_t401_add_cart',
                name: 'browser_click',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.addCartRef
                    ? { ref: observed.addCartRef }
                    : { selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]' }),
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 4) {
          return {
            reasoning: 'Clicking Proceed to Checkout link...',
            toolCalls: [
              {
                id: 'call_t401_goto_checkout',
                name: 'browser_click',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.checkoutLinkRef
                    ? { ref: observed.checkoutLinkRef }
                    : { selector: '#proceed-checkout-link' }),
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 5) {
          return {
            reasoning: 'Waiting for /shop/checkout form and indexing React controlled inputs...',
            toolCalls: [
              {
                id: 'call_t401_wait_checkout',
                name: 'browser_wait_for',
                arguments: {
                  tab_id: shopTabId,
                  selector: '#checkout-fullname',
                  state: 'visible',
                  timeout_ms: 8000,
                },
              },
              {
                id: 'call_t401_snap_checkout',
                name: 'browser_snapshot',
                arguments: { tab_id: shopTabId },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 6) {
          const snapCheckout = turnCtx.latestToolResult?.json;
          observed.fullNameRef = findElementRef(
            snapCheckout,
            (_el, h) => h.includes('checkout-fullname') || h.includes('full name'),
          );
          observed.emailRef = findElementRef(
            snapCheckout,
            (_el, h) => h.includes('checkout-email') || h.includes('shipping email'),
          );
          observed.addressRef = findElementRef(
            snapCheckout,
            (_el, h) => h.includes('checkout-address') || h.includes('street address'),
          );
          observed.placeOrderRef = findElementRef(
            snapCheckout,
            (_el, h) => h.includes('place-order-btn') || h.includes('place order'),
          );
          return {
            reasoning:
              'Filling React _valueTracker controlled checkout inputs and submitting order...',
            toolCalls: [
              {
                id: 'call_t401_type_name',
                name: 'browser_type',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.fullNameRef
                    ? { ref: observed.fullNameRef }
                    : { selector: '#checkout-fullname' }),
                  text: 'Lin Wei',
                  clear_first: true,
                },
              },
              {
                id: 'call_t401_type_email',
                name: 'browser_type',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.emailRef
                    ? { ref: observed.emailRef }
                    : { selector: '#checkout-email' }),
                  text: 'lin@example.com',
                  clear_first: true,
                },
              },
              {
                id: 'call_t401_type_addr',
                name: 'browser_type',
                arguments: {
                  tab_id: shopTabId,
                  ...(observed.addressRef
                    ? { ref: observed.addressRef }
                    : { selector: '#checkout-address' }),
                  text: '88 West Lake Rd',
                  clear_first: true,
                  submit: true,
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 7) {
          const addrRes = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
          const alreadySubmitted = Boolean(addrRes?.submitted);
          return {
            reasoning: 'Confirming #order-confirmation banner and capturing PNG receipt screenshot...',
            toolCalls: [
              ...(alreadySubmitted
                ? []
                : [
                    {
                      id: 'call_t401_click_submit',
                      name: 'browser_click',
                      arguments: {
                        tab_id: shopTabId,
                        ...(observed.placeOrderRef
                          ? { ref: observed.placeOrderRef }
                          : { selector: '#place-order-btn' }),
                      },
                    },
                  ]),
              {
                id: 'call_t401_wait_confirm',
                name: 'browser_wait_for',
                arguments: {
                  tab_id: shopTabId,
                  selector: '#order-confirmation',
                  state: 'visible',
                  timeout_ms: 8000,
                },
              },
              {
                id: 'call_t401_qs_confirm',
                name: 'browser_query_selector',
                arguments: {
                  tab_id: shopTabId,
                  selector: '#order-confirmation',
                },
              },
              {
                id: 'call_t401_shot_receipt',
                name: 'browser_screenshot',
                arguments: { tab_id: shopTabId, format: 'png' },
              },
            ],
          };
        }

        for (const tr of turnCtx.latestRoundToolResults) {
          const data = unwrapBrowserExecResult(tr.json);
          if (Array.isArray(data?.matches) && data.matches[0]?.text) {
            observed.orderConfirmationText = String(data.matches[0].text);
          }
          if (typeof data?.data_base64 === 'string' && data.data_base64.length > 0) {
            observed.screenshotB64 = data.data_base64;
          } else if (typeof data?.artifact?.data_base64 === 'string') {
            observed.screenshotB64 = data.artifact.data_base64;
          }
        }

        return {
          reasoning: 'Composing final order confirmation summary...',
          content: `Order complete! Purchased **Compact Travel Keyboard** (Size M, $79) for Lin Wei. Confirmation: **${observed.orderConfirmationText ?? 'missing'}**.`,
        };
      });

      await ctx.withExtensionSurface(
        'sidepanel',
        async (sidepanelPage) => {
          await sidepanelPage.waitForTestId('conversation-stage', {
            state: 'visible',
            timeoutMs: 12000,
          });
          await selectDialogInSidebar(sidepanelPage, {
            chatId: ctx.primaryUser.officialBotChatId,
            titleHints: ['extension bot', 'local bot', 'telegram official', 'hermes', 'bot'],
          });

          // Attach @page pill if toolbar button exists
          const attachPageBtn = await sidepanelPage.eval(() => {
            const btns = Array.from(
              document.querySelectorAll('[data-testid*="page"], button, [role="button"]'),
            ) as HTMLElement[];
            const found = btns.find((b) => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const txt = (
                b.getAttribute('data-testid') ||
                b.getAttribute('aria-label') ||
                b.innerText ||
                ''
              ).toLowerCase();
              return txt.includes('@page') || txt.includes('attach page');
            });
            if (!found) return null;
            found.setAttribute('data-e2e-t401-page', '1');
            return '[data-e2e-t401-page="1"]';
          });
          if (attachPageBtn) {
            await sidepanelPage.click(attachPageBtn);
            await sleep(80);
          }

          await sendComposerMessageInSurface(
            sidepanelPage,
            '[E2E_SCENARIO:t4_01_ecommerce] @page Buy the Compact Travel Keyboard in size M under $100 and check out as Lin Wei (lin@example.com, 88 West Lake Rd).',
          );

          await sidepanelPage.waitForText('ORD-2026-8841', {
            selector: '[data-testid="conversation-stage"]',
            timeoutMs: 55000,
          });

          // Verify live target tab DOM state on /shop/checkout
          assert.ok(
            (await shopTab.url()).includes('/shop/checkout'),
            `Expected target tab on /shop/checkout, got ${await shopTab.url()}`,
          );
          const checkoutErr = await shopTab.querySelector('#checkout-error');
          assert.equal(
            checkoutErr,
            null,
            'React _valueTracker validation error must be absent (#checkout-error === null)',
          );
          const confirmDom = await shopTab.waitForSelector('#order-confirmation', {
            state: 'visible',
            timeoutMs: 5000,
          });
          assert.ok(confirmDom && confirmDom.text.includes('ORD-2026-8841'));

          // Verify backend fixture order submission & cart SKU/size
          assert.equal(ctx.fixtureApp.submittedOrders.length, 1);
          const submittedOrder = ctx.fixtureApp.submittedOrders[0];
          assert.equal(submittedOrder.orderId, 'ORD-2026-8841');
          assert.equal(submittedOrder.fullName, 'Lin Wei');
          assert.equal(submittedOrder.email, 'lin@example.com');
          assert.equal(submittedOrder.address, '88 West Lake Rd');
          assert.ok(
            submittedOrder.items.some((it) => it.sku === 'SKU-KB-02' && it.size === 'M'),
            `Expected SKU-KB-02 size M in submitted order items, got ${JSON.stringify(submittedOrder.items)}`,
          );

          // Verify genuine [ref=eN] discovery & PNG receipt screenshot
          for (const [label, refVal] of [
            ['#shop-search-input', observed.searchRef],
            ['SKU-KB-02 Add to Cart', observed.addCartRef],
            ['#checkout-fullname', observed.fullNameRef],
          ] as const) {
            assert.ok(
              refVal && /^e\d+$/i.test(refVal),
              `Expected genuine [ref=eN] for ${label}, got ${String(refVal)}`,
            );
          }
          assert.ok(
            typeof observed.screenshotB64 === 'string' && observed.screenshotB64.length > 100,
            'Expected PNG receipt base64 from browser_screenshot',
          );
          assertValidPng(observed.screenshotB64!, { minWidth: 300, minHeight: 300 });

          // Verify sidepanel.html rendered thinking-bubble + tool-steps-list + message-bubble
          const thinkingEl = await sidepanelPage.waitForTestId('thinking-bubble', {
            state: 'attached',
            timeoutMs: 6000,
          });
          const stepsEl = await sidepanelPage.waitForTestId('tool-steps-list', {
            state: 'attached',
            timeoutMs: 6000,
          });
          const bubbles = await sidepanelPage.querySelectorAll('[data-testid="message-bubble"]');
          assert.ok(thinkingEl !== null, 'Expected thinking-bubble in sidepanel.html');
          assert.ok(stepsEl !== null, 'Expected tool-steps-list in sidepanel.html');
          assert.ok(bubbles.length >= 2, 'Expected user + assistant message bubbles in sidepanel.html');
        },
        { viewport: { width: 420, height: 840 } },
      );
    });
  },
});

// ============================================================================
// T4-02: Multi-Tab Research & Markdown Comparison Synthesis via Desktop Bot
// ============================================================================
defineTest({
  id: 'T4-02',
  title:
    'Multi-Tab Research & Markdown Comparison Synthesis via Desktop Bot: opens 3 grouped /docs/{alpha,beta,gamma} tabs, synthesizes Markdown pricing/SLA table over PtsPush to Desktop WS & workspace.html, and closes scratch tabs',
  tier: 4,
  features: ['F1', 'F3', 'F4', 'F5', 'F7', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    const ptsWs = await ctx.primaryUser.api.connectPtsWs();
    const workspacePage = await ctx.browser.openExtensionSurface('workspace', {
      viewport: { width: 1440, height: 900 },
    });

    try {
      await ptsWs.subscribeChat(ctx.primaryUser.officialBotChatId);
      await workspacePage.waitForTestId('conversation-stage', {
        state: 'visible',
        timeoutMs: 12000,
      });
      await selectDialogInSidebar(workspacePage, {
        chatId: ctx.primaryUser.officialBotChatId,
        titleHints: ['telegram official', 'telegram_official_bot', 'hermes', 'official bot'],
      });

      const researchState: {
        tabIds: number[];
        groupId?: number;
        midTurnServerTabsCount: number;
        midTurnGroupedTabsCount: number;
        midTurnDesktopBridgeDocsCount: number;
        extractedDocs: string[];
      } = {
        tabIds: [],
        midTurnServerTabsCount: 0,
        midTurnGroupedTabsCount: 0,
        midTurnDesktopBridgeDocsCount: 0,
        extractedDocs: [],
      };

      ctx.mockLlm.registerScenario('t4_02_research', async (turnCtx: MockLlmTurnContext) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Opening Alpha, Beta, and Gamma Cloud pricing docs in 3 grouped research tabs...',
            toolCalls: [
              {
                id: 'call_t402_open_alpha',
                name: 'browser_open_tab',
                arguments: {
                  url: `${ctx.fixtureApp.baseUrl}/docs/alpha`,
                  active: false,
                  group_with_bot: true,
                },
              },
              {
                id: 'call_t402_open_beta',
                name: 'browser_open_tab',
                arguments: {
                  url: `${ctx.fixtureApp.baseUrl}/docs/beta`,
                  active: false,
                  group_with_bot: true,
                },
              },
              {
                id: 'call_t402_open_gamma',
                name: 'browser_open_tab',
                arguments: {
                  url: `${ctx.fixtureApp.baseUrl}/docs/gamma`,
                  active: true,
                  group_with_bot: true,
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 1) {
          researchState.tabIds = turnCtx.latestRoundToolResults
            .map((tr) => {
              const d = unwrapBrowserExecResult(tr.json);
              return Number(d?.tab?.tab_id ?? d?.tab_id);
            })
            .filter((n) => Number.isFinite(n) && n > 0);
          return {
            reasoning: 'Grouping the 3 research tabs under "Cloud Pricing"...',
            toolCalls: [
              {
                id: 'call_t402_group',
                name: 'browser_group_tabs',
                arguments: {
                  tab_ids: researchState.tabIds,
                  title: 'Cloud Pricing',
                  color: 'blue',
                },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 2) {
          const grpRes = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
          researchState.groupId = Number(grpRes?.group_id ?? 0);

          // Probe live /api/v1/browser/tabs and DesktopBridge /json/list while all 3 grouped tabs are open
          const [srvTabsResp, bridgeList] = await Promise.all([
            ctx.primaryUser.api.getBrowserTabs(),
            ctx.desktopBridge.getJsonList(),
          ]);
          const docTabs = (srvTabsResp.tabs ?? []).filter((t: any) =>
            /\/docs\/(alpha|beta|gamma)/.test(String(t?.url ?? '')),
          );
          researchState.midTurnServerTabsCount = docTabs.length;
          researchState.midTurnGroupedTabsCount = docTabs.filter(
            (t: any) => typeof t?.group_id === 'number' && t.group_id >= 0,
          ).length;
          researchState.midTurnDesktopBridgeDocsCount = bridgeList.filter((t: any) =>
            /\/docs\/(alpha|beta|gamma)/.test(String(t?.url ?? '')),
          ).length;

          return {
            reasoning: 'Extracting Markdown benchmarks across Alpha, Beta, and Gamma tabs...',
            toolCalls: researchState.tabIds.map((tid, idx) => ({
              id: `call_t402_extract_${idx}`,
              name: 'browser_extract_markdown',
              arguments: { tab_id: tid },
            })),
          };
        }

        if (turnCtx.turnIndex === 3) {
          researchState.extractedDocs = turnCtx.latestRoundToolResults.map((tr) => {
            const d = unwrapBrowserExecResult(tr.json);
            return `${String(d?.title ?? '')}: ${String(d?.markdown ?? '')}`;
          });
          return {
            reasoning: 'Closing all 3 scratch research tabs cleanly...',
            toolCalls: researchState.tabIds.map((tid, idx) => ({
              id: `call_t402_close_${idx}`,
              name: 'browser_close_tab',
              arguments: { tab_id: tid },
            })),
          };
        }

        const joined = researchState.extractedDocs.join('\n');
        const hasAlpha = joined.includes('$19/mo') && joined.includes('Tokyo');
        const hasBeta = joined.includes('$29/mo') && joined.includes('Frankfurt');
        const hasGamma = joined.includes('$15/mo') && joined.includes('Oregon');

        return {
          reasoning: 'Synthesizing Markdown comparison table from extracted docs...',
          content: [
            '### Cloud Compute Pricing Comparison',
            '',
            '| Provider | Price | SLA | Region |',
            '|---|---|---|---|',
            `| Alpha Cloud | ${hasAlpha ? '$19/mo' : 'ERR'} | 99.9% | Tokyo |`,
            `| Beta Cloud | ${hasBeta ? '$29/mo' : 'ERR'} | 99.95% | Frankfurt |`,
            `| Gamma Cloud | ${hasGamma ? '$15/mo' : 'ERR'} | 99.5% | Oregon |`,
            '',
            '**Recommendation**: Gamma Cloud ($15/mo) is lowest cost; Beta Cloud (99.95% SLA) has highest reliability.',
          ].join('\n'),
        };
      });

      const turnResp = await ctx.primaryUser.api.createHermesTurn(
        {
          prompt:
            '[E2E_SCENARIO:t4_02_research] Open Alpha, Beta, and Gamma Cloud docs in grouped tabs, compare pricing & SLA in a Markdown table, and close the research tabs.',
          chat_id: ctx.primaryUser.officialBotChatId,
          bot_id: 777000,
          deliver_to_chat: true,
          yolo: true,
          max_iterations: 10,
        },
        60000,
      );

      assert.equal(turnResp.status, 'completed');
      for (const expectedToken of [
        'Alpha Cloud',
        'Beta Cloud',
        'Gamma Cloud',
        '$19/mo',
        '$29/mo',
        '$15/mo',
        '99.95%',
        'Frankfurt',
        'Oregon',
      ]) {
        assert.ok(
          String(turnResp.response ?? '').includes(expectedToken),
          `Expected "${expectedToken}" in synthesized Markdown table: ${String(turnResp.response)}`,
        );
      }

      // Assert mid-workflow grouped tabs were observed in both Server Relay & Desktop Bridge
      assert.equal(researchState.tabIds.length, 3, 'Expected 3 opened research tab_ids');
      assert.equal(
        researchState.midTurnServerTabsCount,
        3,
        'Expected all 3 research tabs in GET /api/v1/browser/tabs during Step 2',
      );
      assert.ok(
        researchState.midTurnGroupedTabsCount >= 3 || (researchState.groupId ?? -1) >= 0,
        'Expected research tabs to be assigned a valid Chrome tab group_id >= 0',
      );
      assert.equal(
        researchState.midTurnDesktopBridgeDocsCount,
        3,
        'Expected DesktopBridge GET /json/list to report all 3 research tabs during Step 2',
      );

      // Assert post-workflow cleanup closed all 3 scratch research tabs
      await pollUntil(
        async () => {
          const [afterSrv, afterBridge] = await Promise.all([
            ctx.primaryUser.api.getBrowserTabs(),
            ctx.desktopBridge.getJsonList(),
          ]);
          const srvRemaining = (afterSrv.tabs ?? []).filter((t: any) =>
            /\/docs\/(alpha|beta|gamma)/.test(String(t?.url ?? '')),
          );
          const bridgeRemaining = afterBridge.filter((t: any) =>
            /\/docs\/(alpha|beta|gamma)/.test(String(t?.url ?? '')),
          );
          return srvRemaining.length === 0 && bridgeRemaining.length === 0;
        },
        { timeoutMs: 8000, intervalMs: 100, message: 'All 3 scratch research tabs closed' },
      );

      // Verify both Desktop WS client (PtsPush / history) AND open workspace.html received the Markdown table
      await ptsWs.waitForPtsPush(
        ctx.primaryUser.officialBotChatId,
        (push) => JSON.stringify(push).includes('$15/mo') && JSON.stringify(push).includes('Gamma Cloud'),
        12000,
      );

      const history = await ctx.primaryUser.api.getMessages(ctx.primaryUser.officialBotChatId, {
        limit: 20,
      });
      assert.ok(
        (history.messages ?? []).some(
          (m: any) =>
            String(m?.text ?? JSON.stringify(m?.content ?? '')).includes('$15/mo') &&
            String(m?.text ?? JSON.stringify(m?.content ?? '')).includes('$29/mo'),
        ),
        'Expected synthesized Markdown comparison table persisted in chat message history',
      );

      await workspacePage.waitForText('Gamma Cloud', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 15000,
      });
      await workspacePage.waitForText('$15/mo', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 10000,
      });
    } finally {
      await workspacePage.close().catch(() => undefined);
      await ptsWs.close().catch(() => undefined);
    }
  },
});

// ============================================================================
// T4-03: Dynamic SPA Form Automation, Console/Network Audit & Cookie/Download Flow
// ============================================================================
defineTest({
  id: 'T4-03',
  title:
    'Dynamic SPA Form Automation, Console/Network Audit & Cookie/Download Flow: logs into /spa/dashboard, scrolls lazy rows, captures console/network logs, redacts HttpOnly cookie secret, downloads CSV, and captures full_page PNG',
  tier: 4,
  features: ['F7', 'F8', 'F13', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    const audit: {
      tabId?: number;
      userRef?: string;
      passRef?: string;
      consoleEntries: any[];
      networkEntries: any[];
      cookiesList: any[];
      downloadId?: number;
      fullPagePngB64?: string;
    } = {
      consoleEntries: [],
      networkEntries: [],
      cookiesList: [],
    };

    ctx.mockLlm.registerScenario('t4_03_spa_audit', (turnCtx: MockLlmTurnContext) => {
      if (turnCtx.turnIndex === 0) {
        return {
          reasoning: 'Opening Ops Telemetry SPA dashboard...',
          toolCalls: [
            {
              id: 'call_t403_open',
              name: 'browser_open_tab',
              arguments: { url: `${ctx.fixtureApp.baseUrl}/spa/dashboard`, active: true },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 1) {
        const openRes = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
        audit.tabId = Number(openRes?.tab?.tab_id ?? openRes?.tab_id);
        return {
          reasoning: 'Enabling console/network capture and snapshotting SPA login form...',
          toolCalls: [
            {
              id: 'call_t403_prime_logs',
              name: 'browser_get_console_logs',
              arguments: { tab_id: audit.tabId, limit: 10 },
            },
            {
              id: 'call_t403_prime_net',
              name: 'browser_get_network_log',
              arguments: { tab_id: audit.tabId, limit: 10 },
            },
            {
              id: 'call_t403_snap',
              name: 'browser_snapshot',
              arguments: { tab_id: audit.tabId },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 2) {
        const snap = turnCtx.latestToolResult?.json;
        audit.userRef = findElementRef(
          snap,
          (_el, h) => h.includes('spa-username') || h.includes('username'),
        );
        audit.passRef = findElementRef(
          snap,
          (_el, h) => h.includes('spa-password') || h.includes('password'),
        );
        return {
          reasoning: 'Logging into SPA with ops_admin credentials...',
          toolCalls: [
            {
              id: 'call_t403_user',
              name: 'browser_type',
              arguments: {
                tab_id: audit.tabId,
                ...(audit.userRef ? { ref: audit.userRef } : { selector: '#spa-username' }),
                text: 'ops_admin',
                clear_first: true,
              },
            },
            {
              id: 'call_t403_pass',
              name: 'browser_type',
              arguments: {
                tab_id: audit.tabId,
                ...(audit.passRef ? { ref: audit.passRef } : { selector: '#spa-password' }),
                text: 'sec_pass',
                clear_first: true,
                submit: true,
              },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 3) {
        return {
          reasoning: 'Waiting for #async-metrics-table, scrolling to bottom, and waiting for #lazy-footer-row...',
          toolCalls: [
            {
              id: 'call_t403_wait_metrics',
              name: 'browser_wait_for',
              arguments: {
                tab_id: audit.tabId,
                selector: '#async-metrics-table',
                state: 'visible',
                timeout_ms: 8000,
              },
            },
            {
              id: 'call_t403_scroll_bottom',
              name: 'browser_scroll',
              arguments: {
                tab_id: audit.tabId,
                direction: 'bottom',
                amount_px: 2200,
              },
            },
            {
              id: 'call_t403_wait_lazy',
              name: 'browser_wait_for',
              arguments: {
                tab_id: audit.tabId,
                selector: '#lazy-footer-row',
                state: 'visible',
                timeout_ms: 8000,
              },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 4) {
        return {
          reasoning: 'Collecting console logs, network XHR entries, and full-page PNG screenshot...',
          toolCalls: [
            {
              id: 'call_t403_console',
              name: 'browser_get_console_logs',
              arguments: { tab_id: audit.tabId, limit: 50 },
            },
            {
              id: 'call_t403_network',
              name: 'browser_get_network_log',
              arguments: { tab_id: audit.tabId, limit: 50 },
            },
            {
              id: 'call_t403_fullshot',
              name: 'browser_screenshot',
              arguments: { tab_id: audit.tabId, full_page: true, format: 'png' },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 5) {
        for (const tr of turnCtx.latestRoundToolResults) {
          const d = unwrapBrowserExecResult(tr.json);
          if (tr.name === 'browser_get_console_logs' && Array.isArray(d?.entries)) {
            audit.consoleEntries = d.entries;
          } else if (tr.name === 'browser_get_network_log' && Array.isArray(d?.entries)) {
            audit.networkEntries = d.entries;
          } else if (typeof d?.data_base64 === 'string' && d.data_base64.length > 0) {
            audit.fullPagePngB64 = d.data_base64;
          } else if (typeof d?.artifact?.data_base64 === 'string') {
            audit.fullPagePngB64 = d.artifact.data_base64;
          }
        }
        return {
          reasoning: 'Navigating to /cookies-and-downloads to inspect cookies and export CSV...',
          toolCalls: [
            {
              id: 'call_t403_nav_cookies',
              name: 'browser_navigate',
              arguments: {
                tab_id: audit.tabId,
                url: `${ctx.fixtureApp.baseUrl}/cookies-and-downloads`,
                wait_until: 'complete',
              },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 6) {
        return {
          reasoning: 'Listing cookies and downloading ops_audit.csv report...',
          toolCalls: [
            {
              id: 'call_t403_cookies',
              name: 'browser_manage_cookies',
              arguments: {
                op: 'list',
                url: `${ctx.fixtureApp.baseUrl}/cookies-and-downloads`,
              },
            },
            {
              id: 'call_t403_download',
              name: 'browser_download_url',
              arguments: {
                url: `${ctx.fixtureApp.baseUrl}/download/report.csv`,
                filename: 'ops_audit.csv',
              },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 7) {
        for (const tr of turnCtx.latestRoundToolResults) {
          const d = unwrapBrowserExecResult(tr.json);
          if (Array.isArray(d?.cookies)) {
            audit.cookiesList = d.cookies;
          }
          if (d?.download_id !== undefined) {
            audit.downloadId = Number(d.download_id);
          }
        }
        return {
          reasoning: 'Closing audited SPA tab...',
          toolCalls: [
            {
              id: 'call_t403_close',
              name: 'browser_close_tab',
              arguments: { tab_id: audit.tabId },
            },
          ],
        };
      }

      return {
        content:
          'SPA Telemetry & Cookie/Download Audit Completed: verified /api/metrics, shard-3 slow warning, public cookie theme_night, redacted HttpOnly cookie, and ops_audit.csv export.',
      };
    });

    const turnResp = await ctx.primaryUser.api.createHermesTurn(
      {
        prompt:
          '[E2E_SCENARIO:t4_03_spa_audit] Audit Ops Telemetry SPA, inspect console/network logs, list cookies, and download CSV.',
        yolo: true,
        max_iterations: 12,
      },
      70000,
    );

    assert.equal(turnResp.status, 'completed');

    // 1. Assert console log captured "shard-3 slow"
    const consoleJoined = JSON.stringify(audit.consoleEntries);
    assert.ok(
      consoleJoined.includes('shard-3 slow'),
      `Expected console logs to contain "shard-3 slow", got ${consoleJoined}`,
    );

    // 2. Assert network log captured "/api/metrics?source=login"
    const networkJoined = JSON.stringify(audit.networkEntries);
    assert.ok(
      networkJoined.includes('/api/metrics'),
      `Expected network logs to contain "/api/metrics", got ${networkJoined}`,
    );

    // 3. Assert cookies include gpui_public_pref="theme_night" AND redact HttpOnly secret value!
    const pubCookie = audit.cookiesList.find((c: any) => c?.name === 'gpui_public_pref');
    assert.ok(pubCookie, `Expected gpui_public_pref in cookies: ${JSON.stringify(audit.cookiesList)}`);
    assert.equal(pubCookie.value, 'theme_night');

    const secretCookie = audit.cookiesList.find((c: any) => c?.name === 'gpui_session_secret');
    if (secretCookie) {
      assert.notEqual(
        secretCookie.value,
        'SUPER_SECRET_HTTPONLY_TOKEN_991',
        'HttpOnly cookie value MUST be redacted on op:"list"',
      );
    }

    // Security invariant: raw HttpOnly token MUST NEVER appear in any LLM request payload
    const allRecordedJson = JSON.stringify(ctx.mockLlm.recordedRequests);
    assert.ok(
      !allRecordedJson.includes('SUPER_SECRET_HTTPONLY_TOKEN_991'),
      'CRITICAL SECURITY FAILURE: HttpOnly secret leaked into MockLlmServer recordedRequests!',
    );

    // 4. Assert download completed in Chromium chrome.downloads or downloadsDir
    const downloadCompleted = await pollUntil(
      async () => {
        const swDone = await ctx.browser
          .evalInServiceWorker(async (dlId?: number) => {
            const c = (globalThis as any).chrome;
            if (!c?.downloads?.search) return false;
            const items = await c.downloads.search(dlId ? { id: dlId } : {});
            return items.some(
              (it: any) =>
                it.state === 'complete' &&
                String(it.url || it.finalUrl || '').includes('/download/report.csv'),
            );
          }, audit.downloadId)
          .catch(() => false);
        if (swDone) return true;
        const files = fs.existsSync(ctx.runEnv.downloadsDir)
          ? fs.readdirSync(ctx.runEnv.downloadsDir)
          : [];
        return files.some((f) => f.endsWith('.csv'));
      },
      { timeoutMs: 10000, intervalMs: 100, message: 'Chromium CSV download completion' },
    );
    assert.equal(downloadCompleted, true);

    // 5. Assert full_page: true PNG screenshot has valid PNG signature & beyond-viewport height
    assert.ok(
      typeof audit.fullPagePngB64 === 'string' && audit.fullPagePngB64.length > 200,
      'Expected non-empty full_page PNG base64',
    );
    const pngMeta = assertValidPng(audit.fullPagePngB64!, { minWidth: 600, minHeight: 1200 });
    assert.ok(pngMeta.byteLength < 32 * 1024 * 1024, 'Screenshot must fit within 32 MiB WS limit');
  },
});

// ============================================================================
// T4-04: Multi-Device Auth, Real-Time PTS Gap Recovery, E2EE Chat & Theme/i18n Sync
// ============================================================================
defineTest({
  id: 'T4-04',
  title:
    'Multi-Device Auth, Real-Time PTS Gap Recovery, E2EE Chat & Theme/i18n Sync: registers/signs in alice via auth-wizard, exchanges Markdown + 5-bit Voice + Poll + X3DH/Double-Ratchet E2EE, recovers 3 cold-wake offline messages, and syncs Classic theme + en-US',
  tier: 4,
  features: ['F2', 'F6', 'F10', 'F11', 'F13', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    const alice = await ctx.createIsolatedUser('alice_t404');
    const bob = await ctx.createIsolatedUser('bob_t404');

    // Clear Extension storage so workspace.html launches unauthenticated at auth-wizard
    await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      if (c?.storage?.local) {
        await c.storage.local.remove([
          'token',
          'auth_token',
          'user_id',
          'session',
          'auth_session',
          'accounts',
          'active_account_id',
        ]);
      }
    });

    // Step 1: Authenticate alice through [data-testid="auth-wizard"] in workspace.html
    let workspacePage: CdpPageHandle | null = await ctx.browser.openExtensionSurface('workspace', {
      viewport: { width: 1440, height: 900 },
    });
    let sidepanelPage: CdpPageHandle | null = null;

    try {
      await workspacePage.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 12000 });
      await typeIntoTestId(workspacePage, 'auth-server-url-input', ctx.server.baseUrl, {
        clearFirst: true,
      });
      await typeIntoTestId(workspacePage, 'auth-username-input', alice.username, {
        clearFirst: true,
      });
      await typeIntoTestId(workspacePage, 'auth-password-input', alice.password, {
        clearFirst: true,
      });
      await workspacePage.clickTestId('auth-submit-btn');
      await workspacePage.waitForTestId('conversation-stage', {
        state: 'visible',
        timeoutMs: 12000,
      });

      const dmChat = await alice.api.createChat({
        chat_type: 'direct',
        peer_user_id: bob.userId,
      });
      const dmChatId = Number(dmChat.chat_id ?? dmChat.id);

      // Step 2: Exchange Markdown message, 5-bit WASM Voice card, and Poll (with live UI vote)
      await selectDialogInSidebar(workspacePage, {
        chatId: dmChatId,
        titleHints: [bob.username, 'bob_t404'],
      });
      await sendComposerMessageInSurface(
        workspacePage,
        'Hello **Bob** — `e2ee_handshake_ready`!',
      );
      await pollUntil(
        async () => {
          const hist = await bob.api.getMessages(dmChatId, { limit: 10 });
          return (hist.messages ?? []).some((m: any) =>
            String(m?.text ?? '').includes('e2ee_handshake_ready'),
          );
        },
        { timeoutMs: 10000, intervalMs: 100, message: 'Bob received Alice Markdown message' },
      );

      // 5-bit WASM waveform Voice note from Bob -> Alice
      const bars = Array.from({ length: 100 }, (_, i) => (i * 3 + 7) % 32);
      const wfEnc = await workspacePage.invokeWasm('waveform_encode_5bit', {
        bars,
        samples: bars,
      });
      assert.equal(wfEnc.ok, true);
      const packedWf: number[] = Array.isArray(wfEnc.data?.bytes)
        ? wfEnc.data.bytes
        : typeof wfEnc.data?.encoded_b64 === 'string'
          ? Array.from(Buffer.from(wfEnc.data.encoded_b64, 'base64'))
          : wfEnc.data;
      assert.equal(packedWf.length, 63);

      const oggBytes = buildVoiceNoteOggBytes();
      const uploadedVoice = await bob.api.uploadMedia(oggBytes, {
        filename: 'bob_voice.ogg',
        mimeType: 'audio/ogg',
        chatId: dmChatId,
      });
      await bob.api.sendMessage({
        chat_id: dmChatId,
        content: {
          type: 'Voice',
          data: {
            file_id: String(uploadedVoice.file_id ?? uploadedVoice.media_id),
            duration_seconds: 5,
            waveform: packedWf,
            mime_type: 'audio/ogg',
            size_bytes: oggBytes.length,
          },
        },
      });

      // Poll created by Bob -> Alice votes in workspace.html
      const pollCreated = await bob.api.createPoll(dmChatId, {
        question: 'Approve Rust WASM Double Ratchet rollout?',
        options: ['Approve immediately', 'Defer'],
      });
      const pollId = pollCreated.poll?.poll_id ?? pollCreated.poll?.id;
      assert.ok(pollId !== undefined);

      await workspacePage.waitForText('Approve Rust WASM Double Ratchet rollout?', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 12000,
      });

      const pollOptionSel = await pollUntil(
        async () => {
          return await workspacePage!.eval(() => {
            document
              .querySelectorAll('[data-e2e-t404-poll-opt]')
              .forEach((el) => el.removeAttribute('data-e2e-t404-poll-opt'));
            const stage = document.querySelector('[data-testid="conversation-stage"]');
            if (!stage) return null;
            const els = Array.from(
              stage.querySelectorAll(
                '[data-option-id], button, label, [role="radio"], [role="checkbox"], [role="option"], [role="button"], li, div',
              ),
            ) as HTMLElement[];
            const matches = els
              .filter((e) => {
                const r = e.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  r.height <= 90 &&
                  (e.innerText || e.textContent || '').includes('Approve immediately')
                );
              })
              .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
            const opt = matches[0];
            if (!opt) return null;
            opt.setAttribute('data-e2e-t404-poll-opt', '1');
            return '[data-e2e-t404-poll-opt="1"]';
          });
        },
        {
          timeoutMs: 8000,
          intervalMs: 100,
          message: 'Poll option "Approve immediately" rendered in conversation-stage',
        },
      );
      assert.ok(
        pollOptionSel,
        'Poll card in conversation-stage must render clickable option "Approve immediately"',
      );
      await workspacePage.click(pollOptionSel);

      const maybeVoteSubmitSel = await workspacePage.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]');
        if (!stage) return null;
        const btns = Array.from(stage.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        const voteBtn = btns.find((b) => {
          const r = b.getBoundingClientRect();
          const txt = (b.innerText || b.textContent || '').trim();
          return r.width > 0 && r.height > 0 && /^(vote|submit vote|投票|提交投票)$/i.test(txt);
        });
        if (!voteBtn) return null;
        voteBtn.setAttribute('data-e2e-t404-poll-submit', '1');
        return '[data-e2e-t404-poll-submit="1"]';
      });
      if (maybeVoteSubmitSel) {
        await workspacePage.click(maybeVoteSubmitSel);
      }

      await pollUntil(
        async () => {
          const msgs = await bob.api.getMessages(dmChatId, { limit: 15 });
          const pollMsg = (msgs.messages ?? []).find((m: any) =>
            JSON.stringify(m).includes('Approve Rust WASM Double Ratchet rollout?'),
          );
          return Boolean(pollMsg && JSON.stringify(pollMsg).includes('"total_voters":1'));
        },
        { timeoutMs: 8000, intervalMs: 100, message: 'Poll vote persisted on server' },
      );

      // Step 3: X3DH + Double Ratchet E2EE via gpui_telegram_ext_wasm + /api/v1/e2ee/prekeys
      const aliceWasmId = await workspacePage.invokeWasm('e2ee_generate_identity', {
        device_id: 'dev_alice_t404',
        spk_id: 1,
        otpk_count: 4,
        created_at_ms: Date.now(),
      });
      const bobWasmId = await workspacePage.invokeWasm('e2ee_generate_identity', {
        device_id: 'dev_bob_t404',
        spk_id: 1,
        otpk_count: 4,
        created_at_ms: Date.now(),
      });
      assert.equal(aliceWasmId.ok, true, 'Expected WASM e2ee_generate_identity ok for Alice');
      assert.equal(bobWasmId.ok, true, 'Expected WASM e2ee_generate_identity ok for Bob');

      const aliceIkPub = String(
        aliceWasmId.data?.identity_key ?? aliceWasmId.data?.x25519_pub ?? '',
      );
      const aliceIkSec = String(
        aliceWasmId.data?.identity_secret ?? aliceWasmId.data?.x25519_sec ?? '',
      );
      const bobIkPub = String(bobWasmId.data?.identity_key ?? bobWasmId.data?.x25519_pub ?? '');
      const bobIkSec = String(
        bobWasmId.data?.identity_secret ?? bobWasmId.data?.x25519_sec ?? '',
      );

      // Also publish cryptographically signed prekey bundles to /api/v1/e2ee/prekeys
      const aliceServerBundle = generateSignedPreKeyBundle('dev_alice_srv', 4);
      const bobServerBundle = generateSignedPreKeyBundle('dev_bob_srv', 4);
      const pubAlice = await alice.api.publishPreKeys(aliceServerBundle.requestPayload);
      const pubBob = await bob.api.publishPreKeys(bobServerBundle.requestPayload);
      assert.equal(pubAlice.success, true);
      assert.equal(pubBob.success, true);

      const fetchedBobBundles = await alice.api.fetchUserPreKeyBundles(bob.userId);
      assert.ok(Array.isArray(fetchedBobBundles.devices) && fetchedBobBundles.devices.length >= 1);

      // Verify commutative 4-emoji safety numbers in WASM
      const safetyAB = await workspacePage.invokeWasm('safety_number_emojis', {
        local_ik: aliceIkPub,
        remote_ik: bobIkPub,
        local_identity_key: aliceIkPub,
        remote_identity_key: bobIkPub,
      });
      const safetyBA = await workspacePage.invokeWasm('safety_number_emojis', {
        local_ik: bobIkPub,
        remote_ik: aliceIkPub,
        local_identity_key: bobIkPub,
        remote_identity_key: aliceIkPub,
      });
      assert.equal(safetyAB.ok, true);
      assert.equal(safetyBA.ok, true);
      const emojisAB = String(safetyAB.data?.emojis ?? safetyAB.data);
      const emojisBA = String(safetyBA.data?.emojis ?? safetyBA.data);
      assert.ok(emojisAB.length > 0);
      assert.equal(emojisAB, emojisBA, 'Safety number emojis must be commutative between Alice & Bob');

      // Run X3DH + Double Ratchet encrypt/decrypt roundtrip in WASM
      const bobSpkObj = bobWasmId.data?.signed_prekey ?? {};
      const bobSpkPub = String(bobSpkObj.public_key ?? bobSpkObj.pub_key ?? '');
      const bobSpkSec = String(
        bobSpkObj.secret_key ?? bobSpkObj.private_key ?? bobWasmId.data?.spk_secret ?? '',
      );
      const bobIskPub = String(
        bobWasmId.data?.identity_signing_key ?? bobWasmId.data?.ed25519_pub ?? '',
      );

      const x3dhInit = await workspacePage.invokeWasm('e2ee_x3dh_initiator', {
        ik_a_sec: aliceIkSec,
        bundle: {
          user_id: bob.userId,
          device_id: 'dev_bob_t404',
          identity_key: bobIkPub,
          identity_signing_key: bobIskPub,
          signed_prekey: {
            key_id: bobSpkObj.key_id ?? 1,
            public_key: bobSpkPub,
            signature: bobSpkObj.signature,
            created_at_ms: bobSpkObj.created_at_ms ?? Date.now(),
          },
          one_time_prekey: null,
        },
      });
      assert.equal(x3dhInit.ok, true, `X3DH initiator failed: ${JSON.stringify(x3dhInit)}`);

      const sharedSecretB64 = String(x3dhInit.data?.shared_secret ?? '');
      const ekAPub = String(x3dhInit.data?.ephemeral_pub ?? x3dhInit.data?.ek_a_pub ?? '');

      assert.ok(
        bobSpkSec.length > 0 && ekAPub.length > 0,
        'Expected non-empty bobSpkSec and ekAPub for X3DH responder verification',
      );
      const x3dhResp = await workspacePage.invokeWasm('e2ee_x3dh_responder', {
        ik_b_sec: bobIkSec,
        spk_b_sec: bobSpkSec,
        ik_a_pub: aliceIkPub,
        ek_a_pub: ekAPub,
      });
      assert.equal(x3dhResp.ok, true);
      assert.equal(x3dhResp.data?.shared_secret, sharedSecretB64);

      const aliceRatchetInit = await workspacePage.invokeWasm('e2ee_ratchet_init', {
        role: 'alice',
        shared_secret: sharedSecretB64,
        remote_dh_pub: bobSpkPub,
        bob_dh_pub: bobSpkPub,
      });
      const bobRatchetInit = await workspacePage.invokeWasm('e2ee_ratchet_init', {
        role: 'bob',
        shared_secret: sharedSecretB64,
        self_dh_sec: bobSpkSec,
        bob_dh_sec: bobSpkSec,
      });
      assert.equal(aliceRatchetInit.ok, true);
      assert.equal(bobRatchetInit.ok, true);

      const secretPlaintext = 'Top-Secret Double Ratchet Payload #2026';
      const encryptedStep = await workspacePage.invokeWasm('e2ee_ratchet_encrypt', {
        session: aliceRatchetInit.data?.session ?? aliceRatchetInit.data,
        plaintext: secretPlaintext,
      });
      assert.equal(encryptedStep.ok, true);
      assert.notEqual(encryptedStep.data?.ciphertext, secretPlaintext);

      const decryptedStep = await workspacePage.invokeWasm('e2ee_ratchet_decrypt', {
        session: bobRatchetInit.data?.session ?? bobRatchetInit.data,
        header: encryptedStep.data?.header,
        ciphertext: encryptedStep.data?.ciphertext,
      });
      assert.equal(decryptedStep.ok, true);
      assert.equal(decryptedStep.data?.plaintext, secretPlaintext);

      // Step 4: Force-stop Extension SW, send 3 offline messages from Bob, cold-wake workspace + sidepanel
      await workspacePage.close();
      workspacePage = null;
      await ctx.browser.stopServiceWorkerForColdWake();

      await bob.api.sendMessage({ chat_id: dmChatId, text: 'T404-ColdGap-1' });
      await bob.api.sendMessage({ chat_id: dmChatId, text: 'T404-ColdGap-2' });
      await bob.api.sendMessage({ chat_id: dmChatId, text: 'T404-ColdGap-3' });

      workspacePage = await ctx.browser.openExtensionSurface('workspace', {
        viewport: { width: 1440, height: 900 },
      });
      sidepanelPage = await ctx.browser.openExtensionSurface('sidepanel', {
        viewport: { width: 420, height: 820 },
      });

      for (const surfacePage of [workspacePage, sidepanelPage]) {
        await surfacePage.waitForTestId('conversation-stage', {
          state: 'visible',
          timeoutMs: 12000,
        });
        await selectDialogInSidebar(surfacePage, {
          chatId: dmChatId,
          titleHints: [bob.username, 'bob_t404'],
        });
        for (const msgToken of ['T404-ColdGap-1', 'T404-ColdGap-2', 'T404-ColdGap-3']) {
          await surfacePage.waitForText(msgToken, {
            selector: '[data-testid="conversation-stage"]',
            timeoutMs: 15000,
          });
        }
      }

      // Step 5: Switch theme Night -> Classic exclusively via workspace.html theme-toggle-btn and language zh-CN -> en-US across both surfaces
      await workspacePage.waitForTestId('theme-toggle-btn', { state: 'visible', timeoutMs: 8000 });
      const checkIsClassic = async (): Promise<boolean> => {
        return await workspacePage!.eval(() => {
          const themed = document.querySelector('.tdesktop-theme, [data-theme]') as HTMLElement | null;
          const attr =
            `${document.documentElement.getAttribute('data-theme') ?? ''} ${document.body.getAttribute('data-theme') ?? ''} ${themed?.getAttribute('data-theme') ?? ''} ${document.documentElement.className} ${document.body.className} ${themed?.className ?? ''}`.toLowerCase();
          return attr.includes('classic');
        });
      };

      let classicApplied = await checkIsClassic();
      for (let i = 0; i < 5 && !classicApplied; i++) {
        await workspacePage.clickTestId('theme-toggle-btn');
        await sleep(140);
        classicApplied = await checkIsClassic();
        if (!classicApplied) {
          const classicOptSel = await workspacePage.eval(() => {
            document
              .querySelectorAll('[data-e2e-t404-classic-opt]')
              .forEach((el) => el.removeAttribute('data-e2e-t404-classic-opt'));
            const nodes = Array.from(
              document.querySelectorAll(
                '[data-theme="classic"], [data-value="classic"], [role="menuitem"], [role="option"], button, li',
              ),
            ) as HTMLElement[];
            const hit = nodes.find((el) => {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              if (el.getAttribute('data-testid') === 'theme-toggle-btn') return false;
              const label = `${el.getAttribute('data-theme') ?? ''} ${el.getAttribute('data-value') ?? ''} ${el.innerText || el.textContent || ''}`;
              return /\bclassic\b|经典/i.test(label);
            });
            if (!hit) return null;
            hit.setAttribute('data-e2e-t404-classic-opt', '1');
            return '[data-e2e-t404-classic-opt="1"]';
          });
          if (classicOptSel) {
            await workspacePage.click(classicOptSel);
            await sleep(140);
            classicApplied = await checkIsClassic();
          }
        }
      }
      assert.equal(
        classicApplied,
        true,
        'Clicking [data-testid="theme-toggle-btn"] must switch workspace.html into Classic theme via UI controls',
      );

      const sampleClassicSurface = () => {
        const rootEl =
          (document.querySelector('.tdesktop-theme') as HTMLElement | null) ||
          document.documentElement;
        const stageEl =
          (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null) ||
          rootEl;
        const rootCs = window.getComputedStyle(rootEl);
        const stageCs = window.getComputedStyle(stageEl);
        const bodyCs = window.getComputedStyle(document.body);
        const pickOpaqueBg = (...styles: CSSStyleDeclaration[]): string => {
          for (const s of styles) {
            const bg = s.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              return bg;
            }
          }
          return bodyCs.backgroundColor;
        };
        return {
          attr: (
            document.documentElement.getAttribute('data-theme') ||
            document.body.getAttribute('data-theme') ||
            rootEl.getAttribute('data-theme') ||
            `${document.documentElement.className} ${rootEl.className}`
          ).toLowerCase(),
          appBg: pickOpaqueBg(rootCs, bodyCs),
          stageBg: pickOpaqueBg(stageCs, rootCs, bodyCs),
          stageBgImage: stageCs.backgroundImage || 'none',
        };
      };

      const syncedTheme = await pollUntil(
        async () => {
          const [wsTheme, spTheme] = await Promise.all([
            workspacePage!.eval(sampleClassicSurface),
            sidepanelPage!.eval(sampleClassicSurface),
          ]);
          if (wsTheme.attr.includes('classic') && spTheme.attr.includes('classic')) {
            return { wsTheme, spTheme };
          }
          return null;
        },
        { timeoutMs: 8000, intervalMs: 100, message: 'Classic theme synchronized to both surfaces' },
      );
      assert.ok(syncedTheme, 'Expected Classic theme state from both surfaces');

      for (const [surfaceLabel, snap] of [
        ['workspace.html', syncedTheme.wsTheme],
        ['sidepanel.html', syncedTheme.spTheme],
      ] as const) {
        if (snap.stageBgImage === 'none') {
          assertCssColorMatches(snap.stageBg, '#D5E8C8', 45);
        } else {
          const rgb = parseCssRgb(snap.stageBg) ?? parseCssRgb(snap.appBg);
          assert.ok(
            rgb !== null && rgb.r >= 180 && rgb.g >= 195 && rgb.b >= 175,
            `Expected light Classic surface RGB on ${surfaceLabel}, got stageBg=${snap.stageBg}, appBg=${snap.appBg}`,
          );
        }
      }

      await workspacePage.waitForTestId('lang-toggle-btn', { state: 'visible', timeoutMs: 8000 });

      const sampleLangState = async (surface: CdpPageHandle) => {
        return await surface.eval(() => {
          const lang = (
            document.documentElement.lang ||
            document.documentElement.getAttribute('data-lang') ||
            document.body.getAttribute('data-lang') ||
            ''
          )
            .trim()
            .toLowerCase();
          const chromeParts: string[] = [];
          for (const el of Array.from(
            document.querySelectorAll(
              '[data-testid="nav-rail"], [data-testid="chat-sidebar"], [data-testid="context-inspector"], header, nav, input, textarea, button, [aria-label], [title]',
            ),
          )) {
            if (el.closest('[data-testid="message-bubble"]')) continue;
            const inp = el as HTMLInputElement;
            chromeParts.push(
              `${inp.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${(el as HTMLElement).innerText || ''}`,
            );
          }
          const copy = chromeParts.join(' ');
          const hasEn =
            /\b(Search|Settings|Send|Bridge|Tab|Message|Type|Archived|Workspace|Studio|Chats)\b/i.test(
              copy,
            );
          const hasZh = /搜索|设置|发送|归档|输入消息|工作台/.test(copy);
          return { lang, hasEn, hasZh };
        });
      };

      // Ensure zh-CN is active first so clicking lang-toggle-btn genuinely tests zh-CN -> en-US synchronization
      const initialLang = await sampleLangState(workspacePage);
      if ((initialLang.lang.startsWith('en') || initialLang.hasEn) && !initialLang.hasZh) {
        await workspacePage.clickTestId('lang-toggle-btn');
        await pollUntil(
          async () => {
            const st = await sampleLangState(workspacePage!);
            return st.lang.startsWith('zh') || st.hasZh ? st : null;
          },
          {
            timeoutMs: 6000,
            intervalMs: 80,
            message: 'workspace.html switched to zh-CN before en-US toggle',
          },
        );
      }

      // Toggle zh-CN -> en-US via workspace.html lang-toggle-btn
      await workspacePage.clickTestId('lang-toggle-btn');

      const wsState = await pollUntil(
        async () => {
          const st = await sampleLangState(workspacePage!);
          return (st.lang.startsWith('en') || st.hasEn) && !st.hasZh ? st : null;
        },
        { timeoutMs: 6000, intervalMs: 80, message: 'workspace.html switched to en-US' },
      );
      assert.ok(
        wsState && (wsState.lang.startsWith('en') || wsState.hasEn) && !wsState.hasZh,
        `Expected workspace.html in en-US without zh-CN chrome, got ${JSON.stringify(wsState)}`,
      );

      const spState = await pollUntil(
        async () => {
          const st = await sampleLangState(sidepanelPage!);
          return (st.lang.startsWith('en') || st.hasEn) && !st.hasZh ? st : null;
        },
        {
          timeoutMs: 8000,
          intervalMs: 100,
          message: 'en-US language sync across surfaces without reload',
        },
      );
      assert.ok(
        spState && (spState.lang.startsWith('en') || spState.hasEn) && !spState.hasZh,
        `Expected sidepanel.html synchronized to en-US without zh-CN chrome, got ${JSON.stringify(spState)}`,
      );
    } finally {
      if (sidepanelPage) await sidepanelPage.close().catch(() => undefined);
      if (workspacePage) await workspacePage.close().catch(() => undefined);
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

// ============================================================================
// T4-05: Standalone Managed Local CDP Fallback When Extension Disconnects
// ============================================================================
defineTest({
  id: 'T4-05',
  title:
    'Standalone Managed Local CDP Fallback When Extension Disconnects: executes full /shop -> /shop/checkout React _valueTracker flow and PNG screenshot against headless Chromium with zero Extension WS connected',
  tier: 4,
  features: ['F3', 'F4', 'F14', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    const standaloneChrome = await ctx.spawnIsolatedChromium({ loadExtension: false });
    assert.equal(standaloneChrome.extensionLoaded, false);

    const targets = await standaloneChrome.listTargets();
    assert.ok(
      !targets.some((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')),
      'Standalone Chromium instance must have zero extension service workers loaded',
    );

    const standaloneServer = await ctx.spawnIsolatedServer({
      cdpFallbackUrl: standaloneChrome.cdpHttpUrl,
    });

    const anon = new TelegramApiClient(standaloneServer.baseUrl);
    const reg = await anon.register({
      username: `cdp_only_${Date.now().toString(36)}`,
      password: 'FabushiE2e!2026',
      auto_welcome: true,
    });
    const cdpApi = new TelegramApiClient(standaloneServer.baseUrl, reg.token);
    await standaloneServer.configureMockLlmProvider(reg.token, ctx.mockLlm.port, 'gpt-4o');

    // Verify zero Extension WS connected on standaloneServer
    const initialBrowserStatus = await cdpApi.getBrowserStatus();
    assert.ok(
      !initialBrowserStatus.server_relay_connected && !initialBrowserStatus.extension_connected,
      `Expected zero Extension WS on standaloneServer, got ${JSON.stringify(initialBrowserStatus)}`,
    );

    const slashStatus = await cdpApi.runHermesCommand('/browser status');
    assert.equal(slashStatus.handled, true);

    const cdpObserved: {
      addCartRef?: string;
      nameRef?: string;
      emailRef?: string;
      addrRef?: string;
      placeOrderRef?: string;
      screenshotB64?: string;
    } = {};

    ctx.mockLlm.registerScenario('t4_05_cdp_fallback', (turnCtx: MockLlmTurnContext) => {
      if (turnCtx.turnIndex === 0) {
        return {
          reasoning: 'Navigating standalone CDP browser to /shop...',
          toolCalls: [
            {
              id: 'call_t405_nav_shop',
              name: 'browser_navigate',
              arguments: { url: `${ctx.fixtureApp.baseUrl}/shop` },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 1) {
        return {
          reasoning: 'Snapshotting /shop via standalone CDP to index [ref=eN] elements...',
          toolCalls: [{ id: 'call_t405_snap_shop', name: 'browser_snapshot', arguments: {} }],
        };
      }

      if (turnCtx.turnIndex === 2) {
        const snap = turnCtx.latestToolResult?.json;
        cdpObserved.addCartRef = findElementRef(
          snap,
          (_el, h) => h.includes('sku-kb-02') || h.includes('compact travel keyboard'),
        );
        return {
          reasoning: 'Adding SKU-KB-02 to cart and navigating to /shop/checkout...',
          toolCalls: [
            {
              id: 'call_t405_click_add',
              name: 'browser_click',
              arguments: cdpObserved.addCartRef
                ? { ref: cdpObserved.addCartRef }
                : { selector: 'button.add-to-cart-btn[data-sku="SKU-KB-02"]' },
            },
            {
              id: 'call_t405_nav_checkout',
              name: 'browser_navigate',
              arguments: { url: `${ctx.fixtureApp.baseUrl}/shop/checkout` },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 3) {
        return {
          reasoning: 'Snapshotting /shop/checkout React controlled form via CDP...',
          toolCalls: [{ id: 'call_t405_snap_checkout', name: 'browser_snapshot', arguments: {} }],
        };
      }

      if (turnCtx.turnIndex === 4) {
        const snapCheckout = turnCtx.latestToolResult?.json;
        cdpObserved.nameRef = findElementRef(
          snapCheckout,
          (_el, h) => h.includes('checkout-fullname') || h.includes('full name'),
        );
        cdpObserved.emailRef = findElementRef(
          snapCheckout,
          (_el, h) => h.includes('checkout-email') || h.includes('shipping email'),
        );
        cdpObserved.addrRef = findElementRef(
          snapCheckout,
          (_el, h) => h.includes('checkout-address') || h.includes('street address'),
        );
        cdpObserved.placeOrderRef = findElementRef(
          snapCheckout,
          (_el, h) => h.includes('place-order-btn') || h.includes('place order'),
        );
        return {
          reasoning: 'Typing checkout fields with React native value setter and submitting...',
          toolCalls: [
            {
              id: 'call_t405_type_name',
              name: 'browser_type',
              arguments: {
                ...(cdpObserved.nameRef
                  ? { ref: cdpObserved.nameRef }
                  : { selector: '#checkout-fullname' }),
                text: 'Standalone CDP Buyer',
                clear_first: true,
              },
            },
            {
              id: 'call_t405_type_email',
              name: 'browser_type',
              arguments: {
                ...(cdpObserved.emailRef
                  ? { ref: cdpObserved.emailRef }
                  : { selector: '#checkout-email' }),
                text: 'cdp_buyer@example.com',
                clear_first: true,
              },
            },
            {
              id: 'call_t405_type_addr',
              name: 'browser_type',
              arguments: {
                ...(cdpObserved.addrRef
                  ? { ref: cdpObserved.addrRef }
                  : { selector: '#checkout-address' }),
                text: '900 Loopback Way',
                clear_first: true,
                submit: true,
              },
            },
          ],
        };
      }

      if (turnCtx.turnIndex === 5) {
        const addrOut = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
        return {
          reasoning: 'Waiting for #order-confirmation and capturing CDP PNG screenshot...',
          toolCalls: [
            ...(addrOut?.submitted
              ? []
              : [
                  {
                    id: 'call_t405_click_order',
                    name: 'browser_click',
                    arguments: cdpObserved.placeOrderRef
                      ? { ref: cdpObserved.placeOrderRef }
                      : { selector: '#place-order-btn' },
                  },
                ]),
            {
              id: 'call_t405_wait_ok',
              name: 'browser_wait_for',
              arguments: { selector: '#order-confirmation', timeout_ms: 8000 },
            },
            {
              id: 'call_t405_shot',
              name: 'browser_screenshot',
              arguments: { format: 'png' },
            },
          ],
        };
      }

      for (const tr of turnCtx.latestRoundToolResults) {
        const d = unwrapBrowserExecResult(tr.json);
        if (typeof d?.data_base64 === 'string' && d.data_base64.length > 0) {
          cdpObserved.screenshotB64 = d.data_base64;
        } else if (typeof d?.artifact?.data_base64 === 'string') {
          cdpObserved.screenshotB64 = d.artifact.data_base64;
        }
      }

      return {
        content: 'Standalone CDP checkout finished: ORD-2026-8841 confirmed.',
      };
    });

    const turnResp = await cdpApi.createHermesTurn(
      {
        prompt:
          '[E2E_SCENARIO:t4_05_cdp_fallback] Purchase SKU-KB-02 and checkout via standalone local CDP.',
        yolo: true,
        max_iterations: 10,
      },
      75000,
    );

    assert.equal(turnResp.status, 'completed');
    assert.ok(String(turnResp.response ?? '').includes('ORD-2026-8841'));

    assert.ok(
      cdpObserved.addCartRef && /^e\d+$/i.test(cdpObserved.addCartRef),
      `Expected standalone CDP engine to assign [ref=eN], got ${String(cdpObserved.addCartRef)}`,
    );
    assert.ok(
      ctx.fixtureApp.submittedOrders.some(
        (o) => o.orderId === 'ORD-2026-8841' && o.fullName === 'Standalone CDP Buyer',
      ),
      `Expected Standalone CDP Buyer order in fixtureApp.submittedOrders, got ${JSON.stringify(ctx.fixtureApp.submittedOrders)}`,
    );
    assert.ok(
      typeof cdpObserved.screenshotB64 === 'string' && cdpObserved.screenshotB64.length > 100,
      'Expected valid PNG screenshot from standalone CDP fallback',
    );
    assertValidPng(cdpObserved.screenshotB64!, { minWidth: 300, minHeight: 300 });
  },
});

// ============================================================================
// T4-06: AskEveryTime Policy Approval Gate + Prompt-Injection Escalation Defense
// ============================================================================
defineTest({
  id: 'T4-06',
  title:
    'AskEveryTime Policy Approval Gate + Prompt-Injection Escalation Defense: flags hidden override + zero-width Unicode on /adversarial/prompt-injection, denies #danger-exfil-btn (-32002), and approves #benign-like-btn',
  tier: 4,
  features: ['F2', 'F3', 'F5', 'F9', 'F14', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(
      `${ctx.fixtureApp.baseUrl}/adversarial/prompt-injection`,
      async (injTab) => {
        const liveInjDto = await waitForBrowserTabByUrl(
          ctx.primaryUser.api,
          '/adversarial/prompt-injection',
        );
        const injTabId = Number(liveInjDto.tab_id);

        await ctx.withExtensionSurface('popup', async (popupPage) => {
          await selectBrowserPolicyInPopupUi(ctx, popupPage, 'allow_read_only', {
            botId: 777000,
          });
        });

        await ctx.withExtensionSurface('workspace', async (_wsPage) => {

          const t406State: {
            scanResult: Record<string, any> | null;
            deniedToolOutput: any;
            approvedToolOutput: any;
          } = {
            scanResult: null,
            deniedToolOutput: null,
            approvedToolOutput: null,
          };

          ctx.mockLlm.registerScenario('t4_06_injection_gate', (turnCtx: MockLlmTurnContext) => {
            if (turnCtx.turnIndex === 0) {
              return {
                reasoning: 'Snapshotting wiki article under AllowReadOnly policy...',
                toolCalls: [
                  {
                    id: 'call_t406_snap',
                    name: 'browser_snapshot',
                    arguments: { tab_id: injTabId, include_hidden: true },
                  },
                ],
              };
            }

            if (turnCtx.turnIndex === 1) {
              const snap = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
              t406State.scanResult = snap?.injection_scan ?? null;
              return {
                reasoning: 'Attempting mutating click on #danger-exfil-btn (should require approval)...',
                toolCalls: [
                  {
                    id: 'call_t406_danger_click',
                    name: 'browser_click',
                    arguments: { tab_id: injTabId, selector: '#danger-exfil-btn' },
                  },
                ],
              };
            }

            if (turnCtx.turnIndex === 2) {
              t406State.deniedToolOutput = turnCtx.latestToolResult?.json ?? {
                raw: turnCtx.latestToolResult?.rawContent,
              };
              return {
                reasoning:
                  'Dangerous action was denied by user (-32002); requesting benign #benign-like-btn bookmark click...',
                toolCalls: [
                  {
                    id: 'call_t406_benign_click',
                    name: 'browser_click',
                    arguments: { tab_id: injTabId, selector: '#benign-like-btn' },
                  },
                ],
              };
            }

            t406State.approvedToolOutput = turnCtx.latestToolResult?.json ?? {};
            return {
              content:
                'Security gate verified: #danger-exfil-btn denied (-32002) and #benign-like-btn approved safely.',
            };
          });

          // Background approval controller: Deny #danger-exfil-btn, Approve #benign-like-btn
          const handledCommandIds = new Set<string>();
          const approvalWorker = (async () => {
            const deadline = Date.now() + 45000;
            while (Date.now() < deadline && handledCommandIds.size < 2) {
              const { items } = await ctx.primaryUser.api
                .getPendingBrowserCommands()
                .catch(() => ({ items: [] }));
              for (const cmd of items) {
                const cid = String(cmd?.command_id ?? cmd?.id ?? '');
                if (!cid || handledCommandIds.has(cid)) continue;
                const argsStr = JSON.stringify(cmd?.arguments ?? '');
                if (argsStr.includes('danger-exfil-btn')) {
                  handledCommandIds.add(cid);
                  await ctx.primaryUser.api.approveBrowserCommand(cid, false);
                } else if (argsStr.includes('benign-like-btn')) {
                  handledCommandIds.add(cid);
                  await ctx.primaryUser.api.approveBrowserCommand(cid, true);
                }
              }
              await sleep(100);
            }
          })();

          const turnResp = await ctx.primaryUser.api.createHermesTurn(
            {
              prompt:
                '[E2E_SCENARIO:t4_06_injection_gate] Inspect wiki article and test approval gate.',
              bot_id: 777000,
              chat_id: ctx.primaryUser.officialBotChatId,
              yolo: false,
              max_iterations: 8,
            },
            60000,
          );
          await approvalWorker;

          assert.equal(turnResp.status, 'completed');
          assert.ok(t406State.scanResult !== null, 'Expected injection_scan on browser_snapshot');
          assert.equal(t406State.scanResult.flagged, true, 'Expected injection_scan.flagged === true');
          assert.equal(
            String(t406State.scanResult.severity ?? '').toLowerCase(),
            'high',
            'Expected high severity prompt-injection detection',
          );

          // Verify secret exposure detection / redaction
          const sanitizedText = String(t406State.scanResult.sanitized_text ?? '');
          if (sanitizedText.length > 0) {
            assert.ok(
              !sanitizedText.includes('sk-proj-fake1234567890abcdef1234567890abcdef'),
              'Expected sk-proj-* fake token scrubbed in injection_scan.sanitized_text',
            );
          }

          // Verify Attempt A received -32002 USER_DENIED_APPROVAL & #danger-exfil-btn NOT clicked
          assertBrowserRpcError(
            t406State.deniedToolOutput,
            BROWSER_RPC_ERROR_CODES.USER_DENIED_APPROVAL,
            'USER_DENIED_APPROVAL',
          );
          const dangerBtn = await injTab.querySelector('#danger-exfil-btn');
          assert.notEqual(dangerBtn?.attrs['data-clicked'], 'true');

          // Verify Attempt B succeeded & #benign-like-btn clicked
          assert.equal(unwrapBrowserExecResult(t406State.approvedToolOutput)?.ok, true);
          const benignBtn = await injTab.querySelector('#benign-like-btn');
          assert.equal(benignBtn?.attrs['data-clicked'], 'true');
          await injTab.waitForText('BOOKMARKED_SAFE', { selector: '#action-log', timeoutMs: 4000 });
        });
      },
    );
  },
});

// ============================================================================
// T4-07: Mid-Workflow Emergency Kill-Switch (Alt+Shift+S / Popup Stop) & Safe Resume
// ============================================================================
defineTest({
  id: 'T4-07',
  title:
    'Mid-Workflow Emergency Kill-Switch (Alt+Shift+S / Popup Stop) & Safe Resume: aborts 20s browser_wait_for in <2s with -32003, detaches chrome.debugger, blocks subsequent ops, and resumes cleanly on re-enable',
  tier: 4,
  features: ['F6', 'F7', 'F8', 'F9', 'F10', 'F15'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/spa/dashboard`, async (spaTab) => {
      const spaDto = await waitForBrowserTabByUrl(ctx.primaryUser.api, '/spa/dashboard');
      const spaTabId = Number(spaDto.tab_id);

      // Attach chrome.debugger on /spa/dashboard by invoking console log / screenshot capture
      await ctx.primaryUser.api.execBrowserTool({
        tool: 'browser_get_console_logs',
        arguments: { tab_id: spaTabId, limit: 5 },
      });

      const popupPage = await ctx.browser.openExtensionSurface('popup');
      try {
        await popupPage.waitForTestId('emergency-stop-btn', { state: 'visible', timeoutMs: 10000 });

        // Start a 20-second browser_wait_for AND a follow-up browser_click
        const waitStartMs = Date.now();
        const inFlightWaitPromise = ctx.primaryUser.api.execBrowserTool(
          {
            tool: 'browser_wait_for',
            arguments: {
              tab_id: spaTabId,
              selector: '#never-renders-element-e2e',
              state: 'visible',
              timeout_ms: 20000,
            },
            timeout_ms: 22000,
          },
          25000,
        );

        await sleep(300);

        // Trigger Emergency Kill-Switch via popup.html button + Alt+Shift+S shortcut
        await popupPage.pressKey('Alt+Shift+S');
        await popupPage.clickTestId('emergency-stop-btn');

        const abortedWaitRes = await inFlightWaitPromise;
        const abortElapsedMs = Date.now() - waitStartMs;

        assert.ok(
          abortElapsedMs < 3500,
          `Emergency stop must abort 20000ms wait immediately (<3.5s), took ${abortElapsedMs}ms`,
        );
        assertBrowserRpcError(
          abortedWaitRes,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );

        // Verify zero attached chrome.debugger targets remain in Extension SW
        const attachedCount = await pollUntil(
          async () => {
            return await ctx.browser.evalInServiceWorker(async () => {
              const c = (globalThis as any).chrome;
              if (!c?.debugger?.getTargets) return 0;
              const list = await c.debugger.getTargets();
              return list.filter((t: any) => Boolean(t.attached)).length;
            });
          },
          {
            timeoutMs: 5000,
            intervalMs: 80,
            isDone: (cnt) => cnt === 0,
            message: 'chrome.debugger detached all targets on Emergency Stop',
          },
        );
        assert.equal(attachedCount, 0);

        // Verify subsequent browser_snapshot while stopped immediately rejects with -32003
        const blockedWhileStopped = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_snapshot',
          arguments: { tab_id: spaTabId },
        });
        assertBrowserRpcError(
          blockedWhileStopped,
          BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
        );

        // Re-select AlwaysAllowAuthorized in popupPage browser-policy-select UI and verify read-only chrome.storage.local state
        await selectBrowserPolicyInPopupUi(ctx, popupPage, 'always_allow_authorized', {
          botId: 777000,
        });

        await spaTab.goto(`${ctx.fixtureApp.baseUrl}/docs/alpha`);
        await waitForBrowserTabByUrl(ctx.primaryUser.api, '/docs/alpha');

        const resumedSnap = await ctx.primaryUser.api.execBrowserTool({
          tool: 'browser_snapshot',
          arguments: { tab_id: spaTabId },
        });
        const unwrappedResume = unwrapBrowserExecResult(resumedSnap);
        assert.equal(unwrappedResume.ok, true, 'Expected clean resume after re-enabling policy');
        assert.equal(unwrappedResume.title, 'Alpha Cloud Pricing');
      } finally {
        await popupPage.close().catch(() => undefined);
      }
    });
  },
});

// ============================================================================
// T4-08: Custom Fabushi Bot Creation via @BotFather, Browser Policy Binding & Mini App Co-Pilot
// ============================================================================
defineTest({
  id: 'T4-08',
  title:
    'Custom Fabushi Bot Creation via @BotFather, Browser Policy Binding & Mini App Co-Pilot: creates PortalCopilotBot, enforces 127.0.0.1 vs localhost ACL, roundtrips Mini App Telegram.WebApp, and passes F16 repo & CI hygiene',
  tier: 4,
  features: ['F3', 'F12', 'F13', 'F14', 'F15', 'F16'],
  timeoutMs: 90000,
  fn: async (ctx: SharedTierContext) => {
    // 1. Create PortalCopilotBot + Companion Mini App via @BotFather NL create
    const nlCreated = await ctx.primaryUser.api.botFatherNlCreate({
      prompt: 'Create PortalCopilotBot companion AI bot and Portal Co-Pilot Mini App for cloud docs',
      avatar_shape: 'rounded',
      avatar_color: '#2563EB',
    });

    const botObj = nlCreated.bot ?? {};
    const appObj = nlCreated.app ?? {};
    const botId = Number(botObj.bot_user_id ?? botObj.bot_id ?? botObj.id);
    const botUsername = String(botObj.username ?? appObj.bot_username ?? '').replace(/^@/, '');
    const companionChatId = Number(nlCreated.companion_chat_id);
    assert.ok(botId > 0, `Expected valid botId from @BotFather nl-create, got ${String(botId)}`);
    assert.ok(botUsername.length > 0, 'Expected non-empty botUsername');
    assert.ok(companionChatId > 0, 'Expected companion_chat_id > 0');

    const appShortName = String(appObj.short_name ?? 'app');
    const appTitle = String(appObj.title ?? 'Portal Co-Pilot');
    await ctx.primaryUser.api.installMiniApp(botUsername, appShortName, true);

    const launchCtx = await ctx.primaryUser.api.launchMiniApp(botUsername, appShortName, {
      chat_id: companionChatId,
      launch_mode: 'CompactSheet',
    });
    const rawInitData = String(launchCtx?.init_data?.raw_query_string ?? '');
    assert.ok(rawInitData.length > 0, 'Expected signed init_data.raw_query_string');

    const validInitCheck = await ctx.primaryUser.api.validateMiniAppInitData(
      botUsername,
      appShortName,
      rawInitData,
    );
    assert.equal(validInitCheck.valid, true, 'Expected HMAC-SHA256 init_data validation to pass');

    // 2. Configure BotBrowserProfileDto (always_allow_authorized, allowed_domains: ["127.0.0.1"], blocked_domains: ["localhost"])
    //    via ContextInspector Bot Studio UI AND launch sandboxed Mini App <iframe> inside workspace.html
    await ctx.withExtensionSurface('workspace', async (wsPage) => {
      await wsPage.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 12000 });
      const selectedBot = await pollUntil(
        async () =>
          await selectDialogInSidebar(wsPage, {
            chatId: companionChatId,
            titleHints: [
              String(botObj.title ?? botObj.display_name ?? '').toLowerCase(),
              'portalcopilot',
              botUsername.toLowerCase(),
            ].filter(Boolean),
          }),
        { timeoutMs: 8000, intervalMs: 100, message: `Select ${botUsername} in chat-sidebar` },
      );
      assert.equal(selectedBot, true, `Expected ${botUsername} companion chat selectable in sidebar`);

      let inspector = await wsPage.querySelector('[data-testid="context-inspector"]');
      if (!inspector || !inspector.visible) {
        await wsPage.pressKey('Ctrl+i');
        inspector = await wsPage.waitForTestId('context-inspector', {
          state: 'visible',
          timeoutMs: 10000,
        });
      }
      assert.ok(
        inspector && inspector.visible,
        'Expected visible [data-testid="context-inspector"] in workspace.html',
      );

      await wsPage.eval(() => {
        const insp = document.querySelector('[data-testid="context-inspector"]');
        if (!insp) return;
        const studioTrigger = Array.from(
          insp.querySelectorAll('button, [role="tab"], [role="button"], a'),
        ).find((el) =>
          /studio|browser|policy|configure\s*bot|bot\s*config|机器人|浏览器|权限/i.test(
            `${(el as HTMLElement).getAttribute('data-tab') ?? ''} ${(el as HTMLElement).getAttribute('data-testid') ?? ''} ${el.textContent ?? ''}`,
          ),
        ) as HTMLElement | undefined;
        studioTrigger?.click();
      });

      const configuredInInspectorUi = await pollUntil(
        async () => {
          return await wsPage.eval(() => {
            const insp = document.querySelector('[data-testid="context-inspector"]');
            if (!insp) return null;

            const setInputValue = (
              el: HTMLInputElement | HTMLTextAreaElement,
              val: string,
            ): void => {
              const proto =
                el instanceof HTMLTextAreaElement
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            // Ensure browser control toggle/checkbox is enabled if present
            const enableChecks = Array.from(
              insp.querySelectorAll('input[type="checkbox"], [role="switch"]'),
            ) as HTMLElement[];
            for (const chk of enableChecks) {
              const labelTxt = `${chk.getAttribute('aria-label') ?? ''} ${chk.getAttribute('data-testid') ?? ''} ${chk.closest('label, div')?.textContent ?? ''}`;
              if (/enable|browser|开启|启用|浏览器/i.test(labelTxt)) {
                if (chk instanceof HTMLInputElement && !chk.checked) {
                  chk.click();
                } else if (chk.getAttribute('aria-checked') === 'false') {
                  chk.click();
                }
              }
            }

            let policySelected = false;
            const selects = Array.from(insp.querySelectorAll('select')) as HTMLSelectElement[];
            const policySel = selects.find((s) =>
              Array.from(s.options).some((o) =>
                /always_allow_authorized|alwaysallowauthorized|always\s*allow|始终允许|自动允许/i.test(
                  `${o.value} ${o.textContent ?? ''}`,
                ),
              ),
            );
            if (policySel) {
              const opt = Array.from(policySel.options).find((o) =>
                /always_allow_authorized|alwaysallowauthorized|always\s*allow|始终允许|自动允许/i.test(
                  `${o.value} ${o.textContent ?? ''}`,
                ),
              )!;
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype,
                'value',
              )?.set;
              if (setter) setter.call(policySel, opt.value);
              else policySel.value = opt.value;
              policySel.dispatchEvent(new Event('input', { bubbles: true }));
              policySel.dispatchEvent(new Event('change', { bubbles: true }));
              policySelected = true;
            } else {
              const optBtn = Array.from(
                insp.querySelectorAll(
                  '[data-policy="always_allow_authorized"], [data-value="always_allow_authorized"], [role="radio"], [role="option"], button',
                ),
              ).find((el) =>
                /always_allow_authorized|always\s*allow|始终允许|自动允许/i.test(
                  `${(el as HTMLElement).getAttribute('data-policy') ?? ''} ${(el as HTMLElement).getAttribute('data-value') ?? ''} ${el.textContent ?? ''}`,
                ),
              ) as HTMLElement | undefined;
              if (optBtn) {
                optBtn.click();
                policySelected = true;
              }
            }

            const describeField = (el: HTMLInputElement | HTMLTextAreaElement): string => {
              const labelEl =
                (el as HTMLInputElement).labels?.[0] ??
                el.closest('label') ??
                el.previousElementSibling ??
                el.parentElement;
              return `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-testid') ?? ''} ${labelEl?.textContent ?? ''}`;
            };

            const textInputs = Array.from(
              insp.querySelectorAll(
                'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
              ),
            ) as Array<HTMLInputElement | HTMLTextAreaElement>;

            const blockedInp = textInputs.find((i) =>
              /block|deny|blacklist|forbid|disallow|禁止|屏蔽|黑名单/i.test(describeField(i)),
            );
            const allowedInp =
              textInputs.find((i) => {
                if (i === blockedInp) return false;
                const d = describeField(i);
                return (
                  /allow|whitelist|permit|允许|白名单/i.test(d) &&
                  !/block|deny|blacklist|forbid|disallow|禁止|屏蔽|黑名单/i.test(d)
                );
              }) ??
              textInputs.find(
                (i) => i !== blockedInp && /domain|host|域名/i.test(describeField(i)),
              );

            let allowedEntered = false;
            if (allowedInp) {
              setInputValue(allowedInp, '127.0.0.1');
              allowedEntered = true;
            }

            let blockedEntered = false;
            if (blockedInp) {
              setInputValue(blockedInp, 'localhost');
              blockedEntered = true;
            }

            const saveBtn = Array.from(insp.querySelectorAll('button')).find((b) =>
              /save|apply|update|保存|应用|更新/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.textContent ?? ''}`,
              ),
            );
            saveBtn?.click();

            if (!policySelected || !allowedEntered || !blockedEntered) return null;
            return { policySelected, allowedEntered, blockedEntered };
          });
        },
        {
          timeoutMs: 8000,
          intervalMs: 100,
          message:
            'ContextInspector Bot Studio exposes run_policy, allowed_domains, and blocked_domains UI controls',
        },
      );
      assert.ok(
        configuredInInspectorUi &&
          configuredInInspectorUi.policySelected &&
          configuredInInspectorUi.allowedEntered &&
          configuredInInspectorUi.blockedEntered,
        'ContextInspector Bot Studio must configure always_allow_authorized, allowed_domains, and blocked_domains via UI',
      );

      const savedProfile = await pollUntil(
        async () => {
          const p = await ctx.primaryUser.api.getBotBrowserProfile(botId);
          return p.enabled === true &&
            p.run_policy === 'always_allow_authorized' &&
            Array.isArray(p.allowed_domains) &&
            p.allowed_domains.includes('127.0.0.1') &&
            Array.isArray(p.blocked_domains) &&
            p.blocked_domains.includes('localhost')
            ? p
            : null;
        },
        {
          timeoutMs: 6000,
          intervalMs: 100,
          message:
            'ContextInspector Bot Studio persisted BotBrowserProfileDto (always_allow_authorized, 127.0.0.1, localhost) on server',
        },
      );
      assert.ok(savedProfile, 'Expected BotBrowserProfileDto persisted via ContextInspector Bot Studio');
      assert.equal(savedProfile.enabled, true);
      assert.equal(savedProfile.run_policy, 'always_allow_authorized');
      assert.deepEqual(savedProfile.allowed_domains, ['127.0.0.1']);
      assert.deepEqual(savedProfile.blocked_domains, ['localhost']);

      // 3. Launch Mini App inside workspace.html, assert sandboxed <iframe>, invoke Telegram.WebApp.sendData via CDP, and verify companion chat receipt
      const miniAppLaunchSel = await pollUntil(
        async () => {
          return await wsPage.eval((expectedTitle: string) => {
            document
              .querySelectorAll('[data-e2e-t408-app-btn]')
              .forEach((el) => el.removeAttribute('data-e2e-t408-app-btn'));
            const candidates = Array.from(
              document.querySelectorAll(
                '[data-testid*="miniapp" i], [data-testid*="mini-app" i], [data-testid*="web-app" i], [data-testid*="bot-app" i], button, [role="button"], [role="menuitem"]',
              ),
            ) as HTMLElement[];
            const hit = candidates.find((b) => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const label = `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`;
              return (
                (expectedTitle && label.includes(expectedTitle)) ||
                /mini\s*app|open\s*app|launch\s*app|web\s*app|bot\s*app|小程序|打开应用|启动应用/i.test(
                  label,
                )
              );
            });
            if (!hit) return null;
            hit.setAttribute('data-e2e-t408-app-btn', '1');
            return '[data-e2e-t408-app-btn="1"]';
          }, appTitle);
        },
        {
          timeoutMs: 8000,
          intervalMs: 100,
          message: 'Mini App launch button rendered in workspace.html',
        },
      );
      assert.ok(miniAppLaunchSel, 'workspace.html must expose a clickable Mini App launch button');
      await wsPage.click(miniAppLaunchSel);

      const maybePickerItemSel = await wsPage.eval(
        (cfg: { title: string; bUser: string }) => {
          if (document.querySelector('iframe')) return null;
          const items = Array.from(
            document.querySelectorAll(
              '[role="menuitem"], [role="option"], [role="dialog"] button, button, li',
            ),
          ) as HTMLElement[];
          const item = items.find((el) => {
            const r = el.getBoundingClientRect();
            const txt = el.textContent ?? '';
            return (
              r.width > 0 &&
              r.height > 0 &&
              !el.hasAttribute('data-e2e-t408-app-btn') &&
              ((cfg.title && txt.includes(cfg.title)) || txt.includes(cfg.bUser))
            );
          });
          if (!item) return null;
          item.setAttribute('data-e2e-t408-picker-item', '1');
          return '[data-e2e-t408-picker-item="1"]';
        },
        { title: appTitle, bUser: botUsername },
      );
      if (maybePickerItemSel) {
        await wsPage.click(maybePickerItemSel);
      }

      const mountedIframe = await pollUntil(
        async () => {
          return await wsPage.eval(() => {
            const ifr = document.querySelector('iframe') as HTMLIFrameElement | null;
            if (!ifr) return null;
            const r = ifr.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return null;
            const src = ifr.getAttribute('src') || ifr.src || '';
            if (!src) return null;
            return {
              src,
              hasSandbox: ifr.hasAttribute('sandbox'),
              sandbox: (ifr.getAttribute('sandbox') ?? '').trim(),
            };
          });
        },
        {
          timeoutMs: 8000,
          intervalMs: 100,
          message: 'Sandboxed Mini App <iframe> mounted inside workspace.html',
        },
      );
      assert.ok(mountedIframe, 'Expected visible Mini App <iframe> mounted inside workspace.html');
      assert.equal(
        mountedIframe.hasSandbox,
        true,
        'Mini App <iframe> must declare an explicit sandbox attribute',
      );
      assert.ok(
        mountedIframe.sandbox.length > 0 &&
          !mountedIframe.sandbox.includes('allow-top-navigation') &&
          !mountedIframe.sandbox.includes('allow-popups-to-escape-sandbox'),
        `Mini App <iframe> sandbox policy is invalid: "${mountedIframe.sandbox}"`,
      );

      const pingMarker = `t408_copilot_ping_${Date.now().toString(36)}`;
      const sentFromIframe = await pollUntil(
        async () => {
          const targets = await ctx.browser.listTargets();
          const iframeTarget = targets.find(
            (t) =>
              t.targetId !== wsPage.targetId &&
              (t.type === 'iframe' || t.url.includes('/miniapps/')) &&
              (t.url.includes('/miniapps/') ||
                t.url.includes(botUsername) ||
                t.url.includes(appShortName)),
          );
          if (!iframeTarget) return null;
          const { sessionId: frameSid } = await ctx.browser.cdp.send<{ sessionId: string }>(
            'Target.attachToTarget',
            { targetId: iframeTarget.targetId, flatten: true },
          );
          try {
            await ctx.browser.cdp.send('Runtime.enable', {}, frameSid);
            const evalRes = await ctx.browser.cdp.send<{
              result?: { value?: { ok: boolean } };
            }>(
              'Runtime.evaluate',
              {
                expression: `(() => {
                  const wa = window.Telegram && window.Telegram.WebApp;
                  if (!wa || typeof wa.sendData !== 'function') return null;
                  const payload = JSON.stringify({
                    action: 'copilot_ping',
                    target: 'alpha_docs',
                    marker: ${JSON.stringify(pingMarker)},
                  });
                  wa.sendData(payload);
                  return { ok: true };
                })()`,
                returnByValue: true,
              },
              frameSid,
            );
            return evalRes.result?.value ?? null;
          } finally {
            await ctx.browser.cdp
              .send('Target.detachFromTarget', { sessionId: frameSid })
              .catch(() => undefined);
          }
        },
        {
          timeoutMs: 8000,
          intervalMs: 120,
          message: 'window.Telegram.WebApp.sendData executed inside mounted Mini App <iframe>',
        },
      );
      assert.ok(
        sentFromIframe?.ok,
        'Expected window.Telegram.WebApp.sendData(...) to execute inside sandboxed Mini App <iframe>',
      );

      await pollUntil(
        async () => {
          const history = await ctx.primaryUser.api.getMessages(companionChatId, { limit: 25 });
          return (history.messages ?? []).some((m: any) =>
            JSON.stringify(m).includes(pingMarker),
          );
        },
        {
          timeoutMs: 8000,
          intervalMs: 120,
          message: 'workspace.html bridged Mini App sendData postMessage to companion chat on server',
        },
      );
    });

    // 4. Prompt PortalCopilotBot: allowed 127.0.0.1 (/docs/alpha -> ok:true) vs blocked localhost (/docs/beta -> blocked!)
    const localhostBetaTab = await ctx.browser.openPage(
      `${ctx.fixtureApp.localhostBaseUrl}/docs/beta`,
    );
    try {
      const localhostTabDto = await waitForBrowserTabByUrl(
        ctx.primaryUser.api,
        `localhost:${ctx.fixtureApp.port}/docs/beta`,
      );
      const localhostTabId = Number(localhostTabDto.tab_id);

      let alphaTabId = 0;
      let alphaPriceText = '';
      let blockedLocalhostOut: any = null;

      ctx.mockLlm.registerScenario('t4_08_fabushi', (turnCtx: MockLlmTurnContext) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Opening allowed http://127.0.0.1/docs/alpha tab...',
            toolCalls: [
              {
                id: 'call_t408_open_alpha',
                name: 'browser_open_tab',
                arguments: { url: `${ctx.fixtureApp.baseUrl}/docs/alpha`, active: true },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 1) {
          const openRes = unwrapBrowserExecResult(turnCtx.latestToolResult?.json);
          alphaTabId = Number(openRes?.tab?.tab_id ?? openRes?.tab_id);
          return {
            reasoning:
              'Snapshotting allowed 127.0.0.1 tab AND attempting snapshot on blocked localhost tab...',
            toolCalls: [
              {
                id: 'call_t408_snap_allowed',
                name: 'browser_extract_markdown',
                arguments: { tab_id: alphaTabId },
              },
              {
                id: 'call_t408_snap_blocked',
                name: 'browser_snapshot',
                arguments: { tab_id: localhostTabId },
              },
            ],
          };
        }

        if (turnCtx.turnIndex === 2) {
          for (const tr of turnCtx.latestRoundToolResults) {
            if (tr.toolCallId === 'call_t408_snap_allowed') {
              const okData = unwrapBrowserExecResult(tr.json);
              alphaPriceText = String(okData?.markdown ?? '');
            } else if (tr.toolCallId === 'call_t408_snap_blocked') {
              blockedLocalhostOut = tr.json ?? { raw: tr.rawContent };
            }
          }
          return {
            reasoning: 'Closing allowed 127.0.0.1 Alpha tab...',
            toolCalls: [
              {
                id: 'call_t408_close_alpha',
                name: 'browser_close_tab',
                arguments: { tab_id: alphaTabId },
              },
            ],
          };
        }

        return {
          content: `PortalCopilotBot report: Alpha Cloud (${alphaPriceText.includes('$19/mo') ? '$19/mo' : 'missing'}) allowed; localhost Beta blocked by ACL.`,
        };
      });

      const fabushiTurn = await ctx.primaryUser.api.createHermesTurn(
        {
          prompt:
            '[E2E_SCENARIO:t4_08_fabushi] Inspect 127.0.0.1 Alpha docs and test localhost Beta ACL.',
          bot_id: botId,
          chat_id: companionChatId,
          yolo: true,
          max_iterations: 8,
        },
        60000,
      );

      assert.equal(fabushiTurn.status, 'completed');
      assert.ok(alphaPriceText.includes('$19/mo') && alphaPriceText.includes('Tokyo'));
      assert.ok(blockedLocalhostOut !== null, 'Expected blocked localhost tool result');
      assertBrowserRpcError(blockedLocalhostOut, [
        BROWSER_RPC_ERROR_CODES.POLICY_DISABLED,
        BROWSER_RPC_ERROR_CODES.RESTRICTED_URL,
      ]);
    } finally {
      await localhostBetaTab.close().catch(() => undefined);
    }

    // 5. Final F16 Read-Only Monorepo Hygiene, READMEs & CI Workflow Verification
    const gitHeadPath = path.join(ctx.sutRoot, '.git', 'HEAD');
    assert.ok(fs.existsSync(gitHeadPath), 'Expected .git/HEAD in /home/antigravity/gpui-telegram');

    const trackedFiles = execFileSync('git', ['-C', ctx.sutRoot, 'ls-files'], {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean);
    assert.ok(
      !trackedFiles.some(
        (f) =>
          f.startsWith('target/') ||
          f.includes('node_modules/') ||
          f.startsWith('.e2e-runs/') ||
          f.startsWith('.local-sysroot/'),
      ),
      'Build artifacts and node_modules must never be tracked in git index',
    );

    const porcelain = execFileSync('git', ['-C', ctx.sutRoot, 'status', '--porcelain'], {
      encoding: 'utf-8',
    });
    assert.ok(
      !porcelain.includes('.e2e-runs') && !/\.(db|db-wal|db-shm)\b/.test(porcelain),
      `Zero E2E contamination allowed inside SUT repository, got:\n${porcelain}`,
    );

    const rootReadme = path.join(ctx.sutRoot, 'README.md');
    const extReadme = path.join(ctx.sutRoot, 'browser-extension', 'README.md');
    const ciWorkflow = path.join(ctx.sutRoot, '.github', 'workflows', 'ci.yml');

    assert.ok(fs.existsSync(rootReadme) && fs.statSync(rootReadme).size > 200, 'Expected root README.md');
    assert.ok(
      fs.existsSync(extReadme) && fs.statSync(extReadme).size > 100,
      'Expected browser-extension/README.md',
    );
    assert.ok(fs.existsSync(ciWorkflow), 'Expected .github/workflows/ci.yml');

    const ciYaml = fs.readFileSync(ciWorkflow, 'utf-8');
    assert.ok(
      ciYaml.includes('cargo') &&
        (ciYaml.includes('wasm32-unknown-unknown') || ciYaml.includes('gpui_telegram_ext_wasm')) &&
        ciYaml.includes('browser-extension'),
      'Expected .github/workflows/ci.yml to verify Rust workspace, WASM crate, and browser-extension',
    );

    assert.equal(
      ctx.browser.uncaughtExceptions.length,
      0,
      `Expected zero uncaught Chromium/SW exceptions, got ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
    );
  },
});
