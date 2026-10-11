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
    // Every DeepSeek Harness module stays external: the profile tree this bundle
    // mounts into already carries exactly one copy of each, and a second copy
    // would give the Host two identities for the same service class.
    dts: { neverBundle: true },
  },
  clean: true,
  fixedExtension: false,
})
