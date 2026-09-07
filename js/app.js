/* 発注ビューア — app.js */
(function () {
  'use strict';

  const START_SHEET = '直近';
  const END_SHEET = '所要(調整)'; // exclusive
  const LS_KEY = 'orderviewer:v1';
  const DB_NAME = 'orderviewer';
  const DB_STORE = 'files';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  // ---------------------------------------------------------------- state
  const defaults = {
    hideEmptyRows: true, hideEmptyCols: true, showHeaders: false, showFills: true,
    allSheets: false, autoOpen: true, fontScale: 1,
  };
  const state = {
    opts: Object.assign({}, defaults),
    book: null,
    fileMeta: null,
    sheetIdx: -1,
    view: 'grid',
    query: '',
    views: {},   // sheetName -> view
    zooms: {},   // sheetName -> zoom
    daySel: {},  // sheetName -> selected date serial
    prepared: new Map(), // sheetIndex -> prepared model
  };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        Object.assign(state.opts, p.opts || {});
        state.views = p.views || {};
        state.lastSheet = p.lastSheet || null;
      }
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ opts: state.opts, views: state.views, lastSheet: state.lastSheet }));
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

  // ---------------------------------------------------------------- target sheets
  function targetRange(names) {
    let start = names.indexOf(START_SHEET);
    let end = names.indexOf(END_SHEET);
    if (start < 0) start = 0;
    if (end < 0 || end <= start) end = names.length;
    return { start, end };
  }
  function isTarget(idx, names) {
    const r = targetRange(names);
    return idx >= r.start && idx < r.end;
  }

  // ---------------------------------------------------------------- cell model helpers
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
    m.text = (cell) => {
      if (!cell) return '';
      if (cell._f === undefined) cell._f = NumFmt.formatCell(cell, m.styleOf(cell).code);
      return cell._f.text;
    };
    m.info = (cell) => {
      if (!cell) return { text: '', isDate: false, isNumber: false };
      if (cell._f === undefined) cell._f = NumFmt.formatCell(cell, m.styleOf(cell).code);
      return cell._f;
    };
    m.has = (r, c) => { const cl = m.cell(r, c); return !!(cl && cl.v !== null && cl.v !== undefined); };
    m.isDateCell = (cell) => !!cell && ((cell.t === 'n' && m.info(cell).isDate) || cell.t === 'd');
    m.serialOf = (cell) => {
      if (!cell) return null;
      if (cell.t === 'n' && m.info(cell).isDate) return cell.v;
      if (cell.t === 'd') { const d = new Date(cell.v); return Number.isNaN(d.getTime()) ? null : d.getTime() / 86400000 + 25569; }
      return null;
    };

    // merges lookup
    m.mergeAnchor = new Map(); // "r,c" -> merge
    m.covered = new Set();
    for (const mg of sheet.merges) {
      m.mergeAnchor.set(mg.r1 + ',' + mg.c1, mg);
      for (let r = mg.r1; r <= mg.r2; r++) for (let c = mg.c1; c <= mg.c2; c++) if (r !== mg.r1 || c !== mg.c1) m.covered.add(r + ',' + c);
    }

    // rows / cols with values
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

  function visibleCols(m, hideEmpty) {
    const cols = [];
    for (let c = 1; c <= m.sheet.maxCol; c++) {
      if (m.hiddenCol(c)) continue;
      if (hideEmpty && !m.colHasValue[c]) continue;
      cols.push(c);
    }
    return cols;
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

  // ---------------------------------------------------------------- header / schedule detection
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
        // find date cell to the left
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
    // groups from the first visible column
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

  function prepare(sheetIndex) {
    if (state.prepared.has(sheetIndex)) return state.prepared.get(sheetIndex);
    return null;
  }
  async function getModel(sheetIndex) {
    let m = state.prepared.get(sheetIndex);
    if (m) return m;
    const sheet = await state.book.loadSheet(sheetIndex);
    if (!sheet) return null;
    m = makeModel(sheet, state.book.styles);
    m.headerRow = detectHeader(m);
    m.schedule = detectSchedule(m);
    state.prepared.set(sheetIndex, m);
    return m;
  }

  // ---------------------------------------------------------------- file loading
  async function openBuffer(buffer, meta, fromCache) {
    overlay(true, 'ファイルを展開中…', 3);
    try {
      const book = await XlsxLite.openWorkbook(buffer, (msg, pct) => overlay(true, msg, pct));
      state.book = book;
      state.prepared.clear();
      state.fileMeta = meta;
      const names = book.allSheetNames;
      const targets = book.sheets.filter((s) => s.state === 'visible' && isTarget(s.index, names));
      if (!targets.length) throw new Error('表示対象のシートが見つかりませんでした。');
      for (let i = 0; i < targets.length; i++) {
        overlay(true, `シート「${targets[i].name}」を読み込み中…`, 15 + Math.round((i / targets.length) * 80));
        await new Promise((r) => setTimeout(r, 0));
        await getModel(targets[i].index);
      }
      if (!fromCache) {
        try { await idbPut('last', Object.assign({ buffer }, meta)); } catch (e) { console.warn('cache failed', e); }
      }
      overlay(true, '表示を準備中…', 97);
      await new Promise((r) => setTimeout(r, 0));
      showViewer();
      const first = (state.lastSheet && targets.find((t) => t.name === state.lastSheet)) || targets[0];
      await selectSheet(first.index);
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
    $('appbar').hidden = true;
    document.querySelector('meta[name=theme-color]').setAttribute('content', '#f3f5f9');
    refreshRecentButton();
  }
  function showViewer() {
    $('home').hidden = true;
    $('viewer').hidden = false;
    $('appbar').hidden = false;
    document.querySelector('meta[name=theme-color]').setAttribute('content', '#ffffff');
    renderTabs();
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.innerHTML = '';
    const names = state.book.allSheetNames;
    for (const s of state.book.sheets) {
      if (s.state !== 'visible') continue;
      const target = isTarget(s.index, names);
      if (!target && !state.opts.allSheets) continue;
      const b = el('button', 'tab' + (target ? '' : ' other'));
      const dot = el('span', 'dot');
      const model = state.prepared.get(s.index);
      const color = model && model.sheet.tabColor;
      if (color) dot.style.background = color;
      b.appendChild(dot);
      b.appendChild(document.createTextNode(s.name));
      b.dataset.idx = s.index;
      if (s.index === state.sheetIdx) b.classList.add('on');
      b.addEventListener('click', () => selectSheet(s.index));
      tabs.appendChild(b);
    }
    const on = tabs.querySelector('.tab.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  async function selectSheet(idx) {
    let m = state.prepared.get(idx);
    if (!m) {
      overlay(true, `シート「${state.book.sheets[idx].name}」を読み込み中…`, 40);
      await new Promise((r) => setTimeout(r, 0));
      try { m = await getModel(idx); } finally { overlay(false); }
      if (!m) { toast('シートを読み込めませんでした', true); return; }
    }
    state.sheetIdx = idx;
    state.lastSheet = m.sheet.name;
    savePrefs();
    $('ttlSheet').textContent = m.sheet.name;
    $('ttlFile').textContent = state.fileMeta ? `${state.fileMeta.name} · ${fmtDateTime(state.fileMeta.savedAt)}` : '';
    // view selection
    const available = availableViews(m);
    let v = state.views[m.sheet.name];
    if (!available.includes(v)) v = defaultView(m, available);
    state.view = v;
    state.query = '';
    $('searchInput').value = '';
    $('searchBox').classList.remove('has');
    renderTabs();
    renderViewSeg(available);
    render();
  }

  function availableViews(m) {
    const v = [];
    if (m.schedule) v.push('daily');
    if (m.headerRow > 0 && m.sheet.maxRow > m.headerRow && !m.schedule) v.push('cards');
    v.push('grid');
    return v;
  }
  function defaultView(m, available) {
    if (available.includes('daily')) return 'daily';
    if (available.includes('cards')) return 'cards';
    return 'grid';
  }
  const VIEW_LABELS = { daily: ['日別', 'i-cal'], cards: ['カード', 'i-cards'], grid: ['表', 'i-grid'] };
  function renderViewSeg(available) {
    const seg = $('viewSeg');
    seg.innerHTML = '';
    for (const v of available) {
      const b = el('button');
      b.innerHTML = `<svg><use href="#${VIEW_LABELS[v][1]}"/></svg>`;
      b.appendChild(document.createTextNode(VIEW_LABELS[v][0]));
      b.classList.toggle('on', v === state.view);
      b.addEventListener('click', () => {
        state.view = v;
        const m = state.prepared.get(state.sheetIdx);
        state.views[m.sheet.name] = v;
        savePrefs();
        renderViewSeg(available);
        render();
      });
      seg.appendChild(b);
    }
  }

  function render() {
    const m = state.prepared.get(state.sheetIdx);
    if (!m) return;
    const viewer = $('viewer');
    viewer.innerHTML = '';
    document.documentElement.style.setProperty('--scale', state.opts.fontScale);
    hideCellInfo();
    if (state.view === 'daily') renderDaily(m, viewer);
    else if (state.view === 'cards') renderCards(m, viewer);
    else renderGrid(m, viewer);
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

  // ---------------------------------------------------------------- grid view
  const measureCtx = document.createElement('canvas').getContext('2d');
  function textWidth(text, bold, px) {
    measureCtx.font = `${bold ? '700' : '400'} ${px}px ${getComputedStyle(document.body).fontFamily}`;
    return measureCtx.measureText(text).width;
  }

  function renderGrid(m, container) {
    const s = m.sheet;
    const scroller = el('div', 'scroller');
    const wrap = el('div', 'gridwrap');
    const table = el('table', 'grid');
    const zoom = state.zooms[s.name] || 1;
    table.style.setProperty('--zoom', zoom);
    const cols = visibleCols(m, state.opts.hideEmptyCols);
    const colPos = new Map(cols.map((c, i) => [c, i]));
    let rows = visibleRows(m, state.opts.hideEmptyRows);
    const frozenRows = rows.filter((r) => r <= s.freeze.y);
    if (state.query) rows = rows.filter((r) => r <= s.freeze.y || rowMatches(m, r));
    const bodyRows = rows.filter((r) => r > s.freeze.y);
    const showHead = state.opts.showHeaders;
    const baseFontPx = 13 * state.opts.fontScale;

    const colWidthPx = (c) => {
      const w = s.cols[c] && s.cols[c].width != null ? s.cols[c].width : s.defaultColWidth;
      return Math.max(18, Math.min(420, Math.round(w * 7.2 + 5)));
    };

    // colgroup (fixed layout needs an explicit table width)
    const cg = el('colgroup');
    let totalW = showHead ? 34 : 0;
    if (showHead) { const c0 = el('col'); c0.style.width = '34px'; cg.appendChild(c0); }
    for (const c of cols) { const ce = el('col'); const w = colWidthPx(c); totalW += w; ce.style.width = w + 'px'; cg.appendChild(ce); }
    table.appendChild(cg);
    table.style.width = totalW + 'px';

    const frozenColSet = new Set(cols.filter((c) => c <= s.freeze.x));
    const tbody = el('tbody');
    table.appendChild(tbody);

    if (showHead) {
      const tr = el('tr');
      tr.className = 'frozen-r';
      const th0 = el('th', 'rowhead frozen-r frozen-c', '');
      tr.appendChild(th0);
      for (const c of cols) {
        const th = el('th', 'frozen-r' + (frozenColSet.has(c) ? ' frozen-c' : ''), XlsxLite.indexToCol(c));
        tr.appendChild(th);
      }
      tbody.appendChild(tr);
    }

    const renderedRowSet = new Set(rows);
    const skip = new Set(); // "r,c" covered cells whose anchor is rendered

    function buildRow(r) {
      const tr = el('tr');
      const isFrozen = r <= s.freeze.y;
      if (isFrozen) tr.className = 'frozen-r';
      const ht = s.rows[r] && s.rows[r].ht ? s.rows[r].ht : s.defaultRowHeight;
      const hpx = Math.max(20, Math.round(ht * 1.34));
      if (showHead) {
        const th = el('th', 'rowhead frozen-c' + (isFrozen ? ' frozen-r' : ''), String(r));
        tr.appendChild(th);
      }
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
          // anchor may be hidden: adopt the merge if we are its first rendered cell
          const owner = s.merges.find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
          if (owner) {
            let firstR = owner.r1; while (firstR <= owner.r2 && !renderedRowSet.has(firstR)) firstR++;
            let firstC = owner.c1; while (firstC <= owner.c2 && !colPos.has(firstC)) firstC++;
            if (firstR === r && firstC === c) mg = owner;
            else continue; // covered by a rendered anchor elsewhere
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
        const text = info.text;
        if (text) td.textContent = text;
        // classes
        const cls = [];
        const h = cst.h;
        if (h === 'center' || h === 'centerContinuous') cls.push('ctr');
        else if (h === 'right') cls.push('rgt');
        else if (h === 'left') cls.push('lft');
        else if (info.isNumber || info.isDate) cls.push('num');
        if (cst.wrap) cls.push('wrap');
        if (cst.rot === 255) cls.push('vert');
        if (cst.font.bold) cls.push('b');
        if (cst.font.italic) cls.push('i');
        if (cst.font.strike) cls.push('strike');
        if (state.query && text && matches(text)) cls.push('hit');
        if (cls.length) td.className = cls.join(' ');
        if (cst.font.size && cst.font.size !== 11) td.style.fontSize = (cst.font.size / 11) + 'em';
        if (cst.font.color && !isWhiteish(cst.font.color)) td.style.color = cst.font.color;
        else if (cst.font.color && cst.fill && luminance(cst.fill) < 0.5) td.style.color = cst.font.color;
        if (state.opts.showFills && cst.fill) {
          td.style.background = cst.fill;
          if (luminance(cst.fill) < 0.45 && !cst.font.color) td.style.color = '#fff';
        }
        if (frozenColSet.has(c)) td.classList.add('frozen-c');
        if (isFrozen) td.classList.add('frozen-r');
        // text spill into empty neighbours (Excel behaviour)
        if (text && !mg && !cst.wrap && cst.rot !== 255 && (!h || h === 'general' || h === 'left') && !info.isNumber && !info.isDate) {
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

    // chunked body rendering
    let pos = 0;
    const CHUNK = 120;
    const sentinel = el('div');
    sentinel.style.height = '1px';
    function more() {
      const end = Math.min(bodyRows.length, pos + CHUNK);
      const frag = document.createDocumentFragment();
      for (; pos < end; pos++) frag.appendChild(buildRow(bodyRows[pos]));
      tbody.appendChild(frag);
      if (pos >= bodyRows.length) { io.disconnect(); sentinel.remove(); }
    }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { root: scroller, rootMargin: '600px' });
    more();

    wrap.appendChild(table);
    wrap.appendChild(sentinel);
    scroller.appendChild(wrap);
    container.appendChild(scroller);
    if (pos < bodyRows.length) io.observe(sentinel);

    $('count').textContent = state.query ? `${bodyRows.length}行が該当` : `${rows.length}行 × ${cols.length}列`;

    // sticky offsets (measure after layout)
    requestAnimationFrame(() => stickyOffsets(table, showHead));

    // cell tap → detail
    table.addEventListener('click', (ev) => {
      const td = ev.target.closest('td');
      if (!td || !td.dataset.r) return;
      const r = +td.dataset.r, c = +td.dataset.c;
      const key = r + ',' + c;
      const mg = m.mergeAnchor.get(key) || s.merges.find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
      const cell = mg ? m.cell(mg.r1, mg.c1) : m.cell(r, c);
      const text = m.text(cell);
      if (!text) { hideCellInfo(); return; }
      showCellInfo(`${XlsxLite.indexToCol(c)}${r}`, text);
    });

    // pinch zoom
    attachPinch(scroller, table, s.name);
  }

  function stickyOffsets(table, showHead) {
    const rows = Array.from(table.querySelectorAll('tr.frozen-r'));
    let top = 0;
    for (const tr of rows) {
      for (const cell of tr.children) cell.style.top = top + 'px';
      top += tr.getBoundingClientRect().height / (parseFloat(table.style.getPropertyValue('--zoom')) || 1);
    }
    // frozen columns: use first body row that contains them
    const first = table.querySelector('tr');
    if (!first) return;
    const zoom = parseFloat(table.style.getPropertyValue('--zoom')) || 1;
    const colLefts = [];
    let left = 0;
    for (const cell of first.children) {
      if (!cell.classList.contains('frozen-c')) break;
      colLefts.push(left);
      left += cell.getBoundingClientRect().width / zoom;
    }
    for (const tr of table.querySelectorAll('tr')) {
      let i = 0;
      for (const cell of tr.children) {
        if (!cell.classList.contains('frozen-c')) break;
        cell.style.left = (colLefts[i] || 0) + 'px';
        i++;
      }
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
    scroller.addEventListener('touchend', () => { if (pinching) { pinching = false; stickyOffsets(table, state.opts.showHeaders); } });
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(getZoom() * (e.deltaY < 0 ? 1.08 : 0.92));
      stickyOffsets(table, state.opts.showHeaders);
    }, { passive: false });
  }

  // ---------------------------------------------------------------- cards view
  function renderCards(m, container) {
    const s = m.sheet;
    const scroller = el('div', 'scroller');
    const list = el('div', 'cards');
    const hr = m.headerRow;
    const cols = visibleCols(m, false);
    const heads = cols.map((c) => {
      const cell = m.cell(hr, c);
      const text = m.text(cell);
      return { c, text: text || XlsxLite.indexToCol(c), hasHead: !!text, isDate: m.isDateCell(cell), serial: m.serialOf(cell) };
    });
    const dateCols = heads.filter((h) => h.isDate);
    const useSeries = dateCols.length >= 4;
    const seriesSet = new Set(useSeries ? dateCols.map((h) => h.c) : []);
    const tc = pickTitleCols(m, heads, hr);

    // meta rows above the header (titles, generated-at, etc.)
    const metaRows = [];
    for (let r = 1; r < hr; r++) {
      if (m.hiddenRow(r) || !m.rowHasValue[r]) continue;
      const parts = [];
      for (const c of cols) {
        const cl = m.cell(r, c);
        if (!cl || cl.v === null || cl.v === undefined) continue;
        parts.push({ text: m.text(cl), isStr: cl.t === 's' });
      }
      if (!parts.some((p) => p.isStr)) continue; // e.g. a row of date labels
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

    // data rows → entries (consecutive rows of the same item are grouped when a series exists)
    const entries = [];
    for (let r = hr + 1; r <= s.maxRow; r++) {
      if (m.hiddenRow(r) || !m.rowHasValue[r]) continue;
      const key = tc.title ? m.text(m.cell(r, tc.title)) + '|' + (tc.sub ? m.text(m.cell(r, tc.sub)) : '') : null;
      const last = entries[entries.length - 1];
      if (useSeries && tc.badge && key && last && last.key === key && last.rows.length < 6) { last.rows.push(r); continue; }
      entries.push({ key, rows: [r], seq: entries.length + 1 });
    }
    const shown = state.query ? entries.filter((e) => e.rows.some((r) => rowMatches(m, r))) : entries;
    $('count').textContent = `${shown.length}件`;
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
    // notice row: a single text cell only
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
    const seen = new Map(); // header -> text
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

  // ---------------------------------------------------------------- daily (schedule) view
  function renderDaily(m, container) {
    const sc = m.schedule;
    const s = m.sheet;
    const blocks = sc.blocks.slice().sort((a, b) => a.serial - b.serial);
    const todaySerial = Math.floor(Date.now() / 86400000 + 25569 + new Date().getTimezoneOffset() / -1440);
    let sel = state.daySel[s.name];
    if (!blocks.some((b) => b.serial === sel)) {
      sel = (blocks.find((b) => b.serial === todaySerial) || blocks.find((b) => b.serial >= todaySerial) || blocks[blocks.length - 1]).serial;
    }
    state.daySel[s.name] = sel;

    // precompute per block/group
    const data = blocks.map((b) => ({ block: b, groups: sc.groups.map((g) => collectGroup(m, sc, b, g)) }));

    const dates = el('div', 'dates');
    for (const d of data) {
      const p = NumFmt.serialToDate(d.block.serial);
      const btn = el('button', 'date');
      if (p.wd === 6) btn.classList.add('sat');
      if (p.wd === 0) btn.classList.add('sun');
      if (d.block.serial === todaySerial) btn.classList.add('today');
      if (d.block.serial === sel) btn.classList.add('on');
      btn.appendChild(el('b', null, `${p.M}/${p.d}`));
      btn.appendChild(el('i', null, ['日', '月', '火', '水', '木', '金', '土'][p.wd] + (d.block.serial === todaySerial ? ' 今日' : '')));
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
      for (const st of g.status) {
        const tag = el('span', 'st ' + statusClass(st));
        tag.textContent = st;
        head.appendChild(tag);
      }
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
    $('count').textContent = state.query ? `${shown}件が該当` : `${p.M}/${p.d} · ${total}件`;
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
      // extras: cells outside any block (and not the group column)
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
      const item = { name: '', qty: null, qtyRaw: null, tags: [], fill: null, r };
      for (const x of rest) {
        if (!item.name && x.cl.t === 's') { item.name = x.info.text; item.fill = x.st.fill; continue; }
        if (item.qty === null && x.info.isNumber) { item.qty = x.info.text; item.qtyRaw = x.cl.v; if (!item.fill) item.fill = x.st.fill; continue; }
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
    if (it.fill && state.opts.showFills) {
      d.style.borderLeftColor = it.fill;
      d.style.background = it.fill + '55';
    }
    const nm = el('div', 'nm');
    nm.appendChild(document.createTextNode(it.name || '—'));
    d.appendChild(nm);
    for (const t of it.tags) d.appendChild(el('span', 'tg', t));
    if (it.qty !== null) {
      const q = el('div', 'qty');
      q.appendChild(document.createTextNode(it.qty));
      d.appendChild(q);
    }
    return d;
  }

  // ---------------------------------------------------------------- cell info popup
  function showCellInfo(addr, text) {
    $('cellAddr').textContent = addr;
    $('cellVal').textContent = text;
    $('cellinfo').classList.add('show');
  }
  function hideCellInfo() { $('cellinfo').classList.remove('show'); }

  // ---------------------------------------------------------------- settings panel
  function openPanel() {
    $('panelBg').hidden = false; $('panel').hidden = false;
    requestAnimationFrame(() => { $('panelBg').classList.add('show'); $('panel').classList.add('show'); });
    syncPanel();
  }
  function closePanel() {
    $('panelBg').classList.remove('show'); $('panel').classList.remove('show');
    setTimeout(() => { $('panelBg').hidden = true; $('panel').hidden = true; }, 220);
  }
  function syncPanel() {
    for (const sw of document.querySelectorAll('.switch[data-opt]')) sw.classList.toggle('on', !!state.opts[sw.dataset.opt]);
    $('fontVal').textContent = Math.round(state.opts.fontScale * 100) + '%';
  }

  // ---------------------------------------------------------------- events
  function bind() {
    $('pickBtn').addEventListener('click', () => $('fileInput').click());
    $('btnOpen').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; openFile(f); });
    $('recentBtn').addEventListener('click', openRecent);
    $('btnHome').addEventListener('click', showHome);
    $('btnSettings').addEventListener('click', openPanel);
    $('panelBg').addEventListener('click', closePanel);
    $('panelClose').addEventListener('click', closePanel);
    $('clearCache').addEventListener('click', async () => {
      try { await idbDel('last'); toast('保存したファイルを削除しました'); refreshRecentButton(); } catch (e) { toast('削除できませんでした', true); }
      closePanel();
    });
    for (const sw of document.querySelectorAll('.switch[data-opt]')) {
      sw.addEventListener('click', () => {
        const k = sw.dataset.opt;
        state.opts[k] = !state.opts[k];
        savePrefs();
        syncPanel();
        if (state.book) { if (k === 'allSheets') renderTabs(); render(); }
      });
    }
    const stepFont = (d) => {
      state.opts.fontScale = Math.max(0.7, Math.min(1.8, Math.round((state.opts.fontScale + d) * 10) / 10));
      savePrefs(); syncPanel(); if (state.book) render();
    };
    $('fontMinus').addEventListener('click', () => stepFont(-0.1));
    $('fontPlus').addEventListener('click', () => stepFont(0.1));

    let searchTimer = null;
    $('searchInput').addEventListener('input', (e) => {
      const v = e.target.value.trim().toLowerCase();
      $('searchBox').classList.toggle('has', !!v);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = v; render(); }, 220);
    });
    $('searchClear').addEventListener('click', () => { $('searchInput').value = ''; $('searchBox').classList.remove('has'); state.query = ''; render(); });
    $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

    document.addEventListener('click', (e) => { if (!e.target.closest('.grid') && !e.target.closest('.cellinfo')) hideCellInfo(); });

    // drag & drop (desktop)
    const home = $('home');
    ['dragenter', 'dragover'].forEach((t) => home.addEventListener(t, (e) => { e.preventDefault(); home.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => home.addEventListener(t, (e) => { e.preventDefault(); home.classList.remove('drag'); }));
    home.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });

    window.addEventListener('resize', () => { const t = document.querySelector('table.grid'); if (t) stickyOffsets(t, state.opts.showHeaders); });
  }

  function renderTargetChips() {
    const box = $('targetChips');
    box.innerHTML = '';
    for (const n of [START_SHEET, '…', END_SHEET]) {
      const c = el('span', 'chip' + (n === END_SHEET || n === '…' ? ' muted' : ''), n === END_SHEET ? `${n} の手前まで` : n);
      box.appendChild(c);
    }
  }

  async function init() {
    loadPrefs();
    bind();
    renderTargetChips();
    syncPanel();
    document.documentElement.style.setProperty('--scale', state.opts.fontScale);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // "open with" a file via launch queue (installed PWA)
    if ('launchQueue' in window && window.launchQueue.setConsumer) {
      window.launchQueue.setConsumer(async (params) => {
        if (params.files && params.files.length) {
          const f = await params.files[0].getFile();
          openFile(f);
        }
      });
    }
    showHome();
    const rec = await refreshRecentButton();
    if (rec && state.opts.autoOpen) openRecent();
  }

  window.OrderViewer = { state, openFile };
  init();
})();
