<script>
  import { nowSong, playing, loadingUrl, seekProgress, currentTime, shuffleOn, repeatMode } from '$lib/stores/playback.js';
  import { npOpen } from '$lib/stores/ui.js';
  import { togglePlay, prev, next } from '$lib/playback.js';
  import { corsAvailable } from '$lib/stores/eq.js';
  import { fmt } from '$lib/utils.js';
  import { createShuffledQueue } from '$lib/playback.js';

  // Cycle shuffle: off → on (with fresh shuffled queue)
  function miniShuffle(e) {
    e.stopPropagation();
    shuffleOn.update(v => {
      if (!v) { createShuffledQueue(); return true; }
      return false;
    });
  }

  // Cycle repeat: 0=off → 1=all → 2=one → 0
  function miniRepeat(e) {
    e.stopPropagation();
    repeatMode.update(v => (v + 1) % 3);
  }

  // Waveform animation active when audio engine is connected and playing
  $: waveActive = $corsAvailable && $playing;
</script>

{#if $nowSong}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div id="mini" on:click={() => npOpen.set(true)}>
    <div id="mini-bg" style="background-image:url({$nowSong.image || ''})"></div>
    <div id="mini-inner">
      <div id="mini-art-wrap">
        <img id="mini-art" src={$nowSong.image || ''} alt={$nowSong.name || ''} />
        {#if $loadingUrl}<div id="mini-art-loading"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div></div>{/if}
      </div>
      <div id="mini-info">
        <div id="mini-title-row">
          <div id="mini-title">{$nowSong.name || '—'}</div>
          {#if waveActive}
            <div id="mini-wave" aria-hidden="true">
              <span class="mw-bar"></span>
              <span class="mw-bar"></span>
              <span class="mw-bar"></span>
            </div>
          {/if}
        </div>
        <div id="mini-artist">{$nowSong.artist || '—'}</div>
      </div>
      <div id="mini-time" aria-label="Elapsed time">{fmt($currentTime)}</div>
      <div id="mini-btns">
        <button class="mini-btn mini-btn--sm" id="mini-shuffle"
          on:click={miniShuffle}
          aria-label="Shuffle {$shuffleOn ? 'on' : 'off'}"
          aria-pressed={$shuffleOn}
          class:mini-accent={$shuffleOn}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
        </button>
        <button class="mini-btn" id="mini-prev" on:click|stopPropagation={prev} aria-label="Previous">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
        </button>
        <button class="mini-btn" id="mini-play" on:click|stopPropagation={togglePlay} aria-label={$playing ? 'Pause' : 'Play'}>
          {#if $loadingUrl}
            <div class="spinner" style="width:22px;height:22px;border-width:2px"></div>
          {:else if $playing}
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          {:else}
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        <button class="mini-btn" id="mini-next" on:click|stopPropagation={next} aria-label="Next">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 4-5.5-4zm7-6h2v12h-2z"/></svg>
        </button>
        <button class="mini-btn mini-btn--sm" id="mini-repeat"
          on:click={miniRepeat}
          aria-label="Repeat {['off','all','one'][$repeatMode]}"
          aria-pressed={$repeatMode > 0}
          class:mini-accent={$repeatMode > 0}
          data-repeat={$repeatMode}>
          {#if $repeatMode === 2}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          {:else}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          {/if}
          {#if $repeatMode === 2}<span class="repeat-one-badge">1</span>{/if}
        </button>
      </div>
    </div>
    <div id="mini-bar" style="width:{($seekProgress * 100).toFixed(1)}%"></div>
  </div>
{/if}

<style>
  #mini {
    position: fixed;
    bottom: calc(var(--tab-h) + env(safe-area-inset-bottom));
    left: 0; right: 0;
    height: var(--mini-h);
    z-index: 35;
    cursor: pointer;
    overflow: hidden;
  }
  #mini-bg {
    position: absolute; inset: 0;
    background-size: cover; background-position: center;
    filter: blur(40px) brightness(.4) saturate(1.5);
    transform: scale(1.2);
  }
  #mini-inner {
    position: relative; z-index: 1;
    display: flex; align-items: center; gap: 10px;
    height: 100%; padding: 0 12px;
  }
  #mini-art-wrap { position: relative; width: 42px; height: 42px; flex-shrink: 0; }
  #mini-art {
    width: 42px; height: 42px; border-radius: 6px;
    object-fit: cover;
  }
  #mini-art-loading {
    position: absolute; inset: 0; border-radius: 6px;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
  }
  #mini-info { flex: 1; min-width: 0; }
  #mini-title-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
  #mini-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #mini-artist { font-size: 12px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Elapsed time */
  #mini-time { font-size: 11px; color: var(--fg3); flex-shrink: 0; min-width: 28px; text-align: right; }

  /* Waveform animation — 3 bars, accent color, animated when playing */
  #mini-wave { display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0; }
  .mw-bar {
    display: block; width: 3px; border-radius: 2px;
    background: var(--accent); height: 4px;
    animation: mwv .75s ease-in-out infinite;
  }
  .mw-bar:nth-child(2) { animation-delay: .18s; }
  .mw-bar:nth-child(3) { animation-delay: .36s; }
  @keyframes mwv { 0%,100% { height: 4px; } 50% { height: 13px; } }

  #mini-btns { display: flex; align-items: center; gap: 1px; }
  .mini-btn {
    color: var(--fg); padding: 6px; border-radius: 50%;
    min-width: 44px; min-height: 44px;
    display: flex; align-items: center; justify-content: center; position: relative;
  }
  .mini-btn:active { background: rgba(255,255,255,.1); }
  .mini-btn--sm { min-width: 36px; min-height: 36px; }
  .mini-accent { color: var(--accent) !important; }

  /* Repeat-one small badge */
  .repeat-one-badge {
    position: absolute; top: 4px; right: 3px;
    font-size: 8px; font-weight: 800; line-height: 1;
    color: var(--accent);
  }
  #mini-bar {
    position: absolute; bottom: 0; left: 0; height: 2px;
    background: var(--accent); transition: width .3s linear;
    max-width: 100%;
  }
</style>
