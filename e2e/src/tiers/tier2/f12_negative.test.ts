import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  type SharedTierContext,
} from '../../harness/index.ts';

defineTest({
  id: 'T2-F12-01',
  title: 'Searching chat-search-input for "__no_match_zz99__" and SQL/RegExp chars "%\' OR 1=1 -- [(*" renders empty state with zero 500 or RegExp crash',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await page.waitForTestId('chat-search-input', { state: 'visible', timeoutMs: 8000 });

      const searchHttpStatuses: number[] = [];
      const offNet = page.cdp.on('Network.responseReceived', (params, sid) => {
        if (sid !== page.sessionId) return;
        const url = String(params.response?.url ?? '');
        if (url.includes('/api/v1/search')) {
          searchHttpStatuses.push(Number(params.response?.status ?? 0));
        }
      });

      try {
        // 1. Nonexistent search string
        await page.typeTestId('chat-search-input', '__no_match_zz99__', { clearFirst: true });
        await sleep(400);

        const emptyStateRendered = await pollUntil(
          async () => {
            const sbText = await page.eval(
              () =>
                (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return (
              /no\s*(results|chats|matches)|nothing\s*found|empty|无结果|未找到|没有匹配|暂无/i.test(
                sbText,
              ) && !sbText.includes('Telegram Official')
            );
          },
          { timeoutMs: 5000, intervalMs: 100, message: 'No results empty state for __no_match_zz99__' },
        );
        assert.equal(emptyStateRendered, true);

        // 2. Adversarial SQL injection + unbalanced RegExp metacharacters
        const adversarialQuery = "%' OR 1=1 -- [(*";
        await page.typeTestId('chat-search-input', adversarialQuery, { clearFirst: true });
        await sleep(450);

        // Also verify server search API directly handles the exact adversarial query with HTTP 200
        const directSearch = await ctx.primaryUser.api.request(
          'GET',
          `/api/v1/search?q=${encodeURIComponent(adversarialQuery)}&category=all`,
        );
        assert.equal(
          directSearch.status,
          200,
          `Expected HTTP 200 from /api/v1/search on SQL/RegExp metacharacters, got ${directSearch.status}`,
        );

        assert.ok(
          !searchHttpStatuses.some((s) => s >= 500),
          `Expected zero 5xx responses from /api/v1/search, saw statuses ${JSON.stringify(searchHttpStatuses)}`,
        );
        assert.equal(
          page.pageExceptions.length,
          0,
          `Expected zero RegExp/DOM exceptions in workspace.html, got ${JSON.stringify(page.pageExceptions)}`,
        );
        assert.equal(ctx.browser.uncaughtExceptions.length, 0);

        // Clearing search restores normal dialog list
        await page.typeTestId('chat-search-input', '', { clearFirst: true });
        await page.pressKey('Escape');
        await sleep(250);
        const restoredCount = await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          return sb ? sb.querySelectorAll('[data-chat-id], [role="listitem"], li, button').length : 0;
        });
        assert.ok(restoredCount >= 1, 'Clearing search input must restore dialog rows in chat-sidebar');
      } finally {
        offNet();
      }
    });
  },
});

defineTest({
  id: 'T2-F12-02',
  title: 'Group with XSS title <img src=x onerror="window.__xss_sidebar=1"> renders literal escaped text and never executes script',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const xssTitle = '<img src=x onerror="window.__xss_sidebar=1">';
    const created = await ctx.primaryUser.api.createChat({
      title: xssTitle,
      chat_type: 'group',
    });
    const chatId = Number(created.chat_id ?? created.id);
    assert.ok(chatId > 0);

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText('__xss_sidebar', {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        // Click the XSS-titled group row so it also renders in conversation-stage header
        await page.eval((literalTitle: string) => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sb) return;
          const leaf = Array.from(sb.querySelectorAll('*')).find(
            (el) => el.children.length === 0 && (el.textContent ?? '').includes(literalTitle),
          );
          (leaf?.closest('[data-chat-id], [role="listitem"], button, li, div') as HTMLElement | null)?.click();
        }, xssTitle);
        await sleep(250);

        const xssAudit = await page.eval((literalTitle: string) => {
          const w = window as any;
          const sidebarEl = document.querySelector('[data-testid="chat-sidebar"]');
          const stageEl = document.querySelector('[data-testid="conversation-stage"]');
          return {
            xssGlobal: w.__xss_sidebar,
            injectedImgs: document.querySelectorAll('img[src="x"], img[onerror]').length,
            sidebarHasLiteral: (sidebarEl?.textContent ?? '').includes(literalTitle),
            stageHasLiteral: (stageEl?.textContent ?? document.body.textContent ?? '').includes(
              literalTitle,
            ),
          };
        }, xssTitle);

        assert.equal(
          xssAudit.xssGlobal,
          undefined,
          'XSS payload in chat title MUST NOT execute (window.__xss_sidebar must be undefined)',
        );
        assert.equal(xssAudit.injectedImgs, 0, 'Zero injected <img src=x> elements allowed in DOM');
        assert.equal(
          xssAudit.sidebarHasLiteral,
          true,
          'chat-sidebar must render literal escaped <img ...> text',
        );
        assert.equal(xssAudit.stageHasLiteral, true);
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F12-03',
  title: 'Creating custom Bot with invalid ("bad handle!") or duplicate handle surfaces error without closing modal or losing persona prompt',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const existingHandle = `dup_f12_${Date.now().toString(36)}_bot`;
    await ctx.primaryUser.api.createFabushiBot({
      display_name: 'Existing Dup Bot',
      username: existingHandle,
      description: 'Pre-existing bot to trigger handle conflict',
    });

    const preservedPersona =
      'Senior Browser Security Copilot — keep this exact persona text intact on validation error!';

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('create-menu-btn', { state: 'visible', timeoutMs: 10000 });
      await page.clickTestId('create-menu-btn');
      await sleep(150);

      // Click "Create AI Bot" / "Create Fabushi Bot" / "BotFather" option
      const openedBotModal = await page.eval(() => {
        const items = Array.from(
          document.querySelectorAll('button, [role="menuitem"], li'),
        ) as HTMLElement[];
        const botOpt = items.find(
          (el) =>
            el.offsetParent !== null &&
            /create.*bot|ai\s*bot|fabushi.*bot|new\s*bot|创建.*机器人|新建.*bot/i.test(
              el.textContent ?? '',
            ),
        );
        if (botOpt) {
          botOpt.click();
          return true;
        }
        return false;
      });
      assert.equal(openedBotModal, true, 'Expected Create AI Bot option in create-menu-btn');

      // Locate modal inputs: display name, handle/username, and persona/description
      const modalSelectors = await pollUntil(
        async () => {
          return await page.eval(() => {
            const dialog =
              (document.querySelector('[role="dialog"], [data-testid*="bot"][data-testid*="modal"], .modal') as HTMLElement | null) ??
              document.body;
            const inputs = Array.from(
              dialog.querySelectorAll('input:not([type="hidden"]), textarea'),
            ).filter((el) => (el as HTMLElement).offsetParent !== null) as Array<
              HTMLInputElement | HTMLTextAreaElement
            >;
            if (inputs.length < 2) return null;

            let handleIdx = inputs.findIndex((i) =>
              /user|handle|bot|@|用户名|标识/i.test(
                `${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.id}`,
              ),
            );
            let personaIdx = inputs.findIndex(
              (i) =>
                i.tagName.toLowerCase() === 'textarea' ||
                /prompt|persona|desc|instruction|描述|设定|提示词/i.test(
                  `${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.id}`,
                ),
            );
            const nameIdx = inputs.findIndex(
              (_, idx) => idx !== handleIdx && idx !== personaIdx,
            );
            if (handleIdx === -1) handleIdx = inputs.length > 1 ? 1 : 0;
            if (personaIdx === -1) personaIdx = inputs.length - 1;

            if (nameIdx >= 0) inputs[nameIdx].setAttribute('data-e2e-bot-name', '1');
            inputs[handleIdx].setAttribute('data-e2e-bot-handle', '1');
            inputs[personaIdx].setAttribute('data-e2e-bot-persona', '1');
            return {
              hasName: nameIdx >= 0,
              handleSel: '[data-e2e-bot-handle="1"]',
              personaSel: '[data-e2e-bot-persona="1"]',
            };
          });
        },
        { timeoutMs: 6000, intervalMs: 100, message: 'Bot creation modal inputs' },
      );
      assert.ok(modalSelectors);

      if (modalSelectors.hasName) {
        await page.type('[data-e2e-bot-name="1"]', 'Validation Probe Bot', { clearFirst: true });
      }
      await page.type(modalSelectors.personaSel, preservedPersona, { clearFirst: true });

      // Attempt 1: Invalid handle "bad handle!" (spaces + exclamation + not ending in bot)
      await page.type(modalSelectors.handleSel, 'bad handle!', { clearFirst: true });
      await page.eval(() => {
        const dialog =
          document.querySelector('[role="dialog"], [data-testid*="modal"], .modal') ?? document.body;
        const submitBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
          /create|save|submit|build|创建|提交|确认/i.test(b.textContent ?? ''),
        ) as HTMLElement | undefined;
        submitBtn?.click();
      });
      await sleep(300);

      const afterInvalidHandle = await page.eval((pSel: string) => {
        const personaEl = document.querySelector(pSel) as HTMLInputElement | HTMLTextAreaElement | null;
        const dialogText =
          (
            (document.querySelector('[role="dialog"], [data-testid*="modal"], .modal') as HTMLElement | null) ??
            document.body
          ).innerText ?? '';
        return {
          modalStillOpen: Boolean(personaEl && personaEl.offsetParent !== null),
          personaValue: personaEl?.value ?? '',
          hasErrorText: /invalid|handle|username|bot|alphanumeric|space|格式|无效|必须|错误/i.test(
            dialogText,
          ),
        };
      }, modalSelectors.personaSel);

      assert.equal(afterInvalidHandle.modalStillOpen, true, 'Bot modal must stay open on invalid handle');
      assert.equal(
        afterInvalidHandle.personaValue,
        preservedPersona,
        'Typed persona prompt must be preserved after invalid handle validation error',
      );
      assert.equal(afterInvalidHandle.hasErrorText, true, 'Expected validation error message for "bad handle!"');

      // Attempt 2: Duplicate handle conflict
      await page.type(modalSelectors.handleSel, existingHandle, { clearFirst: true });
      await page.eval(() => {
        const dialog =
          document.querySelector('[role="dialog"], [data-testid*="modal"], .modal') ?? document.body;
        const submitBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
          /create|save|submit|build|创建|提交|确认/i.test(b.textContent ?? ''),
        ) as HTMLElement | undefined;
        submitBtn?.click();
      });

      await pollUntil(
        async () => {
          const text = await page.eval(
            () =>
              (
                (document.querySelector('[role="dialog"], [data-testid*="modal"], .modal') as HTMLElement | null) ??
                document.body
              ).innerText ?? '',
          );
          return /exist|taken|duplicate|conflict|already|409|400|已存在|占用|冲突|错误/i.test(text);
        },
        { timeoutMs: 5000, intervalMs: 100, message: 'Duplicate bot handle conflict error' },
      );

      const personaAfterDup = await page.eval(
        (pSel: string) =>
          (document.querySelector(pSel) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '',
        modalSelectors.personaSel,
      );
      assert.equal(
        personaAfterDup,
        preservedPersona,
        'Typed persona prompt must remain preserved after duplicate bot handle error',
      );
    });
  },
});

defineTest({
  id: 'T2-F12-04',
  title: 'Whitespace-only Folder name ("   ") is rejected, and deleting active custom Folder falls back cleanly to "All" tab',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    // 1. Verify server/API & UI reject whitespace-only folder name "   "
    const foldersBefore = await ctx.primaryUser.api.listFolders();
    const blankResp = await ctx.primaryUser.api.request('POST', '/api/v1/folders', {
      title: '   ',
      include_chats: [ctx.primaryUser.officialBotChatId],
    });
    assert.ok(
      !blankResp.ok || blankResp.status >= 400,
      `Whitespace-only folder name "   " must be rejected (got HTTP ${blankResp.status})`,
    );
    const foldersAfterBlank = await ctx.primaryUser.api.listFolders();
    assert.equal(
      foldersAfterBlank.folders.length,
      foldersBefore.folders.length,
      'Whitespace-only folder must not be persisted',
    );

    // 2. Create a custom folder, activate it in workspace.html, then delete it while viewing it
    const groupInAll = await ctx.primaryUser.api.createChat({
      title: 'Unassigned Global Group 412',
      chat_type: 'group',
    });
    const scopedGroup = await ctx.primaryUser.api.createChat({
      title: 'Folder Scoped Group 412',
      chat_type: 'group',
    });
    const scopedChatId = Number(scopedGroup.chat_id ?? scopedGroup.id);
    const globalChatId = Number(groupInAll.chat_id ?? groupInAll.id);

    const createdFolder = await ctx.primaryUser.api.createFolder({
      title: 'EphemeralOpsTab',
      include_chats: [scopedChatId],
    });
    const folderId = createdFolder.id ?? createdFolder.folder_id;
    assert.ok(folderId !== undefined);

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText('EphemeralOpsTab', {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        // Tag and click the "EphemeralOpsTab" folder tab in chat-sidebar
        const folderTabSel = await page.eval(() => {
          document
            .querySelectorAll('[data-e2e-ephemeral-folder-tab]')
            .forEach((el) => el.removeAttribute('data-e2e-ephemeral-folder-tab'));
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sb) return null;
          const tab = Array.from(
            sb.querySelectorAll('button, [role="tab"], [data-folder-id], span, div'),
          ).find(
            (el) =>
              (el as HTMLElement).offsetParent !== null &&
              (el.textContent ?? '').trim().startsWith('EphemeralOpsTab'),
          ) as HTMLElement | undefined;
          if (!tab) return null;
          const target = (tab.closest('button, [role="tab"], [data-folder-id]') as HTMLElement | null) ?? tab;
          target.setAttribute('data-e2e-ephemeral-folder-tab', '1');
          return '[data-e2e-ephemeral-folder-tab="1"]';
        });
        assert.ok(folderTabSel, 'Expected clickable EphemeralOpsTab folder tab in chat-sidebar');
        await page.click(folderTabSel);

        // Confirm "EphemeralOpsTab" is genuinely active and filtering out Unassigned Global Group 412
        await pollUntil(
          async () => {
            const sbText = await page.eval(
              () =>
                (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return (
              sbText.includes('Folder Scoped Group 412') &&
              !sbText.includes('Unassigned Global Group 412')
            );
          },
          {
            timeoutMs: 5000,
            intervalMs: 80,
            message: 'EphemeralOpsTab filters sidebar to scoped chats before deletion',
          },
        );

        // Delete the active folder strictly via real UI affordances (ZERO api.deleteFolder or page.reload()!)
        let deletedViaUi = await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sb) return false;
          const activeTab = sb.querySelector('[data-e2e-ephemeral-folder-tab="1"]') as HTMLElement | null;
          const inlineDel =
            (activeTab?.querySelector(
              '[data-testid*="delete"], [aria-label*="delete" i], [aria-label*="remove" i], [title*="delete" i], button',
            ) as HTMLElement | null) ??
            (Array.from(
              sb.querySelectorAll('[data-testid*="delete-folder"], [aria-label*="Delete folder" i]'),
            )[0] as HTMLElement | undefined);
          if (inlineDel && inlineDel !== activeTab && inlineDel.offsetParent !== null) {
            inlineDel.click();
            return true;
          }
          return false;
        });

        // Try right-click context menu on the active folder tab if no inline icon was present
        if (!deletedViaUi) {
          await page.click(folderTabSel, { button: 'right' });
          await sleep(150);
          deletedViaUi = await page.eval(() => {
            const menuItems = Array.from(
              document.querySelectorAll(
                '[role="menuitem"], .context-menu button, .context-menu li, [data-testid*="context"] button',
              ),
            ) as HTMLElement[];
            const delItem = menuItems.find(
              (el) =>
                el.offsetParent !== null &&
                /delete|remove|删除|移除/i.test(el.textContent ?? ''),
            );
            if (delItem) {
              delItem.click();
              return true;
            }
            return false;
          });
        }

        // If folder deletion lives under Settings -> Chat Folders, drive Settings UI and return to Chats view (still zero page.reload!)
        if (!deletedViaUi) {
          const openedSettings = await page.eval(() => {
            const rail = document.querySelector('[data-testid="nav-rail"]');
            const btns = Array.from(
              rail?.querySelectorAll('button, [role="button"], a') ?? [],
            ) as HTMLElement[];
            const settingsBtn = btns.find((b) =>
              /setting|pref|config|设置/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
              ),
            );
            if (settingsBtn) {
              settingsBtn.click();
              return true;
            }
            return false;
          });
          if (openedSettings) {
            await page.waitForTestId('settings-router', { state: 'visible', timeoutMs: 8000 });
            await page.eval(() => {
              const router = document.querySelector('[data-testid="settings-router"]')!;
              const navItems = Array.from(
                router.querySelectorAll('button, [role="tab"], [role="button"], li, a'),
              ) as HTMLElement[];
              const foldersSection = navItems.find((el) =>
                /folder|分组|文件夹/i.test(
                  `${el.getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
                ),
              );
              foldersSection?.click();
            });
            await sleep(200);
            deletedViaUi = await page.eval(() => {
              const router = document.querySelector('[data-testid="settings-router"]')!;
              const candidates = Array.from(router.querySelectorAll('*')) as HTMLElement[];
              const row = candidates
                .filter(
                  (el) =>
                    el.offsetParent !== null &&
                    (el.innerText || '').includes('EphemeralOpsTab') &&
                    el.querySelectorAll('button').length > 0,
                )
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
              if (!row) return false;
              const delBtn = Array.from(row.querySelectorAll('button')).find((b) =>
                /delete|remove|trash|×|✕|删除|移除/i.test(
                  `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''}`,
                ),
              );
              if (delBtn) {
                delBtn.click();
                return true;
              }
              return false;
            });

            // Confirm modal if shown inside Settings, then navigate back to Chats tab via nav-rail
            await sleep(150);
            await page.eval(() => {
              const confirmBtn = Array.from(
                document.querySelectorAll('[role="dialog"] button, .modal button'),
              ).find(
                (b) =>
                  (b as HTMLElement).offsetParent !== null &&
                  !/^(cancel|取消)$/i.test((b.textContent ?? '').trim()) &&
                  /delete|remove|confirm|ok|yes|删除|移除|确认|确定/i.test(b.textContent ?? ''),
              ) as HTMLElement | undefined;
              confirmBtn?.click();

              const rail = document.querySelector('[data-testid="nav-rail"]');
              const btns = Array.from(
                rail?.querySelectorAll('button, [role="button"], a') ?? [],
              ) as HTMLElement[];
              btns[0]?.click();
            });
          }
        }

        // Confirm any confirmation modal if triggered from sidebar tab/context menu
        await sleep(150);
        await page.eval(() => {
          const confirmBtn = Array.from(
            document.querySelectorAll('[role="dialog"] button, .modal button'),
          ).find(
            (b) =>
              (b as HTMLElement).offsetParent !== null &&
              !/^(cancel|取消)$/i.test((b.textContent ?? '').trim()) &&
              /delete|remove|confirm|ok|yes|删除|移除|确认|确定/i.test(b.textContent ?? ''),
          ) as HTMLElement | undefined;
          confirmBtn?.click();
        });

        assert.equal(
          deletedViaUi,
          true,
          'workspace.html must expose a real UI control to delete active custom folder (tab action, context menu, or Settings -> Folders)',
        );

        // Verify live reactive fallback to "All" tab WITHOUT page.reload(), showing Unassigned Global Group 412
        await pollUntil(
          async () => {
            const sbText = await page.eval(
              () =>
                (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return (
              !sbText.includes('EphemeralOpsTab') &&
              sbText.includes('Unassigned Global Group 412')
            );
          },
          {
            timeoutMs: 6000,
            intervalMs: 100,
            message: 'Live reactive fallback to All tab showing unassigned chats after UI folder deletion',
          },
        );

        const foldersAfterUiDelete = await ctx.primaryUser.api.listFolders();
        assert.ok(
          !foldersAfterUiDelete.folders.some((f: any) => f.title === 'EphemeralOpsTab'),
          'UI folder deletion must remove EphemeralOpsTab from /api/v1/folders',
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteFolder(folderId).catch(() => undefined);
      await ctx.primaryUser.api.deleteChat(scopedChatId).catch(() => undefined);
      await ctx.primaryUser.api.deleteChat(globalChatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F12-05',
  title: 'Dialog context menu Clear History and Delete/Leave preserve 100% of messages on Cancel and remove disposable group on Confirm',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const groupTitle = 'Disposable Confirm Group 509';
    const dispGroup = await ctx.primaryUser.api.createChat({
      title: groupTitle,
      chat_type: 'group',
    });
    const chatId = Number(dispGroup.chat_id ?? dispGroup.id);
    assert.ok(chatId > 0);

    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: 'Preserved History Line #1',
    });
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: 'Preserved History Line #2',
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText(groupTitle, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        const tagDialogRow = async (): Promise<string> => {
          const sel = await page.eval((title: string) => {
            const sb = document.querySelector('[data-testid="chat-sidebar"]');
            if (!sb) return null;
            const leaf = Array.from(sb.querySelectorAll('*')).find(
              (el) => el.children.length === 0 && (el.textContent ?? '').includes(title),
            );
            const row = leaf?.closest(
              '[data-chat-id], [role="listitem"], li, button, .dialog-row, .chat-item',
            ) as HTMLElement | null;
            if (!row) return null;
            row.setAttribute('data-e2e-target-dialog', '1');
            return '[data-e2e-target-dialog="1"]';
          }, groupTitle);
          assert.ok(sel, `Expected dialog row for "${groupTitle}"`);
          return sel;
        };

        const rowSelector = await tagDialogRow();
        await page.click(rowSelector);
        await page.waitForText('Preserved History Line #1', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });

        // Right-click dialog row -> Delete/Leave (or Clear History) -> click Cancel in confirmation modal
        await page.click(rowSelector, { button: 'right' });
        await sleep(150);

        const clickedDestructiveMenuItem = await page.eval(() => {
          const items = Array.from(
            document.querySelectorAll('[role="menuitem"], .context-menu button, .context-menu li, button'),
          ) as HTMLElement[];
          const item = items.find(
            (el) =>
              el.offsetParent !== null &&
              /clear\s*history|delete|leave|清空|删除|退出群/i.test(el.textContent ?? ''),
          );
          if (item) {
            item.click();
            return true;
          }
          return false;
        });
        assert.equal(clickedDestructiveMenuItem, true, 'Expected Clear/Delete/Leave item in dialog context menu');
        await sleep(150);

        // Click Cancel in confirmation modal
        const clickedCancel = await page.eval(() => {
          const btns = Array.from(
            document.querySelectorAll('[role="dialog"] button, .modal button, button'),
          ) as HTMLElement[];
          const cancelBtn = btns.find(
            (b) => b.offsetParent !== null && /^(cancel|close|no|取消|关闭)$/i.test((b.textContent ?? '').trim()),
          );
          if (cancelBtn) {
            cancelBtn.click();
            return true;
          }
          return false;
        });
        assert.equal(clickedCancel, true, 'Expected Cancel button in destructive confirmation modal');
        await sleep(250);

        // Verify 100% of messages and sidebar row remain intact after Cancel
        const histAfterCancel = await ctx.primaryUser.api.getMessages(chatId);
        const textsAfterCancel = histAfterCancel.messages.map((m: any) => String(m.text ?? ''));
        assert.ok(textsAfterCancel.includes('Preserved History Line #1'));
        assert.ok(textsAfterCancel.includes('Preserved History Line #2'));

        // Now Right-click -> Delete/Leave -> Confirm
        await page.click(rowSelector, { button: 'right' });
        await sleep(150);
        await page.eval(() => {
          const items = Array.from(
            document.querySelectorAll('[role="menuitem"], .context-menu button, .context-menu li, button'),
          ) as HTMLElement[];
          const delItem = items.find(
            (el) =>
              el.offsetParent !== null && /delete|leave|删除|退出群/i.test(el.textContent ?? ''),
          );
          delItem?.click();
        });
        await sleep(150);

        const clickedConfirm = await page.eval(() => {
          const btns = Array.from(
            document.querySelectorAll('[role="dialog"] button, .modal button'),
          ) as HTMLElement[];
          const confirmBtn = btns.find(
            (b) =>
              b.offsetParent !== null &&
              !/^(cancel|取消)$/i.test((b.textContent ?? '').trim()) &&
              /delete|leave|confirm|ok|yes|删除|退出|确认|确定/i.test(b.textContent ?? ''),
          );
          if (confirmBtn) {
            confirmBtn.click();
            return true;
          }
          return false;
        });
        assert.equal(clickedConfirm, true, 'Expected Confirm button in Delete/Leave confirmation modal');

        await pollUntil(
          async () => {
            const sbText = await page.eval(
              () =>
                (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return !sbText.includes(groupTitle);
          },
          { timeoutMs: 6000, intervalMs: 100, message: 'Confirmed Delete/Leave removes group from sidebar' },
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F12-06',
  title: 'Rapidly switching across 5 dialogs while slow history fetch is in flight strictly displays last clicked dialog transcript',
  tier: 2,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const createdChats: Array<{ chatId: number; title: string; marker: string }> = [];

    try {
      for (let i = 1; i <= 5; i++) {
        const title = `RaceFence_Dialog_${i}`;
        const marker = `UNIQUE_FENCE_TRANSCRIPT_MARKER_${i}_${Date.now()}`;
        const chat = await ctx.primaryUser.api.createChat({
          title,
          chat_type: 'group',
        });
        const chatId = Number(chat.chat_id ?? chat.id);
        await ctx.primaryUser.api.sendMessage({ chat_id: chatId, text: marker });
        createdChats.push({ chatId, title, marker });
      }

      const firstChatId = createdChats[0].chatId;
      const lastDialog = createdChats[4];

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText(lastDialog.title, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        // Tag all 5 dialog rows in DOM for rapid click dispatch
        await page.eval((titles: string[]) => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          if (!sb) return;
          titles.forEach((t, idx) => {
            const leaf = Array.from(sb.querySelectorAll('*')).find(
              (el) => el.children.length === 0 && (el.textContent ?? '').includes(t),
            );
            const row = leaf?.closest(
              '[data-chat-id], [role="listitem"], li, button, .dialog-row, .chat-item',
            ) as HTMLElement | null;
            row?.setAttribute('data-e2e-race-idx', String(idx + 1));
          });
        }, createdChats.map((c) => c.title));

        // Add genuine 300ms network response delay ONLY to Dialog #1's messages fetch via CDP Fetch
        await page.cdp
          .send(
            'Fetch.enable',
            { patterns: [{ urlPattern: `*/api/v1/chats/${firstChatId}/messages*`, requestStage: 'Response' }] },
            page.sessionId,
          )
          .catch(() => undefined);

        const offFetch = page.cdp.on('Fetch.requestPaused', (params, sid) => {
          if (sid !== page.sessionId) return;
          setTimeout(() => {
            void page.cdp
              .send('Fetch.continueRequest', { requestId: params.requestId }, page.sessionId)
              .catch(() => undefined);
          }, 300);
        });

        try {
          // Rapidly click Dialog 1 -> 2 -> 3 -> 4 -> 5
          for (let i = 1; i <= 5; i++) {
            await page.eval((idx: number) => {
              const el = document.querySelector(`[data-e2e-race-idx="${idx}"]`) as HTMLElement | null;
              el?.click();
            }, i);
            await sleep(20);
          }

          // Wait past the 300ms delayed response of Dialog #1 so stale response arrives AFTER Dialog #5
          await sleep(550);

          await page.waitForText(lastDialog.marker, {
            selector: '[data-testid="conversation-stage"]',
            timeoutMs: 6000,
          });

          const stageText = await page.eval(
            () =>
              (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null)
                ?.innerText ?? '',
          );
          assert.ok(
            stageText.includes(lastDialog.marker),
            'conversation-stage must display last clicked Dialog #5 transcript',
          );
          for (let i = 0; i < 4; i++) {
            assert.ok(
              !stageText.includes(createdChats[i].marker),
              `Stale transcript from ${createdChats[i].title} overwrote Dialog #5 in conversation-stage!`,
            );
          }
        } finally {
          offFetch();
          await page.cdp.send('Fetch.disable', {}, page.sessionId).catch(() => undefined);
        }
      });
    } finally {
      for (const c of createdChats) {
        await ctx.primaryUser.api.deleteChat(c.chatId).catch(() => undefined);
      }
    }
  },
});
