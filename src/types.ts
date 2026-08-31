export interface Thresholds {
  contextMin: number;
  tpsMin: number;
  percentile: "p50" | "p75" | "p90" | "p99";
  latencyMax: number;
}

export interface Weights {
  cost: number;
  tps: number;
  latency: number;
  quantization: number;
}

export interface QuantLadder {
  [quant: string]: number;
}

export interface RoleConfig {
  models: string[];
  quantFloor: string;
  allowQuantRelax: boolean;
  allowContextRelax: boolean;
  requireCaching: boolean;
  allowFree: boolean;
  allowBatch: boolean;
}

export interface RouterConfig {
  providerID: string;
  statePath: string;
  scoreCacheMs: number;
  switchMargin: number;
  allowFallbacks: boolean;
  minUptime: number;
  ttl: Record<string, number>;
  thresholds: Thresholds;
  weights: Weights;
  quantLadder: QuantLadder;
  roles: Record<string, RoleConfig>;
}

export interface PluginOptions {
  providerID?: string;
  statePath?: string;
  scoreCacheMs?: number;
  switchMargin?: number;
  allowFallbacks?: boolean;
  minUptime?: number;
  apiKey?: string;
  ttl?: Record<string, number>;
  thresholds?: Partial<Thresholds>;
  weights?: Partial<Weights>;
  quantLadder?: QuantLadder;
  roles?: Record<string, Partial<RoleConfig>>;
}

export interface Decision {
  provider: string;
  score: number;
  decidedAt: number;
  lastSeen: number;
  role: string;
}

export interface LatencyStats {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
}

export interface EndpointPricing {
  prompt?: string;
  completion?: string;
  request?: string;
}

export interface Endpoint {
  provider_name: string;
  tag?: string;
  name?: string;
  model_id?: string;
  context_length: number;
  quantization?: string;
  throughput_last_30m: LatencyStats | null;
  latency_last_30m: LatencyStats | null;
  pricing: EndpointPricing;
  supported_parameters: string[];
  supports_tool_choice: Record<string, boolean> | null;
  supports_implicit_caching: boolean;
  status?: number;
  uptime_last_5m?: number;
  uptime_last_30m?: number;
  uptime_last_1d?: number;
}

export interface ModelInfo {
  id: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  alias_target?: string | null;
}

export interface RouterState {
  decisions: Record<string, Decision>;
  scoreCache: {
    fetchedAt: number;
    models: ModelInfo[] | null;
    endpoints: Record<string, Endpoint[]>;
  };
}