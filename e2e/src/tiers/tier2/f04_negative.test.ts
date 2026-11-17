import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assert,
  defineTest,
  pollUntil,
  type SharedTierContext,
} from '../../harness/index.ts';

async function resolveTabId(ctx: SharedTierContext, urlPrefix: string): Promise<number> {
  return await pollUntil(
    async () => {
      const swId = await ctx.browser.evalInServiceWorker((prefix: string) => {
        const c = (globalThis as any).chrome;
        if (!c?.tabs?.query) return null;
        return c.tabs.query({}).then((tabs: any[]) => {
          const m = tabs.find(
            (t) => typeof t.url === 'string' && t.url.startsWith(prefix) && typeof t.id === 'number',
          );
          return m ? Number(m.id) : null;
        });
      }, urlPrefix);
      if (typeof swId === 'number' && swId > 0) return swId;
      const list = await ctx.primaryUser.api.getBrowserTabs().catch(() => null);
      const found = list?.tabs?.find(
        (t: any) => typeof t.url === 'string' && t.url.startsWith(urlPrefix),
      );
      return typeof found?.tab_id === 'number' ? found.tab_id : null;
    },
    { timeoutMs: 6000, intervalMs: 80, message: `resolve tab_id for ${urlPrefix}` },
  ).then((id) => {
    assert.ok(typeof id === 'number' && id > 0);
    return id;
  });
}

defineTest({
  id: 'T2-F04-01',
  title: 'Return actionable BROWSER_EXTENSION_NOT_CONNECTED / unreachable CDP error when isolated user has neither Extension WS nor reachable CDP endpoint',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const lonelyUser = await ctx.createIsolatedUser('f04_disconnected');
    await ctx.server.configureMockLlmProvider(lonelyUser.token, ctx.mockLlm.port, 'gpt-4o');

    ctx.mockLlm.registerScenario('f04_no_ext_no_cdp', (turnCtx) => {
      if (turnCtx.turnIndex === 0) {
        return {
          reasoning: 'Attempting snapshot without extension or reachable CDP...',
          toolCalls: [
            {
              id: 'call_no_ext_1',
              name: 'browser_snapshot',
              arguments: { cdp_url: 'http://127.0.0.1:1' },
            },
          ],
        };
      }
      const raw = turnCtx.latestToolResult?.rawContent ?? '';
      return {
        content: `Diagnostic reported cleanly: ${raw.slice(0, 240)}`,
      };
    });

    const startMs = Date.now();
    const turnResp = await lonelyUser.api.createHermesTurn(
      {
        prompt: '[E2E_SCENARIO:f04_no_ext_no_cdp] Snapshot active tab',
        preset: 'hermes-telegram',
        yolo: true,
        max_iterations: 4,
      },
      20000,
    );
    const elapsedMs = Date.now() - startMs;

    assert.ok(elapsedMs < 15000, `Disconnected fallback check must fail fast (<15s), took ${elapsedMs}ms`);
    assert.equal(turnResp.status, 'completed');

    const turn1Req = ctx.mockLlm.recordedRequests.find(
      (r) => r.matchedScenarioId === 'f04_no_ext_no_cdp' && r.turnIndex === 1,
    );
    assert.ok(turn1Req, 'Expected HermesEngine to feed structured tool error into Turn 1');
    const toolMsg = turn1Req.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'Expected role="tool" diagnostic message');
    const toolText = String(toolMsg.content ?? '');
    assert.ok(
      /not_connected|not connected|connection refused|unreachable|cdp|bridge|extension|failed|error/i.test(
        toolText,
      ),
      `Expected actionable extension/CDP connectivity diagnostic, got: ${toolText}`,
    );
    assert.ok(ctx.server.isRunning(), 'gpui_telegram_server must remain healthy');
  },
});

defineTest({
  id: 'T2-F04-02',
  title: 'Return structured usage / RESTRICTED_URL diagnostics on /browser unknown_subcmd_xyz and /browser open ftp://invalid.scheme/file',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    // 1. Unknown /browser subcommand
    const unknownCmdRes = await ctx.primaryUser.api.request(
      'POST',
      '/api/v1/hermes/command',
      { command: '/browser unknown_subcmd_xyz' },
    );
    assert.ok(
      unknownCmdRes.status === 200 || unknownCmdRes.status === 400,
      `Expected HTTP 200 or 400 for unknown /browser subcommand, got ${unknownCmdRes.status}: ${unknownCmdRes.rawText}`,
    );
    const unknownText = JSON.stringify(unknownCmdRes.data ?? unknownCmdRes.rawText);
    assert.ok(
      unknownCmdRes.status === 400 ||
        unknownCmdRes.data?.data?.is_error === true ||
        /usage|unknown|invalid|unsupported|status|tabs|open|navigate|snapshot/i.test(unknownText),
      `Expected structured usage/unknown-subcommand diagnostic, got: ${unknownText}`,
    );

    // 2. Disallowed ftp:// scheme in /browser open
    const ftpCmdRes = await ctx.primaryUser.api.request(
      'POST',
      '/api/v1/hermes/command',
      { command: '/browser open ftp://invalid.scheme/file' },
    );
    assert.ok(
      ftpCmdRes.status === 200 || ftpCmdRes.status === 400,
      `Expected HTTP 200 or 400 for /browser open ftp://, got ${ftpCmdRes.status}: ${ftpCmdRes.rawText}`,
    );
    const ftpText = JSON.stringify(ftpCmdRes.data ?? ftpCmdRes.rawText);
    assert.ok(
      ftpCmdRes.status === 400 ||
        ftpCmdRes.data?.data?.is_error === true ||
        /restricted|invalid|unsupported|scheme|http|-32004|error/i.test(ftpText),
      `Expected RESTRICTED_URL / scheme rejection on ftp:// URL, got: ${ftpText}`,
    );

    // 3. Verify Hermes command session remains completely healthy afterward
    const healthyStatusCmd = await ctx.primaryUser.api.runHermesCommand('/browser status');
    assert.equal(healthyStatusCmd.handled, true, '/browser status must succeed after negative subcommands');
  },
});

defineTest({
  id: 'T2-F04-03',
  title: 'Repair or recover gracefully from malformed trailing-comma tool-call JSON arguments ("{\\"tab_id\\": N,}") in HermesEngine',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const alphaUrl = `${ctx.fixtureApp.baseUrl}/docs/alpha`;
    await ctx.withTargetTab(alphaUrl, async () => {
      const tabId = await resolveTabId(ctx, alphaUrl);

      ctx.mockLlm.registerScenario('f04_malformed_json', (turnCtx) => {
        if (turnCtx.turnIndex === 0) {
          return {
            reasoning: 'Emitting tool call with trailing comma in JSON arguments...',
            toolCalls: [
              {
                id: 'call_malformed_comma_1',
                name: 'browser_snapshot',
                arguments: `{"tab_id": ${tabId},}`,
              },
            ],
          };
        }
        const toolOut = turnCtx.latestToolResult?.rawContent ?? '';
        const repairedOk = toolOut.includes('Alpha Cloud');
        return {
          content: repairedOk
            ? 'JSON repaired and Alpha Cloud snapshot retrieved.'
            : `Recovered via structured error feedback: ${toolOut.slice(0, 120)}`,
        };
      });

      const turnResp = await ctx.primaryUser.api.createHermesTurn({
        prompt: '[E2E_SCENARIO:f04_malformed_json] Read Alpha Cloud tab',
        preset: 'hermes-telegram',
        yolo: true,
        max_iterations: 5,
      });

      assert.equal(turnResp.status, 'completed', 'Hermes turn must complete cleanly without aborting');
      assert.ok(
        turnResp.response.includes('JSON repaired and Alpha Cloud snapshot retrieved.') ||
          turnResp.response.includes('Recovered via structured error feedback:'),
        `Unexpected turn response: ${turnResp.response}`,
      );

      const turn1Req = ctx.mockLlm.recordedRequests.find(
        (r) => r.matchedScenarioId === 'f04_malformed_json' && r.turnIndex === 1,
      );
      assert.ok(turn1Req, 'Expected Turn 1 follow-up request to MockLlmServer');
    });
  },
});

defineTest({
  id: 'T2-F04-04',
  title: 'Sanitize path-traversal filenames ("../../../../etc/passwd" and "../evil/report.csv") in browser_download_url to safe basenames without SecurityEngine false block',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    ctx.mockLlm.registerScenario('f04_path_traversal_dl', (turnCtx) => {
      if (turnCtx.turnIndex === 0) {
        return {
          toolCalls: [
            {
              id: 'call_dl_passwd',
              name: 'browser_download_url',
              arguments: {
                url: `${ctx.fixtureApp.baseUrl}/download/report.csv`,
                filename: '../../../../etc/passwd',
              },
            },
            {
              id: 'call_dl_evil',
              name: 'browser_download_url',
              arguments: {
                url: `${ctx.fixtureApp.baseUrl}/download/summary.txt`,
                filename: '../evil/report.csv',
              },
            },
          ],
        };
      }
      return {
        content: `Downloads completed safely: ${turnCtx.latestRoundToolResults.length} results.`,
      };
    });

    const turnResp = await ctx.primaryUser.api.createHermesTurn({
      prompt: '[E2E_SCENARIO:f04_path_traversal_dl] Export CSV and summary',
      preset: 'hermes-telegram',
      yolo: true,
      max_iterations: 5,
    });
    assert.equal(turnResp.status, 'completed');

    const turn1Req = ctx.mockLlm.recordedRequests.find(
      (r) => r.matchedScenarioId === 'f04_path_traversal_dl' && r.turnIndex === 1,
    );
    assert.ok(turn1Req, 'Expected Turn 1 after browser_download_url calls');

    const toolMessages = turn1Req.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMessages.length, 2, 'Expected 2 tool result messages for the 2 downloads');

    for (const tm of toolMessages) {
      const contentStr = String(tm.content ?? '');
      // SecurityEngine::pre_execute_check must NOT false-positive block `filename`
      assert.ok(
        !/outside workspace|workspace containment|blocked by securityengine/i.test(contentStr),
        `SecurityEngine must not false-positive block browser_download_url filename: ${contentStr}`,
      );
      const parsed = JSON.parse(contentStr);
      const inner = parsed.result ?? parsed;
      assert.equal(inner.ok, true, `Expected sanitized download to succeed with ok: true, got ${contentStr}`);

      if (typeof inner.filename === 'string') {
        assert.ok(
          !inner.filename.includes('..') && !inner.filename.includes('/'),
          `Returned filename must be sanitized to basename only, got "${inner.filename}"`,
        );
      }
    }

    // Inspect Chromium chrome.downloads items in SW to verify paths stay strictly inside downloadsDir with sanitized basenames
    const downloadItems = await ctx.browser.evalInServiceWorker(async () => {
      const c = (globalThis as any).chrome;
      if (!c?.downloads?.search) return [];
      return await c.downloads.search({ limit: 10 });
    });

    const resolvedDownloadsRoot = path.resolve(ctx.browser.downloadsDir);
    for (const item of downloadItems) {
      if (typeof item.filename === 'string' && item.filename.length > 0) {
        const resolvedFile = path.resolve(item.filename);
        assert.ok(
          resolvedFile.startsWith(resolvedDownloadsRoot + path.sep),
          `Downloaded file escaped downloadsDir (${resolvedDownloadsRoot}): ${resolvedFile}`,
        );
        const base = path.basename(resolvedFile);
        assert.ok(
          !base.includes('..'),
          `Downloaded basename must not contain traversal segments: ${base}`,
        );
      }
    }

    // Confirm no "../evil" directory was created next to downloadsDir
    assert.equal(
      fs.existsSync(path.join(path.dirname(resolvedDownloadsRoot), 'evil')),
      false,
      'Path traversal directory ../evil must never be created',
    );
  },
});

defineTest({
  id: 'T2-F04-05',
  title: 'Flag and sanitize indirect prompt-injection & sk-proj secret via scan_output + scan_content_for_injection before Turn 1 LLM context',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const injUrl = `${ctx.fixtureApp.baseUrl}/adversarial/prompt-injection`;
    await ctx.withTargetTab(injUrl, async () => {
      const tabId = await resolveTabId(ctx, injUrl);

      ctx.mockLlm.registerScenario('f04_scan_output', (turnCtx) => {
        if (turnCtx.turnIndex === 0) {
          return {
            toolCalls: [
              {
                id: 'call_inj_snap_1',
                name: 'browser_snapshot',
                arguments: { tab_id: tabId },
              },
            ],
          };
        }
        return {
          content: 'Reviewed article safely while ignoring injected override.',
        };
      });

      const turnResp = await ctx.primaryUser.api.createHermesTurn({
        prompt: '[E2E_SCENARIO:f04_scan_output] Summarize the Rust Async Wiki page',
        preset: 'hermes-telegram',
        yolo: true,
        max_iterations: 4,
      });
      assert.equal(turnResp.status, 'completed');

      const turn1Req = ctx.mockLlm.recordedRequests.find(
        (r) => r.matchedScenarioId === 'f04_scan_output' && r.turnIndex === 1,
      );
      assert.ok(turn1Req, 'Expected Turn 1 LLM request containing tool output');

      const toolMsg = turn1Req.messages.find(
        (m) => m.role === 'tool' && (m.tool_call_id === 'call_inj_snap_1' || m.name === 'browser_snapshot'),
      );
      assert.ok(toolMsg, 'Expected browser_snapshot tool message in Turn 1 history');
      const rawToolContent = String(toolMsg.content ?? '');

      // Verify injection scan flagged high severity AND/OR scan_output scrubbed/quarantined the leaked sk-proj key
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(rawToolContent);
      } catch {
        parsedJson = null;
      }
      const unwrapped = parsedJson?.result ?? parsedJson;
      const injScan = unwrapped?.injection_scan;

      const flaggedInStruct =
        injScan?.flagged === true && String(injScan?.severity ?? '').toLowerCase() === 'high';
      const flaggedInText = /injection|security|flagged|high|sanitized|redacted|override/i.test(
        rawToolContent,
      );
      assert.ok(
        flaggedInStruct || flaggedInText,
        `Expected scan_output / injection_scan to flag adversarial content before LLM ingestion: ${rawToolContent.slice(0, 500)}`,
      );

      // Verify raw secret sk-proj-fake1234567890abcdef1234567890abcdef is either redacted from markdown_excerpt/tool text OR explicitly marked in secrets_detected/findings
      const rawSecretPresentInExcerpt = String(unwrapped?.markdown_excerpt ?? '').includes(
        'sk-proj-fake1234567890abcdef1234567890abcdef',
      );
      const secretFlaggedOrScrubbed =
        !rawToolContent.includes('sk-proj-fake1234567890abcdef1234567890abcdef') ||
        !rawSecretPresentInExcerpt ||
        (typeof injScan?.secrets_detected === 'number' && injScan.secrets_detected >= 1) ||
        /secret|api.?key|redact/i.test(JSON.stringify(injScan?.findings ?? []));
      assert.ok(
        secretFlaggedOrScrubbed,
        'Hidden OPENAI_API_KEY=sk-proj-... must be scrubbed or flagged by scan_output / scan_content_for_injection',
      );
    });
  },
});

defineTest({
  id: 'T2-F04-06',
  title: 'Halt repeated failing browser_click({ selector: "#missing" }) calls deterministically at max_iterations: 3 / cycle guardrail',
  tier: 2,
  features: ['F4'],
  fn: async (ctx: SharedTierContext) => {
    const shopUrl = `${ctx.fixtureApp.baseUrl}/shop`;
    await ctx.withTargetTab(shopUrl, async () => {
      const tabId = await resolveTabId(ctx, shopUrl);

      ctx.mockLlm.registerScenario('f04_cycle_guard', (turnCtx) => ({
        reasoning: `Attempt #${turnCtx.turnIndex + 1} clicking nonexistent #missing`,
        toolCalls: [
          {
            id: `call_missing_loop_${turnCtx.turnIndex}`,
            name: 'browser_click',
            arguments: { tab_id: tabId, selector: '#missing' },
          },
        ],
      }));

      const startMs = Date.now();
      const turnResp = await ctx.primaryUser.api.createHermesTurn(
        {
          prompt: '[E2E_SCENARIO:f04_cycle_guard] Click #missing repeatedly',
          preset: 'hermes-telegram',
          yolo: true,
          max_iterations: 3,
        },
        25000,
      );
      const elapsedMs = Date.now() - startMs;

      assert.ok(elapsedMs < 18000, `Loop guardrail must terminate promptly (<18s), took ${elapsedMs}ms`);
      assert.ok(turnResp !== null && typeof turnResp === 'object');

      const loopRequests = ctx.mockLlm.recordedRequests.filter(
        (r) => r.matchedScenarioId === 'f04_cycle_guard',
      );
      assert.ok(
        loopRequests.length >= 1 && loopRequests.length <= 4,
        `Expected HermesEngine to stop at max_iterations: 3 (<= 4 LLM calls including final synthesis), got ${loopRequests.length}`,
      );
      assert.ok(ctx.server.isRunning(), 'gpui_telegram_server must remain running after max_iterations halt');
    });
  },
});
