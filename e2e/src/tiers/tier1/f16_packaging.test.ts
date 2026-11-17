import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defineTest,
  assert,
  assertPathOnXfs,
  assertWasmMagic,
  type SharedTierContext,
} from '../../harness/index.ts';

function gitReadOnly(sutRoot: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('git', ['--no-optional-locks', '-C', sutRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim() };
  } catch (err: any) {
    return {
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout: String(err?.stdout ?? '').trim(),
    };
  }
}

defineTest({
  id: 'T1-F16-01',
  title: 'Monorepo git worktree on XFS contains all 4 architectural planes declared in PROJECT.md Code Layout',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    assertPathOnXfs(ctx.sutRoot);

    const insideWorkTree = gitReadOnly(ctx.sutRoot, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(insideWorkTree.status, 0, 'sutRoot must be a valid git worktree');
    assert.equal(insideWorkTree.stdout, 'true');

    const headRef = gitReadOnly(ctx.sutRoot, ['rev-parse', '--verify', 'HEAD']);
    assert.equal(headRef.status, 0, 'Git HEAD must resolve to a valid commit');
    assert.match(headRef.stdout, /^[0-9a-f]{40}$/);

    const requiredFiles = [
      'Cargo.toml',
      'crates/gpui_telegram_proto/src/browser_contracts.rs',
      'crates/gpui_telegram_ext_wasm/Cargo.toml',
      'crates/gpui_telegram_server/Cargo.toml',
      'crates/gpui_telegram_agent/Cargo.toml',
      'crates/gpui_telegram_desktop/Cargo.toml',
      'browser-extension/package.json',
    ];

    for (const rel of requiredFiles) {
      const fullPath = path.join(ctx.sutRoot, rel);
      assert.equal(fs.existsSync(fullPath), true, `Missing required monorepo file: ${rel}`);
      const st = fs.statSync(fullPath);
      assert.ok(st.isFile() && st.size > 0, `Expected non-empty file at ${rel}`);
    }

    const rootCargo = fs.readFileSync(path.join(ctx.sutRoot, 'Cargo.toml'), 'utf-8');
    assert.ok(rootCargo.includes('[workspace]'), 'Root Cargo.toml must declare [workspace]');
    assert.ok(
      rootCargo.includes('gpui_telegram_ext_wasm'),
      'Root Cargo.toml workspace must include gpui_telegram_ext_wasm',
    );

    const wasmCargo = fs.readFileSync(
      path.join(ctx.sutRoot, 'crates/gpui_telegram_ext_wasm/Cargo.toml'),
      'utf-8',
    );
    assert.ok(wasmCargo.includes('cdylib'), 'gpui_telegram_ext_wasm/Cargo.toml must declare crate-type cdylib');
  },
});

defineTest({
  id: 'T1-F16-02',
  title: '.gitignore excludes target/, node_modules/, ephemeral .e2e-runs/, .local-sysroot/, and .env files',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    const gitignorePath = path.join(ctx.sutRoot, '.gitignore');
    assert.equal(fs.existsSync(gitignorePath), true, 'Root .gitignore must exist');
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(gitignoreContent.length > 20, '.gitignore must be non-empty');

    const ignoredProbes = [
      'target/debug/gpui_telegram_server',
      'browser-extension/node_modules/.package-lock.json',
      '.e2e-runs/probe-run/tmp',
      '.local-sysroot/usr/lib',
      '.env',
    ];

    for (const probe of ignoredProbes) {
      const res = gitReadOnly(ctx.sutRoot, ['check-ignore', '-q', probe]);
      assert.equal(
        res.status,
        0,
        `Expected git check-ignore to ignore "${probe}" via .gitignore`,
      );
    }
  },
});

defineTest({
  id: 'T1-F16-03',
  title: 'Root README.md and browser-extension documentation cover Rust/WASM/MV3 build, Desktop Bridge, and 24-tool browser control',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    const rootReadmePath = path.join(ctx.sutRoot, 'README.md');
    assert.equal(fs.existsSync(rootReadmePath), true, 'Root README.md must exist');
    const rootReadme = fs.readFileSync(rootReadmePath, 'utf-8');
    assert.ok(rootReadme.length > 500, `Root README.md must be >500 bytes (got ${rootReadme.length})`);

    const extReadmePath = path.join(ctx.sutRoot, 'browser-extension', 'README.md');
    const extReadme = fs.existsSync(extReadmePath)
      ? fs.readFileSync(extReadmePath, 'utf-8')
      : '';

    const combinedDocs = `${rootReadme}\n${extReadme}`;
    assert.ok(/cargo/i.test(combinedDocs), 'Documentation must cover Cargo Rust build');
    assert.ok(/wasm32-unknown-unknown|gpui_telegram_ext_wasm|wasm/i.test(combinedDocs), 'Documentation must cover WASM build');
    assert.ok(/browser-extension|manifest|chrome:\/\/extensions|--load-extension/i.test(combinedDocs), 'Documentation must cover MV3 extension build/load');
    assert.ok(/19222|bridge|\/api\/v1\/browser/i.test(combinedDocs), 'Documentation must cover Desktop/Server browser bridge');
    assert.ok(/browser_snapshot|24|browser_/i.test(combinedDocs), 'Documentation must cover 24-tool browser controller');
  },
});

defineTest({
  id: 'T1-F16-04',
  title: '.github/workflows/ci.yml defines push/pull_request triggers and builds Rust crates, wasm32-unknown-unknown, and browser-extension',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    const workflowsDir = path.join(ctx.sutRoot, '.github', 'workflows');
    const candidates = ['ci.yml', 'ci.yaml'].map((f) => path.join(workflowsDir, f));
    const ciPath = candidates.find((p) => fs.existsSync(p));
    assert.ok(ciPath, 'Expected .github/workflows/ci.yml (or ci.yaml) to exist');

    const ciText = fs.readFileSync(ciPath, 'utf-8');
    assert.ok(ciText.length > 150, 'CI workflow file must be non-trivial');
    assert.ok(!ciText.includes('\t'), 'Valid YAML workflow must use spaces rather than tab indentation');
    assert.ok(/\bon\s*:/m.test(ciText), 'CI workflow must declare "on:" triggers');
    assert.ok(/\bpush\b/.test(ciText) && /\bpull_request\b/.test(ciText), 'CI workflow must trigger on push and pull_request');
    assert.ok(/\bjobs\s*:/m.test(ciText) && /\bsteps\s*:/m.test(ciText), 'CI workflow must define jobs and steps');

    // Must cover all 3 planes: Rust workspace, WASM target, and browser-extension npm build/test
    assert.ok(/cargo\s+(check|build|test)/i.test(ciText), 'CI workflow must check/build/test Rust workspace');
    assert.ok(/wasm32-unknown-unknown|gpui_telegram_ext_wasm/i.test(ciText), 'CI workflow must verify WASM target');
    assert.ok(/browser-extension/i.test(ciText) && /\b(npm|npx)\b/i.test(ciText), 'CI workflow must build/verify browser-extension');
  },
});

defineTest({
  id: 'T1-F16-05',
  title: 'browser-extension/package.json defines reproducible build script and dist/manifest.json references zero missing bundle files',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    const pkgPath = path.join(ctx.sutRoot, 'browser-extension', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, any>;
    assert.ok(
      typeof pkg.scripts?.build === 'string' && pkg.scripts.build.trim().length > 0,
      'browser-extension/package.json must define a non-empty "build" script',
    );

    const distDir = ctx.sutPaths.extDistDir;
    const manifest = JSON.parse(fs.readFileSync(ctx.sutPaths.manifestPath, 'utf-8')) as Record<string, any>;
    assert.equal(manifest.manifest_version, 3, 'dist/manifest.json must have manifest_version === 3');

    const cspStr = JSON.stringify(manifest.content_security_policy ?? '');
    assert.ok(cspStr.includes('wasm-unsafe-eval'), 'Manifest CSP must include wasm-unsafe-eval');
    assert.ok(!cspStr.includes("'unsafe-eval'"), 'Manifest CSP must NOT include forbidden unsafe-eval');

    const referencedRelativePaths = new Set<string>([
      'workspace.html',
      'sidepanel.html',
      'popup.html',
      'options.html',
      'assets/gpui_telegram_ext_wasm.wasm',
    ]);

    if (typeof manifest.background?.service_worker === 'string') {
      referencedRelativePaths.add(manifest.background.service_worker);
    }
    if (typeof manifest.side_panel?.default_path === 'string') {
      referencedRelativePaths.add(manifest.side_panel.default_path);
    }
    if (typeof manifest.action?.default_popup === 'string') {
      referencedRelativePaths.add(manifest.action.default_popup);
    }
    if (typeof manifest.options_page === 'string') {
      referencedRelativePaths.add(manifest.options_page);
    }
    if (typeof manifest.options_ui?.page === 'string') {
      referencedRelativePaths.add(manifest.options_ui.page);
    }
    if (Array.isArray(manifest.content_scripts)) {
      for (const cs of manifest.content_scripts) {
        for (const jsRel of cs?.js ?? []) {
          if (typeof jsRel === 'string') referencedRelativePaths.add(jsRel);
        }
        for (const cssRel of cs?.css ?? []) {
          if (typeof cssRel === 'string') referencedRelativePaths.add(cssRel);
        }
      }
    }
    if (manifest.icons && typeof manifest.icons === 'object') {
      for (const iconRel of Object.values(manifest.icons)) {
        if (typeof iconRel === 'string') referencedRelativePaths.add(iconRel);
      }
    }

    for (const rel of referencedRelativePaths) {
      const cleanRel = rel.replace(/^\.?\//, '');
      const full = path.join(distDir, cleanRel);
      assert.equal(fs.existsSync(full), true, `Manifest referenced asset missing from dist/: ${cleanRel}`);
      const st = fs.statSync(full);
      assert.ok(st.isFile() && st.size > 0, `Dist asset is empty: ${cleanRel}`);
    }

    assertWasmMagic(ctx.sutPaths.wasmPath);
  },
});

defineTest({
  id: 'T1-F16-06',
  title: 'git ls-files index audit confirms zero tracked binaries in target/, node_modules/, .e2e-runs/, .local-sysroot/, or SQLite DBs',
  tier: 1,
  features: ['F16'],
  fn: (ctx: SharedTierContext) => {
    const lsRes = gitReadOnly(ctx.sutRoot, ['ls-files']);
    assert.equal(lsRes.status, 0, 'git ls-files must succeed');

    const trackedFiles = lsRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.ok(trackedFiles.length >= 20, `Expected populated git index, found ${trackedFiles.length} files`);
    assert.ok(trackedFiles.includes('Cargo.toml'), 'Cargo.toml must be tracked in git index');

    const forbiddenTracked = trackedFiles.filter(
      (f) =>
        f.startsWith('target/') ||
        /(^|\/)node_modules\//.test(f) ||
        /(^|\/)\.e2e-runs\//.test(f) ||
        /(^|\/)\.local-sysroot\//.test(f) ||
        /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(f) ||
        f === '.env',
    );

    assert.deepEqual(
      forbiddenTracked,
      [],
      `Forbidden build/runtime artifacts tracked in git index: ${JSON.stringify(forbiddenTracked.slice(0, 20))}`,
    );
  },
});
