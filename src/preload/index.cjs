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
  triggerBilibiliSync() {
    return ipcRenderer.invoke('browse:bili:sync:trigger');
  },
  openBilibiliAccount() {
    return ipcRenderer.invoke('browse:bili:account:open');
  },
  openSystemPermissionSettings(permission) {
    return ipcRenderer.invoke('system:permissions:open-settings', permission);
  },
  resetSystemPermissions() {
    return ipcRenderer.invoke('system:permissions:reset');
  },
  importPetModelFromDialog() {
    return ipcRenderer.invoke('pet:model:import');
  },
  listSkills() {
    return ipcRenderer.invoke('skills:list');
  },
  rescanSkills() {
    return ipcRenderer.invoke('skills:rescan');
  },
  importSkillFolder() {
    return ipcRenderer.invoke('skills:import-folder');
  },
  setSkillEnabled(input) {
    return ipcRenderer.invoke('skills:set-enabled', input);
  },
  deleteSkill(skillId) {
    return ipcRenderer.invoke('skills:delete', { skillId });
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
  listScheduledTasks() {
    return ipcRenderer.invoke('scheduler:list');
  },
  saveScheduledTask(input) {
    return ipcRenderer.invoke('scheduler:save', input);
  },
  pauseScheduledTask(taskId) {
    return ipcRenderer.invoke('scheduler:pause', { taskId });
  },
  resumeScheduledTask(taskId) {
    return ipcRenderer.invoke('scheduler:resume', { taskId });
  },
  deleteScheduledTask(taskId) {
    return ipcRenderer.invoke('scheduler:delete', { taskId });
  },
  runScheduledTaskNow(taskId) {
    return ipcRenderer.invoke('scheduler:run-now', { taskId });
  }
};

contextBridge.exposeInMainWorld('companion', api);
