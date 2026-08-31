import type { Plugin } from "@opencode-ai/plugin";
import type { Decision, Endpoint, PluginOptions, RoleConfig, RouterConfig, RouterState } from "./types.js";
import { buildConfig } from "./config.js";
import { isWarm, loadState, persistDecision, saveState, touch } from "./state.js";
import { familyOf, fetchEndpoints, fetchModels, providerSlug, resolveApiKey } from "./openrouter.js";
import { pickBest, shouldSwitch } from "./scorer.js";

interface RoleMatch {
  roleName: string;
  role: RoleConfig;
}

function findRole(config: RouterConfig, modelId: string): RoleMatch | null {
  for (const [roleName, role] of Object.entries(config.roles)) {
    if (role.models.some((candidate) => candidate === modelId)) {
      return { roleName, role };
    }
  }
  return null;
}

function findDecision(state: RouterState, modelId: string): Decision | undefined {
  const suffix = `|${modelId}`;
  const entry = Object.entries(state.decisions).find(([key]) => key.endsWith(suffix));
  return entry ? entry[1] : undefined;
}

type LogLevel = "debug" | "info" | "error" | "warn";

function resolveModelId(model: { id: string; providerID: string; modelID?: string }): string {
  const raw = model.modelID ?? model.id;
  let id = raw.replace(/^~+/, "");
  const prefix = `${model.providerID}/`;
  if (id.startsWith(prefix)) {
    id = id.slice(prefix.length);
  }
  return id;
}

export const SmartRouterPlugin: Plugin = async (ctx, pluginOptions: PluginOptions = {}) => {
  const config = buildConfig(pluginOptions);
  const state: RouterState = loadState(config.statePath);
  const apiKey = resolveApiKey(pluginOptions);

  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    const body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> } = {
      service: "opencode-smart-router",
      level,
      message,
    };
    if (extra) {
      body.extra = extra;
    }
    try {
      void ctx.client?.app?.log?.({ body });
    } catch {
      // logging must never break the request path
    }
  };

  const refreshScoreCache = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - state.scoreCache.fetchedAt < config.scoreCacheMs) {
      return true;
    }
    try {
      const models = await fetchModels({ contextMin: config.thresholds.contextMin, apiKey });
      const endpoints: Record<string, Endpoint[]> = {};
      for (const role of Object.values(config.roles)) {
        for (const modelId of role.models) {
          try {
            endpoints[modelId] = await fetchEndpoints({ modelId, apiKey });
          } catch (error) {
            log("warn", "failed to fetch endpoints for model", { modelId, error: String(error) });
          }
        }
      }
      state.scoreCache = { fetchedAt: Date.now(), models, endpoints };
      saveStateSafe();
      return true;
    } catch (error) {
      log("warn", "failed to refresh score cache", { error: String(error) });
      return false;
    }
  };

  const saveStateSafe = (): void => {
    try {
      saveState(config.statePath, state);
    } catch (error) {
      log("warn", "failed to persist state", { error: String(error) });
    }
  };

  const evaluateModel = (modelId: string, roleName: string, role: RoleConfig): void => {
    const endpoints = state.scoreCache.endpoints[modelId] ?? [];
    const existing = findDecision(state, modelId);
    if (endpoints.length === 0) {
      log("warn", "no endpoints cached for model; keeping current decision", { modelId });
      return;
    }
    const { best, steps } = pickBest(
      endpoints,
      role,
      config.thresholds,
      config.weights,
      config.quantLadder,
      config.minUptime,
    );
    if (!best) {
      log("warn", "no candidate after relaxation chain; keeping current decision", { modelId, role: roleName, steps });
      return;
    }
    if (existing) {
      if (shouldSwitch(existing.score, best.score, config.switchMargin)) {
        const decision: Decision = {
          provider: providerSlug(best.endpoint),
          score: best.score,
          decidedAt: Date.now(),
          lastSeen: Date.now(),
          role: roleName,
        };
        persistDecision(state, modelId, decision);
        saveStateSafe();
        log("info", "switched provider", { modelId, from: existing.provider, to: decision.provider, score: decision.score });
      } else {
        const updated = touch(existing, Date.now());
        persistDecision(state, modelId, updated);
        saveStateSafe();
      }
    } else {
      const decision: Decision = {
        provider: providerSlug(best.endpoint),
        score: best.score,
        decidedAt: Date.now(),
        lastSeen: Date.now(),
        role: roleName,
      };
      persistDecision(state, modelId, decision);
      saveStateSafe();
      log("info", "established provider decision", { modelId, provider: decision.provider, score: decision.score });
    }
  };

  return {
    "chat.params": async (input, output) => {
      try {
        if (input.model.providerID !== config.providerID) {
          return;
        }
        const modelId = resolveModelId(input.model);
        const match = findRole(config, modelId);
        if (!match) {
          return;
        }
        const existing = findDecision(state, modelId);
        const now = Date.now();
        if (existing) {
          const ttlMs = config.ttl[familyOf(existing.provider, config.ttl)] ?? config.ttl.default ?? 600000;
          const warm = isWarm(existing, ttlMs, now);
          persistDecision(state, modelId, touch(existing, now));
          saveStateSafe();
          if (warm) {
            output.options.provider = { order: [existing.provider], allow_fallbacks: config.allowFallbacks };
            return;
          }
          await refreshScoreCache();
          evaluateModel(modelId, match.roleName, match.role);
        } else {
          await refreshScoreCache();
          evaluateModel(modelId, match.roleName, match.role);
        }
        const after = findDecision(state, modelId);
        if (after) {
          output.options.provider = { order: [after.provider], allow_fallbacks: config.allowFallbacks };
        } else {
          log("warn", "no decision available; leaving provider unset for default routing", { modelId });
        }
      } catch (error) {
        log("warn", "chat.params handler failed", { error: String(error) });
      }
    },
    event: async ({ event }) => {
      try {
        if (event?.type === "session.created") {
          void (async () => {
            try {
              await refreshScoreCache();
              for (const [roleName, role] of Object.entries(config.roles)) {
                for (const modelId of role.models) {
                  evaluateModel(modelId, roleName, role);
                }
              }
            } catch (error) {
              log("warn", "async re-evaluation failed", { error: String(error) });
            }
          })();
        }
      } catch (error) {
        log("warn", "event handler failed", { error: String(error) });
      }
    },
  };
};