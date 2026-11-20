import createClient from "openapi-fetch";
import { apiError, PurrkeyError } from "./errors.js";
import type { paths } from "./schema.js";
import type {
  Balance,
  DiscoverRequest,
  DiscoverResponse,
  InspectRequest,
  ListRunsParams,
  ListToolsParams,
  ProviderCatalog,
  PublicCatalog,
  PublicEndpointPage,
  PublicEndpointsParams,
  PublicRankings,
  Run,
  RunPage,
  RunRequest,
  RunStatus,
  ToolInspection,
  ToolPage,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.purrkey.app";

/** Statuses after which a Run no longer changes on its own. `UNKNOWN` is
 * included: the outcome needs reconciliation, so check it later with
 * `getRun` instead of submitting the task again. */
export const FINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
  "UNKNOWN",
]);

/** Price units whose unit price is the most a single call can cost. */
const CAPPED_PER_CALL_UNITS = new Set(["call", "max_call"]);

export interface PurrkeyOptions {
  /** Purrkey API key. Defaults to the `PURRKEY_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to https://api.purrkey.app. */
  baseUrl?: string;
  /** Custom fetch implementation, for tests or proxies. */
  fetch?: typeof fetch;
  /** Retries after network errors, HTTP 429 and 5xx. Defaults to 2. */
  maxRetries?: number;
}

export interface WaitOptions {
  /** Stop waiting after this long and return the Run as it is. Defaults to 120000. */
  timeoutMs?: number;
  /** Delay between polls when the API gives no `pollAfterMs`. Defaults to 1000. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface RunOptions extends WaitOptions {
  toolId: string;
  /** Tool input; must match the input schema returned by `inspect`. */
  input: unknown;
  /** Pin a tool revision. Defaults to the current one. */
  toolRevision?: string;
  /**
   * Most this Run may cost, in USD micro-units (1 USD = 1000000). Optional for
   * tools priced per call; required when the price depends on the input, such
   * as per result or per credit.
   */
  maxChargeMicros?: string | number | bigint;
  /**
   * Identifies this task. Sending the same key again returns the original Run
   * and never charges twice. Defaults to a new random key.
   */
  idempotencyKey?: string;
  cacheControl?: RunRequest["cacheControl"];
  /** Wait for a final status. Defaults to true. */
  wait?: boolean;
}

export class Purrkey {
  private readonly client: ReturnType<typeof createClient<paths>>;
  private readonly maxRetries: number;

  constructor(options: PurrkeyOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("PURRKEY_API_KEY");
    if (!apiKey) {
      throw new PurrkeyError({
        status: 0,
        code: "missing_api_key",
        message:
          "Pass apiKey or set PURRKEY_API_KEY. Create a key at https://purrkey.app/keys",
      });
    }
    this.maxRetries = options.maxRetries ?? 2;
    this.client = createClient<paths>({
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      fetch: options.fetch,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "purrkey-js/0.1.0",
      },
    });
  }

  /** Finds tool candidates for one task. Free. */
  discover(request: DiscoverRequest): Promise<DiscoverResponse> {
    return this.call(() => this.client.POST("/v1/discover", { body: request }));
  }

  /** Reads a tool's exact schema, price and delivery rules. Free. */
  inspect(request: InspectRequest): Promise<ToolInspection> {
    return this.call(() => this.client.POST("/v1/inspect", { body: request }));
  }

  /**
   * Inspects the tool, submits a Run from the account balance and, by default,
   * waits for a final status. A lost response is retried with the same
   * idempotency key, so it never buys the same task twice.
   */
  async run(options: RunOptions): Promise<Run> {
    const inspection = await this.inspect({
      toolId: options.toolId,
      toolRevision: options.toolRevision,
    });
    const request: RunRequest = {
      toolId: inspection.tool.toolId,
      toolRevision: inspection.tool.toolRevision,
      priceRevision: inspection.tool.price.priceRevision,
      input: options.input,
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      maxChargeMicros: maxCharge(options.maxChargeMicros, inspection),
      funding: { mode: "balance" },
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
    };
    const run = await this.submitRun(request);
    if (options.wait === false) return run;
    return this.waitForRun(run.runId, options);
  }

  /** Submits a prepared RunRequest. Prefer `run` unless you build requests yourself. */
  submitRun(request: RunRequest): Promise<Run> {
    return this.call(() => this.client.POST("/v1/runs", { body: request }));
  }

  /** Reads a Run and its current result. Free. */
  getRun(runId: string): Promise<Run> {
    return this.call(() =>
      this.client.GET("/v1/runs/{runId}", { params: { path: { runId } } }),
    );
  }

  /**
   * Polls a Run until it reaches a final status or the timeout passes. On
   * timeout it returns the Run as it is; call again to keep waiting.
   */
  async waitForRun(runId: string, options: WaitOptions = {}): Promise<Run> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    let run = await this.getRun(runId);
    while (!FINAL_RUN_STATUSES.has(run.status) && Date.now() < deadline) {
      const delay = run.pollAfterMs ?? options.pollIntervalMs ?? 1_000;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), options.signal);
      run = await this.getRun(runId);
    }
    return run;
  }

  /** Requests cancellation. Read the returned Run's billing; a request is not a refund. */
  cancelRun(runId: string): Promise<Run> {
    return this.call(() =>
      this.client.POST("/v1/runs/{runId}/cancel", { params: { path: { runId } } }),
    );
  }

  listRuns(params: ListRunsParams = {}): Promise<RunPage> {
    return this.call(() => this.client.GET("/v1/runs", { params: { query: params } }));
  }

  balance(): Promise<Balance> {
    return this.call(() => this.client.GET("/v1/balance"));
  }

  listTools(params: ListToolsParams = {}): Promise<ToolPage> {
    return this.call(() => this.client.GET("/v1/tools", { params: { query: params } }));
  }

  listProviders(): Promise<ProviderCatalog> {
    return this.call(() => this.client.GET("/v1/providers"));
  }

  catalog(): Promise<PublicCatalog> {
    return this.call(() => this.client.GET("/v1/catalog"));
  }

  platformEndpoints(
    platform: string,
    params: PublicEndpointsParams = {},
  ): Promise<PublicEndpointPage> {
    return this.call(() =>
      this.client.GET("/v1/catalog/{platform}/endpoints", {
        params: { path: { platform }, query: params },
      }),
    );
  }

  rankings(): Promise<PublicRankings> {
    return this.call(() => this.client.GET("/v1/rankings"));
  }

  /** Sends a request, retrying network errors, 429 and 5xx. Every Purrkey
   * operation the SDK exposes is safe to repeat: reads have no side effects
   * and Run submissions are deduplicated by their idempotency key. */
  private async call<T>(
    send: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let result: { data?: T; error?: unknown; response: Response };
      try {
        result = await send();
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new PurrkeyError({
          status: 0,
          code: "network_error",
          message: "Could not reach the Purrkey API",
          retryable: true,
          cause,
        });
      }
      const { data, error, response } = result;
      if (response.ok && data !== undefined) return data;
      const failure = apiError(response.status, error);
      if (failure.retryable && attempt < this.maxRetries) {
        await sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw failure;
    }
  }
}

function maxCharge(
  value: RunOptions["maxChargeMicros"],
  inspection: ToolInspection,
): string {
  if (value !== undefined) {
    const text = typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value);
    if (!/^[0-9]+$/.test(text)) {
      throw new PurrkeyError({
        status: 0,
        code: "invalid_max_charge",
        message: "maxChargeMicros must be a non-negative integer number of USD micro-units",
      });
    }
    return text;
  }
  const price = inspection.tool.price;
  if (CAPPED_PER_CALL_UNITS.has(price.unit) && price.unitPriceMicros) {
    return price.unitPriceMicros;
  }
  throw new PurrkeyError({
    status: 0,
    code: "max_charge_required",
    message: `${inspection.tool.toolId} is priced per ${price.unit}; pass maxChargeMicros for this input (${price.description})`,
  });
}

function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `sdk-${random}`;
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.[name] || undefined;
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) ? Math.min(seconds * 1_000, 30_000) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
