import { describe, expect, it } from "vitest";
import { Purrkey, PurrkeyError } from "../src/index.js";

type Handler = (request: Request) => Response | Promise<Response>;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

function mockApi(handler: Handler) {
  const calls: Recorded[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.clone().text();
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    });
    return handler(request);
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const inspection = (unit = "call", unitPriceMicros = "10000") => ({
  tool: {
    toolId: "demo.search",
    toolRevision: "rev-1",
    name: "demo.search",
    price: {
      priceRevision: "price-1",
      currency: "USD",
      unit,
      unitPriceMicros,
      description: "per call",
      validUntil: "2099-01-01T00:00:00Z",
    },
  },
  inputSchema: {},
  outputSchema: {},
  inputExamples: [],
  limitations: [],
  supportsCancel: false,
  behavior: {},
  delivery: {},
});

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  runId: "run_1",
  toolId: "demo.search",
  toolRevision: "rev-1",
  status,
  billing: { status: "HELD", chargedMicros: "0" },
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  result: { status: status === "SUCCEEDED" ? "available" : "pending" },
  ...extra,
});

const client = (fetcher: typeof fetch) =>
  new Purrkey({ apiKey: "test-key", fetch: fetcher, maxRetries: 2 });

describe("run", () => {
  it("submits the inspected revisions and waits for a final status", async () => {
    let polls = 0;
    const api = mockApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/inspect") return json(200, inspection());
      if (path === "/v1/runs") return json(202, run("RUNNING", { pollAfterMs: 1 }));
      polls += 1;
      return json(200, run(polls < 2 ? "RUNNING" : "SUCCEEDED", { pollAfterMs: 1 }));
    });

    const result = await client(api.fetcher).run({ toolId: "demo.search", input: { q: "x" } });

    expect(result.status).toBe("SUCCEEDED");
    const submit = api.calls.find((call) => call.path === "/v1/runs")?.body as Record<string, unknown>;
    expect(submit).toMatchObject({
      toolId: "demo.search",
      toolRevision: "rev-1",
      priceRevision: "price-1",
      input: { q: "x" },
      maxChargeMicros: "10000",
      funding: { mode: "balance" },
    });
    expect(String(submit.idempotencyKey)).toMatch(/^sdk-/);
  });

  it("retries a lost submission with the same idempotency key", async () => {
    let submits = 0;
    const api = mockApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/inspect") return json(200, inspection());
      if (path === "/v1/runs") {
        submits += 1;
        if (submits === 1) throw new TypeError("socket hang up");
        return json(200, run("SUCCEEDED"));
      }
      return json(200, run("SUCCEEDED"));
    });

    await client(api.fetcher).run({ toolId: "demo.search", input: {} });

    const keys = api.calls
      .filter((call) => call.path === "/v1/runs")
      .map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("stops at UNKNOWN without submitting again", async () => {
    const api = mockApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/inspect") return json(200, inspection());
      if (path === "/v1/runs") return json(202, run("RUNNING", { pollAfterMs: 1 }));
      return json(200, run("UNKNOWN"));
    });

    const result = await client(api.fetcher).run({ toolId: "demo.search", input: {} });

    expect(result.status).toBe("UNKNOWN");
    expect(api.calls.filter((call) => call.path === "/v1/runs")).toHaveLength(1);
  });

  it("requires maxChargeMicros when the price depends on the input", async () => {
    const api = mockApi(() => json(200, inspection("result", "500")));

    await expect(client(api.fetcher).run({ toolId: "demo.search", input: {} })).rejects.toMatchObject({
      code: "max_charge_required",
    });
    expect(api.calls.some((call) => call.path === "/v1/runs")).toBe(false);
  });

  it("keeps large micro amounts exact", async () => {
    const api = mockApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/inspect") return json(200, inspection("result", "1"));
      return json(200, run("SUCCEEDED"));
    });

    await client(api.fetcher).run({
      toolId: "demo.search",
      input: {},
      maxChargeMicros: 9007199254740993n,
      wait: false,
    });

    const submit = api.calls.find((call) => call.path === "/v1/runs")?.body as Record<string, unknown>;
    expect(submit.maxChargeMicros).toBe("9007199254740993");
  });

  it("rejects fractional amounts before calling the API", async () => {
    const api = mockApi(() => json(200, inspection()));
    await expect(
      client(api.fetcher).run({ toolId: "demo.search", input: {}, maxChargeMicros: 1.5 }),
    ).rejects.toMatchObject({ code: "invalid_max_charge" });
  });
});

describe("errors", () => {
  it("does not retry a non-retryable error", async () => {
    const api = mockApi(() =>
      json(402, {
        requestId: "req_1",
        error: { code: "insufficient_balance", message: "Top up", retryable: false },
      }),
    );

    const error = await client(api.fetcher).balance().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PurrkeyError);
    expect(error).toMatchObject({ status: 402, code: "insufficient_balance", requestId: "req_1" });
    expect(api.calls).toHaveLength(1);
  });

  it("retries 5xx and then succeeds", async () => {
    let attempts = 0;
    const api = mockApi(() => {
      attempts += 1;
      return attempts < 2
        ? json(503, { requestId: "r", error: { code: "unavailable", message: "x", retryable: true } })
        : json(200, { balanceMicros: "1" });
    });

    await expect(client(api.fetcher).balance()).resolves.toMatchObject({ balanceMicros: "1" });
    expect(attempts).toBe(2);
  });

  it("needs an API key", () => {
    const previous = process.env.PURRKEY_API_KEY;
    delete process.env.PURRKEY_API_KEY;
    expect(() => new Purrkey()).toThrow(/PURRKEY_API_KEY/);
    if (previous !== undefined) process.env.PURRKEY_API_KEY = previous;
  });
});
