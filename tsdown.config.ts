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
    // The bundle inlines the one leaf path helper it needs at runtime and keeps
    // every service-owning DSH module external: the profile tree this bundle
    // mounts into already carries exactly one copy of each, and a second copy
    // would give the Host two identities for the same service class.
    onlyBundle: ['@deepseek-ai/dsh-home-paths'],
    dts: { neverBundle: true },
  },
  clean: true,
  fixedExtension: false,
})
