const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const limitsFile = path.join(app.getPath('userData'), 'send_limits.json');

// Warm-up ramp: new/newly-connected WhatsApp numbers get flagged fast if
// they suddenly send a huge volume of messages. Ramp the allowed daily
// volume up gradually based on how many days it's been connected.
// { days: X, limit: Y } => "for the first X days since connecting, cap at Y/day"
const WARMUP_STAGES = [
  { days: 3, limit: 50 },
  { days: 7, limit: 150 },
  { days: 14, limit: 300 },
  { days: Infinity, limit: 1000 }
];

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function loadLimits() {
  try {
    if (fs.existsSync(limitsFile)) {
      return fs.readJsonSync(limitsFile);
    }
  } catch (err) {
    // corrupted file — start fresh rather than crash
  }
  return { connectedSince: null, dailyCounts: {} };
}

function saveLimits(data) {
  fs.writeJsonSync(limitsFile, data);
}

/** Call once when a WhatsApp session successfully connects for the first time. */
function markConnected() {
  const data = loadLimits();
  if (!data.connectedSince) {
    data.connectedSince = new Date().toISOString();
    saveLimits(data);
  }
}

/** Resets the warm-up clock — use this if the user connects a brand new number. */
function resetWarmup() {
  const data = loadLimits();
  data.connectedSince = new Date().toISOString();
  saveLimits(data);
}

function getDailyLimit() {
  const data = loadLimits();
  if (!data.connectedSince) return WARMUP_STAGES[0].limit;
  const daysSince = Math.floor((Date.now() - new Date(data.connectedSince).getTime()) / 86400000);
  const stage = WARMUP_STAGES.find(s => daysSince <= s.days);
  return stage.limit;
}

function getTodayCount() {
  const data = loadLimits();
  return data.dailyCounts[todayKey()] || 0;
}

function canSendMore() {
  return getTodayCount() < getDailyLimit();
}

/** Call after each successful send to increment today's counter. */
function recordSend() {
  const data = loadLimits();
  const key = todayKey();
  data.dailyCounts[key] = (data.dailyCounts[key] || 0) + 1;

  // housekeeping — drop counts older than 30 days
  const cutoff = Date.now() - 30 * 86400000;
  for (const k of Object.keys(data.dailyCounts)) {
    if (new Date(k).getTime() < cutoff) delete data.dailyCounts[k];
  }
  saveLimits(data);
}

function getStatus() {
  const limit = getDailyLimit();
  const count = getTodayCount();
  return {
    todayCount: count,
    dailyLimit: limit,
    remaining: Math.max(0, limit - count)
  };
}

module.exports = {
  markConnected,
  resetWarmup,
  canSendMore,
  recordSend,
  getDailyLimit,
  getTodayCount,
  getStatus
};
