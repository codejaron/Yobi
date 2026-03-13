const { contextBridge, ipcRenderer } = require('electron');

const voiceHostApi = {
  emit(payload) {
    ipcRenderer.send('voice-host:event', payload);
  },
  onCommand(listener) {
    const channel = 'voice-host:command';
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }
};

contextBridge.exposeInMainWorld('voiceHost', voiceHostApi);
