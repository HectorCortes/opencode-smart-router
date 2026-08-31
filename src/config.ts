import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginOptions, RouterConfig } from "./types.js";

function defaultStatePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-smart-router", "state.json");
}

export const DEFAULT_CONFIG: RouterConfig = {
  providerID: "openrouter",
  statePath: defaultStatePath(),
  scoreCacheMs: 300000,
  switchMargin: 0.1,
  allowFallbacks: true,
  minUptime: 90,
  ttl: {
    anthropic: 300000,
    openai: 600000,
    deepseek: 7200000,
    google: 1200000,
    default: 600000,
  },
  thresholds: {
    contextMin: 500000,
    tpsMin: 25,
    percentile: "p90",
    latencyMax: 6,
  },
  weights: {
    cost: 50,
    tps: 30,
    latency: 10,
    quantization: 10,
  },
  quantLadder: {
    int4: 0.1,
    int8: 0.3,
    fp8: 0.5,
    fp16: 0.7,
    bf16: 0.85,
    fp32: 1.0,
    unknown: 0,
  },
  roles: {
    critical: {
      models: ["openai/gpt-5.6-luna"],
      quantFloor: "fp8",
      allowQuantRelax: false,
      allowContextRelax: true,
      requireCaching: true,
      allowFree: false,
      allowBatch: false,
    },
    chat: {
      models: ["anthropic/claude-sonnet-4.6"],
      quantFloor: "fp8",
      allowQuantRelax: true,
      allowContextRelax: true,
      requireCaching: true,
      allowFree: false,
      allowBatch: false,
    },
    cheap: {
      models: ["deepseek/deepseek-v4-flash"],
      quantFloor: "fp8",
      allowQuantRelax: true,
      allowContextRelax: true,
      requireCaching: true,
      allowFree: false,
      allowBatch: false,
    },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
      const overrideValue = override[key];
      out[key] = overrideValue === undefined ? base[key] : deepMerge(base[key], overrideValue);
    }
    return out;
  }
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? override : base;
  }
  if (override === undefined) {
    return base;
  }
  return override;
}

export function buildConfig(options: PluginOptions): RouterConfig {
  return deepMerge(DEFAULT_CONFIG, options) as RouterConfig;
}