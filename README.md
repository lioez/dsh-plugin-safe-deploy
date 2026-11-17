# dsh-plugin-safe-deploy

面向 DeepSeek Harness（dsh）的通用 Cloudflare 部署插件。
它把「部署」拆成 **先预检、后确认、再发布** 两阶段，避免把私钥、证书、服务端代码或不该公开的构建文件上传到公网。

> 本项目派生自 [Octo-o-o-o/dsh-plugin-deploy](https://github.com/Octo-o-o-o/dsh-plugin-deploy)（MIT），保留其 Cloudflare Workers 部署、临时预览、凭据隔离与审批设计，并在部署前加入通用安全预检。
> 仓库：[lioez/dsh-plugin-safe-deploy](https://github.com/lioez/dsh-plugin-safe-deploy)

---

## 为什么需要它

传统「一句话部署」很容易漏掉：

- `npm run build` 之后把整个项目根目录发上去，连同 `.env`、`cert/`、`server/`、`scripts/`；
- 把只有本机才能用的 `/api/key`、`localhost`、内网地址原样带上云；
- PWA 的 manifest、service worker、图标没有进构建产物；
- 发布目录在预检之后又变了，实际发出去的内容和审查的不一致。

本插件在真正调用 wrangler 之前先做只读预检，并返回一个目录指纹。只有模型/人审查报告、并用同一个指纹确认后，工具才继续部署。

## 两阶段流程

### 1. 预检（不会部署）

只说「把这个项目发出去」或直接调用 `deploy` 而不带 `confirm` 时，工具先做：

```text
部署预检通过（尚未部署）。
项目形态：static-dist
发布目录：/path/to/project/dist
Worker 名：my-site
文件：164 个 / 4.32 MiB
顶层内容：
- static：...
- icons：...
检查项：
- [通过] secret-scan：未发现凭据/私钥/敏感目录
- [提醒] local-endpoints：发现 1 处本机/内网/api 引用
...
预检指纹：f946f972698c5d3a
下一步：审查后带 confirm=f946f972698c5d3a 调用 deploy。
```

预检包含：

- **文件清单**：发布目录、文件数、总大小、顶层目录/文件；
- **阻止项**（硬失败）：`.env`、`*.key`、`*.pem`、`*.p12`、`cert/`、`.ssh`、`.git`、`node_modules`、符号链接、私钥文件名、超大/超量文件；
- **审查项**：`server/`、`scripts/`、`src/`、`tests/`、`package.json` 等不适合直接当静态资源的内容；
- **Cloudflare 适配**：静态站点是否有 `index.html`；Worker 配置；是否超过 Workers 静态资源上限（免费 20,000 文件 / 单文件 25 MiB）；
- **PWA 检查**：manifest、`start_url`/`scope`、icons、根目录 `sw.js`；
- **本机依赖检查**：构建产物里的 `/api/`、`localhost`、`127.0.0.1`、内网 IP、明文 `http://`；这些在静态托管上不会自动变成可用接口；
- **目录指纹**：文件路径、大小、mtime 的短 SHA-256。目录在预检后变化，指纹失效。

### 2. 确认后部署

```json
{
  "directory": "/abs/path/to/project",
  "mode": "account",
  "confirm": "f946f972698c5d3a"
}
```

工具会重新预检并比对指纹；一致后才进入上游原有的认证、审批和 `wrangler deploy` 流程。审批仍由 dsh 的 approval 通道完成；本插件不绕过审批。

## 安装

需要 Node.js 22+。实际部署需要：

- `wrangler` 在 PATH 上（临时预览要求 ≥ 4.102.0）；
- 有 Cloudflare 账号时，在插件设置里配置 `CLOUDFLARE_API_TOKEN` 凭据引用（推荐），或先 `wrangler login`。

```sh
# 从本地源码安装；路径必须绝对
dsh plugin --profile desktop add /absolute/path/to/dsh-plugin-safe-deploy

# 如果旧版 dsh-plugin-deploy 还安装着，先移除，避免 deploy 工具名冲突
dsh plugin --profile desktop remove dsh-plugin-deploy
```

重启 dsh 桌面版/Web 后，侧栏插件设置会出现 **dsh-plugin-safe-deploy**。

## 凭据

- 工具参数里没有 token 字段；插件设置里只填**引用名**，值写入 dsh 凭据服务；
- 值不会进入模型上下文、工具参数、命令或结果文本；
- 临时预览用独立 HOME，读不到本机 wrangler 凭据；不需要为了临时预览登录/登出；
- 部署仍需 dsh 的一次性审批；审批被禁用时会 fail closed。

## 临时预览与自有账号

| 模式 | 用途 | 要求 |
|---|---|---|
| `temporary` | 快速看效果，拿到 `*.workers.dev` 临时地址 + 60 分钟认领窗口 | 不需要 Cloudflare 账号；wrangler ≥ 4.102 |
| `account` | 长期地址、正式项目 | Cloudflare API token 或 wrangler login |
| `auto` | 已认证走 account，否则 temporary | 同上 |

临时预览不认领会被 Cloudflare 删除；认领链接属于凭据，不要分享会话记录。

## 自定义域名

插件只负责部署，不负责 DNS/自定义域。要绑定域名，在项目根的 `wrangler.jsonc` 写 `routes` / `custom_domain`，然后让预检识别到项目内 wrangler 配置，再部署。示例：

```jsonc
{
  "name": "my-site",
  "compatibility_date": "2026-11-17",
  "assets": { "directory": "./dist" },
  "routes": [
    { "pattern": "sub.example.com/*", "zone_name": "example.com" }
  ]
}
```

## 通用部署检查清单

1. **先构建**，只把构建产物放进发布目录（通常是 `dist/`），不要把仓库根、release 包或证书目录当静态目录。
2. 跑预检；先看 `blocked`，再看 `review`，最后看 `local-endpoints` / PWA / Worker 配置。
3. 对报告做模型/人工判断：哪些文件该发、哪些是服务端或本机专用、哪些接口上云后换成公网地址。
4. 用预检指纹确认；目录变化就重新预检，不复用旧指纹。
5. 部署后验证：目标 URL、`manifest.webmanifest`、`sw.js`、PWA 安装/离线、接口与域名 TLS。
6. 自定义域/优选域名/DNS 属于项目侧配置；不要在本插件里塞死。

## 已知限制

- 目标仍是 Cloudflare **Workers 静态资源**，不是 Cloudflare Pages；
- 不创建 DNS、自定义域、证书或优选线路；
- 预检是启发式文件名/产物检查，不是秘密内容的完整静态分析；**发布前仍需模型/人审查**；
- 临时预览 60 分钟认领，不认领会被删除；
- Workers 免费账号静态资源上限 20,000 文件 / 单文件 25 MiB；临时预览账号 1,000 文件 / 5 MiB；
- 插件本身不调用 LLM，部署动作由本地 wrangler 完成；不会产生额外的模型 token 消耗。

## 开发与验证

```sh
npm install
npm run typecheck
npm test        # 构建 + 测试
npm run check   # 插件扫描门禁
```

## License

MIT。派生自 [Octo-o-o-o/dsh-plugin-deploy](https://github.com/Octo-o-o-o/dsh-plugin-deploy)，原作者版权与 MIT 条款保留。