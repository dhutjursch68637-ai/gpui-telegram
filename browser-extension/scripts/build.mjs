import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { build as viteBuild } from 'vite';
import * as esbuild from 'esbuild';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(extRoot, '..');
const distDir = path.join(extRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');
const iconsDir = path.join(distDir, 'icons');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function createIconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.44;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        // Telegram-style azure gradient with crisp white center glyph
        const nx = (x / size) * 2 - 1;
        const ny = (y / size) * 2 - 1;
        const inPaperPlane =
          Math.abs(ny + nx * 0.35) < 0.16 && nx > -0.45 && nx < 0.48 && ny > -0.45 && ny < 0.45;
        if (inPaperPlane) {
          raw[px] = 255;
          raw[px + 1] = 255;
          raw[px + 2] = 255;
          raw[px + 3] = 255;
        } else {
          raw[px] = 36;
          raw[px + 1] = 161;
          raw[px + 2] = 222;
          raw[px + 3] = 255;
        }
      } else {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function resolveWasmArtifact() {
  const candidates = [
    path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'gpui_telegram_ext_wasm.wasm'),
    path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'debug', 'gpui_telegram_ext_wasm.wasm'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 8) {
      return candidate;
    }
  }

  // Fallback only if prebuilt WASM does not exist yet
  console.log('[build] Prebuilt WASM not found; invoking cargo build fallback for gpui_telegram_ext_wasm...');
  execFileSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      path.join(repoRoot, 'crates', 'gpui_telegram_ext_wasm', 'Cargo.toml'),
      '--target',
      'wasm32-unknown-unknown',
      '--release',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  const built = candidates[0];
  if (!fs.existsSync(built)) {
    throw new Error(`Expected compiled WASM artifact at ${built}`);
  }
  return built;
}

async function main() {
  console.log('[build] Building UI entrypoints with Vite...');
  await viteBuild({
    configFile: path.join(extRoot, 'vite.config.ts'),
    logLevel: 'info',
  });

  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });

  console.log('[build] Bundling MV3 Service Worker (background.js)...');
  await esbuild.build({
    entryPoints: [path.join(extRoot, 'src', 'background', 'index.ts')],
    outfile: path.join(distDir, 'background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    legalComments: 'none',
  });

  console.log('[build] Bundling MV3 Content Script IIFE (content.js)...');
  await esbuild.build({
    entryPoints: [path.join(extRoot, 'src', 'content', 'dom_agent.ts')],
    outfile: path.join(distDir, 'content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    legalComments: 'none',
  });

  console.log('[build] Generating deterministic extension icons...');
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), createIconPng(size));
  }

  const wasmSrc = resolveWasmArtifact();
  const wasmDst = path.join(assetsDir, 'gpui_telegram_ext_wasm.wasm');
  fs.copyFileSync(wasmSrc, wasmDst);

  // Verify WASM header & required files
  const wasmHead = fs.readFileSync(wasmDst).subarray(0, 8);
  const expectedMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  if (!wasmHead.equals(expectedMagic)) {
    throw new Error(`Invalid WASM header in ${wasmDst}`);
  }

  const requiredFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'workspace.html',
    'sidepanel.html',
    'popup.html',
    'options.html',
    'assets/gpui_telegram_ext_wasm.wasm',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ];
  for (const rel of requiredFiles) {
    const p = path.join(distDir, rel);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
      throw new Error(`Missing or empty build artifact: ${rel}`);
    }
  }

  console.log(`[build] Complete -> ${distDir}`);
}

main().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
