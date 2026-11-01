/*
 * O'yinchilar reytingi (Elo) va statistikasi.
 *
 * Har bir brauzer o'zining maxfiy kalitini (uid) yuboradi; serverda u xeshlanib
 * saqlanadi, shuning uchun reyting jadvalidan birovning kalitini bilib bo'lmaydi.
 * Ma'lumotlar DATA_DIR/stats.json faylida turadi va o'zgarganda bir necha
 * soniyada bir marta yoziladi.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'stats.json');
const START_ELO = 1000;
const K_FACTOR = 32;
const SAVE_DELAY = 5000;
const TOP_SIZE = 20;

/** statId -> profil */
let profiles = new Map();
let saveTimer = null;
let topCache = null;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    profiles = new Map(Object.entries(data.players || {}));
    console.log(`Reyting: ${profiles.size} ta o'yinchi yuklandi (${FILE})`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Reyting faylini o‘qib bo‘lmadi:', err.message);
  }
}

function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, players: Object.fromEntries(profiles) }));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('Reytingni saqlab bo‘lmadi:', err.message);
  }
}

function changed() {
  topCache = null;
  if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

/** Maxfiy kalitdan ochiq identifikator (jadvalda faqat shu ishlatiladi). */
function statIdOf(uid) {
  return crypto.createHash('sha256').update('dengiz-jangi:' + uid).digest('hex').slice(0, 20);
}

function get(statId, name) {
  let p = profiles.get(statId);
  if (!p) {
    p = {
      name: name || '', elo: START_ELO, games: 0, wins: 0, losses: 0,
      botWins: { easy: 0, hard: 0 }, botLosses: { easy: 0, hard: 0 },
      shots: 0, hits: 0, bestWin: null, streak: 0, bestStreak: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    profiles.set(statId, p);
  }
  if (name) p.name = name;
  return p;
}

function addResult(p, win, fired, hits) {
  p.shots += fired;
  p.hits += hits;
  if (win) {
    p.streak++;
    p.bestStreak = Math.max(p.bestStreak, p.streak);
  } else {
    p.streak = 0;
  }
  p.updatedAt = Date.now();
}

/**
 * Ikki odam o'rtasidagi o'yin. a — g'olib, b — mag'lub.
 * Har biri: { statId, name, fired, hits, allSunk }
 * Reyting o'zgarishini qaytaradi: { [statId]: delta }
 */
function recordMatch(a, b) {
  const pa = get(a.statId, a.name), pb = get(b.statId, b.name);
  const expected = 1 / (1 + Math.pow(10, (pb.elo - pa.elo) / 400));
  const delta = Math.max(1, Math.round(K_FACTOR * (1 - expected)));
  pa.elo += delta;
  pb.elo = Math.max(100, pb.elo - delta);
  pa.games++; pa.wins++;
  pb.games++; pb.losses++;
  addResult(pa, true, a.fired, a.hits);
  addResult(pb, false, b.fired, b.hits);
  if (a.allSunk && (pa.bestWin == null || a.fired < pa.bestWin)) pa.bestWin = a.fired;
  changed();
  return { [a.statId]: delta, [b.statId]: -delta };
}

/** Kompyuter bilan o'yin — reytingga ta'sir qilmaydi, faqat statistika. */
function recordBotGame(x, level, win) {
  const p = get(x.statId, x.name);
  const lv = level === 'hard' ? 'hard' : 'easy';
  if (win) p.botWins[lv]++; else p.botLosses[lv]++;
  addResult(p, win, x.fired, x.hits);
  if (win && x.allSunk && (p.bestWin == null || x.fired < p.bestWin)) p.bestWin = x.fired;
  changed();
}

function ranked() {
  if (!topCache) {
    topCache = [...profiles.entries()]
      .filter(([, p]) => p.games > 0)
      .sort((x, y) => y[1].elo - x[1].elo || y[1].wins - x[1].wins || x[1].createdAt - y[1].createdAt);
  }
  return topCache;
}

function rankOf(statId) {
  const i = ranked().findIndex(([id]) => id === statId);
  return i === -1 ? null : i + 1;
}

/** O'yinchiga ko'rsatiladigan profil (kalitlarsiz). */
function profileFor(statId) {
  const p = profiles.get(statId);
  if (!p) return { elo: START_ELO, rank: null, games: 0, wins: 0, losses: 0, botWins: { easy: 0, hard: 0 }, botLosses: { easy: 0, hard: 0 }, shots: 0, hits: 0, bestWin: null, streak: 0, bestStreak: 0 };
  return {
    elo: p.elo, rank: rankOf(statId), games: p.games, wins: p.wins, losses: p.losses,
    botWins: p.botWins, botLosses: p.botLosses, shots: p.shots, hits: p.hits,
    bestWin: p.bestWin, streak: p.streak, bestStreak: p.bestStreak
  };
}

function top(statId) {
  const list = ranked().slice(0, TOP_SIZE).map(([id, p], i) => ({
    rank: i + 1, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses, me: id === statId
  }));
  return { list, total: ranked().length };
}

load();

module.exports = { statIdOf, recordMatch, recordBotGame, profileFor, top, saveNow, START_ELO };
