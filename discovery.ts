/**
 * AxonHub model discovery.
 *
 * AxonHub is a multi-protocol gateway. `/v1` accepts OpenAI chat-completions
 * and responses, `/anthropic` accepts Anthropic messages, and `/gemini/v1beta`
 * accepts Gemini generateContent. Which inbound endpoint serves a model is
 * independent of the upstream channel that model is routed to, so `owned_by` is
 * not a routing signal: it names the upstream channel type and is routinely
 * mismatched, as a gateway may serve Grok models through a channel labelled
 * `anthropic`. Routing keys on the model id instead.
 *
 * Metadata is deliberately sparse. AxonHub reports pricing, limits, and
 * capabilities only for models configured by hand; the rest arrive as a bare
 * id. Every field AxonHub omits is left undefined so omp fills it from its
 * bundled catalog, which is also the only source of `thinking` and `compat`
 * metadata. Filling a default here would mask that catalog.
 */

import type { Api } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Budget for the models.dev lookup. The host caps all discovery at 15s. */
const ENRICH_TIMEOUT_MS = 6000;

/** A model as reported by AxonHub. Only `id` is dependable. */
export interface AxonHubModel {
  id?: string;
  name?: string;
  owned_by?: string;
  /** `chat`, `image_generation`, ... Absent when AxonHub holds no metadata. */
  type?: string;
  context_length?: number;
  max_output_tokens?: number;
  modalities?: { input?: string[]; output?: string[] };
  capabilities?: { vision?: boolean; tool_call?: boolean; reasoning?: boolean };
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    /** Only `per_1m_tokens` matches omp's cost unit; other units are ignored. */
    unit?: string;
  };
}

export interface AxonHubModelsResponse {
  data?: AxonHubModel[];
}

/** The subset of a models.dev entry that can stand in for missing AxonHub metadata. */
export interface ModelsDevModel {
  reasoning?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

export type ModelsDevResponse = Record<string, { models?: Record<string, ModelsDevModel & { id?: string }> }>;

/**
 * A model definition for `registerProvider`.
 *
 * omp accepts a sparse definition at runtime — `CustomModelDefinitionLike` is
 * fully optional and `finalizeCustomModel` fills the gaps from the bundled
 * catalog — and honours a per-model `baseUrl`. The published
 * `ProviderModelConfig` expresses neither, so the fields omp can supply itself
 * are relaxed and `baseUrl` is restored.
 */
export type AxonHubModelConfig = Omit<
  ProviderModelConfig,
  "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
> &
  Partial<Pick<ProviderModelConfig, "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">> & {
    baseUrl?: string;
  };

export interface DiscoveryOptions {
  /** Gateway root without a protocol path, e.g. `https://axonhub.example.com`. */
  root: string;
  apiKey: string;
  /** Consult models.dev for models AxonHub reports without metadata. */
  enrich: boolean;
  /** Keep embedding, speech, and image models that omp cannot drive as chat. */
  includeNonChat: boolean;
  enrichTimeoutMs?: number;
  warn?: (message: string) => void;
}

/** Strip a trailing `/v1` and slashes so protocol paths can be appended. */
export function normalizeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/**
 * Ids naming an embedding, rerank, speech, image, video, or moderation model
 * rather than a chat model. AxonHub often reports bare ids with no `type` or
 * `modalities`, so this list is the only filter for them.
 */
const NON_CHAT_ID =
  /embedding|rerank|(^|[-/])bge-|whisper|sensevoice|gpt-image|imagine-image|(^|[-/:])tts|dall-e|sora|(^|[-/])veo|imagen|moderation|stable-diffusion|(^|[-/])flux|kokoro/i;

/** Whether a model can serve chat completions, which is all omp drives. */
export function isChatModel(model: AxonHubModel): boolean {
  // `type: null` and absent `type` both mean "AxonHub holds no metadata".
  if (model.type != null && model.type !== "chat") return false;
  const output = model.modalities?.output;
  if (Array.isArray(output) && !output.includes("text")) return false;
  return !NON_CHAT_ID.test(model.id ?? "");
}

/** Endpoint and wire protocol for a model id, given the gateway root. */
export function routeFor(id: string, root: string): { api: Api; baseUrl: string } {
  if (/claude/i.test(id)) return { api: "anthropic-messages", baseUrl: `${root}/anthropic` };
  if (/gemini/i.test(id)) return { api: "google-generative-ai", baseUrl: `${root}/gemini/v1beta` };
  if (/^gpt-|codex/i.test(id)) return { api: "openai-responses", baseUrl: `${root}/v1` };
  return { api: "openai-completions", baseUrl: `${root}/v1` };
}

/**
 * Merge the plain and detailed model responses by id, later fields winning.
 * The plain list can carry ids the detailed list omits, and the detailed list
 * carries the metadata, so both are needed.
 */
export function mergeModels(responses: readonly AxonHubModelsResponse[]): AxonHubModel[] {
  const byId = new Map<string, AxonHubModel>();
  for (const response of responses) {
    for (const model of response.data ?? []) {
      if (!model.id) continue;
      byId.set(model.id, { ...byId.get(model.id), ...model });
    }
  }
  return [...byId.values()];
}

/**
 * Text and image inputs declared by AxonHub, or undefined when it declares
 * neither. `capabilities.vision` and `modalities.input` can disagree (a
 * multimodal model may report `vision: false` while listing an image
 * modality), so either one claiming images is enough.
 */
function inputsFor(model: AxonHubModel): ("text" | "image")[] | undefined {
  const declared = model.modalities?.input;
  const vision = model.capabilities?.vision;
  if (declared === undefined && vision === undefined) return undefined;
  return declared?.includes("image") || vision === true ? ["text", "image"] : ["text"];
}

/** Cost per million tokens, or undefined when AxonHub reports none in omp's unit. */
function costFor(model: AxonHubModel): ProviderModelConfig["cost"] | undefined {
  const pricing = model.pricing;
  if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") return undefined;
  if (pricing.unit !== undefined && pricing.unit !== "per_1m_tokens") return undefined;
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cache_read ?? 0,
    cacheWrite: pricing.cache_write ?? 0,
  };
}

function inputsFromModelsDev(entry: ModelsDevModel | undefined): ("text" | "image")[] | undefined {
  if (!entry) return undefined;
  const declared = entry.modalities?.input;
  if (declared === undefined && entry.attachment === undefined) return undefined;
  return declared?.includes("image") || entry.attachment === true ? ["text", "image"] : ["text"];
}

function costFromModelsDev(entry: ModelsDevModel | undefined): ProviderModelConfig["cost"] | undefined {
  const cost = entry?.cost;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return undefined;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0,
  };
}

/**
 * Map one AxonHub model onto an omp model definition.
 *
 * `thinking` and `compat` are never set: omp's bundled catalog is the only
 * source for them, and anything set here would override it.
 */
export function toProviderModel(
  model: AxonHubModel,
  root: string,
  enrichment?: ModelsDevModel,
): AxonHubModelConfig | undefined {
  if (!model.id) return undefined;
  const { api, baseUrl } = routeFor(model.id, root);
  return {
    id: model.id,
    api,
    baseUrl,
    name: model.name,
    reasoning: model.capabilities?.reasoning ?? enrichment?.reasoning,
    input: inputsFor(model) ?? inputsFromModelsDev(enrichment),
    cost: costFor(model) ?? costFromModelsDev(enrichment),
    contextWindow: model.context_length ?? enrichment?.limit?.context,
    maxTokens: model.max_output_tokens ?? enrichment?.limit?.output,
  };
}

/** Index models.dev by model id; the first provider declaring an id wins. */
export function indexModelsDev(payload: ModelsDevResponse): Map<string, ModelsDevModel> {
  const index = new Map<string, ModelsDevModel>();
  for (const provider of Object.values(payload)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      for (const id of new Set([key, model.id].filter((value): value is string => typeof value === "string"))) {
        if (!index.has(id)) index.set(id, model);
      }
    }
  }
  return index;
}

/** Whether models.dev could supply a field AxonHub left out. */
function needsEnrichment(model: AxonHubModel): boolean {
  return (
    model.context_length === undefined ||
    model.max_output_tokens === undefined ||
    model.capabilities?.reasoning === undefined ||
    costFor(model) === undefined ||
    inputsFor(model) === undefined
  );
}

async function fetchModelsDev(timeoutMs: number): Promise<Map<string, ModelsDevModel>> {
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`models.dev returned ${response.status} ${response.statusText}`);
  return indexModelsDev((await response.json()) as ModelsDevResponse);
}

/**
 * models.dev index, fetched only when a model actually lacks fields it could
 * supply. A failed lookup is not fatal: those fields stay undefined and omp
 * falls back to its bundled catalog.
 */
async function enrichmentFor(
  models: readonly AxonHubModel[],
  timeoutMs: number,
  warn: ((message: string) => void) | undefined,
): Promise<Map<string, ModelsDevModel> | undefined> {
  if (!models.some(needsEnrichment)) return undefined;
  try {
    return await fetchModelsDev(timeoutMs);
  } catch (error) {
    warn?.(`axonhub: models.dev lookup failed, falling back to omp's bundled catalog (${error})`);
    return undefined;
  }
}

function describeOutcome(outcome: PromiseSettledResult<Response>): string {
  return outcome.status === "fulfilled" ? String(outcome.value.status) : String(outcome.reason);
}

/**
 * Both model endpoints, each tolerated to fail on its own.
 *
 * A 200 response is not necessarily JSON: a gateway behind a reverse proxy or
 * web UI can answer an unrecognised path with HTML, and an older AxonHub may
 * not know `?include=all`. Such a response is skipped instead of discarding
 * what the other endpoint returned. Only a total failure throws, so the host
 * keeps its cached model list rather than dropping every AxonHub model on a
 * transient outage.
 */
async function fetchAxonHubModels(root: string, apiKey: string): Promise<AxonHubModelsResponse[]> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const outcomes = await Promise.allSettled([
    fetch(`${root}/v1/models`, { headers }),
    fetch(`${root}/v1/models?include=all`, { headers }),
  ]);

  const payloads: AxonHubModelsResponse[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "fulfilled" || !outcome.value.ok) continue;
    try {
      const payload = (await outcome.value.json()) as AxonHubModelsResponse;
      if (Array.isArray(payload.data)) payloads.push(payload);
    } catch {
      // Not JSON. The other endpoint may still carry the catalog.
    }
  }
  if (payloads.length === 0) {
    const [basic, detailed] = outcomes;
    throw new Error(
      `AxonHub model discovery failed: /v1/models ${describeOutcome(basic!)}, ` +
        `?include=all ${describeOutcome(detailed!)}`,
    );
  }
  return payloads;
}

export async function discoverModels(options: DiscoveryOptions): Promise<AxonHubModelConfig[]> {
  const models = mergeModels(await fetchAxonHubModels(options.root, options.apiKey));
  const usable = options.includeNonChat ? models : models.filter(isChatModel);
  const enrichment = options.enrich
    ? await enrichmentFor(usable, options.enrichTimeoutMs ?? ENRICH_TIMEOUT_MS, options.warn)
    : undefined;

  const configs: AxonHubModelConfig[] = [];
  for (const model of usable) {
    const config = toProviderModel(model, options.root, model.id ? enrichment?.get(model.id) : undefined);
    if (config) configs.push(config);
  }
  return configs;
}
