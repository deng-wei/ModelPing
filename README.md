# ModelPing · LLM API Testing Tool

**English** | [简体中文](./README.zh-CN.md)

A lightweight, zero-config web tool to quickly check whether an LLM API is reachable, and to measure latency and token usage across providers.

![Screenshot](./web/public/screenshot.png)

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
- **One-click cc-switch import**: opens `ccswitch://v1/import` deep links for the current provider or a passed test result, with target app selection for Claude Code, Codex, Gemini CLI, OpenCode, and OpenClaw
- Optional custom User-Agent presets for coding-plan upstreams that gate access by client UA; applies consistently to model tests, stream checks, model listing, and balance lookup
- Reports total latency, time-to-first-token (TTFT, streaming), and input/output/total tokens
- Per-row status lights in the model table: gray (pending) → blue (testing) → green (pass) / red (fail)
- Batch testing (concurrency 3), custom models, adjustable timeout/retries/maxTokens/input text
- History (toggleable persistence, copy baseUrl/masked key, export JSON)
- Status page: save common provider + model entries, batch-refresh endpoint latency, auto-refresh, and import to cc-switch
- **Key safety**: the backend never stores API keys in plaintext and never logs them; private working state is saved only as an encrypted blob

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

## Provider helpers

After entering a provider `baseUrl` and API key in the connection panel, ModelPing can help with a few adjacent setup tasks:

- **Query balance**: click **Balance** next to the API key field. The backend matches the provider by the `baseUrl` host, calls the provider's balance endpoint, and returns remaining credit/quota when that provider is supported. Unsupported providers will be reported as unsupported instead of guessed.
- **Fetch models**: click **Fetch models** next to the API key field. ModelPing calls the provider's `/models` endpoint, opens a searchable multi-select modal, and batch-adds selected model ids to the test table.
- **Import to cc-switch**: use the **→ cc-switch** button in the model area to import the current provider, or use the same button in successful history rows to import a tested provider + model pair. The target app dropdown supports Claude Code, Codex, Gemini CLI, OpenCode, and OpenClaw, then opens the local `ccswitch://v1/import` deep link.

These helpers use the same `baseUrl`, API key, full-URL mode, and optional User-Agent configured in the UI. API keys are only forwarded for the request/deep link action and are not persisted by the backend.

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

Cloudflare Workers is the recommended low-cost personal deployment path. The app is built as a Worker API plus Workers Static Assets, so normal page and asset requests are served by Assets while `/api/*` invokes the Worker.

### Docker (self-host / cloud server)

The repo still ships a GitHub Actions workflow (`.github/workflows/docker-publish.yml`) for fallback self-hosting. It builds and pushes a GHCR image only when manually dispatched or when a `v*` tag is pushed, so day-to-day `main` pushes can be handled by Cloudflare Builds instead.

One-time setup:

1. **Publish the image** — run the workflow manually or push a `v*` tag to publish `ghcr.io/<owner>/modelping`. In your repo's *Packages*, set its visibility to **Public** so the server can pull without credentials. (Forking? Change the `image:` in `docker-compose.yml` to your own `ghcr.io/<owner>/modelping`.)
2. **On the server**:
   ```bash
   git clone https://github.com/<owner>/ModelPing.git
   cd ModelPing
   cp .env.example .env        # set APP_PASSWORD and PRIVATE_STATE_SECRET (kept out of git)
   docker compose up -d        # http://<server>:8787
   ```

`docker-compose.yml` runs two services: `modelping` (the app) and `watchtower` (checks GHCR every 5 min, pulls new images, restarts, prunes old ones). The image bakes in no keys.

To update afterwards, manually rerun the workflow or push a `v*` tag, then Watchtower redeploys within its interval. Prefer building on the box instead of GHCR? Replace `image:` with `build: .` and run `docker compose up -d --build`.

Environment (set in `.env`, or the `environment:` block of `docker-compose.yml`):

- `APP_PASSWORD` (required by compose): access-password gate for `/api`
- `PRIVATE_STATE_SECRET` (required by compose): long random encryption secret for private working state; keep it separate from `APP_PASSWORD`
- `ALLOWED_HOSTS`: optional comma-separated target-host allowlist (open-proxy / SSRF protection). Leave unset to allow any custom target host; if you do, block intranet access at the network layer instead (see Security)
- `CORS_ORIGIN`: comma-separated allowed cross-site origins (same-origin by default; see Security below)

Settings persistence (presets shared across devices) uses the file driver by default. `docker-compose.yml` already points `SETTINGS_FILE` to `/data/presets.json` and mounts a named volume `presets-data`, so it survives container rebuilds. When the volume is empty on first run, `/presets.json` falls back to the defaults bundled in the image.

Private working state (history, the history persistence toggle, last connection, test settings, and Status entries, including API keys) is stored server-side as an encrypted blob when `PRIVATE_STATE_SECRET`, `STATUS_SECRET`, or `APP_PASSWORD` is available. For Docker, set a dedicated `PRIVATE_STATE_SECRET` so changing the access password does not make existing state undecryptable. `STATUS_SECRET` is only a legacy fallback; old sensitive localStorage keys are migrated once and removed; theme/language and non-sensitive preset cache stay local.

### Cloudflare Workers (free tier)

```bash
npx wrangler login
npx wrangler kv namespace create SETTINGS_KV
npm run deploy:cf
npx wrangler secret put APP_PASSWORD
npx wrangler secret put PRIVATE_STATE_SECRET
```

Put the returned KV id into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SETTINGS_KV"
id = "<your-kv-namespace-id>"
```

Static assets are served via `[assets]` with SPA fallback. `wrangler.toml` enables `assets_navigation_prefers_asset_serving`, so browser navigation to frontend routes is served by Assets and does not consume Worker requests. Only `/api/*` calls invoke the Worker.

Free-tier defaults are intentionally conservative:

- `PRIVATE_STATE_SCOPE=config`: KV stores presets, last connection, test parameters, and Status entries, but not test history.
- `BLOCK_PRIVATE_HOSTS=1`: Workers lacks the Docker egress firewall, so public deployments get app-level private-address blocking by default.
- `APP_PASSWORD` and `PRIVATE_STATE_SECRET` must be Workers secrets, not `wrangler.toml` values.

For GitHub push-to-deploy, connect the repository in Cloudflare Workers Builds:

- Production branch: `main`
- Build command: `npm run build:cf`
- Deploy command: `npx wrangler deploy`

Cloudflare free-tier reference limits: Workers Free has 100,000 requests/day, 10 ms CPU/request, and 50 subrequests/request; KV Free has 100,000 reads/day, 1,000 writes/day, 1 write/second to the same key, and 1 GB storage. Workers Static Assets requests are free and unlimited.

### Vercel (free tier)

```bash
npm i -g vercel
vercel            # link the project on first run; later use vercel --prod
```

Static hosting + a single serverless function (`api/index.ts`, which `vercel.json` routes `/api/*` to). Settings/private-state persistence uses Vercel Blob by default: once you add Blob to the project, `BLOB_READ_WRITE_TOKEN` is injected automatically and the store enables the vercel driver; otherwise server-side persistence is disabled and the UI falls back where possible.

> ⚠️ Vercel free-tier serverless functions have an execution limit of ~10s, while this tool defaults to `timeoutMs=60000`. Testing slow models or long streaming responses may be cut off mid-flight by the platform, surfacing as unexpected failures. Use it privately, lower the timeout, or set a higher `maxDuration` in `vercel.json` (requires a suitable plan).

### Settings persistence (presets shared across devices)

Providers/models edited in the UI's **Settings** are stored in the browser by default. To share them across devices, enable server-side presets persistence (**presets never contain apiKey**); the driver is auto-selected by platform:

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
| `BLOCK_PRIVATE_HOSTS`   | Set to `1` to reject targets resolving to private/loopback/link-local/cloud-metadata addresses (app-level SSRF guard); off by default. Do **not** enable if you need to test local/intranet endpoints (e.g. Ollama) |
| `CORS_ORIGIN`           | Optional CORS allowed origins (comma-separated, `*` = open to all); no ACAO header if unset (same-origin) |
| `STORAGE_DRIVER`        | Force a driver: `file` / `cf-kv` / `vercel` / `none`                         |
| `SETTINGS_FILE`         | Presets path for the file driver; defaults to `./web/public/presets.json`    |
| `PRIVATE_STATE_SECRET`  | Encryption secret for private working state; optional globally, required by the bundled Docker compose; falls back to `STATUS_SECRET`, then `APP_PASSWORD` |
| `PRIVATE_STATE_SCOPE`   | Private-state persistence scope: `full` (default), `config` (conn/config/status only; no history), or `none` |
| `PRIVATE_STATE_FILE`    | File-driver path for encrypted private working state; defaults to `./data/private-state.enc` |
| `STATUS_SECRET`         | Optional legacy secret; used only as a private-state fallback                |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (injected automatically once Blob is added)                |
| `PORT`                  | Node server listen port; defaults to 8787                                    |

## Security (important)

- This tool is a **forwarding proxy**: the frontend sends baseUrl + key to the backend, which forwards to the target API.
- Keys in history, last connection, and Status entries are persisted only in the encrypted private-state blob. If private-state persistence is unavailable, they remain in memory for the current browser session and are not written to localStorage; old sensitive localStorage keys are deleted after one migration pass.
- **CORS is same-origin by default**: when `CORS_ORIGIN` is unset, the backend sends no `Access-Control-Allow-Origin`, so other sites' JS cannot call your `/api`. Configure allowed origins explicitly only when you need cross-site calls.
- A bare public deployment is effectively an open proxy. Keep a strong `APP_PASSWORD`; for Docker, also expose it only behind HTTPS and either set `ALLOWED_HOSTS` or run the bundled `deploy/firewall-egress.sh` network-layer egress guard. On Cloudflare Workers, leave `BLOCK_PRIVATE_HOSTS=1` enabled unless you explicitly need private-address targets. `APP_PASSWORD` is compared in constant time to reduce password-enumeration risk.
- When accessed through a non-local address, the UI shows a non-blocking safety warning if the instance appears to be missing an access password or target-host/private-address restrictions.
- If you frequently test local/intranet endpoints, leave `BLOCK_PRIVATE_HOSTS` off and rely on the Docker egress firewall rules for what the public instance may reach. For untrusted multi-tenant deployments, set `BLOCK_PRIVATE_HOSTS=1` as an app-level complement; it rejects literal private/loopback/metadata IPs but cannot stop DNS rebinding.
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
  env.ts              Shared runtime env/store injection for Node / Workers / Vercel
  node.ts             Node entry (@hono/node-server + static assets)
  worker.ts           Cloudflare Workers entry (ASSETS binding)
  store/              Persistence drivers: types / file / cf-kv / vercel / index (auto-selected by platform)
api/
  index.ts            Vercel serverless entry
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
| `npm run build:cf`  | Build frontend assets for Cloudflare Workers          |
| `npm start`         | Run the built Node server                        |
| `npm run typecheck` | Type checking                                    |
| `npm run deploy:cf` | Build and deploy to Cloudflare                   |
| `vercel`            | Deploy to Vercel (`vercel --prod` for production)|

## License & credits

Released under the [MIT License](./LICENSE) — free to use, modify, and distribute. See the `LICENSE` file in the repo root.

The default models and curated provider presets are referenced from [farion1231/cc-switch](https://github.com/farion1231/cc-switch) (provider / baseUrl / model / balance endpoints). Each provider's protocols, model ids, and endpoints belong to their respective owners. This tool only forwards and tests; it bundles no API keys and is not responsible for third-party service availability or billing.

Issues and PRs welcome. Before submitting, please make sure `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass.
