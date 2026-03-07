const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('pet:event', wrapped);
    return () => ipcRenderer.removeListener('pet:event', wrapped);
  },
  fileExists(filePath) {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  },
  readTextFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  },
  walkFiles(baseDir) {
    const result = [];
    if (!baseDir || !fs.existsSync(baseDir)) {
      return result;
    }
    const stack = [baseDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile()) result.push(fullPath);
      }
    }
    return result;
  },
  joinPath(...parts) {
    return path.join(...parts);
  },
  toFileHref(filePath) {
    try {
      return pathToFileURL(filePath).toString();
    } catch {
      return `file://${encodeURI(filePath)}`;
    }
  }
};

contextBridge.exposeInMainWorld('petApi', petApi);
