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

app.get('/', (req, res) => {
  res.status(200).send('Live');
});

const users = new Map(); 
const socketToUser = new Map(); 
const waitingUsers = new Set(); 
const pairs = new Map(); 
const chatHistories = new Map(); 
const activeCalls = new Map(); 
const recentlyEndedCalls = new Set();

function getPairKey(id1, id2) {
  return [id1, id2].sort().join('_');
}

function getDisplayName(userId) {
  const info = users.get(userId);
  return info?.name?.trim() && info.name.trim() !== '' ? info.name.trim() : 'Pengguna';
}

function getPartnerUserId(userId) {
  return pairs.get(userId);
}

function getPartnerSocket(userId) {
  const partnerId = pairs.get(userId);
  if (!partnerId) return null;
  const partner = users.get(partnerId);
  if (partner && partner.online && partner.socketId) {
    return io.sockets.sockets.get(partner.socketId);
  }
  return null;
}

function broadcastOnlineUsers() {
  const onlineList = [];
  for (const userId of waitingUsers) {
    const info = users.get(userId);
    if (info && info.online) {
      onlineList.push({
        userId: userId,
        name: info.name || "Anonim",
        age: info.age || "?",
        gender: info.gender || "-",
        job: info.job || "-",
        server: info.server
      });
    }
  }
  io.emit("online-users", onlineList);
  io.emit("online-count", onlineList.length); 
}

function tryMatchWaiting() {
  const byServer = new Map();
  for (const userId of waitingUsers) {
    const user = users.get(userId);
    if (!user || !user.online) continue;
    const s = user.server;
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s).push(userId);
  }

  for (const ids of byServer.values()) {
    let i = 0;
    while (i < ids.length) {
      let matched = false;
      for (let j = i + 1; j < ids.length; j++) {
        const id1 = ids[i];
        const id2 = ids[j];
        const u1 = users.get(id1);
        const u2 = users.get(id2);
        
        if (!u1 || !u2) continue;

        if (!u1.history.has(id2) && !u2.history.has(id1)) {
          pairs.set(id1, id2);
          pairs.set(id2, id1);

          u1.history.add(id2);
          u2.history.add(id1);

          const s1 = io.sockets.sockets.get(u1.socketId);
          const s2 = io.sockets.sockets.get(u2.socketId);
          
          if(s1) s1.emit('matched', u2);
          if(s2) s2.emit('matched', u1);

          waitingUsers.delete(id1);
          waitingUsers.delete(id2);
          
          ids.splice(j, 1);
          ids.splice(i, 1);
          matched = true;
          console.log(`Match berhasil: ${id1} ↔ ${id2}`);
          break;
        }
      }
      if (!matched) i++;
    }
  }

  broadcastOnlineUsers();
}

let onlineCountGlobal = 0;

io.on('connection', (socket) => {
  onlineCountGlobal++;
  io.emit('online-count', onlineCountGlobal);

  socket.on('disconnect', () => {
    onlineCountGlobal--;
    io.emit('online-count', onlineCountGlobal);
    
    const userId = socketToUser.get(socket.id);
    if (userId) {
        socketToUser.delete(socket.id);
        const user = users.get(userId);
        if (user) {
            user.online = false;
            user.lastSeen = Date.now();
            user.socketId = null;

            const partnerSocket = getPartnerSocket(userId);
            if (partnerSocket) {
                partnerSocket.emit('partner-offline', { lastSeen: user.lastSeen });
            } else {
                waitingUsers.delete(userId);
            }
        }
    }
    
    for (const [cid, call] of activeCalls.entries()) {
      if (cid === socket.id || call.to === socket.id) {
        if (call.timeout) clearTimeout(call.timeout);
        activeCalls.delete(cid);
        const other = io.sockets.sockets.get(cid === socket.id ? call.to : cid);
        if (other) other.emit('call-rejected', { reason: 'partner terputus' });
      }
    }
    broadcastOnlineUsers(); 
  });

  socket.on('get-online-count', () => {
    socket.emit('online-count', onlineCountGlobal);
  });

  socket.on('join', (data) => {
    if (!data?.server || !data?.userId) {
      socket.emit('error', { message: 'Data tidak lengkap' });
      return;
    }

    const userId = data.userId;
    socketToUser.set(socket.id, userId);

    let user = users.get(userId);
    if (!user) {
        user = { 
            name: data.name ? String(data.name).trim() : 'Anonim',
            age: data.age ? Number(data.age) : null,
            gender: data.gender ? String(data.gender).trim() : '-',
            job: data.job ? String(data.job).trim() : '-',
            server: data.server,
            profilePic: data.profilePic || '',
            history: new Set(), 
            stories: [], 
            online: true 
        };
        users.set(userId, user);
    } else {
        user.name = data.name ? String(data.name).trim() : 'Anonim';
        user.server = data.server;
        if(data.profilePic) user.profilePic = data.profilePic;
        user.online = true;
    }
    user.socketId = socket.id;

    const partnerId = pairs.get(userId);
    if (partnerId) {
        const partner = users.get(partnerId);
        if (partner) {
            socket.emit('matched', partner); 
            
            const pairKey = getPairKey(userId, partnerId);
            const history = chatHistories.get(pairKey) || [];
            socket.emit('chat-history', history);

            if (partner.online && partner.socketId) {
                io.to(partner.socketId).emit('partner-online');
            } else {
                socket.emit('partner-offline', { lastSeen: partner.lastSeen });
            }
            return;
        }
    }

    waitingUsers.add(userId);
    tryMatchWaiting();
    broadcastOnlineUsers();
  });

  socket.on('update-profile-info', (data) => {
      const userId = socketToUser.get(socket.id);
      if(userId) {
          const user = users.get(userId);
          if (user) {
              if (data.name) user.name = data.name;
              if (data.age) user.age = data.age;
          }
      }
  });

  socket.on('update-profile-pic', (url) => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
        const user = users.get(userId);
        if (user) {
            user.profilePic = url;
            const partnerSocket = getPartnerSocket(userId);
            if (partnerSocket) partnerSocket.emit('partner-profile-updated', url);
        }
    }
  });

  socket.on('add-story', (data) => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
        const user = users.get(userId);
        if (user) {
            user.stories.push({
                id: uuidv4(),
                url: data.url || data,
                type: data.type || 'image', 
                timestamp: Date.now(),
                viewers: []
            });
        }
    }
  });

  socket.on('delete-story', (storyId) => {
      const userId = socketToUser.get(socket.id);
      if (userId) {
          const user = users.get(userId);
          if (user) {
              user.stories = user.stories.filter(s => s.id !== storyId);
          }
      }
  });

  socket.on('get-stories', () => {
      const userId = socketToUser.get(socket.id);
      if (!userId) return;
      const myInfo = users.get(userId);
      const partnerId = pairs.get(userId);
      let partnerInfo = partnerId ? users.get(partnerId) : null;
      
      socket.emit('stories-data', {
          myStories: myInfo ? myInfo.stories : [],
          partnerStories: partnerInfo ? partnerInfo.stories : [],
          partnerName: partnerInfo ? partnerInfo.name : 'Partner'
      });
  });

  socket.on('view-story', (storyId) => {
      const userId = socketToUser.get(socket.id);
      const partnerId = pairs.get(userId);
      if (userId && partnerId) {
          const myInfo = users.get(userId);
          const partnerInfo = users.get(partnerId);
          
          if (myInfo && partnerInfo) {
              const story = partnerInfo.stories.find(s => s.id === storyId);
              if (story) {
                  if (!story.viewers.find(v => v.id === userId)) {
                      story.viewers.push({ id: userId, name: myInfo.name });
                  }
              }
          }
      }
  });

  socket.on('message', (msgData) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    const partnerId = pairs.get(userId);
    if (!partnerId) return;
    
    const messageId = uuidv4();
    const fullMessage = {
      id: messageId,
      ...msgData,
      timestamp: Date.now(),
      from: userId
    };

    const pairKey = getPairKey(userId, partnerId);
    if (!chatHistories.has(pairKey)) chatHistories.set(pairKey, []);
    const arr = chatHistories.get(pairKey);
    arr.push(fullMessage);
    if(arr.length > 1000) arr.shift(); 

    const partnerSocket = getPartnerSocket(userId);
    if (partnerSocket) partnerSocket.emit('message', fullMessage);
    socket.emit('message-confirmed', { id: messageId });
  });

  socket.on('delete-for-everyone', ({ msgId }) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    const partnerId = pairs.get(userId);
    
    if (partnerId) {
        const pairKey = getPairKey(userId, partnerId);
        const arr = chatHistories.get(pairKey);
        if (arr) {
            const msgObj = arr.find(m => m.id === msgId);
            if(msgObj) msgObj.type = 'deleted';
        }
    }

    const partnerSocket = getPartnerSocket(userId);
    if (partnerSocket) partnerSocket.emit('delete-for-everyone', { msgId });
    socket.emit('delete-for-everyone', { msgId });
  });

  socket.on('typing', () => {
    const partnerSocket = getPartnerSocket(socketToUser.get(socket.id));
    if (partnerSocket) partnerSocket.emit('typing');
  });

  socket.on('putus-hubungan', () => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    
    waitingUsers.delete(userId);

    const partnerId = pairs.get(userId);
    if (partnerId) {
        pairs.delete(userId);
        pairs.delete(partnerId);
        
        const pairKey = getPairKey(userId, partnerId);
        chatHistories.delete(pairKey);
        
        const user1 = users.get(userId);
        const user2 = users.get(partnerId);
        if (user1) user1.history.delete(partnerId);
        if (user2) user2.history.delete(userId);
        
        const partnerSocket = io.sockets.sockets.get(users.get(partnerId)?.socketId);
        if (partnerSocket) {
            partnerSocket.emit('partner-disconnected');
        }
    }
    
    broadcastOnlineUsers();
  });

  socket.on('call-user', (data) => {
    const partnerSocket = getPartnerSocket(socketToUser.get(socket.id));
    if (!partnerSocket) {
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

    activeCalls.set(socket.id, { to: partnerSocket.id, timeout });
    partnerSocket.emit('incoming-call', { 
        name: getDisplayName(socketToUser.get(socket.id)),
        isVideo: data ? data.isVideo : true
    });
    socket.emit('call-sent');
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

  socket.on('offer', (offer) => { const p = getPartnerSocket(socketToUser.get(socket.id)); if (p) p.emit('offer', offer); });
  socket.on('answer', (answer) => { const p = getPartnerSocket(socketToUser.get(socket.id)); if (p) p.emit('answer', answer); });
  socket.on('ice', (candidate) => { const p = getPartnerSocket(socketToUser.get(socket.id)); if (p) p.emit('ice', candidate); });

  socket.on('media-status', (status) => {
    const p = getPartnerSocket(socketToUser.get(socket.id));
    if (p) p.emit('media-status', status);
  });

  socket.on('end-call', () => {
    if (recentlyEndedCalls.has(socket.id)) return;
    recentlyEndedCalls.add(socket.id);
    setTimeout(() => recentlyEndedCalls.delete(socket.id), 8000);

    const p = getPartnerSocket(socketToUser.get(socket.id));
    if (p) p.emit('end-call');
    activeCalls.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di port ${PORT}`);
});