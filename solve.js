// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the answer
// makefun-site 1.0.0's build returns for the same input, as a JSON object of
// path -> text. Reimplemented from makefun-site's README and reference code
// (MIT, make.fun), restructured for speed: direct single-pass Markdown
// rendering with no token objects, a flat-op template interpreter with
// per-iteration allocation eliminated, per-case caching of page-independent
// includes (header/nav/footer render once per case, not once per page), an
// ASCII fast path for slugify plus a per-case slug cache, and whole-run HTML
// escaping instead of per-character escaping.
//
// Nothing is cached from one case to the next: every cache below is created
// fresh inside run() and dropped with it. No clock, no environment, no
// randomness, no file access: the output is a function of the input alone.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text`, exactly as makefun-site's slugify. */
function slugifyRaw(text) {
  // NFKD is the identity on ASCII, and ASCII holds no combining marks, so
  // the ASCII-only path skips normalize() and the mark strip entirely.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i !== 4 && i !== 7 && !isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
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
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
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
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter from its lines: { data, bodyStart }, or { error }.
 * `lines` is the source text split on "\n" (line ends already made "\n").
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    for (let j = 0; j < key.length; j++) {
      const c = key.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || c === 95)) return { error: `line ${i + 1} is not "key: value"` };
    }
    const rest = line.slice(ci + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) {
      raw = rest.slice(1);
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      raw = raw.slice(0, e);
    } else return { error: `line ${i + 1} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

// The characters a backslash escapes.
const ESCAPABLE = '\\`*_[]()#+-.!>';

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `ctx` resolves a link target to its href. */
function inline(s, ctx) {
  // A fresh regex per call: inline recurses (strong, emphasis, link text),
  // and a shared /g regex would have its lastIndex clobbered by the inner call.
  const re = /[\\`*\[&<>"']/g;
  let out = null;
  let i = 0;
  let start = 0;
  const n = s.length;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j < i) continue;
    if (out === null) out = [];
    if (j > start) out.push(s.slice(start, j));
    const c = s[j];
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.indexOf(d) !== -1) {
        out.push(d === '>' ? '&gt;' : d);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>', inline(s.slice(j + 2, k), ctx), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>', inline(s.slice(j + 1, k), ctx), '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnesc(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(linkHref(ctx, target)), '">', inline(s.slice(j + 1, k), ctx), '</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    } else {
      out.push(ESCAPES[c]);
      i = j + 1;
    }
    start = i;
    re.lastIndex = i;
  }
  if (out === null) return s;
  if (start < n) out.push(s.slice(start));
  return out.join('');
}

/** Trim spaces and tabs at both ends of a line. */
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
  return line.slice(a, b);
}

/** Whether `line` is a fence opening; its language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(d));
  return text === '' ? null : { depth: d, text };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const cc = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && cc === 45) || (a === 42 && b === 42 && cc === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && /\S/.test(line[j]);
}

/**
 * `lines[start..]` rendered: its HTML, its table of contents (level 2 and 3
 * headings) and its excerpt (the first paragraph's inline HTML, or "").
 * `ctx` resolves link targets; `slugify` is the case's cached slug function.
 */
function renderMarkdown(lines, start, ctx, slugify) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, ctx);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), ctx)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    let ordered = false;
    let oStart = 1;
    if (!bullet) {
      let j = 0;
      let digits = 0;
      while (j < line.length && digits < 9 && isDigit(line.charCodeAt(j))) {
        j++;
        digits++;
      }
      if (digits > 0 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        ordered = true;
        oStart = Number(line.slice(0, j));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (ordered) {
          let j = 0;
          let digits = 0;
          while (j < l.length && digits < 9 && isDigit(l.charCodeAt(j))) {
            j++;
            digits++;
          }
          if (digits > 0 && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) {
            items.push([trimLine(l.slice(j + 2))]);
            i++;
            continue;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && oStart !== 1 ? `<ol start="${oStart}">` : `<${tag}>`;
      let b = `${open}\n`;
      for (let k = 0; k < items.length; k++) b += `<li>${inline(items[k].join('\n'), ctx)}</li>\n`;
      blocks.push(`${b}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  // The body's words: runs of characters other than whitespace. A word never
  // spans a line break, so counting per line and summing is exact. A manual
  // scan beats a /\S+/g match here: no match array is built per line.
  for (let k = start; k < n; k++) {
    const line = lines[k];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
      const raw = src.charCodeAt(open + 2) === 123;
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

// Flat ops: 0 text {s} · 1 var {p} · 2 raw {p} · 3 if {p, not, e, end}
//            4 for {name, p, end, frame} · 5 include {name}
function compileTemplate(name, src) {
  const ops = [];
  const stack = [];
  let loopDepth = 0;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') ops.push({ t: 0, s: tok.text });
    else if (tok.t === 'var') ops.push({ t: 1, p: tok.path });
    else if (tok.t === 'raw') ops.push({ t: 2, p: tok.path });
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const op = { t: 4, name: m[1], p: pathOf(name, m[2]), end: -1, frame: null };
        op.frame = { vars: { [m[1]]: undefined, loop: { index: 0, first: false, last: false, length: 0 } }, parent: null };
        ops.push(op);
        stack.push(op);
        loopDepth++;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const op = { t: 3, p: pathOf(name, m[2]), not: m[1] !== undefined, e: -1, end: -1 };
        ops.push(op);
        stack.push(op);
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.t !== 3 || top.e !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
        top.e = ops.length;
      } else if (tag === 'endfor' || tag === 'endif') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.t !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        top.end = ops.length;
        stack.pop();
        if (tag === 'endfor') loopDepth--;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) ops.push({ t: 5, name: m[1], inLoop: loopDepth > 0 });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].t === 4 ? 'for' : 'if'} is not closed`);
  return { ops, free: null, isConst: false, memoVars: null, memo: null, cached: null, cachedDepth: -1 };
}

/** The free variable roots of `ops[from..to)`, given `bound` loop names. */
function freeOfOps(ops, from, to, bound, freeMap) {
  const out = new Set();
  for (let pc = from; pc < to; pc++) {
    const n = ops[pc];
    if (n.t === 1 || n.t === 2) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
    } else if (n.t === 3) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
      const mid = n.e === -1 ? n.end : n.e;
      for (const v of freeOfOps(ops, pc + 1, mid, bound, freeMap)) out.add(v);
      if (n.e !== -1) for (const v of freeOfOps(ops, n.e, n.end, bound, freeMap)) out.add(v);
      pc = n.end - 1;
    } else if (n.t === 4) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      for (const v of freeOfOps(ops, pc + 1, n.end, b2, freeMap)) out.add(v);
      pc = n.end - 1;
    } else if (n.t === 5) {
      const f = freeMap.get(n.name);
      if (f !== undefined) for (const v of f) out.add(v);
    }
  }
  return out;
}

/** Every template's free roots, by fixpoint over the include graph. */
function computeFree(templates) {
  const freeMap = new Map();
  for (const name of templates.keys()) freeMap.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, tpl] of templates) {
      const s = freeOfOps(tpl.ops, 0, tpl.ops.length, new Set(), freeMap);
      const cur = freeMap.get(name);
      for (const v of s) {
        if (!cur.has(v)) {
          cur.add(v);
          changed = true;
        }
      }
    }
  }
  for (const [name, tpl] of templates) {
    tpl.free = freeMap.get(name);
    tpl.isConst = [...tpl.free].every((v) => v === 'site' || v === 'tags' || v === 'recent');
    // Memoize only a template some loop includes (one rendered again and
    // again for different elements): a top-level include renders once per
    // page, so memoizing it only pays the bookkeeping. Never memoize on
    // `loop`: its object is mutated per turn.
    let loopIncluded = false;
    for (const [, other] of templates) {
      for (const op of other.ops) {
        if (op.t === 5 && op.name === name && op.inLoop) {
          loopIncluded = true;
          break;
        }
      }
      if (loopIncluded) break;
    }
    tpl.memoVars = tpl.free.has('loop') || !loopIncluded
      ? null
      : [...tpl.free].filter((v) => v !== 'site' && v !== 'tags' && v !== 'recent');
    tpl.memo = new Map();
  }
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  if (path.length === 1) return s.vars[path[0]];
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether any non-root scope frame binds site, tags or recent. */
function shadowed(scope) {
  let s = scope;
  while (s !== null && s.parent !== null) {
    const v = s.vars;
    if (Object.hasOwn(v, 'site') || Object.hasOwn(v, 'tags') || Object.hasOwn(v, 'recent')) return true;
    s = s.parent;
  }
  return false;
}

const INCLUDE_DEPTH = 8;

/** Sentinel key for a memoized include's stored {depth, str} leaf. */
const MEMO_LEAF = {};

function renderOps(ops, from, to, scope, ctx, depth, out) {
  for (let pc = from; pc < to; pc++) {
    const n = ops[pc];
    if (n.t === 0) out.push(n.s);
    else if (n.t === 1) out.push(escapeHtml(textOf(lookup(scope, n.p))));
    else if (n.t === 2) out.push(textOf(lookup(scope, n.p)));
    else if (n.t === 3) {
      const takeThen = truthy(lookup(scope, n.p)) !== n.not;
      if (takeThen) {
        const end = n.e === -1 ? n.end : n.e;
        if (pc + 1 < end) renderOps(ops, pc + 1, end, scope, ctx, depth, out);
      } else if (n.e !== -1) {
        renderOps(ops, n.e, n.end, scope, ctx, depth, out);
      }
      pc = n.end - 1;
    } else if (n.t === 4) {
      const xs = lookup(scope, n.p);
      if (Array.isArray(xs)) {
        const frame = n.frame;
        const vars = frame.vars;
        const loop = vars.loop;
        // The frame is reused across iterations; save and restore it so a
        // template that includes itself (depth-limited) cannot corrupt an
        // enclosing iteration's bindings.
        const prevX = vars[n.name];
        const prevParent = frame.parent;
        const prevIndex = loop.index;
        const prevFirst = loop.first;
        const prevLast = loop.last;
        const prevLength = loop.length;
        loop.length = xs.length;
        frame.parent = scope;
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderOps(ops, pc + 1, n.end, frame, ctx, depth, out);
        }
        vars[n.name] = prevX;
        frame.parent = prevParent;
        loop.index = prevIndex;
        loop.first = prevFirst;
        loop.last = prevLast;
        loop.length = prevLength;
      }
      pc = n.end - 1;
    } else {
      const tpl = ctx.templates.get(n.name);
      if (tpl !== undefined && depth < INCLUDE_DEPTH) {
        if (tpl.isConst) {
          // Page-independent: render once per case (at a fixed depth, with
          // no loop binding shadowing site/tags/recent) and reuse the text.
          if (tpl.cached !== null && tpl.cachedDepth === depth && !shadowed(scope)) {
            out.push(tpl.cached);
          } else {
            const tmp = [];
            renderOps(tpl.ops, 0, tpl.ops.length, scope, ctx, depth + 1, tmp);
            const str = tmp.join('');
            if (!shadowed(scope)) {
              tpl.cached = str;
              tpl.cachedDepth = depth;
            }
            out.push(str);
          }
        } else if (tpl.memoVars !== null && !shadowed(scope)) {
          // Depends only on the case constants plus the resolved values of
          // its free roots: memoize on those values (objects by identity).
          let node = tpl.memo;
          for (let vi = 0; vi < tpl.memoVars.length; vi++) {
            const v = lookup(scope, [tpl.memoVars[vi]]);
            let nx = node.get(v);
            if (nx === undefined) {
              nx = new Map();
              node.set(v, nx);
            }
            node = nx;
          }
          const hit = node.get(MEMO_LEAF);
          if (hit !== undefined && hit.depth === depth) out.push(hit.str);
          else {
            const tmp = [];
            renderOps(tpl.ops, 0, tpl.ops.length, scope, ctx, depth + 1, tmp);
            const str = tmp.join('');
            node.set(MEMO_LEAF, { depth, str });
            out.push(str);
          }
        } else {
          renderOps(tpl.ops, 0, tpl.ops.length, scope, ctx, depth + 1, out);
        }
      }
    }
  }
}

// -------------------------------------------------------------------- links

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
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

/** A link target's href, resolving page and static targets, reporting the broken. */
function linkHref(ctx, target) {
  let i = 0;
  const first = target.charCodeAt(0);
  if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
    i = 1;
    while (i < target.length) {
      const c = target.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
      else break;
    }
    if (target.charCodeAt(i) === 58) return target;
  }
  if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dir, rel);
  if (path !== null && ctx.bySource.has(path)) return `${ctx.bySource.get(path).url}${frag}`;
  if (path !== null && ctx.staticPaths.has(path)) return `${ctx.base}/${path}${frag}`;
  ctx.broken.add(`broken-link ${ctx.srcPath} -> ${target}`);
  return target;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// -------------------------------------------------------------------- build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  computeFree(templates);

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content;
      sources.push({ path: f.path, lines: text.indexOf('\r') === -1 ? text.split('\n') : text.replace(/\r\n?/g, '\n').split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
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

  // 3. Each page's output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const ctx = { dir: dirOf(s.path), bySource, staticPaths, base, broken, srcPath: s.path };
    const md = renderMarkdown(s.lines, s.bodyStart, ctx, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
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
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
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
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const tpl = templates.get(name);
    if (tpl === undefined) return null;
    const out = [];
    renderOps(tpl.ops, 0, tpl.ops.length, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) {
    const page = cardOf(s);
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    page.newer = linkOf(s.newer ?? null);
    page.older = linkOf(s.older ?? null);
    page.is_post = s.post;
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

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
