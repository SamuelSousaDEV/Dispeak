import { defineConfig } from 'tsup';

// Everything but Electron itself is bundled, so the installer ships no node_modules.
const shared = {
  clean: false,
  sourcemap: true,
  noExternal: [/^(?!electron$)/],
  external: ['electron'],
};

export default defineConfig([
  {
    ...shared,
    entry: { main: 'src/main.ts' },
    format: ['esm'],
    // The bundled CommonJS dependencies (electron-updater and what it needs) call `require`.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    target: 'node22',
    platform: 'node',
  },
  {
    ...shared,
    // Sandboxed preload scripts are CommonJS.
    entry: {
      preload: 'src/preload.ts',
      'picker-preload': 'src/picker/preload.ts',
      'notice-preload': 'src/notice/preload.ts',
    },
    format: ['cjs'],
    target: 'node22',
    platform: 'node',
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    ...shared,
    entry: { picker: 'src/picker/renderer.ts', notice: 'src/notice/renderer.ts' },
    format: ['iife'],
    target: 'chrome140',
    platform: 'browser',
  },
]);
