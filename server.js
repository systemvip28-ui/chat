const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/*
  waiting[serverName] = array socket.id yang menunggu
  users[socket.id] = data user
*/
const waiting = {
  server1: [],
  server2: [],
  server3: []
};

const users = {};

io.on("connection", socket => {
  console.log("🟢 User connect:", socket.id);

  socket.on("join", data => {
    /*
      data = {
        name, age, gender, job,
        server, photo, location
      }
    */

    users[socket.id] = {
      id: socket.id,
      name: data.name,
      age: data.age,
      gender: data.gender,
      job: data.job,
      server: data.server,
      photo: data.photo || "",
      location: data.location || "",
      partner: null
    };

    socket.join(data.server);

    // Cek antrian server
    const queue = waiting[data.server];

    if (queue.length > 0) {
      // Match dengan user lain
      const partnerId = queue.shift();
      const partnerSocket = io.sockets.sockets.get(partnerId);

      if (!partnerSocket) return;

      users[socket.id].partner = partnerId;
      users[partnerId].partner = socket.id;

      // Kirim info partner ke masing-masing
      socket.emit("matched", users[partnerId]);
      partnerSocket.emit("matched", users[socket.id]);

      console.log(`🔗 Match ${socket.id} <-> ${partnerId}`);
    } else {
      // Masuk antrian
      queue.push(socket.id);
      console.log(`⏳ Menunggu di ${data.server}`);
    }
  });

  socket.on("message", text => {
    const user = users[socket.id];
    if (!user || !user.partner) return;

    const partnerSocket = io.sockets.sockets.get(user.partner);
    if (!partnerSocket) return;

    partnerSocket.emit("message", {
      text,
      time: timeNow()
    });
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (!user) return;

    console.log("🔴 User disconnect:", socket.id);

    // Hapus dari waiting queue
    const q = waiting[user.server];
    if (q) {
      const i = q.indexOf(socket.id);
      if (i !== -1) q.splice(i, 1);
    }

    // Putuskan partner
    if (user.partner) {
      const partner = users[user.partner];
      if (partner) {
        partner.partner = null;
        io.to(user.partner).emit("message", {
          text: "Partner keluar dari chat",
          time: timeNow()
        });
      }
    }

    delete users[socket.id];
  });
});

function timeNow() {
  const d = new Date();
  return d.getHours().toString().padStart(2, "0") + ":" +
         d.getMinutes().toString().padStart(2, "0");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
