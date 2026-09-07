/* Order View (発注ビューア) — app.js */
(function () {
  'use strict';

  const APP_VERSION = '1.5.0';
  const APP_DATE = '2026-09-07';
  const START_SHEET = '直近';
  const BOUNDARY_SHEET = '所要(調整)'; // sheets to the right of this are targets
  const LS_KEY = 'orderviewer:v2';
  const DB_NAME = 'orderviewer';
  const DB_STORE = 'files';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const svgUse = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; };

  // ---------------------------------------------------------------- state
  const defaults = {
    hideEmptyRows: true, hideEmptyCols: true, showHeaders: false, showFills: true,
    allSheets: false, autoOpen: true, fontScale: 1, ltFilter: true,
  };
  const state = {
    opts: Object.assign({}, defaults),
    book: null,
    fileMeta: null,
    sheetIdx: -1,
    view: 'grid',
    query: '',
    views: {},    // sheetName -> view
    colVis: {},   // sheetName -> [header texts shown] (attribute columns), null = default
    zooms: {},    // sheetName -> zoom
    daySel: {},   // sheetName -> selected date serial
    lastSheet: null,
    prepared: new Map(), // sheetIndex -> model
    panes: [{ idx: -1, view: 'grid' }, { idx: -1, view: 'grid' }],
    active: 0,
    split: false,
    splitRatio: 0.5,
    splitNames: [null, null],
    colFilters: {}, // sheetName -> { col: { values: [..]|null, nonEmpty: bool, min: n|null, max: n|null } }
  };
  const pane = () => state.panes[state.active];
  Object.defineProperty(state, 'sheetIdx', { get: () => pane().idx, set: (v) => { pane().idx = v; } });
  Object.defineProperty(state, 'view', { get: () => pane().view, set: (v) => { pane().view = v; } });

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        Object.assign(state.opts, p.opts || {});
        state.views = p.views || {};
        state.colVis = p.colVis || {};
        state.lastSheet = p.lastSheet || null;
        state.split = !!p.split;
        state.splitRatio = p.splitRatio || 0.5;
        state.splitNames = p.splitNames || [null, null];
        state.colFilters = p.colFilters || {};
      }
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try {
      const names = state.panes.map((pn) => { const m = state.prepared.get(pn.idx); return m ? m.sheet.name : null; });
      localStorage.setItem(LS_KEY, JSON.stringify({ opts: state.opts, views: state.views, colVis: state.colVis, lastSheet: state.lastSheet, split: state.split, splitRatio: state.splitRatio, splitNames: names, colFilters: state.colFilters }));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- IndexedDB
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
  }
  async function idbDel(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------------------------------------------------------------- UI helpers
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4200 : 2200);
  }
  function overlay(show, msg, pct) {
    const o = $('overlay');
    o.hidden = !show;
    if (msg !== undefined) $('overlayMsg').textContent = msg;
    if (pct !== undefined) $('overlayBar').style.width = pct + '%';
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function fmtDateTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtBytes(n) {
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function luminance(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function isWhiteish(hex) { return !hex || /^#F{6}$/i.test(hex) || luminance(hex) > 0.985; }
  function todaySerial() {
    const d = new Date();
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 25569;
  }

  // ---------------------------------------------------------------- target sheets
  function isTarget(idx, names) {
    const iStart = names.indexOf(START_SHEET);
    const iEnd = names.indexOf(BOUNDARY_SHEET);
    if (idx === iStart) return true;
    if (iEnd >= 0) return idx > iEnd;
    if (iStart >= 0) return idx >= iStart;
    return true;
  }
  function targetSheets() {
    const names = state.book.allSheetNames;
    return state.book.sheets.filter((s) => s.state === 'visible' && isTarget(s.index, names));
  }
  function otherSheets() {
    const names = state.book.allSheetNames;
    return state.book.sheets.filter((s) => s.state === 'visible' && !isTarget(s.index, names));
  }

  // ---------------------------------------------------------------- cell model
  function makeModel(sheet, styles) {
    const m = {
      sheet, styles,
      styleCache: new Map(),
      hiddenCol: (c) => !!(sheet.cols[c] && sheet.cols[c].hidden),
      hiddenRow: (r) => !!(sheet.rows[r] && sheet.rows[r].hidden),
    };
    m.styleOf = (cell) => {
      const sid = cell ? cell.s : 0;
      let st = m.styleCache.get(sid);
      if (st) return st;
      const xf = styles.xfs[sid] || styles.xfs[0] || { numFmtId: 0, fontId: 0, fillId: 0 };
      const font = styles.fonts[xf.fontId] || { size: 11 };
      st = {
        code: styles.numFmts[xf.numFmtId] || 'General',
        font,
        fill: styles.fills[xf.fillId] || null,
        h: xf.h || null, v: xf.v || null, wrap: !!xf.wrap, rot: xf.rot || 0,
      };
      if (st.fill && isWhiteish(st.fill)) st.fill = null;
      m.styleCache.set(sid, st);
      return st;
    };
    m.cell = (r, c) => { const row = sheet.cells[r]; return row ? row[c] : undefined; };
    m.info = (cell) => {
      if (!cell) return { text: '', isDate: false, isNumber: false };
      if (cell._f === undefined) cell._f = NumFmt.formatCell(cell, m.styleOf(cell).code);
      return cell._f;
    };
    m.text = (cell) => m.info(cell).text;
    m.has = (r, c) => { const cl = m.cell(r, c); return !!(cl && cl.v !== null && cl.v !== undefined); };
    m.isDateCell = (cell) => !!cell && ((cell.t === 'n' && m.info(cell).isDate) || cell.t === 'd');
    m.serialOf = (cell) => {
      if (!cell) return null;
      if (cell.t === 'n' && m.info(cell).isDate) return cell.v;
      if (cell.t === 'd') { const d = new Date(cell.v); return Number.isNaN(d.getTime()) ? null : d.getTime() / 86400000 + 25569; }
      return null;
    };
    m.mergeAnchor = new Map();
    m.covered = new Set();
    for (const mg of sheet.merges) {
      m.mergeAnchor.set(mg.r1 + ',' + mg.c1, mg);
      for (let r = mg.r1; r <= mg.r2; r++) for (let c = mg.c1; c <= mg.c2; c++) if (r !== mg.r1 || c !== mg.c1) m.covered.add(r + ',' + c);
    }
    m.rowHasValue = [];
    m.colHasValue = [];
    for (let r = 1; r <= sheet.maxRow; r++) {
      const row = sheet.cells[r];
      let any = false;
      if (row) for (let c = 1; c < row.length; c++) { const cl = row[c]; if (cl && cl.v !== null && cl.v !== undefined) { any = true; m.colHasValue[c] = true; } }
      m.rowHasValue[r] = any;
    }
    return m;
  }

  function visibleRows(m, hideEmpty) {
    const rows = [];
    for (let r = 1; r <= m.sheet.maxRow; r++) {
      if (m.hiddenRow(r)) continue;
      if (hideEmpty && !m.rowHasValue[r]) continue;
      rows.push(r);
    }
    return rows;
  }

  // ---------------------------------------------------------------- detection
  function detectHeader(m) {
    const s = m.sheet;
    const scoreRow = (r) => {
      let n = 0, str = 0;
      const row = s.cells[r];
      if (!row) return { n, str };
      for (let c = 1; c < row.length; c++) {
        const cl = row[c];
        if (!cl || cl.v === null || cl.v === undefined) continue;
        n++;
        if (cl.t === 's') str++;
      }
      return { n, str };
    };
    // a row containing 品番 + 当日 is the header of the requirement sheets
    for (let r = 1; r <= Math.min(12, s.maxRow); r++) {
      const row = s.cells[r];
      if (!row) continue;
      let hinban = false, tojitsu = false;
      for (let c = 1; c < row.length; c++) { const cl = row[c]; if (cl && cl.t === 's') { if (cl.v === '品番') hinban = true; if (cl.v === '当日') tojitsu = true; } }
      if (hinban && tojitsu) return r;
    }
    if (s.freeze.y > 0 && s.freeze.y <= 30) {
      const sc = scoreRow(s.freeze.y);
      if (sc.n >= 2 && sc.str >= 2) return s.freeze.y;
    }
    for (let r = 1; r <= Math.min(15, s.maxRow); r++) {
      const sc = scoreRow(r);
      if (sc.n >= 2 && sc.str / sc.n >= 0.6 && r < s.maxRow) return r;
    }
    return 0;
  }

  function detectSchedule(m) {
    const s = m.sheet;
    const blocks = [];
    let headerRow = 0;
    for (let r = 1; r <= Math.min(8, s.maxRow) && !blocks.length; r++) {
      const row = s.cells[r];
      if (!row) continue;
      for (let c = 1; c < row.length; c++) {
        const cl = row[c];
        if (!cl || cl.t !== 's' || String(cl.v).indexOf('出荷日') < 0) continue;
        for (let k = c - 1; k >= 1; k--) {
          const dc = row[k];
          if (dc && dc.t === 's' && String(dc.v).indexOf('出荷日') >= 0) break;
          const serial = m.serialOf(dc);
          if (serial !== null) {
            let hiddenAll = true;
            for (let x = k; x <= c; x++) if (!m.hiddenCol(x)) { hiddenAll = false; break; }
            blocks.push({ c1: k, c2: c, serial, hidden: hiddenAll, row: r });
            break;
          }
        }
      }
      if (blocks.length) headerRow = r;
    }
    if (blocks.length < 2) return null;
    let gc = 1;
    while (gc <= s.maxCol && m.hiddenCol(gc)) gc++;
    const groups = [];
    for (let r = headerRow + 1; r <= s.maxRow; r++) {
      const cl = m.cell(r, gc);
      if (cl && cl.t === 's' && !m.hiddenRow(r)) groups.push({ name: String(cl.v), r1: r, r2: s.maxRow });
    }
    for (let i = 0; i < groups.length - 1; i++) groups[i].r2 = groups[i + 1].r1 - 1;
    if (!groups.length) groups.push({ name: s.name, r1: headerRow + 1, r2: s.maxRow });
    return { blocks: blocks.filter((b) => !b.hidden), allBlocks: blocks, groups, headerRow, groupCol: gc };
  }

  /** Column configuration for the table view of requirement-style sheets (品番 … 当日 … dates). */
  function detectGridConfig(m) {
    const hr = m.headerRow;
    if (!hr) return null;
    const s = m.sheet;
    let dayCol = 0;
    const heads = [];
    for (let c = 1; c <= s.maxCol; c++) {
      const cl = m.cell(hr, c);
      const text = m.text(cl);
      if (cl && cl.t === 's' && cl.v === '当日' && !dayCol) dayCol = c;
      heads.push({ c, text, isDate: m.isDateCell(cl), serial: m.serialOf(cl) });
    }
    if (!dayCol) {
      const firstDate = heads.find((h) => h.isDate);
      if (!firstDate) return null;
      dayCol = firstDate.c;
    }
    const attr = heads.filter((h) => h.c < dayCol && h.text && !m.hiddenCol(h.c));
    if (!attr.length) return null;
    const keyCols = attr.filter((h) => /品番/.test(h.text)).slice(0, 1).concat(attr.filter((h) => /品名/.test(h.text)).slice(0, 1)).map((h) => h.c);
    if (!keyCols.length) keyCols.push(attr[0].c);
    const kubun = attr.find((h) => h.text === '区分');
    const defaultShown = new Set(keyCols);
    if (kubun) defaultShown.add(kubun.c);
    const ltHead = heads.find((h) => /発注\s*L\s*\/?\s*T/i.test(h.text)) || heads.find((h) => /L\s*\/?\s*T/i.test(h.text));
    return { dayCol, attr, keyCols, kubunCol: kubun ? kubun.c : 0, defaultShown, heads, ltCol: ltHead ? ltHead.c : 0 };
  }

  async function getModel(sheetIndex) {
    let m = state.prepared.get(sheetIndex);
    if (m) return m;
    const sheet = await state.book.loadSheet(sheetIndex);
    if (!sheet) return null;
    m = makeModel(sheet, state.book.styles);
    m.headerRow = detectHeader(m);
    m.schedule = detectSchedule(m);
    m.gridConfig = m.schedule ? null : detectGridConfig(m);
    state.prepared.set(sheetIndex, m);
    return m;
  }

  // ---------------------------------------------------------------- file loading
  async function openBuffer(buffer, meta, fromCache) {
    overlay(true, 'ファイルを展開中…', 3);
    try {
      const book = await XlsxLite.openWorkbook(buffer, (msg, pct) => overlay(true, msg, Math.min(pct, 40)));
      state.book = book;
      state.prepared.clear();
      state.fileMeta = meta;
      const targets = targetSheets();
      if (!targets.length) throw new Error('表示対象のシート（直近・所要(調整)より右）が見つかりませんでした。');
      if (!fromCache) {
        try { await idbPut('last', Object.assign({ buffer }, meta)); } catch (e) { console.warn('cache failed', e); }
      }
      const first = (state.lastSheet && book.sheets.find((t) => t.name === state.lastSheet && t.state === 'visible' && (isTarget(t.index, book.allSheetNames) || state.opts.allSheets))) || targets[0];
      showViewer();
      state.active = 0;
      state.panes[1].idx = -1;
      await selectSheet(first.index, true);
      if (state.split) {
        const other = state.splitNames[1] && book.sheets.find((t) => t.name === state.splitNames[1] && t.state === 'visible');
        const idx1 = other ? other.index : (targets.find((t) => t.index !== first.index) || {}).index;
        if (idx1 !== undefined) { overlay(true, 'もう一方のシートを読み込み中…', 85); await tick(); await selectSheet(idx1, true, 1); }
        else state.split = false;
        render();
      }
    } catch (err) {
      console.error(err);
      toast('読み込みに失敗しました: ' + (err && err.message ? err.message : err), true);
      if (!state.book) showHome();
    } finally {
      overlay(false);
    }
  }

  async function openFile(file) {
    if (!file) return;
    if (/\.xls$/i.test(file.name)) { toast('旧形式 (.xls) は対応していません。.xlsx / .xlsm で保存してください。', true); return; }
    overlay(true, 'ファイルを読み込み中…', 1);
    try {
      const buffer = await file.arrayBuffer();
      await openBuffer(buffer, { name: file.name, size: file.size, lastModified: file.lastModified, savedAt: Date.now() }, false);
    } catch (err) {
      overlay(false);
      toast('ファイルを読めませんでした', true);
    }
  }

  async function openRecent() {
    try {
      const rec = await idbGet('last');
      if (!rec) { toast('保存されたファイルがありません'); return false; }
      await openBuffer(rec.buffer, { name: rec.name, size: rec.size, lastModified: rec.lastModified, savedAt: rec.savedAt }, true);
      return true;
    } catch (e) {
      toast('保存ファイルを開けませんでした', true);
      return false;
    }
  }

  async function refreshRecentButton() {
    const btn = $('recentBtn');
    try {
      const rec = await idbGet('last');
      if (!rec) { btn.hidden = true; return null; }
      $('recentName').textContent = rec.name;
      $('recentInfo').textContent = `前回開いたファイル · ${fmtBytes(rec.size)} · ${fmtDateTime(rec.savedAt)} 保存`;
      btn.hidden = false;
      return rec;
    } catch (e) { btn.hidden = true; return null; }
  }

  // ---------------------------------------------------------------- screens
  function showHome() {
    $('home').hidden = false;
    $('viewer').hidden = true;
    $('fab').hidden = true;
    $('ttlSheet').textContent = 'Order View';
    $('ttlFile').textContent = state.fileMeta ? `読み込み中: ${state.fileMeta.name}` : 'ファイルを選択してください';
    $('count').textContent = '';
    hideCellInfo();
    refreshRecentButton();
  }
  function showViewer() {
    $('home').hidden = true;
    $('viewer').hidden = false;
    $('fab').hidden = false;
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer() {
    renderDrawer();
    $('drawerBg').hidden = false; $('drawer').hidden = false;
    requestAnimationFrame(() => { $('drawerBg').classList.add('show'); $('drawer').classList.add('show'); });
  }
  function closeDrawer() {
    $('drawerBg').classList.remove('show'); $('drawer').classList.remove('show');
    setTimeout(() => { $('drawerBg').hidden = true; $('drawer').hidden = true; }, 240);
  }
  function renderDrawer() {
    $('drawerFile').textContent = state.fileMeta ? state.fileMeta.name : 'ファイル未選択';
    $('drawerVer').textContent = 'Ver ' + APP_VERSION;
    const list = $('drawerSheets');
    list.innerHTML = '';
    if (!state.book) { list.appendChild(el('div', 'drawer-empty', 'ファイルを読み込むとシートが表示されます')); return; }
    if (state.split && $('home').hidden) list.appendChild(el('div', 'drawer-empty', `タップしたシートを「${state.active === 0 ? '上' : '下'}」のペインに表示します`));
    const addItem = (s, other) => {
      const b = el('button', 'drawer-item' + (other ? ' other' : '') + (s.index === state.sheetIdx && $('home').hidden ? ' on' : ''));
      const dot = el('i', 'sdot');
      const model = state.prepared.get(s.index);
      if (model && model.sheet.tabColor) dot.style.background = model.sheet.tabColor;
      b.appendChild(dot);
      b.appendChild(el('span', null, s.name));
      if (state.split) {
        const where = state.panes.map((pn, i) => (pn.idx === s.index ? (i === 0 ? '上' : '下') : '')).filter(Boolean).join('・');
        if (where) b.appendChild(el('small', null, where));
      } else if (model) b.appendChild(el('small', null, model.schedule ? '日別' : `${model.sheet.maxRow}行`));
      b.addEventListener('click', async () => { closeDrawer(); showViewer(); await selectSheet(s.index); });
      list.appendChild(b);
    };
    for (const s of targetSheets()) addItem(s, false);
    if (state.opts.allSheets) {
      const others = otherSheets();
      if (others.length) {
        list.appendChild(el('div', 'drawer-sec', 'その他のシート'));
        for (const s of others) addItem(s, true);
      }
    }
  }

  // ---------------------------------------------------------------- sheet selection
  async function selectSheet(idx, initial, paneNo) {
    if (paneNo === undefined) paneNo = state.active;
    let m = state.prepared.get(idx);
    if (!m) {
      overlay(true, `シート「${state.book.sheets[idx].name}」を読み込み中…`, initial ? 55 : 30);
      await tick();
      try { m = await getModel(idx); } finally { if (!initial) overlay(false); }
      if (!m) { toast('シートを読み込めませんでした', true); return; }
    }
    const pn = state.panes[paneNo];
    pn.idx = idx;
    if (paneNo === 0) state.lastSheet = m.sheet.name;
    const available = availableViews(m);
    let v = state.views[m.sheet.name];
    if (!available.includes(v)) v = defaultView(m, available);
    pn.view = v;
    savePrefs();
    state.query = '';
    $('searchInput').value = '';
    $('searchBox').classList.remove('has');
    $('fabDot').hidden = true;
    render();
  }

  function availableViews(m) {
    const v = [];
    if (m.schedule) { v.push('daily', 'grid', 'raw'); return v; }
    if (m.headerRow > 0 && m.sheet.maxRow > m.headerRow) v.push('cards');
    v.push('grid');
    return v;
  }
  function defaultView(m, available) {
    if (available.includes('daily')) return 'daily';
    if (m.gridConfig) return 'grid';
    if (available.includes('cards')) return 'cards';
    return 'grid';
  }

  function render() {
    const viewer = $('viewer');
    viewer.innerHTML = '';
    document.documentElement.style.setProperty('--scale', state.opts.fontScale);
    hideCellInfo();
    const m0 = state.prepared.get(state.panes[0].idx);
    if (!state.split) {
      if (!m0) return;
      $('ttlSheet').textContent = m0.sheet.name;
      $('ttlFile').textContent = state.query ? `検索: ${state.query}` : (state.fileMeta ? `${state.fileMeta.name} · ${fmtDateTime(state.fileMeta.savedAt)}` : '');
      renderPane(0, viewer, false);
      return;
    }
    const m1 = state.prepared.get(state.panes[1].idx);
    $('ttlSheet').textContent = [m0, m1].map((m) => (m ? m.sheet.name : '—')).join(' / ');
    $('ttlFile').textContent = state.query ? `検索: ${state.query}` : '分割ビュー';
    $('count').textContent = '';
    const split = el('div', 'split');
    split.style.setProperty('--ratio', state.splitRatio);
    const top = el('div', 'pane top' + (state.active === 0 ? ' active' : ''));
    const handle = el('div', 'split-handle');
    const bottom = el('div', 'pane bottom' + (state.active === 1 ? ' active' : ''));
    split.appendChild(top); split.appendChild(handle); split.appendChild(bottom);
    viewer.appendChild(split);
    renderPane(0, top, true);
    renderPane(1, bottom, true);
    for (const [i, pn] of [[0, top], [1, bottom]]) {
      pn.addEventListener('pointerdown', () => { if (state.active !== i) { state.active = i; top.classList.toggle('active', i === 0); bottom.classList.toggle('active', i === 1); } }, { capture: true });
    }
    attachSplitDrag(split, handle);
  }

  function renderPane(i, container, withBar) {
    const pn = state.panes[i];
    const m = state.prepared.get(pn.idx);
    if (withBar) {
      const bar = el('div', 'pane-bar');
      const nameBtn = el('button', 'pname');
      nameBtn.appendChild(el('span', 'tag', i === 0 ? '上' : '下'));
      nameBtn.appendChild(el('span', null, m ? m.sheet.name : 'シートを選択'));
      nameBtn.appendChild(svgUse('i-chev'));
      nameBtn.addEventListener('click', () => { state.active = i; openDrawer(); });
      bar.appendChild(nameBtn);
      if (m) {
        const pv = el('div', 'pviews');
        for (const v of availableViews(m)) {
          const b = el('button');
          b.title = VIEW_LABELS[v][0];
          b.appendChild(svgUse(VIEW_LABELS[v][1]));
          b.classList.toggle('on', v === pn.view);
          b.addEventListener('click', () => { state.active = i; pn.view = v; state.views[m.sheet.name] = v; savePrefs(); render(); });
          pv.appendChild(b);
        }
        bar.appendChild(pv);
      }
      const cnt = el('span', 'pcount');
      bar.appendChild(cnt);
      container.appendChild(bar);
      container._countEl = cnt;
    }
    const body = el('div', 'pane-body');
    body._countEl = container._countEl || null;
    container.appendChild(body);
    if (!m) {
      const em = el('div', 'pane-empty');
      em.appendChild(el('div', null, 'このペインに表示するシートを選んでください'));
      const b = el('button', null, 'シートを選択');
      b.addEventListener('click', () => { state.active = i; openDrawer(); });
      em.appendChild(b);
      body.appendChild(em);
      return;
    }
    if (pn.view === 'daily') renderDaily(m, body);
    else if (pn.view === 'cards') renderCards(m, body);
    else if (pn.view === 'grid' && m.schedule) renderScheduleGrid(m, body);
    else renderGrid(m, body);
  }

  function setCount(container, text) {
    const target = container && container._countEl ? container._countEl : $('count');
    target.textContent = text;
  }

  function attachSplitDrag(split, handle) {
    let dragging = false;
    const move = (y) => {
      const r = split.getBoundingClientRect();
      const ratio = Math.max(0.18, Math.min(0.82, (y - r.top - handle.offsetHeight / 2) / (r.height - handle.offsetHeight)));
      state.splitRatio = Math.round(ratio * 1000) / 1000;
      split.style.setProperty('--ratio', state.splitRatio);
    };
    handle.addEventListener('pointerdown', (e) => { dragging = true; handle.classList.add('drag'); handle.setPointerCapture(e.pointerId); e.preventDefault(); });
    handle.addEventListener('pointermove', (e) => { if (dragging) move(e.clientY); });
    const end = () => { if (!dragging) return; dragging = false; handle.classList.remove('drag'); savePrefs(); for (const t of split.querySelectorAll('table.grid')) stickyOffsets(t); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  async function setSplit(on) {
    if (on === state.split) return;
    state.split = on;
    if (on) {
      state.active = 0;
      if (state.panes[1].idx < 0 || state.panes[1].idx === state.panes[0].idx) {
        const targets = targetSheets();
        const m0 = state.prepared.get(state.panes[0].idx);
        let cand = null;
        if (m0 && !m0.schedule) cand = targets.find((t) => { const mm = state.prepared.get(t.index); return t.name === START_SHEET || (mm && mm.schedule); }) || null;
        if (!cand) cand = targets.find((t) => t.index !== state.panes[0].idx) || null;
        if (cand) await selectSheet(cand.index, false, 1);
      }
    } else {
      state.active = 0;
    }
    savePrefs();
    render();
  }

  // ---------------------------------------------------------------- search helpers
  function matches(text) {
    if (!state.query) return true;
    return text.toLowerCase().indexOf(state.query) >= 0;
  }
  function rowMatches(m, r) {
    if (!state.query) return true;
    const row = m.sheet.cells[r];
    if (!row) return false;
    for (let c = 1; c < row.length; c++) {
      const cl = row[c];
      if (!cl || cl.v === null || cl.v === undefined) continue;
      if (matches(m.text(cl))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- column visibility
  function shownAttrCols(m) {
    const cfg = m.gridConfig;
    if (!cfg) return null;
    const saved = state.colVis[m.sheet.name];
    const shown = new Set(cfg.keyCols);
    if (Array.isArray(saved)) {
      for (const h of cfg.attr) if (saved.includes(h.text)) shown.add(h.c);
    } else {
      for (const c of cfg.defaultShown) shown.add(c);
    }
    return shown;
  }
  function setAttrColShown(m, c, on) {
    const cfg = m.gridConfig;
    const shown = shownAttrCols(m);
    if (on) shown.add(c); else shown.delete(c);
    state.colVis[m.sheet.name] = cfg.attr.filter((h) => shown.has(h.c) && !cfg.keyCols.includes(h.c)).map((h) => h.text);
    savePrefs();
  }

  // ---------------------------------------------------------------- row filters (L/T window, 区分)
  function addBusinessDays(serial, n) {
    let d = serial;
    let wd = (Math.floor(serial) + 6) % 7; // 0 = Sunday for Excel serials (1900-01-01 = Monday)
    let left = Math.max(0, Math.round(n));
    while (left > 0) {
      d++; wd = (wd + 1) % 7;
      if (wd !== 0 && wd !== 6) left--;
    }
    return d;
  }
  /** Rows (品番 groups) that have no 所要/発注 within 発注L/T×2 business days from today. */
  function ltHiddenRows(m) {
    const cfg = m.gridConfig;
    if (!cfg || !cfg.ltCol || !cfg.keyCols.length) return null;
    const today = todaySerial();
    const key = today + ':' + m.sheet.maxRow;
    if (m._ltCache && m._ltCache.key === key) return m._ltCache;
    const hidden = new Set();
    const keyCol = cfg.keyCols[0];
    const dateCols = cfg.heads.filter((h) => h.serial !== null && h.serial !== undefined && h.c >= cfg.dayCol);
    let groups = 0, hiddenGroups = 0;
    const vis = [];
    for (let r = m.headerRow + 1; r <= m.sheet.maxRow; r++) if (!m.hiddenRow(r) && m.rowHasValue[r]) vis.push(r);
    let i = 0;
    while (i < vis.length) {
      const k = m.text(m.cell(vis[i], keyCol));
      const rows = [];
      while (i < vis.length && m.text(m.cell(vis[i], keyCol)) === k) rows.push(vis[i++]);
      groups++;
      const ltCell = m.cell(rows[0], cfg.ltCol);
      const lt = ltCell && ltCell.t === 'n' ? ltCell.v : parseFloat(m.text(ltCell)) || 0;
      const end = addBusinessDays(today, lt * 2);
      let has = false;
      for (const row of rows) {
        if (cfg.kubunCol) { const kb = m.text(m.cell(row, cfg.kubunCol)); if (!/所要|発注/.test(kb)) continue; }
        const dayCell = m.cell(row, cfg.dayCol);
        if (dayCell && dayCell.t === 'n' && dayCell.v !== null && dayCell.v !== undefined && dayCell.v !== 0) { has = true; break; }
        for (const h of dateCols) {
          if (h.serial < today || h.serial > end) continue;
          const cl = m.cell(row, h.c);
          if (!cl || cl.v === null || cl.v === undefined) continue;
          if (cl.t === 'n' ? cl.v !== 0 : !/^[-－ー—\s]*$/.test(String(cl.v))) { has = true; break; }
        }
        if (has) break;
      }
      if (!has) { hiddenGroups++; for (const row of rows) hidden.add(row); }
    }
    m._ltCache = { key, hidden, groups, hiddenGroups };
    return m._ltCache;
  }
  const BLANK = '\u0000blank';
  function colFilters(m) { return state.colFilters[m.sheet.name] || {}; }
  function setColFilter(m, c, f) {
    const cf = Object.assign({}, colFilters(m));
    if (f) cf[c] = f; else delete cf[c];
    if (Object.keys(cf).length) state.colFilters[m.sheet.name] = cf; else delete state.colFilters[m.sheet.name];
    savePrefs();
  }
  function isBlankCell(cl, text) {
    if (!cl || cl.v === null || cl.v === undefined || text === '') return true;
    if (cl.t === 'n' && cl.v === 0) return true;
    return /^[-－ー—\s]*$/.test(text);
  }
  function cellPasses(m, r, c, f) {
    const cl = m.cell(r, c);
    const text = m.text(cl);
    if (f.nonEmpty && isBlankCell(cl, text)) return false;
    if (f.min != null || f.max != null) {
      const v = cl && cl.t === 'n' ? cl.v : parseFloat(String(text).replace(/,/g, ''));
      if (Number.isNaN(v)) return false;
      if (f.min != null && v < f.min) return false;
      if (f.max != null && v > f.max) return false;
    }
    if (f.values) { const key = text === '' ? BLANK : text; if (!f.values.includes(key)) return false; }
    return true;
  }
  /** Returns a predicate deciding whether a data row passes the active filters, plus stats. */
  function rowFilter(m, skipCol) {
    const cfg = m.gridConfig;
    const lt = cfg && state.opts.ltFilter ? ltHiddenRows(m) : null;
    const cf = colFilters(m);
    const entries = Object.entries(cf).map(([c, f]) => [+c, f]).filter(([c]) => c !== skipCol);
    const pass = (r) => {
      if (lt && lt.hidden.has(r)) return false;
      for (const [c, f] of entries) if (!cellPasses(m, r, c, f)) return false;
      return true;
    };
    return { pass, lt, active: !!(lt && lt.hiddenGroups) || entries.length > 0, nfilters: entries.length };
  }
  function filterSummary(m, c, f) {
    let head = m.text(m.cell(m.headerRow, c)) || XlsxLite.indexToCol(c);
    if (m.gridConfig && c >= m.gridConfig.dayCol) {
      const hh = m.gridConfig.heads[c - 1];
      if (hh && hh.serial != null) { const pd = NumFmt.serialToDate(hh.serial); head = `${pd.M}/${pd.d}`; }
    }
    const parts = [];
    if (f.values) parts.push(`${f.values.length}件`);
    if (f.nonEmpty) parts.push('空白・0除く');
    if (f.min != null && f.max != null) parts.push(`${f.min}〜${f.max}`);
    else if (f.min != null) parts.push(`${f.min}以上`);
    else if (f.max != null) parts.push(`${f.max}以下`);
    return { head, desc: parts.join(' · ') };
  }

  // ---- column filter popup (Excel-like)
  let cfCtx = null;
  function openColFilter(m, c) {
    const hr = m.headerRow;
    const cur = colFilters(m)[c] || null;
    // candidate values: data rows passing the other filters
    const rf = rowFilter(m, c);
    const counts = new Map();
    let numeric = 0, total = 0;
    for (let r = hr + 1; r <= m.sheet.maxRow; r++) {
      if (m.hiddenRow(r) || !m.rowHasValue[r]) continue;
      if (!rf.pass(r)) continue;
      const cl = m.cell(r, c);
      const text = m.text(cl);
      const key = text === '' ? BLANK : text;
      counts.set(key, (counts.get(key) || 0) + 1);
      total++;
      if (cl && cl.t === 'n') numeric++;
    }
    const isNum = total > 0 && numeric / total > 0.6;
    const keys = Array.from(counts.keys()).sort((a, b) => {
      if (a === BLANK) return -1; if (b === BLANK) return 1;
      if (isNum) { const na = parseFloat(a), nb = parseFloat(b); if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb; }
      return a.localeCompare(b, 'ja');
    });
    const head = m.text(m.cell(hr, c)) || XlsxLite.indexToCol(c);
    let title = head;
    if (m.gridConfig && c >= m.gridConfig.dayCol) {
      const hh = m.gridConfig.heads[c - 1];
      if (hh && hh.serial != null) { const pd = NumFmt.serialToDate(hh.serial); title = `${pd.M}/${pd.d}（${['日', '月', '火', '水', '木', '金', '土'][pd.wd]}）`; }
    }
    cfCtx = {
      m, c, keys, counts, isNum,
      sel: new Set(cur && cur.values ? cur.values : keys),
      nonEmpty: !!(cur && cur.nonEmpty),
      min: cur && cur.min != null ? cur.min : '',
      max: cur && cur.max != null ? cur.max : '',
      q: '',
    };
    $('cfTitle').textContent = `${title} のフィルター`;
    $('cfSearch').value = '';
    $('cfRange').hidden = !isNum;
    $('cfMin').value = cfCtx.min; $('cfMax').value = cfCtx.max;
    renderCfList();
    openPanel('cf', 'cfBg');
  }
  function renderCfList() {
    const x = cfCtx;
    if (!x) return;
    $('cfNonEmpty').classList.toggle('on', x.nonEmpty);
    const list = $('cfList');
    list.innerHTML = '';
    const q = x.q;
    const keys = q ? x.keys.filter((k) => k !== BLANK && k.toLowerCase().indexOf(q) >= 0) : x.keys;
    const LIMIT = 400;
    keys.slice(0, LIMIT).forEach((k) => {
      const b = el('button', 'cf-item' + (x.sel.has(k) ? ' on' : '') + (k === BLANK ? ' blank' : ''));
      const box = el('i', 'box'); box.appendChild(svgUse('i-check')); b.appendChild(box);
      b.appendChild(el('span', null, k === BLANK ? '(空白)' : k));
      b.appendChild(el('small', null, String(x.counts.get(k))));
      b.addEventListener('click', () => { if (x.sel.has(k)) x.sel.delete(k); else x.sel.add(k); b.classList.toggle('on'); });
      list.appendChild(b);
    });
    if (!keys.length) list.appendChild(el('div', 'cf-empty', '該当する値がありません'));
    else if (keys.length > LIMIT) list.appendChild(el('div', 'cf-empty', `他 ${keys.length - LIMIT} 件は検索で絞り込んでください`));
  }
  function applyColFilter() {
    const x = cfCtx;
    if (!x) return;
    const min = $('cfMin').value.trim() === '' ? null : parseFloat($('cfMin').value);
    const max = $('cfMax').value.trim() === '' ? null : parseFloat($('cfMax').value);
    const allSelected = x.keys.every((k) => x.sel.has(k));
    const f = { values: allSelected ? null : x.keys.filter((k) => x.sel.has(k)), nonEmpty: x.nonEmpty, min: Number.isNaN(min) ? null : min, max: Number.isNaN(max) ? null : max };
    const active = f.values || f.nonEmpty || f.min != null || f.max != null;
    setColFilter(x.m, x.c, active ? f : null);
    closePanel('cf', 'cfBg');
    render();
  }
  // ---------------------------------------------------------------- grid view
  const measureCtx = document.createElement('canvas').getContext('2d');
  function textWidth(text, bold, px) {
    measureCtx.font = `${bold ? '700' : '400'} ${px}px ${getComputedStyle(document.body).fontFamily}`;
    return measureCtx.measureText(text).width;
  }

  function renderGrid(m, container) {
    const s = m.sheet;
    const cfg = m.gridConfig;
    const scroller = el('div', 'scroller');
    const wrap = el('div', 'gridwrap');
    const table = el('table', 'grid');
    const zoom = state.zooms[s.name] || 1;
    table.style.setProperty('--zoom', zoom);

    // columns
    let cols = [];
    let frozenColSet;
    if (cfg) {
      const shown = shownAttrCols(m);
      for (let c = 1; c < cfg.dayCol; c++) if (shown.has(c) && !m.hiddenCol(c)) cols.push(c);
      for (let c = cfg.dayCol; c <= s.maxCol; c++) {
        if (m.hiddenCol(c)) continue;
        if (state.opts.hideEmptyCols && !m.colHasValue[c]) continue;
        cols.push(c);
      }
      frozenColSet = new Set(cfg.keyCols.concat(cfg.kubunCol && shown.has(cfg.kubunCol) ? [cfg.kubunCol] : []));
    } else {
      for (let c = 1; c <= s.maxCol; c++) {
        if (m.hiddenCol(c)) continue;
        if (state.opts.hideEmptyCols && !m.colHasValue[c]) continue;
        cols.push(c);
      }
      frozenColSet = new Set(cols.filter((c) => c <= s.freeze.x));
    }
    const colPos = new Map(cols.map((c, i) => [c, i]));

    // rows
    const freezeY = cfg ? m.headerRow : Math.min(s.freeze.y, 6);
    let rows = visibleRows(m, state.opts.hideEmptyRows);
    const frozenRows = rows.filter((r) => r <= freezeY);
    const rf = m.headerRow ? rowFilter(m) : null;
    if (rf) rows = rows.filter((r) => r <= freezeY || rf.pass(r));
    if (state.query) rows = rows.filter((r) => r <= freezeY || rowMatches(m, r));
    const bodyRows = rows.filter((r) => r > freezeY);
    const cfActive = m.headerRow ? colFilters(m) : {};
    const showHead = state.opts.showHeaders;
    const baseFontPx = 13 * state.opts.fontScale;
    const today = todaySerial();

    // key columns (品番 / 品名): compact by default (about half of the text width);
    // scrolling further left past the 当日 column expands them to their full width.
    const keyFull = new Map(), keyCompact = new Map();
    if (cfg) {
      for (const c of cfg.keyCols) {
        const cap = /品名/.test(m.text(m.cell(m.headerRow, c))) ? 170 : 150;
        let need = textWidth(m.text(m.cell(m.headerRow, c)), true, baseFontPx);
        let n = 0;
        for (let r = m.headerRow + 1; r <= s.maxRow && n < 300; r++) {
          if (m.hiddenRow(r)) continue;
          const t = m.text(m.cell(r, c));
          if (!t) continue;
          n++;
          need = Math.max(need, textWidth(t, false, baseFontPx));
        }
        const full = Math.min(cap, Math.ceil(need) + 12);
        keyFull.set(c, full);
        keyCompact.set(c, Math.max(40, Math.ceil(full / 2)));
      }
    }
    if (cfg && cfg.kubunCol && !m.hiddenCol(cfg.kubunCol)) { keyFull.set(cfg.kubunCol, 42); keyCompact.set(cfg.kubunCol, 26); }
    const extraD = Array.from(keyFull.keys()).reduce((a, c) => a + keyFull.get(c) - keyCompact.get(c), 0);
    const colWidthPx = (c) => {
      const w = s.cols[c] && s.cols[c].width != null ? s.cols[c].width : s.defaultColWidth;
      let px = Math.round(w * 7.2 + 5);
      if (cfg) {
        if (keyFull.has(c)) px = keyCompact.get(c);
        else if (c === cfg.kubunCol) px = Math.min(px, 40);
        else if (c >= cfg.dayCol) px = Math.min(px, 62);
      }
      return Math.max(18, Math.min(420, px));
    };

    const cg = el('colgroup');
    let totalW = showHead ? 34 : 0;
    if (showHead) { const c0 = el('col'); c0.style.width = '34px'; cg.appendChild(c0); }
    for (const c of cols) {
      const ce = el('col');
      const w = colWidthPx(c);
      totalW += w;
      if (keyFull.has(c)) { table.style.setProperty('--kw' + c, w + 'px'); ce.style.width = `var(--kw${c})`; }
      else ce.style.width = w + 'px';
      cg.appendChild(ce);
    }
    table.appendChild(cg);
    table.style.setProperty('--tw', totalW + 'px');
    table.style.width = totalW + 'px';

    const tbody = el('tbody');
    table.appendChild(tbody);

    if (showHead) {
      const tr = el('tr');
      tr.className = 'frozen-r';
      let fz = 0;
      const th0 = el('th', 'rowhead frozen-r frozen-c', ''); th0.style.left = `var(--fl${fz++})`; tr.appendChild(th0);
      for (const c of cols) { const th = el('th', 'frozen-r' + (frozenColSet.has(c) ? ' frozen-c' : ''), XlsxLite.indexToCol(c)); if (frozenColSet.has(c)) th.style.left = `var(--fl${fz++})`; tr.appendChild(th); }
      tbody.appendChild(tr);
    }

    const renderedRowSet = new Set(rows);
    const skip = new Set();

    function buildRow(r) {
      const tr = el('tr');
      const isFrozen = r <= freezeY;
      if (isFrozen) tr.className = 'frozen-r';
      if (cfg && r === m.headerRow) tr.classList.add('hdr');
      const ht = s.rows[r] && s.rows[r].ht ? s.rows[r].ht : s.defaultRowHeight;
      const hpx = Math.max(20, Math.round(ht * 1.34));
      let fz = 0;
      if (showHead) { const th = el('th', 'rowhead frozen-c' + (isFrozen ? ' frozen-r' : ''), String(r)); th.style.left = 'var(--fl0)'; fz = 1; tr.appendChild(th); }
      const rowCells = s.cells[r] || [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const key = r + ',' + c;
        if (skip.has(key)) continue;
        const cell = rowCells[c];
        const st = m.styleOf(cell);
        const td = el('td');
        td.dataset.r = r; td.dataset.c = c;
        td.style.height = hpx + 'px';
        let colspan = 1, rowspan = 1;
        let mg = m.mergeAnchor.get(key);
        if (!mg && m.covered.has(key)) {
          const owner = s.merges.find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
          if (owner) {
            let firstR = owner.r1; while (firstR <= owner.r2 && !renderedRowSet.has(firstR)) firstR++;
            let firstC = owner.c1; while (firstC <= owner.c2 && !colPos.has(firstC)) firstC++;
            if (firstR === r && firstC === c) mg = owner;
            else continue;
          }
        }
        let content = cell;
        if (mg) {
          content = m.cell(mg.r1, mg.c1) || cell;
          for (let cc = mg.c1; cc <= mg.c2; cc++) if (colPos.has(cc) && cc !== c) colspan++;
          for (let rr = mg.r1; rr <= mg.r2; rr++) if (renderedRowSet.has(rr) && rr !== r) rowspan++;
          for (let rr = mg.r1; rr <= mg.r2; rr++) for (let cc = mg.c1; cc <= mg.c2; cc++) if (rr !== r || cc !== c) skip.add(rr + ',' + cc);
          if (colspan > 1) td.colSpan = colspan;
          if (rowspan > 1) td.rowSpan = rowspan;
        }
        const cst = content ? m.styleOf(content) : st;
        const info = m.info(content);
        let text = info.text;
        // date columns of requirement sheets: keep long fractions short (e.g. 21.3333 → 21.3)
        if (cfg && c >= cfg.dayCol && info.isNumber && content && content.t === 'n' && !Number.isInteger(content.v) && text.length > 6 && /^-?\d+\.\d{3,}$/.test(text)) text = String(Math.round(content.v * 10) / 10);
        const cls = [];
        let dhead = null;
        if (cfg && c >= cfg.dayCol && (r === m.headerRow || r === m.headerRow - 1)) {
          const hh = cfg.heads[c - 1];
          if (hh && hh.serial !== null && hh.serial !== undefined) {
            const pd = NumFmt.serialToDate(hh.serial);
            if (r === m.headerRow - 1) { text = `${pd.M}/${pd.d}`; dhead = 'dh1'; }
            else { text = ['日', '月', '火', '水', '木', '金', '土'][pd.wd]; dhead = 'dh2'; }
            cls.push(dhead);
            if (pd.wd === 6) cls.push('sat');
            if (pd.wd === 0) cls.push('sun');
            if (hh.serial === today) cls.push('today');
          }
        }
        if (text) {
          if (cfg && c === cfg.kubunCol) { td.appendChild(el('span', 'k1', text.charAt(0))); td.appendChild(el('span', 'kf', text)); }
          else if (keyFull.has(c) && r > m.headerRow) td.appendChild(el('span', 'kt', text));
          else td.textContent = text;
        }
        const h = cst.h;
        if (h === 'center' || h === 'centerContinuous') cls.push('ctr');
        else if (h === 'right') cls.push('rgt');
        else if (h === 'left') cls.push('lft');
        else if (info.isNumber || info.isDate) cls.push('num');
        if (cst.wrap && !(cfg && r > m.headerRow)) cls.push('wrap');
        if (cst.rot === 255) cls.push('vert');
        if (cst.font.bold) cls.push('b');
        if (cst.font.italic) cls.push('i');
        if (cst.font.strike) cls.push('strike');
        if (cfg && c === cfg.kubunCol) cls.push('kubun');
        if (cfg && r === m.headerRow && cfg.heads[c - 1] && cfg.heads[c - 1].serial === today) cls.push('today');
        if (m.headerRow && (r === m.headerRow || (cfg && r === m.headerRow - 1 && c >= cfg.dayCol))) {
          cls.push('fh');
          if (cfActive[c]) { cls.push('filt'); const fi = el('i', 'fi'); fi.appendChild(svgUse('i-filter')); td.appendChild(fi); }
        }
        if (state.query && text && matches(text)) cls.push('hit');
        if (cls.length) td.className = cls.join(' ');
        if (cst.font.size && cst.font.size !== 11 && !cfg) td.style.fontSize = (cst.font.size / 11) + 'em';
        if (cst.font.color && !isWhiteish(cst.font.color)) td.style.color = cst.font.color;
        else if (cst.font.color && cst.fill && luminance(cst.fill) < 0.5) td.style.color = cst.font.color;
        if (state.opts.showFills && cst.fill && !(cfg && r === m.headerRow) && !dhead) {
          td.style.background = cst.fill;
          if (luminance(cst.fill) < 0.45 && !cst.font.color) td.style.color = '#fff';
        }
        if (frozenColSet.has(c)) { td.classList.add('frozen-c'); td.style.left = `var(--fl${fz++})`; }
        if (keyFull.has(c) && !(cfg && c === cfg.kubunCol)) { td.classList.add('key'); if (text && textWidth(text, cst.font.bold, baseFontPx) + 10 > keyCompact.get(c)) td.classList.add('cut'); }
        if (isFrozen) td.classList.add('frozen-r');
        // Excel-like spill of text into empty neighbours
        if (text && !mg && !cst.wrap && cst.rot !== 255 && (!h || h === 'general' || h === 'left') && !info.isNumber && !info.isDate && !(cfg && c < cfg.dayCol)) {
          const px = baseFontPx * ((cst.font.size || 11) / 11);
          const need = textWidth(text, cst.font.bold, px) + 12;
          let have = colWidthPx(c);
          let j = i + 1, span = 1;
          while (have < need && j < cols.length) {
            const nc = cols[j];
            if (m.has(r, nc) || m.covered.has(r + ',' + nc) || m.mergeAnchor.has(r + ',' + nc) || frozenColSet.has(nc) !== frozenColSet.has(c)) break;
            const nst = m.styleOf(rowCells[nc]);
            if (state.opts.showFills && nst.fill && nst.fill !== cst.fill) break;
            have += colWidthPx(nc);
            skip.add(r + ',' + nc);
            span++; j++;
          }
          if (span > 1) td.colSpan = span;
        }
        tr.appendChild(td);
      }
      return tr;
    }

    for (const r of frozenRows) tbody.appendChild(buildRow(r));

    let pos = 0;
    const CHUNK = 120;
    const sentinel = el('div');
    sentinel.style.height = '1px';
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { root: scroller, rootMargin: '600px' });
    function more() {
      const end = Math.min(bodyRows.length, pos + CHUNK);
      const frag = document.createDocumentFragment();
      for (; pos < end; pos++) frag.appendChild(buildRow(bodyRows[pos]));
      tbody.appendChild(frag);
      if (pos >= bodyRows.length) { io.disconnect(); sentinel.remove(); }
    }
    more();

    wrap.appendChild(table);
    wrap.appendChild(sentinel);
    scroller.appendChild(wrap);
    container.appendChild(scroller);
    if (pos < bodyRows.length) io.observe(sentinel);

    setCount(container, (state.query ? `${bodyRows.length}行が該当` : `${bodyRows.length}行`) + (rf && rf.nfilters ? ` · ${rf.nfilters}列で絞り込み` : '') + (rf && rf.lt && rf.lt.hiddenGroups ? ` · ${rf.lt.hiddenGroups}品番を非表示` : ''));
    requestAnimationFrame(() => stickyOffsets(table));

    if (cfg && extraD > 0) {
      // over-scroll zone on the left: key columns grow from compact to full width
      const zoomOf = () => parseFloat(table.style.getPropertyValue('--zoom')) || 1;
      let lastSl = -1;
      const apply = () => {
        const z = zoomOf();
        const D = extraD * z;
        const sl = scroller.scrollLeft;
        if (sl === lastSl) return;
        lastSl = sl;
        const t = Math.max(0, Math.min(1, 1 - sl / D));
        wrap.style.setProperty('--sp', Math.min(sl, D) + 'px');
        let tw = totalW;
        for (const c of keyFull.keys()) {
          const w = Math.round(keyCompact.get(c) + (keyFull.get(c) - keyCompact.get(c)) * t);
          tw += w - keyCompact.get(c);
          table.style.setProperty('--kw' + c, w + 'px');
        }
        table.style.width = tw + 'px';
        table.classList.toggle('expanded', t > 0.98);
        table.classList.toggle('kfull', t > 0.5);
        stickyOffsets(table, true);
      };
      scroller.addEventListener('scroll', () => requestAnimationFrame(apply), { passive: true });
      requestAnimationFrame(() => {
        const D = extraD * zoomOf();
        wrap.style.setProperty('--sp', D + 'px');
        scroller.scrollLeft = D;
        apply();
      });
    }

    table.addEventListener('click', (ev) => {
      const td = ev.target.closest('td');
      if (!td || !td.dataset.r) return;
      const r = +td.dataset.r, c = +td.dataset.c;
      if (td.classList.contains('fh')) { hideCellInfo(); openColFilter(m, c); return; }
      const key = r + ',' + c;
      const mg = m.mergeAnchor.get(key) || s.merges.find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
      const cell = mg ? m.cell(mg.r1, mg.c1) : m.cell(r, c);
      const text = m.text(cell);
      if (!text) { hideCellInfo(); return; }
      let label = `${XlsxLite.indexToCol(c)}${r}`;
      if (cfg && r > m.headerRow) {
        const head = m.text(m.cell(m.headerRow, c));
        const name = cfg.keyCols.map((k) => m.text(m.cell(r, k))).filter(Boolean).join(' ');
        const kb = cfg.kubunCol ? m.text(m.cell(r, cfg.kubunCol)) : '';
        label = [name, kb, head].filter(Boolean).join(' · ') + `（${label}）`;
      }
      showCellInfo(label, text);
    });
    attachPinch(scroller, table, s.name);
  }

  function stickyOffsets(table, quick) {
    const zoom = parseFloat(table.style.getPropertyValue('--zoom')) || 1;
    if (!quick) {
      let top = 0;
      for (const tr of table.querySelectorAll('tr.frozen-r')) {
        for (const cell of tr.children) cell.style.top = top + 'px';
        top += tr.getBoundingClientRect().height / zoom;
      }
    }
    const first = table.querySelector('tr');
    if (!first) return;
    // frozen column lefts from the colgroup (resolves CSS variables without measuring cells)
    const colEls = Array.from(table.querySelectorAll('colgroup col'));
    let left = 0, i = 0;
    for (const cell of first.children) {
      if (!cell.classList.contains('frozen-c')) break;
      table.style.setProperty('--fl' + i, left + 'px');
      const ce = colEls[i];
      left += ce ? parseFloat(getComputedStyle(ce).width) || 0 : cell.getBoundingClientRect().width / zoom;
      i++;
    }
  }

  function attachPinch(scroller, table, sheetName) {
    let startDist = 0, startZoom = 1, pinching = false;
    const getZoom = () => parseFloat(table.style.getPropertyValue('--zoom')) || 1;
    const setZoom = (z) => {
      z = Math.max(0.45, Math.min(2.6, z));
      table.style.setProperty('--zoom', z.toFixed(3));
      state.zooms[sheetName] = z;
    };
    scroller.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinching = true;
        startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        startZoom = getZoom();
      }
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      setZoom(startZoom * (d / startDist));
    }, { passive: false });
    scroller.addEventListener('touchend', () => { if (pinching) { pinching = false; stickyOffsets(table); } });
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(getZoom() * (e.deltaY < 0 ? 1.08 : 0.92));
      stickyOffsets(table);
    }, { passive: false });
  }

  // ---------------------------------------------------------------- cards view
  function renderCards(m, container) {
    const s = m.sheet;
    const scroller = el('div', 'scroller');
    const list = el('div', 'cards');
    const hr = m.headerRow;
    const cols = [];
    for (let c = 1; c <= s.maxCol; c++) if (!m.hiddenCol(c)) cols.push(c);
    const heads = cols.map((c) => {
      const cell = m.cell(hr, c);
      const text = m.text(cell);
      return { c, text: text || XlsxLite.indexToCol(c), hasHead: !!text, isDate: m.isDateCell(cell), serial: m.serialOf(cell) };
    });
    const dateCols = heads.filter((h) => h.isDate);
    const useSeries = dateCols.length >= 4;
    const seriesSet = new Set(useSeries ? dateCols.map((h) => h.c) : []);
    const tc = pickTitleCols(m, heads, hr);

    const metaRows = [];
    for (let r = 1; r < hr; r++) {
      if (m.hiddenRow(r) || !m.rowHasValue[r]) continue;
      const parts = [];
      for (const c of cols) {
        const cl = m.cell(r, c);
        if (!cl || cl.v === null || cl.v === undefined) continue;
        parts.push({ text: m.text(cl), isStr: cl.t === 's' });
      }
      if (!parts.some((p) => p.isStr)) continue;
      metaRows.push(parts);
    }
    if (metaRows.length) {
      const box = el('div', 'meta');
      for (const parts of metaRows) {
        if (parts.length === 1) { box.appendChild(el('h2', null, parts[0].text)); continue; }
        const kv = el('div', 'kv');
        for (let i = 0; i < parts.length; i++) {
          const sp = el('span');
          if (parts[i].isStr && i + 1 < parts.length && !(parts[i + 1].isStr && i + 2 < parts.length && !parts[i + 2].isStr)) {
            sp.appendChild(document.createTextNode(parts[i].text + ' '));
            sp.appendChild(el('b', null, parts[i + 1].text));
            i++;
          } else sp.appendChild(el('b', null, parts[i].text));
          kv.appendChild(sp);
        }
        box.appendChild(kv);
      }
      list.appendChild(box);
    }

    const rf = m.headerRow ? rowFilter(m) : null;
    const entries = [];
    for (let r = hr + 1; r <= s.maxRow; r++) {
      if (m.hiddenRow(r) || !m.rowHasValue[r]) continue;
      if (rf && !rf.pass(r)) continue;
      const key = tc.title ? m.text(m.cell(r, tc.title)) + '|' + (tc.sub ? m.text(m.cell(r, tc.sub)) : '') : null;
      const last = entries[entries.length - 1];
      if (useSeries && tc.badge && key && last && last.key === key && last.rows.length < 6) { last.rows.push(r); continue; }
      entries.push({ key, rows: [r], seq: entries.length + 1 });
    }
    const shown = state.query ? entries.filter((e) => e.rows.some((r) => rowMatches(m, r))) : entries;
    setCount(container, (state.query ? `${shown.length}件が該当` : `${shown.length}件`) + (rf && rf.nfilters ? ` · ${rf.nfilters}列で絞り込み` : '') + (rf && rf.lt && rf.lt.hiddenGroups ? ` · ${rf.lt.hiddenGroups}品番を非表示` : ''));
    if (!shown.length) list.appendChild(el('div', 'emptystate', state.query ? '該当するデータがありません' : 'データがありません'));

    let pos = 0;
    const CHUNK = 40;
    const sentinel = el('div');
    sentinel.style.height = '1px';
    const io = new IntersectionObserver((en) => { if (en.some((e) => e.isIntersecting)) more(); }, { root: scroller, rootMargin: '800px' });
    function more() {
      const end = Math.min(shown.length, pos + CHUNK);
      const frag = document.createDocumentFragment();
      for (; pos < end; pos++) frag.appendChild(buildCard(m, shown[pos], heads, tc, seriesSet));
      list.appendChild(frag);
      if (pos >= shown.length) { io.disconnect(); sentinel.remove(); }
    }
    more();
    list.appendChild(sentinel);
    scroller.appendChild(list);
    container.appendChild(scroller);
    if (pos < shown.length) io.observe(sentinel);
  }

  function pickTitleCols(m, heads, hr) {
    const textRatio = (c) => {
      let str = 0, n = 0;
      for (let r = hr + 1; r <= Math.min(hr + 40, m.sheet.maxRow); r++) { const cl = m.cell(r, c); if (cl && cl.v != null) { n++; if (cl.t === 's') str++; } }
      return n ? str / n : 0;
    };
    const idx = (heads.find((h) => /^(#|No\.?|№|NO|連番|番号)$/i.test(h.text)) || {}).c;
    let badge = (heads.find((h) => /^(区分|種別|状態|ステータス)$/.test(h.text)) || heads.find((h) => /区分|種別|状態|ステータス/.test(h.text)) || {}).c;
    if (badge && textRatio(badge) < 0.5) badge = undefined;
    let title = (heads.find((h) => /品番/.test(h.text)) || heads.find((h) => /品名|名称/.test(h.text)) || {}).c;
    if (!title) for (const h of heads.slice(0, 6)) { if (h.c !== idx && h.c !== badge && textRatio(h.c) > 0.7) { title = h.c; break; } }
    let sub = (heads.find((h) => h.c !== title && /品名|名称|手配先名|担当者名|内容/.test(h.text)) || {}).c;
    if (!sub) { const cand = heads.find((h) => h.c !== title && h.c !== badge && h.c !== idx && h.hasHead && textRatio(h.c) > 0.7); if (cand) sub = cand.c; }
    return { idx, title, sub, badge };
  }

  function valueOf(m, r, c) { return c ? m.text(m.cell(r, c)) : ''; }

  function buildCard(m, entry, heads, tc, seriesSet) {
    const r0 = entry.rows[0];
    {
      let n = 0, only = null;
      for (const h of heads) { const cl = m.cell(r0, h.c); if (cl && cl.v != null) { n++; only = cl; } }
      if (entry.rows.length === 1 && n === 1 && only.t === 's') return el('div', 'card notice', m.text(only));
    }
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'idx', valueOf(m, r0, tc.idx) || String(entry.seq)));
    const ttl = el('div', 'ttl');
    const tTitle = valueOf(m, r0, tc.title);
    const tSub = valueOf(m, r0, tc.sub);
    ttl.appendChild(el('b', null, tTitle || tSub || `${r0} 行目`));
    if (tTitle && tSub) ttl.appendChild(el('span', null, tSub));
    head.appendChild(ttl);
    if (entry.rows.length === 1) {
      const bc = tc.badge ? m.cell(r0, tc.badge) : null;
      if (bc && bc.t === 's') head.appendChild(el('span', 'badge', m.text(bc)));
    }
    card.appendChild(head);

    const fields = el('div', 'fields');
    let n = 0;
    const seen = new Map();
    const seriesRows = [];
    entry.rows.forEach((r, ri) => {
      const badgeText = tc.badge ? valueOf(m, r, tc.badge) : '';
      const pts = [];
      for (const h of heads) {
        if (h.c === tc.title || h.c === tc.sub || h.c === tc.idx) continue;
        if (h.c === tc.badge && entry.rows.length > 1) continue;
        const cell = m.cell(r, h.c);
        if (!cell || cell.v === null || cell.v === undefined) continue;
        const info = m.info(cell);
        if (!info.text) continue;
        if (seriesSet.has(h.c)) {
          if (cell.t === 'n' && cell.v === 0) continue;
          if (cell.t === 's' && /^[-－ー—]+$/.test(String(cell.v))) continue;
          pts.push({ label: shortDate(h.serial, h.text), text: info.text, neg: cell.t === 'n' && cell.v < 0 });
          continue;
        }
        const prev = seen.get(h.text);
        if (prev !== undefined && prev === info.text) continue;
        if (prev === undefined) seen.set(h.text, info.text);
        const label = prev !== undefined && badgeText ? `${h.text}（${badgeText}）` : h.text;
        const f = el('div', 'field' + (info.text.length > 16 ? ' wide' : ''));
        f.appendChild(el('div', 'k', label));
        const v = el('div', 'v' + (info.isNumber ? ' num' : '') + (cell.t === 'n' && cell.v < 0 ? ' neg' : ''));
        const st = m.styleOf(cell);
        if (state.opts.showFills && st.fill && luminance(st.fill) < 0.93) { const sw = el('i', 'sw'); sw.style.background = st.fill; v.appendChild(sw); }
        v.appendChild(document.createTextNode(info.text));
        if (state.query && matches(info.text)) v.style.background = '#fff3c4';
        f.appendChild(v);
        fields.appendChild(f);
        n++;
      }
      if (seriesSet.size) seriesRows.push({ label: badgeText || (entry.rows.length > 1 ? `${ri + 1}` : ''), pts });
    });
    card.appendChild(fields);
    if (n > 6) {
      fields.classList.add('collapsed');
      const btn = el('button', 'more', `すべて表示 (${n}項目)`);
      btn.addEventListener('click', () => { fields.classList.remove('collapsed'); btn.remove(); });
      card.appendChild(btn);
    }
    if (seriesRows.length) {
      const wrap = el('div', 'serieswrap');
      for (const sr of seriesRows) {
        const box = el('div', 'series');
        box.appendChild(el('div', 'k', (sr.label ? sr.label + ' · ' : '') + `日別 ${sr.pts.length}件`));
        if (sr.pts.length) {
          const row = el('div', 'row');
          const LIMIT = 24;
          sr.pts.forEach((p, i) => {
            const pt = el('span', 'pt' + (p.neg ? ' neg' : ''));
            if (i >= LIMIT) pt.hidden = true;
            pt.appendChild(el('i', null, p.label));
            pt.appendChild(el('b', null, p.text));
            row.appendChild(pt);
          });
          if (sr.pts.length > LIMIT) {
            const mb = el('button', 'morebtn', `+${sr.pts.length - LIMIT}`);
            mb.addEventListener('click', () => { for (const x of row.querySelectorAll('.pt[hidden]')) x.hidden = false; mb.remove(); });
            row.appendChild(mb);
          }
          box.appendChild(row);
        } else box.appendChild(el('div', 'empty', '値なし'));
        wrap.appendChild(box);
      }
      card.appendChild(wrap);
    }
    return card;
  }

  function shortDate(serial, fallback) {
    if (serial == null) return fallback;
    const p = NumFmt.serialToDate(serial);
    return `${p.M}/${p.d}`;
  }

  // ---------------------------------------------------------------- schedule matrix (出荷日 × ライン)
  function renderScheduleGrid(m, container) {
    const sc = m.schedule;
    const s = m.sheet;
    const blocks = sc.blocks.slice().sort((a, b) => a.serial - b.serial);
    const today = todaySerial();
    const data = blocks.map((b) => ({ block: b, groups: sc.groups.map((g) => collectGroup(m, sc, b, g)) }));
    const scroller = el('div', 'scroller');
    const wrap = el('div', 'gridwrap');
    const table = el('table', 'grid sched');
    const zoom = state.zooms[s.name + ':sched'] || 1;
    table.style.setProperty('--zoom', zoom);
    const LINE_W = 86, DAY_W = 184, MAX_ITEMS = 5;
    const cg = el('colgroup');
    const c0 = el('col'); c0.style.width = LINE_W + 'px'; cg.appendChild(c0);
    for (let i = 0; i < blocks.length; i++) { const ce = el('col'); ce.style.width = DAY_W + 'px'; cg.appendChild(ce); }
    table.appendChild(cg);
    table.style.width = (LINE_W + DAY_W * blocks.length) + 'px';
    const tbody = el('tbody');
    table.appendChild(tbody);

    // header row
    const hr = el('tr', 'frozen-r');
    const corner = el('th', 'corner frozen-r frozen-c', 'ライン');
    corner.style.left = '0px'; corner.style.top = '0px';
    hr.appendChild(corner);
    let todayIdx = -1;
    data.forEach((d, i) => {
      const th = el('th', 'frozen-r');
      th.style.top = '0px';
      const p = NumFmt.serialToDate(d.block.serial);
      const dh = el('div', 'dh' + (p.wd === 6 ? ' sat' : '') + (p.wd === 0 ? ' sun' : '') + (d.block.serial === today ? ' today' : ''));
      dh.appendChild(el('b', null, `${p.M}/${p.d}`));
      dh.appendChild(el('i', null, ['日', '月', '火', '水', '木', '金', '土'][p.wd] + (d.block.serial === today ? ' 今日' : '')));
      const cnt = d.groups.reduce((a, g) => a + g.items.length, 0);
      dh.appendChild(el('small', null, cnt ? `${cnt}件` : '—'));
      th.appendChild(dh);
      hr.appendChild(th);
      if (d.block.serial === today) todayIdx = i;
    });
    tbody.appendChild(hr);

    let shown = 0, total = 0;
    sc.groups.forEach((g, gi) => {
      const cells = data.map((d) => d.groups[gi]);
      const items = cells.map((c) => (state.query ? c.items.filter((it) => it.searchText.indexOf(state.query) >= 0) : c.items));
      const n = items.reduce((a, x) => a + x.length, 0);
      total += cells.reduce((a, c) => a + c.items.length, 0);
      if (state.query && !n && !matches(g.name)) return;
      shown += n;
      const tr = el('tr', n ? '' : 'idle');
      const lc = el('td', 'line-cell frozen-c');
      lc.style.left = '0px';
      lc.appendChild(el('b', null, g.name));
      const extras = cells[0] ? cells[0].extras : [];
      if (extras.length) lc.appendChild(el('span', 'ex', extras.join(' / ')));
      tr.appendChild(lc);
      cells.forEach((c, i) => {
        const td = el('td', 'sc' + (i === todayIdx ? ' today' : ''));
        for (const st of c.status) td.appendChild(el('span', 'st ' + statusClass(st), st));
        if (items[i].length) {
          items[i].forEach((it, k) => {
            const row = el('div', 'si' + (it.qty === null ? ' note' : ''));
            if (it.fill && state.opts.showFills) { row.style.borderLeftColor = it.fill; row.style.background = it.fill + '40'; }
            else row.style.borderLeftColor = 'var(--green-mid)';
            row.appendChild(el('span', 'nm', it.name || '—'));
            for (const t of it.tags) row.appendChild(el('span', 'tg', t));
            if (it.qty !== null) row.appendChild(el('span', 'q', it.qty));
            if (k >= MAX_ITEMS && !state.query) row.hidden = true;
            td.appendChild(row);
          });
          if (items[i].length > MAX_ITEMS && !state.query) {
            const mb = el('button', 'smore', `+${items[i].length - MAX_ITEMS}件を表示`);
            mb.addEventListener('click', (ev) => { ev.stopPropagation(); for (const x of td.querySelectorAll('.si[hidden]')) x.hidden = false; mb.remove(); });
            td.appendChild(mb);
          }
        } else if (!c.status.length) td.appendChild(el('span', 'none', '·'));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    wrap.appendChild(table);
    scroller.appendChild(wrap);
    container.appendChild(scroller);
    setCount(container, state.query ? `${shown}件が該当` : `${blocks.length}日 · ${total}件`);
    // scroll so that today's column is the first visible date column
    if (todayIdx > 0) requestAnimationFrame(() => { scroller.scrollLeft = DAY_W * todayIdx * zoom; });
    table.addEventListener('click', (ev) => {
      const si = ev.target.closest('.si');
      if (!si) return;
      showCellInfo(si.closest('tr').querySelector('.line-cell b').textContent, si.textContent);
    });
    attachPinch(scroller, table, s.name + ':sched');
  }

  // ---------------------------------------------------------------- daily (schedule) view
  function renderDaily(m, container) {
    const sc = m.schedule;
    const s = m.sheet;
    const blocks = sc.blocks.slice().sort((a, b) => a.serial - b.serial);
    const today = todaySerial();
    let sel = state.daySel[s.name];
    if (!blocks.some((b) => b.serial === sel)) {
      sel = (blocks.find((b) => b.serial === today) || blocks.find((b) => b.serial >= today) || blocks[blocks.length - 1]).serial;
    }
    state.daySel[s.name] = sel;
    const data = blocks.map((b) => ({ block: b, groups: sc.groups.map((g) => collectGroup(m, sc, b, g)) }));

    const dates = el('div', 'dates');
    for (const d of data) {
      const p = NumFmt.serialToDate(d.block.serial);
      const btn = el('button', 'date');
      if (p.wd === 6) btn.classList.add('sat');
      if (p.wd === 0) btn.classList.add('sun');
      if (d.block.serial === today) btn.classList.add('today');
      if (d.block.serial === sel) btn.classList.add('on');
      btn.appendChild(el('b', null, `${p.M}/${p.d}`));
      btn.appendChild(el('i', null, ['日', '月', '火', '水', '木', '金', '土'][p.wd] + (d.block.serial === today ? ' 今日' : '')));
      const cnt = d.groups.reduce((a, g) => a + g.items.length, 0);
      btn.appendChild(el('span', 'n', cnt ? `${cnt}件` : '—'));
      btn.addEventListener('click', () => { state.daySel[s.name] = d.block.serial; render(); });
      dates.appendChild(btn);
    }
    container.appendChild(dates);
    requestAnimationFrame(() => { const on = dates.querySelector('.date.on'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' }); });

    const scroller = el('div', 'scroller');
    const list = el('div', 'daily');
    const cur = data.find((d) => d.block.serial === sel);
    const p = NumFmt.serialToDate(sel);
    let shown = 0, total = 0;
    for (const g of cur.groups) {
      const items = state.query ? g.items.filter((it) => it.searchText.indexOf(state.query) >= 0) : g.items;
      total += g.items.length;
      if (state.query && !items.length && !matches(g.name)) continue;
      shown += items.length;
      const card = el('div', 'line' + (items.length ? '' : ' idle'));
      const head = el('div', 'line-head');
      head.appendChild(el('b', null, g.name));
      head.appendChild(el('span', 'cnt', items.length ? `${items.length}件` : ''));
      for (const st of g.status) head.appendChild(el('span', 'st ' + statusClass(st), st));
      card.appendChild(head);
      if (g.extras.length) {
        const ex = el('div', 'extras');
        for (const e of g.extras) ex.appendChild(el('span', null, e));
        card.appendChild(ex);
      }
      if (items.length) {
        const ul = el('div', 'items');
        for (const it of items) ul.appendChild(buildItem(it));
        card.appendChild(ul);
      } else card.appendChild(el('div', 'none', '予定なし'));
      list.appendChild(card);
    }
    if (!list.children.length) list.appendChild(el('div', 'emptystate', '該当するデータがありません'));
    scroller.appendChild(list);
    container.appendChild(scroller);
    setCount(container, state.query ? `${shown}件が該当` : `${p.M}/${p.d} · ${total}件`);
  }

  function statusClass(text) {
    if (/停止|休/.test(text)) return 'stop';
    if (/残業/.test(text)) return 'warn';
    if (/定時/.test(text)) return 'ok';
    return '';
  }

  function collectGroup(m, sc, block, g) {
    const items = [], status = [], extras = [];
    const blockCols = new Set();
    for (const b of sc.allBlocks) for (let c = b.c1; c <= b.c2; c++) blockCols.add(c);
    for (let r = g.r1; r <= g.r2; r++) {
      if (m.hiddenRow(r)) continue;
      const row = m.sheet.cells[r];
      if (!row) continue;
      const cells = [];
      for (let c = block.c1; c <= block.c2; c++) {
        if (m.hiddenCol(c)) continue;
        const cl = row[c];
        if (!cl || cl.v === null || cl.v === undefined) continue;
        cells.push({ c, cl, info: m.info(cl), st: m.styleOf(cl) });
      }
      for (let c = 1; c < row.length; c++) {
        if (c === sc.groupCol || blockCols.has(c) || m.hiddenCol(c)) continue;
        const cl = row[c];
        if (cl && cl.v !== null && cl.v !== undefined) { const t = m.text(cl); if (t && !extras.includes(t)) extras.push(t); }
      }
      if (!cells.length) continue;
      const statusCells = cells.filter((x) => x.c === block.c2 && x.cl.t === 's');
      for (const x of statusCells) if (!status.includes(x.info.text)) status.push(x.info.text);
      const rest = cells.filter((x) => !statusCells.includes(x));
      if (!rest.length) continue;
      const item = { name: '', qty: null, tags: [], fill: null, r };
      for (const x of rest) {
        if (!item.name && x.cl.t === 's') { item.name = x.info.text; item.fill = x.st.fill; continue; }
        if (item.qty === null && x.info.isNumber) { item.qty = x.info.text; if (!item.fill) item.fill = x.st.fill; continue; }
        item.tags.push(x.info.text);
      }
      if (!item.name && item.tags.length) item.name = item.tags.shift();
      item.searchText = (item.name + ' ' + (item.qty || '') + ' ' + item.tags.join(' ')).toLowerCase();
      items.push(item);
    }
    return { name: g.name, items, status, extras };
  }

  function buildItem(it) {
    const d = el('div', 'item' + (it.qty === null ? ' note' : ''));
    if (it.fill && state.opts.showFills) { d.style.borderLeftColor = it.fill; d.style.background = it.fill + '55'; }
    d.appendChild(el('div', 'nm', it.name || '—'));
    for (const t of it.tags) d.appendChild(el('span', 'tg', t));
    if (it.qty !== null) d.appendChild(el('div', 'qty', it.qty));
    return d;
  }

  // ---------------------------------------------------------------- cell info popup
  function showCellInfo(addr, text) {
    $('cellAddr').textContent = addr;
    $('cellVal').textContent = text;
    $('cellinfo').classList.add('show');
  }
  function hideCellInfo() { $('cellinfo').classList.remove('show'); }

  // ---------------------------------------------------------------- bottom panels
  function openPanel(id, bgId) {
    $(bgId).hidden = false; $(id).hidden = false;
    requestAnimationFrame(() => { $(bgId).classList.add('show'); $(id).classList.add('show'); });
  }
  function closePanel(id, bgId) {
    $(bgId).classList.remove('show'); $(id).classList.remove('show');
    setTimeout(() => { $(bgId).hidden = true; $(id).hidden = true; }, 220);
  }
  function syncSettings() {
    for (const sw of document.querySelectorAll('.switch[data-opt]')) sw.classList.toggle('on', !!state.opts[sw.dataset.opt]);
    $('fontVal').textContent = Math.round(state.opts.fontScale * 100) + '%';
  }

  const VIEW_LABELS = { daily: ['日別', 'i-cal'], cards: ['カード', 'i-cards'], grid: ['表', 'i-grid'], raw: ['Excel', 'i-sheet'] };
  function openViewMenu() {
    if (!state.book) return;
    renderViewMenu();
    openPanel('viewMenu', 'viewMenuBg');
  }
  function renderViewMenu() {
    $('splitSw').classList.toggle('on', state.split);
    $('swapPanes').hidden = !state.split;
    const pseg = $('paneSeg');
    pseg.hidden = !state.split;
    pseg.innerHTML = '';
    if (state.split) {
      state.panes.forEach((pn, i) => {
        const mm = state.prepared.get(pn.idx);
        const b = el('button', i === state.active ? 'on' : '');
        b.textContent = `${i === 0 ? '上' : '下'}: ${mm ? mm.sheet.name : '未選択'}`;
        b.addEventListener('click', () => { state.active = i; renderViewMenu(); render(); });
        pseg.appendChild(b);
      });
    }
    $('viewSecLabel').textContent = state.split ? `表示方法（${state.active === 0 ? '上' : '下'}のペイン）` : '表示方法';
    const m = state.prepared.get(state.sheetIdx);
    if (m) { renderViewSeg(m); renderColsList(m); }
    else { $('viewSeg').innerHTML = ''; $('colsHead').hidden = true; $('colsList').hidden = true; $('ltHead').hidden = true; $('filtHead').hidden = true; $('filtList').hidden = true; }
  }
  function renderViewSeg(m) {
    const seg = $('viewSeg');
    seg.innerHTML = '';
    for (const v of availableViews(m)) {
      const b = el('button');
      b.appendChild(svgUse(VIEW_LABELS[v][1]));
      b.appendChild(document.createTextNode(VIEW_LABELS[v][0]));
      b.classList.toggle('on', v === state.view);
      b.addEventListener('click', () => {
        state.view = v;
        state.views[m.sheet.name] = v;
        savePrefs();
        renderViewSeg(m);
        renderColsList(m);
        render();
      });
      seg.appendChild(b);
    }
  }
  function renderFilterPills(m) {
    const cf = m && m.headerRow ? colFilters(m) : {};
    const keys = Object.keys(cf);
    $('filtHead').hidden = !m || !m.headerRow;
    const box = $('filtList');
    box.hidden = !keys.length;
    box.innerHTML = '';
    for (const c of keys) {
      const { head, desc } = filterSummary(m, +c, cf[c]);
      const pill = el('span', 'fp');
      pill.appendChild(el('b', null, head));
      pill.appendChild(document.createTextNode(desc));
      const x = el('button', 'x'); x.appendChild(svgUse('i-x'));
      x.addEventListener('click', () => { setColFilter(m, +c, null); renderViewMenu(); render(); });
      pill.appendChild(x);
      box.appendChild(pill);
    }
    if (!keys.length && m && m.headerRow) box.hidden = false, box.appendChild(el('span', 'psub', 'フィルターなし'));
  }
  function renderColsList(m) {
    renderFilterPills(m);
    const cfg = m.gridConfig;
    const list = $('colsList');
    const ltShow = !!(cfg && cfg.ltCol) && (state.view === 'grid' || state.view === 'cards');
    $('ltHead').hidden = !ltShow;
    if (ltShow) {
      $('ltSw').classList.toggle('on', !!state.opts.ltFilter);
      const info = ltHiddenRows(m);
      $('ltDesc').textContent = `発注L/T×2（営業日）以内に所要・発注がない品番を隠す` + (info ? `（${info.hiddenGroups}/${info.groups}品番）` : '');
    }
    const show = !!cfg && state.view === 'grid';
    $('colsHead').hidden = !show;
    list.hidden = !show;
    if (!show) return;
    list.innerHTML = '';
    const shown = shownAttrCols(m);
    for (const h of cfg.attr) {
      const locked = cfg.keyCols.includes(h.c);
      const b = el('button', 'colitem' + (shown.has(h.c) ? ' on' : '') + (locked ? ' locked' : ''));
      const box = el('i', 'box'); box.appendChild(svgUse('i-check')); b.appendChild(box);
      b.appendChild(el('span', null, h.text));
      if (locked || h.c === cfg.kubunCol) { const lk = el('em', 'lk'); lk.appendChild(svgUse('i-lock')); lk.appendChild(document.createTextNode('固定')); b.appendChild(lk); }
      b.appendChild(el('small', null, XlsxLite.indexToCol(h.c)));
      if (!locked) b.addEventListener('click', () => { setAttrColShown(m, h.c, !b.classList.contains('on')); b.classList.toggle('on'); render(); });
      list.appendChild(b);
    }
    const dayHead = el('div', 'colitem locked');
    const box = el('i', 'box'); box.appendChild(svgUse('i-check')); dayHead.classList.add('on'); dayHead.appendChild(box);
    dayHead.appendChild(el('span', null, `${m.text(m.cell(m.headerRow, cfg.dayCol)) || '当日'} 以降の日付列（常に表示・横スクロール）`));
    list.appendChild(dayHead);
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $('pickBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; openFile(f); });
    $('recentBtn').addEventListener('click', openRecent);

    // drawer
    $('btnMenu').addEventListener('click', openDrawer);
    $('drawerBg').addEventListener('click', closeDrawer);
    $('drawerLoad').addEventListener('click', () => { closeDrawer(); showHome(); });
    $('drawerSettings').addEventListener('click', () => { closeDrawer(); syncSettings(); setTimeout(() => openPanel('panel', 'panelBg'), 120); });
    $('drawerAbout').addEventListener('click', () => {
      closeDrawer();
      $('aboutVer').textContent = APP_VERSION;
      $('aboutDate').textContent = APP_DATE;
      $('aboutFile').textContent = state.fileMeta ? `${state.fileMeta.name}（${fmtBytes(state.fileMeta.size)}）` : '—';
      setTimeout(() => openPanel('about', 'aboutBg'), 120);
    });
    $('aboutBg').addEventListener('click', () => closePanel('about', 'aboutBg'));
    $('aboutClose').addEventListener('click', () => closePanel('about', 'aboutBg'));

    // settings
    $('panelBg').addEventListener('click', () => closePanel('panel', 'panelBg'));
    $('panelClose').addEventListener('click', () => closePanel('panel', 'panelBg'));
    $('clearCache').addEventListener('click', async () => {
      try { await idbDel('last'); toast('保存したファイルを削除しました'); refreshRecentButton(); } catch (e) { toast('削除できませんでした', true); }
      closePanel('panel', 'panelBg');
    });
    for (const sw of document.querySelectorAll('.switch[data-opt]')) {
      sw.addEventListener('click', () => {
        const k = sw.dataset.opt;
        state.opts[k] = !state.opts[k];
        savePrefs();
        syncSettings();
        if (state.book && $('home').hidden) render();
      });
    }
    const stepFont = (d) => {
      state.opts.fontScale = Math.max(0.7, Math.min(1.8, Math.round((state.opts.fontScale + d) * 10) / 10));
      savePrefs(); syncSettings(); if (state.book && $('home').hidden) render();
    };
    $('fontMinus').addEventListener('click', () => stepFont(-0.1));
    $('fontPlus').addEventListener('click', () => stepFont(0.1));

    // view menu (FAB)
    $('fab').addEventListener('click', openViewMenu);
    $('viewMenuBg').addEventListener('click', () => closePanel('viewMenu', 'viewMenuBg'));
    $('viewMenuClose').addEventListener('click', () => closePanel('viewMenu', 'viewMenuBg'));
    $('cfBg').addEventListener('click', () => closePanel('cf', 'cfBg'));
    $('cfClose').addEventListener('click', () => closePanel('cf', 'cfBg'));
    $('cfApply').addEventListener('click', applyColFilter);
    $('cfReset').addEventListener('click', () => { if (cfCtx) { setColFilter(cfCtx.m, cfCtx.c, null); closePanel('cf', 'cfBg'); render(); } });
    $('cfAll').addEventListener('click', () => { if (!cfCtx) return; const q = cfCtx.q; for (const k of cfCtx.keys) if (!q || (k !== BLANK && k.toLowerCase().indexOf(q) >= 0)) cfCtx.sel.add(k); renderCfList(); });
    $('cfNone').addEventListener('click', () => { if (!cfCtx) return; const q = cfCtx.q; for (const k of cfCtx.keys) if (!q || (k !== BLANK && k.toLowerCase().indexOf(q) >= 0)) cfCtx.sel.delete(k); renderCfList(); });
    $('cfNonEmpty').addEventListener('click', () => { if (!cfCtx) return; cfCtx.nonEmpty = !cfCtx.nonEmpty; renderCfList(); });
    let cfTimer = null;
    $('cfSearch').addEventListener('input', (e) => { clearTimeout(cfTimer); cfTimer = setTimeout(() => { if (cfCtx) { cfCtx.q = e.target.value.trim().toLowerCase(); renderCfList(); } }, 200); });
    $('filtClear').addEventListener('click', () => { const m = state.prepared.get(state.sheetIdx); if (!m) return; delete state.colFilters[m.sheet.name]; savePrefs(); renderViewMenu(); render(); });
    $('ltSw').addEventListener('click', () => { state.opts.ltFilter = !state.opts.ltFilter; savePrefs(); renderViewMenu(); render(); });
    $('splitSw').addEventListener('click', async () => { await setSplit(!state.split); renderViewMenu(); });
    $('swapPanes').addEventListener('click', () => {
      state.panes.reverse();
      state.active = 1 - state.active;
      savePrefs(); renderViewMenu(); render();
    });
    $('colsReset').addEventListener('click', () => {
      const m = state.prepared.get(state.sheetIdx);
      if (!m) return;
      delete state.colVis[m.sheet.name];
      savePrefs();
      renderColsList(m);
      render();
    });
    let searchTimer = null;
    $('searchInput').addEventListener('input', (e) => {
      const v = e.target.value.trim().toLowerCase();
      $('searchBox').classList.toggle('has', !!v);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = v; $('fabDot').hidden = !v; render(); }, 250);
    });
    $('searchClear').addEventListener('click', () => { $('searchInput').value = ''; $('searchBox').classList.remove('has'); state.query = ''; $('fabDot').hidden = true; render(); });
    $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); closePanel('viewMenu', 'viewMenuBg'); } });

    document.addEventListener('click', (e) => { if (!e.target.closest('.grid') && !e.target.closest('.cellinfo')) hideCellInfo(); });

    const home = $('home');
    ['dragenter', 'dragover'].forEach((t) => home.addEventListener(t, (e) => { e.preventDefault(); home.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => home.addEventListener(t, (e) => { e.preventDefault(); home.classList.remove('drag'); }));
    home.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });

    window.addEventListener('resize', () => { const t = document.querySelector('table.grid'); if (t) stickyOffsets(t); });
  }

  function renderTargetChips() {
    const box = $('targetChips');
    box.innerHTML = '';
    box.appendChild(el('span', 'chip', START_SHEET));
    box.appendChild(el('span', 'chip muted', `${BOUNDARY_SHEET} より右`));
    for (const n of ['ハコ_直近', 'ハコ', 'パット_直近', '各業者…']) box.appendChild(el('span', 'chip', n));
  }

  async function init() {
    loadPrefs();
    bind();
    renderTargetChips();
    syncSettings();
    $('drawerVer').textContent = 'Ver ' + APP_VERSION;
    document.documentElement.style.setProperty('--scale', state.opts.fontScale);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    if ('launchQueue' in window && window.launchQueue.setConsumer) {
      window.launchQueue.setConsumer(async (params) => {
        if (params.files && params.files.length) openFile(await params.files[0].getFile());
      });
    }
    showHome();
    const rec = await refreshRecentButton();
    if (rec && state.opts.autoOpen) openRecent();
  }

  window.OrderViewer = { state, openFile, version: APP_VERSION, debug: { ltHiddenRows, addBusinessDays, todaySerial } };
  init();
})();
