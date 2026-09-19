const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const isInsecureSecret = !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.trim() === '' ||
  process.env.JWT_SECRET === 'cloudvturb_ultra_secret_key_2026_jwt_token_99' ||
  process.env.JWT_SECRET === 'cloudvturb_dev_secret_key_2026';

if (NODE_ENV === 'production' && isInsecureSecret) {
  console.error('ERRO FATAL: JWT_SECRET seguro deve ser configurado via variável de ambiente em produção.');
  process.exit(1);
}

const SERVER_STORAGE_LIMIT_BYTES = 30 * 1024 * 1024 * 1024;
const MEMBER_STORAGE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_STORAGE_BYTES = SERVER_STORAGE_LIMIT_BYTES;
const APP_NAME = process.env.APP_NAME || 'CloudVTurb';
const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'roleta-sorte.online').toLowerCase();
const PLAYER_DOMAIN = (process.env.PLAYER_DOMAIN || `player.${BASE_DOMAIN}`).toLowerCase();
const DASH_DOMAIN = (process.env.DASH_DOMAIN || `dash.${BASE_DOMAIN}`).toLowerCase();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, 'videos');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cloudvturb.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    status TEXT DEFAULT 'pending',
    full_name TEXT,
    country TEXT,
    phone TEXT,
    address_street TEXT,
    postal_code TEXT,
    state_province TEXT,
    onboarding_completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    folder_id TEXT,
    title TEXT NOT NULL,
    source_type TEXT DEFAULT 'remote',
    file_path TEXT,
    video_url TEXT NOT NULL,
    duration TEXT DEFAULT '05:00',
    file_size INTEGER DEFAULT 0,
    plays INTEGER DEFAULT 0,
    settings_json TEXT,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    milestone INTEGER,
    watch_time REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_vid_event ON analytics_events(video_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_vid_created ON analytics_events(video_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_vid_visitor ON analytics_events(video_id, visitor_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_session_milestone ON analytics_events(session_id, event_type, milestone);
`);

try {
  db.prepare(`
    UPDATE videos
    SET video_url = REPLACE(video_url, 'https://roleta-sorte.online/videos/', 'https://' || ? || '/videos/')
    WHERE video_url LIKE '%roleta-sorte.online/videos/%'
  `).run(PLAYER_DOMAIN);
} catch (e) {}

const userCols = ['full_name', 'country', 'phone', 'address_street', 'postal_code', 'state_province'];
for (const col of userCols) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch (e) {}
}
try { db.exec("ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN file_size INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN folder_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE videos ADD COLUMN deleted_at DATETIME DEFAULT NULL"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted_at)"); } catch (e) {}

try {
  db.prepare("UPDATE users SET onboarding_completed = 1 WHERE role = 'owner' OR onboarding_completed IS NULL").run();
} catch (e) {}

try {
  const localVids = db.prepare("SELECT id, file_path, file_size FROM videos WHERE source_type = 'local'").all();
  for (const v of localVids) {
    if (v.file_path && fs.existsSync(v.file_path)) {
      try {
        const realSize = fs.statSync(v.file_path).size;
        if (!v.file_size || v.file_size !== realSize) {
          db.prepare("UPDATE videos SET file_size = ? WHERE id = ?").run(realSize, v.id);
        }
      } catch (err) {}
    }
  }
} catch (e) {}

const getSetting = (key, defaultVal) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
};

const setSetting = (key, value) => {
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, String(value), String(value));
};

if (!getSetting('require_approval', null)) {
  setSetting('require_approval', '1');
}

const rawAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || NODE_ENV !== 'production' || rawAllowedOrigins.length === 0 || rawAllowedOrigins.includes('*')) {
      return callback(null, true);
    }
    const cleanOrigin = origin.toLowerCase().replace(/\/$/, '');
    const internalOrigins = [
      `https://${PLAYER_DOMAIN}`,
      `https://${DASH_DOMAIN}`,
      `https://${BASE_DOMAIN}`,
      `http://${PLAYER_DOMAIN}`,
      `http://${DASH_DOMAIN}`,
      `http://${BASE_DOMAIN}`
    ];
    if (internalOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }
    const isAllowed = rawAllowedOrigins.some(allowed => {
      if (allowed === '*' || cleanOrigin === allowed) return true;
      if (allowed.startsWith('*.') && cleanOrigin.endsWith(allowed.slice(1))) return true;
      return false;
    });
    return callback(null, isAllowed);
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  if (host === PLAYER_DOMAIN || host.startsWith('player.')) {
    if (req.path.startsWith('/videos/') || req.path.startsWith('/api/')) {
      return next();
    }
    if (
      req.path === '/player' ||
      req.path === '/player.html' ||
      req.path === '/' ||
      req.path === '' ||
      req.path.startsWith('/embed/') ||
      req.path.startsWith('/v/') ||
      /^\/vsl_[a-zA-Z0-9_-]+$/.test(req.path)
    ) {
      return res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
    }
  }

  if (host === BASE_DOMAIN || host === 'www.' + BASE_DOMAIN) {
    if (req.path === '/login') {
      return res.redirect(301, `https://${DASH_DOMAIN}/login`);
    }
    if (req.path === '/cadastro') {
      return res.redirect(301, `https://${DASH_DOMAIN}/cadastro`);
    }
    if (req.path === '/' || req.path === '/index.html' || req.path === '') {
      return res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
    }
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/videos/')) {
      return res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
    }
  }

  const dashRoutes = ['/', '/login', '/cadastro', '/videos', '/metricas', '/usuarios', '/servidor', '/analytics'];
  if (dashRoutes.includes(req.path)) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  if (req.path === '/player' || req.path.startsWith('/embed/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
  }

  next();
});

app.use(express.static(PUBLIC_DIR));

function getUsedStorageBytes() {
  try {
    let total = 0;
    const files = fs.readdirSync(VIDEOS_DIR);
    for (const f of files) {
      const stat = fs.statSync(path.join(VIDEOS_DIR, f));
      if (stat.isFile()) total += stat.size;
    }
    return total;
  } catch (e) {
    return 0;
  }
}

function getUserStorageBytes(userId) {
  try {
    const row = db.prepare("SELECT COALESCE(SUM(file_size), 0) as total FROM videos WHERE user_id = ? AND source_type = 'local'").get(userId);
    return row ? row.total : 0;
  } catch (e) {
    return 0;
  }
}

function formatStorage(bytes) {
  const mb = bytes / (1024 * 1024);
  const gb = bytes / (1024 * 1024 * 1024);
  if (bytes >= 1024 * 1024 * 1024) {
    return `${gb.toFixed(1).replace('.', ',')} GB`;
  }
  return `${mb.toFixed(0)} MB`;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, role, status, full_name, country, phone, address_street, postal_code, state_province, onboarding_completed FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'Acesso bloqueado ou pendente de aprovação.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada ou inválida.' });
  }
}

function ownerMiddleware(req, res, next) {
  if (req.user && req.user.role === 'owner') {
    next();
  } else {
    res.status(403).json({ error: 'Acesso restrito ao Owner.' });
  }
}

const ALLOWED_MIME_TYPES = ['video/mp4', 'video/webm'];
const ALLOWED_EXTS = ['.mp4', '.webm'];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, VIDEOS_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const uniqueName = 'vsl_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTS.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Formato inválido. Apenas vídeos MP4 e WebM são aceitos.'));
    }
    cb(null, true);
  }
});

function checkStorageQuotaPre(req, res, next) {
  const incomingLength = parseInt(req.headers['content-length'] || '0', 10);
  const isOwner = req.user && req.user.role === 'owner';
  if (!isOwner) {
    const userUsed = getUserStorageBytes(req.user ? req.user.id : 0);
    if (userUsed + incomingLength > MEMBER_STORAGE_LIMIT_BYTES) {
      return res.status(400).json({ error: 'Cota individual de 3 GB atingida. Remova vídeos para liberar espaço.' });
    }
  }
  const currentUsed = getUsedStorageBytes();
  if (currentUsed + incomingLength > SERVER_STORAGE_LIMIT_BYTES) {
    return res.status(400).json({ error: 'Capacidade do servidor temporariamente esgotada.' });
  }
  next();
}

app.get('/api/config', (req, res) => {
  const host = req.get('host') || '';
  const isProd = host.includes(BASE_DOMAIN);
  const playerDomain = isProd ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${host}`;
  res.json({
    appName: APP_NAME,
    baseDomain: BASE_DOMAIN,
    playerDomain: playerDomain,
    dashDomain: isProd ? `https://${DASH_DOMAIN}` : `${req.protocol}://${host}`
  });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos.' });

  const cleanEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const passwordHash = bcrypt.hashSync(password, 10);

  if (userCount === 0) {
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status)
      VALUES (?, ?, ?, 'owner', 'approved')
    `).run(name.trim(), cleanEmail, passwordHash);

    const token = jwt.sign({ id: info.lastInsertRowid, email: cleanEmail, role: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true,
      message: 'Conta de Administrador criada com sucesso!',
      token,
      user: { id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, role: 'owner', status: 'approved' }
    });
  }

  const requireApproval = getSetting('require_approval', '1') === '1';
  const initialStatus = requireApproval ? 'pending' : 'approved';

  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, status)
    VALUES (?, ?, ?, 'member', ?)
  `).run(name.trim(), cleanEmail, passwordHash, initialStatus);

  if (initialStatus === 'pending') {
    return res.json({
      success: true,
      pendingApproval: true,
      message: 'Cadastro realizado! Aguarde a aprovação do Administrador para acessar a plataforma.'
    });
  } else {
    const token = jwt.sign({ id: info.lastInsertRowid, email: cleanEmail, role: 'member' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true,
      pendingApproval: false,
      token,
      user: { id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, role: 'member', status: 'approved' }
    });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha.' });

  const cleanEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Sua conta está aguardando aprovação do Administrador.' });
  }
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'Sua conta foi desativada pelo Administrador.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      full_name: user.full_name,
      country: user.country,
      phone: user.phone,
      address_street: user.address_street,
      postal_code: user.postal_code,
      state_province: user.state_province,
      onboarding_completed: Boolean(user.onboarding_completed)
    }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/onboarding/status', authMiddleware, (req, res) => {
  res.json({
    onboardingCompleted: Boolean(req.user.onboarding_completed),
    user: req.user
  });
});

app.post('/api/onboarding/profile', authMiddleware, (req, res) => {
  const { fullName, country, phone, addressStreet, postalCode, stateProvince } = req.body || {};

  if (!fullName || !country || !phone || !addressStreet || !postalCode || !stateProvince) {
    return res.status(400).json({ error: 'Todos os campos de endereço e contato são obrigatórios.' });
  }

  db.prepare(`
    UPDATE users SET
      full_name = ?,
      country = ?,
      phone = ?,
      address_street = ?,
      postal_code = ?,
      state_province = ?,
      onboarding_completed = 1
    WHERE id = ?
  `).run(
    String(fullName).trim().slice(0, 150),
    String(country).trim().slice(0, 80),
    String(phone).trim().slice(0, 40),
    String(addressStreet).trim().slice(0, 200),
    String(postalCode).trim().slice(0, 30),
    String(stateProvince).trim().slice(0, 80),
    req.user.id
  );

  const updated = db.prepare('SELECT id, name, email, role, status, full_name, country, phone, address_street, postal_code, state_province, onboarding_completed FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, user: updated });
});

app.post('/api/onboarding/complete', authMiddleware, (req, res) => {
  db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

app.get('/api/admin/users', authMiddleware, ownerMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC').all();
  const usersWithStorage = users.map(u => {
    const usedBytes = getUserStorageBytes(u.id);
    const videoCount = db.prepare('SELECT COUNT(*) as count FROM videos WHERE user_id = ?').get(u.id).count;
    return {
      ...u,
      storageBytes: usedBytes,
      storageFormatted: formatStorage(usedBytes),
      videoCount
    };
  });
  res.json({ users: usersWithStorage });
});

app.post('/api/admin/users/:id/action', authMiddleware, ownerMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { action } = req.body;

  if (targetId === req.user.id && (action === 'block' || action === 'delete')) {
    return res.status(400).json({ error: 'Você não pode alterar o status da sua própria conta.' });
  }

  if (action === 'approve') {
    db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(targetId);
  } else if (action === 'block') {
    db.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").run(targetId);
  } else if (action === 'make_owner') {
    db.prepare("UPDATE users SET role = 'owner', status = 'approved' WHERE id = ?").run(targetId);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  }

  res.json({ success: true });
});

app.get('/api/admin/settings', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const requireApproval = isOwner ? (getSetting('require_approval', '1') === '1') : false;

  if (isOwner) {
    const usedBytes = getUsedStorageBytes();
    const totalBytes = SERVER_STORAGE_LIMIT_BYTES;
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return res.json({
      isOwner: true,
      requireApproval,
      appName: APP_NAME,
      baseDomain: BASE_DOMAIN,
      playerDomain: PLAYER_DOMAIN,
      dashDomain: DASH_DOMAIN,
      storage: {
        usedBytes,
        totalBytes,
        usedMB: (usedBytes / (1024 * 1024)).toFixed(1),
        usedGB: (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
        formattedUsage: formatStorage(usedBytes),
        totalFormatted: '30 GB',
        totalGB: '30',
        usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1),
        isIndividual: false
      }
    });
  }

  const usedBytes = getUserStorageBytes(req.user.id);
  const totalBytes = MEMBER_STORAGE_LIMIT_BYTES;
  const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  res.json({
    isOwner: false,
    appName: APP_NAME,
    baseDomain: BASE_DOMAIN,
    playerDomain: PLAYER_DOMAIN,
    dashDomain: DASH_DOMAIN,
    storage: {
      usedBytes,
      totalBytes,
      usedMB: (usedBytes / (1024 * 1024)).toFixed(1),
      usedGB: (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
      formattedUsage: formatStorage(usedBytes),
      totalFormatted: '3 GB',
      totalGB: '3',
      usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1),
      isIndividual: true
    }
  });
});

app.post('/api/admin/settings', authMiddleware, ownerMiddleware, (req, res) => {
  const { requireApproval } = req.body;
  if (requireApproval !== undefined) {
    setSetting('require_approval', requireApproval ? '1' : '0');
  }
  res.json({ success: true });
});

app.get('/api/folders', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  let rows;
  if (isOwner) {
    rows = db.prepare(`
      SELECT f.*, COUNT(v.id) as video_count
      FROM folders f
      LEFT JOIN videos v ON v.folder_id = f.id AND v.deleted_at IS NULL
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `).all();
  } else {
    rows = db.prepare(`
      SELECT f.*, COUNT(v.id) as video_count
      FROM folders f
      LEFT JOIN videos v ON v.folder_id = f.id AND v.deleted_at IS NULL
      WHERE f.user_id = ?
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `).all(req.user.id);
  }
  res.json({ folders: rows });
});

app.post('/api/folders', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'O nome da pasta é obrigatório.' });
  }

  const cleanName = name.trim().slice(0, 80);
  const folderId = 'fld_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

  db.prepare(`
    INSERT INTO folders (id, user_id, name)
    VALUES (?, ?, ?)
  `).run(folderId, req.user.id, cleanName);

  res.json({ success: true, folder: { id: folderId, name: cleanName, user_id: req.user.id, video_count: 0 } });
});

app.put('/api/folders/:id', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Nome inválido.' });
  }

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' });
  if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  const cleanName = name.trim().slice(0, 80);
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(cleanName, req.params.id);
  res.json({ success: true, name: cleanName });
});

app.delete('/api/folders/:id', authMiddleware, (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' });
  if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET folder_id = NULL WHERE folder_id = ?').run(req.params.id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/videos', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const isTrash = req.query.trash === '1';
  const folderId = req.query.folder_id;

  let query = 'SELECT * FROM videos WHERE ';
  const params = [];

  if (isTrash) {
    query += 'deleted_at IS NOT NULL ';
  } else {
    query += 'deleted_at IS NULL ';
  }

  if (!isOwner) {
    query += 'AND user_id = ? ';
    params.push(req.user.id);
  }

  if (folderId) {
    if (folderId === 'root') {
      query += 'AND (folder_id IS NULL OR folder_id = "") ';
    } else {
      query += 'AND folder_id = ? ';
      params.push(folderId);
    }
  }

  query += 'ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  const videos = rows.map(r => ({
    ...r,
    settings: r.settings_json ? JSON.parse(r.settings_json) : {}
  }));

  res.json({ videos });
});

app.get('/api/videos/top', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  let videosQuery = 'SELECT id, title, video_url, duration, plays, created_at FROM videos WHERE deleted_at IS NULL ';
  const params = [];
  if (!isOwner) {
    videosQuery += 'AND user_id = ? ';
    params.push(req.user.id);
  }
  videosQuery += 'ORDER BY plays DESC LIMIT 20';

  const rows = db.prepare(videosQuery).all(...params);
  const topVideos = rows.map(v => {
    const ctaClicks = db.prepare("SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked'").get(v.id).count;
    const completes = db.prepare("SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND (event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))").get(v.id).count;
    const completionRate = v.plays > 0 ? ((completes / v.plays) * 100).toFixed(1) : '0.0';
    const ctaRate = v.plays > 0 ? ((ctaClicks / v.plays) * 100).toFixed(1) : '0.0';

    return {
      id: v.id,
      title: v.title,
      duration: v.duration,
      plays: v.plays || 0,
      ctaClicks,
      completes,
      completionRate,
      ctaRate,
      createdAt: v.created_at
    };
  });

  res.json({ topVideos });
});

app.post('/api/videos', authMiddleware, (req, res) => {
  const { id, title, videoUrl, sourceType, filePath, duration, settings, fileSize, folderId } = req.body;

  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ error: 'URL do vídeo é obrigatória.' });
  }

  const cleanUrl = videoUrl.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://') && !cleanUrl.startsWith('/videos/')) {
    return res.status(400).json({ error: 'URL do vídeo inválida.' });
  }

  const vidId = id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'vsl_' + Date.now();
  const cleanTitle = (title || 'Minha VSL').trim().slice(0, 150);

  let resolvedSize = 0;
  if (sourceType === 'local') {
    if (fileSize && typeof fileSize === 'number') {
      resolvedSize = fileSize;
    } else if (filePath && fs.existsSync(filePath)) {
      try { resolvedSize = fs.statSync(filePath).size; } catch (e) {}
    }
  }

  let cleanFolderId = null;
  if (folderId && folderId !== 'root') {
    const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
    if (folder && (req.user.role === 'owner' || folder.user_id === req.user.id)) {
      cleanFolderId = folder.id;
    }
  }

  db.prepare(`
    INSERT INTO videos (id, user_id, folder_id, title, source_type, file_path, file_size, video_url, duration, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vidId,
    req.user.id,
    cleanFolderId,
    cleanTitle,
    sourceType === 'local' ? 'local' : 'remote',
    filePath || null,
    resolvedSize,
    cleanUrl,
    duration || '10:00',
    JSON.stringify(settings || {})
  );

  res.json({ success: true, id: vidId });
});

app.patch('/api/videos/:id/move', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const { folderId } = req.body || {};

  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  let cleanFolderId = null;
  if (folderId && folderId !== 'root') {
    const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
    if (!folder) return res.status(404).json({ error: 'Pasta de destino não encontrada.' });
    if (req.user.role !== 'owner' && folder.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Pasta não pertence a você.' });
    }
    cleanFolderId = folder.id;
  }

  db.prepare('UPDATE videos SET folder_id = ? WHERE id = ?').run(cleanFolderId, vidId);
  res.json({ success: true, folderId: cleanFolderId });
});

app.patch('/api/videos/:id/trash', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(vidId);
  res.json({ success: true });
});

app.patch('/api/videos/:id/restore', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = NULL WHERE id = ?').run(vidId);
  res.json({ success: true });
});

app.put('/api/videos/:id', authMiddleware, (req, res) => {
  const { title, settings, duration, folderId } = req.body;
  const vidId = req.params.id;

  const existing = db.prepare('SELECT user_id FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  let cleanFolderId = existing.folder_id;
  if (folderId !== undefined) {
    if (!folderId || folderId === 'root') {
      cleanFolderId = null;
    } else {
      const folder = db.prepare('SELECT id, user_id FROM folders WHERE id = ?').get(folderId);
      if (folder && (req.user.role === 'owner' || folder.user_id === req.user.id)) {
        cleanFolderId = folder.id;
      }
    }
  }

  db.prepare(`
    UPDATE videos SET
      title = COALESCE(?, title),
      duration = COALESCE(?, duration),
      settings_json = COALESCE(?, settings_json),
      folder_id = ?
    WHERE id = ?
  `).run(
    title ? title.trim().slice(0, 150) : null,
    duration || null,
    settings ? JSON.stringify(settings) : null,
    cleanFolderId,
    vidId
  );

  res.json({ success: true });
});

app.delete('/api/videos/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(vidId);
  res.json({ success: true, movedToTrash: true });
});

app.delete('/api/videos/:id/permanent', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  if (existing.source_type === 'local' && existing.file_path && fs.existsSync(existing.file_path)) {
    try { fs.unlinkSync(existing.file_path); } catch (e) {}
  }

  db.prepare('DELETE FROM analytics_events WHERE video_id = ?').run(vidId);
  db.prepare('DELETE FROM videos WHERE id = ?').run(vidId);
  res.json({ success: true, permanentlyDeleted: true });
});

app.post('/api/videos/:id/play', (req, res) => {
  const vidId = req.params.id;
  try {
    db.prepare('UPDATE videos SET plays = plays + 1 WHERE id = ?').run(vidId);
    const updated = db.prepare('SELECT plays FROM videos WHERE id = ?').get(vidId);
    res.json({ success: true, plays: updated ? updated.plays : 1 });
  } catch (e) {
    res.json({ success: false });
  }
});

app.get('/api/videos/:id/public', (req, res) => {
  const vidId = req.params.id;
  try {
    const v = db.prepare('SELECT id, title, video_url, duration, settings_json FROM videos WHERE id = ? AND deleted_at IS NULL').get(vidId);
    if (!v) return res.status(404).json({ error: 'Vídeo não encontrado ou indisponível.' });
    let settings = {};
    try { settings = JSON.parse(v.settings_json || '{}'); } catch (e) {}

    let videoUrl = v.video_url;
    if (videoUrl && videoUrl.includes('roleta-sorte.online/videos/') && !videoUrl.includes(`${PLAYER_DOMAIN}/videos/`)) {
      videoUrl = videoUrl.replace('https://roleta-sorte.online/videos/', `https://${PLAYER_DOMAIN}/videos/`);
    }

    res.json({
      id: v.id,
      title: v.title,
      video_url: videoUrl,
      duration: v.duration,
      settings
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar vídeo.' });
  }
});

const ALLOWED_ANALYTICS_EVENTS = [
  'page_view',
  'play',
  'pause',
  'progress',
  'pitch_viewed',
  'cta_shown',
  'cta_clicked',
  'complete'
];

app.post('/api/analytics/event', (req, res) => {
  const { videoId, visitorId, sessionId, eventType, milestone, watchTime } = req.body || {};

  if (!videoId || !visitorId || !sessionId || !eventType) {
    return res.status(400).json({ error: 'Dados analíticos insuficientes.' });
  }

  if (!ALLOWED_ANALYTICS_EVENTS.includes(eventType)) {
    return res.status(400).json({ error: 'Tipo de evento não reconhecido.' });
  }

  const cleanVidId = String(videoId).slice(0, 64);
  const cleanVisitorId = String(visitorId).slice(0, 64);
  const cleanSessionId = String(sessionId).slice(0, 64);
  const cleanMilestone = milestone !== undefined && milestone !== null ? parseInt(milestone, 10) : null;
  const cleanWatchTime = typeof watchTime === 'number' ? Math.max(0, watchTime) : 0;

  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(cleanVidId);
  if (!video) {
    return res.status(404).json({ error: 'Vídeo não cadastrado.' });
  }

  if (eventType === 'progress' && cleanMilestone !== null) {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'progress' AND milestone = ?
      LIMIT 1
    `).get(cleanSessionId, cleanMilestone);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'page_view') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'page_view'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'pitch_viewed') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'pitch_viewed'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  if (eventType === 'cta_shown') {
    const exists = db.prepare(`
      SELECT id FROM analytics_events
      WHERE session_id = ? AND event_type = 'cta_shown'
      LIMIT 1
    `).get(cleanSessionId);
    if (exists) return res.json({ success: true, duplicate: true });
  }

  db.prepare(`
    INSERT INTO analytics_events (video_id, visitor_id, session_id, event_type, milestone, watch_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cleanVidId, cleanVisitorId, cleanSessionId, eventType, cleanMilestone, cleanWatchTime);

  if (eventType === 'play') {
    const playRecordedForSession = db.prepare(`
      SELECT COUNT(*) as count FROM analytics_events
      WHERE session_id = ? AND event_type = 'play'
    `).get(cleanSessionId).count;

    if (playRecordedForSession === 1) {
      db.prepare('UPDATE videos SET plays = plays + 1 WHERE id = ?').run(cleanVidId);
    }
  }

  res.json({ success: true });
});

app.get('/api/analytics/overview', authMiddleware, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const videoFilter = isOwner
    ? '1=1'
    : 'video_id IN (SELECT id FROM videos WHERE user_id = ' + req.user.id + ')';

  const userVideos = isOwner
    ? db.prepare('SELECT id, title, plays FROM videos ORDER BY created_at DESC').all()
    : db.prepare('SELECT id, title, plays FROM videos WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);

  const totalViews = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'page_view' AND ${videoFilter}`).get().count;
  const totalPlays = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'play' AND ${videoFilter}`).get().count;
  const uniquePlays = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE event_type = 'play' AND ${videoFilter}`).get().count;
  const ctaClicks = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'cta_clicked' AND ${videoFilter}`).get().count;
  const pitchViews = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'pitch_viewed' AND ${videoFilter}`).get().count;
  const completes = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE (event_type = 'complete' OR (event_type = 'progress' AND milestone = 100)) AND ${videoFilter}`).get().count;

  const totalPlaysBase = totalPlays > 0 ? totalPlays : userVideos.reduce((acc, v) => acc + (v.plays || 0), 0);
  const completionRate = totalPlaysBase > 0 ? ((completes / totalPlaysBase) * 100).toFixed(1) : '0.0';
  const conversionRate = totalPlaysBase > 0 ? ((ctaClicks / totalPlaysBase) * 100).toFixed(1) : '0.0';

  const usedBytes = isOwner ? getUsedStorageBytes() : getUserStorageBytes(req.user.id);
  const totalBytes = isOwner ? SERVER_STORAGE_LIMIT_BYTES : MEMBER_STORAGE_LIMIT_BYTES;

  res.json({
    totalViews,
    totalPlays: totalPlaysBase,
    uniquePlays: uniquePlays || totalPlaysBase,
    ctaClicks,
    pitchViews,
    completionRate,
    conversionRate,
    usedStorage: {
      usedBytes,
      totalBytes,
      formatted: formatStorage(usedBytes),
      isIndividual: !isOwner
    }
  });
});

app.get('/api/analytics/video/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const video = db.prepare('SELECT id, title, user_id, plays, settings_json FROM videos WHERE id = ?').get(vidId);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && video.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  const period = req.query.period || 'all';
  let dateCondition = '1=1';
  if (period === '24h') {
    dateCondition = "created_at >= datetime('now', '-24 hours')";
  } else if (period === '7d') {
    dateCondition = "created_at >= datetime('now', '-7 days')";
  } else if (period === '30d') {
    dateCondition = "created_at >= datetime('now', '-30 days')";
  }

  const views = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${dateCondition}`).get(vidId).count;
  const plays = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dateCondition}`).get(vidId).count;
  const uniqueVisitors = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND ${dateCondition}`).get(vidId).count;
  const uniquePlays = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${dateCondition}`).get(vidId).count;
  const pitchViews = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'pitch_viewed' AND ${dateCondition}`).get(vidId).count;
  const ctaShown = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_shown' AND ${dateCondition}`).get(vidId).count;
  const ctaClicks = db.prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dateCondition}`).get(vidId).count;
  const ctaUniqueClicks = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as count FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${dateCondition}`).get(vidId).count;

  const milestonesList = [10, 25, 50, 75, 90, 100];
  const retentionCurve = [];

  const basePlays = plays > 0 ? plays : (period === 'all' ? video.plays || 0 : 0);

  retentionCurve.push({
    milestone: 0,
    label: '0%',
    sessions: basePlays,
    percent: basePlays > 0 ? 100 : 0
  });

  for (const m of milestonesList) {
    const count = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE video_id = ? AND event_type = 'progress' AND milestone = ? AND ${dateCondition}
    `).get(vidId, m).count;

    const pct = basePlays > 0 ? Math.min(100, Math.round((count / basePlays) * 100)) : 0;
    retentionCurve.push({
      milestone: m,
      label: `${m}%`,
      sessions: count,
      percent: pct
    });
  }

  const pitchRate = basePlays > 0 ? ((pitchViews / basePlays) * 100).toFixed(1) : '0.0';
  const ctaClickRate = pitchViews > 0 ? ((ctaClicks / pitchViews) * 100).toFixed(1) : (basePlays > 0 ? ((ctaClicks / basePlays) * 100).toFixed(1) : '0.0');

  res.json({
    video: {
      id: video.id,
      title: video.title
    },
    period,
    metrics: {
      views,
      plays: basePlays,
      uniqueVisitors,
      uniquePlays: uniquePlays > 0 ? uniquePlays : basePlays,
      pitchViews,
      ctaShown,
      ctaClicks,
      ctaUniqueClicks,
      pitchRate,
      ctaClickRate
    },
    retentionCurve
  });
});

app.post('/api/upload', authMiddleware, checkStorageQuotaPre, (req, res) => {
  upload.single('videoFile')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Falha no upload do arquivo.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const originalPath = req.file.path;
    const isOwner = req.user.role === 'owner';
    const userUsed = getUserStorageBytes(req.user.id);
    const initialSize = fs.statSync(originalPath).size;

    if (!isOwner && (userUsed + initialSize > MEMBER_STORAGE_LIMIT_BYTES)) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Cota individual de 3 GB atingida. Remova vídeos para liberar espaço.' });
    }

    const currentUsed = getUsedStorageBytes();
    if (currentUsed > SERVER_STORAGE_LIMIT_BYTES) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Capacidade do servidor esgotada.' });
    }

    const fastPath = originalPath + '.fast.mp4';
    try {
      execSync(`nice -n 19 ffmpeg -y -i "${originalPath}" -c copy -movflags +faststart "${fastPath}"`, { timeout: 30000 });
      if (fs.existsSync(fastPath)) {
        fs.unlinkSync(originalPath);
        fs.renameSync(fastPath, originalPath);
      }
    } catch (ffmpegErr) {
      console.log('FastStart log:', ffmpegErr.message);
    }

    const finalStat = fs.statSync(originalPath);

    if (!isOwner && (userUsed + finalStat.size > MEMBER_STORAGE_LIMIT_BYTES)) {
      try { fs.unlinkSync(originalPath); } catch (e) {}
      return res.status(400).json({ error: 'Cota individual de 3 GB excedida para este vídeo.' });
    }

    const host = req.get('host') || '';
    const isProd = host.includes(BASE_DOMAIN);
    const videoDomain = isProd ? `https://${PLAYER_DOMAIN}` : `${req.protocol}://${host}`;
    const videoUrl = `${videoDomain}/videos/${req.file.filename}`;

    res.json({
      success: true,
      filename: req.file.filename,
      filePath: originalPath,
      fileSize: finalStat.size,
      videoUrl: videoUrl
    });
  });
});

app.get('/videos/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(VIDEOS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Vídeo não encontrado.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const MAX_CHUNK = 1.5 * 1024 * 1024;
    let end = parts[1] ? parseInt(parts[1], 10) : start + MAX_CHUNK - 1;
    if (end >= fileSize) end = fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': safeFilename.endsWith('.webm') ? 'video/webm' : 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const MAX_INITIAL = Math.min(2 * 1024 * 1024, fileSize);
    const file = fs.createReadStream(filePath, { start: 0, end: MAX_INITIAL - 1 });
    const head = {
      'Content-Range': `bytes 0-${MAX_INITIAL - 1}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': MAX_INITIAL,
      'Content-Type': safeFilename.endsWith('.webm') ? 'video/webm' : 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    };
    res.writeHead(206, head);
    file.pipe(res);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} ativo na porta ${PORT}`);
});
