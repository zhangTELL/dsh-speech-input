/**
 * dsh-speech-input 构建配置（自包含版，参照 dsh-web-ui 的
 * shared/tsdown.client.ts 预设与 dsh-language-input 同款布局）。
 *
 * 产物两部分：
 *  - lib/index.js  —— 宿主侧（node）：由 dsh profile 的 loader 从 profile
 *                     node_modules 解析依赖（@deepseek-ai/* 保持 external）。
 *  - lib/client.js —— 浏览器侧：closure-factory 产物，交给 GUI 的
 *                     window.__ModuleLoader__ 加载；平台模块表内的依赖
 *                     （react、primitives 等）保持 external，由加载器注入
 *                     require 解析，其余依赖全部内联。
 */
import type { UserConfig } from 'tsdown'

/** dsh 浏览器平台共享的模块表（0.1.2-rc.1 真实模块表；client-runtime 的
 *  `stripClientSuffix` 会把 `…/client` 子路径归一到包名，故一并列出）。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime',
] as const

/** 浏览器 bundle 的 external：平台模块 + 文档化的 runtime store 豁免。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

const PLUGIN_ID = '@dsh-local/dsh-speech-input'

/** 宿主侧（node）配置。 */
const nodeConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  // 宿主侧的依赖全部从 dsh profile 树解析，绝不从此仓库的安装解析。
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    'schemastery',
  ],
}

/** 浏览器侧（client）配置。 */
const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeConfig, clientConfig]
