const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const whatsapp = require('./src/whatsapp');
const rateLimiter = require('./src/rateLimiter');
const { randomDelayMs } = require('./src/delayUtils');
const { applySpintax } = require('./src/messageVariation');
const { withRetry } = require('./src/retry');
const { readSecureJson, writeSecureJson } = require('./src/secureStore');
const chatStore = require('./src/chatStore');

// Sleeps for `ms` milliseconds, but checks `isCancelledFn` every 250ms
// and returns early if it becomes true — makes the Stop button responsive
// even during a long delay wait.
async function sleepCancellable(ms, isCancelledFn) {
  const stepMs = 250;
  let waited = 0;
  while (waited < ms) {
    if (isCancelledFn()) return;
    const step = Math.min(stepMs, ms - waited);
    await new Promise(resolve => setTimeout(resolve, step));
    waited += step;
  }
}

// Auto-reload during development (only active with `npm run dev`)
if (process.argv.includes('--dev')) {
  try {
    require('electron-reload')(__dirname, {
      electron: require(`${__dirname}/node_modules/electron`)
    });
  } catch (err) {
    console.log('electron-reload not active:', err.message);
  }
}

let mainWindow;
const licenseFile = path.join(app.getPath('userData'), 'license.json');
const reportFile = path.join(app.getPath('userData'), 'reports.json');
const scheduleFile = path.join(app.getPath('userData'), 'schedules.json');

// Active timers
const activeTimers = {};

// Stop-sending flags — set to true via IPC when the user clicks "Stop"
let cancelIndividualSend = false;
let cancelGroupSend = false;

function createLicenseWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'WA Bulk Sender - Activation',
    autoHideMenuBar: true
  });
  mainWindow.loadFile('renderer/license.html');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'WA Bulk Sender',
    autoHideMenuBar: true
  });
  mainWindow.loadFile('renderer/index.html');
  whatsapp.setWindow(mainWindow);
}

// ─── SCHEDULE EXECUTOR ───────────────────────────────────────────────

async function executeSchedule(schedule) {
  try {
    if (mainWindow) {
      mainWindow.webContents.send('schedule-started', { id: schedule.id });
    }

    const delayMin = schedule.delayMin || schedule.delay || 3;
    const delayMax = schedule.delayMax || schedule.delay || delayMin;

    const results = [];
    for (let i = 0; i < schedule.contacts.length; i++) {
      const contact = schedule.contacts[i];
      const number = contact.number;

      // Daily/warm-up send cap — stop the batch cleanly instead of
      // hammering WhatsApp past a safe volume for this number.
      if (!rateLimiter.canSendMore()) {
        if (mainWindow) {
          mainWindow.webContents.send('schedule-message-status', {
            id: schedule.id,
            number, name: contact.name,
            status: 'limit_reached',
            index: i,
            total: schedule.contacts.length
          });
        }
        break;
      }

      const personalizedMessage = applySpintax(schedule.message.replace(/\{name\}/gi, contact.name || ''));

      try {
        await withRetry(
          () => whatsapp.sendMessage(number, personalizedMessage, schedule.attachment || null),
          { retries: 2, isRetryable: (err) => err.message !== 'Number is not registered on WhatsApp.' }
        );
        rateLimiter.recordSend();
        results.push({ number, name: contact.name, status: 'success' });
        if (mainWindow) {
          mainWindow.webContents.send('schedule-message-status', {
            id: schedule.id,
            number, name: contact.name,
            status: 'success',
            index: i,
            total: schedule.contacts.length
          });
        }
      } catch (err) {
        results.push({ number, name: contact.name, status: 'failed', error: err.message });
        if (mainWindow) {
          mainWindow.webContents.send('schedule-message-status', {
            id: schedule.id,
            number, name: contact.name,
            status: 'failed',
            index: i,
            total: schedule.contacts.length
          });
        }
      }

      if (i < schedule.contacts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, randomDelayMs(delayMin, delayMax)));
      }
    }

    // Schedule complete — status update
    updateScheduleStatus(schedule.id, 'completed');

    // Save report
    const success = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const report = {
      id: Date.now().toString(),
      date: new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      message: schedule.message.substring(0, 50) + (schedule.message.length > 50 ? '...' : ''),
      total: results.length,
      success,
      failed,
      details: results
    };
    let reports = readSecureJson(reportFile, []);
    reports.unshift(report);
    if (reports.length > 50) reports = reports.slice(0, 50);
    writeSecureJson(reportFile, reports);

    if (mainWindow) {
      mainWindow.webContents.send('schedule-completed', { id: schedule.id, success, failed });
    }

  } catch (err) {
    updateScheduleStatus(schedule.id, 'failed');
  }
}

function updateScheduleStatus(id, status) {
  let schedules = readSecureJson(scheduleFile, []);
  schedules = schedules.map(s => s.id === id ? { ...s, status } : s);
  writeSecureJson(scheduleFile, schedules);
}

function setupScheduleTimer(schedule) {
  const now = new Date().getTime();
  const scheduledTime = new Date(schedule.scheduledAt).getTime();
  const delay = scheduledTime - now;

  if (delay <= 0) {
    // Already past — execute immediately if pending
    if (schedule.status === 'pending') {
      executeSchedule(schedule);
    }
    return;
  }

  // Clear existing timer if any
  if (activeTimers[schedule.id]) {
    clearTimeout(activeTimers[schedule.id]);
  }

  activeTimers[schedule.id] = setTimeout(() => {
    executeSchedule(schedule);
    delete activeTimers[schedule.id];
  }, delay);
}

function loadAndSetupSchedules() {
  const schedules = readSecureJson(scheduleFile, []);
  schedules
    .filter(s => s.status === 'pending')
    .forEach(s => setupScheduleTimer(s));
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:"
        ]
      }
    });
  });

  const licenseData = readSecureJson(licenseFile, null);
  if (licenseData) {
    try {
      const axios = require('axios');
      const response = await axios.post('https://walic.pspsoft.tech/verify.php', {
        license_key: licenseData.license_key,
        domain: 'MACHINE-' + licenseData.machine_id,
        product_id: 'WA_Bulk_Sender'
      });
      if (response.data.status === 'success') {
        writeSecureJson(licenseFile, {
          ...licenseData,
          expiry_date: response.data.license_info.expiry_date,
          customer_name: response.data.license_info.customer_name,
          lastVerifiedAt: new Date().toISOString()
        });
        createMainWindow();
      } else {
        fs.removeSync(licenseFile);
        createLicenseWindow();
      }
    } catch (err) {
      // Offline fallback — only trust this if the system clock hasn't been
      // rolled back since the last successful server check, and only for
      // a limited grace period (so a permanently blocked network can't be
      // used to run the app forever on a stale local check).
      const OFFLINE_GRACE_DAYS = 3;
      const now = new Date();
      const expiry = new Date(licenseData.expiry_date);
      const lastVerifiedAt = licenseData.lastVerifiedAt ? new Date(licenseData.lastVerifiedAt) : null;

      const clockLooksTampered = lastVerifiedAt && now < lastVerifiedAt;
      const withinGracePeriod = lastVerifiedAt &&
        (now.getTime() - lastVerifiedAt.getTime()) < OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;

      if (!clockLooksTampered && withinGracePeriod && expiry > now) {
        createMainWindow();
      } else {
        fs.removeSync(licenseFile);
        createLicenseWindow();
      }
    }
  } else {
    createLicenseWindow();
  }

  // Load pending schedules
  loadAndSetupSchedules();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── LICENSE ───────────────────────────────────────────────

ipcMain.handle('verify-license', async (event, licenseKey) => {
  try {
    const { machineIdSync } = require('node-machine-id');
    const axios = require('axios');
    const machineId = machineIdSync();

    const response = await axios.post('https://walic.pspsoft.tech/verify.php', {
      license_key: licenseKey,
      domain: 'MACHINE-' + machineId,
      product_id: 'WA_Bulk_Sender'
    });

    const data = response.data;

    if (data.status === 'success') {
      writeSecureJson(licenseFile, {
        license_key: licenseKey,
        customer_name: data.license_info.customer_name,
        expiry_date: data.license_info.expiry_date,
        machine_id: machineId,
        lastVerifiedAt: new Date().toISOString()
      });
      mainWindow.close();
      createMainWindow();
      return { success: true, name: data.license_info.customer_name };
    } else {
      return { success: false, message: data.message };
    }
  } catch (err) {
    return { success: false, message: 'Server connection failed.' };
  }
});

ipcMain.handle('get-license-info', async () => {
  return readSecureJson(licenseFile, null);
});

ipcMain.handle('deactivate-license', async () => {
  try {
    if (fs.existsSync(licenseFile)) fs.removeSync(licenseFile);
    mainWindow.close();
    createLicenseWindow();
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

// ─── FILE PICKER ───────────────────────────────────────────────

ipcMain.handle('pick-file', async (event, type) => {
  let filters = [];
  if (type === 'image') filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }];
  else if (type === 'video') filters = [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', '3gp'] }];
  else if (type === 'document') filters = [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip'] }];
  else if (type === 'csv') filters = [{ name: 'CSV', extensions: ['csv'] }];

  const isMultiple = type === 'image' || type === 'video' || type === 'document';

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: isMultiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  if (type === 'csv') {
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf8');
    return { filePath, content };
  }

  // Multiple files — size check all
  const files = [];
  for (const filePath of result.filePaths) {
    const fileStats = fs.statSync(filePath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    if (fileSizeMB > 5) {
      return { error: `"${path.basename(filePath)}" is ${fileSizeMB.toFixed(1)} MB. Maximum allowed size is 5 MB per file.` };
    }
    files.push({ filePath, fileName: path.basename(filePath) });
  }

  // Single file — old format maintain
  if (files.length === 1) {
    return { filePath: files[0].filePath, fileName: files[0].fileName, files };
  }

return { files, fileName: `${files.length} files selected` };
});

// ─── REPORTS ───────────────────────────────────────────────

ipcMain.handle('get-reports', async () => {
  return readSecureJson(reportFile, []);
});

ipcMain.handle('save-report', async (event, report) => {
  let reports = readSecureJson(reportFile, []);
  reports.unshift(report);
  if (reports.length > 50) reports = reports.slice(0, 50);
  writeSecureJson(reportFile, reports);
  return { success: true };
});

ipcMain.handle('delete-report', async (event, id) => {
  let reports = readSecureJson(reportFile, []);
  reports = reports.filter(r => r.id !== id);
  writeSecureJson(reportFile, reports);
  return { success: true };
});

// ─── EXPORT EXCEL ───────────────────────────────────────────────

ipcMain.handle('export-report-excel', async (event, reportId) => {
  try {
    const XLSX = require('xlsx');
    const reports = readSecureJson(reportFile, []);
    const report = reports.find(r => r.id === reportId);
    if (!report) return { success: false };

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Report',
      defaultPath: `WA_Report_${reportId}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });

    if (!filePath) return { success: false };

    const summaryData = [
      ['WA Bulk Sender - Sending Report'],
      [],
      ['Date', report.date],
      ['Message', report.message],
      ['Total', report.total],
      ['Successful', report.success],
      ['Failed', report.failed],
    ];

    const detailsData = [['Name', 'Number', 'Status']];
    for (const d of report.details) {
      detailsData.push([
        d.name || '-',
        d.number,
        d.status === 'success' ? 'Successful' : 'Failed'
      ]);
    }

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    const ws2 = XLSX.utils.aoa_to_sheet(detailsData);

    ws1['!cols'] = [{ wch: 20 }, { wch: 40 }];
    ws2['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 15 }];

    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
    XLSX.utils.book_append_sheet(wb, ws2, 'Details');
    XLSX.writeFile(wb, filePath);

    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ─── SCHEDULES ───────────────────────────────────────────────

ipcMain.handle('get-schedules', async () => {
  return readSecureJson(scheduleFile, []);
});

ipcMain.handle('save-schedule', async (event, schedule) => {
  let schedules = readSecureJson(scheduleFile, []);
  schedules.unshift(schedule);
  writeSecureJson(scheduleFile, schedules);
  // Timer setup
  setupScheduleTimer(schedule);
  return { success: true };
});

ipcMain.handle('cancel-schedule', async (event, id) => {
  // Timer clear
  if (activeTimers[id]) {
    clearTimeout(activeTimers[id]);
    delete activeTimers[id];
  }
  // Status update
  updateScheduleStatus(id, 'cancelled');
  return { success: true };
});

ipcMain.handle('delete-schedule', async (event, id) => {
  if (activeTimers[id]) {
    clearTimeout(activeTimers[id]);
    delete activeTimers[id];
  }
  let schedules = readSecureJson(scheduleFile, []);
  schedules = schedules.filter(s => s.id !== id);
  writeSecureJson(scheduleFile, schedules);
  return { success: true };
});

// ─── WHATSAPP ───────────────────────────────────────────────

ipcMain.handle('connect-whatsapp', async () => {
  try {
    await whatsapp.connectWhatsApp();
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('disconnect-whatsapp', async () => {
  try {
    await whatsapp.disconnectWhatsApp();
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('send-message', async (event, { contacts, message, delay, delayMin, delayMax, attachment }) => {
  try {
    cancelIndividualSend = false;
    const minD = delayMin || delay || 3;
    const maxD = delayMax || delay || minD;

    const results = [];
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const number = contact.number;

      if (cancelIndividualSend) {
        results.push({ number, name: contact.name, status: 'stopped' });
        if (mainWindow) {
          mainWindow.webContents.send('message-status', {
            number, name: contact.name,
            status: 'stopped',
            index: i,
            total: contacts.length
          });
        }
        break;
      }

      if (!rateLimiter.canSendMore()) {
        results.push({ number, name: contact.name, status: 'limit_reached' });
        if (mainWindow) {
          mainWindow.webContents.send('message-status', {
            number, name: contact.name,
            status: 'limit_reached',
            index: i,
            total: contacts.length
          });
        }
        break;
      }

      const personalizedMessage = applySpintax(message.replace(/\{name\}/gi, contact.name || ''));

      try {
        await withRetry(
          () => whatsapp.sendMessage(number, personalizedMessage, attachment),
          { retries: 2, isRetryable: (err) => err.message !== 'Number is not registered on WhatsApp.' }
        );
        rateLimiter.recordSend();
        results.push({ number, name: contact.name, status: 'success' });
        if (mainWindow) {
          mainWindow.webContents.send('message-status', {
            number, name: contact.name,
            status: 'success',
            index: i,
            total: contacts.length
          });
        }
      } catch (err) {
        results.push({ number, name: contact.name, status: 'failed', error: err.message });
        if (mainWindow) {
          mainWindow.webContents.send('message-status', {
            number, name: contact.name,
            status: 'failed',
            index: i,
            total: contacts.length
          });
        }
      }

      if (i < contacts.length - 1) {
        await sleepCancellable(randomDelayMs(minD, maxD), () => cancelIndividualSend);
      }
    }
    return { success: true, results };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('stop-sending', async () => {
  cancelIndividualSend = true;
  return { success: true };
});

// ─── GROUPS ───────────────────────────────────────────────

ipcMain.handle('get-groups', async () => {
  try {
    const groups = await whatsapp.getGroups();
    return { success: true, groups };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('send-group-message', async (event, { groups, message, delay, delayMin, delayMax, attachment }) => {
  try {
    cancelGroupSend = false;
    const minD = delayMin || delay || 3;
    const maxD = delayMax || delay || minD;

    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      if (cancelGroupSend) {
        results.push({ id: group.id, name: group.name, status: 'stopped' });
        if (mainWindow) {
          mainWindow.webContents.send('group-message-status', {
            id: group.id,
            name: group.name,
            status: 'stopped',
            index: i,
            total: groups.length
          });
        }
        break;
      }

      try {
        await withRetry(
          () => whatsapp.sendMessage(group.id, applySpintax(message), attachment),
          { retries: 2 }
        );
        results.push({ id: group.id, name: group.name, status: 'success' });
        if (mainWindow) {
          mainWindow.webContents.send('group-message-status', {
            id: group.id,
            name: group.name,
            status: 'success',
            index: i,
            total: groups.length
          });
        }
      } catch (err) {
        results.push({ id: group.id, name: group.name, status: 'failed' });
        if (mainWindow) {
          mainWindow.webContents.send('group-message-status', {
            id: group.id,
            name: group.name,
            status: 'failed',
            index: i,
            total: groups.length
          });
        }
      }
      if (i < groups.length - 1) {
        await sleepCancellable(randomDelayMs(minD, maxD), () => cancelGroupSend);
      }
    }
    return { success: true, results };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('stop-group-sending', async () => {
  cancelGroupSend = true;
  return { success: true };
});

// ─── SEND LIMIT STATUS ───────────────────────────────────────────────

ipcMain.handle('get-send-limit-status', async () => {
  try {
    return { success: true, ...rateLimiter.getStatus() };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ─── CHATS ───────────────────────────────────────────────

ipcMain.handle('get-chats', async () => {
  try {
    return { success: true, chats: chatStore.getChats() };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-chat-messages', async (event, jid) => {
  try {
    return { success: true, messages: chatStore.getMessages(jid) };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-chat-media', async (event, mediaFilePath) => {
  try {
    const media = chatStore.loadMedia(mediaFilePath);
    return { success: true, media };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('mark-chat-read', async (event, jid) => {
  chatStore.markChatRead(jid);
  return { success: true };
});

ipcMain.handle('get-chat-avatar', async (event, jid) => {
  try {
    const avatar = await whatsapp.getChatAvatar(jid);
    return { success: true, avatar };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('send-chat-message', async (event, { jid, text, attachment }) => {
  try {
    const realMsgId = await whatsapp.sendChatReply(jid, text || '', attachment || null);
    const msgId = realMsgId || ('local-' + Date.now());

    let mediaFile = null;
    if (attachment && attachment.type === 'image' && attachment.filePath) {
      try {
        const buffer = fs.readFileSync(attachment.filePath);
        mediaFile = chatStore.saveMedia(jid, msgId, buffer, 'image/jpeg');
      } catch (err) {
        // If caching fails, the message still sends fine — it'll just show
        // the "not downloaded" placeholder instead of the image.
      }
    }

    const message = {
      id: msgId,
      fromMe: true,
      type: attachment && attachment.type === 'image' ? 'image' : 'text',
      text: text || '',
      mediaFile,
      timestamp: Date.now()
    };
    chatStore.addMessage(jid, message);
    chatStore.upsertChat(jid, {
      lastMessageText: message.type === 'image' ? ('📷 ' + (text || 'Photo')) : text,
      lastMessageTime: message.timestamp
    });

    return { success: true, message };
  } catch (err) {
    return { success: false, message: err.message };
  }
});