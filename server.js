const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

let maleQueue = [];
let femaleQueue = [];

io.on("connection", socket => {
  console.log("User connect:", socket.id);

  socket.on("join", data => {
    socket.name = data.name;
    socket.age = data.age;
    socket.gender = data.gender;
    socket.job = data.job;
    socket.photo = data.photo || "";
    socket.partner = null;

    if (socket.gender === "male") {
      maleQueue.push(socket);
    } else {
      femaleQueue.push(socket);
    }

    matchUsers();
  });

  socket.on("message", text => {
    if (!socket.partner) return;
    socket.partner.emit("message", {
      text,
      time: getTime()
    });
  });

  socket.on("disconnect", () => {
    maleQueue = maleQueue.filter(s => s.id !== socket.id);
    femaleQueue = femaleQueue.filter(s => s.id !== socket.id);

    if (socket.partner) {
      socket.partner.emit("system", "Partner keluar");
      socket.partner.partner = null;
    }
  });
});

function matchUsers() {
  if (maleQueue.length && femaleQueue.length) {
    const male = maleQueue.shift();
    const female = femaleQueue.shift();

    male.partner = female;
    female.partner = male;

    male.emit("matched", {
      name: female.name,
      age: female.age,
      gender: female.gender,
      job: female.job,
      photo: female.photo
    });

    female.emit("matched", {
      name: male.name,
      age: male.age,
      gender: male.gender,
      job: male.job,
      photo: male.photo
    });

    console.log(`Match: ${male.name} ↔ ${female.name}`);
  }
}

function getTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,"0") + ":" +
         d.getMinutes().toString().padStart(2,"0");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
