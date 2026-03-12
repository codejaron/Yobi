const { contextBridge, ipcRenderer } = require('electron');

const voiceHostApi = {
  onPort(listener) {
    const channel = 'voice-host:port';
    const wrapped = (event) => {
      const [port] = event.ports || [];
      if (port) {
        listener(port);
      }
    };

    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }
};

contextBridge.exposeInMainWorld('voiceHost', voiceHostApi);
