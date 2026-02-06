const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ─── UPLOAD CONFIG ─────────────────────────────────────────────────────────────
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,10)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Hanya gambar'), false);
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});

app.use('/uploads', express.static(uploadDir));
app.use(express.static('public'));

// ─── DATA ──────────────────────────────────────────────────────────────────────
const waitingUsers = new Map();
const pairs = new Map();                // socket.id → partner socket.id
const userInfo = new Map();
const activeCalls = new Map();          // callerId → {to: partnerId, timeout}
const recentlyEndedCalls = new Set();

// ─── HELPER ────────────────────────────────────────────────────────────────────
function getDisplayName(id) {
  const info = userInfo.get(id);
  return info?.name?.trim() && info.name.trim() !== '' ? info.name.trim() : 'Pengguna';
}

function getPartner(socketId) {
  const partnerId = pairs.get(socketId);
  return partnerId ? io.sockets.sockets.get(partnerId) : null;
}

function sendSystemMsg(fromId, text) {
  const partner = getPartner(fromId);
  if (partner) {
    partner.emit('message', {
      id: 'sys-' + Date.now(),
      type: 'text',
      text,
      system: true,
      timestamp: Date.now()
    });
  }
}

function cleanUp(socket) {
  const partner = getPartner(socket.id);
  const name = getDisplayName(socket.id);

  if (partner) {
    sendSystemMsg(socket.id, `${name} telah keluar dari chat`);
    partner.emit('partner-left');
    pairs.delete(partner.id);
  }

  pairs.delete(socket.id);
  waitingUsers.delete(socket.id);
  userInfo.delete(socket.id);

  // clean calls
  for (const [cid, call] of activeCalls.entries()) {
    if (cid === socket.id || call.to === socket.id) {
      if (call.timeout) clearTimeout(call.timeout);
      activeCalls.delete(cid);
      const other = io.sockets.sockets.get(cid === socket.id ? call.to : cid);
      if (other) other.emit('call-rejected', { reason: 'partner terputus' });
    }
  }
}

function tryMatchWaiting() {
  const byServer = new Map();
  for (const [id, e] of waitingUsers.entries()) {
    const s = e.info.server;
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s).push(id);
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
    }
  }
}

// ─── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('join', (data) => {
    if (!data?.server || !data?.gender || !data?.job) return;
    userInfo.set(socket.id, data);
    waitingUsers.set(socket.id, { socket, info: data });

    tryMatchWaiting();
  });

  socket.on('message', (msgData) => {
    const partner = getPartner(socket.id);
    if (!partner) {
      console.log(`Pesan dari ${socket.id} tidak dikirim: tidak ada partner`);
      return;
    }

    const messageId = uuidv4();

    const fullMessage = {
      id: messageId,
      ...msgData,
      timestamp: Date.now(),
      from: socket.id
    };

    console.log(`Pesan dikirim ke pair: ${socket.id} → ${partner.id} | ID: ${messageId}`);

    // HANYA KIRIM KE PENERIMA (partner) → menghilangkan duplikat di pengirim
    partner.emit('message', fullMessage);

    // Kirim konfirmasi ID ke pengirim (untuk update optimistic UI kalau perlu)
    socket.emit('message-confirmed', { id: messageId });
  });

  socket.on('delete-for-everyone', ({ msgId }) => {
    const partner = getPartner(socket.id);
    if (!partner) return;

    console.log(`Hapus untuk semua: ${msgId} dari ${socket.id}`);

    // Broadcast ke kedua sisi
    socket.emit('delete-for-everyone', { msgId });
    partner.emit('delete-for-everyone', { msgId });
  });

  socket.on('typing', () => {
    const p = getPartner(socket.id);
    if (p) p.emit('typing');
  });

  // ─── VIDEO CALL ───────────────────────────────────────────────────────────────
  socket.on('call-user', () => {
    const partner = getPartner(socket.id);
    if (!partner) {
      socket.emit('call-failed', { reason: 'Partner tidak tersedia atau sudah keluar' });
      return;
    }

    if (activeCalls.has(socket.id)) {
      socket.emit('call-failed', { reason: 'Panggilan sedang berlangsung' });
      return;
    }

    const timeout = setTimeout(() => {
      socket.emit('call-timeout');
      activeCalls.delete(socket.id);
    }, 30000);

    activeCalls.set(socket.id, { to: partner.id, timeout });

    partner.emit('incoming-call', { name: getDisplayName(socket.id) });
    socket.emit('call-sent');
  });

  socket.on('accept-call', () => {
    let callerId = null;
    for (const [id, call] of activeCalls.entries()) {
      if (call.to === socket.id) {
        callerId = id;
        break;
      }
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
      if (call.to === socket.id) {
        callerId = id;
        break;
      }
    }
    if (callerId) {
      clearTimeout(activeCalls.get(callerId).timeout);
      activeCalls.delete(callerId);
      const caller = io.sockets.sockets.get(callerId);
      if (caller) caller.emit('call-rejected');
    }
  });

  socket.on('offer', (offer) => {
    const p = getPartner(socket.id);
    if (p) p.emit('offer', offer);
  });

  socket.on('answer', (answer) => {
    const p = getPartner(socket.id);
    if (p) p.emit('answer', answer);
  });

  socket.on('ice', (candidate) => {
    const p = getPartner(socket.id);
    if (p) p.emit('ice', candidate);
  });

  socket.on('end-call', () => {
    if (recentlyEndedCalls.has(socket.id)) return;
    recentlyEndedCalls.add(socket.id);
    setTimeout(() => recentlyEndedCalls.delete(socket.id), 8000);

    const p = getPartner(socket.id);
    if (p) {
      sendSystemMsg(socket.id, `${getDisplayName(socket.id)} menutup panggilan`);
      p.emit('end-call');
    }

    activeCalls.delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    cleanUp(socket);
  });
});

// ─── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di port ${PORT}`);
});