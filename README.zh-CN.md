# ModelPing · LLM API 测试工具

[English](./README.md) | **简体中文**

开箱即用的轻量 Web 工具，用于快速点测各家大模型 API 是否可用，并测量延迟与 token 消耗。

支持的协议：

| 协议               | 端点                                          | 典型供应商                                                       |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| `openai-chat`      | `/chat/completions`                           | OpenAI、DeepSeek、GLM、Qwen、Kimi、小米、各类聚合商…（多数兼容） |
| `openai-responses` | `/responses`                                  | OpenAI Responses API                                             |
| `gemini`           | `:generateContent` / `:streamGenerateContent` | Google Gemini 原生                                               |
| `anthropic`        | `/v1/messages`                                | Anthropic Claude                                                 |

特性：

- 选供应商自动填入 baseUrl；每个模型会自动探测 4 种协议
- 自动探测非流式与流式（SSE）可用性
- **查询余额**：按 baseUrl 主机识别供应商，一键查可用余额/额度（DeepSeek、SiliconFlow、OpenRouter、StepFun、Novita 等）
- **拉取模型列表**：从供应商 `/models` 端点拉取可用模型，弹层搜索多选后批量加入测试表格
- **一键导入 cc-switch**：把当前 provider 或已通过测试的 provider + model 导入到 Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw
- 可选自定义 User-Agent 预设，用于按客户端 UA 放行的 coding-plan 上游；模型测试、流式检测、模型列表和余额查询会一致生效
- 返回总延迟、首字延迟（TTFT，流式）、输入/输出/总 token
- 模型表格逐行状态灯：灰待测 → 蓝测试中 → 绿通过 / 红失败
- 批量测试（并发 3）、自定义模型、可调超时/重试/maxTokens/输入文本
- 历史记录（可持久化开关、复制 baseUrl/掩码 key、导出 JSON）
- **后端无状态**：不存储、不打印任何 API Key；key 仅在测试时由浏览器随请求转发

## 快速开始（本地）

```bash
npm install
npm run dev      # 前端 5173（开发） + 后端 8787，浏览器开 http://localhost:5173
```

生产模式（单进程，前后端同源）：

```bash
npm run build
npm start        # http://localhost:8787
```

## 供应商辅助功能

在连接面板填好供应商 `baseUrl` 和 API Key 后，ModelPing 还可以帮你完成几件常见配置工作：

- **查询余额**：点击 API Key 输入框旁边的「余额」。后端会按 `baseUrl` 的 host 匹配供应商，调用对应余额端点；支持的供应商会返回剩余余额/额度，不支持的会明确提示不支持。
- **拉取模型**：点击「拉模型」。ModelPing 会调用供应商 `/models` 端点，弹出可搜索、多选的模型列表，确认后批量加入测试表格。
- **一键导入 cc-switch**：模型区的「→ cc-switch」可导入当前 provider；历史记录中测试成功的行也会出现同样按钮，可连同已验证的 model 一起导入。按钮左侧下拉可选择目标应用：Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw，随后会唤起本机 `ccswitch://v1/import` 深链。

这些辅助功能复用 UI 中配置的 `baseUrl`、API Key、完整 URL 模式和可选 User-Agent。API Key 只会在本次请求/深链导入动作中使用，后端不会持久化保存。

## 默认模型

预设里内置了一批默认模型与精选 provider，参考 `farion1231/cc-switch` 的 provider/baseUrl/model 预设维护：

- 官方/原生：OpenAI、Anthropic、Google Gemini
- 国内与编码计划：DeepSeek、智谱 GLM、通义千问 Qwen、Moonshot/Kimi、Kimi For Coding、小米 MiMo、火山 Ark 
- 聚合与全球平台：SiliconFlow、OpenRouter、Nvidia

默认模型包含 `gpt-5.5` / `gpt-5.4`、`claude-opus-4-8` / `claude-sonnet-4-6`、`gemini-3.5-flash` / `gemini-3.1-pro`、`deepseek-v4-flash` / `deepseek-v4-pro`、`glm-5.2`、`kimi-k2.7-code`、`mimo-v2.5-pro` 等。

> ⚠️ 各家 model id 随官方持续演进。预设值仅供起步，请对照官方文档核对；UI「设置」里可增删改供应商和模型（保存在本机浏览器），也可以直接编辑 `web/public/presets.json` 后重新构建/部署作为新的默认配置。

## 参数默认值

| 参数           | 默认                                    |
| -------------- | --------------------------------------- |
| 输入文本       | 你好，请用一句话自我介绍。              |
| 传输           | 自动探测非流式与流式                    |
| 超时           | 60000 ms                                |
| 最大重试       | 1（指数退避，仅网络/超时/429/5xx 重试） |
| 最大输出 token | 1024                                    |
| User-Agent     | 空（不覆盖运行时默认 UA）               |

## 部署

### Docker（自托管 / 云服务器）

仓库内置 GitHub Actions 工作流（`.github/workflows/docker-publish.yml`），每次 push 到 `main` 会自动构建多架构镜像并推送到 GHCR。配合 compose 里自带的 Watchtower，更新闭环就是：**改代码 → `git push` → 镜像重建 → 服务器自动拉取重启**（无需 SSH）。

一次性配置：

1. **公开镜像** —— 首次 push 后工作流会发布 `ghcr.io/<owner>/modelping`。到仓库 *Packages* 把可见性设为 **Public**，服务器才能免登录拉取。（fork 的话，把 `docker-compose.yml` 里的 `image:` 改成你自己的 `ghcr.io/<owner>/modelping`。）
2. **在服务器上**：
   ```bash
   git clone https://github.com/<owner>/ModelPing.git
   cd ModelPing
   cp .env.example .env        # 设置强 APP_PASSWORD（已被 .gitignore 排除，不入库）
   docker compose up -d        # http://<server>:8787
   ```

`docker-compose.yml` 跑两个服务：`modelping`（应用）和 `watchtower`（每 5 分钟检查 GHCR，拉新镜像、重启、清理旧镜像）。镜像不烘焙任何 key。

之后更新只需 `git push` 到 `main` —— Action 重建、Watchtower 在一个间隔内自动重新部署。想在机器上本地构建而不走 GHCR？把 `image:` 换回 `build: .`，用 `docker compose up -d --build`。

环境变量（写在 `.env`，或 `docker-compose.yml` 的 `environment:` 块）：

- `APP_PASSWORD`（compose 要求必填）：`/api` 的访问口令闸
- `ALLOWED_HOSTS`：可选，逗号分隔的目标主机白名单（防开放代理 / SSRF）。留空则允许任意自定义目标主机；若留空，请改在网络层阻断内网访问（见安全说明）
- `CORS_ORIGIN`：逗号分隔的允许跨站来源（缺省同源，见下方安全说明）

设置持久化（presets 跨设备共享）默认用 file 驱动，`docker-compose.yml` 已把 `SETTINGS_FILE` 指到 `/data/presets.json` 并挂了命名卷 `presets-data`，重建容器不丢失。首次卷为空时 `/presets.json` 会自动回退到镜像内置的默认预设。

### Cloudflare Workers（免费版）

```bash
npm run build
npx wrangler login
npm run deploy:cf
```

静态资源经 `[assets]` 绑定托管，SPA 路由自动回退 index.html。访问口令用 secret（勿写进 `wrangler.toml`）：

```bash
npx wrangler secret put APP_PASSWORD
```

目标主机白名单可在 `wrangler.toml` 的 `[vars]` 里设 `ALLOWED_HOSTS`。设置持久化（跨设备共享 presets）需绑定 KV：先 `wrangler kv namespace create SETTINGS_KV`，再把返回的 id 填进 `wrangler.toml` 的 `[[kv_namespaces]]`（绑定名固定为 `SETTINGS_KV`，store 据此自动启用 cf-kv 驱动）。

### Vercel（免费版）

```bash
npm i -g vercel
vercel            # 首次按提示关联项目，后续 vercel --prod
```

前端静态托管 + 单个 serverless function（`api/index.ts`，由 `vercel.json` 把 `/api/*` 路由过去）。设置持久化默认走 Vercel Blob：在项目里接入 Blob 后会自动注入 `BLOB_READ_WRITE_TOKEN`，store 据此启用 vercel 驱动；未接入则为前端纯本地模式。

> ⚠️ Vercel 免费版 serverless function 执行时长约 10s 上限，而本工具默认 `timeoutMs=60000`。测较慢的模型或长流式响应可能被平台中途切断，表现为非预期失败。建议私用、调小超时，或在 `vercel.json` 配置更高的 `maxDuration`（需对应套餐支持）。

### 设置持久化（presets 跨设备共享）

UI「设置」里增删改的供应商/模型默认存浏览器本地。若想跨设备共享，可启用服务端持久化（**不存储任何 apiKey**），按部署平台自动选驱动：

| 驱动       | 触发条件                              | 存储位置                          |
| ---------- | ------------------------------------- | --------------------------------- |
| `file`     | 默认（Node 自托管 / Docker）          | `./web/public/presets.json`，与 `/presets.json` 同源，改即生效 |
| `cf-kv`    | 绑定了 `SETTINGS_KV`                  | Cloudflare KV                     |
| `vercel`   | 存在 `BLOB_READ_WRITE_TOKEN`          | Vercel Blob                       |
| `none`     | `STORAGE_DRIVER=none`                 | 关闭服务端持久化（纯前端本地）    |

可用 `STORAGE_DRIVER` 显式指定驱动，`SETTINGS_FILE` 覆盖 file 驱动路径。

## 环境变量

| 变量                   | 作用                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `APP_PASSWORD`         | 可选访问口令；设置后所有 `/api` 请求须带 `x-app-password`     |
| `ALLOWED_HOSTS`        | 可选目标主机白名单（逗号分隔），防开放代理 / SSRF；缺省不限制 |
| `BLOCK_PRIVATE_HOSTS`  | 设为 `1` 时拒绝目标解析到私有/环回/链路本地/云元数据地址（应用层 SSRF 兜底）；缺省关闭。需测试本地/内网端点（如 Ollama）时**勿开启** |
| `CORS_ORIGIN`          | 可选 CORS 允许来源（逗号分隔，`*` 表示全开）；缺省不下发 ACAO（默认同源） |
| `STORAGE_DRIVER`       | 显式选驱动：`file` / `cf-kv` / `vercel` / `none`             |
| `SETTINGS_FILE`        | file 驱动的 presets 路径，缺省 `./web/public/presets.json`   |
| `BLOB_READ_WRITE_TOKEN`| Vercel Blob token（接入 Blob 后自动注入）                    |
| `PORT`                 | Node 服务监听端口，缺省 8787                                 |

## 安全说明（重要）

- 本工具是一个**转发代理**：前端把 baseUrl + key 发给后端，后端转发给目标 API。后端自身不持久化任何 key。
- 历史记录里的 key 只存在**你浏览器的 localStorage**（可在面板关闭持久化）。
- **CORS 默认同源**：未配置 `CORS_ORIGIN` 时后端不下发 `Access-Control-Allow-Origin`，其他网站的 JS 调不动你的 `/api`。需要跨站调用时才显式配置允许来源。
- 公网裸部署等于开放代理，**强烈建议私用**，或务必启用 `APP_PASSWORD` + `ALLOWED_HOSTS`。`APP_PASSWORD` 用常量时间比较，降低口令枚举风险。
- 不可信多租户环境可设 `BLOCK_PRIVATE_HOSTS=1`，作为防火墙脚本（`deploy/firewall-egress.sh`）之外的应用层补充。它能拦截字面私有/环回/元数据 IP，但挡不住 DNS rebinding——网络层隔离仍是根本。
- 后端全程不打印 key 与请求体；失败日志里的 key/token/authorization 均做脱敏。

## 项目结构

```
src/
  types.ts            统一类型
  adapters/           4 个协议适配器 + 注册表（openai-chat / openai-responses / gemini / anthropic）
  runner.ts           fetch / 超时 / 重试 / SSE 解析 / usage 聚合 / 日志脱敏
  balance.ts          余额查询（按 host 匹配各家端点的可扩展注册表）
  models-fetch.ts     拉取供应商模型列表（按 baseUrl 形态选 /models 端点）
  presets-schema.ts   presets 校验（前后端共享的纯函数）
  app.ts              框架无关的 Hono app（校验 / 口令 / CORS / 白名单 / 路由 / 设置持久化）
  node.ts             Node 入口（@hono/node-server + 静态资源）
  worker.ts           Cloudflare Workers 入口（ASSETS 绑定）
  store/              设置持久化驱动：types / file / cf-kv / vercel / index（按平台自动选）
api/
  index.ts            Vercel serverless 入口（hono/vercel）
web/
  index.html  main.tsx  styles.css
  public/presets.json 默认供应商 / 模型 / 参数配置
  lib/                types / api(含 SSE) / storage / format / theme / presets / ccswitch
  components/         App / ConnectionPanel / ConfigPanel / ModelTable / ModelPickerModal /
                      HistoryPanel / SettingsPanel / ThemeToggle / CcSwitchButton / CopyButton
```

## 脚本

| 命令                | 作用                                      |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | 开发（前端 + 后端热重载）                 |
| `npm run build`     | 构建前端(dist/client) + 后端(dist/server) |
| `npm start`         | 运行已构建的 Node 服务                    |
| `npm run typecheck` | 类型检查                                  |
| `npm run deploy:cf` | 构建并部署到 Cloudflare                   |
| `vercel`            | 部署到 Vercel（`vercel --prod` 上生产）   |

## 开源声明

本项目以 [MIT 许可证](./LICENSE) 开源，可自由使用、修改、分发，详见根目录 `LICENSE` 文件。

默认模型与精选 provider 预设参考了 [farion1231/cc-switch](https://github.com/farion1231/cc-switch)（provider / baseUrl / model / 余额端点）。各家协议、模型 id 与端点归各自服务商所有，本工具仅作转发与测试，不附带任何 API Key，也不对第三方服务的可用性或计费负责。

欢迎提 issue 与 PR。提交前请确保 `npm run typecheck` 与 `npm run build` 通过。
