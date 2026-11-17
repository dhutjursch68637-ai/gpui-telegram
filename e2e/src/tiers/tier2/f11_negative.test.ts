import {
  defineTest,
  assert,
  pollUntil,
  sleep,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

async function clearExtensionAuthForWizardTest(ctx: SharedTierContext): Promise<void> {
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
        'passcode_locked',
        'passcode_enabled',
        'passcode_hash',
      ]);
      await c.storage.local.set({
        server_url: srvUrl,
        serverUrl: srvUrl,
      });
    }
  }, ctx.server.baseUrl);
}

async function clearPageLocalAuthStorage(page: CdpPageHandle): Promise<void> {
  await page.eval(() => {
    try {
      for (const k of [
        'token',
        'auth_token',
        'session',
        'auth_session',
        'accounts',
        'active_account_id',
      ]) {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      }
    } catch {
      // Ignore
    }
  });
}

defineTest({
  id: 'T2-F11-01',
  title: 'Unreachable (http://127.0.0.1:1) and malformed (not-a-url://bad) server URLs show validation/offline banner without unhandled rejections',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    try {
      await clearExtensionAuthForWizardTest(ctx);
      ctx.browser.clearUncaughtExceptions();

      await ctx.withExtensionSurface('workspace', async (page) => {
        await clearPageLocalAuthStorage(page);
        await page.reload();

        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });
        await page.waitForTestId('auth-server-url-input', { state: 'visible', timeoutMs: 8000 });

        // 1. Malformed URL scheme/format
        await page.typeTestId('auth-server-url-input', 'not-a-url://bad', { clearFirst: true });
        await page.pressKey('Tab');
        // Click connectivity check button if present, or submit button
        await page.eval(() => {
          const checkBtn = Array.from(
            document.querySelectorAll('[data-testid="auth-wizard"] button'),
          ).find((b) => /check|test|connect|verify|检测|连接/i.test(b.textContent ?? '')) as
            | HTMLElement
            | undefined;
          checkBtn?.click();
        });

        await pollUntil(
          async () => {
            const wizText = await page.eval(
              () =>
                (document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return /invalid|url|http|malformed|unreachable|offline|error|failed|无效|格式|错误|无法连接/i.test(
              wizText,
            );
          },
          { timeoutMs: 3000, intervalMs: 80, message: 'Malformed server URL validation banner' },
        );

        // 2. Unreachable port http://127.0.0.1:1
        await page.typeTestId('auth-server-url-input', 'http://127.0.0.1:1', { clearFirst: true });
        await page.pressKey('Tab');
        await page.eval(() => {
          const checkBtn = Array.from(
            document.querySelectorAll('[data-testid="auth-wizard"] button'),
          ).find((b) => /check|test|connect|verify|检测|连接/i.test(b.textContent ?? '')) as
            | HTMLElement
            | undefined;
          if (checkBtn) {
            checkBtn.click();
          }
        });
        // Also attempt login submit against unreachable server if form requires submit to probe
        const userInp = await page.querySelector('[data-testid="auth-username-input"]');
        const passInp = await page.querySelector('[data-testid="auth-password-input"]');
        if (userInp?.visible && passInp?.visible) {
          await page.typeTestId('auth-username-input', ctx.primaryUser.username, { clearFirst: true });
          await page.typeTestId('auth-password-input', ctx.primaryUser.password, { clearFirst: true });
          const sub = await page.querySelector('[data-testid="auth-submit-btn"]');
          if (sub && !sub.disabled) {
            await page.clickTestId('auth-submit-btn');
          }
        }

        await pollUntil(
          async () => {
            const wizText = await page.eval(
              () =>
                (document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null)
                  ?.innerText ?? '',
            );
            return /unreachable|offline|connect|network|failed|refused|error|离线|无法连接|连接失败|错误/i.test(
              wizText,
            );
          },
          { timeoutMs: 3000, intervalMs: 80, message: 'Unreachable server 127.0.0.1:1 banner' },
        );

        assert.equal(
          page.pageExceptions.length,
          0,
          `Expected zero unhandled page exceptions on unreachable server URL, got ${JSON.stringify(page.pageExceptions)}`,
        );
        assert.equal(
          ctx.browser.uncaughtExceptions.length,
          0,
          `Expected zero SW uncaught exceptions, got ${JSON.stringify(ctx.browser.uncaughtExceptions)}`,
        );

        // 3. Switch back to valid server URL and verify login recovers cleanly
        await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });
        await page.pressKey('Tab');
        await page.typeTestId('auth-username-input', ctx.primaryUser.username, { clearFirst: true });
        await page.typeTestId('auth-password-input', ctx.primaryUser.password, { clearFirst: true });
        await page.clickTestId('auth-submit-btn');

        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 8000 });
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F11-02',
  title: 'Submitting auth-wizard Login with wrong password returns HTTP 401, shows error banner, and stores zero session token',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    try {
      await clearExtensionAuthForWizardTest(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        await clearPageLocalAuthStorage(page);
        await page.reload();
        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });

        const loginStatuses: number[] = [];
        const offNet = page.cdp.on('Network.responseReceived', (params, sid) => {
          if (sid !== page.sessionId) return;
          const url = String(params.response?.url ?? '');
          if (url.includes('/api/v1/auth/login')) {
            loginStatuses.push(Number(params.response?.status ?? 0));
          }
        });

        try {
          const srvInput = await page.querySelector('[data-testid="auth-server-url-input"]');
          if (srvInput?.visible) {
            await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });
          }

          // Ensure Login mode is selected (not Register)
          await page.eval(() => {
            const tabs = Array.from(
              document.querySelectorAll('[data-testid="auth-wizard"] button, [data-testid="auth-wizard"] [role="tab"]'),
            ) as HTMLElement[];
            const loginTab = tabs.find(
              (el) =>
                el.getAttribute('data-testid') !== 'auth-submit-btn' &&
                /^(sign in|log in|login|登录)$/i.test((el.textContent ?? '').trim()),
            );
            loginTab?.click();
          });

          await page.typeTestId('auth-username-input', ctx.primaryUser.username, { clearFirst: true });
          await page.typeTestId('auth-password-input', 'DefinitelyWrongPass!999', { clearFirst: true });
          await page.clickTestId('auth-submit-btn');

          await pollUntil(
            () => loginStatuses.includes(401),
            { timeoutMs: 6000, intervalMs: 80, message: 'HTTP 401 from /api/v1/auth/login' },
          );

          await pollUntil(
            async () => {
              const wizText = await page.eval(
                () =>
                  (document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null)
                    ?.innerText ?? '',
              );
              return /invalid|incorrect|wrong|password|credentials|unauthorized|401|密码|错误|无效|失败/i.test(
                wizText,
              );
            },
            { timeoutMs: 5000, intervalMs: 80, message: 'Invalid credentials banner in auth-wizard' },
          );

          const wizStillVisible = await page.querySelector('[data-testid="auth-wizard"]');
          assert.ok(wizStillVisible?.visible, 'auth-wizard must remain mounted after 401 login');

          const storedToken = await ctx.browser.evalInServiceWorker(async () => {
            const c = (globalThis as any).chrome;
            const st = await c.storage.local.get(['token', 'auth_token', 'session']);
            return st.token ?? st.auth_token ?? st.session?.token ?? null;
          });
          assert.equal(storedToken, null, 'No auth token may be stored after failed 401 login');
        } finally {
          offNet();
        }
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F11-03',
  title: 'Register in auth-wizard blocks empty password locally and surfaces 409/400 conflict on duplicate username',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    try {
      await clearExtensionAuthForWizardTest(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        await clearPageLocalAuthStorage(page);
        await page.reload();
        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });

        const srvInput = await page.querySelector('[data-testid="auth-server-url-input"]');
        if (srvInput?.visible) {
          await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });
        }

        // Switch auth-wizard to Register / Sign Up mode
        const switchedToRegister = await page.eval(() => {
          const candidates = Array.from(
            document.querySelectorAll(
              '[data-testid="auth-wizard"] button, [data-testid="auth-wizard"] a, [data-testid="auth-wizard"] [role="tab"]',
            ),
          ) as HTMLElement[];
          const regBtn = candidates.find(
            (el) =>
              el.getAttribute('data-testid') !== 'auth-submit-btn' &&
              /register|sign up|create account|注册/i.test((el.textContent ?? '').trim()),
          );
          if (regBtn) {
            regBtn.click();
            return true;
          }
          return false;
        });
        assert.equal(switchedToRegister, true, 'Expected Register mode toggle in auth-wizard');
        await sleep(150);

        // Case A: Empty password validation
        await page.typeTestId('auth-username-input', 'empty_pw_candidate_user', { clearFirst: true });
        await page.typeTestId('auth-password-input', '', { clearFirst: true });

        const submitBefore = await page.querySelector('[data-testid="auth-submit-btn"]');
        assert.ok(submitBefore);
        if (!submitBefore.disabled) {
          await page.clickTestId('auth-submit-btn');
          await sleep(250);
        }

        const wizAfterEmptyPw = await page.querySelector('[data-testid="auth-wizard"]');
        assert.ok(
          wizAfterEmptyPw?.visible,
          'Empty password Register must stay on auth-wizard and block account creation',
        );

        // Case B: Duplicate primaryUser.username conflict (409 / 400)
        const registerStatuses: number[] = [];
        const offNet = page.cdp.on('Network.responseReceived', (params, sid) => {
          if (sid !== page.sessionId) return;
          const url = String(params.response?.url ?? '');
          if (url.includes('/api/v1/auth/register')) {
            registerStatuses.push(Number(params.response?.status ?? 0));
          }
        });

        try {
          await page.typeTestId('auth-username-input', ctx.primaryUser.username, { clearFirst: true });
          await page.typeTestId('auth-password-input', 'ValidStrongPass!2026', { clearFirst: true });
          // Fill confirm password if present
          await page.eval(() => {
            const pwInputs = Array.from(
              document.querySelectorAll('[data-testid="auth-wizard"] input[type="password"]'),
            ) as HTMLInputElement[];
            if (pwInputs.length > 1) {
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value',
              )?.set;
              setter?.call(pwInputs[1], 'ValidStrongPass!2026');
              pwInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          await page.clickTestId('auth-submit-btn');

          await pollUntil(
            () => registerStatuses.some((s) => s === 409 || s === 400),
            {
              timeoutMs: 6000,
              intervalMs: 80,
              message: 'HTTP 409/400 duplicate username response from /api/v1/auth/register',
            },
          );

          await pollUntil(
            async () => {
              const wizText = await page.eval(
                () =>
                  (document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null)
                    ?.innerText ?? '',
              );
              return /exist|taken|duplicate|conflict|already|409|已存在|已被|占用|冲突/i.test(wizText);
            },
            { timeoutMs: 5000, intervalMs: 80, message: 'Duplicate username conflict error in UI' },
          );

          const sidebar = await page.querySelector('[data-testid="chat-sidebar"]');
          assert.ok(!sidebar || !sidebar.visible, 'Duplicate Register must not enter AppShell');
        } finally {
          offNet();
        }
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F11-04',
  title: 'Phone/Email OTP step rejects invalid 6-digit code ("000000") with 400/401 and preserves input state for retry',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const testPhone = '+8613800138099';
    try {
      await clearExtensionAuthForWizardTest(ctx);

      await ctx.withExtensionSurface('workspace', async (page) => {
        await clearPageLocalAuthStorage(page);
        await page.reload();
        await page.waitForTestId('auth-wizard', { state: 'visible', timeoutMs: 10000 });

        const srvInput = await page.querySelector('[data-testid="auth-server-url-input"]');
        if (srvInput?.visible) {
          await page.typeTestId('auth-server-url-input', ctx.server.baseUrl, { clearFirst: true });
        }

        // Switch to Phone OTP (or Email OTP) tab inside auth-wizard
        const otpModeSelected = await page.eval(() => {
          const btns = Array.from(
            document.querySelectorAll(
              '[data-testid="auth-wizard"] button, [data-testid="auth-wizard"] [role="tab"]',
            ),
          ) as HTMLElement[];
          const phoneTab = btns.find((b) => /phone|sms|otp|手机|短信/i.test(b.textContent ?? ''));
          if (phoneTab) {
            phoneTab.click();
            return 'phone';
          }
          const emailTab = btns.find((b) => /email|邮箱/i.test(b.textContent ?? ''));
          if (emailTab) {
            emailTab.click();
            return 'email';
          }
          return null;
        });
        assert.ok(otpModeSelected !== null, 'Expected Phone or Email OTP tab in auth-wizard');
        await sleep(150);

        const targetContact = otpModeSelected === 'phone' ? testPhone : 'otp_neg_check@example.com';

        // Type phone/email into OTP target input
        const contactSelector = await page.eval(() => {
          const inputs = Array.from(
            document.querySelectorAll('[data-testid="auth-wizard"] input'),
          ) as HTMLInputElement[];
          const target = inputs.find(
            (inp) =>
              inp.getAttribute('data-testid') !== 'auth-server-url-input' &&
              inp.type !== 'hidden' &&
              inp.offsetParent !== null,
          );
          if (!target) return null;
          target.setAttribute('data-e2e-otp-contact', '1');
          return '[data-e2e-otp-contact="1"]';
        });
        assert.ok(contactSelector, 'Expected visible phone/email input in OTP wizard step');
        await page.type(contactSelector, targetContact, { clearFirst: true });

        // Click Send Code button
        await page.eval(() => {
          const btns = Array.from(
            document.querySelectorAll('[data-testid="auth-wizard"] button'),
          ) as HTMLElement[];
          const sendBtn =
            btns.find((b) => /send|code|otp|获取|发送/i.test(b.textContent ?? '')) ??
            (document.querySelector('[data-testid="auth-submit-btn"]') as HTMLElement | null);
          sendBtn?.click();
        });

        // Wait for OTP 6-digit code input to appear and enter invalid "000000"
        const codeSelector = await pollUntil(
          async () => {
            return await page.eval(() => {
              const inputs = Array.from(
                document.querySelectorAll('[data-testid="auth-wizard"] input'),
              ) as HTMLInputElement[];
              const codeInp = inputs.find(
                (inp) =>
                  inp.offsetParent !== null &&
                  inp.getAttribute('data-testid') !== 'auth-server-url-input' &&
                  inp.getAttribute('data-e2e-otp-contact') !== '1' &&
                  (/code|otp|6|验证/i.test(
                    `${inp.placeholder} ${inp.name} ${inp.getAttribute('aria-label') ?? ''}`,
                  ) ||
                    inp.maxLength === 6),
              );
              if (codeInp) {
                codeInp.setAttribute('data-e2e-otp-code', '1');
                return '[data-e2e-otp-code="1"]';
              }
              return null;
            });
          },
          { timeoutMs: 6000, intervalMs: 100, message: 'OTP verification code input' },
        );
        assert.ok(codeSelector);

        const verifyStatuses: number[] = [];
        const offNet = page.cdp.on('Network.responseReceived', (params, sid) => {
          if (sid !== page.sessionId) return;
          const url = String(params.response?.url ?? '');
          if (url.includes('/verify')) {
            verifyStatuses.push(Number(params.response?.status ?? 0));
          }
        });

        try {
          await page.type(codeSelector, '000000', { clearFirst: true });
          await page.eval(() => {
            const btns = Array.from(
              document.querySelectorAll('[data-testid="auth-wizard"] button'),
            ) as HTMLElement[];
            const verifyBtn =
              btns.find((b) => /verify|confirm|submit|sign in|验证|确认|登录/i.test(b.textContent ?? '')) ??
              (document.querySelector('[data-testid="auth-submit-btn"]') as HTMLElement | null);
            verifyBtn?.click();
          });

          await pollUntil(
            () => verifyStatuses.some((s) => s === 400 || s === 401 || s === 403 || s === 422),
            { timeoutMs: 6000, intervalMs: 80, message: 'Server 400/401 rejection of invalid OTP "000000"' },
          );

          await pollUntil(
            async () => {
              const wizText = await page.eval(
                () =>
                  (document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null)
                    ?.innerText ?? '',
              );
              return /invalid|incorrect|expired|code|error|failed|验证|错误|无效/i.test(wizText);
            },
            { timeoutMs: 5000, intervalMs: 80, message: 'Invalid OTP error feedback in UI' },
          );

          // Verify wizard stayed open and preserved phone/email context for retry
          const wizState = await page.eval((expectedContact: string) => {
            const wiz = document.querySelector('[data-testid="auth-wizard"]') as HTMLElement | null;
            if (!wiz) return { visible: false, preservesContact: false };
            const allValues = Array.from(wiz.querySelectorAll('input'))
              .map((i) => (i as HTMLInputElement).value)
              .join(' ');
            const text = wiz.innerText || '';
            return {
              visible: wiz.offsetParent !== null,
              preservesContact:
                allValues.includes(expectedContact) || text.includes(expectedContact),
            };
          }, targetContact);
          assert.equal(wizState.visible, true, 'auth-wizard must stay visible on invalid OTP');
          assert.equal(
            wizState.preservesContact,
            true,
            `Expected phone/email state (${targetContact}) preserved for retry`,
          );
        } finally {
          offNet();
        }
      });
    } finally {
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});

defineTest({
  id: 'T2-F11-05',
  title: 'Local Passcode Lock stays strictly locked across 3 wrong passcodes ("9999"), keeping conversation-stage unmounted/hidden',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const secretChatMsg = 'TOP_SECRET_LOCKED_TRANSCRIPT_8831';
    await ctx.primaryUser.api.sendMessage({
      chat_id: ctx.primaryUser.officialBotChatId,
      text: secretChatMsg,
    });

    try {
      await ctx.withExtensionSurface('workspace', async (page) => {
        try {
          await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 10000 });
          await page.waitForTestId('nav-rail', { state: 'visible', timeoutMs: 10000 });

          // Ensure official bot chat is selected so secretChatMsg is actively rendered before lock
          const stageHasSecret = await page.eval(
            (msg: string) =>
              (document.querySelector('[data-testid="conversation-stage"]') as HTMLElement | null)
                ?.innerText?.includes(msg) ?? false,
            secretChatMsg,
          );
          if (!stageHasSecret) {
            await page.eval(() => {
              const sb = document.querySelector('[data-testid="chat-sidebar"]');
              if (!sb) return;
              const row = sb.querySelector(
                '[data-chat-id], [role="listitem"], button, li',
              ) as HTMLElement | null;
              row?.click();
            });
          }
          await page.waitForText(secretChatMsg, {
            selector: '[data-testid="conversation-stage"]',
            timeoutMs: 8000,
          });

          // Navigate to Settings -> LocalPasscode strictly via real UI (ZERO chrome.storage.local.set bypass!)
          const clickedSettingsNav = await page.eval(() => {
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
          assert.equal(clickedSettingsNav, true, 'Expected Settings button in nav-rail');
          await page.waitForTestId('settings-router', { state: 'visible', timeoutMs: 8000 });

          const selectedPasscodeSection = await page.eval(() => {
            const router = document.querySelector('[data-testid="settings-router"]')!;
            const items = Array.from(
              router.querySelectorAll('button, [role="tab"], [role="button"], li, a'),
            ) as HTMLElement[];
            const passcodeItem =
              items.find((el) =>
                /passcode|lock|pin|密码锁|本地密码|锁定/i.test(
                  `${el.getAttribute('data-section') ?? ''} ${el.textContent ?? ''}`,
                ),
              ) ?? items.find((el) => /privacy|security|隐私|安全/i.test(el.textContent ?? ''));
            if (passcodeItem) {
              passcodeItem.click();
              return true;
            }
            return false;
          });
          assert.equal(selectedPasscodeSection, true, 'Expected LocalPasscode / Security section in settings-router');
          await sleep(150);

          // Configure 4-digit passcode "2468" via Settings UI inputs and save/enable button
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
              router.querySelectorAll(
                'input[type="password"], input[inputmode="numeric"], input[maxlength="4"], input[placeholder*="passcode" i], input[placeholder*="密码" i], input[placeholder*="PIN" i]',
              ),
            ).filter((el) => (el as HTMLElement).offsetParent !== null) as HTMLInputElement[];

            if (pinInputs.length === 0) {
              return false;
            }
            for (const inp of pinInputs) {
              setVal(inp, '2468');
            }
            const saveBtn = Array.from(router.querySelectorAll('button')).find((b) =>
              /enable|save|set|confirm|启用|保存|设置|开启/i.test(b.textContent ?? ''),
            );
            if (!saveBtn) return false;
            saveBtn.click();
            return true;
          });
          assert.equal(
            configuredPasscode,
            true,
            'Settings -> LocalPasscode section must expose passcode input and Enable/Save button',
          );

          // Return to Chats view on nav-rail and lock app via Ctrl+Shift+L (or explicit Lock UI button)
          await page.eval(() => {
            const rail = document.querySelector('[data-testid="nav-rail"]');
            const btns = Array.from(
              rail?.querySelectorAll('button, [role="button"], a') ?? [],
            ) as HTMLElement[];
            btns[0]?.click();
          });
          await page.pressKey('Ctrl+Shift+l');

          await page.eval(() => {
            const lockBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(
              (b) =>
                /lock\s*now|lock\s*app|passcode-lock|锁定/i.test(
                  `${b.getAttribute('data-testid') ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`,
                ),
            ) as HTMLElement | undefined;
            lockBtn?.click();
          });

          // Wait for Passcode Lock Screen to mount and verify conversation-stage + secretChatMsg are hidden/unmounted
          await pollUntil(
            async () => {
              const st = await page.querySelector('[data-testid="conversation-stage"]');
              const lockDom = await page.eval((secret: string) => {
                const hasLockInput =
                  document.querySelectorAll(
                    '[data-testid*="passcode" i] input, input[type="password"], input[inputmode="numeric"]',
                  ).length > 0;
                const bodyTxt = document.body.innerText || '';
                return {
                  hasLockInput,
                  leaksSecret: bodyTxt.includes(secret),
                };
              }, secretChatMsg);
              return (st === null || !st.visible) && lockDom.hasLockInput && !lockDom.leaksSecret;
            },
            { timeoutMs: 8000, intervalMs: 100, message: 'Passcode Lock Screen active and hiding conversation-stage' },
          );

          // Attempt 3 consecutive wrong passcodes ("9999")
          for (let attempt = 1; attempt <= 3; attempt++) {
            const pinInputSel = await page.eval(() => {
              document
                .querySelectorAll('[data-e2e-lock-pin]')
                .forEach((el) => el.removeAttribute('data-e2e-lock-pin'));
              const inputs = Array.from(
                document.querySelectorAll(
                  '[data-testid*="passcode" i] input, input[type="password"], input[inputmode="numeric"], input',
                ),
              ) as HTMLInputElement[];
              const visible = inputs.find((i) => i.offsetParent !== null);
              if (!visible) return null;
              visible.setAttribute('data-e2e-lock-pin', '1');
              return '[data-e2e-lock-pin="1"]';
            });
            assert.ok(pinInputSel, `Expected visible passcode input on attempt #${attempt}`);

            await page.type(pinInputSel, '9999', { clearFirst: true, submit: true });
            await page.eval(() => {
              const unlockBtn = Array.from(document.querySelectorAll('button')).find((b) =>
                /unlock|verify|enter|confirm|解锁|确认/i.test(b.textContent ?? ''),
              ) as HTMLElement | undefined;
              unlockBtn?.click();
            });
            await sleep(200);

            const stageDuringLock = await page.querySelector('[data-testid="conversation-stage"]');
            assert.ok(
              stageDuringLock === null || !stageDuringLock.visible,
              `conversation-stage MUST remain hidden/unmounted after wrong passcode attempt #${attempt}`,
            );

            const visibleBodyText = await page.eval(() => document.body.innerText || '');
            assert.ok(
              !visibleBodyText.includes(secretChatMsg),
              `Secret chat message must never appear in visible DOM while locked (attempt #${attempt})`,
            );
          }

          const lockFeedback = await page.eval(() => document.body.innerText || '');
          assert.ok(
            /wrong|incorrect|invalid|passcode|error|attempt|locked|密码|错误|不正确|锁定/i.test(
              lockFeedback,
            ),
            `Expected wrong-passcode error feedback after 3 failed attempts, got: ${lockFeedback.slice(0, 200)}`,
          );

          // Positive verification: unlock with the genuine UI-configured passcode "2468"
          const finalUnlockSel = await page.eval(() => {
            const inputs = Array.from(
              document.querySelectorAll(
                '[data-testid*="passcode" i] input, input[type="password"], input[inputmode="numeric"], input',
              ),
            ) as HTMLInputElement[];
            const visible = inputs.find((i) => i.offsetParent !== null);
            if (!visible) return null;
            visible.setAttribute('data-e2e-unlock-valid', '1');
            return '[data-e2e-unlock-valid="1"]';
          });
          assert.ok(finalUnlockSel, 'Expected visible passcode input to unlock with valid PIN');
          await page.type(finalUnlockSel, '2468', { clearFirst: true, submit: true });
          await page.eval(() => {
            const unlockBtn = Array.from(document.querySelectorAll('button')).find((b) =>
              /unlock|verify|enter|confirm|解锁|确认/i.test(b.textContent ?? ''),
            ) as HTMLElement | undefined;
            unlockBtn?.click();
          });

          await page.waitForTestId('conversation-stage', { state: 'visible', timeoutMs: 8000 });
        } finally {
          await page
            .eval(() => {
              try {
                for (const k of ['passcode', 'local_passcode', 'passcode_locked', 'passcode_enabled', 'passcode_hash']) {
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
        await c.storage.local.remove(['passcode', 'local_passcode', 'passcode_locked']);
        await c.storage.local.set({
          passcode_enabled: false,
          passcode_locked: false,
          passcode_hash: null,
        });
      });
    }
  },
});

defineTest({
  id: 'T2-F11-06',
  title: 'Multi-account Logout on secondary account userB purges userB token while preserving primaryUser session and dialogs',
  tier: 2,
  features: ['F11'],
  fn: async (ctx: SharedTierContext) => {
    const userB = await ctx.createIsolatedUser('t2_f11_userb');
    const primaryVault = await ctx.primaryUser.api.createChat({
      title: 'PrimaryKeepVault_701',
      chat_type: 'group',
    });
    const primaryVaultId = Number(primaryVault.chat_id ?? primaryVault.id);
    const userBVault = await userB.api.createChat({
      title: 'UserBPrivateVault_902',
      chat_type: 'group',
    });
    const userBVaultId = Number(userBVault.chat_id ?? userBVault.id);

    try {
      // Seed multi-account state with both primaryUser and userB, setting userB active
      await ctx.browser.evalInServiceWorker(
        async (cfg: {
          serverUrl: string;
          primary: { userId: number; username: string; token: string; sessionId: string };
          secondary: { userId: number; username: string; token: string; sessionId: string };
        }) => {
          const mkAcc = (u: typeof cfg.primary, active: boolean) => ({
            user_id: u.userId,
            userId: u.userId,
            username: u.username,
            token: u.token,
            session_id: u.sessionId,
            sessionId: u.sessionId,
            server_url: cfg.serverUrl,
            serverUrl: cfg.serverUrl,
            active,
          });
          const secSession = mkAcc(cfg.secondary, true);
          const c = (globalThis as any).chrome;
          await c.storage.local.set({
            token: cfg.secondary.token,
            auth_token: cfg.secondary.token,
            user_id: cfg.secondary.userId,
            session: secSession,
            auth_session: secSession,
            accounts: [mkAcc(cfg.primary, false), secSession],
            active_account_id: cfg.secondary.userId,
          });
        },
        {
          serverUrl: ctx.server.baseUrl,
          primary: {
            userId: ctx.primaryUser.userId,
            username: ctx.primaryUser.username,
            token: ctx.primaryUser.token,
            sessionId: ctx.primaryUser.sessionId,
          },
          secondary: {
            userId: userB.userId,
            username: userB.username,
            token: userB.token,
            sessionId: userB.sessionId,
          },
        },
      );

      await ctx.withExtensionSurface('workspace', async (page) => {
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 10000 });
        await page.waitForText('UserBPrivateVault_902', {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });

        // Trigger Logout on active account userB via Settings or MainMenuDrawer / NavRail
        let logoutClicked = await page.eval(() => {
          const findLogout = () =>
            Array.from(document.querySelectorAll('button, [role="menuitem"]')).find((el) =>
              /log\s*out|sign\s*out|退出登录|注销/i.test(
                `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
              ),
            ) as HTMLElement | undefined;

          let btn = findLogout();
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
          // Open MainMenuDrawer or Settings on nav-rail
          const navButtons = Array.from(
            document.querySelectorAll('[data-testid="nav-rail"] button, [data-testid*="menu"]'),
          ) as HTMLElement[];
          for (const nb of navButtons) {
            nb.click();
            btn = findLogout();
            if (btn) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (!logoutClicked) {
          // Navigate to Settings router and click Logout
          const settingsNav = await page.querySelector(
            '[data-testid="nav-rail"] [data-testid*="settings"], [data-testid="settings-btn"]',
          );
          if (settingsNav) {
            await page.click(
              '[data-testid="nav-rail"] [data-testid*="settings"], [data-testid="settings-btn"]',
            );
          }
          await sleep(200);
          logoutClicked = await page.eval(() => {
            const btn = Array.from(document.querySelectorAll('button, [role="menuitem"]')).find(
              (el) => /log\s*out|sign\s*out|退出登录|注销/i.test(el.textContent ?? ''),
            ) as HTMLElement | undefined;
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          });
        }
        assert.equal(logoutClicked, true, 'Expected clickable Logout button in workspace UI');

        // Confirm logout modal if confirmation dialog appears
        await sleep(200);
        await page.eval(() => {
          const dialogs = Array.from(
            document.querySelectorAll('[role="dialog"] button, .modal button'),
          ) as HTMLElement[];
          const confirmBtn = dialogs.find((b) =>
            /log\s*out|sign\s*out|confirm|ok|退出|确定/i.test(b.textContent ?? ''),
          );
          confirmBtn?.click();
        });

        // Verify userB token is purged from chrome.storage.local while primaryUser token survives
        const postLogoutStorage = await pollUntil(
          async () => {
            return await ctx.browser.evalInServiceWorker(async () => {
              const c = (globalThis as any).chrome;
              return await c.storage.local.get(null);
            });
          },
          {
            timeoutMs: 6000,
            intervalMs: 120,
            message: 'userB token purged from chrome.storage.local after Logout',
            isDone: (st) => !JSON.stringify(st).includes(userB.token),
          },
        );

        const serialized = JSON.stringify(postLogoutStorage);
        assert.ok(
          !serialized.includes(userB.token),
          'userB session token must be completely purged after Logout',
        );
        assert.ok(
          serialized.includes(ctx.primaryUser.token),
          'primaryUser account session must remain intact in multi-account storage',
        );

        // Reload / inspect sidebar to confirm primaryUser dialogs show without userB's vault
        await page.reload();
        await page.waitForTestId('chat-sidebar', { state: 'visible', timeoutMs: 8000 });
        await page.waitForText('PrimaryKeepVault_701', {
          selector: '[data-testid="chat-sidebar"]',
          timeoutMs: 8000,
        });
        const sidebarText = await page.eval(
          () => (document.querySelector('[data-testid="chat-sidebar"]') as HTMLElement)?.innerText ?? '',
        );
        assert.ok(
          !sidebarText.includes('UserBPrivateVault_902'),
          'Logged-out userB dialogs must not leak into primaryUser chat-sidebar',
        );
      });
    } finally {
      await ctx.primaryUser.api.deleteChat(primaryVaultId).catch(() => undefined);
      await userB.api.deleteChat(userBVaultId).catch(() => undefined);
      await ctx.signInExtensionAs(ctx.primaryUser);
    }
  },
});
