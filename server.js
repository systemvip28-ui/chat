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

// ─── Multer untuk upload gambar ────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './public/uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Hanya gambar yang diperbolehkan'), false);
  }
});

app.use('/uploads', express.static('public/uploads'));
app.use(express.static('public')); // jika kamu taruh index.html di folder public

// ─── Struktur data ─────────────────────────────────────────────
const waitingUsers = new Map();       // server → user socket
const pairs = new Map();              // socket.id → partner socket.id
const userInfo = new Map();           // socket.id → {name, age, gender, job, server}
const activeCalls = new Map();        // callerId → {to: socketId, timeout?}

function findPartnerFor(socket) {
  for (const [id, user] of waitingUsers.entries()) {
    if (id !== socket.id && user.server === userInfo.get(socket.id)?.server) {
      return { socket: user.socket, info: user.info };
    }
  }
  return null;
}

function getPartner(socketId) {
  const partnerId = pairs.get(socketId);
  if (!partnerId) return null;
  return io.sockets.sockets.get(partnerId);
}

function cleanUp(socket) {
  const partnerSocket = getPartner(socket.id);
  if (partnerSocket) {
    partnerSocket.emit('partner-left');
    pairs.delete(partnerSocket.id);
  }
  pairs.delete(socket.id);
  waitingUsers.delete(socket.id);
  userInfo.delete(socket.id);

  // bersihkan call yang tertinggal
  for (const [callerId, call] of activeCalls.entries()) {
    if (call.to === socket.id || callerId === socket.id) {
      if (call.timeout) clearTimeout(call.timeout);
      activeCalls.delete(callerId);
      const other = io.sockets.sockets.get(callerId === socket.id ? call.to : callerId);
      if (other) other.emit('call-rejected', { reason: 'partner disconnected' });
    }
  }
}

// ─── Socket logic ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join', (data) => {
    userInfo.set(socket.id, data);

    const existing = findPartnerFor(socket);
    if (existing) {
      // ketemu pasangan
      const me = userInfo.get(socket.id);
      const partner = existing.info;

      pairs.set(socket.id, existing.socket.id);
      pairs.set(existing.socket.id, socket.id);

      socket.emit('matched', partner);
      existing.socket.emit('matched', me);

      waitingUsers.delete(socket.id);
      waitingUsers.delete(existing.socket.id);
    } else {
      // masuk antrian
      waitingUsers.set(socket.id, {
        socket,
        info: data
      });
    }
  });

  // ── Pesan teks ──
  socket.on('message', (msg) => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit('message', {
        ...msg,
        from: socket.id,
        timestamp: Date.now()
      });
    }
  });

  // ── Typing indicator ──
  socket.on('typing', () => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('typing');
  });

  // ── Upload gambar ──
  socket.on('upload-file', (meta, callback) => {
    callback({ status: 'ready' });
  });

  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Upload gagal' });
    }
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  });

  // ── View once logic (server hanya forward, client handle hapus) ──
  socket.on('message', (msg) => {
    if (msg.type === 'file' && msg.viewOnce) {
      // Bisa ditambahkan logic hapus file setelah X waktu / setelah dilihat
      // Untuk sekarang: client yang handle auto delete setelah dilihat
    }
    const partner = getPartner(socket.id);
    if (partner) partner.emit('message', msg);
  });

  socket.on('delete-for-everyone', ({ msgId }) => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit('delete-for-everyone', { msgId });
    }
    // Jika ingin hapus file juga (khusus view-once), bisa ditambahkan disini
  });

  // ── Video Call Signaling ───────────────────────────────────
  socket.on('call-user', ({ name }) => {
    const partner = getPartner(socket.id);
    if (!partner) return;

    activeCalls.set(socket.id, {
      to: partner.id,
      timeout: setTimeout(() => {
        socket.emit('call-timeout');
        activeCalls.delete(socket.id);
      }, 30000)
    });

    partner.emit('incoming-call', { name: userInfo.get(socket.id)?.name || 'Seseorang' });
  });

  socket.on('accept-call', () => {
    const callerId = [...activeCalls.entries()].find(([k, v]) => v.to === socket.id)?.[0];
    if (!callerId) return;

    const callerSocket = io.sockets.sockets.get(callerId);
    if (callerSocket) {
      clearTimeout(activeCalls.get(callerId).timeout);
      activeCalls.delete(callerId);
      callerSocket.emit('call-accepted');
    }
  });

  socket.on('reject-call', () => {
    const callerId = [...activeCalls.entries()].find(([k, v]) => v.to === socket.id)?.[0];
    if (callerId) {
      clearTimeout(activeCalls.get(callerId).timeout);
      activeCalls.delete(callerId);
      const caller = io.sockets.sockets.get(callerId);
      if (caller) caller.emit('call-rejected');
    }
  });

  socket.on('cancel-call', () => {
    if (activeCalls.has(socket.id)) {
      clearTimeout(activeCalls.get(socket.id).timeout);
      activeCalls.delete(socket.id);
    }
  });

  // WebRTC signaling
  socket.on('offer', (offer) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('offer', offer);
  });

  socket.on('answer', (answer) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('answer', answer);
  });

  socket.on('ice', (candidate) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('ice', candidate);
  });

  socket.on('end-call', () => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('end-call');
  });

  socket.on('media-status', (status) => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('media-status', status);
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    cleanUp(socket);
  });
});

// Jalankan server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});