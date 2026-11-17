import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SUT_ROOT } from './env.ts';

export class SutMissingError extends Error {
  readonly exitCode = 2 as const;
  readonly artifactPath: string;
  readonly reason: string;

  constructor(artifactPath: string, reason: string) {
    super(`[SUT_ARTIFACT_MISSING] ${artifactPath}: ${reason}`);
    this.name = 'SutMissingError';
    this.artifactPath = artifactPath;
    this.reason = reason;
  }
}

export interface SutArtifactPaths {
  readonly sutRoot: string;
  readonly serverBin: string;
  readonly desktopBin: string;
  readonly extDistDir: string;
  readonly manifestPath: string;
  readonly backgroundJsPath: string;
  readonly contentJsPath: string;
  readonly workspaceHtmlPath: string;
  readonly sidepanelHtmlPath: string;
  readonly popupHtmlPath: string;
  readonly optionsHtmlPath: string;
  readonly wasmPath: string;
}

export interface SutVerificationResult {
  readonly paths: SutArtifactPaths;
  readonly manifest: Record<string, any>;
  readonly resolvedBackgroundEntry: string;
  readonly resolvedContentEntry: string;
}

export function resolveSutPaths(sutRoot = DEFAULT_SUT_ROOT): SutArtifactPaths {
  const root = path.resolve(sutRoot);
  const extDistDir = path.join(root, 'browser-extension', 'dist');
  return {
    sutRoot: root,
    serverBin: path.join(root, 'target', 'debug', 'gpui_telegram_server'),
    desktopBin: path.join(root, 'target', 'debug', 'gpui_telegram_desktop'),
    extDistDir,
    manifestPath: path.join(extDistDir, 'manifest.json'),
    backgroundJsPath: path.join(extDistDir, 'background.js'),
    contentJsPath: path.join(extDistDir, 'content.js'),
    workspaceHtmlPath: path.join(extDistDir, 'workspace.html'),
    sidepanelHtmlPath: path.join(extDistDir, 'sidepanel.html'),
    popupHtmlPath: path.join(extDistDir, 'popup.html'),
    optionsHtmlPath: path.join(extDistDir, 'options.html'),
    wasmPath: path.join(extDistDir, 'assets', 'gpui_telegram_ext_wasm.wasm'),
  };
}

function verifyNonEmptyRegularFile(filePath: string, requireExecutable = false): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw new SutMissingError(filePath, 'file does not exist');
  }
  if (!st.isFile()) {
    throw new SutMissingError(filePath, 'path is not a regular file');
  }
  if (st.size <= 0) {
    throw new SutMissingError(filePath, 'file is empty (0 bytes)');
  }
  if (requireExecutable) {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
    } catch {
      throw new SutMissingError(filePath, 'binary is not executable (missing X_OK permission)');
    }
  }
  return st;
}

export function verifySutArtifactsOrFail(sutRoot = DEFAULT_SUT_ROOT): SutVerificationResult {
  const paths = resolveSutPaths(sutRoot);

  let rootStats: fs.Stats;
  try {
    rootStats = fs.statSync(paths.sutRoot);
  } catch {
    throw new SutMissingError(paths.sutRoot, 'SUT repository root directory does not exist');
  }
  if (!rootStats.isDirectory()) {
    throw new SutMissingError(paths.sutRoot, 'SUT repository root is not a directory');
  }

  // 1 & 2: Built Rust binaries
  verifyNonEmptyRegularFile(paths.serverBin, true);
  verifyNonEmptyRegularFile(paths.desktopBin, true);

  // 3: Unpacked MV3 manifest.json
  verifyNonEmptyRegularFile(paths.manifestPath, false);
  let manifest: Record<string, any>;
  try {
    const raw = fs.readFileSync(paths.manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as Record<string, any>;
  } catch (err) {
    throw new SutMissingError(
      paths.manifestPath,
      `invalid JSON in manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (manifest.manifest_version !== 3) {
    throw new SutMissingError(
      paths.manifestPath,
      `expected manifest_version === 3, got ${JSON.stringify(manifest.manifest_version)}`,
    );
  }

  // 4: Background service worker bundle
  const declaredSwRel =
    typeof manifest.background?.service_worker === 'string'
      ? manifest.background.service_worker.replace(/^\.?\//, '')
      : null;
  const resolvedBackgroundEntry = fs.existsSync(paths.backgroundJsPath)
    ? paths.backgroundJsPath
    : declaredSwRel
      ? path.join(paths.extDistDir, declaredSwRel)
      : paths.backgroundJsPath;
  verifyNonEmptyRegularFile(resolvedBackgroundEntry, false);

  // 5: Content script bundle (prefer canonical dist/content.js, fallback to manifest content_scripts[0].js[0])
  const declaredContentRel =
    Array.isArray(manifest.content_scripts) &&
    Array.isArray(manifest.content_scripts[0]?.js) &&
    typeof manifest.content_scripts[0].js[0] === 'string'
      ? manifest.content_scripts[0].js[0].replace(/^\.?\//, '')
      : null;
  const resolvedContentEntry = fs.existsSync(paths.contentJsPath)
    ? paths.contentJsPath
    : declaredContentRel
      ? path.join(paths.extDistDir, declaredContentRel)
      : paths.contentJsPath;
  verifyNonEmptyRegularFile(resolvedContentEntry, false);

  // 6..9: Extension HTML UI surfaces
  verifyNonEmptyRegularFile(paths.workspaceHtmlPath, false);
  verifyNonEmptyRegularFile(paths.sidepanelHtmlPath, false);
  verifyNonEmptyRegularFile(paths.popupHtmlPath, false);
  verifyNonEmptyRegularFile(paths.optionsHtmlPath, false);

  // 10: Compiled Rust->WASM binary with valid \0asm magic header
  const wasmStats = verifyNonEmptyRegularFile(paths.wasmPath, false);
  if (wasmStats.size < 8) {
    throw new SutMissingError(paths.wasmPath, `WASM binary truncated (${wasmStats.size} bytes < 8)`);
  }
  const fd = fs.openSync(paths.wasmPath, 'r');
  const magicBuf = Buffer.alloc(8);
  try {
    fs.readSync(fd, magicBuf, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (
    magicBuf[0] !== 0x00 ||
    magicBuf[1] !== 0x61 ||
    magicBuf[2] !== 0x73 ||
    magicBuf[3] !== 0x6d
  ) {
    throw new SutMissingError(
      paths.wasmPath,
      `invalid WASM magic bytes: expected 00 61 73 6d (\\0asm), got ${magicBuf.subarray(0, 4).toString('hex')}`,
    );
  }

  return {
    paths,
    manifest,
    resolvedBackgroundEntry,
    resolvedContentEntry,
  };
}
