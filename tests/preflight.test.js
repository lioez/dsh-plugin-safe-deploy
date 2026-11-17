import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPreflight } from '../lib/index.js'

async function makeSite(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'safe-deploy-preflight-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><link rel="manifest" href="manifest.webmanifest"><title>site</title>\n')
  await writeFile(join(dir, 'app.js'), options.api ? "fetch('/api/key')\n" : "console.log('ok')\n")
  if (options.manifest !== false) {
    await writeFile(join(dir, 'manifest.webmanifest'), JSON.stringify({
      name: 'site',
      start_url: './#home',
      scope: './',
      display: 'standalone',
      icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    }))
    await mkdir(join(dir, 'icons'), { recursive: true })
    await writeFile(join(dir, 'icons/icon-192.png'), 'png')
  }
  if (options.sw !== false) await writeFile(join(dir, 'sw.js'), 'self.addEventListener("install", () => {})\n')
  if (options.server) {
    await mkdir(join(dir, 'server'), { recursive: true })
    await writeFile(join(dir, 'server/index.js'), 'console.log("server")\n')
  }
  if (options.secret) {
    await mkdir(join(dir, 'cert'), { recursive: true })
    await writeFile(join(dir, 'cert/server.key'), '-----BEGIN PRIVATE KEY-----\n')
  }
  return dir
}

test('clean static site passes preflight and returns a stable fingerprint', async () => {
  const dir = await makeSite()
  const first = await runPreflight(dir)
  assert.equal(first.ok, true)
  assert.equal(first.preflight, true)
  assert.equal(first.projectKind, 'static-root')
  assert.equal(first.assetsRoot, dir)
  assert.ok(first.fileCount >= 4)
  assert.equal(first.blocked.length, 0)
  assert.equal(first.fingerprint.length, 16)
  assert.ok(first.checks.some(check => check.id === 'pwa-manifest' && check.level === 'pass'))
  assert.ok(first.checks.some(check => check.id === 'pwa-service-worker' && check.level === 'pass'))
  const second = await runPreflight(dir)
  assert.equal(second.fingerprint, first.fingerprint)
})

test('private keys or cert directories are hard blockers', async () => {
  const dir = await makeSite({ secret: true })
  const result = await runPreflight(dir)
  assert.equal(result.ok, false)
  assert.equal(result.preflight, true)
  assert.ok(result.blocked.some(item => item.includes('cert')))
  assert.ok(result.checks.some(check => check.id === 'secret-scan' && check.level === 'block'))
  assert.match(result.error ?? '', /阻止/)
})

test('server directories are surfaced for review but do not become secrets', async () => {
  const dir = await makeSite({ server: true })
  const result = await runPreflight(dir)
  assert.equal(result.ok, true)
  assert.ok(result.review.some(item => item.startsWith('server/')))
  assert.ok(result.checks.some(check => check.id === 'static-host' && check.level === 'warn'))
})

test('local API references are reported as a warning, not silently ignored', async () => {
  const dir = await makeSite({ api: true })
  const result = await runPreflight(dir)
  assert.equal(result.ok, true)
  assert.ok(result.checks.some(check => check.id === 'local-endpoints' && check.level === 'warn'))
  assert.ok(result.warnings.some(item => item.includes('本机 API')))
})

test('adding a file changes the fingerprint', async () => {
  const dir = await makeSite()
  const first = await runPreflight(dir)
  await writeFile(join(dir, 'extra.txt'), 'changed')
  const second = await runPreflight(dir)
  assert.notEqual(second.fingerprint, first.fingerprint)
})

test('a dist-only directory is detected as static-dist and only dist is scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-deploy-dist-'))
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist/index.html'), '<html></html>\n')
  await writeFile(join(root, 'README.md'), 'do not publish\n')
  const result = await runPreflight(root)
  assert.equal(result.ok, true)
  assert.equal(result.projectKind, 'static-dist')
  assert.equal(result.assetsRoot, join(root, 'dist'))
  assert.equal(result.fileCount, 1)
  assert.equal(result.topLevel[0].path, 'index.html')
})
