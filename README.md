# opencode-smart-router

An opencode plugin that selects the best OpenRouter provider for each configured
model in real time, based on scored criteria, with cache-aware sticky switching.

The plugin never switches providers per request. A decision is sticky for a warm
window (a TTL estimate per provider family). It only re-evaluates once that
window has expired, and even then it only switches when a better-scored
provider beats the current one by a configurable margin.

## How it works

1. The plugin observes every `chat.params` call. When the model being requested
   matches a configured role and uses the configured `providerID`
   (`openrouter` by default), it checks the persisted decision for that model.
2. If the decision is still warm (within the provider family TTL), the provider
   is injected directly. No network calls, no scoring.
3. If the decision is cold, the plugin refreshes its score cache (if stale) and
   re-scores all candidate endpoints for that model against the role's hard
   filters and scoring weights.
4. The best candidate is compared against the current decision using the
   switch margin. It switches only if the new score is meaningfully better.
5. The chosen provider is injected as an OpenRouter routing object:
   `output.options.provider = { order: [provider], allow_fallbacks: true }`.

On `session.created`, the plugin triggers an asynchronous re-evaluation for all
roles, which never blocks a request.

## Scoring criteria and weights

Each candidate endpoint is normalized against the current candidate pool (the
relative best in the pool scores 1.0 on each factor) and combined with a
weighted average:

| Factor | Weight | Normalization |
| --- | --- | --- |
| Cost | 50 | `minCostPerM / costPerM` (cheapest = 1.0) |
| Throughput | 30 | `tps / maxTps` |
| Latency | 10 | `minLatency / latency` |
| Quantization | 10 | Value from the quant ladder |

`costPerM = prompt price + completion price`. `score = (wCost * costNorm +
wTps * tpsNorm + wLat * latencyNorm + wQuant * quantNorm) / sum(weights)`.

Quantization ladder (rank order is insertion order, higher precision is
better): `int4: 0.1`, `int8: 0.3`, `fp8: 0.5`, `fp16: 0.7`, `bf16: 0.85`,
`fp32: 1.0`, `unknown: 0`.

## Hard filters

A candidate endpoint must pass all of the following before it can be scored:

1. Tool calling: `supported_parameters` includes `tools` and
   `supports_tool_choice` is present.
2. Context: endpoint `context_length >= thresholds.contextMin` (default
   500000).
3. Quantization: rank in the ladder is `>= rank(quantFloor)`. `unknown` fails
   while the floor is active.
4. Throughput: `throughput_last_30m[percentile] >= thresholds.tpsMin` (default
   25 at `p90`). Null throughput fails.
5. Latency: `latency_last_30m[percentile] <= thresholds.latencyMax` (default 6
   at `p90`). Null latency fails.
6. Implicit caching: if `requireCaching` is true,
   `supports_implicit_caching === true` must hold.
7. Variant exclusion: model ids ending in `:batch` are excluded unless
   `allowBatch`; ending in `:free` are excluded unless `allowFree`.
8. Provider health: `status === 0` and `uptime_last_5m >= minUptime` (default
   90).

## Relaxation chain

When zero candidates pass the strict filters, the plugin relaxes filters one
step at a time (each step is logged), in this order:

1. Drop the `requireCaching` requirement.
2. Drop the quantization floor if `allowQuantRelax` (then `unknown` is
   admissible and scores 0 on the quantization factor).
3. Lower the context floor to 128000 if `allowContextRelax`.
4. Switch the latency percentile to `p50`.
5. Switch the throughput percentile to `p50`.

If still zero candidates, the plugin keeps the current provider. If there is no
current decision yet, it does not inject `options.provider` (OpenRouter default
routing is used) and logs a warning. The quantization floor is never relaxed
below `fp8` when `allowQuantRelax` is false (the `critical` role).

## Sticky switching

- State is persisted to `statePath` (default:
  `$XDG_DATA_HOME || ~/.local/share/opencode-smart-router/state.json`).
- Decisions are keyed `"<providerName>|<modelId>"` and store the chosen
  provider, its score, `decidedAt`, `lastSeen`, and role.
- TTL per provider family (family = first token of the provider slug,
  matched by prefix):

| Family | TTL |
| --- | --- |
| anthropic | 5 minutes |
| openai | 10 minutes |
| deepseek | 2 hours |
| google | 20 minutes |
| default | 10 minutes |

- A decision is warm while `now - lastSeen < ttl[family]`. `lastSeen` is
  updated on every request for that model.
- A switch only happens when the decision is cold AND
  `bestScore >= currentScore * (1 + switchMargin)` (default margin 0.10), or
  when there is no current decision yet.

## Installation

In `opencode.json`:

```json
{
  "plugin": [
    "opencode-smart-router"
  ]
}
```

With options (tuple form):

```json
{
  "plugin": [
    [
      "opencode-smart-router",
      {
        "switchMargin": 0.15,
        "roles": {
          "cheap": {
            "models": ["deepseek/deepseek-v4-flash"]
          }
        }
      }
    ]
  ]
}
```

From a local checkout:

```json
{
  "plugin": [
    ["/absolute/path/to/opencode-smart-router", {}]
  ]
}
```

## Configuration reference

| Key | Type | Default |
| --- | --- | --- |
| `providerID` | string | `"openrouter"` |
| `statePath` | string | `$XDG_DATA_HOME || ~/.local/share` + `/opencode-smart-router/state.json` |
| `scoreCacheMs` | number | `300000` |
| `switchMargin` | number | `0.1` |
| `allowFallbacks` | boolean | `true` |
| `minUptime` | number | `90` |
| `apiKey` | string | `undefined` (falls back to `OPENROUTER_API_KEY`, then `~/.local/share/opencode/auth.json`) |
| `ttl` | Record\<string, number\> | `{ anthropic: 300000, openai: 600000, deepseek: 7200000, google: 1200000, default: 600000 }` |
| `thresholds.contextMin` | number | `500000` |
| `thresholds.tpsMin` | number | `25` |
| `thresholds.percentile` | string | `"p90"` |
| `thresholds.latencyMax` | number | `6` |
| `weights.cost` | number | `50` |
| `weights.tps` | number | `30` |
| `weights.latency` | number | `10` |
| `weights.quantization` | number | `10` |
| `quantLadder` | Record\<string, number\> | `{ int4: 0.1, int8: 0.3, fp8: 0.5, fp16: 0.7, bf16: 0.85, fp32: 1.0, unknown: 0 }` |
| `roles.*.models` | string[] | See below |
| `roles.*.quantFloor` | string | `"fp8"` |
| `roles.*.allowQuantRelax` | boolean | `critical: false`, `chat/cheap: true` |
| `roles.*.allowContextRelax` | boolean | `true` |
| `roles.*.requireCaching` | boolean | `true` |
| `roles.*.allowFree` | boolean | `false` |
| `roles.*.allowBatch` | boolean | `false` |

Default roles:

- `critical`: models `["openai/gpt-5.6-luna"]`, strict (quant floor `fp8`
  never relaxed).
- `chat`: models `["anthropic/claude-sonnet-4.6"]`.
- `cheap`: models `["deepseek/deepseek-v4-flash"]`.

## How scoring normalization works

Normalization is relative to the current candidate pool, not absolute. For
example, if the cheapest candidate in the pool costs $1 and another costs $4,
their cost factors are `1.0` and `0.25`. The same applies to throughput
(fastest = 1.0) and latency (lowest = 1.0). This means scores are only
meaningful as a comparison within one evaluation, and are persisted alongside
the decision so the margin comparison across evaluations stays coherent.

## API access

- Model list: `GET /api/v1/models?context=<contextMin>&supported_parameters=tools`.
- Endpoints: `GET /api/v1/models/{author}/{slug}/endpoints`.
- Both responses are cached for `scoreCacheMs`.
- An API key is passed when available; public reads work without one, but the
  endpoints call benefits from the key. Key resolution order: `options.apiKey`
  → `OPENROUTER_API_KEY` → `~/.local/share/opencode/auth.json`.
- All requests use the global `fetch` with `AbortSignal.timeout(10000)`. Fetch
  failures are logged and the plugin falls back to the current decision; they
  never throw into the request path.

## Limitations

- Free and batch variants are excluded by default (`allowFree` /
  `allowBatch` are false).
- Endpoints with null throughput or latency are excluded; they cannot be
  scored.
- TTLs are estimates of provider prompt-cache expiry, not exact measurements.
- The latency threshold compares the value OpenRouter returns directly; units
  may differ between providers, so verify against your own measurements.
- The plugin only routes requests that arrive through the configured
  `providerID` and match a configured role model exactly (leading `~` alias
  prefixes are stripped for matching).

## License

MIT. See [LICENSE](./LICENSE).