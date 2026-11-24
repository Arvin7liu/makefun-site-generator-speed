// A faster drop-in for makefun-site 1.0.0's build(input): the same output tree for every input, written from its
// README.md and its code (the reference wherever the two differ).
//
// Where the time goes in the reference, and what this does instead:
//   - Output: the reference builds every page as a JS string, and the driver then JSON.stringifies the 7 MB tree. Here
//     every byte of the answer is written once, already escaped for a JSON string (ASCII only), into one growing
//     Buffer: template text is pre-encoded, values are escaped straight into it, and nothing of the output is ever a
//     JS string (no ropes to flatten, almost nothing for the garbage collector).
//   - Markdown renders straight into a second buffer: inline runs of plain characters are escaped byte by byte, a
//     paragraph that needs no trimming is read in place from the source, and a page's content, excerpt and table of
//     contents are ranges of that buffer, copied into a page with one memcpy.
//   - Templates parse into node trees as the reference's do; an include or for node is rendered once per build for
//     each set of values its free names resolve to (only values shared across pages: site, tags, recent and loop
//     elements such as a post's card), and later uses copy those bytes. Nothing is kept from one build to the next.
//   - Slugs and long dates are memoised within a build, with an ASCII fast path before NFKD.
//
// run(input) returns the output tree, { path: text }. emitJSON(input, flush) writes the same answer as JSON text into
// the shared buffer and hands it to flush(buffer, length) (main.ts writes it to answers.json).

const hasOwn = Object.hasOwn;

// ------------------------------------------------------------------------------------------------ byte writers

/** A growing byte buffer: b, and p the next byte to write. */
class Out {
  constructor(size) {
    this.b = Buffer.allocUnsafe(size);
    this.p = 0;
  }
}

/** The answer's bytes (template output, pages and the JSON around them). */
const W = new Out(16 << 20);
/** Each build's rendered Markdown, which pages copy from. */
const C = new Out(8 << 20);

function grow(w, n) {
  const nb = Buffer.allocUnsafe(Math.max(w.b.length * 2, w.p + n + 1024));
  w.b.copy(nb, 0, 0, w.p);
  w.b = nb;
}

/** An ASCII string with nothing to escape, as it is. */
function put(w, s) {
  const n = s.length;
  if (w.p + n > w.b.length) grow(w, n);
  if (n > 24) w.p += w.b.latin1Write(s, w.p);
  else {
    const b = w.b;
    let p = w.p;
    for (let i = 0; i < n; i++) b[p++] = s.charCodeAt(i);
    w.p = p;
  }
}

/** Pre-encoded bytes. */
function putBytes(w, bytes) {
  const n = bytes.length;
  if (w.p + n > w.b.length) grow(w, n);
  if (n > 24) w.p += bytes.copy(w.b, w.p);
  else {
    const b = w.b;
    let p = w.p;
    for (let i = 0; i < n; i++) b[p++] = bytes[i];
    w.p = p;
  }
}

const HEX = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102];

/**
 * s[from..to) written as the inside of a JSON string of ASCII alone: with `html`, first & < > " ' as the reference's
 * HTML escape writes them (&amp; &lt; &gt; &quot; &#39;); then \ as \\, " as \", a newline as \n, a tab as \t, and any
 * other control character and every code unit from U+007F as a \u escape.
 */
function putEsc(w, s, from, to, html) {
  if (w.p + (to - from) * 6 > w.b.length) grow(w, (to - from) * 6);
  const b = w.b;
  let p = w.p;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c < 127) {
      if (c === 34) {
        if (html) {
          b[p] = 38; b[p + 1] = 113; b[p + 2] = 117; b[p + 3] = 111; b[p + 4] = 116; b[p + 5] = 59; // &quot;
          p += 6;
        } else {
          b[p] = 92; b[p + 1] = 34;
          p += 2;
        }
      } else if (c === 92) {
        b[p] = 92; b[p + 1] = 92;
        p += 2;
      } else if (html && (c === 38 || c === 60 || c === 62 || c === 39)) {
        if (c === 38) {
          b[p] = 38; b[p + 1] = 97; b[p + 2] = 109; b[p + 3] = 112; b[p + 4] = 59; // &amp;
          p += 5;
        } else if (c === 60) {
          b[p] = 38; b[p + 1] = 108; b[p + 2] = 116; b[p + 3] = 59; // &lt;
          p += 4;
        } else if (c === 62) {
          b[p] = 38; b[p + 1] = 103; b[p + 2] = 116; b[p + 3] = 59; // &gt;
          p += 4;
        } else {
          b[p] = 38; b[p + 1] = 35; b[p + 2] = 51; b[p + 3] = 57; b[p + 4] = 59; // &#39;
          p += 5;
        }
      } else b[p++] = c;
    } else if (c === 10) {
      b[p] = 92; b[p + 1] = 110;
      p += 2;
    } else if (c === 9) {
      b[p] = 92; b[p + 1] = 116;
      p += 2;
    } else {
      b[p] = 92; b[p + 1] = 117; b[p + 2] = HEX[(c >> 12) & 15]; b[p + 3] = HEX[(c >> 8) & 15]; b[p + 4] = HEX[(c >> 4) & 15]; b[p + 5] = HEX[c & 15];
      p += 6;
    }
  }
  w.p = p;
}

/** A string as the inside of a JSON string of ASCII alone (no HTML escaping), as a JS string (for keys and text nodes). */
function jsonEsc(s) {
  const q = JSON.stringify(s);
  return q.slice(1, q.length - 1).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** HTML text held as a range of C (written as the inside of a JSON string). Its ends sit under symbols: no path reads them. */
const JS = Symbol('start');
const JE = Symbol('end');
class J {
  constructor(s, e) {
    this[JS] = s;
    this[JE] = e;
  }
}
/** A J's HTML text, decoded. */
const plainOf = (v) => JSON.parse(`"${C.b.latin1Slice(v[JS], v[JE])}"`);

// ------------------------------------------------------------------------------------------------ text

const MARKS = /\p{M}/gu;

/** The slug rule: NFKD, marks dropped, A-Z lowered, runs of anything but a-z0-9 one "-", cut to 64, else "untitled". */
function slugOf(text) {
  const n0 = text.length;
  let plain = text;
  for (let i = 0; i < n0; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARKS, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  const n = plain.length;
  for (let i = 0; i < n; i++) {
    let c = plain.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += plain[i];
    } else if (c >= 65 && c <= 90) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c + 32);
    } else gap = out.length > 0;
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is JavaScript's \s. */
function isWs(c) {
  return c === 32 || (c >= 9 && c <= 13) || (c > 127 && (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279));
}

/** The count of runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let prev = 0; // 1 inside a word
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const w = c > 32 ? (c < 127 || !isWs(c) ? 1 : 0) : c === 32 || (c >= 9 && c <= 13) ? 0 : 1;
    count += w & (prev ^ 1);
    prev = w;
  }
  return count;
}

// ------------------------------------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const TRAIL_WS = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    if (raw.indexOf('\\') === -1) {
      const inner = raw.slice(1, -1);
      if (inner.indexOf('"') !== -1) return { error: 'a quoted string holds a stray quote' };
      return { value: inner };
    }
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** { data, body } or { error }; `text` has "\n" line ends. */
function frontMatter(text) {
  // Line 0 must be exactly "---".
  if (!text.startsWith('---') || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // The closing line: the first line after line 0 that is exactly "---".
  let close = -1; // index of the closing line's first character
  let pos = 4;
  for (;;) {
    if (pos > text.length) break;
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = pos;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const lines = close - 1 > 4 ? text.slice(4, close - 1).split('\n') : close - 1 === 4 ? [''] : [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if ((line.length > 0 && line.charCodeAt(0) === 35) || FM_BLANK.test(line)) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAIL_WS, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const after = text.indexOf('\n', close);
  return { data, body: after === -1 ? '' : text.slice(after + 1) };
}

// ------------------------------------------------------------------------------------------------ Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const QUOTE_MARK = /^> ?/;
const HAS_WS = /\s/;

/** Escapable after a backslash: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = new Uint8Array(128);
for (const c of '\\`*_[]()#+-.!>') ESCAPABLE[c.charCodeAt(0)] = 1;
const escapable = (c) => c < 128 && ESCAPABLE[c] === 1;

/** Whether s[from..to) is spaces and tabs only. */
function blankRange(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Spaces and tabs dropped at both ends. */
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

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : m;
}

/** Whether the line s[ls..le) ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(s, ls, le) {
  if (le === ls) return true;
  const c = s.charCodeAt(ls);
  if (c === 32 || c === 9) return blankRange(s, ls, le);
  if (c === 96) return FENCE_OPEN.test(s.slice(ls, le));
  if (c === 35) return headingOf(s.slice(ls, le)) !== null;
  if (c === 45 || c === 42) return HR.test(s.slice(ls, le));
  return false;
}

/** The first `what` in s[from..to) outside a backslash escape, or -1 (the reference's search on the slice). */
function findUnescaped(s, what, from, to) {
  const p = s.indexOf(what, from);
  if (p === -1 || p + what.length > to) return -1;
  const b = s.indexOf('\\', from);
  if (b === -1 || b >= p) return p;
  for (let j = from; j <= to - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * (not part of **) in s[from..to), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Code units inline() cannot copy as they are: controls, " & ' < > \ ` * [ and DEL. */
const INL = new Uint8Array(128);
for (let c = 0; c < 32; c++) INL[c] = 1;
for (const c of [34, 38, 39, 42, 60, 62, 91, 92, 96, 127]) INL[c] = 1;

/** Room in C for n more bytes. */
function roomC(n) {
  if (C.p + n > C.b.length) grow(C, n);
}

/**
 * s[from..to) rendered inline into C (the reference's inline() on that slice); linkTo(target) is a link's href. One
 * pass: plain text is escaped (HTML, then JSON) as it is read, so a marker that opens nothing is written as text.
 * Every source unit takes at most 6 bytes; room is made again after each construct.
 */
function inline(s, from, to) {
  roomC((to - from) * 6);
  let b = C.b;
  let p = C.p;
  let i = from;
  while (i < to) {
    const c = s.charCodeAt(i);
    if (c < 128 && INL[c] === 0) {
      b[p++] = c;
      i++;
      continue;
    }
    if (c === 38) {
      b[p] = 38; b[p + 1] = 97; b[p + 2] = 109; b[p + 3] = 112; b[p + 4] = 59; // &amp;
      p += 5;
      i++;
      continue;
    }
    if (c === 60) {
      b[p] = 38; b[p + 1] = 108; b[p + 2] = 116; b[p + 3] = 59; // &lt;
      p += 4;
      i++;
      continue;
    }
    if (c === 62) {
      b[p] = 38; b[p + 1] = 103; b[p + 2] = 116; b[p + 3] = 59; // &gt;
      p += 4;
      i++;
      continue;
    }
    if (c === 34) {
      b[p] = 38; b[p + 1] = 113; b[p + 2] = 117; b[p + 3] = 111; b[p + 4] = 116; b[p + 5] = 59; // &quot;
      p += 6;
      i++;
      continue;
    }
    if (c === 39) {
      b[p] = 38; b[p + 1] = 35; b[p + 2] = 51; b[p + 3] = 57; b[p + 4] = 59; // &#39;
      p += 5;
      i++;
      continue;
    }
    if (c === 92) {
      if (i + 1 < to && escapable(s.charCodeAt(i + 1))) {
        C.p = p;
        putEsc(C, s, i + 1, i + 2, true);
        p = C.p;
        i += 2;
      } else {
        b[p] = 92; b[p + 1] = 92;
        p += 2;
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < to) {
        C.p = p;
        put(C, '<code>');
        putEsc(C, s, i + 1, j, true);
        put(C, '</code>');
        i = j + 1;
        roomC((to - i) * 6);
        b = C.b;
        p = C.p;
      } else {
        b[p++] = 96;
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < to && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, to);
        if (j > i + 2) {
          C.p = p;
          put(C, '<strong>');
          inline(s, i + 2, j);
          put(C, '</strong>');
          i = j + 2;
          roomC((to - i) * 6);
          b = C.b;
          p = C.p;
        } else {
          b[p] = 42; b[p + 1] = 42;
          p += 2;
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, to);
      if (j > i + 1) {
        C.p = p;
        put(C, '<em>');
        inline(s, i + 1, j);
        put(C, '</em>');
        i = j + 1;
        roomC((to - i) * 6);
        b = C.b;
        p = C.p;
      } else {
        b[p++] = 42;
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, to);
      const m = k !== -1 && k + 1 < to && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (m > k + 2 && m < to) {
        const target = s.slice(k + 2, m);
        if (!HAS_WS.test(target)) {
          C.p = p;
          const href = linkTo(target);
          put(C, '<a href=\\"');
          putEsc(C, href, 0, href.length, true);
          put(C, '\\">');
          inline(s, i + 1, k);
          put(C, '</a>');
          i = m + 1;
          roomC((to - i) * 6);
          b = C.b;
          p = C.p;
          continue;
        }
      }
      b[p++] = 91;
      i++;
      continue;
    }
    // A control character, DEL or a code unit past ASCII.
    C.p = p;
    putEsc(C, s, i, i + 1, true);
    p = C.p;
    i++;
  }
  C.p = p;
}

/** A whole string rendered inline into C. */
const inlineAll = (s) => inline(s, 0, s.length);

/**
 * A body rendered into C: { html, toc, excerpt }, each a J: its blocks each followed by a newline, its level 2 and 3
 * headings (level, id, html) and its first paragraph's inline HTML (or ""). Lines are read in place, s[ls..le).
 */
function renderMarkdown(src) {
  const n = src.length;
  const ids = new Set();
  const toc = [];
  let exS = -1;
  let exE = -1;
  const start = C.p;
  let ls = 0;
  while (ls <= n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    const c0 = le === ls ? -1 : src.charCodeAt(ls);
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && blankRange(src, ls, le))) {
      ls = le + 1;
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(src.slice(ls, le));
      if (fence !== null) {
        const lang = fence[1];
        put(C, '<pre><code');
        if (lang !== '') {
          put(C, ' class=\\"language-');
          putEsc(C, lang, 0, lang.length, true);
          put(C, '\\"');
        }
        put(C, '>');
        ls = le + 1;
        while (ls <= n) {
          le = src.indexOf('\n', ls);
          if (le === -1) le = n;
          if (le - ls >= 3 && src.charCodeAt(ls) === 96 && FENCE_CLOSE.test(src.slice(ls, le))) break;
          putEsc(C, src, ls, le, true);
          put(C, '\\n');
          ls = le + 1;
        }
        ls = le + 1; // past the closing line, or past the end
        put(C, '</code></pre>\\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(src.slice(ls, le));
      if (h !== null) {
        const depth = h[1].length;
        const text = h[2];
        const id = uniqueSlug(slug(text), ids);
        put(C, `<h${depth} id=\\"${id}\\">`);
        const a = C.p;
        inlineAll(text);
        const b = C.p;
        put(C, `</h${depth}>\\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: new J(a, b) });
        ls = le + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(src.slice(ls, le))) {
        put(C, '<hr>\\n');
        ls = le + 1;
        continue;
      }
    } else if (c0 === 62) {
      let body = '';
      while (ls <= n) {
        le = src.indexOf('\n', ls);
        if (le === -1) le = n;
        if (le === ls || src.charCodeAt(ls) !== 62) break;
        const l = trimLine(src.slice(ls, le).replace(QUOTE_MARK, ''));
        if (l !== '') body = body === '' ? l : `${body}\n${l}`;
        ls = le + 1;
      }
      if (body === '') put(C, '<blockquote>\\n</blockquote>\\n');
      else {
        put(C, '<blockquote>\\n<p>');
        inlineAll(body);
        put(C, '</p>\\n</blockquote>\\n');
      }
      continue;
    }
    const isBullet = c0 === 45 || c0 === 42;
    const first = isBullet || (c0 >= 48 && c0 <= 57) ? (isBullet ? BULLET : ORDERED).exec(src.slice(ls, le)) : null;
    if (first !== null) {
      const marker = isBullet ? BULLET : ORDERED;
      const items = [];
      while (ls <= n) {
        le = src.indexOf('\n', ls);
        if (le === -1) le = n;
        const li = src.slice(ls, le);
        const m = marker.exec(li);
        if (m !== null) items.push(trimLine(isBullet ? m[1] : m[2]));
        else if (li.length > 2 && li.charCodeAt(0) === 32 && CONTINUED.test(li)) items[items.length - 1] += `\n${trimLine(li)}`;
        else break;
        ls = le + 1;
      }
      const start = isBullet ? 1 : Number(first[1]);
      const tag = isBullet ? 'ul' : 'ol';
      put(C, !isBullet && start !== 1 ? `<ol start=\\"${start}\\">\\n` : `<${tag}>\\n`);
      for (let k = 0; k < items.length; k++) {
        put(C, '<li>');
        inlineAll(items[k]);
        put(C, '</li>\\n');
      }
      put(C, `</${tag}>\\n`);
      continue;
    }
    // A paragraph: this line and the next up to one that ends it, each trimmed, joined by "\n". When no line needs
    // trimming the text is the source itself from the first line's start to the last line's end.
    const ps = ls;
    let pe = le;
    let trim = src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9 || src.charCodeAt(le - 1) === 32 || src.charCodeAt(le - 1) === 9;
    ls = le + 1;
    while (ls <= n) {
      le = src.indexOf('\n', ls);
      if (le === -1) le = n;
      if (endsParagraph(src, ls, le)) break;
      const a = src.charCodeAt(ls);
      const z = src.charCodeAt(le - 1);
      if (a === 32 || a === 9 || z === 32 || z === 9) trim = true;
      pe = le;
      ls = le + 1;
    }
    put(C, '<p>');
    const a = C.p;
    if (!trim) inline(src, ps, pe);
    else {
      let text = '';
      let q = ps;
      while (q <= pe) {
        let e = src.indexOf('\n', q);
        if (e === -1 || e > pe) e = pe;
        text = q === ps ? trimLine(src.slice(q, e)) : `${text}\n${trimLine(src.slice(q, e))}`;
        q = e + 1;
      }
      inlineAll(text);
    }
    if (exS === -1) {
      exS = a;
      exE = C.p;
    }
    put(C, '</p>\\n');
  }
  return { html: new J(start, C.p), toc, excerpt: exS === -1 ? new J(0, 0) : new J(exS, exE) };
}

const T_TEXT = 0;
const T_VAR = 1;
const T_RAW = 2;
const T_IF = 3;
const T_FOR = 4;
const T_INCLUDE = 5;
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const TAG_BLANK = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
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
    const standalone = TAG_BLANK.test(src.slice(lineStart, open)) && TAG_BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Every template node has one shape (all fields), so the renderer's property reads stay monomorphic. */
function tnode(k, kind) {
  return { k, kind, text: '', bytes: null, path: null, p0: '', not: false, then: null, else: null, name: '', body: null, target: undefined, free: null, memo: null };
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      const node = tnode(T_TEXT, 'text');
      node.text = tok.text;
      node.bytes = Buffer.from(jsonEsc(tok.text), 'latin1');
      body.push(node);
    } else if (tok.t === 'var' || tok.t === 'raw') {
      const node = tnode(tok.t === 'var' ? T_VAR : T_RAW, tok.t);
      node.path = tok.path;
      node.p0 = tok.path[0];
      body.push(node);
    }
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const path = pathOf(name, m[2]);
        const node = tnode(T_FOR, 'for');
        node.name = m[1];
        node.path = path;
        node.p0 = path[0];
        node.body = [];
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const path = pathOf(name, m[2]);
        const node = tnode(T_IF, 'if');
        node.not = m[1] !== undefined;
        node.path = path;
        node.p0 = path[0];
        node.then = [];
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
      } else if ((m = INCLUDE.exec(tag)) !== null) {
        const node = tnode(T_INCLUDE, 'include');
        node.name = m[1];
        body.push(node);
      }
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The names `nodes` read from the scope they are rendered in (not bound by a loop inside them). */
function freeNames(nodes, bound, freeT, out) {
  for (const n of nodes) {
    switch (n.k) {
      case T_VAR:
      case T_RAW:
        if (!bound.has(n.p0)) out.add(n.p0);
        break;
      case T_IF:
        if (!bound.has(n.p0)) out.add(n.p0);
        freeNames(n.then, bound, freeT, out);
        if (n.else !== null) freeNames(n.else, bound, freeT, out);
        break;
      case T_FOR: {
        if (!bound.has(n.p0)) out.add(n.p0);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        freeNames(n.body, inner, freeT, out);
        break;
      }
      case T_INCLUDE: {
        const f = freeT.get(n.name);
        if (f !== undefined) for (const x of f) if (!bound.has(x)) out.add(x);
        break;
      }
    }
  }
  return out;
}

/** Each include and for node's free names, the includes' by a fixed point over the templates. */
function analyse(templates) {
  const freeT = new Map();
  for (const name of templates.keys()) freeT.set(name, new Set());
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, nodes] of templates) {
      const f = freeNames(nodes, new Set(), freeT, new Set());
      if (f.size !== freeT.get(name).size) {
        freeT.set(name, f);
        changed = true;
      }
    }
  }
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.k === T_IF) {
        visit(n.then);
        if (n.else !== null) visit(n.else);
      } else if (n.k === T_FOR) {
        n.free = [...freeNames([n], new Set(), freeT, new Set())];
        n.memo = [];
        visit(n.body);
      } else if (n.k === T_INCLUDE) {
        n.target = templates.get(n.name);
        n.free = n.target === undefined ? [] : [...freeT.get(n.name)];
        n.memo = [];
      }
    }
  };
  for (const nodes of templates.values()) visit(nodes);
}

/** A scope: the root (loop false, its vars) or a loop's (its name, element x, index k and length len). */
class Scope {
  constructor(loop, vars, name, len, parent) {
    this.loop = loop;
    this.vars = vars;
    this.name = name;
    this.x = null;
    this.k = 0;
    this.len = len;
    this.parent = parent;
  }
}

const ABORT = Symbol('abort');

/** The value of a name for a memo key: ABORT where it is one page's own (page, posts, pager, tag) or a loop's `loop`. */
function keyValue(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    if (s.loop) {
      if (name === 'loop') return ABORT;
      if (name === s.name) return s.x;
    } else if (hasOwn(s.vars, name)) {
      return name === 'site' || name === 'tags' || name === 'recent' ? s.vars[name] : ABORT;
    }
  }
  return undefined;
}

function lookup(scope, node) {
  const p0 = node.p0;
  let v;
  let s = scope;
  for (; s !== null; s = s.parent) {
    if (s.loop) {
      if (p0 === 'loop') return loopValue(s, node.path);
      if (p0 === s.name) {
        v = s.x;
        break;
      }
    } else if (hasOwn(s.vars, p0)) {
      v = s.vars[p0];
      break;
    }
  }
  if (s === null) return undefined;
  const path = node.path;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function loopValue(s, path) {
  if (path.length === 1) return { index: s.k + 1, first: s.k === 0, last: s.k === s.len - 1, length: s.len };
  if (path.length > 2) return undefined;
  switch (path[1]) {
    case 'index': return s.k + 1;
    case 'first': return s.k === 0;
    case 'last': return s.k === s.len - 1;
    case 'length': return s.len;
    default: return undefined;
  }
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof J) return plainOf(v);
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof J) return v[JE] > v[JS];
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A memoised rendering: the bytes W.b[s..e) of this build. */
class Range {
  constructor(s, e) {
    this.s = s;
    this.e = e;
  }
}

const ONLY = Symbol('only');

/** The memo entry for `node` at `depth` in `scope`: a Range, undefined (none yet) or ABORT (not memoised here). */
function memoGet(node, scope, depth) {
  const free = node.free;
  let m = node.memo[depth];
  if (m === undefined) m = node.memo[depth] = new Map();
  if (free.length === 0) return m.get(ONLY);
  for (let i = 0; i < free.length; i++) {
    const kv = keyValue(scope, free[i]);
    if (kv === ABORT) return ABORT;
    if (i === free.length - 1) return m.get(kv);
    const next = m.get(kv);
    if (next === undefined) return undefined;
    m = next;
  }
  return undefined;
}

function memoSet(node, scope, depth, range) {
  const free = node.free;
  let m = node.memo[depth];
  if (free.length === 0) {
    m.set(ONLY, range);
    return;
  }
  for (let i = 0; i < free.length; i++) {
    const kv = keyValue(scope, free[i]);
    if (i === free.length - 1) {
      m.set(kv, range);
      return;
    }
    let next = m.get(kv);
    if (next === undefined) m.set(kv, (next = new Map()));
    m = next;
  }
}

/** Earlier bytes of this build written again (one memcpy). */
function putRange(r) {
  const n = r.e - r.s;
  if (W.p + n > W.b.length) grow(W, n);
  W.p += W.b.copy(W.b, W.p, r.s, r.e);
}

/** A J's bytes copied from C. */
function putJ(v) {
  const s = v[JS];
  const n = v[JE] - s;
  if (W.p + n > W.b.length) grow(W, n);
  W.p += C.b.copy(W.b, W.p, s, s + n);
}

/** `nodes` rendered into W in `scope`. */
function renderNodes(nodes, scope, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.k) {
      case T_TEXT:
        putBytes(W, n.bytes);
        break;
      case T_VAR: {
        const v = lookup(scope, n);
        const t = typeof v === 'string' ? v : textOf(v);
        putEsc(W, t, 0, t.length, true);
        break;
      }
      case T_RAW: {
        const v = lookup(scope, n);
        if (v instanceof J) putJ(v);
        else {
          const t = textOf(v);
          putEsc(W, t, 0, t.length, false);
        }
        break;
      }
      case T_IF: {
        const branch = truthy(lookup(scope, n)) !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, depth);
        break;
      }
      case T_FOR: {
        const hit = memoGet(n, scope, depth);
        if (hit !== undefined && hit !== ABORT) {
          putRange(hit);
          break;
        }
        const s = W.p;
        const xs = lookup(scope, n);
        if (Array.isArray(xs)) {
          const ls = new Scope(true, null, n.name, xs.length, scope);
          for (let k = 0; k < xs.length; k++) {
            ls.x = xs[k];
            ls.k = k;
            renderNodes(n.body, ls, depth);
          }
        }
        if (hit !== ABORT) memoSet(n, scope, depth, new Range(s, W.p));
        break;
      }
      case T_INCLUDE: {
        if (n.target === undefined || depth >= INCLUDE_DEPTH) break;
        const hit = memoGet(n, scope, depth);
        if (hit !== undefined && hit !== ABORT) {
          putRange(hit);
          break;
        }
        const s = W.p;
        renderNodes(n.target, scope, depth + 1);
        if (hit !== ABORT) memoSet(n, scope, depth, new Range(s, W.p));
        break;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ the build

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

/** One site built and its answer written into W as JSON text: { "path": "text", ... }. */
function build(input) {
  slugMemo = new Map();
  C.p = 0;
  const dateMemo = new Map();
  const dateLong = (d) => {
    let s = dateMemo.get(d);
    if (s === undefined) dateMemo.set(d, (s = longDate(d)));
    return s;
  };

  // Templates, in code-unit order of their names.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  analyse(templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources and statics, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const statics = [];
  let sources = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = frontMatter(s.text);
    if (fm.error !== undefined) {
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
    if (s.post && !hasOwn(s.data, 'date')) {
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
    let t = taken.get(dir);
    if (t === undefined) taken.set(dir, (t = new Set(dir === '' ? ['posts', 'tags', 'page'] : [])));
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), t);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  B_bySource = bySource;
  B_static = new Set(statics.map((f) => f.path));
  B_base = base;
  const broken = (B_broken = new Set());
  for (const s of sources) {
    B_dir = dirOf(s.path);
    B_from = s.path;
    const md = renderMarkdown(s.body);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const names = s.data.tags;
    if (names === undefined || names.length === 0) return [];
    const seen = new Set();
    const out = [];
    for (const name of names) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) bySlug.set(sl, (tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] }));
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts, each output written as it is rendered: `"path":"text"`. Built outputs never share a path (each
  // directory's slugs are unique, and tags/, page/ and the reserved root names are the generator's own), so the
  // reference's later assignments never overwrite an earlier page; `written` holds the paths for the statics' check.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateLong(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const written = new Set();
  let first = true;
  const key = (path) => {
    put(W, first ? '{"' : ',"');
    first = false;
    putEsc(W, path, 0, path.length, false);
    put(W, '":"');
    written.add(path);
  };
  const render = (path, name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return;
    key(path);
    renderNodes(nodes, new Scope(false, { site, tags: allTags, recent, ...vars }, '', 0, null), 0);
    put(W, '"');
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    render(`${s.outDir}/index.html`, s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    render(k === 1 ? 'index.html' : `page/${k}/index.html`, 'index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
  }
  for (const t of tagList) render(`tags/${t.slug}/index.html`, 'tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
  render('tags/index.html', 'tags', {});
  for (const f of statics) {
    if (written.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    // The reference's output[f.path] = content: "__proto__" sets no property, and the report replaces its own path.
    else if (f.path !== '__proto__' && f.path !== 'build-report.txt') {
      key(f.path);
      putEsc(W, f.content, 0, f.content.length, false);
      put(W, '"');
    } else if (f.path === 'build-report.txt') written.add(f.path);
  }

  // 8. The report.
  const lines = [...report, ...broken].sort();
  let nPages = 0;
  for (const s of sources) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  const text = `${lines.join('\n')}\n`;
  key('build-report.txt');
  putEsc(W, text, 0, text.length, false);
  put(W, '"}');
}

// One build's state, read by the Markdown pass's link and slug functions (set at the start of each build).
let slugMemo = new Map();
let B_bySource = new Map();
let B_static = new Set();
let B_broken = new Set();
let B_base = '';
let B_dir = '';
let B_from = '';

function slug(t) {
  let s = slugMemo.get(t);
  if (s === undefined) slugMemo.set(t, (s = slugOf(t)));
  return s;
}

/** A link's href from the current source (B_dir, B_from), a broken one reported. */
function linkTo(target) {
  if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(B_dir, rel);
  if (path !== null) {
    const hit = B_bySource.get(path);
    if (hit !== undefined) return `${hit.url}${frag}`;
    if (B_static.has(path)) return `${B_base}/${path}${frag}`;
  }
  B_broken.add(`broken-link ${B_from} -> ${target}`);
  return target;
}

/**
 * One case's answer as JSON text (ASCII only, the value JSON.stringify(run(input)) reads back as), written into a
 * buffer that flush(buffer, length) receives before this returns; the buffer is reused afterwards.
 */
export function emitJSON(input, flush) {
  W.p = 0;
  build(input);
  flush(W.b, W.p);
  W.p = 0;
}

/** makefun-site 1.0.0's answer for one case's input: its output tree, { path: text }. */
export function run(input) {
  let text = '';
  emitJSON(input, (b, n) => {
    text = b.latin1Slice(0, n);
  });
  return JSON.parse(text);
}
