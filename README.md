# dsh-plugin-subscriptions

English | [中文](README.zh.md)

Use your **ChatGPT (Codex)**, **Claude**, and **Grok (X Premium)** subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no API keys. Login happens in the dsh web UI (Settings → Subscriptions); tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

## Providers

| Route    | Subscription      | Models |
|----------|-------------------|--------|
| `codex`  | ChatGPT Plus/Pro  | live catalog from `chatgpt.com/backend-api/codex/models` |
| `claude` | Claude Pro/Max    | claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5 |
| `grok`   | X Premium (xAI)   | live catalog from `api.x.ai/v1/models` (chat models only) |

Only logged-in providers appear in the session model picker; the lists above refresh on login/logout. Vision-capable models declare `['text', 'image']` input modalities, and image content is translated to each provider's wire format.

Also included, registered when the matching provider is enabled:

- **`x_search`** tool (Grok) — xAI's hosted X search, returning `{ answer, citations }`.
- **`image_generate`** tool (ChatGPT) — `gpt-image-2` via the Codex backend; PNGs are saved under `~/.dsh/plugins/subscriptions/images/` and the paths returned.

## Install

With the `dsh` CLI available, install from npm (prebuilt artifacts, no build permission needed):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

Or install the sources from GitHub:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

pnpm will ask you to allow this package's build script on first install (git installs fetch sources, not built artifacts); add the printed key to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

and re-run the `add`. Only grant this to packages you trust — it runs the package's code at install time.

From a local checkout instead:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

Headless-only usage without installing into a profile (log in via the web UI first — the token file is shared):

```sh
dsh --profile headless --patch <checkout>/overlay.yml "your task"
```

## Use

1. `dsh web`, open the printed URL.
2. Settings → **Subscriptions**: click **Log in** on a provider and authorize in the opened tab. If the browser flow can't complete (headless host), expand the manual fallback and paste the callback URL or code.
3. In any session, open the model picker (`/model`) and choose a model under **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)**.

Not logged in? The provider stays out of the picker, and requests fail with `MISSING_CREDENTIAL` pointing at the Settings page; nothing else breaks.

## Config

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # subset; default all three
    streamIdleTimeoutMs: 300000
    models:                            # override the discovered/built-in catalogs
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
```

## Develop

```sh
pnpm install   # devDependencies link into a local deepseek-harness checkout — edit the paths first
pnpm build     # tsc (lib/) + tsdown (lib/client.js browser bundle)
pnpm test      # node --test over compiled unit specs
```

`prepare` (used by git installs) runs `tsdown.prepare.config.ts`: a self-contained bundle build of both faces with all `@deepseek-ai/*` specifiers external — they resolve from the dsh installation at runtime, so this package never carries a second cordis copy.

After `pnpm build`, restart `dsh web` to pick up changes.

## Layout

- `src/index.ts` — plugin entry: config schema, adapter registration, auth-change re-announce, RPC wiring
- `src/auth/` — PKCE/JWT helpers, token store, OAuth flow engine (temp loopback callback server), `/subscriptions-auth` RPC channel
- `src/providers/` — per-provider OAuth constants/exchange/refresh + `LlmAdapter`s
- `src/translate/` — dsh `Message[]` ⟷ OpenAI Responses / Anthropic Messages wire formats, SSE → `StreamChunk`
- `src/tools/` — `x_search` and `image_generate`
- `src/client/` — the Settings → Subscriptions page (browser half, zh/en, theme-token aware)
