/*
 * Serverni avtomatik sinash: ikki "o'yinchi" ulanib, to'liq o'yin o'ynaydi.
 *   npm test
 */
'use strict';
process.env.PORT = process.env.PORT || '3999';
process.env.BOT_FAST = '1';
// reyting sinov uchun vaqtinchalik papkaga yoziladi
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dengiz-jangi-'));
const assert = require('assert');
const { io: ioc } = require('socket.io-client');
const G = require('../public/game.js');
const { server } = require('../server.js');

const URL = `http://localhost:${process.env.PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = () => require('crypto').randomBytes(12).toString('hex');

function client(name, playerId = rid(), uid = null) {
  const s = ioc(URL, { transports: ['websocket'], forceNew: true });
  const c = { s, name, playerId, state: null, chats: [], notices: [], queued: false, profile: null, top: null };
  s.on('connect', () => s.emit('hello', { playerId, name, uid }));
  s.on('state', st => { c.state = st; });
  s.on('chat', m => c.chats.push(m));
  s.on('notice', n => c.notices.push(n));
  s.on('queued', () => { c.queued = true; });
  s.on('profile', p => { c.profile = p; });
  s.on('top', d => { c.top = d; });
  c.ready = new Promise(res => s.once('welcome', res));
  return c;
}

async function until(fn, ms = 4000, label = 'shart') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(15); }
  throw new Error(`Kutish tugadi: ${label}`);
}

/** Navbat kimda bo'lsa, o'sha o'yinchi birinchi bo'sh katakka otadi. */
async function playToEnd(a, b) {
  let guard = 0;
  while (a.state.phase === 'playing' && guard++ < 400) {
    const shooter = a.state.turn === 'me' ? a : b;
    const grid = shooter.state.opp.shots;
    let target = null;
    for (let r = 0; r < 10 && !target; r++) for (let c = 0; c < 10 && !target; c++) if (grid[r][c] === G.EMPTY) target = [r, c];
    await sleep(100); // server so'rov cheklovidan oshmaslik uchun
    const seq = a.state.lastShot ? a.state.lastShot.seq : 0;
    shooter.s.emit('fire', { r: target[0], c: target[1] });
    await until(() => (a.state.lastShot && a.state.lastShot.seq > seq) || a.state.phase === 'over', 3000, 'otish natijasi');
    await until(() => b.state.lastShot && a.state.lastShot && b.state.lastShot.seq === a.state.lastShot.seq, 3000, 'holat sinxronlashuvi');
  }
}

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));

  // 1) Do'st bilan: xona yaratish, kod orqali kirish, to'liq o'yin
  const a = client('Ali'), b = client('Vali');
  await Promise.all([a.ready, b.ready]);
  a.s.emit('create_room');
  await until(() => a.state && a.state.phase === 'waiting', 2000, 'xona yaratildi');
  const code = a.state.code;
  assert.match(code, /^[A-Z0-9]{5}$/);
  b.s.emit('join_room', { code: code.toLowerCase() });
  await until(() => a.state.phase === 'placing' && b.state && b.state.phase === 'placing', 2000, 'joylashtirish');

  // Noto'g'ri flot rad etilishi kerak
  b.s.emit('place_fleet', { ships: [{ r: 0, c: 0, len: 4, v: false }] });
  await until(() => b.notices.length > 0, 2000, 'xato flot');
  assert.strictEqual(b.notices[0].key, 'err.fleetCount');
  b.notices.length = 0;

  a.s.emit('place_fleet', { ships: G.randomFleet() });
  b.s.emit('place_fleet', { ships: G.randomFleet() });
  await until(() => a.state.phase === 'playing' && b.state.phase === 'playing', 2000, 'jang boshlandi');
  assert.strictEqual(a.state.opp.ships, null, 'raqib kemalari yashirin bo‘lishi kerak');
  assert.notStrictEqual(a.state.turn, b.state.turn);

  // Navbati bo'lmagan o'yinchi ota olmasligi kerak
  const waiting = a.state.turn === 'me' ? b : a;
  waiting.s.emit('fire', { r: 0, c: 0 });
  await sleep(150);
  assert.strictEqual(a.state.lastShot, null, 'navbatsiz otish qabul qilinmasligi kerak');

  // Chat
  a.s.emit('chat', { text: '  Omad!  <b>' });
  await until(() => b.chats.some(m => m.from === 'opp' && m.text === 'Omad! <b>'), 2000, 'chat');

  await playToEnd(a, b);
  assert.strictEqual(a.state.phase, 'over');
  assert.ok(a.state.winner === 'me' || a.state.winner === 'opp');
  assert.ok(Array.isArray(a.state.opp.ships), 'o‘yin oxirida raqib kemalari ochilishi kerak');
  const winner = a.state.winner === 'me' ? a : b;
  assert.strictEqual(winner.state.score.me, 1);
  console.log(`✓ Do'st bilan o'yin: ${winner.name} yutdi (xona ${code})`);

  // 2) Revansh: yutqazgan boshlashi kerak
  a.s.emit('rematch');
  await until(() => b.state.rematch.opp, 2000, 'revansh so‘rovi');
  b.s.emit('rematch');
  await until(() => a.state.phase === 'placing' && a.state.round === 2, 2000, 'revansh');
  a.s.emit('place_fleet', { ships: G.randomFleet() });
  b.s.emit('place_fleet', { ships: G.randomFleet() });
  await until(() => a.state.phase === 'playing' && b.state.phase === 'playing', 2000, '2-raund');
  const loser = winner === a ? b : a;
  assert.strictEqual(loser.state.turn, 'me', 'yutqazgan birinchi otishi kerak');
  console.log('✓ Revansh va navbat tartibi');

  // 3) Qayta ulanish: o'yinchi uziladi va shu id bilan qaytadi
  a.s.disconnect();
  await until(() => b.state.opp.connected === false, 2000, 'uzilish ko‘rindi');
  const a2 = client('Ali', a.playerId);
  await a2.ready;
  await until(() => a2.state && a2.state.phase === 'playing', 2000, 'qayta ulanish holati');
  await until(() => b.state.opp.connected === true, 2000, 'qaytdi');
  assert.ok(a2.state.me.ships.length === 10);
  console.log('✓ Qayta ulanish o‘yinni davom ettiradi');

  // 4) O'yindan chiqish — raqib g'olib
  a2.s.emit('leave_room');
  await until(() => b.state.phase === 'over' && b.state.winner === 'me' && b.state.endReason === 'left', 2000, 'chiqib ketish');
  console.log('✓ O‘yindan chiqqanda raqib g‘olib bo‘ladi');
  b.s.emit('leave_room');

  // 5) Tasodifiy raqib
  const c = client('Sardor'), d = client('Malika');
  await Promise.all([c.ready, d.ready]);
  c.s.emit('quick_match');
  await until(() => c.queued, 2000, 'navbatga qo‘shildi');
  d.s.emit('quick_match');
  await until(() => c.state && d.state && c.state.phase === 'placing' && c.state.code === d.state.code, 2000, 'juftlashdi');
  assert.strictEqual(c.state.opp.name, 'Malika');
  console.log('✓ Tasodifiy raqib topildi');
  c.s.emit('leave_room'); d.s.emit('leave_room');

  // 6) Kompyuter bilan (qiyin daraja) — to'liq o'yin
  for (const level of ['easy', 'hard']) {
    const e = client('Bekzod');
    await e.ready;
    e.s.emit('play_bot', { level });
    await until(() => e.state && e.state.phase === 'placing', 2000, 'bot xonasi');
    e.s.emit('place_fleet', { ships: G.randomFleet() });
    await until(() => e.state.phase === 'playing', 2000, 'bot bilan jang');
    let guard = 0;
    while (e.state.phase === 'playing' && guard++ < 500) {
      if (e.state.turn === 'me') {
        const grid = e.state.opp.shots;
        const empties = [];
        for (let r = 0; r < 10; r++) for (let c2 = 0; c2 < 10; c2++) if (grid[r][c2] === G.EMPTY) empties.push([r, c2]);
        const [r, c2] = empties[Math.floor(Math.random() * empties.length)];
        await sleep(100);
        const seq = e.state.lastShot ? e.state.lastShot.seq : 0;
        e.s.emit('fire', { r, c: c2 });
        await until(() => (e.state.lastShot && e.state.lastShot.seq > seq) || e.state.phase === 'over', 3000, 'otish');
      } else {
        await sleep(50);
      }
    }
    assert.strictEqual(e.state.phase, 'over');
    const myShots = e.state.me.shots.flat().filter(x => x !== G.EMPTY).length;
    console.log(`✓ Kompyuter (${level}) bilan o'yin tugadi: ${e.state.winner === 'me' ? 'odam' : 'kompyuter'} yutdi`);
    void myShots;
    e.s.close();
  }

  // 7) Mavjud bo'lmagan xona
  const f = client('Test');
  await f.ready;
  f.s.emit('join_room', { code: 'ZZZZZ' });
  await until(() => f.notices.length > 0, 2000, 'xona topilmadi xabari');
  assert.strictEqual(f.notices[0].key, 'err.roomNotFound');
  console.log('✓ Noto‘g‘ri kod uchun xabar');

  // 8) Reyting: kalitli ikki o'yinchi, to'liq o'yin
  const g = client('Jasur', rid(), rid()), h = client('Dilnoza', rid(), rid());
  await Promise.all([g.ready, h.ready]);
  await until(() => g.profile && h.profile, 2000, 'profil');
  assert.strictEqual(g.profile.elo, 1000);
  assert.strictEqual(f.profile, null, 'kalitsiz o‘yinchiga profil yuborilmaydi');
  g.s.emit('create_room');
  await until(() => g.state && g.state.phase === 'waiting', 2000, 'reyting xonasi');
  h.s.emit('join_room', { code: g.state.code });
  await until(() => g.state.phase === 'placing' && h.state && h.state.phase === 'placing', 2000, 'reyting joylashtirish');
  g.s.emit('place_fleet', { ships: G.randomFleet() });
  h.s.emit('place_fleet', { ships: G.randomFleet() });
  await until(() => g.state.phase === 'playing' && h.state.phase === 'playing', 2000, 'reyting jangi');
  await playToEnd(g, h);
  const gWin = g.state.winner === 'me';
  const [W, Lz] = gWin ? [g, h] : [h, g];
  await until(() => W.profile.games === 1 && Lz.profile.games === 1, 2000, 'reyting yangilandi');
  assert.strictEqual(W.profile.elo, 1016);
  assert.strictEqual(Lz.profile.elo, 984);
  assert.strictEqual(W.state.ratingDelta, 16);
  assert.strictEqual(Lz.state.ratingDelta, -16);
  assert.strictEqual(W.profile.rank, 1);
  assert.ok(W.profile.shots > 0 && W.profile.hits === 20 && W.profile.bestWin === W.profile.shots);
  W.s.emit('get_top');
  await until(() => W.top, 2000, 'reyting jadvali');
  assert.deepStrictEqual(W.top.list.map(r => [r.name, r.elo, r.me]), [[W.name, 1016, true], [Lz.name, 984, false]]);
  console.log(`✓ Reyting: ${W.name} 1016 (+16), ${Lz.name} 984 (−16), jadval to‘g‘ri`);

  // 9) Kompyuter bilan o'yin reytingni o'zgartirmaydi, statistikaga yoziladi
  g.s.emit('leave_room'); h.s.emit('leave_room');
  await sleep(100);
  const eloBefore = g.profile.elo;
  g.state = null;
  g.s.emit('play_bot', { level: 'hard' });
  await until(() => g.state && g.state.phase === 'placing', 2000, 'reyting: bot xonasi');
  g.s.emit('place_fleet', { ships: G.randomFleet() });
  await until(() => g.state.phase === 'playing', 2000, 'reyting: bot jangi');
  for (let guard = 0; g.state.phase === 'playing' && guard < 500; guard++) {
    if (g.state.turn === 'me') {
      const grid = g.state.opp.shots;
      const empty = [];
      for (let r = 0; r < 10; r++) for (let c2 = 0; c2 < 10; c2++) if (grid[r][c2] === G.EMPTY) empty.push([r, c2]);
      await sleep(100);
      const seq = g.state.lastShot ? g.state.lastShot.seq : 0;
      g.s.emit('fire', { r: empty[0][0], c: empty[0][1] });
      await until(() => (g.state.lastShot && g.state.lastShot.seq > seq) || g.state.phase === 'over', 3000, 'bot: otish');
    } else await sleep(30);
  }
  await until(() => g.profile.botWins.hard + g.profile.botLosses.hard === 1, 2000, 'bot statistikasi');
  assert.strictEqual(g.profile.elo, eloBefore);
  assert.strictEqual(g.state.ratingDelta, null);
  console.log('✓ Kompyuter bilan o‘yin statistikaga yozildi, reyting o‘zgarmadi');

  // 10) Bitta brauzerning ikki varag'i (bir xil kalit) — reyting o'zgarmaydi
  const sameUid = rid();
  const i1 = client('Bir', rid(), sameUid), i2 = client('Ikki', rid(), sameUid);
  await Promise.all([i1.ready, i2.ready]);
  i1.s.emit('create_room');
  await until(() => i1.state && i1.state.phase === 'waiting', 2000, 'bir kalit: xona');
  i2.s.emit('join_room', { code: i1.state.code });
  await until(() => i1.state.phase === 'placing' && i2.state && i2.state.phase === 'placing', 2000, 'bir kalit: joylashtirish');
  i1.s.emit('place_fleet', { ships: G.randomFleet() });
  i2.s.emit('place_fleet', { ships: G.randomFleet() });
  await until(() => i1.state.phase === 'playing' && i2.state.phase === 'playing', 2000, 'bir kalit: jang');
  i2.s.emit('leave_room');
  await until(() => i1.state.phase === 'over', 2000, 'bir kalit: tugadi');
  assert.strictEqual(i1.state.ratingDelta, null);
  await sleep(100);
  assert.strictEqual(i1.profile.games, 0);
  console.log('✓ O‘ziga qarshi o‘ynash reytingni o‘zgartirmaydi');

  // 11) Reyting faylga yoziladi
  require('../stats.js').saveNow();
  const saved = JSON.parse(require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'stats.json'), 'utf8'));
  assert.strictEqual(Object.keys(saved.players).length, 2);   // Jasur va Dilnoza; bir kalitli varaqlar yozilmaydi
  console.log('✓ Reyting faylga saqlandi');

  // 12) Tarjimalar to'liq: har bir tilda bir xil kalitlar, ishlatilgan kalitlar mavjud
  checkTranslations();
  console.log('✓ Tarjimalar to‘liq (uz, ru, en)');

  for (const x of [a2, b, c, d, f, g, h, i1, i2]) x.s.close();
  console.log('\nBarcha sinovlar muvaffaqiyatli o‘tdi.');
  process.exit(0);
})().catch(err => { console.error('✗', err); process.exit(1); });

/** i18n.js lug'atlarini va HTML/JS/serverda ishlatilgan kalitlarni solishtiradi. */
function checkTranslations() {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const root = path.join(__dirname, '..');
  const ctx = { window: {}, document: {}, navigator: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), ctx);
  const dict = ctx.window.I18N.dict;
  const base = Object.keys(dict.uz).sort();
  for (const lang of ['ru', 'en']) {
    assert.deepStrictEqual(Object.keys(dict[lang]).sort(), base, `${lang} tarjimasida kalitlar farq qiladi`);
    for (const k of base) {
      const vars = s => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.strictEqual(vars(dict[lang][k]), vars(dict.uz[k]), `${lang}.${k}: {o‘zgaruvchilar} mos emas`);
    }
  }
  const used = new Set();
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-ph|-aria|-title)?="([^"]+)"/g)) used.add(m[1]);
  const js = fs.readFileSync(path.join(root, 'public/client.js'), 'utf8');
  for (const m of js.matchAll(/\bt\('([a-zA-Z]+\.[a-zA-Z0-9]+)'/g)) used.add(m[1]);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const m of server.matchAll(/'((?:sys|err)\.[a-zA-Z]+)'/g)) used.add(m[1]);
  const game = fs.readFileSync(path.join(root, 'public/game.js'), 'utf8');
  for (const m of game.matchAll(/return '([a-zA-Z]+)';/g)) used.add('err.' + m[1]);
  for (const k of used) assert.ok(k in dict.uz, `tarjima kaliti yo‘q: ${k}`);
}
