# 通用安全部署流程

这份清单适用于把任何本地项目发布到 Cloudflare Workers 静态资源（本插件当前目标）。

## 0. 先明确发布物

- 发布目录必须是构建产物（通常是 `dist/`），不是仓库根、release 包、源码目录。
- 发布目录里不应有 `server/`、`scripts/`、`cert/`、`.env`、私钥、`node_modules`。
- 先构建，再预检；构建失败或产物不完整时不要继续。

## 1. 运行预检

`deploy` 第一次调用（或不带 `confirm`）只读扫描，返回：

- `blocked`：硬失败项，必须修掉；
- `review`：需要模型/人判断的文件和目录；
- `topLevel` / `fileCount` / `totalBytes`：实际会发布什么；
- `checks`：静态入口、PWA、本机接口、CF 限制、wrangler 配置；
- `fingerprint`：目录快照。

## 2. 模型/人审查

至少检查：

1. 发布目录是否只包含静态产物？
2. 有没有把本机服务端、证书、密钥、脚本一起发出去？
3. 构建产物里有没有 `/api/`、`localhost`、内网 IP、明文 `http://`？上云后这些地址还有效吗？
4. PWA：manifest 是否可解析、start_url/scope 是否正确、icons 是否存在、根目录是否有 `sw.js`？
5. Worker 配置：name、assets.directory、routes/custom domain 是否符合预期？
6. 是否超过 Workers 限制（免费 20,000 文件 / 单文件 25 MiB；临时预览 1,000 文件 / 5 MiB）？
7. 目录在预检后是否又被 build/改动？有则重新预检。

## 3. 确认

- 只有审查通过才把 `fingerprint` 作为 `confirm` 传给 `deploy`。
- 插件会重新预检并比对；不一致就拒绝。
- 真正部署仍要 dsh 的审批；审批不可用时 fail closed。

## 4. 部署后验证

- 目标 URL 返回 200；
- `manifest.webmanifest` 的 MIME 正确（`application/manifest+json`）；
- `sw.js` 在根路径、scope 正确；
- PWA 安装/离线可用；
- 自定义域名/优选线路的 DNS、TLS、Worker 路由都正确；
- 不要把临时预览 URL 当成正式地址。

## 5. 通用风险

| 风险 | 处理 |
|---|---|
| release/仓库根包含 cert/*.key | 只发 dist；预检硬阻止 cert/ |
| 服务端代码被当静态文件 | 预检 review；只发构建产物 |
| 本机 API 上云后 404 | 预检 local-endpoints；改成公网接口或明确手填配置 |
| PWA 清单缺失/图标缺失 | 预检 pwa-manifest；重新构建并确认复制 public 资源 |
| 临时配置/密钥被上传 | 插件使用系统临时目录；预检 secret-scan |
| 目录预检后变化 | fingerprint 不匹配即拒绝；重新预检 |
| 临时预览过期 | 60 分钟内认领，否则用 account 模式 |

## 6. 自定义域/优选域名

- 插件不创建 DNS 或证书；在 `wrangler.jsonc` 配 `routes`，或按项目 DNS 教程配置。
- 优选域名属于域名/DNS 侧；先确认 Worker 路由和目标域名可用，再按线路配置。
- 部署后从境内外分别验证 DNS/TLS/内容，不要只看 wrangler 成功。