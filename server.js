/*
 * Dengiz jangi — multiplayer server (Express + Socket.io).
 *
 * O'yin turlari:
 *   friend — xona kodi / havola orqali do'st bilan
 *   random — tasodifiy raqib (navbat orqali juftlash)
 *   bot    — kompyuter bilan
 *
 * Barcha o'yin holati serverda saqlanadi; mijozga faqat u ko'rishi
 * mumkin bo'lgan ma'lumot yuboriladi (raqib kemalari o'yin oxirigacha yashirin).
 */
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const G = require('./public/game.js');
const { chooseShot } = require('./bot.js');
const stats = require('./stats.js');

const PORT = Number(process.env.PORT) || 3000;
const TURN_SECONDS = 30;          // bir yurish uchun vaqt
const PLACE_SECONDS = 120;        // kemalarni joylashtirish uchun vaqt
const RECONNECT_SECONDS = 60;     // uzilgan o'yinchini kutish vaqti
const MAX_TIMEOUTS = 3;           // ketma-ket shuncha marta vaqt o'tsa — mag'lubiyat
const WAITING_ROOM_TTL = 30 * 60 * 1000;
const IDLE_ROOM_TTL = 15 * 60 * 1000;
const BOT_ID = 'BOT';
const BOT_FAST = process.env.BOT_FAST === '1';   // faqat avtomatik sinov uchun

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));
app.get('/health', (req, res) => res.json({ ok: true, online: onlineCount(), rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8 * 1024, pingInterval: 20000, pingTimeout: 20000 });

/** playerId -> { id, name, autoName, statId, lang, socketId, roomCode, lastSeen, lastChat } */
const players = new Map();
/** code -> room */
const rooms = new Map();
/** tasodifiy raqib kutayotganlar (playerId) */
let queue = [];

// ---------------------------------------------------------------- yordamchilar

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function cleanCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
}

function onlineCount() {
  let n = 0;
  for (const p of players.values()) if (p.socketId) n++;
  return n;
}

function socketOf(pid) {
  const p = players.get(pid);
  return p && p.socketId ? io.sockets.sockets.get(p.socketId) : null;
}

function emitTo(pid, event, data) {
  const s = socketOf(pid);
  if (s) s.emit(event, data);
}

function opponentOf(room, pid) {
  return room.players.find(p => p !== pid) || null;
}

function playerName(pid) {
  if (pid === BOT_ID) return 'Kompyuter';
  const p = players.get(pid);
  return p ? p.name : 'O‘yinchi';
}

function isConnected(pid) {
  if (pid === BOT_ID) return true;
  const p = players.get(pid);
  return !!(p && p.socketId);
}

/** Xabar matni mijozda, uning tilida yig'iladi: serverdan faqat kalit va qiymatlar keladi. */
function systemChat(room, key, params) {
  for (const pid of room.players) if (pid !== BOT_ID) emitTo(pid, 'chat', { from: 'system', key, params });
}

/** Xabardagi o'yinchi: kompyuter nomini mijoz o'zi tarjima qiladi. */
function subj(pid) {
  return { name: playerName(pid), bot: pid === BOT_ID };
}

const DEFAULT_NAMES = { uz: 'Dengizchi', ru: 'Моряк', en: 'Sailor' };
function defaultName(lang) {
  return `${DEFAULT_NAMES[lang] || DEFAULT_NAMES.uz} ${Math.floor(100 + Math.random() * 900)}`;
}

// ---------------------------------------------------------------- xona holati

function stateFor(room, pid) {
  const now = Date.now();
  const opp = opponentOf(room, pid);
  const myBoard = room.boards[pid];
  const oppBoard = opp ? room.boards[opp] : null;
  const reveal = room.phase === 'over';
  const rel = x => (x == null ? null : x === pid ? 'me' : 'opp');

  return {
    code: room.code,
    type: room.type,
    level: room.level || null,
    phase: room.phase,
    me: {
      name: playerName(pid),
      ready: !!myBoard,
      ships: myBoard ? myBoard.ships.map(s => ({ r: s.r, c: s.c, len: s.len, v: s.v, sunk: s.hits >= s.len })) : null,
      shots: myBoard ? myBoard.shots : null,
      remaining: myBoard ? G.remainingFleet(myBoard) : G.FLEET.slice(),
      fired: room.fired[pid] || 0,
      timeouts: room.timeouts[pid] || 0
    },
    opp: opp ? {
      name: playerName(opp),
      isBot: opp === BOT_ID,
      connected: isConnected(opp),
      awayLeft: room.awayUntil[opp] ? Math.max(0, room.awayUntil[opp] - now) : null,
      left: room.left === opp,
      ready: !!oppBoard,
      shots: oppBoard ? oppBoard.shots : null,
      sunk: oppBoard ? G.sunkShips(oppBoard) : [],
      remaining: oppBoard ? G.remainingFleet(oppBoard) : G.FLEET.slice(),
      fired: opp ? room.fired[opp] || 0 : 0,
      ships: reveal && oppBoard ? oppBoard.ships.map(s => ({ r: s.r, c: s.c, len: s.len, v: s.v, sunk: s.hits >= s.len })) : null
    } : null,
    turn: rel(room.turn),
    turnLeft: room.turnEndsAt ? Math.max(0, room.turnEndsAt - now) : null,
    turnTotal: TURN_SECONDS * 1000,
    placeLeft: room.placeEndsAt ? Math.max(0, room.placeEndsAt - now) : null,
    placeTotal: PLACE_SECONDS * 1000,
    winner: rel(room.winner),
    endReason: room.endReason || null,
    rematch: { me: room.rematch.has(pid), opp: opp ? room.rematch.has(opp) : false },
    score: { me: room.score[pid] || 0, opp: opp ? room.score[opp] || 0 : 0 },
    round: room.round,
    ratingDelta: room.ratingDelta[pid] != null ? room.ratingDelta[pid] : null,
    lastShot: room.lastShot ? { ...room.lastShot, by: rel(room.lastShot.by) } : null
  };
}

function sendState(room) {
  for (const pid of room.players) {
    if (pid === BOT_ID) continue;
    const p = players.get(pid);
    if (p && p.roomCode === room.code) emitTo(pid, 'state', stateFor(room, pid));  // chiqib ketganlarga yubormaymiz
  }
}

function touch(room) { room.lastActive = Date.now(); }

function createRoom(type, ownerId, extra = {}) {
  const room = {
    code: newRoomCode(),
    type,
    players: [ownerId],
    phase: 'waiting',
    boards: {},
    turn: null,
    turnEndsAt: null,
    turnTimer: null,
    placeEndsAt: null,
    placeTimer: null,
    botTimer: null,
    winner: null,
    endReason: null,
    left: null,
    rematch: new Set(),
    score: {},
    timeouts: {},
    fired: {},
    awayUntil: {},
    awayTimers: {},
    lastShot: null,
    ratingDelta: {},
    shotSeq: 0,
    round: 0,
    nextStarter: null,
    createdAt: Date.now(),
    lastActive: Date.now(),
    ...extra
  };
  rooms.set(room.code, room);
  return room;
}

function clearTimers(room) {
  clearTimeout(room.turnTimer); room.turnTimer = null;
  clearTimeout(room.placeTimer); room.placeTimer = null;
  clearTimeout(room.botTimer); room.botTimer = null;
  for (const t of Object.values(room.awayTimers)) clearTimeout(t);
  room.awayTimers = {};
  room.awayUntil = {};
}

function destroyRoom(room) {
  clearTimers(room);
  for (const pid of room.players) {
    const p = players.get(pid);
    if (p && p.roomCode === room.code) p.roomCode = null;
  }
  rooms.delete(room.code);
}

// ---------------------------------------------------------------- o'yin bosqichlari

function startPlacement(room) {
  clearTimers(room);
  room.phase = 'placing';
  room.boards = {};
  room.turn = null;
  room.turnEndsAt = null;
  room.winner = null;
  room.endReason = null;
  room.rematch = new Set();
  room.timeouts = {};
  room.fired = {};
  room.lastShot = null;
  room.ratingDelta = {};
  room.round++;
  room.placeEndsAt = Date.now() + PLACE_SECONDS * 1000;
  room.placeTimer = setTimeout(() => onPlaceTimeout(room), PLACE_SECONDS * 1000);
  if (room.players.includes(BOT_ID)) room.boards[BOT_ID] = G.createBoard(G.randomFleet());
  touch(room);
  sendState(room);
  armAway(room);
}

/** Taymerlar tozalangandan keyin uzilgan o'yinchilar uchun kutish vaqtini qayta yoqadi. */
function armAway(room) {
  for (const pid of room.players) if (pid !== BOT_ID && !isConnected(pid)) onPlayerAway(pid);
}

function onPlaceTimeout(room) {
  if (room.phase !== 'placing' || !rooms.has(room.code)) return;
  for (const pid of room.players) {
    if (!room.boards[pid]) {
      room.boards[pid] = G.createBoard(G.randomFleet());
      if (pid !== BOT_ID) emitTo(pid, 'chat', { from: 'system', key: 'sys.autoPlaced' });
    }
  }
  startBattle(room);
}

function startBattle(room) {
  clearTimeout(room.placeTimer); room.placeTimer = null;
  room.placeEndsAt = null;
  room.phase = 'playing';
  room.turn = room.nextStarter && room.players.includes(room.nextStarter)
    ? room.nextStarter
    : room.players[Math.floor(Math.random() * 2)];
  room.nextStarter = null;
  systemChat(room, 'sys.battleStarted', subj(room.turn));
  startTurn(room);
}

function startTurn(room) {
  clearTimeout(room.turnTimer); room.turnTimer = null;
  clearTimeout(room.botTimer); room.botTimer = null;
  if (room.phase !== 'playing') return;
  touch(room);

  if (room.turn === BOT_ID) {
    room.turnEndsAt = null;
    const delay = BOT_FAST ? 5 : 650 + Math.random() * 900;
    room.botTimer = setTimeout(() => botMove(room), delay);
  } else if (isConnected(room.turn)) {
    room.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_SECONDS * 1000 + 300);
  } else {
    // navbatdagi o'yinchi uzilgan — u qaytguncha vaqt to'xtatiladi
    room.turnEndsAt = null;
  }
  sendState(room);
}

function onTurnTimeout(room) {
  if (room.phase !== 'playing' || !rooms.has(room.code)) return;
  const pid = room.turn;
  room.timeouts[pid] = (room.timeouts[pid] || 0) + 1;
  if (room.timeouts[pid] >= MAX_TIMEOUTS) {
    systemChat(room, 'sys.afkLost', { ...subj(pid), n: MAX_TIMEOUTS });
    finishGame(room, opponentOf(room, pid), 'afk');
    return;
  }
  systemChat(room, 'sys.turnSkipped', subj(pid));
  room.turn = opponentOf(room, pid);
  startTurn(room);
}

function botMove(room) {
  if (room.phase !== 'playing' || room.turn !== BOT_ID || !rooms.has(room.code)) return;
  const target = opponentOf(room, BOT_ID);
  const board = room.boards[target];
  const [r, c] = chooseShot(board, room.level);
  doFire(room, BOT_ID, r, c);
}

function doFire(room, pid, r, c) {
  const opp = opponentOf(room, pid);
  const board = room.boards[opp];
  const res = G.fire(board, r, c);
  if (res.result === 'invalid' || res.result === 'repeat') return false;

  room.timeouts[pid] = 0;
  room.fired[pid] = (room.fired[pid] || 0) + 1;
  room.shotSeq++;
  room.lastShot = { seq: room.shotSeq, by: pid, r, c, result: res.result, len: res.len || null };
  touch(room);

  if (res.gameOver) {
    finishGame(room, pid, 'all_sunk');
    return true;
  }
  if (res.result === 'miss') room.turn = opp;   // tekkan bo'lsa — yana o'sha o'yinchi otadi
  startTurn(room);
  return true;
}

function finishGame(room, winner, reason) {
  clearTimers(room);
  const started = room.phase === 'playing';   // joylashtirish paytida chiqish reytingga ta'sir qilmaydi
  room.phase = 'over';
  room.turn = null;
  room.turnEndsAt = null;
  room.placeEndsAt = null;
  room.winner = winner;
  room.endReason = reason;
  if (winner) room.score[winner] = (room.score[winner] || 0) + 1;
  // keyingi raundni yutqazgan boshlaydi
  room.nextStarter = winner ? opponentOf(room, winner) : null;
  if (started && winner) recordStats(room, winner, reason);
  touch(room);
  sendState(room);
  armAway(room);
}

// ---------------------------------------------------------------- reyting va statistika

function recordStats(room, winner, reason) {
  const hitsOn = board => (board ? board.shots.flat().filter(v => v === G.HIT || v === G.SUNK).length : 0);
  const info = pid => {
    const p = players.get(pid);
    if (!p || !p.statId) return null;   // kalitsiz mehmon — hisobga olinmaydi
    return {
      statId: p.statId, name: p.name, fired: room.fired[pid] || 0,
      hits: hitsOn(room.boards[opponentOf(room, pid)]),
      allSunk: pid === winner && reason === 'all_sunk'
    };
  };
  if (room.type === 'bot') {
    const pid = room.players.find(x => x !== BOT_ID);
    const x = info(pid);
    if (x) stats.recordBotGame(x, room.level, winner === pid);
  } else {
    const loser = opponentOf(room, winner);
    const a = info(winner), b = info(loser);
    // bitta brauzerning ikki varag'i bir-biriga qarshi o'ynasa — reyting o'zgarmaydi
    if (a && b && a.statId !== b.statId) {
      const delta = stats.recordMatch(a, b);
      room.ratingDelta[winner] = delta[a.statId];
      room.ratingDelta[loser] = delta[b.statId];
    }
  }
  for (const pid of room.players) sendProfile(pid);
}

function sendProfile(pid) {
  const p = players.get(pid);
  if (p && p.statId) emitTo(pid, 'profile', stats.profileFor(p.statId));
}

// ---------------------------------------------------------------- xonadan chiqish, uzilish

function leaveRoom(pid, reason) {
  const p = players.get(pid);
  if (!p || !p.roomCode) return;
  const room = rooms.get(p.roomCode);
  p.roomCode = null;
  if (!room) return;

  const opp = opponentOf(room, pid);
  if (room.type === 'bot' || room.phase === 'waiting' || !opp) {
    destroyRoom(room);
    return;
  }
  if (room.phase === 'placing' || room.phase === 'playing') {
    systemChat(room, reason === 'disconnect' ? 'sys.disconnected' : 'sys.left', subj(pid));
    room.left = pid;
    finishGame(room, opp, reason === 'disconnect' ? 'disconnect' : 'left');
  } else {
    room.left = pid;
    room.rematch.delete(pid);
    sendState(room);
  }
  // ikkala o'yinchi ham chiqib ketgan bo'lsa — xonani o'chiramiz
  const oppPlayer = players.get(opp);
  if (!oppPlayer || oppPlayer.roomCode !== room.code) destroyRoom(room);
}

function onPlayerAway(pid) {
  const p = players.get(pid);
  if (!p || !p.roomCode) return;
  const room = rooms.get(p.roomCode);
  if (!room) { p.roomCode = null; return; }

  if (room.phase === 'waiting') return; // do'st kutilayotgan xona — havola ishlashda davom etadi

  // Navbat uzilgan o'yinchida bo'lsa — vaqtni to'xtatamiz
  if (room.phase === 'playing' && room.turn === pid) {
    clearTimeout(room.turnTimer); room.turnTimer = null;
    room.turnEndsAt = null;
  }

  const wait = room.type === 'bot' || room.phase === 'over' ? 5 * 60 : RECONNECT_SECONDS;
  room.awayUntil[pid] = Date.now() + wait * 1000;
  clearTimeout(room.awayTimers[pid]);
  room.awayTimers[pid] = setTimeout(() => {
    delete room.awayTimers[pid];
    delete room.awayUntil[pid];
    if (!isConnected(pid) && rooms.has(room.code)) leaveRoom(pid, 'disconnect');
  }, wait * 1000);
  sendState(room);
}

function onPlayerBack(pid) {
  const p = players.get(pid);
  const room = p && p.roomCode ? rooms.get(p.roomCode) : null;
  if (!room) { if (p) p.roomCode = null; return; }
  clearTimeout(room.awayTimers[pid]);
  delete room.awayTimers[pid];
  delete room.awayUntil[pid];
  if (room.phase === 'playing' && room.turn === pid && !room.turnTimer) startTurn(room);
  else sendState(room);
}

// ---------------------------------------------------------------- matchmaking

function removeFromQueue(pid) { queue = queue.filter(x => x !== pid); }

function tryMatch(pid) {
  removeFromQueue(pid);
  queue = queue.filter(x => {
    const q = players.get(x);
    return q && q.socketId && !q.roomCode;
  });
  const other = queue.shift();
  if (!other) {
    queue.push(pid);
    emitTo(pid, 'queued', { since: Date.now() });
    return;
  }
  const room = createRoom('random', other);
  room.players.push(pid);
  players.get(other).roomCode = room.code;
  players.get(pid).roomCode = room.code;
  startPlacement(room);
}

// ---------------------------------------------------------------- socket hodisalari

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

io.on('connection', socket => {
  let pid = null;
  // oddiy so'rov cheklovi: 5 soniyada 60 ta hodisa
  let bucket = 60, bucketAt = Date.now();
  const allow = () => {
    const now = Date.now();
    bucket = Math.min(60, bucket + ((now - bucketAt) / 5000) * 60);
    bucketAt = now;
    if (bucket < 1) return false;
    bucket--;
    return true;
  };

  const on = (event, handler) => socket.on(event, (data = {}) => {
    if (!allow()) return;
    if (event !== 'hello' && !pid) return;
    try { handler(data && typeof data === 'object' ? data : {}); }
    catch (err) { console.error(`[${event}]`, err); socket.emit('notice', { key: 'err.server' }); }
  });

  const me = () => players.get(pid);
  const myRoom = () => { const p = me(); return p && p.roomCode ? rooms.get(p.roomCode) : null; };

  on('hello', data => {
    if (pid) return;
    const id = typeof data.playerId === 'string' && ID_RE.test(data.playerId) ? data.playerId : crypto.randomBytes(16).toString('hex');
    pid = id;
    let p = players.get(pid);
    if (!p) {
      p = { id: pid, name: '', autoName: false, statId: null, lang: 'uz', socketId: null, roomCode: null, lastSeen: Date.now(), lastChat: 0 };
      players.set(pid, p);
    }
    const oldSocketId = p.socketId;
    p.socketId = socket.id;
    if (oldSocketId && oldSocketId !== socket.id) {
      // shu o'yinchi boshqa oynada ochgan — eskisini uzamiz
      const old = io.sockets.sockets.get(oldSocketId);
      if (old) { old.emit('replaced'); old.disconnect(true); }
    }
    if (typeof data.lang === 'string' && DEFAULT_NAMES[data.lang]) p.lang = data.lang;
    // brauzerning doimiy kaliti — reyting va statistika shunga bog'lanadi
    if (typeof data.uid === 'string' && ID_RE.test(data.uid)) p.statId = stats.statIdOf(data.uid);
    const given = cleanName(data.name);
    if (given) { p.name = given; p.autoName = false; }
    else if (!p.name) { p.name = defaultName(p.lang); p.autoName = true; }
    p.lastSeen = Date.now();
    socket.emit('welcome', { playerId: pid, name: p.name, online: onlineCount(), inRoom: !!p.roomCode });
    sendProfile(pid);
    if (p.roomCode && rooms.has(p.roomCode)) onPlayerBack(pid);
    else p.roomCode = null;
  });

  on('set_name', data => {
    const name = cleanName(data.name);
    if (name) { me().name = name; me().autoName = false; }
  });

  // Til almashsa, o'yinchi hali ism yozmagan bo'lsa — avtomatik ism ham shu tilda
  on('set_lang', data => {
    const p = me();
    if (typeof data.lang !== 'string' || !DEFAULT_NAMES[data.lang] || data.lang === p.lang) return;
    p.lang = data.lang;
    if (p.autoName && !p.roomCode) {
      p.name = DEFAULT_NAMES[p.lang] + p.name.slice(p.name.lastIndexOf(' '));   // raqami o'zgarmaydi
      socket.emit('auto_name', { name: p.name });
    }
  });

  on('create_room', () => {
    leaveRoom(pid, 'left');
    removeFromQueue(pid);
    const room = createRoom('friend', pid);
    me().roomCode = room.code;
    sendState(room);
  });

  // Taklif havolasi ochilganda: kim chaqirganini ko'rsatish uchun
  on('peek_room', data => {
    const code = cleanCode(data.code);
    const room = rooms.get(code);
    if (!room || room.type !== 'friend') return socket.emit('room_info', { code, ok: false, key: 'err.inviteExpired' });
    if (room.players.includes(pid)) { me().roomCode = room.code; return onPlayerBack(pid); }
    if (room.players.length >= 2 || room.phase !== 'waiting') return socket.emit('room_info', { code, ok: false, key: 'err.roomFull' });
    socket.emit('room_info', { code, ok: true, host: playerName(room.players[0]) });
  });

  on('join_room', data => {
    const code = cleanCode(data.code);
    const room = rooms.get(code);
    if (!room || room.type !== 'friend') return socket.emit('notice', { key: 'err.roomNotFound', kind: 'join' });
    if (room.players.includes(pid)) { me().roomCode = room.code; return onPlayerBack(pid); }
    if (room.players.length >= 2 || room.phase !== 'waiting') return socket.emit('notice', { key: 'err.roomFull', kind: 'join' });
    leaveRoom(pid, 'left');
    removeFromQueue(pid);
    room.players.push(pid);
    me().roomCode = room.code;
    startPlacement(room);
  });

  on('quick_match', () => {
    leaveRoom(pid, 'left');
    tryMatch(pid);
  });

  on('cancel_queue', () => {
    removeFromQueue(pid);
    socket.emit('unqueued');
  });

  on('play_bot', data => {
    leaveRoom(pid, 'left');
    removeFromQueue(pid);
    const level = data.level === 'hard' ? 'hard' : 'easy';
    const room = createRoom('bot', pid, { level });
    room.players.push(BOT_ID);
    me().roomCode = room.code;
    startPlacement(room);
  });

  on('place_fleet', data => {
    const room = myRoom();
    if (!room || room.phase !== 'placing' || room.boards[pid]) return;
    const err = G.validateFleet(data.ships);
    if (err) return socket.emit('notice', { key: 'err.' + err });
    const ships = data.ships.map(s => ({ r: s.r, c: s.c, len: s.len, v: !!s.v }));
    room.boards[pid] = G.createBoard(ships);
    touch(room);
    if (room.players.length === 2 && room.players.every(p => room.boards[p])) startBattle(room);
    else sendState(room);
  });

  on('fire', data => {
    const room = myRoom();
    if (!room || room.phase !== 'playing' || room.turn !== pid) return;
    const r = Number(data.r), c = Number(data.c);
    if (!G.inBounds(r, c)) return;
    doFire(room, pid, r, c);
  });

  on('chat', data => {
    const room = myRoom();
    const p = me();
    if (!room || typeof data.text !== 'string') return;
    const text = data.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (now - p.lastChat < 800) return;
    p.lastChat = now;
    const opp = opponentOf(room, pid);
    socket.emit('chat', { from: 'me', name: p.name, text });
    if (opp && opp !== BOT_ID) emitTo(opp, 'chat', { from: 'opp', name: p.name, text });
  });

  on('rematch', () => {
    const room = myRoom();
    if (!room || room.phase !== 'over' || room.left) return;
    room.rematch.add(pid);
    if (room.type === 'bot' || room.players.every(p => room.rematch.has(p))) startPlacement(room);
    else {
      sendState(room);
      const opp = opponentOf(room, pid);
      if (opp) emitTo(opp, 'chat', { from: 'system', key: 'sys.rematchAsked', params: subj(pid) });
    }
  });

  on('leave_room', () => {
    removeFromQueue(pid);
    leaveRoom(pid, 'left');
    socket.emit('left');
  });

  on('get_profile', () => sendProfile(pid));

  on('get_top', () => {
    const p = me();
    socket.emit('top', stats.top(p.statId));
  });

  on('sync', () => {
    const room = myRoom();
    if (room) socket.emit('state', stateFor(room, pid));
    else socket.emit('left');
  });

  socket.on('disconnect', () => {
    if (!pid) return;
    const p = players.get(pid);
    if (!p || p.socketId !== socket.id) return;
    p.socketId = null;
    p.lastSeen = Date.now();
    removeFromQueue(pid);
    onPlayerAway(pid);
  });
});

// ---------------------------------------------------------------- tozalash va onlayn soni

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const ttl = room.phase === 'waiting' ? WAITING_ROOM_TTL : IDLE_ROOM_TTL;
    if (now - room.lastActive > ttl) destroyRoom(room);
  }
  for (const [id, p] of players) {
    if (!p.socketId && !p.roomCode && now - p.lastSeen > 30 * 60 * 1000) players.delete(id);
  }
}, 60 * 1000).unref();

setInterval(() => io.emit('online', { online: onlineCount() }), 15 * 1000).unref();

// to'xtatilganda reytingni darhol yozib qo'yamiz
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { stats.saveNow(); process.exit(0); });
}

server.listen(PORT, () => console.log(`Dengiz jangi: http://localhost:${PORT}`));

module.exports = { server, io };
