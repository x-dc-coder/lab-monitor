import { defineConfig } from 'tsdown'

/**
 * lab-monitor V2 构建（官方 tsdown 规范，参照 dsh-better-sidebar + official repo）
 * - host 半：lib/types/index.js → lib/index.js（ESM，node）
 * - client 半：lib/types/client.js → lib/client.js（CJS browser + __ModuleLoader__ 包装）
 */
export default defineConfig([
  {
    // ── host 半 ──
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
  {
    // ── client 半（ModuleLoader bundle，参照官方 tsdown.client.ts banner/footer） ──
    entry: ['lib/types/client.js'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    external: [/^react/, /^@deepseek-ai\//, /^cordis/, /^schemastery/],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "lab-monitor", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
