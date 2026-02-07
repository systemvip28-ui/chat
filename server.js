const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name:     'davgb7tjm',        
  api_key:        '211214865765642',          
  api_secret:     '3OG8-xUQlkYGt1uYO7yrPVoPFCo',  
  secure: true
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static('public'));

const waitingUsers = new Map();
const pairs = new Map();                
const userInfo = new Map();
const activeCalls = new Map();          
const recentlyEndedCalls = new Set();

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

  for (const [cid, call] of activeCalls.entries()) {
    if (cid === socket.id || call.to === socket.id) {
      if (call.timeout) clearTimeout(call.timeout);
      activeCalls.delete(cid);
      const other = io.sockets.sockets.get(cid === socket.id ? call.to : cid);
      if (other) other.emit('call-rejected', { reason: 'partner terputus' });
    }
  }

  // Broadcast ulang daftar online setelah user keluar
  broadcastOnlineUsers();
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

      console.log(`Match berhasil: ${id1} ↔ ${id2}`);
    }
  }

  // Setelah matching, update daftar online (karena waitingUsers berkurang)
  broadcastOnlineUsers();
}

// Fungsi baru: Broadcast daftar user yang sedang online/waiting
function broadcastOnlineUsers() {
  const onlineList = [];

  // Ambil semua user yang sedang waiting (belum match)
  for (const [id, entry] of waitingUsers.entries()) {
    const info = userInfo.get(id);
    if (info) {
      onlineList.push({
        socketId: id,
        name: info.name || "Anonim",
        age: info.age || "?",
        gender: info.gender || "-",
        job: info.job || "-",
        server: info.server
      });
    }
  }

  // Kirim ke SEMUA client (atau bisa difilter hanya ke yang di searching nanti di client)
  io.emit("online-users", onlineList);
  io.emit("online-count", onlineList.length); // update count juga dari sini (lebih akurat)
}

let onlineUsers = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online-count', onlineUsers);

  // Kirim daftar online saat user baru connect (biar langsung lihat riwayat)
  broadcastOnlineUsers();

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('online-count', onlineUsers);
    cleanUp(socket);
    broadcastOnlineUsers(); // update lagi setelah disconnect
  });

  socket.on('get-online-count', () => {
    socket.emit('online-count', onlineUsers);
  });

  // Event join user
  socket.on('join', (data) => {
    if (!data?.server) {
      console.log(`Join ditolak dari ${socket.id} - server tidak ada`);
      socket.emit('error', { message: 'Server harus dipilih' });
      return;
    }

    const userData = {
      name:   data.name   ? String(data.name).trim()   : 'Anonim',
      age:    data.age    ? Number(data.age)           : null,
      gender: data.gender ? String(data.gender).trim() : '-',
      job:    data.job    ? String(data.job).trim()    : '-',
      server: data.server,
    };

    userInfo.set(socket.id, userData);
    waitingUsers.set(socket.id, { socket, info: userData });

    console.log(`User join: ${socket.id} | ${userData.name} | server: ${userData.server}`);

    tryMatchWaiting();

    // Broadcast daftar online setelah user join
    broadcastOnlineUsers();
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

    partner.emit('message', fullMessage);
    socket.emit('message-confirmed', { id: messageId });
  });

  socket.on('delete-for-everyone', ({ msgId }) => {
    const partner = getPartner(socket.id);
    if (!partner) return;

    console.log(`Hapus untuk semua: ${msgId} dari ${socket.id}`);

    socket.emit('delete-for-everyone', { msgId });
    partner.emit('delete-for-everyone', { msgId });
  });

  socket.on('typing', () => {
    const p = getPartner(socket.id);
    if (p) p.emit('typing');
  });

  socket.on('upload-file', async (data, callback) => {
    const { buffer, filename, mimetype, caption, viewOnce } = data;

    if (!buffer || !filename || !mimetype?.startsWith('image/')) {
      return callback?.({ success: false, error: 'Data file tidak valid' });
    }

    try {
      if (buffer.length > 10 * 1024 * 1024) {
        return callback?.({ success: false, error: 'File terlalu besar maks 10MB' });
      }

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            folder: 'sanz-chat',
            public_id: `${Date.now()}-${uuidv4().slice(0, 8)}`,
            overwrite: true,
            format: path.extname(filename).slice(1) || 'jpg'
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );

        uploadStream.end(Buffer.from(buffer));
      });

      const imageUrl = uploadResult.secure_url;

      const partner = getPartner(socket.id);
      if (partner) {
        const messageId = uuidv4();
        const fileMsg = {
          id: messageId,
          type: 'file',
          fileUrl: imageUrl,
          caption: caption || '',
          viewOnce: !!viewOnce,
          timestamp: Date.now(),
          from: socket.id
        };

        partner.emit('message', fileMsg);
        socket.emit('message-confirmed', { id: messageId });
      }

      callback?.({ success: true, url: imageUrl });

    } catch (err) {
      console.error('Cloudinary upload gagal:', err.message || err);
      callback?.({ success: false, error: 'Gagal upload gambar ke Cloudinary' });
    }
  });

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

  socket.on('media-status', (status) => {
    const partner = getPartner(socket.id);
    if (partner) {
      partner.emit('media-status', status);
      console.log(`Media status dari ${socket.id} → ${partner.id}: cam=${status.cam}, mic=${status.mic}`);
    }
  });

  socket.on('end-call', () => {
    if (recentlyEndedCalls.has(socket.id)) return;
    recentlyEndedCalls.add(socket.id);
    setTimeout(() => recentlyEndedCalls.delete(socket.id), 8000);

    const p = getPartner(socket.id);
    if (p) {
      sendSystemMsg(socket.id, `Panggilan berakhir`);
      p.emit('end-call');
    }

    activeCalls.delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    cleanUp(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di port ${PORT}`);
});