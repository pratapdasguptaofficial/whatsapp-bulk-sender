const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // License
  verifyLicense: (key) => ipcRenderer.invoke('verify-license', key),
  getLicenseInfo: () => ipcRenderer.invoke('get-license-info'),
  deactivateLicense: () => ipcRenderer.invoke('deactivate-license'),

  // WhatsApp
  connectWhatsApp: () => ipcRenderer.invoke('connect-whatsapp'),
  disconnectWhatsApp: () => ipcRenderer.invoke('disconnect-whatsapp'),
  sendMessage: (data) => ipcRenderer.invoke('send-message', data),
  stopSending: () => ipcRenderer.invoke('stop-sending'),
  stopGroupSending: () => ipcRenderer.invoke('stop-group-sending'),
  getSendLimitStatus: () => ipcRenderer.invoke('get-send-limit-status'),

  // File
  pickFile: (type) => ipcRenderer.invoke('pick-file', type),

  // Reports
  getReports: () => ipcRenderer.invoke('get-reports'),
  saveReport: (report) => ipcRenderer.invoke('save-report', report),
  deleteReport: (id) => ipcRenderer.invoke('delete-report', id),
  exportReportExcel: (id) => ipcRenderer.invoke('export-report-excel', id),

  // Schedules
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  saveSchedule: (schedule) => ipcRenderer.invoke('save-schedule', schedule),
  cancelSchedule: (id) => ipcRenderer.invoke('cancel-schedule', id),
  deleteSchedule: (id) => ipcRenderer.invoke('delete-schedule', id),
  
  // Groups
  getGroups: () => ipcRenderer.invoke('get-groups'),
  sendGroupMessage: (data) => ipcRenderer.invoke('send-group-message', data),
  stopSending: () => ipcRenderer.invoke('stop-sending'),
  stopGroupSending: () => ipcRenderer.invoke('stop-group-sending'),

  // Chats
  getChats: () => ipcRenderer.invoke('get-chats'),
  getChatMessages: (jid) => ipcRenderer.invoke('get-chat-messages', jid),
  getChatMedia: (mediaFilePath) => ipcRenderer.invoke('get-chat-media', mediaFilePath),
  markChatRead: (jid) => ipcRenderer.invoke('mark-chat-read', jid),
  getChatAvatar: (jid) => ipcRenderer.invoke('get-chat-avatar', jid),
  sendChatMessage: (data) => ipcRenderer.invoke('send-chat-message', data),

  // Events
  onQRCode: (callback) => ipcRenderer.on('qr-code', (event, qr) => callback(qr)),
  onWhatsAppStatus: (callback) => ipcRenderer.on('whatsapp-status', (event, status) => callback(status)),
  onMessageStatus: (callback) => ipcRenderer.on('message-status', (event, data) => callback(data)),
  onScheduleStarted: (callback) => ipcRenderer.on('schedule-started', (event, data) => callback(data)),
  onScheduleMessageStatus: (callback) => ipcRenderer.on('schedule-message-status', (event, data) => callback(data)),
  onScheduleCompleted: (callback) => ipcRenderer.on('schedule-completed', (event, data) => callback(data)),
  onGroupMessageStatus: (callback) => ipcRenderer.on('group-message-status', (event, data) => callback(data)),
  onChatNewMessage: (callback) => ipcRenderer.on('chat-new-message', (event, data) => callback(data)),
  onChatHistorySynced: (callback) => ipcRenderer.on('chat-history-synced', (event, data) => callback(data)),
  onChatMessageDeleted: (callback) => ipcRenderer.on('chat-message-deleted', (event, data) => callback(data)),
});