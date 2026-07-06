// playback.js — Core playback controller. Extracted from index.html play/next/prev/togglePlay.
// Reads/writes Svelte stores. Calls audioEngine via direct import.
// CRITICAL: play() preserves iOS gesture chain — ensureAudioCtx() and resumeAudioCtx()
// are called synchronously, with audio.src and audio.play() immediately after.
import { get } from 'svelte/store';
import * as audioEngine from './audioEngine.js';
import { apiStream } from './api.js';
import { idbGet } from './idb.js';
import { cacheSong } from './utils.js';
import { Log } from './logger.js';
import {
  nowSong, queue, qIdx, playing, userPaused, seekProgress,
  loadingUrl, offlineBlobUrl, shuffleOn, shuffledQueue, shufflePos,
  repeatMode, getAudioElement
} from './stores/playback.js';
import { toast, npOpen } from './stores/ui.js';
import { smartInjectAhead, smartQueueFill, intelTrackPlay, suppressArtist } from './smartPlay.js';

// Per-session state (not stores — concurrency flags, not reactive UI)
let _pendingNext      = false;
// Song queued for deferred play when play() was called into an interrupted AudioContext.
// Cleared on resume (onDeferredPlay) or user pause (onClearDeferredPlay).
let _pendingPlaySong  = null;
// True while play() is in the middle of assigning a new src — suppresses the
// spurious 'pause' event that the browser fires on src reassignment.
// Exposed as a getter (not a raw export let) to guarantee bundlers don't inline
// a stale false copy when tree-shaking or chunking the module.
let transitioningTrack = false;
export function isTransitioningTrack() { return transitioningTrack; }
let _intelNaturalEnd  = false;
let _intelPlayStartTs = 0;
let _sessionSkipStreak = 0;

export function createShuffledQueue() {
  const q = get(queue);
  const idx = get(qIdx);
  const arr = q.map((_, i) => i).filter(i => i !== idx);
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  shuffledQueue.set([idx, ...arr]);
  shufflePos.set(0);
}

// F14: when SmartPlay injects songs mid-queue, the new queue indices are not in
// shuffledQueue, so they were unreachable in shuffle mode. Append any queue index
// missing from the shuffle order (shuffled) so injected songs still play.
export function syncShuffleWithQueue() {
  if (!get(shuffleOn)) return;
  const sq = get(shuffledQueue);
  if (!sq.length) return;
  const present = new Set(sq);
  const missing = [];
  const qLen = get(queue).length;
  for (let i = 0; i < qLen; i++) if (!present.has(i)) missing.push(i);
  if (!missing.length) return;
  for (let i = missing.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [missing[i], missing[j]] = [missing[j], missing[i]]; }
  shuffledQueue.set([...sq, ...missing]);
}

export async function play(song, newQueue, idx) {
  const audio = getAudioElement();
  if (!audio) return;
  const isLoading = get(loadingUrl);
  const current   = get(nowSong);
  if (isLoading && current?.id === song.id) return; // block double-tap on same song

  if (newQueue !== undefined) {
    queue.set(newQueue);
    qIdx.set(idx);
    if (get(shuffleOn)) createShuffledQueue();
  }
  // ── Interrupted AudioContext guard ──────────────────────────────────────────
  // If the AudioContext is currently 'interrupted' (iOS phone call, Siri, CarPlay handoff),
  // calling audio.play() into a dead context silently fails — iOS kills the promise
  // without rejecting it. Queue the song for deferred play instead; audioEngine will
  // call back via onDeferredPlay() when the interrupt clears.
  if (audioEngine.getAudioCtxState() === 'interrupted') {
    Log.info('play() deferred: AudioContext interrupted', { name: song.name, id: song.id });
    _pendingPlaySong = song;
    // Still update nowSong so the UI shows the correct track title/artwork
    nowSong.set(song);
    cacheSong(song);
    return;
  }

  nowSong.set(song);
  cacheSong(song);
  npOpen.set(true);
  loadingUrl.set(true);
  Log.info('play() called', {
    name:     song.name,
    songId:   song.id,
    queueLen: get(queue).length,
    queueIdx: get(qIdx),
    shuffle:  get(shuffleOn),
    repeat:   get(repeatMode),
  });

  try {
    // ── Offline blob path ────────────────────────────────────────────────────
    // Use pre-created blob URL if preloadNext() already fetched the blob for this song.
    // Falls back to idbGet() if the preload missed (first tap, shuffle reorder, etc.).
    const preloadedBlobUrl = consumePreloadedBlobUrl(song.id);
    const offline = preloadedBlobUrl ? { blob: true } : await idbGet(song.id);
    if (preloadedBlobUrl || offline?.blob) {
      if (get(nowSong)?.id !== song.id) { if (preloadedBlobUrl) try { URL.revokeObjectURL(preloadedBlobUrl); } catch {} return; }
      const blobUrl = preloadedBlobUrl || URL.createObjectURL(offline.blob);
      const prev = get(offlineBlobUrl);
      if (prev) { try { URL.revokeObjectURL(prev); } catch {} }
      offlineBlobUrl.set(blobUrl);

      // iOS gesture chain — NOTHING between resumeAudioCtx() and audio.play()
      // resumeAudioCtx is fire-and-forget: awaiting it yields to the event loop,
      // which terminates iOS Safari's user-gesture transient activation → NotAllowedError.
      // Do NOT set crossOrigin for blob URLs — they are same-origin by definition,
      // and toggling crossOrigin forces the browser to reset the media pipeline,
      // causing a 1-2s audio stall immediately after play() on the new src.
      audioEngine.ensureAudioCtx();
      if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
      audioEngine.resumeAudioCtx().catch(() => {});
      transitioningTrack = true;
      audio.src = blobUrl;
      const offlinePlayErr = await audio.play().catch(e => e);
      transitioningTrack = false;
      if (offlinePlayErr instanceof Error) throw offlinePlayErr;

      if (get(nowSong)?.id !== song.id) return;
      playing.set(true);
      userPaused.set(false);
      Log.info('Playback (offline)', { name: song.name });

    } else {
      // ── Network stream path ──────────────────────────────────────────────
      // If the preload element already buffered this song's URL, reuse it directly —
      // skips the apiStream() round-trip and the browser serves from its buffer cache,
      // eliminating the 1-2s stutter at the start of every Next tap.
      let streamUrl;
      const preloadEl = _preloadEl;
      if (
        preloadEl &&
        preloadEl !== audio &&
        preloadEl.src &&
        preloadEl.readyState === 4 // HAVE_ENOUGH_DATA — fully buffered, safe to transfer
      ) {
        streamUrl = preloadEl.src;
        // Clear the preload element immediately — on iOS 15 WKWebView, leaving both
        // elements on the same URL causes the main player to inherit an exhausted
        // HTTP stream, firing 'ended' instantly and auto-advancing the queue.
        preloadEl.src = '';
        preloadEl.load();
        Log.info('play(): using preloaded URL', { name: song.name, readyState: preloadEl.readyState });
      } else {
        const stream = await apiStream(song.id);
        if (get(nowSong)?.id !== song.id) return;
        // Update metadata from stream response
        if (stream.image || stream.quality) {
          nowSong.update(s => ({ ...s, image: stream.image || s.image, quality: stream.quality || s.quality }));
        }
        streamUrl = stream.url;
      }
      if (get(nowSong)?.id !== song.id) return;

      // iOS gesture chain — NOTHING between resumeAudioCtx() and audio.play()
      // resumeAudioCtx is fire-and-forget: awaiting it yields to the event loop,
      // which terminates iOS Safari's user-gesture transient activation → NotAllowedError.
      audio.crossOrigin = 'anonymous';
      audioEngine.ensureAudioCtx();
      if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
      audioEngine.resumeAudioCtx().catch(() => {});
      const prev = get(offlineBlobUrl);
      if (prev) { try { URL.revokeObjectURL(prev); } catch {} offlineBlobUrl.set(null); }
      transitioningTrack = true;
      audio.src = streamUrl;
      const streamPlayErr = await audio.play().catch(e => e);
      transitioningTrack = false;
      if (streamPlayErr instanceof Error) throw streamPlayErr;

      if (get(nowSong)?.id !== song.id) return;
      playing.set(true);
      userPaused.set(false);
      _intelPlayStartTs = Date.now();
      Log.info('Playback started', { name: song.name, artist: song.artist });
    }

    setTimeout(() => preloadNext(), 500); // start preloading next song early — reduces Next-tap stutter
    _updateMediaSession(song);
  } catch (e) {
    transitioningTrack = false;
    toast('Stream unavailable — try another song');
    playing.set(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    Log.error('Playback failed', { name: song.name, err: e.message });
  } finally {
    loadingUrl.set(false);
    if (_pendingNext) { _pendingNext = false; next(); }
  }
}

export async function togglePlay() {
  const audio = getAudioElement();
  if (!audio || !get(nowSong) || get(loadingUrl)) return;
  if (get(playing)) {
    userPaused.set(true);
    audioEngine.onUserPaused();
    audio.pause();
  } else {
    userPaused.set(false);
    audioEngine.resumeAudioCtx().catch(() => {});
    if (audio.ended) {
      // Reload the src to fully reset ended state — seeking to 0 on an ended
      // element causes a spurious 'ended' event on WKWebView (iOS 15) that
      // immediately triggers onEnded() → next(), skipping to the next song.
      const src = audio.src;
      audio.src = '';
      audio.src = src;
      audio.load();
    }
    audio.play().catch(() => {});
  }
}

export function prev() {
  const audio = getAudioElement();
  if (!audio || get(loadingUrl)) return;
  const curTime = audio.currentTime;
  if (curTime > 3) { audio.currentTime = 0; return; }
  const totDur = audio.duration;
  const song = get(nowSong);
  if (song && totDur > 0) intelTrackPlay(song, curTime / totDur);
  if (get(shuffleOn)) {
    const pos = get(shufflePos);
    if (pos > 0) {
      shufflePos.set(pos - 1);
      const sq = get(shuffledQueue);
      qIdx.set(sq[pos - 1]);
      play(get(queue)[sq[pos - 1]]);
    } else if (audio) {
      // F12: at the first shuffled track, Prev restarts the current song
      // (was a silent no-op — inconsistent with the linear path below).
      audio.currentTime = 0;
    }
    return;
  }
  const idx = get(qIdx);
  // Guard: idx === 0 means we're at the start — restart current song instead of play(undefined)
  if (idx > 0) {
    const prevSong = get(queue)[idx - 1];
    if (!prevSong) return;
    qIdx.set(idx - 1);
    play(prevSong);
  } else if (audio) {
    audio.currentTime = 0;
  }
}

export function next({ fromEnded = false } = {}) {
  const audio = getAudioElement();
  const song  = get(nowSong);
  if (song) {
    const curTime = audio?.currentTime || 0;
    const totDur  = audio?.duration   || 0;
    const ratio   = _intelNaturalEnd ? 1.0 : (totDur > 0 ? curTime / totDur : 0);
    const isFast  = !_intelNaturalEnd && _intelPlayStartTs > 0 && (Date.now() - _intelPlayStartTs) < 5000;
    intelTrackPlay(song, ratio, isFast);
    if (_intelNaturalEnd || ratio >= 0.8) { _sessionSkipStreak = 0; smartInjectAhead().then(() => syncShuffleWithQueue()); }
    else if (isFast) {
      _sessionSkipStreak++;
      if (_sessionSkipStreak >= 2) {
        // F13/F22: was writing to a dead local Set — the live suppression state lives
        // in smartPlay.js, so fast-skip artist suppression never actually fired.
        // Call the canonical suppressArtist() so the feature works.
        suppressArtist(song);
        _sessionSkipStreak = 0;
      }
    } else { _sessionSkipStreak = 0; }
  }
  _intelNaturalEnd = false;

  if (get(loadingUrl)) { _pendingNext = true; return; }

  const rm = get(repeatMode);
  if (rm === 2 && fromEnded) {
    // repeat-one: restart current track ONLY on natural end (F11).
    // A manual Next tap must still advance to the next song — matching Spotify/Apple.
    const audioEl = getAudioElement();
    if (!audioEl) return;
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
    return;
  }

  let ni;
  if (get(shuffleOn)) {
    let sq = get(shuffledQueue);
    // If shuffledQueue is empty (shuffle toggled before any queue built), create it now
    if (!sq.length) { createShuffledQueue(); sq = get(shuffledQueue); }
    const pos = get(shufflePos);
    const nextPos = pos + 1;
    if (nextPos >= sq.length) {
      if (rm === 1) { createShuffledQueue(); ni = get(shuffledQueue)[0]; }
      else {
        smartQueueFill().then(filled => {
          if (filled) {
            // F1: fill appended songs and set qIdx to the first — rebuild the shuffle
            // index so the new songs are reachable, then play. Without this the queue
            // silently dead-stops: songs sit in the queue but nothing plays.
            createShuffledQueue();
            const sq2 = get(shuffledQueue);
            play(get(queue)[sq2[0]]);
          } else {
            const audioEl = getAudioElement();
            if (audioEl && !audioEl.paused) audioEl.pause();
            playing.set(false);
            userPaused.set(false);
          }
        });
        return;
      }
    } else {
      shufflePos.set(nextPos);
      ni = sq[nextPos];
    }
  } else {
    const idx = get(qIdx);
    ni = idx + 1;
    if (ni >= get(queue).length) {
      if (rm === 1) ni = 0;
      else {
        smartQueueFill().then(filled => {
          if (filled) {
            // F1: smartQueueFill() appended songs and set qIdx to the first new one.
            // The previous code returned without playing, so the queue silently
            // dead-stopped. Play the song smartQueueFill() queued up.
            play(get(queue)[get(qIdx)]);
          } else {
            // No more songs — stop both the store AND the audio element so
            // the button state matches what is actually playing.
            const audioEl = getAudioElement();
            if (audioEl && !audioEl.paused) audioEl.pause();
            playing.set(false);
            userPaused.set(false);
          }
        });
        return;
      }
    }
  }
  qIdx.set(ni);
  play(get(queue)[ni]);
}

// Called from audio 'ended' event in layout
export function onEnded() {
  _intelNaturalEnd = true;
  next({ fromEnded: true });
}

export function seek(ratio) {
  const audio = getAudioElement();
  if (!audio || !audio.duration || !isFinite(audio.duration) || isNaN(ratio)) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  audio.currentTime = clamped * audio.duration;
}

export function setVolume(v) {
  audioEngine.setVolume(v);
}

// Called by audioEngine via the onDeferredPlay callback when the AudioContext recovers
// from an interrupted state and there is a song queued for deferred play.
export function onDeferredPlay() {
  if (!_pendingPlaySong) return;
  const song = _pendingPlaySong;
  _pendingPlaySong = null;
  Log.info('Deferred play: resuming song that was queued during AudioContext interrupt', { name: song.name, id: song.id });
  play(song).catch(() => {});
}

// Called by audioEngine via onClearDeferredPlay when the user explicitly pauses —
// discard any pending song so it does not auto-start on interrupt recovery.
export function onClearDeferredPlay() {
  if (_pendingPlaySong) {
    Log.info('Deferred play: cleared (user paused)', { name: _pendingPlaySong.name, id: _pendingPlaySong.id });
    _pendingPlaySong = null;
  }
}

// preloadEl is set by +layout.svelte via setPreloadElement() — avoids fragile DOM query
let _preloadEl = null;
export function setPreloadElement(el) { _preloadEl = el; }

// Pre-created blob URL for the next offline song — avoids idbGet() round-trip on Next tap
let _preloadBlobUrl   = null;
let _preloadBlobSongId = null;

export function consumePreloadedBlobUrl(songId) {
  if (_preloadBlobSongId === songId && _preloadBlobUrl) {
    const url = _preloadBlobUrl;
    _preloadBlobUrl    = null;
    _preloadBlobSongId = null;
    return url;
  }
  return null;
}

async function preloadNext() {
  const q = get(queue);
  if (!q.length) return;
  let nextIdx;
  if (get(shuffleOn)) {
    const pos = get(shufflePos), sq = get(shuffledQueue);
    if (pos >= sq.length - 1) return;
    nextIdx = sq[pos + 1];
  } else {
    const idx = get(qIdx);
    if (idx >= q.length - 1) return;
    nextIdx = idx + 1;
  }
  const nextSong = q[nextIdx];
  if (!nextSong) return;
  if (_preloadEl === getAudioElement()) { Log.error('preloadNext: _preloadEl is main audio element — aborting'); return; }

  try {
    // Check IDB first — if offline, pre-create blob URL to eliminate idbGet() latency on Next tap
    const offline = await idbGet(nextSong.id);
    if (offline?.blob) {
      if (_preloadBlobSongId !== nextSong.id) {
        // Revoke any stale blob URL from a previous preload
        if (_preloadBlobUrl) { try { URL.revokeObjectURL(_preloadBlobUrl); } catch {} }
        _preloadBlobUrl    = URL.createObjectURL(offline.blob);
        _preloadBlobSongId = nextSong.id;
      }
      return; // offline song doesn't need network preload
    }

    if (!_preloadEl) return;
    const result = await apiStream(nextSong.id);
    if (_preloadEl && _preloadEl.src !== result.url) {
      _preloadEl.src = result.url;
      _preloadEl.load();
      // Probe readyState after a tick — if HAVE_NOTHING, nudge with currentTime
      // to encourage the browser to buffer past the HTTP headers into actual audio data.
      setTimeout(() => {
        try { if (_preloadEl && _preloadEl.readyState < 2) _preloadEl.currentTime = 0; } catch {}
      }, 200);
    }
  } catch {}
}

// Fetch artwork and encode as data: URLs at two sizes.
// iOS Safari CarPlay: small player uses the first artwork entry (~96px); large view uses the second (~512px).
// Two entries let CarPlay pick the sharpest size for each context without upscaling.
// Raw CDN URLs are rejected by Tesla/Bluetooth AVRCP firmware (403 outside browser).
// data: URLs embed bytes directly — the OS passes them over AVRCP without HTTP.
async function _fetchArtDataUrls(url, signal, songId) {
  const _fetchStart = Date.now();
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      Log.warn('MediaSession: artwork HTTP error', { url, status: res.status, statusText: res.statusText });
      return null;
    }
    const blob = await res.blob();
    return await new Promise(resolve => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      const _decodeStart = Date.now();
      img.onload = () => {
        Log.info('MediaSession: artwork decoded', { songId, decodeMs: Date.now() - _decodeStart });
        const draw = (size, quality) => {
          const cv = document.createElement('canvas');
          cv.width = size; cv.height = size;
          cv.getContext('2d').drawImage(img, 0, 0, size, size);
          return cv.toDataURL('image/jpeg', quality);
        };
        URL.revokeObjectURL(objUrl);
        resolve({ small: draw(96, 0.80), large: draw(512, 0.85) });
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
      img.src = objUrl;
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      Log.info('MediaSession: artwork fetch aborted', { songId, elapsedMs: Date.now() - _fetchStart });
      return null;
    }
    return null;
  }
}

let _msAbortCtrl = null;
let _msFetchingSongId = null;

// Capacitor CarPlay bridge — push song metadata and playback state to native MPNowPlayingInfoCenter.
// Safe to call on web (window.Capacitor absent) — no-ops silently.
export async function carPlayUpdateNowPlaying(song, artBase64 = null) {
  try {
    const cap = window?.Capacitor?.Plugins?.MBXCarPlay;
    if (!cap) return;
    const audio = getAudioElement();
    await cap.updateNowPlaying({
      title:          song?.name   || '',
      artist:         song?.artist || '',
      duration:       audio?.duration   || 0,
      elapsed:        audio?.currentTime || 0,
      artworkBase64:  artBase64 || '',
    });
  } catch {}
}

export async function carPlayUpdatePlaybackState(isPlaying) {
  try {
    const cap = window?.Capacitor?.Plugins?.MBXCarPlay;
    if (!cap) return;
    await cap.updatePlaybackState({ isPlaying });
  } catch {}
}

async function _updateMediaSession(song) {
  if (!('mediaSession' in navigator) || !song) return;

  // Cancel any in-flight artwork fetch from a previous song
  if (_msAbortCtrl) { Log.info('MediaSession: cancelled in-flight fetch', { previousSongId: _msFetchingSongId ?? null }); _msAbortCtrl.abort(); _msAbortCtrl = null; }

  // Set title/artist immediately — lock screen shows something while artwork fetches.
  // NOTE: iOS Safari WebKit bug — setting both `artist` and `album` causes `album` to be
  // silently dropped. Omit `album` to ensure `artist` always renders on CarPlay/lock screen.
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   song.name   || 'Unknown',
      artist:  song.artist || '',
      artwork: [],
    });
    navigator.mediaSession.playbackState = 'playing';
    Log.info('MediaSession: metadata set', { songId: song.id, title: song.name, artist: song.artist, playbackState: 'playing' });
  } catch {}

  if (!song.image) { Log.warn('MediaSession: no artwork URL on song', { songId: song.id, name: song.name }); return; }

  // Snapshot song id — if the song changes while fetching, discard the result
  const songId = song.id;
  _msAbortCtrl = new AbortController();
  _msFetchingSongId = songId;
  const imgUrl = song.image.replace(/\d+x\d+/, '500x500');
  Log.info('MediaSession: fetching artwork', { songId, url: imgUrl });
  const art = await _fetchArtDataUrls(imgUrl, _msAbortCtrl.signal, songId);
  _msAbortCtrl = null;
  _msFetchingSongId = null;

  if (!art) { Log.warn('MediaSession: artwork fetch returned null', { songId, url: imgUrl }); return; }
  if (get(nowSong)?.id !== songId) { Log.info('MediaSession: artwork discarded (song changed)', { fetchedSongId: songId, currentSongId: get(nowSong)?.id ?? null }); return; }
  try {
    // Two artwork sizes: iOS Safari picks the first entry for the small lock screen/CarPlay widget
    // (~96px context) and the second for the large Now Playing full-screen view (~512px context).
    // Without both, iOS upscales the single entry and it looks blurry in one of the two views.
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   song.name   || 'Unknown',
      artist:  song.artist || '',
      artwork: [
        { src: art.small, sizes: '96x96',   type: 'image/jpeg' },
        { src: art.large, sizes: '512x512', type: 'image/jpeg' },
      ],
    });
    Log.info('MediaSession: artwork set', { songId, smallBytes: art.small.length, largeBytes: art.large.length });
  } catch {}
  // Push to native MPNowPlayingInfoCenter for CarPlay (artwork as base64)
  carPlayUpdateNowPlaying(song, art?.large ?? null);
}
