import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Endpoint, ModelInfo } from "./types.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/{modelId}/endpoints";
const DEFAULT_TIMEOUT_MS = 10000;

interface OpenRouterListResponse {
  data: ModelInfo[];
}

interface OpenRouterEndpointsResponse {
  data: {
    id?: string;
    endpoints?: Endpoint[];
    [key: string]: unknown;
  };
}

export function resolveApiKey(options: { apiKey?: string } = {}): string | undefined {
  if (options.apiKey) {
    return options.apiKey;
  }
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) {
      return undefined;
    }
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const entry = auth?.openrouter as { type?: string; key?: string } | undefined;
    if (entry && typeof entry.key === "string" && entry.key.length > 0) {
      return entry.key;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function requestJson(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
  fetcher: typeof globalThis.fetch,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as unknown;
}

export async function fetchModels(options: {
  contextMin: number;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<ModelInfo[]> {
  const url = `${MODELS_URL}?context=${options.contextMin}&supported_parameters=tools`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const body = (await requestJson(url, options.apiKey, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetcher)) as OpenRouterListResponse;
  return Array.isArray(body?.data) ? body.data : [];
}

export async function fetchEndpoints(options: {
  modelId: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<Endpoint[]> {
  const url = ENDPOINTS_URL.replace("{modelId}", options.modelId);
  const fetcher = options.fetch ?? globalThis.fetch;
  const body = (await requestJson(url, options.apiKey, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetcher)) as OpenRouterEndpointsResponse;
  return Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
}

export function providerSlug(endpoint: Endpoint): string {
  if (endpoint.tag) {
    return endpoint.tag;
  }
  return endpoint.provider_name.toLowerCase().replace(/\s+/g, "-");
}

export function familyOf(provider: string, ttl: Record<string, number>): string {
  const token = (provider.split(/[/\s]/)[0] || provider).toLowerCase();
  const families = Object.keys(ttl).filter((key) => key !== "default");
  const match = families.find((family) => token.startsWith(family) || family.startsWith(token));
  return match ?? "default";
}