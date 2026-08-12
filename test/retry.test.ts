import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryable, isThrottleError } from '../src/lib/retry';

describe('isRetryable', () => {
  it('returns true for 429 errors', () => {
    expect(isRetryable(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 503 errors', () => {
    expect(isRetryable(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for AXL memory allocation errors', () => {
    expect(isRetryable(new Error('Maximum AXL Memory Allocation Consumed'))).toBe(true);
  });

  it('returns true for connection errors', () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryable(new Error('EPIPE'))).toBe(true);
    expect(isRetryable(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  it.each([
    ['top-level code', Object.assign(new Error('request failed'), { code: 'ECONNRESET' })],
    [
      'nested cause code',
      new Error('request failed', {
        cause: Object.assign(new Error('transport closed'), { code: 'ETIMEDOUT' }),
      }),
    ],
    ['errno', Object.assign(new Error('write failed'), { errno: 'EPIPE' })],
    ['generic network code', Object.assign(new Error('request failed'), { code: 'ERR_NETWORK' })],
    ['HTTP status', Object.assign(new Error('request failed'), { status: 503 })],
    [
      'nested response status',
      Object.assign(new Error('request failed'), { response: { statusCode: 503 } }),
    ],
  ])('inspects structured %s fields', (_label, error) => {
    expect(isRetryable(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error('request failed'), { status: 401 }),
    Object.assign(new Error('request failed'), { response: { statusCode: 403 } }),
    Object.assign(new Error('AXL validation failed'), {
      response: { statusCode: 500 },
      fault: { faultcode: 'soap:Client', faultstring: 'Invalid field value' },
    }),
  ])('keeps structured auth and SOAP business faults non-retryable', error => {
    expect(isRetryable(error)).toBe(false);
  });

  it('returns true for rate limit errors', () => {
    expect(isRetryable(new Error('rate limit exceeded'))).toBe(true);
  });

  it('returns false for auth errors', () => {
    expect(isRetryable(new Error('401 Unauthorized'))).toBe(false);
    expect(isRetryable(new Error('403 Forbidden'))).toBe(false);
    expect(isRetryable(new Error('Authentication failed'))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRetryable(new Error('Invalid parameter'))).toBe(false);
    expect(isRetryable(new Error('Not found'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isRetryable('ECONNRESET')).toBe(true);
    expect(isRetryable('some error')).toBe(false);
  });
});

describe('isThrottleError', () => {
  it('detects AXL memory errors', () => {
    expect(isThrottleError(new Error('Maximum AXL Memory Allocation Consumed'))).toBe(true);
  });

  it('detects 429 errors', () => {
    expect(isThrottleError(new Error('429'))).toBe(true);
  });

  it('does not flag connection errors as throttle', () => {
    expect(isThrottleError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitterFactor: 0,
    });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitterFactor: 0,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and succeeds on third attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitterFactor: 0,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0 })
    ).rejects.toThrow('401 Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0 })
    ).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('calls onRetry callback for each retry', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValue('ok');

    const onRetry = vi.fn();
    await withRetry(
      fn,
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0 },
      { onRetry }
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
  });

  it('does not retry on AXL memory error that exceeds max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Maximum AXL Memory Allocation Consumed'));

    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0 })
    ).rejects.toThrow('Maximum AXL Memory Allocation Consumed');
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});
