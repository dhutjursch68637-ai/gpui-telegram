import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SUT_ROOT,
  E2E_ROOT,
  SHM_PREFIX,
  SHM_ROOT,
  allocateRunEnvironment,
  cleanupAllTrackedResources,
  installGlobalCleanupHooks,
  isE2eRelatedTmpEntry,
  isVmDaemonTmpEntry,
  trackChildProcess,
} from '../harness/env.ts';
import {
  SutMissingError,
  verifySutArtifactsOrFail,
} from '../harness/sut_preflight.ts';
import {
  assert,
  assertPathOnXfs,
  assertValidPng,
} from '../harness/assertions.ts';
import { spawnChromiumWithExtension } from '../harness/chromium_ext.ts';
import {
  ALL_FEATURE_IDS,
  bootSharedTierContext,
  type TierNumber,
} from '../harness/tier_context.ts';
import { startFixtureWebAppServer } from '../fixtures/web_app_server.ts';
import { startMockLlmServer } from '../fixtures/mock_llm_server.ts';
import {
  InventoryThresholdError,
  assertInventoryThresholdsOrThrow,
  getRegisteredTests,
  validateInventoryThresholds,
  type RegisteredTestCase,
} from './registry.ts';

interface CliOptions {
  checkHarness: boolean;
  tier?: TierNumber;
  sutRoot: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let checkHarness = false;
  let tier: TierNumber | undefined;
  let sutRoot = process.env.GPUI_SUT_ROOT ?? DEFAULT_SUT_ROOT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check-harness') {
      checkHarness = true;
    } else if (arg === '--tier') {
      const next = argv[++i];
      if (!next || !/^[1-4]$/.test(next)) {
        throw new Error(`Invalid --tier value "${String(next)}" (expected 1, 2, 3, or 4)`);
      }
      tier = Number(next) as TierNumber;
    } else if (arg.startsWith('--tier=')) {
      const val = arg.slice('--tier='.length);
      if (!/^[1-4]$/.test(val)) {
        throw new Error(`Invalid --tier value "${val}" (expected 1, 2, 3, or 4)`);
      }
      tier = Number(val) as TierNumber;
    } else if (arg === '--sut-root') {
      const next = argv[++i];
      if (!next) throw new Error('--sut-root requires a directory path');
      sutRoot = path.resolve(next);
    } else if (arg.startsWith('--sut-root=')) {
      const val = arg.slice('--sut-root='.length);
      if (!val) throw new Error('--sut-root requires a directory path');
      sutRoot = path.resolve(val);
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return { checkHarness, tier, sutRoot };
}

function discoverTierTestFiles(): string[] {
  const tiersRoot = path.join(E2E_ROOT, 'src', 'tiers');
  const found: string[] = [];

  for (const tierName of ['tier1', 'tier2', 'tier3', 'tier4']) {
    const dir = path.join(tiersRoot, tierName);
    if (!fs.existsSync(dir)) continue;

    const walk = (currentDir: string): void => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
          found.push(fullPath);
        }
      }
    };
    walk(dir);
  }

  return found;
}

async function importAllTierTestFiles(): Promise<string[]> {
  const files = discoverTierTestFiles();
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
  return files;
}

async function runTypecheck(childEnv: NodeJS.ProcessEnv): Promise<void> {
  const tscBin = path.join(E2E_ROOT, 'node_modules', '.bin', 'tsc');
  const tsconfigPath = path.join(E2E_ROOT, 'tsconfig.json');

  await new Promise<void>((resolve, reject) => {
    const outChunks: string[] = [];
    const child = spawn(tscBin, ['--noEmit', '-p', tsconfigPath], {
      cwd: E2E_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChildProcess(child);
    child.stdout?.on('data', (c) => outChunks.push(c.toString('utf-8')));
    child.stderr?.on('data', (c) => outChunks.push(c.toString('utf-8')));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tsc --noEmit failed (exit ${code}):\n${outChunks.join('')}`));
      }
    });
  });
}

async function runHarnessSelfCheck(): Promise<number> {
  const tmpBefore = fs.existsSync('/tmp') ? new Set(fs.readdirSync('/tmp')) : new Set<string>();
  const checkEnv = allocateRunEnvironment('check-harness');

  try {
    console.log('[CHECK_HARNESS] 1/6 Running TypeScript strict typecheck (tsc --noEmit)...');
    assertPathOnXfs(checkEnv.runDir);
    await runTypecheck(checkEnv.buildChildEnv());
    console.log('[CHECK_HARNESS]     tsc --noEmit passed.');

    console.log('[CHECK_HARNESS] 2/6 Importing Tier 1-4 test modules & validating inventory...');
    const importedFiles = await importAllTierTestFiles();
    const invReport = validateInventoryThresholds();
    const formatFeatureMap = (counts: Record<string, number>): string =>
      ALL_FEATURE_IDS.map((f) => `${f}=${counts[f]}`).join(', ');
    console.log(
      `[CHECK_HARNESS]     Imported ${importedFiles.length} test files (${invReport.total} tests: T1=${invReport.byTier[1]}, T2=${invReport.byTier[2]}, T3=${invReport.byTier[3]}, T4=${invReport.byTier[4]}; 0 duplicate IDs).`,
    );
    console.log(
      `[CHECK_HARNESS]     Tier 1 per-feature: ${formatFeatureMap(invReport.byTierFeature[1])}`,
    );
    console.log(
      `[CHECK_HARNESS]     Tier 2 per-feature: ${formatFeatureMap(invReport.byTierFeature[2])}`,
    );
    assertInventoryThresholdsOrThrow();

    console.log('[CHECK_HARNESS] 3/6 Smoke-testing dual-stack FixtureWebAppServer (127.0.0.1 + ::1 localhost)...');
    const fixture = await startFixtureWebAppServer();
    try {
      const [healthResp, shopv4, shopLocalhost, cookieResp, injResp, slowResp] =
        await Promise.all([
          fetch(`${fixture.baseUrl}/health`),
          fetch(`${fixture.baseUrl}/shop`),
          fetch(`${fixture.localhostBaseUrl}/shop`),
          fetch(`${fixture.baseUrl}/cookies-and-downloads`),
          fetch(`${fixture.baseUrl}/adversarial/prompt-injection`),
          fetch(`${fixture.baseUrl}/slow?ms=40`),
        ]);
      assert.equal(healthResp.status, 200);
      assert.equal(shopv4.status, 200);
      assert.equal(shopLocalhost.status, 200);
      assert.ok((await shopv4.text()).includes('Fabushi Gear Store'));
      assert.ok((await shopLocalhost.text()).includes('Fabushi Gear Store'));

      const setCookies = cookieResp.headers.getSetCookie();
      assert.ok(
        setCookies.some((c) => c.includes('gpui_public_pref=theme_night')),
        'Expected public cookie header',
      );
      assert.ok(
        setCookies.some(
          (c) =>
            c.includes('gpui_session_secret=SUPER_SECRET_HTTPONLY_TOKEN_991') &&
            /HttpOnly/i.test(c),
        ),
        'Expected HttpOnly secret cookie header',
      );
      assert.ok((await injResp.text()).includes('Ignore previous instructions'));
      assert.equal(slowResp.status, 200);

      console.log('[CHECK_HARNESS] 4/6 Smoke-testing MockLlmServer (JSON + multi-chunk SSE tool-calls)...');
      const mockLlm = await startMockLlmServer();
      try {
        mockLlm.registerScenario('harness_smoke', (ctx) => {
          if (ctx.turnIndex === 0) {
            return {
              reasoning: 'Inspecting storefront snapshot first...',
              toolCalls: [
                {
                  id: 'call_smoke_1',
                  name: 'browser_snapshot',
                  arguments: { tab_id: 42 },
                },
              ],
            };
          }
          const observedTitle = ctx.latestToolResult?.json?.title ?? 'unknown';
          return {
            reasoning: 'Synthesizing final answer...',
            content: `Verified title: ${observedTitle}`,
          };
        });

        const modelsResp = await fetch(`${mockLlm.v1BaseUrl}/models`);
        assert.equal(modelsResp.status, 200);
        const modelsJson = (await modelsResp.json()) as { data: Array<{ id: string }> };
        assert.ok(modelsJson.data.some((m) => m.id === 'gpt-4o'));

        // Turn 0: Non-streaming JSON tool call
        const turn0Resp = await fetch(`${mockLlm.v1BaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            stream: false,
            messages: [{ role: 'user', content: '[E2E_SCENARIO:harness_smoke] Check store' }],
          }),
        });
        assert.equal(turn0Resp.status, 200);
        const turn0Json = (await turn0Resp.json()) as any;
        assert.equal(turn0Json.choices[0].finish_reason, 'tool_calls');
        assert.equal(turn0Json.choices[0].message.tool_calls[0].function.name, 'browser_snapshot');

        // Turn 1: Streaming SSE completion with tool result
        const turn1Resp = await fetch(`${mockLlm.v1BaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            stream: true,
            messages: [
              { role: 'user', content: '[E2E_SCENARIO:harness_smoke] Check store' },
              turn0Json.choices[0].message,
              {
                role: 'tool',
                tool_call_id: 'call_smoke_1',
                name: 'browser_snapshot',
                content: JSON.stringify({ ok: true, title: 'Fabushi Gear Store' }),
              },
            ],
          }),
        });
        assert.equal(turn1Resp.status, 200);
        assert.ok(
          (turn1Resp.headers.get('content-type') ?? '').includes('text/event-stream'),
        );
        const sseRaw = await turn1Resp.text();
        assert.ok(sseRaw.includes('data: [DONE]'), 'Expected SSE [DONE] terminator');
        assert.ok(sseRaw.includes('reasoning_content'), 'Expected SSE reasoning_content delta');

        let assembledContent = '';
        for (const line of sseRaw.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === 'string') {
            assembledContent += delta.content;
          }
        }
        assert.equal(assembledContent, 'Verified title: Fabushi Gear Store');
        assert.equal(mockLlm.recordedRequests.length, 2);

        console.log('[CHECK_HARNESS] 5/6 Smoke-testing real Chromium 156 CDP navigation, React _valueTracker & PNG screenshot...');
        const chrome = await spawnChromiumWithExtension({
          runEnv: checkEnv,
          loadExtension: false,
        });
        try {
          const shopPage = await chrome.openPage(`${fixture.baseUrl}/shop`, {
            width: 1280,
            height: 800,
          });
          try {
            assert.equal(await shopPage.title(), 'Fabushi Gear Store');
            await shopPage.click('button.add-to-cart-btn[data-sku="SKU-KB-02"]');
            await shopPage.waitForText('1', { selector: '#cart-count' });
          } finally {
            await shopPage.close();
          }

          const checkoutPage = await chrome.openPage(
            `${fixture.localhostBaseUrl}/shop/checkout`,
            { width: 1280, height: 800 },
          );
          try {
            // Verify naive .value assignment fails React _valueTracker validation
            await checkoutPage.eval(() => {
              const fn = document.getElementById('checkout-fullname') as HTMLInputElement;
              fn.value = 'Naive Setter Bypass';
              fn.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await checkoutPage.click('#place-order-btn');
            const errEl = await checkoutPage.waitForSelector('#checkout-error');
            assert.ok(errEl && errEl.text.includes('Missing required fields'));

            // Verify real CDP typing updates React controlled state and submits order
            await checkoutPage.type('#checkout-fullname', 'Lin Wei');
            await checkoutPage.type('#checkout-email', 'lin@example.com');
            await checkoutPage.type('#checkout-address', '88 West Lake Rd', { submit: true });
            const confirmEl = await checkoutPage.waitForSelector('#order-confirmation');
            assert.ok(confirmEl && confirmEl.text.includes('ORD-2026-8841'));
            assert.equal(fixture.submittedOrders.length, 1);

            const pngBuf = await checkoutPage.captureScreenshot();
            const pngMeta = assertValidPng(pngBuf, { minWidth: 800, minHeight: 600 });
            console.log(
              `[CHECK_HARNESS]     Captured valid PNG screenshot (${pngMeta.width}x${pngMeta.height}, ${pngMeta.byteLength} bytes).`,
            );
          } finally {
            await checkoutPage.close();
          }
        } finally {
          await chrome.stop();
        }
      } finally {
        await mockLlm.stop();
      }
    } finally {
      await fixture.stop();
    }

    console.log('[CHECK_HARNESS] 6/6 Self-testing verifySutArtifactsOrFail fail-fast guard...');
    assert.throws(
      () => verifySutArtifactsOrFail(path.join(checkEnv.runDir, 'does-not-exist')),
      (err: unknown) => err instanceof SutMissingError && err.exitCode === 2,
    );

    // Also test corrupted WASM header rejection
    const fakeSut = path.join(checkEnv.runDir, 'corrupt-wasm-sut');
    const fakeBinDir = path.join(fakeSut, 'target', 'debug');
    const fakeDistDir = path.join(fakeSut, 'browser-extension', 'dist');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(path.join(fakeDistDir, 'assets'), { recursive: true });
    for (const b of ['gpui_telegram_server', 'gpui_telegram_desktop']) {
      const bp = path.join(fakeBinDir, b);
      fs.writeFileSync(bp, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), { mode: 0o755 });
    }
    fs.writeFileSync(
      path.join(fakeDistDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'test', version: '1.0.0' }),
    );
    for (const f of [
      'background.js',
      'content.js',
      'workspace.html',
      'sidepanel.html',
      'popup.html',
      'options.html',
    ]) {
      fs.writeFileSync(path.join(fakeDistDir, f), '// stub');
    }
    fs.writeFileSync(
      path.join(fakeDistDir, 'assets', 'gpui_telegram_ext_wasm.wasm'),
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x00, 0x00, 0x00]),
    );
    assert.throws(
      () => verifySutArtifactsOrFail(fakeSut),
      (err: unknown) => err instanceof SutMissingError && err.exitCode === 2,
    );

    await checkEnv.cleanup();
    await cleanupAllTrackedResources();

    // Verify zero leftover checkEnv dirs and zero new files in /tmp
    assert.ok(!fs.existsSync(checkEnv.runDir), `Expected ${checkEnv.runDir} to be removed`);
    assert.ok(!fs.existsSync(checkEnv.shmDir), `Expected ${checkEnv.shmDir} to be removed`);

    if (fs.existsSync(SHM_ROOT)) {
      const leftoverShm = fs
        .readdirSync(SHM_ROOT)
        .filter((n) => n.startsWith(`${SHM_PREFIX}${process.pid}-`));
      assert.equal(
        leftoverShm.length,
        0,
        `Leftover /dev/shm directories detected: ${leftoverShm.join(', ')}`,
      );
    }

    if (fs.existsSync('/tmp')) {
      const tmpAfter = fs.readdirSync('/tmp');
      const addedInTmp = tmpAfter.filter(
        (entry) =>
          !tmpBefore.has(entry) &&
          !isVmDaemonTmpEntry(entry) &&
          isE2eRelatedTmpEntry(entry),
      );
      assert.equal(
        addedInTmp.length,
        0,
        `Zero-pollution violation: new E2E/Chromium files created in /tmp: ${addedInTmp.join(', ')}`,
      );
    }

    console.log('[CHECK_HARNESS_OK] All harness self-checks passed cleanly.');
    return 0;
  } catch (err) {
    await checkEnv.cleanup().catch(() => undefined);
    await cleanupAllTrackedResources().catch(() => undefined);
    if (err instanceof InventoryThresholdError) {
      console.error(err.message);
      return 1;
    }
    console.error('[CHECK_HARNESS_FAILED]', err instanceof Error ? err.stack ?? err.message : err);
    return 1;
  }
}

async function executeTestWithTimeout(
  testCase: RegisteredTestCase,
  runFn: () => Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runFn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`Test ${testCase.id} timed out after ${testCase.timeoutMs}ms`),
          );
        }, testCase.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runE2eSuite(opts: CliOptions): Promise<number> {
  // 1. Strict fail-fast SUT preflight check BEFORE running any tier (exit code 2 on missing SUT)
  try {
    verifySutArtifactsOrFail(opts.sutRoot);
  } catch (err) {
    await cleanupAllTrackedResources();
    if (err instanceof SutMissingError) {
      console.error(err.message);
      return err.exitCode;
    }
    console.error('[SUT_PREFLIGHT_ERROR]', err);
    return 2;
  }

  // 2. Import all registered test files and enforce strict coverage thresholds
  await importAllTierTestFiles();
  try {
    assertInventoryThresholdsOrThrow(opts.tier ? { tier: opts.tier } : {});
  } catch (err) {
    await cleanupAllTrackedResources();
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const tiersToRun: TierNumber[] = opts.tier ? [opts.tier] : [1, 2, 3, 4];
  let totalPassed = 0;
  let totalFailed = 0;
  const failures: Array<{ id: string; tier: TierNumber; title: string; error: string }> = [];
  const suiteStartMs = Date.now();

  for (const tier of tiersToRun) {
    const tierTests = getRegisteredTests(tier);
    console.log(
      `\n================================================================================\n` +
        `[TIER ${tier}] Booting SharedTierContext for ${tierTests.length} tests...\n` +
        `================================================================================`,
    );

    const ctx = await bootSharedTierContext(tier, opts.sutRoot);
    let tierPassed = 0;
    let tierFailed = 0;

    try {
      for (let i = 0; i < tierTests.length; i++) {
        const tc = tierTests[i];
        const startMs = Date.now();
        try {
          await executeTestWithTimeout(tc, async () => {
            await tc.fn(ctx);
          });
          const elapsed = Date.now() - startMs;
          tierPassed++;
          totalPassed++;
          console.log(
            `  [PASS] (${i + 1}/${tierTests.length}) ${tc.id} [${tc.features.join(',')}] — ${tc.title} (${elapsed}ms)`,
          );
        } catch (err) {
          const elapsed = Date.now() - startMs;
          tierFailed++;
          totalFailed++;
          const errStr = err instanceof Error ? err.stack ?? err.message : String(err);
          failures.push({ id: tc.id, tier, title: tc.title, error: errStr });
          console.error(
            `  [FAIL] (${i + 1}/${tierTests.length}) ${tc.id} [${tc.features.join(',')}] — ${tc.title} (${elapsed}ms)\n    ${errStr.split('\n').join('\n    ')}`,
          );
        } finally {
          await ctx.resetBetweenTests();
        }
      }
    } finally {
      await ctx.teardown();
    }

    console.log(
      `[TIER ${tier} SUMMARY] Passed: ${tierPassed}/${tierTests.length}, Failed: ${tierFailed}`,
    );
  }

  await cleanupAllTrackedResources();

  const totalRun = totalPassed + totalFailed;
  const totalElapsedSec = ((Date.now() - suiteStartMs) / 1000).toFixed(2);
  console.log(
    `\n================================================================================\n` +
      `[E2E FINAL REPORT] Passed: ${totalPassed}/${totalRun} | Failed: ${totalFailed} | Elapsed: ${totalElapsedSec}s\n` +
      `================================================================================`,
  );

  if (failures.length > 0) {
    console.error('\nFailed Tests Summary:');
    for (const f of failures) {
      console.error(`  - [Tier ${f.tier}] ${f.id} (${f.title}): ${f.error.split('\n')[0]}`);
    }
    return 1;
  }

  return totalRun > 0 ? 0 : 1;
}

async function main(): Promise<void> {
  installGlobalCleanupHooks();
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[CLI_ARG_ERROR]', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (opts.checkHarness) {
    const code = await runHarnessSelfCheck();
    process.exitCode = code;
    return;
  }

  const code = await runE2eSuite(opts);
  process.exitCode = code;
}

void main().catch(async (err) => {
  console.error('[FATAL_RUNNER_ERROR]', err instanceof Error ? err.stack ?? err.message : err);
  await cleanupAllTrackedResources().catch(() => undefined);
  process.exit(1);
});
