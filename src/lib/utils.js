// Utility functions — extracted from index.html

export function decodeHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function bestImg(arr, size = '150x150') {
  if (!arr) return '';
  if (typeof arr === 'string') return arr.replace(/\d+x\d+/, size);
  const sorted = [...arr].sort((a, b) => {
    const sizeOf = u => { const m = (u.link || u.url || u || '').match(/(\d+)x\d+/); return m ? parseInt(m[1]) : 0; };
    return sizeOf(b) - sizeOf(a);
  });
  const target = parseInt(size);
  const pick = sorted.find(u => {
    const m = (u.link || u.url || u || '').match(/(\d+)x\d+/);
    return m && parseInt(m[1]) <= target * 2;
  }) || sorted[sorted.length - 1];
  return (pick?.link || pick?.url || pick || '').replace(/\d+x\d+/, size);
}

// LRU song cache — max 300 entries
const _songCache = new Map();
export function cacheSong(s) {
  if (!s?.id) return;
  _songCache.delete(s.id);
  _songCache.set(s.id, s);
  if (_songCache.size > 300) _songCache.delete(_songCache.keys().next().value);
}
export function cacheSongs(arr) { arr?.forEach(cacheSong); }

// AbortSignal.timeout polyfill for iOS < 16
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = ms => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return c.signal;
  };
}
