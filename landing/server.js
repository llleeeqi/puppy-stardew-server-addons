const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8080;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'changeme';
const VNC_PASSWORD = process.env.VNC_PASSWORD || 'changeme';
const SERVER_IP = process.env.SERVER_IP || '127.0.0.1';
const PANEL_PORT = process.env.PANEL_PORT || '18642';
const VNC_HOST = process.env.VNC_HOST || process.env.VNC_PUBLIC_IP || 'localhost';
const VNC_PORT = process.env.VNC_WEB_PORT || '43000';
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/data/backups';
const SAVES_DIR = process.env.SAVES_DIR || '/data/saves';
const MODS_DIR = process.env.MODS_DIR || '/data/custom-mods';
const BACKUP_CONFIG_PATH = process.env.BACKUP_CONFIG || '/data/backup-config.json';
const SYNC_STATE_PATH = path.join(path.dirname(BACKUP_CONFIG_PATH), 'sync-state.json');
const RETRY_INTERVAL = 3000;
const SESSION_TTL = 86400000;

const PUBLIC = path.join(__dirname, 'public');
const sessions = new Map();
const rateLimits = new Map();
const syncedFiles = new Set();

// ─── Util ────────────────────────────────────────────────────────

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=86400`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; Max-Age=0`);
}

function parseCookies(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return {};
  return cookie.split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    acc[k] = v;
    return acc;
  }, {});
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function validateSession(token) {
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const lastAttempt = rateLimits.get(ip) || 0;
  return now - lastAttempt >= RETRY_INTERVAL;
}

function updateRateLimit(ip) {
  rateLimits.set(ip, Date.now());
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─── Backup Config ───────────────────────────────────────────────

function loadBackupConfig() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP_CONFIG_PATH, 'utf-8'));
  } catch { return { type: 'none', keep: 20 }; }
}

function saveBackupConfig(data) {
  const dir = path.dirname(BACKUP_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(data, null, 2));
}

function loadSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf-8'));
  } catch { return { synced: [] }; }
}

function saveSyncState(state) {
  const dir = path.dirname(SYNC_STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Backup Upload ───────────────────────────────────────────────

function uploadToWebDAV(filePath, remotePath, config, callback) {
  const { url, username, password } = config;
  const dest = `${url.replace(/\/+$/, '')}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
  const auth = username ? `-u "${username}:${password}"` : '';
  exec(`curl -s -T "${filePath}" ${auth} "${dest}"`, { timeout: 300000 }, (err) => callback(err));
}

function uploadFile(filePath, remotePath, config, callback) {
  if (config.type === 'webdav') uploadToWebDAV(filePath, remotePath, config.webdav, callback);
  else callback(null);
}

function removeRemote(remotePath, config) {
  const { url, username, password } = config;
  if (!url) return;
  const dest = `${url.replace(/\/+$/, '')}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
  const auth = username ? `-u "${username}:${password}"` : '';
  exec(`curl -s -X DELETE ${auth} "${dest}"`);
}

function getModsTotalSize() {
  if (!fs.existsSync(MODS_DIR)) return 0;
  let total = 0;
  try {
    const files = fs.readdirSync(MODS_DIR);
    files.forEach(f => {
      if (f.endsWith('.zip')) {
        try { total += fs.statSync(path.join(MODS_DIR, f)).size; } catch {}
      }
    });
  } catch {}
  return total;
}

function checkModsAndBackup(config, cb) {
  const currentSize = getModsTotalSize();
  const state = loadSyncState();
  const lastSize = state.mods_last_size || 0;
  if (currentSize === lastSize) { if (cb) cb(false); return; }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const zipName = `mods-backup-${stamp}.zip`;
  const zipPath = `/tmp/${zipName}`;

  exec(`zip -r "${zipPath}" . 2>/dev/null`, { cwd: MODS_DIR }, (zipErr) => {
    if (zipErr) { console.log('[BackupSync] ❌ mods zip failed'); if (cb) cb(true); return; }
    uploadFile(zipPath, `mods/${zipName}`, config, (upErr) => {
      try { fs.unlinkSync(zipPath); } catch {}
      if (upErr) { console.log(`[BackupSync] ❌ mods backup upload failed: ${upErr.message}`); if (cb) cb(true); return; }
      console.log(`[BackupSync] ✓ mods backup uploaded (size changed: ${lastSize} → ${currentSize})`);
      const newState = loadSyncState();
      newState.mods_last_size = currentSize;
      if (!newState.history) newState.history = {};
      if (!newState.history.mods) newState.history.mods = [];
      newState.history.mods.push(tarName);
      const keep = config.keep || 20;
      const all = newState.history.mods.sort();
      if (all.length > keep) {
        newState.history.mods = all.slice(all.length - keep);
        all.slice(0, all.length - keep).forEach(f => removeRemote(`mods/${f}`, config.webdav));
      }
      saveSyncState(newState);
      if (cb) cb(false);
    });
  });
}

function syncBackup(filePath, remoteFolder) {
  const config = loadBackupConfig();
  if (!config.type || config.type === 'none') return;

  const fileName = path.basename(filePath);
  const remotePath = remoteFolder ? `${remoteFolder}/${fileName}` : fileName;

  uploadFile(filePath, remotePath, config, (err) => {
    if (err) {
      console.log(`[BackupSync] ❌ ${remotePath} sync failed: ${err.message}`);
    } else {
      console.log(`[BackupSync] ✓ ${remotePath} synced`);
      const state = loadSyncState();
      if (!state.history) state.history = {};
      if (!state.history[remoteFolder]) state.history[remoteFolder] = [];
      state.history[remoteFolder].push(fileName);
      const keep = config.keep || 20;
      const all = state.history[remoteFolder].sort();
      if (all.length > keep) {
        state.history[remoteFolder] = all.slice(all.length - keep);
        all.slice(0, all.length - keep).forEach(f => removeRemote(`${remoteFolder}/${f}`, config.webdav));
      }
      saveSyncState(state);

      // 面板备份同步成功后，顺便检查 mod 目录是否有变化
      checkModsAndBackup(config);
    }
  });
}

function startBackupWatcher() {
  try {
    const state = loadSyncState();
    if (!state.history) state.history = {};

    if (fs.existsSync(BACKUPS_DIR)) {
      fs.watch(BACKUPS_DIR, (eventType, fileName) => {
        if (!fileName || !fileName.endsWith('.tar.gz') && !fileName.endsWith('.zip')) return;
        if (eventType !== 'rename') return;
        setTimeout(() => {
          const fp = path.join(BACKUPS_DIR, fileName);
          if (fs.existsSync(fp)) syncBackup(fp, 'archives');
        }, 3000);
      });
      console.log(`[BackupSync] Watching ${BACKUPS_DIR}`);
    } else console.log(`[BackupSync] Skip: ${BACKUPS_DIR} not found`);
  } catch (e) {
    console.log(`[BackupSync] Error: ${e.message}`);
  }
}

startBackupWatcher();

// ─── HTTP Server ─────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const cookies = parseCookies(req);

  // API: login
  if (req.method === 'POST' && pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const ip = getClientIp(req);
        if (!checkRateLimit(ip)) { sendJson(res, 429, { error: 'try_again', message: '请等待后重试' }); return; }
        updateRateLimit(ip);
        if (data.password !== LOGIN_PASSWORD) { sendJson(res, 401, { error: 'invalid', message: '密码错误' }); return; }
        const token = generateToken();
        sessions.set(token, { created: Date.now() });
        setSessionCookie(res, token);
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { error: 'bad_request' }); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    if (cookies.session) sessions.delete(cookies.session);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/status') {
    sendJson(res, 200, { authed: validateSession(cookies.session) });
    return;
  }

  // Auth wall for all remaining /api/ routes
  if (!validateSession(cookies.session)) {
    if (pathname.startsWith('/api/')) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    serveStatic(res, path.join(PUBLIC, 'login.html'));
    return;
  }

  // API: public config (server IP, panel URL etc)
  if (pathname === '/api/config') {
    sendJson(res, 200, {
      serverIp: SERVER_IP,
      panelUrl: `http://${SERVER_IP}:${PANEL_PORT}`,
      vncUrl: `http://${SERVER_IP}:${VNC_PORT}`,
    });
    return;
  }

  // API: VNC redirect
  if (pathname === '/api/vnc-open') {
    const target = `/vnc.html?autoconnect=true&password=${encodeURIComponent(VNC_PASSWORD)}&host=${VNC_HOST}&port=${VNC_PORT}`;
    res.writeHead(302, { Location: `http://${VNC_HOST}:${VNC_PORT}${target}` });
    res.end();
    return;
  }

  // API: backup config GET
  if (pathname === '/api/backup/config' && req.method === 'GET') {
    const cfg = loadBackupConfig();
    // 不返回密钥明文给前端
    const safe = { ...cfg };
    if (safe.s3) { safe.s3 = { ...safe.s3, accessKey: safe.s3.accessKey ? '****' : '' }; if (safe.s3.secretKey) safe.s3.secretKey = '****'; }
    if (safe.webdav) { safe.webdav = { ...safe.webdav, password: safe.webdav.password ? '****' : '' }; }
    sendJson(res, 200, safe);
    return;
  }

  // API: backup config PUT
  if (pathname === '/api/backup/config' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const existing = loadBackupConfig();
        // 如果密码字段是 **** 就保留旧值
        if (data.s3) {
          if (data.s3.secretKey === '****') data.s3.secretKey = (existing.s3 && existing.s3.secretKey) || '';
          if (data.s3.accessKey === '****') data.s3.accessKey = (existing.s3 && existing.s3.accessKey) || '';
        }
        if (data.webdav) {
          if (data.webdav.password === '****') data.webdav.password = (existing.webdav && existing.webdav.password) || '';
        }
        saveBackupConfig(data);
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { error: 'bad_request' }); }
    });
    return;
  }

  // API: backup file list
  if (pathname === '/api/backup/files' && req.method === 'GET') {
    const state = loadSyncState();
    sendJson(res, 200, state.history || {});
    return;
  }

  // API: backup test
  if (pathname === '/api/backup/test' && req.method === 'POST') {
    const config = loadBackupConfig();
    if (config.type === 'none' || !config.type) { sendJson(res, 400, { error: '未配置备份目标' }); return; }
    const testFile = '/tmp/.puppy-backup-test';
    fs.writeFileSync(testFile, 'test');
    const cb = (err) => {
      try { fs.unlinkSync(testFile); } catch {}
      if (err) sendJson(res, 500, { error: `连接失败: ${err.message}` });
      else sendJson(res, 200, { ok: true });
    };
    if (config.type === 'webdav') uploadToWebDAV(testFile, '.puppy-backup-test', config.webdav, cb);
    else sendJson(res, 400, { error: '未知类型' });
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/panel.html') {
    serveStatic(res, path.join(PUBLIC, 'panel.html'));
    return;
  }

  const filePath = path.join(PUBLIC, pathname === '/' ? 'panel.html' : pathname);
  serveStatic(res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Landing] Server running on port ${PORT}`);
});
