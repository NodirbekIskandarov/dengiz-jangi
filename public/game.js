/*
 * Dengiz jangi — umumiy o'yin mantig'i.
 * Bu fayl ham serverda (Node.js), ham brauzerda ishlaydi.
 *
 * Kema formati: { r, c, len, v }  — r,c: boshlanish katagi (0..9),
 *                                     len: uzunlik, v: true = vertikal.
 * Qoidalar (klassik): 10x10 maydon, flot 1x4, 2x3, 3x2, 4x1,
 * kemalar bir-biriga tegmaydi (burchakdan ham).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeaGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 10;
  var FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

  // Katak holatlari (otishlar xaritasi)
  var EMPTY = 0, MISS = 1, HIT = 2, SUNK = 3;

  function inBounds(r, c) {
    return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function shipCells(ship) {
    var cells = [];
    for (var i = 0; i < ship.len; i++) {
      cells.push(ship.v ? [ship.r + i, ship.c] : [ship.r, ship.c + i]);
    }
    return cells;
  }

  /** Kema atrofidagi kataklar (o'zini hisobga olmagan holda). */
  function aroundCells(cells) {
    var own = {}, out = [], seen = {};
    cells.forEach(function (p) { own[p[0] * SIZE + p[1]] = true; });
    cells.forEach(function (p) {
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          var r = p[0] + dr, c = p[1] + dc, k = r * SIZE + c;
          if (inBounds(r, c) && !own[k] && !seen[k]) { seen[k] = true; out.push([r, c]); }
        }
      }
    });
    return out;
  }

  function emptyGrid(fill) {
    var g = [];
    for (var r = 0; r < SIZE; r++) {
      var row = [];
      for (var c = 0; c < SIZE; c++) row.push(fill);
      g.push(row);
    }
    return g;
  }

  /** Bitta kemani mavjud joylashuvga qo'yish mumkinmi? (occ: 10x10, -1 bo'sh) */
  function canPlace(occ, ship, ignoreIndex) {
    var cells = shipCells(ship);
    for (var i = 0; i < cells.length; i++) {
      var r = cells[i][0], c = cells[i][1];
      if (!inBounds(r, c)) return false;
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          var rr = r + dr, cc = c + dc;
          if (inBounds(rr, cc) && occ[rr][cc] !== -1 && occ[rr][cc] !== ignoreIndex) return false;
        }
      }
    }
    return true;
  }

  function occupancy(ships) {
    var occ = emptyGrid(-1);
    ships.forEach(function (s, idx) {
      shipCells(s).forEach(function (p) { if (inBounds(p[0], p[1])) occ[p[0]][p[1]] = idx; });
    });
    return occ;
  }

  /** Flotni to'liq tekshirish. Xato bo'lsa xato kodini qaytaradi (tarjima kaliti 'err.<kod>'), to'g'ri bo'lsa null. */
  function validateFleet(ships) {
    if (!Array.isArray(ships) || ships.length !== FLEET.length) return 'fleetCount';
    var clean = [];
    for (var i = 0; i < ships.length; i++) {
      var s = ships[i];
      if (!s || typeof s !== 'object') return 'shipData';
      var ship = { r: s.r, c: s.c, len: s.len, v: !!s.v };
      if (!Number.isInteger(ship.len) || ship.len < 1 || ship.len > 4) return 'shipLen';
      if (!shipCells(ship).every(function (p) { return inBounds(p[0], p[1]); })) return 'shipOut';
      clean.push(ship);
    }
    var lens = clean.map(function (s) { return s.len; }).sort(function (a, b) { return b - a; });
    if (lens.join(',') !== FLEET.join(',')) return 'fleetMix';
    var occ = emptyGrid(-1);
    for (var j = 0; j < clean.length; j++) {
      if (!canPlace(occ, clean[j], -2)) return 'shipsTouch';
      shipCells(clean[j]).forEach(function (p) { occ[p[0]][p[1]] = j; });
    }
    return null;
  }

  function randomFleet(rand) {
    rand = rand || Math.random;
    for (var attempt = 0; attempt < 200; attempt++) {
      var ships = [], occ = emptyGrid(-1), ok = true;
      for (var i = 0; i < FLEET.length && ok; i++) {
        var len = FLEET[i], placed = false;
        for (var t = 0; t < 300 && !placed; t++) {
          var v = rand() < 0.5;
          var ship = {
            r: Math.floor(rand() * (v ? SIZE - len + 1 : SIZE)),
            c: Math.floor(rand() * (v ? SIZE : SIZE - len + 1)),
            len: len, v: v
          };
          if (canPlace(occ, ship, -2)) {
            ships.push(ship);
            shipCells(ship).forEach(function (p) { occ[p[0]][p[1]] = ships.length - 1; });
            placed = true;
          }
        }
        if (!placed) ok = false;
      }
      if (ok) return ships;
    }
    throw new Error('Flotni joylab bo‘lmadi');
  }

  /** Jang maydoni: kemalar + unga qilingan otishlar. */
  function createBoard(ships) {
    var occ = occupancy(ships);
    return {
      ships: ships.map(function (s) { return { r: s.r, c: s.c, len: s.len, v: !!s.v, hits: 0 }; }),
      occ: occ,
      shots: emptyGrid(EMPTY),
      sunkCount: 0
    };
  }

  /**
   * Maydonga o'q uzish.
   * Natija: { result: 'miss'|'hit'|'sunk'|'repeat'|'invalid', cells?, around?, gameOver? }
   */
  function fire(board, r, c) {
    if (!inBounds(r, c)) return { result: 'invalid' };
    if (board.shots[r][c] !== EMPTY) return { result: 'repeat' };
    var idx = board.occ[r][c];
    if (idx === -1) {
      board.shots[r][c] = MISS;
      return { result: 'miss' };
    }
    var ship = board.ships[idx];
    ship.hits++;
    board.shots[r][c] = HIT;
    if (ship.hits < ship.len) return { result: 'hit' };

    // Kema cho'kdi: kataklarini belgilaymiz va atrofini "bo'sh" deb ochamiz
    var cells = shipCells(ship);
    cells.forEach(function (p) { board.shots[p[0]][p[1]] = SUNK; });
    var around = aroundCells(cells);
    around.forEach(function (p) {
      if (board.shots[p[0]][p[1]] === EMPTY) board.shots[p[0]][p[1]] = MISS;
    });
    board.sunkCount++;
    return { result: 'sunk', cells: cells, around: around, len: ship.len, gameOver: board.sunkCount === board.ships.length };
  }

  /** Raqib uchun ko'rinadigan cho'kkan kemalar ro'yxati. */
  function sunkShips(board) {
    return board.ships.filter(function (s) { return s.hits >= s.len; })
      .map(function (s) { return { r: s.r, c: s.c, len: s.len, v: s.v }; });
  }

  function remainingFleet(board) {
    return board.ships.filter(function (s) { return s.hits < s.len; }).map(function (s) { return s.len; });
  }

  // Ustun belgilari — o'zbek lotin alifbosi tartibida (C harfi yo'q).
  var COLS = ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

  function coordName(r, c) { return COLS[c] + (r + 1); }

  return {
    SIZE: SIZE, FLEET: FLEET, COLS: COLS,
    EMPTY: EMPTY, MISS: MISS, HIT: HIT, SUNK: SUNK,
    inBounds: inBounds, shipCells: shipCells, aroundCells: aroundCells,
    emptyGrid: emptyGrid, canPlace: canPlace, occupancy: occupancy,
    validateFleet: validateFleet, randomFleet: randomFleet,
    createBoard: createBoard, fire: fire, sunkShips: sunkShips,
    remainingFleet: remainingFleet, coordName: coordName
  };
});
