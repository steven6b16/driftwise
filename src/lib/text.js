// Text helpers: turn Jira ADF and Confluence storage format into plain text the
// model can read, and check that quotes the model returns really exist.

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow', 'panel', 'rule',
]);

export function adfToText(node, depth = 0) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth)).join('');
  const { type, text, content, attrs } = node;
  if (type === 'text') return text || '';
  if (type === 'hardBreak') return '\n';
  if (type === 'mention') return attrs?.text || '@user';
  if (type === 'inlineCard' || type === 'blockCard') return attrs?.url ? ` ${attrs.url} ` : '';
  if (type === 'emoji') return attrs?.text || '';
  const inner = adfToText(content || [], depth + 1);
  if (type === 'heading') return `\n${'#'.repeat(attrs?.level || 2)} ${inner.trim()}\n`;
  if (type === 'listItem') return `\n${'  '.repeat(Math.max(0, depth - 2))}- ${inner.trim()}`;
  if (type === 'tableCell' || type === 'tableHeader') return ` | ${inner.trim()}`;
  if (BLOCK_TYPES.has(type)) return `\n${inner.trim()}\n`;
  return inner;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

export function storageToText(html = '') {
  return html
    .replace(/<ac:structured-macro[^>]*ac:name="(?:toc|children|jira)"[\s\S]*?<\/ac:structured-macro>/g, '')
    .replace(/<h([1-6])[^>]*>/g, (_, l) => `\n${'#'.repeat(Number(l))} `)
    .replace(/<\/h[1-6]>/g, '\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<\/(p|div|tr|li|ul|ol|table|blockquote)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<t[dh][^>]*>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => {
      if (e.startsWith('#')) return String.fromCharCode(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function normalize(s = '') {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9À-￿'"%$.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A quote counts as verified when its normalised words appear in the source,
// either verbatim or (for long quotes) with at least 85% of word 4-grams present.
export function verifyQuote(quote, source) {
  if (!quote || !source) return false;
  const q = normalize(quote).replace(/\.\.\.|…/g, ' ').replace(/\s+/g, ' ').trim();
  const s = normalize(source);
  if (!q) return false;
  if (s.includes(q)) return true;
  const words = q.split(' ');
  if (words.length < 6) return false;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 4 <= words.length; i += 1) {
    total += 1;
    if (s.includes(words.slice(i, i + 4).join(' '))) hit += 1;
  }
  return total > 0 && hit / total >= 0.85;
}

export function truncate(s = '', max = 12000) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} characters]`;
}

export function hashString(s = '') {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const PAGE_ID_PATTERNS = [
  /\/wiki\/spaces\/[^/\s]+\/pages\/(\d+)/,
  /\/wiki\/pages\/viewpage\.action\?pageId=(\d+)/,
  /[?&]pageId=(\d+)/,
  /\/wiki\/x\/[A-Za-z0-9_-]+/,
];

export function extractPageIds(text = '') {
  const ids = new Set();
  const urls = text.match(/https?:\/\/[^\s)"'<>\]]+/g) || [];
  for (const url of urls) {
    for (const p of PAGE_ID_PATTERNS.slice(0, 3)) {
      const m = url.match(p);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids];
}
