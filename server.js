const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

cloudinary.config({
  cloud_name: "davgb7tjm",
  api_key: "211214865765642",
  api_secret: "3OG8-xUQlkYGt1uYO7yrPVoPFCo"
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "chat-random",
    allowed_formats: ["jpg", "png", "jpeg", "gif", "mp4", "webm"],
    resource_type: "auto"
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const waiting = { server1: [], server2: [], server3: [] };
const users = {};

function getRoomId(a, b) {
  return [a, b].sort().join("-");
}

function timeNow() {
  const d = new Date();
  return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
}

// Upload endpoint
app.post("/upload", (req, res) => {
  upload.single("file")(req, res, err => {
    if (err) {
      console.error("Upload error:", err);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: "No file" });
    res.json({ url: req.file.path });
  });
});

io.on("connection", socket => {
  console.log("Client connected:", socket.id);

  socket.on("join", data => {
    if (users[socket.id]) {
      const old = users[socket.id];
      if (old.partner && users[old.partner]) {
        users[old.partner].partner = null;
        io.to(old.partner).emit("partner-left");
      }
    }

    users[socket.id] = {
      ...data,
      id: socket.id,
      partner: null,
      matched: false
    };

    tryMatch(socket, data.server);
  });

  socket.on("typing", () => {
    const user = users[socket.id];
    if (user?.partner) {
      socket.to(user.partner).emit("typing");
    }
  });

  socket.on("message", payload => {
    const user = users[socket.id];
    if (!user?.partner) return;

    const msg = {
      ...payload,
      sender: socket.id,
      time: payload.time || timeNow()
    };

    // Kirim ke partner
    socket.to(user.partner).emit("message", msg);
    // Kirim balik ke pengirim (agar muncul di layar sendiri)
    socket.emit("message", msg);

    console.log(`Pesan dari ${user.name} ke ${users[user.partner]?.name || "?"}`);
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (!user) return;

    if (user.partner && users[user.partner]) {
      users[user.partner].partner = null;
      io.to(user.partner).emit("partner-left");
    }

    // Hapus dari antrian jika masih menunggu
    const q = waiting[user.server];
    if (q) {
      const idx = q.indexOf(socket.id);
      if (idx !== -1) q.splice(idx, 1);
    }

    delete users[socket.id];
    console.log("Client disconnected:", socket.id);
  });
});

function tryMatch(socket, serverName) {
  const queue = waiting[serverName] = waiting[serverName] || [];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!users[pid] || users[pid].matched) continue;

    users[socket.id].partner = pid;
    users[socket.id].matched = true;
    users[pid].partner = socket.id;
    users[pid].matched = true;

    socket.emit("matched", users[pid]);
    io.to(pid).emit("matched", users[socket.id]);

    console.log(`Match: ${socket.id} <-> ${pid} (${serverName})`);
    return;
  }

  if (!queue.includes(socket.id)) queue.push(socket.id);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});