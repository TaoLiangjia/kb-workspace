const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.vbs': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 飞书应用配置：优先读本地 feishu.config.json（该文件已 gitignore，勿提交），其次环境变量
// 开源版不内置任何凭证：请参照 feishu.config.example.json 在飞书开放平台创建自己的企业自建应用后填入
let FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
let FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
try {
  const _cfg = JSON.parse(fs.readFileSync(path.join(root, 'feishu.config.json'), 'utf8'));
  if (_cfg.app_id) FEISHU_APP_ID = String(_cfg.app_id).trim();
  if (_cfg.app_secret) FEISHU_APP_SECRET = String(_cfg.app_secret).trim();
} catch (_e) { /* 无配置文件时使用环境变量或空值 */ }
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.log('[KB-Workspace] 未配置飞书应用凭证，组内共享库功能将不可用。');
  console.log('[KB-Workspace] 请复制 feishu.config.example.json 为 feishu.config.json，填入你自己的飞书应用 App ID / App Secret。');
}

// 飞书 tenant_access_token 缓存（仅存内存，重启即失效）
const tenantCache = {};

function feishuToken(appId, appSecret) {
  return new Promise(function (resolve, reject) {
    const c = tenantCache[appId];
    if (c && c.exp > Date.now()) return resolve(c.token);
    const data = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const u = new URL('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }
    }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        try {
          const j = JSON.parse(b);
          if (j && j.code === 0 && j.tenant_access_token) {
            tenantCache[appId] = { token: j.tenant_access_token, exp: Date.now() + ((j.expire || 7200) * 1000) - 60000 };
            resolve(j.tenant_access_token);
          } else {
            reject(new Error((j && j.msg) || '获取飞书 token 失败'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('连接飞书超时，请检查网络或代理')); });
    req.write(data);
    req.end();
  });
}

function feishuApi(method, pathname, token, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL('https://open.feishu.cn' + pathname);
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' };
    let data = null;
    if (body) { data = JSON.stringify(body); headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ method: method, hostname: u.hostname, path: u.pathname + u.search, headers: headers }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(b)); } catch (e) { resolve({ code: -1, msg: b || '飞书无返回' }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('请求飞书接口超时，请检查网络或代理')); });
    if (data) req.write(data);
    req.end();
  });
}

// 上传素材到飞书多维表格（multipart），返回 file_token
// parentType: bitable_image(图片) / bitable_file(附件，如 PDF)；mime: 文件 Content-Type
function feishuUploadMedia(token, appToken, fileName, buf, parentType, mime) {
  parentType = parentType || 'bitable_image';
  mime = mime || 'image/jpeg';
  return new Promise(function (resolve, reject) {
    const boundary = '----kb' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const parts = [];
    function field(name, value) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n', 'utf8'));
    }
    field('file_name', fileName);
    field('parent_type', parentType);
    field('parent_node', appToken);
    field('size', String(buf.length));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: ' + mime + '\r\n\r\n', 'utf8'));
    parts.push(buf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
    const body = Buffer.concat(parts);
    const u = new URL('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all');
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        try {
          const j = JSON.parse(b);
          if (j && j.code === 0 && j.data && j.data.file_token) resolve(j.data.file_token);
          else reject(new Error((j && j.msg) || '上传素材失败'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('上传素材超时')); });
    req.write(body);
    req.end();
  });
}

function handleRequest(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 安全：纯本地模式下只接受本地来源。若请求带 Origin 且非本机地址，直接拒绝，
  // 防止用户开着应用时，浏览器里其他网页借本服务（内置飞书密钥）读写知识库。
  const origin = (req.headers.origin || '').trim();
  const isLocalOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (origin && !isLocalOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 1, msg: 'Forbidden' }));
    return;
  }
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 飞书 token 预热：应用启动时调用，提前拿好 tenant_access_token，减少首次打开共享页的等待
  if (method === 'POST' && urlPath === '/feishu/warmup') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', function () {
      let o;
      try { o = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { code: 1, msg: '请求格式错误' }); }
      const appId = FEISHU_APP_ID, appSecret = FEISHU_APP_SECRET;
      if (!appId || !appSecret) return json(res, 400, { code: 1, msg: '缺少飞书应用配置' });
      feishuToken(appId, appSecret).then(function () {
        json(res, 200, { code: 0, msg: 'ok' });
      }).catch(function (e) { json(res, 502, { code: 1, msg: e.message || String(e) }); });
    });
    return;
  }

  // 飞书多维表格代理（读列表 / 写记录）
  if (method === 'POST' && urlPath === '/feishu/bitable') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', function () {
      let o;
      try { o = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { code: 1, msg: '请求格式错误' }); }
      const appId = FEISHU_APP_ID, appSecret = FEISHU_APP_SECRET;
      const appToken = String(o.app_token || ''), tableId = String(o.table_id || '');
      const needTable = (o.op !== 'list_tables' && o.op !== 'create_table');
      if (!appId || !appSecret || !appToken) return json(res, 400, { code: 1, msg: '缺少飞书应用配置' });
      if (needTable && !tableId) return json(res, 400, { code: 1, msg: '缺少 table_id' });
      if (!/^[A-Za-z0-9_-]+$/.test(appToken)) return json(res, 400, { code: 1, msg: 'app_token 不合法' });
      if (needTable && !/^[A-Za-z0-9_-]+$/.test(tableId)) return json(res, 400, { code: 1, msg: 'table_id 不合法' });
      feishuToken(appId, appSecret).then(function (token) {
        const base = '/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records';
        let method2, path2, body2;
        if (o.op === 'list') { method2 = 'GET'; path2 = base + '?page_size=500'; body2 = null; }
        else if (o.op === 'create') { method2 = 'POST'; path2 = base; body2 = { fields: o.fields || {} }; }
        else if (o.op === 'update') {
          const rid = String(o.record_id || '');
          if (!/^[A-Za-z0-9_-]+$/.test(rid)) return json(res, 400, { code: 1, msg: 'record_id 不合法' });
          method2 = 'PUT'; path2 = base + '/' + rid; body2 = { fields: o.fields || {} };
        }
        else if (o.op === 'delete') {
          const rid = String(o.record_id || '');
          if (!/^[A-Za-z0-9_-]+$/.test(rid)) return json(res, 400, { code: 1, msg: 'record_id 不合法' });
          method2 = 'DELETE'; path2 = base + '/' + rid; body2 = null;
        }
        else if (o.op === 'list_fields') { method2 = 'GET'; path2 = '/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields?page_size=200'; body2 = null; }
        else if (o.op === 'create_field') {
          const fn = String(o.field_name || '').trim();
          if (!fn) return json(res, 400, { code: 1, msg: '缺少字段名' });
          method2 = 'POST'; path2 = '/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields';
          body2 = { field_name: fn, type: Number(o.type || 17) };
        }
        else if (o.op === 'list_tables') { method2 = 'GET'; path2 = '/open-apis/bitable/v1/apps/' + appToken + '/tables?page_size=200'; body2 = null; }
        else if (o.op === 'create_table') {
          const tn = String(o.table_name || '').trim();
          if (!tn) return json(res, 400, { code: 1, msg: '缺少表名' });
          method2 = 'POST'; path2 = '/open-apis/bitable/v1/apps/' + appToken + '/tables';
          body2 = { table: { name: tn, default_view_name: '表格', fields: (Array.isArray(o.fields) ? o.fields : [{ field_name: '名字', type: 1 }, { field_name: '学号', type: 1 }]) } };
        }
        else return json(res, 400, { code: 1, msg: '未知操作' });
        return feishuApi(method2, path2, token, body2).then(function (r) {
        if (r && r.code === 0) json(res, 200, r);
        else json(res, 502, { code: (r && r.code) || 1, msg: (r && r.msg) || '飞书返回异常', detail: (r && r.data) || null });
        });
      }).catch(function (e) { json(res, 502, { code: 1, msg: e.message || String(e) }); });
    });
    return;
  }

  // 飞书素材上传（图片 base64 → file_token）
  if (method === 'POST' && urlPath === '/feishu/upload') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 15 * 1024 * 1024) req.destroy(); });
    req.on('end', function () {
      let o;
      try { o = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { code: 1, msg: '请求格式错误' }); }
      const appId = FEISHU_APP_ID, appSecret = FEISHU_APP_SECRET;
      const appToken = String(o.app_token || ''), image = String(o.image || ''), fileName = String(o.file_name || 'image.jpg');
      if (!appId || !appSecret || !appToken || !image) return json(res, 400, { code: 1, msg: '缺少参数' });
      if (!/^[A-Za-z0-9_-]+$/.test(appToken)) return json(res, 400, { code: 1, msg: 'app_token 不合法' });
      let buf;
      const m = image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
      if (m) buf = Buffer.from(m[1], 'base64');
      else buf = Buffer.from(image, 'base64');
      if (!buf.length) return json(res, 400, { code: 1, msg: '图片数据为空' });
      const safeName = fileName.replace(/[^\w.\-]/g, '_').slice(0, 80);
      feishuToken(appId, appSecret).then(function (token) {
        return feishuUploadMedia(token, appToken, safeName, buf);
      }).then(function (fileToken) {
        json(res, 200, { code: 0, file_token: fileToken });
      }).catch(function (e) { json(res, 502, { code: 1, msg: e.message || String(e) }); });
    });
    return;
  }

  // 飞书附件上传（PDF 等文件 base64 → file_token，用于组内资料共享）
  if (method === 'POST' && urlPath === '/feishu/upload_file') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 45 * 1024 * 1024) req.destroy(); });
    req.on('end', function () {
      let o;
      try { o = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { code: 1, msg: '请求格式错误' }); }
      const appId = FEISHU_APP_ID, appSecret = FEISHU_APP_SECRET;
      const appToken = String(o.app_token || ''), file = String(o.file || ''), fileName = String(o.file_name || 'file.pdf');
      const parentType = String(o.parent_type || 'bitable_file');
      const mime = String(o.mime || 'application/pdf');
      if (!appId || !appSecret || !appToken || !file) return json(res, 400, { code: 1, msg: '缺少参数' });
      if (!/^[A-Za-z0-9_-]+$/.test(appToken)) return json(res, 400, { code: 1, msg: 'app_token 不合法' });
      if (parentType !== 'bitable_file' && parentType !== 'bitable_image') return json(res, 400, { code: 1, msg: 'parent_type 不合法' });
      let buf;
      const m = file.match(/^data:[^;]+;base64,(.+)$/);
      if (m) buf = Buffer.from(m[1], 'base64');
      else buf = Buffer.from(file, 'base64');
      if (!buf.length) return json(res, 400, { code: 1, msg: '文件数据为空' });
      // 保留中文文件名，仅清理路径分隔等危险字符
      const safeName = (fileName.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'file.pdf');
      feishuToken(appId, appSecret).then(function (token) {
        return feishuUploadMedia(token, appToken, safeName, buf, parentType, mime);
      }).then(function (fileToken) {
        json(res, 200, { code: 0, file_token: fileToken });
      }).catch(function (e) { json(res, 502, { code: 1, msg: e.message || String(e) }); });
    });
    return;
  }

  // 飞书附件下载代理（file_token 或完整 url → 二进制，图片供 <img> 显示，文件加 download=1 强制下载）
  if (urlPath === '/feishu/media') {
    let ft = '', appId = '', appSecret = '', mediaUrl = '', download = '', fileName = '';
    try {
      const u = new URL('http://127.0.0.1' + (req.url || '/'));
      ft = u.searchParams.get('file_token') || '';
      appId = FEISHU_APP_ID;
      appSecret = FEISHU_APP_SECRET;
      mediaUrl = u.searchParams.get('url') || '';
      download = u.searchParams.get('download') || '';
      fileName = u.searchParams.get('name') || '';
    } catch (e) { return json(res, 400, { code: 1, msg: '参数错误' }); }
    if (!appId || !appSecret) return json(res, 400, { code: 1, msg: '缺少参数' });
    // 目标路径：优先用飞书返回的完整 url（含 extra 鉴权参数），否则用 file_token 拼
    let target;
    if (mediaUrl) {
      try {
        const mu = new URL(mediaUrl);
        if (mu.hostname !== 'open.feishu.cn') return json(res, 400, { code: 1, msg: 'url 不合法' });
        target = mu.pathname + mu.search;
      } catch (e) { return json(res, 400, { code: 1, msg: 'url 不合法' }); }
    } else if (ft) {
      if (!/^[A-Za-z0-9_-]+$/.test(ft)) return json(res, 400, { code: 1, msg: 'file_token 不合法' });
      target = '/open-apis/drive/v1/medias/' + ft + '/download';
    } else {
      return json(res, 400, { code: 1, msg: '缺少参数' });
    }
    feishuToken(appId, appSecret).then(function (token) {
      return new Promise(function (resolve, reject) {
        const r2 = https.request({
          method: 'GET', hostname: 'open.feishu.cn', path: target,
          headers: { 'Authorization': 'Bearer ' + token }
        }, function (rsp) {
          if (rsp.statusCode < 200 || rsp.statusCode >= 300) {
            rsp.resume();
            return reject(new Error('下载附件失败：HTTP ' + rsp.statusCode));
          }
          const dlHeaders = { 'Content-Type': rsp.headers['content-type'] || 'application/octet-stream', 'Cache-Control': 'no-store' };
          if (download === '1') {
            const dn = fileName ? fileName.replace(/[\\/:*?"<>|\r\n]/g, '_') : 'download';
            dlHeaders['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(dn);
          }
          res.writeHead(200, dlHeaders);
          rsp.on('data', function (c) { res.write(c); });
          rsp.on('end', function () { res.end(); resolve(); });
        });
        r2.on('error', reject);
        r2.setTimeout(30000, function () { r2.destroy(new Error('下载附件超时')); });
        r2.end();
      });
    }).catch(function (e) { json(res, 502, { code: 1, msg: e.message || String(e) }); });
    return;
  }

  // 静态文件服务
  let filePath = urlPath;
  if (filePath === '/') filePath = '/index.html';
  const full = path.join(root, filePath);
  if (!full.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function start(p) {
  return new Promise(function (resolve, reject) {
    const srv = http.createServer(handleRequest);
    srv.once('error', function (err) {
      if (err.code === 'EADDRINUSE') { resolve('busy'); }
      else { reject(err); }
    });
    srv.listen(p, '127.0.0.1', function () {
      console.log('KB 工作台本地服务已启动：http://127.0.0.1:' + p);
      resolve('ok');
    });
  });
}

module.exports = { start: start };

if (require.main === module) {
  start(port);
}
