const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getConfig() {
    return ipcRenderer.invoke('config:get');
  },
  saveConfig(config) {
    return ipcRenderer.invoke('config:save', config);
  },
  listProviderModels(input) {
    return ipcRenderer.invoke('provider:models:list', input ?? {});
  },
  getSpeechRecognitionStatus() {
    return ipcRenderer.invoke('voice:stt:status');
  },
  ensureSenseVoiceModel(input) {
    return ipcRenderer.invoke('sensevoice:model:ensure', input ?? {});
  },
  getSenseVoiceModelStatus(input) {
    return ipcRenderer.invoke('sensevoice:model:status', input ?? {});
  },
  onSenseVoiceModelDownloadProgress(listener) {
    const channel = 'runtime:sensevoice-model-progress';
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
  regenerateCognitionGraphFromSoul() {
    return ipcRenderer.invoke('mind:soul:regenerate-cognition-graph');
  },
  getRelationship() {
    return ipcRenderer.invoke('mind:relationship:get');
  },
  saveRelationship(input) {
    return ipcRenderer.invoke('mind:relationship:save', input);
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
  loadChatImagePreview(input) {
    return ipcRenderer.invoke('chat-media:preview', input ?? {});
  },
  sendConsoleChat(input) {
    return ipcRenderer.invoke('console:chat:send', input ?? {});
  },
  sendConsoleChatWithVoice(input) {
    return ipcRenderer.invoke('console:chat:send', input ?? {});
  },
  stopConsoleChat(requestId) {
    return ipcRenderer.invoke('console:chat:stop', { requestId });
  },
  warmupAudioCapture() {
    return ipcRenderer.invoke('audio:capture:warmup');
  },
  startAudioCaptureSegment() {
    return ipcRenderer.invoke('audio:capture:start-segment');
  },
  stopAudioCaptureSegment() {
    return ipcRenderer.invoke('audio:capture:stop-segment');
  },
  cancelAudioCaptureSegment() {
    return ipcRenderer.invoke('audio:capture:cancel-segment');
  },
  transcribeVoice(input) {
    return ipcRenderer.invoke('voice:transcribe', input);
  },
  getVoiceSessionState() {
    return ipcRenderer.invoke('voice:session:get');
  },
  startVoiceSession(input) {
    return ipcRenderer.invoke('voice:session:start', input ?? {});
  },
  stopVoiceSession() {
    return ipcRenderer.invoke('voice:session:stop');
  },
  interruptVoiceSession(input) {
    return ipcRenderer.invoke('voice:session:interrupt', input ?? {});
  },
  setVoiceSessionMode(mode) {
    return ipcRenderer.invoke('voice:session:set-mode', { mode });
  },
  getCompanionModeState() {
    return ipcRenderer.invoke('companion:mode:get');
  },
  startCompanionMode() {
    return ipcRenderer.invoke('companion:mode:start');
  },
  stopCompanionMode() {
    return ipcRenderer.invoke('companion:mode:stop');
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
  onVoiceSessionEvent(listener) {
    const channel = 'runtime:voice-session-event';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('voice:session:subscribe');
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onCompanionModeEvent(listener) {
    const channel = 'runtime:companion-mode-event';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('companion:mode:subscribe');
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
  },
  getCognitionDebugSnapshot() {
    return ipcRenderer.invoke('cognition:getDebugSnapshot');
  },
  triggerCognitionManualSpread(input) {
    return ipcRenderer.invoke('cognition:triggerManualSpread', input ?? {});
  },
  updateCognitionConfig(input) {
    return ipcRenderer.invoke('cognition:updateConfig', input ?? {});
  },
  getCognitionHealthMetrics() {
    return ipcRenderer.invoke('cognition:getHealthMetrics');
  },
  getCognitionBroadcastHistory() {
    return ipcRenderer.invoke('cognition:getBroadcastHistory');
  },
  clearCognitionLogs(input) {
    return ipcRenderer.invoke('cognition:clearLogs', input ?? {});
  },
  triggerCognitionConsolidation() {
    return ipcRenderer.invoke('cognition:triggerConsolidation');
  },
  getCognitionConsolidationReport() {
    return ipcRenderer.invoke('cognition:getConsolidationReport');
  },
  getCognitionConsolidationHistory() {
    return ipcRenderer.invoke('cognition:getConsolidationHistory');
  },
  getCognitionArchiveStats() {
    return ipcRenderer.invoke('cognition:getArchiveStats');
  },
  onCognitionTickCompleted(listener) {
    const channel = 'cognition:tick-completed';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.send('cognition:tick:subscribe');
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld('companion', api);
