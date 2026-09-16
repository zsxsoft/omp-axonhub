/**
 * omp extension registering AxonHub as the `axonhub` model provider.
 *
 * The gateway can be configured two ways: `AXONHUB_BASE_URL` plus
 * `AXONHUB_API_KEY` in the environment (omp loads a project `.env`
 * automatically, so a repository can point at its own gateway), or
 * `/login axonhub`, which asks for both and stores the key in omp's
 * credential database. The environment wins when both are present.
 */

import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, type ProviderModelConfig, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { discoverModels, normalizeRoot } from "./discovery";
import { readStoredBaseUrl, writeStoredBaseUrl } from "./settings";

const PROVIDER_ID = "axonhub";
const DEFAULT_ROOT = "http://localhost:8090";
const API_KEY_ENV = "AXONHUB_API_KEY";
const BASE_URL_ENV = "AXONHUB_BASE_URL";

/** Flags are opt-in: only an explicit truthy value enables them. */
function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function resolveRoot(agentDir: string): string {
  return normalizeRoot(process.env[BASE_URL_ENV] ?? readStoredBaseUrl(agentDir) ?? DEFAULT_ROOT);
}

/**
 * Ask for the gateway and an API key, verify them together, and persist the
 * gateway. Verifying before returning means a typo in either field surfaces
 * here instead of as an empty model list later.
 *
 * The gateway is mutated in place because the host re-runs discovery for this
 * provider immediately after a successful login, so a new URL takes effect
 * without a restart.
 */
async function login(gateway: { root: string }, agentDir: string, callbacks: OAuthLoginCallbacks): Promise<string> {
  const enteredUrl = (
    await callbacks.onPrompt({
      message: `AxonHub base URL (Enter keeps ${gateway.root})`,
      placeholder: "https://axonhub.example.com",
    })
  ).trim();
  const root = enteredUrl ? normalizeRoot(enteredUrl) : gateway.root;

  const key = (
    await callbacks.onPrompt({
      message: `AxonHub API key for ${root}`,
      placeholder: "ah-...",
    })
  ).trim();
  if (!key) throw new Error("No AxonHub API key entered");

  const response = await fetch(`${root}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) {
    throw new Error(`AxonHub at ${root} rejected the key: ${response.status} ${response.statusText}`);
  }

  writeStoredBaseUrl(agentDir, root);
  gateway.root = root;
  return key;
}

/**
 * Add OpenAI's provider-side `web_search` tool to GPT requests.
 *
 * Off by default: omp ships its own web search, and the provider-side tool is
 * billed separately by the upstream.
 */
function registerWebSearchInjection(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID || !model.id.startsWith("gpt-")) return;

    const payload = event.payload as { tools?: { type: string }[] } | undefined;
    if (!payload) return;
    if (payload.tools?.some(tool => tool.type === "web_search")) return;

    return { ...payload, tools: [...(payload.tools ?? []), { type: "web_search" }] };
  });
}

export default function axonhub(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const gateway = { root: resolveRoot(agentDir) };
  const enrich = !isEnabled(process.env.AXONHUB_NO_MODELS_DEV);
  const includeNonChat = isEnabled(process.env.AXONHUB_INCLUDE_NON_CHAT);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: `${gateway.root}/v1`,
    api: "openai-completions",
    // The variable *name* is passed so omp resolves it at request time. A
    // literal naming no existing variable would be stored as the key itself
    // and would outrank the credential saved by `/login`.
    apiKey: process.env[API_KEY_ENV] ? API_KEY_ENV : undefined,
    oauth: {
      name: "AxonHub",
      login: callbacks => login(gateway, agentDir, callbacks),
    },
    fetchDynamicModels: async apiKey => {
      if (!apiKey) return [];
      const models = await discoverModels({
        root: gateway.root,
        apiKey,
        enrich,
        includeNonChat,
        warn: message => pi.logger.warn(message),
      });
      // Sparse definitions are intentional; see AxonHubModelConfig.
      return models as ProviderModelConfig[];
    },
  });

  if (isEnabled(process.env.AXONHUB_WEB_SEARCH)) registerWebSearchInjection(pi);
}
