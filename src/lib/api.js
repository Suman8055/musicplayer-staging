// api.js — JioSaavn API layer. Extracted from index.html.
// CORS rules: SIGMA_API is open. SAAVN_API has NO CORS — never use for browser fetches.
import { decodeHtml, bestImg } from './utils.js';
import { Log } from './logger.js';


export const APP_VERSION = '5.2.67';
export const STORE_KEY   = 'mbx_v2';
export const ENV_KEY     = 'mbx_env';
// DES-ECB key removed — was dead code from the old SAAVN stream URL decryption path.

const ENVS = {
  production: { sigma: 'https://jiosaavn-api-sigma-sandy.vercel.app', saavn: 'https://saavn.8man.dev' },
  staging:    { sigma: 'https://jiosaavn-api-sigma-sandy.vercel.app', saavn: 'https://saavn.8man.dev' },
};

export function getEnv()    { return (typeof localStorage !== 'undefined' && localStorage.getItem(ENV_KEY)) || 'production'; }
export function isStaging() { return getEnv() === 'staging'; }
export function getEnvCfg() { return ENVS[getEnv()] || ENVS.production; }
export function setEnv(env) { if (typeof localStorage !== 'undefined') localStorage.setItem(ENV_KEY, env); }

export let SIGMA_API = getEnvCfg().sigma;
export let SAAVN_API = getEnvCfg().saavn; // NO CORS — never use for browser fetches

export const ALLOWED_LANGUAGES = new Set(['english', 'hindi', 'telugu', 'tamil', 'punjabi']);

export const LANG_TILES = [
  { lang: 'hindi',   label: 'Hindi' },
  { lang: 'english', label: 'English' },
  { lang: 'telugu',  label: 'Telugu' },
  { lang: 'tamil',   label: 'Tamil' },
  { lang: 'punjabi', label: 'Punjabi' },
];

// CORS proxies for JioSaavn autocomplete fallback only
const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

export async function proxyFetch(url) {
  let last;
  const deadline = AbortSignal.timeout(9000);
  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy(url), { signal: deadline });
      if (r.ok) return r;
      last = new Error('proxy_' + r.status);
    } catch (e) { last = e; if (deadline.aborted) break; }
  }
  throw last || new Error('All proxies failed');
}

export async function apiFetch(url, { timeout = 7000, retries = 1 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (r.ok) return r;
      last = new Error('HTTP ' + r.status);
    } catch (e) {
      last = e;
      if (i < retries) await new Promise(r => setTimeout(r, (i + 1) * 1000));
    }
  }
  throw last;
}

// ── Language classification ────────────────────────────────────────────────────
export function detectScript(text) {
  if (!text) return null;
  if (/[ऀ-ॿ]/.test(text)) return 'devanagari';
  if (/[ఀ-౿]/.test(text)) return 'telugu';
  if (/[஀-௿]/.test(text)) return 'tamil';
  if (/[਀-੿]/.test(text)) return 'gurmukhi';
  return 'latin';
}

export function classifyLanguage(song) {
  const tag = (song.language || '').toLowerCase().trim();
  if (ALLOWED_LANGUAGES.has(tag)) return tag;
  const script = detectScript(song.name + ' ' + song.artist);
  // Non-allowlist tag (e.g. "pop", "western"): trust Latin script as English
  if (tag) return script === 'latin' ? 'english' : null;
  // No tag: fall back to script detection
  if (script === 'telugu') return 'telugu';
  if (script === 'tamil')  return 'tamil';
  if (script === 'devanagari') return 'hindi';
  if (script === 'gurmukhi')   return 'punjabi';
  return script === 'latin' ? 'english' : null;
}

// F27: parseInt on a non-numeric/undefined duration yields NaN, which JSON.stringify
// serialises as null and leaks into liked/downloaded records. Coerce to a safe integer.
function safeDuration(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function filterByLanguage(songs, activeLang = '') {
  if (activeLang === 'english') return songs.filter(s => s._lang === 'english' || s._lang === null);
  if (activeLang) return songs.filter(s => s._lang === activeLang);
  // F4: no active language → keep everything allowlisted PLUS unknown (_lang === null).
  // Fallback-search results (autocomplete path) all carry _lang === null; the old
  // filter dropped every one of them, silently starving SmartPlay queue fills.
  return songs.filter(s => s._lang === null || (s._lang && ALLOWED_LANGUAGES.has(s._lang)));
}

function normSigmaSong(s) {
  const pa = s.primaryArtists;
  // F26: an empty primaryArtists array yielded '' → artist key 'n:' → intel never
  // tracked the play. Fall back to artistMap for the array-but-empty case too.
  let artist = Array.isArray(pa)
    ? pa.map(a => a.name || '').filter(Boolean).join(', ')
    : decodeHtml(pa || '');
  if (!artist) artist = decodeHtml(s.artistMap?.primary?.[0]?.name || '');
  const song = {
    id:       s.id,
    name:     decodeHtml(s.name || s.title || ''),
    artist,
    album:    decodeHtml(s.album?.name || s.album || ''),
    language: s.language || '',
    image:    bestImg(s.image, '150x150'),
    duration: safeDuration(s.duration),
  };
  song._lang = classifyLanguage(song);
  return song;
}

// ── Search ────────────────────────────────────────────────────────────────────
async function _searchFallback(q, limit = 20) {
  const r = await proxyFetch(
    `https://www.jiosaavn.com/api.php?__call=autocomplete.get&query=${encodeURIComponent(q)}&_format=json&_marker=0&ctx=wap6dot0`
  );
  if (!r.ok) return [];
  const data = await r.json();
  return (data?.songs?.data || []).slice(0, limit).map(s => ({
    id:       s.id,
    name:     decodeHtml(s.title || ''),
    artist:   decodeHtml(s.more_info?.primary_artists || s.more_info?.singers || ''),
    album:    decodeHtml(s.album || ''),
    image:    (s.image || '').replace('50x50', '150x150'),
    duration: safeDuration(s.more_info?.duration),
    _lang:    null,
  }));
}

export async function searchSongs(q, limit = 20) {
  try {
    const r = await apiFetch(`${SIGMA_API}/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`, { timeout: 7000, retries: 1 });
    const data = await r.json();
    const results = data.data?.results;
    if (data.status === 'SUCCESS' && results?.length) return results.map(normSigmaSong);
  } catch (e) { Log.warn('searchSongs: sigma failed, using fallback', { q, err: e?.message }); }
  return _searchFallback(q, limit);
}

export async function searchAlbums(q, limit = 15) {
  try {
    const r = await apiFetch(`${SIGMA_API}/search/albums?query=${encodeURIComponent(q)}&page=1&limit=${limit}`, { timeout: 7000, retries: 1 });
    const data = await r.json();
    const results = data.data?.results;
    if (data.status === 'SUCCESS' && results?.length) {
      return results.map(al => ({
        id:       al.id,
        name:     decodeHtml(al.name || ''),
        subtitle: Array.isArray(al.primaryArtists) ? al.primaryArtists.map(a => a.name).join(', ') : decodeHtml(al.primaryArtists || al.language || 'Album'),
        image:    bestImg(al.image, '150x150'),
      }));
    }
  } catch (e) { Log.warn('searchAlbums failed', { q, err: e?.message }); }
  return [];
}

export async function searchArtists(q, limit = 10) {
  try {
    const r = await apiFetch(`${SIGMA_API}/search/artists?query=${encodeURIComponent(q)}&page=1&limit=${limit}`, { timeout: 7000, retries: 1 });
    const data = await r.json();
    const results = data.data?.results;
    if (data.status === 'SUCCESS' && results?.length) {
      return results.map(a => ({ id: a.id, name: decodeHtml(a.name || ''), subtitle: a.role || 'Artist', image: bestImg(a.image, '150x150') }));
    }
  } catch (e) { Log.warn('searchArtists failed', { q, err: e?.message }); }
  return [];
}

export async function searchPlaylists(q, limit = 15) {
  try {
    const r = await apiFetch(`${SIGMA_API}/search/playlists?query=${encodeURIComponent(q)}&page=1&limit=${limit}`, { timeout: 7000, retries: 1 });
    const data = await r.json();
    const results = data.data?.results;
    if (data.status === 'SUCCESS' && results?.length) {
      return results.map(pl => ({ id: pl.id, name: decodeHtml(pl.name || ''), subtitle: pl.songCount ? `${pl.songCount} songs` : (pl.language || 'Playlist'), image: bestImg(pl.image, '150x150') }));
    }
  } catch (e) { Log.warn('searchPlaylists failed', { q, err: e?.message }); }
  return [];
}

export async function fetchArtistSongs(artistName, limit = 30) {
  return searchSongs(artistName, limit);
}

export async function fetchArtistTopSongs(artistId, limit = 20) {
  try {
    const r = await apiFetch(`${SIGMA_API}/artists/${encodeURIComponent(artistId)}/songs?page=0&n=${limit}&sortBy=popularity`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') return (data.data?.songs || data.data?.results || []).map(normSigmaSong);
  } catch (e) { Log.warn('fetchArtistTopSongs failed', { artistId, err: e.message }); }
  return [];
}

export async function fetchArtistAlbums(artistId, limit = 10) {
  try {
    const r = await apiFetch(`${SIGMA_API}/artists/${encodeURIComponent(artistId)}/albums?page=0&n=${limit}&sortBy=popularity`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      return (data.data?.albums || data.data?.results || []).map(al => ({
        id:       al.id,
        name:     decodeHtml(al.name || al.title || ''),
        subtitle: decodeHtml(al.description || al.year || ''),
        image:    bestImg(al.image, '150x150'),
        type:     'album',
      }));
    }
  } catch (e) { Log.warn('fetchArtistAlbums failed', { artistId, err: e.message }); }
  return [];
}

export async function fetchArtistMeta(artistId) {
  try {
    const r = await apiFetch(`${SIGMA_API}/artists/${encodeURIComponent(artistId)}`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      const a = data.data;
      return {
        name:      decodeHtml(a.name || ''),
        image:     bestImg(a.image, '500x500'),
        bio:       a.bio ? decodeHtml(Array.isArray(a.bio) ? a.bio.map(b => b.text).join(' ') : String(a.bio)) : '',
        followers: a.followerCount || a.fans || '',
      };
    }
  } catch (e) { Log.warn('fetchArtistMeta failed', { artistId, err: e.message }); }
  return null;
}

// ── Stream URL ────────────────────────────────────────────────────────────────
const streamCache = new Map();
// In-flight deduplication: if two callers request the same id concurrently,
// both await the same Promise instead of firing duplicate network requests.
const _streamInflight = new Map();
const QUALITY_RANK = { '320kbps': 5, '160kbps': 4, '96kbps': 3, '48kbps': 2, '12kbps': 1 };

export function getNetworkQuality() {
  const c = navigator.connection;
  if (!c) return '320kbps';
  if (c.saveData) return '96kbps';
  const t = c.effectiveType;
  if (t === 'slow-2g' || t === '2g') return '96kbps';
  if (t === '3g' || (c.downlink > 0 && c.downlink < 1.5)) return '160kbps';
  return '320kbps';
}

async function fetchStream(id) {
  const r = await fetch(`${SIGMA_API}/songs?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('SIGMA stream HTTP ' + r.status);
  const data = await r.json();
  const song = Array.isArray(data?.data) ? data.data[0] : null;
  if (!song) throw new Error('No song in SIGMA response');
  const targetTier = QUALITY_RANK[getNetworkQuality()];
  const urls = (song.downloadUrl || []).slice().sort((a, b) => (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0));
  const best = urls.find(u => (QUALITY_RANK[u.quality] || 0) <= targetTier) || urls[urls.length - 1];
  if (!best?.link) throw new Error('No stream link in SIGMA response');
  return { url: best.link, quality: best.quality, image: bestImg(song.image, '500x500'), duration: parseInt(song.duration || 0) };
}

export async function apiStream(id) {
  if (streamCache.has(id)) {
    const cached = streamCache.get(id);
    // TTL: 12 min — safely under the ~15 min CDN URL expiry window
    if (Date.now() - (cached._fetchedAt || 0) < 12 * 60 * 1000) {
      // LRU: re-insert to make this entry the most recently used
      streamCache.delete(id);
      streamCache.set(id, cached);
      return cached;
    }
    streamCache.delete(id);
  }
  // Return the existing in-flight Promise for this id to deduplicate concurrent callers
  if (_streamInflight.has(id)) return _streamInflight.get(id);
  const p = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await fetchStream(id);
        result._fetchedAt = Date.now();
        streamCache.set(id, result);
        // LRU eviction: keep at most 15 entries (evict before inserting the 16th)
        if (streamCache.size > 15) streamCache.delete(streamCache.keys().next().value);
        return result;
      } catch (e) {
        lastErr = e;
        Log.warn('Stream attempt failed', { id, attempt, err: e.message });
        if (attempt < 2) await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
    throw lastErr;
  })().finally(() => _streamInflight.delete(id));
  _streamInflight.set(id, p);
  return p;
}

// ── Browse / Modules ──────────────────────────────────────────────────────────
const _modulesCache = new Map();

export async function fetchModules(language = 'hindi') {
  const key = `mod_${language}`;
  const cached = _modulesCache.get(key);
  if (cached && Date.now() - cached._ts < 5 * 60 * 1000) return cached.data;
  try {
    const r = await apiFetch(`${SIGMA_API}/modules?language=${encodeURIComponent(language)}`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      _modulesCache.set(key, { data: data.data, _ts: Date.now() });
      // Cap at 10 entries (one per language + overflow) to prevent unbounded growth
      if (_modulesCache.size > 10) _modulesCache.delete(_modulesCache.keys().next().value);
      return data.data;
    }
  } catch (e) { Log.warn('fetchModules failed', { language, err: e.message }); }
  return null;
}

// Normalise a song from the saavn.8man.dev API format (different schema to sigma)
function normSaavnSong(s) {
  const pa = s.artists?.primary || [];
  const artist = Array.isArray(pa) ? pa.map(a => a.name || '').filter(Boolean).join(', ')
               : decodeHtml(s.primaryArtists || '');
  const song = {
    id:       s.id,
    name:     decodeHtml(s.name || s.title || ''),
    artist,
    album:    decodeHtml(s.album?.name || ''),
    language: s.language || '',
    image:    bestImg(s.image, '150x150'),
    duration: parseInt(s.duration || 0),
  };
  song._lang = classifyLanguage(song);
  return song;
}

// Fetch real playlist songs via saavn.8man.dev (CORS-blocked directly, routed via proxy)
async function fetchPlaylistSongsDirect(playlistId) {
  const url = `https://saavn.8man.dev/api/playlists?id=${encodeURIComponent(playlistId)}&limit=50`;
  const r = await proxyFetch(url);
  if (!r.ok) throw new Error('proxy HTTP ' + r.status);
  const data = await r.json();
  return (data?.data?.songs || []).map(normSaavnSong);
}

// Fetch real album songs via saavn.8man.dev (fallback when sigma returns empty)
async function fetchAlbumSongsDirect(albumId) {
  const url = `https://saavn.8man.dev/api/albums?id=${encodeURIComponent(albumId)}`;
  const r = await proxyFetch(url);
  if (!r.ok) throw new Error('proxy HTTP ' + r.status);
  const data = await r.json();
  return (data?.data?.songs || []).map(normSaavnSong);
}

export async function fetchAlbumSongs(albumId) {
  // Try sigma first (fast, direct CORS)
  try {
    const r = await apiFetch(`${SIGMA_API}/albums?id=${encodeURIComponent(albumId)}`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      const songs = (data.data?.songs || []).map(normSigmaSong);
      if (songs.length) return songs;
    }
  } catch (e) { Log.warn('fetchAlbumSongs sigma failed', { albumId, err: e.message }); }
  // Fallback: saavn.8man.dev via proxy (returns real tracks)
  try {
    const songs = await fetchAlbumSongsDirect(albumId);
    if (songs.length) return songs;
  } catch (e) { Log.warn('fetchAlbumSongs proxy failed', { albumId, err: e.message }); }
  return [];
}

export async function fetchPlaylistSongs(playlistId) {
  // Try sigma first (fast, direct CORS) — returns empty for editorial/chart playlists
  try {
    const r = await apiFetch(`${SIGMA_API}/playlists?id=${encodeURIComponent(playlistId)}`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      const songs = (data.data?.songs || []).map(normSigmaSong);
      if (songs.length) return songs;
    }
  } catch (e) { Log.warn('fetchPlaylistSongs sigma failed', { playlistId, err: e.message }); }
  // Fallback: saavn.8man.dev via proxy — returns real songs for ALL playlist types
  try {
    const songs = await fetchPlaylistSongsDirect(playlistId);
    if (songs.length) return songs;
  } catch (e) { Log.warn('fetchPlaylistSongs proxy failed', { playlistId, err: e.message }); }
  return [];
}

export async function fetchCharts(language = 'hindi') {
  try {
    // /charts endpoint does not exist on SIGMA — charts are inside /modules response
    const modules = await fetchModules(language);
    return modules?.charts || [];
  } catch (e) { Log.warn('fetchCharts failed', { language, err: e.message }); }
  return [];
}

export async function fetchFeaturedPlaylists(language = 'hindi') {
  try {
    const r = await apiFetch(`${SIGMA_API}/featured-playlists?page=1&n=20&language=${encodeURIComponent(language)}`, { timeout: 8000, retries: 1 });
    const data = await r.json();
    if (data.status === 'SUCCESS') {
      const list = Array.isArray(data.data) ? data.data : (data.data?.playlists || data.data?.results || []);
      return list.map(pl => ({
        id:       pl.id,
        name:     decodeHtml(pl.name || pl.title || ''),
        subtitle: pl.subtitle || (pl.songCount ? `${pl.songCount} songs` : ''),
        image:    bestImg(pl.image, '150x150'),
      }));
    }
  } catch (e) { Log.warn('fetchFeaturedPlaylists failed', { language, err: e.message }); }
  return [];
}

// DES-ECB decrypt removed — no longer used for active stream URLs.
// SIGMA API returns plain HTTPS URLs directly. DES-ECB was a legacy Saavn v2 format.
