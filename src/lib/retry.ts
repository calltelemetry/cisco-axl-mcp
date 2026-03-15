export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

function getDefaultOptions(): RetryOptions {
  return {
    maxRetries: parseInt(process.env.AXL_MCP_MAX_RETRIES ?? '3', 10) || 3,
    baseDelayMs: parseInt(process.env.AXL_MCP_RETRY_BASE_DELAY_MS ?? '1000', 10) || 1000,
    maxDelayMs: 30000,
    jitterFactor: 0.25,
  };
}

/**
 * Check if an error is retryable.
 *
 * Retryable: 429, 503, connection errors, AXL memory allocation errors.
 * Not retryable: 400-499 auth/validation errors, other SOAP faults.
 */
export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // AXL-specific: memory allocation exceeded (mirrors Elixir axl-api.ex:132-138)
  if (lower.includes('maximum axl memory allocation consumed')) return true;

  // HTTP status-based
  if (lower.includes('429') || lower.includes('too many requests')) return true;
  if (lower.includes('503') || lower.includes('service unavailable')) return true;

  // Connection errors
  if (lower.includes('econnreset')) return true;
  if (lower.includes('econnrefused')) return true;
  if (lower.includes('etimedout')) return true;
  if (lower.includes('socket hang up')) return true;
  if (lower.includes('rate limit')) return true;

  // Not retryable: auth errors, validation errors
  if (lower.includes('401') || lower.includes('unauthorized')) return false;
  if (lower.includes('403') || lower.includes('forbidden')) return false;
  if (lower.includes('authentication failed')) return false;

  return false;
}

/**
 * Check if an error indicates throttling (for audit log purposes).
 */
export function isThrottleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes('maximum axl memory allocation consumed') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponential = Math.min(options.baseDelayMs * Math.pow(2, attempt), options.maxDelayMs);
  const jitter = exponential * (1 + Math.random() * options.jitterFactor);
  return Math.round(jitter);
}

export interface RetryCallbacks {
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Execute a function with retry and exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
  callbacks?: RetryCallbacks,
): Promise<T> {
  const opts = { ...getDefaultOptions(), ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, opts);
      callbacks?.onRetry?.(attempt + 1, error, delayMs);
      console.error(
        `[AXL Retry] attempt ${attempt + 1}/${opts.maxRetries} after ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`
      );
      await delay(delayMs);
    }
  }

  throw lastError;
}
