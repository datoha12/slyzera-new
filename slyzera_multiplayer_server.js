const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const CLIENT_FILE = path.join(ROOT, "index.html");
const clients = new Map();
const SNAPSHOT_MS = 50;
const CLIENT_TIMEOUT_MS = 8000;

// ─── АВТОРИТЕТНЫЕ БОТЫ ───────────────────────────────────────────────────────
const WORLD_RADIUS = 5200;
const SEGMENT_SPACING = 13;
const BOT_COUNT = 32;
const BOT_NAMES = ["Pulse","Nova","Viper","Orbit","Lumen","Blitz","Echo","Ion",
                   "Pixel","Comet","Zed","Rune","Sparks","Mira","Flux","Drift",
                   "Krux","Sable","Neon","Flux","Quill","Ryze","Talon","Wren"];
const SNAKE_TYPE_IDS = ["default","coral","ocean","forest","sunset","galaxy",
                        "cherry","arctic","volcano","batman","catdog","neon"];
const BOT_TICK_MS = 100; // боты обновляются каждые 100мс на сервере

const bots = new Map(); // id -> bot state

function seededRand(seed) {
  // простой PRNG для воспроизводимых позиций
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function randomWorldPoint(rng, inset = 0) {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * (WORLD_RADIUS - inset);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function makeBot(index) {
  const rng = seededRand(index * 7919 + 12345);
  const pos = randomWorldPoint(rng, 300);
  const angle = rng() * Math.PI * 2;
  const typeId = SNAKE_TYPE_IDS[index % SNAKE_TYPE_IDS.length];
  const segs = [];
  for (let i = 0; i < 20; i++) {
    segs.push({
      x: pos.x - Math.cos(angle) * i * SEGMENT_SPACING,
      y: pos.y - Math.sin(angle) * i * SEGMENT_SPACING
    });
  }
  return {
    id: "bot_" + index,
    isBot: true,
    name: BOT_NAMES[index % BOT_NAMES.length],
    typeId,
    accessory: "none",
    angle,
    targetAngle: angle,
    speed: 130 + rng() * 30,
    score: 20 + Math.floor(rng() * 60),
    desiredLength: 20,
    radius: 10,
    alive: true,
    segments: segs,
    wanderAngle: angle,
    wanderTimer: 0,
    respawnTimer: 0,
  };
}

function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    bots.set("bot_" + i, makeBot(i));
  }
}

function updateBots(dt) {
  const now = Date.now();
  for (const [id, bot] of bots) {
    if (!bot.alive) {
      bot.respawnTimer -= dt;
      if (bot.respawnTimer <= 0) {
        const fresh = makeBot(parseInt(id.split("_")[1]));
        // позиция при респауне случайная
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (WORLD_RADIUS - 300);
        fresh.segments = fresh.segments.map((_, i) => ({
          x: Math.cos(a) * r - Math.cos(fresh.angle) * i * SEGMENT_SPACING,
          y: Math.sin(a) * r - Math.sin(fresh.angle) * i * SEGMENT_SPACING,
        }));
        fresh.segments[0] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
        bots.set(id, fresh);
      }
      continue;
    }

    // простой wander AI
    bot.wanderTimer -= dt;
    if (bot.wanderTimer <= 0) {
      bot.wanderTimer = 1.5 + Math.random() * 3;
      bot.wanderAngle = Math.random() * Math.PI * 2;
    }

    // поворот к цели
    let da = bot.wanderAngle - bot.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    bot.angle += da * 0.06;

    // отталкивание от края
    const hx = bot.segments[0].x, hy = bot.segments[0].y;
    if (Math.hypot(hx, hy) > WORLD_RADIUS - 500) {
      bot.wanderAngle = Math.atan2(-hy, -hx);
    }

    const speed = bot.speed;
    const nx = hx + Math.cos(bot.angle) * speed * dt;
    const ny = hy + Math.sin(bot.angle) * speed * dt;
    bot.segments.unshift({ x: nx, y: ny });

    // подрезаем хвост по desiredLength
    let total = 0;
    const trim = [bot.segments[0]];
    for (let i = 1; i < bot.segments.length; i++) {
      const prev = trim[trim.length - 1], cur = bot.segments[i];
      const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (d === 0) continue;
      if (total + d >= bot.desiredLength * SEGMENT_SPACING) break;
      trim.push({ x: prev.x + (cur.x - prev.x) / d * Math.min(SEGMENT_SPACING, d),
                  y: prev.y + (cur.y - prev.y) / d * Math.min(SEGMENT_SPACING, d) });
      total += Math.min(SEGMENT_SPACING, d);
    }
    bot.segments = trim;
  }
}

// ─── АВТОРИТЕТНЫЕ КОЛЛИЗИИ ────────────────────────────────────────────────────
// Проверяем: врезался ли живой игрок в другого (или в бота)
function runServerCollisions() {
  const allSnakes = [
    ...[...clients.values()].filter(c => c.state && c.state.alive),
    ...[...bots.values()].filter(b => b.alive),
  ];

  for (const [id, client] of clients) {
    const p = client.state;
    if (!p || !p.alive || !p.segments || !p.segments.length) continue;
    if ((p.spawnGrace || 0) > 0) continue; // спавн-защита — не убиваем новичка
    const head = p.segments[0];
    const hitR = (p.radius || 10) * 0.78;

    for (const other of allSnakes) {
      // не проверяем сам с собой
      if (other === p || other.id === id) continue;
      if (!other.segments || !other.segments.length) continue;
      const otherHitR = (other.radius || 10) * 0.78;
      const totalHit = hitR + otherHitR;

      for (let i = 0; i < other.segments.length; i += 2) {
        const seg = other.segments[i];
        if (Math.hypot(seg.x - head.x, seg.y - head.y) < totalHit) {
          // игрок умер
          p.alive = false;
          // сообщаем игроку что он умер
          send(client.socket, { type: "killed", by: other.name || "?" });
          // бродкастим всем что игрок умер
          broadcast({ type: "player_died", id }, id);
          break;
        }
      }
      if (!p.alive) break;
    }
  }
}

initBots();

// Тик ботов
let lastBotTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastBotTick) / 1000, 0.1);
  lastBotTick = now;
  updateBots(dt);
  runServerCollisions();
}, BOT_TICK_MS);

// ─── WebSocket helpers ────────────────────────────────────────────────────────
function send(ws, data) {
  if (!ws.writable || ws.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65536
      ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      : null;
  if (!header) return;
  ws.write(Buffer.concat([header, payload]));
}

function broadcast(data, exceptId = null) {
  for (const [id, client] of clients) {
    if (id === exceptId) continue;
    send(client.socket, data);
  }
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      return { messages, rest: Buffer.alloc(0) };
    }
    const maskOffset = offset + header;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    if (offset + header + (masked ? 4 : 0) + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(dataOffset, dataOffset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    if (opcode === 1) {
      try { messages.push(JSON.parse(payload.toString("utf8"))); } catch {}
    }
    offset = dataOffset + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = urlPath === "/" ? CLIENT_FILE : path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".avif": "image/avif", ".js": "text/javascript" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "", ""
  ].join("\r\n"));

  const id = crypto.randomBytes(6).toString("hex");
  const client = { id, socket, state: null, buffer: Buffer.alloc(0) };
  clients.set(id, client);

  // Отправляем приветствие + текущих игроков + ВСЕХ ботов
  send(socket, { type: "welcome", id });
  send(socket, {
    type: "players",
    players: [...clients.values()].filter(c => c.state).map(c => c.state),
    bots: [...bots.values()].map(botSnapshot),
  });

  socket.on("data", chunk => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const decoded = decodeFrames(client.buffer);
    client.buffer = decoded.rest;
    for (const msg of decoded.messages) {
      if (msg.type === "state" && msg.player) {
        client.state = { ...msg.player, id, serverSeenAt: Date.now() };
        // Не ретранслируем мгновенно — единый снапшот 20Гц ниже даёт ровный поток
        // без двойных обновлений и рывков интерполяции.
      }
    }
  });

  socket.on("close", () => { clients.delete(id); broadcast({ type: "leave", id }); });
  socket.on("error", () => { clients.delete(id); broadcast({ type: "leave", id }); });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Slyzera server: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});

// ─── Snapshot helper ──────────────────────────────────────────────────────────
// Лёгкий снапшот: только голова. Тело бота клиент строит сам (тянущийся хвост).
// Это в ~30 раз меньше трафика, чем слать все сегменты.
function botSnapshot(b) {
  const head = b.segments[0] || { x: 0, y: 0 };
  return {
    id: b.id,
    isBot: true,
    name: b.name,
    typeId: b.typeId,
    angle: Math.round(b.angle * 1000) / 1000,
    score: Math.round(b.score),
    desiredLength: Math.round(b.desiredLength),
    radius: b.radius,
    alive: b.alive,
    x: Math.round(head.x),
    y: Math.round(head.y),
  };
}

// ─── Главный broadcast цикл ───────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  // Таймаут неактивных клиентов
  for (const [id, client] of clients) {
    if (client.state && now - (client.state.serverSeenAt || now) > CLIENT_TIMEOUT_MS) {
      clients.delete(id);
      try { client.socket.destroy(); } catch {}
      broadcast({ type: "leave", id });
    }
  }

  // Рассылаем состояние игроков и ботов всем
  const players = [...clients.values()].filter(c => c.state).map(c => c.state);
  const botList = [...bots.values()].map(botSnapshot);

  if (clients.size > 0) {
    broadcast({
      type: "players",
      players,
      bots: botList,
      serverTime: now,
    });
  }
}, SNAPSHOT_MS);
