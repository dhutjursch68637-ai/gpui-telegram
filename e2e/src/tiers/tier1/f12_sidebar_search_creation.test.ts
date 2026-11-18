import * as crypto from 'node:crypto';
import {
  defineTest,
  assert,
  pollUntil,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

async function cdpClickPoint(
  page: CdpPageHandle,
  pt: { x: number; y: number },
  button: 'left' | 'right' = 'left',
): Promise<void> {
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' },
    page.sessionId,
  );
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: pt.x, y: pt.y, button, clickCount: 1 },
    page.sessionId,
  );
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: pt.x, y: pt.y, button, clickCount: 1 },
    page.sessionId,
  );
}

async function findSidebarRowPoint(
  page: CdpPageHandle,
  titleSubstring: string,
): Promise<{ x: number; y: number } | null> {
  return await page.eval((needle: string) => {
    const sb = document.querySelector('[data-testid="chat-sidebar"]');
    if (!sb) return null;
    const candidates = Array.from(
      sb.querySelectorAll('[data-chat-id], [role="listitem"], [role="option"], li, .chat-row, .dialog-row, div, button'),
    ) as HTMLElement[];
    const matches = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      const txt = el.innerText || el.textContent || '';
      return (
        txt.includes(needle) &&
        r.width >= 120 &&
        r.height >= 32 &&
        r.height <= 110
      );
    });
    matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const best = matches[0];
    if (!best) return null;
    best.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, titleSubstring);
}

async function clickMenuItemMatching(
  page: CdpPageHandle,
  pattern: RegExp,
  labelForError: string,
): Promise<void> {
  const pt = await pollUntil(
    async () => {
      return await page.eval((reSrc: string) => {
        const re = new RegExp(reSrc, 'i');
        const items = Array.from(
          document.querySelectorAll(
            '[role="menuitem"], [role="option"], .context-menu button, .menu button, [data-menu-item], button, li',
          ),
        ) as HTMLElement[];
        const hit = items.find((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.height > 68) return false;
          const testId = (el.getAttribute('data-testid') ?? '').trim();
          const aria = (el.getAttribute('aria-label') ?? '').trim();
          const text = (el.textContent ?? '').trim();
          const combined = `${testId} ${aria} ${text}`.trim();
          return re.test(text) || re.test(aria) || re.test(testId) || re.test(combined);
        });
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, pattern.source);
    },
    { timeoutMs: 5000, intervalMs: 60, message: `Menu item matching ${labelForError}` },
  );
  assert.ok(pt, `Menu item not found: ${labelForError}`);
  await cdpClickPoint(page, pt, 'left');
}

defineTest({
  id: 'T1-F12-01',
  title: 'Sidebar create-menu-btn (+) creates New Group and New Channel persisted via POST /api/v1/chats',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const teammate = await ctx.createIsolatedUser('team_member');
    const groupTitle = `E2E Core Team ${crypto.randomBytes(2).toString('hex')}`;
    const channelTitle = `Fabushi Releases ${crypto.randomBytes(2).toString('hex')}`;

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('create-menu-btn', { state: 'visible', timeoutMs: 10000 });

      // 1. Create New Group via + menu
      await page.clickTestId('create-menu-btn');
      await clickMenuItemMatching(page, /new\s*group|create\s*group|新建群组|创建群聊/, 'New Group');

      // Fill group creation modal/dialog
      const groupModalFilled = await pollUntil(
        async () => {
          return await page.eval(
            (gTitle: string, memberName: string) => {
              const setVal = (el: HTMLInputElement | HTMLTextAreaElement, val: string) => {
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

              const dialog =
                (document.querySelector('[role="dialog"], .modal, [data-testid*="modal" i], [data-testid*="dialog" i]') as HTMLElement | null) ??
                document.body;
              const inputs = Array.from(dialog.querySelectorAll('input, textarea')).filter(
                (i) => (i as HTMLElement).getAttribute('data-testid') !== 'chat-search-input',
              ) as Array<HTMLInputElement | HTMLTextAreaElement>;
              if (inputs.length === 0) return false;

              setVal(inputs[0], gTitle);
              const memberInp = inputs.find((i) =>
                /member|user|participant|invite|成员|用户/i.test(
                  `${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`,
                ),
              );
              if (memberInp && memberInp !== inputs[0]) {
                setVal(memberInp, memberName);
              }
              return true;
            },
            groupTitle,
            teammate.username,
          );
        },
        { timeoutMs: 5000, message: 'New Group dialog title input mounted' },
      );
      assert.equal(groupModalFilled, true);

      await clickMenuItemMatching(page, /^(create|submit|save|next|confirm|创建|确定|下一步)$/i, 'Submit New Group');

      await page.waitForText(groupTitle, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 8000,
      });

      // 2. Create New Channel via + menu
      await page.clickTestId('create-menu-btn');
      await clickMenuItemMatching(page, /new\s*channel|create\s*channel|新建频道|创建频道/, 'New Channel');

      await pollUntil(
        async () => {
          return await page.eval((cTitle: string) => {
            const setVal = (el: HTMLInputElement | HTMLTextAreaElement, val: string) => {
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
            const dialog =
              (document.querySelector('[role="dialog"], .modal, [data-testid*="modal" i]') as HTMLElement | null) ??
              document.body;
            const inputs = Array.from(dialog.querySelectorAll('input, textarea')).filter(
              (i) => (i as HTMLElement).getAttribute('data-testid') !== 'chat-search-input',
            ) as Array<HTMLInputElement | HTMLTextAreaElement>;
            if (inputs.length === 0) return false;
            setVal(inputs[0], cTitle);
            return true;
          }, channelTitle);
        },
        { timeoutMs: 5000, message: 'New Channel dialog title input mounted' },
      );

      await clickMenuItemMatching(page, /^(create|submit|save|confirm|创建|确定)$/i, 'Submit New Channel');

      await page.waitForText(channelTitle, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 8000,
      });

      // Verify both group and channel exist on gpui_telegram_server
      const serverChats = await ctx.primaryUser.api.listChats();
      const createdGroup = serverChats.chats.find((c: any) => c.title === groupTitle);
      const createdChannel = serverChats.chats.find((c: any) => c.title === channelTitle);

      assert.ok(createdGroup, `Server GET /api/v1/chats must contain group "${groupTitle}"`);
      assert.ok(
        createdGroup.is_group === true ||
          createdGroup.kind === 'group' ||
          createdGroup.chat_type === 1 ||
          createdGroup.chat_type === 2,
        `Expected group chat_type on server, got ${JSON.stringify(createdGroup)}`,
      );

      assert.ok(createdChannel, `Server GET /api/v1/chats must contain channel "${channelTitle}"`);
      assert.ok(
        createdChannel.is_channel === true ||
          createdChannel.kind === 'channel' ||
          createdChannel.chat_type === 3,
        `Expected channel chat_type on server, got ${JSON.stringify(createdChannel)}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F12-02',
  title: 'create-menu-btn (+) provisions companion AI Bot (Fabushi / @BotFather) and opens bot conversation view',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const botDisplayName = `ResearchHelperBot_${crypto.randomBytes(2).toString('hex')}`;

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('create-menu-btn', { state: 'visible', timeoutMs: 10000 });
      await page.clickTestId('create-menu-btn');

      await clickMenuItemMatching(
        page,
        /create.*bot|ai\s*bot|fabushi|botfather|机器人|智能体/,
        'Create AI Bot',
      );

      await pollUntil(
        async () => {
          return await page.eval((bName: string) => {
            const setVal = (el: HTMLInputElement | HTMLTextAreaElement, val: string) => {
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

            const dialog =
              (document.querySelector('[role="dialog"], .modal, [data-testid*="modal" i], [data-testid*="bot" i]') as HTMLElement | null) ??
              document.body;
            const inputs = Array.from(dialog.querySelectorAll('input, textarea')).filter(
              (i) =>
                (i as HTMLElement).getAttribute('data-testid') !== 'chat-search-input' &&
                (i as HTMLElement).getAttribute('data-testid') !== 'canonical-composer-input',
            ) as Array<HTMLInputElement | HTMLTextAreaElement>;
            if (inputs.length === 0) return false;

            setVal(inputs[0], bName);
            if (inputs.length > 1) {
              const descInp = inputs.find((i) =>
                /prompt|persona|desc|system|指令|描述|人设/i.test(
                  `${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`,
                ),
              );
              if (descInp && descInp !== inputs[0]) {
                setVal(descInp, `Create ${bName} to synthesize cloud architecture research.`);
              }
            }
            return true;
          }, botDisplayName);
        },
        { timeoutMs: 5000, message: 'Create AI Bot modal inputs mounted' },
      );

      await clickMenuItemMatching(
        page,
        /create|generate|provision|submit|save|创建|生成|确定/,
        'Submit Create AI Bot',
      );

      // Verify bot appears in chat-sidebar AND on backend Fabushi/Bots registry
      await page.waitForText(botDisplayName, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 10000,
      });

      const [fabushiList, chatsList] = await Promise.all([
        ctx.primaryUser.api.listFabushiBots(),
        ctx.primaryUser.api.listChats(),
      ]);
      const inFabushi = fabushiList.bots.some((b: any) =>
        `${b.display_name ?? ''} ${b.title ?? ''} ${b.username ?? ''}`.includes(botDisplayName),
      );
      const inChats = chatsList.chats.some(
        (c: any) => String(c.title ?? '').includes(botDisplayName) && (c.is_bot || c.chat_type === 4 || c.kind === 'bot'),
      );
      assert.ok(
        inFabushi || inChats,
        `Provisioned bot "${botDisplayName}" must exist in server Fabushi bots or bot chats`,
      );

      // Click the bot row in chat-sidebar and verify conversation stage opens cleanly
      const botPt = await findSidebarRowPoint(page, botDisplayName);
      assert.ok(botPt, `Expected clickable sidebar row for ${botDisplayName}`);
      await cdpClickPoint(page, botPt, 'left');

      const stage = await page.waitForTestId('conversation-stage', {
        state: 'visible',
        timeoutMs: 6000,
      });
      assert.ok(stage?.visible, 'Clicking bot dialog must open conversation-stage');
    });
  },
});

defineTest({
  id: 'T1-F12-03',
  title: 'Universal search (chat-search-input) filters across tags (all, bot, unread, pinned, media, links) and categories',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const tag = crypto.randomBytes(3).toString('hex');
    const searchGroupTitle = `AlphaSearchGroup_${tag}`;
    const searchBotName = `AlphaSearchBot_${tag}`;

    const grp = await ctx.primaryUser.api.createChat({
      title: searchGroupTitle,
      chat_type: 'group',
    });
    const grpId = Number(grp.chat_id ?? grp.id);
    await ctx.primaryUser.api.sendMessage({
      chat_id: grpId,
      text: `Reference specification link https://example.com/spec-${tag}`,
    });
    await ctx.primaryUser.api.createFabushiBot({
      display_name: searchBotName,
      description: 'Search tag verification bot',
    });

    // Wait briefly for async Tantivy indexer commit on server
    await pollUntil(
      async () => {
        const res = await ctx.primaryUser.api.search(`spec-${tag}`, { category: 'messages' });
        return (res.total ?? res.hits?.length ?? 0) >= 1;
      },
      { timeoutMs: 4000, intervalMs: 80, message: 'Server Tantivy search indexes new message' },
    );

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-search-input', { state: 'visible', timeoutMs: 10000 });

      await page.typeTestId('chat-search-input', `AlphaSearchGroup_${tag}`, { clearFirst: true });

      await pollUntil(
        async () => {
          const text = await page.eval(() => document.body.innerText || '');
          return text.includes(searchGroupTitle);
        },
        { timeoutMs: 6000, message: 'Universal search surfaces AlphaSearchGroup' },
      );

      // Filter by "bot" tag / category for AlphaSearchBot
      await page.typeTestId('chat-search-input', `AlphaSearch`, { clearFirst: true });
      const clickedBotChip = await pollUntil(
        async () => {
          return await page.eval(() => {
            const chips = Array.from(
              document.querySelectorAll(
                'button, [role="tab"], [role="button"], [data-tag], [data-filter], [data-category]',
              ),
            ) as HTMLElement[];
            const botChip = chips.find((c) => {
              const r = c.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const tagAttr = `${c.getAttribute('data-tag') ?? ''} ${c.getAttribute('data-filter') ?? ''} ${c.getAttribute('data-testid') ?? ''}`;
              const txt = (c.textContent ?? '').trim();
              return (
                /\bbot\b/i.test(tagAttr) ||
                /^(#?\s*bot|#?\s*bots|机器人)(\s*\(?\d+\)?)?$/i.test(txt)
              );
            });
            if (!botChip) return false;
            botChip.click();
            return true;
          });
        },
        { timeoutMs: 4000, intervalMs: 60, message: 'Universal search exposes clickable "bot" tag chip' },
      );
      assert.equal(clickedBotChip, true, 'Universal search must render clickable "bot" filter tag/chip');

      await pollUntil(
        async () => {
          const text = await page.eval(() => document.body.innerText || '');
          return text.includes(searchBotName);
        },
        { timeoutMs: 6000, message: 'Bot search tag surfaces AlphaSearchBot' },
      );

      // Exercise and verify search category tabs (Chats, Channels, Apps, Links, Files)
      let matchedCategoryTabs = 0;
      for (const catRe of [
        /chats|dialogs|会话|聊天/i,
        /channels|频道/i,
        /apps|mini\s*apps|小程序|应用/i,
        /links|链接/i,
        /files|documents|文件/i,
      ]) {
        const clickedCat = await page.eval((src: string) => {
          const re = new RegExp(src, 'i');
          const tabs = Array.from(
            document.querySelectorAll('button, [role="tab"], [data-category], [data-tab]'),
          ) as HTMLElement[];
          const hit = tabs.find((t) => {
            const r = t.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const label = `${t.getAttribute('data-category') ?? ''} ${t.getAttribute('data-tab') ?? ''} ${t.getAttribute('aria-label') ?? ''} ${(t.textContent ?? '').trim()}`;
            return re.test(label);
          });
          if (!hit) return false;
          hit.click();
          return true;
        }, catRe.source);
        if (clickedCat) {
          matchedCategoryTabs += 1;
        }
      }
      assert.ok(
        matchedCategoryTabs >= 4,
        `Universal search must render >= 4 clickable category tabs (Chats/Channels/Apps/Links/Files), found ${matchedCategoryTabs}`,
      );

      // Clear search and verify full dialog list returns
      await page.typeTestId('chat-search-input', '', { clearFirst: true });
      await page.pressKey('Escape');

      await page.waitForText(searchGroupTitle, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 6000,
      });
      assert.equal(page.pageExceptions.length, 0, 'Zero page exceptions during universal search filtering');
    });
  },
});

defineTest({
  id: 'T1-F12-04',
  title: 'Custom chat Folder tabs display unread badges and filter chat-sidebar dialogs accurately',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const peer = await ctx.createIsolatedUser('folder_peer');
    const suffix = crypto.randomBytes(2).toString('hex');
    const opsGroupTitle = `OpsFolderRoom_${suffix}`;
    const otherGroupTitle = `GeneralLounge_${suffix}`;
    const folderTitle = `Bots & Ops ${suffix}`;

    const opsChat = await ctx.primaryUser.api.createChat({
      title: opsGroupTitle,
      chat_type: 'group',
      member_ids: [peer.userId],
    });
    const opsChatId = Number(opsChat.chat_id ?? opsChat.id);

    await ctx.primaryUser.api.createChat({
      title: otherGroupTitle,
      chat_type: 'group',
    });

    // Peer sends unread message into opsChat so folder badge is > 0
    await peer.api.sendMessage({
      chat_id: opsChatId,
      text: 'Unread folder alert #1',
    });

    const folderDto = await ctx.primaryUser.api.createFolder({
      title: folderTitle,
      emoticon: '🤖',
      include_chats: [opsChatId],
    });
    assert.ok(folderDto, 'POST /api/v1/folders must create custom folder');

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

      // Both dialogs visible under default "All" tab
      await page.waitForText(opsGroupTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });
      await page.waitForText(otherGroupTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });

      // Custom folder tab must appear with visible unread badge ('1' or unread badge element)
      await page.waitForText(folderTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });

      const folderHasUnreadBadge = await pollUntil(
        async () => {
          return await page.eval((fTitle: string) => {
            const sb = document.querySelector('[data-testid="chat-sidebar"]');
            if (!sb) return false;
            const tabs = Array.from(
              sb.querySelectorAll('button, [role="tab"], [data-folder-id]'),
            ) as HTMLElement[];
            const tab = tabs.find((t) => (t.textContent ?? '').includes(fTitle));
            if (!tab) return false;
            const attrCount = Number(
              tab.getAttribute('data-unread') ?? tab.getAttribute('data-badge') ?? '0',
            );
            if (Number.isFinite(attrCount) && attrCount >= 1) {
              return true;
            }
            const badgeEl = tab.querySelector(
              '[data-unread], [data-badge], [data-testid*="badge" i], [data-testid*="unread" i], .badge, .unread, [class*="badge" i], [class*="unread" i]',
            ) as HTMLElement | null;
            if (badgeEl) {
              const br = badgeEl.getBoundingClientRect();
              if (br.width > 0 && br.height > 0) {
                return true;
              }
            }
            const restText = (tab.innerText || tab.textContent || '').replace(fTitle, '').trim();
            return /\b1\b/.test(restText);
          }, folderTitle);
        },
        {
          timeoutMs: 5000,
          intervalMs: 80,
          message: `Custom folder tab "${folderTitle}" displays unread badge`,
        },
      );
      assert.equal(
        folderHasUnreadBadge,
        true,
        `Custom folder tab "${folderTitle}" must visibly render unread count '1' or unread badge element`,
      );

      const folderTabPt = await page.eval((fTitle: string) => {
        const sb = document.querySelector('[data-testid="chat-sidebar"]')!;
        const tabs = Array.from(sb.querySelectorAll('button, [role="tab"], [data-folder-id]')) as HTMLElement[];
        const tab = tabs.find((t) => (t.textContent ?? '').includes(fTitle));
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return r.width > 0
          ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          : null;
      }, folderTitle);
      assert.ok(folderTabPt, `Folder tab "${folderTitle}" must be clickable in chat-sidebar`);
      await cdpClickPoint(page, folderTabPt, 'left');

      // Verify OpsFolderRoom remains visible while GeneralLounge is filtered out
      await pollUntil(
        async () => {
          const text = await page.eval(
            () => (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement)?.innerText ?? '',
          );
          return text.includes(opsGroupTitle) && !text.includes(otherGroupTitle);
        },
        {
          timeoutMs: 5000,
          message: `Clicking "${folderTitle}" filters out unassigned GeneralLounge`,
        },
      );

      // Click "All" tab to restore full dialog list
      const allTabPt = await page.eval(() => {
        const sb = document.querySelector('[data-testid="chat-sidebar"]')!;
        const tabs = Array.from(sb.querySelectorAll('button, [role="tab"], [data-folder-id]')) as HTMLElement[];
        const allTab = tabs.find((t) => /^(all|all\s*chats|全部)(\s*\d+)?$/i.test((t.textContent ?? '').trim()));
        if (!allTab) return null;
        const r = allTab.getBoundingClientRect();
        return r.width > 0
          ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          : null;
      });
      assert.ok(allTabPt, 'Expected "All" folder tab in chat-sidebar');
      await cdpClickPoint(page, allTabPt, 'left');

      await page.waitForText(otherGroupTitle, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 5000,
      });
    });
  },
});

defineTest({
  id: 'T1-F12-05',
  title: 'Forum-enabled group expands General and Deployments topic rows in chat-sidebar and scopes messages by topic_id',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const suffix = crypto.randomBytes(2).toString('hex');
    const forumTitle = `E2E Forum Hub ${suffix}`;

    const forumChat = await ctx.primaryUser.api.createChat({
      title: forumTitle,
      chat_type: 'supergroup',
      is_forum: true,
    });
    const forumChatId = Number(forumChat.chat_id ?? forumChat.id);

    const deployTopic = await ctx.primaryUser.api.post<Record<string, any>>(
      `/api/v1/chats/${forumChatId}/topics`,
      { title: 'Deployments', icon_color: 7322096 },
    );
    const deployTopicId = Number(deployTopic.topic_id ?? deployTopic.id);
    assert.ok(Number.isFinite(deployTopicId) && deployTopicId > 0, `Expected valid topic_id: ${JSON.stringify(deployTopic)}`);

    const generalMsg = `General_Welcome_${suffix}`;
    const deployMsg = `Prod_Deploy_v2_${suffix}`;

    await ctx.primaryUser.api.sendMessage({
      chat_id: forumChatId,
      topic_id: 1,
      text: generalMsg,
    });
    await ctx.primaryUser.api.sendMessage({
      chat_id: forumChatId,
      topic_id: deployTopicId,
      text: deployMsg,
    });

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await page.waitForText(forumTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });

      const forumRowPt = await findSidebarRowPoint(page, forumTitle);
      assert.ok(forumRowPt, `Expected forum row "${forumTitle}" in chat-sidebar`);
      await cdpClickPoint(page, forumRowPt, 'left');

      // Verify topic sub-rows ("General" & "Deployments") render in sidebar or topic header strip
      await pollUntil(
        async () => {
          const text = await page.eval(() => document.body.innerText || '');
          return text.includes('Deployments') && (/general|常规/i.test(text) || text.includes(generalMsg));
        },
        { timeoutMs: 6000, message: 'Forum topics General and Deployments rendered' },
      );

      // Click "Deployments" topic row/pill
      const deployTopicPt = await page.eval(() => {
        const els = Array.from(
          document.querySelectorAll('[data-topic-id], button, [role="tab"], [role="listitem"], li, div'),
        ) as HTMLElement[];
        const matches = els.filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 40 &&
            r.height >= 22 &&
            r.height <= 64 &&
            (el.innerText || '').trim().includes('Deployments')
          );
        });
        matches.sort((a, b) => a.innerText.length - b.innerText.length);
        const best = matches[0];
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      assert.ok(deployTopicPt, 'Expected clickable "Deployments" forum topic');
      await cdpClickPoint(page, deployTopicPt, 'left');

      await page.waitForText(deployMsg, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 6000,
      });

      // Send a message inside Deployments topic via composer and verify topic_id scoping on server
      const replyInTopic = `Canary_Green_${suffix}`;
      await page.typeTestId('canonical-composer-input', replyInTopic, { clearFirst: true });
      await page.clickTestId('composer-send-btn');

      await pollUntil(
        async () => {
          const topicHistory = await ctx.primaryUser.api.getMessages(forumChatId, {
            topic_id: deployTopicId,
          });
          return topicHistory.messages.some((m: any) => String(m.text ?? '').includes(replyInTopic));
        },
        {
          timeoutMs: 6000,
          message: 'Composer message inside Deployments topic persists with deployTopicId',
        },
      );
    });
  },
});

defineTest({
  id: 'T1-F12-06',
  title: 'Right-click dialog context menu persists Pin, Mute, Mark Unread, Archive, and Unarchive on server and DOM',
  tier: 1,
  features: ['F12'],
  fn: async (ctx: SharedTierContext) => {
    const targetTitle = `CtxMenuRoom_${crypto.randomBytes(3).toString('hex')}`;
    const created = await ctx.primaryUser.api.createChat({
      title: targetTitle,
      chat_type: 'group',
    });
    const chatId = Number(created.chat_id ?? created.id);

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await page.waitForText(targetTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });

      const rightClickTarget = async () => {
        const pt = await findSidebarRowPoint(page, targetTitle);
        assert.ok(pt, `Expected dialog row "${targetTitle}" in sidebar`);
        await cdpClickPoint(page, pt, 'right');
      };

      // 1. Pin
      await rightClickTarget();
      await clickMenuItemMatching(page, /^(pin|pin\s*chat|置顶)/i, 'Pin');
      await pollUntil(
        async () => (await ctx.primaryUser.api.getChat(chatId)).is_pinned === true,
        { timeoutMs: 5000, message: 'Pin persisted to /api/v1/chats/{id}/pin' },
      );

      // 2. Mute
      await rightClickTarget();
      await clickMenuItemMatching(page, /^(mute|mute\s*notifications|静音|免打扰)/i, 'Mute');
      await pollUntil(
        async () => (await ctx.primaryUser.api.getChat(chatId)).is_muted === true,
        { timeoutMs: 5000, message: 'Mute persisted to /api/v1/chats/{id}/mute' },
      );

      // 3. Mark Unread
      await rightClickTarget();
      await clickMenuItemMatching(page, /unread|标为未读/i, 'Mark Unread');
      await pollUntil(
        async () => {
          return await page.eval((needle: string) => {
            const sb = document.querySelector('[data-testid="chat-sidebar"]');
            if (!sb) return false;
            const rows = Array.from(sb.querySelectorAll('*')) as HTMLElement[];
            const row = rows.find(
              (el) =>
                (el.innerText || '').includes(needle) &&
                el.getBoundingClientRect().height >= 32 &&
                el.getBoundingClientRect().height <= 110,
            );
            if (!row) return false;
            return Boolean(
              row.querySelector('[data-unread], .unread, [class*="unread" i], [class*="badge" i]') ||
                /\b1\b/.test(row.innerText),
            );
          }, targetTitle);
        },
        { timeoutMs: 4000, message: 'Unread pill rendered on dialog row' },
      );

      // 4. Archive -> moves into Archived Chats drawer
      await rightClickTarget();
      await clickMenuItemMatching(page, /^(archive|archive\s*chat|归档)/i, 'Archive');
      await pollUntil(
        async () => (await ctx.primaryUser.api.getChat(chatId)).is_archived === true,
        { timeoutMs: 5000, message: 'Archive persisted to /api/v1/chats/{id}/archive' },
      );

      // Open Archived Chats drawer in sidebar and verify targetTitle is inside
      const archiveDrawerPt = await pollUntil(
        async () => {
          return await page.eval(() => {
            const sb = document.querySelector('[data-testid="chat-sidebar"]');
            if (!sb) return null;
            const els = Array.from(sb.querySelectorAll('button, [role="button"], div, li')) as HTMLElement[];
            const hit = els.find((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 60 &&
                r.height >= 24 &&
                r.height <= 72 &&
                /archived|已归档|归档会话/i.test(el.innerText || el.getAttribute('aria-label') || '')
              );
            });
            if (!hit) return null;
            const r = hit.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          });
        },
        { timeoutMs: 5000, message: 'Archived Chats drawer button visible in sidebar' },
      );
      assert.ok(archiveDrawerPt, 'Expected non-null Archived Chats drawer coordinates');
      await cdpClickPoint(page, archiveDrawerPt, 'left');

      await page.waitForText(targetTitle, {
        selector: '[data-testid="chat-sidebar"]',
        timeoutMs: 6000,
      });

      // 5. Unarchive -> returns to main dialog list
      await rightClickTarget();
      await clickMenuItemMatching(page, /unarchive|取消归档|移出归档/i, 'Unarchive');
      await pollUntil(
        async () => (await ctx.primaryUser.api.getChat(chatId)).is_archived === false,
        { timeoutMs: 5000, message: 'Unarchive persisted to /api/v1/chats/{id}/archive' },
      );
    });
  },
});
