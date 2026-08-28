const { contextBridge, ipcRenderer } = require('electron');

// 暴露给渲染进程的本地文件操作接口（替代 File System Access API，避免会话级权限问题）
contextBridge.exposeInMainWorld('kbAPI', {
  selectDir: function () { return ipcRenderer.invoke('select-dir'); },
  writeFile: function (payload) { return ipcRenderer.invoke('write-file', payload); },
  removeFile: function (payload) { return ipcRenderer.invoke('remove-file', payload); },
  readFile: function (payload) { return ipcRenderer.invoke('read-file', payload); },
  listMd: function (payload) { return ipcRenderer.invoke('list-md', payload); }
});
