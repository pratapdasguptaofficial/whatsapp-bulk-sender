/**
 * Retries an async operation on failure, waiting a bit longer between
 * each attempt. Skips retrying errors that will never succeed no matter
 * how many times you try (e.g. "number not on WhatsApp").
 */
async function withRetry(fn, options = {}) {
  const retries = options.retries ?? 2;          // total extra attempts after the first try
  const baseDelayMs = options.baseDelayMs ?? 2000; // grows with each retry
  const isRetryable = options.isRetryable ?? (() => true);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === retries;
      if (!isRetryable(err) || isLastAttempt) {
        throw err;
      }
      const wait = baseDelayMs * (attempt + 1); // 2s, then 4s, then 6s...
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };