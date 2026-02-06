const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

// Pastikan folder uploads ada
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Konfigurasi multer (simpan file di folder public/uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // batas 10MB (ubah sesuai kebutuhan)
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/3gpp",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file gambar dan video yang diperbolehkan"), false);
    }
  },
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Simpan antrian per server
const waiting = {
  server1: [],
  server2: [],
  server3: [],
};

// Simpan data user
const users = {};

// Simpan pesan per room (untuk delete-for-everyone & view-once jika mau dikelola server-side)
const messages = {}; // { roomId: [msgObj, ...] }

function getRoomId(id1, id2) {
  return [id1, id2].sort().join("-");
}

function timeNow() {
  const d = new Date();
  return (
    d.getHours().toString().padStart(2, "0") +
    ":" +
    d.getMinutes().toString().padStart(2, "0")
  );
}

// ─── ROUTE UPLOAD FILE ───────────────────────────────────────
app.post("/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Kesalahan multer (misal ukuran file terlalu besar)
      return res.status(400).json({ error: err.message });
    } else if (err) {
      // Kesalahan lain (misal tipe file tidak diizinkan)
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada file yang diupload" });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  });
});

// Serve file statis (uploads + frontend html jika ada)
app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(__dirname, "public")));

// ─── SOCKET.IO ───────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Typing indicator
  socket.on("typing", () => {
    const user = users[socket.id];
    if (!user || !user.partner) return;
    io.to(user.partner).emit("typing");
  });

  // Join & matching
  socket.on("join", (data) => {
    // Cleanup jika reconnect / join ulang
    if (users[socket.id]) {
      const old = users[socket.id];
      const q = waiting[old.server];
      if (q) {
        const idx = q.indexOf(socket.id);
        if (idx !== -1) q.splice(idx, 1);
      }
      if (old.partner && users[old.partner]) {
        users[old.partner].partner = null;
        users[old.partner].matched = false;
        io.to(old.partner).emit("partner-left");
      }
    }

    users[socket.id] = {
      id: socket.id,
      name: data.name || "Anon",
      age: data.age,
      gender: data.gender,
      job: data.job,
      server: data.server,
      partner: null,
      matched: false,
      callActive: false,
    };

    socket.join(data.server);
    tryMatch(socket, data.server);
  });

  // Kirim pesan (text / file)
  socket.on("message", (payload) => {
    const user = users[socket.id];
    if (!user || !user.partner || !user.matched) return;

    const room = getRoomId(socket.id, user.partner);
    if (!messages[room]) messages[room] = [];

    const msg = {
      id: payload.id,
      type: payload.type || "text",
      text: payload.text,
      fileUrl: payload.fileUrl,
      caption: payload.caption || "",
      viewOnce: !!payload.viewOnce,
      sender: socket.id,
      time: timeNow(),
    };

    messages[room].push(msg);

    // Kirim ke partner
    io.to(user.partner).emit("message", msg);
    // Konfirmasi ke pengirim
    socket.emit("message", msg);
  });

  // Hapus pesan untuk semua orang
  socket.on("delete-for-everyone", ({ msgId }) => {
    const user = users[socket.id];
    if (!user || !user.partner) return;

    const room = getRoomId(socket.id, user.partner);
    if (!messages[room]) return;

    const msg = messages[room].find((m) => m.id === msgId);
    if (msg && msg.sender === socket.id) {
      msg.type = "deleted";
      msg.text = null;
      msg.fileUrl = null;
      msg.caption = null;

      io.to(socket.id).emit("delete-for-everyone", { msgId });
      io.to(user.partner).emit("delete-for-everyone", { msgId });
    }
  });

  // ─── Video Call Signaling ────────────────────────────────
  socket.on("call-user", () => {
    const user = users[socket.id];
    if (!user || !user.partner || !user.matched) return;
    io.to(user.partner).emit("incoming-call", { name: user.name || "Anon" });
  });

  socket.on("accept-call", () => {
    const user = users[socket.id];
    if (!user || !user.partner) return;
    user.callActive = true;
    if (users[user.partner]) users[user.partner].callActive = true;
    io.to(user.partner).emit("call-accepted");
  });

  socket.on("reject-call", () => {
    const user = users[socket.id];
    if (!user || !user.partner) return;
    user.callActive = false;
    if (users[user.partner]) users[user.partner].callActive = false;
    io.to(user.partner).emit("call-rejected");
  });

  socket.on("offer", (offer) => {
    const user = users[socket.id];
    if (!user || !user.partner || !user.callActive) return;
    io.to(user.partner).emit("offer", offer);
  });

  socket.on("answer", (answer) => {
    const user = users[socket.id];
    if (!user || !user.partner || !user.callActive) return;
    io.to(user.partner).emit("answer", answer);
  });

  socket.on("ice", (candidate) => {
    const user = users[socket.id];
    if (!user || !user.partner) return;
    io.to(user.partner).emit("ice", candidate);
  });

  socket.on("end-call", () => {
    const user = users[socket.id];
    if (!user || !user.partner) return;
    user.callActive = false;
    if (users[user.partner]) users[user.partner].callActive = false;
    io.to(user.partner).emit("end-call");
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (!user) return;

    const q = waiting[user.server];
    if (q) {
      const idx = q.indexOf(socket.id);
      if (idx !== -1) q.splice(idx, 1);
    }

    if (user.partner && users[user.partner]) {
      const p = users[user.partner];
      p.partner = null;
      p.matched = false;
      p.callActive = false;

      io.to(user.partner).emit("partner-left");
      io.to(user.partner).emit("end-call");
      io.to(user.partner).emit("message", {
        type: "text",
        text: `${user.name || "Seseorang"} keluar dari chat`,
        time: timeNow(),
      });
    }

    delete users[socket.id];
    console.log("Disconnected:", socket.id);
  });
});

// ─── Matching Logic ──────────────────────────────────────────
function tryMatch(socket, serverName) {
  const queue = waiting[serverName];
  if (!queue) return;

  while (queue.length > 0) {
    const partnerId = queue.shift();
    if (!users[partnerId] || users[partnerId].matched) continue;

    users[socket.id].partner = partnerId;
    users[socket.id].matched = true;

    users[partnerId].partner = socket.id;
    users[partnerId].matched = true;

    // Kirim data partner ke masing-masing
    socket.emit("matched", {
      name: users[partnerId].name,
      age: users[partnerId].age,
      gender: users[partnerId].gender,
      job: users[partnerId].job,
      server: users[partnerId].server,
    });

    io.to(partnerId).emit("matched", {
      name: users[socket.id].name,
      age: users[socket.id].age,
      gender: users[socket.id].gender,
      job: users[socket.id].job,
      server: users[socket.id].server,
    });

    console.log(`MATCH: ${socket.id} <-> ${partnerId} (${serverName})`);
    return;
  }

  // Masuk antrian jika belum ada pasangan
  if (!queue.includes(socket.id)) {
    queue.push(socket.id);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});