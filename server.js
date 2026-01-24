const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const waiting = {
  server1: [],
  server2: [],
  server3: []
};

const users = {};

io.on("connection", socket => {
  console.log("connect", socket.id);

  socket.on("typing", () => {
    const user = users[socket.id];
    if (!user || !user.partner) return;

    const partnerSocket = io.sockets.sockets.get(user.partner);
    if (!partnerSocket) return;

    partnerSocket.emit("typing");
  });

  socket.on("join", data => {
    users[socket.id] = {
      id: socket.id,
      name: data.name,
      age: data.age,
      gender: data.gender,
      job: data.job,
      server: data.server,
      photo: data.photo || "",
      location: data.location || "",
      partner: null,
      matched: false
    };

    socket.join(data.server);
    tryMatch(socket, data.server);
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

  const q = waiting[user.server];
  if (q) {
    const i = q.indexOf(socket.id);
    if (i !== -1) q.splice(i, 1);
  }

  if (user.partner) {
    const p = users[user.partner];
    if (p) {
      p.partner = null;
      p.matched = false;

      const partnerName = user.name || "Anonim"; 
      io.to(user.partner).emit("message", {
        text: `${partnerName} keluar dari chat`, 
        time: timeNow()
      });

      io.to(user.partner).emit("partner-left");
    }
  }

  delete users[socket.id];
});
});

function tryMatch(socket, serverName) {
  const queue = waiting[serverName];
  if (!queue) return;

  while (queue.length > 0) {
    const partnerId = queue.shift();
    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (!partnerSocket || !users[partnerId] || users[partnerId].matched) {
      continue; 
    }

    users[socket.id].partner = partnerId;
    users[partnerId].partner = socket.id;
    users[socket.id].matched = true;
    users[partnerId].matched = true;

    socket.emit("matched", users[partnerId]);
    partnerSocket.emit("matched", users[socket.id]);

    console.log("MATCH", socket.id, "<->", partnerId);
    return;
  }

  waiting[serverName].push(socket.id);
  console.log("waiting", socket.id, "in", serverName);
}

function timeNow() {
  const d = new Date();
  return d.getHours().toString().padStart(2, "0") + ":" +
         d.getMinutes().toString().padStart(2, "0");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("running on", PORT);
});