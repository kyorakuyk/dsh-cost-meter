/**
 * Standalone tsdown build for dsh-cost-meter.
 *
 * Three artifacts:
 * - lib/index.js + lib/invariant.js — the Node host half (Loader entry).
 * - lib/client.js — the browser half (settings section panel), built as the
 *   module-loader closure exactly like in-repo ui-* bundles. Platform seed
 *   entries stay external (the loader's frozen module table answers them);
 *   everything else is inlined, including cross-plugin value imports of
 *   @deepseek-ai/dsh-* packages that are NOT platform modules.
 */

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

export default [
  // Node half (Loader entry). fixedExtension: false keeps plain .js names so
  // package.json main/exports resolve.
  {
    name: 'dsh-cost-meter',
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: true,
  },
  // Browser half (module-loader closure).
  {
    name: 'dsh-cost-meter/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...PLATFORM_MODULES],
      alwaysBundle: (id: string) => !(PLATFORM_MODULES as readonly string[]).includes(id),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-cost-meter", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
