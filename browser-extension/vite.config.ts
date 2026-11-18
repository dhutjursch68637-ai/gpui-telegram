import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: rootDir,
  base: './',
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome120',
    rollupOptions: {
      input: {
        workspace: resolve(rootDir, 'workspace.html'),
        sidepanel: resolve(rootDir, 'sidepanel.html'),
        popup: resolve(rootDir, 'popup.html'),
        options: resolve(rootDir, 'options.html'),
      },
    },
  },
});
