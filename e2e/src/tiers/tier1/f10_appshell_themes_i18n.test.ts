import {
  defineTest,
  assert,
  pollUntil,
  assertCssColorMatches,
  parseCssRgb,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

async function ensureActiveChatSelected(page: CdpPageHandle): Promise<void> {
  const composer = await page.querySelector('[data-testid="canonical-composer-input"]');
  if (composer?.visible) return;

  const firstDialogPos = await page.eval(() => {
    const sidebar = document.querySelector('[data-testid="chat-sidebar"]');
    if (!sidebar) return null;
    const candidates = Array.from(
      sidebar.querySelectorAll('[data-chat-id], [role="listitem"], [role="option"], li, .chat-row, .dialog-row, button'),
    ) as HTMLElement[];
    const row = candidates.find((el) => {
      const r = el.getBoundingClientRect();
      const testId = el.getAttribute('data-testid') ?? '';
      return (
        r.width > 100 &&
        r.height >= 36 &&
        testId !== 'chat-search-input' &&
        testId !== 'create-menu-btn'
      );
    });
    if (!row) return null;
    row.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });

  if (firstDialogPos) {
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: firstDialogPos.x, y: firstDialogPos.y, button: 'left', clickCount: 1 },
      page.sessionId,
    );
    await page.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: firstDialogPos.x, y: firstDialogPos.y, button: 'left', clickCount: 1 },
      page.sessionId,
    );
  }
}

defineTest({
  id: 'T1-F10-01',
  title: 'workspace.html renders 1:1 4-column desktop AppShell geometry (52px NavRail, 288px resizable Sidebar, Stage, 320px Inspector)',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: 'Desktop AppShell 4-column geometry verification',
    });

    await ctx.withExtensionSurface(
      'workspace',
      async (page) => {
        const navRail = await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });
        const sidebar = await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        const stage = await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 10000 });

        assert.ok(navRail && sidebar && stage, 'Core 3 columns must mount visibly');
        await ensureActiveChatSelected(page);

        // Ensure ContextInspector (column 4) is open
        let inspector = await page.querySelector('[data-testid="context-inspector"]');
        if (!inspector || !inspector.visible) {
          await page.pressKey('Ctrl+i');
          inspector = await page
            .waitForTestId('context-inspector', { state: 'visible', timeoutMs: 3000 })
            .catch(() => null);
          if (!inspector || !inspector.visible) {
            // Try clicking inspector toggle button in stage header
            const headerTogglePt = await page.eval(() => {
              const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
              const target = btns.find((b) =>
                /inspector|profile|info|详情|侧栏/i.test(
                  `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''} ${b.textContent ?? ''}`,
                ),
              );
              if (!target) return null;
              const r = target.getBoundingClientRect();
              return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
            });
            assert.ok(headerTogglePt, 'Expected Ctrl+I or header toggle button to open context-inspector');
            await page.cdp.send(
              'Input.dispatchMouseEvent',
              { type: 'mousePressed', x: headerTogglePt.x, y: headerTogglePt.y, button: 'left', clickCount: 1 },
              page.sessionId,
            );
            await page.cdp.send(
              'Input.dispatchMouseEvent',
              { type: 'mouseReleased', x: headerTogglePt.x, y: headerTogglePt.y, button: 'left', clickCount: 1 },
              page.sessionId,
            );
            inspector = await page.waitForTestId('context-inspector', { state: 'visible', timeoutMs: 5000 });
          }
        }

        const freshNav = (await page.querySelector('[data-testid="nav-rail"]'))!;
        const freshSidebar = (await page.querySelector('[data-testid="chat-sidebar"]'))!;
        const freshStage = (await page.querySelector('[data-testid="conversation-stage"]'))!;
        const freshInspector = (await page.querySelector('[data-testid="context-inspector"]'))!;

        assert.ok(freshInspector?.visible, 'context-inspector must be visible in 1440x900 4-column desktop layout');

        // Column 1: 52px NavRail (±4px)
        assert.ok(
          Math.abs(freshNav.rect.width - 52) <= 4,
          `Expected nav-rail width ~52px (±4px), got ${freshNav.rect.width}px`,
        );
        assert.ok(freshNav.rect.x <= 2, `Expected nav-rail at x=0, got ${freshNav.rect.x}`);

        // Column 2: 288px default ChatSidebar (within 240..360 resizable bounds)
        assert.ok(
          Math.abs(freshSidebar.rect.width - 288) <= 8,
          `Expected default chat-sidebar width ~288px (±8px), got ${freshSidebar.rect.width}px`,
        );

        // Column 4: 320px ContextInspector (±6px)
        assert.ok(
          Math.abs(freshInspector.rect.width - 320) <= 6,
          `Expected context-inspector width ~320px (±6px), got ${freshInspector.rect.width}px`,
        );

        // Column 3: ConversationStage fills remaining center (> 650px on 1440px viewport)
        assert.ok(
          freshStage.rect.width > 650,
          `Expected conversation-stage center width > 650px, got ${freshStage.rect.width}px`,
        );

        // Strict left-to-right column ordering
        assert.ok(
          freshNav.rect.x < freshSidebar.rect.x &&
            freshSidebar.rect.x < freshStage.rect.x &&
            freshStage.rect.x < freshInspector.rect.x,
          `Expected 4-column x-order nav(${freshNav.rect.x}) < sidebar(${freshSidebar.rect.x}) < stage(${freshStage.rect.x}) < inspector(${freshInspector.rect.x})`,
        );

        // Drag-resize ChatSidebar splitter +36px and assert width genuinely increases
        const splitterPt = await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null;
          if (!sb) return null;
          const sbRect = sb.getBoundingClientRect();
          const handles = Array.from(
            document.querySelectorAll(
              '[data-testid*="resize" i], [data-testid*="splitter" i], [role="separator"], .sidebar-resizer, .resize-handle, [class*="resizer" i], [class*="splitter" i]',
            ),
          ) as HTMLElement[];
          const nearEdge = handles.find((h) => {
            const r = h.getBoundingClientRect();
            return r.height > 40 && Math.abs(r.left + r.width / 2 - sbRect.right) <= 12;
          });
          if (nearEdge) {
            const r = nearEdge.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return { x: Math.round(sbRect.x + sbRect.width), y: 450 };
        });
        assert.ok(splitterPt, 'Expected ChatSidebar right-edge splitter coordinates');

        const resizeEdgeX = splitterPt.x;
        const resizeEdgeY = splitterPt.y;
        await page.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: resizeEdgeX, y: resizeEdgeY, button: 'none', buttons: 0 },
          page.sessionId,
        );
        await page.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x: resizeEdgeX, y: resizeEdgeY, button: 'left', buttons: 1, clickCount: 1 },
          page.sessionId,
        );
        await page.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: resizeEdgeX + 18, y: resizeEdgeY, button: 'left', buttons: 1 },
          page.sessionId,
        );
        await page.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: resizeEdgeX + 36, y: resizeEdgeY, button: 'left', buttons: 1 },
          page.sessionId,
        );
        await page.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: resizeEdgeX + 36, y: resizeEdgeY, button: 'left', buttons: 0, clickCount: 1 },
          page.sessionId,
        );

        const afterDragSidebar = (await page.querySelector('[data-testid="chat-sidebar"]'))!;
        assert.ok(
          afterDragSidebar.rect.width > freshSidebar.rect.width + 10,
          `Dragging ChatSidebar splitter +36px must increase width by >10px (before=${freshSidebar.rect.width}px, after=${afterDragSidebar.rect.width}px)`,
        );
        assert.ok(
          afterDragSidebar.rect.width >= 240 && afterDragSidebar.rect.width <= 362,
          `ChatSidebar width after resize must stay within [240..360] bounds, got ${afterDragSidebar.rect.width}px`,
        );
      },
      { viewport: { width: 1440, height: 900 } },
    );
  },
});

defineTest({
  id: 'T1-F10-02',
  title: 'sidepanel.html renders responsive <680px companion layout without horizontal overflow and keeps composer & bridge bar interactive',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/docs/alpha`, async () => {
      await ctx.withExtensionSurface(
        'sidepanel',
        async (sidepanel) => {
          const pill = await sidepanel.waitForTestId('browser-bridge-status-pill', {
            state: 'visible',
            timeoutMs: 10000,
          });
          assert.ok(pill && pill.visible, 'sidepanel.html must render visible browser-bridge-status-pill');

          await ensureActiveChatSelected(sidepanel);

          const composer = await sidepanel.waitForTestId('canonical-composer-input', {
            state: 'visible',
            timeoutMs: 8000,
          });
          const sendBtn = await sidepanel.waitForTestId('composer-send-btn', {
            state: 'visible',
            timeoutMs: 8000,
          });
          assert.ok(composer?.visible && sendBtn?.visible, 'Composer input & send button must be visible in 420x820 sidepanel');

          const layoutCheck = await sidepanel.eval(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            inspectorVisible: (() => {
              const insp = document.querySelector('[data-testid="context-inspector"]') as HTMLElement | null;
              if (!insp) return false;
              const r = insp.getBoundingClientRect();
              const cs = window.getComputedStyle(insp);
              return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0;
            })(),
          }));

          assert.ok(
            layoutCheck.scrollWidth <= 425,
            `sidepanel.html at 420px must not overflow horizontally (scrollWidth=${layoutCheck.scrollWidth})`,
          );
          assert.equal(
            layoutCheck.inspectorVisible,
            false,
            '320px desktop context-inspector column must auto-collapse on narrow 420px sidepanel',
          );
          assert.ok(
            sendBtn.rect.x >= 0 && sendBtn.rect.x + sendBtn.rect.width <= 425,
            `Send button must fit inside 420px viewport, got rect=${JSON.stringify(sendBtn.rect)}`,
          );

          await sidepanel.typeTestId('canonical-composer-input', 'Sidepanel interactive input ok');
          const typed = await sidepanel.eval(() => {
            const el = document.querySelector('[data-testid="canonical-composer-input"]') as
              | HTMLTextAreaElement
              | HTMLInputElement
              | HTMLElement
              | null;
            if (!el) return '';
            return 'value' in el ? String(el.value ?? '') : el.textContent ?? '';
          });
          assert.ok(
            typed.includes('Sidepanel interactive input ok'),
            `Expected typed text in sidepanel composer, got ${JSON.stringify(typed)}`,
          );
        },
        { viewport: { width: 420, height: 820 } },
      );
    });
  },
});

defineTest({
  id: 'T1-F10-03',
  title: 'popup.html (380x560) and options.html (1024x768) render full control surfaces synced with chrome.storage.local',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withTargetTab(`${ctx.fixtureApp.baseUrl}/shop`, async () => {
      // 1. Verify popup.html
      await ctx.withExtensionSurface(
        'popup',
        async (popup) => {
          const statusPill = await popup.waitForTestId('browser-bridge-status-pill', {
            state: 'visible',
            timeoutMs: 8000,
          });
          const policySelect = await popup.waitForTestId('browser-policy-select', {
            state: 'visible',
            timeoutMs: 8000,
          });
          const stopBtn = await popup.waitForTestId('emergency-stop-btn', {
            state: 'visible',
            timeoutMs: 8000,
          });

          assert.ok(statusPill?.visible && policySelect?.visible && stopBtn?.visible);

          const popupMeta = await popup.eval(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            text: document.body.innerText || '',
            optionValues: Array.from(
              (document.querySelector('[data-testid="browser-policy-select"]') as HTMLSelectElement | null)
                ?.options ?? [],
            ).map((o) => o.value),
          }));

          assert.ok(
            popupMeta.scrollWidth <= 385,
            `popup.html (380x560) must not overflow horizontally (got ${popupMeta.scrollWidth})`,
          );
          for (const requiredPolicy of [
            'always_allow_authorized',
            'allow_read_only',
            'ask_every_time',
            'disabled',
          ]) {
            assert.ok(
              popupMeta.optionValues.includes(requiredPolicy),
              `popup browser-policy-select must expose "${requiredPolicy}" (got ${JSON.stringify(popupMeta.optionValues)})`,
            );
          }
          assert.ok(
            /summarize|tab|bridge|chat|unread|总结|标签页|桥接/i.test(popupMeta.text),
            'popup.html must display active-tab action / bridge pairing / unread switcher content',
          );
        },
        { viewport: { width: 380, height: 560 } },
      );

      // 2. Verify options.html
      await ctx.withExtensionSurface(
        'options',
        async (optionsPage) => {
          await pollUntil(
            async () => {
              const dump = await optionsPage.eval(() => {
                const inputs = Array.from(
                  document.querySelectorAll('input, select, textarea'),
                ) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
                return {
                  bodyText: document.body.innerText || '',
                  inputValues: inputs.map((i) => i.value),
                  inputCount: inputs.length,
                };
              });
              return (
                dump.inputCount >= 2 &&
                (dump.inputValues.some((v) => v.includes(String(ctx.server.port))) ||
                  dump.bodyText.includes(String(ctx.server.port)) ||
                  dump.inputValues.some((v) => v.includes(String(ctx.desktopBridge.port))) ||
                  dump.bodyText.includes(String(ctx.desktopBridge.port)))
              );
            },
            {
              timeoutMs: 8000,
              intervalMs: 100,
              message: 'options.html hydrates server/bridge/LLM settings from chrome.storage.local',
            },
          );

          // Change policy in options.html if browser-policy-select or policy select exists, verify storage sync
          const hasPolicySelect = await optionsPage.querySelector('[data-testid="browser-policy-select"]');
          if (hasPolicySelect) {
            await optionsPage.selectOption('[data-testid="browser-policy-select"]', 'allow_read_only');
          } else {
            await optionsPage.eval(() => {
              const sel = Array.from(document.querySelectorAll('select')).find((s) =>
                Array.from(s.options).some((o) => o.value === 'allow_read_only'),
              );
              if (!sel) throw new Error('options.html missing BrowserRunPolicy <select>');
              sel.value = 'allow_read_only';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              const saveBtn = Array.from(document.querySelectorAll('button')).find((b) =>
                /save|apply|保存|应用/i.test(b.textContent ?? ''),
              );
              saveBtn?.click();
            });
          }

          await pollUntil(
            async () => {
              const stored = await ctx.browser.evalInServiceWorker(async () => {
                const c = (globalThis as any).chrome;
                return await c.storage.local.get(['run_policy', 'browser_run_policy', 'bridge_config']);
              });
              return (
                stored.run_policy === 'allow_read_only' ||
                stored.browser_run_policy === 'allow_read_only' ||
                stored.bridge_config?.run_policy === 'allow_read_only'
              );
            },
            { timeoutMs: 5000, message: 'options.html persists updated run_policy into chrome.storage.local' },
          );
        },
        { viewport: { width: 1024, height: 768 } },
      );
    });
  },
});

defineTest({
  id: 'T1-F10-04',
  title: 'Cycling all 4 .tdesktop-theme presets (Night, Tinted, Day, Classic) applies distinct canonical RGB palettes',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('theme-toggle-btn', { state: 'visible', timeoutMs: 10000 });
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 10000 });

      const samplePalette = async () => {
        return await page.eval(() => {
          const root =
            (document.querySelector('.tdesktop-theme') as HTMLElement | null) ??
            document.documentElement;
          const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
          const sidebar = document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null;

          const rootCs = window.getComputedStyle(root);
          const bodyCs = window.getComputedStyle(document.body);
          const stageCs = stage ? window.getComputedStyle(stage) : bodyCs;
          const sidebarCs = sidebar ? window.getComputedStyle(sidebar) : bodyCs;

          const themeAttr = (
            root.getAttribute('data-theme') ||
            document.documentElement.getAttribute('data-theme') ||
            document.body.getAttribute('data-theme') ||
            root.className ||
            ''
          ).toLowerCase();

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
            themeAttr,
            appBg: pickOpaqueBg(rootCs, sidebarCs, bodyCs),
            stageBg: pickOpaqueBg(stageCs, rootCs, bodyCs),
            textColor: pickOpaqueBg(
              { backgroundColor: rootCs.color } as any,
              { backgroundColor: bodyCs.color } as any,
            ),
          };
        });
      };

      const snapshots: Array<{
        step: number;
        themeAttr: string;
        appBg: string;
        stageBg: string;
      }> = [];

      // Sample initial theme + 4 clicks of theme-toggle-btn to guarantee visiting all 4 presets
      for (let i = 0; i < 4; i++) {
        const cur = await samplePalette();
        snapshots.push({ step: i, ...cur });
        await page.clickTestId('theme-toggle-btn');
        // Wait briefly for CSS transition / theme state commit
        await pollUntil(
          async () => {
            const next = await samplePalette();
            return (
              next.themeAttr !== cur.themeAttr ||
              next.appBg !== cur.appBg ||
              next.stageBg !== cur.stageBg
            );
          },
          { timeoutMs: 3000, intervalMs: 50, message: `Theme toggle step ${i + 1} updates computed CSS` },
        );
      }

      const uniqueSignatures = new Set(snapshots.map((s) => `${s.appBg}|${s.stageBg}`));
      assert.equal(
        uniqueSignatures.size,
        4,
        `Expected 4 distinct computed RGB theme palettes across Night/Tinted/Day/Classic, got: ${JSON.stringify(snapshots)}`,
      );

      // Verify Night (#0B0B0B), Tinted (#101215), Day (#FCFCFC), and Classic (#D5E8C8 stage / light bg) characteristics
      const parsedPalettes = snapshots.map((s) => ({
        ...s,
        appRgb: parseCssRgb(s.appBg),
        stageRgb: parseCssRgb(s.stageBg),
      }));
      for (const p of parsedPalettes) {
        assert.ok(p.appRgb && p.stageRgb, `Invalid CSS RGB in theme snapshot: ${JSON.stringify(p)}`);
      }

      const nightCandidate = parsedPalettes.find(
        (p) => p.themeAttr.includes('night') || (p.appRgb!.r <= 20 && p.appRgb!.g <= 20 && p.appRgb!.b <= 20),
      );
      assert.ok(nightCandidate, `Missing Night dark palette in ${JSON.stringify(snapshots)}`);
      assertCssColorMatches(nightCandidate.appBg, '#0B0B0B', 16);

      const tintedCandidate = parsedPalettes.find(
        (p) =>
          p !== nightCandidate &&
          (p.themeAttr.includes('tinted') ||
            (p.appRgb!.r <= 36 && p.appRgb!.b >= p.appRgb!.r && p.appRgb!.b <= 50)),
      );
      assert.ok(tintedCandidate, `Missing Tinted dark-slate palette in ${JSON.stringify(snapshots)}`);
      assertCssColorMatches(tintedCandidate.appBg, '#101215', 22);

      const dayCandidate = parsedPalettes.find(
        (p) =>
          p.themeAttr.includes('day') ||
          (p.appRgb!.r >= 235 &&
            p.appRgb!.g >= 235 &&
            p.appRgb!.b >= 235 &&
            Math.abs(p.stageRgb!.g - p.stageRgb!.b) <= 12),
      );
      assert.ok(dayCandidate, `Missing Day crisp-light palette in ${JSON.stringify(snapshots)}`);
      assertCssColorMatches(dayCandidate.appBg, '#FCFCFC', 20);

      const classicCandidate = parsedPalettes.find(
        (p) =>
          p !== dayCandidate &&
          (p.themeAttr.includes('classic') || p.stageRgb!.g > p.stageRgb!.b + 10),
      );
      assert.ok(classicCandidate, `Missing Classic green-stage palette in ${JSON.stringify(snapshots)}`);
      assertCssColorMatches(classicCandidate.stageBg, '#D5E8C8', 30);
    });
  },
});

defineTest({
  id: 'T1-F10-05',
  title: 'Customizing accent swatch, font size (18px), and bubble corner radius (17px) updates computed CSS and persists across reload',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    const markerText = `TypographyProbe_${Date.now()}`;
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: markerText,
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });

        // Select official bot chat and confirm message bubble renders
        await page.eval((txt: string) => {
          const sidebar = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sidebar) return;
          const rows = Array.from(sidebar.querySelectorAll('*')) as HTMLElement[];
          const botRow = rows.find(
            (el) =>
              el.children.length > 0 &&
              /official|hermes|bot|777000/i.test(el.textContent ?? '') &&
              el.getBoundingClientRect().height >= 36 &&
              el.getBoundingClientRect().height <= 100,
          );
          botRow?.click();
          void txt;
        }, markerText);

        await page.waitForTestId('message-bubble', { state: 'visible', timeoutMs: 8000 });

        // Open Settings -> Appearance / Chat settings
        const openedSettings = await page.eval(() => {
          const rail = document.querySelector('[data-testid="nav-rail"]');
          if (!rail) return false;
          const btns = Array.from(rail.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
          const settingsBtn = btns.find((b) =>
            /setting|appearance|pref|设置|外观/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
            ),
          );
          if (settingsBtn) {
            settingsBtn.click();
            return true;
          }
          return false;
        });
        if (!openedSettings) {
          await page.pressKey('Ctrl+,');
        }
        await page.waitForTestId('settings-router', { state: 'visible', timeoutMs: 8000 });

        // Navigate to Appearance / Chat section inside settings-router
        await page.eval(() => {
          const router = document.querySelector('[data-testid="settings-router"]')!;
          const navItems = Array.from(
            router.querySelectorAll('button, [role="tab"], [role="button"], li, a'),
          ) as HTMLElement[];
          const chatAppearance = navItems.find((el) =>
            /chat|appearance|theme|聊天|外观|主题/i.test(
              `${el.getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
            ),
          );
          chatAppearance?.click();
        });

        // Adjust font size -> 18, bubble corner radius -> 17, and click a distinct accent swatch
        const appliedControls = await page.eval(() => {
          const router = document.querySelector('[data-testid="settings-router"]')!;
          const setRangeOrNumber = (el: HTMLInputElement, val: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value',
            )?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          const inputs = Array.from(
            router.querySelectorAll('input[type="range"], input[type="number"]'),
          ) as HTMLInputElement[];

          let fontUpdated = false;
          let radiusUpdated = false;

          for (const inp of inputs) {
            const min = Number(inp.min || '0');
            const max = Number(inp.max || '100');
            const labelCtx = `${inp.name} ${inp.id} ${inp.getAttribute('aria-label') ?? ''} ${inp.closest('label, div')?.textContent ?? ''}`;
            if (!fontUpdated && (/font|字号|字体/i.test(labelCtx) || (min >= 10 && max <= 24))) {
              setRangeOrNumber(inp, '18');
              fontUpdated = true;
              continue;
            }
            if (!radiusUpdated && (/radius|corner|圆角|气泡/i.test(labelCtx) || (min >= 0 && max <= 24))) {
              setRangeOrNumber(inp, '17');
              radiusUpdated = true;
            }
          }

          // Click an accent swatch button or color picker
          const explicitSwatches = Array.from(
            router.querySelectorAll(
              '[data-accent], [data-color], [data-testid*="accent" i], .accent-swatch, [class*="swatch" i], button[aria-label*="accent" i], button[title*="accent" i], input[type="color"]',
            ),
          ) as HTMLElement[];
          const fallbackSwatches =
            explicitSwatches.length > 0
              ? []
              : (Array.from(router.querySelectorAll('button[style*="background"]')) as HTMLElement[]).filter(
                  (el) => {
                    const r = el.getBoundingClientRect();
                    return (
                      r.width >= 14 &&
                      r.width <= 56 &&
                      r.height >= 14 &&
                      r.height <= 56 &&
                      (el.textContent ?? '').trim().length <= 2
                    );
                  },
                );
          const swatches = explicitSwatches.length > 0 ? explicitSwatches : fallbackSwatches;
          let accentClicked = false;
          if (swatches.length > 0) {
            const target = swatches[swatches.length - 1];
            if ((target as HTMLInputElement).type === 'color') {
              setRangeOrNumber(target as HTMLInputElement, '#e11d48');
            } else {
              target.click();
            }
            accentClicked = true;
          }

          return { fontUpdated, radiusUpdated, accentClicked };
        });

        assert.equal(appliedControls.fontUpdated, true, 'Settings Chat/Appearance must expose font size control');
        assert.equal(appliedControls.radiusUpdated, true, 'Settings Chat/Appearance must expose bubble corner radius control');
        assert.equal(appliedControls.accentClicked, true, 'Settings Chat/Appearance must expose accent color swatch/picker');

        // Return to Chats view on NavRail to measure .message-bubble computed styles
        await page.eval(() => {
          const rail = document.querySelector('[data-testid="nav-rail"]');
          if (!rail) return;
          const btns = Array.from(rail.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
          const chatBtn =
            btns.find((b) =>
              /chat|message|dialog|会话|消息/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
              ),
            ) ?? btns[0];
          chatBtn?.click();
        });

        await page.waitForTestId('message-bubble', { state: 'visible', timeoutMs: 8000 });

        const readBubbleMetrics = async () => {
          return await page.eval(() => {
            const bubble = document.querySelector('[data-testid="message-bubble"]') as HTMLElement | null;
            if (!bubble) return null;
            const cs = window.getComputedStyle(bubble);
            const rootCs = window.getComputedStyle(document.documentElement);
            return {
              fontSize: cs.fontSize,
              borderRadius: cs.borderTopLeftRadius || cs.borderRadius,
              cssVarFont:
                rootCs.getPropertyValue('--msg-font-size').trim() ||
                rootCs.getPropertyValue('--font-size').trim(),
              cssVarRadius:
                rootCs.getPropertyValue('--bubble-radius').trim() ||
                rootCs.getPropertyValue('--msg-radius').trim(),
            };
          });
        };

        await pollUntil(
          async () => {
            const m = await readBubbleMetrics();
            return Boolean(
              m &&
                (m.fontSize === '18px' || m.cssVarFont === '18px') &&
                (m.borderRadius === '17px' || m.cssVarRadius === '17px'),
            );
          },
          { timeoutMs: 5000, message: 'Message bubble reflects 18px font size and 17px border radius' },
        );

        // Reload workspace.html and confirm persistence
        await page.reload();
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await ensureActiveChatSelected(page);
        await page.waitForTestId('message-bubble', { state: 'visible', timeoutMs: 8000 });

        const persisted = await readBubbleMetrics();
        assert.ok(persisted, 'message-bubble must render after reload');
        assert.ok(
          persisted.fontSize === '18px' || persisted.cssVarFont === '18px',
          `Expected persisted 18px fontSize after reload, got ${JSON.stringify(persisted)}`,
        );
        assert.ok(
          persisted.borderRadius === '17px' || persisted.cssVarRadius === '17px',
          `Expected persisted 17px borderRadius after reload, got ${JSON.stringify(persisted)}`,
        );
      });
    } finally {
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        if (c?.storage?.local) {
          await c.storage.local.remove(['font_size', 'fontSize', 'bubble_radius', 'bubbleRadius', 'appearance']);
        }
      });
    }
  },
});

defineTest({
  id: 'T1-F10-06',
  title: 'Bilingual i18n toggle (zh-CN <-> en-US) and keyboard shortcuts (Ctrl+K search, Ctrl+I inspector, Ctrl+B sidebar)',
  tier: 1,
  features: ['F10'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface(
      'workspace',
      async (page) => {
        await page.waitForTestId('lang-toggle-btn', { state: 'visible', timeoutMs: 10000 });
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await ensureActiveChatSelected(page);

        const detectLangState = async () => {
          return await page.eval(() => {
            const text = document.body.innerText || '';
            const placeholders = Array.from(document.querySelectorAll('input, textarea'))
              .map((el) => (el as HTMLInputElement).placeholder || '')
              .join(' ');
            const titles = Array.from(document.querySelectorAll('[title], [aria-label]'))
              .map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`)
              .join(' ');
            const combined = `${text} ${placeholders} ${titles}`;
            return {
              hasChinese: /搜索|设置|发送|归档|新建|会话|工作台/.test(combined),
              hasEnglish: /\b(Search|Settings|Send|Archived|Folders|Workspace|Studio)\b/i.test(combined),
              htmlLang: document.documentElement.lang,
              sample: combined.slice(0, 300),
            };
          });
        };

        const langBefore = await detectLangState();
        await page.clickTestId('lang-toggle-btn');

        const langAfterFirst = await pollUntil(
          async () => {
            const st = await detectLangState();
            const changed =
              st.htmlLang !== langBefore.htmlLang ||
              st.hasChinese !== langBefore.hasChinese ||
              st.sample !== langBefore.sample;
            return changed ? st : null;
          },
          { timeoutMs: 4000, intervalMs: 60, message: 'First lang-toggle-btn click updates UI locale' },
        );
        assert.ok(langAfterFirst, 'First language toggle must produce updated locale state');

        await page.clickTestId('lang-toggle-btn');
        const langAfterSecond = await pollUntil(
          async () => {
            const st = await detectLangState();
            return st.sample !== langAfterFirst.sample ? st : null;
          },
          { timeoutMs: 4000, intervalMs: 60, message: 'Second lang-toggle-btn click toggles back UI locale' },
        );
        assert.ok(langAfterSecond, 'Second language toggle must produce restored locale state');

        assert.ok(
          (langAfterFirst.hasChinese && langAfterSecond.hasEnglish) ||
            (langAfterSecond.hasChinese && langAfterFirst.hasEnglish),
          `Expected deterministic zh-CN <-> en-US copy switch across toggles, got first=${JSON.stringify(langAfterFirst)}, second=${JSON.stringify(langAfterSecond)}`,
        );

        // Shortcut 1: Ctrl+K focuses [data-testid="chat-search-input"]
        await page.click('[data-testid="conversation-stage"]');
        await page.pressKey('Ctrl+k');
        await pollUntil(
          async () => {
            return await page.eval(() => {
              const active = document.activeElement as HTMLElement | null;
              if (!active) return false;
              return (
                active.getAttribute('data-testid') === 'chat-search-input' ||
                Boolean(active.closest('[data-testid="chat-search-input"]'))
              );
            });
          },
          { timeoutMs: 3000, message: 'Ctrl+K focuses chat-search-input' },
        );
        await page.pressKey('Escape');

        // Shortcut 2: Ctrl+I toggles [data-testid="context-inspector"]
        const inspectorBefore = Boolean((await page.querySelector('[data-testid="context-inspector"]'))?.visible);
        await page.pressKey('Ctrl+i');
        await pollUntil(
          async () =>
            Boolean((await page.querySelector('[data-testid="context-inspector"]'))?.visible) !==
            inspectorBefore,
          { timeoutMs: 3000, message: 'Ctrl+I toggles context-inspector visibility' },
        );
        await page.pressKey('Ctrl+i');
        await pollUntil(
          async () =>
            Boolean((await page.querySelector('[data-testid="context-inspector"]'))?.visible) ===
            inspectorBefore,
          { timeoutMs: 3000, message: 'Second Ctrl+I restores context-inspector visibility' },
        );

        // Shortcut 3: Ctrl+B collapses and restores [data-testid="chat-sidebar"]
        const sidebarInitial = (await page.querySelector('[data-testid="chat-sidebar"]'))!;
        assert.ok(sidebarInitial.rect.width >= 240, `Expected expanded sidebar >=240px, got ${sidebarInitial.rect.width}`);

        await page.pressKey('Ctrl+b');
        await pollUntil(
          async () => {
            const sb = await page.querySelector('[data-testid="chat-sidebar"]');
            return !sb || !sb.visible || sb.rect.width <= 84;
          },
          { timeoutMs: 3000, message: 'Ctrl+B collapses chat-sidebar to <=84px or hidden' },
        );

        await page.pressKey('Ctrl+b');
        await pollUntil(
          async () => {
            const sb = await page.querySelector('[data-testid="chat-sidebar"]');
            return Boolean(sb && sb.visible && sb.rect.width >= 240);
          },
          { timeoutMs: 3000, message: 'Second Ctrl+B expands chat-sidebar back to >=240px' },
        );
      },
      { viewport: { width: 1440, height: 900 } },
    );
  },
});
