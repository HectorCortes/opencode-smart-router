import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../src/config.js";
import { QUANT_LADDER, meetsQuantFloor, rankOf } from "../src/quant.js";
import { filterCandidates, initialActive, pickBest, scoreCandidates, shouldSwitch } from "../src/scorer.js";
import type { Endpoint, RoleConfig, Thresholds, Weights } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixtures(): { deepseekEndpoints: Endpoint[]; claudeEndpoints: Endpoint[] } {
  const deepseek = JSON.parse(
    readFileSync(join(here, "fixtures", "endpoints-deepseek-v4-flash.json"), "utf8"),
  ) as { data: { endpoints: Endpoint[] } };
  const claude = JSON.parse(
    readFileSync(join(here, "fixtures", "endpoints-claude-sonnet-4.6.json"), "utf8"),
  ) as { data: { endpoints: Endpoint[] } };
  return { deepseekEndpoints: deepseek.data.endpoints, claudeEndpoints: claude.data.endpoints };
}

function endpoint(overrides: Partial<Endpoint> & { provider_name: string }): Endpoint {
  return {
    tag: overrides.provider_name.toLowerCase().replace(/\s+/g, "-"),
    context_length: 1000000,
    quantization: "fp16",
    pricing: { prompt: "1", completion: "2" },
    supported_parameters: ["tools"],
    supports_tool_choice: { auto: true, function: true, none: false, required: false },
    supports_implicit_caching: true,
    throughput_last_30m: { p50: 100, p90: 90 },
    latency_last_30m: { p50: 2, p90: 3 },
    status: 0,
    uptime_last_5m: 99,
    ...overrides,
  };
}

function role(name: keyof typeof DEFAULT_CONFIG.roles): RoleConfig {
  return { ...DEFAULT_CONFIG.roles[name] };
}

function thresholds(): Thresholds {
  return { ...DEFAULT_CONFIG.thresholds };
}

function weights(): Weights {
  return { ...DEFAULT_CONFIG.weights };
}

function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

describe("quantization ladder", () => {
  it("ranks values by insertion order", () => {
    const keys = Object.keys(QUANT_LADDER);
    assert.deepEqual(keys.map((key) => rankOf(QUANT_LADDER, key)), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(rankOf(QUANT_LADDER, "not-a-quant"), -1);
  });

  it("meetsQuantFloor accepts only rank >= floor", () => {
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "fp8"), true);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "fp16"), true);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "bf16"), true);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "fp32"), true);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "int4"), false);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "int8"), false);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp32", "bf16"), false);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", "unknown"), false);
    assert.equal(meetsQuantFloor(QUANT_LADDER, "fp8", undefined), false);
  });
});

describe("hard filters", () => {
  const r = role("cheap");
  const active = initialActive(r, thresholds());

  it("excludes fp4 and int8 while the fp8 floor is active", () => {
    const fp4 = endpoint({ provider_name: "fp4-provider", quantization: "fp4" });
    const int8 = endpoint({ provider_name: "int8-provider", quantization: "int8" });
    const fp8 = endpoint({ provider_name: "fp8-provider", quantization: "fp8" });
    const passing = filterCandidates([fp4, int8, fp8], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.deepEqual(passing.map((e) => e.provider_name), ["fp8-provider"]);
  });

  it("excludes unknown quantization while the floor is active, admits it when relaxed", () => {
    const unk = endpoint({ provider_name: "unknown-quant", quantization: "unknown" });
    assert.equal(filterCandidates([unk], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    const relaxed = { ...active, quantFloorActive: false };
    const admitted = filterCandidates([unk], r, relaxed, QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.equal(admitted.length, 1);
  });

  it("excludes endpoints with null throughput or latency", () => {
    const nullTps = endpoint({ provider_name: "null-tps", throughput_last_30m: null });
    const nullLat = endpoint({ provider_name: "null-latency", latency_last_30m: null });
    assert.equal(filterCandidates([nullTps], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    assert.equal(filterCandidates([nullLat], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
  });

  it("excludes endpoints that fail the throughput minimum", () => {
    const slow = endpoint({ provider_name: "slow", throughput_last_30m: { p50: 1, p90: 1 } });
    assert.equal(filterCandidates([slow], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
  });

  it("excludes endpoints that fail the latency maximum", () => {
    const slow = endpoint({ provider_name: "latency-slow", latency_last_30m: { p50: 60, p90: 60 } });
    assert.equal(filterCandidates([slow], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
  });

  it("excludes non-caching endpoints when caching is required, admits them when relaxed", () => {
    const noCache = endpoint({ provider_name: "no-cache", supports_implicit_caching: false });
    assert.equal(filterCandidates([noCache], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    const relaxed = { ...active, requireCaching: false };
    assert.equal(filterCandidates([noCache], r, relaxed, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 1);
  });

  it("excludes batch and free variants unless allowed", () => {
    const batch = endpoint({ provider_name: "batch-provider", model_id: "foo/bar:batch" });
    const free = endpoint({ provider_name: "free-provider", model_id: "foo/bar:free" });
    assert.equal(filterCandidates([batch], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    assert.equal(filterCandidates([free], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    const allowing = { ...r, allowBatch: true, allowFree: true };
    const admitted = filterCandidates([batch, free], allowing, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.equal(admitted.length, 2);
  });

  it("excludes unhealthy endpoints", () => {
    const down = endpoint({ provider_name: "down", status: 1 });
    const lowUptime = endpoint({ provider_name: "low-uptime", uptime_last_5m: 50 });
    const missingStatus = endpoint({ provider_name: "no-status", status: undefined });
    assert.equal(filterCandidates([down], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    assert.equal(filterCandidates([lowUptime], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    assert.equal(filterCandidates([missingStatus], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
  });

  it("excludes endpoints without tool calling support", () => {
    const noTools = endpoint({ provider_name: "no-tools", supported_parameters: ["temperature"] });
    const nullTools = endpoint({ provider_name: "null-tools", supports_tool_choice: null });
    assert.equal(filterCandidates([noTools], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
    assert.equal(filterCandidates([nullTools], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime).length, 0);
  });

  it("returns an empty list for no candidates", () => {
    assert.deepEqual(filterCandidates([], r, active, QUANT_LADDER, DEFAULT_CONFIG.minUptime), []);
  });
});

describe("score weighting", () => {
  it("computes expected normalized scores for fixed inputs", () => {
    const a = endpoint({
      provider_name: "A",
      pricing: { prompt: "1", completion: "3" },
      throughput_last_30m: { p50: 100, p90: 100 },
      latency_last_30m: { p50: 2, p90: 2 },
      quantization: "fp16",
    });
    const b = endpoint({
      provider_name: "B",
      pricing: { prompt: "2", completion: "2" },
      throughput_last_30m: { p50: 200, p90: 200 },
      latency_last_30m: { p50: 4, p90: 4 },
      quantization: "fp8",
    });
    const r = role("cheap");
    const active = initialActive(r, thresholds());
    const scored = scoreCandidates([a, b], active, weights(), QUANT_LADDER);
    assert.equal(scored.length, 2);
    const scoreA = scored.find((s) => s.endpoint.provider_name === "A");
    const scoreB = scored.find((s) => s.endpoint.provider_name === "B");
    assert.ok(scoreA);
    assert.ok(scoreB);
    closeTo(scoreA.costNorm, 1);
    closeTo(scoreA.tpsNorm, 0.5);
    closeTo(scoreA.latencyNorm, 1);
    closeTo(scoreA.quantNorm, 0.7);
    closeTo(scoreA.score, 0.82);
    closeTo(scoreB.costNorm, 1);
    closeTo(scoreB.tpsNorm, 1);
    closeTo(scoreB.latencyNorm, 0.5);
    closeTo(scoreB.quantNorm, 0.5);
    closeTo(scoreB.score, 0.9);
  });

  it("prefers the higher-scored candidate via pickBest", () => {
    const a = endpoint({
      provider_name: "A",
      pricing: { prompt: "1", completion: "3" },
      throughput_last_30m: { p50: 100, p90: 100 },
      latency_last_30m: { p50: 2, p90: 2 },
      quantization: "fp16",
    });
    const b = endpoint({
      provider_name: "B",
      pricing: { prompt: "2", completion: "2" },
      throughput_last_30m: { p50: 200, p90: 200 },
      latency_last_30m: { p50: 4, p90: 4 },
      quantization: "fp8",
    });
    const result = pickBest([a, b], role("cheap"), thresholds(), weights(), QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.ok(result.best);
    assert.equal(result.best.endpoint.provider_name, "B");
  });

  it("returns an empty list for empty candidate input", () => {
    const r = role("cheap");
    const active = initialActive(r, thresholds());
    assert.deepEqual(scoreCandidates([], active, weights(), QUANT_LADDER), []);
  });
});

describe("relaxation chain", () => {
  it("returns null when no candidate survives the full chain", () => {
    const { deepseekEndpoints, claudeEndpoints } = loadFixtures();
    const deepseekResult = pickBest(
      deepseekEndpoints,
      role("cheap"),
      thresholds(),
      weights(),
      QUANT_LADDER,
      DEFAULT_CONFIG.minUptime,
    );
    assert.equal(deepseekResult.best, null);
    assert.equal(deepseekResult.steps.length, 5);

    const claudeResult = pickBest(
      claudeEndpoints,
      role("chat"),
      thresholds(),
      weights(),
      QUANT_LADDER,
      DEFAULT_CONFIG.minUptime,
    );
    assert.equal(claudeResult.best, null);
    assert.equal(claudeResult.steps.length, 5);
  });

  it("drops the caching requirement first", () => {
    const noCache = endpoint({ provider_name: "no-cache", supports_implicit_caching: false });
    const result = pickBest([noCache], role("cheap"), thresholds(), weights(), QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.ok(result.best);
    assert.deepEqual(result.steps, ["drop caching requirement"]);
  });

  it("drops the quantization floor next when allowed, scoring unknown as 0", () => {
    const unk = endpoint({ provider_name: "unknown-quant", quantization: "unknown" });
    const result = pickBest([unk], role("cheap"), thresholds(), weights(), QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.ok(result.best);
    assert.equal(result.best.endpoint.provider_name, "unknown-quant");
    assert.deepEqual(result.steps, ["drop caching requirement", "drop quantization floor"]);
    closeTo(result.best.quantNorm, 0);
  });

  it("lowers the context floor next when allowed", () => {
    const small = endpoint({ provider_name: "small-context", context_length: 130000 });
    const result = pickBest([small], role("cheap"), thresholds(), weights(), QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.ok(result.best);
    assert.deepEqual(result.steps, [
      "drop caching requirement",
      "drop quantization floor",
      "lower context floor to 128000",
    ]);
  });

  it("never relaxes the quant floor for the critical role", () => {
    const unk = endpoint({ provider_name: "unknown-quant", quantization: "unknown", context_length: 200000 });
    const result = pickBest(
      [unk],
      role("critical"),
      thresholds(),
      weights(),
      QUANT_LADDER,
      DEFAULT_CONFIG.minUptime,
    );
    assert.equal(result.best, null);
    assert.ok(!result.steps.includes("drop quantization floor"));
    assert.deepEqual(result.steps, [
      "drop caching requirement",
      "lower context floor to 128000",
      "switch latency percentile to p50",
      "switch throughput percentile to p50",
    ]);
  });

  it("keeps relaxing when a step is disabled for a role", () => {
    const noContext = { ...role("cheap"), allowContextRelax: false };
    const small = endpoint({ provider_name: "small-context", context_length: 130000 });
    const result = pickBest([small], noContext, thresholds(), weights(), QUANT_LADDER, DEFAULT_CONFIG.minUptime);
    assert.equal(result.best, null);
    assert.deepEqual(result.steps, [
      "drop caching requirement",
      "drop quantization floor",
      "switch latency percentile to p50",
      "switch throughput percentile to p50",
    ]);
  });
});

describe("margin logic", () => {
  it("switches when there is no current decision", () => {
    assert.equal(shouldSwitch(undefined, 0.8, 0.1), true);
  });

  it("switches only when best beats current by the margin", () => {
    assert.equal(shouldSwitch(0.8, 0.9, 0.1), true);
    assert.equal(shouldSwitch(0.9, 1.0, 0.1), true);
    assert.equal(shouldSwitch(0.9, 0.98, 0.1), false);
    assert.equal(shouldSwitch(0.9, 0.95, 0.1), false);
  });

  it("never switches when best is below the margin threshold", () => {
    assert.equal(shouldSwitch(0.9, 0.9, 0.1), false);
    assert.equal(shouldSwitch(0.9, 0.89, 0.1), false);
  });
});

describe("real fixtures", () => {
  it("deepseek fixture endpoints all fail the strict throughput filter", () => {
    const { deepseekEndpoints } = loadFixtures();
    const passing = filterCandidates(
      deepseekEndpoints,
      role("cheap"),
      initialActive(role("cheap"), thresholds()),
      QUANT_LADDER,
      DEFAULT_CONFIG.minUptime,
    );
    assert.equal(passing.length, 0);
  });

  it("claude fixture endpoints all fail the strict throughput filter", () => {
    const { claudeEndpoints } = loadFixtures();
    const passing = filterCandidates(
      claudeEndpoints,
      role("chat"),
      initialActive(role("chat"), thresholds()),
      QUANT_LADDER,
      DEFAULT_CONFIG.minUptime,
    );
    assert.equal(passing.length, 0);
  });
});