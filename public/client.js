/* Dengiz jangi — brauzer qismi */
(function () {
  'use strict';

  var G = window.SeaGame;
  var L = window.I18N;
  var t = L.t;
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ saqlash (xatoga chidamli)
  function load(key, def, session) {
    try {
      var v = (session ? sessionStorage : localStorage).getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function save(key, val, session) {
    try { (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(val)); } catch (e) { /* ruxsat yo'q */ }
  }

  function newId() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // Har bir brauzer varag'i uchun alohida o'yinchi; sahifa yangilansa ham saqlanadi
  var playerId = load('dj_pid', null, true);
  if (!playerId) { playerId = newId(); save('dj_pid', playerId, true); }

  // Brauzerning doimiy kaliti — reyting va statistika shunga yoziladi.
  // Saqlab bo'lmasa (maxfiy rejim cheklovlari), o'yinchi mehmon sifatida o'ynaydi.
  var uid = load('dj_uid', null);
  if (!uid) { save('dj_uid', newId()); uid = load('dj_uid', null); }

  L.setLang(L.detect(load('dj_lang', null)));

  var CHAT_LIMIT = 60;

  var S = null;                 // serverdan kelgan oxirgi xona holati
  var screen = 'lobby';
  var lastCode = null, lastSeq = 0;
  var prevGrids = { key: null, enemy: null, mine: null, sunkE: 0, sunkM: 0 };
  var pendingFire = false, pendingTimer = null;
  var place = { key: null, ships: [], sel: null, hover: null };
  var deadlines = { turn: null, place: null, away: null };
  var focusPos = { enemyBoard: [0, 0], myBoard: [0, 0] };
  var soundOn = load('dj_sound', true);
  var queueTimer = null;
  var profile = null;           // serverdagi reyting va statistika
  var autoName = '';            // server bergan ism (ism yozilmagan bo'lsa)
  var joinFromUrl = cleanCode(new URLSearchParams(location.search).get('xona') || '');

  // Kirill klaviaturasida terilgan o'xshash harflar ham qabul qilinadi
  var CYR = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y' };
  function cleanCode(s) {
    return String(s).toUpperCase().replace(/[АВЕКМНРСТХУ]/g, function (ch) { return CYR[ch]; })
      .replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  // ------------------------------------------------------------ ovozlar (fayl kerak emas)
  var ac = null;
  function audio() {
    if (!soundOn) return null;
    if (!ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ac = new AC(); } catch (e) { return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(freq, dur, type, vol, slideTo, delay) {
    var a = audio(); if (!a) return;
    var t = a.currentTime + (delay || 0);
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, freq, delay) {
    var a = audio(); if (!a) return;
    var t = a.currentTime + (delay || 0);
    var len = Math.floor(a.sampleRate * dur);
    var buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq;
    g.gain.value = vol;
    src.connect(f).connect(g).connect(a.destination);
    src.start(t);
  }
  var sfx = {
    miss: function () { noise(0.28, 0.18, 1100); tone(540, 0.18, 'sine', 0.05, 240); },
    hit: function () { noise(0.4, 0.45, 1600); tone(150, 0.32, 'triangle', 0.25, 55); },
    sunk: function () { noise(0.9, 0.5, 750); tone(120, 0.75, 'sawtooth', 0.1, 35); tone(90, 0.8, 'triangle', 0.2, 40, 0.05); },
    turn: function () { tone(880, 0.09, 'sine', 0.07); tone(1320, 0.14, 'sine', 0.06, null, 0.09); },
    win: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.22, 'triangle', 0.12, null, i * 0.12); }); },
    lose: function () { [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.3, 'triangle', 0.1, null, i * 0.18); }); },
    tick: function () { tone(700, 0.05, 'square', 0.025); },
    bad: function () { tone(180, 0.12, 'square', 0.04); },
    msg: function () { tone(1046, 0.07, 'sine', 0.05); }
  };
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* yo'q */ } }
  document.addEventListener('pointerdown', function () { audio(); }, { once: true });

  // ------------------------------------------------------------ ekranlar
  function show(name) {
    if (screen === name) return;
    screen = name;
    ['lobby', 'invite', 'queue', 'game', 'top'].forEach(function (n) { $('screen-' + n).hidden = n !== name; });
    document.body.dataset.screen = name;
    if (name !== 'lobby') setInvited(null);
    if (name !== 'queue') { clearTimeout(queueTimer); queueTimer = null; }
    if (name === 'lobby') { renderProfile(); setUrl(null); }
    window.scrollTo(0, 0);
  }

  function setUrl(code) {
    try { history.replaceState(null, '', code ? '?xona=' + code : location.pathname); } catch (e) { /* yo'q */ }
  }

  var toastTimer = null;
  function toast(html, ms, isChat) {
    var t = $('toast');
    t.innerHTML = '';
    if (typeof html === 'string') t.textContent = html; else t.appendChild(html);
    t.className = 'toast' + (isChat ? ' chat-toast' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  function fmt(ms) {
    var s = Math.ceil(ms / 1000), m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ------------------------------------------------------------ ism
  function currentName() { return $('nameInput').value.trim().slice(0, 20); }
  function saveName() {
    var n = currentName();
    if (n) { save('dj_name', n); if (socket.connected) socket.emit('set_name', { name: n }); }
  }
  function syncNamePlaceholder() { $('nameInput').placeholder = autoName || t('lobby.namePh'); }
  $('nameInput').value = load('dj_name', '');
  syncNamePlaceholder();
  document.body.dataset.screen = 'lobby';
  $('nameInput').addEventListener('change', saveName);

  // ------------------------------------------------------------ til
  function syncLangButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.lang === L.lang()));
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) {
    b.addEventListener('click', function () {
      save('dj_lang', L.setLang(b.dataset.lang));
      if (socket.connected) socket.emit('set_lang', { lang: L.lang() });
      relocalize();
    });
  });
  syncLangButtons();

  /** Til almashganda JS yozgan matnlarni qayta chizadi. */
  function relocalize() {
    syncLangButtons();
    syncNamePlaceholder();
    syncSoundBtn();
    setOnline(lastOnline);
    setHint(t('place.hint'));
    if (invited) setInvited(invited);
    if (S && S.phase === 'waiting') showInvite(S.code);
    renderProfile();
    if (screen === 'top') renderTop();
    render();
  }

  // ------------------------------------------------------------ reyting va statistika
  function accuracy(p) { return p.shots ? Math.round(p.hits / p.shots * 100) : 0; }

  function renderProfile() {
    var box = $('profileBox');
    box.hidden = !profile;
    if (!profile) return;
    $('pfElo').textContent = profile.elo;
    $('pfRank').textContent = profile.rank ? t('pf.rank', { n: profile.rank }) : '';
    var played = profile.games + profile.botWins.easy + profile.botWins.hard + profile.botLosses.easy + profile.botLosses.hard;
    $('pfLine').textContent = profile.games
      ? t('pf.line', { w: profile.wins, l: profile.losses }) + (profile.shots ? ' · ' + t('pf.acc', { n: accuracy(profile) }) : '')
      : t('pf.none') + (played && profile.shots ? ' · ' + t('pf.acc', { n: accuracy(profile) }) : '');
  }

  var topData = null;
  function openTop() {
    topData = null;
    show('top');
    renderTop();
    socket.emit('get_top');
    socket.emit('get_profile');
  }
  $('topBtn').addEventListener('click', openTop);
  $('topBack').addEventListener('click', function () { show('lobby'); });

  function renderTop() {
    var list = $('topList'), note = $('topNote');
    list.innerHTML = '';
    if (!topData) { note.textContent = t('top.loading'); }
    else if (!topData.list.length) { note.textContent = t('top.empty'); }
    else {
      topData.list.forEach(function (row) {
        var li = document.createElement('li');
        if (row.me) li.className = 'me';
        var rank = document.createElement('span'); rank.className = 'tr-rank'; rank.textContent = row.rank;
        var name = document.createElement('span'); name.className = 'tr-name'; name.textContent = row.name;
        if (row.me) { var you = document.createElement('em'); you.textContent = ' (' + t('top.you') + ')'; name.appendChild(you); }
        var wl = document.createElement('span'); wl.className = 'tr-wl'; wl.textContent = row.wins + ' – ' + row.losses;
        var elo = document.createElement('span'); elo.className = 'tr-elo'; elo.textContent = row.elo;
        li.appendChild(rank); li.appendChild(name); li.appendChild(wl); li.appendChild(elo);
        list.appendChild(li);
      });
      note.textContent = t('top.total', { n: topData.total });
    }

    var dl = $('myStats');
    dl.innerHTML = '';
    if (!profile) {
      var p = document.createElement('p'); p.textContent = t('st.guest');
      dl.appendChild(p);
      return;
    }
    var rows = [
      ['st.rating', String(profile.elo)],
      ['st.rank', profile.rank ? '#' + profile.rank : '—'],
      ['st.vsPeople', t('st.wl', { w: profile.wins, l: profile.losses })],
      ['st.vsEasy', t('st.wl', { w: profile.botWins.easy, l: profile.botLosses.easy })],
      ['st.vsHard', t('st.wl', { w: profile.botWins.hard, l: profile.botLosses.hard })],
      ['st.acc', profile.shots ? accuracy(profile) + '%' : '—'],
      ['st.best', profile.bestWin ? t('st.bestVal', { n: profile.bestWin }) : '—'],
      ['st.streak', String(profile.bestStreak)]
    ];
    rows.forEach(function (r) {
      var dt = document.createElement('dt'); dt.textContent = t(r[0]);
      var dd = document.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
  }

  // ------------------------------------------------------------ socket
  var socket = io({ transports: ['websocket', 'polling'] });
  var connTimer = null;

  socket.on('connect', function () {
    clearTimeout(connTimer);
    $('connBanner').hidden = true;
    socket.emit('hello', { playerId: playerId, uid: uid, lang: L.lang(), name: currentName() || load('dj_name', '') });
  });
  socket.on('disconnect', function () {
    clearTimeout(connTimer);
    connTimer = setTimeout(function () {
      $('connBanner').textContent = t('conn.lost');
      $('connBanner').hidden = false;
    }, 1500);
  });
  socket.on('replaced', function () {
    socket.io.opts.reconnection = false;
    $('connBanner').textContent = t('conn.replaced');
    $('connBanner').hidden = false;
  });

  socket.on('welcome', function (d) {
    setOnline(d.online);
    // avtomatik ism maslahat sifatida ko'rinadi — yozilgan ism unga qo'shilib ketmasligi uchun
    autoName = d.name;
    syncNamePlaceholder();
    if (d.inRoom) return;                         // holat alohida keladi
    if (joinFromUrl) {
      // ismi saqlangan o'yinchi darhol qo'shiladi, yangisidan avval ism so'raymiz
      socket.emit(load('dj_name', '') ? 'join_room' : 'peek_room', { code: joinFromUrl });
      joinFromUrl = '';
    } else if (screen === 'queue') {
      socket.emit('quick_match');                 // aloqa uzilib qolgan bo'lsa, qayta navbatga
    } else if (screen !== 'lobby') {
      S = null; show('lobby');
    }
  });

  socket.on('online', function (d) { setOnline(d.online); });
  socket.on('auto_name', function (d) { autoName = d.name; syncNamePlaceholder(); });
  var lastOnline = 0;
  function setOnline(n) { lastOnline = n; $('onlineCount').textContent = n ? t('online', { n: n }) : ''; }

  socket.on('profile', function (p) {
    profile = p;
    renderProfile();
    if (screen === 'top') renderTop();
  });
  socket.on('top', function (d) {
    topData = d;
    if (screen === 'top') renderTop();
  });

  socket.on('queued', function () { show('queue'); armQueueHint(); });
  socket.on('unqueued', function () { show('lobby'); });
  socket.on('left', function () { S = null; show('lobby'); });

  socket.on('notice', function (n) {
    if (n.kind === 'join') {
      if (screen !== 'lobby') { S = null; show('lobby'); }
      $('joinError').textContent = t(n.key);
      setUrl(null);
      return;
    }
    toast(t(n.key), 3200);
  });

  socket.on('room_info', function (d) {
    if (!d.ok) { setUrl(null); toast(t(d.key), 4000); $('joinError').textContent = t(d.key); return; }
    show('lobby');
    setUrl(d.code);
    setInvited(d);
  });

  var invited = null;
  function setInvited(d) {
    var fresh = d && d !== invited;
    invited = d;
    document.body.classList.toggle('invited', !!d);
    $('inviteBanner').hidden = !d;
    $('inviteActions').hidden = !d;
    if (d) {
      // "{host} sizni jangga chaqirdi!" — ism marker bilan ajratiladi
      var title = $('ibTitle'), parts = t('lobby.invited').split('{host}');
      title.innerHTML = '';
      title.appendChild(document.createTextNode(parts[0]));
      var host = document.createElement('span'); host.textContent = d.host;
      title.appendChild(host);
      title.appendChild(document.createTextNode(parts[1] || ''));
      if (fresh) $('nameInput').focus();
    }
  }
  $('ibJoin').addEventListener('click', function () {
    if (!invited) return;
    saveName();
    socket.emit('join_room', { code: invited.code });
  });
  $('ibCancel').addEventListener('click', function () { setInvited(null); setUrl(null); });

  socket.on('chat', addChat);
  socket.on('state', onState);

  // ------------------------------------------------------------ bosh sahifa amallari
  $('friendBtn').addEventListener('click', function () { saveName(); socket.emit('create_room'); });
  $('randomBtn').addEventListener('click', function () {
    saveName();
    socket.emit('quick_match');
    show('queue');
    armQueueHint();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () { saveName(); socket.emit('play_bot', { level: b.dataset.level }); });
  });
  $('codeInput').addEventListener('input', function () {
    var v = cleanCode(this.value);
    if (v !== this.value) this.value = v;
    $('joinError').textContent = '';
  });
  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = cleanCode($('codeInput').value);
    if (code.length !== 5) { $('joinError').textContent = t('join.badLen'); return; }
    saveName();
    socket.emit('join_room', { code: code });
  });

  function armQueueHint() {
    $('queueAlt').hidden = true;
    clearTimeout(queueTimer);
    queueTimer = setTimeout(function () { $('queueAlt').hidden = false; }, 12000);
  }
  $('cancelQueueBtn').addEventListener('click', function () { socket.emit('cancel_queue'); show('lobby'); });
  $('queueBotBtn').addEventListener('click', function () { socket.emit('cancel_queue'); socket.emit('play_bot', { level: 'easy' }); });

  function leave() {
    if (screen === 'queue') { socket.emit('cancel_queue'); show('lobby'); return; }
    if (screen === 'top') { show('lobby'); return; }
    var risky = S && (S.phase === 'placing' || S.phase === 'playing') && S.opp && !S.opp.isBot;
    if (risky && !window.confirm(t('game.leaveConfirm'))) return;
    socket.emit('leave_room');
    S = null;
    show('lobby');
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-action="leave"]'), function (b) {
    b.addEventListener('click', leave);
  });
  $('brandBtn').addEventListener('click', function () { if (screen !== 'lobby') leave(); });

  $('soundBtn').addEventListener('click', function () {
    soundOn = !soundOn;
    save('dj_sound', soundOn);
    syncSoundBtn();
    if (soundOn) sfx.tick();
  });
  function syncSoundBtn() {
    var b = $('soundBtn');
    b.setAttribute('aria-pressed', String(soundOn));
    b.setAttribute('aria-label', t(soundOn ? 'sound.off' : 'sound.on'));
  }
  syncSoundBtn();

  // ------------------------------------------------------------ do'stni taklif qilish
  function inviteLink(code) { return location.origin + location.pathname + '?xona=' + code; }

  function showInvite(code) {
    show('invite');
    var link = inviteLink(code);
    $('roomCode').textContent = code;
    $('shareLink').textContent = link;
    $('tgShare').href = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(t('invite.msg'));
    $('shareBtn').hidden = !navigator.share;
    setUrl(code);
  }
  $('shareBtn').addEventListener('click', function () {
    if (!S) return;
    navigator.share({ title: t('brand'), text: t('invite.msg'), url: inviteLink(S.code) }).catch(function () { /* bekor qilindi */ });
  });
  $('copyBtn').addEventListener('click', function () {
    if (!S) return;
    var link = inviteLink(S.code);
    var done = function () { toast(t('invite.copied')); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, fallback);
    else fallback();
    function fallback() {
      var i = document.createElement('input');
      i.value = link; document.body.appendChild(i); i.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast(t('invite.copyFail')); }
      i.remove();
    }
  });

  // ------------------------------------------------------------ chat
  function addChat(m) {
    var log = $('chatLog');
    var p = document.createElement('p');
    p.className = 'msg ' + m.from;
    if (m.from !== 'system') {
      var b = document.createElement('b');
      b.textContent = (m.from === 'me' ? t('game.you') : m.name) + ': ';
      p.appendChild(b);
    }
    p.appendChild(document.createTextNode(m.from === 'system' ? systemText(m) : m.text));
    log.appendChild(p);
    while (log.children.length > CHAT_LIMIT) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    if (m.from === 'opp') {
      var frag = document.createElement('span');
      var nb = document.createElement('b'); nb.textContent = m.name + ': ';
      frag.appendChild(nb); frag.appendChild(document.createTextNode(m.text));
      toast(frag, 3500, true);
      sfx.msg();
    }
  }
  /** Server xabari kalit bilan keladi — matn shu yerda, tanlangan tilda yig'iladi. */
  function systemText(m) {
    var params = {};
    var src = m.params || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) params[k] = src[k];
    if (src.bot) params.name = t('game.computer');
    return t(m.key, params);
  }

  function sendChat(text) {
    text = String(text || '').trim();
    if (text) socket.emit('chat', { text: text });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#quickRow button'), function (b) {
    b.addEventListener('click', function () { sendChat(b.textContent); });
  });
  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    sendChat($('chatInput').value);
    $('chatInput').value = '';
  });

  // ------------------------------------------------------------ holatni qabul qilish
  function onState(st) {
    var prev = S;
    S = st;
    clearTimeout(pendingTimer); pendingFire = false;

    if (st.code !== lastCode) {           // yangi xona — chatni tozalaymiz
      $('chatLog').innerHTML = '';
      lastCode = st.code;
      lastSeq = st.lastShot ? st.lastShot.seq : 0;
      prev = null;
    }

    if (st.phase === 'waiting') { showInvite(st.code); return; }
    show('game');
    setUrl(st.type === 'friend' ? st.code : null);

    var now = performance.now();
    deadlines.turn = st.turnLeft != null ? now + st.turnLeft : null;
    deadlines.place = st.placeLeft != null ? now + st.placeLeft : null;
    deadlines.away = st.opp && st.opp.awayLeft != null ? now + st.opp.awayLeft : null;

    // effektlar faqat jonli o'zgarishlarda (qayta ulanganda emas)
    var shot = st.lastShot && st.lastShot.seq !== lastSeq ? st.lastShot : null;
    if (st.lastShot) lastSeq = st.lastShot.seq;
    if (prev && shot) playShot(shot);
    if (prev && st.phase === 'playing' && prev.phase !== 'playing') sfx.turn();
    if (prev && prev.phase === 'playing' && st.phase === 'playing' && st.turn === 'me' && prev.turn !== 'me' && !shot) sfx.turn();
    if (prev && st.phase === 'playing' && st.turn === 'me' && (prev.turn !== 'me' || prev.phase !== 'playing') && shot && shot.by === 'opp') {
      setTimeout(sfx.turn, 450);
    }
    if (st.phase === 'over' && prev && prev.phase !== 'over') (st.winner === 'me' ? sfx.win : sfx.lose)();
    if (st.phase === 'playing' && st.turn === 'me' && document.hidden) document.title = t('game.yourTurnTitle');

    render();
  }

  function playShot(shot) {
    if (shot.result === 'miss') sfx.miss();
    else if (shot.result === 'hit') sfx.hit();
    else sfx.sunk();
    if (shot.by === 'opp' && shot.result !== 'miss') vibrate(shot.result === 'sunk' ? [120, 60, 160] : 70);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      document.title = t('meta.title');
      if (socket.connected && S) socket.emit('sync');
    }
  });

  // ------------------------------------------------------------ chizish
  function shotText(ls) {
    var key = { miss: 'Miss', hit: 'Hit', sunk: 'Sunk' }[ls.result];
    return t((ls.by === 'me' ? 'shot.my' : 'shot.opp') + key, { c: L.coord(ls.r, ls.c), n: ls.len });
  }

  /** Matnni xavfsiz HTML qiladi va {cd} kabi joylarga taymer qo'yadi. */
  function withTimers(text) {
    return escapeHtml(text)
      .replace('{cd}', '<span class="cd"></span>')
      .replace('{cda}', '<span class="cd-away"></span>');
  }

  function render() {
    var st = S;
    if (!st || st.phase === 'waiting') return;
    var opp = st.opp || { name: '…', isBot: false, connected: false };
    opp.display = opp.isBot ? t('game.computer') : opp.name;

    // yuqori qator
    $('meName').textContent = st.me.name;
    $('oppName').textContent = opp.display;
    $('scoreText').textContent = st.score.me + ' : ' + st.score.opp;
    $('oppDot').className = 'dot' + (opp.isBot ? ' bot' : opp.connected ? '' : ' off');
    $('oppDot').title = t(opp.isBot ? 'game.computer' : opp.connected ? 'game.online' : 'game.offline');

    $('screen-game').dataset.phase = st.phase;
    $('enemyWrap').hidden = st.phase === 'placing';
    $('mineTitle').textContent = t(st.phase === 'placing' ? 'game.myShips' : 'game.myFleet');
    // kompyuter bilan o'ynaganda yozishadigan odam yo'q
    $('quickRow').hidden = $('chatForm').hidden = !!opp.isBot;

    renderStatus(st, opp);
    renderResult(st, opp);
    renderPlacement(st);
    renderBoards(st);
    tick();
  }

  function renderStatus(st, opp) {
    var box = $('statusBox'), main = $('statusMain'), sub = $('statusSub');
    box.hidden = st.phase === 'over';
    box.className = 'status';
    var mainText = '', subHtml = '';
    var showTimer = false;

    if (st.phase === 'placing') {
      showTimer = true;
      if (!st.me.ready) {
        mainText = t('status.place');
        subHtml = withTimers(t(opp.ready ? 'status.oppReady' : 'status.oppPlacing') + ' ' + t('status.autoPlace'));
      } else {
        mainText = t('status.ready');
        subHtml = withTimers(t('status.waitOpp'));
      }
    } else if (st.phase === 'playing') {
      var away = !opp.isBot && !opp.connected;
      if (st.turn === 'me') {
        box.classList.add('mine');
        mainText = t('status.yourTurn');
        showTimer = true;
      } else {
        mainText = t(opp.isBot ? 'status.botThinking' : 'status.oppFiring');
        showTimer = !away;
      }
      var parts = [];
      if (st.lastShot) parts.push(shotText(st.lastShot));
      if (st.turn === 'me') parts.push(t(st.lastShot ? 'status.left' : 'status.pickCell'));
      if (st.me.timeouts > 0 && st.turn === 'me') parts.push(t('status.timeouts', { n: 3 - st.me.timeouts }));
      if (away) {
        box.classList.add('danger');
        mainText = t('status.lost');
        parts = [t('status.waitBack')];
      }
      subHtml = withTimers(parts.join(' '));
    }
    main.textContent = mainText;
    sub.innerHTML = subHtml;
    $('timerBar').hidden = !showTimer;
  }

  function renderResult(st, opp) {
    var box = $('resultBox');
    box.hidden = st.phase !== 'over';
    if (st.phase !== 'over') return;
    var win = st.winner === 'me';
    box.className = 'result ' + (win ? 'win' : 'lose');
    var title = $('resultTitle');
    title.innerHTML = '';
    if (win) { var mark = document.createElement('span'); mark.textContent = t('result.win'); title.appendChild(mark); }
    else title.textContent = t('result.lose');

    var hits = countHits(st.opp && st.opp.shots), fired = st.me.fired;
    var acc = fired ? Math.round(hits / fired * 100) : 0;
    var aim = fired ? ' ' + t('result.aim', { n: fired, acc: acc }) : '';
    var reasons = {
      all_sunk: (win ? 'result.allSunkWin' : 'result.allSunkLose'),
      left: win ? 'result.leftWin' : 'result.leftLose',
      disconnect: win ? 'result.discWin' : 'result.discLose',
      afk: win ? 'result.afkWin' : 'result.afkLose'
    };
    var reason = reasons[st.endReason];
    $('resultSub').textContent = reason ? t(reason, { name: opp.display }) + (st.endReason === 'all_sunk' ? aim : '') : '';

    // reyting o'zgarishi (faqat odamlar bilan o'yinda)
    var rating = $('resultRating');
    rating.hidden = st.ratingDelta == null || !profile;
    if (!rating.hidden) {
      var d = st.ratingDelta;
      rating.textContent = t('result.rating', { elo: profile.elo, d: (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) });
      rating.className = 'result-rating ' + (d >= 0 ? 'up' : 'down');
    }

    var btn = $('rematchBtn'), note = $('rematchNote');
    btn.hidden = !!opp.left;
    btn.disabled = false;
    note.textContent = '';
    if (opp.isBot) btn.textContent = t('result.again');
    else if (st.rematch.me) { btn.textContent = t('result.waiting'); btn.disabled = true; }
    else if (st.rematch.opp) { btn.textContent = t('result.accept'); note.textContent = t('result.asks', { name: opp.display }); }
    else btn.textContent = t('result.rematch');
    if (opp.left) note.textContent = t('result.oppGone');
  }
  $('rematchBtn').addEventListener('click', function () { socket.emit('rematch'); });

  function countHits(grid) {
    var n = 0;
    if (!grid) return 0;
    grid.forEach(function (row) { row.forEach(function (v) { if (v === G.HIT || v === G.SUNK) n++; }); });
    return n;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // ------------------------------------------------------------ maydonlarni chizish
  var HIT_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2L8 8"/><path d="M8 2L2 8"/></svg>';

  function area(r, c, h, w) {
    return 'grid-area:' + (r + 2) + '/' + (c + 2) + '/span ' + (h || 1) + '/span ' + (w || 1);
  }
  function shipArea(s) { return area(s.r, s.c, s.v ? s.len : 1, s.v ? 1 : s.len); }
  function shipKey(s) { return s.r + ',' + s.c + ',' + s.len + ',' + (s.v ? 1 : 0); }

  function renderBoards(st) {
    var gridKey = st.code + ':' + st.round;
    var keep = prevGrids.key === gridKey;

    // --- raqib maydoni
    if (st.phase !== 'placing') {
      var eShots = st.opp ? st.opp.shots : null;
      var armed = st.phase === 'playing' && st.turn === 'me';
      var sunkE = st.opp ? st.opp.sunk : [];
      var revealed = st.opp && st.opp.ships ? st.opp.ships.filter(function (s) { return !s.sunk; }) : [];
      drawBoard($('enemyBoard'), {
        shots: eShots,
        prevShots: keep ? prevGrids.enemy : null,
        ships: sunkE.map(function (s) { return { s: s, cls: 'sunk' }; })
          .concat(revealed.map(function (s) { return { s: s, cls: 'reveal' }; })),
        freshShips: keep ? newSunk(prevGrids.sunkListE, sunkE) : {},
        last: st.lastShot && st.lastShot.by === 'me' ? st.lastShot : null,
        lastCls: 'by-me',
        armed: armed,
        interactive: true
      });
      prevGrids.enemy = eShots ? eShots.map(function (r) { return r.slice(); }) : null;
      prevGrids.sunkListE = sunkE.map(shipKey);
      renderPips($('enemyFleet'), st.opp ? st.opp.remaining : G.FLEET);
    }

    // --- o'z maydonim
    var mineEl = $('myBoard');
    if (st.phase === 'placing' && !st.me.ready) {
      drawBoard(mineEl, {
        shots: null,
        ships: place.ships.map(function (s, i) { return { s: s, cls: i === place.sel ? 'selected' : '' }; }),
        placing: true,
        interactive: true
      });
      updateGhost();
      $('myFleet').innerHTML = '';
    } else {
      var myShips = st.me.ships || [];
      var sunkM = myShips.filter(function (s) { return s.sunk; });
      drawBoard(mineEl, {
        shots: st.me.shots,
        prevShots: keep ? prevGrids.mine : null,
        ships: myShips.map(function (s) { return { s: s, cls: s.sunk ? 'sunk' : '' }; }),
        freshShips: keep ? newSunk(prevGrids.sunkListM, sunkM) : {},
        last: st.lastShot && st.lastShot.by === 'opp' ? st.lastShot : null,
        lastCls: ''
      });
      prevGrids.mine = st.me.shots ? st.me.shots.map(function (r) { return r.slice(); }) : null;
      prevGrids.sunkListM = sunkM.map(shipKey);
      if (st.phase === 'placing') $('myFleet').innerHTML = '';
      else renderPips($('myFleet'), st.me.remaining);
    }
    prevGrids.key = gridKey;
  }

  function newSunk(prevKeys, list) {
    var out = {};
    if (!prevKeys) return out;
    list.forEach(function (s) { var k = shipKey(s); if (prevKeys.indexOf(k) === -1) out[k] = true; });
    return out;
  }

  function drawBoard(el, o) {
    var id = el.id;
    var hadFocus = document.activeElement && el.contains(document.activeElement);
    var fp = focusPos[id];
    var h = [];
    var cols = L.cols(), stateLabel = [t('cell.0'), t('cell.1'), t('cell.2'), t('cell.3')];
    for (var c = 0; c < G.SIZE; c++) h.push('<span class="lbl" aria-hidden="true" style="grid-area:1/' + (c + 2) + '">' + cols[c] + '</span>');
    for (var r = 0; r < G.SIZE; r++) h.push('<span class="lbl" aria-hidden="true" style="grid-area:' + (r + 2) + '/1">' + (r + 1) + '</span>');

    for (r = 0; r < G.SIZE; r++) {
      for (c = 0; c < G.SIZE; c++) {
        var v = o.shots ? o.shots[r][c] : G.EMPTY;
        var cls = 'cell ' + (v === G.EMPTY ? 'empty' : 'shot');
        var tab = fp[0] === r && fp[1] === c ? '0' : '-1';
        h.push('<button type="button" class="' + cls + '" data-r="' + r + '" data-c="' + c + '" tabindex="' + (o.interactive ? tab : '-1') +
          '" aria-label="' + escapeHtml(L.coord(r, c) + ', ' + stateLabel[v]) + '" style="' + area(r, c) + '"></button>');
      }
    }
    (o.ships || []).forEach(function (x) {
      var fresh = o.freshShips && o.freshShips[shipKey(x.s)] ? ' fresh' : '';
      h.push('<div class="ship ' + x.cls + fresh + '" style="' + shipArea(x.s) + '"></div>');
    });
    if (o.shots) {
      for (r = 0; r < G.SIZE; r++) {
        for (c = 0; c < G.SIZE; c++) {
          v = o.shots[r][c];
          if (v === G.EMPTY) continue;
          var isFresh = o.prevShots && o.prevShots[r][c] !== v && !(o.prevShots[r][c] === G.HIT && v === G.SUNK);
          var f = isFresh ? ' fresh' : '';
          if (v === G.MISS) h.push('<span class="mark miss' + f + '" style="' + area(r, c) + '"></span>');
          else h.push('<span class="mark hit' + f + '" style="' + area(r, c) + '">' + HIT_SVG + '</span>');
        }
      }
    }
    if (o.last) h.push('<span class="ring ' + (o.lastCls || '') + '" style="' + area(o.last.r, o.last.c) + '"></span>');
    if (o.placing) h.push('<div class="ship ghost" id="ghost" hidden></div>');
    h.push('<span class="frame" aria-hidden="true"></span>');

    el.innerHTML = h.join('');
    el.classList.toggle('armed', !!o.armed);
    el.classList.toggle('placing', !!o.placing);
    if (hadFocus) {
      var cell = el.querySelector('.cell[data-r="' + fp[0] + '"][data-c="' + fp[1] + '"]');
      if (cell) cell.focus({ preventScroll: true });
    }
  }

  function renderPips(el, remaining) {
    var left = remaining.slice();
    var h = [];
    G.FLEET.forEach(function (len) {
      var i = left.indexOf(len);
      var alive = i !== -1;
      if (alive) left.splice(i, 1);
      var cells = '';
      for (var k = 0; k < len; k++) cells += '<i></i>';
      h.push('<span class="pip' + (alive ? '' : ' gone') + '" title="' + escapeHtml(t('pip', { n: len }) + (alive ? '' : t('pip.sunk'))) + '">' + cells + '</span>');
    });
    el.innerHTML = h.join('');
  }

  // ------------------------------------------------------------ taymerlar
  function tick() {
    if (!S || screen !== 'game') return;
    var now = performance.now();
    var bar = $('timerBar'), fill = bar.firstElementChild;
    var left = null, total = 1;
    if (S.phase === 'playing' && deadlines.turn) { left = Math.max(0, deadlines.turn - now); total = S.turnTotal; }
    else if (S.phase === 'placing' && deadlines.place) { left = Math.max(0, deadlines.place - now); total = S.placeTotal; }
    if (left != null) {
      fill.style.transform = 'scaleX(' + (left / total).toFixed(4) + ')';
      bar.classList.toggle('low', left < 10000);
      Array.prototype.forEach.call(document.querySelectorAll('.cd'), function (e) { e.textContent = fmt(left); });
    }
    if (deadlines.away) {
      var a = Math.max(0, deadlines.away - now);
      Array.prototype.forEach.call(document.querySelectorAll('.cd-away'), function (e) { e.textContent = fmt(a); });
    }
  }
  setInterval(tick, 250);

  // ------------------------------------------------------------ o'q uzish
  $('enemyBoard').addEventListener('click', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell || !S) return;
    var r = +cell.dataset.r, c = +cell.dataset.c;
    focusPos.enemyBoard = [r, c];
    if (S.phase !== 'playing') return;
    if (S.turn !== 'me') { toast(t(S.opp && S.opp.isBot ? 'game.botTurnToast' : 'game.oppTurnToast')); return; }
    if (pendingFire || S.opp.shots[r][c] !== G.EMPTY) return;
    pendingFire = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { pendingFire = false; }, 2500);
    socket.emit('fire', { r: r, c: c });
  });

  // klaviatura bilan katakdan katakka yurish (strelkalar)
  function arrowNav(e) {
    var el = e.currentTarget, cell = e.target.closest('.cell');
    if (!cell) return;
    var d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    var r = Math.min(9, Math.max(0, +cell.dataset.r + d[0]));
    var c = Math.min(9, Math.max(0, +cell.dataset.c + d[1]));
    focusPos[el.id] = [r, c];
    Array.prototype.forEach.call(el.querySelectorAll('.cell[tabindex="0"]'), function (x) { x.tabIndex = -1; });
    var next = el.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"]');
    next.tabIndex = 0;
    next.focus();
    if (el.id === 'myBoard') { place.hover = [r, c]; updateGhost(); }
  }
  $('enemyBoard').addEventListener('keydown', arrowNav);
  $('myBoard').addEventListener('keydown', arrowNav);

  // ------------------------------------------------------------ kemalarni joylashtirish

  function renderPlacement(st) {
    var active = st.phase === 'placing' && !st.me.ready;
    $('placeTools').hidden = !active;
    var key = st.code + ':' + st.round;
    if (active && place.key !== key) {
      place.key = key;
      place.ships = G.randomFleet();
      place.sel = null;
      place.hover = null;
      setHint(t('place.hint'));
    }
    var sel = place.sel !== null ? place.ships[place.sel] : null;
    $('rotateBtn').disabled = !sel || sel.len === 1;
  }

  function setHint(text, bad) {
    var h = $('placeHint');
    h.textContent = text;
    h.classList.toggle('bad', !!bad);
  }
  function rejectMove(text) {
    setHint(text, true);
    sfx.bad();
    var b = $('myBoard');
    b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
  }

  function candidateAt(ship, r, c) {
    return {
      r: ship.v ? Math.min(r, G.SIZE - ship.len) : r,
      c: ship.v ? c : Math.min(c, G.SIZE - ship.len),
      len: ship.len, v: ship.v
    };
  }

  function placing() { return S && S.phase === 'placing' && !S.me.ready; }

  $('myBoard').addEventListener('click', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell || !placing()) return;
    var r = +cell.dataset.r, c = +cell.dataset.c;
    focusPos.myBoard = [r, c];
    var occ = G.occupancy(place.ships);
    var idx = occ[r][c];
    if (idx !== -1) {
      place.sel = place.sel === idx ? null : idx;
      setHint(t(place.sel === null ? 'place.hint' : 'place.selected'));
      sfx.tick();
      render();
      return;
    }
    if (place.sel === null) { setHint(t('place.pickFirst'), true); return; }
    var cand = candidateAt(place.ships[place.sel], r, c);
    if (G.canPlace(occ, cand, place.sel)) {
      place.ships[place.sel] = cand;
      setHint(t('place.moved'));
      sfx.tick();
      render();
    } else {
      rejectMove(t('place.noFit'));
    }
  });

  $('myBoard').addEventListener('mouseover', function (e) {
    var cell = e.target.closest('.cell');
    if (!cell || !placing()) return;
    var r = +cell.dataset.r, c = +cell.dataset.c;
    if (place.hover && place.hover[0] === r && place.hover[1] === c) return;
    place.hover = [r, c];
    updateGhost();
  });
  $('myBoard').addEventListener('mouseleave', function () { place.hover = null; updateGhost(); });

  function updateGhost() {
    var g = $('ghost');
    if (!g) return;
    if (!placing() || place.sel === null || !place.hover) { g.hidden = true; return; }
    var occ = G.occupancy(place.ships);
    var r = place.hover[0], c = place.hover[1];
    if (occ[r][c] !== -1) { g.hidden = true; return; }
    var cand = candidateAt(place.ships[place.sel], r, c);
    g.setAttribute('style', shipArea(cand));
    g.classList.toggle('bad', !G.canPlace(occ, cand, place.sel));
    g.hidden = false;
  }

  function rotateSelected() {
    if (!placing() || place.sel === null) return;
    var s = place.ships[place.sel];
    if (s.len === 1) return;
    var occ = G.occupancy(place.ships);
    var nv = !s.v;
    // burilgan kema eski kataklaridan kamida bittasini egallashi kerak; avval boshlanish katagidan urinamiz
    var cells = G.shipCells(s);
    for (var k = 0; k < cells.length; k++) {
      for (var off = 0; off < s.len; off++) {
        var cand = { r: nv ? cells[k][0] - off : cells[k][0], c: nv ? cells[k][1] : cells[k][1] - off, len: s.len, v: nv };
        if (G.canPlace(occ, cand, place.sel)) {
          place.ships[place.sel] = cand;
          setHint(t('place.rotated'));
          sfx.tick();
          render();
          return;
        }
      }
    }
    rejectMove(t('place.noRotate'));
  }
  $('rotateBtn').addEventListener('click', rotateSelected);
  $('shuffleBtn').addEventListener('click', function () {
    if (!placing()) return;
    place.ships = G.randomFleet();
    place.sel = null;
    setHint(t('place.hint'));
    sfx.tick();
    render();
  });
  $('readyBtn').addEventListener('click', function () {
    if (!placing()) return;
    var err = G.validateFleet(place.ships);
    if (err) { rejectMove(t('err.' + err)); return; }
    place.sel = null;
    socket.emit('place_fleet', { ships: place.ships });
  });
  document.addEventListener('keydown', function (e) {
    if (!placing() || e.target.tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateSelected(); }
    if (e.key === 'Escape' && place.sel !== null) { place.sel = null; setHint(t('place.hint')); render(); }
  });
})();
