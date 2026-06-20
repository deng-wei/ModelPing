# ModelPing · LLM API Testing Tool

**English** | [简体中文](./README.zh-CN.md)

A lightweight, zero-config web tool to quickly check whether an LLM API is reachable, and to measure latency and token usage across providers.

Supported protocols:

| Protocol           | Endpoint                                      | Typical providers                                                |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| `openai-chat`      | `/chat/completions`                           | OpenAI, DeepSeek, GLM, Qwen, Kimi, MiMo, most aggregators…       |
| `openai-responses` | `/responses`                                  | OpenAI Responses API                                             |
| `gemini`           | `:generateContent` / `:streamGenerateContent` | Google Gemini (native)                                           |
| `anthropic`        | `/v1/messages`                                | Anthropic Claude                                                 |

Features:

- Pick a provider to auto-fill its baseUrl; each model auto-probes the 4 protocols
- Auto-detects non-streaming and streaming (SSE) availability
- **Balance lookup**: identifies the provider by baseUrl host and queries remaining credit/quota in one click (DeepSeek, SiliconFlow, OpenRouter, StepFun, Novita, …)
- **Model list fetch**: pulls available models from the provider's `/models` endpoint; search, multi-select in a modal, and batch-add to the test table
- Optional custom User-Agent presets for coding-plan upstreams that gate access by client UA; applies consistently to model tests, stream checks, model listing, and balance lookup
- Reports total latency, time-to-first-token (TTFT, streaming), and input/output/total tokens
- Per-row status lights in the model table: gray (pending) → blue (testing) → green (pass) / red (fail)
- Batch testing (concurrency 3), custom models, adjustable timeout/retries/maxTokens/input text
- History (toggleable persistence, copy baseUrl/masked key, export JSON)
- **Stateless backend**: never stores or logs any API key; keys are forwarded by the browser only at test time

## Quick start (local)

```bash
npm install
npm run dev      # frontend on 5173 (dev) + backend on 8787; open http://localhost:5173
```

Production mode (single process, frontend and backend same-origin):

```bash
npm run build
npm start        # http://localhost:8787
```

## Default models

A set of default models and curated providers is bundled, maintained with reference to the provider/baseUrl/model presets of [`farion1231/cc-switch`](https://github.com/farion1231/cc-switch):

- Official/native: OpenAI, Anthropic, Google Gemini
- China & coding plans: DeepSeek, Zhipu GLM, Qwen, Moonshot/Kimi, Kimi For Coding, Xiaomi MiMo, Volcengine Ark
- Aggregators & global platforms: SiliconFlow, OpenRouter, Nvidia

> ⚠️ Model ids evolve as providers update. The presets are a starting point only — verify against official docs. You can add/edit/remove providers and models in the UI's **Settings** (saved in the browser), or edit `web/public/presets.json` and rebuild/redeploy to ship new defaults.

## Parameter defaults

| Parameter        | Default                                          |
| ---------------- | ------------------------------------------------ |
| Input text       | 你好，请用一句话自我介绍。                        |
| Transport        | Auto-probe non-streaming and streaming           |
| Timeout          | 60000 ms                                          |
| Max retries      | 1 (exponential backoff; only network/timeout/429/5xx) |
| Max output tokens| 1024                                             |
| User-Agent       | Empty (do not override runtime default)          |

## Deployment

### Docker (self-host / cloud server)

The repo ships a GitHub Actions workflow (`.github/workflows/docker-publish.yml`) that builds a multi-arch image and pushes it to GHCR on every push to `main`. Paired with the bundled Watchtower service, the update loop is: **edit code → `git push` → image rebuilt → server auto-pulls and restarts** (no SSH needed).

One-time setup:

1. **Publish the image** — after the first push, the workflow publishes `ghcr.io/<owner>/modelping`. In your repo's *Packages*, set its visibility to **Public** so the server can pull without credentials. (Forking? Change the `image:` in `docker-compose.yml` to your own `ghcr.io/<owner>/modelping`.)
2. **On the server**:
   ```bash
   git clone https://github.com/<owner>/ModelPing.git
   cd ModelPing
   cp .env.example .env        # set a strong APP_PASSWORD (kept out of git via .gitignore)
   docker compose up -d        # http://<server>:8787
   ```

`docker-compose.yml` runs two services: `modelping` (the app) and `watchtower` (checks GHCR every 5 min, pulls new images, restarts, prunes old ones). The image bakes in no keys.

To update afterwards, just `git push` to `main` — the Action rebuilds and Watchtower redeploys within its interval. Prefer building on the box instead of GHCR? Replace `image:` with `build: .` and run `docker compose up -d --build`.

Environment (set in `.env`, or the `environment:` block of `docker-compose.yml`):

- `APP_PASSWORD` (required by compose): access-password gate for `/api`
- `ALLOWED_HOSTS`: optional comma-separated target-host allowlist (open-proxy / SSRF protection). Leave unset to allow any custom target host; if you do, block intranet access at the network layer instead (see Security)
- `CORS_ORIGIN`: comma-separated allowed cross-site origins (same-origin by default; see Security below)

Settings persistence (presets shared across devices) uses the file driver by default. `docker-compose.yml` already points `SETTINGS_FILE` to `/data/presets.json` and mounts a named volume `presets-data`, so it survives container rebuilds. When the volume is empty on first run, `/presets.json` falls back to the defaults bundled in the image.

### Cloudflare Workers (free tier)

```bash
npm run build
npx wrangler login
npm run deploy:cf
```

Static assets are served via the `[assets]` binding, with SPA routing falling back to index.html. Set the access password as a secret (do not put it in `wrangler.toml`):

```bash
npx wrangler secret put APP_PASSWORD
```

Set `ALLOWED_HOSTS` under `[vars]` in `wrangler.toml`. For cross-device presets persistence, bind a KV namespace: run `wrangler kv namespace create SETTINGS_KV`, then put the returned id into `[[kv_namespaces]]` in `wrangler.toml` (the binding name must be `SETTINGS_KV`; the store enables the cf-kv driver automatically).

### Vercel (free tier)

```bash
npm i -g vercel
vercel            # link the project on first run; later use vercel --prod
```

Static hosting + a single serverless function (`api/index.ts`, which `vercel.json` routes `/api/*` to). Settings persistence uses Vercel Blob by default: once you add Blob to the project, `BLOB_READ_WRITE_TOKEN` is injected automatically and the store enables the vercel driver; otherwise it runs in frontend-only local mode.

> ⚠️ Vercel free-tier serverless functions have an execution limit of ~10s, while this tool defaults to `timeoutMs=60000`. Testing slow models or long streaming responses may be cut off mid-flight by the platform, surfacing as unexpected failures. Use it privately, lower the timeout, or set a higher `maxDuration` in `vercel.json` (requires a suitable plan).

### Settings persistence (presets shared across devices)

Providers/models edited in the UI's **Settings** are stored in the browser by default. To share them across devices, enable server-side persistence (**no apiKey is ever stored**); the driver is auto-selected by platform:

| Driver   | Trigger                              | Storage location                                              |
| -------- | ------------------------------------ | ------------------------------------------------------------- |
| `file`   | default (Node self-host / Docker)    | `./web/public/presets.json`, same source as `/presets.json`, instant effect |
| `cf-kv`  | `SETTINGS_KV` bound                  | Cloudflare KV                                                 |
| `vercel` | `BLOB_READ_WRITE_TOKEN` present      | Vercel Blob                                                   |
| `none`   | `STORAGE_DRIVER=none`                | server-side persistence off (frontend-only)                   |

Use `STORAGE_DRIVER` to force a driver, and `SETTINGS_FILE` to override the file driver's path.

## Environment variables

| Variable                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `APP_PASSWORD`          | Optional access password; when set, all `/api` requests must send `x-app-password` |
| `ALLOWED_HOSTS`         | Optional target-host allowlist (comma-separated), prevents open proxy / SSRF; unrestricted if unset |
| `CORS_ORIGIN`           | Optional CORS allowed origins (comma-separated, `*` = open to all); no ACAO header if unset (same-origin) |
| `STORAGE_DRIVER`        | Force a driver: `file` / `cf-kv` / `vercel` / `none`                         |
| `SETTINGS_FILE`         | Presets path for the file driver; defaults to `./web/public/presets.json`    |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (injected automatically once Blob is added)                |
| `PORT`                  | Node server listen port; defaults to 8787                                    |

## Security (important)

- This tool is a **forwarding proxy**: the frontend sends baseUrl + key to the backend, which forwards to the target API. The backend itself persists no keys.
- Keys in history live only in **your browser's localStorage** (persistence can be turned off in the panel).
- **CORS is same-origin by default**: when `CORS_ORIGIN` is unset, the backend sends no `Access-Control-Allow-Origin`, so other sites' JS cannot call your `/api`. Configure allowed origins explicitly only when you need cross-site calls.
- A bare public deployment is effectively an open proxy. **Private use is strongly recommended**, or make sure to enable `APP_PASSWORD` + `ALLOWED_HOSTS`. `APP_PASSWORD` is compared in constant time to reduce password-enumeration risk.
- The backend never logs keys or request bodies; keys/tokens/authorization in failure logs are redacted.

## Project structure

```
src/
  types.ts            Shared types
  adapters/           4 protocol adapters + registry (openai-chat / openai-responses / gemini / anthropic)
  runner.ts           fetch / timeout / retry / SSE parsing / usage aggregation / log redaction
  balance.ts          Balance lookup (extensible registry matching each provider's endpoint by host)
  models-fetch.ts     Fetch provider model list (picks /models endpoint by baseUrl shape)
  presets-schema.ts   Presets validation (pure function shared by frontend & backend)
  app.ts              Framework-agnostic Hono app (validation / password / CORS / allowlist / routes / persistence)
  node.ts             Node entry (@hono/node-server + static assets)
  worker.ts           Cloudflare Workers entry (ASSETS binding)
  store/              Persistence drivers: types / file / cf-kv / vercel / index (auto-selected by platform)
api/
  index.ts            Vercel serverless entry (hono/vercel)
web/
  index.html  main.tsx  styles.css
  public/presets.json Default providers / models / parameters
  lib/                types / api (incl. SSE) / storage / format / theme / presets / ccswitch
  components/         App / ConnectionPanel / ConfigPanel / ModelTable / ModelPickerModal /
                      HistoryPanel / SettingsPanel / ThemeToggle / CcSwitchButton / CopyButton
```

## Scripts

| Command             | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Dev (frontend + backend hot reload)              |
| `npm run build`     | Build frontend (dist/client) + backend (dist/server) |
| `npm start`         | Run the built Node server                        |
| `npm run typecheck` | Type checking                                    |
| `npm run deploy:cf` | Build and deploy to Cloudflare                   |
| `vercel`            | Deploy to Vercel (`vercel --prod` for production)|

## License & credits

Released under the [MIT License](./LICENSE) — free to use, modify, and distribute. See the `LICENSE` file in the repo root.

The default models and curated provider presets are referenced from [farion1231/cc-switch](https://github.com/farion1231/cc-switch) (provider / baseUrl / model / balance endpoints). Each provider's protocols, model ids, and endpoints belong to their respective owners. This tool only forwards and tests; it bundles no API keys and is not responsible for third-party service availability or billing.

Issues and PRs welcome. Before submitting, please make sure `npm run typecheck` and `npm run build` pass.
