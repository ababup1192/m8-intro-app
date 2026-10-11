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
  sel: null,                  // selection mode: { row, col (anchor), mode: 'cells' | 'rows' | 'cols' }
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
const TABS = [['edit', '編集'], ['sel', '選択'], ['nav', '移動'], ['play', '再生']];
const NAV_IDS = ['open-chain', 'open-phrase', 'to-song', 'to-chain', 'page', 'chain-nav', 'phrase-nav', 'track-nav'];
const PLAY_IDS = ['play', 'play-song', 'mute', 'solo', 'solo-side'];
const categoryOf = (id) => (NAV_IDS.includes(id) ? 'nav' : PLAY_IDS.includes(id) ? 'play'
  : id === 'paste' || id.startsWith('sel-') ? 'sel' : 'edit');
const canPaste = () => !!clip && clip.view === st.view;

// actions while selection mode is active
function selectionActions() {
  const { r0, r1, c0, c1 } = selRange();
  const kind = GRID[st.view].kind(c0);
  const single = c0 === c1;
  const pitch = single && (kind === 'note' || kind === 'tsp');
  const list = [
    act('sel-grow', '選択範囲を広げる / 狭める', [], ARROWS),
    act('sel-copy', 'コピーして選択終了', [], 'opt'),
    act('sel-cut', 'カット (切り取り)', ['opt'], 'edit'),
    act('sel-small', single && kind === 'fxcmd' ? 'まとめてコマンドを前後' : `まとめて ${pitch ? '±半音' : '±1'}`, ['edit'], ['left', 'right']),
  ];
  if (st.view === 'song') list.push(act('sel-move', '選択ブロックを上下に移動', ['edit'], ['up', 'down']));
  else if (st.view === 'phrase' && c1 > c0 && r1 > r0) list.push(act('sel-nudge', '選択内の中身を上下にずらす', ['edit'], ['up', 'down']));
  else if (!(single && kind === 'fxcmd')) list.push(act('sel-large', `まとめて ${pitch ? '±オクターブ' : '±10'}`, ['edit'], ['up', 'down']));
  if (canInterpolate()) list.push(act('sel-interp', '最初と最後の値で補間', ['shift'], 'edit'));
  list.push(act('sel-mode', '選択の形を切替 (範囲 → 行 → 列)', ['shift'], 'opt'));
  return list;
}

function selectionTools() {
  const list = [act('sel-start', '範囲選択を開始', ['shift'], 'opt')];
  if (canPaste()) list.unshift(act('paste', 'ペースト (カーソル位置に挿入)', ['shift'], 'edit'));
  return list;
}
let tab = 'edit';

function actionsFor() {
  if (st.picker) {
    return [
      act('pick', 'コマンドを選ぶ (EDITは押したまま)', ['edit'], ARROWS),
      act('pick-ok', 'EDITを離して決定', [], 'edit'),
      act('pick-cancel', 'キャンセル', [], 'opt'),
    ];
  }
  if (st.sel) return selectionActions();
  return [...viewActions(), ...selectionTools()];
}

function viewActions() {
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

function clipInfo() {
  const name = { song: 'SONG', chain: 'CHAIN', phrase: 'PHRASE' }[clip.view];
  const size = `${clip.data.length}行×${clip.data[0].length}列`;
  return `コピー中: ${name} ${size}` + (canPaste() ? '' : `<br><small>${name}画面でペーストできます</small>`);
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
  if (b && !st.picker && !st.sel) { tab = b.dataset.tab; render(); }
});

function renderActions() {
  const list = actionsFor();
  if (guide && guide.left === guide.count && !list.some((a) => a.id === guide.id)) guide = null;
  // the FX picker and selection mode each lock the list to their own tab
  const shown = st.picker ? 'edit' : st.sel ? 'sel' : tab;
  const locked = st.picker || st.sel;
  tabsEl.innerHTML = TABS.map(([k, name]) => {
    const cls = [k === shown && 'on', locked && k !== shown && 'off', k === 'sel' && canPaste() && 'dot'].filter(Boolean).join(' ');
    return `<button data-tab="${k}" class="${cls}">${name}</button>`;
  }).join('');
  const items = list.filter((a) => categoryOf(a.id) === shown).map((a) =>
    `<li data-id="${a.id}" class="${guide?.id === a.id ? 'on' : ''}"><span class="lbl">${a.label}</span><span class="kbd">${comboText(a)}</span></li>`);
  if (shown === 'sel' && clip && !st.sel) items.unshift(`<li class="info">${clipInfo()}</li>`);
  actionsEl.innerHTML = items.join('');

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
let selR = null;  // selection range for the current render
// class for grid cell (r, c) of the current view: cursor, selected, or plain
function cc(r, c, cls) {
  const p = curPos();
  if (r === p.row && c === p.col) return `${cls} cur`;
  if (selR && r >= selR.r0 && r <= selR.r1 && c >= selR.c0 && c <= selR.c1) return `${cls} sel`;
  return cls;
}

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
      line += ' ' + s(v === EMPTY ? '--' : hex2(v), cc(r, c, cls));
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
      + s(p === EMPTY ? '--' : hex2(p), cc(r, 0, pCls)) + '  '
      + s(hex2(ch.tsp[r]), cc(r, 1, ch.tsp[r] ? 'val' : 'dimv')));
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
    const n = ph.note[r], v = ph.vol[r], i = ph.ins[r];
    let line = s(hex1(r), r % 4 === 0 ? 'rn beat' : 'rn') + ' '
      + s(noteName(n), cc(r, 0, n === NOTE_EMPTY ? 'empty' : 'val')) + ' '
      + s(v < 0 ? '--' : hex2(v), cc(r, 1, v < 0 ? 'empty' : 'val')) + ' '
      + s(i < 0 ? '--' : hex2(i), cc(r, 2, i < 0 ? 'empty' : 'val'));
    ph.fx.forEach((f, k) => {
      const cmd = f.cmd[r];
      line += ' ' + s(cmd < 0 ? '---' : FX_CMDS[cmd], cc(r, 3 + k * 2, cmd < 0 ? 'empty' : 'val'))
        + s(hex2(f.val[r]), cc(r, 4 + k * 2, cmd < 0 ? 'empty' : 'val'));
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
  selR = st.sel ? selRange() : null;
  const lines = st.picker ? renderPicker() : { song: renderSong, chain: renderChain, phrase: renderPhrase }[st.view]();
  if (selR) {
    lines[lines.length - 1] = s(`SELECT ${selR.r1 - selR.r0 + 1}x${selR.c1 - selR.c0 + 1}${SEL_MODE_NAME[st.sel.mode]}`, 'help');
  }
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

// ===== selection mode (SHIFT+OPT) =====
// copy buffer: { view, c0, data: rows x cols }
let clip = null;

const GRID = {
  song: { rows: 256, cols: 8, kind: () => 'chain' },
  chain: { rows: 16, cols: 2, kind: (c) => (c === 0 ? 'phrase' : 'tsp') },
  phrase: { rows: 16, cols: 9, kind: (c) => ['note', 'vol', 'ins'][c] || (isFxCmdCol(c) ? 'fxcmd' : 'fxval') },
};
const EMPTY_OF = { chain: EMPTY, phrase: EMPTY, tsp: 0, note: NOTE_EMPTY, vol: -1, ins: -1, fxcmd: -1, fxval: 0 };
// [small step, large step, min, max, wraps]
const STEP = {
  chain: [1, 0x10, 0, ID_MAX], phrase: [1, 0x10, 0, ID_MAX], tsp: [1, 12, 0, 0xff, true],
  note: [1, 12, 0, NOTE_MAX], vol: [1, 0x10, 0, VOL_MAX], ins: [1, 0x10, 0, INS_MAX],
  fxcmd: [1, 0, 0, FX_CMDS.length - 1], fxval: [1, 0x10, 0, 0xff],
};
const SEL_MODES = ['cells', 'rows', 'cols'];
const SEL_MODE_NAME = { cells: '', rows: ' ROWS', cols: ' COLS' };

const curPos = () => st[st.view];

function colArray(c) {
  if (st.view === 'chain') { const ch = chains[st.ctx.chainId]; return c === 0 ? ch.ph : ch.tsp; }
  const ph = phrases[st.ctx.phraseId];
  if (c < 3) return [ph.note, ph.vol, ph.ins][c];
  const f = ph.fx[fxIndex(c)];
  return isFxCmdCol(c) ? f.cmd : f.val;
}
const cellGet = (r, c) => (st.view === 'song' ? song[r][c] : colArray(c)[r]);
const cellSet = (r, c, v) => { if (st.view === 'song') song[r][c] = v; else colArray(c)[r] = v; };

function selRange() {
  const p = curPos(), a = st.sel, g = GRID[st.view];
  let r0 = Math.min(a.row, p.row), r1 = Math.max(a.row, p.row);
  let c0 = Math.min(a.col, p.col), c1 = Math.max(a.col, p.col);
  if (a.mode === 'rows') { c0 = 0; c1 = g.cols - 1; }
  if (a.mode === 'cols') { r0 = 0; r1 = g.rows - 1; }
  return { r0, r1, c0, c1 };
}

function startSelection() {
  const p = curPos();
  st.sel = { row: p.row, col: p.col, mode: 'cells' };
  tab = 'sel';
}

function cycleSelection() {
  st.sel.mode = SEL_MODES[(SEL_MODES.indexOf(st.sel.mode) + 1) % SEL_MODES.length];
}

function copySelection(cut) {
  const { r0, r1, c0, c1 } = selRange();
  const kind = GRID[st.view].kind;
  const data = [];
  for (let r = r0; r <= r1; r++) {
    const rowData = [];
    for (let c = c0; c <= c1; c++) {
      rowData.push(cellGet(r, c));
      if (cut) cellSet(r, c, EMPTY_OF[kind(c)]);
    }
    data.push(rowData);
  }
  clip = { view: st.view, c0, data };
  st.sel = null;
  Object.assign(curPos(), { row: r0, col: c0 });
  if (st.view === 'song') scrollSong();
}

function paste() {
  if (!clip) return log([], 'BUFFER EMPTY', true);
  if (clip.view !== st.view) return log([], 'NO FUNCTION', true);
  const g = GRID[st.view], p = curPos();
  const col0 = st.view === 'song' ? p.col : clip.c0;  // tracks are alike; chain/phrase columns are not
  const n = clip.data.length;
  const cols = clip.data[0].length;
  // insert: rows from the cursor down are pushed down by n; anything past the end falls off
  for (let c = col0; c < Math.min(col0 + cols, g.cols); c++) {
    for (let r = g.rows - 1; r >= p.row + n; r--) cellSet(r, c, cellGet(r - n, c));
  }
  clip.data.forEach((rowData, i) => rowData.forEach((v, j) => {
    const r = p.row + i, c = col0 + j;
    if (r < g.rows && c < g.cols) cellSet(r, c, v);
  }));
}

function bump(kind, v, dir) {
  const [small, large, lo, hi, wraps] = STEP[kind];
  if (kind !== 'tsp' && kind !== 'fxval' && v === EMPTY_OF[kind]) return v;
  if (kind === 'note' && v === NOTE_OFF) return v;
  const d = deltaFor(dir, small, large);
  return wraps ? (((v + d) % 256) + 256) % 256 : clamp(v + d, lo, hi);
}

// EDIT + direction while selecting
function selectionEdit(dir) {
  const { r0, r1, c0, c1 } = selRange();
  const vertical = dir === 'up' || dir === 'down';
  const step = dir === 'up' ? -1 : 1;
  if (vertical && st.view === 'song') return moveSongBlock(r0, r1, c0, c1, step);
  if (vertical && st.view === 'phrase' && c1 > c0 && r1 > r0) return nudge(r0, r1, c0, c1, step);
  const kind = GRID[st.view].kind;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (kind(c) === 'fxval' && cellGet(r, c - 1) < 0) continue;  // value without a command
      cellSet(r, c, bump(kind(c), cellGet(r, c), dir));
    }
  }
}

// song view: the selected block moves one row into empty space; it stops at a row that has chains
function moveSongBlock(r0, r1, c0, c1, step) {
  if (r0 + step < 0 || r1 + step > 255) return;
  const target = step < 0 ? r0 - 1 : r1 + 1;
  for (let c = c0; c <= c1; c++) if (song[target][c] !== EMPTY) return;  // blocked: selection stays put
  for (let c = c0; c <= c1; c++) {
    const col = [];
    for (let r = r0; r <= r1; r++) col.push(song[r][c]);
    const displaced = song[step < 0 ? r0 - 1 : r1 + 1][c];
    col.forEach((v, i) => { song[r0 + step + i][c] = v; });
    song[step < 0 ? r1 : r0][c] = displaced;
  }
  st.sel.row += step;
  st.song.row += step;
  scrollSong();
}

// phrase view: rotate the selected rows inside the selection
function nudge(r0, r1, c0, c1, step) {
  for (let c = c0; c <= c1; c++) {
    const col = [];
    for (let r = r0; r <= r1; r++) col.push(cellGet(r, c));
    if (step < 0) col.push(col.shift()); else col.unshift(col.pop());
    col.forEach((v, i) => cellSet(r0 + i, c, v));
  }
}

function canInterpolate() {
  if (!st.sel || st.view !== 'phrase') return false;
  const { r0, r1, c0, c1 } = selRange();
  const kind = GRID.phrase.kind(c0);
  if (c0 !== c1 || r1 === r0 || kind === 'fxcmd') return false;
  const ok = (r) => kind === 'fxval' ? cellGet(r, c0 - 1) >= 0
    : cellGet(r, c0) !== EMPTY_OF[kind] && cellGet(r, c0) !== NOTE_OFF;
  return ok(r0) && ok(r1);
}

// SHIFT+EDIT on a single phrase column: fill linearly between first and last row
function interpolate() {
  if (!canInterpolate()) return log([], 'NO FUNCTION', true);
  const { r0, r1, c0 } = selRange();
  const a = cellGet(r0, c0), b = cellGet(r1, c0);
  const cmd = GRID.phrase.kind(c0) === 'fxval' ? cellGet(r0, c0 - 1) : null;
  for (let r = r0; r <= r1; r++) {
    cellSet(r, c0, Math.round(a + ((b - a) * (r - r0)) / (r1 - r0)));
    if (cmd !== null) cellSet(r, c0 - 1, cmd);
  }
}

// ===== input dispatch =====
const held = new Set();
let lastEditTap = -Infinity;
let repeatTimer = null;
let optAlone = false;   // OPT tapped by itself in selection mode -> copy on release

function press(key) {
  if (held.has(key)) return;
  held.add(key);
  setKeyVisual(key, true);
  if (navigator.vibrate) navigator.vibrate(8);
  trackGuide(key);

  const editTapCandidate = key === 'edit' && held.size === 1;
  if (key !== 'edit') lastEditTap = -Infinity;
  if (key !== 'opt') optAlone = false;

  if (DIRS.includes(key)) {
    handleDirection(key);
    startRepeat(key);
  } else if (key === 'edit') {
    if (held.has('opt')) st.sel ? copySelection(true) : deleteValue();
    else if (held.has('shift')) st.sel ? interpolate() : paste();
    else if (st.sel) { /* EDIT alone does nothing while selecting */ }
    else if (editTapCandidate) {
      const now = performance.now();
      if (now - lastEditTap < DOUBLE_TAP_MS) { lastEditTap = -Infinity; editDoubleTap(); }
      else { lastEditTap = now; editTap(); }
    }
  } else if (key === 'opt') {
    if (st.picker) { st.picker = null; log(['opt'], 'コマンド選択をキャンセル'); }
    else if (held.has('edit')) st.sel ? copySelection(true) : deleteValue();
    else if (held.has('shift')) st.sel ? cycleSelection() : startSelection();
    else if (st.sel) optAlone = true;
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
  if (key === 'opt' && optAlone) { optAlone = false; if (st.sel) copySelection(false); render(); }
}

function handleDirection(dir) {
  if (st.picker) return held.has('edit') ? pickerMove(dir) : undefined;
  if (st.sel) {
    if (held.has('edit')) return selectionEdit(dir);
    if (held.has('shift') || held.has('opt')) return log([], 'NO FUNCTION', true);
    return moveCursor(dir);  // grows / shrinks the selection
  }
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
