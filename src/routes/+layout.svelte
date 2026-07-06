<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import * as audioEngine from '$lib/audioEngine.js';
  import { extractAndApplyAccent } from '$lib/colorEngine.js';
  import { gateToken } from '$lib/stores/gate.js';
  import { onEnded, next, prev, play, setPreloadElement, isTransitioningTrack, onDeferredPlay, onClearDeferredPlay, carPlayUpdateNowPlaying, carPlayUpdatePlaybackState } from '$lib/playback.js';
  import { Log } from '$lib/logger.js';
  import { APP_VERSION } from '$lib/api.js';
  import { intelPrune } from '$lib/smartPlay.js';
  import { initAutoTest } from '$lib/autotest.js';
  import { idbGetAll } from '$lib/idb.js';
  import { downloadedIds } from '$lib/stores/library.js';
  import {
    playing, userPaused, nowSong, seekProgress, currentTime, duration,
    loadingUrl, offlineBlobUrl, seeking, setAudioElement, getAudioElement
  } from '$lib/stores/playback.js';
  import { toast, isOnline, updateAvailable, elderView, iPodMode } from '$lib/stores/ui.js';
  import PasscodeGate from '$lib/components/gate/PasscodeGate.svelte';
  import NetworkBanner from '$lib/components/layout/NetworkBanner.svelte';
  import StagingBanner from '$lib/components/layout/StagingBanner.svelte';
  import MiniPlayer from '$lib/components/player/MiniPlayer.svelte';
  import NowPlaying from '$lib/components/player/NowPlaying.svelte';
  import EQPanel from '$lib/components/player/EQPanel.svelte';
  import QueuePanel from '$lib/components/player/QueuePanel.svelte';
  import SmartQueueBadge from '$lib/components/player/SmartQueueBadge.svelte';
  import TabBar from '$lib/components/tabs/TabBar.svelte';
  import Toast from '$lib/components/shared/Toast.svelte';
  import ActionSheet from '$lib/components/shared/ActionSheet.svelte';
  import PromptModal from '$lib/components/shared/PromptModal.svelte';
  import UpdateBanner from '$lib/components/layout/UpdateBanner.svelte';
  import '../app.css';

  // ── Audio element bindings — NEVER re-mount these ─────────────────────────
  let audioEl;
  let audioPreloadEl;

  // Throttle setPositionState success log to once per 10s (fires 30-60x/sec otherwise)
  let _lastPosLogTs = 0;

  // Derived: is gate unlocked?
  $: unlocked = $gateToken === '278b0ebf70ec6ed8b4c6480de49a1650ace8d513d277e1374801564e49186d37';

  // Track accent color updates from nowSong changes — guard by id to avoid double-fire
  // (play() updates nowSong twice: once at start, again when stream metadata arrives)
  let _lastAccentId = null;
  $: if ($nowSong?.image && $nowSong.id !== _lastAccentId) {
    _lastAccentId = $nowSong.id;
    extractAndApplyAccent($nowSong.image, $nowSong.id);
  }

  onMount(() => {
    // ── Single-instance lock (prevents double-audio when iOS opens a second PWA tab) ──
    // When a new instance loads it broadcasts TAKE_OVER; any older tab hears it and
    // immediately pauses audio. This eliminates the "double sound" bug seen in logs
    // where two App-started events appear within ~1s of each other.
    const _tabId = Math.random().toString(36).slice(2);
    let _isActiveTab = true;
    let _bc = null;
    try {
      _bc = new BroadcastChannel('mbx_tab_lock');
      _bc.onmessage = (e) => {
        if (e.data?.type === 'TAKE_OVER' && e.data.id !== _tabId) {
          // Another tab took over — this instance is now a background zombie.
          // 1. Stop any current audio immediately.
          // 2. Override audioEl.play so future play() calls in this instance silently no-op.
          //    This prevents the background instance from responding to the same user tap
          //    that the new foreground instance also receives.
          _isActiveTab = false;
          if (audioEl && !audioEl.paused) { audioEl.pause(); userPaused.set(true); }
          if (audioEl) audioEl.play = () => Promise.resolve();
        }
      };
      // Announce this instance as the new active tab
      _bc.postMessage({ type: 'TAKE_OVER', id: _tabId });
    } catch {}

    // Hand audio elements to playback store and audio engine
    setAudioElement(audioEl);
    setPreloadElement(audioPreloadEl);

    // Init logger first so all subsequent events are captured
    Log.init(APP_VERSION);
    intelPrune();
    initAutoTest();

    // Parsed early, applied after audioEngine.init() below
    let _resumePosition = null;
    let _resumeState = null;
    // Guard: block onEnded from auto-advancing queue during the resume window.
    // Without this, the restored audio element can fire 'ended' prematurely on
    // Capacitor/WKWebView (iOS 15) before loadedmetadata seeks to the saved position,
    // causing the queue to skip ahead uncontrollably.
    let _resuming = false;
    try {
      const _resumeRaw = sessionStorage.getItem('mbx_resume');
      if (_resumeRaw) { sessionStorage.removeItem('mbx_resume'); _resumeState = JSON.parse(_resumeRaw); }
    } catch {}

    audioEl.addEventListener('loadedmetadata', () => {
      if (_resumePosition !== null && _resumePosition > 0) {
        try { audioEl.currentTime = _resumePosition; } catch {}
        _resumePosition = null;
      }
      // Resume window ends once metadata is loaded and position is seeked
      _resuming = false;
      duration.set(audioEl.duration || 0);
    });

    // Init audio engine — does NOT create AudioContext yet (lazy, on first gesture)
    audioEngine.init(audioEl, {
      getState: () => ({
        playing:      $playing,
        userPaused:   $userPaused,
        nowSong:      $nowSong,
        offlineBlobUrl: $offlineBlobUrl,
      }),
      onCorsUnavailable: () => {
        toast('Enhanced audio unavailable — EQ disabled for this stream');
      },
      onLog: (level, msg, data) => {
        if (level === 'warn') { Log.warn(msg, data ?? null); console.warn('[Engine]', msg, data ?? ''); }
        else { Log.info(msg, data ?? null); console.info('[Engine]', msg, data ?? ''); }
      },
      // Deferred-play callbacks: fired by audioEngine when the AudioContext recovers
      // from an iOS interrupt. playback.js checks _pendingPlaySong and plays it.
      onDeferredPlay:      () => onDeferredPlay(),
      onClearDeferredPlay: () => onClearDeferredPlay(),
    });

    // ── Reload recovery: restore song after iOS memory-pressure eviction ──────────
    // pagehide wrote { song, position, wasPlaying } to sessionStorage before iOS killed the page.
    // Now that audioEngine is initialised, restore the song into the UI and seek to position.
    // iOS blocks autoplay without a gesture — user must tap play once; position is preserved.
    if (_resumeState?.song) {
      _resumePosition = _resumeState.position ?? 0;
      _resuming = true;  // block premature onEnded during restore
      // Reset queue to just this one song — prevents the stale queue from the
      // previous session driving next() after the restored song ends.
      // In Capacitor the WebView never unloads, so store state persists in memory.
      play(_resumeState.song, [_resumeState.song], 0).catch(() => { _resuming = false; });
      Log.info('Reload recovery: song restored after iOS eviction', {
        song:     _resumeState.song?.name ?? null,
        position: _resumeState.position,
      });
    }

    // Apply elder view if saved from previous session
    if ($elderView) document.body.classList.add('elder-view');

    // Apply iPod mode body class if saved
    if ($iPodMode) {
      document.body.classList.add('ipod-mode');
      audioEngine.setIpodMode(true);
      // iOS 15 lacks navigator.audioSession — silent switch will mute music
      if (!('audioSession' in navigator) && /iPod|iPhone/.test(navigator.userAgent)) {
        const _warned = localStorage.getItem('mbx_ipod_silent_warned');
        if (!_warned) {
          setTimeout(() => toast('Tip: turn off silent switch for background music on iOS 15', 5000), 2000);
          localStorage.setItem('mbx_ipod_silent_warned', '1');
        }
      }
    }

    // D21: Drive --mini-visible so #content padding has no dead gap on fresh install
    const _unsubMini = nowSong.subscribe(s => {
      document.documentElement.style.setProperty('--mini-visible', s ? '1' : '0');
    });

    // Hydrate downloaded IDs from IDB (metadata only — no blobs)
    idbGetAll().then(records => {
      downloadedIds.set(new Set(records.map(r => r.id)));
    }).catch(() => {});

    // Expose debug hook in dev
    window._mbxAudio = audioEngine.getDebugInfo;
    // Test hook: window._mbxSetAirPlay(true/false) simulates AirPlay activation without hardware
    // ── Audio element event listeners ─────────────────────────────────────────
    // F3: stream-failure circuit breaker state (declared before the listeners that use it)
    let _consecutiveSongFails = 0;
    let _lastFailedSongId = null;
    const MAX_CONSECUTIVE_FAILS = 4;
    audioEl.addEventListener('play', () => {
      playing.set(true);
      loadingUrl.set(false);
      audioEngine.onPlaybackStarted();
    });

    audioEl.addEventListener('pause', () => {
      // Suppress spurious pause fired by browser when audio.src is reassigned during track transition
      if (isTransitioningTrack()) return;
      playing.set(false);
      audioEngine.onPlaybackPaused();
    });

    audioEl.addEventListener('playing', () => {
      loadingUrl.set(false);
      // F3: a song is actually playing — reset the stream-failure circuit breaker.
      _consecutiveSongFails = 0;
      _lastFailedSongId = null;
    });

    audioEl.addEventListener('waiting', () => {
      loadingUrl.set(true);
    });

    audioEl.addEventListener('timeupdate', () => {
      const t = audioEl.currentTime;
      const d = audioEl.duration || 0;
      currentTime.set(t);
      duration.set(d);
      if (!$seeking && d > 0) seekProgress.set(t / d);
      if ('mediaSession' in navigator && d > 0 && isFinite(t) && isFinite(d)) {
        try {
          navigator.mediaSession.setPositionState({ duration: d, playbackRate: 1.0, position: Math.min(t, d) });
          const _now = Date.now();
          if (_now - _lastPosLogTs > 10000) { _lastPosLogTs = _now; Log.info('MediaSession: setPositionState ok', { t: Math.round(t), d: Math.round(d) }); }
        } catch (e) {
          Log.warn('MediaSession: setPositionState failed', { err: e?.message, t, d });
        }
      }
    });

    audioEl.addEventListener('ended', () => {
      // Block auto-advance during resume window — prevents queue skipping when
      // Capacitor/WKWebView fires 'ended' before loadedmetadata seeks to saved position.
      if (_resuming) { Log.info('Song ended suppressed during resume window', { name: $nowSong?.name ?? null }); return; }
      playing.set(false);
      Log.info('Song ended naturally', {
        name:     $nowSong?.name   ?? null,
        duration: audioEl.duration ?? null,
      });
      if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = 'paused'; Log.info('MediaSession: playbackState →', { state: 'paused', context: 'ended' }); }
      carPlayUpdatePlaybackState(false);
      onEnded();
    });

    // D7: audio error — show toast + auto-retry up to 2 times, then skip to next
    // F3: circuit breaker — if several distinct songs fail in a row (API/CDN down),
    // stop skipping so we don't spin next() through the whole queue forever.
    let _audioErrRetries = 0;
    let _audioErrSongId  = null;
    audioEl.addEventListener('error', () => {
      loadingUrl.set(false);
      const err = audioEl.error;
      Log.error('Audio element error', {
        code:    err?.code    ?? null,
        message: err?.message ?? null,
        src:     audioEl.src ? audioEl.src.slice(0, 120) : null,
      });
      const curId = get(nowSong)?.id ?? null;
      if (curId !== _audioErrSongId) { _audioErrRetries = 0; _audioErrSongId = curId; }
      if (_audioErrRetries < 2) {
        _audioErrRetries++;
        toast(`Playback error — retrying (${_audioErrRetries}/2)…`);
        setTimeout(() => { try { audioEl.load(); audioEl.play().catch(() => {}); } catch {} }, 800);
      } else {
        // This song has exhausted retries. Track distinct consecutive song failures.
        if (curId !== _lastFailedSongId) { _consecutiveSongFails++; _lastFailedSongId = curId; }
        _audioErrRetries = 0;
        if (_consecutiveSongFails >= MAX_CONSECUTIVE_FAILS) {
          // Streaming is broken (provider/CDN down) — stop the skip-loop and rest.
          _consecutiveSongFails = 0;
          _lastFailedSongId = null;
          playing.set(false);
          userPaused.set(true);
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
          Log.error('Playback circuit breaker tripped — too many consecutive stream failures');
          toast('Streaming unavailable right now — playback paused');
        } else {
          toast('Playback failed — skipping to next track');
          setTimeout(() => { try { next(); } catch {} }, 500);
        }
      }
    });

    // ── MediaSession action handlers (registered once, never re-registered) ──
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play',         () => { Log.info('MediaSession: play');         audioEl.play().then(() => Log.info('MediaSession: play succeeded')).catch(e => Log.warn('MediaSession: play failed', { name: e?.name, message: e?.message })); });
      navigator.mediaSession.setActionHandler('pause',        () => { Log.info('MediaSession: pause');        try { audioEl.pause(); userPaused.set(true); audioEngine.onUserPaused(); Log.info('MediaSession: pause succeeded'); } catch (e) { Log.warn('MediaSession: pause failed', { name: e?.name, message: e?.message }); } });
      navigator.mediaSession.setActionHandler('stop',         () => { Log.info('MediaSession: stop');         try { audioEl.pause(); userPaused.set(true); audioEngine.onUserPaused(); Log.info('MediaSession: stop succeeded'); }  catch (e) { Log.warn('MediaSession: stop failed',  { name: e?.name, message: e?.message }); } });
      navigator.mediaSession.setActionHandler('nexttrack',    () => { Log.info('MediaSession: nexttrack');    try { next(); } catch (e) { Log.warn('MediaSession: nexttrack error', { error: e?.message }); } });
      navigator.mediaSession.setActionHandler('previoustrack',() => { Log.info('MediaSession: previoustrack'); try { prev(); } catch (e) { Log.warn('MediaSession: previoustrack error', { error: e?.message }); } });
      navigator.mediaSession.setActionHandler('seekto',       (d) => { Log.info('MediaSession: seekto', { seekTime: d.seekTime }); try { if (d.seekTime != null) audioEl.currentTime = d.seekTime; } catch {} });
      navigator.mediaSession.setActionHandler('seekbackward', (d) => { const skip = d?.seekOffset ?? 15; Log.info('MediaSession: seekbackward', { skip }); try { audioEl.currentTime = Math.max(0, audioEl.currentTime - skip); } catch {} });
      navigator.mediaSession.setActionHandler('seekforward',  (d) => { const skip = d?.seekOffset ?? 15; Log.info('MediaSession: seekforward',  { skip }); try { audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + skip); } catch {} });
    }

    // ── CarPlay native bridge — Capacitor MBXCarPlay plugin ──────────────────
    // Register for transport commands coming from the CarPlay head unit via native MPRemoteCommandCenter.
    // These fire when the user taps Play/Pause/Next/Prev/Skip on the car screen.
    const _capPlugin = window?.Capacitor?.Plugins?.MBXCarPlay;
    let _cpListener = null;
    if (_capPlugin) {
      _capPlugin.addListener('carplayCommand', ({ event }) => {
        Log.info('CarPlay: command received', { event });
        if (event === 'play')         { audioEl.play().catch(() => {}); carPlayUpdatePlaybackState(true); }
        else if (event === 'pause')   { audioEl.pause(); userPaused.set(true); audioEngine.onUserPaused(); carPlayUpdatePlaybackState(false); }
        else if (event === 'next')    { next(); }
        else if (event === 'prev')    { prev(); }
        else if (event === 'seekBackward') { audioEl.currentTime = Math.max(0, audioEl.currentTime - 15); }
        else if (event === 'seekForward')  { audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 15); }
      }).then(l => { _cpListener = l; });
      Log.info('CarPlay: MBXCarPlay plugin listener registered');
    }

    // ── Visibility / page lifecycle ──────────────────────────────────────────
    // Collect all window/document listeners so they can be removed on destroy
    // (prevents HMR double-registration and ensures clean teardown)
    const _listeners = [];
    function _on(target, type, fn) { target.addEventListener(type, fn); _listeners.push([target, type, fn]); }

    _on(document, 'visibilitychange', () => {
      if (!_isActiveTab) return;
      if (document.hidden) {
        // Assert playback audio session BEFORE starting keep-alive so iOS does not
        // downgrade the session to 'ambient' (which gets silenced in the background).
        if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
        audioEngine.startBgKeepAlive();
        if ('mediaSession' in navigator && $playing && !$userPaused) { navigator.mediaSession.playbackState = 'playing'; Log.info('MediaSession: playbackState →', { state: 'playing', context: 'visibilitychange-bg' }); }
        return;
      }
      audioEngine.stopBgKeepAlive();
      if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
      (async () => {
        await audioEngine.resumeIfSuspended();
        if (!$userPaused && $nowSong && audioEl.paused) {
          audioEl.play().catch(() => {});
        }
        if ('mediaSession' in navigator) { const _s = (!$userPaused && $nowSong) ? 'playing' : 'paused'; navigator.mediaSession.playbackState = _s; Log.info('MediaSession: playbackState →', { state: _s, context: 'visibilitychange-fg' }); }
      })();
    });

    _on(window, 'pageshow', (e) => {
      if (!_isActiveTab || !e.persisted) return;
      (async () => {
        await audioEngine.resumeIfSuspended();
        if (!$userPaused && $nowSong && audioEl.paused) audioEl.play().catch(() => {});
      })();
    });

    _on(window, 'pagehide', () => {
      if ($playing && !$userPaused && 'mediaSession' in navigator) { navigator.mediaSession.playbackState = 'playing'; Log.info('MediaSession: playbackState →', { state: 'playing', context: 'pagehide' }); }
      // Persist playback position so iOS reload (memory eviction) can auto-resume.
      // Use sessionStorage — survives reload within the same PWA session, cleared on close.
      if ($nowSong && !$userPaused) {
        try {
          sessionStorage.setItem('mbx_resume', JSON.stringify({
            song:        $nowSong,
            position:    audioEl.currentTime ?? 0,
            wasPlaying:  $playing && !$userPaused,
          }));
        } catch {}
      }
      const blobUrl = $offlineBlobUrl;
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch {} offlineBlobUrl.set(null); }
    });

    _on(document, 'freeze', () => {
      if ($playing && !$userPaused && 'mediaSession' in navigator) { navigator.mediaSession.playbackState = 'playing'; Log.info('MediaSession: playbackState →', { state: 'playing', context: 'freeze' }); }
    });

    _on(document, 'resume', () => {
      if (!_isActiveTab) return;
      (async () => {
        await audioEngine.resumeIfSuspended();
        if (!$userPaused && $nowSong && audioEl.paused) audioEl.play().catch(() => {});
      })();
    });

    // ── Network status ────────────────────────────────────────────────────────
    isOnline.set(navigator.onLine);
    _on(window, 'online',  () => isOnline.set(true));
    _on(window, 'offline', () => isOnline.set(false));

    // ── SW update ─────────────────────────────────────────────────────────────
    _on(window, 'sw-update-ready', e => {
      const { waiting, newVersion } = e.detail;
      const _parseVer = s => { const m = s?.match(/v(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1],+m[2],+m[3]] : [0,0,0]; };
      const [nm,ni,np] = _parseVer(newVersion);
      const [cm,ci,cp] = _parseVer(APP_VERSION);
      const isNewer = nm > cm || (nm===cm && ni > ci) || (nm===cm && ni===ci && np > cp);
      if (newVersion && isNewer) updateAvailable.set({ waiting, newVersion });
    });

    if ('audioSession' in navigator) navigator.audioSession.type = 'playback';

    return () => {
      try { _bc?.close(); } catch {}
      _listeners.forEach(([t, type, fn]) => t.removeEventListener(type, fn));
      _unsubMini();
      try { _cpListener?.remove(); } catch {}
    };
  });
</script>

<!-- CRITICAL: These two audio elements must NEVER be re-mounted.
     They live here in the root layout and nowhere else. -->
<audio
  id="audio"
  bind:this={audioEl}
  preload="metadata"
  playsinline
  webkit-playsinline
></audio>
<!-- F18: crossorigin MUST match the main #audio element's CORS mode ('anonymous').
     The preload element only ever buffers network stream URLs (offline songs use the
     IDB blob-preload path, never this element), so a static anonymous mode is safe.
     Without it, a URL buffered here as a non-CORS response can't be reused by the
     main element's CORS request — worst case it re-fetches and taints
     MediaElementSource, silently bypassing the entire EQ/limiter chain for that song. -->
<audio
  id="audio-preload"
  bind:this={audioPreloadEl}
  preload="auto"
  crossorigin="anonymous"
  playsinline
  webkit-playsinline
  style="visibility:hidden;position:absolute;width:0;height:0;pointer-events:none"
></audio>

<NetworkBanner />
<StagingBanner />

{#if unlocked}
  <div id="app">
    <div id="content">
      <slot />
    </div>
    <SmartQueueBadge />
    <MiniPlayer />
    <TabBar />
  </div>
  <NowPlaying />
  <EQPanel />
  <QueuePanel />
  <UpdateBanner />
  <Toast />
  <ActionSheet />
  <PromptModal />
{:else}
  <PasscodeGate />
{/if}
