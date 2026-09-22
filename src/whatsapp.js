const path = require('path');
const { app } = require('electron');
const fs = require('fs-extra');
const rateLimiter = require('./rateLimiter');
const chatStore = require('./chatStore');

let sock = null;
let mainWindow = null;
const authFolder = path.join(app.getPath('userData'), 'wa_auth');

function setWindow(win) {
  mainWindow = win;
}

function sendStatus(status) {
  if (mainWindow) mainWindow.webContents.send('whatsapp-status', status);
}

// Pulls out the text/type we care about from a raw Baileys message.
// Phase 1 only understands plain text and image messages — other types
// (video, document, audio, stickers, etc.) are ignored for now.
function extractMessageContent(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '' };
  return null;
}

function isIndividualChatJid(jid) {
  return !!jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast') && jid !== 'status@broadcast';
}

async function connectWhatsApp() {
  const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = await import('baileys');
  const { Boom } = await import('@hapi/boom');

  fs.ensureDirSync(authFolder);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['WA Bulk Sender', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (mainWindow) mainWindow.webContents.send('qr-code', qr);
    }

    if (connection === 'open') {
      rateLimiter.markConnected();
      sendStatus('connected');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        fs.removeSync(authFolder);
        sendStatus('logged_out');
        sock = null;
      } else {
        sendStatus('disconnected');
        setTimeout(() => connectWhatsApp(), 5000);
      }
    }
  });

  // ─── CHAT SYNC (Phase 1: individual chats, text + image) ───────────

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (c.id && isIndividualChatJid(c.id) && (c.name || c.notify)) {
        chatStore.upsertChat(c.id, { name: c.name || c.notify });
      }
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      if (c.id && isIndividualChatJid(c.id) && (c.name || c.notify)) {
        chatStore.upsertChat(c.id, { name: c.name || c.notify });
      }
    }
  });

  // Historical chats/messages, delivered once after connecting. Known to
  // be occasionally incomplete/unreliable in the current Baileys version —
  // that's a library-side limitation, not something we can fix here. To
  // keep this fast and robust, historical images are shown as a "📷 Photo"
  // placeholder rather than auto-downloaded (that only happens for new
  // messages that arrive live, below).
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    try {
      for (const c of contacts || []) {
        if (c.id && isIndividualChatJid(c.id) && (c.name || c.notify)) {
          chatStore.upsertChat(c.id, { name: c.name || c.notify });
        }
      }

      for (const chat of chats || []) {
        if (!isIndividualChatJid(chat.id)) continue;
        chatStore.upsertChat(chat.id, {
          name: chatStore.getChatName(chat.id) || chat.name || chat.id.split('@')[0]
        });
      }

      // Baileys delivers history newest-first; insert oldest-first so the
      // chat log ends up in natural reading order.
      const sorted = [...(messages || [])].sort(
        (a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)
      );

      for (const msg of sorted) {
        const jid = msg.key.remoteJid;
        if (!isIndividualChatJid(jid)) continue;
        const content = extractMessageContent(msg);
        if (!content) continue;

        const timestamp = (Number(msg.messageTimestamp) || 0) * 1000;
        const chatMessage = {
          id: msg.key.id,
          fromMe: !!msg.key.fromMe,
          type: content.type,
          text: content.text,
          mediaFile: null,
          timestamp
        };
        chatStore.addMessage(jid, chatMessage);
        chatStore.upsertChat(jid, {
          lastMessageText: content.type === 'image' ? ('📷 ' + (content.text || 'Photo')) : content.text,
          lastMessageTime: timestamp
        });
      }

      if (mainWindow) {
        mainWindow.webContents.send('chat-history-synced', {});
      }
    } catch (err) {
      console.error('Chat history sync error:', err.message);
    }
  });

  // Live messages — both incoming and our own outgoing (echoed back by
  // the socket). Images downloaded immediately while the media link is
  // still guaranteed valid.
  sock.ev.on('messages.upsert', async (upsert) => {
    for (const msg of upsert.messages) {
      const jid = msg.key.remoteJid;
      if (!isIndividualChatJid(jid)) continue;

      // "Delete for everyone" arrives as a "revoke" protocol message inside
      // the normal message stream, not as a separate deletion event.
      const protocolMsg = msg.message && msg.message.protocolMessage;
      if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE') && protocolMsg.key) {
        chatStore.deleteMessage(jid, protocolMsg.key.id);
        if (mainWindow) {
          mainWindow.webContents.send('chat-message-deleted', { jid, id: protocolMsg.key.id });
        }
        continue;
      }

      const content = extractMessageContent(msg);
      if (!content) continue;

      const timestamp = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
      const chatMessage = {
        id: msg.key.id,
        fromMe: !!msg.key.fromMe,
        type: content.type,
        text: content.text,
        mediaFile: null,
        timestamp
      };

      if (content.type === 'image' && upsert.type === 'notify' && !chatMessage.fromMe) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          chatMessage.mediaFile = chatStore.saveMedia(jid, chatMessage.id, buffer, 'image/jpeg');
        } catch (err) {
          // Media link may have expired or download failed — message still
          // shows with its caption/placeholder text, just without the image.
        }
      }

      chatStore.addMessage(jid, chatMessage);
      chatStore.upsertChat(jid, {
        name: chatStore.getChatName(jid) || (msg.pushName || jid.split('@')[0]),
        lastMessageText: content.type === 'image' ? ('📷 ' + (content.text || 'Photo')) : content.text,
        lastMessageTime: timestamp,
        unreadCount: (!chatMessage.fromMe && upsert.type === 'notify')
          ? chatStore.getUnreadCount(jid) + 1
          : chatStore.getUnreadCount(jid)
      });

      if (mainWindow) {
        mainWindow.webContents.send('chat-new-message', { jid, message: chatMessage });
      }
    }
  });
  // Message deletion — either specific messages ("delete for me/everyone")
  // or an entire chat cleared. Keeps the local copy in sync with the phone.
  sock.ev.on('messages.delete', (item) => {
    try {
      if (item.keys) {
        for (const key of item.keys) {
          const jid = key.remoteJid;
          if (!isIndividualChatJid(jid)) continue;
          chatStore.deleteMessage(jid, key.id);
          if (mainWindow) {
            mainWindow.webContents.send('chat-message-deleted', { jid, id: key.id });
          }
        }
      } else if (item.jid) {
        if (!isIndividualChatJid(item.jid)) return;
        chatStore.clearMessages(item.jid);
        if (mainWindow) {
          mainWindow.webContents.send('chat-message-deleted', { jid: item.jid, all: true });
        }
      }
    } catch (err) {
      console.error('messages.delete handling error:', err.message);
    }
  });
}

async function disconnectWhatsApp() {
  if (sock) {
    await sock.logout();
    fs.removeSync(authFolder);
    sock = null;
    sendStatus('logged_out');
  }
}

async function getGroups() {
  if (!sock) throw new Error('WhatsApp not connected.');
  const chats = await sock.groupFetchAllParticipating();
  const groups = Object.values(chats).map(g => ({
    id: g.id,
    name: g.subject,
    participants: g.participants ? g.participants.length : 0
  }));
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

async function sendMessage(number, message, attachment) {
  if (!sock) throw new Error('WhatsApp not connected.');

  let jid;
  if (number.includes('@g.us')) {
    jid = number;
  } else {
    let formatted = number.toString().replace(/\D/g, '');
    jid = formatted + '@s.whatsapp.net';

    // Verify the number actually exists on WhatsApp before wasting a send
    // attempt on it. Sending to dead/invalid numbers wastes daily quota
    // and looks worse to WhatsApp's anti-abuse systems than a clean skip.
    try {
      const [result] = await sock.onWhatsApp(formatted);
      if (!result || !result.exists) {
        throw new Error('Number is not registered on WhatsApp.');
      }
      jid = result.jid; // use the canonical jid WhatsApp returns
    } catch (err) {
      if (err.message === 'Number is not registered on WhatsApp.') throw err;
      // A network hiccup during the check shouldn't block sending outright —
      // fall through and try the send with the manually formatted jid.
    }
  }

  // Typing-indicator simulation: a real person reads a message, maybe
  // types a reply, pauses, etc. An instant, robotic message-after-message
  // pattern is one of the easiest bulk-sending signatures to detect.
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 700 + Math.random() * 1300));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    // presence updates are cosmetic — never let a failure here block sending
  }

  if (attachment) {
    // Multiple files
    const files = attachment.files && attachment.files.length > 1
      ? attachment.files
      : [{ filePath: attachment.filePath, fileName: path.basename(attachment.filePath) }];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileBuffer = fs.readFileSync(file.filePath);
      const fileName = file.fileName;
      // Caption শুধু প্রথম file এ
      const caption = i === 0 ? message : '';

      if (attachment.type === 'image') {
        await sock.sendMessage(jid, { image: fileBuffer, caption });
      } else if (attachment.type === 'video') {
        await sock.sendMessage(jid, { video: fileBuffer, caption });
      } else if (attachment.type === 'document') {
        await sock.sendMessage(jid, {
          document: fileBuffer,
          fileName: fileName,
          mimetype: getMimeType(fileName),
          caption
        });
      }

      // Multiple file এর মধ্যে 1 second delay
      if (i < files.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } else {
    await sock.sendMessage(jid, { text: message });
  }

  return true;
}

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const mimes = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
  };
  return mimes[ext] || 'application/octet-stream';
}

function isConnected() {
  return sock !== null;
}

// In-memory only (not persisted) — profile pictures can change, and many
// users block this via privacy settings anyway, so there's little value
// in caching it to disk. undefined = not fetched yet, null = fetch failed
// (e.g. blocked by privacy settings), object = { mimetype, data }.
const avatarCache = {};

async function getChatAvatar(jid) {
  if (avatarCache[jid] !== undefined) return avatarCache[jid];
  if (!sock) return null;
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    const axios = require('axios');
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    const result = {
      mimetype: response.headers['content-type'] || 'image/jpeg',
      data: Buffer.from(response.data).toString('base64')
    };
    avatarCache[jid] = result;
    return result;
  } catch (err) {
    // No profile picture, or privacy settings block it — expected, not an error.
    avatarCache[jid] = null;
    return null;
  }
}

// Sends a reply in an existing chat. Unlike sendMessage() (used for bulk
// sending to user-typed numbers), this trusts the jid as-is — it came
// straight from a message Baileys already gave us, so it may be a
// phone-number jid (@s.whatsapp.net) OR a privacy "linked ID" jid (@lid).
// Skipping the phone-number re-validation avoids mangling @lid jids.
async function sendChatReply(jid, message, attachment) {
  if (!sock) throw new Error('WhatsApp not connected.');

  let sentMsg = null;

  if (attachment) {
    const files = attachment.files && attachment.files.length > 1
      ? attachment.files
      : [{ filePath: attachment.filePath, fileName: attachment.fileName || path.basename(attachment.filePath) }];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileBuffer = fs.readFileSync(file.filePath);
      const fileName = file.fileName;
      const caption = i === 0 ? message : '';

      if (attachment.type === 'image') {
        sentMsg = await sock.sendMessage(jid, { image: fileBuffer, caption });
      } else if (attachment.type === 'video') {
        sentMsg = await sock.sendMessage(jid, { video: fileBuffer, caption });
      } else if (attachment.type === 'document') {
        sentMsg = await sock.sendMessage(jid, {
          document: fileBuffer,
          fileName: fileName,
          mimetype: getMimeType(fileName),
          caption
        });
      }

      if (i < files.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } else {
    sentMsg = await sock.sendMessage(jid, { text: message });
  }

  // Return the real WhatsApp message id so the caller can use the SAME id
  // that will later arrive via the messages.upsert echo — this lets the
  // dedupe logic correctly recognise it's the same message instead of
  // showing it twice.
  return sentMsg && sentMsg.key ? sentMsg.key.id : null;
}

module.exports = { connectWhatsApp, disconnectWhatsApp, sendMessage, sendChatReply, getChatAvatar, getGroups, isConnected, setWindow };