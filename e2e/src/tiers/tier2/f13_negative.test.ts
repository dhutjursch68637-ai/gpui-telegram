import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function openChatByTitleInWorkspace(page: CdpPageHandle, title: string): Promise<void> {
  await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
  await page.waitForText(title, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });
  await page.eval((targetTitle: string) => {
    const sb = document.querySelector('[data-testid="chat-sidebar"]');
    if (!sb) return;
    const leaf = Array.from(sb.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent ?? '').includes(targetTitle),
    );
    (leaf?.closest('[data-chat-id], [role="listitem"], button, li, div') as HTMLElement | null)?.click();
  }, title);
}

defineTest({
  id: 'T2-F13-01',
  title: 'Markdown/HTML message containing <script>, javascript: link, and <img onerror> is sanitized in conversation-stage',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const roomTitle = 'XSS Card Sanitizer Room 1301';
    const room = await ctx.primaryUser.api.createChat({
      title: roomTitle,
      chat_type: 'group',
    });
    const chatId = Number(room.chat_id ?? room.id);

    const xssPayload =
      '<script>window.__xss_msg=1</script>[click_xss](javascript:window.__xss_link=1)<img src=x onerror=window.__xss_img=1> SafeRenderedTail_1301';

    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: xssPayload,
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, roomTitle);
        await page.waitForText('SafeRenderedTail_1301', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });

        // Attempt clicking any anchor rendered for [click_xss] to ensure javascript: URI is neutralized
        await page.eval(() => {
          const stage = document.querySelector('[data-testid="conversation-stage"]');
          if (!stage) return;
          const anchor = Array.from(stage.querySelectorAll('a')).find((a) =>
            (a.textContent ?? '').includes('click_xss'),
          );
          anchor?.click();
        });
        await sleep(150);

        const audit = await page.eval(() => {
          const w = window as any;
          const stage = document.querySelector('[data-testid="conversation-stage"]');
          const jsAnchors = stage
            ? Array.from(stage.querySelectorAll('a')).filter((a) =>
                (a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:'),
              ).length
            : 0;
          const scriptTags = stage ? stage.querySelectorAll('script').length : 0;
          const onerrorImgs = stage ? stage.querySelectorAll('img[onerror]').length : 0;
          return {
            xssMsg: w.__xss_msg,
            xssLink: w.__xss_link,
            xssImg: w.__xss_img,
            jsAnchors,
            scriptTags,
            onerrorImgs,
          };
        });

        assert.equal(audit.xssMsg, undefined, 'window.__xss_msg must remain undefined');
        assert.equal(audit.xssLink, undefined, 'window.__xss_link must remain undefined');
        assert.equal(audit.xssImg, undefined, 'window.__xss_img must remain undefined');
        assert.equal(audit.jsAnchors, 0, 'Zero javascript: href anchors allowed in conversation-stage');
        assert.equal(audit.scriptTags, 0, 'Zero <script> elements allowed inside conversation-stage');
        assert.equal(audit.onerrorImgs, 0, 'Zero <img onerror=...> attributes allowed in conversation-stage');
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F13-02',
  title: 'Assistant message with unclosed <think> and [STATE_PATCH] routes reasoning to thinking-bubble and strips internal patch tags',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    ctx.mockLlm.registerScenario('t2_f13_unclosed_think', () => ({
      content: '<think>Partial reasoning before abort',
    }));
    ctx.mockLlm.registerScenario('t2_f13_state_patch', () => ({
      reasoning: 'Internal reasoning block',
      content:
        '[STATE_PATCH]{"internal":true,"secret_cursor":991}[/STATE_PATCH]Visible sanitized answer 1302',
    }));

    // Trigger both assistant replies into officialBotChatId via Hermes turns delivered to chat
    await ctx.primaryUser.api.createHermesTurn({
      prompt: '[E2E_SCENARIO:t2_f13_unclosed_think] Test unclosed think block',
      chat_id: ctx.primaryUser.officialBotChatId,
      bot_id: 777000,
      deliver_to_chat: true,
    });
    await ctx.primaryUser.api.createHermesTurn({
      prompt: '[E2E_SCENARIO:t2_f13_state_patch] Test state patch stripping',
      chat_id: ctx.primaryUser.officialBotChatId,
      bot_id: 777000,
      deliver_to_chat: true,
    });

    // Also ensure raw unclosed <think> + [STATE_PATCH] message rendering is tested directly in stage
    const room = await ctx.primaryUser.api.createChat({
      title: 'Think & StatePatch Stage Room',
      chat_type: 'group',
    });
    const roomChatId = Number(room.chat_id ?? room.id);
    await ctx.primaryUser.api.sendMessage({
      chat_id: roomChatId,
      text: '<think>Partial reasoning before abort',
    });
    await ctx.primaryUser.api.sendMessage({
      chat_id: roomChatId,
      text: '<think>Completed thought</think>[STATE_PATCH]{"internal":true}[/STATE_PATCH]Visible answer 1302',
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, 'Think & StatePatch Stage Room');
        await page.waitForText('Visible answer 1302', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });

        const stageCheck = await page.eval(() => {
          const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
          const thinkingBubbles = Array.from(
            document.querySelectorAll('[data-testid="thinking-bubble"]'),
          ) as HTMLElement[];
          const messageBubbles = Array.from(
            document.querySelectorAll('[data-testid="message-bubble"]'),
          ) as HTMLElement[];

          const visibleTexts = messageBubbles.map((b) => b.innerText || '');
          const stageText = stage?.innerText ?? '';
          return {
            thinkingCount: thinkingBubbles.length,
            hasStatePatchLeak:
              stageText.includes('[STATE_PATCH]') ||
              stageText.includes('[/STATE_PATCH]') ||
              stageText.includes('"internal":true'),
            hasRawThinkTagLeak: stageText.includes('<think>') || stageText.includes('</think>'),
            hasVisibleAnswer: visibleTexts.some((t) => t.includes('Visible answer 1302')) || stageText.includes('Visible answer 1302'),
          };
        });

        assert.ok(
          stageCheck.thinkingCount >= 1,
          'Unclosed <think> must route into [data-testid="thinking-bubble"]',
        );
        assert.equal(
          stageCheck.hasStatePatchLeak,
          false,
          '[STATE_PATCH]...[/STATE_PATCH] metadata must be stripped from visible bubble text',
        );
        assert.equal(
          stageCheck.hasRawThinkTagLeak,
          false,
          'Raw <think> XML tags must not leak into visible conversation-stage text',
        );
        assert.equal(stageCheck.hasVisibleAnswer, true);
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(roomChatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F13-03',
  title: 'Whitespace-only message ("   \\n  ") is ignored and 16,000-char Markdown paste clamps composer height <=192px without UI freeze',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const roomTitle = 'Composer Bounds Room 1303';
    const room = await ctx.primaryUser.api.createChat({
      title: roomTitle,
      chat_type: 'group',
    });
    const chatId = Number(room.chat_id ?? room.id);

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, roomTitle);
        await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });

        const beforeMsgs = await ctx.primaryUser.api.getMessages(chatId);
        const initialMsgCount = beforeMsgs.messages.length;

        // 1. Attempt sending whitespace-only input "   \n  "
        await page.typeTestId('canonical-composer-input', '   \n  ', { clearFirst: true });
        await page.pressKey('Enter');
        const sendBtn = await page.querySelector('[data-testid="composer-send-btn"]');
        if (sendBtn && !sendBtn.disabled) {
          await page.clickTestId('composer-send-btn');
        }
        await sleep(300);

        const afterWhitespaceMsgs = await ctx.primaryUser.api.getMessages(chatId);
        assert.equal(
          afterWhitespaceMsgs.messages.length,
          initialMsgCount,
          'Whitespace-only input ("   \\n  ") must NOT create an empty message bubble',
        );

        // 2. Paste a 16,000+ character multi-line Markdown document
        const line = '## Section Header — Deterministic Multi-Line Markdown Specification Entry Item 1234567890';
        const lines: string[] = [];
        while (lines.join('\n').length < 16200) {
          lines.push(`${line} (#${lines.length + 1})`);
        }
        const longMarkdown = lines.join('\n');
        assert.ok(longMarkdown.length >= 16000);

        await page.eval((docText: string) => {
          const el = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLTextAreaElement | HTMLInputElement | HTMLElement;
          el.focus();
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            const proto =
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, docText);
            else el.value = docText;
          } else {
            el.textContent = docText;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, longMarkdown);
        await sleep(150);

        const composerMetrics = await page.eval(() => {
          const el = document.querySelector(
            '[data-testid="canonical-composer-input"]',
          ) as HTMLElement;
          const r = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          const parentCs = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
          return {
            height: r.height,
            scrollHeight: el.scrollHeight,
            overflowY: cs.overflowY,
            parentOverflowY: parentCs?.overflowY ?? '',
          };
        });

        assert.ok(
          composerMetrics.height <= 196,
          `Expected 16,000-char paste to clamp canonical-composer-input height <= 192px (+border), got ${composerMetrics.height}px`,
        );
        assert.ok(
          composerMetrics.overflowY === 'auto' ||
            composerMetrics.overflowY === 'scroll' ||
            composerMetrics.parentOverflowY === 'auto' ||
            composerMetrics.parentOverflowY === 'scroll',
          `Expected scrollable overflow-y on clamped composer, got ${JSON.stringify(composerMetrics)}`,
        );

        // Send/chunk the 16,000-char document and verify UI main thread stays responsive
        await page.clickTestId('composer-send-btn');
        const responsiveStart = Date.now();
        const pingVal = await page.eval(() => 21 * 2);
        assert.equal(pingVal, 42);
        assert.ok(
          Date.now() - responsiveStart < 1500,
          'Main thread must remain responsive when sending/chunking 16,000-char message',
        );

        await pollUntil(
          async () => {
            const afterLong = await ctx.primaryUser.api.getMessages(chatId);
            return afterLong.messages.length > initialMsgCount;
          },
          { timeoutMs: 8000, intervalMs: 120, message: '16,000-char Markdown message delivered/chunked' },
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F13-04',
  title: 'Closing a Poll via /api/v1/polls/{poll_id}/close disables/rejects subsequent vote without corrupting displayed tally',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const roomTitle = 'Closed Poll Guard Room 1304';
    const room = await ctx.primaryUser.api.createChat({
      title: roomTitle,
      chat_type: 'group',
    });
    const chatId = Number(room.chat_id ?? room.id);

    const createdPoll = await ctx.primaryUser.api.createPoll(chatId, {
      question: 'Deploy Friday Release Freeze?',
      options: ['Ship Now', 'Hold Until Monday'],
      is_anonymous: true,
    });
    const pollObj = createdPoll.poll ?? createdPoll;
    const pollId = pollObj.poll_id ?? pollObj.id;
    assert.ok(pollId !== undefined, 'Expected poll_id from createPoll');

    // Cast 1 valid vote for option 0 ("Ship Now") before closing
    await ctx.primaryUser.api.votePoll(pollId, [0]);

    // Close the poll on server
    const closedResp = await ctx.primaryUser.api.closePoll(pollId);
    assert.ok(closedResp);

    // Verify server rejects voting on closed poll via second user
    const voterB = await ctx.createIsolatedUser('t2_f13_voterb');
    const lateVoteResp = await voterB.api.request('POST', `/api/v1/polls/${pollId}/vote`, {
      option_ids: [1],
    });
    assert.ok(
      !lateVoteResp.ok || lateVoteResp.status >= 400 || lateVoteResp.data?.success === false,
      `Voting on a closed poll must be rejected (got HTTP ${lateVoteResp.status}: ${lateVoteResp.rawText})`,
    );

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, roomTitle);
        await page.waitForText('Deploy Friday Release Freeze?', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });

        // Attempt clicking "Hold Until Monday" option inside conversation-stage
        await page.eval(() => {
          const stage = document.querySelector('[data-testid="conversation-stage"]');
          if (!stage) return;
          const optEl = Array.from(stage.querySelectorAll('button, label, div, span')).find((el) =>
            (el.textContent ?? '').includes('Hold Until Monday'),
          ) as HTMLElement | undefined;
          optEl?.click();
        });
        await sleep(350);

        // Verify tally was NOT corrupted on server or UI ("Hold Until Monday" stays 0 votes)
        const hist = await ctx.primaryUser.api.getMessages(chatId);
        const pollMsg = hist.messages.find(
          (m: any) =>
            m?.content?.type === 'Poll' ||
            m?.poll !== undefined ||
            JSON.stringify(m).includes('Deploy Friday Release Freeze?'),
        );
        assert.ok(pollMsg, 'Expected Poll message in history');
        const serverPollData = pollMsg.poll ?? pollMsg.content?.data;
        assert.ok(
          Array.isArray(serverPollData?.options) && serverPollData.options.length >= 2,
          `Expected serverPollData.options array with >= 2 options, got ${JSON.stringify(serverPollData)}`,
        );
        const opt0 = serverPollData.options[0];
        const opt1 = serverPollData.options[1];
        assert.equal(opt0.vote_count, 1, 'Option 0 vote_count must remain 1');
        assert.equal(opt1.vote_count, 0, 'Closed poll Option 1 vote_count must remain 0');
        assert.equal(page.pageExceptions.length, 0);
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F13-05',
  title: 'Media card with 404 file_id and GenerativeCard with unknown/corrupted schema isolate errors without unmounting conversation-stage',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const roomTitle = 'ErrorBoundary Card Isolation 1305';
    const room = await ctx.primaryUser.api.createChat({
      title: roomTitle,
      chat_type: 'group',
    });
    const chatId = Number(room.chat_id ?? room.id);

    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: 'Anchor_Before_Broken_Cards_1305',
    });

    // 1. Media card referencing nonexistent 404 CAS file_id
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'Media',
        data: {
          file_id: '0000000000000000000000000000000000000000000000000000000000000404',
          file_name: 'missing_404_asset.png',
          mime_type: 'image/png',
          size_bytes: 4096,
          width: 640,
          height: 480,
          caption: 'Broken 404 Media Card',
        },
      },
    });

    // 2. GenerativeCard with corrupted/extreme values (or unknown component fallback)
    const corruptGenResp = await ctx.primaryUser.api.request('POST', '/api/v1/messages/send', {
      chat_id: chatId,
      content: {
        type: 'GenerativeCard',
        data: {
          card_id: 'gc_corrupt_1305',
          title: 'Corrupted Generative Schema',
          subtitle: null,
          layout: 'UnknownAlienLayout_v99',
          components: [
            { type: 'UnknownWidgetType', raw_payload: { broken: true } },
            { type: 'Progress', value: -9999, max: 0, label: 'DivideByZeroCheck' },
          ],
          status: 'corrupt_unknown_status',
        },
      },
    });
    if (!corruptGenResp.ok) {
      // Server strict enum deserialization rejected unknown component; send valid wire GenerativeCard with extreme NaN/0-max edge values
      await ctx.primaryUser.api.sendMessage({
        chat_id: chatId,
        content: {
          type: 'GenerativeCard',
          data: {
            card_id: 'gc_corrupt_1305',
            title: 'Corrupted Generative Schema',
            subtitle: '',
            layout: 'UnknownAlienLayout_v99',
            components: [
              { type: 'Progress', value: -9999, max: 0, label: 'ZeroMaxProgress' },
              { type: 'Text', text: '', bold: true, color: 'not-a-valid-css-color(((' },
            ],
            status: 'corrupt_unknown_status',
          },
        },
      });
    }

    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: 'Anchor_After_Broken_Cards_1305',
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, roomTitle);
        await page.waitForText('Anchor_Before_Broken_Cards_1305', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });
        await page.waitForText('Anchor_After_Broken_Cards_1305', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });
        await sleep(300);

        const stageInfo = await page.querySelector('[data-testid="conversation-stage"]');
        assert.ok(
          stageInfo && stageInfo.visible,
          'conversation-stage React tree must remain mounted despite 404 Media & corrupted GenerativeCard',
        );
        assert.equal(
          page.pageExceptions.length,
          0,
          `Expected ErrorBoundary / card isolation to prevent uncaught exceptions, got ${JSON.stringify(page.pageExceptions)}`,
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(chatId).catch(() => undefined);
    }
  },
});

defineTest({
  id: 'T2-F13-06',
  title: 'Attaching @page context pill while active adjacent tab is restricted chrome://version surfaces clean notice without uncaught SW error',
  tier: 2,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    ctx.browser.clearUncaughtExceptions();
    const chromeVersionTab = await ctx.browser.openPage('chrome://version');

    try {
      // Activate the restricted chrome://version tab in Chromium so it is the active browser tab
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return;
        const tabs = await c.tabs.query({});
        const restricted = tabs.find((t: any) => String(t.url ?? '').startsWith('chrome://version'));
        if (restricted?.id !== undefined) {
          await c.tabs.update(restricted.id, { active: true });
        }
      });

      await ctx.withExtensionSurface('sidepanel', async (page) => {
        await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 10000 });

        // Try clicking dedicated @page attach button if visible, AND typing @page in composer
        const clickedAttachBtn = await page.eval(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          const pageBtn = btns.find((b) =>
            /@page|attach.*page|current.*tab|附加.*页面|当前标签/i.test(
              `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`,
            ),
          );
          if (pageBtn) {
            if ((pageBtn as HTMLButtonElement).disabled) {
              return 'disabled';
            }
            pageBtn.click();
            return 'clicked';
          }
          return 'none';
        });

        await page.typeTestId('canonical-composer-input', '@page Summarize this tab', {
          clearFirst: true,
        });
        await sleep(300);

        // Verify restricted chrome:// notice or disabled @page pill AND zero privileged chrome://version leakage
        const sampleRestrictedUiState = () =>
          page.eval(() => {
            const bodyText = document.body.innerText || '';
            const hasRestrictedNotice =
              /restricted|chrome:\/\/|cannot\s*(attach|read|access|control)|unavailable|unsupported|受限|无法(附加|访问|读取)|不支持/i.test(
                bodyText,
              );
            const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const attachBtn = allBtns.find((b) =>
              /@page|attach.*page|current\s*page|当前页面|附加页面/i.test(
                `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''}`,
              ),
            );
            const attachBtnDisabledAfter = Boolean(
              attachBtn &&
                ((attachBtn as HTMLButtonElement).disabled ||
                  attachBtn.getAttribute('aria-disabled') === 'true' ||
                  attachBtn.hasAttribute('disabled')),
            );
            const leakedInternalVersionDom =
              bodyText.includes('Command Line') && bodyText.includes('Executable Path');
            return {
              hasRestrictedNotice,
              attachBtnDisabledAfter,
              leakedInternalVersionDom,
            };
          });

        const uiState = await pollUntil(
          async () => {
            const st = await sampleRestrictedUiState();
            return clickedAttachBtn === 'disabled' ||
              st.attachBtnDisabledAfter ||
              st.hasRestrictedNotice
              ? st
              : null;
          },
          {
            timeoutMs: 5000,
            intervalMs: 100,
            message: '@page control disabled or restricted chrome:// URL notice surfaced',
          },
        );
        assert.ok(uiState, 'Expected non-null restricted UI state');

        assert.equal(
          uiState.leakedInternalVersionDom,
          false,
          '@page must never scrape restricted chrome://version DOM',
        );
        assert.ok(
          clickedAttachBtn === 'disabled' ||
            uiState.attachBtnDisabledAfter ||
            uiState.hasRestrictedNotice,
          `Expected @page control to disable or surface restricted URL notice, got clickedAttachBtn=${clickedAttachBtn}, uiState=${JSON.stringify(uiState)}`,
        );
        assert.equal(
          page.pageExceptions.length,
          0,
          `Expected zero uncaught page exceptions on chrome:// @page attempt, got ${JSON.stringify(page.pageExceptions)}`,
        );
        assert.equal(
          ctx.browser.uncaughtExceptions.length,
          0,
          `Expected zero uncaught Service Worker exceptions on chrome:// @page attempt, got ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
        );
      });
    } finally {
      await chromeVersionTab.close();
    }
  },
});
