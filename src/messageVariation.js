/**
 * Applies spintax-style variation to a message so identical text isn't
 * sent to every contact verbatim.
 *
 * Syntax: {option one|option two|option three}
 * Example: "{Hi|Hello|Hey} {name}, {check out|take a look at} our offer!"
 *
 * NOTE: Apply this AFTER {name} personalization has already been
 * substituted, otherwise this function will also try to "spin" the
 * {name} placeholder itself.
 */
function applySpintax(text) {
  if (!text) return text;
  let result = text;
  // Loop in case of nested braces isn't needed here (single-level spintax),
  // but run twice defensively in case adjacent groups appear.
  for (let i = 0; i < 2; i++) {
    result = result.replace(/\{([^{}]+)\}/g, (match, group) => {
      const options = group.split('|').map(s => s.trim());
      if (options.length <= 1) return match; // not a spintax group, leave as-is
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return result;
}

module.exports = { applySpintax };
