import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, RouterState } from "./types.js";

export function emptyState(): RouterState {
  return {
    decisions: {},
    scoreCache: {
      fetchedAt: 0,
      models: null,
      endpoints: {},
    },
  };
}

export function loadState(path: string): RouterState {
  try {
    if (!existsSync(path)) {
      return emptyState();
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RouterState>;
    const base = emptyState();
    return {
      decisions:
        raw.decisions && typeof raw.decisions === "object" && !Array.isArray(raw.decisions)
          ? raw.decisions
          : base.decisions,
      scoreCache: {
        fetchedAt: typeof raw.scoreCache?.fetchedAt === "number" ? raw.scoreCache.fetchedAt : base.scoreCache.fetchedAt,
        models: raw.scoreCache?.models ?? base.scoreCache.models,
        endpoints:
          raw.scoreCache?.endpoints && typeof raw.scoreCache.endpoints === "object"
            ? raw.scoreCache.endpoints
            : base.scoreCache.endpoints,
      },
    };
  } catch {
    return emptyState();
  }
}

export function saveState(path: string, state: RouterState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state), "utf8");
  renameSync(tmpPath, path);
}

export function isWarm(decision: Decision | undefined, ttlMs: number, now: number): boolean {
  if (!decision) {
    return false;
  }
  if (ttlMs <= 0) {
    return false;
  }
  return now - decision.lastSeen < ttlMs;
}

export function touch(decision: Decision, now: number): Decision {
  return { ...decision, lastSeen: now };
}

export function updateDecision(state: RouterState, key: string, decision: Decision): void {
  state.decisions[key] = decision;
}

export function persistDecision(state: RouterState, modelId: string, decision: Decision): void {
  const suffix = `|${modelId}`;
  for (const key of Object.keys(state.decisions)) {
    if (key.endsWith(suffix)) {
      delete state.decisions[key];
    }
  }
  updateDecision(state, `${decision.provider}|${modelId}`, decision);
}