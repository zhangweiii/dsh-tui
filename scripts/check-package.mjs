import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// Deps inlined into the published bundle (tsdown deps.onlyBundle) must never
// be published as runtime dependencies of the manifest.
const bundledDependencies = []
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tarball = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`

for (const name of bundledDependencies) {
  if (manifest.dependencies?.[name] !== undefined) {
    throw new Error(`${name} must be bundled, not published as a runtime dependency`)
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-package-'))

try {
  execFileSync(npm, [
    'pack', '--ignore-scripts', '--pack-destination', sandbox,
  ], { cwd: root, stdio: 'inherit' })
  const packed = join(sandbox, tarball)
  if (!existsSync(packed)) throw new Error(`npm pack did not create ${tarball}`)

  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({
    name: 'dsh-tui-package-smoke',
    private: true,
    type: 'module',
  }))
  execFileSync(npm, [
    'install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
    packed,
  ], { cwd: sandbox, stdio: 'inherit' })
  // The bundle mounts into a DSH host, so the smoke test links this checkout's
  // host tree in for the declared peers instead of shipping a second copy: a
  // real profile resolves them from the tree the launcher composed.
  const linked = join(sandbox, 'node_modules/@deepseek-ai')
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const source = join(root, 'node_modules', name)
    if (!existsSync(source)) throw new Error(`${name} is not installed in the checkout`)
    mkdirSync(linked, { recursive: true })
    symlinkSync(source, join(linked, name.replace('@deepseek-ai/', '')), 'dir')
  }
  execFileSync(process.execPath, ['--input-type=module', '--eval', [
    "await import('@zhangweiii/dsh-tui')",
    "await import('@zhangweiii/dsh-tui/startup')",
    "await import('@zhangweiii/dsh-tui/invariant')",
  ].join('; ')], { cwd: sandbox, stdio: 'inherit' })
  console.log('package smoke test passed')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
