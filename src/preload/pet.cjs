const { contextBridge, ipcRenderer } = require('electron');

const petApi = {
  sendChat(text) {
    return ipcRenderer.invoke('pet:chat:send', { text });
  },
  transcribeAndSendFromPet(input) {
    return ipcRenderer.invoke('pet:voice:transcribe-and-send', input);
  },
  moveWindowBy(input) {
    ipcRenderer.send('pet:window:move-by', input);
  },
  setIgnoreMouseEvents(input) {
    ipcRenderer.send('pet:window:set-ignore-mouse-events', input);
  },
  getCursorPosition() {
    return ipcRenderer.invoke('pet:window:get-cursor-position');
  },
  showContextMenu(input) {
    ipcRenderer.send('pet:menu:show', input);
  },
  debugLog(message, detail) {
    ipcRenderer.send('pet:debug:log', { message, detail });
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('pet:event', wrapped);
    return () => ipcRenderer.removeListener('pet:event', wrapped);
  }
};

contextBridge.exposeInMainWorld('petApi', petApi);
