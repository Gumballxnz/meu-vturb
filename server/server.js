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
const JWT_SECRET = process.env.JWT_SECRET || 'cloudvturb_ultra_secret_key_2026_jwt_token_99';
const MAX_STORAGE_BYTES = 30 * 1024 * 1024 * 1024; // 30 GB cota

// Diretórios
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, 'videos');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// 1. Inicialização do Banco SQLite
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    title TEXT NOT NULL,
    source_type TEXT DEFAULT 'remote',
    file_path TEXT,
    video_url TEXT NOT NULL,
    duration TEXT DEFAULT '05:00',
    file_size INTEGER DEFAULT 0,
    plays INTEGER DEFAULT 0,
    settings_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

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

// 2. Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Calcular espaço usado nos vídeos
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

// Middleware de Autenticação JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(decoded.id);
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

// 3. Upload de Arquivos
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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

// -------------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos.' });

  const cleanEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const passwordHash = bcrypt.hashSync(password, 10);

  // Primeiro usuário é OWNER
  if (userCount === 0) {
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status)
      VALUES (?, ?, ?, 'owner', 'approved')
    `).run(name.trim(), cleanEmail, passwordHash);

    const token = jwt.sign({ id: info.lastInsertRowid, email: cleanEmail, role: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true,
      message: 'Conta de Owner criada com sucesso!',
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
      message: 'Cadastro realizado com sucesso! Aguarde a aprovação do Administrador/Owner.'
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
    return res.status(403).json({ error: 'Sua conta está aguardando aprovação do Owner para ser liberada.' });
  }
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'Sua conta foi bloqueada pelo Administrador.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// -------------------------------------------------------------
// ROTAS DO OWNER
// -------------------------------------------------------------
app.get('/api/admin/users', authMiddleware, ownerMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC').all();
  res.json({ users });
});

app.post('/api/admin/users/:id/action', authMiddleware, ownerMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  const { action } = req.body;

  if (targetId === req.user.id && (action === 'block' || action === 'delete')) {
    return res.status(400).json({ error: 'Você não pode bloquear ou excluir a si mesmo.' });
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
  const requireApproval = getSetting('require_approval', '1') === '1';
  const usedBytes = getUsedStorageBytes();
  const totalBytes = MAX_STORAGE_BYTES;

  const usedMB = (usedBytes / (1024 * 1024)).toFixed(1);
  const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const formattedUsage = usedBytes >= (1024 * 1024 * 1024) 
    ? `${usedGB} GB` 
    : `${usedMB} MB`;

  const percent = ((usedBytes / totalBytes) * 100);

  res.json({
    requireApproval,
    storage: {
      usedBytes,
      totalBytes,
      usedMB,
      usedGB,
      formattedUsage,
      totalGB: '30',
      usagePercent: percent < 0.1 && usedBytes > 0 ? '0.1' : percent.toFixed(1)
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

// -------------------------------------------------------------
// ROTAS DE VÍDEOS & TRACKING DE PLAYS
// -------------------------------------------------------------
app.get('/api/videos', authMiddleware, (req, res) => {
  let rows;
  if (req.user.role === 'owner') {
    rows = db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  }

  const videos = rows.map(r => ({
    ...r,
    settings: r.settings_json ? JSON.parse(r.settings_json) : {}
  }));

  res.json({ videos });
});

app.post('/api/videos', authMiddleware, (req, res) => {
  const { id, title, videoUrl, sourceType, filePath, duration, settings } = req.body;
  const vidId = id || 'vsl_' + Date.now();

  db.prepare(`
    INSERT INTO videos (id, user_id, title, source_type, file_path, video_url, duration, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vidId,
    req.user.id,
    title || 'Minha VSL',
    sourceType || 'remote',
    filePath || null,
    videoUrl,
    duration || '10:00',
    JSON.stringify(settings || {})
  );

  res.json({ success: true, id: vidId });
});

app.put('/api/videos/:id', authMiddleware, (req, res) => {
  const { title, settings, duration } = req.body;
  const vidId = req.params.id;

  const existing = db.prepare('SELECT user_id FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  db.prepare(`
    UPDATE videos SET 
      title = COALESCE(?, title),
      duration = COALESCE(?, duration),
      settings_json = COALESCE(?, settings_json)
    WHERE id = ?
  `).run(title, duration, settings ? JSON.stringify(settings) : null, vidId);

  res.json({ success: true });
});

app.delete('/api/videos/:id', authMiddleware, (req, res) => {
  const vidId = req.params.id;
  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(vidId);
  if (!existing) return res.status(404).json({ error: 'Vídeo não encontrado.' });
  if (req.user.role !== 'owner' && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Permissão negada.' });
  }

  if (existing.source_type === 'local' && existing.file_path && fs.existsSync(existing.file_path)) {
    try { fs.unlinkSync(existing.file_path); } catch (e) {}
  }

  db.prepare('DELETE FROM videos WHERE id = ?').run(vidId);
  res.json({ success: true });
});

// Endpoint de Registro de Play (Aberto para o Player chamar)
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

// Upload de Vídeo com Otimização FastStart Automática
app.post('/api/upload', authMiddleware, upload.single('videoFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const currentUsed = getUsedStorageBytes();
  if (currentUsed > MAX_STORAGE_BYTES) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Cota de armazenamento da VPS (30 GB) atingida.' });
  }

  // Otimização FastStart: move moov atom para o início instantaneamente
  const originalPath = req.file.path;
  const fastPath = originalPath + '.fast.mp4';

  try {
    execSync(`ffmpeg -y -i "${originalPath}" -c copy -movflags +faststart "${fastPath}"`, { timeout: 30000 });
    if (fs.existsSync(fastPath)) {
      fs.unlinkSync(originalPath);
      fs.renameSync(fastPath, originalPath);
    }
  } catch (err) {
    console.log('FastStart ignorado ou ffmpeg em fallback:', err.message);
  }

  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const videoUrl = `${protocol}://${host}/videos/${req.file.filename}`;

  const finalStat = fs.statSync(originalPath);

  res.json({
    success: true,
    filename: req.file.filename,
    filePath: originalPath,
    fileSize: finalStat.size,
    videoUrl: videoUrl
  });
});

// -------------------------------------------------------------
// STREAMING DE VÍDEO DE ALTA PERFORMANCE (Adaptive Chunking 1.5MB)
// -------------------------------------------------------------
app.get('/videos/:filename', (req, res) => {
  const filePath = path.join(VIDEOS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Vídeo não encontrado.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    
    // Chunk ideal para VSL instantânea: 1.5 MB por pacote
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
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // Se não pediu Range, envia os primeiros 2MB para carregar instantâneo
    const MAX_INITIAL = Math.min(2 * 1024 * 1024, fileSize);
    const file = fs.createReadStream(filePath, { start: 0, end: MAX_INITIAL - 1 });
    const head = {
      'Content-Range': `bytes 0-${MAX_INITIAL - 1}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': MAX_INITIAL,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    };
    res.writeHead(206, head);
    file.pipe(res);
  }
});

app.get('*', (req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  } else {
    res.send('CloudVTurb Server Online');
  }
});

app.listen(PORT, () => {
  console.log(`CloudVTurb Server ativo na porta ${PORT}`);
});
