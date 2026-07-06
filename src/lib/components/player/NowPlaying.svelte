<script>
  import { nowSong, playing, loadingUrl, seekProgress, currentTime, duration, seeking, shuffleOn, repeatMode, userPaused } from '$lib/stores/playback.js';
  import { npOpen, eqSheetOpen, queueOpen, showSheet, toast, iPodMode } from '$lib/stores/ui.js';
  import { whyChip } from '$lib/stores/smartplay.js';
  import { liked, playlists, downloadedIds } from '$lib/stores/library.js';
  import { togglePlay, prev, next, seek, createShuffledQueue } from '$lib/playback.js';
  import { intelTrackLike } from '$lib/smartPlay.js';
  import { fmt } from '$lib/utils.js';
  import { get } from 'svelte/store';
  import { downloadSong, removeDownload, idbGetAll } from '$lib/idb.js';
  import { apiStream } from '$lib/api.js';
  import BackButton from '$lib/components/shared/BackButton.svelte'; // D11

  // Lyrics state
  let lyricsOpen = false;
  let lyricsText = '';
  let lyricsLoading = false;

  async function openLyrics() {
    if (!$nowSong) return;
    lyricsOpen = true;
    if (lyricsText && _lyricsId === $nowSong.id) return;
    _lyricsId = $nowSong.id;
    lyricsText = '';
    lyricsLoading = true;
    try {
      const { SIGMA_API, apiFetch } = await import('$lib/api.js');
      const r = await apiFetch(`${SIGMA_API}/lyrics?id=${encodeURIComponent($nowSong.id)}`, { timeout: 6000, retries: 0 });
      const data = await r.json();
      // Strip all HTML tags from API response before rendering with {@html} — prevents XSS
      const raw = data?.data?.lyrics || data?.lyrics || 'Lyrics not available';
      // Sanitize via DOM textContent assignment — escapes <, >, &, and HTML entities,
      // making the result safe for {@html} rendering with <br> line breaks.
      const _tmp = document.createElement('div');
      _tmp.textContent = String(raw);
      lyricsText = _tmp.innerHTML;
    } catch { lyricsText = 'Lyrics not available'; }
    finally { lyricsLoading = false; }
  }
  let _lyricsId = null;

  let seekVal = 0;
  $: if (!$seeking) seekVal = Math.round($seekProgress * 1000);

  function onSeekStart()  { seeking.set(true); }
  function onSeekEnd()    { seek(seekVal / 1000); seeking.set(false); }
  function onSeekInput(e) { seekVal = +e.target.value; }

  $: elapsed  = fmt($currentTime);
  $: remain   = $duration > 0 ? '−' + fmt($duration - $currentTime) : '−0:00';

  $: isLiked = $liked.some(s => s.id === $nowSong?.id);

  function toggleLike() {
    if (!$nowSong) return;
    if (isLiked) {
      liked.update(arr => arr.filter(s => s.id !== $nowSong.id));
      toast('Removed from liked');
    } else {
      liked.update(arr => [{ ...$nowSong, likedAt: Date.now() }, ...arr]);
      intelTrackLike($nowSong);
      toast('Added to liked songs');
    }
  }

  function cycleShuffle() {
    shuffleOn.update(v => {
      const next = !v;
      if (next) createShuffledQueue(); // build shuffled order immediately so Next works right away
      return next;
    });
  }
  function cycleRepeat()  { repeatMode.update(v => (v + 1) % 3); }

  function addToPlaylist(song) {
    const pls = get(playlists);
    if (!pls.length) {
      toast('No playlists — create one in Library');
      return;
    }
    showSheet(`Add "${song.name}" to…`, pls.map(pl => ({
      label: pl.name,
      action: () => {
        playlists.update(arr => arr.map(p =>
          p.id === pl.id
            ? { ...p, songs: p.songs.some(s => s.id === song.id) ? p.songs : [...p.songs, song] }
            : p
        ));
        toast(`Added to ${pl.name}`);
      }
    })));
  }

  function onDownload(song) {
    const dl = get(downloadedIds).has(song.id);
    if (dl) {
      removeDownload(song, toast, null).catch(() => {});
    } else {
      downloadSong(song, toast, apiStream).catch(() => {});
    }
  }

  function onMenuBtn() {
    if (!$nowSong) return;
    const dl = get(downloadedIds).has($nowSong.id);
    showSheet($nowSong.name, [
      { label: 'Add to Playlist',                    action: () => addToPlaylist($nowSong) },
      { label: isLiked ? 'Remove from Liked' : 'Add to Liked', action: toggleLike },
      { label: dl ? 'Remove Download' : 'Download',  action: () => onDownload($nowSong) },
    ]);
  }

  // D17: repeat icons — paths are valid SVG, no <text> hack. Repeat-1 uses CSS ::after badge.
  const REPEAT_ICONS = [
    `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
    `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
    `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
  ];

  // D2: swipe-to-dismiss gesture state
  let swipeStartY = 0;
  let swipeDeltaY = 0;
  let _isSwiping = false;
  let swipeTransform = '';

  function onSwipeStart(e) {
    if (!$npOpen) return;
    swipeStartY = e.touches[0].clientY;
    swipeDeltaY = 0;
    _isSwiping = true;
    swipeTransform = '';
  }
  function onSwipeMove(e) {
    if (!_isSwiping) return;
    const dy = e.touches[0].clientY - swipeStartY;
    if (dy > 0) {
      swipeDeltaY = dy;
      swipeTransform = `translateY(${dy}px)`;
      if (dy > 10) e.preventDefault();
    }
  }
  function onSwipeEnd() {
    if (!_isSwiping) return;
    _isSwiping = false;
    if (swipeDeltaY > 120) {
      npOpen.set(false);
    }
    swipeDeltaY = 0;
    swipeTransform = '';
  }

  // D5: volume slider
  import { setVolume } from '$lib/playback.js';
  let volumeVal = 80;
  function onVolumeInput(e) { setVolume(parseFloat(e.target.value) / 100); }
</script>

<div id="np" class:open={$npOpen}>
  <div id="np-bg" style="background-image:url({$nowSong?.image || ''})"></div>
  <!-- D2: swipe-to-dismiss on the inner panel -->
  <div id="np-inner"
    style={swipeTransform ? `transform:${swipeTransform};transition:none` : ''}
    on:touchstart={onSwipeStart}
    on:touchmove={onSwipeMove}
    on:touchend={onSwipeEnd}
  >
    <!-- D2: handle is now a proper button -->
    <button id="np-handle" on:click={() => npOpen.set(false)} aria-label="Close player"></button>
    <div id="np-topbar">
      <!-- D1: .np-circle enlarged to 44px -->
      <button class="np-circle" id="np-close-btn" on:click={() => npOpen.set(false)} aria-label="Close player">✕</button>
      <div id="np-label">Now Playing</div>
      <button class="np-circle" id="np-menu-btn" on:click={onMenuBtn} aria-label="More options">•••</button>
    </div>

    <div id="np-art-wrap">
      <img
        id="np-art"
        src={$nowSong?.image || ''}
        alt={$nowSong?.name || ''}
        class:playing={$playing}
        class:paused-anim={!$playing && $nowSong}
      />
      {#if $loadingUrl}
        <div id="np-loading" class="show">
          <div class="spinner" style="border-color:rgba(255,255,255,.25);border-top-color:#fff;width:40px;height:40px;border-width:4px"></div>
        </div>
      {/if}
    </div>

    <div id="np-info">
      <div id="np-texts">
        <div id="np-song">{$nowSong?.name || '—'}</div>
        <div id="np-artist">{$nowSong?.artist || '—'}</div>
        {#if $nowSong?.quality}
          <div id="np-quality" class="visible">{$nowSong.quality}</div>
        {/if}
      </div>
      <!-- D4: ARIA label on like button -->
      <button id="np-like" class:liked={isLiked} on:click={toggleLike}
        aria-label={isLiked ? 'Remove from liked songs' : 'Add to liked songs'}
        aria-pressed={isLiked}>
        {isLiked ? '♥' : '♡'}
      </button>
    </div>

    <div id="np-seek-wrap">
      <!-- D4: ARIA attributes on seek bar -->
      <input
        id="np-seek"
        type="range" min="0" max="1000" step="1"
        bind:value={seekVal}
        on:mousedown={onSeekStart} on:touchstart={onSeekStart}
        on:mouseup={onSeekEnd}     on:touchend={onSeekEnd}
        on:input={onSeekInput}
        aria-label="Seek position"
        aria-valuemin="0" aria-valuemax="1000"
        aria-valuenow={seekVal}
        aria-valuetext={elapsed}
      />
      <div id="np-times">
        <span id="np-elapsed">{elapsed}</span>
        <span id="np-remain">{remain}</span>
      </div>
    </div>

    <!-- D5: volume slider between seek bar and transport controls -->
    <div id="np-vol-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="np-vol-icon">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      </svg>
      <input id="np-volume" type="range" min="0" max="100" step="1"
        bind:value={volumeVal}
        on:input={onVolumeInput}
        aria-label="Volume"
      />
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="np-vol-icon">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
    </div>

    <div id="np-controls">
      <!-- D1: .ctl min 44px touch target; D4: ARIA labels on all controls -->
      <button class="ctl" class:accent={$shuffleOn} class:dim={!$shuffleOn} id="np-shuffle-btn" on:click={cycleShuffle}
        aria-label="Shuffle {$shuffleOn ? 'on' : 'off'}" aria-pressed={$shuffleOn}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
          <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
        </svg>
      </button>
      <!-- D13: Lucide stroked prev icon -->
      <button class="ctl" id="np-prev-btn" on:click={prev} aria-label="Previous track">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>
        </svg>
      </button>
      <!-- D4: dynamic play/pause aria-label -->
      <button id="np-play" on:click={togglePlay} aria-label={$playing ? 'Pause' : 'Play'} aria-pressed={$playing}>
        {#if $loadingUrl}
          <div class="spinner" style="width:36px;height:36px;border-width:3px;border-color:rgba(255,255,255,.2);border-top-color:#fff"></div>
        {:else if $playing}
          <!-- D13: Lucide stroked pause -->
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
          </svg>
        {:else}
          <!-- D13: Lucide stroked play -->
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        {/if}
      </button>
      <!-- D13: Lucide stroked next icon -->
      <button class="ctl" id="np-next-btn" on:click={next} aria-label="Next track">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>
        </svg>
      </button>
      <!-- D17: repeat-1 badge via data-repeat + CSS ::after; D4: ARIA on repeat -->
      <button class="ctl" class:accent={$repeatMode > 0} class:dim={$repeatMode === 0} id="np-repeat-btn"
        on:click={cycleRepeat}
        data-repeat={$repeatMode}
        aria-label="Repeat {['off','all','one'][$repeatMode]}"
        aria-pressed={$repeatMode > 0}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          {@html REPEAT_ICONS[$repeatMode % REPEAT_ICONS.length] ?? ''}
        </svg>
      </button>
    </div>

    {#if $whyChip}
      <div id="np-why-chip">{$whyChip.label}</div>
    {/if}

    <!-- D1: np-footer min-height 44px; D4: aria-labels on all footer buttons -->
    <div id="np-footer">
      <button class="np-foot" id="np-add-pl-btn" on:click={() => $nowSong && addToPlaylist($nowSong)} aria-label="Add to playlist">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Playlist
      </button>
      <button class="np-foot" id="np-lyrics-btn" on:click={openLyrics} aria-label="Show lyrics">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>Lyrics
      </button>
      <button class="np-foot" id="np-queue-btn" on:click={() => queueOpen.set(true)} aria-label="Show queue">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/></svg>Queue
      </button>
      <button class="np-foot" id="np-dl-btn" on:click={() => $nowSong && onDownload($nowSong)}
        aria-label={$downloadedIds.has($nowSong?.id) ? 'Remove download' : 'Download song'}>
        {#if $downloadedIds.has($nowSong?.id)}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm-1 11.59L7.41 10 6 11.41l6 6 6-6L16.59 10 13 13.59V6h-2v7.59z"/></svg>Downloaded
        {:else}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download
        {/if}
      </button>
      <button class="np-foot" id="np-eq-btn" on:click={() => eqSheetOpen.set(true)} aria-label="Open equalizer">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <line x1="4" y1="18" x2="4" y2="6"/><line x1="9" y1="18" x2="9" y2="10"/>
          <line x1="14" y1="18" x2="14" y2="4"/><line x1="19" y1="18" x2="19" y2="12"/>
        </svg>EQ
      </button>
    </div>
  </div>
</div>

<!-- D20: lyrics now inline below footer, not a fullscreen overlay -->
{#if lyricsOpen}
  <div id="np-lyrics-inline">
    <div class="lyrics-inline-hdr">
      <!-- D11: shared BackButton -->
      <BackButton label="Player" onClick={() => lyricsOpen = false} />
      <div class="lyrics-title">Lyrics</div>
      <div style="width:44px"></div>
    </div>
    <div class="lyrics-song-name">{$nowSong?.name || ''}</div>
    <div class="lyrics-artist">{$nowSong?.artist || ''}</div>
    {#if lyricsLoading}
      <div class="lyrics-loading"><div class="spinner"></div></div>
    {:else}
      <div class="lyrics-body">{@html lyricsText.replace(/\n/g, '<br/>')}</div><!-- lyricsText is DOM-escaped via textContent — safe for {@html} -->
    {/if}
  </div>
{/if}

<style>
  #np {
    position: fixed; inset: 0; z-index: 80;
    transform: translateY(100%);
    transition: transform var(--np-dur) cubic-bezier(.32,.72,0,1);
    will-change: transform;
    pointer-events: none;
  }
  #np.open { transform: translateY(0); pointer-events: auto; }
  #np-bg {
    position: absolute; inset: 0;
    background-size: cover; background-position: center;
    filter: blur(60px) brightness(.25) saturate(1.8);
    transform: scale(1.15);
  }
  #np-inner {
    position: relative; z-index: 1;
    display: flex; flex-direction: column;
    height: 100%; padding: 0 20px;
    padding-top: env(safe-area-inset-top);
    padding-bottom: calc(env(safe-area-inset-bottom) + 12px);
    touch-action: pan-x;
  }
  /* D2: handle is a proper button — pill appearance preserved via pseudo-element */
  #np-handle {
    width: 44px; height: 44px; /* D1: full 44px touch target */
    background: none;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 0;
    touch-action: none; /* D2: exclusive touch handling for swipe */
  }
  #np-handle::after {
    content: ''; display: block;
    width: 36px; height: 4px; background: rgba(255,255,255,.25);
    border-radius: 2px;
  }
  #np-topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  /* D1: .np-circle enlarged from 32px to 44px */
  .np-circle { width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,.1); display: flex; align-items: center; justify-content: center; font-size: 13px; }
  #np-label { font-size: 13px; font-weight: 600; opacity: .7; }
  #np-art-wrap { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; overflow: hidden; }
  #np-art {
    width: min(72vw, 340px); height: min(72vw, 340px);
    max-width: 100%; max-height: 100%;
    border-radius: 16px; object-fit: cover;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    transition: transform .4s ease;
  }
  /* iPod Touch 4-inch: constrain art further so controls stay visible */
  :global(body.ipod-mode) #np-art {
    width: min(60vw, 200px); height: min(60vw, 200px);
  }
  #np-art.playing { transform: scale(1.04); }
  #np-art.paused-anim { transform: scale(0.96); }
  #np-loading { position: absolute; display: none; align-items: center; justify-content: center; }
  #np-loading.show { display: flex; }
  #np-info { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 8px; }
  #np-song { font-size: 20px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #np-artist { font-size: 15px; color: var(--fg3); }
  #np-quality { font-size: 10px; color: var(--accent); display: none; }
  #np-quality.visible { display: block; }
  #np-like { font-size: 22px; color: var(--fg3); padding: 4px 8px; }
  #np-like.liked { color: #ef4444; }
  #np-seek-wrap { margin: 4px 0 8px; }
  #np-seek {
    width: 100%; -webkit-appearance: none; height: 4px;
    background: rgba(255,255,255,.2); border-radius: 2px;
    padding: 12px 0; box-sizing: content-box; cursor: pointer;
  }
  #np-seek::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px;
    border-radius: 50%; background: #fff;
    box-shadow: 0 0 6px rgba(0,0,0,.4);
  }
  #np-times { display: flex; justify-content: space-between; font-size: 11px; color: var(--fg3); margin-top: 2px; }
  /* D5: volume slider */
  #np-vol-wrap { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
  .np-vol-icon { color: var(--fg3); flex-shrink: 0; }
  #np-volume {
    flex: 1; -webkit-appearance: none; height: 3px;
    background: rgba(255,255,255,.2); border-radius: 2px;
    padding: 10px 0; box-sizing: content-box; cursor: pointer;
  }
  #np-volume::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px;
    border-radius: 50%; background: #fff;
    box-shadow: 0 0 4px rgba(0,0,0,.4);
  }

  #np-controls { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
  /* D1: .ctl min 44x44 touch target */
  .ctl { color: var(--fg); min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; }
  .ctl.dim { opacity: .4; }
  .ctl.accent { color: var(--accent); opacity: 1; }
  /* D17: repeat-1 badge via CSS ::after — no SVG <text> hack */
  #np-repeat-btn[data-repeat="1"]::after {
    content: '1'; position: absolute; font-size: 8px; font-weight: 700;
    right: 0; top: 2px; line-height: 1;
    color: var(--accent);
  }
  #np-repeat-btn { position: relative; }
  #np-play {
    width: 72px; height: 72px; border-radius: 50%;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 20px hsla(var(--accent-h),var(--accent-s),var(--accent-l),.4);
  }
  #np-why-chip {
    margin: 4px 0; padding: 5px 12px; border-radius: 20px;
    background: hsla(var(--accent-h),var(--accent-s),var(--accent-l),.1);
    border: 1px solid hsla(var(--accent-h),var(--accent-s),var(--accent-l),.25);
    font-size: 11px; color: var(--fg2); text-align: center; cursor: pointer;
  }
  #np-footer { display: flex; justify-content: space-around; margin-top: 12px; }
  /* D1: np-foot min-height 44px */
  .np-foot {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    font-size: 10px; color: var(--fg3); padding: 8px 6px;
    min-height: 44px; min-width: 44px; justify-content: center;
    transition: color .15s;
  }
  .np-foot.active { color: var(--accent); }
  .np-foot:active { opacity: .7; }

  /* D20: Lyrics inline panel — slides up from inside #np, not a separate fullscreen overlay */
  #np-lyrics-inline {
    position: fixed; inset: 0; z-index: 90;
    background: var(--bg); overflow-y: auto;
    -webkit-overflow-scrolling: auto;
  }
  .lyrics-inline-hdr { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; padding-top: calc(16px + env(safe-area-inset-top)); }
  .lyrics-title { font-size: 16px; font-weight: 700; flex: 1; text-align: center; }
  .lyrics-song-name { font-size: 18px; font-weight: 700; padding: 8px 20px 2px; }
  .lyrics-artist { font-size: 13px; color: var(--fg3); padding: 0 20px 16px; }
  .lyrics-loading { display: flex; justify-content: center; padding: 40px; }
  .lyrics-body { padding: 0 20px 40px; font-size: 15px; line-height: 1.8; color: var(--fg2); white-space: pre-wrap; }
</style>
