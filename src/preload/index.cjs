const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getConfig() {
    return ipcRenderer.invoke('config:get');
  },
  saveConfig(config) {
    return ipcRenderer.invoke('config:save', config);
  },
  getSpeechRecognitionStatus() {
    return ipcRenderer.invoke('voice:stt:status');
  },
  ensureWhisperModel(input) {
    return ipcRenderer.invoke('whisper:model:ensure', input ?? {});
  },
  getWhisperModelStatus(input) {
    return ipcRenderer.invoke('whisper:model:status', input ?? {});
  },
  onWhisperModelDownloadProgress(listener) {
    const channel = 'runtime:whisper-model-progress';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  listHistory(query) {
    return ipcRenderer.invoke('history:list', query ?? {});
  },
  clearHistory() {
    return ipcRenderer.invoke('history:clear');
  },
  getMindSnapshot() {
    return ipcRenderer.invoke('mind:snapshot:get');
  },
  getSoul() {
    return ipcRenderer.invoke('mind:soul:get');
  },
  saveSoul(input) {
    return ipcRenderer.invoke('mind:soul:save', input);
  },
  getPersona() {
    return ipcRenderer.invoke('mind:persona:get');
  },
  savePersona(input) {
    return ipcRenderer.invoke('mind:persona:save', input);
  },
  patchState(input) {
    return ipcRenderer.invoke('mind:state:patch', input);
  },
  patchProfile(input) {
    return ipcRenderer.invoke('mind:profile:patch', input);
  },
  resetMindSection(input) {
    return ipcRenderer.invoke('mind:section:reset', input);
  },
  triggerKernelTask(taskType) {
    return ipcRenderer.invoke('kernel:task:trigger', { taskType });
  },
  getStatus() {
    return ipcRenderer.invoke('status:get');
  },
  startBilibiliQrAuth() {
    return ipcRenderer.invoke('browse:bili:qr:start');
  },
  pollBilibiliQrAuth(input) {
    return ipcRenderer.invoke('browse:bili:qr:poll', input);
  },
  saveBilibiliCookie(input) {
    return ipcRenderer.invoke('browse:bili:cookie:save', input);
  },
  triggerTopicRecall() {
    return ipcRenderer.invoke('topic:recall:trigger');
  },
  triggerBilibiliSync() {
    return ipcRenderer.invoke('browse:bili:sync:trigger');
  },
  openBilibiliAccount() {
    return ipcRenderer.invoke('browse:bili:account:open');
  },
  deleteTopicPoolItem(topicId) {
    return ipcRenderer.invoke('topic-pool:item:delete', { topicId });
  },
  clearTopicPool() {
    return ipcRenderer.invoke('topic-pool:clear');
  },
  openSystemPermissionSettings(permission) {
    return ipcRenderer.invoke('system:permissions:open-settings', permission);
  },
  resetSystemPermissions() {
    return ipcRenderer.invoke('system:permissions:reset');
  },
  openOpenClawWebUi() {
    return ipcRenderer.invoke('openclaw:webui:open');
  },
  importPetModelFromDialog() {
    return ipcRenderer.invoke('pet:model:import');
  },
  onStatus(listener) {
    const channel = 'runtime:status';
    const wrapped = (_event, status) => listener(status);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('status:subscribe');
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onPetEnabledChange(listener) {
    const channel = 'runtime:pet-enabled';
    const wrapped = (_event, enabled) => listener(Boolean(enabled));
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  sendConsoleChat(text) {
    return ipcRenderer.invoke('console:chat:send', { text });
  },
  transcribeVoice(input) {
    return ipcRenderer.invoke('voice:transcribe', input);
  },
  listConsoleHistory(input) {
    return ipcRenderer.invoke('console:chat:history', input ?? {});
  },
  approveConsoleCommand(input) {
    return ipcRenderer.invoke('console:chat:approve', input);
  },
  onConsoleRunEvent(listener) {
    const channel = 'runtime:console-run-event';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('console:chat:subscribe');
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  clawConnect() {
    return ipcRenderer.invoke('claw:connect');
  },
  clawDisconnect() {
    return ipcRenderer.invoke('claw:disconnect');
  },
  clawSend(message) {
    return ipcRenderer.invoke('claw:send', { message });
  },
  clawHistory(limit) {
    return ipcRenderer.invoke('claw:history', { limit });
  },
  clawAbort() {
    return ipcRenderer.invoke('claw:abort');
  },
  onClawEvent(listener) {
    const channel = 'runtime:claw-event';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('claw:subscribe');
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld('companion', api);
