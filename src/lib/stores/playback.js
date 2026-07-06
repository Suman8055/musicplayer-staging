import { writable, get } from 'svelte/store';

export const nowSong     = writable(null);
export const queue       = writable([]);
export const qIdx        = writable(0);
export const playing     = writable(false);
export const userPaused  = writable(false);
export const shuffleOn   = writable(false);
export const shuffledQueue = writable([]);
export const shufflePos  = writable(0);
export const repeatMode  = writable(0);   // 0=off 1=all 2=one  (cycleRepeat in NowPlaying: 0→1→2→0)
export const seeking     = writable(false);
export const loadingUrl  = writable(false);
export const seekProgress = writable(0);  // 0.0–1.0
export const duration    = writable(0);
export const currentTime = writable(0);
export const offlineBlobUrl = writable(null);

// audioEl ref — set by +layout.svelte so playback store can call audio methods
let _audioEl = null;
export function setAudioElement(el) { _audioEl = el; }
export function getAudioElement() { return _audioEl; }

