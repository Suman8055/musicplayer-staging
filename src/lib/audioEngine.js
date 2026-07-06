// audioEngine.js — Vanilla JS Web Audio engine for MusicPlayer SvelteKit
// Extracted from index.html. Zero DOM dependencies. Zero Svelte imports.
// Call init(audioEl, callbacks) from +layout.svelte onMount BEFORE any play().
// AudioContext is created lazily on first user gesture (iOS requirement).
//
// DSP fixes applied vs original index.html:
//   1. Bass exciter DC fix: 5Hz HPF after _bassExciterOut blocks DC offset
//   2. _haasDelay renamed _sideGainNeg (it is a GainNode, not a DelayNode)

import { writable, get } from 'svelte/store';

// ── Public readable stores (UI subscribes, engine writes) ─────────────────────
const _eqStateStore = writable({ gains: null, on: true, preset: 'Custom' });
const _corsAvailableStore = writable(false);
const _cfOnStore = writable(
  (typeof localStorage !== 'undefined') ? localStorage.getItem('mbx_cf_v1') === 'true' : false
);

export const eqState = { subscribe: _eqStateStore.subscribe };
export const corsAvailable = { subscribe: _corsAvailableStore.subscribe };
export const crossfeedOn = { subscribe: _cfOnStore.subscribe };

// ── Module-level state ────────────────────────────────────────────────────────
let _audioEl      = null;   // set by init()
let _callbacks    = {};     // set by init()

const AC = (typeof window !== 'undefined')
  ? (window.AudioContext || window.webkitAudioContext || null)
  : null;

const NORM_VOLUME = 1.0;

// ── AudioContext state ────────────────────────────────────────────────────────
let _audioCtx    = null;
let _gainNode    = null;  // unity gain node — connects mediaSource to DSP chain
let _volumeGain  = null;  // user volume control
let _mediaSource = null;
let _ctxFailed   = false;
let _corsAvailable = false;

// ── DSP chain nodes ───────────────────────────────────────────────────────────
let _limiterCompressor = null;
let _limiterWaveshaper = null;
let _bassExciterIn     = null;
let _bassExciterDist   = null;
let _bassExciterOut    = null;
let _bassExciterDcHpf  = null; // FIX: 5Hz HPF to block DC offset from half-wave rectifier
let _bassExciterGain   = null;
let _preMixGain        = null;
let _eqHeadroomGain    = null;
let _splitter          = null;
let _merger            = null;
let _midGain           = null;
let _sideGain          = null;
let _sideGainNeg       = null; // was _haasDelay — renamed: it is a GainNode, not a DelayNode
let _msInvGain         = null;
let _sideGainR         = null;
let _airShelf          = null;
let _cfSplit           = null;
let _cfMerge           = null;
let _cfHpL             = null;
let _cfHpR             = null;
let _cfGainL           = null;
let _cfGainR           = null;
let _cfDelayL          = null; // ITD delay L→R cross path: 0.6ms ear-to-ear simulation
let _cfDelayR          = null; // ITD delay R→L cross path
let _bgKeepAliveTimer  = null;
let _rewiring          = false;
let _wasInterrupted    = false;  // true while iOS audio session interrupt is active
let _playingBeforeInterrupt = false;  // snapshot of playing state when interrupt fired

// ── EQ constants ──────────────────────────────────────────────────────────────
export const EQ_BANDS = [
  { freq:   32, type: 'lowshelf',  label: '32' },
  { freq:   64, type: 'peaking',   label: '64' },
  { freq:  125, type: 'peaking',   label: '125' },
  { freq:  250, type: 'peaking',   label: '250' },
  { freq:  500, type: 'peaking',   label: '500' },
  { freq: 1000, type: 'peaking',   label: '1k' },
  { freq: 2000, type: 'peaking',   label: '2k' },
  { freq: 4000, type: 'peaking',   label: '4k' },
  { freq: 8000, type: 'peaking',   label: '8k' },
  { freq:16000, type: 'highshelf', label: '16k' },
];
export const EQ_Q = [0.707, 0.7, 0.7, 0.7, 1.0, 1.0, 1.0, 1.4, 1.4, 0.707]; // shelf bands: Butterworth Q=0.707 — no resonant peak/notch
export const EQ_PRESETS = {
  flat:       [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass:       [ 5, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  vocal:      [-2,-2, 0, 2, 4, 4, 3, 1, 0, 0],
  treble:     [ 0, 0, 0, 0, 0, 0, 2, 3, 4, 5],
  vshape:     [ 4, 4, 2, 0,-2,-2, 0, 2, 4, 5],
  bollywood:  [ 3, 5, 3, 1, 0,-1, 1, 3, 2, 2],
  punjabi:    [ 5, 6, 4, 2, 0,-1, 0, 2, 3, 3],
  classical:  [ 2, 2, 1, 0,-1, 0, 1, 2, 3, 4],
  podcast:    [-3,-4,-2, 0, 3, 5, 4, 2, 0,-1],
  r_and_b:    [ 2, 5, 4, 4,-1,-1, 2, 2, 3, 4], // 64Hz +7→+5, 125Hz +6→+4: ref Drake/SZA/Dua Lipa mixes
};
const EQ_KEY = 'mbx_eq_v2';
const CF_KEY = 'mbx_cf_v1';

// ── EQ state (persisted to localStorage) ─────────────────────────────────────
const _EQ_DEFAULT = '[0,0,0,-1,0,0,2,3,2,1]';
(function _migrateEqGains() {
  if (typeof localStorage === 'undefined') return;
  const stored = localStorage.getItem(EQ_KEY);
  if (stored) {
    try {
      const g = JSON.parse(stored);
      if (g.length !== 10) localStorage.removeItem(EQ_KEY);
    } catch { localStorage.removeItem(EQ_KEY); }
  }
})();

let _eqNodes  = [];
let _eqGains  = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(EQ_KEY)) || _EQ_DEFAULT);
let _eqOn     = (typeof localStorage !== 'undefined') ? localStorage.getItem(EQ_KEY + '_on') !== 'false' : true;
let _cfOn     = (typeof localStorage !== 'undefined') ? localStorage.getItem(CF_KEY) === 'true' : false;
let _manualEqAdjusted = false;
let _ipodMode = (typeof localStorage !== 'undefined') ? localStorage.getItem('mbx_ipod_mode') === '1' : false;

// ── init() — called once from +layout.svelte onMount ─────────────────────────
// Sets up the audio element reference and callbacks. Does NOT create AudioContext.
// AudioContext is created on first user gesture via ensureAudioCtx().
export function init(audioEl, callbacks = {}) {
  _audioEl   = audioEl;
  _callbacks = callbacks;
}

// ── ensureAudioCtx() — call synchronously in play() before audio.play() ───────
// Creates AudioContext + full DSP chain on first call. Idempotent.
// CRITICAL: must remain synchronous. Any await here would break iOS gesture chain.
export function ensureAudioCtx() {
  if (_audioCtx) return true;
  if (_ctxFailed || !AC || !_audioEl) return false;
  try {
    _audioCtx = new AC({ sampleRate: 48000 });
    _audioCtx.addEventListener('statechange', () => {
      const cb = _callbacks.getState?.() ?? {};
      const state = _audioCtx?.state ?? 'unknown';
      if (_callbacks.onLog) _callbacks.onLog('info', 'AudioContext statechange', {
        state,
        userPaused:          cb.userPaused ?? false,
        playing:             cb.playing    ?? false,
        wasInterrupted:      _wasInterrupted,
        playingBeforeInt:    _playingBeforeInterrupt,
      });

      if (state === 'interrupted') {
        // iOS system interrupt (phone call, Siri, CarPlay handoff, etc.)
        // Snapshot whether we were actively playing — NOT user-paused
        _wasInterrupted = true;
        _playingBeforeInterrupt = (cb.playing === true) && (cb.userPaused === false);
        if (_callbacks.onLog) _callbacks.onLog('info', 'AudioContext: interrupt start', { playingBeforeInt: _playingBeforeInterrupt });
      } else if (state === 'running' && _wasInterrupted) {
        // Interrupt ended — iOS resumed the audio session
        _wasInterrupted = false;
        const cur = _callbacks.getState?.() ?? {};
        if (_playingBeforeInterrupt) {
          // We were playing when interrupted (not user-paused) — auto-resume mid-song
          if (_callbacks.onLog) _callbacks.onLog('info', 'AudioContext: interrupt ended, auto-resuming mid-song');
          setTimeout(() => {
            const cur2 = _callbacks.getState?.() ?? {};
            // Only resume if user has not explicitly paused in the interim
            if (!cur2.userPaused && _audioEl?.paused) {
              _audioEl.play().catch(e => {
                if (_callbacks.onLog) _callbacks.onLog('warn', 'AudioContext: auto-resume after interrupt failed', { err: e?.message });
              });
            }
          }, 300);
        }
        _playingBeforeInterrupt = false;
        // Fire deferred-play callback regardless — playback.js will check _pendingPlaySong.
        // This handles the race where onEnded→next()→play() fired into the interrupted context.
        if (!cur.userPaused && _callbacks.onDeferredPlay) {
          if (_callbacks.onLog) _callbacks.onLog('info', 'AudioContext: interrupt ended, firing onDeferredPlay');
          setTimeout(() => {
            const cur3 = _callbacks.getState?.() ?? {};
            if (!cur3.userPaused && _callbacks.onDeferredPlay) _callbacks.onDeferredPlay();
          }, 300);
        }
      } else if (state === 'suspended' && !cb.userPaused) {
        // Non-interrupt suspension (background throttle, etc.) — try to resume
        setTimeout(() => {
          if (_audioCtx?.state === 'suspended' && !(_callbacks.getState?.()?.userPaused)) {
            _audioCtx.resume().catch(() => {});
          }
        }, 800);
      }
    });

    _gainNode = _audioCtx.createGain();
    _gainNode.gain.value = NORM_VOLUME;

    _volumeGain = _audioCtx.createGain();
    _volumeGain.gain.value = NORM_VOLUME;

    // Route <audio> through Web Audio for DSP chain
    // Signal path: mediaSource → gainNode → volumeGain → DSP chain
    try {
      _mediaSource = _audioCtx.createMediaElementSource(_audioEl);
      _mediaSource.connect(_gainNode);
      _gainNode.connect(_volumeGain);
      _audioEl.volume = 1;
      _corsAvailable = true;
      _corsAvailableStore.set(true);
    } catch (corsErr) {
      _mediaSource = null;
      _corsAvailable = false;
      _corsAvailableStore.set(false);
      _audioEl.volume = NORM_VOLUME;
      if (_callbacks.onCorsUnavailable) _callbacks.onCorsUnavailable();
      if (_callbacks.onLog) _callbacks.onLog('warn', 'Web Audio CORS unavailable', corsErr.message);
    }

    _rewireAudio();

    // Expose debug hook — caller sets window._mbxAudio = getDebugInfo in layout
    if (_callbacks.onLog) _callbacks.onLog('info', 'AudioContext created', { sampleRate: 48000 });
    return true;
  } catch (e) {
    _ctxFailed = true;
    if (_callbacks.onLog) _callbacks.onLog('warn', 'AudioContext failed', e.message);
    return false;
  }
}

export async function resumeAudioCtx() {
  if (_audioCtx && _audioCtx.state === 'suspended') {
    try { await _audioCtx.resume(); } catch {}
  }
}

// Returns the current AudioContext state, or null if not yet created.
export function getAudioCtxState() {
  return _audioCtx?.state ?? null;
}

// F10: a first-class resume for the visibility/pageshow/resume recovery paths.
// Previously the layout reached through getDebugInfo().audioCtx.resume() — using a
// debug API as production control flow, which would break if getDebugInfo shrank.
export async function resumeIfSuspended() {
  if (_audioCtx?.state === 'suspended') {
    try { await _audioCtx.resume(); } catch {}
  }
}

// ── Playback hooks (called by audio event listeners in +layout.svelte) ────────
export function onPlaybackStarted()  { startBgKeepAlive(); }
export function onPlaybackPaused()   { /* keep-alive continues; stopped on user pause */ }
export function onUserPaused() {
  stopBgKeepAlive();
  _playingBeforeInterrupt = false; // user explicitly paused — don't auto-resume on interrupt end
  // Also discard any song queued for deferred play during an interrupt
  if (_callbacks.onClearDeferredPlay) _callbacks.onClearDeferredPlay();
}

let _kaRunning = false;
export function startBgKeepAlive() {
  stopBgKeepAlive();
  _bgKeepAliveTimer = setInterval(async () => {
    if (_kaRunning) return;
    _kaRunning = true;
    try {
      const cb = _callbacks.getState?.() ?? {};
      if (!cb.playing || cb.userPaused || !_audioCtx) return;
      // Always attempt resume — iOS 18 can report state:running while audio is
      // actually frozen; calling resume() is a no-op when truly running but
      // re-activates the session when iOS has silently suspended it.
      try { await _audioCtx.resume(); } catch {}
      // If the element is paused (iOS suspended the media pipeline), force play().
      if (_audioEl?.paused && !cb.userPaused && cb.nowSong) {
        try { await _audioEl.play(); } catch {}
      }
    } finally {
      _kaRunning = false;
    }
  }, 5000); // 5s interval: tighter than 10s to catch iOS suspension within one cycle
}

export function stopBgKeepAlive() {
  clearInterval(_bgKeepAliveTimer);
  _bgKeepAliveTimer = null;
}

// ── Volume control ────────────────────────────────────────────────────────────
export function setVolume(v) {
  if (_corsAvailable && _volumeGain) {
    // Write user volume to _volumeGain. (_gainNode is a fixed unity bridge — the LUFS
    // automation the old comment referenced was removed; nothing writes _gainNode.gain
    // after init, so there's no ramp to preserve here.)
    _volumeGain.gain.value = v;
  } else if (_audioEl) {
    _audioEl.volume = v;
  }
}

// ── EQ public API ─────────────────────────────────────────────────────────────
export function setEqGain(bandIndex, dB) {
  _eqGains[bandIndex] = dB;
  _manualEqAdjusted = true;
  _applyEqGains();
  _saveEqState();
  _pushEqState();
}

export function setEqEnabled(on) {
  _eqOn = on;
  _applyEqGains();
  _saveEqState();
  _pushEqState();
}

export function loadEqPreset(name) {
  const gains = EQ_PRESETS[name];
  if (!gains) return;
  _eqGains = [...gains];
  _applyEqGains();
  _saveEqState();
  _pushEqState(name);
}

export function getEqState() {
  return { gains: [..._eqGains], on: _eqOn };
}

export function setCrossfeedEnabled(on) {
  _cfOn = on;
  _cfOnStore.set(on);
  if (typeof localStorage !== 'undefined') localStorage.setItem(CF_KEY, String(on));
  // Only rewire if AudioContext exists — if toggled before first play, _cfOn is already
  // persisted; ensureAudioCtx() will call _rewireAudio() which picks up _cfOn correctly.
  if (_audioCtx) _rewireAudio();
  _pushEqState();
}

// ── iPod Mode — reduce DSP load for A10 chip / iOS 15.8.8 ────────────────────
export function setIpodMode(on) {
  _ipodMode = on;
  if (typeof localStorage !== 'undefined') localStorage.setItem('mbx_ipod_mode', on ? '1' : '0');
  // Apply new oversample level to existing waveshapers without full rewire
  const level = on ? '2x' : '4x';
  if (_limiterWaveshaper) _limiterWaveshaper.oversample = level;
  if (_bassExciterDist)   _bassExciterDist.oversample   = level;
}

// ── Debug API — caller does: window._mbxAudio = audioEngine.getDebugInfo ─────
export function getDebugInfo() {
  return {
    corsAvailable:        _corsAvailable,
    mediaSource:          _mediaSource,
    gainNode:             _gainNode,
    audioCtx:             _audioCtx,
    rewiring:             _rewiring,
    limiterComp:          _limiterCompressor,
    limiterGainReduction: _limiterCompressor?.reduction ?? 0,
    bassExciterOn:        !!_bassExciterIn,
    bassExciterBlend:     _bassExciterGain?.gain.value ?? null,
    stereoWidenerOn:      !!_splitter,
    airShelfFreq:         _airShelf?.frequency.value ?? null,
    airShelfGain:         _airShelf?.gain.value ?? null,
    cfDelayTime:          _cfDelayL?.delayTime.value ?? null,
    cfHpFreq:             _cfHpL?.frequency.value ?? null,
    eqOn:                 _eqOn,
    eqGains:              [..._eqGains],
    eqNodes:              _eqNodes,
    crossfeedOn:          _cfOn,
    limiterAttack:        _limiterCompressor?.attack.value     ?? null,
    limiterRelease:       _limiterCompressor?.release.value    ?? null,
    eqHeadroomGainValue:  _eqHeadroomGain?.gain.value          ?? null,
    preMixGainValue:      _preMixGain?.gain.value              ?? null,
    volumeGainValue:      _volumeGain?.gain.value              ?? null,
    audioCtxSampleRate:   _audioCtx?.sampleRate                ?? null,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _pushEqState(preset = null) {
  if (!preset) preset = _detectPreset();
  _eqStateStore.set({ gains: [..._eqGains], on: _eqOn, preset });
}

function _detectPreset() {
  for (const [name, gains] of Object.entries(EQ_PRESETS)) {
    if (gains.every((g, i) => Math.abs(g - _eqGains[i]) < 0.01)) return name;
  }
  return 'Custom';
}

function _buildLimiterChain(ctx) {
  _limiterCompressor = ctx.createDynamicsCompressor();
  _limiterCompressor.threshold.value = -2;  // aligned with waveshaper CEIL (0.794 = −2dBFS)
  _limiterCompressor.knee.value      =  2;
  _limiterCompressor.ratio.value     = 10;
  _limiterCompressor.attack.value    = 0.003; // 3ms — prevents DC click on CarPlay/car DAC (1ms regressed this)
  _limiterCompressor.release.value   = 0.08;  // 80ms — transparent recovery, eliminates pumping on Bollywood/EDM
  _limiterWaveshaper = ctx.createWaveShaper();
  _limiterWaveshaper.oversample = _ipodMode ? '2x' : '4x';
  const N = 65536;
  const curve = new Float32Array(N);
  const CEIL = 0.794;   // knee threshold = −2 dBFS
  // F15 + F16: the previous curve asymptoted to ~0.993 (−0.06 dBFS), so the claimed
  // "−2 dBFS ceiling" was false and transients rode near full scale. It also had a
  // slope discontinuity at the knee (1 → 2), injecting odd-harmonic grit.
  // New soft-knee: f(a) = CEIL + KNEE·tanh((a−CEIL)/KNEE). tanh'(0)=1 makes the knee
  // C¹-continuous (slope matches the unity region → no kink), and the curve asymptotes
  // to CEIL+KNEE ≈ 0.844 (≈ −1.5 dBFS) — a genuine brick-wall ceiling below 0 dBFS.
  const KNEE = 0.05;
  for (let i = 0; i < N; i++) {
    const x = (i * 2) / N - 1;
    const a = Math.abs(x);
    if (a <= CEIL) {
      curve[i] = x;
    } else {
      const sign = x < 0 ? -1 : 1;
      curve[i] = sign * (CEIL + KNEE * Math.tanh((a - CEIL) / KNEE));
    }
  }
  _limiterWaveshaper.curve = curve;
  _limiterCompressor.connect(_limiterWaveshaper);
}

function _teardownLimiterChain() {
  [_limiterWaveshaper, _limiterCompressor].forEach(n => {
    if (n) { try { n.disconnect(); } catch {} }
  });
  _limiterWaveshaper = _limiterCompressor = null;
}

function _buildBassExciter(ctx) {
  _bassExciterIn = ctx.createBiquadFilter();
  _bassExciterIn.type = 'bandpass';
  _bassExciterIn.frequency.value = 65;
  _bassExciterIn.Q.value = 1.2; // narrower: 38–92Hz sub-bass zone only (was 0.7 = 19–111Hz)
  _bassExciterDist = ctx.createWaveShaper();
  _bassExciterDist.oversample = _ipodMode ? '2x' : '4x';
  const N = 4096;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i * 2) / N - 1;
    // Chebyshev soft saturation: odd harmonics only, zero DC offset, warm bass enhancement
    curve[i] = Math.max(-1, Math.min(1, 1.5 * x - 0.5 * x * x * x));
  }
  _bassExciterDist.curve = curve;
  _bassExciterOut = ctx.createBiquadFilter();
  _bassExciterOut.type = 'lowpass';
  _bassExciterOut.frequency.value = 160;
  _bassExciterOut.Q.value = 0.707;
  // DC-blocking HPF — symmetric Chebyshev curve has near-zero DC, but keep as safety net
  _bassExciterDcHpf = ctx.createBiquadFilter();
  _bassExciterDcHpf.type = 'highpass';
  _bassExciterDcHpf.frequency.value = 5;
  _bassExciterDcHpf.Q.value = 0.707;
  _bassExciterGain = ctx.createGain();
  _bassExciterGain.gain.value = 0.08; // reduced from 0.12: Chebyshev generates less IMD, 8% is equivalent warmth
  _bassExciterIn.connect(_bassExciterDist);
  _bassExciterDist.connect(_bassExciterOut);
  _bassExciterOut.connect(_bassExciterDcHpf); // FIX: route through DC-block HPF
  _bassExciterDcHpf.connect(_bassExciterGain);
}

function _teardownBassExciter() {
  [_bassExciterGain, _bassExciterDcHpf, _bassExciterOut, _bassExciterDist,
   _bassExciterIn, _preMixGain, _eqHeadroomGain].forEach(n => {
    if (n) { try { n.disconnect(); } catch {} }
  });
  _bassExciterIn = _bassExciterDist = _bassExciterOut = _bassExciterDcHpf =
  _bassExciterGain = _preMixGain = _eqHeadroomGain = null;
}

function _buildEqChain(ctx) {
  _eqNodes = EQ_BANDS.map((b, i) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = EQ_Q[i];
    f.gain.value = _eqOn ? _eqGains[i] : 0;
    return f;
  });
  for (let i = 0; i < _eqNodes.length - 1; i++) _eqNodes[i].connect(_eqNodes[i + 1]);
}

function _teardownEqChain() {
  _eqNodes.forEach(n => { try { n.disconnect(); } catch {} });
  _eqNodes = [];
}

// F29: the air-shelf adds a fixed +1 dB at 16kHz downstream of headroom compensation,
// so air-heavy material ran ~1 dB hotter into the limiter than the model assumed.
// Fold that constant into the headroom target so the pre-limiter peak matches intent.
const _FIXED_POST_EQ_BOOST_DB = 1.0; // _airShelf.gain (highshelf +1 dB)

// F35: setTargetAtTime instead of direct .value writes — a fast slider drag steps
// biquad coefficients discontinuously, producing an audible zipper/click. A 10ms
// time constant smooths the ramp with no perceptible lag.
function _rampGain(param, target) {
  if (!param) return;
  if (_audioCtx) param.setTargetAtTime(target, _audioCtx.currentTime, 0.01);
  else param.value = target;
}

function _computeEqHeadroomGain() {
  const maxBoostDb = (_eqOn ? Math.max(0, ..._eqGains) : 0) + _FIXED_POST_EQ_BOOST_DB;
  const gain = Math.pow(10, -maxBoostDb / 20); // full attenuation: prevents limiter pumping on bass presets
  if (_eqHeadroomGain) _rampGain(_eqHeadroomGain.gain, gain);
}

function _applyEqGains() {
  if (_rewiring) return;
  _eqNodes.forEach((n, i) => { _rampGain(n.gain, _eqOn ? _eqGains[i] : 0); });
  _computeEqHeadroomGain();
}

function _saveEqState() {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(EQ_KEY, JSON.stringify(_eqGains));
  localStorage.setItem(EQ_KEY + '_on', String(_eqOn));
}

function _buildCrossfeed(ctx) {
  const blend = 0.25;
  const direct = 1.0 - blend;
  _cfSplit = ctx.createChannelSplitter(2);
  _cfMerge = ctx.createChannelMerger(2);
  const _cfDirectL = ctx.createGain(); _cfDirectL.gain.value = direct;
  const _cfDirectR = ctx.createGain(); _cfDirectR.gain.value = direct;
  // HPF at 300Hz: ILD operates from ~200Hz up; was 700Hz which cut most useful midrange
  _cfHpR = ctx.createBiquadFilter();
  _cfHpR.type = 'highpass'; _cfHpR.frequency.value = 300; _cfHpR.Q.value = 0.707;
  _cfHpL = ctx.createBiquadFilter();
  _cfHpL.type = 'highpass'; _cfHpL.frequency.value = 300; _cfHpL.Q.value = 0.707;
  // ITD delay: 0.6ms (0.0006s) — approximated ear-to-ear travel time for contralateral path
  _cfDelayL = ctx.createDelay(0.005); _cfDelayL.delayTime.value = 0.0006;
  _cfDelayR = ctx.createDelay(0.005); _cfDelayR.delayTime.value = 0.0006;
  _cfGainR = ctx.createGain(); _cfGainR.gain.value = blend;
  _cfGainL = ctx.createGain(); _cfGainL.gain.value = blend;
  _cfSplit.connect(_cfDirectL, 0); _cfDirectL.connect(_cfMerge, 0, 0);
  _cfSplit.connect(_cfDirectR, 1); _cfDirectR.connect(_cfMerge, 0, 1);
  // R→L cross path: R channel → HPF → delay → gain → L output
  _cfSplit.connect(_cfHpR, 1); _cfHpR.connect(_cfDelayR); _cfDelayR.connect(_cfGainR); _cfGainR.connect(_cfMerge, 0, 0);
  // L→R cross path: L channel → HPF → delay → gain → R output
  _cfSplit.connect(_cfHpL, 0); _cfHpL.connect(_cfDelayL); _cfDelayL.connect(_cfGainL); _cfGainL.connect(_cfMerge, 0, 1);
  _cfSplit._directL = _cfDirectL;
  _cfSplit._directR = _cfDirectR;
}

function _teardownCrossfeed() {
  if (_cfSplit) {
    try { _cfSplit._directL?.disconnect(); } catch {}
    try { _cfSplit._directR?.disconnect(); } catch {}
    _cfSplit._directL = null; // prevent GainNode leak across rewires
    _cfSplit._directR = null;
  }
  [_cfGainL, _cfGainR, _cfDelayL, _cfDelayR, _cfHpL, _cfHpR, _cfMerge, _cfSplit].forEach(n => {
    if (n) { try { n.disconnect(); } catch {} }
  });
  _cfSplit = _cfMerge = _cfHpL = _cfHpR = _cfGainL = _cfGainR = _cfDelayL = _cfDelayR = null;
}

function _buildStereoWidener(ctx) {
  const Wc   = 0.7;
  const mid  = 0.5;
  const side = 0.5 * Wc;
  _splitter   = ctx.createChannelSplitter(2);
  _merger     = ctx.createChannelMerger(2);
  _midGain    = ctx.createGain(); _midGain.gain.value    =  mid;
  _sideGain   = ctx.createGain(); _sideGain.gain.value   =  side;
  _sideGainNeg = ctx.createGain(); _sideGainNeg.gain.value = -side; // was _haasDelay
  _msInvGain  = ctx.createGain(); _msInvGain.gain.value  = -1;
  _splitter.connect(_midGain, 0); _splitter.connect(_midGain, 1);
  _midGain.connect(_merger, 0, 0); _midGain.connect(_merger, 0, 1);
  _splitter.connect(_sideGain, 0); _sideGain.connect(_merger, 0, 0);
  _splitter.connect(_msInvGain, 1); _msInvGain.connect(_sideGain);
  _splitter.connect(_sideGainNeg, 0); _sideGainNeg.connect(_merger, 0, 1);
  _sideGainR = ctx.createGain(); _sideGainR.gain.value = side;
  _splitter.connect(_sideGainR, 1); _sideGainR.connect(_merger, 0, 1);
  _airShelf = ctx.createBiquadFilter();
  _airShelf.type = 'highshelf';
  _airShelf.frequency.value = 16000; // moved from 14kHz: avoids sibilance/presence harshness
  _airShelf.gain.value = 1.0;        // reduced from +2dB: matches Spotify/Apple air correction target
  _merger.connect(_airShelf);
}

function _teardownStereoWidener() {
  [_airShelf, _merger, _sideGainR, _sideGainNeg, _msInvGain,
   _sideGain, _midGain, _splitter].forEach(n => {
    if (n) { try { n.disconnect(); } catch {} }
  });
  _splitter = _merger = _midGain = _sideGain = _sideGainNeg =
  _msInvGain = _sideGainR = _airShelf = null;
}

function _rewireAudio() {
  if (!_audioCtx || _rewiring) return;
  _rewiring = true;
  if (_callbacks.onLog) _callbacks.onLog('info', 'EQ rewire start', {
    ctxState: _audioCtx?.state ?? 'unknown',
    cfOn: _cfOn,
  });
  try {
    _teardownLimiterChain();
    _teardownBassExciter();
    _teardownEqChain();
    _teardownCrossfeed();
    _teardownStereoWidener();
    if (_callbacks.onLog) _callbacks.onLog('info', 'EQ rewire: gainNode pre-teardown', { gainValue: _gainNode?.gain.value ?? null, volumeGain: _volumeGain?.gain.value ?? null, ctxState: _audioCtx?.state ?? 'unknown' });
    _gainNode.disconnect();
    // NOTE: _gainNode.disconnect() only severs _gainNode's outputs — the upstream
    // _mediaSource→_gainNode edge is never broken, so we must NOT reconnect it here
    // or each rewire stacks a duplicate +6dB connection.
    // Re-wire gainNode→volumeGain in case volumeGain was also disconnected
    if (_volumeGain) { try { _gainNode.connect(_volumeGain); } catch {} }

    _buildBassExciter(_audioCtx);
    _buildEqChain(_audioCtx);
    if (_cfOn) _buildCrossfeed(_audioCtx);
    _buildStereoWidener(_audioCtx);
    _buildLimiterChain(_audioCtx);

    _preMixGain = _audioCtx.createGain();
    _preMixGain.gain.value = 1.0;
    // DSP chain input is volumeGain (post-LUFS), not gainNode directly
    _volumeGain.connect(_preMixGain);
    if (_bassExciterIn) _volumeGain.connect(_bassExciterIn);
    if (_bassExciterGain) _bassExciterGain.connect(_preMixGain);

    _eqHeadroomGain = _audioCtx.createGain();
    _preMixGain.connect(_eqHeadroomGain);
    _computeEqHeadroomGain();

    _eqHeadroomGain.connect(_eqNodes[0]);
    const _eqOut = _eqNodes[_eqNodes.length - 1];
    if (_cfOn && _cfSplit) {
      _eqOut.connect(_cfSplit);
      _cfMerge.connect(_splitter);
    } else {
      _eqOut.connect(_splitter);
    }
    _airShelf.connect(_limiterCompressor);
    _limiterWaveshaper.connect(_audioCtx.destination);
  } finally {
    _rewiring = false;
    if (_callbacks.onLog) _callbacks.onLog('info', 'EQ rewire done', {
      eqNodes: _eqNodes.length,
      cfOn:    _cfOn,
    });
  }
  _pushEqState();
}
