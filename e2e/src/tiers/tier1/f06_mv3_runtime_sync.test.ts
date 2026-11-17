import * as fs from 'node:fs';
import {
  assert,
  defineTest,
  pollUntil,
  type SharedTierContext,
} from '../../harness/index.ts';

defineTest({
  id: 'T1-F06-01',
  title: 'Verify MV3 service_worker CDP target, deterministic 32-char extensionId, wasm-unsafe-eval CSP, and registered commands',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    assert.match(
      ctx.browser.extensionId,
      /^[a-p]{32}$/,
      `Expected deterministic 32-char lowercase [a-p] extensionId, got "${ctx.browser.extensionId}"`,
    );

    const diskManifest = JSON.parse(fs.readFileSync(ctx.sutPaths.manifestPath, 'utf-8'));
    assert.equal(diskManifest.manifest_version, 3);
    assert.ok(
      typeof diskManifest.key === 'string' && diskManifest.key.trim().length > 16,
      'Expected deterministic dev "key" in manifest.json',
    );

    const csp = String(diskManifest.content_security_policy?.extension_pages ?? '');
    assert.ok(
      csp.includes("'wasm-unsafe-eval'"),
      `Expected 'wasm-unsafe-eval' in content_security_policy.extension_pages, got: "${csp}"`,
    );
    assert.ok(
      !/(^|[\s;])'unsafe-eval'([\s;]|$)/.test(csp),
      `MV3 extension_pages CSP must NOT contain 'unsafe-eval', got: "${csp}"`,
    );

    const targets = await ctx.browser.listTargets();
    const swTarget = targets.find(
      (t) =>
        t.type === 'service_worker' &&
        t.url.startsWith(`chrome-extension://${ctx.browser.extensionId}/`),
    );
    assert.ok(swTarget, 'Expected active MV3 service_worker target in Chromium CDP');

    const manifestCommandsStr = JSON.stringify(diskManifest.commands ?? {});
    assert.match(
      manifestCommandsStr,
      /Ctrl\+Shift\+Y/i,
      `Expected Ctrl+Shift+Y command in manifest.json commands: ${manifestCommandsStr}`,
    );
    assert.match(
      manifestCommandsStr,
      /Alt\+Shift\+S/i,
      `Expected Alt+Shift+S command in manifest.json commands: ${manifestCommandsStr}`,
    );

    const runtimeInspection = await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      const rtManifest = c.runtime.getManifest();
      const cmds = c.commands?.getAll ? await c.commands.getAll() : [];
      return {
        manifestVersion: rtManifest.manifest_version,
        commandsCount: Array.isArray(cmds) ? cmds.length : 0,
        commandNames: Array.isArray(cmds) ? cmds.map((cmd: any) => String(cmd.name ?? '')) : [],
      };
    });

    assert.equal(runtimeInspection.manifestVersion, 3);
    assert.ok(
      runtimeInspection.commandsCount >= 2,
      `Expected >= 2 registered chrome.commands in SW, got ${JSON.stringify(runtimeInspection.commandNames)}`,
    );
  },
});

defineTest({
  id: 'T1-F06-02',
  title: 'Receive 3 real-time PtsPush messages over /api/v1/ws and render message-bubble items live in workspace.html',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const bob = await ctx.createIsolatedUser('f06_bob');
    const dm = await bob.api.createChat({
      chat_type: 'direct',
      peer_user_id: ctx.primaryUser.userId,
    });
    const dmChatId = Number(dm.chat_id ?? dm.id);
    assert.ok(dmChatId > 0, 'Expected valid DM chat_id');

    await bob.api.sendMessage({
      chat_id: dmChatId,
      text: 'F06 Seed Greeting',
    });

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 8000 });

      // Click Bob's conversation row in chat-sidebar
      const clickedBob = await pollUntil(
        async () => {
          return await page.eval((peerName: string) => {
            const sidebar = document.querySelector('[data-testid="chat-sidebar"]');
            if (!sidebar) return false;
            const candidates = Array.from(sidebar.querySelectorAll('*')) as HTMLElement[];
            const target = candidates.find(
              (el) =>
                el.children.length <= 6 &&
                (el.innerText || el.textContent || '').toLowerCase().includes(peerName.toLowerCase()),
            );
            if (!target) return false;
            target.click();
            return true;
          }, bob.username);
        },
        { timeoutMs: 6000, intervalMs: 100, message: `Select ${bob.username} row in chat-sidebar` },
      );
      assert.equal(clickedBob, true);

      await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 5000 });

      const realtimeTexts = [
        'F06 Realtime Msg #1',
        'F06 Realtime Msg #2',
        'F06 Realtime Msg #3',
      ];
      for (const text of realtimeTexts) {
        await bob.api.sendMessage({ chat_id: dmChatId, text });
      }

      for (const expectedText of realtimeTexts) {
        await page.waitForText(expectedText, {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 5000,
        });
      }

      const bubbles = await page.querySelectorAll('[data-testid="message-bubble"]');
      assert.ok(
        bubbles.length >= 3,
        `Expected >= 3 rendered [data-testid="message-bubble"] elements, got ${bubbles.length}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F06-03',
  title: 'Verify chrome.storage.local session/bridge state and IndexedDB gpui_telegram_ext_db stores after chat sync',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const peer = await ctx.createIsolatedUser('f06_idb');
    const dm = await peer.api.createChat({
      chat_type: 'direct',
      peer_user_id: ctx.primaryUser.userId,
    });
    const dmChatId = Number(dm.chat_id ?? dm.id);
    await peer.api.sendMessage({
      chat_id: dmChatId,
      text: 'IndexedDB Hydration Verification Record',
    });

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 8000 });

      const persistence = await pollUntil(
        async () => {
          const info = await page.eval(async () => {
            const c = (globalThis as any).chrome;
            const localData = await c.storage.local.get(null);
            const dbs =
              typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
            const hasExtDb = dbs.some((d) => d.name === 'gpui_telegram_ext_db');
            if (!hasExtDb) {
              return null;
            }

            const storeSummary = await new Promise<{
              storeNames: string[];
              totalRecords: number;
            }>((resolve, reject) => {
              const req = indexedDB.open('gpui_telegram_ext_db');
              req.onerror = () => reject(req.error);
              req.onsuccess = () => {
                const db = req.result;
                const names = Array.from(db.objectStoreNames);
                if (names.length === 0) {
                  db.close();
                  resolve({ storeNames: [], totalRecords: 0 });
                  return;
                }
                let totalRecords = 0;
                let remaining = names.length;
                const tx = db.transaction(names, 'readonly');
                for (const name of names) {
                  const countReq = tx.objectStore(name).count();
                  countReq.onsuccess = () => {
                    totalRecords += Number(countReq.result ?? 0);
                    remaining--;
                    if (remaining === 0) {
                      db.close();
                      resolve({ storeNames: names, totalRecords });
                    }
                  };
                  countReq.onerror = () => {
                    remaining--;
                    if (remaining === 0) {
                      db.close();
                      resolve({ storeNames: names, totalRecords });
                    }
                  };
                }
              };
            });

            if (storeSummary.storeNames.length < 2 || storeSummary.totalRecords < 1) {
              return null;
            }
            return { localData, storeSummary };
          });
          return info;
        },
        {
          timeoutMs: 6000,
          intervalMs: 120,
          message: 'IndexedDB gpui_telegram_ext_db populated stores',
        },
      );

      assert.ok(persistence);
      const local = persistence.localData;
      assert.equal(
        String(local.server_url ?? local.serverUrl ?? ''),
        ctx.server.baseUrl,
        'chrome.storage.local must persist server_url',
      );
      assert.ok(
        Boolean(local.token ?? local.auth_token ?? local.session?.token),
        'chrome.storage.local must persist authenticated session token',
      );
      assert.ok(
        Boolean(local.bridge_config ?? local.browser_bridge ?? local.desktop_bridge),
        'chrome.storage.local must persist bridge_config',
      );
      assert.ok(
        persistence.storeSummary.storeNames.length >= 2,
        `Expected >= 2 object stores in gpui_telegram_ext_db, got ${JSON.stringify(persistence.storeSummary.storeNames)}`,
      );
      assert.ok(persistence.storeSummary.totalRecords >= 1);
    });
  },
});

defineTest({
  id: 'T1-F06-04',
  title: 'Verify chrome.alarms keepalive registration and live /api/v1/ws Ping/Pong health in Extension SW',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const alarms = await pollUntil(
      async () => {
        const list = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          return c?.alarms?.getAll ? await c.alarms.getAll() : [];
        });
        return Array.isArray(list) && list.length >= 1 ? list : null;
      },
      { timeoutMs: 4000, intervalMs: 100, message: 'Registered chrome.alarms in Extension SW' },
    );

    assert.ok(alarms && alarms.length >= 1);
    const hasPeriodicKeepalive = alarms.some(
      (a: any) => typeof a.periodInMinutes === 'number' && a.periodInMinutes <= 1,
    );
    assert.equal(
      hasPeriodicKeepalive,
      true,
      `Expected keepalive alarm with periodInMinutes <= 1, got ${JSON.stringify(alarms)}`,
    );

    // Verify /api/v1/ws Ping/Pong roundtrip and uninterrupted Extension Relay WS connectivity
    const ptsWs = await ctx.primaryUser.api.connectPtsWs();
    try {
      const pongPayload = await ptsWs.ping(604201);
      assert.equal(pongPayload.nonce, 604201, 'Expected matching Pong nonce from /api/v1/ws');
    } finally {
      await ptsWs.close();
    }

    const relayStatus = await ctx.primaryUser.api.getBrowserStatus();
    assert.equal(
      Boolean(
        relayStatus.connected ??
          relayStatus.extension_connected ??
          relayStatus.server_relay_connected,
      ),
      true,
      'Extension SW WebSocket bridge must remain connected across keepalive checks',
    );
  },
});

defineTest({
  id: 'T1-F06-05',
  title: 'Update chrome.action unread badge text on incoming message and clear badge when marked read',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.browser.closeExtraTabs();

    // Baseline: mark any existing unread dialogs as read
    const existingChats = await ctx.primaryUser.api.listChats();
    for (const ch of existingChats.chats ?? []) {
      const cid = Number(ch.chat_id ?? ch.id ?? 0);
      const lastId = Number(ch.last_message_id ?? 0);
      if (cid > 0 && Number(ch.unread_count ?? 0) > 0 && lastId > 0) {
        await ctx.primaryUser.api.markRead(cid, lastId).catch(() => undefined);
      }
    }

    const bob = await ctx.createIsolatedUser('f06_badge');
    const dm = await bob.api.createChat({
      chat_type: 'direct',
      peer_user_id: ctx.primaryUser.userId,
    });
    const dmChatId = Number(dm.chat_id ?? dm.id);
    const sent = await bob.api.sendMessage({
      chat_id: dmChatId,
      text: 'Unread Badge Trigger Message',
    });
    const msgId = Number(sent.message_id ?? sent.id ?? 1);

    const unreadBadge = await pollUntil(
      async () => {
        const txt = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          return await c.action.getBadgeText({});
        });
        const clean = String(txt ?? '').trim();
        return clean.length > 0 && clean !== '0' ? clean : null;
      },
      {
        timeoutMs: 5000,
        intervalMs: 80,
        message: 'Non-empty unread badge text in chrome.action.getBadgeText',
      },
    );
    assert.match(
      unreadBadge!,
      /^[1-9]\d*\+?$/,
      `Expected positive unread count badge, got "${unreadBadge}"`,
    );

    // Mark DM chat read and verify badge clears to "" or "0"
    await ctx.primaryUser.api.markRead(dmChatId, msgId);
    // Also notify/open workspace briefly if extension clears badge upon read sync event
    const clearedBadge = await pollUntil(
      async () => {
        const txt = await ctx.browser.evalInServiceWorker(async () => {
          const c = (globalThis as any).chrome;
          return await c.action.getBadgeText({});
        });
        const clean = String(txt ?? '').trim();
        return clean === '' || clean === '0' ? clean : null;
      },
      {
        timeoutMs: 5000,
        intervalMs: 80,
        message: 'Cleared unread badge text after markRead',
      },
    );
    assert.ok(clearedBadge === '' || clearedBadge === '0');
  },
});

defineTest({
  id: 'T1-F06-06',
  title: 'Verify chrome.sidePanel.getPanelBehavior and getOptions configure sidepanel.html cleanly',
  tier: 1,
  features: ['F6'],
  fn: async (ctx: SharedTierContext) => {
    const spCheck = await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      const manifest = c.runtime.getManifest();
      await c.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      const behavior = await c.sidePanel.getPanelBehavior();
      const options = await c.sidePanel.getOptions({});
      return {
        behavior,
        options,
        manifestSidePanelPath: manifest?.side_panel?.default_path ?? null,
      };
    });

    assert.equal(
      spCheck.behavior?.openPanelOnActionClick,
      true,
      `Expected openPanelOnActionClick === true, got ${JSON.stringify(spCheck.behavior)}`,
    );
    const resolvedPath = String(spCheck.options?.path ?? spCheck.manifestSidePanelPath ?? '');
    assert.ok(
      resolvedPath.endsWith('sidepanel.html'),
      `Expected sidepanel path ending with "sidepanel.html", got "${resolvedPath}"`,
    );
    assert.notEqual(spCheck.options?.enabled, false);

    await ctx.withExtensionSurface('sidepanel', async (panel) => {
      const readyState = await panel.eval<string>('document.readyState');
      assert.equal(readyState, 'complete');
      assert.equal(
        panel.pageExceptions.length,
        0,
        `Expected zero uncaught exceptions in sidepanel.html, got ${JSON.stringify(panel.pageExceptions)}`,
      );
    });
  },
});
