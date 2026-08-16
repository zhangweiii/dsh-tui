import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundledDependencies = ['@deepseek-ai/dsh-client-schema-form']
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
  execFileSync(process.execPath, ['--input-type=module', '--eval', [
    "await import('@zhangweiii/dsh-tui')",
    "await import('@zhangweiii/dsh-tui/startup')",
    "await import('@zhangweiii/dsh-tui/invariant')",
  ].join('; ')], { cwd: sandbox, stdio: 'inherit' })
  console.log('package smoke test passed')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
