# omp-axonhub

[中文文档](README.zh-CN.md)

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) plugin that registers an [AxonHub](https://github.com/looplj/axonhub) LLM gateway as the `axonhub` model provider.

AxonHub is a multi-protocol gateway: `/v1` speaks OpenAI chat-completions and responses, `/anthropic` speaks Anthropic messages, and `/gemini/v1beta` speaks Gemini generateContent. This plugin discovers every model the gateway exposes and routes each model id to the correct inbound protocol automatically.

## Features

- **Model discovery** — fetches both `/v1/models` and `/v1/models?include=all` and merges them by id; each endpoint is tolerated to fail on its own, and only a total failure is reported so a transient outage never wipes the cached list.
- **Protocol routing by model id** — `claude*` → `/anthropic`, `gemini*` → `/gemini/v1beta`, `gpt-*`/`codex*` → OpenAI responses on `/v1`, everything else → OpenAI chat-completions on `/v1`. (`owned_by` names the upstream channel, not the inbound endpoint, so it is deliberately ignored.)
- **Non-chat filtering** — embedding, rerank, speech, and image models are dropped unless `AXONHUB_INCLUDE_NON_CHAT` is set.
- **models.dev enrichment** — fields AxonHub leaves out (context window, limits, reasoning, cost, modalities) are filled from [models.dev](https://models.dev) when available; anything still missing falls through to omp's bundled catalog. Disable with `AXONHUB_NO_MODELS_DEV`.
- **Optional provider-side web search** — `AXONHUB_WEB_SEARCH` injects OpenAI's `web_search` tool into `gpt-*` requests. Off by default because omp ships its own search and the provider tool is billed separately.

## Install

From npm:

```sh
omp plugin install @zsxsoft/omp-axonhub
```

Directly from GitHub (bun resolves the `owner/repo` shorthand):

```sh
omp plugin install zsxsoft/omp-axonhub
```

For local development, link a checkout instead:

```sh
omp plugin link /path/to/omp-axonhub
```

Or copy `index.ts`, `discovery.ts`, and `settings.ts` into `~/.omp/agent/extensions/axonhub/` — omp loads extension directories directly, no package install required.

## Configure

Two ways to point omp at a gateway; the environment wins when both are set.

**Environment variables** (omp loads a project `.env` automatically, so a repo can point at its own gateway):

```sh
AXONHUB_BASE_URL=https://axonhub.example.com
AXONHUB_API_KEY=ah-...
```

**Interactive login**:

```
/login axonhub
```

Prompts for the base URL (Enter keeps the current one) and API key, verifies both against `/v1/models` before saving, stores the key in omp's credential database, and writes the URL to `~/.omp/agent/axonhub.json`. A successful login re-runs model discovery immediately — no restart needed.

With neither configured the gateway defaults to `http://localhost:8090` and discovery returns no models until a key exists.

## Refreshing the model list

The plugin only implements `fetchDynamicModels`; omp decides when to call it:

- `/model` opens the model hub → select `axonhub` in the provider sidebar → press **F5** to force a re-fetch.
- `/login axonhub` again — a successful login re-runs discovery for the provider.
- Selecting the provider in the hub auto-refreshes once per process.
- Discovery results are cached in `~/.omp/agent/models.db` with a ~2 hour TTL; delete that file (or the axonhub rows) to force a cold fetch on next start.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AXONHUB_BASE_URL` | Gateway root, e.g. `https://axonhub.example.com` (a trailing `/v1` is stripped) |
| `AXONHUB_API_KEY` | API key; when set, it overrides the `/login` credential |
| `AXONHUB_NO_MODELS_DEV` | `1`/`true` disables models.dev enrichment |
| `AXONHUB_INCLUDE_NON_CHAT` | `1`/`true` keeps embedding/speech/image models in the list |
| `AXONHUB_WEB_SEARCH` | `1`/`true` adds the provider-side `web_search` tool to `gpt-*` requests |

## License

MIT
