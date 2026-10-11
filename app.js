'use strict';

// ===== constants =====
const EMPTY = 0xff;          // "--" in song / chain cells
const NOTE_EMPTY = -1;
const NOTE_OFF = 128;
const NOTE_MAX = 127;        // full MIDI range, 11 octaves (0-A)
const VOL_MAX = 0x7f;
const INS_MAX = 0x7f;
const ID_MAX = 0xfe;         // chain / phrase numbers 00-FE
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const FX_CMDS = [
  'ARP', 'ARC', 'CHA', 'DEL', 'GRV', 'GGR', 'HOP', 'INS', 'KIL', 'RND', 'RNL', 'RET', 'REP', 'RTO', 'RMX', 'NTH',
  'PSL', 'PBN', 'PVB', 'PVX', 'SCA', 'SCG', 'SNG', 'SED', 'TBL', 'THO', 'TIC', 'TBX', 'TPO', 'TSP', 'NXT', 'OFF',
  'MTT', 'EQM', 'EQI', 'VMV', 'XMT', 'XMM', 'XMF', 'XMW', 'XMR', 'XDT', 'XDF', 'XDW', 'XDR', 'XRS', 'XRM', 'XRF',
  'XRW', 'XRZ', 'VMX', 'VDE', 'VRE', 'USB', 'VOL', 'PIT', 'FIN',
];
const PICKER_COLS = 8;
const KEY_LABEL = { up: '▲', down: '▼', left: '◀', right: '▶', shift: 'SHIFT', play: 'PLAY', opt: 'OPT', edit: 'EDIT' };
const DIRS = ['up', 'down', 'left', 'right'];
const DOUBLE_TAP_MS = 350;

// ===== song data =====
const song = Array.from({ length: 256 }, () => Array(8).fill(EMPTY));
const chains = Array.from({ length: 255 }, () => ({ ph: Array(16).fill(EMPTY), tsp: Array(16).fill(0) }));
const phrases = Array.from({ length: 255 }, () => ({
  note: Array(16).fill(NOTE_EMPTY),
  vol: Array(16).fill(-1),
  ins: Array(16).fill(-1),
  fx: Array.from({ length: 3 }, () => ({ cmd: Array(16).fill(-1), val: Array(16).fill(0) })),
}));

// small demo so the screens are not blank
song[0][0] = 0x00; song[1][0] = 0x00; song[0][1] = 0x01; song[1][1] = 0x02;
chains[0].ph[0] = 0x00; chains[0].ph[1] = 0x00;
chains[1].ph[0] = 0x01; chains[1].ph[1] = 0x01;
chains[2].ph[0] = 0x01; chains[2].tsp[0] = 0x05;
for (const r of [0, 4, 8, 12]) { phrases[0].note[r] = 36; phrases[0].vol[r] = 0x60; phrases[0].ins[r] = 0x00; }
for (const [r, n] of [[0, 48], [3, 51], [6, 55], [10, 58]]) { phrases[1].note[r] = n; phrases[1].ins[r] = 0x01; }
phrases[1].fx[0].cmd[0] = FX_CMDS.indexOf('ARP'); phrases[1].fx[0].val[0] = 0x37;
phrases[1].note[14] = NOTE_OFF;

// "last edited or deleted" values used when tapping EDIT on an empty cell
const last = { chain: 0x00, phrase: 0x00, note: 48, vol: 0x40, ins: 0x00, fxCmd: 0, fxVal: 0x00 };

// ===== UI state =====
const st = {
  view: 'song',
  song: { row: 0, col: 0, top: 0 },
  chain: { row: 0, col: 0 },
  phrase: { row: 0, col: 0 },
  ctx: { track: 0, songRow: 0, chainId: 0, chainRow: 0, phraseId: 0 },
  picker: null,               // FX command picker: { fx, idx }
  playing: false,
};

// ===== helpers =====
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex1 = (n) => n.toString(16).toUpperCase();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const noteName = (n) => n === NOTE_EMPTY ? '---' : n === NOTE_OFF ? 'OFF' : NOTE_NAMES[n % 12] + hex1(Math.floor(n / 12));
const signed = (v) => (v >= 0x80 ? v - 256 : v);
const deltaFor = (dir, small, large) => ({ right: small, left: -small, up: large, down: -large })[dir];

const chainHasNotes = (id) => chains[id].ph.some((p) => p !== EMPTY && phraseHasNotes(p));
const phraseHasNotes = (id) => phrases[id].note.some((n) => n !== NOTE_EMPTY);
const chainIsEmpty = (id) => chains[id].ph.every((p) => p === EMPTY);
const phraseIsEmpty = (id) => {
  const p = phrases[id];
  return p.note.every((n) => n === NOTE_EMPTY) && p.vol.every((v) => v < 0) && p.ins.every((v) => v < 0)
    && p.fx.every((f) => f.cmd.every((c) => c < 0));
};
const firstUnused = (max, isUsed) => { for (let i = 0; i <= max; i++) if (!isUsed(i)) return i; return -1; };

// ===== flash message (shown on the screen's help line) =====
let flash = null;   // { text, warn }
let flashTimer = null;

// only short M8-style warnings are shown; successful actions speak for themselves
function log(_keys, text, warn = false) {
  if (!warn) return;
  flash = { text, warn };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; render(); }, 1800);
}

// ===== reverse-lookup action list =====
// mods: keys to hold, trig: key(s) to tap, count: taps needed
const act = (id, label, mods, trig, count = 1) => ({ id, label, mods, trig: [].concat(trig), count });
const ARROWS = ['left', 'right', 'up', 'down'];
const PLAYBACK = [
  act('play', '再生 / 停止', [], 'play'),
  act('play-song', 'カーソル位置からソング再生', ['shift'], 'play'),
  act('mute', 'トラックをミュート', ['opt'], 'shift'),
  act('solo', 'トラックをソロ', ['opt'], 'play'),
];

// rough categories for the tabs
const TABS = [['edit', '編集'], ['nav', '移動'], ['play', '再生']];
const NAV_IDS = ['open-chain', 'open-phrase', 'to-song', 'to-chain', 'page', 'chain-nav', 'phrase-nav', 'track-nav'];
const PLAY_IDS = ['play', 'play-song', 'mute', 'solo', 'solo-side'];
const categoryOf = (id) => (NAV_IDS.includes(id) ? 'nav' : PLAY_IDS.includes(id) ? 'play' : 'edit');
let tab = 'edit';

function actionsFor() {
  if (st.picker) {
    return [
      act('pick', 'コマンドを選ぶ (EDITは押したまま)', ['edit'], ARROWS),
      act('pick-ok', 'EDITを離して決定', [], 'edit'),
      act('pick-cancel', 'キャンセル', [], 'opt'),
    ];
  }
  if (st.view === 'song') {
    const v = song[st.song.row][st.song.col];
    const cell = v === EMPTY
      ? [act('new-chain', '新規CHAINの作成', [], 'edit', 2),
         act('put-chain', `前回のCHAIN (${hex2(last.chain)}) を置く`, [], 'edit')]
      : [act('open-chain', 'CHAINを開く', ['shift'], 'right'),
         act('chain-1', 'CHAIN番号 ±1', ['edit'], ['left', 'right']),
         act('chain-10', 'CHAIN番号 ±10', ['edit'], ['up', 'down']),
         act('del-chain', 'CHAINの削除', ['opt'], 'edit')];
    return [...cell, act('page', '16行ジャンプ', ['opt'], ['up', 'down']),
      act('solo-side', 'カーソルの左 / 右側をソロ', ['opt'], ['left', 'right']), ...PLAYBACK];
  }
  if (st.view === 'chain') {
    const ch = chains[st.ctx.chainId];
    const { row, col } = st.chain;
    let cell;
    if (col === 1) {
      cell = [act('tsp-1', 'トランスポーズ ±半音', ['edit'], ['left', 'right']),
              act('tsp-12', 'トランスポーズ ±オクターブ', ['edit'], ['up', 'down'])];
      if (ch.tsp[row]) cell.push(act('tsp-0', 'トランスポーズを 00 に戻す', ['opt'], 'edit'));
    } else if (ch.ph[row] === EMPTY) {
      cell = [act('new-phrase', '新規PHRASEの作成', [], 'edit', 2),
              act('put-phrase', `前回のPHRASE (${hex2(last.phrase)}) を置く`, [], 'edit')];
    } else {
      cell = [act('open-phrase', 'PHRASEを開く', ['shift'], 'right'),
              act('phrase-1', 'PHRASE番号 ±1', ['edit'], ['left', 'right']),
              act('phrase-10', 'PHRASE番号 ±10', ['edit'], ['up', 'down']),
              act('del-phrase', 'PHRASEの削除', ['opt'], 'edit')];
    }
    return [...cell, act('to-song', 'SONGに戻る', ['shift'], 'left'),
      act('chain-nav', '前 / 次のCHAINへ', ['opt'], ['up', 'down']),
      act('track-nav', '隣のトラックへ', ['opt'], ['left', 'right']), ...PLAYBACK];
  }
  const ph = phrases[st.ctx.phraseId];
  const { row, col } = st.phrase;
  let cell;
  if (col === 0) {
    const n = ph.note[row];
    cell = n === NOTE_EMPTY
      ? [act('put-note', `ノートを置く (${noteName(last.note)})`, [], 'edit'),
         act('note-off', 'ノートオフ (OFF) を置く', ['opt'], 'edit')]
      : n === NOTE_OFF
        ? [act('del-note', 'OFFの削除', ['opt'], 'edit')]
        : [act('note-1', '音程 ±半音', ['edit'], ['left', 'right']),
           act('note-12', '音程 ±オクターブ', ['edit'], ['up', 'down']),
           act('del-note', 'ノートの削除', ['opt'], 'edit')];
  } else if (col === 1 || col === 2) {
    const name = col === 1 ? 'ボリューム' : 'インスト';
    const empty = (col === 1 ? ph.vol : ph.ins)[row] < 0;
    cell = empty
      ? [act('put-val', `${name}を置く`, [], 'edit')]
      : [act('val-1', `${name} ±1`, ['edit'], ['left', 'right']),
         act('val-10', `${name} ±10`, ['edit'], ['up', 'down']),
         act('del-val', `${name}の削除`, ['opt'], 'edit')];
    if (col === 2) cell.splice(1, 0, act('new-ins', '未使用のインストを割り当て', [], 'edit', 2));
  } else if (isFxCmdCol(col)) {
    cell = ph.fx[fxIndex(col)].cmd[row] < 0
      ? [act('put-fx', `FXを置く (${FX_CMDS[last.fxCmd]})`, [], 'edit'),
         act('fx-list', 'FXを一覧から選ぶ', ['edit'], ['up', 'down'])]
      : [act('fx-list', 'FXを一覧から選ぶ', ['edit'], ['up', 'down']),
         act('fx-step', 'FX 前 / 次のコマンド', ['edit'], ['left', 'right']),
         act('del-fx', 'FXの削除', ['opt'], 'edit')];
  } else {
    cell = [act('val-1', 'FX値 ±1', ['edit'], ['left', 'right']),
            act('val-10', 'FX値 ±10', ['edit'], ['up', 'down']),
            act('fx-0', 'FX値を 00 に戻す', ['opt'], 'edit')];
  }
  return [...cell, act('to-chain', 'CHAINに戻る', ['shift'], 'left'),
    act('phrase-nav', '前 / 次のPHRASEへ', ['opt'], ['up', 'down']),
    act('track-nav', '隣のトラックへ', ['opt'], ['left', 'right']), ...PLAYBACK];
}

function comboText(a) {
  const t = a.trig.map((k) => KEY_LABEL[k]).join('');
  return [...a.mods.map((k) => KEY_LABEL[k]), t].join(' + ') + (a.count > 1 ? ' ×' + a.count : '');
}

// currently highlighted action: { ...action, left: taps remaining }
let guide = null;

function toggleGuide(id) {
  const a = actionsFor().find((x) => x.id === id);
  guide = !a || guide?.id === id ? null : { ...a, left: a.count };
  render();
}

// called on every key press, before the key is handled
function trackGuide(key) {
  if (!guide) return;
  if (guide.trig.includes(key) && guide.mods.every((m) => held.has(m))) {
    if (--guide.left <= 0) guide = null;
  } else if (!guide.mods.includes(key)) {
    guide.left = guide.count;
  }
}

const actionsEl = document.getElementById('actions');
const tabsEl = document.getElementById('tabs');
actionsEl.addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  if (li) toggleGuide(li.dataset.id);
});
tabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) { tab = b.dataset.tab; render(); }
});

function renderActions() {
  const list = actionsFor();
  if (guide && guide.left === guide.count && !list.some((a) => a.id === guide.id)) guide = null;
  const shown = st.picker ? 'edit' : tab;  // the FX picker only has edit actions
  tabsEl.innerHTML = TABS.map(([k, name]) =>
    `<button data-tab="${k}" class="${k === shown ? 'on' : ''}">${name}</button>`).join('');
  actionsEl.innerHTML = list.filter((a) => categoryOf(a.id) === shown).map((a) =>
    `<li data-id="${a.id}" class="${guide?.id === a.id ? 'on' : ''}"><span class="lbl">${a.label}</span><span class="kbd">${comboText(a)}</span></li>`).join('');

  Object.entries(keyEls).forEach(([k, el]) => {
    const isMod = guide?.mods.includes(k);
    const isTrig = guide?.trig.includes(k);
    el.classList.toggle('guide', !!(isMod || isTrig));
    el.dataset.badge = isMod ? '押したまま' : isTrig && guide.count > 1 ? `${guide.left}回` : '';
  });
}

// ===== rendering =====
const bodyEl = document.getElementById('screen-body');
const minimapEl = document.getElementById('minimap');
const s = (text, cls) => (cls ? `<span class="${cls}">${text}</span>` : text);
const cur = (on, cls) => (on ? `${cls} cur` : cls);

function titleLine(name, info) {
  return s(name, 'title') + (info ? s('  ' + info, 'sub') : '') + (st.playing ? s('  ▶', 'play') : '');
}

function renderSong() {
  const { row, col, top } = st.song;
  const L = [titleLine('SONG'), '', s('  ' + [1, 2, 3, 4, 5, 6, 7, 8].map((n) => '  ' + n).join(''), 'hdr')];
  for (let r = top; r < top + 16; r++) {
    let line = s(hex2(r), r % 4 === 0 ? 'rn beat' : 'rn');
    for (let c = 0; c < 8; c++) {
      const v = song[r][c];
      const cls = v === EMPTY ? 'empty' : chainHasNotes(v) ? 'val' : 'dimv';
      line += ' ' + s(v === EMPTY ? '--' : hex2(v), cur(r === row && c === col, cls));
    }
    L.push(line);
  }
  const v = song[row][col];
  L.push('', s(v === EMPTY ? `TRACK ${col + 1}  ROW ${hex2(row)}` : `CHAIN ${hex2(v)} (${v})  TRACK ${col + 1}`, 'help'));
  return L;
}

function renderChain() {
  const { row, col } = st.chain;
  const { chainId, track, songRow } = st.ctx;
  const ch = chains[chainId];
  const L = [titleLine(`CHAIN ${hex2(chainId)}`, `T${track + 1} ROW${hex2(songRow)}`), '', s('   PH  TSP', 'hdr')];
  for (let r = 0; r < 16; r++) {
    const p = ch.ph[r];
    const pCls = p === EMPTY ? 'empty' : phraseHasNotes(p) ? 'val' : 'dimv';
    L.push(s(hex1(r), r % 4 === 0 ? 'rn beat' : 'rn') + '  '
      + s(p === EMPTY ? '--' : hex2(p), cur(r === row && col === 0, pCls)) + '  '
      + s(hex2(ch.tsp[r]), cur(r === row && col === 1, ch.tsp[r] ? 'val' : 'dimv')));
  }
  let help;
  if (col === 0) help = ch.ph[row] === EMPTY ? 'END OF CHAIN' : `PHRASE ${hex2(ch.ph[row])} (${ch.ph[row]})`;
  else help = `TRANSPOSE ${signed(ch.tsp[row]) >= 0 ? '+' : ''}${signed(ch.tsp[row])}`;
  L.push('', s(help, 'help'));
  return L;
}

const isFxCmdCol = (c) => c >= 3 && (c - 3) % 2 === 0;
const fxIndex = (c) => Math.floor((c - 3) / 2);

function renderPhrase() {
  const { row, col } = st.phrase;
  const ph = phrases[st.ctx.phraseId];
  const L = [titleLine(`PHRASE ${hex2(st.ctx.phraseId)}`, `T${st.ctx.track + 1} CH${hex2(st.ctx.chainId)}`), '',
    s('  N   V  I  FX1   FX2   FX3', 'hdr')];
  for (let r = 0; r < 16; r++) {
    const on = (c) => r === row && col === c;
    const n = ph.note[r], v = ph.vol[r], i = ph.ins[r];
    let line = s(hex1(r), r % 4 === 0 ? 'rn beat' : 'rn') + ' '
      + s(noteName(n), cur(on(0), n === NOTE_EMPTY ? 'empty' : 'val')) + ' '
      + s(v < 0 ? '--' : hex2(v), cur(on(1), v < 0 ? 'empty' : 'val')) + ' '
      + s(i < 0 ? '--' : hex2(i), cur(on(2), i < 0 ? 'empty' : 'val'));
    ph.fx.forEach((f, k) => {
      const cmd = f.cmd[r];
      line += ' ' + s(cmd < 0 ? '---' : FX_CMDS[cmd], cur(on(3 + k * 2), cmd < 0 ? 'empty' : 'val'))
        + s(hex2(f.val[r]), cur(on(4 + k * 2), cmd < 0 ? 'empty' : 'val'));
    });
    L.push(line);
  }
  L.push('', s(phraseHelp(ph, row, col), 'help'));
  return L;
}

function phraseHelp(ph, row, col) {
  if (col === 0) {
    const n = ph.note[row];
    return n === NOTE_EMPTY ? 'NOTE' : n === NOTE_OFF ? 'NOTE OFF' : `NOTE ${noteName(n)} (MIDI ${n})`;
  }
  if (col === 1) return ph.vol[row] < 0 ? 'VOLUME' : `VOLUME ${hex2(ph.vol[row])} (${ph.vol[row]})`;
  if (col === 2) return ph.ins[row] < 0 ? 'INSTRUMENT' : `INSTRUMENT ${hex2(ph.ins[row])} (${ph.ins[row]})`;
  const f = ph.fx[fxIndex(col)];
  if (isFxCmdCol(col)) return f.cmd[row] < 0 ? `FX${fxIndex(col) + 1}` : `FX${fxIndex(col) + 1} ${FX_CMDS[f.cmd[row]]}`;
  return `FX${fxIndex(col) + 1} VALUE ${hex2(f.val[row])} (${f.val[row]})`;
}

function renderPicker() {
  const L = [s('FX COMMANDS', 'title'), ''];
  for (let r = 0; r * PICKER_COLS < FX_CMDS.length; r++) {
    let line = '';
    for (let c = 0; c < PICKER_COLS; c++) {
      const i = r * PICKER_COLS + c;
      if (i >= FX_CMDS.length) break;
      line += ' ' + s(FX_CMDS[i], cur(i === st.picker.idx, 'val'));
    }
    L.push(line);
  }
  L.push('', s(FX_CMDS[st.picker.idx], 'help'));
  return L;
}

function renderMinimap() {
  const cells = [
    ['P', 'project'], ['', ''], ['', ''], ['', ''], ['', ''],
    ['S', 'song'], ['C', 'chain'], ['P', 'phrase'], ['I', 'inst'], ['T', 'table'],
    ['V', 'mixer'], ['', ''], ['', ''], ['', ''], ['', ''],
  ];
  const active = ['song', 'chain', 'phrase'];
  minimapEl.innerHTML = cells.map(([t, v]) =>
    `<span class="${v === st.view ? 'here' : active.includes(v) ? 'on' : ''}">${t}</span>`).join('');
}

function render() {
  const lines = st.picker ? renderPicker() : { song: renderSong, chain: renderChain, phrase: renderPhrase }[st.view]();
  if (flash) lines[lines.length - 1] = s(flash.text, flash.warn ? 'help warn' : 'help');
  const lastIdx = lines.length - 1;
  bodyEl.innerHTML = lines.map((l, i) => `<div class="ln${i === lastIdx ? ' help-ln' : ''}">${l}</div>`).join('');
  renderMinimap();
  renderActions();
}

// ===== cursor movement =====
function moveCursor(dir) {
  const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  if (st.view === 'song') {
    const c = st.song;
    c.row = clamp(c.row + dy, 0, 255);
    c.col = clamp(c.col + dx, 0, 7);
    scrollSong();
  } else if (st.view === 'chain') {
    st.chain.row = clamp(st.chain.row + dy, 0, 15);
    st.chain.col = clamp(st.chain.col + dx, 0, 1);
  } else {
    st.phrase.row = clamp(st.phrase.row + dy, 0, 15);
    st.phrase.col = clamp(st.phrase.col + dx, 0, 8);
  }
}

function scrollSong() {
  const c = st.song;
  if (c.row < c.top) c.top = c.row;
  if (c.row > c.top + 15) c.top = c.row - 15;
}

// ===== SHIFT + direction: switch views =====
function navigateView(dir) {
  const k = ['shift', dir];
  if (dir === 'up') return log(k, 'NOT AVAILABLE', true);
  if (dir === 'down') return log(k, 'NOT AVAILABLE', true);

  if (st.view === 'song') {
    if (dir === 'left') return log(k, 'NOT AVAILABLE', true);
    const id = song[st.song.row][st.song.col];
    if (id === EMPTY) return log(k, 'NO CHAIN', true);
    Object.assign(st.ctx, { track: st.song.col, songRow: st.song.row, chainId: id });
    st.view = 'chain';
    return log(k, `チェーン ${hex2(id)} を開く`);
  }
  if (st.view === 'chain') {
    if (dir === 'left') {
      st.view = 'song';
      Object.assign(st.song, { row: st.ctx.songRow, col: st.ctx.track });
      scrollSong();
      return log(k, 'ソング画面へ戻る');
    }
    const id = chains[st.ctx.chainId].ph[st.chain.row];
    if (id === EMPTY) return log(k, 'NO PHRASE', true);
    Object.assign(st.ctx, { chainRow: st.chain.row, phraseId: id });
    st.view = 'phrase';
    return log(k, `フレーズ ${hex2(id)} を開く`);
  }
  if (dir === 'left') {
    st.view = 'chain';
    st.chain.row = st.ctx.chainRow;
    return log(k, 'チェーン画面へ戻る');
  }
  return log(k, 'NOT AVAILABLE', true);
}

// ===== OPTION + direction =====
function optNav(dir) {
  const k = ['opt', dir];
  const step = dir === 'up' || dir === 'left' ? -1 : 1;
  const vertical = dir === 'up' || dir === 'down';

  if (st.view === 'song') {
    if (vertical) {
      st.song.row = clamp(st.song.row + step * 16, 0, 255);
      st.song.top = clamp(st.song.top + step * 16, 0, 240);
      scrollSong();
      return log(k, `16行${step < 0 ? '上' : '下'}へジャンプ`);
    }
    return log(k, `カーソルより${step < 0 ? '左' : '右'}側のトラックをソロ (音は出ません)`);
  }

  const ctx = st.ctx;
  if (st.view === 'chain') {
    if (vertical) {
      for (let r = ctx.songRow + step; r >= 0 && r < 256; r += step) {
        if (song[r][ctx.track] !== EMPTY) {
          Object.assign(ctx, { songRow: r, chainId: song[r][ctx.track] });
          return log(k, `ソングの${step < 0 ? '前' : '次'}のチェーン ${hex2(ctx.chainId)} へ (ROW ${hex2(r)})`);
        }
      }
      return log(k, 'NO CHAIN', true);
    }
    const t = ctx.track + step;
    if (t < 0 || t > 7) return log(k, 'NO TRACK', true);
    const id = song[ctx.songRow][t];
    if (id === EMPTY) return log(k, 'NO CHAIN', true);
    Object.assign(ctx, { track: t, chainId: id });
    return log(k, `トラック${t + 1}のチェーン ${hex2(id)} へ`);
  }

  // phrase view
  if (vertical) {
    const ch = chains[ctx.chainId];
    for (let r = ctx.chainRow + step; r >= 0 && r < 16; r += step) {
      if (ch.ph[r] === EMPTY) break;
      Object.assign(ctx, { chainRow: r, phraseId: ch.ph[r] });
      return log(k, `チェーン内の${step < 0 ? '前' : '次'}のフレーズ ${hex2(ctx.phraseId)} へ`);
    }
    return log(k, 'NO PHRASE', true);
  }
  const t = ctx.track + step;
  if (t < 0 || t > 7) return log(k, 'NO TRACK', true);
  const cid = song[ctx.songRow][t];
  const pid = cid === EMPTY ? EMPTY : chains[cid].ph[ctx.chainRow];
  if (pid === EMPTY) return log(k, 'NO PHRASE', true);
  Object.assign(ctx, { track: t, chainId: cid, phraseId: pid });
  return log(k, `トラック${t + 1}のフレーズ ${hex2(pid)} へ`);
}

// ===== EDIT (tap) =====
function editTap() {
  const k = ['edit'];
  if (st.view === 'song') {
    const { row, col } = st.song;
    if (song[row][col] !== EMPTY) return log(k, '値の変更は EDIT を押したまま方向キー');
    song[row][col] = last.chain;
    return log(k, `空欄に最後に使ったチェーン ${hex2(last.chain)} を入力`);
  }
  if (st.view === 'chain') {
    const ch = chains[st.ctx.chainId];
    const { row, col } = st.chain;
    if (col === 1) return log(k, 'TSPは EDIT を押したまま方向キーで変更');
    if (ch.ph[row] !== EMPTY) return log(k, '値の変更は EDIT を押したまま方向キー');
    ch.ph[row] = last.phrase;
    return log(k, `空欄に最後に使ったフレーズ ${hex2(last.phrase)} を入力`);
  }
  const ph = phrases[st.ctx.phraseId];
  const { row, col } = st.phrase;
  if (col === 0) {
    if (ph.note[row] !== NOTE_EMPTY) return log(k, '値の変更は EDIT を押したまま方向キー');
    ph.note[row] = last.note;
    let msg = `最後のノート ${noteName(last.note)} を入力`;
    if (ph.ins[row] < 0) { ph.ins[row] = last.ins; msg += ` (インスト ${hex2(last.ins)} も)`; }
    return log(k, msg);
  }
  if (col === 1 || col === 2) {
    const arr = col === 1 ? ph.vol : ph.ins;
    if (arr[row] >= 0) return log(k, '値の変更は EDIT を押したまま方向キー');
    arr[row] = col === 1 ? last.vol : last.ins;
    return log(k, `最後の${col === 1 ? 'ボリューム' : 'インスト'} ${hex2(arr[row])} を入力`);
  }
  const f = ph.fx[fxIndex(col)];
  if (isFxCmdCol(col)) {
    if (f.cmd[row] >= 0) return log(k, 'EDIT+◀▶で前後のコマンド、EDIT+▲▼で一覧');
    f.cmd[row] = last.fxCmd;
    return log(k, `最後のコマンド ${FX_CMDS[last.fxCmd]} を入力`);
  }
  return log(k, '値の変更は EDIT を押したまま方向キー');
}

// ===== EDIT, EDIT (double tap) =====
function editDoubleTap() {
  const k = ['edit', 'edit'];
  if (st.view === 'song') {
    const id = firstUnused(ID_MAX, (i) => !chainIsEmpty(i) || song.some((r) => r.includes(i)));
    if (id < 0) return log(k, 'NO FREE CHAIN', true);
    song[st.song.row][st.song.col] = last.chain = id;
    return log(k, `未使用の空チェーン ${hex2(id)} を新規作成`);
  }
  if (st.view === 'chain' && st.chain.col === 0) {
    const id = firstUnused(ID_MAX, (i) => !phraseIsEmpty(i) || chains.some((c) => c.ph.includes(i)));
    if (id < 0) return log(k, 'NO FREE PHRASE', true);
    chains[st.ctx.chainId].ph[st.chain.row] = last.phrase = id;
    return log(k, `未使用の空フレーズ ${hex2(id)} を新規作成`);
  }
  if (st.view === 'phrase' && st.phrase.col === 2) {
    const id = firstUnused(INS_MAX, (i) => phrases.some((p) => p.ins.includes(i)));
    if (id < 0) return log(k, 'NO FREE INSTRUMENT', true);
    phrases[st.ctx.phraseId].ins[st.phrase.row] = last.ins = id;
    return log(k, `未使用のインスト ${hex2(id)} を割り当て`);
  }
  return editTap();
}

// ===== EDIT + direction: change value =====
function editValue(dir) {
  const k = ['edit', dir];
  const big = dir === 'up' || dir === 'down';
  const sign = dir === 'up' || dir === 'right' ? '+' : '-';

  if (st.view === 'song' || (st.view === 'chain' && st.chain.col === 0)) {
    const isSong = st.view === 'song';
    const arr = isSong ? song[st.song.row] : chains[st.ctx.chainId].ph;
    const i = isSong ? st.song.col : st.chain.row;
    if (arr[i] === EMPTY) return log(k, 'EMPTY', true);
    const before = arr[i];
    arr[i] = clamp(before + deltaFor(dir, 1, 0x10), 0, ID_MAX);
    if (isSong) last.chain = arr[i]; else last.phrase = arr[i];
    return log(k, `${big ? '上位桁' : '下位桁'} ${sign}1 : ${hex2(before)} → ${hex2(arr[i])}`);
  }

  if (st.view === 'chain') {
    const ch = chains[st.ctx.chainId];
    const before = ch.tsp[st.chain.row];
    ch.tsp[st.chain.row] = (before + deltaFor(dir, 1, 12) + 256) % 256;
    return log(k, `トランスポーズ ${big ? 'オクターブ' : '半音'} ${sign}1 : ${hex2(before)} → ${hex2(ch.tsp[st.chain.row])}`);
  }

  const ph = phrases[st.ctx.phraseId];
  const { row, col } = st.phrase;

  if (col === 0) {
    const n = ph.note[row];
    if (n === NOTE_EMPTY) return log(k, 'EMPTY', true);
    if (n === NOTE_OFF) return log(k, 'NO FUNCTION', true);
    ph.note[row] = last.note = clamp(n + deltaFor(dir, 1, 12), 0, NOTE_MAX);
    return log(k, `${big ? 'オクターブ' : '半音'} ${sign}1 : ${noteName(n)} → ${noteName(ph.note[row])}`);
  }

  if (col === 1 || col === 2) {
    const arr = col === 1 ? ph.vol : ph.ins;
    if (arr[row] < 0) return log(k, 'EMPTY', true);
    const before = arr[row];
    arr[row] = clamp(before + deltaFor(dir, 1, 0x10), 0, col === 1 ? VOL_MAX : INS_MAX);
    if (col === 1) last.vol = arr[row]; else last.ins = arr[row];
    return log(k, `${big ? '上位桁' : '下位桁'} ${sign}1 : ${hex2(before)} → ${hex2(arr[row])}`);
  }

  const f = ph.fx[fxIndex(col)];
  if (isFxCmdCol(col)) {
    if (big) {
      st.picker = { fx: fxIndex(col), idx: f.cmd[row] >= 0 ? f.cmd[row] : last.fxCmd };
      stopRepeat();
      return log(k, 'コマンド一覧を表示 (EDITを押したまま選んで離す)');
    }
    if (f.cmd[row] < 0) return log(k, 'EMPTY', true);
    const before = f.cmd[row];
    f.cmd[row] = last.fxCmd = clamp(before + deltaFor(dir, 1, 0), 0, FX_CMDS.length - 1);
    return log(k, `コマンド ${FX_CMDS[before]} → ${FX_CMDS[f.cmd[row]]}`);
  }
  const before = f.val[row];
  f.val[row] = last.fxVal = clamp(before + deltaFor(dir, 1, 0x10), 0, 0xff);
  return log(k, `${big ? '上位桁' : '下位桁'} ${sign}1 : ${hex2(before)} → ${hex2(f.val[row])}`);
}

// ===== OPTION + EDIT: delete =====
function deleteValue() {
  const k = ['opt', 'edit'];
  if (st.view === 'song' || (st.view === 'chain' && st.chain.col === 0)) {
    const isSong = st.view === 'song';
    const arr = isSong ? song[st.song.row] : chains[st.ctx.chainId].ph;
    const i = isSong ? st.song.col : st.chain.row;
    if (arr[i] === EMPTY) return log(k, 'すでに空欄です');
    if (isSong) last.chain = arr[i]; else last.phrase = arr[i];
    const before = arr[i];
    arr[i] = EMPTY;
    return log(k, `${hex2(before)} を削除 (EDIT単押しで戻せる)`);
  }
  if (st.view === 'chain') {
    chains[st.ctx.chainId].tsp[st.chain.row] = 0;
    return log(k, 'トランスポーズを 00 に戻す');
  }
  const ph = phrases[st.ctx.phraseId];
  const { row, col } = st.phrase;
  if (col === 0) {
    const n = ph.note[row];
    if (n === NOTE_EMPTY) { ph.note[row] = NOTE_OFF; return log(k, '空欄にノートオフ (OFF) を入力'); }
    if (n !== NOTE_OFF) last.note = n;
    ph.note[row] = NOTE_EMPTY;
    return log(k, `${noteName(n)} を削除`);
  }
  if (col === 1 || col === 2) {
    const arr = col === 1 ? ph.vol : ph.ins;
    if (arr[row] < 0) return log(k, 'すでに空欄です');
    if (col === 1) last.vol = arr[row]; else last.ins = arr[row];
    const before = arr[row];
    arr[row] = -1;
    return log(k, `${hex2(before)} を削除`);
  }
  const f = ph.fx[fxIndex(col)];
  if (isFxCmdCol(col)) {
    if (f.cmd[row] < 0) return log(k, 'すでに空欄です');
    last.fxCmd = f.cmd[row];
    const before = FX_CMDS[f.cmd[row]];
    f.cmd[row] = -1;
    f.val[row] = 0;
    return log(k, `${before} を削除`);
  }
  f.val[row] = 0;
  return log(k, '値を 00 に戻す');
}

// ===== FX picker =====
function pickerMove(dir) {
  const p = st.picker;
  p.idx = clamp(p.idx + { left: -1, right: 1, up: -PICKER_COLS, down: PICKER_COLS }[dir], 0, FX_CMDS.length - 1);
  log(['edit', dir], `コマンド ${FX_CMDS[p.idx]} を選択中`);
}

function pickerCommit() {
  const p = st.picker;
  st.picker = null;
  const f = phrases[st.ctx.phraseId].fx[p.fx];
  f.cmd[st.phrase.row] = last.fxCmd = p.idx;
  log(['edit'], `EDITを離して ${FX_CMDS[p.idx]} を決定`);
}

// ===== input dispatch =====
const held = new Set();
let lastEditTap = -Infinity;
let repeatTimer = null;

function press(key) {
  if (held.has(key)) return;
  held.add(key);
  setKeyVisual(key, true);
  if (navigator.vibrate) navigator.vibrate(8);
  trackGuide(key);

  const editTapCandidate = key === 'edit' && held.size === 1;
  if (key !== 'edit') lastEditTap = -Infinity;

  if (DIRS.includes(key)) {
    handleDirection(key);
    startRepeat(key);
  } else if (key === 'edit') {
    if (held.has('opt')) deleteValue();
    else if (held.has('shift')) log(['shift', 'edit'], 'NOT AVAILABLE', true);
    else if (editTapCandidate) {
      const now = performance.now();
      if (now - lastEditTap < DOUBLE_TAP_MS) { lastEditTap = -Infinity; editDoubleTap(); }
      else { lastEditTap = now; editTap(); }
    }
  } else if (key === 'opt') {
    if (st.picker) { st.picker = null; log(['opt'], 'コマンド選択をキャンセル'); }
    else if (held.has('edit')) deleteValue();
    else if (held.has('shift')) log(['shift', 'opt'], 'NOT AVAILABLE', true);
  } else if (key === 'shift') {
    if (held.has('opt')) log(['opt', 'shift'], '現在のトラックをミュート (音は出ません)');
  } else if (key === 'play') {
    if (held.has('opt')) log(['opt', 'play'], '現在のトラックをソロ (音は出ません)');
    else if (held.has('shift')) log(['shift', 'play'], 'カーソル位置からソングを再生 (音は出ません)');
    else {
      st.playing = !st.playing;
      log(['play'], `${st.playing ? '再生' : '停止'} (このアプリでは音は出ません)`);
    }
  }
  render();
}

function release(key) {
  if (!held.has(key)) return;
  held.delete(key);
  setKeyVisual(key, false);
  if (DIRS.includes(key)) stopRepeat();
  if (key === 'edit' && st.picker) { pickerCommit(); render(); }
}

function handleDirection(dir) {
  if (st.picker) return held.has('edit') ? pickerMove(dir) : undefined;
  if (held.has('edit')) return editValue(dir);
  if (held.has('shift')) return navigateView(dir);
  if (held.has('opt')) return optNav(dir);
  return moveCursor(dir);
}

function startRepeat(dir) {
  stopRepeat();
  if (held.has('shift')) return;  // view switching should not auto-repeat
  repeatTimer = setTimeout(function tick() {
    if (!held.has(dir)) return;
    handleDirection(dir);
    render();
    repeatTimer = setTimeout(tick, 70);
  }, 380);
}

function stopRepeat() {
  clearTimeout(repeatTimer);
  repeatTimer = null;
}

// ===== wire up on-screen buttons =====
const keyEls = {};
document.querySelectorAll('.key').forEach((el) => {
  const key = el.dataset.key;
  keyEls[key] = el;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    press(key);
  });
  const up = () => release(key);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
});

function setKeyVisual(key, on) {
  keyEls[key]?.classList.toggle('down', on);
}

// ===== keyboard (same mapping as m8.run: arrows, L-Shift, Space, Z, X) =====
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  ShiftLeft: 'shift', Space: 'play', KeyZ: 'opt', KeyX: 'edit',
};
window.addEventListener('keydown', (e) => {
  const key = KEYMAP[e.code];
  if (!key) return;
  e.preventDefault();
  if (!e.repeat) press(key);
});
window.addEventListener('keyup', (e) => {
  const key = KEYMAP[e.code];
  if (key) release(key);
});
window.addEventListener('blur', () => [...held].forEach(release));
document.addEventListener('dblclick', (e) => e.preventDefault());

render();
