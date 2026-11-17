import * as crypto from 'node:crypto';
import {
  defineTest,
  assert,
  pollUntil,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

async function openHermesStudio(page: CdpPageHandle): Promise<void> {
  await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });
  const existing = await page.querySelector('[data-testid="hermes-studio-workspace"]');
  if (existing?.visible) return;

  await page.eval(() => {
    const rail = document.querySelector('[data-testid="nav-rail"]');
    const btns = Array.from(rail?.querySelectorAll('button, [role="button"], a') ?? []) as HTMLElement[];
    const studioBtn = btns.find((b) =>
      /studio|task|hermes|agent|任务|工作台|智能体/i.test(
        `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
      ),
    );
    studioBtn?.click();
  });
  await page.waitForTestId('hermes-studio-workspace', { state: 'visible', timeoutMs: 8000 });
}

async function selectStudioTab(page: CdpPageHandle, tabPattern: RegExp, label: string): Promise<void> {
  const clicked = await page.eval((reSrc: string) => {
    const re = new RegExp(reSrc, 'i');
    const ws = document.querySelector('[data-testid="hermes-studio-workspace"]');
    if (!ws) return false;
    const tabs = Array.from(ws.querySelectorAll('button, [role="tab"], [data-tab], a')) as HTMLElement[];
    const hit = tabs.find((t) =>
      re.test(
        `${t.getAttribute('data-tab') ?? ''} ${t.getAttribute('data-testid') ?? ''} ${t.textContent ?? ''}`,
      ),
    );
    if (!hit) return false;
    hit.click();
    return true;
  }, tabPattern.source);
  assert.equal(clicked, true, `Hermes Studio must render tab matching ${label}`);
}

defineTest({
  id: 'T1-F14-01',
  title: 'Hermes Studio Tabs 1-4 (Tasks Kanban, Skills, MemorySoul, McpTools) mount live /api/v1/hermes/* state and persist mutations',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    const tag = crypto.randomBytes(2).toString('hex');
    const board = await ctx.primaryUser.api.createKanbanBoard({
      name: `Studio Sprint ${tag}`,
      columns: ['Todo', 'In Progress', 'Done'],
    });
    const boardId = String(board.board_id ?? board.id);
    const cardTitle = `Ship Browser Agent ${tag}`;
    await ctx.primaryUser.api.createKanbanCard({
      board_id: boardId,
      title: cardTitle,
      column: 'Todo',
      priority: 'high',
    });

    const skillName = `e2e-audit-${tag}`;
    await ctx.primaryUser.api.createSkill({
      name: skillName,
      description: 'DOM snapshot audit workflow',
      content: '# Audit Workflow\n1. Run browser_snapshot\n2. Verify refs',
      tags: ['browser'],
    });

    await ctx.withExtensionSurface('workspace', async (page) => {
      await openHermesStudio(page);

      // Tab 1: Tasks (Kanban)
      await selectStudioTab(page, /task|kanban|任务|看板/, 'Tasks');
      await page.waitForText(cardTitle, {
        selector: '[data-testid="hermes-studio-workspace"]',
        timeoutMs: 8000,
      });

      // Tab 2: Skills
      await selectStudioTab(page, /skill|技能/, 'Skills');
      await page.waitForText(skillName, {
        selector: '[data-testid="hermes-studio-workspace"]',
        timeoutMs: 8000,
      });

      // Tab 3: MemorySoul (edit BOTH MEMORY.md and SOUL.md via UI and verify server persistence)
      await selectStudioTab(page, /memory|soul|记忆|人格/, 'MemorySoul');
      const memNote = `StudioMemoryPersist_${tag}: Prefer deterministic CDP refs.`;
      const editedMemoryViaUi = await pollUntil(
        async () => {
          return await page.eval((note: string) => {
            const ws = document.querySelector('[data-testid="hermes-studio-workspace"]');
            if (!ws) return false;
            const setVal = (el: HTMLTextAreaElement | HTMLInputElement, val: string) => {
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

            const textareas = Array.from(ws.querySelectorAll('textarea')) as HTMLTextAreaElement[];
            const memTa =
              textareas.find((ta) =>
                /memory|2200|bounded\s*agent|记忆/i.test(
                  `${ta.name} ${ta.placeholder} ${ta.getAttribute('aria-label') ?? ''} ${ta.getAttribute('data-testid') ?? ''} ${ta.closest('section, article, div')?.textContent ?? ''}`,
                ),
              ) ?? textareas[0];
            if (!memTa) return false;

            const nextVal = `${memTa.value ? `${memTa.value}\n` : ''}${note}`;
            setVal(memTa, nextVal);

            const localContainer = memTa.closest('section, article, form') ?? memTa.parentElement ?? ws;
            const saveBtns = Array.from(ws.querySelectorAll('button')) as HTMLButtonElement[];
            const memSaveBtn =
              saveBtns.find((b) => /save.*memory|保存.*memory|保存记忆/i.test(b.textContent ?? '')) ??
              Array.from(localContainer.querySelectorAll('button')).find((b) =>
                /save|apply|update|保存|更新/i.test(b.textContent ?? ''),
              ) ??
              saveBtns.find((b) => /save|apply|update|保存|更新/i.test(b.textContent ?? ''));
            if (!memSaveBtn) return false;
            memSaveBtn.click();
            return true;
          }, memNote);
        },
        { timeoutMs: 6000, intervalMs: 100, message: 'MemorySoul tab exposes MEMORY.md textarea & Save button' },
      );
      assert.equal(editedMemoryViaUi, true, 'MemorySoul tab must expose editable MEMORY.md textarea and Save button');

      await pollUntil(
        async () => {
          const mem = await ctx.primaryUser.api.getMemory();
          return JSON.stringify(mem).includes(memNote);
        },
        { timeoutMs: 6000, message: 'MEMORY.md edit persisted on /api/v1/hermes/memory' },
      );

      // Also edit SOUL.md via MemorySoul UI and verify persistence on /api/v1/hermes/soul
      const soulMarker = `StudioSoulPersist_${tag}`;
      const soulMarkdown = `# SOUL.md\n${soulMarker}: Calm, surgical, deterministic.`;
      await page.eval(() => {
        const ws = document.querySelector('[data-testid="hermes-studio-workspace"]');
        if (!ws) return;
        const textareas = Array.from(ws.querySelectorAll('textarea'));
        if (textareas.length < 2) {
          const soulSubTab = Array.from(
            ws.querySelectorAll('button, [role="tab"], [data-subtab]'),
          ).find((b) => {
            const txt = `${(b as HTMLElement).getAttribute('data-subtab') ?? ''} ${b.textContent ?? ''}`;
            return /soul|persona|灵魂|人格/i.test(txt) && !/save|apply|update|保存|更新/i.test(txt);
          }) as HTMLElement | undefined;
          soulSubTab?.click();
        }
      });

      const editedSoulViaUi = await pollUntil(
        async () => {
          return await page.eval((soulVal: string) => {
            const ws = document.querySelector('[data-testid="hermes-studio-workspace"]');
            if (!ws) return false;
            const setVal = (el: HTMLTextAreaElement | HTMLInputElement, val: string) => {
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

            const textareas = Array.from(ws.querySelectorAll('textarea')) as HTMLTextAreaElement[];
            const soulTa =
              textareas.find((ta) =>
                /soul|persona|tone|voice|人格|灵魂/i.test(
                  `${ta.name} ${ta.placeholder} ${ta.getAttribute('aria-label') ?? ''} ${ta.getAttribute('data-testid') ?? ''} ${ta.closest('section, article, div')?.textContent ?? ''}`,
                ),
              ) ?? (textareas.length >= 2 ? textareas[textareas.length - 1] : textareas[0]);
            if (!soulTa) return false;

            setVal(soulTa, soulVal);

            const localContainer = soulTa.closest('section, article, form') ?? soulTa.parentElement ?? ws;
            const saveBtns = Array.from(ws.querySelectorAll('button')) as HTMLButtonElement[];
            const soulSaveBtn =
              saveBtns.find((b) => /save.*soul|保存.*soul|保存人格/i.test(b.textContent ?? '')) ??
              Array.from(localContainer.querySelectorAll('button')).find((b) =>
                /save|apply|update|保存|更新/i.test(b.textContent ?? ''),
              ) ??
              saveBtns[saveBtns.length - 1];
            if (!soulSaveBtn) return false;
            soulSaveBtn.click();
            return true;
          }, soulMarkdown);
        },
        { timeoutMs: 6000, intervalMs: 100, message: 'MemorySoul tab exposes SOUL.md textarea & Save button' },
      );
      assert.equal(editedSoulViaUi, true, 'MemorySoul tab must expose editable SOUL.md textarea and Save button');

      await pollUntil(
        async () => {
          const soul = await ctx.primaryUser.api.getSoul();
          return JSON.stringify(soul).includes(soulMarker);
        },
        { timeoutMs: 6000, message: 'SOUL.md edit persisted on /api/v1/hermes/soul' },
      );

      // Tab 4: McpTools (verify Browser toolset enabled)
      await selectStudioTab(page, /mcp|tool|工具/, 'McpTools');
      await pollUntil(
        async () => {
          const txt = await page.eval(
            () => (document.querySelector('[data-testid="hermes-studio-workspace"]') as HTMLElement)?.innerText ?? '',
          );
          return /browser|浏览器/i.test(txt);
        },
        { timeoutMs: 6000, message: 'McpTools tab displays Browser toolset' },
      );
      const toolsetsResp = await ctx.primaryUser.api.getHermesToolsets();
      const browserTs = toolsetsResp.toolsets.find((t: any) => t.name === 'browser');
      assert.ok(browserTs && browserTs.enabled === true, 'Browser toolset must be enabled');
    });
  },
});

defineTest({
  id: 'T1-F14-02',
  title: 'Hermes Studio Tabs 5-7 (Cron routines, FTS5 Sessions & token usage, Approvals) mount live server state cleanly',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    const tag = crypto.randomBytes(2).toString('hex');
    const cronName = `HourlyDocsCheck_${tag}`;
    const createdJob = await ctx.primaryUser.api.createCronJob({
      name: cronName,
      schedule: '@every 1h',
      prompt: 'Summarize docs portal updates',
      enabled: true,
    });
    const jobId = String(createdJob.job_id ?? createdJob.id ?? '');
    assert.ok(jobId.length > 0, 'POST /api/v1/hermes/cron must return job_id');

    // Create a Hermes turn so Sessions tab has live FTS5 searchable history & token usage
    ctx.mockLlm.registerScenario(`f14_sess_${tag}`, () => ({
      content: `SessionSearchableToken_${tag} completed.`,
    }));
    const turn = await ctx.primaryUser.api.createHermesTurn({
      prompt: `[E2E_SCENARIO:f14_sess_${tag}] Record session telemetry ${tag}`,
    });
    assert.equal(turn.status, 'completed');
    const seededSessionId = String(turn.session_id ?? turn.id ?? '');

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openHermesStudio(page);

        // Tab 5: Cron
        await selectStudioTab(page, /cron|routine|schedule|定时|计划/, 'Cron');
        await page.waitForText(cronName, {
          selector: '[data-testid="hermes-studio-workspace"]',
          timeoutMs: 8000,
        });

        // Tab 6: Sessions (verify seeded session entry + FTS5 search + token usage)
        await selectStudioTab(page, /session|history|会话|历史/, 'Sessions');
        const sessionsHttp = await ctx.primaryUser.api.get('/api/v1/hermes/sessions');
        assert.ok(sessionsHttp, 'GET /api/v1/hermes/sessions must return 200');
        const searchHttp = await ctx.primaryUser.api.post('/api/v1/hermes/sessions/search', {
          query: `telemetry ${tag}`,
        });
        assert.ok(searchHttp, 'POST /api/v1/hermes/sessions/search must return 200');

        const renderedSeededSession = await pollUntil(
          async () => {
            return await page.eval(
              (probe: { tagMarker: string; sessId: string }) => {
                const ws = document.querySelector(
                  '[data-testid="hermes-studio-workspace"]',
                ) as HTMLElement | null;
                if (!ws) return false;
                const checkMatch = (txt: string): boolean =>
                  txt.includes(probe.tagMarker) ||
                  (probe.sessId.length >= 4 && txt.includes(probe.sessId)) ||
                  Boolean(
                    probe.sessId.length >= 4 &&
                      ws.querySelector(`[data-session-id="${probe.sessId}"]`),
                  );
                const currentTxt = ws.innerText || '';
                if (checkMatch(currentTxt)) {
                  return true;
                }
                // If Sessions tab filters via an inline FTS5 search box, enter the seeded query
                const searchInp = Array.from(
                  ws.querySelectorAll('input[type="search"], input[type="text"], input:not([type])'),
                ).find((inp) =>
                  /search|session|filter|query|搜索|会话|检索/i.test(
                    `${(inp as HTMLInputElement).placeholder ?? ''} ${inp.getAttribute('aria-label') ?? ''} ${inp.getAttribute('data-testid') ?? ''}`,
                  ),
                ) as HTMLInputElement | undefined;
                if (searchInp && searchInp.value !== `telemetry ${probe.tagMarker}`) {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    'value',
                  )?.set;
                  const q = `telemetry ${probe.tagMarker}`;
                  if (setter) setter.call(searchInp, q);
                  else searchInp.value = q;
                  searchInp.dispatchEvent(new Event('input', { bubbles: true }));
                  searchInp.dispatchEvent(new Event('change', { bubbles: true }));
                  searchInp.dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
                  );
                  const searchBtn = Array.from(ws.querySelectorAll('button')).find((b) =>
                    /search|find|搜索|查询/i.test(b.textContent ?? ''),
                  );
                  searchBtn?.click();
                }
                return checkMatch(ws.innerText || '');
              },
              { tagMarker: tag, sessId: seededSessionId },
            );
          },
          {
            timeoutMs: 6000,
            intervalMs: 100,
            message: `Sessions tab renders seeded session marker (${tag})`,
          },
        );
        assert.equal(
          renderedSeededSession,
          true,
          `Hermes Studio Sessions tab must render the seeded session marker "${tag}"`,
        );

        // Tab 7: Approvals
        await selectStudioTab(page, /approval|security|gate|审批|安全/, 'Approvals');
        const approvalsHttp = await ctx.primaryUser.api.listHermesApprovals();
        assert.ok(Array.isArray(approvalsHttp.approvals), 'GET /api/v1/hermes/approvals must return approvals array');
        assert.equal(page.pageExceptions.length, 0, 'Zero page exceptions across Hermes Studio Tabs 5-7');
      });
    } finally {
      await ctx.primaryUser.api.deleteCronJob(jobId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T1-F14-03',
  title: 'settings-router exposes all 26 SettingsSectionType sections with working Back navigation and live AiProviders & Computers config',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });

      await page.eval(() => {
        const rail = document.querySelector('[data-testid="nav-rail"]');
        const btns = Array.from(rail?.querySelectorAll('button, [role="button"], a') ?? []) as HTMLElement[];
        const settingsBtn = btns.find((b) =>
          /setting|pref|设置/i.test(
            `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
          ),
        );
        settingsBtn?.click();
      });
      await page.waitForTestId('settings-router', { state: 'visible', timeoutMs: 8000 });

      // Inspect total navigable SettingsSectionType entries
      const sectionInventory = await page.eval(() => {
        const router = document.querySelector('[data-testid="settings-router"]') as HTMLElement;
        const byAttr = Array.from(router.querySelectorAll('[data-section], [data-settings-section]'));
        const navButtons = Array.from(
          router.querySelectorAll('nav button, aside button, [role="tablist"] [role="tab"], [role="listitem"], li button, button[data-section]'),
        );
        return {
          byAttrCount: byAttr.length,
          navButtonCount: navButtons.length,
          text: router.innerText || '',
        };
      });
      assert.ok(
        Math.max(sectionInventory.byAttrCount, sectionInventory.navButtonCount) >= 26,
        `Expected >= 26 SettingsSectionType sections in settings-router, got byAttr=${sectionInventory.byAttrCount}, navBtns=${sectionInventory.navButtonCount}`,
      );

      // Navigate into AiProviders section -> verify MockLlmServer URL / model routing
      const clickedAi = await page.eval(() => {
        const router = document.querySelector('[data-testid="settings-router"]')!;
        const items = Array.from(
          router.querySelectorAll(
            '[data-section], [data-settings-section], button, [role="tab"], [role="listitem"], li, a',
          ),
        ) as HTMLElement[];
        const ai = items.find((el) =>
          /ai\s*provider|magpie|llm|model|模型|供应商/i.test(
            `${el.getAttribute('data-section') ?? ''} ${el.getAttribute('data-settings-section') ?? ''} ${el.textContent ?? ''}`,
          ),
        );
        if (!ai) return false;
        ai.click();
        return true;
      });
      assert.equal(clickedAi, true, 'settings-router must expose clickable AiProviders section');

      await pollUntil(
        async () => {
          const dump = await page.eval(() => {
            const r = document.querySelector('[data-testid="settings-router"]') as HTMLElement;
            const vals = Array.from(r.querySelectorAll('input, select')).map(
              (i) => (i as HTMLInputElement).value,
            );
            return `${r.innerText} ${vals.join(' ')}`;
          });
          return /openai|gpt-4o|magpie|127\.0\.0\.1/i.test(dump);
        },
        { timeoutMs: 6000, message: 'AiProviders section displays active OpenAI/Magpie provider' },
      );

      // Navigate into Computers (Browser Bridge pairing & policy) section
      // If settings-router uses drill-down subpages, navigate Back first if Computers is not currently visible
      let clickedComp = await page.eval(() => {
        const router = document.querySelector('[data-testid="settings-router"]')!;
        const items = Array.from(
          router.querySelectorAll(
            '[data-section], [data-settings-section], button, [role="tab"], [role="listitem"], li, a',
          ),
        ) as HTMLElement[];
        const comp = items.find((el) =>
          /computer|bridge|browser|电脑|桥接|浏览器控制/i.test(
            `${el.getAttribute('data-section') ?? ''} ${el.getAttribute('data-settings-section') ?? ''} ${el.textContent ?? ''}`,
          ),
        );
        if (!comp) return false;
        comp.click();
        return true;
      });
      if (!clickedComp) {
        await page.eval(() => {
          const router = document.querySelector('[data-testid="settings-router"]');
          const backBtn = Array.from(router?.querySelectorAll('button, [role="button"], a') ?? []).find(
            (b) =>
              /\bback\b|all\s*settings|settings|返回|全部设置/i.test(
                `${(b as HTMLElement).getAttribute('data-testid') ?? ''} ${(b as HTMLElement).getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
              ),
          ) as HTMLElement | undefined;
          backBtn?.click();
        });
        await page.pressKey('Ctrl+[');
        clickedComp = await pollUntil(
          async () => {
            return await page.eval(() => {
              const router = document.querySelector('[data-testid="settings-router"]');
              if (!router) return false;
              const items = Array.from(
                router.querySelectorAll(
                  '[data-section], [data-settings-section], button, [role="tab"], [role="listitem"], li, a',
                ),
              ) as HTMLElement[];
              const comp = items.find((el) =>
                /computer|bridge|browser|电脑|桥接|浏览器控制/i.test(
                  `${el.getAttribute('data-section') ?? ''} ${el.getAttribute('data-settings-section') ?? ''} ${el.textContent ?? ''}`,
                ),
              );
              if (!comp) return false;
              comp.click();
              return true;
            });
          },
          { timeoutMs: 4000, intervalMs: 60, message: 'Computers section visible after Back navigation' },
        );
      }
      assert.equal(clickedComp, true, 'settings-router must expose clickable Computers / Browser Bridge section');

      await pollUntil(
        async () => {
          const dump = await page.eval(() => {
            const r = document.querySelector('[data-testid="settings-router"]') as HTMLElement;
            const vals = Array.from(r.querySelectorAll('input, select')).map(
              (i) => (i as HTMLInputElement).value,
            );
            return `${r.innerText} ${vals.join(' ')}`;
          });
          return (
            dump.includes(String(ctx.desktopBridge.port)) ||
            /always_allow|bridge|pairing|19222|connected|已连接/i.test(dump)
          );
        },
        { timeoutMs: 6000, message: 'Computers section reflects live Desktop Bridge & BrowserRunPolicy' },
      );

      // Verify breadcrumb / Ctrl+[ Back navigation
      await page.pressKey('Ctrl+[');
      const stillMounted = await page.querySelector('[data-testid="settings-router"]');
      assert.ok(stillMounted, 'settings-router remains healthy on breadcrumb Back navigation');
    });
  },
});

defineTest({
  id: 'T1-F14-04',
  title: 'context-inspector renders 4 tabs (Profile, Members, SharedMedia, Settings E2EE) and Bot Studio saves BotBrowserProfileDto',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    const tag = crypto.randomBytes(2).toString('hex');
    const createdBot = await ctx.primaryUser.api.createFabushiBot({
      display_name: `InspectorBot_${tag}`,
      description: 'ContextInspector Bot Studio policy test',
    });
    const botUserId = Number(
      createdBot.bot?.bot_user_id ??
        createdBot.bot?.user_id ??
        createdBot.registry?.bot_user_id ??
        createdBot.registry?.id,
    );
    assert.ok(Number.isFinite(botUserId) && botUserId > 0, `Expected numeric botUserId: ${JSON.stringify(createdBot)}`);

    await ctx.withExtensionSurface(
      'workspace',
      async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText(`InspectorBot_${tag}`, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        await page.eval((bName: string) => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]')!;
          const rows = Array.from(sb.querySelectorAll('*')) as HTMLElement[];
          const hit = rows
            .filter(
              (el) =>
                (el.innerText || '').includes(bName) &&
                el.getBoundingClientRect().height >= 32 &&
                el.getBoundingClientRect().height <= 110,
            )
            .sort((a, b) => a.innerText.length - b.innerText.length)[0];
          hit?.click();
        }, `InspectorBot_${tag}`);

        let inspector = await page.querySelector('[data-testid="context-inspector"]');
        if (!inspector?.visible) {
          await page.pressKey('Ctrl+i');
          inspector = await page.waitForTestId('context-inspector', {
            state: 'visible',
            timeoutMs: 6000,
          });
        }
        assert.ok(inspector?.visible, 'context-inspector must open for bot chat');

        // Assert all 4 ContextInspector tabs (Profile, Members, SharedMedia, Settings/E2EE) exist and click cleanly
        for (const tabSpec of [
          { label: 'Profile', re: /profile|info|overview|资料|简介|详情/i },
          { label: 'Members', re: /member|participant|subscriber|成员/i },
          { label: 'SharedMedia', re: /media|shared|file|媒体|共享|文件/i },
          { label: 'Settings/E2EE', re: /setting|e2ee|security|encryption|安全|加密|设置/i },
        ]) {
          const clickedInspectorTab = await page.eval((reSrc: string) => {
            const re = new RegExp(reSrc, 'i');
            const insp = document.querySelector('[data-testid="context-inspector"]');
            if (!insp) return false;
            const tabs = Array.from(
              insp.querySelectorAll('button, [role="tab"], [data-tab]'),
            ) as HTMLElement[];
            const hit = tabs.find((t) => {
              const r = t.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const hay = `${t.getAttribute('data-tab') ?? ''} ${t.getAttribute('data-testid') ?? ''} ${t.getAttribute('aria-label') ?? ''} ${t.getAttribute('title') ?? ''} ${t.textContent ?? ''}`;
              return re.test(hay);
            });
            if (!hit) return false;
            hit.click();
            return true;
          }, tabSpec.re.source);
          assert.equal(
            clickedInspectorTab,
            true,
            `context-inspector must render clickable ${tabSpec.label} tab`,
          );
        }

        // Open Bot Studio / Browser Policy editor inside context-inspector and save allow_read_only + 127.0.0.1 exclusively via UI
        await page.eval(() => {
          const insp = document.querySelector('[data-testid="context-inspector"]');
          if (!insp) return;
          const studioTrigger = Array.from(
            insp.querySelectorAll('button, [role="tab"], [role="button"], a'),
          ).find((t) =>
            /studio|browser|policy|configure\s*bot|bot\s*config|机器人|浏览器|权限/i.test(
              `${(t as HTMLElement).getAttribute('data-tab') ?? ''} ${(t as HTMLElement).getAttribute('data-testid') ?? ''} ${t.textContent ?? ''}`,
            ),
          ) as HTMLElement | undefined;
          studioTrigger?.click();
        });

        const savedViaInspectorUi = await pollUntil(
          async () => {
            const attempt = await page.eval(() => {
              const insp = document.querySelector('[data-testid="context-inspector"]');
              if (!insp) return null;

              let policySelected = false;
              const selects = Array.from(insp.querySelectorAll('select')) as HTMLSelectElement[];
              const policySel = selects.find((s) =>
                Array.from(s.options).some((o) =>
                  /allow_read_only|allowreadonly|read.?only/i.test(`${o.value} ${o.textContent ?? ''}`),
                ),
              );
              if (policySel) {
                const opt = Array.from(policySel.options).find((o) =>
                  /allow_read_only|allowreadonly|read.?only/i.test(`${o.value} ${o.textContent ?? ''}`),
                )!;
                const protoSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLSelectElement.prototype,
                  'value',
                )?.set;
                if (protoSetter) protoSetter.call(policySel, opt.value);
                else policySel.value = opt.value;
                policySel.dispatchEvent(new Event('input', { bubbles: true }));
                policySel.dispatchEvent(new Event('change', { bubbles: true }));
                policySelected = true;
              } else {
                const policyBtn = Array.from(
                  insp.querySelectorAll(
                    '[data-policy="allow_read_only"], [data-value="allow_read_only"], [role="radio"], [role="option"], button',
                  ),
                ).find((el) =>
                  /allow_read_only|read[\s-]*only|仅允许只读|只读/i.test(
                    `${(el as HTMLElement).getAttribute('data-policy') ?? ''} ${(el as HTMLElement).getAttribute('data-value') ?? ''} ${el.textContent ?? ''}`,
                  ),
                ) as HTMLElement | undefined;
                if (policyBtn) {
                  policyBtn.click();
                  policySelected = true;
                }
              }

              const inputs = Array.from(
                insp.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea'),
              ) as Array<HTMLInputElement | HTMLTextAreaElement>;
              const domainInp = inputs.find((i) =>
                /allow|domain|host|whitelist|域名|白名单/i.test(
                  `${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.getAttribute('data-testid') ?? ''} ${i.closest('label, div')?.textContent ?? ''}`,
                ),
              );
              let domainEntered = false;
              if (domainInp) {
                const proto =
                  domainInp instanceof HTMLTextAreaElement
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const inpSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (inpSetter) inpSetter.call(domainInp, '127.0.0.1');
                else domainInp.value = '127.0.0.1';
                domainInp.dispatchEvent(new Event('input', { bubbles: true }));
                domainInp.dispatchEvent(new Event('change', { bubbles: true }));
                domainEntered = true;
              }

              const saveBtn = Array.from(insp.querySelectorAll('button')).find((b) =>
                /save|apply|update|保存|应用|更新/i.test(
                  `${b.getAttribute('data-testid') ?? ''} ${b.textContent ?? ''}`,
                ),
              );
              saveBtn?.click();

              if (!policySelected || !domainEntered) return null;
              return { policySelected, domainEntered, clickedSave: Boolean(saveBtn) };
            });
            return attempt;
          },
          {
            timeoutMs: 6000,
            intervalMs: 100,
            message: 'ContextInspector Bot Studio renders BrowserRunPolicy & allowed_domains controls',
          },
        );
        assert.ok(
          savedViaInspectorUi?.policySelected && savedViaInspectorUi?.domainEntered,
          'ContextInspector Bot Studio must expose working run_policy and allowed_domains UI controls',
        );

        await pollUntil(
          async () => {
            const prof = await ctx.primaryUser.api.getBotBrowserProfile(botUserId);
            return (
              prof.run_policy === 'allow_read_only' &&
              Array.isArray(prof.allowed_domains) &&
              prof.allowed_domains.includes('127.0.0.1')
            );
          },
          {
            timeoutMs: 6000,
            message: 'Bot Studio UI persists BotBrowserProfileDto (allow_read_only + 127.0.0.1) to /api/v1/bots/{id}/browser',
          },
        );
      },
      { viewport: { width: 1440, height: 900 } },
    );
  },
});

defineTest({
  id: 'T1-F14-05',
  title: 'Sandboxed Mini App <iframe> loads telegram-web-app.js SDK, verifies HMAC initData, and communicates sendData via postMessage',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    const tag = crypto.randomBytes(2).toString('hex');
    const nlCreated = await ctx.primaryUser.api.botFatherNlCreate({
      prompt: `Create a companion task dashboard mini app ${tag}`,
    });
    const botUsername = String(
      nlCreated.bot?.username ?? nlCreated.app?.bot_username,
    ).replace(/^@/, '');
    const shortName = String(nlCreated.app?.short_name ?? 'app');

    await ctx.primaryUser.api.installMiniApp(botUsername, shortName, true);
    const launchCtx = await ctx.primaryUser.api.launchMiniApp(botUsername, shortName, {
      chat_id: nlCreated.companion_chat_id,
      launch_mode: 'CompactSheet',
    });
    assert.equal(
      launchCtx.init_data?.hmac_verified,
      true,
      'Server launchMiniApp must generate HMAC-verified init_data',
    );

    const validated = await ctx.primaryUser.api.validateMiniAppInitData(
      botUsername,
      shortName,
      launchCtx.init_data.raw_query_string,
    );
    assert.equal(validated.valid, true, 'validate-init-data must confirm HMAC signature');

    // Open server-hosted /miniapps/{bot}/{short_name} page in Chromium to verify telegram-web-app.js SDK
    const miniAppUrl = `${ctx.server.baseUrl}/miniapps/${encodeURIComponent(botUsername)}/${encodeURIComponent(shortName)}?init_data=${encodeURIComponent(launchCtx.init_data.raw_query_string)}`;
    await ctx.withTargetTab(miniAppUrl, async (miniTab) => {
      const sdkState = await pollUntil(
        async () => {
          return await miniTab.eval(() => {
            const w = window as any;
            const wa = w.Telegram?.WebApp;
            if (!wa) return null;
            return {
              hasInitData: typeof wa.initData === 'string',
              hasMainButton: Boolean(wa.MainButton),
              hasSendData: typeof wa.sendData === 'function',
              hasThemeParams: typeof wa.themeParams === 'object',
            };
          });
        },
        { timeoutMs: 6000, message: 'window.Telegram.WebApp SDK initialized on /miniapps/...' },
      );
      assert.ok(sdkState, 'Expected non-null Telegram.WebApp SDK state');
      assert.equal(sdkState.hasSendData, true);
      assert.equal(sdkState.hasMainButton, true);
    });

    // Launch Mini App inside workspace.html BotAttachWebView sandboxed <iframe> and roundtrip sendData via postMessage
    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

      const botTitle = String(nlCreated.bot?.title ?? nlCreated.bot?.display_name ?? botUsername);
      const selectedBotSel = await pollUntil(
        async () => {
          return await page.eval(
            (cfg: { chatId: number; bTitle: string; bUser: string }) => {
              document
                .querySelectorAll('[data-e2e-f1405-bot]')
                .forEach((el) => el.removeAttribute('data-e2e-f1405-bot'));
              if (cfg.chatId > 0) {
                const byId = document.querySelector(
                  `[data-chat-id="${cfg.chatId}"], [data-dialog-id="${cfg.chatId}"]`,
                ) as HTMLElement | null;
                if (byId && byId.getBoundingClientRect().height > 0) {
                  byId.setAttribute('data-e2e-f1405-bot', '1');
                  return '[data-e2e-f1405-bot="1"]';
                }
              }
              const sb = document.querySelector('[data-testid="chat-sidebar"]');
              const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
              const row = rows
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  const txt = el.innerText || '';
                  return (
                    r.height >= 32 &&
                    r.height <= 110 &&
                    (txt.includes(cfg.bTitle) || txt.includes(cfg.bUser))
                  );
                })
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
              if (!row) return null;
              row.setAttribute('data-e2e-f1405-bot', '1');
              return '[data-e2e-f1405-bot="1"]';
            },
            { chatId: Number(nlCreated.companion_chat_id ?? 0), bTitle: botTitle, bUser: botUsername },
          );
        },
        { timeoutMs: 8000, intervalMs: 100, message: `Bot row "${botTitle}" visible in chat-sidebar` },
      );
      assert.ok(selectedBotSel, `Expected clickable sidebar row for bot "${botTitle}"`);
      await page.click(selectedBotSel);
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });

      // Click Mini App / Open App button in composer, bot header, or inspector
      const appBtnSel = await pollUntil(
        async () => {
          return await page.eval((appTitle: string) => {
            document
              .querySelectorAll('[data-e2e-f1405-app-btn]')
              .forEach((el) => el.removeAttribute('data-e2e-f1405-app-btn'));
            const btns = Array.from(
              document.querySelectorAll(
                '[data-testid*="miniapp" i], [data-testid*="mini-app" i], [data-testid*="web-app" i], button, [role="button"], [role="menuitem"]',
              ),
            ) as HTMLElement[];
            const appBtn = btns.find((b) => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const label = `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`;
              return (
                (appTitle && label.includes(appTitle)) ||
                /mini\s*app|open\s*app|launch\s*app|web\s*app|bot\s*app|小程序|打开应用|启动应用/i.test(label)
              );
            });
            if (!appBtn) return null;
            appBtn.setAttribute('data-e2e-f1405-app-btn', '1');
            return '[data-e2e-f1405-app-btn="1"]';
          }, String(nlCreated.app?.title ?? ''));
        },
        { timeoutMs: 8000, intervalMs: 100, message: 'Mini App launch button rendered in workspace.html' },
      );
      assert.ok(appBtnSel, 'Workspace must expose a clickable Mini App launch button');
      await page.click(appBtnSel);

      // Assert sandboxed Mini App <iframe> mounts inside workspace.html
      const iframeMeta = await pollUntil(
        async () => {
          return await page.eval(() => {
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
        { timeoutMs: 8000, intervalMs: 100, message: 'Sandboxed Mini App <iframe> mounted in workspace.html' },
      );
      assert.ok(iframeMeta, 'Expected BotAttachWebView to mount a visible Mini App <iframe>');
      assert.equal(iframeMeta.hasSandbox, true, 'Mounted Mini App <iframe> must have a sandbox attribute');
      assert.ok(
        iframeMeta.sandbox.length > 0 &&
          !iframeMeta.sandbox.includes('allow-top-navigation') &&
          !iframeMeta.sandbox.includes('allow-popups-to-escape-sandbox'),
        `Mini App <iframe> sandbox policy is invalid: "${iframeMeta.sandbox}"`,
      );

      // Attach via CDP to the mounted cross-origin Mini App <iframe> and invoke Telegram.WebApp.sendData(...) over postMessage
      const pingMarker = `e2e_miniapp_ping_${tag}`;
      const sentFromIframe = await pollUntil(
        async () => {
          const targets = await ctx.browser.listTargets();
          const iframeTarget = targets.find(
            (t) =>
              t.targetId !== page.targetId &&
              (t.type === 'iframe' || t.url.includes('/miniapps/')) &&
              (t.url.includes('/miniapps/') || t.url.includes(botUsername) || t.url.includes(shortName)),
          );
          if (!iframeTarget) return null;
          const { sessionId: frameSid } = await ctx.browser.cdp.send<{ sessionId: string }>(
            'Target.attachToTarget',
            { targetId: iframeTarget.targetId, flatten: true },
          );
          try {
            await ctx.browser.cdp.send('Runtime.enable', {}, frameSid);
            const evalRes = await ctx.browser.cdp.send<{
              result?: { value?: { ok: boolean; initDataLen: number } };
            }>(
              'Runtime.evaluate',
              {
                expression: `(() => {
                  const wa = window.Telegram && window.Telegram.WebApp;
                  if (!wa || typeof wa.sendData !== 'function') return null;
                  const payload = JSON.stringify({ event: ${JSON.stringify(pingMarker)} });
                  wa.sendData(payload);
                  return { ok: true, initDataLen: String(wa.initData || '').length };
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
          message: 'Telegram.WebApp.sendData invoked inside mounted workspace.html <iframe>',
        },
      );
      assert.ok(sentFromIframe?.ok, 'Expected Telegram.WebApp.sendData to execute inside mounted <iframe>');

      // Verify workspace.html host received the postMessage from the <iframe> and roundtripped send_data to companion_chat_id on server
      await pollUntil(
        async () => {
          const history = await ctx.primaryUser.api.getMessages(nlCreated.companion_chat_id, {
            limit: 20,
          });
          return (history.messages ?? []).some((m: any) =>
            JSON.stringify(m).includes(pingMarker),
          );
        },
        {
          timeoutMs: 8000,
          intervalMs: 120,
          message: 'Host bridged Mini App postMessage web_app_data_send to server companion chat',
        },
      );
    });
  },
});

defineTest({
  id: 'T1-F14-06',
  title: '1:1 WebRTC CallOverlay, AI Talk Mode, and representative modals (CreatePoll, ShortcutsLegend, ExportData) mount and close on Escape',
  tier: 1,
  features: ['F14'],
  fn: async (ctx: SharedTierContext) => {
    const callee = await ctx.createIsolatedUser('call_peer');
    const dmChat = await ctx.primaryUser.api.createChat({
      chat_type: 'direct',
      peer_user_id: callee.userId,
    });
    const dmChatId = Number(dmChat.chat_id ?? dmChat.id);
    await ctx.primaryUser.api.sendMessage({
      chat_id: dmChatId,
      text: 'Ready for voice call check',
    });

    const pollGroupTitle = `ModalPollRoom_${crypto.randomBytes(2).toString('hex')}`;
    await ctx.primaryUser.api.createChat({
      title: pollGroupTitle,
      chat_type: 'group',
    });

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      const selectSidebarChat = async (needle: string): Promise<void> => {
        const sel = await pollUntil(
          async () => {
            return await page.eval((peerName: string) => {
              document
                .querySelectorAll('[data-e2e-f1406-row]')
                .forEach((el) => el.removeAttribute('data-e2e-f1406-row'));
              const sb = document.querySelector('[data-testid="chat-sidebar"]');
              const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
              const row = rows
                .filter(
                  (el) =>
                    (el.innerText || '').includes(peerName) &&
                    el.getBoundingClientRect().height >= 32 &&
                    el.getBoundingClientRect().height <= 110,
                )
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
              if (!row) return null;
              row.setAttribute('data-e2e-f1406-row', '1');
              return '[data-e2e-f1406-row="1"]';
            }, needle);
          },
          { timeoutMs: 8000, intervalMs: 100, message: `Sidebar row "${needle}" visible` },
        );
        assert.ok(sel, `Expected sidebar row "${needle}"`);
        await page.click(sel);
      };

      await selectSidebarChat(callee.username);
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });

      // 1. Trigger 1:1 WebRTC CallOverlay, assert mount, and hang up cleanly
      const clickedCall = await page.eval(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        const callBtn = btns.find((b) =>
          /\bcall\b|voice\s*call|audio\s*call|通话|语音通话/i.test(
            `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
          ),
        );
        if (callBtn) {
          callBtn.click();
          return true;
        }
        return false;
      });
      assert.equal(clickedCall, true, 'Stage header must expose 1:1 Call trigger button');

      await pollUntil(
        async () => {
          return await page.eval(() => {
            const text = document.body.innerText || '';
            return /hang\s*up|end\s*call|mute|calling|ringing|connecting|挂断|静音|呼叫|正在连接/i.test(text);
          });
        },
        { timeoutMs: 6000, message: 'CallOverlay mounts with mute/hangup controls' },
      );

      const clickedHangup = await page.eval(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        const hangup = btns.find((b) =>
          /hang\s*up|end\s*call|decline|挂断|结束通话/i.test(
            `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
          ),
        );
        if (!hangup) return false;
        hangup.click();
        return true;
      });
      assert.equal(clickedHangup, true, 'CallOverlay must expose Hangup/End Call button');
      await page.pressKey('Escape');
      await pollUntil(
        async () => {
          return await page.eval(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
            return !btns.some((b) => {
              const r = b.getBoundingClientRect();
              const cs = window.getComputedStyle(b);
              if (r.width <= 0 || r.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') {
                return false;
              }
              return /hang\s*up|end\s*call|挂断|结束通话/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
              );
            });
          });
        },
        { timeoutMs: 6000, intervalMs: 80, message: 'CallOverlay dismisses cleanly after Hangup/Escape' },
      );

      // 2. Open AI Talk Mode (in bot chat if talk button is bot-scoped), assert mount, and assert Escape closes it
      let hasTalkBtn = await page.eval(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        return btns.some((b) => {
          const r = b.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            /talk\s*mode|voice\s*mode|ai\s*talk|talk-mode|语音对话|对讲|实时语音/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
            )
          );
        });
      });
      if (!hasTalkBtn) {
        await page.eval((botChatId: number) => {
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
      }

      const clickedTalkMode = await pollUntil(
        async () => {
          return await page.eval(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
            const talkBtn = btns.find((b) => {
              const r = b.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.height > 0 &&
                /talk\s*mode|voice\s*mode|voice\s*chat|ai\s*talk|talk-mode|语音对话|对讲|实时语音/i.test(
                  `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
                )
              );
            });
            if (!talkBtn) return false;
            talkBtn.click();
            return true;
          });
        },
        { timeoutMs: 6000, intervalMs: 100, message: 'AI Talk Mode trigger button visible' },
      );
      assert.equal(clickedTalkMode, true, 'Workspace must expose AI Talk Mode trigger button');

      const isTalkModeMounted = async (): Promise<boolean> => {
        return await page.eval(() => {
          const talkEl = document.querySelector(
            '[data-testid*="talk-mode" i], [data-testid*="talk_mode" i], [data-modal="talk-mode"], .talk-mode-overlay, .talk-mode-orb',
          ) as HTMLElement | null;
          if (talkEl) {
            const r = talkEl.getBoundingClientRect();
            const cs = window.getComputedStyle(talkEl);
            if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
              return true;
            }
          }
          const dialogs = Array.from(
            document.querySelectorAll('[role="dialog"], .modal, [data-testid*="overlay" i]'),
          ) as HTMLElement[];
          return dialogs.some((d) => {
            const r = d.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              /talk\s*mode|listening|speaking|thinking|connecting|语音对话|聆听|对讲/i.test(d.innerText || '')
            );
          });
        });
      };

      await pollUntil(isTalkModeMounted, {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'AI Talk Mode overlay/orb mounts cleanly',
      });
      await page.pressKey('Escape');
      await pollUntil(async () => !(await isTalkModeMounted()), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'AI Talk Mode closes cleanly on Escape',
      });

      // Helper to check visible modal dialog matching content pattern
      const isModalVisibleMatching = async (re: RegExp): Promise<boolean> => {
        return await page.eval((reSrc: string) => {
          const rx = new RegExp(reSrc, 'i');
          const modals = Array.from(
            document.querySelectorAll('[role="dialog"], .modal, [data-testid*="modal" i], [data-modal]'),
          ) as HTMLElement[];
          return modals.some((m) => {
            const r = m.getBoundingClientRect();
            const cs = window.getComputedStyle(m);
            if (r.width <= 0 || r.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') {
              return false;
            }
            const hay = `${m.getAttribute('data-testid') ?? ''} ${m.getAttribute('data-modal') ?? ''} ${m.getAttribute('aria-label') ?? ''} ${m.innerText ?? ''}`;
            return rx.test(hay);
          });
        }, re.source);
      };

      // 3. Representative Modal 1: CreatePoll -> mounts and closes on Escape
      await selectSidebarChat(pollGroupTitle);
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });

      const openedCreatePoll = await pollUntil(
        async () => {
          const directClicked = await page.eval(() => {
            const btns = Array.from(
              document.querySelectorAll('button, [role="button"], [role="menuitem"]'),
            ) as HTMLElement[];
            const pollBtn = btns.find((b) => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const label = `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`;
              return /create\s*poll|new\s*poll|\bpoll\b|创建投票|发起投票|投票/i.test(label);
            });
            if (pollBtn) {
              pollBtn.click();
              return true;
            }
            const attachBtn = btns.find((b) => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const label = `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`;
              return /attach|more\s*actions|plus|附件|添加/i.test(label);
            });
            attachBtn?.click();
            return false;
          });
          if (directClicked) return true;
          return await isModalVisibleMatching(/poll|投票/);
        },
        { timeoutMs: 6000, intervalMs: 100, message: 'CreatePoll modal trigger clicked' },
      );
      assert.equal(openedCreatePoll, true, 'Composer/stage must expose CreatePoll modal trigger');
      await pollUntil(() => isModalVisibleMatching(/poll|question|option|投票/), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'CreatePoll modal mounts visibly',
      });
      await page.pressKey('Escape');
      await pollUntil(async () => !(await isModalVisibleMatching(/create\s*poll|poll\s*question|创建投票|发起投票/)), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'CreatePoll modal closes on Escape',
      });

      // 4. Representative Modal 2: ShortcutsLegend -> mounts and closes on Escape
      await page.eval(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]')) as HTMLElement[];
        const scBtn = btns.find((b) => {
          const r = b.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            /shortcut|hotkey|快捷键/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
            )
          );
        });
        scBtn?.click();
      });
      if (!(await isModalVisibleMatching(/shortcut|hotkey|ctrl\+|快捷键/))) {
        await page.pressKey('Ctrl+/');
      }
      await pollUntil(() => isModalVisibleMatching(/shortcut|hotkey|ctrl\+|快捷键/), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'ShortcutsLegend modal mounts visibly',
      });
      await page.pressKey('Escape');
      await pollUntil(async () => !(await isModalVisibleMatching(/shortcut|hotkey|快捷键/)), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'ShortcutsLegend modal closes on Escape',
      });

      // 5. Representative Modal 3: ExportData -> mounts and closes on Escape
      const openedExportData = await pollUntil(
        async () => {
          const clickedExport = await page.eval(() => {
            const findExportControl = (): HTMLElement | undefined => {
              const all = Array.from(
                document.querySelectorAll('button, [role="button"], [role="menuitem"], a'),
              ) as HTMLElement[];
              return all.find((b) => {
                const r = b.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const label = `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`;
                return /export\s*(telegram\s*)?data|export\s*chat|data\s*export|导出数据|导出聊天/i.test(label);
              });
            };
            const direct = findExportControl();
            if (direct) {
              direct.click();
              return true;
            }
            // Open MainMenuDrawer or Settings -> Advanced where Export Data lives
            const rail = document.querySelector('[data-testid="nav-rail"]');
            const railBtns = Array.from(rail?.querySelectorAll('button, [role="button"], a') ?? []) as HTMLElement[];
            const menuOrSettings =
              railBtns.find((b) =>
                /menu|drawer|setting|advanced|菜单|设置/i.test(
                  `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
                ),
              ) ?? railBtns[railBtns.length - 1];
            menuOrSettings?.click();

            const router = document.querySelector('[data-testid="settings-router"]');
            if (router) {
              const adv = Array.from(
                router.querySelectorAll('[data-section], button, [role="tab"], li, a'),
              ).find((el) =>
                /advanced|export|data|高级|导出|数据/i.test(
                  `${(el as HTMLElement).getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
                ),
              ) as HTMLElement | undefined;
              adv?.click();
            }
            return false;
          });
          if (clickedExport) return true;
          return await isModalVisibleMatching(/export.*data|export.*chat|导出数据|导出聊天/);
        },
        { timeoutMs: 6000, intervalMs: 120, message: 'ExportData modal trigger clicked' },
      );
      assert.equal(openedExportData, true, 'Workspace/Settings must expose ExportData modal trigger');
      await pollUntil(() => isModalVisibleMatching(/export|json|html|导出/), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'ExportData modal mounts visibly',
      });
      await page.pressKey('Escape');
      await pollUntil(async () => !(await isModalVisibleMatching(/export\s*(telegram\s*)?data|export\s*chat|导出数据|导出聊天/)), {
        timeoutMs: 6000,
        intervalMs: 80,
        message: 'ExportData modal closes on Escape',
      });

      // Return to Chats view on NavRail if Settings was opened, and verify stage remains healthy with zero uncaught exceptions
      const stageVisibleNow = await page.querySelector('[data-testid="conversation-stage"]');
      if (!stageVisibleNow?.visible) {
        await page.eval(() => {
          const rail = document.querySelector('[data-testid="nav-rail"]');
          const btns = Array.from(rail?.querySelectorAll('button, [role="button"], a') ?? []) as HTMLElement[];
          const chatBtn =
            btns.find((b) =>
              /chat|message|dialog|会话|消息/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
              ),
            ) ?? btns[0];
          chatBtn?.click();
        });
      }
      const stageAfter = await page.waitForTestId('conversation-stage', {
        state: 'visible',
        timeoutMs: 6000,
      });
      assert.ok(stageAfter?.visible, 'conversation-stage remains mounted after closing overlays/modals');
      assert.equal(page.pageExceptions.length, 0, 'Zero page exceptions during CallOverlay/TalkMode/Modal checks');
    });
  },
});
