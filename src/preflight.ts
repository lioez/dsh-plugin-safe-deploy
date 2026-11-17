import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { detectProject } from './detect.ts'
import type { PreflightCheck, PreflightResult, PreflightSummaryItem } from './types.ts'
import { deriveWorkerName } from './worker-name.ts'
import { readWranglerWorkerName, resolveWranglerAssetsRoot } from './wrangler-config.ts'

/**
 * Generic, read-only deployment preflight.
 *
 * It answers four questions before anything is uploaded:
 *   1. what exactly would be published (file inventory, top-level layout);
 *   2. which files are hard blockers (secrets, keys, certs, symlinks, limits);
 *   3. which files deserve a human/model review (server code, scripts, source);
 *   4. does the project look compatible with a static Cloudflare Workers target
 *      (index/PWA/service worker/local API calls/headers/wrangler config)?
 *
 * It never calls wrangler and never mutates the project. The tool layer requires
 * the returned fingerprint before it will invoke a real deploy.
 */

const MAX_SCAN_FILES = 20_000
const ACCOUNT_MAX_FILES = 20_000
const ACCOUNT_MAX_FILE_BYTES = 25 * 1024 * 1024
const TEMP_MAX_FILES = 1_000
const TEMP_MAX_FILE_BYTES = 5 * 1024 * 1024
const TEXT_MAX_BYTES = 512 * 1024

const BLOCKED_DIRS = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  'cert',
  'certs',
  '.wrangler',
  'node_modules',
])

const REVIEW_DIRS = new Set([
  'server',
  'scripts',
  'src',
  'tests',
  'test',
  '.github',
  '.vscode',
  'release',
])

const REVIEW_FILES = [
  /^README(?:\..*)?$/i,
  /^使用说明.*$/i,
  /^启动.*\.command$/i,
  /^package(?:-lock)?\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^Dockerfile$/i,
  /^\.gitignore$/i,
  /\.map$/i,
]

const SECRET_NAME =
  /^\.env(?:\..*)?$|^\.npmrc$|^\.netrc$|^\.credentials.*$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:key|pem|p12|pfx|jks|keystore|secret)$/i

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.webmanifest',
  '.txt',
  '.xml',
  '.svg',
  '.yml',
  '.yaml',
  '.toml',
  '.md',
])

const LOCAL_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: '/api/', pattern: /\/api\// },
  { id: 'localhost', pattern: /\blocalhost\b/i },
  { id: '127.0.0.1', pattern: /\b127\.0\.0\.1\b/ },
  { id: 'private-10.x', pattern: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'private-192.168.x', pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'private-172.16-31.x', pattern: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'plain-http', pattern: /http:\/\/(?!www\.w3\.org)[^\s"'<>]+/i },
]

interface FileInfo {
  rel: string
  bytes: number
  mtimeMs: number
}

interface WalkResult {
  files: FileInfo[]
  blocked: string[]
  review: string[]
  overflow: boolean
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value))
}

function walkAssets(root: string): WalkResult {
  const files: FileInfo[] = []
  const blocked: string[] = []
  const review: string[] = []
  let overflow = false
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries
    try {
      entries = readdirSync(current.abs, { withFileTypes: true })
    } catch {
      blocked.push(`${current.rel || '.'} (无法读取)`)
      continue
    }

    for (const entry of entries) {
      const abs = join(current.abs, entry.name)
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`
      let stat
      try {
        stat = lstatSync(abs)
      } catch {
        blocked.push(`${rel} (无法读取元数据)`)
        continue
      }

      if (stat.isSymbolicLink()) {
        blocked.push(`${rel} (符号链接，未跟随)`)
        continue
      }

      if (stat.isDirectory()) {
        if (BLOCKED_DIRS.has(entry.name)) {
          blocked.push(`${rel}/ (敏感目录)`)
          continue
        }
        if (REVIEW_DIRS.has(entry.name)) {
          review.push(`${rel}/`)
        }
        stack.push({ abs, rel })
        continue
      }

      if (!stat.isFile()) {
        blocked.push(`${rel} (特殊文件)`)
        continue
      }

      if (SECRET_NAME.test(entry.name)) {
        blocked.push(`${rel} (疑似凭据/私钥)`)
        continue
      }

      if (matchesAny(entry.name, REVIEW_FILES)) {
        review.push(rel)
      }

      files.push({ rel, bytes: stat.size, mtimeMs: stat.mtimeMs })
      if (files.length > MAX_SCAN_FILES) {
        overflow = true
        break
      }
    }

    if (overflow) break
  }

  return { files, blocked: [...new Set(blocked)].sort(), review: [...new Set(review)].sort(), overflow }
}

function fingerprintFiles(files: FileInfo[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(`${file.rel}\0${file.bytes}\0${Math.trunc(file.mtimeMs)}\n`)
  }
  return hash.digest('hex').slice(0, 16)
}

function summarizeTopLevel(files: FileInfo[]): PreflightSummaryItem[] {
  const map = new Map<string, { files: number; bytes: number }>()
  for (const file of files) {
    const top = file.rel.includes('/') ? file.rel.slice(0, file.rel.indexOf('/')) : file.rel
    const item = map.get(top) ?? { files: 0, bytes: 0 }
    item.files += 1
    item.bytes += file.bytes
    map.set(top, item)
  }
  return [...map.entries()]
    .map(([path, stats]) => ({ path, ...stats }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, 20)
}

function scanLocalReferences(files: FileInfo[], root: string): string[] {
  const hits: string[] = []
  for (const file of files) {
    if (file.bytes > TEXT_MAX_BYTES) continue
    if (!TEXT_EXTENSIONS.has(extname(file.rel).toLowerCase())) continue
    let text: string
    try {
      text = readFileSync(join(root, file.rel), 'utf8')
    } catch {
      continue
    }
    for (const item of LOCAL_PATTERNS) {
      if (item.pattern.test(text)) {
        hits.push(`${file.rel} (${item.id})`)
        if (hits.length >= 20) return hits
      }
    }
  }
  return [...new Set(hits)]
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function findManifest(root: string): { file: string; json: Record<string, unknown> } | undefined {
  for (const name of ['manifest.webmanifest', 'manifest.json', 'site.webmanifest']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const json = readJson(path)
    return json === undefined ? { file: name, json: {} } : { file: name, json }
  }
  return undefined
}

function iconProblems(root: string, manifest: Record<string, unknown>): string[] {
  const icons = manifest.icons
  if (!Array.isArray(icons) || icons.length === 0) return ['manifest 没有 icons']
  const problems: string[] = []
  for (const item of icons.slice(0, 20)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push('icons 里有无效条目')
      continue
    }
    const src = (item as { src?: unknown }).src
    if (typeof src !== 'string' || src.length === 0) {
      problems.push('icon 缺少 src')
      continue
    }
    if (/^https?:\/\//i.test(src)) continue
    const rel = src.replace(/^\//, '').replace(/^\.\//, '')
    if (!existsSync(join(root, rel))) problems.push(`icon 文件不存在: ${src}`)
  }
  return problems.slice(0, 8)
}

function staticEntryCheck(root: string, isStaticSite: boolean): PreflightCheck {
  const indexExists = existsSync(join(root, 'index.html'))
  if (!isStaticSite) {
    return { id: 'static-entry', ok: true, level: 'pass', detail: 'Worker 项目，不要求 index.html' }
  }
  return indexExists
    ? { id: 'static-entry', ok: true, level: 'pass', detail: '存在 index.html' }
    : { id: 'static-entry', ok: false, level: 'block', detail: '静态站点缺少 index.html' }
}

function pwaChecks(root: string, files: FileInfo[]): { checks: PreflightCheck[]; warnings: string[] } {
  const checks: PreflightCheck[] = []
  const warnings: string[] = []
  const manifest = findManifest(root)
  const swExists = existsSync(join(root, 'sw.js'))
  const textMentionsSw = files.some((file) => {
    if (file.bytes > TEXT_MAX_BYTES) return false
    if (!['.html', '.js', '.mjs'].includes(extname(file.rel).toLowerCase())) return false
    try {
      return /serviceWorker\.register|navigator\.serviceWorker/i.test(readFileSync(join(root, file.rel), 'utf8'))
    } catch {
      return false
    }
  })

  if (manifest === undefined) {
    checks.push({ id: 'pwa-manifest', ok: false, level: 'warn', detail: '未找到 manifest.webmanifest / manifest.json；不是 PWA 或清单未构建' })
    warnings.push('未发现 PWA manifest；如果项目是 PWA，先检查构建产物。')
  } else {
    const startUrl = typeof manifest.json.start_url === 'string' ? manifest.json.start_url : undefined
    const scope = typeof manifest.json.scope === 'string' ? manifest.json.scope : undefined
    const problems = iconProblems(root, manifest.json)
    const hashStart = startUrl?.includes('#') === true
    const relativeStart = startUrl === undefined || startUrl.startsWith('./') || startUrl.startsWith('/') || hashStart
    checks.push({
      id: 'pwa-manifest',
      ok: problems.length === 0,
      level: problems.length === 0 ? 'pass' : 'warn',
      detail: problems.length === 0 ? `${manifest.file} 可解析，icons 完整` : `${manifest.file}: ${problems.join('；')}`,
    })
    checks.push({
      id: 'pwa-start-url',
      ok: relativeStart,
      level: relativeStart ? 'pass' : 'warn',
      detail: `start_url=${startUrl ?? '(未设置)'}, scope=${scope ?? '(未设置)'}${hashStart ? '（hash 路由）' : ''}`,
    })
    if (problems.length > 0) warnings.push('PWA manifest 存在问题，安装前需要修。')
  }

  if (swExists) {
    checks.push({ id: 'pwa-service-worker', ok: true, level: 'pass', detail: '根目录存在 sw.js' })
  } else if (textMentionsSw) {
    checks.push({ id: 'pwa-service-worker', ok: false, level: 'warn', detail: '代码里注册了 Service Worker，但根目录没有 sw.js' })
  } else {
    checks.push({ id: 'pwa-service-worker', ok: false, level: 'warn', detail: '未发现 sw.js；离线能力不会生效' })
  }

  return { checks, warnings }
}

function staticHostCheck(review: string[], isStaticSite: boolean): PreflightCheck {
  const hasServerLike = review.some(item => item.startsWith('server/') || item.startsWith('scripts/'))
  if (!isStaticSite) {
    return { id: 'static-host', ok: true, level: 'pass', detail: 'Worker 项目，允许有代码' }
  }
  if (hasServerLike) {
    return {
      id: 'static-host',
      ok: false,
      level: 'warn',
      detail: '静态资源目录里发现 server/ 或 scripts/；Cloudflare 静态托管不会执行它们，通常应排除',
    }
  }
  return { id: 'static-host', ok: true, level: 'pass', detail: '未发现服务端目录，适合静态托管' }
}

export async function runPreflight(directory: string): Promise<PreflightResult> {
  const root = directory
  const project = detectProject(root)
  if (project === undefined) {
    return {
      ok: false,
      mode: 'none',
      preflight: true,
      projectKind: 'unknown',
      assetsRoot: root,
      fileCount: 0,
      totalBytes: 0,
      fingerprint: '',
      blocked: [],
      review: [],
      checks: [{ id: 'project-detect', ok: false, level: 'block', detail: '无法识别项目形态' }],
      topLevel: [],
      warnings: [],
      error: '无法从目录识别静态站点或 Worker 项目。',
      hint: '请指定包含 index.html、dist/index.html 或 wrangler.jsonc/toml 的项目目录；优先只发布构建产物 dist。',
    }
  }

  const wranglerConfigName = project.wranglerConfigName
  const hasConfig = project.hasWranglerConfig && wranglerConfigName !== undefined
  const assetsRoot = hasConfig
    ? resolveWranglerAssetsRoot(project.directory, wranglerConfigName) ?? project.directory
    : project.assetsDir ?? project.directory
  const workerName = hasConfig
    ? readWranglerWorkerName(project.directory, wranglerConfigName) ?? deriveWorkerName(project.directory)
    : deriveWorkerName(project.directory)

  const walk = walkAssets(assetsRoot)
  const files = walk.files
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const largest = files.reduce((max, file) => Math.max(max, file.bytes), 0)
  const topLevel = summarizeTopLevel(files)
  const fingerprint = fingerprintFiles(files)
  const isStaticSite = project.kind === 'static-dist' || project.kind === 'static-root'
  const checks: PreflightCheck[] = []
  const warnings: string[] = []
  const blocked = [...walk.blocked]

  if (walk.overflow) {
    blocked.push(`文件数超过扫描上限 ${MAX_SCAN_FILES}`)
  }
  if (files.length > ACCOUNT_MAX_FILES) {
    blocked.push(`文件数 ${files.length} 超过 Workers 静态资源上限 ${ACCOUNT_MAX_FILES}`)
  }
  if (largest > ACCOUNT_MAX_FILE_BYTES) {
    blocked.push(`存在超过 ${ACCOUNT_MAX_FILE_BYTES / 1024 / 1024} MiB 的单文件`)
  }

  checks.push({
    id: 'project-detect',
    ok: true,
    level: 'pass',
    detail: `${project.kind} → assetsRoot=${assetsRoot}`,
  })
  checks.push({
    id: 'secret-scan',
    ok: blocked.length === 0,
    level: blocked.length === 0 ? 'pass' : 'block',
    detail: blocked.length === 0 ? '未发现凭据/私钥/敏感目录' : `发现 ${blocked.length} 个阻止项`,
  })
  checks.push({
    id: 'file-limits',
    ok: files.length <= ACCOUNT_MAX_FILES && largest <= ACCOUNT_MAX_FILE_BYTES,
    level: files.length <= ACCOUNT_MAX_FILES && largest <= ACCOUNT_MAX_FILE_BYTES ? 'pass' : 'block',
    detail: `${files.length} 个文件，最大 ${(largest / 1024 / 1024).toFixed(2)} MiB；临时预览限制 ${TEMP_MAX_FILES} 文件 / ${TEMP_MAX_FILE_BYTES / 1024 / 1024} MiB`,
  })
  if (files.length > TEMP_MAX_FILES || largest > TEMP_MAX_FILE_BYTES) {
    warnings.push('超过临时预览限制；如走 temporary 会失败，需要 account 模式或缩小产物。')
  }

  checks.push(staticEntryCheck(assetsRoot, isStaticSite))
  const pwa = pwaChecks(assetsRoot, files)
  checks.push(...pwa.checks)
  warnings.push(...pwa.warnings)

  const localRefs = scanLocalReferences(files, assetsRoot)
  if (localRefs.length > 0) {
    checks.push({
      id: 'local-endpoints',
      ok: false,
      level: 'warn',
      detail: `发现 ${localRefs.length} 处本机/内网/api 引用；静态托管后这些端点不存在`,
    })
    warnings.push('构建产物引用了本机 API 或内网地址；上云后需要改成公网接口或手填配置。')
  } else {
    checks.push({ id: 'local-endpoints', ok: true, level: 'pass', detail: '未发现本机/内网 API 引用' })
  }

  checks.push(staticHostCheck(walk.review, isStaticSite))
  checks.push({
    id: 'pwa-headers',
    ok: true,
    level: 'pass',
    detail: existsSync(join(assetsRoot, '_headers'))
      ? '存在 _headers；Workers 静态资源会应用'
      : '未提供 _headers；Workers 默认 no-cache，PWA 更新通常可用',
  })
  checks.push({
    id: 'wrangler-config',
    ok: true,
    level: hasConfig ? 'pass' : 'warn',
    detail: hasConfig
      ? `使用 ${project.wranglerConfigName}，Worker=${workerName}`
      : `未发现 wrangler 配置；将生成临时配置，Worker=${workerName}`,
  })
  if (!hasConfig) warnings.push('没有项目内 wrangler 配置；Worker 名由目录名推导，正式项目建议加稳定配置。')

  const hasBlock = blocked.length > 0 || checks.some(check => check.level === 'block')
  const ok = !hasBlock
  const error = ok
    ? undefined
    : blocked.length > 0
      ? '预检发现不能上传的文件或目录，已阻止部署。'
      : checks.find(check => check.level === 'block')?.detail

  return {
    ok,
    mode: 'none',
    preflight: true,
    projectKind: project.kind,
    assetsRoot,
    workerName,
    fileCount: files.length,
    totalBytes,
    fingerprint,
    blocked,
    review: walk.review.slice(0, 80),
    checks,
    topLevel,
    warnings: [...new Set(warnings)],
    ...error === undefined ? {} : { error },
    ...ok ? {} : { hint: '只发布构建产物（通常是 dist），不要把 cert/、server/、scripts/、node_modules 或密钥文件放进静态目录。' },
  }
}
