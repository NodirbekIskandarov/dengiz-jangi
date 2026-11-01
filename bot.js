/*
 * Kompyuter raqib.
 *  - "oson": ko'pincha tasodifiy otadi, tekkan kemani ham har doim tugatavermaydi
 *    (o'rtacha ~66 o'qda yutadi).
 *  - "qiyin": tekkan kemani oxirigacha cho'ktiradi, qolgan vaqtda kemalar
 *    qayerda bo'lishi ehtimoli eng katta katakni hisoblaydi (o'rtacha ~56 o'q).
 */
'use strict';
const G = require('./public/game.js');

const EASY_RANDOM = 0.8;   // "oson" daraja yurishlarining qanchasi butunlay tasodifiy

function emptyCells(shots) {
  const out = [];
  for (let r = 0; r < G.SIZE; r++) for (let c = 0; c < G.SIZE; c++) if (shots[r][c] === G.EMPTY) out.push([r, c]);
  return out;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Cho'kmagan, lekin tekkan kataklar bo'yicha keyingi nishonlar. */
function targetCandidates(shots) {
  const hits = [];
  for (let r = 0; r < G.SIZE; r++) for (let c = 0; c < G.SIZE; c++) if (shots[r][c] === G.HIT) hits.push([r, c]);
  if (!hits.length) return [];

  // Birinchi tekkan katakdan boshlab bir kemaga tegishli kataklarni yig'amiz
  const key = (r, c) => r * G.SIZE + c;
  const hitSet = new Set(hits.map(([r, c]) => key(r, c)));
  const group = [hits[0]];
  const seen = new Set([key(...hits[0])]);
  for (let i = 0; i < group.length; i++) {
    const [r, c] = group[i];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(r + dr, c + dc);
      if (G.inBounds(r + dr, c + dc) && hitSet.has(k) && !seen.has(k)) { seen.add(k); group.push([r + dr, c + dc]); }
    }
  }

  const free = (r, c) => G.inBounds(r, c) && shots[r][c] === G.EMPTY;
  const out = [];
  if (group.length === 1) {
    const [r, c] = group[0];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (free(r + dr, c + dc)) out.push([r + dr, c + dc]);
  } else {
    const vertical = group[0][1] === group[1][1];
    const rs = group.map(p => p[0]), cs = group.map(p => p[1]);
    if (vertical) {
      const c = cs[0], min = Math.min(...rs), max = Math.max(...rs);
      if (free(min - 1, c)) out.push([min - 1, c]);
      if (free(max + 1, c)) out.push([max + 1, c]);
    } else {
      const r = rs[0], min = Math.min(...cs), max = Math.max(...cs);
      if (free(r, min - 1)) out.push([r, min - 1]);
      if (free(r, max + 1)) out.push([r, max + 1]);
    }
  }
  return out;
}

/** Har bir katakka qolgan kemalar necha xil usulda sig'ishini sanaydi. */
function densityPick(shots, remaining) {
  const score = G.emptyGrid(0);
  const free = (r, c) => shots[r][c] === G.EMPTY;
  for (const len of remaining) {
    for (let r = 0; r < G.SIZE; r++) {
      for (let c = 0; c < G.SIZE; c++) {
        if (c + len <= G.SIZE) {
          let ok = true;
          for (let i = 0; i < len && ok; i++) ok = free(r, c + i);
          if (ok) for (let i = 0; i < len; i++) score[r][c + i]++;
        }
        if (len > 1 && r + len <= G.SIZE) {
          let ok = true;
          for (let i = 0; i < len && ok; i++) ok = free(r + i, c);
          if (ok) for (let i = 0; i < len; i++) score[r + i][c]++;
        }
      }
    }
  }
  let best = -1, cells = [];
  for (let r = 0; r < G.SIZE; r++) for (let c = 0; c < G.SIZE; c++) {
    if (!free(r, c)) continue;
    if (score[r][c] > best) { best = score[r][c]; cells = [[r, c]]; }
    else if (score[r][c] === best) cells.push([r, c]);
  }
  return cells.length ? pick(cells) : null;
}

function chooseShot(board, level) {
  const shots = board.shots;
  if (level !== 'hard' && Math.random() < EASY_RANDOM) return pick(emptyCells(shots));
  const targets = targetCandidates(shots);
  if (targets.length) return pick(targets);
  if (level === 'hard') {
    const p = densityPick(shots, G.remainingFleet(board));
    if (p) return p;
  }
  return pick(emptyCells(shots));
}

module.exports = { chooseShot };
