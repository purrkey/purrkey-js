# Purrkey TypeScript SDK

[![npm](https://img.shields.io/npm/v/@purrkey/sdk)](https://www.npmjs.com/package/@purrkey/sdk)

The official TypeScript and JavaScript client for [Purrkey](https://purrkey.app/?utm_source=github&utm_medium=readme&utm_campaign=geo_launch), a pay-per-call tool marketplace for AI agents. One API key reaches 1,100+ data tools: social media from TikTok, Instagram, YouTube, Xiaohongshu and Douyin, Amazon and eBay listings, Google Maps reviews, SEO data, and web search and scraping. Every tool has a published price, and each call is paid from one balance.

Works in Node.js 20+, Bun, Deno and modern browsers.

## Install

```sh
npm install @purrkey/sdk
```

## Quick start

Create a key at [purrkey.app/keys](https://purrkey.app/keys?utm_source=github&utm_medium=readme&utm_campaign=geo_launch) and set it as `PURRKEY_API_KEY`. New accounts get $1 in free credit.

```ts
import { Purrkey } from "@purrkey/sdk";

const purrkey = new Purrkey(); // reads PURRKEY_API_KEY

// 1. Find a tool (free)
const { candidates } = await purrkey.discover({ query: "tiktok video search" });

// 2. Read its schema and price (free)
const tool = await purrkey.inspect({ toolId: "tikhub.tiktok.app.v3.fetch_video_search_result" });
console.log(tool.tool.price); // { unit: "call", unitPriceMicros: "1000", ... }

// 3. Run it and wait for the result
const run = await purrkey.run({
  toolId: "tikhub.tiktok.app.v3.fetch_video_search_result",
  input: { query: { keyword: "matcha latte", count: 10 } },
});

console.log(run.status); // "SUCCEEDED"
console.log(run.billing.chargedMicros); // "1000" = $0.001
console.log(run.result.output);
```

Browse the [tool catalog](https://purrkey.app/tools?utm_source=github&utm_medium=readme&utm_campaign=geo_launch) to see what is available.

## Paying safely

`run()` handles the rules that keep a task from being charged twice:

- **Spending cap.** Each Run carries `maxChargeMicros`, the most it may cost (1 USD = 1,000,000 micros). For tools priced per call, the SDK uses the inspected price. When the price depends on the input (per result, per URL, per credit), pass `maxChargeMicros` yourself; otherwise `run()` throws `max_charge_required` before anything is charged.
- **Idempotency.** Every Run has an `idempotencyKey`. If a response is lost, the SDK sends the same request again with the same key, and Purrkey returns the original Run instead of running and charging again. Pass your own key to make retries safe across processes:

  ```ts
  await purrkey.run({ toolId, input, idempotencyKey: `report-${reportId}` });
  ```

  A new key means a new, separately charged task.
- **Unknown outcomes.** `UNKNOWN` means the provider's outcome needs reconciliation. The SDK stops waiting and returns the Run. Check it later with `getRun(runId)`; don't submit the task again.
- **Billing is separate from status.** Read `run.billing` (`status`, `heldMicros`, `chargedMicros`). A failed Run can still be charged for verified work when the tool's pricing allows it.

Account-wide daily and per-run caps can be set at [purrkey.app/budget](https://purrkey.app/budget?utm_source=github&utm_medium=readme&utm_campaign=geo_launch).

## API

| Method | What it does | Cost |
| --- | --- | --- |
| `discover({ query, limit? })` | Find tool candidates for one task | Free |
| `inspect({ toolId, toolRevision? })` | Exact input/output schema, price and delivery rules | Free |
| `run(options)` | Inspect, submit and (by default) wait for a final status | Tool price |
| `submitRun(request)` | Submit a prepared `RunRequest` | Tool price |
| `getRun(runId)` | Read a Run and its result | Free |
| `waitForRun(runId, { timeoutMs? })` | Poll until a final status; returns the Run as it is on timeout | Free |
| `cancelRun(runId)` | Request cancellation | — |
| `listRuns({ status?, toolId?, cursor?, limit? })` | List your Runs | Free |
| `balance()` | Balance and held amounts | Free |
| `listTools()`, `listProviders()`, `catalog()`, `platformEndpoints(platform)`, `rankings()` | Browse the catalog | Free |

`run()` options: `toolId`, `input`, `maxChargeMicros?`, `idempotencyKey?`, `toolRevision?`, `cacheControl?`, `wait?` (default `true`), `timeoutMs?` (default 120000), `pollIntervalMs?`, `signal?`.

Client options: `apiKey?` (default `PURRKEY_API_KEY`), `baseUrl?`, `fetch?`, `maxRetries?` (default 2; network errors, 429 and 5xx).

All request and response types are exported, generated from the [public OpenAPI contract](https://purrkey.app/docs/openapi.yaml).

## Errors

API errors and client-side checks throw `PurrkeyError`:

```ts
import { PurrkeyError } from "@purrkey/sdk";

try {
  await purrkey.run({ toolId, input });
} catch (error) {
  if (error instanceof PurrkeyError) {
    console.log(error.status, error.code, error.message, error.requestId);
  }
}
```

Common codes: `insufficient_balance`, `schema_invalid` (input doesn't match the tool's schema), `max_charge_required`, `network_error`.

## Other ways to connect

- [Purrkey plugin](https://github.com/purrkey/plugins) for Claude Code and Cursor (MCP)
- [Purrkey skills](https://github.com/purrkey/skills): task recipes for agents
- [Purrkey CLI](https://github.com/purrkey-ai/cli)
- [Python SDK](https://github.com/purrkey/purrkey-python)
- [API reference](https://purrkey.app/docs?utm_source=github&utm_medium=readme&utm_campaign=geo_launch)

## Development

```sh
npm install
npm test
npm run typecheck
npm run generate -- --fetch   # pull the live contract and regenerate src/schema.ts
```

`src/schema.ts` is generated from `openapi/openapi.yaml`; don't edit it by hand. CI fails when they disagree, and a weekly job checks the vendored contract against the live API.

## License

[MIT](LICENSE)
