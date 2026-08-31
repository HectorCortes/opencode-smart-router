import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyState, isWarm, loadState, persistDecision, saveState, touch, updateDecision } from "../src/state.js";
import type { Decision, RouterState } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "smart-router-state-"));
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    provider: "deepinfra",
    score: 0.85,
    decidedAt: 1000,
    lastSeen: 1000,
    role: "cheap",
    ...overrides,
  };
}

describe("state persistence", () => {
  it("round-trips save and load", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    const state = emptyState();
    state.decisions["deepinfra|deepseek/deepseek-v4-flash"] = decision();
    state.scoreCache.fetchedAt = 12345;
    saveState(path, state);

    const loaded = loadState(path);
    assert.deepEqual(loaded, state);
    assert.ok(existsSync(path));
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty state when the file is missing", () => {
    const dir = tempDir();
    const path = join(dir, "does-not-exist.json");
    assert.deepEqual(loadState(path), emptyState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty state for corrupt JSON", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    writeFileSync(path, "{ not valid json", "utf8");
    assert.deepEqual(loadState(path), emptyState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file without leaving temp files behind", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    const state = emptyState();
    saveState(path, state);
    assert.ok(existsSync(path));
    assert.deepEqual(readdirSync(dir), ["state.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isWarm", () => {
  it("is warm inside the TTL window", () => {
    const d = decision({ lastSeen: 1000 });
    assert.equal(isWarm(d, 5000, 5999), true);
  });

  it("is cold at or beyond the TTL", () => {
    const d = decision({ lastSeen: 1000 });
    assert.equal(isWarm(d, 5000, 6000), false);
    assert.equal(isWarm(d, 5000, 10000), false);
  });

  it("is cold for undefined decisions and zero TTL", () => {
    assert.equal(isWarm(undefined, 5000, 1000), false);
    const d = decision();
    assert.equal(isWarm(d, 0, 1001), false);
  });
});

describe("touch", () => {
  it("updates lastSeen and keeps the rest", () => {
    const d = decision({ lastSeen: 1000, score: 0.7 });
    const touched = touch(d, 5000);
    assert.equal(touched.lastSeen, 5000);
    assert.equal(touched.score, 0.7);
    assert.equal(touched.provider, "deepinfra");
    assert.equal(d.lastSeen, 1000);
  });
});

describe("decision updates", () => {
  it("updateDecision writes under an explicit key", () => {
    const state = emptyState();
    updateDecision(state, "deepinfra|deepseek/deepseek-v4-flash", decision());
    assert.equal(Object.keys(state.decisions).length, 1);
    assert.ok(state.decisions["deepinfra|deepseek/deepseek-v4-flash"]);
  });

  it("persistDecision replaces prior decisions for the same model", () => {
    const state = emptyState();
    updateDecision(state, "deepinfra|deepseek/deepseek-v4-flash", decision());
    persistDecision(state, "deepseek/deepseek-v4-flash", decision({ provider: "novita" }));
    const keys = Object.keys(state.decisions);
    assert.equal(keys.length, 1);
    assert.ok(keys[0].startsWith("novita|"));
    assert.equal(state.decisions[keys[0]].provider, "novita");
  });

  it("persists after updateDecision via save/load", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    const state: RouterState = emptyState();
    persistDecision(state, "deepseek/deepseek-v4-flash", decision({ provider: "digitalocean" }));
    saveState(path, state);
    const loaded = loadState(path);
    assert.equal(loaded.decisions["digitalocean|deepseek/deepseek-v4-flash"].provider, "digitalocean");
    rmSync(dir, { recursive: true, force: true });
  });
});