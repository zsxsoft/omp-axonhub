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
  // An empty env value reads as "not set"; without the fallback every fetch
  // would fail on a URL parse error.
  const envRoot = process.env[BASE_URL_ENV]?.trim();
  return normalizeRoot(envRoot || readStoredBaseUrl(agentDir) || DEFAULT_ROOT);
}

/**
 * Guard against credential theft through a repo-controlled `.env`.
 *
 * omp merges a project's `.env` into `process.env`, so a repository can point
 * `AXONHUB_BASE_URL` anywhere. When the URL comes from the environment but the
 * key does not, the resolved credential may be the `/login` key issued for a
 * different gateway — sending it there would leak it. Refuse unless the env
 * URL matches the gateway the stored credential was issued for.
 */
function assertEnvUrlHasOwnKey(agentDir: string): void {
  const envRoot = process.env[BASE_URL_ENV]?.trim();
  if (!envRoot || process.env[API_KEY_ENV]) return;
  if (normalizeRoot(envRoot) === readStoredBaseUrl(agentDir)) return;
  throw new Error(
    `axonhub: ${BASE_URL_ENV} is set without ${API_KEY_ENV}; ` +
      `refusing to send the /login credential to ${envRoot}`,
  );
}

/**
 * Ask for the gateway and an API key, verify them together, and persist the
 * gateway. Verifying before returning means a typo in either field surfaces
 * here instead of as an empty model list later.
 *
 * The gateway is mutated in place because the host re-runs discovery for this
 * provider immediately after a successful login, so a new URL takes effect
 * without a restart.
 *
 * `onAuth` is emitted before the first prompt: in RPC mode the host rejects
 * `onPrompt` until an auth info has been emitted, so a prompt-first login can
 * never work headlessly. Built-in key-paste logins (e.g. Alibaba Coding Plan)
 * do the same.
 */
async function login(gateway: { root: string }, agentDir: string, callbacks: OAuthLoginCallbacks): Promise<string> {
  callbacks.onAuth({
    url: gateway.root,
    instructions: "Paste an AxonHub API key for this gateway",
  });
  const enteredUrl = (
    await callbacks.onPrompt({
      message: `AxonHub base URL (Enter keeps ${gateway.root})`,
      placeholder: "https://axonhub.example.com",
    })
  ).trim();
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");
  const root = enteredUrl ? normalizeRoot(enteredUrl) : gateway.root;

  const key = (
    await callbacks.onPrompt({
      message: `AxonHub API key for ${root}`,
      placeholder: "ah-...",
    })
  ).trim();
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");
  if (!key) throw new Error("No AxonHub API key entered");

  // Bounded probe: the host's cancel signal plus a local timeout, through the
  // host's fetch (custom CA aware), so a stalled gateway can't hold /login
  // open and Esc still aborts it.
  const probe = callbacks.fetch ?? fetch;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, timeoutSignal]) : timeoutSignal;
  const response = await probe(`${root}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!response.ok) {
    throw new Error(`AxonHub at ${root} rejected the key: ${response.status} ${response.statusText}`);
  }
  // A reverse proxy can answer an unknown path with a 200 HTML page; only a
  // JSON body proves the key really reached AxonHub.
  try {
    await response.json();
  } catch {
    throw new Error(`AxonHub at ${root} did not return a model list (not an AxonHub endpoint?)`);
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
    // No provider-level baseUrl: omp treats it as an override that would
    // clobber each model's own baseUrl, breaking the multi-protocol routing
    // in routeFor. Every discovered model carries its own baseUrl instead.
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
      assertEnvUrlHasOwnKey(agentDir);
      // Throw rather than return []: an empty list is authoritative and would
      // wipe the cached catalog, while a failed discovery keeps it.
      if (!apiKey) {
        throw new Error(`axonhub: no API key — set ${API_KEY_ENV} or run /login axonhub`);
      }
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
