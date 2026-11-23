// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Same answers as makefun-site's build() for every input, produced by a
// from-scratch implementation of its dialect (front matter, Markdown subset,
// template dialect, slug rule, report). No dependencies. The speed comes from
// single-pass scanning instead of per-character/per-line regular expressions,
// range-based inline rendering instead of substring slicing, and array-based
// output instead of repeated string concatenation.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const SPECIAL_RE = /[&<>"']/;

function escapeHtml(s) {
  const first = s.search(SPECIAL_RE);
  if (first === -1) return s;
  let out = s.slice(0, first);
  let last = first;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep === null) continue;
    out += s.slice(last, i);
    out += rep;
    last = i + 1;
  }
  return out + s.slice(last);
}

const slugCache = new Map();

function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifySlow(text);
    slugCache.set(text, v);
  }
  return v;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;

function isWSCode(c) {
  if (c < 128) return WS_ASCII[c] === 1;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// The words of one line. A line boundary is whitespace, so the count of a
// whole body is the sum of its lines' counts.
function countLineWords(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const ws = c < 128 ? WS_ASCII[c] === 1 : (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z _
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

function fmValueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
    }
    return { value: raw };
  }
  // slug
  if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return { error: 'key "slug": not a slug' };
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return { error: 'key "slug": not a slug' };
  }
  if (prevDash) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line: a line exactly '---'.
  let closeStart = -1;
  let p = text.indexOf('\n---', 3);
  while (p !== -1) {
    const after = p + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { closeStart = p + 1; break; }
    p = text.indexOf('\n---', p + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart - 1);
  const bodyStart = closeStart + 3 >= text.length ? text.length : closeStart + 4;
  const body = closeStart + 3 >= text.length ? '' : text.slice(bodyStart);
  const data = {};
  if (fmText !== '') {
    const lines = fmText.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      let blank = true;
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (blank || line.charCodeAt(0) === 35) continue; // blank or '#'
      // key: one or more [a-z_], then ':', then optionally ' ' + value
      let j = 0;
      while (j < line.length && isKeyChar(line.charCodeAt(j))) j++;
      if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return { error: `line ${k + 2} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 >= line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      else return { error: `line ${k + 2} is not "key: value"` };
      // drop trailing spaces and tabs
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      raw = raw.slice(0, e);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ----------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// A fence opening line: '```' + lang chars, then spaces/tabs only. Returns the lang or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading line, or null. Text is the content after the '#'s and spaces, trailing spaces/tabs dropped.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) break;
    i++;
  }
  let e = line.length;
  while (e > i) {
    const ch = line.charCodeAt(e - 1);
    if (ch !== 32 && ch !== 9) break;
    e--;
  }
  if (e === i) return null;
  return { depth: n, text: line.slice(i, e) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null; // ``` fence
  if (c0 === 35) return headingOf(line) !== null; // # heading
  if (c0 === 45 || c0 === 42) return isHR(line); // --- or *** break
  return false;
}

// Whether `target` opens with a URL scheme (a letter, then letters/digits/+/-/. and a colon).
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // :
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// A bullet item's text, or null. '- ' or '* ' + rest.
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

// An ordered item: { num, text } or null. 1-9 digits + '. ' + rest.
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  return i < line.length && !isWSCode(line.charCodeAt(i));
}

function findUnescaped(s, what, from, to) {
  const wlen = what.length;
  for (let j = from; j <= to - wlen; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

// The characters that can start an inline construct or need HTML escaping.
const INL_RE = /[\\`*\[&<>"']/g;

// Render the inline range [from, to) of s into out. Plain stretches are found
// by one native regex scan and pushed raw; only the construct at the end of a
// stretch is handled in JavaScript. A special that forms no construct stays in
// the pending plain run (run is not advanced), so it is emitted with the run.
// (INL_RE's lastIndex is reset at the top of every iteration, so the recursion
// below cannot corrupt the outer scan.)
function inlineRange(s, from, to, env, out) {
  let i = from;
  let run = from;
  while (i < to) {
    INL_RE.lastIndex = i;
    const m = INL_RE.exec(s);
    if (m === null || m.index >= to) {
      if (to > run) out.push(s.slice(run, to));
      return;
    }
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < to && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out.push(s.slice(run, i));
        out.push(escapeHtml(s[i + 1]));
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (c === 96) { // backtick
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < to && k > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>');
        out.push(escapeHtml(s.slice(i + 1, k)));
        out.push('</code>');
        i = k + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === 42) { // *
      if (i + 1 < to && s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, to);
        if (k > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineRange(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
          run = i;
        } else i += 2;
      } else {
        const k = findSingleStar(s, i + 1, to);
        if (k > i + 1) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<em>');
          inlineRange(s, i + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    if (c === 91) { // [
      const k = findUnescaped(s, ']', i + 1, to);
      let p = -1;
      if (k !== -1 && k + 1 < to && s[k + 1] === '(') {
        const q = s.indexOf(')', k + 2);
        if (q !== -1 && q < to) p = q;
      }
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !hasWS(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="');
        out.push(escapeHtml(env.link(target)));
        out.push('">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = p + 1;
        run = i;
      } else i++;
      continue;
    }
    // One of & < > " ' : flush the plain run, then its entity.
    if (i > run) out.push(s.slice(run, i));
    if (c === 38) out.push('&amp;');
    else if (c === 60) out.push('&lt;');
    else if (c === 62) out.push('&gt;');
    else if (c === 34) out.push('&quot;');
    else out.push('&#39;');
    i++;
    run = i;
  }
  if (to > run) out.push(s.slice(run, to));
}

// INL_RE's set is the union of the construct starters (\ ` * [) and the HTML
// specials (& < > " '), so a string it does not match needs neither a
// construct nor any escaping and can be pushed as-is. That is one regex test
// instead of MARK_RE's test plus escapeHtml's own search.
function inlineInto(s, env, out) {
  INL_RE.lastIndex = 0;
  if (!INL_RE.test(s)) {
    out.push(s);
    return;
  }
  inlineRange(s, 0, s.length, env, out);
}

function inlineToString(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

// Render one body's Markdown: { html, toc, excerpt, words }. Inline content is
// written straight into the single html array; a string is built only where one
// is needed (the first paragraph's excerpt, a level 2/3 heading's toc entry).
// The word count is taken while the lines are consumed: the block-start line
// is counted at the top of the loop, and every line an inner loop consumes
// after the first is counted there — so each line is counted exactly once and
// the sum equals wordsOf(src). In particular the blockquote and list inner
// loops skip their first line (it is the block-start line, already counted),
// while the fence-body and paragraph-continuation loops count every line
// they consume.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const html = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    words += countLineWords(line);
    const c0 = line.charCodeAt(0);
    // Blank: empty, or (rarely) only spaces/tabs.
    if (line === '' || c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
    }
    // Fence opening: ``` + lang.
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !fenceClose(lines[i])) { words += countLineWords(lines[i]); body.push(lines[i++]); }
        if (i < lines.length) words += countLineWords(lines[i]); // the closing fence line
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        html.push(`<pre><code${cls}>`);
        for (const l of body) html.push(escapeHtml(l), '\n');
        html.push('</code></pre>\n');
        continue;
      }
    }
    if (c0 === 35) { // # heading
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        if (h.depth === 2 || h.depth === 3) {
          const hHtml = inlineToString(h.text, env);
          html.push(`<h${h.depth} id="${id}">`, hHtml, `</h${h.depth}>\n`);
          toc.push({ level: h.depth, id, html: hHtml });
        } else {
          html.push(`<h${h.depth} id="${id}">`);
          inlineInto(h.text, env, html);
          html.push(`</h${h.depth}>\n`);
        }
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) { // --- or *** break
      if (isHR(line)) { html.push('<hr>\n'); i++; continue; }
    }
    if (c0 === 62) { // > blockquote
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        if (body.length > 0) words += countLineWords(lines[i]); // the first line was counted at the top
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) html.push('<blockquote>\n</blockquote>\n');
      else {
        const text = kept.join('\n');
        html.push('<blockquote>\n<p>');
        inlineInto(text, env, html);
        html.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bText = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
    const o = bText === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (bText !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      let start = 1;
      while (i < lines.length) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            if (items.length === 0) start = Number(m.num);
            if (items.length > 0) words += countLineWords(lines[i]); // the first item was counted at the top
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const t = bulletOf(lines[i]);
          if (t !== null) {
            if (items.length > 0) words += countLineWords(lines[i]); // the first item was counted at the top
            items.push([trimLine(t)]);
            i++;
            continue;
          }
        }
        if (items.length > 0 && isContinued(lines[i])) {
          words += countLineWords(lines[i]);
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      html.push(open, '\n');
      for (const parts of items) {
        const text = parts.join('\n');
        html.push('<li>');
        inlineInto(text, env, html);
        html.push('</li>\n');
      }
      html.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) { words += countLineWords(lines[i]); body.push(trimLine(lines[i++])); }
    const text = body.join('\n');
    if (excerpt === null) {
      const pHtml = inlineToString(text, env);
      excerpt = pHtml;
      html.push('<p>', pHtml, '</p>\n');
    } else {
      html.push('<p>');
      inlineInto(text, env, html);
      html.push('</p>\n');
    }
  }
  return { html: html.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INCLUDE_DEPTH = 8;

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------- template compiler

// A parsed template compiled to a function fn(S, D, O, LK, TX, TR, E, T, G):
// S the scope chain, D the include depth, O the output array, LK/TX/TR/E the
// lookup/text/truthy/escape helpers, T the compiled templates, G this
// template's captured path arrays. Rendering the tree once per template
// replaces the per-node interpreter walk on every page. Falls back to null
// (the AST interpreter above) if compilation is unavailable.
function compileTemplate(nodes) {
  const G = [];
  let uid = 0;
  const gen = (ns, scopeVar, out) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          out.push(`O.push(${JSON.stringify(n.text)});`);
          break;
        case 'var': {
          const gi = G.length;
          G.push(n.path);
          out.push(`O.push(E(TX(LK(${scopeVar},G[${gi}]))));`);
          break;
        }
        case 'raw': {
          const gi = G.length;
          G.push(n.path);
          out.push(`O.push(TX(LK(${scopeVar},G[${gi}])));`);
          break;
        }
        case 'if': {
          const gi = G.length;
          G.push(n.path);
          out.push(`if (TR(LK(${scopeVar},G[${gi}])) !== ${n.not ? 'true' : 'false'}) {`);
          gen(n.then, scopeVar, out);
          if (n.else !== null) {
            out.push('} else {');
            gen(n.else, scopeVar, out);
          }
          out.push('}');
          break;
        }
        case 'for': {
          const gi = G.length;
          G.push(n.path);
          const sv = `_s${uid++}`;
          const av = `_a${uid++}`;
          const iv = `_i${uid++}`;
          out.push(`{ const ${av} = LK(${scopeVar},G[${gi}]);`);
          out.push(`if (Array.isArray(${av})) {`);
          out.push(`for (let ${iv} = 0; ${iv} < ${av}.length; ${iv}++) {`);
          out.push(`const ${sv} = { vars: { ${JSON.stringify(n.name)}: ${av}[${iv}], loop: { index: ${iv} + 1, first: ${iv} === 0, last: ${iv} === ${av}.length - 1, length: ${av}.length } }, parent: ${scopeVar} };`);
          gen(n.body, sv, out);
          out.push('} } }');
          break;
        }
        case 'include':
          // _f is the included template's wrapper, which supplies its own G.
          out.push(`if (D < 8) { const _f = T.get(${JSON.stringify(n.name)}); if (_f !== undefined) _f(${scopeVar}, D + 1, O, LK, TX, TR, E, T); }`);
          break;
      }
    }
  };
  try {
    const lines = [];
    gen(nodes, 'S', lines);
    const fn = new Function('S', 'D', 'O', 'LK', 'TX', 'TR', 'E', 'T', 'G', lines.join('\n'));
    return (S, D, O, LK, TX, TR, E, T) => fn(S, D, O, LK, TX, TR, E, T, G);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- build

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** `rel` resolved from the directory whose parts are `parts` (already split), or null when it climbs out of the root. */
function resolveFrom(parts, rel) {
  const out = parts.slice();
  let i = 0;
  while (i <= rel.length) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const seg = rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (out.length === 0) return null;
        out.pop();
      } else out.push(seg);
    }
    i = j + 1;
  }
  return out.join('/');
}

function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

export function build(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  // Compile every template once per case; a template that does not compile
  // keeps its AST and renders through the interpreter.
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    if (fn !== null) compiled.set(name, fn);
  }

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveFrom(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const output = {};
  const render = (name, vars) => {
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    const fn = compiled.get(name);
    const out = [];
    if (fn !== undefined) {
      fn(scope, 0, out, lookup, textOf, truthy, escapeHtml, compiled);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, scope, ctx, 0, out);
    }
    return out.join('');
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** One case's answer. The slug cache is per case: it is cleared here so no
 * result is carried from one case to the next. */
export function run(input) {
  slugCache.clear();
  return build(input);
}
