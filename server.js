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

// ─── Konfigurasi Upload Gambar ─────────────────────────────────
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // maks 8MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diizinkan'), false);
    }
  }
});

// Serve file statis (uploads & index.html jika ada)
app.use('/uploads', express.static(uploadDir));
app.use(express.static('public')); // taruh index.html di folder public/

// ─── Data Struktur ──────────────────────────────────────────────
const waitingUsers = new Map();       // socket.id → {socket, info}
const pairs = new Map();              // socket.id → partner socket.id
const userInfo = new Map();           // socket.id → {name, age, gender, job, server}
const activeCalls = new Map();        // callerSocket.id → {to: partnerId, timeout}

// ─── Fungsi Helper ──────────────────────────────────────────────
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

function getPartnerSocket(socketId) {
  const partnerId = pairs.get(socketId);
  return partnerId ? io.sockets.sockets.get(partnerId) : null;
}

function cleanUp(socket) {
  const partner = getPartnerSocket(socket.id);
  if (partner) {
    partner.emit('partner-left');
    pairs.delete(partner.id);
  }
  pairs.delete(socket.id);
  waitingUsers.delete(socket.id);
  userInfo.delete(socket.id);

  // Bersihkan panggilan yang tertinggal
  for (const [callerId, call] of activeCalls.entries()) {
    if (callerId === socket.id || call.to === socket.id) {
      if (call.timeout) clearTimeout(call.timeout);
      activeCalls.delete(callerId);
      const other = io.sockets.sockets.get(callerId === socket.id ? call.to : callerId);
      if (other) other.emit('call-rejected', { reason: 'partner disconnected' });
    }
  }
}

function tryMatchAllWaiting() {
  const byServer = new Map();

  // Kelompokkan berdasarkan server
  for (const [id, entry] of waitingUsers.entries()) {
    const srv = entry.info.server;
    if (!byServer.has(srv)) byServer.set(srv, []);
    byServer.get(srv).push(id);
  }

  // Cocokkan berpasangan di setiap server
  for (const [serverName, ids] of byServer.entries()) {
    while (ids.length >= 2) {
      const id1 = ids.shift();
      const id2 = ids.shift();

      const entry1 = waitingUsers.get(id1);
      const entry2 = waitingUsers.get(id2);

      if (!entry1 || !entry2) continue;

      // Pairing
      pairs.set(id1, id2);
      pairs.set(id2, id1);

      entry1.socket.emit('matched', userInfo.get(id2));
      entry2.socket.emit('matched', userInfo.get(id1));

      waitingUsers.delete(id1);
      waitingUsers.delete(id2);

      console.log(`[${serverName}] MATCHED: ${entry1.info.name || 'Anon'} ↔ ${entry2.info.name || 'Anon'}`);
    }
  }
}

// ─── Socket.IO Events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`➜ Connected: ${socket.id}`);

  socket.on('join', (data) => {
    if (!data || !data.server || !data.gender || !data.job) {
      socket.emit('error', { message: 'Data tidak lengkap' });
      return;
    }

    console.log(`[${data.server}] JOIN → ${data.name || 'Anon'} (age:${data.age}, gender:${data.gender})`);

    userInfo.set(socket.id, data);
    waitingUsers.set(socket.id, { socket, info: data });

    // Coba cari partner langsung
    const partnerEntry = findPartnerFor(socket);

    if (partnerEntry) {
      // Ketemu → pairing
      const me = userInfo.get(socket.id);
      pairs.set(socket.id, partnerEntry.socket.id);
      pairs.set(partnerEntry.socket.id, socket.id);

      socket.emit('matched', partnerEntry.info);
      partnerEntry.socket.emit('matched', me);

      waitingUsers.delete(socket.id);
      waitingUsers.delete(partnerEntry.socket.id);

      console.log(`[${data.server}] MATCH langsung: ${me.name || 'Anon'} ↔ ${partnerEntry.info.name || 'Anon'}`);
    } else {
      // Masuk antrian & coba cocokkan semua waiting (handle race condition)
      tryMatchAllWaiting();
    }
  });

  // Pesan teks & file
  socket.on('message', (msg) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) {
      partner.emit('message', {
        ...msg,
        timestamp: Date.now()
      });
    }
  });

  // Typing indicator
  socket.on('typing', () => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('typing');
  });

  // Upload file (gambar)
  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Upload gagal atau bukan gambar' });
    }
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  });

  // Delete for everyone
  socket.on('delete-for-everyone', ({ msgId }) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) {
      partner.emit('delete-for-everyone', { msgId });
    }
  });

  // ─── Video Call Signaling ───────────────────────────────────
  socket.on('call-user', () => {
    const partner = getPartnerSocket(socket.id);
    if (!partner) return;

    if (activeCalls.has(socket.id)) return; // sudah ada call pending

    const timeout = setTimeout(() => {
      socket.emit('call-timeout');
      activeCalls.delete(socket.id);
    }, 30000);

    activeCalls.set(socket.id, { to: partner.id, timeout });

    partner.emit('incoming-call', {
      name: userInfo.get(socket.id)?.name || 'Pengguna'
    });
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
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('offer', offer);
  });

  socket.on('answer', (answer) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('answer', answer);
  });

  socket.on('ice', (candidate) => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('ice', candidate);
  });

  socket.on('end-call', () => {
    const partner = getPartnerSocket(socket.id);
    if (partner) partner.emit('end-call');
  });

  // ─── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`✖ Disconnected: ${socket.id}`);
    cleanUp(socket);
  });
});

// Jalankan server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server Chat Random berjalan di port ${PORT}`);
  console.log('Gunakan https:// untuk WebRTC di production');
});