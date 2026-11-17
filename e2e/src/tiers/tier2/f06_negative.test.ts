import * as fs from 'node:fs';
import {
  TelegramApiClient,
  assert,
  defineTest,
  pollUntil,
  sleep,
  unwrapBrowserExecResult,
  type CdpPageHandle,
  type IsolatedUserSession,
  type SharedTierContext,
} from '../../harness/index.ts';

async function openChatByTitleInWorkspace(
  page: CdpPageHandle,
  chatTitleSubstring: string,
): Promise<void> {
  await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

  await pollUntil(
    async () => {
      const clicked = await page.eval((needle: string) => {
        const sidebar = document.querySelector('[data-testid="chat-sidebar"]');
        if (!sidebar) return false;
        const candidates = Array.from(
          sidebar.querySelectorAll(
            '[data-chat-id], [data-testid*="chat-row"], [data-testid*="dialog"], li, [role="listitem"], [role="option"], [role="button"], div',
          ),
        ) as HTMLElement[];
        for (const el of candidates) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt.includes(needle) && el.children.length <= 8) {
            const r = el.getBoundingClientRect();
            if (r.width > 20 && r.height > 16 && r.height < 140) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }, chatTitleSubstring);
      return clicked;
    },
    {
      timeoutMs: 10000,
      intervalMs: 120,
      message: `select chat "${chatTitleSubstring}" in chat-sidebar`,
    },
  );
}

defineTest({
  id: 'T2-F06-01',
  title: 'Wake MV3 Service Worker after forced cold-stop, rehydrating storage/IndexedDB session and reconnecting /api/v1/ws + /api/v1/browser/ws',
  tier: 2,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    // Ensure baseline message & storage state exist before stopping SW
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: 'Pre-cold-wake anchor message #f06_01',
    });

    const preStatus = await ctx.primaryUser.api.getBrowserStatus();
    assert.ok(preStatus.connected || preStatus.extension_connected, 'Extension must be connected pre-stop');

    // Force-stop MV3 Service Worker via CDP ServiceWorker.stopAllWorkers
    await ctx.browser.stopServiceWorkerForColdWake();
    assert.equal(ctx.browser.swSessionId, '', 'SW session must be detached after stopServiceWorkerForColdWake');

    // Trigger cold-wake by opening popup.html and attaching to freshly started SW
    await ctx.withExtensionSurface('popup', async (popupPage) => {
      await popupPage.waitForSelector('body', { state: 'attached' });
      const woken = await ctx.browser.wakeServiceWorker(10000);
      assert.ok(woken.targetId.length > 0 && woken.sessionId.length > 0, 'Expected woken SW session');

      // Poll until Extension SW rehydrates session and reconnects Server Relay WS
      await pollUntil(
        async () => {
          const st = await ctx.primaryUser.api.getBrowserStatus().catch(() => null);
          return Boolean(st && (st.connected || st.extension_connected || st.server_relay_connected));
        },
        {
          timeoutMs: 8000,
          intervalMs: 120,
          message: 'Extension /api/v1/browser/ws reconnect after cold wake',
        },
      );

      const hydratedState = await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        const stored = await c.storage.local.get(['token', 'session', 'user_id']);
        let dbNames: string[] = [];
        if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
          const dbs = await indexedDB.databases();
          dbNames = dbs.map((d) => String(d.name ?? '')).filter(Boolean);
        }
        return {
          token: stored.token ?? stored.session?.token ?? null,
          userId: stored.user_id ?? stored.session?.user_id ?? null,
          dbNames,
        };
      });

      assert.equal(hydratedState.token, ctx.primaryUser.token, 'Auth token must survive SW cold-wake');
      assert.equal(hydratedState.userId, ctx.primaryUser.userId, 'User ID must survive SW cold-wake');
    });

    // Verify live browser_status tool execution succeeds post-wake
    const execCheck = await ctx.primaryUser.api.execBrowserTool({
      tool: 'browser_status',
      arguments: {},
    });
    assert.equal(execCheck.status, 200);
    assert.equal(unwrapBrowserExecResult(execCheck.data).ok, true);
  },
});

defineTest({
  id: 'T2-F06-02',
  title: 'Reconcile 3 missed PTS gap messages via get_difference upon MV3 Service Worker cold-wake and render in workspace.html',
  tier: 2,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const bob = await ctx.createIsolatedUser('bob_f06_gap');
    const chatTitle = `ColdWakeGap_${Date.now()}`;
    const createdChat = await bob.api.createChat({
      title: chatTitle,
      chat_type: 'group',
      member_ids: [ctx.primaryUser.userId],
    });
    const chatId = Number(createdChat.chat_id ?? createdChat.id);
    assert.ok(chatId > 0);

    await bob.api.sendMessage({
      chat_id: chatId,
      text: 'Anchor message before SW stop [GAP-0]',
    });
    await sleep(300);

    // Stop MV3 Service Worker so Extension misses real-time WS pushes
    await ctx.browser.stopServiceWorkerForColdWake();

    // Bob sends 3 messages while Extension SW is offline (+3 PTS advance)
    const gapTexts = [
      'Offline missed update #1 [GAP-ONE]',
      'Offline missed update #2 [GAP-TWO]',
      'Offline missed update #3 [GAP-THREE]',
    ];
    for (const t of gapTexts) {
      await bob.api.sendMessage({ chat_id: chatId, text: t });
    }

    // Wake Extension SW and open workspace.html
    await ctx.browser.wakeServiceWorker(10000);
    await ctx.withExtensionSurface('workspace', async (page) => {
      await openChatByTitleInWorkspace(page, chatTitle);

      // Verify all 3 missed messages are reconciled and rendered in strict PTS order
      await pollUntil(
        async () => {
          const stageText = await page.eval(() => {
            const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
            return stage ? stage.innerText || stage.textContent || '' : '';
          });
          return (
            stageText.includes('[GAP-ONE]') &&
            stageText.includes('[GAP-TWO]') &&
            stageText.includes('[GAP-THREE]')
          );
        },
        {
          timeoutMs: 12000,
          intervalMs: 150,
          message: '3 missed gap messages reconciled into workspace.html conversation-stage',
        },
      );

      const stageContent = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
        return stage ? stage.innerText || stage.textContent || '' : '';
      });
      const idx1 = stageContent.indexOf('[GAP-ONE]');
      const idx2 = stageContent.indexOf('[GAP-TWO]');
      const idx3 = stageContent.indexOf('[GAP-THREE]');
      assert.ok(
        idx1 >= 0 && idx1 < idx2 && idx2 < idx3,
        `Expected monotonic PTS order [GAP-ONE] < [GAP-TWO] < [GAP-THREE] in stage`,
      );
    });
  },
});

defineTest({
  id: 'T2-F06-03',
  title: 'Preserve strict monotonic order with zero duplicate bubbles and accurate edit/reaction during rapid 5-message PTS burst',
  tier: 2,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const bob = await ctx.createIsolatedUser('bob_f06_burst');
    const chatTitle = `BurstSync_${Date.now()}`;
    const createdChat = await bob.api.createChat({
      title: chatTitle,
      chat_type: 'group',
      member_ids: [ctx.primaryUser.userId],
    });
    const chatId = Number(createdChat.chat_id ?? createdChat.id);

    await ctx.withExtensionSurface('workspace', async (page) => {
      await openChatByTitleInWorkspace(page, chatTitle);

      // Rapidly fire 5 messages + duplicate client_nonce retry + edit on #3 + reaction on #5
      const dupNonce = 88442211;
      const m1 = await bob.api.sendMessage({ chat_id: chatId, text: 'BurstSeq_M1' });
      const m2 = await bob.api.sendMessage({
        chat_id: chatId,
        text: 'BurstSeq_M2_Unique',
        client_nonce: dupNonce,
      });
      // Re-send M2 with identical client_nonce to test duplicate suppression
      const m2Dup = await bob.api.sendMessage({
        chat_id: chatId,
        text: 'BurstSeq_M2_Unique',
        client_nonce: dupNonce,
      });
      assert.equal(m2Dup.message_id ?? m2Dup.id, m2.message_id ?? m2.id);

      const m3 = await bob.api.sendMessage({ chat_id: chatId, text: 'BurstSeq_M3_Original' });
      const m4 = await bob.api.sendMessage({ chat_id: chatId, text: 'BurstSeq_M4' });
      const m5 = await bob.api.sendMessage({ chat_id: chatId, text: 'BurstSeq_M5' });

      const m3Id = Number(m3.message_id ?? m3.id);
      const m5Id = Number(m5.message_id ?? m5.id);
      assert.ok(Number(m1.message_id ?? m1.id) > 0 && Number(m4.message_id ?? m4.id) > 0);

      await Promise.all([
        bob.api.editMessage(chatId, m3Id, 'BurstSeq_M3_EDITED'),
        bob.api.toggleReaction(chatId, m5Id, '🔥'),
      ]);

      await pollUntil(
        async () => {
          const txt = await page.eval(() => {
            const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
            return stage ? stage.innerText || stage.textContent || '' : '';
          });
          return (
            txt.includes('BurstSeq_M1') &&
            txt.includes('BurstSeq_M2_Unique') &&
            txt.includes('BurstSeq_M3_EDITED') &&
            txt.includes('BurstSeq_M4') &&
            txt.includes('BurstSeq_M5') &&
            txt.includes('🔥')
          );
        },
        {
          timeoutMs: 10000,
          intervalMs: 120,
          message: 'Burst messages + edit + reaction rendered in conversation-stage',
        },
      );

      const transcriptInspection = await page.eval(() => {
        const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement;
        const fullText = stage.innerText || stage.textContent || '';
        const countOccurrences = (sub: string) => fullText.split(sub).length - 1;
        return {
          fullText,
          m1Count: countOccurrences('BurstSeq_M1'),
          m2Count: countOccurrences('BurstSeq_M2_Unique'),
          m3EditedCount: countOccurrences('BurstSeq_M3_EDITED'),
          m3StaleCount: countOccurrences('BurstSeq_M3_Original'),
          m4Count: countOccurrences('BurstSeq_M4'),
          m5Count: countOccurrences('BurstSeq_M5'),
        };
      });

      assert.equal(transcriptInspection.m1Count, 1, 'Expected exact 1 bubble for M1');
      assert.equal(transcriptInspection.m2Count, 1, 'Duplicate M2 must not render twice');
      assert.equal(transcriptInspection.m3EditedCount, 1, 'Edited M3 must render once');
      assert.equal(transcriptInspection.m3StaleCount, 0, 'Unedited M3 text must be replaced');
      assert.equal(transcriptInspection.m4Count, 1, 'Expected exact 1 bubble for M4');
      assert.equal(transcriptInspection.m5Count, 1, 'Expected exact 1 bubble for M5');

      const t = transcriptInspection.fullText;
      assert.ok(
        t.indexOf('BurstSeq_M1') < t.indexOf('BurstSeq_M2_Unique') &&
          t.indexOf('BurstSeq_M2_Unique') < t.indexOf('BurstSeq_M3_EDITED') &&
          t.indexOf('BurstSeq_M3_EDITED') < t.indexOf('BurstSeq_M4') &&
          t.indexOf('BurstSeq_M4') < t.indexOf('BurstSeq_M5'),
        'Messages must appear in strict monotonic PTS sequence',
      );
    });
  },
});

defineTest({
  id: 'T2-F06-04',
  title: 'Queue outgoing message in outbox_queue while isolatedServer is offline and deliver once with client_nonce deduplication on restart',
  tier: 2,
  features: ['F6'],
  timeoutMs: 60000,
  fn: async (ctx: SharedTierContext) => {
    const isoServer = await ctx.spawnIsolatedServer();
    try {
      const anonClient = new TelegramApiClient(isoServer.baseUrl);
      const reg = await anonClient.register({
        username: `alice_outbox_${Date.now()}`,
        password: 'OutboxPassword!2026',
        first_name: 'AliceOutbox',
        auto_welcome: true,
      });
      const aliceApi = new TelegramApiClient(isoServer.baseUrl, reg.token);
      const aliceSession: IsolatedUserSession = {
        userId: reg.user_id,
        username: reg.username,
        password: 'OutboxPassword!2026',
        token: reg.token,
        sessionId: reg.session_id,
        officialBotChatId: 700_000_000 + reg.user_id,
        api: aliceApi,
      };

      const roomTitle = `OutboxRoom_${Date.now()}`;
      const room = await aliceApi.createChat({
        title: roomTitle,
        chat_type: 'group',
      });
      const roomChatId = Number(room.chat_id ?? room.id);

      // Point Extension SW to isoServer
      await ctx.browser.evalInServiceWorker(
        async (srvUrl: string, u: { userId: number; username: string; token: string; sessionId: string }) => {
          const c = (globalThis as any).chrome;
          const sess = {
            user_id: u.userId,
            userId: u.userId,
            username: u.username,
            token: u.token,
            session_id: u.sessionId,
            sessionId: u.sessionId,
            server_url: srvUrl,
            serverUrl: srvUrl,
          };
          await c.storage.local.set({
            server_url: srvUrl,
            serverUrl: srvUrl,
            token: u.token,
            auth_token: u.token,
            user_id: u.userId,
            session: sess,
            auth_session: sess,
            accounts: [{ ...sess, active: true }],
            active_account_id: u.userId,
          });
          for (const fn of ['__gpuiRehydrate', '__rehydrateSession', 'reconnectBridges']) {
            if (typeof (globalThis as any)[fn] === 'function') {
              await (globalThis as any)[fn]().catch(() => undefined);
            }
          }
        },
        isoServer.baseUrl,
        {
          userId: aliceSession.userId,
          username: aliceSession.username,
          token: aliceSession.token,
          sessionId: aliceSession.sessionId,
        },
      );

      await ctx.withExtensionSurface('workspace', async (page) => {
        await openChatByTitleInWorkspace(page, roomTitle);
        await page.waitForTestId('canonical-composer-input', { state: 'visible', timeoutMs: 10000 });

        // Stop isolatedServer before sending message from composer
        isoServer.kill('SIGTERM');
        await pollUntil(() => !isoServer.isRunning(), {
          timeoutMs: 5000,
          intervalMs: 60,
          message: 'isolatedServer stopped for offline outbox test',
        });

        const queuedMarker = `OfflineQueuedMsg_${Date.now()}`;
        await page.typeTestId('canonical-composer-input', queuedMarker, { clearFirst: true });
        const sendBtn = await page.querySelector('[data-testid="composer-send-btn"]');
        if (sendBtn && sendBtn.visible && !sendBtn.disabled) {
          await page.clickTestId('composer-send-btn');
        } else {
          await page.pressKey('Enter');
        }

        await sleep(400);

        // Restart isolatedServer on the exact same port & SQLite DB
        await isoServer.restart();

        // Poll server message history until Extension outbox flushes the queued message
        const deliveredMessages = await pollUntil(
          async () => {
            const hist = await aliceApi.getMessages(roomChatId, { limit: 30 });
            const matches = hist.messages.filter((m: any) =>
              String(m.text ?? m.content?.data?.text ?? '').includes(queuedMarker),
            );
            return matches.length > 0 ? matches : null;
          },
          {
            timeoutMs: 15000,
            intervalMs: 200,
            message: 'Outbox worker flushed queued message after isolatedServer restart',
          },
        );

        assert.equal(
          deliveredMessages!.length,
          1,
          `client_nonce must prevent duplicate outbox delivery, got ${deliveredMessages!.length} copies`,
        );
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
      await isoServer.stop();
    }
  },
});

defineTest({
  id: 'T2-F06-05',
  title: 'Handle 401 invalid_token upon server session revocation by clearing stale auth and redirecting workspace.html to auth-wizard',
  tier: 2,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const tempUser = await ctx.createIsolatedUser('f06_revoked_sess');
    // Create a second admin device session for tempUser so we can revoke tempUser.sessionId
    const secondDeviceLogin = await new TelegramApiClient(ctx.server.baseUrl).login({
      username: tempUser.username,
      password: tempUser.password,
      device_name: 'Session Revoker Device',
    });
    const revokerApi = new TelegramApiClient(ctx.server.baseUrl, secondDeviceLogin.token);

    try {
      await ctx.signInExtensionAs(tempUser);
      ctx.browser.clearUncaughtExceptions();

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

        // Revoke Extension's active session_id on gpui_telegram_server
        const revRes = await revokerApi.revokeSession(tempUser.sessionId);
        assert.equal(revRes.revoked, true);

        // Confirm revoked token now returns HTTP 401 invalid_token
        const checkRevoked = await tempUser.api.request('GET', '/api/v1/auth/me');
        assert.equal(checkRevoked.status, 401);
        assert.ok(/invalid_token|unauthorized/i.test(checkRevoked.rawText));

        // Trigger an authenticated action in workspace.html (composer send or reload) so UI observes 401
        const composer = await page.querySelector('[data-testid="canonical-composer-input"]');
        if (composer && composer.visible) {
          await page.typeTestId('canonical-composer-input', 'Trigger 401 check', {
            clearFirst: true,
            submit: true,
          });
        } else {
          await page.reload();
        }

        // Wait for Extension to gracefully clear stale session and render [data-testid="auth-wizard"]
        const sawWizard = await pollUntil(
          async () => {
            const wiz = await page.querySelector('[data-testid="auth-wizard"]');
            if (wiz && wiz.visible) return true;
            await page.reload().catch(() => undefined);
            const wizAfterReload = await page.querySelector('[data-testid="auth-wizard"]');
            return Boolean(wizAfterReload && wizAfterReload.visible);
          },
          {
            timeoutMs: 10000,
            intervalMs: 250,
            message: 'workspace.html redirects to [data-testid="auth-wizard"] after 401 invalid_token',
          },
        );
        assert.equal(sawWizard, true);

        // Wait briefly to confirm zero uncaught SW crashes or infinite 401 spin
        await sleep(600);
        const swErrors = ctx.browser.uncaughtExceptions.filter(
          (e) => e.targetType === 'service_worker',
        );
        assert.equal(
          swErrors.length,
          0,
          `SW must handle 401 logout cleanly without uncaught errors: ${JSON.stringify(swErrors)}`,
        );
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F06-06',
  title: 'Enforce MV3 CSP inside workspace.html: block eval("1+1") with EvalError while allowing WebAssembly.instantiate under wasm-unsafe-eval',
  tier: 2,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const manifestJson = JSON.parse(fs.readFileSync(ctx.sutPaths.manifestPath, 'utf-8'));
    const extPagesCsp = String(manifestJson?.content_security_policy?.extension_pages ?? '');
    assert.ok(
      extPagesCsp.includes("'wasm-unsafe-eval'"),
      `manifest.json extension_pages CSP must include 'wasm-unsafe-eval', got: ${extPagesCsp}`,
    );
    assert.ok(
      !/(^|[\s;])'unsafe-eval'([\s;]|$)/.test(extPagesCsp),
      `manifest.json extension_pages CSP must NOT allow 'unsafe-eval', got: ${extPagesCsp}`,
    );

    await ctx.withExtensionSurface('workspace', async (page) => {
      // 1. Verify dynamic JS eval("1+1") and new Function("return 42;") are strictly blocked by MV3 CSP
      // Explicitly pass allowUnsafeEvalBlockedByCSP: false so CDP Runtime.evaluate honors MV3 page CSP instead of bypassing it!
      const evalProbeExpression = `(() => {
        let evalBlocked = false;
        let evalErrorName = '';
        let evalErrorMessage = '';
        try {
          (0, eval)('1+1');
        } catch (err) {
          evalBlocked = true;
          evalErrorName = String(err?.name ?? '');
          evalErrorMessage = String(err?.message ?? err);
        }

        let fnBlocked = false;
        let fnErrorName = '';
        try {
          const fn = new Function('return 42;');
          fn();
        } catch (err) {
          fnBlocked = true;
          fnErrorName = String(err?.name ?? '');
        }

        return { evalBlocked, evalErrorName, evalErrorMessage, fnBlocked, fnErrorName };
      })()`;

      const rawCspEvalRes = await page.cdp.send<{
        result?: { value?: {
          evalBlocked: boolean;
          evalErrorName: string;
          evalErrorMessage: string;
          fnBlocked: boolean;
          fnErrorName: string;
        } };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        'Runtime.evaluate',
        {
          expression: evalProbeExpression,
          returnByValue: true,
          awaitPromise: true,
          allowUnsafeEvalBlockedByCSP: false,
        },
        page.sessionId,
      );
      assert.equal(
        rawCspEvalRes.exceptionDetails,
        undefined,
        `CSP probe wrapper itself must not throw uncaught exception: ${JSON.stringify(rawCspEvalRes.exceptionDetails)}`,
      );
      const cspEvalProbe = rawCspEvalRes.result?.value;
      assert.ok(cspEvalProbe, 'Expected structured CSP probe result');

      assert.equal(cspEvalProbe.evalBlocked, true, 'eval("1+1") must throw under MV3 CSP');
      assert.equal(cspEvalProbe.evalErrorName, 'EvalError', `Expected EvalError, got ${cspEvalProbe.evalErrorName}`);
      assert.ok(
        /Refused to evaluate|unsafe-eval|Content Security Policy/i.test(cspEvalProbe.evalErrorMessage),
        `Expected CSP EvalError message, got: ${cspEvalProbe.evalErrorMessage}`,
      );
      assert.equal(cspEvalProbe.fnBlocked, true, 'new Function() must also be blocked under MV3 CSP');
      assert.equal(cspEvalProbe.fnErrorName, 'EvalError', `Expected EvalError from new Function(), got ${cspEvalProbe.fnErrorName}`);

      // 2. Verify WebAssembly.instantiate succeeds under the exact same strict allowUnsafeEvalBlockedByCSP: false enforcement ('wasm-unsafe-eval')
      const rawWasmCspRes = await page.cdp.send<{
        result?: { value?: { instantiated: boolean; hasInvokeExport: boolean } };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            const c = globalThis.chrome;
            const url = c?.runtime?.getURL
              ? c.runtime.getURL('assets/gpui_telegram_ext_wasm.wasm')
              : new URL('assets/gpui_telegram_ext_wasm.wasm', window.location.href).href;
            const resp = await fetch(url);
            const bytes = await resp.arrayBuffer();
            const instantiated = await WebAssembly.instantiate(bytes, {});
            const instance = instantiated.instance ?? instantiated;
            return {
              instantiated: Boolean(instance),
              hasInvokeExport: typeof instance.exports?.wasm_invoke_json === 'function',
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
          allowUnsafeEvalBlockedByCSP: false,
        },
        page.sessionId,
      );
      assert.equal(
        rawWasmCspRes.exceptionDetails,
        undefined,
        `WebAssembly.instantiate must succeed under 'wasm-unsafe-eval' with allowUnsafeEvalBlockedByCSP: false: ${JSON.stringify(rawWasmCspRes.exceptionDetails)}`,
      );
      assert.equal(rawWasmCspRes.result?.value?.instantiated, true);
      assert.equal(rawWasmCspRes.result?.value?.hasInvokeExport, true);

      const wasmInspect = await page.inspectWasm();
      assert.ok(wasmInspect.exports.includes('wasm_invoke_json'));
      const wasmRes = await page.invokeWasm('html_to_markdown', {
        html: '<p>WASM allowed under MV3 CSP</p>',
      });
      assert.equal(wasmRes.ok, true);
    });
  },
});
