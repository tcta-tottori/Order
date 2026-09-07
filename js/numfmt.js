/*
 * numfmt.js — formats cell values using (a practical subset of) Excel number
 * format codes, including the Japanese date/era formats used in this workbook.
 */
(function (global) {
  'use strict';

  const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const ERAS = [
    { start: Date.UTC(2019, 4, 1), name: '令和', short: 'R' },
    { start: Date.UTC(1989, 0, 8), name: '平成', short: 'H' },
    { start: Date.UTC(1926, 11, 25), name: '昭和', short: 'S' },
    { start: Date.UTC(1912, 6, 30), name: '大正', short: 'T' },
    { start: -Infinity, name: '明治', short: 'M' },
  ];

  /** Excel serial (1900 date system) → parts in UTC. */
  function serialToDate(serial) {
    let s = serial;
    if (s < 60) s += 1; // Excel's fictitious 1900-02-29
    const ms = Math.round((s - 25569) * 86400000);
    const d = new Date(ms);
    // round to nearest second to avoid 59.999 artefacts
    const frac = serial - Math.floor(serial);
    let secs = Math.round(frac * 86400);
    if (secs >= 86400) secs = 86399;
    return {
      y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(),
      h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60), s: secs % 60,
      totalHours: Math.floor(serial) * 24 + Math.floor(secs / 3600),
      utc: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    };
  }

  function dateFromSerial(serial) {
    const p = serialToDate(serial);
    return new Date(p.y, p.M - 1, p.d, p.h, p.m, p.s);
  }

  function eraOf(utc) {
    for (const e of ERAS) if (utc >= e.start) return e;
    return ERAS[ERAS.length - 1];
  }

  // ---- tokenizer ----
  // Splits a single format section into tokens: {t:'lit', v} | {t:'code', v}
  function tokenize(section) {
    const tokens = [];
    let i = 0;
    const n = section.length;
    while (i < n) {
      const ch = section[i];
      if (ch === '"') {
        const j = section.indexOf('"', i + 1);
        tokens.push({ t: 'lit', v: section.slice(i + 1, j < 0 ? n : j) });
        i = j < 0 ? n : j + 1;
      } else if (ch === '\\') {
        tokens.push({ t: 'lit', v: section[i + 1] || '' });
        i += 2;
      } else if (ch === '_') {
        tokens.push({ t: 'lit', v: ' ' });
        i += 2;
      } else if (ch === '*') {
        i += 2; // repeat-fill: ignored
      } else if (ch === '[') {
        const j = section.indexOf(']', i);
        const inner = section.slice(i + 1, j < 0 ? n : j);
        // [h] [mm] [ss] elapsed; colours / locale / conditions are dropped
        if (/^(h+|m+|s+)$/i.test(inner)) tokens.push({ t: 'code', v: '[' + inner.toLowerCase() + ']' });
        i = j < 0 ? n : j + 1;
      } else if (/^general/i.test(section.slice(i, i + 7))) {
        tokens.push({ t: 'code', v: 'General' });
        i += 7;
      } else if (/^(AM\/PM|A\/P)/i.test(section.slice(i, i + 5))) {
        const m = /^(AM\/PM|A\/P)/i.exec(section.slice(i, i + 5));
        tokens.push({ t: 'code', v: m[0].toUpperCase() });
        i += m[0].length;
      } else if (/[ymdhsgeaYMDHSGEA#0?.,%@E+-]/.test(ch)) {
        // run of the same letter (for dates) or a numeric pattern char
        let j = i + 1;
        if (/[a-zA-Z]/.test(ch)) {
          while (j < n && section[j].toLowerCase() === ch.toLowerCase()) j++;
          tokens.push({ t: 'code', v: section.slice(i, j).toLowerCase() });
        } else {
          tokens.push({ t: 'code', v: ch });
        }
        i = j;
      } else {
        tokens.push({ t: 'lit', v: ch });
        i++;
      }
    }
    return tokens;
  }

  function splitSections(code) {
    const parts = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"') inQ = !inQ;
      if (ch === '\\' && !inQ) { cur += ch + (code[i + 1] || ''); i++; continue; }
      if (ch === ';' && !inQ) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  }

  function isDateSection(tokens) {
    let hasDate = false, hasNum = false;
    for (const tk of tokens) {
      if (tk.t !== 'code') continue;
      if (tk.v === 'General' || tk.v === '@') continue;
      if (/^[#0?%]$/.test(tk.v) || tk.v === 'E' || tk.v === 'e' && false) hasNum = true;
      if (/^(y+|m+|d+|h+|s+|g+|e+|a+|\[h+\]|\[m+\]|\[s+\]|AM\/PM|A\/P)$/.test(tk.v)) hasDate = true;
    }
    return hasDate && !hasNum;
  }

  function formatDate(serial, tokens) {
    if (!Number.isFinite(serial) || serial < -1000000) return String(serial);
    const p = serialToDate(serial);
    const era = eraOf(p.utc);
    const eraYear = p.y - new Date(era.start === -Infinity ? Date.UTC(1868, 0, 1) : era.start).getUTCFullYear() + 1;
    const hasAmPm = tokens.some((t) => t.t === 'code' && (t.v === 'AM/PM' || t.v === 'A/P'));
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t === 'lit') { out += tk.v; continue; }
      const v = tk.v;
      const pad = (num, len) => String(num).padStart(len, '0');
      if (v[0] === 'y') out += v.length <= 2 ? pad(p.y % 100, 2) : String(p.y);
      else if (v[0] === 'e') out += v.length >= 2 ? pad(eraYear, 2) : String(eraYear);
      else if (v[0] === 'g') out += v.length >= 3 ? era.name : v.length === 2 ? era.name[0] : era.short;
      else if (v[0] === 'm') {
        // minutes if immediately after an hour token or before a seconds token
        const prev = prevCode(tokens, i), next = nextCode(tokens, i);
        const isMin = (prev && prev[0] === 'h') || (next && next[0] === 's') || (prev && prev[0] === '[' && prev[1] === 'h');
        if (isMin) out += v.length >= 2 ? pad(p.m, 2) : String(p.m);
        else if (v.length >= 5) out += EN_MONTHS[p.M - 1][0];
        else if (v.length === 4) out += EN_MONTHS[p.M - 1];
        else if (v.length === 3) out += EN_MONTHS[p.M - 1].slice(0, 3);
        else out += v.length === 2 ? pad(p.M, 2) : String(p.M);
      } else if (v[0] === 'd') {
        if (v.length >= 4) out += EN_WEEKDAYS[p.wd];
        else if (v.length === 3) out += EN_WEEKDAYS[p.wd].slice(0, 3);
        else out += v.length === 2 ? pad(p.d, 2) : String(p.d);
      } else if (v[0] === 'a') {
        out += v.length >= 4 ? JA_WEEKDAYS[p.wd] + '曜日' : JA_WEEKDAYS[p.wd];
      } else if (v[0] === 'h') {
        let h = p.h;
        if (hasAmPm) { h = h % 12; if (h === 0) h = 12; }
        out += v.length >= 2 ? pad(h, 2) : String(h);
      } else if (v[0] === 's') out += v.length >= 2 ? pad(p.s, 2) : String(p.s);
      else if (v === '[h]') out += String(p.totalHours);
      else if (v === '[m]') out += String(Math.floor(serial * 1440));
      else if (v === '[s]') out += String(Math.floor(serial * 86400));
      else if (v === 'AM/PM') out += p.h < 12 ? 'AM' : 'PM';
      else if (v === 'A/P') out += p.h < 12 ? 'A' : 'P';
      else if (v === '.' && nextCode(tokens, i) === '0') { /* fractional seconds: drop */ }
      else if (v === '0' && prevCode(tokens, i) === '.') { /* dropped */ }
      else if (v === '/' || v === '-' || v === ':' || v === ',') out += v;
      else out += v;
    }
    return out;
  }

  function prevCode(tokens, i) {
    for (let j = i - 1; j >= 0; j--) if (tokens[j].t === 'code') return tokens[j].v;
    return null;
  }
  function nextCode(tokens, i) {
    for (let j = i + 1; j < tokens.length; j++) if (tokens[j].t === 'code') return tokens[j].v;
    return null;
  }

  function formatGeneral(num) {
    if (!Number.isFinite(num)) return String(num);
    if (Number.isInteger(num)) return Math.abs(num) >= 1e15 ? num.toExponential(5) : String(num);
    const abs = Math.abs(num);
    if (abs >= 1e11 || abs < 1e-9) return num.toExponential(5).replace(/\.?0+e/, 'e');
    let s = num.toPrecision(10);
    if (s.indexOf('e') >= 0) return s.replace(/\.?0+e/, 'e');
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s;
  }

  function addThousands(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatNumber(num, tokens, useAbs) {
    let pre = '', post = '';
    let intMin = 0, decMin = 0, decMax = 0, grouping = false, percent = false, sawDot = false, sawNumeric = false, scale = 0;
    let generalOnly = true;
    let textHolder = false;
    // pass 1: analyse pattern
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t === 'lit') { if (sawNumeric) post += tk.v; else pre += tk.v; continue; }
      const v = tk.v;
      if (v === 'General') { sawNumeric = true; continue; }
      if (v === '@') { textHolder = true; continue; }
      generalOnly = false;
      if (v === '#' || v === '0' || v === '?') {
        sawNumeric = true;
        if (sawDot) { decMax++; if (v === '0') decMin++; }
        else if (v === '0') intMin++;
      } else if (v === '.') { sawDot = true; sawNumeric = true; }
      else if (v === ',') {
        // thousands separator if followed by more digit tokens, else scaling
        const nx = nextCode(tokens, i);
        if (nx === '#' || nx === '0' || nx === '?') grouping = true; else if (sawNumeric && !sawDot) scale++;
      } else if (v === '%') { percent = true; if (sawNumeric) post += '%'; else pre += '%'; }
      else if (v === 'E' || v === 'e' || v === '+' || v === '-') { if (sawNumeric) post += v === 'E' || v === 'e' ? '' : v; else pre += v === 'E' || v === 'e' ? '' : v; }
      else { if (sawNumeric) post += v; else pre += v; }
    }
    let n = useAbs ? Math.abs(num) : num;
    if (percent) n *= 100;
    if (scale) n /= Math.pow(1000, scale);
    let body;
    if (generalOnly) body = formatGeneral(n);
    else {
      const neg = n < 0;
      const fixed = Math.abs(n).toFixed(decMax);
      let [ip, dp = ''] = fixed.split('.');
      if (decMax > decMin) dp = dp.replace(new RegExp('0{1,' + (decMax - decMin) + '}$'), '');
      if (intMin === 0 && ip === '0' && (decMax > 0)) ip = '';
      ip = ip.padStart(intMin, '0');
      if (grouping) ip = addThousands(ip);
      body = ip + (dp ? '.' + dp : '');
      if (neg) body = '-' + body;
    }
    return pre + body + post;
  }

  /**
   * Format a number using an Excel format code.
   * @returns {{text:string, isDate:boolean}}
   */
  function formatNumberWithCode(num, code) {
    if (!code || code === 'General') return { text: formatGeneral(num), isDate: false };
    const sections = splitSections(code);
    let sec, useAbs = false;
    if (sections.length === 1) sec = sections[0];
    else if (sections.length === 2) { if (num < 0) { sec = sections[1]; useAbs = true; } else sec = sections[0]; }
    else { if (num > 0) sec = sections[0]; else if (num < 0) { sec = sections[1]; useAbs = true; } else sec = sections[2]; }
    const tokens = tokenize(sec);
    if (isDateSection(tokens)) return { text: formatDate(num, tokens), isDate: true };
    return { text: formatNumber(num, tokens, useAbs), isDate: false };
  }

  function formatText(str, code) {
    if (!code || code === 'General' || code === '@') return str;
    const sections = splitSections(code);
    const sec = sections.length >= 4 ? sections[3] : sections.find((s) => s.indexOf('@') >= 0);
    if (!sec) return str;
    const tokens = tokenize(sec);
    return tokens.map((t) => (t.t === 'lit' ? t.v : t.v === '@' ? str : '')).join('');
  }

  function isDateFormat(code) {
    if (!code || code === 'General') return false;
    const tokens = tokenize(splitSections(code)[0]);
    return isDateSection(tokens);
  }

  /**
   * Format a parsed cell {v, t} with a number format code.
   * @returns {{text:string, isDate:boolean, isNumber:boolean}}
   */
  function formatCell(cell, code) {
    if (!cell || cell.v === null || cell.v === undefined) return { text: '', isDate: false, isNumber: false };
    switch (cell.t) {
      case 'n': {
        const r = formatNumberWithCode(cell.v, code);
        return { text: r.text, isDate: r.isDate, isNumber: !r.isDate };
      }
      case 'b': return { text: cell.v ? 'TRUE' : 'FALSE', isDate: false, isNumber: false };
      case 'e': return { text: String(cell.v), isDate: false, isNumber: false };
      case 'd': return { text: String(cell.v).replace('T', ' ').replace(/:\d\d(\.\d+)?$/, ''), isDate: true, isNumber: false };
      default: return { text: formatText(String(cell.v), code), isDate: false, isNumber: false };
    }
  }

  global.NumFmt = { formatCell, formatNumberWithCode, formatGeneral, isDateFormat, serialToDate, dateFromSerial };
})(window);
