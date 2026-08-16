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
  deps: {
    onlyBundle: ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout'],
    dts: { neverBundle: true },
  },
  clean: true,
  fixedExtension: false,
})
