import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import { runDeploy, type DeployHost } from './deploy.ts'
import { formatDeployText, formatTerminalOutput } from './format.ts'
import { runPreflight } from './preflight.ts'
import type { DeployResult } from './types.ts'
import { resolveWorkspaceDirectory } from './workspace.ts'

function textFromContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function asMeta(value: unknown): DeployResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Partial<DeployResult>
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.warnings)) return undefined
  return record as DeployResult
}

export function createDeployTool(ctx: Context, getConfig: () => Config) {
  const host = ctx as unknown as DeployHost
  return defineTool({
    name: 'deploy',
    description:
      '把当前项目部署到 Cloudflare。默认两阶段：第一次调用只做安全预检（文件清单/秘密扫描/CF/PWA 适配/指纹），不部署；'
      + '审查报告后带 confirm=<指纹> 再调用才会真正部署。预检发现私钥、证书目录、敏感文件或目录变化会硬阻止。'
      + 'mode=auto 时：未认证走临时预览（60 分钟认领窗口）；已配置 CLOUDFLARE_API_TOKEN 或 wrangler 已登录则部署到用户账号。'
      + '显式 mode=temporary 即使本机已登录也会走隔离 HOME 的临时预览，不要为此登出 wrangler。'
      + '不要把 token 放进参数。directory 可省略（默认当前工作区）；优先显式指定构建产物 dist。',
    parameters: {
      directory: {
        type: 'string',
        description: '要部署的目录。省略则使用当前会话工作区。',
      },
      target: {
        type: 'string',
        enum: ['auto', 'cloudflare'],
        description: '部署目标。P0 只有 Cloudflare。',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'temporary', 'account'],
        description: 'auto 按认证状态选择（已认证优先账号）；temporary 为临时预览（即使本机已登录也走隔离 HOME，不要 logout）；account 为用户账号。',
      },
      preflight: {
        type: 'boolean',
        description: '只执行安全预检并返回文件清单、阻止项、适配检查和指纹，不部署。不传 confirm 时默认也会先返回预检报告。',
      },
      confirm: {
        type: 'string',
        description: '上一次预检返回的 fingerprint。必须与当前预检完全一致才会继续真正部署。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', enum: ['temporary', 'account', 'none'], required: true },
          previewUrl: { type: 'string' },
          claimUrl: { type: 'string' },
          claimWithin: { type: 'string' },
          workerName: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          error: { type: 'string' },
          hint: { type: 'string' },
          stdout: { type: 'string' },
          exitCode: { type: 'integer' },
          preflight: { type: 'boolean' },
          projectKind: { type: 'string' },
          assetsRoot: { type: 'string' },
          fileCount: { type: 'integer' },
          totalBytes: { type: 'integer' },
          fingerprint: { type: 'string' },
          blocked: { type: 'array', items: { type: 'string' } },
          review: { type: 'array', items: { type: 'string' } },
          topLevel: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                files: { type: 'integer' },
                bytes: { type: 'integer' },
              },
            },
          },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                ok: { type: 'boolean' },
                level: { type: 'string', enum: ['pass', 'warn', 'block'] },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDeployText(value as DeployResult) }],
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: 360_000,
    presentCall: (args) => ({
      card: 'terminal',
      title: 'wrangler deploy',
      description: '部署到 Cloudflare',
      ...args.directory === undefined ? {} : { cwd: args.directory },
    }),
    presentResult: (_args, result) => {
      if (result.isError) {
        return {
          card: 'terminal',
          title: '部署失败',
          output: textFromContent(result.content),
          exitCode: 1,
        }
      }
      const meta = asMeta(result.meta)
      if (meta === undefined) {
        return {
          card: 'terminal',
          title: '部署',
          output: textFromContent(result.content),
        }
      }
      return {
        card: 'terminal',
        title: meta.preflight === true
          ? '部署预检'
          : meta.mode === 'temporary' ? '临时预览' : 'Cloudflare 部署',
        output: formatTerminalOutput(meta),
        ...meta.exitCode === undefined ? {} : { exitCode: meta.exitCode },
      }
    },
    async execute(args, exec) {
      const baseDirectory = resolveWorkspaceDirectory(host, args.directory, exec.agent)
      const preview = await runPreflight(baseDirectory)

      if (!preview.ok || args.preflight === true) {
        return preview
      }

      if (args.confirm === undefined) {
        return {
          ...preview,
          warnings: [
            ...preview.warnings,
            '尚未部署：请先审查上面的预检报告，再用 confirm=<预检指纹> 调用 deploy。',
          ],
        }
      }

      if (args.confirm.trim() !== preview.fingerprint) {
        return {
          ...preview,
          ok: false,
          error: '预检指纹不匹配：目录内容在预检后发生了变化，或 confirm 不是本次预检的指纹。',
          hint: '重新调用 deploy（不带 confirm）获取最新预检报告和指纹，然后再确认。',
        }
      }

      return runDeploy(host, args, {
        signal: exec.signal,
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        ...exec.callId === undefined ? {} : { callId: String(exec.callId) },
      }, getConfig())
    },
  })
}

export function createDeployCommand(ctx: Context, getConfig: () => Config) {
  const host = ctx as unknown as DeployHost
  return {
    name: 'deploy',
    description: '对当前项目做 Cloudflare 部署预检（不会直接部署）',
    input: { hint: '可选：要预检的目录' },
    async handler(invocation: {
      agent: unknown
      rawInput: string
      signal: AbortSignal
    }): Promise<CommandResult> {
      const directory = invocation.rawInput.trim()
      const baseDirectory = resolveWorkspaceDirectory(host, directory.length === 0 ? undefined : directory, invocation.agent)
      const value = await runPreflight(baseDirectory)
      const text = formatDeployText(value)
      return value.ok ? { kind: 'success', text } : { kind: 'error', text }
    },
  }
}
