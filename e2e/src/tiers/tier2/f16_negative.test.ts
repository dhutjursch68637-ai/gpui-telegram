import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defineTest,
  assert,
  assertPathOnXfs,
  assertWasmMagic,
  isVmDaemonTmpEntry,
  SutMissingError,
  verifySutArtifactsOrFail,
  type SharedTierContext,
} from '../../harness/index.ts';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.ogg',
  '.mp4',
  '.webm',
  '.pdf',
  '.zip',
  '.gz',
]);

function isIntentionalTestFixtureToken(matched: string, relFilePath: string): boolean {
  const lowerMatch = matched.toLowerCase();
  if (
    lowerMatch.includes('fake') ||
    lowerMatch.includes('mock') ||
    lowerMatch.includes('dummy') ||
    lowerMatch.includes('example') ||
    lowerMatch.includes('sample') ||
    lowerMatch.includes('test') ||
    lowerMatch.includes('redacted') ||
    lowerMatch.includes('placeholder') ||
    lowerMatch.includes('00000000') ||
    lowerMatch.includes('1234567890abcdef')
  ) {
    return true;
  }
  const lowerPath = relFilePath.toLowerCase();
  return (
    lowerPath.includes('test') ||
    lowerPath.includes('fixture') ||
    lowerPath.endsWith('security.rs')
  );
}

function buildValidSyntheticSutTree(targetRoot: string): void {
  const binDir = path.join(targetRoot, 'target', 'debug');
  const distDir = path.join(targetRoot, 'browser-extension', 'dist');
  const assetsDir = path.join(distDir, 'assets');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(assetsDir, { recursive: true, mode: 0o700 });

  const elfStub = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  fs.writeFileSync(path.join(binDir, 'gpui_telegram_server'), elfStub, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'gpui_telegram_desktop'), elfStub, { mode: 0o755 });

  fs.writeFileSync(
    path.join(distDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Synthetic Preflight Probe',
      version: '1.0.0',
      background: { service_worker: 'background.js', type: 'module' },
      content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
    }),
  );

  for (const rel of [
    'background.js',
    'content.js',
    'workspace.html',
    'sidepanel.html',
    'popup.html',
    'options.html',
  ]) {
    fs.writeFileSync(path.join(distDir, rel), '/* non-empty preflight fixture */\n');
  }

  // Valid minimal 8-byte WebAssembly v1 module header: \0asm\x01\x00\x00\x00
  fs.writeFileSync(
    path.join(assetsDir, 'gpui_telegram_ext_wasm.wasm'),
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
}

defineTest({
  id: 'T2-F16-01',
  title: 'Read-only scan of git-tracked files in /home/antigravity/gpui-telegram finds zero leaked secrets or committed .env files',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    const rawTracked = execFileSync(
      'git',
      ['--no-optional-locks', '-C', ctx.sutRoot, 'ls-files', '-z'],
      {
        cwd: ctx.runDir,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const trackedFiles = rawTracked.split('\0').filter((f) => f.length > 0);
    assert.ok(
      trackedFiles.length > 20,
      `Expected git ls-files on ${ctx.sutRoot} to return tracked workspace files, got ${trackedFiles.length}`,
    );

    const forbiddenDotEnv = trackedFiles.filter((rel) => {
      const base = path.basename(rel);
      return (
        base === '.env' ||
        base === '.env.local' ||
        base === '.env.production' ||
        base === '.env.development'
      );
    });
    assert.equal(
      forbiddenDotEnv.length,
      0,
      `Forbidden live .env files tracked in git index: ${forbiddenDotEnv.join(', ')}`,
    );

    const secretPatterns: Array<{ label: string; regex: RegExp }> = [
      { label: 'GitHub Token (ghp_/ghs_/gho_/ghu_)', regex: /\bgh[psou]_[A-Za-z0-9]{36,}\b/g },
      { label: 'GitHub Fine-Grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
      { label: 'OpenAI Secret Key (sk-proj-)', regex: /\bsk-proj-[A-Za-z0-9_-]{28,}\b/g },
      { label: 'Google API Key (AIzaSy)', regex: /\bAIzaSy[A-Za-z0-9_-]{33}\b/g },
      {
        label: 'PEM Private Key Block',
        regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
      },
    ];

    const leaks: string[] = [];
    for (const rel of trackedFiles) {
      const ext = path.extname(rel).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const absPath = path.join(ctx.sutRoot, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;

      const content = fs.readFileSync(absPath, 'utf-8');
      for (const { label, regex } of secretPatterns) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          if (!isIntentionalTestFixtureToken(match[0], rel)) {
            leaks.push(`${rel}: ${label} (${match[0].slice(0, 14)}...)`);
          }
        }
      }
    }

    assert.equal(
      leaks.length,
      0,
      `Detected leaked credentials in tracked repository files:\n  ${leaks.join('\n  ')}`,
    );
  },
});

defineTest({
  id: 'T2-F16-02',
  title: 'Zero runtime pollution inside /home/antigravity/gpui-telegram, /tmp (excluding VM daemons), and /home/antigravity/.gemini/jetski',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    // 1. Verify active E2E runDir is on XFS / local filesystem (never virtiofs)
    const fsType = assertPathOnXfs(ctx.runDir);
    assert.notEqual(fsType, 'virtiofs');

    // 2. Read-only check on /home/antigravity/gpui-telegram for untracked E2E runtime artifacts
    const statusRaw = execFileSync(
      'git',
      ['--no-optional-locks', '-C', ctx.sutRoot, 'status', '--porcelain', '--untracked-files=all'],
      {
        cwd: ctx.runDir,
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const pollutedSutPaths = statusRaw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((line) =>
        /(\.db(-wal|-shm)?$|\.tantivy|\.e2e-runs|chrome-profile|SingletonSocket|browser_bridge\.json|server_cwd|server_data)/i.test(
          line,
        ),
      );
    assert.equal(
      pollutedSutPaths.length,
      0,
      `Zero-pollution violation inside ${ctx.sutRoot}: ${pollutedSutPaths.join('; ')}`,
    );

    // 3. Read-only check on /tmp (filtering VM background daemon sockets via isVmDaemonTmpEntry)
    if (fs.existsSync('/tmp')) {
      const tmpEntries = fs.readdirSync('/tmp').filter((name) => !isVmDaemonTmpEntry(name));
      const e2eTmpPollution = tmpEntries.filter((name) =>
        /^(gpui|fabushi|e2e|\.org\.chromium|org\.chromium|chromium|Singleton|hermes)/i.test(name),
      );
      assert.equal(
        e2eTmpPollution.length,
        0,
        `Zero-pollution violation in /tmp: found E2E/Chromium artifacts [${e2eTmpPollution.join(', ')}]`,
      );
    }

    // 4. Read-only check on /home/antigravity/.gemini/jetski (virtiofs)
    const jetskiDir = '/home/antigravity/.gemini/jetski';
    if (fs.existsSync(jetskiDir)) {
      const jetskiTop = fs.readdirSync(jetskiDir);
      const jetskiPollution = jetskiTop.filter((name) =>
        /(\.e2e-runs|chrome-profile|gpui_telegram\.db|SingletonSocket)/i.test(name),
      );
      assert.equal(
        jetskiPollution.length,
        0,
        `Zero-pollution violation in ${jetskiDir}: [${jetskiPollution.join(', ')}]`,
      );
    }
  },
});

defineTest({
  id: 'T2-F16-03',
  title: 'browser-extension/dist/ HTML & JS bundles satisfy MV3 store compliance (no remote <script>, no unsafe-eval / unsafe-inline)',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    const manifestRaw = fs.readFileSync(ctx.sutPaths.manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as Record<string, any>;
    assert.equal(manifest.manifest_version, 3);

    // 1. Inspect MV3 Content Security Policy
    const cspObj = manifest.content_security_policy;
    const extPagesCsp =
      typeof cspObj === 'string'
        ? cspObj
        : String(cspObj?.extension_pages ?? '');
    assert.ok(
      extPagesCsp.includes("'wasm-unsafe-eval'"),
      `MV3 extension_pages CSP must include 'wasm-unsafe-eval', got: ${extPagesCsp}`,
    );

    const cspWithoutWasm = extPagesCsp.replace(/'wasm-unsafe-eval'/g, '');
    assert.ok(
      !cspWithoutWasm.includes("'unsafe-eval'"),
      `MV3 CSP must NOT allow 'unsafe-eval': ${extPagesCsp}`,
    );

    // Extract script-src directive to ensure no 'unsafe-inline' or remote http/https origins
    const scriptSrcDirective =
      extPagesCsp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('script-src')) ?? '';
    assert.ok(
      !scriptSrcDirective.includes("'unsafe-inline'"),
      `MV3 script-src must NOT contain 'unsafe-inline': ${scriptSrcDirective}`,
    );
    assert.ok(
      !/https?:/i.test(scriptSrcDirective),
      `MV3 script-src must NOT reference remote HTTP/HTTPS script hosts: ${scriptSrcDirective}`,
    );

    // 2. Inspect all HTML entry surfaces in dist/ for remote <script src="http..."> or inline scripts
    const htmlFiles: string[] = [];
    const walkDist = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDist(full);
        else if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(full);
      }
    };
    walkDist(ctx.sutPaths.extDistDir);
    assert.ok(htmlFiles.length >= 4, `Expected >=4 HTML surfaces in dist/, found ${htmlFiles.length}`);

    for (const htmlFile of htmlFiles) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      for (const tag of scriptTags) {
        const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
        assert.ok(
          srcMatch !== null,
          `MV3 forbids inline <script> blocks without src in ${path.basename(htmlFile)}: ${tag.slice(0, 120)}`,
        );
        const srcUrl = srcMatch[1].trim();
        assert.ok(
          !/^(https?:)?\/\//i.test(srcUrl),
          `MV3 forbids remote CDN <script src="${srcUrl}"> in ${path.basename(htmlFile)}`,
        );
      }
    }
  },
});

defineTest({
  id: 'T2-F16-04',
  title: 'verifySutArtifactsOrFail deterministically throws SutMissingError (exitCode === 2) when server, desktop, manifest, or WASM is missing/corrupt',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    const synthRoot = path.join(ctx.runDir, `f16-preflight-unit-${Date.now()}`);
    fs.mkdirSync(synthRoot, { recursive: true, mode: 0o700 });

    try {
      // Positive control: complete synthetic tree passes verifySutArtifactsOrFail
      const controlDir = path.join(synthRoot, 'valid-control');
      buildValidSyntheticSutTree(controlDir);
      const okResult = verifySutArtifactsOrFail(controlDir);
      assert.equal(okResult.manifest.manifest_version, 3);

      const cases: Array<{
        name: string;
        mutate: (dir: string) => void;
        expectedPathSuffix: string;
      }> = [
        {
          name: 'missing_server_bin',
          mutate: (dir) => fs.rmSync(path.join(dir, 'target', 'debug', 'gpui_telegram_server')),
          expectedPathSuffix: 'gpui_telegram_server',
        },
        {
          name: 'missing_desktop_bin',
          mutate: (dir) => fs.rmSync(path.join(dir, 'target', 'debug', 'gpui_telegram_desktop')),
          expectedPathSuffix: 'gpui_telegram_desktop',
        },
        {
          name: 'missing_manifest_json',
          mutate: (dir) => fs.rmSync(path.join(dir, 'browser-extension', 'dist', 'manifest.json')),
          expectedPathSuffix: 'manifest.json',
        },
        {
          name: 'missing_wasm_binary',
          mutate: (dir) =>
            fs.rmSync(
              path.join(
                dir,
                'browser-extension',
                'dist',
                'assets',
                'gpui_telegram_ext_wasm.wasm',
              ),
            ),
          expectedPathSuffix: 'gpui_telegram_ext_wasm.wasm',
        },
        {
          name: 'corrupted_wasm_magic_header',
          mutate: (dir) =>
            fs.writeFileSync(
              path.join(
                dir,
                'browser-extension',
                'dist',
                'assets',
                'gpui_telegram_ext_wasm.wasm',
              ),
              Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x00, 0x00, 0x00]),
            ),
          expectedPathSuffix: 'gpui_telegram_ext_wasm.wasm',
        },
      ];

      for (const tc of cases) {
        const caseDir = path.join(synthRoot, tc.name);
        buildValidSyntheticSutTree(caseDir);
        tc.mutate(caseDir);

        let caught: unknown = null;
        try {
          verifySutArtifactsOrFail(caseDir);
        } catch (err) {
          caught = err;
        }
        assert.ok(
          caught instanceof SutMissingError,
          `Case "${tc.name}" must throw SutMissingError, got: ${String(caught)}`,
        );
        assert.equal(
          caught.exitCode,
          2,
          `Case "${tc.name}" SutMissingError.exitCode must equal 2`,
        );
        assert.ok(
          caught.artifactPath.endsWith(tc.expectedPathSuffix),
          `Case "${tc.name}" expected artifactPath ending with "${tc.expectedPathSuffix}", got "${caught.artifactPath}"`,
        );
      }
    } finally {
      fs.rmSync(synthRoot, { recursive: true, force: true });
    }
  },
});

defineTest({
  id: 'T2-F16-05',
  title: '.github/workflows/ci.yml uses portable paths, installs wasm32-unknown-unknown, and builds both Rust and browser-extension',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    const workflowsDir = path.join(ctx.sutRoot, '.github', 'workflows');
    const primaryCiPath = path.join(workflowsDir, 'ci.yml');
    const altCiPath = path.join(workflowsDir, 'ci.yaml');
    const ciPath = fs.existsSync(primaryCiPath) ? primaryCiPath : altCiPath;

    assert.equal(
      fs.existsSync(ciPath),
      true,
      `Expected GitHub Actions workflow at ${primaryCiPath}`,
    );

    const ciRaw = fs.readFileSync(ciPath, 'utf-8');
    assert.ok(ciRaw.trim().length > 100, 'ci.yml must be non-empty');

    // Strip YAML comment lines before checking for hardcoded local VM paths
    const activeLines = ciRaw
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    assert.ok(
      !activeLines.includes('/home/antigravity'),
      '.github/workflows/ci.yml must NOT contain hardcoded /home/antigravity paths that fail on GitHub Actions runners',
    );
    assert.ok(
      !activeLines.includes('/Users/'),
      '.github/workflows/ci.yml must NOT contain hardcoded macOS /Users/ paths',
    );
    assert.ok(
      activeLines.includes('wasm32-unknown-unknown'),
      '.github/workflows/ci.yml must install and build the wasm32-unknown-unknown target',
    );
    assert.ok(
      /\bcargo\s+(check|build|test|clippy)\b/.test(activeLines),
      '.github/workflows/ci.yml must run cargo workspace verification commands',
    );
    assert.ok(
      activeLines.includes('browser-extension') && /\b(npm|npx|pnpm|yarn)\b/.test(activeLines),
      '.github/workflows/ci.yml must build/verify browser-extension',
    );
  },
});

defineTest({
  id: 'T2-F16-06',
  title: 'gpui_telegram_ext_wasm Cargo.toml & compiled .wasm imports require zero POSIX WASI syscalls and instantiate in MV3 browser context',
  tier: 2,
  features: ['F16'],
  fn: async (ctx: SharedTierContext) => {
    const extWasmCargoPath = path.join(
      ctx.sutRoot,
      'crates',
      'gpui_telegram_ext_wasm',
      'Cargo.toml',
    );
    assert.equal(
      fs.existsSync(extWasmCargoPath),
      true,
      `Expected ${extWasmCargoPath} to exist`,
    );

    const extWasmCargo = fs.readFileSync(extWasmCargoPath, 'utf-8');
    assert.ok(
      extWasmCargo.includes('cdylib'),
      'crates/gpui_telegram_ext_wasm/Cargo.toml must declare crate-type including "cdylib"',
    );

    // Inspect compiled .wasm binary magic bytes and WebAssembly.Module.imports(mod)
    assertWasmMagic(ctx.sutPaths.wasmPath);
    const wasmBytes = fs.readFileSync(ctx.sutPaths.wasmPath);
    const compiledMod = new WebAssembly.Module(wasmBytes);
    const nodeImports = WebAssembly.Module.imports(compiledMod);
    const nodeExports = WebAssembly.Module.exports(compiledMod).map((e) => e.name);

    for (const reqExport of ['memory', 'wasm_alloc', 'wasm_dealloc', 'wasm_invoke_json']) {
      assert.ok(
        nodeExports.includes(reqExport),
        `dist/assets/gpui_telegram_ext_wasm.wasm missing required C-ABI export "${reqExport}" (exports: ${nodeExports.join(', ')})`,
      );
    }

    const wasiPosixImports = nodeImports.filter((imp) =>
      /^wasi_(snapshot_preview1|unstable)/i.test(imp.module),
    );
    assert.equal(
      wasiPosixImports.length,
      0,
      `gpui_telegram_ext_wasm.wasm must target pure wasm32-unknown-unknown with zero WASI OS syscalls, found: ${JSON.stringify(wasiPosixImports)}`,
    );

    // Also verify live instantiation inside real Chromium 156 MV3 extension page under 'wasm-unsafe-eval'
    await ctx.withExtensionSurface('workspace', async (page) => {
      const browserInspection = await page.inspectWasm();
      assert.ok(browserInspection.exports.includes('wasm_invoke_json'));
      assert.ok(browserInspection.memoryByteLength >= 65536);
    });
  },
});
