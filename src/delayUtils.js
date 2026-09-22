/**
 * Returns a randomized delay (ms) between minSeconds and maxSeconds.
 * Fixed, identical delays between every message is an easy pattern for
 * WhatsApp's anti-spam systems to detect. A small random jitter makes
 * the sending behaviour look more human.
 */
function randomDelayMs(minSeconds, maxSeconds) {
  const min = Math.max(1, Number(minSeconds) || 3);
  const max = Math.max(min, Number(maxSeconds) || min);
  const seconds = min + Math.random() * (max - min);
  return Math.round(seconds * 1000);
}

module.exports = { randomDelayMs };
