/*
 * xlsx-lite.js — a small, dependency-light reader for .xlsx / .xlsm files.
 *
 * Reads only what the viewer needs (values, number formats, fills, fonts,
 * alignment, merges, column widths, hidden rows/cols, freeze panes) and only
 * for the sheets requested, so a large workbook stays fast on a phone.
 *
 * Requires JSZip (window.JSZip).
 */
(function (global) {
  'use strict';

  const NS_ATTR_RE = /([\w:.-]+)="([^"]*)"/g;

  function attrs(str) {
    const out = {};
    if (!str) return out;
    NS_ATTR_RE.lastIndex = 0;
    let m;
    while ((m = NS_ATTR_RE.exec(str))) out[m[1]] = m[2];
    return out;
  }

  function decodeXml(s) {
    if (!s || s.indexOf('&') === -1) return s || '';
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
  }

  function parseDom(xml) {
    return new DOMParser().parseFromString(xml, 'application/xml');
  }

  function byTag(node, tag) {
    return Array.from(node.getElementsByTagName(tag));
  }

  function colToIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n; // 1-based
  }

  function indexToCol(n) {
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function parseRef(ref) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return null;
    return { c: colToIndex(m[1]), r: parseInt(m[2], 10) };
  }

  function parseRange(ref) {
    const parts = ref.split(':');
    const a = parseRef(parts[0]);
    const b = parts[1] ? parseRef(parts[1]) : a;
    if (!a || !b) return null;
    return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
  }

  // ---------- colours ----------

  const INDEXED_COLORS = [
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
    '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
    '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
    '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
    '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
    '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  ];

  function hexToRgb(hex) {
    const h = hex.length === 8 ? hex.slice(2) : hex;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(rgb) {
    return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
  }

  function applyTint(hex, tint) {
    if (!tint) return hex;
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    return rgbToHex(hslToRgb(h, s, nl));
  }

  // Excel theme index → clrScheme slot (dk1/lt1 and dk2/lt2 are swapped)
  const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

  function parseTheme(xml) {
    const theme = {};
    if (!xml) return theme;
    const doc = parseDom(xml);
    const scheme = doc.getElementsByTagName('a:clrScheme')[0] || doc.getElementsByTagName('clrScheme')[0];
    if (!scheme) return theme;
    for (const el of Array.from(scheme.children)) {
      const name = el.localName;
      const child = el.firstElementChild;
      if (!child) continue;
      const val = child.getAttribute('lastClr') || child.getAttribute('val');
      if (val) theme[name] = val.toUpperCase();
    }
    return theme;
  }

  function colorFromAttrs(a, theme) {
    if (!a) return null;
    let hex = null;
    if (a.rgb) hex = a.rgb.toUpperCase().slice(-6);
    else if (a.theme !== undefined) {
      const slot = THEME_SLOTS[parseInt(a.theme, 10)];
      hex = (slot && theme[slot]) || null;
    } else if (a.indexed !== undefined) {
      hex = INDEXED_COLORS[parseInt(a.indexed, 10)] || null;
    }
    if (!hex) return null;
    if (a.tint) hex = applyTint(hex, parseFloat(a.tint));
    return '#' + hex;
  }

  // ---------- styles ----------

  const BUILTIN_FORMATS = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
    12: '# ?/?', 13: '# ??/??', 14: 'yyyy/m/d', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy/m/d h:mm', 37: '#,##0 ;(#,##0)',
    38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss',
    46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
    // Japanese locale builtins
    27: '[$-411]ge.m.d', 28: '[$-411]ggge"年"m"月"d"日"', 29: '[$-411]ggge"年"m"月"d"日"', 30: 'm/d/yy',
    31: 'yyyy"年"m"月"d"日"', 32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"', 34: 'yyyy"年"m"月"', 35: 'm"月"d"日"',
    36: '[$-411]ge.m.d', 50: '[$-411]ge.m.d', 51: '[$-411]ggge"年"m"月"d"日"', 52: 'yyyy"年"m"月"', 53: 'm"月"d"日"',
    54: '[$-411]ggge"年"m"月"d"日"', 55: 'yyyy"年"m"月"', 56: 'm"月"d"日"', 57: '[$-411]ge.m.d', 58: '[$-411]ggge"年"m"月"d"日"',
  };

  function parseStyles(xml, theme) {
    const numFmts = Object.assign({}, BUILTIN_FORMATS);
    const fonts = [];
    const fills = [];
    const xfs = [];
    if (!xml) return { numFmts, fonts, fills, xfs };
    const doc = parseDom(xml);

    for (const nf of byTag(doc, 'numFmt')) {
      numFmts[parseInt(nf.getAttribute('numFmtId'), 10)] = nf.getAttribute('formatCode');
    }

    const fontsEl = doc.getElementsByTagName('fonts')[0];
    if (fontsEl) {
      for (const f of Array.from(fontsEl.children)) {
        const font = { bold: false, italic: false, strike: false, underline: false, size: 11, color: null };
        for (const p of Array.from(f.children)) {
          switch (p.localName) {
            case 'b': font.bold = p.getAttribute('val') !== '0'; break;
            case 'i': font.italic = p.getAttribute('val') !== '0'; break;
            case 'strike': font.strike = p.getAttribute('val') !== '0'; break;
            case 'u': font.underline = p.getAttribute('val') !== 'none'; break;
            case 'sz': font.size = parseFloat(p.getAttribute('val')) || 11; break;
            case 'color': font.color = colorFromAttrs(attrsOf(p), theme); break;
            default: break;
          }
        }
        fonts.push(font);
      }
    }

    const fillsEl = doc.getElementsByTagName('fills')[0];
    if (fillsEl) {
      for (const f of Array.from(fillsEl.children)) {
        const pf = f.getElementsByTagName('patternFill')[0];
        let color = null;
        if (pf) {
          const type = pf.getAttribute('patternType');
          if (type && type !== 'none') {
            const fg = pf.getElementsByTagName('fgColor')[0];
            const bg = pf.getElementsByTagName('bgColor')[0];
            if (type === 'solid') color = colorFromAttrs(attrsOf(fg), theme);
            else color = colorFromAttrs(attrsOf(fg), theme) || colorFromAttrs(attrsOf(bg), theme);
            if (type === 'gray125' && !fg) color = null;
          }
        }
        fills.push(color);
      }
    }

    const cellXfs = doc.getElementsByTagName('cellXfs')[0];
    if (cellXfs) {
      for (const xf of Array.from(cellXfs.children)) {
        const s = {
          numFmtId: parseInt(xf.getAttribute('numFmtId') || '0', 10),
          fontId: parseInt(xf.getAttribute('fontId') || '0', 10),
          fillId: parseInt(xf.getAttribute('fillId') || '0', 10),
          h: null, v: null, wrap: false, indent: 0, rot: 0,
        };
        const al = xf.getElementsByTagName('alignment')[0];
        if (al) {
          s.h = al.getAttribute('horizontal');
          s.v = al.getAttribute('vertical');
          s.wrap = al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true';
          s.indent = parseInt(al.getAttribute('indent') || '0', 10);
          s.rot = parseInt(al.getAttribute('textRotation') || '0', 10);
        }
        xfs.push(s);
      }
    }
    return { numFmts, fonts, fills, xfs };
  }

  function attrsOf(el) {
    if (!el) return null;
    const o = {};
    for (const a of Array.from(el.attributes)) o[a.name] = a.value;
    return o;
  }

  // ---------- shared strings ----------

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const doc = parseDom(xml);
    const sst = doc.documentElement;
    for (const si of Array.from(sst.children)) {
      if (si.localName !== 'si') continue;
      let text = '';
      for (const ch of Array.from(si.children)) {
        if (ch.localName === 't') text += ch.textContent;
        else if (ch.localName === 'r') {
          for (const t of Array.from(ch.children)) if (t.localName === 't') text += t.textContent;
        }
        // rPh (phonetic/furigana) runs are intentionally skipped
      }
      out.push(text);
    }
    return out;
  }

  // ---------- worksheet ----------

  const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const V_RE = /<v>([\s\S]*?)<\/v>/;
  const IS_T_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;

  function parseSheet(xml, ctx) {
    const sheet = {
      cells: [],       // cells[r][c] = {v, t, s}  (1-based)
      rows: {},        // rows[r] = {hidden, ht}
      cols: {},        // cols[c] = {width, hidden}
      merges: [],
      freeze: { x: 0, y: 0 },
      defaultRowHeight: 15,
      defaultColWidth: 8.43,
      maxRow: 0, maxCol: 0,
      tabColor: null,
    };

    // header portion (everything before sheetData) is small: use DOM for it
    const sdStart = xml.indexOf('<sheetData');
    const headXml = sdStart >= 0 ? xml.slice(0, sdStart) + '</worksheet>' : xml;
    const hdoc = parseDom(headXml.replace(/<\/worksheet>\s*$/, '') + '</worksheet>');

    const tab = hdoc.getElementsByTagName('tabColor')[0];
    if (tab) sheet.tabColor = colorFromAttrs(attrsOf(tab), ctx.theme);

    const pane = hdoc.getElementsByTagName('pane')[0];
    if (pane && pane.getAttribute('state') === 'frozen') {
      sheet.freeze.x = parseInt(pane.getAttribute('xSplit') || '0', 10);
      sheet.freeze.y = parseInt(pane.getAttribute('ySplit') || '0', 10);
    }
    const fmt = hdoc.getElementsByTagName('sheetFormatPr')[0];
    if (fmt) {
      if (fmt.getAttribute('defaultRowHeight')) sheet.defaultRowHeight = parseFloat(fmt.getAttribute('defaultRowHeight'));
      if (fmt.getAttribute('defaultColWidth')) sheet.defaultColWidth = parseFloat(fmt.getAttribute('defaultColWidth'));
    }
    for (const col of byTag(hdoc, 'col')) {
      const min = parseInt(col.getAttribute('min'), 10);
      const max = Math.min(parseInt(col.getAttribute('max'), 10), min + 2000);
      const width = col.getAttribute('width') ? parseFloat(col.getAttribute('width')) : null;
      const hidden = col.getAttribute('hidden') === '1' || col.getAttribute('hidden') === 'true';
      for (let c = min; c <= max; c++) sheet.cols[c] = { width, hidden };
    }

    // merges live after sheetData
    const mcStart = xml.indexOf('<mergeCells');
    if (mcStart >= 0) {
      const mcEnd = xml.indexOf('</mergeCells>', mcStart);
      const seg = xml.slice(mcStart, mcEnd);
      const re = /<mergeCell ref="([^"]+)"/g;
      let m;
      while ((m = re.exec(seg))) {
        const rg = parseRange(m[1]);
        if (rg) sheet.merges.push(rg);
      }
    }

    // sheetData
    if (sdStart >= 0) {
      const sdEnd = xml.indexOf('</sheetData>', sdStart);
      const data = xml.slice(sdStart, sdEnd);
      ROW_RE.lastIndex = 0;
      let rm;
      while ((rm = ROW_RE.exec(data))) {
        const ra = attrs(rm[1]);
        const r = parseInt(ra.r, 10);
        if (!r) continue;
        const rowInfo = {};
        if (ra.hidden === '1' || ra.hidden === 'true') rowInfo.hidden = true;
        if (ra.ht) rowInfo.ht = parseFloat(ra.ht);
        if (rowInfo.hidden || rowInfo.ht !== undefined) sheet.rows[r] = rowInfo;
        if (!rm[2]) continue;
        const rowCells = [];
        let any = false;
        CELL_RE.lastIndex = 0;
        let cm;
        while ((cm = CELL_RE.exec(rm[2]))) {
          const ca = attrs(cm[1]);
          const ref = parseRef(ca.r || '');
          if (!ref) continue;
          const s = ca.s ? parseInt(ca.s, 10) : 0;
          let v = null, t = 'n';
          const body = cm[2];
          if (body) {
            const type = ca.t || 'n';
            if (type === 'inlineStr') {
              let txt = '';
              IS_T_RE.lastIndex = 0;
              let tm;
              while ((tm = IS_T_RE.exec(body))) txt += decodeXml(tm[1]);
              v = txt; t = 's';
            } else {
              const vm = V_RE.exec(body);
              if (vm) {
                const raw = vm[1];
                if (type === 's') { v = ctx.sst[parseInt(raw, 10)] ?? ''; t = 's'; }
                else if (type === 'str') { v = decodeXml(raw); t = 's'; }
                else if (type === 'b') { v = raw === '1'; t = 'b'; }
                else if (type === 'e') { v = decodeXml(raw); t = 'e'; }
                else if (type === 'd') { v = decodeXml(raw); t = 'd'; }
                else { v = parseFloat(raw); t = 'n'; if (Number.isNaN(v)) { v = decodeXml(raw); t = 's'; } }
              }
            }
          }
          if (v === null && !s) continue;
          if (t === 's' && v === '') v = null;
          rowCells[ref.c] = { v, t, s };
          if (v !== null) any = true;
          if (ref.c > sheet.maxCol) sheet.maxCol = ref.c;
        }
        if (rowCells.length) {
          sheet.cells[r] = rowCells;
          if (any && r > sheet.maxRow) sheet.maxRow = r;
        }
      }
    }
    for (const mg of sheet.merges) {
      if (mg.r2 > sheet.maxRow && hasValue(sheet, mg.r1, mg.c1)) sheet.maxRow = mg.r2;
    }
    return sheet;
  }

  function hasValue(sheet, r, c) {
    const row = sheet.cells[r];
    return !!(row && row[c] && row[c].v !== null && row[c].v !== undefined);
  }

  // ---------- workbook ----------

  async function readText(zip, path) {
    const f = zip.file(path) || zip.file(path.replace(/^\//, ''));
    return f ? f.async('string') : null;
  }

  /**
   * Open a workbook. Sheets are parsed lazily through `loadSheet` so that a
   * large book with many unneeded sheets stays fast.
   * @param {ArrayBuffer} buffer
   * @param {(msg:string, pct:number) => void} [onProgress]
   */
  async function openWorkbook(buffer, onProgress) {
    const progress = onProgress || (() => {});
    progress('ファイルを展開中…', 5);
    const zip = await global.JSZip.loadAsync(buffer);
    const wbXml = await readText(zip, 'xl/workbook.xml');
    if (!wbXml) throw new Error('Excel ブック (xlsx / xlsm) として読み込めませんでした。');
    const relsXml = await readText(zip, 'xl/_rels/workbook.xml.rels');
    const stylesXml = await readText(zip, 'xl/styles.xml');
    const themeXml = await readText(zip, 'xl/theme/theme1.xml');
    const sstXml = await readText(zip, 'xl/sharedStrings.xml');

    progress('書式を読み込み中…', 10);
    const theme = parseTheme(themeXml);
    const styles = parseStyles(stylesXml, theme);
    const sst = parseSharedStrings(sstXml);

    const rels = {};
    if (relsXml) {
      const rdoc = parseDom(relsXml);
      for (const rel of byTag(rdoc, 'Relationship')) {
        let target = rel.getAttribute('Target') || '';
        if (target.startsWith('/')) target = target.slice(1);
        else if (!target.startsWith('xl/')) target = 'xl/' + target;
        rels[rel.getAttribute('Id')] = target;
      }
    }

    const wdoc = parseDom(wbXml);
    const sheetEls = byTag(wdoc, 'sheet');
    const sheetsMeta = sheetEls.map((s, i) => ({
      name: s.getAttribute('name'),
      index: i,
      state: s.getAttribute('state') || 'visible',
      path: rels[s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')] || null,
    }));
    const ctx = { sst, theme, styles };
    const cache = new Map();

    async function loadSheet(index) {
      if (cache.has(index)) return cache.get(index);
      const meta = sheetsMeta[index];
      if (!meta || !meta.path) return null;
      const xml = await readText(zip, meta.path);
      if (!xml) return null;
      const sheet = parseSheet(xml, ctx);
      sheet.name = meta.name;
      sheet.index = meta.index;
      cache.set(index, sheet);
      return sheet;
    }

    return {
      sheets: sheetsMeta,
      allSheetNames: sheetsMeta.map((m) => m.name),
      styles,
      theme,
      loadSheet,
      isLoaded: (index) => cache.has(index),
    };
  }

  global.XlsxLite = { openWorkbook, colToIndex, indexToCol, parseRange, decodeXml };
})(window);
