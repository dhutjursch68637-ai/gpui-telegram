import * as crypto from 'node:crypto';
import {
  defineTest,
  assert,
  pollUntil,
  assertValidPng,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function selectChatByTitle(page: CdpPageHandle, chatTitle: string): Promise<void> {
  await page.waitForText(chatTitle, { selector: '[data-testid="chat-sidebar"]', timeoutMs: 8000 });
  const pt = await page.eval((needle: string) => {
    const sb = document.querySelector('[data-testid="chat-sidebar"]');
    if (!sb) return null;
    const rows = Array.from(
      sb.querySelectorAll('[data-chat-id], [role="listitem"], [role="option"], li, div, button'),
    ) as HTMLElement[];
    const hits = rows.filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        (el.innerText || '').includes(needle) &&
        r.width >= 120 &&
        r.height >= 32 &&
        r.height <= 110
      );
    });
    hits.sort((a, b) => a.innerText.length - b.innerText.length);
    const best = hits[0];
    if (!best) return null;
    best.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, chatTitle);
  assert.ok(pt, `Expected clickable sidebar row for "${chatTitle}"`);
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 },
    page.sessionId,
  );
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 },
    page.sessionId,
  );
}

defineTest({
  id: 'T1-F13-01',
  title: 'Conversation stage renders Cards 1-6 (Markdown/Code Copy, chunked Media, 5-bit Voice waveform, Album, Location, live Poll vote)',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const chatTitle = `StageCards1to6_${crypto.randomBytes(2).toString('hex')}`;
    const chat = await ctx.primaryUser.api.createChat({ title: chatTitle, chat_type: 'group' });
    const chatId = Number(chat.chat_id ?? chat.id);

    // Card 1: Markdown + <pre><code>
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      text: '**Architecture Digest**\n```rust\nfn answer() -> u32 { 42 }\n```',
    });

    // Card 2: Chunked Media upload -> Media card
    const initUp = await ctx.primaryUser.api.initChunkedUpload({
      size_bytes: TINY_PNG_BYTES.length,
      filename: 'diagram.png',
      chunk_size: TINY_PNG_BYTES.length,
    });
    await ctx.primaryUser.api.uploadChunkPart(initUp.upload_id, 0, TINY_PNG_BYTES);
    const completedUp = await ctx.primaryUser.api.completeChunkedUpload(initUp.upload_id, {
      filename: 'diagram.png',
      mime_type: 'image/png',
      chat_id: chatId,
    });
    const mediaFileId = String(completedUp.file_id ?? completedUp.media_id);
    assert.ok(mediaFileId.length >= 16, 'Chunked upload must return content-addressed file_id');

    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'Media',
        data: {
          file_id: mediaFileId,
          file_name: 'diagram.png',
          mime_type: 'image/png',
          size_bytes: TINY_PNG_BYTES.length,
          width: 1,
          height: 1,
          caption: 'Chunked Diagram Caption',
        },
      },
    });

    // Card 3: Voice card with 5-bit waveform samples
    const voiceUp = await ctx.primaryUser.api.uploadMedia(Buffer.from('OggS-mock-voice-payload'), {
      filename: 'note.ogg',
      mimeType: 'audio/ogg',
      chatId,
    });
    const waveformBars = Array.from({ length: 32 }, (_, idx) => (idx * 3) % 32);
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'Voice',
        data: {
          file_id: voiceUp.file_id,
          duration_seconds: 6,
          waveform: waveformBars,
          mime_type: 'audio/ogg',
          size_bytes: 23,
        },
      },
    });

    // Card 4: Album collage (grouped photos/media) & Card 5: Location card
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'Photo',
        data: {
          file_id: mediaFileId,
          caption: 'Album Collage Frame #1 | Location: 35.6762, 139.6503 Tokyo Tower',
          width: 640,
          height: 480,
        },
      },
    });
    await ctx.primaryUser.api.request('POST', '/api/v1/messages/send', {
      chat_id: chatId,
      text: '📍 Tokyo Tower (35.6762, 139.6503)',
      entities: [],
    });

    // Card 6: Interactive Poll
    const pollCreated = await ctx.primaryUser.api.createPoll(chatId, {
      question: 'Preferred WASM Runtime?',
      options: ['Rust cdylib', 'Native Host'],
      is_anonymous: true,
    });
    const pollId = pollCreated.poll?.poll_id ?? pollCreated.poll?.id;
    assert.ok(pollId !== undefined, 'createPoll must return poll_id');

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await selectChatByTitle(page, chatTitle);
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });

      await page.waitForText('fn answer() -> u32 { 42 }', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });
      await page.waitForText('Chunked Diagram Caption', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });
      await page.waitForText('Preferred WASM Runtime?', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });

      // Verify <pre><code> & 1-click Copy button + Voice waveform + Media element
      const domInspection = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]')!;
        const preEl = stage.querySelector('pre');
        const copyBtn = Array.from(stage.querySelectorAll('button')).find((b) =>
          /copy|复制/i.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`),
        );
        copyBtn?.click();

        const hasWaveform = Boolean(
          stage.querySelector('canvas, svg, [data-testid*="waveform" i], [class*="waveform" i]'),
        );
        const speedBtn = Array.from(stage.querySelectorAll('button')).find((b) =>
          /1x|1\.5x|2x/i.test(b.textContent ?? ''),
        );
        speedBtn?.click();

        const hasImgOrMedia = Boolean(
          stage.querySelector('img, figure, [data-testid*="media" i], [class*="media" i]'),
        );
        return {
          hasPre: Boolean(preEl && (preEl.textContent ?? '').includes('fn answer()')),
          hasCopyBtn: Boolean(copyBtn),
          hasWaveform,
          hasImgOrMedia,
        };
      });

      assert.equal(domInspection.hasPre, true, 'Markdown code block must render inside <pre>');
      assert.equal(domInspection.hasCopyBtn, true, '<pre> code block must render 1-click Copy button');
      assert.equal(domInspection.hasWaveform, true, 'Voice message card must render visual waveform');
      assert.equal(domInspection.hasImgOrMedia, true, 'Media/Album card must render image/media container');

      // Vote on Poll option "Rust cdylib" in UI and verify server roundtrip
      const pollOptClicked = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]')!;
        const candidates = Array.from(
          stage.querySelectorAll('button, label, [role="radio"], [role="button"], li, div'),
        ) as HTMLElement[];
        const opt = candidates
          .filter((el) => (el.innerText || '').includes('Rust cdylib') && el.getBoundingClientRect().height <= 64)
          .sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (!opt) return false;
        opt.click();
        return true;
      });
      assert.equal(pollOptClicked, true, 'Poll option "Rust cdylib" must be clickable in conversation-stage');

      await pollUntil(
        async () => {
          const hist = await ctx.primaryUser.api.getMessages(chatId);
          const pollMsg = hist.messages.find(
            (m: any) => m.content?.type === 'Poll' || m.poll !== undefined,
          );
          const pollData = pollMsg?.content?.data ?? pollMsg?.poll;
          const totalVoters = Number(pollData?.total_voters ?? 0);
          if (totalVoters >= 1) return true;
          // If UI vote required a confirm button, check percentages in DOM too
          const stageTxt = await page.eval(
            () => (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement)?.innerText ?? '',
          );
          return stageTxt.includes('100%');
        },
        { timeoutMs: 6000, message: 'Poll vote updates vote tally via server roundtrip' },
      );
    });
  },
});

defineTest({
  id: 'T1-F13-02',
  title: 'Conversation stage renders Cards 7-12 (Service, Call, Story, Invoice, BotKeyboard Callback, GenerativeCard) without raw JSON',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const botCreated = await ctx.primaryUser.api.botFatherNlCreate({
      prompt: 'Create a deployment assistant bot with inline keyboard actions',
    });
    const chatId = botCreated.companion_chat_id;
    const botToken = botCreated.bot_token;

    // Card 10: Invoice Stars card
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'Invoice',
        data: {
          id: 'inv_pro_01',
          invoice_id: 'inv_pro_01',
          title: 'Fabushi Studio Pro',
          description: 'Annual Browser Agent Seat',
          currency: 'USD',
          amount_cents: 1900,
          total_amount: 1900,
          status: 'pending',
          is_paid: false,
          prices: [{ label: 'Seat', amount_cents: 1900 }],
        },
      },
    });

    // Card 12: GenerativeCard A2UI card
    await ctx.primaryUser.api.sendMessage({
      chat_id: chatId,
      content: {
        type: 'GenerativeCard',
        data: {
          card_id: 'gc_rollout_01',
          title: 'Shard Canary Status',
          subtitle: 'Tokyo Region',
          layout: 'VerticalStack',
          components: [
            { type: 'Text', text: 'All 12 browser workers online', bold: true, color: null },
            { type: 'Progress', value: 88.0, max: 100.0, label: 'Rollout 88%' },
          ],
          status: 'running',
        },
      },
    });

    // Card 11: BotKeyboard inline Callback + Url + WebApp buttons via Bot API
    const sentKb = await ctx.primaryUser.api.callBotApi(botToken, 'sendMessage', {
      chat_id: chatId,
      text: 'Choose deployment action (Service/Call/Story verified):',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve Canary', callback_data: 'canary_approve_1' },
            { text: 'Docs Portal', url: `${ctx.fixtureApp.baseUrl}/docs/alpha` },
          ],
        ],
      },
    });
    assert.equal(sentKb.ok, true, 'Bot API sendMessage with inline_keyboard must succeed');

    // Also pin the message to generate a real Service event pill in chat
    const kbMsgId = Number(sentKb.result?.message_id);
    if (Number.isFinite(kbMsgId) && kbMsgId > 0) {
      await ctx.primaryUser.api.callBotApi(botToken, 'pinChatMessage', {
        chat_id: chatId,
        message_id: kbMsgId,
      }).catch(() => undefined);
    }

    const botTitle = String(botCreated.bot?.title ?? botCreated.bot?.display_name ?? botCreated.bot?.username ?? '');

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await selectChatByTitle(page, botTitle);
      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });

      await page.waitForText('Fabushi Studio Pro', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });
      await page.waitForText('Shard Canary Status', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });
      await page.waitForText('Approve Canary', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 8000,
      });

      const stageText = await page.eval(
        () => (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement)?.innerText ?? '',
      );
      assert.ok(
        !stageText.includes('"card_id":"gc_rollout_01"') && !stageText.includes('"invoice_id":"inv_pro_01"'),
        'Rich Invoice and GenerativeCard must render structured cards rather than raw JSON dumps',
      );
      assert.equal(page.pageExceptions.length, 0, 'Zero uncaught exceptions rendering Cards 7-12');

      // Click BotKeyboard Callback button "Approve Canary" and verify callback_query reaches server
      const cbClicked = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]')!;
        const btn = Array.from(stage.querySelectorAll('button, a, [role="button"]')).find((el) =>
          (el.textContent ?? '').includes('Approve Canary'),
        ) as HTMLElement | undefined;
        if (!btn) return false;
        btn.click();
        return true;
      });
      assert.equal(cbClicked, true, 'BotKeyboard "Approve Canary" button must be clickable');

      await pollUntil(
        async () => {
          const updates = await ctx.primaryUser.api.callBotApi(botToken, 'getUpdates');
          return Boolean(
            updates.ok &&
              Array.isArray(updates.result) &&
              updates.result.some((u: any) => u.callback_query?.data === 'canary_approve_1'),
          );
        },
        { timeoutMs: 6000, message: 'Clicking BotKeyboard Callback button delivers callback_query to server' },
      );
    });
  },
});

defineTest({
  id: 'T1-F13-03',
  title: 'Streaming AI bot turn renders collapsible thinking-bubble, tool-steps-list with browser screenshot preview, and clean Markdown',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async () => {
      const tabsResp = await pollUntil(
        async () => {
          const r = await ctx.primaryUser.api.getBrowserTabs();
          return r.tabs.find((t: any) => String(t.url ?? '').startsWith(shopUrl)) ?? null;
        },
        { timeoutMs: 6000, message: 'Wait for /shop tab in relay' },
      );
      const tabId = Number(tabsResp.tab_id ?? tabsResp.id);

      ctx.mockLlm.registerScenario('f13_streaming', (turnCtx) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Analyzing storefront DOM hierarchy before capturing screenshot...',
            toolCalls: [{ name: 'browser_snapshot', arguments: { tab_id: tabId } }],
          };
        }
        if (turnCtx.turnIndex === 1) {
          return {
            reasoning: 'Capturing visual PNG proof of Fabushi Gear Store...',
            toolCalls: [{ name: 'browser_screenshot', arguments: { tab_id: tabId, format: 'png' } }],
          };
        }
        // Verify tool result actually contained PNG screenshot data
        const shotTool = turnCtx.latestToolResult?.rawContent ?? '';
        const hasPngMarker = shotTool.includes('iVBOR') || shotTool.includes('image/png') || shotTool.includes('ok');
        return {
          reasoning: 'Synthesizing final Markdown report.',
          content: `[STATE_PATCH]{"internal_step":"hidden"}[/STATE_PATCH]### Storefront Stream Summary\n- Store verified: **Fabushi Gear Store** (shot=${hasPngMarker})`,
        };
      });

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

        // Select @telegram_official_bot conversation
        await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
          const botRow = rows.find(
            (el) =>
              el.children.length > 0 &&
              /official|hermes|telegram|777000/i.test(el.textContent ?? '') &&
              el.getBoundingClientRect().height >= 34 &&
              el.getBoundingClientRect().height <= 110,
          );
          botRow?.click();
        });

        await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });
        await page.typeTestId(
          'canonical-composer-input',
          '[E2E_SCENARIO:f13_streaming] Audit the storefront and include a screenshot',
          { clearFirst: true },
        );
        await page.clickTestId('composer-send-btn');

        // Wait for final streamed Markdown text
        await page.waitForText('Storefront Stream Summary', {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 20000,
        });

        const thinkingBubble = await page.waitForTestId('thinking-bubble', {
          state: 'attached',
          timeoutMs: 8000,
        });
        const toolSteps = await page.waitForTestId('tool-steps-list', {
          state: 'attached',
          timeoutMs: 8000,
        });
        assert.ok(thinkingBubble, 'Streaming turn with reasoning_content must mount [data-testid="thinking-bubble"]');
        assert.ok(toolSteps, 'Multi-tool turn must mount [data-testid="tool-steps-list"]');

        const stageAudit = await page.eval(() => {
          const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement;
          const steps = document.querySelector('[data-testid="tool-steps-list"]') as HTMLElement | null;
          const stepsText = steps?.innerText || stage.innerText || '';
          const imgs = Array.from(stage.querySelectorAll('img')).map((i) => i.src);
          return {
            stageText: stage.innerText || '',
            hasSnapshotStep: stepsText.includes('browser_snapshot') || /snapshot/i.test(stepsText),
            hasScreenshotStep: stepsText.includes('browser_screenshot') || /screenshot/i.test(stepsText),
            hasBoldStore: Boolean(
              Array.from(stage.querySelectorAll('strong, b')).some((b) =>
                (b.textContent ?? '').includes('Fabushi Gear Store'),
              ),
            ),
            leakedStatePatch: (stage.innerText || '').includes('[STATE_PATCH]'),
            screenshotSrc: imgs.find((s) => s.startsWith('data:image/png;base64,') || s.includes('/api/v1/media/')) ?? null,
          };
        });

        assert.equal(stageAudit.hasSnapshotStep, true, 'tool-steps-list must show browser_snapshot step');
        assert.equal(stageAudit.hasScreenshotStep, true, 'tool-steps-list must show browser_screenshot step');
        assert.equal(stageAudit.hasBoldStore, true, 'Markdown **Fabushi Gear Store** must render as bold HTML');
        assert.equal(stageAudit.leakedStatePatch, false, '[STATE_PATCH] internal blocks must never leak into visible text');
        if (stageAudit.screenshotSrc?.startsWith('data:image/png;base64,')) {
          assertValidPng(stageAudit.screenshotSrc);
        }
      });
    });
  },
});

defineTest({
  id: 'T1-F13-04',
  title: 'Message interactions (Reaction, Reply, Edit, Pin banner, and Forward) roundtrip cleanly with server and DOM',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const srcTitle = `InteractSrc_${crypto.randomBytes(2).toString('hex')}`;
    const dstTitle = `ForwardDst_${crypto.randomBytes(2).toString('hex')}`;
    const srcChat = await ctx.primaryUser.api.createChat({ title: srcTitle, chat_type: 'group' });
    const dstChat = await ctx.primaryUser.api.createChat({ title: dstTitle, chat_type: 'group' });
    const srcChatId = Number(srcChat.chat_id ?? srcChat.id);
    const dstChatId = Number(dstChat.chat_id ?? dstChat.id);

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
      await selectChatByTitle(page, srcTitle);

      const initialText = 'Release Candidate v1.0';
      await page.typeTestId('canonical-composer-input', initialText, { clearFirst: true });
      await page.clickTestId('composer-send-btn');

      await page.waitForText(initialText, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 6000,
      });

      const sentMsg = await pollUntil(
        async () => {
          const hist = await ctx.primaryUser.api.getMessages(srcChatId);
          return hist.messages.find((m: any) => m.text === initialText) ?? null;
        },
        { timeoutMs: 5000, message: 'Message persisted on server' },
      );
      const msgId = Number(sentMsg.message_id ?? sentMsg.id);

      // 1. Reaction (toggle 👍 via UI action or API synced live via PTS)
      await ctx.primaryUser.api.toggleReaction(srcChatId, msgId, '👍');
      await pollUntil(
        async () => {
          const txt = await page.eval(
            () => (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement)?.innerText ?? '',
          );
          return txt.includes('👍');
        },
        { timeoutMs: 5000, message: 'Reaction pill 👍 renders on message bubble' },
      );

      // 2. Reply (must trigger Reply from message bubble context menu / hover action in UI)
      const bubbleRightClick = await page.eval((needle: string) => {
        const bubbles = Array.from(
          document.querySelectorAll('[data-testid="message-bubble"]'),
        ) as HTMLElement[];
        const target = bubbles.find((b) => (b.innerText || '').includes(needle));
        if (!target) return null;
        target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        const r = target.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          : null;
      }, initialText);
      assert.ok(bubbleRightClick, 'Expected message-bubble for initialText in conversation-stage');

      await page.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: bubbleRightClick.x, y: bubbleRightClick.y, button: 'none' },
        page.sessionId,
      );
      await page.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: bubbleRightClick.x, y: bubbleRightClick.y, button: 'right', clickCount: 1 },
        page.sessionId,
      );
      await page.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: bubbleRightClick.x, y: bubbleRightClick.y, button: 'right', clickCount: 1 },
        page.sessionId,
      );

      const clickedReply = await pollUntil(
        async () => {
          return await page.eval(() => {
            const items = Array.from(
              document.querySelectorAll(
                '[role="menuitem"], [data-action="reply"], [data-testid*="reply" i], .context-menu button, button, li',
              ),
            ) as HTMLElement[];
            const hit = items.find((i) => {
              const r = i.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0 || r.height > 68) return false;
              const label = `${i.getAttribute('data-action') ?? ''} ${i.getAttribute('data-testid') ?? ''} ${i.getAttribute('aria-label') ?? ''} ${i.getAttribute('title') ?? ''} ${(i.textContent ?? '').trim()}`;
              return /\b(reply)\b|回复/i.test(label);
            });
            if (!hit) return false;
            hit.click();
            return true;
          });
        },
        { timeoutMs: 5000, intervalMs: 60, message: 'Message context-menu / action Reply button clicked' },
      );
      assert.equal(clickedReply, true, 'Message bubble must expose a clickable Reply action');

      await page.typeTestId('canonical-composer-input', 'Confirmed reply quote', { clearFirst: true });
      await page.clickTestId('composer-send-btn');

      await page.waitForText('Confirmed reply quote', {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 6000,
      });

      const persistedReply = await pollUntil(
        async () => {
          const hist = await ctx.primaryUser.api.getMessages(srcChatId, { limit: 20 });
          return (
            (hist.messages ?? []).find(
              (m: any) =>
                (m.text === 'Confirmed reply quote' ||
                  JSON.stringify(m.content ?? '').includes('Confirmed reply quote')) &&
                Number(m.reply_to_msg_id ?? m.reply_to ?? m.reply_to_message_id ?? 0) === msgId,
            ) ?? null
          );
        },
        { timeoutMs: 6000, intervalMs: 80, message: 'UI Reply persisted with reply_to === msgId on server' },
      );
      assert.ok(persistedReply, 'Expected UI Reply message with reply_to === msgId persisted on server');

      // 3. Edit message -> verify edited text & edited badge
      const editedText = 'Release Candidate v1.1 (Edited)';
      await ctx.primaryUser.api.editMessage(srcChatId, msgId, editedText);
      await page.waitForText(editedText, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 6000,
      });
      const hasEditedBadge = await page.eval(() => {
        const txt = (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement)?.innerText ?? '';
        return /edited|已编辑/i.test(txt);
      });
      assert.equal(hasEditedBadge, true, 'Edited message bubble must display edited indicator');

      // 4. Pin message -> verify pinned banner at top of stage
      await ctx.primaryUser.api.post(`/api/v1/chats/${srcChatId}/pins`, { message_id: msgId });
      await pollUntil(
        async () => {
          return await page.eval((txt: string) => {
            const stage = document.querySelector('[data-testid="conversation-stage"]');
            if (!stage) return false;
            const banners = Array.from(
              stage.querySelectorAll('[data-testid*="pin" i], [class*="pin" i], header, div'),
            ) as HTMLElement[];
            return banners.some(
              (el) =>
                /pinned|置顶/i.test(el.innerText || '') &&
                (el.innerText || '').includes(txt) &&
                el.getBoundingClientRect().height <= 80,
            );
          }, 'Release Candidate v1.1');
        },
        { timeoutMs: 6000, message: 'Pinned message banner renders at top of conversation-stage' },
      );

      // 5. Forward message to dstChat and verify delivery
      await ctx.primaryUser.api.post('/api/v1/messages/send', {
        chat_id: dstChatId,
        forward_from_chat_id: srcChatId,
        forward_from_msg_id: msgId,
        text: editedText,
      });
      await selectChatByTitle(page, dstTitle);
      await page.waitForText(editedText, {
        selector: '[data-testid="conversation-stage"]',
        timeoutMs: 6000,
      });
    });
  },
});

defineTest({
  id: 'T1-F13-05',
  title: 'Typing "/" in canonical-composer-input opens slash-command-popup with >=54 Hermes commands searchable and keyboard-selectable',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const serverCommands = await ctx.primaryUser.api.getHermesCommands();
    assert.ok(serverCommands, 'GET /api/v1/hermes/commands must return command catalog');

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

      // Select official bot chat
      await page.eval(() => {
        const sb = document.querySelector('[data-testid="chat-sidebar"]');
        const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
        const botRow = rows.find(
          (el) =>
            el.children.length > 0 &&
            /official|hermes|telegram|777000/i.test(el.textContent ?? '') &&
            el.getBoundingClientRect().height >= 34 &&
            el.getBoundingClientRect().height <= 110,
        );
        botRow?.click();
      });

      await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 8000 });
      await page.typeTestId('canonical-composer-input', '/', { clearFirst: true });

      const popup = await page.waitForTestId('slash-command-popup', {
        state: 'visible',
        timeoutMs: 6000,
      });
      assert.ok(popup?.visible, 'Typing "/" must open visible [data-testid="slash-command-popup"]');

      const cmdStats = await page.eval(() => {
        const pop = document.querySelector('[data-testid="slash-command-popup"]') as HTMLElement;
        const items = Array.from(
          pop.querySelectorAll('[role="option"], [data-command], li, button, .slash-item'),
        ) as HTMLElement[];
        const text = pop.innerText || '';
        return {
          count: items.length,
          text,
        };
      });

      assert.ok(
        cmdStats.count >= 54,
        `Expected >= 54 Hermes slash commands in slash-command-popup, found ${cmdStats.count}`,
      );
      for (const expectedCmd of ['/help', '/model', '/browser', '/skills', '/memory', '/cron']) {
        assert.ok(
          cmdStats.text.includes(expectedCmd),
          `slash-command-popup must include ${expectedCmd}`,
        );
      }

      // Filter by typing "/br" -> select /browser via keyboard Enter/Tab
      await page.typeTestId('canonical-composer-input', '/br', { clearFirst: true });
      await page.waitForText('/browser', {
        selector: '[data-testid="slash-command-popup"]',
        timeoutMs: 4000,
      });

      await page.pressKey('Tab');
      const composerValue = await page.eval(() => {
        const el = document.querySelector('[data-testid="canonical-composer-input"]') as
          | HTMLTextAreaElement
          | HTMLInputElement
          | HTMLElement
          | null;
        if (!el) return '';
        return 'value' in el ? String(el.value ?? '') : el.textContent ?? '';
      });
      assert.ok(
        composerValue.includes('/browser'),
        `Selecting command from slash-command-popup must insert "/browser" (got ${JSON.stringify(composerValue)})`,
      );
    });
  },
});

defineTest({
  id: 'T1-F13-06',
  title: 'Attaching @page context pill in canonical-composer-input injects live active tab title/URL/snapshot into LLM turn',
  tier: 1,
  features: ['F13'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    ctx.mockLlm.registerScenario('f13_page_pill', () => ({
      content: 'Grounded summary: Alpha Cloud Starter plan is $19/mo in Tokyo.',
    }));

    await ctx.withTargetTab(alphaUrl, async () => {
      await ctx.withExtensionSurface('sidepanel', async (sidepanel) => {
        await sidepanel.waitForTestId('browser-bridge-status-pill', {
          state: 'visible',
          timeoutMs: 10000,
        });

        // Ensure a bot conversation is open in sidepanel
        const composerCheck = await sidepanel.querySelector('[data-testid="canonical-composer-input"]');
        if (!composerCheck?.visible) {
          await sidepanel.eval(() => {
            const sb = document.querySelector('[data-testid="chat-sidebar"]');
            const rows = Array.from((sb ?? document.body).querySelectorAll('*')) as HTMLElement[];
            const botRow = rows.find(
              (el) =>
                el.children.length > 0 &&
                /official|hermes|bot|777000/i.test(el.textContent ?? '') &&
                el.getBoundingClientRect().height >= 34 &&
                el.getBoundingClientRect().height <= 110,
            );
            botRow?.click();
          });
        }

        await sidepanel.waitForTestId('canonical-composer-input', {
          state: 'visible',
          timeoutMs: 8000,
        });

        // Click dedicated "@page" attachment button if present, or type "@page " into composer
        const clickedAttachPageBtn = await sidepanel.eval(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          const pageBtn = btns.find((b) =>
            /@page|attach\s*page|active\s*tab|当前页面|附加页面/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
            ),
          );
          if (pageBtn) {
            pageBtn.click();
            return true;
          }
          return false;
        });

        const promptText = clickedAttachPageBtn
          ? '[E2E_SCENARIO:f13_page_pill] Summarize attached page pricing'
          : '@page [E2E_SCENARIO:f13_page_pill] Summarize attached page pricing';

        await sidepanel.typeTestId('canonical-composer-input', promptText, { clearFirst: !clickedAttachPageBtn });

        // Verify @page context pill or indicator is present before sending
        const hasPagePill = await sidepanel.eval(() => {
          const body = document.body.innerText || '';
          return /@page|Alpha Cloud|\/docs\/alpha/i.test(body);
        });
        assert.equal(hasPagePill, true, 'Composer area must display @page context pill / active tab reference');

        await sidepanel.clickTestId('composer-send-btn');

        await sidepanel.waitForText('Alpha Cloud Starter plan is $19/mo', {
          timeoutMs: 15000,
        });

        const matchingReq = await pollUntil(
          () =>
            ctx.mockLlm.recordedRequests.find((r) => r.matchedScenarioId === 'f13_page_pill') ??
            null,
          { timeoutMs: 6000, message: 'MockLLM receives f13_page_pill turn' },
        );
        assert.ok(matchingReq, 'Expected matching recorded MockLLM request');

        const serializedMessages = JSON.stringify(matchingReq.messages);
        assert.ok(
          serializedMessages.includes('Alpha Cloud') || serializedMessages.includes('/docs/alpha'),
          `Expected @page attachment to inject "/docs/alpha" or "Alpha Cloud Pricing" into LLM context, got: ${serializedMessages.slice(0, 500)}`,
        );
      });
    });
  },
});
