import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  parseCssRgb,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function dragMouseHorizontal(
  page: CdpPageHandle,
  startX: number,
  startY: number,
  endX: number,
): Promise<void> {
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: startX, y: startY, button: 'none' },
    page.sessionId,
  );
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 },
    page.sessionId,
  );
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const curX = Math.round(startX + ((endX - startX) * i) / steps);
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: curX, y: startY, button: 'left', buttons: 1 },
      page.sessionId,
    );
  }
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: endX, y: startY, button: 'left', buttons: 0, clickCount: 1 },
    page.sessionId,
  );
}

async function auditSurfaceForUntranslatedKeys(page: CdpPageHandle): Promise<{
  textSample: string;
  hasCjk: boolean;
  hasAsciiWords: boolean;
  violations: string[];
}> {
  return await page.eval(() => {
    const violations: string[] = [];
    const collectedChunks: string[] = [];

    const checkString = (str: string, source: string) => {
      const s = str.trim();
      if (!s) return;
      collectedChunks.push(s);
      if (/\bi18n\.[a-z0-9_.-]+/i.test(s)) {
        violations.push(`${source}: raw i18n key "${s.slice(0, 80)}"`);
      }
      if (/missing_translation/i.test(s)) {
        violations.push(`${source}: missing_translation "${s.slice(0, 80)}"`);
      }
      if (s.includes('[object Object]')) {
        violations.push(`${source}: [object Object] "${s.slice(0, 80)}"`);
      }
      if (s === 'undefined' || s === 'NaN') {
        violations.push(`${source}: literal "${s}"`);
      }
      if (/\{\{[a-zA-Z0-9_.-]+\}\}/.test(s)) {
        violations.push(`${source}: uninterpolated template "${s.slice(0, 80)}"`);
      }
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      const cs = window.getComputedStyle(parent);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      checkString(node.textContent ?? '', `text<${tag}>`);
    }

    for (const el of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        const v = el.getAttribute(attr);
        if (v) checkString(v, `attr[${attr}]`);
      }
    }

    const joined = collectedChunks.join(' ');
    return {
      textSample: joined.slice(0, 300),
      hasCjk: /[\u4e00-\u9fff]/.test(joined),
      hasAsciiWords: /[A-Za-z]{3,}/.test(joined),
      violations,
    };
  });
}

defineTest({
  id: 'T2-F10-01',
  title: 'sidepanel.html resized to 320x480 minimum compact viewport has zero horizontal overflow and preserves conversation-stage',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface(
      'sidepanel',
      async (page) => {
        await page.setViewport({ width: 320, height: 480 });
        await page.waitForSelector(
          '[data-testid="conversation-stage"], [data-testid="canonical-composer-input"]',
          { state: 'visible', timeoutMs: 10000 },
        );
        await sleep(150);

        const metrics = await page.eval(() => {
          const docEl = document.documentElement;
          const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
          const composer = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement | null;
          const sidebar = document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null;
          const inspector = document.querySelector(
            '[data-testid="context-inspector"]',
          ) as HTMLElement | null;

          const describeBox = (el: HTMLElement | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return {
              width: r.width,
              height: r.height,
              left: r.left,
              right: r.right,
              display: cs.display,
              position: cs.position,
              visibility: cs.visibility,
            };
          };

          return {
            scrollWidth: docEl.scrollWidth,
            clientWidth: docEl.clientWidth,
            innerWidth: window.innerWidth,
            stage: describeBox(stage),
            composer: describeBox(composer),
            sidebar: describeBox(sidebar),
            inspector: describeBox(inspector),
          };
        });

        assert.ok(
          metrics.scrollWidth <= metrics.clientWidth + 2,
          `Expected zero horizontal overflow at 320px (scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth})`,
        );
        assert.ok(metrics.stage !== null, 'Expected [data-testid="conversation-stage"] in sidepanel.html');
        assert.ok(
          metrics.stage.width >= 200,
          `Expected conversation-stage width >= 200px at 320px viewport (not crushed by side panels), got ${metrics.stage.width}px`,
        );
        assert.ok(
          metrics.composer !== null && metrics.composer.width >= 120,
          `Expected interactive canonical-composer-input at 320px, got ${JSON.stringify(metrics.composer)}`,
        );

        // Inspector must be hidden/collapsed or drawer-positioned at 320px
        if (metrics.inspector && metrics.inspector.display !== 'none' && metrics.inspector.width > 0) {
          assert.ok(
            metrics.inspector.position === 'fixed' ||
              metrics.inspector.position === 'absolute' ||
              metrics.inspector.left >= 318 ||
              metrics.inspector.right <= 2,
            `context-inspector must collapse into drawer/overlay at 320px, got ${JSON.stringify(metrics.inspector)}`,
          );
        }
      },
      { viewport: { width: 320, height: 480 } },
    );
  },
});

defineTest({
  id: 'T2-F10-02',
  title: 'Dragging chat-sidebar resizer in workspace.html to 50px and 800px clamps width strictly to [240px, 360px] (or 64px collapsed)',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface(
      'workspace',
      async (page) => {
        const sidebarInitial = await page.waitForTestId('chat-sidebar', {
          state: 'visible',
          timeoutMs: 10000,
        });
        assert.ok(sidebarInitial, 'Expected [data-testid="chat-sidebar"] in workspace.html');

        // Locate resize handle or right edge of chat-sidebar
        const handleCoords = await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement;
          const explicit = document.querySelector(
            '[data-testid="sidebar-resizer"], [data-testid="chat-sidebar-resizer"], .sidebar-resizer, .resize-handle, [role="separator"]',
          ) as HTMLElement | null;
          const sbRect = sb.getBoundingClientRect();
          if (explicit) {
            const hr = explicit.getBoundingClientRect();
            if (hr.width > 0 || hr.height > 0) {
              return {
                x: Math.round(hr.left + hr.width / 2),
                y: Math.round(hr.top + hr.height / 2),
                sidebarLeft: Math.round(sbRect.left),
              };
            }
          }
          return {
            x: Math.round(sbRect.right),
            y: Math.round(sbRect.top + sbRect.height / 2),
            sidebarLeft: Math.round(sbRect.left),
          };
        });

        // 1. Drag below minimum to sidebarLeft + 50px
        await dragMouseHorizontal(
          page,
          handleCoords.x,
          handleCoords.y,
          handleCoords.sidebarLeft + 50,
        );
        await sleep(120);

        const afterMin = await page.querySelector('[data-testid="chat-sidebar"]');
        assert.ok(afterMin, 'chat-sidebar must remain mounted after min drag');
        const minW = Math.round(afterMin.rect.width);
        const isCollapsedIconRail = minW >= 56 && minW <= 72;
        const isClampedAt240 = minW >= 238 && minW <= 362;
        assert.ok(
          isClampedAt240 || isCollapsedIconRail,
          `Dragging sidebar to 50px must clamp to >=240px (or collapse to ~64px icon rail), got ${minW}px`,
        );

        // Re-expand if drag triggered icon collapse before testing max drag
        if (isCollapsedIconRail) {
          await page.pressKey('Ctrl+b');
          await sleep(150);
        }

        const midSidebar = await page.querySelector('[data-testid="chat-sidebar"]');
        assert.ok(midSidebar);
        const midEdgeX = Math.round(midSidebar.rect.x + midSidebar.rect.width);
        const midEdgeY = Math.round(midSidebar.rect.y + midSidebar.rect.height / 2);

        // 2. Drag far above maximum to sidebarLeft + 800px
        await dragMouseHorizontal(
          page,
          midEdgeX,
          midEdgeY,
          handleCoords.sidebarLeft + 800,
        );
        await sleep(120);

        const afterMax = await page.querySelector('[data-testid="chat-sidebar"]');
        assert.ok(afterMax, 'chat-sidebar must remain mounted after max drag');
        const maxW = Math.round(afterMax.rect.width);
        assert.ok(
          maxW >= 238 && maxW <= 362,
          `Dragging sidebar to 800px must clamp strictly to <=360px ([240, 360]), got ${maxW}px`,
        );
      },
      { viewport: { width: 1440, height: 900 } },
    );
  },
});

defineTest({
  id: 'T2-F10-03',
  title: 'Out-of-range appearance prefs (font_size:999, bubble_radius:-50, corrupted_theme) clamp safely and fall back to Night theme',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: 'Appearance boundary clamp test bubble',
    });

    try {
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        const corruptedAppearance = {
          font_size: 999,
          fontSize: 999,
          bubble_radius: -50,
          bubbleRadius: -50,
          corner_radius: -50,
          theme: 'corrupted_theme',
          theme_mode: 'corrupted_theme',
          palette: 'corrupted_theme',
        };
        await c.storage.local.set({
          ...corruptedAppearance,
          appearance: corruptedAppearance,
          ui_settings: corruptedAppearance,
          theme_settings: corruptedAppearance,
        });
      });

      await ctx.withExtensionSurface('workspace', async (page) => {
        try {
          await page.eval(() => {
            try {
              localStorage.setItem('font_size', '999');
              localStorage.setItem('bubble_radius', '-50');
              localStorage.setItem('theme_mode', 'corrupted_theme');
              localStorage.setItem('theme', 'corrupted_theme');
            } catch {
              // Ignore
            }
          });
          await page.reload();

          const stage = await page.waitForTestId('conversation-stage', {
            state: 'visible',
            timeoutMs: 10000,
          });
          assert.ok(stage && stage.rect.height > 100, 'workspace.html must not blank-screen on corrupted theme');

          // Select official bot chat if no message bubble is immediately visible
          const existingBubble = await page.querySelector('[data-testid="message-bubble"]');
          if (!existingBubble) {
            const firstDialog = await page.querySelector(
              '[data-testid="chat-sidebar"] [data-chat-id], [data-testid="chat-sidebar"] [role="listitem"], [data-testid="chat-sidebar"] button',
            );
            if (firstDialog) {
              await page.click(
                '[data-testid="chat-sidebar"] [data-chat-id], [data-testid="chat-sidebar"] [role="listitem"], [data-testid="chat-sidebar"] button',
              );
            }
          }
          await page.waitForTestId('message-bubble', { state: 'visible', timeoutMs: 8000 });

          const computed = await page.eval(() => {
            const bubble = document.querySelector('[data-testid="message-bubble"]') as HTMLElement;
            const stageEl = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement;
            const sendBtnEl = document.querySelector('[data-testid="composer-send-btn"]') as HTMLElement | null;
            const bStyle = window.getComputedStyle(bubble);
            const sStyle = window.getComputedStyle(stageEl);
            const bodyStyle = window.getComputedStyle(document.body);
            const sendStyle = sendBtnEl ? window.getComputedStyle(sendBtnEl) : null;
            return {
              bubbleFontSize: bStyle.fontSize,
              bubbleBorderRadius: bStyle.borderTopLeftRadius || bStyle.borderRadius,
              stageBg: sStyle.backgroundColor,
              bodyBg: bodyStyle.backgroundColor,
              accentControlColor: sendStyle ? sendStyle.backgroundColor || sendStyle.color : '',
            };
          });

          const fontSizePx = Number.parseFloat(computed.bubbleFontSize);
          assert.ok(
            !Number.isNaN(fontSizePx) && fontSizePx >= 12 && fontSizePx <= 20,
            `Expected clamped message-bubble font-size in [12px, 20px] when storage has 999, got ${computed.bubbleFontSize}`,
          );

          const radiusPx = Number.parseFloat(computed.bubbleBorderRadius);
          assert.ok(
            !Number.isNaN(radiusPx) && radiusPx >= 6 && radiusPx <= 18,
            `Expected clamped bubble border-radius in [6px, 18px] when storage has -50, got ${computed.bubbleBorderRadius}`,
          );

          // Verify fallback to dark Night theme (non-white dark background) & valid computed accent RGB
          const bgRgb =
            parseCssRgb(computed.bodyBg) && parseCssRgb(computed.bodyBg)!.a > 0
              ? parseCssRgb(computed.bodyBg)
              : parseCssRgb(computed.stageBg);
          assert.ok(bgRgb !== null, `Expected valid RGB background color, got ${JSON.stringify(computed)}`);
          assert.ok(
            bgRgb.r <= 48 && bgRgb.g <= 52 && bgRgb.b <= 64,
            `Expected fallback to dark Night theme on "corrupted_theme", got bodyBg=${computed.bodyBg}, stageBg=${computed.stageBg}`,
          );
          if (computed.accentControlColor) {
            const accentRgb = parseCssRgb(computed.accentControlColor);
            assert.ok(
              accentRgb !== null,
              `Expected valid RGB on composer-send-btn accent control, got ${computed.accentControlColor}`,
            );
          }
        } finally {
          await page
            .eval(() => {
              try {
                for (const k of ['font_size', 'bubble_radius', 'theme_mode', 'theme']) {
                  localStorage.removeItem(k);
                }
              } catch {
                // Ignore
              }
            })
            .catch(() => undefined);
        }
      });
    } finally {
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        await c.storage.local.remove([
          'font_size',
          'fontSize',
          'bubble_radius',
          'bubbleRadius',
          'corner_radius',
          'theme',
          'theme_mode',
          'palette',
          'appearance',
          'ui_settings',
          'theme_settings',
        ]);
      });
    }
  },
});

defineTest({
  id: 'T2-F10-04',
  title: 'Visible text nodes across workspace.html, sidepanel.html, popup.html, and options.html in zh-CN and en-US have zero untranslated key leaks',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    const workspacePage = await ctx.browser.openExtensionSurface('workspace');
    const sidepanelPage = await ctx.browser.openExtensionSurface('sidepanel');
    const popupPage = await ctx.browser.openExtensionSurface('popup');
    const optionsPage = await ctx.browser.openExtensionSurface('options');

    try {
      await workspacePage.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });
      await sidepanelPage.waitForSelector(
        '[data-testid="conversation-stage"], [data-testid="canonical-composer-input"]',
        { state: 'visible', timeoutMs: 10000 },
      );
      await popupPage.waitForTestId('emergency-stop-btn', { state: 'visible', timeoutMs: 10000 });
      await optionsPage.waitForSelector('body', { state: 'visible', timeoutMs: 10000 });

      const surfaceNames = ['workspace', 'sidepanel', 'popup', 'options'] as const;

      // Audit initial language mode across all 4 MV3 surfaces
      const pass1 = await Promise.all([
        auditSurfaceForUntranslatedKeys(workspacePage),
        auditSurfaceForUntranslatedKeys(sidepanelPage),
        auditSurfaceForUntranslatedKeys(popupPage),
        auditSurfaceForUntranslatedKeys(optionsPage),
      ]);
      for (const [idx, res] of pass1.entries()) {
        const name = surfaceNames[idx];
        assert.equal(
          res.violations.length,
          0,
          `Found untranslated/corrupt text on ${name}.html (mode 1): ${res.violations.join('; ')}`,
        );
        assert.ok(res.textSample.length > 0, `Expected non-empty visible copy on ${name}.html`);
      }

      // Toggle language via canonical [data-testid="lang-toggle-btn"]
      await workspacePage.waitForTestId('lang-toggle-btn', { state: 'visible', timeoutMs: 6000 });
      await workspacePage.clickTestId('lang-toggle-btn');
      await sleep(300);
      await Promise.all([sidepanelPage.reload(), popupPage.reload(), optionsPage.reload()]);
      await sleep(200);

      const pass2 = await Promise.all([
        auditSurfaceForUntranslatedKeys(workspacePage),
        auditSurfaceForUntranslatedKeys(sidepanelPage),
        auditSurfaceForUntranslatedKeys(popupPage),
        auditSurfaceForUntranslatedKeys(optionsPage),
      ]);
      for (const [idx, res] of pass2.entries()) {
        const name = surfaceNames[idx];
        assert.equal(
          res.violations.length,
          0,
          `Found untranslated/corrupt text on ${name}.html (mode 2): ${res.violations.join('; ')}`,
        );
        assert.ok(res.textSample.length > 0, `Expected non-empty visible copy on ${name}.html after toggle`);
      }

      // Restore initial language mode before exiting so later tests observe consistent default locale
      await workspacePage.clickTestId('lang-toggle-btn');
      await sleep(150);

      // Across the two toggled language modes, one must contain CJK characters (zh-CN) and one ASCII English copy (en-US)
      const sawChinese = pass1.some((r) => r.hasCjk) || pass2.some((r) => r.hasCjk);
      const sawEnglish = pass1.some((r) => r.hasAsciiWords) || pass2.some((r) => r.hasAsciiWords);
      assert.equal(sawChinese, true, 'Expected zh-CN Chinese UI copy across language toggle');
      assert.equal(sawEnglish, true, 'Expected en-US English UI copy across language toggle');
      assert.notEqual(
        pass1[0].textSample,
        pass2[0].textSample,
        'Toggling lang-toggle-btn must genuinely switch rendered locale strings on workspace.html',
      );
    } finally {
      await Promise.all([
        workspacePage.close(),
        sidepanelPage.close(),
        popupPage.close(),
        optionsPage.close(),
      ]);
    }
  },
});

defineTest({
  id: 'T2-F10-05',
  title: 'Pressing Enter during active CJK IME composition (isComposing: true) in canonical-composer-input does not prematurely send',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    const imeChat = await ctx.primaryUser.api.createChat({
      title: 'CJK IME Preedit Safety Room',
      chat_type: 'group',
    });
    const chatId = Number(imeChat.chat_id ?? imeChat.id);
    assert.ok(chatId > 0);

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText('CJK IME Preedit Safety Room', {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        // Click the newly created chat row in sidebar
        await page.eval((targetTitle: string) => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sb) return;
          const candidates = Array.from(sb.querySelectorAll('*')) as HTMLElement[];
          const match = candidates.find(
            (el) =>
              el.children.length === 0 && (el.textContent ?? '').includes(targetTitle),
          );
          (match?.closest('[data-chat-id], [role="listitem"], button, li, div') as HTMLElement | null)?.click();
        }, 'CJK IME Preedit Safety Room');

        await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });
        const beforeHist = await ctx.primaryUser.api.getMessages(chatId);
        const baselineCount = beforeHist.messages.length;

        await page.typeTestId('canonical-composer-input', 'nihao', { clearFirst: true });

        // Simulate active CJK IME composition + Enter keydown (both isComposing:true & keyCode:229)
        await page.eval(() => {
          const input = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement;
          input.focus();
          input.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true, cancelable: true, data: 'nihao' }),
          );
          input.dispatchEvent(
            new CompositionEvent('compositionupdate', { bubbles: true, cancelable: true, data: '你好' }),
          );
          const imeEnter1 = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(imeEnter1);

          const imeEnter229 = new KeyboardEvent('keydown', {
            key: 'Process',
            code: 'Enter',
            keyCode: 229,
            which: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(imeEnter229);
        });

        await sleep(450);
        const midHist = await ctx.primaryUser.api.getMessages(chatId);
        assert.equal(
          midHist.messages.length,
          baselineCount,
          'Enter during active CJK IME composition (isComposing: true) must NOT send message prematurely',
        );

        const draftStillPresent = await page.eval(() => {
          const el = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement | null;
          if (!el) return '';
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            return el.value ?? '';
          }
          return el.textContent ?? '';
        });
        assert.ok(
          draftStillPresent.length > 0,
          'Preedit draft inside canonical-composer-input must remain intact during IME Enter',
        );

        // End IME composition and verify normal send now works
        await page.eval(() => {
          const input = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement;
          input.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true, data: '你好' }),
          );
        });
        await page.clickTestId('composer-send-btn');

        await pollUntil(
          async () => {
            const afterHist = await ctx.primaryUser.api.getMessages(chatId);
            return afterHist.messages.length > baselineCount;
          },
          { timeoutMs: 5000, intervalMs: 100, message: 'Post-composition message send' },
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F10-06',
  title: 'Sequential Escape presses close topmost modal/popup first without wiping unsent text in canonical-composer-input',
  tier: 2,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    const sent = await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: 'Anchor message for reply banner + Escape layering check',
    });
    assert.ok(sent.message_id);

    const unsentDraft = 'Important unsent draft — do NOT wipe on Escape 9042';

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 10000 });
      await page.typeTestId('canonical-composer-input', unsentDraft, { clearFirst: true });

      // Trigger menu/modal overlay via create-menu-btn
      await page.clickTestId('create-menu-btn');
      await sleep(150);

      // Click first menu option (e.g. New Group / Create Bot modal) if menu items rendered
      const openedModal = await page.eval(() => {
        const menuItems = Array.from(
          document.querySelectorAll('[role="menuitem"], .create-menu-item, [data-testid*="create-"] button'),
        ) as HTMLElement[];
        const item = menuItems.find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.getAttribute('data-testid') !== 'create-menu-btn';
        });
        if (item) {
          item.click();
          return true;
        }
        return false;
      });

      if (!openedModal) {
        await page.pressKey('Ctrl+/');
      }
      await sleep(200);

      // Verify a modal/popover layer is open before pressing Escape
      const countOpenOverlays = async () =>
        await page.eval(() => {
          const els = Array.from(
            document.querySelectorAll(
              '[role="dialog"], [role="menu"], .modal-backdrop, .modal-overlay, [data-testid*="modal"], [data-testid="slash-command-popup"]',
            ),
          ) as HTMLElement[];
          return els.filter((el) => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          }).length;
        });

      const overlaysBefore = await countOpenOverlays();
      assert.ok(overlaysBefore >= 1, 'Expected at least 1 active modal/menu overlay before Escape');

      // Press Escape #1 -> closes topmost modal/menu
      await page.pressKey('Escape');
      await sleep(200);

      const overlaysAfterFirstEsc = await countOpenOverlays();
      assert.ok(
        overlaysAfterFirstEsc < overlaysBefore,
        `First Escape should close topmost overlay (before=${overlaysBefore}, after=${overlaysAfterFirstEsc})`,
      );

      const readComposerDraft = async () =>
        await page.eval(() => {
          const el = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement | null;
          if (!el) return '';
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            return el.value ?? '';
          }
          return el.textContent ?? '';
        });

      assert.equal(
        (await readComposerDraft()).trim(),
        unsentDraft,
        'First Escape closing modal must NOT wipe unsent text in canonical-composer-input',
      );

      // Press Escape #2 -> any secondary banner/popup closes while composer draft STILL survives
      await page.pressKey('Escape');
      await sleep(150);

      assert.equal(
        (await readComposerDraft()).trim(),
        unsentDraft,
        'Second Escape must STILL preserve unsent text in canonical-composer-input',
      );
    });
  },
});
