const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8080;
const LOGIN_PASSWORD = 'llleeeqi';
const VNC_PASSWORD = 'llleeeqi';
const VNC_HOST = process.env.VNC_HOST || process.env.VNC_PUBLIC_IP || 'localhost';
const VNC_PORT = process.env.VNC_WEB_PORT || '43000';
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/data/backups';
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

function uploadToS3(filePath, fileName, config, callback) {
  const { endpoint, bucket, region, accessKey, secretKey, path: prefix } = config;
  const aliasName = 'puppybackup';
  const destPath = prefix ? `${prefix}/${fileName}` : fileName;
  const cmds = [
    `mc alias set ${aliasName} ${endpoint} ${accessKey} ${secretKey} --api S3v4 > /dev/null 2>&1`,
    `mc cp "${filePath}" ${aliasName}/${bucket}/${destPath} > /dev/null 2>&1`,
  ];
  exec(cmds.join(' && '), { timeout: 300000 }, (err) => callback(err));
}

function uploadToWebDAV(filePath, fileName, config, callback) {
  const { url, username, password } = config;
  const dest = `${url.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`;
  const auth = username ? `-u "${username}:${password}"` : '';
  exec(`curl -s -T "${filePath}" ${auth} "${dest}"`, { timeout: 300000 }, (err) => callback(err));
}

function syncBackup(filePath) {
  const config = loadBackupConfig();
  if (!config.type || config.type === 'none') return;

  const fileName = path.basename(filePath);
  const cb = (err) => {
    if (err) {
      console.log(`[BackupSync] ❌ ${fileName} sync failed: ${err.message}`);
    } else {
      console.log(`[BackupSync] ✓ ${fileName} synced`);
      const state = loadSyncState();
      state.synced.push(fileName);
      saveSyncState(state);
      // 清理远程多余备份（保留 config.keep 份）
      const all = state.synced.sort();
      if (all.length > config.keep) {
        const toRemove = all.slice(0, all.length - config.keep);
        state.synced = all.slice(all.length - config.keep);
        saveSyncState(state);
        toRemove.forEach(f => {
          if (config.type === 's3') {
            const { endpoint, bucket, region, accessKey, secretKey, path: prefix } = config;
            const aliasName = 'puppybackup';
            const destPath = prefix ? `${prefix}/${f}` : f;
            exec(`mc alias set ${aliasName} ${endpoint} ${accessKey} ${secretKey} --api S3v4 > /dev/null 2>&1 && mc rm ${aliasName}/${bucket}/${destPath} > /dev/null 2>&1`);
          } else if (config.type === 'webdav') {
            const { url, username, password } = config;
            const dest = `${url.replace(/\/+$/, '')}/${encodeURIComponent(f)}`;
            const auth = username ? `-u "${username}:${password}"` : '';
            exec(`curl -s -X DELETE ${auth} "${dest}"`);
          }
        });
      }
    }
  };

  switch (config.type) {
    case 's3': uploadToS3(filePath, fileName, config, cb); break;
    case 'webdav': uploadToWebDAV(filePath, fileName, config, cb); break;
  }
}

// ─── Backup Watcher ──────────────────────────────────────────────

function startBackupWatcher() {
  const state = loadSyncState();
  state.synced.forEach(f => syncedFiles.add(f));

  // Watch directory
  if (fs.existsSync(BACKUPS_DIR)) {
    fs.watch(BACKUPS_DIR, (eventType, fileName) => {
      if (!fileName || !fileName.endsWith('.tar.gz') && !fileName.endsWith('.zip')) return;
      if (eventType !== 'rename') return;
      // 延迟等文件写完
      setTimeout(() => {
        const filePath = path.join(BACKUPS_DIR, fileName);
        if (fs.existsSync(filePath) && !syncedFiles.has(fileName)) {
          syncedFiles.add(fileName);
          syncBackup(filePath);
        }
      }, 3000);
    });
    console.log(`[BackupSync] Watching ${BACKUPS_DIR}`);
  } else {
    console.log(`[BackupSync] Backup dir not found: ${BACKUPS_DIR}, watcher disabled`);
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

  // API: backup test
  if (pathname === '/api/backup/test' && req.method === 'POST') {
    const config = loadBackupConfig();
    if (config.type === 'none' || !config.type) { sendJson(res, 400, { error: '未配置备份目标' }); return; }
    const testFile = path.join(BACKUPS_DIR, '.puppy-backup-test');
    fs.writeFileSync(testFile, 'test');
    const cb = (err) => {
      try { fs.unlinkSync(testFile); } catch {}
      if (err) sendJson(res, 500, { error: `连接失败: ${err.message}` });
      else sendJson(res, 200, { ok: true });
    };
    switch (config.type) {
      case 's3': uploadToS3(testFile, '.puppy-backup-test', config, cb); break;
      case 'webdav': uploadToWebDAV(testFile, '.puppy-backup-test', config, cb); break;
      default: sendJson(res, 400, { error: '未知类型' });
    }
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
