import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    startup: 'src/startup.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  treeshake: {
    moduleSideEffects: id => id !== '@deepseek-ai/cordis',
  },
  deps: {
    onlyBundle: [
      '@deepseek-ai/dsh-client-schema-form',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-timeout',
    ],
    dts: { neverBundle: true },
  },
  clean: true,
  fixedExtension: false,
})
