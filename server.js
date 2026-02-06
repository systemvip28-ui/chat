const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ─── KONFIGURASI UPLOAD GAMBAR ────────────────────────────────────────────────
// Route UPLOAD HARUS PALING ATAS sebelum static middleware!
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}${ext}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // maks 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diperbolehkan'), false);
    }
  }
});

// Route upload - PASTIKAN INI ADA DI ATAS SEMUA app.use(express.static)
app.post('/upload', upload.single('file'), (req, res) => {
  console.log('[UPLOAD] Request diterima dari:', req.ip);
  console.log('[UPLOAD] File:', req.file ? req.file.originalname : 'TIDAK ADA FILE');

  if (!req.file) {
    console.log('[UPLOAD] Gagal: tidak ada file');
    return res.status(400).json({ error: 'Tidak ada file yang diupload' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  console.log('[UPLOAD] Sukses →', fileUrl);

  res.json({ url: fileUrl });
});

// Static files - harus setelah route POST /upload
app.use('/uploads', express.static(uploadDir));
app.use(express.static('public'));

// ─── DATA STRUKTUR ─────────────────────────────────────────────────────────────
const waitingUsers = new Map();    // socket.id → {socket, info}
const pairs        = new Map();    // socket.id → partner socket.id
const userInfo     = new Map();    // socket.id → user data
const activeCalls  = new Map();    // caller.id → {to, timeout}

// ─── HELPER ────────────────────────────────────────────────────────────────────
function getDisplayName(socketId) {
  const info = userInfo.get(socketId);
  return (info?.name?.trim() && info.name.trim() !== '')
    ? info.name.trim()
    : 'Pengguna';
}

function getPartnerSocket(mySocketId) {
  const partnerId = pairs.get(mySocketId);
  return partnerId ? io.sockets.sockets.get(partnerId) : null;
}

function sendSystemMessageToPartner(socketId, text) {
  const partner = getPartnerSocket(socketId);
  if (!partner) return;

  partner.emit('message', {
    id: 'sys-' + Date.now() + Math.random().toString(36).slice(2),
    type: 'text',
    text: text,
    system: true,
    timestamp: Date.now()
  });
}

function cleanUp(socket) {
  const partner = getPartnerSocket(socket.id);
  const myName = getDisplayName(socket.id);

  if (partner) {
    sendSystemMessageToPartner(socket.id, `${myName} telah keluar dari chat`);
    partner.emit('partner-left');
    pairs.delete(partner.id);
  }

  pairs.delete(socket.id);
  waitingUsers.delete(socket.id);
  userInfo.delete(socket.id);

  // Bersihkan panggilan yang masih aktif
  for (const [callerId, call] of activeCalls.entries()) {
    if (callerId === socket.id || call.to === socket.id) {
      if (call.timeout) clearTimeout(call.timeout);
      activeCalls.delete(callerId);

      const otherId = (callerId === socket.id) ? call.to : callerId;
      const other = io.sockets.sockets.get(otherId);
      if (other) other.emit('call-rejected', { reason: 'partner disconnected' });
    }
  }
}

function tryMatchAllWaiting() {
  const byServer = new Map();

  for (const [id, entry] of waitingUsers.entries()) {
    const srv = entry.info.server;
    if (!byServer.has(srv)) byServer.set(srv, []);
    byServer.get(srv).push(id);
  }

  for (const ids of byServer.values()) {
    while (ids.length >= 2) {
      const id1 = ids.shift();
      const id2 = ids.shift();

      const e1 = waitingUsers.get(id1);
      const e2 = waitingUsers.get(id2);

      if (!e1 || !e2) continue;

      pairs.set(id1, id2);
      pairs.set(id2, id1);

      e1.socket.emit('matched', userInfo.get(id2));
      e2.socket.emit('matched', userInfo.get(id1));

      waitingUsers.delete(id1);
      waitingUsers.delete(id2);

      console.log(`MATCH: ${getDisplayName(id1)} ↔ ${getDisplayName(id2)}`);
    }
  }
}

// ─── SOCKET LOGIC ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`➜ Connected: ${socket.id}`);

  socket.on('join', (data) => {
    if (!data || !data.server || !data.gender || !data.job) {
      socket.emit('error', { message: 'Data tidak lengkap' });
      return;
    }

    console.log(`[${data.server}] JOIN → ${data.name || 'Anon'} (${socket.id})`);

    userInfo.set(socket.id, data);
    waitingUsers.set(socket.id, { socket, info: data });

    const partnerEntry = findPartnerFor(socket);

    if (partnerEntry) {
      const me = userInfo.get(socket.id);
      pairs.set(socket.id, partnerEntry.socket.id);
      pairs.set(partnerEntry.socket.id, socket.id);

      socket.emit('matched', partnerEntry.info);
      partnerEntry.socket.emit('matched', me);

      waitingUsers.delete(socket.id);
      waitingUsers.delete(partnerEntry.socket.id);

      console.log(`MATCH langsung: ${getDisplayName(socket.id)} ↔ ${getDisplayName(partnerEntry.socket.id)}`);
    } else {
      tryMatchAllWaiting();
    }
  });

  function findPartnerFor(socket) {
    const myInfo = userInfo.get(socket.id);
    if (!myInfo) return null;

    for (const [id, entry] of waitingUsers.entries()) {
      if (id !== socket.id && entry.info.server === myInfo.server) {
        return entry;
      }
    }
    return null;
  }

  socket.on('message', (msg) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('message', { ...msg, timestamp: Date.now() });
  });

  socket.on('typing', () => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('typing');
  });

  socket.on('delete-for-everyone', ({ msgId }) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('delete-for-everyone', { msgId });
  });

  // ─── VIDEO CALL SIGNALING ────────────────────────────────────────────────────
  socket.on('call-user', () => {
    const partner = getPartnerSocket(socket.id);
    if (!partner || activeCalls.has(socket.id)) return;

    const timeout = setTimeout(() => {
      socket.emit('call-timeout');
      activeCalls.delete(socket.id);
    }, 30000);

    activeCalls.set(socket.id, { to: partner.id, timeout });

    partner.emit('incoming-call', { name: getDisplayName(socket.id) });
  });

  socket.on('accept-call', () => {
    let callerId = null;
    for (const [id, call] of activeCalls.entries()) {
      if (call.to === socket.id) { callerId = id; break; }
    }
    if (!callerId) return;

    const caller = io.sockets.sockets.get(callerId);
    if (caller) {
      clearTimeout(activeCalls.get(callerId).timeout);
      activeCalls.delete(callerId);
      caller.emit('call-accepted');
    }
  });

  socket.on('reject-call', () => {
    let callerId = null;
    for (const [id, call] of activeCalls.entries()) {
      if (call.to === socket.id) { callerId = id; break; }
    }
    if (callerId) {
      clearTimeout(activeCalls.get(callerId).timeout);
      activeCalls.delete(callerId);
      const caller = io.sockets.sockets.get(callerId);
      if (caller) caller.emit('call-rejected');
    }
  });

  socket.on('offer', (offer) => {
    const p = getPartnerSocket(socket.id);
    if (p) p.emit('offer', offer);
  });

  socket.on('answer', (answer) => {
    const p = getPartnerSocket(socket.id);
    if (p) p.emit('answer', answer);
  });

  socket.on('ice', (candidate) => {
    const p = getPartnerSocket(socket.id);
    if (p) p.emit('ice', candidate);
  });

  socket.on('end-call', () => {
    const p = getPartnerSocket(socket.id);
    if (p) {
      sendSystemMessageToPartner(socket.id, `${getDisplayName(socket.id)} menutup panggilan`);
      p.emit('end-call');
    }
  });

  socket.on('disconnect', () => {
    console.log(`✖ Disconnected: ${socket.id}`);
    cleanUp(socket);
  });
});

// ─── JALANKAN SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server aktif di port ${PORT}`);
  console.log('Upload endpoint: POST /upload');
  console.log('Static uploads: /uploads/...');
});