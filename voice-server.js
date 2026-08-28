/**
 * voice-server.js — 简单的 WebSocket 信令后端（支持手机浏览器）
 * 运行:  npm install ws   然后   node voice-server.js
 * 默认端口 3001，支持与 PHP 版 index.php 共存（PHP轮询为兜底，WS优先）
 *
 * 前端会自动尝试连接 wss://当前域名:3001，成功则走 WS，失败则回退到 PHP 文件轮询
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.VOICE_PORT ? parseInt(process.env.VOICE_PORT, 10) : 3001;

// roomId -> Map<userId, {ws, name, ts}>
const rooms = new Map();
// ws -> {roomId, userId}
const wsMeta = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}
function broadcastPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peers = {};
  for (const [uid, info] of room.entries()) peers[uid] = { name: info.name, ts: Date.now(), muted: !!info.muted };
  const msg = JSON.stringify({ type: 'peers', peers });
  for (const info of room.values()) {
    try { if (info.ws.readyState === 1) info.ws.send(msg); } catch (e) {}
  }
}
function sendTo(roomId, targetId, data) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const info = room.get(targetId);
  if (!info || info.ws.readyState !== 1) return false;
  try { info.ws.send(JSON.stringify(data)); return true; } catch (e) { return false; }
}

// 定时清理 18s 无心跳的 peer（从70s→30s→18s，5G切WiFi/掉线秒级提示）
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    let changed = false;
    for (const [uid, info] of room.entries()) {
      if (now - info.ts > 18000) {
        try { info.ws.close(); } catch (e) {}
        room.delete(uid);
        wsMeta.delete(info.ws);
        changed = true;
      }
    }
    if (changed) {
      broadcastPeers(roomId);
      // 通知剩余成员有人离开
      const leaveMsg = JSON.stringify({ type: 'signal', from: '__server', kind: 'leave', payload: '' });
      for (const info of room.values()) try { info.ws.send(leaveMsg); } catch (e) {}
    }
    if (room.size === 0) rooms.delete(roomId);
  }
}, 5000);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, port: PORT }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('voice-server ok. Use WebSocket ws://host:' + PORT + '\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const type = msg.type || msg.action;

    if (type === 'join') {
      const roomId = String(msg.room || msg.chatId || msg.chat_id || '').trim();
      const userId = String(msg.userId || msg.user_id || '').trim();
      const name = String(msg.name || userId).trim();
      if (!roomId || !userId) return;
      // 如果已在其他房间，先移除
      const old = wsMeta.get(ws);
      if (old && old.roomId !== roomId) {
        const oldRoom = rooms.get(old.roomId);
        if (oldRoom) { oldRoom.delete(old.userId); broadcastPeers(old.roomId); }
      }
      const room = getRoom(roomId);
      const existing = room.get(userId);
      const prevMuted = existing ? !!existing.muted : false;
      room.set(userId, { ws, name, ts: Date.now(), muted: prevMuted });
      wsMeta.set(ws, { roomId, userId });
      // 回复自己 peers
      const peers = {};
      for (const [uid, info] of room.entries()) peers[uid] = { name: info.name, muted: !!info.muted };
      ws.send(JSON.stringify({ type: 'joined', peers, userId }));
      // 广播给其他人
      broadcastPeers(roomId);
      return;
    }

    if (type === 'heartbeat' || type === 'ping') {
      const meta = wsMeta.get(ws);
      if (meta) {
        const room = rooms.get(meta.roomId);
        if (room && room.has(meta.userId)) room.get(meta.userId).ts = Date.now();
      }
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
      return;
    }

    if (type === 'leave') {
      const meta = wsMeta.get(ws);
      if (!meta) return;
      const room = rooms.get(meta.roomId);
      if (room) {
        room.delete(meta.userId);
        broadcastPeers(meta.roomId);
        const leaveMsg = JSON.stringify({ type: 'signal', from: meta.userId, kind: 'leave', payload: '' });
        for (const info of room.values()) try { info.ws.send(leaveMsg); } catch (e) {}
      }
      wsMeta.delete(ws);
      return;
    }

    // 静音状态同步
    if (type === 'mute' || (type === 'signal' && (msg.kind === 'mute' || msg.payload === 'mute' || String(msg.payload).includes('muted')))) {
      const meta = wsMeta.get(ws);
      if (!meta) return;
      let muted = false;
      try {
        const j = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        if (j && typeof j.muted !== 'undefined') muted = !!j.muted;
        else if (msg.muted !== undefined) muted = !!msg.muted;
      } catch(e) {
        muted = String(msg.payload).includes('true');
      }
      if (msg.muted !== undefined) muted = !!msg.muted;
      const room = rooms.get(meta.roomId);
      if (room && room.has(meta.userId)) {
        room.get(meta.userId).muted = muted;
        room.get(meta.userId).ts = Date.now();
        broadcastPeers(meta.roomId);
      }
      return;
    }

    // 信令转发: signal / offer / answer / ice
    if (type === 'signal' || type === 'offer' || type === 'answer' || type === 'ice') {
      const meta = wsMeta.get(ws);
      if (!meta) return;
      const roomId = meta.roomId;
      const from = meta.userId;
      const to = String(msg.to || msg.target || '').trim();
      // 兼容前端发 {type: "offer", payload: "..."} 之类
      let kind = msg.kind || type;
      if (['offer', 'answer', 'ice'].includes(type)) kind = type;
      let payload = msg.payload || msg.sdp || msg.candidate || '';
      if (typeof payload !== 'string') payload = JSON.stringify(payload);
      const out = { type: 'signal', from, to: to || '', kind, payload, ts: Date.now() };
      if (to) {
        sendTo(roomId, to, out);
      } else {
        // 广播给房间内除自己外的所有人（用于 leave）
        const room = rooms.get(roomId);
        if (room) for (const [uid, info] of room.entries()) if (uid !== from) try { info.ws.send(JSON.stringify(out)); } catch (e) {}
      }
      // 更新心跳
      const room = rooms.get(roomId);
      if (room && room.has(from)) room.get(from).ts = Date.now();
      return;
    }
  });

  ws.on('close', () => {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    const roomId = meta.roomId;
    const userId = meta.userId;
    const wasCleanLeave = !roomId || !userId;
    const room = rooms.get(roomId);
    if (room) {
      const existed = room.has(userId);
      room.delete(userId);
      if (existed) {
        broadcastPeers(roomId);
        const leaveMsg = JSON.stringify({ type: 'signal', from: userId, kind: 'leave', payload: '' });
        for (const info of room.values()) try { info.ws.send(leaveMsg); } catch (e) {}
        // 让已掉线的用户本身超时不重要，关键是让剩余成员秒级感知
      }
      if (room.size === 0) rooms.delete(roomId);
    }
    wsMeta.delete(ws);
  });
  ws.on('error', () => {});
});

// 心跳检测 ws（15s 一轮，配合前端 7s 心跳，断线 20-30s 内必感知）
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[voice-server] listening on 0.0.0.0:${PORT}  (ws://host:${PORT})`);
  console.log(`[voice-server] health: http://host:${PORT}/health`);
});
