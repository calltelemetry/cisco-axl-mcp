export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_SOCKET_CLOSED',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

interface ErrorSignals {
  texts: string[];
  codes: string[];
  statuses: number[];
  hasSoapFault: boolean;
}

function readErrorProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function collectErrorSignals(error: unknown): ErrorSignals {
  const signals: ErrorSignals = { texts: [], codes: [], statuses: [], hasSoapFault: false };
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 5) return;
    if (typeof value !== 'object') {
      signals.texts.push(String(value));
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    for (const key of ['message', 'name', 'syscall']) {
      const candidate = readErrorProperty(value, key);
      if (typeof candidate === 'string') signals.texts.push(candidate);
    }
    for (const key of ['code', 'errno']) {
      const candidate = readErrorProperty(value, key);
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        signals.codes.push(String(candidate).toUpperCase());
      }
    }
    for (const key of ['status', 'statusCode']) {
      const candidate = readErrorProperty(value, key);
      const status = typeof candidate === 'string' ? Number(candidate) : candidate;
      if (typeof status === 'number' && Number.isFinite(status)) signals.statuses.push(status);
    }

    for (const key of ['fault', 'faultcode', 'faultCode', 'faultstring', 'faultString']) {
      if (readErrorProperty(value, key) !== undefined) signals.hasSoapFault = true;
    }
    for (const key of ['cause', 'response', 'originalError', 'innerError']) {
      visit(readErrorProperty(value, key), depth + 1);
    }
  };

  visit(error, 0);
  if (signals.texts.length === 0 && signals.codes.length === 0 && signals.statuses.length === 0) {
    signals.texts.push(String(error));
  }
  return signals;
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
  const signals = collectErrorSignals(error);
  const lower = signals.texts.join(' ').toLowerCase();

  // AXL-specific: memory allocation exceeded (mirrors Elixir axl-api.ex:132-138)
  if (lower.includes('maximum axl memory allocation consumed')) return true;

  // HTTP status-based
  if (
    signals.statuses.includes(429) ||
    lower.includes('429') ||
    lower.includes('too many requests')
  )
    return true;
  if (
    signals.statuses.includes(503) ||
    lower.includes('503') ||
    lower.includes('service unavailable')
  )
    return true;

  // Not retryable: auth errors, validation errors, and ordinary SOAP business faults.
  if (signals.statuses.includes(401) || lower.includes('401') || lower.includes('unauthorized'))
    return false;
  if (signals.statuses.includes(403) || lower.includes('403') || lower.includes('forbidden'))
    return false;
  if (lower.includes('authentication failed')) return false;
  if (signals.hasSoapFault) return false;

  // Connection errors
  if (signals.codes.some(code => NETWORK_ERROR_CODES.has(code))) return true;
  if (
    [
      'connection closed',
      'connection lost',
      'fetch failed',
      'network error',
      'socket hang up',
    ].some(fragment => lower.includes(fragment))
  )
    return true;
  if (lower.includes('econnreset')) return true;
  if (lower.includes('econnrefused')) return true;
  if (lower.includes('etimedout')) return true;
  if (lower.includes('epipe')) return true;
  if (lower.includes('enotfound')) return true;
  if (lower.includes('rate limit')) return true;

  return false;
}

/**
 * Check if an error indicates throttling (for audit log purposes).
 */
export function isThrottleError(error: unknown): boolean {
  const signals = collectErrorSignals(error);
  const lower = signals.texts.join(' ').toLowerCase();
  return (
    lower.includes('maximum axl memory allocation consumed') ||
    signals.statuses.includes(429) ||
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
  callbacks?: RetryCallbacks
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
      await delay(delayMs);
    }
  }

  throw lastError;
}
