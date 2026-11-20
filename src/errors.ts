/** Error returned by the Purrkey API or raised by the SDK before a request. */
export class PurrkeyError extends Error {
  /** HTTP status, or 0 when the request never reached the API. */
  readonly status: number;
  /** Stable error code, such as `insufficient_balance` or `max_charge_required`. */
  readonly code: string;
  /** Whether the same request may be sent again. */
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    requestId?: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "PurrkeyError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

interface ErrorBody {
  requestId?: string;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

/** Builds a PurrkeyError from an HTTP error response body. */
export function apiError(status: number, body: unknown): PurrkeyError {
  const parsed = (body ?? {}) as ErrorBody;
  return new PurrkeyError({
    status,
    code: parsed.error?.code ?? `http_${status}`,
    message: parsed.error?.message ?? `Purrkey API returned HTTP ${status}`,
    retryable: parsed.error?.retryable ?? (status === 429 || status >= 500),
    requestId: parsed.requestId,
    details: parsed.error?.details,
  });
}
