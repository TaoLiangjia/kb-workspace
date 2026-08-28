const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { start } = require('./server.js');

const PORT = 5173;
// 前端页面地址：留空则加载本地页面（纯本地程序，最稳定）；填入远程地址则加载云端页面（热更新，但依赖托管稳定性）
const REMOTE_URL = '';
let mainWindow = null;

// 单实例：重复双击只聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1320,
      height: 880,
      minWidth: 900,
      minHeight: 600,
      autoHideMenuBar: true,
      title: '知识库工作台',
      backgroundColor: '#f3f5fa',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    mainWindow.loadURL(REMOTE_URL || ('http://127.0.0.1:' + PORT + '/'));
    mainWindow.webContents.setWindowOpenHandler(function (details) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });
    // 关闭前未保存确认：渲染进程 beforeunload 触发 will-prevent-unload，这里弹自定义确认框
    mainWindow.webContents.on('will-prevent-unload', function (event) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['离开', '留下'],
        title: '有未保存的修改',
        message: '你有未保存的修改，确定要退出吗？',
        defaultId: 1,
        cancelId: 1
      });
      if (choice === 0) {  // 选「离开」：允许关闭
        event.preventDefault();
      }
      // 选「留下」：不 preventDefault，取消关闭
    });
    mainWindow.on('closed', function () { mainWindow = null; });
  }

  // 选择保存目录（返回绝对路径）
  ipcMain.handle('select-dir', async function () {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  function validSeg(seg) {
    return seg && seg !== '..' && seg.indexOf('/') < 0 && seg.indexOf('\\') < 0;
  }

  // 写文件（含子目录）
  ipcMain.handle('write-file', async function (e, payload) {
    const p = payload || {};
    const dir = String(p.dir || '');
    const subdir = String(p.subdir || '');
    const filename = String(p.filename || '');
    const content = String(p.content || '');
    if (!dir || !filename) throw new Error('缺少参数');
    if (!validSeg(filename)) throw new Error('文件名不合法');
    let targetDir = dir;
    if (subdir) {
      if (!validSeg(subdir)) throw new Error('目录不合法');
      targetDir = path.join(dir, subdir);
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, filename), content, 'utf8');
    return true;
  });

  // 删文件（含子目录）
  ipcMain.handle('remove-file', async function (e, payload) {
    const p = payload || {};
    const dir = String(p.dir || '');
    const subdir = String(p.subdir || '');
    const filename = String(p.filename || '');
    if (!dir || !filename) throw new Error('缺少参数');
    if (!validSeg(filename)) throw new Error('文件名不合法');
    let targetDir = dir;
    if (subdir) {
      if (!validSeg(subdir)) throw new Error('目录不合法');
      targetDir = path.join(dir, subdir);
    }
    try { await fs.promises.unlink(path.join(targetDir, filename)); } catch (err) { /* 不存在则忽略 */ }
    return true;
  });

  // 读文件（UTF-8 文本，不存在则返回 null）
  ipcMain.handle('read-file', async function (e, payload) {
    const p = payload || {};
    const dir = String(p.dir || '');
    const subdir = String(p.subdir || '');
    const filename = String(p.filename || '');
    if (!dir || !filename) throw new Error('缺少参数');
    if (!validSeg(filename)) throw new Error('文件名不合法');
    let targetDir = dir;
    if (subdir) {
      if (!validSeg(subdir)) throw new Error('目录不合法');
      targetDir = path.join(dir, subdir);
    }
    try {
      return await fs.promises.readFile(path.join(targetDir, filename), 'utf8');
    } catch (err) {
      return null;   // 文件不存在
    }
  });

  // 递归列出目录下所有 .md 文件（返回 [{subdir, filename}]）
  ipcMain.handle('list-md', async function (e, payload) {
    const p = payload || {};
    const dir = String(p.dir || '');
    if (!dir) throw new Error('缺少参数');
    async function walk(d, rel) {
      const entries = await fs.promises.readdir(d, { withFileTypes: true });
      const out = [];
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          out.push(...(await walk(full, path.join(rel, ent.name))));
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
          out.push({ subdir: rel, filename: ent.name });
        }
      }
      return out;
    }
    try {
      return await walk(dir, '');
    } catch (err) {
      return [];
    }
  });

  app.whenReady().then(async function () {
    try {
      await start(PORT);
    } catch (e) {
      console.error('本地服务启动失败：', e && e.message);
    }
    createWindow();
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });
}
