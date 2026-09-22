const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');
const { readSecureJson, writeSecureJson } = require('./secureStore');

const chatsFile = path.join(app.getPath('userData'), 'chats.dat');
const mediaDir = path.join(app.getPath('userData'), 'chat_media');

const MAX_MESSAGES_PER_CHAT = 300;

let store = null; // { chats: { [jid]: {...} }, messages: { [jid]: [...] } }
let saveTimer = null;

function ensureLoaded() {
  if (!store) {
    store = readSecureJson(chatsFile, { chats: {}, messages: {} });
    if (!store.chats) store.chats = {};
    if (!store.messages) store.messages = {};
  }
  return store;
}

// Debounced write — during a big history sync many messages can arrive
// within milliseconds of each other; writing the whole encrypted file on
// every single one would be very slow. Coalesce rapid writes into one.
function schedulePersist() {
  ensureLoaded();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSecureJson(chatsFile, store);
  }, 400);
}

function safeJidFolder(jid) {
  return jid.replace(/[^a-zA-Z0-9]/g, '_');
}

function upsertChat(jid, patch) {
  ensureLoaded();
  const existing = store.chats[jid] || {
    jid,
    name: jid.split('@')[0],
    lastMessageText: '',
    lastMessageTime: 0,
    unreadCount: 0
  };
  store.chats[jid] = { ...existing, ...patch, jid };
  schedulePersist();
}

function addMessage(jid, message) {
  ensureLoaded();
  if (!store.messages[jid]) store.messages[jid] = [];
  const idx = store.messages[jid].findIndex(m => m.id === message.id);
  if (idx !== -1) {
    // Same message arriving via a second path (optimistic send vs. the
    // WhatsApp echo event) — merge instead of ignoring, so whichever path
    // has the cached image (mediaFile) wins rather than being lost.
    store.messages[jid][idx] = {
      ...store.messages[jid][idx],
      ...message,
      mediaFile: message.mediaFile || store.messages[jid][idx].mediaFile
    };
    schedulePersist();
    return;
  }
  store.messages[jid].push(message);
  if (store.messages[jid].length > MAX_MESSAGES_PER_CHAT) {
    store.messages[jid] = store.messages[jid].slice(-MAX_MESSAGES_PER_CHAT);
  }
  schedulePersist();
}

function getChats() {
  ensureLoaded();
  return Object.values(store.chats)
    .filter(c => c.jid && !c.jid.endsWith('@g.us') && !c.jid.endsWith('@broadcast'))
    .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
}

function getMessages(jid) {
  ensureLoaded();
  return store.messages[jid] || [];
}

function getChatName(jid) {
  ensureLoaded();
  return store.chats[jid] ? store.chats[jid].name : null;
}

function getUnreadCount(jid) {
  ensureLoaded();
  return store.chats[jid] ? (store.chats[jid].unreadCount || 0) : 0;
}

function markChatRead(jid) {
  ensureLoaded();
  if (store.chats[jid]) {
    store.chats[jid].unreadCount = 0;
    schedulePersist();
  }
}

function deleteMessage(jid, msgId) {
  ensureLoaded();
  if (!store.messages[jid]) return;
  store.messages[jid] = store.messages[jid].filter(m => m.id !== msgId);
  schedulePersist();
}

function clearMessages(jid) {
  ensureLoaded();
  store.messages[jid] = [];
  schedulePersist();
}

/** Saves a media buffer (e.g. a downloaded image) encrypted to disk, returns the file path to store on the message. */
function saveMedia(jid, msgId, buffer, mimetype) {
  const dir = path.join(mediaDir, safeJidFolder(jid));
  fs.ensureDirSync(dir);
  const filePath = path.join(dir, msgId + '.dat');
  writeSecureJson(filePath, { mimetype, data: buffer.toString('base64') });
  return filePath;
}

/** Loads a previously saved media file — returns { mimetype, data (base64) } or null. */
function loadMedia(filePath) {
  return readSecureJson(filePath, null);
}

module.exports = {
  upsertChat,
  addMessage,
  getChats,
  getMessages,
  getChatName,
  getUnreadCount,
  markChatRead,
  deleteMessage,
  clearMessages,
  saveMedia,
  loadMedia
};