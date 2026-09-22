const fs = require('fs-extra');
const crypto = require('crypto');
const { machineIdSync } = require('node-machine-id');

// Derive an encryption key tied to this device, so the file can't be
// casually opened/read on another machine or in a text editor.
function getKey() {
  const machineId = machineIdSync(true);
  return crypto.scryptSync(machineId, 'wa-bulk-sender-salt', 32);
}

/**
 * Reads and decrypts a JSON file written by writeSecureJson().
 * Returns defaultValue if the file doesn't exist or can't be read.
 */
function readSecureJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    const raw = fs.readJsonSync(filePath);
    if (!raw || !raw.iv || !raw.authTag || !raw.data) {
      // Not in our encrypted format (e.g. an old plain-JSON file from
      // before this update) — return default so callers don't crash.
      return defaultValue;
    }
    const key = getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.error('Failed to read secure file:', filePath, err.message);
    return defaultValue;
  }
}

/** Encrypts data and writes it to filePath. */
function writeSecureJson(filePath, data) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  fs.writeJsonSync(filePath, {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: encrypted.toString('base64')
  });
}

module.exports = { readSecureJson, writeSecureJson };