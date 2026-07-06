// smartPlay.js — Listening intelligence and SmartPlay queue. Extracted from index.html.
// Zero DOM dependencies. All UI updates go through Svelte stores.
import { get } from 'svelte/store';
import { queue, qIdx, shuffleOn } from './stores/playback.js';
import { smartQueueActive, smartPlayOn, whyChip } from './stores/smartplay.js';
import { toast } from './stores/ui.js';
import { searchSongs, fetchArtistSongs, filterByLanguage } from './api.js';

const INTEL_KEY = 'mbx_intel_v2';

// ── In-memory intel cache — avoids JSON.parse on every tracking event ─────────
// Write-through: every intelSave() updates both _intelCache and localStorage.
// Reads always use _intelCache when populated; cold start loads from localStorage once.
let _intelCache = null;

// ── Session state (not stores — concurrency flags) ────────────────────────────
let _sessionStreak         = 0;
let _sessionSuppressed     = new Set();
const _suppressedAt        = new Map();
let _prevFullPlayArtistKey = null;
let _smartInjectPending    = false;
let _queueWritePending     = false;
let _forYouCache           = null;
let _forYouRenderPending   = false;
let _intelPruned           = false;

// ── Intel persistence ─────────────────────────────────────────────────────────
function _validateIntel(d) {
  if (!d || typeof d !== 'object') return { artists: {}, languages: {}, songs: {}, flows: {}, streaks: {} };
  d.artists   = (d.artists   && typeof d.artists   === 'object') ? d.artists   : {};
  d.songs     = (d.songs     && typeof d.songs     === 'object') ? d.songs     : {};
  d.languages = (d.languages && typeof d.languages === 'object') ? d.languages : {};
  d.flows     = (d.flows     && typeof d.flows     === 'object') ? d.flows     : {};
  d.streaks   = (d.streaks   && typeof d.streaks   === 'object') ? d.streaks   : {};
  return d;
}

function intelLoad() {
  // Return in-memory cache on all calls after the first load — avoids JSON.parse on every track event
  if (_intelCache) return _intelCache;
  try {
    const s = localStorage.getItem(INTEL_KEY);
    if (s) {
      _intelCache = _validateIntel(JSON.parse(s));
      return _intelCache;
    }
  } catch {}
  _intelCache = { artists: {}, languages: {}, songs: {}, flows: {}, streaks: {} };
  return _intelCache;
}

function intelSave(d) {
  _intelCache = d; // write-through: keep memory in sync before localStorage write
  try {
    localStorage.setItem(INTEL_KEY, JSON.stringify(d));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      try {
        const ids = Object.keys(d.songs || {});
        if (ids.length > 20) {
          ids.sort((a, b) => (d.songs[a].lastPlayed || 0) - (d.songs[b].lastPlayed || 0))
             .slice(0, Math.floor(ids.length * 0.2))
             .forEach(id => delete d.songs[id]);
          localStorage.setItem(INTEL_KEY, JSON.stringify(d));
        } else {
          toast('Listening history full — clear in Settings → Memory');
        }
      } catch { toast('Listening history full — clear in Settings → Memory'); }
    }
  }
}

function intelMigrateV1() {
  try {
    const raw = localStorage.getItem('mbx_intel_v1');
    if (!raw) return;
    const v1 = JSON.parse(raw);
    const d = intelLoad();
    for (const [k, a] of Object.entries(v1.artists || {})) {
      if (!d.artists[k]) d.artists[k] = { name: a.name, id: a.id || '', score: a.score || 0, plays: a.plays || 0 };
    }
    for (const [id, s] of Object.entries(v1.songs || {})) {
      if (!d.songs[id]) d.songs[id] = { plays: s.plays || 0, skips: s.skips || 0, fastSkips: 0, lastPlayed: s.lastPlayed || 0 };
    }
    for (const [lang, val] of Object.entries(v1.languages || {})) {
      if (!d.languages[lang]) d.languages[lang] = { count: typeof val === 'number' ? val : (val.count || 0), lastPlayed: Date.now() };
    }
    intelSave(d);
    localStorage.removeItem('mbx_intel_v1');
  } catch {}
}

export function intelPrune() {
  if (_intelPruned) return;
  _intelPruned = true;
  intelMigrateV1();
  const d = intelLoad();
  const CUT = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const LANGCUT = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const songs = Object.entries(d.songs).filter(([, s]) => (s.lastPlayed || 0) > CUT || (s.plays || 0) > 3)
    .sort(([, a], [, b]) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 500);
  d.songs = Object.fromEntries(songs);
  const artists = Object.entries(d.artists).sort(([, a], [, b]) => b.score - a.score).slice(0, 100);
  d.artists = Object.fromEntries(artists);
  for (const lang of Object.keys(d.languages)) {
    const entry = d.languages[lang];
    if (entry && typeof entry === 'object' && (entry.lastPlayed || 0) < LANGCUT)
      entry.count = Math.floor((entry.count || 0) * 0.8);
  }
  const FLOWCUT = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [from, toMap] of Object.entries(d.flows || {})) {
    for (const [to, val] of Object.entries(toMap)) {
      const entry = typeof val === 'number' ? { count: val, lastPlayed: 0 } : val;
      if ((entry.lastPlayed || 0) < FLOWCUT) entry.count = Math.floor(entry.count * 0.8);
      if (entry.count < 1) delete toMap[to]; else toMap[to] = entry;
    }
    if (!Object.keys(toMap).length) delete d.flows[from];
  }
  intelSave(d);
}

// ── Artist key ────────────────────────────────────────────────────────────────
export function _artistKey(song) {
  return 'n:' + (song.artist || '').toLowerCase().trim();
}

// ── Time context ──────────────────────────────────────────────────────────────
export function _timeSlot() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}
export function _timeGreeting() {
  switch (_timeSlot()) {
    case 'morning':   return 'Good Morning';
    case 'afternoon': return 'Good Afternoon';
    case 'evening':   return 'Good Evening';
    default:          return 'Good Night';
  }
}
export function _isWeekend() { const d = new Date().getDay(); return d === 0 || d === 6; }

// ── Scoring ───────────────────────────────────────────────────────────────────
const _SCORE_HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;
function _decayedScore(artist) {
  if (!artist.lastPlayed) return artist.score * 0.1;
  const age = Date.now() - artist.lastPlayed;
  return Math.max(artist.score * 0.1, artist.score * Math.pow(2, -age / _SCORE_HALF_LIFE_MS));
}

function _expireSuppressions() {
  const EXPIRY = 30 * 60 * 1000;
  const now = Date.now();
  _suppressedAt.forEach((ts, key) => {
    if (now - ts >= EXPIRY) { _sessionSuppressed.delete(key); _suppressedAt.delete(key); }
  });
}

export function intelGetTopArtists(n = 3, contextual = false, filtered = false) {
  if (filtered) _expireSuppressions();
  const d = intelLoad();
  const slot = _timeSlot(), weekend = _isWeekend();
  return Object.entries(d.artists)
    .filter(([key, a]) => a.score > 0 && !(filtered && _sessionSuppressed.has(key)))
    .sort(([, a], [, b]) => {
      if (contextual) {
        const totalA = Object.values(a.slots || {}).reduce((s, v) => s + v, 0);
        const totalB = Object.values(b.slots || {}).reduce((s, v) => s + v, 0);
        const slotA = (a.slots?.[slot] || 0) + (weekend ? (a.slots?.['weekend'] || 0) : 0);
        const slotB = (b.slots?.[slot] || 0) + (weekend ? (b.slots?.['weekend'] || 0) : 0);
        const baseA = _decayedScore(a), baseB = _decayedScore(b);
        const rA = totalA > 0 ? (slotA > 0 ? baseA * (1 + slotA / totalA) : baseA * 0.5) : baseA;
        const rB = totalB > 0 ? (slotB > 0 ? baseB * (1 + slotB / totalB) : baseB * 0.5) : baseB;
        if (rA !== rB) return rB - rA;
      }
      return _decayedScore(b) - _decayedScore(a);
    })
    .slice(0, n)
    .map(([key, a]) => ({ key, id: a.id || '', name: a.name, score: a.score, plays: a.plays, slots: a.slots || {}, lastPlayed: a.lastPlayed || 0 }));
}

export function intelTotalPlays() {
  return Object.values(intelLoad().songs).reduce((s, r) => s + (r.plays || 0), 0);
}

export function intelPlayedIds() {
  return new Set(Object.keys(intelLoad().songs));
}

// ── Tracking ──────────────────────────────────────────────────────────────────
export function intelTrackPlay(song, completionRatio, isFastSkip = false) {
  if (!song?.id) return;
  const key = _artistKey(song);
  if (!key || key === 'n:') return;
  const d = intelLoad();
  if (!d.flows) d.flows = {};
  if (!d.streaks) d.streaks = {};
  const sr = d.songs[song.id] || { plays: 0, skips: 0, fastSkips: 0, lastPlayed: 0 };
  if (song.name)   sr.name   = song.name;
  if (song.artist) sr.artist = song.artist;
  if (song.image)  sr.image  = song.image;
  if (completionRatio >= 0.8)       { sr.plays++; }
  else if (completionRatio < 0.2)   { sr.skips++; if (isFastSkip) sr.fastSkips = (sr.fastSkips || 0) + 1; }
  sr.lastPlayed = Date.now();
  d.songs[song.id] = sr;
  const ar = d.artists[key] || { name: song.artist || '', id: song.artistId || '', score: 0, plays: 0 };
  ar.name = song.artist || ar.name;
  if (song.artistId) ar.id = song.artistId;
  const slot = _timeSlot(), isWeekend = _isWeekend();
  if (completionRatio >= 0.8) {
    ar.score += 3; ar.plays++; ar.lastPlayed = Date.now(); _sessionStreak++;
    if (_sessionStreak >= 3) ar.score += 2;
    if (!ar.slots) ar.slots = {};
    ar.slots[slot] = (ar.slots[slot] || 0) + 1;
    if (isWeekend) ar.slots['weekend'] = (ar.slots['weekend'] || 0) + 1;
    if (_prevFullPlayArtistKey && _prevFullPlayArtistKey !== key) {
      if (!d.flows[_prevFullPlayArtistKey]) d.flows[_prevFullPlayArtistKey] = {};
      const existing = d.flows[_prevFullPlayArtistKey][key];
      const prevCount = typeof existing === 'number' ? existing : (existing?.count || 0);
      d.flows[_prevFullPlayArtistKey][key] = { count: prevCount + 1, lastPlayed: Date.now() };
      // Cap flow map to top-20 entries by count to prevent unbounded localStorage growth
      const flowMap = d.flows[_prevFullPlayArtistKey];
      const entries = Object.entries(flowMap);
      if (entries.length > 20) {
        entries.sort(([, a], [, b]) => (b?.count || 0) - (a?.count || 0));
        d.flows[_prevFullPlayArtistKey] = Object.fromEntries(entries.slice(0, 20));
      }
    }
    _prevFullPlayArtistKey = key;
  } else if (completionRatio >= 0.3) {
    ar.score += 1; ar.plays++; ar.lastPlayed = ar.lastPlayed || Date.now(); _sessionStreak = 0; _prevFullPlayArtistKey = null;
  } else if (completionRatio < 0.2) {
    ar.score = Math.max(0, ar.score - 1); _sessionStreak = 0; _prevFullPlayArtistKey = null;
  }
  d.artists[key] = ar;
  if (song.language && completionRatio >= 0.3) {
    const lang = d.languages[song.language];
    if (lang && typeof lang === 'object') { lang.count++; lang.lastPlayed = Date.now(); }
    else d.languages[song.language] = { count: (typeof lang === 'number' ? lang + 1 : 1), lastPlayed: Date.now() };
  }
  intelSave(d);
  _forYouCache = null;
}

export function intelTrackLike(song) {
  if (!song?.id) return;
  const key = _artistKey(song);
  if (!key || key === 'n:') return;
  const d = intelLoad();
  const ar = d.artists[key] || { name: song.artist || '', id: song.artistId || '', score: 0, plays: 0 };
  ar.name = song.artist || ar.name;
  if (song.artistId) ar.id = song.artistId;
  ar.score += 4; ar.plays = (ar.plays || 0) + 1; ar.lastPlayed = Date.now();
  d.artists[key] = ar;
  const sr = d.songs[song.id] || { plays: 0, skips: 0, fastSkips: 0, lastPlayed: 0 };
  sr.liked = true; sr.likedAt = Date.now();
  if (song.name)   sr.name   = song.name;
  if (song.artist) sr.artist = song.artist;
  if (song.image)  sr.image  = song.image;
  d.songs[song.id] = sr;
  intelSave(d);
  _forYouCache = null;
}

export function intelGetStats() {
  const d = intelLoad();
  const topArtist = intelGetTopArtists(1)[0];
  const topLang = Object.entries(d.languages || {})
    .map(([lang, v]) => ({ lang, count: typeof v === 'object' ? (v.count || 0) : (v || 0) }))
    .sort((a, b) => b.count - a.count)[0];
  const flowCount = Object.values(d.flows || {}).reduce((s, m) => s + Object.keys(m).length, 0);
  return { totalPlays: intelTotalPlays(), topArtist, topLang, flowCount, songCount: Object.keys(d.songs).length, suppressed: [..._sessionSuppressed] };
}

export function intelReset() {
  localStorage.removeItem(INTEL_KEY);
  _intelCache  = null;
  _forYouCache = null;
}

// ── Flow ──────────────────────────────────────────────────────────────────────
function _flowNextArtist() {
  if (!_prevFullPlayArtistKey) return null;
  const d = intelLoad();
  const toMap = d.flows?.[_prevFullPlayArtistKey];
  if (!toMap) return null;
  const best = Object.entries(toMap)
    .map(([k, v]) => [k, typeof v === 'number' ? v : (v?.count || 0)])
    .filter(([k]) => !_sessionSuppressed.has(k))
    .sort(([, a], [, b]) => b - a)[0];
  if (!best || best[1] < 3) return null;
  return { key: best[0], count: best[1] };
}

// ── Smart inject / fill / radio ────────────────────────────────────────────────
export async function smartInjectAhead() {
  if (!get(smartPlayOn)) return;
  if (_smartInjectPending || _queueWritePending) return;
  const q = get(queue), idx = get(qIdx);
  const remaining = q.length - idx - 1;
  if (remaining >= 3) return;
  _smartInjectPending = true;
  _queueWritePending = true;
  try {
    const flowResult = _flowNextArtist();
    const d = intelLoad();
    let artist;
    if (flowResult && d.artists[flowResult.key]) {
      const a = d.artists[flowResult.key];
      artist = { key: flowResult.key, id: a.id || '', name: a.name };
    } else {
      const topArtists = intelGetTopArtists(1, true, true);
      if (!topArtists.length) return;
      artist = topArtists[0];
    }
    const played = intelPlayedIds();
    const inQueue = new Set(q.slice(idx + 1).map(s => s.id));
    const allSongs = filterByLanguage(await fetchArtistSongs(artist.name, 20));
    const picks = allSongs.filter(s => s.id && !played.has(s.id) && !inQueue.has(s.id)).sort(() => Math.random() - 0.5).slice(0, 2);
    if (!picks.length) return;
    queue.update(q => [...q, ...picks]);
    smartQueueActive.set(true);
  } catch {} finally {
    _smartInjectPending = false;
    _queueWritePending = false;
  }
}

export async function smartQueueFill() {
  if (!get(smartPlayOn) || _queueWritePending) return false;
  // Acquire lock immediately — before any async work — to prevent double-fill race
  // where two concurrent callers both pass the guard before either sets the flag.
  _queueWritePending = true;
  const flowResult = _flowNextArtist();
  const d = intelLoad();
  let artist, whyReason;
  if (flowResult && d.artists[flowResult.key]) {
    const a = d.artists[flowResult.key];
    artist = { key: flowResult.key, id: a.id || '', name: a.name, score: a.score, plays: a.plays };
    const fromName = d.artists[_prevFullPlayArtistKey]?.name || '';
    whyReason = `Follows your ${fromName} session (${flowResult.count}x)`;
  } else {
    const topArtists = intelGetTopArtists(1, true, true);
    if (!topArtists.length) { _queueWritePending = false; return false; }
    artist = topArtists[0];
    const slotLabel = { morning: 'Morning mix', afternoon: 'Afternoon mix', evening: 'Evening mix', night: 'Night mix' }[_timeSlot()];
    whyReason = `${slotLabel} · ${artist.name}`;
  }
  smartQueueActive.set(true);
  try {
    const played = intelPlayedIds();
    const allSongs = filterByLanguage(await fetchArtistSongs(artist.name, 30));
    const songs = allSongs.filter(s => s.id && !played.has(s.id)).sort(() => Math.random() - 0.5).slice(0, 10);
    if (!songs.length) { smartQueueActive.set(false); return false; }
    const startIdx = get(queue).length;
    queue.update(q => [...q, ...songs]);
    qIdx.set(startIdx);
    whyChip.set({ reason: whyReason, label: `Smart Queue · ${artist.name}` });
    toast(`Smart Queue — ${artist.name}`);
    // play() called by caller (next/ended handler)
    return true;
  } catch { smartQueueActive.set(false); return false; }
  finally { _queueWritePending = false; }
}

// ── For You rows ──────────────────────────────────────────────────────────────
async function _buildSlotRow(played) {
  const slot = _timeSlot();
  const label = { morning: 'Your Morning Mix', afternoon: 'Your Afternoon Mix', evening: 'Your Evening Mix', night: 'Your Night Mix' }[slot];
  const d = intelLoad();
  const slotArtists = Object.entries(d.artists)
    .filter(([, a]) => a.score > 0 && (a.slots?.[slot] || 0) > 0)
    .sort(([, a], [, b]) => (b.slots?.[slot] || 0) - (a.slots?.[slot] || 0))
    .slice(0, 3).map(([key, a]) => ({ key, name: a.name }));
  if (!slotArtists.length) return null;
  const results = await Promise.allSettled(slotArtists.map(a => fetchArtistSongs(a.name, 15)));
  const songs = filterByLanguage(results.filter(r => r.status === 'fulfilled').flatMap(r => r.value))
    .filter(s => s.id && !played.has(s.id)).sort(() => Math.random() - 0.5).slice(0, 10);
  if (songs.length < 2) return null;
  return { type: 'slot', label, reason: _timeGreeting(), songs };
}

async function _fetchBecauseYouLiked(artistName, excludeIds, limit = 10) {
  const queries = [`${artistName} hits`, `${artistName} feat`, `${artistName} latest`];
  const results = await Promise.allSettled(queries.map(q => searchSongs(q, 15)));
  const seen = new Set(excludeIds);
  const scored = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const song of r.value) {
      if (!song.id || seen.has(song.id)) continue;
      seen.add(song.id);
      scored.push({ song, score: (song.artist || '').toLowerCase().includes(artistName.toLowerCase()) ? 3 : 1 });
    }
  }
  return filterByLanguage(scored.sort((a, b) => b.score - a.score || Math.random() - 0.5).slice(0, limit * 2).map(e => e.song)).slice(0, limit);
}

function _buildRediscoverRow() {
  const d = intelLoad();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const songs = Object.entries(d.songs)
    .filter(([, s]) => (s.plays || 0) >= 2 && (s.skips || 0) === 0 && (s.lastPlayed || 0) < cutoff && s.name && s.artist)
    .sort(([, a], [, b]) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 20).sort(() => Math.random() - 0.5).slice(0, 10)
    .map(([id, s]) => ({ id, name: s.name, artist: s.artist, image: s.image || '' }));
  if (songs.length < 2) return null;
  return { type: 'rediscover', label: 'Rediscover', reason: 'Songs you loved a while ago', songs };
}

// Concurrency limiter: prevents saturating the browser connection pool (max 6 per origin)
// when buildForYouRows fires up to 12 fetches simultaneously on Browse open.
async function _limited(tasks, concurrency = 4) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]().catch(e => ({ status: 'rejected', reason: e }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function buildForYouRows() {
  if (_forYouRenderPending) return _forYouCache?.rows ?? [];
  if (_forYouCache && (Date.now() - _forYouCache.ts) < 30 * 60 * 1000) return _forYouCache.rows;
  _forYouRenderPending = true;
  try {
    const topArtists = intelGetTopArtists(3, false, true);
    if (!topArtists.length) return [];
    const played = intelPlayedIds();
    const excludeIds = new Set(played);
    const rows = [];
    const slotRow = await _buildSlotRow(played);
    if (slotRow) { slotRow.songs.forEach(s => excludeIds.add(s.id)); rows.push(slotRow); }

    // Cap to 4 concurrent fetches — prevents connection pool starvation on slow 3G
    const artistTasks = topArtists.map(artist => async () => {
      const isBecause = artist.score >= 15 && artist.plays >= 3;
      let songs;
      if (isBecause) {
        songs = await _fetchBecauseYouLiked(artist.name, excludeIds, 10);
      } else {
        songs = filterByLanguage(await fetchArtistSongs(artist.name, 30))
          .filter(s => s.id && !excludeIds.has(s.id)).sort(() => Math.random() - 0.5).slice(0, 10);
      }
      if (songs.length >= 2) {
        songs.forEach(s => excludeIds.add(s.id));
        rows.push({ type: isBecause ? 'because' : 'more', label: isBecause ? `Because you love ${artist.name}` : `More from ${artist.name}`, reason: isBecause ? `${artist.plays} songs played` : 'Based on your listening', artist, songs });
      }
    });
    await _limited(artistTasks, 4);

    const rediscoverRow = _buildRediscoverRow();
    if (rediscoverRow) rows.push(rediscoverRow);
    rows.sort((a, b) => { const O = { slot: 0, because: 1, more: 2, rediscover: 3 }; return (O[a.type] ?? 9) - (O[b.type] ?? 9); });
    _forYouCache = { rows, ts: Date.now() };
    return rows;
  } finally {
    _forYouRenderPending = false;
  }
}

export function suppressArtist(song) {
  const key = _artistKey(song);
  if (key && key !== 'n:') {
    _expireSuppressions(); // clean up stale entries unconditionally before adding
    _sessionSuppressed.add(key);
    _suppressedAt.set(key, Date.now());
    _forYouCache = null;
  }
}

