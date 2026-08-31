import type { Endpoint, QuantLadder, RoleConfig, Thresholds, Weights } from "./types.js";
import { meetsQuantFloor, quantScore } from "./quant.js";

export interface ActiveFilters {
  requireCaching: boolean;
  quantFloorActive: boolean;
  contextMin: number;
  percentile: "p50" | "p75" | "p90" | "p99";
  tpsMin: number;
  latencyMax: number;
}

export interface ScoredCandidate {
  endpoint: Endpoint;
  score: number;
  costNorm: number;
  tpsNorm: number;
  latencyNorm: number;
  quantNorm: number;
}

export interface PickResult {
  best: ScoredCandidate | null;
  steps: string[];
}

export const RELAX_STEPS = [
  "drop caching requirement",
  "drop quantization floor",
  "lower context floor to 128000",
  "switch latency percentile to p50",
  "switch throughput percentile to p50",
] as const;

export function initialActive(role: RoleConfig, thresholds: Thresholds): ActiveFilters {
  return {
    requireCaching: role.requireCaching,
    quantFloorActive: true,
    contextMin: thresholds.contextMin,
    percentile: thresholds.percentile,
    tpsMin: thresholds.tpsMin,
    latencyMax: thresholds.latencyMax,
  };
}

export function applyRelaxStep(role: RoleConfig, active: ActiveFilters, step: number): string | null {
  switch (step) {
    case 0:
      active.requireCaching = false;
      return RELAX_STEPS[0];
    case 1:
      if (!role.allowQuantRelax) {
        return null;
      }
      active.quantFloorActive = false;
      return RELAX_STEPS[1];
    case 2:
      if (!role.allowContextRelax) {
        return null;
      }
      active.contextMin = 128000;
      return RELAX_STEPS[2];
    case 3:
      active.percentile = "p50";
      return RELAX_STEPS[3];
    case 4:
      active.percentile = "p50";
      return RELAX_STEPS[4];
    default:
      return null;
  }
}

function hasTools(endpoint: Endpoint): boolean {
  return (
    Array.isArray(endpoint.supported_parameters) &&
    endpoint.supported_parameters.includes("tools") &&
    endpoint.supports_tool_choice !== null &&
    typeof endpoint.supports_tool_choice === "object"
  );
}

function percentileValue(stats: Endpoint["throughput_last_30m"], percentile: string): number | undefined {
  if (!stats) {
    return undefined;
  }
  const value = stats[percentile as keyof typeof stats];
  return typeof value === "number" ? value : undefined;
}

function costPerM(endpoint: Endpoint): number {
  const prompt = parseFloat(endpoint.pricing?.prompt ?? "0");
  const completion = parseFloat(endpoint.pricing?.completion ?? "0");
  if (Number.isNaN(prompt) || Number.isNaN(completion)) {
    return 0;
  }
  return prompt + completion;
}

function isBatchVariant(endpoint: Endpoint): boolean {
  return (endpoint.model_id ?? "").endsWith(":batch");
}

function isFreeVariant(endpoint: Endpoint): boolean {
  return (endpoint.model_id ?? "").endsWith(":free");
}

export function filterCandidates(
  endpoints: Endpoint[],
  role: RoleConfig,
  active: ActiveFilters,
  quantLadder: QuantLadder,
  minUptime: number,
): Endpoint[] {
  return endpoints.filter((endpoint) => {
    if (!hasTools(endpoint)) {
      return false;
    }
    if (endpoint.context_length < active.contextMin) {
      return false;
    }
    if (active.quantFloorActive && !meetsQuantFloor(quantLadder, role.quantFloor, endpoint.quantization)) {
      return false;
    }
    const tps = percentileValue(endpoint.throughput_last_30m, active.percentile);
    if (tps === undefined || tps < active.tpsMin) {
      return false;
    }
    const latency = percentileValue(endpoint.latency_last_30m, active.percentile);
    if (latency === undefined || latency > active.latencyMax) {
      return false;
    }
    if (active.requireCaching && endpoint.supports_implicit_caching !== true) {
      return false;
    }
    if (isBatchVariant(endpoint) && !role.allowBatch) {
      return false;
    }
    if (isFreeVariant(endpoint) && !role.allowFree) {
      return false;
    }
    if (endpoint.status !== 0) {
      return false;
    }
    if (typeof endpoint.uptime_last_5m !== "number" || endpoint.uptime_last_5m < minUptime) {
      return false;
    }
    return true;
  });
}

export function scoreCandidates(
  endpoints: Endpoint[],
  active: ActiveFilters,
  weights: Weights,
  quantLadder: QuantLadder,
): ScoredCandidate[] {
  if (endpoints.length === 0) {
    return [];
  }
  const costs = endpoints.map(costPerM);
  const tpss = endpoints.map((endpoint) => percentileValue(endpoint.throughput_last_30m, active.percentile) ?? 0);
  const latencies = endpoints.map((endpoint) => percentileValue(endpoint.latency_last_30m, active.percentile) ?? 0);
  const minCost = Math.min(...costs);
  const maxTps = Math.max(...tpss);
  const positiveLatencies = latencies.filter((value) => value > 0);
  const minLatency = positiveLatencies.length > 0 ? Math.min(...positiveLatencies) : 0;
  const weightSum = weights.cost + weights.tps + weights.latency + weights.quantization;
  if (weightSum <= 0) {
    return [];
  }
  return endpoints.map((endpoint, index) => {
    const cost = costs[index] ?? 0;
    const tps = tpss[index] ?? 0;
    const latency = latencies[index] ?? 0;
    const costNorm = minCost > 0 && cost > 0 ? minCost / cost : 0;
    const tpsNorm = maxTps > 0 ? tps / maxTps : 0;
    const latencyNorm = minLatency > 0 && latency > 0 ? minLatency / latency : 0;
    const quantNorm = quantScore(quantLadder, endpoint.quantization);
    const score =
      (weights.cost * costNorm +
        weights.tps * tpsNorm +
        weights.latency * latencyNorm +
        weights.quantization * quantNorm) /
      weightSum;
    return { endpoint, score, costNorm, tpsNorm, latencyNorm, quantNorm };
  });
}

export function pickBest(
  endpoints: Endpoint[],
  role: RoleConfig,
  thresholds: Thresholds,
  weights: Weights,
  quantLadder: QuantLadder,
  minUptime: number,
): PickResult {
  const steps: string[] = [];
  const active = initialActive(role, thresholds);
  for (let step = 0; step <= RELAX_STEPS.length; step++) {
    const passing = filterCandidates(endpoints, role, active, quantLadder, minUptime);
    if (passing.length > 0) {
      const scored = scoreCandidates(passing, active, weights, quantLadder);
      scored.sort((a, b) => b.score - a.score);
      return { best: scored[0] ?? null, steps };
    }
    if (step >= RELAX_STEPS.length) {
      break;
    }
    const applied = applyRelaxStep(role, active, step);
    if (applied) {
      steps.push(applied);
    }
  }
  return { best: null, steps };
}

export function shouldSwitch(currentScore: number | undefined, bestScore: number, margin: number): boolean {
  if (currentScore === undefined) {
    return true;
  }
  return bestScore >= currentScore * (1 + margin);
}