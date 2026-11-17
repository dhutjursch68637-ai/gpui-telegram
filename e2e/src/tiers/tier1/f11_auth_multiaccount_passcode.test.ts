import * as crypto from 'node:crypto';
import {
  defineTest,
  assert,
  pollUntil,
  TelegramApiClient,
  type SharedTierContext,
  type CdpPageHandle,
} from '../../harness/index.ts';

async function clearExtensionAuthState(ctx: SharedTierContext): Promise<void> {
  await ctx.browser.evalInServiceWorker(async (srvUrl: string) => {
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
      await c.storage.local.set({
        server_url: srvUrl,
        serverUrl: srvUrl,
      });
    }
  }, ctx.server.baseUrl);
}

async function clickCdpElementAt(
  page: CdpPageHandle,
  pt: { x: number; y: number },
): Promise<void> {
  await page.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' },
    page.sessionId,
  );
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
  id: 'T1-F11-01',
  title: 'Unauthenticated workspace.html renders auth-wizard and verifies live server_url connectivity indicator',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    try {
      await clearExtensionAuthState(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        const wizard = await page.waitForTestId('auth-wizard', {
          state: 'visible',
          timeoutMs: 10000,
        });
        assert.ok(wizard && wizard.visible, 'Unauthenticated workspace.html must mount visible [data-testid="auth-wizard"]');

        const sidebarWhileLoggedOut = await page.querySelector('[data-testid="chat-sidebar"]');
        assert.ok(
          !sidebarWhileLoggedOut || !sidebarWhileLoggedOut.visible,
          'chat-sidebar must not be visible before authentication',
        );

        const srvInput = await page.waitForTestId('auth-server-url-input', {
          state: 'visible',
          timeoutMs: 8000,
        });
        assert.ok(srvInput?.visible, 'auth-wizard must expose [data-testid="auth-server-url-input"]');

        await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });

        // Click optional explicit "Check / Test Connection" button inside auth-wizard if present, or blur input
        const checkBtnPt = await page.eval(() => {
          const wiz = document.querySelector('[data-testid="auth-wizard"]');
          if (!wiz) return null;
          const inp = wiz.querySelector('[data-testid="auth-server-url-input"]') as HTMLElement | null;
          inp?.blur();
          const btns = Array.from(wiz.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          const probeBtn = btns.find((b) =>
            /check|test|connect|ping|verify|检测|连接|验证/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
            ) && b.getAttribute('data-testid') !== 'auth-submit-btn',
          );
          if (!probeBtn) return null;
          const r = probeBtn.getBoundingClientRect();
          return r.width > 0
            ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            : null;
        });
        if (checkBtnPt) {
          await clickCdpElementAt(page, checkBtnPt);
        }

        // Verify live backend status endpoint and UI connectivity indicator
        const serverStatus = await ctx.primaryUser.api.request('GET', '/api/v1/status', undefined, {
          token: null,
        });
        assert.equal(serverStatus.status, 200);
        assert.equal(serverStatus.data?.status, 'healthy');

        await pollUntil(
          async () => {
            const wizText = await page.eval(() => {
              const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
              if (!wiz) return '';
              const attrs = Array.from(wiz.querySelectorAll('[data-status], [data-connected], [aria-label]'))
                .map((el) =>
                  `${el.getAttribute('data-status') ?? ''} ${el.getAttribute('data-connected') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
                )
                .join(' ');
              return `${wiz.innerText || ''} ${attrs}`;
            });
            return /connected|online|healthy|ok|reachable|已连接|在线|正常/i.test(wizText);
          },
          {
            timeoutMs: 6000,
            intervalMs: 100,
            message: 'auth-wizard displays healthy server connectivity badge',
          },
        );
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T1-F11-02',
  title: 'Registering a brand-new account through auth-wizard transitions into AppShell and persists valid session token',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const wizUsername = `wiz_${crypto.randomBytes(4).toString('hex')}`;
    const wizPassword = 'WizardUser!2026';

    try {
      await clearExtensionAuthState(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });
        await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });

        // Switch auth-wizard to Register / Create Account mode if toggle exists
        const regTogglePt = await page.eval(() => {
          const wiz = document.querySelector('[data-testid="auth-wizard"]');
          if (!wiz) return null;
          const controls = Array.from(
            wiz.querySelectorAll('button, [role="tab"], a, label, [role="button"]'),
          ) as HTMLElement[];
          const reg = controls.find((el) => {
            const tid = el.getAttribute('data-testid') ?? '';
            if (tid === 'auth-submit-btn') return false;
            return /register|sign\s*up|create\s*account|注册|创建账号/i.test(
              `${tid} ${el.textContent ?? ''}`,
            );
          });
          if (!reg) return null;
          const r = reg.getBoundingClientRect();
          return r.width > 0
            ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            : null;
        });
        if (regTogglePt) {
          await clickCdpElementAt(page, regTogglePt);
        }

        await page.typeTestId('auth-username-input', wizUsername, { clearFirst: true });
        await page.typeTestId('auth-password-input', wizPassword, { clearFirst: true });

        // Populate optional display name / confirm password fields if rendered in Register mode
        await page.eval(
          (uName: string, pwd: string) => {
            const wiz = document.querySelector('[data-testid="auth-wizard"]');
            if (!wiz) return;
            const setInput = (el: HTMLInputElement, val: string) => {
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value',
              )?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            for (const inp of Array.from(wiz.querySelectorAll('input')) as HTMLInputElement[]) {
              const tid = inp.getAttribute('data-testid') ?? '';
              if (
                tid === 'auth-server-url-input' ||
                tid === 'auth-username-input' ||
                tid === 'auth-password-input'
              ) {
                continue;
              }
              const meta = `${inp.name} ${inp.placeholder} ${inp.getAttribute('aria-label') ?? ''}`;
              if (/confirm|repeat|确认密码/i.test(meta)) {
                setInput(inp, pwd);
              } else if (/first|display|name|昵称|姓名/i.test(meta) && !inp.value) {
                setInput(inp, uName);
              }
            }
          },
          wizUsername,
          wizPassword,
        );

        await page.clickTestId('auth-submit-btn');

        // Must transition automatically from Auth Wizard into AppShell
        const sidebar = await page.waitForTestId('chat-sidebar', {
          state: 'visible',
          timeoutMs: 12000,
        });
        assert.ok(sidebar?.visible, 'AppShell chat-sidebar must appear after registration');

        const wizAfter = await page.querySelector('[data-testid="auth-wizard"]');
        assert.ok(!wizAfter || !wizAfter.visible, 'auth-wizard must unmount once authenticated');

        // Verify token stored in chrome.storage.local authenticates against gpui_telegram_server
        const storedToken = await pollUntil(
          async () => {
            return await ctx.browser.evalInServiceWorker(async () => {
              const c = (globalThis as any).chrome;
              const data = await c.storage.local.get([
                'token',
                'auth_token',
                'session',
                'auth_session',
              ]);
              return (
                data.token ??
                data.auth_token ??
                data.session?.token ??
                data.auth_session?.token ??
                null
              );
            });
          },
          { timeoutMs: 6000, message: 'Registered session token persisted in chrome.storage.local' },
        );
        assert.ok(typeof storedToken === 'string' && storedToken.length > 10);

        const newUserApi = new TelegramApiClient(ctx.server.baseUrl, storedToken);
        const me = await newUserApi.getMe();
        assert.equal(me.username, wizUsername, 'Persisted token must belong to newly registered user');

        const chatsResp = await newUserApi.listChats();
        assert.ok(Array.isArray(chatsResp.chats), 'Registered user chat list must be accessible');
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T1-F11-03',
  title: 'Auth wizard switches cleanly across Phone OTP, Email OTP, Alipay QR, and QR Device Pairing backed by real server endpoints',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    try {
      await clearExtensionAuthState(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });
        await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });

        const selectWizardMode = async (pattern: RegExp, modeLabel: string): Promise<void> => {
          const pt = await page.eval((reSource: string) => {
            const re = new RegExp(reSource, 'i');
            const wiz = document.querySelector('[data-testid="auth-wizard"]');
            if (!wiz) return null;
            const els = Array.from(
              wiz.querySelectorAll('button, [role="tab"], [role="button"], a'),
            ) as HTMLElement[];
            const match = els.find((el) =>
              re.test(
                `${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('data-mode') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`,
              ),
            );
            if (!match) return null;
            match.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
            const r = match.getBoundingClientRect();
            return r.width > 0
              ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
              : null;
          }, pattern.source);
          assert.ok(pt, `auth-wizard must render mode selector for ${modeLabel}`);
          await clickCdpElementAt(page, pt);
        };

        // 1. Phone OTP step + server /api/v1/auth/phone/send-code verification
        await selectWizardMode(/phone|sms|手机|短信/, 'Phone OTP');
        const phoneRes = await ctx.primaryUser.api.sendPhoneCode('+15550192837');
        assert.equal(phoneRes.sent ?? phoneRes.ok, true, 'Server /api/v1/auth/phone/send-code must succeed');
        const hasPhoneControl = await pollUntil(
          async () => {
            return await page.eval(() => {
              const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
              if (!wiz) return false;
              return /phone|code|otp|sms|\+\d|手机|验证码/i.test(
                `${wiz.innerText} ${Array.from(wiz.querySelectorAll('input')).map((i) => `${i.type} ${i.placeholder}`).join(' ')}`,
              );
            });
          },
          { timeoutMs: 4000, message: 'Phone OTP controls rendered in auth-wizard' },
        );
        assert.equal(hasPhoneControl, true);

        // 2. Email OTP step
        await selectWizardMode(/email|mail|邮箱/, 'Email OTP');
        const hasEmailControl = await pollUntil(
          async () => {
            return await page.eval(() => {
              const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
              if (!wiz) return false;
              return /email|mail|code|otp|@|邮箱|验证码/i.test(
                `${wiz.innerText} ${Array.from(wiz.querySelectorAll('input')).map((i) => `${i.type} ${i.placeholder}`).join(' ')}`,
              );
            });
          },
          { timeoutMs: 4000, message: 'Email OTP controls rendered in auth-wizard' },
        );
        assert.equal(hasEmailControl, true);

        // 3. Alipay QR step
        await selectWizardMode(/alipay|支付宝/, 'Alipay QR');
        const hasAlipayView = await pollUntil(
          async () => {
            return await page.eval(() => {
              const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
              if (!wiz) return false;
              const hasQrNode = Boolean(
                wiz.querySelector('canvas, svg, img[alt*="qr" i], [data-testid*="qr" i], .qr, [class*="qr" i]'),
              );
              return hasQrNode || /alipay|qr|scan|支付宝|扫码/i.test(wiz.innerText || '');
            });
          },
          { timeoutMs: 5000, message: 'Alipay QR step rendered in auth-wizard' },
        );
        assert.equal(hasAlipayView, true);

        // 4. QR Device Pairing step + live /api/v1/auth/pair/init & poll verification
        await selectWizardMode(/qr|pair|扫码登录|设备配对/, 'QR Device Pairing');
        const pairInit = await ctx.primaryUser.api.initQrPair();
        assert.ok(
          typeof pairInit.pair_token === 'string' && pairInit.pair_token.length > 8,
          'POST /api/v1/auth/pair/init must return pair_token',
        );
        const pairPoll = await ctx.primaryUser.api.pollQrPair(pairInit.pair_token);
        assert.ok(pairPoll, 'GET /api/v1/auth/pair/poll/{token} must return HTTP 200');

        const hasPairQr = await pollUntil(
          async () => {
            return await page.eval(() => {
              const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
              if (!wiz) return false;
              return Boolean(
                wiz.querySelector('canvas, svg, img, [data-testid*="qr" i], [class*="qr" i]') ||
                  /pair|scan|qr|扫码|配对/i.test(wiz.innerText || ''),
              );
            });
          },
          { timeoutMs: 5000, message: 'QR Pairing canvas/step rendered in auth-wizard' },
        );
        assert.equal(hasPairQr, true);
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T1-F11-04',
  title: 'Multi-Account Switcher isolates dialogs, profile identity, and active sessions between primaryUser and userB',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const userB = await ctx.createIsolatedUser('acct_b');
    const primaryRoomTitle = `PrimaryOnly_${crypto.randomBytes(3).toString('hex')}`;
    const userBRoomTitle = `UserBOnly_${crypto.randomBytes(3).toString('hex')}`;

    await ctx.primaryUser.api.createChat({ title: primaryRoomTitle, chat_type: 'group' });
    await userB.api.createChat({ title: userBRoomTitle, chat_type: 'group' });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText(primaryRoomTitle, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        const initialSidebarText = await page.eval(
          () => (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement)?.innerText ?? '',
        );
        assert.ok(!initialSidebarText.includes(userBRoomTitle), 'userB chats must not leak into primaryUser');

        // Seed multi-account registry with both accounts and trigger UI account switcher (Ctrl+E or menu drawer)
        await ctx.browser.evalInServiceWorker(
          async (acctA: any, acctB: any, srvUrl: string) => {
            const c = (globalThis as any).chrome;
            if (!c?.storage?.local) return;
            const accounts = [
              {
                user_id: acctA.userId,
                userId: acctA.userId,
                username: acctA.username,
                token: acctA.token,
                session_id: acctA.sessionId,
                sessionId: acctA.sessionId,
                server_url: srvUrl,
                serverUrl: srvUrl,
                active: true,
              },
              {
                user_id: acctB.userId,
                userId: acctB.userId,
                username: acctB.username,
                token: acctB.token,
                session_id: acctB.sessionId,
                sessionId: acctB.sessionId,
                server_url: srvUrl,
                serverUrl: srvUrl,
                active: false,
              },
            ];
            await c.storage.local.set({ accounts });
          },
          {
            userId: ctx.primaryUser.userId,
            username: ctx.primaryUser.username,
            token: ctx.primaryUser.token,
            sessionId: ctx.primaryUser.sessionId,
          },
          {
            userId: userB.userId,
            username: userB.username,
            token: userB.token,
            sessionId: userB.sessionId,
          },
          ctx.server.baseUrl,
        );

        // Open Multi-Account Switcher via Ctrl+E or MainMenu/Avatar button on NavRail
        await page.pressKey('Ctrl+e');
        let userBClicked = await page.eval((targetUsername: string) => {
          const all = Array.from(
            document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], li'),
          ) as HTMLElement[];
          const item = all.find((el) => (el.textContent ?? '').includes(targetUsername));
          if (item) {
            item.click();
            return true;
          }
          return false;
        }, userB.username);

        if (!userBClicked) {
          // Open MainMenuDrawer / Account menu button in nav-rail or sidebar header
          await page.eval(() => {
            const btns = Array.from(
              document.querySelectorAll(
                '[data-testid="nav-rail"] button, [data-testid="chat-sidebar"] button, header button',
              ),
            ) as HTMLElement[];
            const menuBtn = btns.find((b) =>
              /account|menu|drawer|profile|switch|账号|菜单|切换/i.test(
                `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
              ),
            ) ?? btns[0];
            menuBtn?.click();
          });
          userBClicked = await pollUntil(
            async () => {
              return await page.eval((targetUsername: string) => {
                const all = Array.from(
                  document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], li, div'),
                ) as HTMLElement[];
                const item = all.find(
                  (el) =>
                    el.children.length <= 5 &&
                    (el.textContent ?? '').includes(targetUsername) &&
                    el.getBoundingClientRect().width > 0,
                );
                if (item) {
                  item.click();
                  return true;
                }
                return false;
              }, userB.username);
            },
            { timeoutMs: 5000, message: `Account switcher lists ${userB.username}` },
          );
        }
        assert.equal(userBClicked, true, 'Multi-Account Switcher must allow selecting userB');

        // Verify sidebar switches to userB's exclusive chats without leaking primaryUser's chats
        await page.waitForText(userBRoomTitle, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });
        const userBSidebarText = await page.eval(
          () => (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement)?.innerText ?? '',
        );
        assert.ok(userBSidebarText.includes(userBRoomTitle), 'userB chat must render after switching');
        assert.ok(
          !userBSidebarText.includes(primaryRoomTitle),
          'primaryUser chat must NOT leak into userB dialog list',
        );

        // Switch back to primaryUser via Multi-Account Switcher
        await page.pressKey('Ctrl+e');
        await pollUntil(
          async () => {
            return await page.eval((primaryName: string) => {
              const all = Array.from(
                document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], li, div'),
              ) as HTMLElement[];
              const item = all.find(
                (el) =>
                  el.children.length <= 5 &&
                  (el.textContent ?? '').includes(primaryName) &&
                  el.getBoundingClientRect().width > 0,
              );
              if (item) {
                item.click();
                return true;
              }
              return false;
            }, ctx.primaryUser.username);
          },
          { timeoutMs: 5000, message: `Switch back to ${ctx.primaryUser.username}` },
        );

        await page.waitForText(primaryRoomTitle, {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });
        const restoredSidebarText = await page.eval(
          () => (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement)?.innerText ?? '',
        );
        assert.ok(!restoredSidebarText.includes(userBRoomTitle), 'userB chat must be absent after switching back');
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T1-F11-05',
  title: 'Settings ActiveSessions lists live device sessions from /api/v1/auth/sessions and revokes secondary session on server',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const secondaryDeviceName = `E2E_Secondary_Tablet_${crypto.randomBytes(2).toString('hex')}`;
    const secondaryLogin = await ctx.primaryUser.api.login({
      username: ctx.primaryUser.username,
      password: ctx.primaryUser.password,
      device_name: secondaryDeviceName,
    });
    assert.ok(secondaryLogin.session_id && secondaryLogin.token, 'Secondary login must mint a distinct session');

    const beforeSessions = await ctx.primaryUser.api.listSessions();
    assert.ok(
      beforeSessions.sessions.some((s: any) => s.session_id === secondaryLogin.session_id),
      'GET /api/v1/auth/sessions must list secondary session prior to revocation',
    );

    await ctx.withExtensionSurface('workspace', async (page) => {
      await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });

      // Navigate to Settings -> ActiveSessions
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

      // Click ActiveSessions / Devices section in settings-router
      await page.eval(() => {
        const router = document.querySelector('[data-testid="settings-router"]')!;
        const items = Array.from(
          router.querySelectorAll('button, [role="tab"], [role="button"], li, a'),
        ) as HTMLElement[];
        const target =
          items.find((el) =>
            /active\s*session|devices|sessions|登录设备|活动会话|会话管理/i.test(
              `${el.getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
            ),
          ) ??
          items.find((el) => /privacy|security|隐私|安全/i.test(el.textContent ?? ''));
        target?.click();
      });

      // Wait for secondary device name to appear in UI
      await page.waitForText(secondaryDeviceName, {
        selector: '[data-testid="settings-router"]',
        timeoutMs: 8000,
      });

      // Click Revoke / Terminate button associated with secondaryDeviceName
      const revokePt = await page.eval((devName: string) => {
        const router = document.querySelector('[data-testid="settings-router"]')!;
        const containers = Array.from(router.querySelectorAll('li, tr, div, article')) as HTMLElement[];
        const row = containers
          .filter((c) => (c.innerText || '').includes(devName))
          .sort((a, b) => a.innerText.length - b.innerText.length)[0];
        if (!row) return null;
        const btn = Array.from(row.querySelectorAll('button, [role="button"]')).find((b) =>
          /revoke|terminate|remove|log\s*out|注销|终止|移除|下线/i.test(
            `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
          ),
        ) as HTMLElement | undefined;
        const target = btn ?? (row.querySelector('button') as HTMLElement | null);
        if (!target) return null;
        target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        const r = target.getBoundingClientRect();
        return r.width > 0
          ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          : null;
      }, secondaryDeviceName);

      assert.ok(revokePt, `ActiveSessions view must render a Revoke button for ${secondaryDeviceName}`);
      await clickCdpElementAt(page, revokePt);

      // Confirm revocation modal if a confirmation dialog popped up
      await page.eval(() => {
        const dialogBtns = Array.from(
          document.querySelectorAll('[role="dialog"] button, .modal button'),
        ) as HTMLElement[];
        const confirmBtn = dialogBtns.find((b) =>
          /confirm|revoke|terminate|yes|确定|确认|终止/i.test(b.textContent ?? ''),
        );
        confirmBtn?.click();
      });

      // Verify session is genuinely revoked on gpui_telegram_server
      await pollUntil(
        async () => {
          const after = await ctx.primaryUser.api.listSessions();
          return !after.sessions.some((s: any) => s.session_id === secondaryLogin.session_id);
        },
        {
          timeoutMs: 6000,
          intervalMs: 100,
          message: 'Secondary device session removed from GET /api/v1/auth/sessions',
        },
      );

      const revokedCheck = await ctx.primaryUser.api
        .withToken(secondaryLogin.token)
        .request('GET', '/api/v1/auth/me');
      assert.equal(
        revokedCheck.status,
        401,
        `Revoked secondary token must receive HTTP 401 on /api/v1/auth/me, got ${revokedCheck.status}`,
      );
    });
  },
});

defineTest({
  id: 'T1-F11-06',
  title: 'Local Passcode Lock hides conversation-stage messages behind Lock Screen and unlocks cleanly with valid 4-digit passcode',
  tier: 1,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const secretMarker = `SECRET_VAULT_MSG_${crypto.randomBytes(4).toString('hex')}`;
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: secretMarker,
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });

        // Open official bot chat so secretMarker is visible on stage
        await page.eval(() => {
          const sb = document.querySelector('[data-testid="chat-sidebar"]');
          const rows = Array.from(sb?.querySelectorAll('*') ?? []) as HTMLElement[];
          const target = rows.find(
            (el) =>
              el.children.length > 0 &&
              /official|hermes|bot|777000/i.test(el.textContent ?? '') &&
              el.getBoundingClientRect().height >= 36 &&
              el.getBoundingClientRect().height <= 100,
          );
          target?.click();
        });
        await page.waitForText(secretMarker, {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });

        // Navigate to Settings -> LocalPasscode
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

        await page.eval(() => {
          const router = document.querySelector('[data-testid="settings-router"]')!;
          const items = Array.from(
            router.querySelectorAll('button, [role="tab"], [role="button"], li, a'),
          ) as HTMLElement[];
          const passcodeItem =
            items.find((el) =>
              /passcode|lock|pin|密码锁|本地密码|锁定/i.test(
                `${el.getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
              ),
            ) ??
            items.find((el) => /privacy|security|隐私|安全/i.test(el.textContent ?? ''));
          passcodeItem?.click();
        });

        // Fill 4-digit passcode "2580" (and confirmation input if present) and save/enable
        const configuredPasscode = await page.eval(() => {
          const router = document.querySelector('[data-testid="settings-router"]')!;
          const setVal = (el: HTMLInputElement, val: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value',
            )?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          const pinInputs = Array.from(
            router.querySelectorAll('input[type="password"], input[inputmode="numeric"], input[maxlength="4"], input[placeholder*="passcode" i], input[placeholder*="密码" i], input[placeholder*="PIN" i]'),
          ) as HTMLInputElement[];

          if (pinInputs.length === 0) {
            return false;
          }
          for (const inp of pinInputs) {
            setVal(inp, '2580');
          }
          const saveBtn = Array.from(router.querySelectorAll('button')).find((b) =>
            /enable|save|set|confirm|启用|保存|设置|开启/i.test(b.textContent ?? ''),
          );
          saveBtn?.click();
          return true;
        });
        assert.equal(configuredPasscode, true, 'LocalPasscode settings section must expose passcode input');

        // Return to chat view and lock app via Ctrl+Shift+L (or Lock button)
        await page.eval(() => {
          const rail = document.querySelector('[data-testid="nav-rail"]');
          const btns = Array.from(rail?.querySelectorAll('button, [role="button"], a') ?? []) as HTMLElement[];
          btns[0]?.click();
        });
        await page.pressKey('Ctrl+Shift+l');

        // Also click explicit Lock button if shortcut needs focus or button is rendered
        await page.eval(() => {
          const lockBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
            /lock\s*now|lock\s*app|锁定/i.test(
              `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
            ),
          ) as HTMLElement | undefined;
          lockBtn?.click();
        });

        // Verify conversation content is hidden behind Lock Screen
        await pollUntil(
          async () => {
            return await page.eval((secret: string) => {
              const stage = document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null;
              const stageVisible = Boolean(
                stage &&
                  window.getComputedStyle(stage).display !== 'none' &&
                  window.getComputedStyle(stage).visibility !== 'hidden' &&
                  stage.getBoundingClientRect().width > 0,
              );
              const visibleBody = document.body.innerText || '';
              return !stageVisible && !visibleBody.includes(secret);
            }, secretMarker);
          },
          {
            timeoutMs: 6000,
            message: 'Lock Screen hides conversation-stage and secret message from DOM',
          },
        );

        // Unlock with valid 4-digit passcode "2580"
        const unlockSelector =
          'input[type="password"], input[inputmode="numeric"], [data-testid*="passcode" i] input, input';
        await page.type(unlockSelector, '2580', { clearFirst: true, submit: true });
        await page.eval(() => {
          const unlockBtn = Array.from(document.querySelectorAll('button')).find((b) =>
            /unlock|enter|解锁|确认/i.test(b.textContent ?? ''),
          );
          unlockBtn?.click();
        });

        // Verify exact open chat state and secret message are restored
        await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });
        await page.waitForText(secretMarker, {
          selector: '[data-testid="conversation-stage"]',
          timeoutMs: 8000,
        });
      });
    } finally {
      await ctx.browser.evalInServiceWorker(async () => {
        const c = (globalThis as any).chrome;
        if (c?.storage?.local) {
          await c.storage.local.remove(['passcode', 'local_passcode', 'passcode_locked']);
          await c.storage.local.set({
            passcode_locked: false,
            passcode_enabled: false,
            passcode_hash: null,
          });
        }
      });
    }
  },
});
