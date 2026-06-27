<script>
  import { onMount } from 'svelte';
  import { activeTab } from '$lib/stores/ui.js';
  import { fetchModules, fetchAlbumSongs, fetchPlaylistSongs, fetchCharts, fetchFeaturedPlaylists, fetchArtistTopSongs, fetchArtistAlbums, fetchArtistMeta, filterByLanguage, searchSongs, LANG_TILES } from '$lib/api.js';
  import { buildForYouRows, intelTotalPlays, _timeGreeting } from '$lib/smartPlay.js';
  import { play } from '$lib/playback.js';
  import { cacheSongs, bestImg, decodeHtml } from '$lib/utils.js';
  import { showSheet, toast } from '$lib/stores/ui.js';
  import { downloadedIds, playlists } from '$lib/stores/library.js';
  import { downloadSong, removeDownload } from '$lib/idb.js';
  import { apiStream } from '$lib/api.js';
  import { get } from 'svelte/store';
  import SongRow from '$lib/components/shared/SongRow.svelte';
  import BackButton from '$lib/components/shared/BackButton.svelte'; // D11

  let activeLang = LANG_TILES[0].lang;
  let modules = null;
  let forYouRows = [];
  let charts = [];
  let featuredPlaylists = [];
  let loading = true;
  let browseError = false; // D8: track API load failures

  // Detail slide-in state (album / playlist)
  let detailOpen = false;
  let detailTitle = '';
  let detailSongs = [];
  let detailLoading = false;

  // Artist detail slide-in
  let artistDetailOpen = false;
  let artistDetailLoading = false;
  let artistMeta = null;
  let artistTopSongs = [];
  let artistAlbums = [];

  // Album from artist sub-detail
  let albumFromArtistOpen = false;
  let albumFromArtistTitle = '';
  let albumFromArtistSongs = [];
  let albumFromArtistLoading = false;

  $: if ($activeTab === 'browse' && !modules) loadBrowse();

  async function loadBrowse() {
    loading = true;
    browseError = false; // D8: reset error state on each attempt
    try {
      [modules, charts, featuredPlaylists, forYouRows] = await Promise.allSettled([
        fetchModules(activeLang),
        fetchCharts(activeLang),
        fetchFeaturedPlaylists(activeLang),
        intelTotalPlays() >= 5 ? buildForYouRows() : Promise.resolve([]),
      ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));
      // D8: if all primary data sources failed, show error state
      if (!modules && !charts?.length) browseError = true;
      // /featured-playlists endpoint fails for English — use modules.playlists as fallback
      if ((!featuredPlaylists || featuredPlaylists.length === 0) && modules?.playlists?.length) {
        featuredPlaylists = modules.playlists.map(p => ({
          id:       p.id,
          name:     decodeHtml(p.title || p.name || ''),
          subtitle: p.subtitle || (p.songCount ? `${p.songCount} songs` : ''),
          image:    bestImg(p.image, '150x150'),
        }));
      }
    } catch {
      browseError = true;
    } finally { loading = false; }
  }

  async function switchLang(lang) {
    activeLang = lang;
    modules = null;
    await loadBrowse();
  }

  async function openDetail(id, type, title) {
    detailTitle = title;
    detailSongs = [];
    detailOpen = true;
    detailLoading = true;
    try {
      // fetchPlaylistSongs/fetchAlbumSongs now handle sigma→proxy fallback internally
      let songs = type === 'playlist' ? await fetchPlaylistSongs(id) : await fetchAlbumSongs(id);
      let filtered = filterByLanguage(songs, activeLang);
      if (filtered.length === 0 && songs.length) filtered = songs; // proxy returned songs, wrong lang tag
      // Last resort: both sigma and proxy failed — search by title
      if (filtered.length === 0 && activeLang) {
        const base = title.replace(/[-–—]\s*(english|hindi|telugu|tamil|punjabi)\s*$/i, '').trim();
        const NOISE = /\b(most|top|best|all|the|of|streamed|searched|trending|today|international|charts|hot|new|latest|40|20|50)\b/gi;
        const stripped = base.replace(NOISE, '').replace(/\s+/g,' ').trim();
        const attempts = [base ? `${base} ${activeLang}` : null, stripped ? `${stripped} ${activeLang}` : null, `top ${activeLang} songs`].filter(Boolean);
        for (const q of attempts) {
          const res = await searchSongs(q, 30).catch(() => []);
          filtered = filterByLanguage(res, activeLang);
          if (filtered.length === 0) filtered = res.slice(0, 20);
          if (filtered.length > 0) break;
        }
      }
      detailSongs = filtered;
      cacheSongs(detailSongs);
    } finally { detailLoading = false; }
  }

  async function openArtistDetail(artistId, artistName) {
    artistMeta = null;
    artistTopSongs = [];
    artistAlbums = [];
    artistDetailOpen = true;
    artistDetailLoading = true;
    try {
      const [meta, songs, albums] = await Promise.allSettled([
        fetchArtistMeta(artistId),
        fetchArtistTopSongs(artistId, 20),
        fetchArtistAlbums(artistId, 10),
      ]);
      artistMeta = meta.status === 'fulfilled' ? meta.value : { name: artistName, image: null };
      artistTopSongs = songs.status === 'fulfilled' && songs.value.length ? songs.value : [];
      artistAlbums = albums.status === 'fulfilled' ? albums.value : [];
      cacheSongs(artistTopSongs);
    } finally { artistDetailLoading = false; }
  }

  async function openAlbumFromArtist(albumId, albumName) {
    albumFromArtistTitle = albumName;
    albumFromArtistSongs = [];
    albumFromArtistOpen = true;
    albumFromArtistLoading = true;
    try {
      const songs = await fetchAlbumSongs(albumId);
      albumFromArtistSongs = songs;
      cacheSongs(songs);
    } finally { albumFromArtistLoading = false; }
  }

  function playSong(song, songs, idx) { play(song, songs, idx); }

  function openNewRelease(item) {
    if (item.type === 'song') {
      // Single-track release from modules.albums — play it directly
      const song = {
        id: item.id,
        name: decodeHtml(item.name || ''),
        artist: Array.isArray(item.primaryArtists) ? item.primaryArtists.map(a => a.name).join(', ') : '',
        image: bestImg(item.image, '150x150'),
        duration: 0,
        _lang: (item.language || '').toLowerCase() || null,
      };
      play(song, [song], 0);
    } else {
      openDetail(item.id, 'album', item.name || item.title);
    }
  }

  function onMoreSong(song) {
    const dl = get(downloadedIds).has(song.id);
    const pls = get(playlists);
    showSheet(song.name, [
      ...(pls.length ? [{ label: 'Add to Playlist', action: () => {
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
      }}] : []),
      { label: dl ? 'Remove Download' : 'Download', action: () => {
        if (dl) removeDownload(song, toast, null).catch(() => {});
        else downloadSong(song, toast, apiStream).catch(() => {});
      }},
    ]);
  }

  // Trending songs — show all, no language filter (already scoped by activeLang query)
  $: trendingSongs = (modules?.trending?.songs ?? []).map(normTrendingItem).filter(s => s.id);
  // Trending albums — separate horizontal row
  $: trendingAlbums = (modules?.trending?.albums ?? []).filter(a => a.type === 'album').slice(0, 10);
  // New Releases — show all 20 items (albums + singles). Reference app shows all, no type filter.
  $: newReleases = (modules?.albums ?? []).slice(0, 20);
  // Top Artists — from modules.artists array
  $: topArtists = (modules?.artists ?? []).slice(0, 15).map(a => ({
    id:    a.id,
    name:  decodeHtml(a.name || ''),
    image: bestImg(a.image, '150x150'),
  })).filter(a => a.id);

  // Hero banner — first 3 trending songs with images
  $: heroItems = trendingSongs.filter(s => s.image).slice(0, 3);
  $: heroSong = heroItems[heroIdx] ?? null;
  let heroIdx = 0;
  let heroTimer = null;

  $: if (heroItems.length > 1) {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => { heroIdx = (heroIdx + 1) % heroItems.length; }, 4500);
  }

  // Horizontal carousel scroll helpers
  function scrollCarousel(el, dir) {
    if (el) el.scrollBy({ left: dir * 220, behavior: 'smooth' });
  }

  // Carousel element refs (bind:this targets)
  let trendEl, albEl, nrEl, artEl, fpEl, fyEl;

  function normTrendingItem(s) {
    const pa = s.primaryArtists;
    const artist = Array.isArray(pa) ? pa.map(a => a.name).filter(Boolean).join(', ')
                 : (typeof pa === 'string' ? pa : '');
    return { id: s.id, name: s.name || s.title || '', artist, image: s.image, language: s.language || '', type: s.type };
  }
</script>

<div class="tab-pane" class:active={$activeTab === 'browse'} id="tab-browse">
  <div class="tab-header">
    Discover
    <span class="greeting">{_timeGreeting()}</span>
  </div>

  <!-- Language pills -->
  <div class="lang-pills">
    {#each LANG_TILES as { lang, label }}
      <button class="lang-pill" class:active={activeLang === lang} on:click={() => switchLang(lang)}>
        {label}
      </button>
    {/each}
  </div>

  <!-- Hero Banner — real trending songs, auto-slides every 4.5s -->
  {#if !loading && !browseError && heroSong}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="hero-banner" on:click={() => playSong(heroSong, trendingSongs, heroIdx)}
      style="--hero-bg: url('{heroSong.image}')">
      <div class="hero-bg"></div>
      <div class="hero-content">
        <img class="hero-art" src={heroSong.image} alt={heroSong.name} />
        <div class="hero-text">
          <div class="hero-tag">Trending Now</div>
          <div class="hero-title">{heroSong.name}</div>
          <div class="hero-artist">{heroSong.artist}</div>
          <button class="hero-play-btn" on:click|stopPropagation={() => playSong(heroSong, trendingSongs, heroIdx)}
            aria-label="Play {heroSong.name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Play
          </button>
        </div>
      </div>
      {#if heroItems.length > 1}
        <div class="hero-dots">
          {#each heroItems as _, i}
            <button class="hero-dot" class:active={i === heroIdx}
              on:click|stopPropagation={() => heroIdx = i}
              aria-label="Go to slide {i + 1}">
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if loading}
    <div class="empty-wrap"><div class="spinner"></div></div>
  {:else if browseError}
    <!-- D8: API failure error state with retry -->
    <div class="browse-error-state" data-testid="browse-error">
      <div class="browse-error-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="currentColor"/>
        </svg>
      </div>
      <div class="browse-error-msg">Couldn't load content</div>
      <div class="browse-error-sub">Check your connection and try again</div>
      <button class="browse-retry-btn" on:click={loadBrowse}>Try Again</button>
    </div>
  {:else}
    <!-- For You section -->
    {#if forYouRows.length}
      <div class="section-title">For You</div>
      {#each forYouRows as row}
        <div class="disc-hd">
          <span class="disc-hd-title">{row.label}</span>
          {#if row.reason}<span class="disc-reason">{row.reason}</span>{/if}
        </div>
        <div class="scroll-fade-wrap">
          <div class="h-scroll">
            {#each row.songs as song, i}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <div class="content-card" on:click={() => playSong(song, row.songs, i)}>
                <img src={bestImg(song.image, '150x150')} alt="" class="card-img" loading="lazy" />
                <div class="card-name">{song.name}</div>
                <div class="card-sub">{song.artist}</div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}

    <!-- Trending Today -->
    {#if trendingSongs.length}
      <div class="section-hd">
        <span class="section-title section-title--inline">Trending Today · {activeLang}</span>
        <div class="scroll-arrows">
          <button class="scroll-arrow" aria-label="Scroll left" on:click={() => scrollCarousel(trendEl, -1)}>‹</button>
          <button class="scroll-arrow" aria-label="Scroll right" on:click={() => scrollCarousel(trendEl, 1)}>›</button>
        </div>
      </div>
      <div class="scroll-fade-wrap">
        <div class="h-scroll" bind:this={trendEl}>
          {#each trendingSongs as song, i}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => playSong(song, trendingSongs, i)}>
              <div class="card-img-wrap">
                <img src={bestImg(song.image, '150x150')} alt="" class="card-img" loading="lazy" />
                <div class="card-play-overlay" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="card-name">{song.name}</div>
              <div class="card-sub">{song.artist}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Trending Albums -->
    {#if trendingAlbums.length}
      <div class="section-hd">
        <span class="section-title section-title--inline">Trending Albums</span>
        <div class="scroll-arrows">
          <button class="scroll-arrow" aria-label="Scroll left" on:click={() => scrollCarousel(albEl, -1)}>‹</button>
          <button class="scroll-arrow" aria-label="Scroll right" on:click={() => scrollCarousel(albEl, 1)}>›</button>
        </div>
      </div>
      <div class="scroll-fade-wrap">
        <div class="h-scroll" bind:this={albEl}>
          {#each trendingAlbums as album}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => openDetail(album.id, 'album', album.name || album.title)}>
              <div class="card-img-wrap">
                <img src={bestImg(album.image, '150x150')} alt="" class="card-img" loading="lazy" />
                <div class="card-play-overlay" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="card-name">{album.name || album.title}</div>
              <div class="card-sub">{Array.isArray(album.primaryArtists) ? album.primaryArtists.map(a=>a.name).join(', ') : (album.subtitle || album.language || '')}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- New Releases -->
    {#if newReleases.length}
      <div class="section-hd">
        <span class="section-title section-title--inline">New Releases</span>
        <div class="scroll-arrows">
          <button class="scroll-arrow" aria-label="Scroll left" on:click={() => scrollCarousel(nrEl, -1)}>‹</button>
          <button class="scroll-arrow" aria-label="Scroll right" on:click={() => scrollCarousel(nrEl, 1)}>›</button>
        </div>
      </div>
      <div class="scroll-fade-wrap">
        <div class="h-scroll" bind:this={nrEl}>
          {#each newReleases as album}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => openNewRelease(album)}>
              <div class="card-img-wrap">
                <img src={bestImg(album.image, '150x150')} alt="" class="card-img" loading="lazy" />
                <div class="card-play-overlay" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="card-name">{album.name || album.title}</div>
              <div class="card-sub">{Array.isArray(album.primaryArtists) ? album.primaryArtists.map(a=>a.name).join(', ') : (album.subtitle || album.language || '')}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Top Artists -->
    {#if topArtists.length}
      <div class="section-hd">
        <span class="section-title section-title--inline">Top Artists</span>
        <div class="scroll-arrows">
          <button class="scroll-arrow" aria-label="Scroll left" on:click={() => scrollCarousel(artEl, -1)}>‹</button>
          <button class="scroll-arrow" aria-label="Scroll right" on:click={() => scrollCarousel(artEl, 1)}>›</button>
        </div>
      </div>
      <div class="scroll-fade-wrap">
        <div class="h-scroll" bind:this={artEl}>
          {#each topArtists as artist}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => openArtistDetail(artist.id, artist.name)}>
              <img src={artist.image} alt="" class="card-img artist-img" loading="lazy" />
              <div class="card-name artist-card-name">{artist.name}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Charts -->
    {#if charts.length}
      <div class="section-title">Charts · {charts.length} playlists</div>
      {#each charts as chart}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <div class="chart-row" on:click={() => openDetail(chart.id, 'playlist', chart.title || chart.name)}>
          <img src={bestImg(chart.image, '80x80')} alt="" class="chart-img" loading="lazy" />
          <div class="chart-info">
            <div class="chart-title">{chart.title || chart.name}</div>
            <div class="chart-sub">{chart.subtitle || chart.language || ''}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      {/each}
    {/if}

    <!-- Featured Playlists -->
    {#if featuredPlaylists?.length}
      <div class="section-hd">
        <span class="section-title section-title--inline">Featured Playlists</span>
        <div class="scroll-arrows">
          <button class="scroll-arrow" aria-label="Scroll left" on:click={() => scrollCarousel(fpEl, -1)}>‹</button>
          <button class="scroll-arrow" aria-label="Scroll right" on:click={() => scrollCarousel(fpEl, 1)}>›</button>
        </div>
      </div>
      <div class="scroll-fade-wrap">
        <div class="h-scroll" bind:this={fpEl}>
          {#each featuredPlaylists as pl}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => openDetail(pl.id, 'playlist', pl.name)}>
              <div class="card-img-wrap">
                <img src={bestImg(pl.image, '150x150')} alt="" class="card-img" loading="lazy" />
                <div class="card-play-overlay" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="card-name">{pl.name}</div>
              <div class="card-sub">{pl.subtitle || ''}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  <!-- Browse Detail Slide-in (album / playlist) -->
  <div id="browse-detail" class:open={detailOpen}>
    <div class="pl-view-hdr">
      <BackButton label="Browse" onClick={() => detailOpen = false} />
      <div class="pl-view-title">{detailTitle}</div>
      <div></div>
    </div>
    {#if detailLoading}
      <div class="empty-wrap"><div class="spinner"></div></div>
    {:else if detailSongs.length === 0}
      <div class="empty-wrap" style="color:var(--fg2);font-size:14px;padding:32px 16px;text-align:center">No songs available for this playlist</div>
    {:else}
      {#each detailSongs as song, i}
        <SongRow {song} onPlay={() => playSong(song, detailSongs, i)} onMore={(s) => onMoreSong(s)} />
      {/each}
    {/if}
  </div>

  <!-- Artist Detail Slide-in -->
  <div id="browse-artist-detail" class:open={artistDetailOpen}>
    <div class="pl-view-hdr artist-view-hdr">
      <BackButton label="Browse" onClick={() => artistDetailOpen = false} />
      <div class="pl-view-title">{artistDetailLoading ? '' : (artistMeta?.name || '')}</div>
      <div></div>
    </div>
    {#if artistDetailLoading}
      <div class="empty-wrap"><div class="spinner"></div></div>
    {:else}
      {#if artistMeta?.image}
        <div class="artist-hero">
          <img class="artist-hero-img" src={artistMeta.image} alt={artistMeta.name} />
          <div class="artist-hero-overlay">
            <div class="artist-hero-name">{artistMeta.name}</div>
            {#if artistMeta.followers}<div class="artist-followers">{artistMeta.followers} followers</div>{/if}
          </div>
        </div>
      {/if}
      {#if artistTopSongs.length}
        <div class="section-title section-title--pt">Top Songs</div>
        {#each artistTopSongs as song, i}
          <SongRow {song} onPlay={() => playSong(song, artistTopSongs, i)} onMore={(s) => onMoreSong(s)} />
        {/each}
      {/if}
      {#if artistAlbums.length}
        <div class="section-title">Albums</div>
        <div class="h-scroll artist-albums-scroll">
          {#each artistAlbums as album}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="content-card" on:click={() => openAlbumFromArtist(album.id, album.name)}>
              <img src={album.image} alt="" class="card-img" loading="lazy" />
              <div class="card-name">{album.name}</div>
              <div class="card-sub">{album.subtitle || ''}</div>
            </div>
          {/each}
        </div>
      {/if}
      {#if !artistTopSongs.length && !artistAlbums.length}
        <div class="empty-wrap">No content found</div>
      {/if}
    {/if}

    <!-- Album from Artist sub-detail -->
    <div id="browse-album-from-artist" class:open={albumFromArtistOpen}>
      <div class="pl-view-hdr">
        <BackButton label={artistMeta?.name || 'Artist'} onClick={() => albumFromArtistOpen = false} />
        <div class="pl-view-title">{albumFromArtistTitle}</div>
        <div></div>
      </div>
      {#if albumFromArtistLoading}
        <div class="empty-wrap"><div class="spinner"></div></div>
      {:else}
        {#each albumFromArtistSongs as song, i}
          <SongRow {song} onPlay={() => playSong(song, albumFromArtistSongs, i)} onMore={(s) => onMoreSong(s)} />
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  /* D8: Browse error state */
  .browse-error-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 24px; gap: 10px; }
  .browse-error-icon { color: var(--fg3); margin-bottom: 4px; }
  .browse-error-msg { font-size: 16px; font-weight: 600; color: var(--fg); }
  .browse-error-sub { font-size: 13px; color: var(--fg3); text-align: center; }
  .browse-retry-btn { margin-top: 8px; background: var(--accent); color: #fff; border-radius: var(--radius); padding: 10px 28px; font-size: 14px; font-weight: 600; }
  .browse-retry-btn:active { opacity: .8; }

  .tab-header { font-size: 22px; font-weight: 700; padding: 16px 16px 8px; display: flex; align-items: baseline; gap: 8px; }
  .greeting { font-size: 13px; font-weight: 400; color: var(--fg3); }
  .lang-pills { display: flex; gap: 6px; padding: 0 16px 12px; overflow-x: auto; }
  .lang-pills::-webkit-scrollbar { display: none; }
  .lang-pill { padding: 6px 14px; border-radius: 20px; font-size: 13px; background: var(--bg3); color: var(--fg3); border: 1px solid rgba(255,255,255,.08); white-space: nowrap; }
  .lang-pill.active { background: var(--accent); color: #fff; border-color: transparent; }

  /* ── Hero Banner ── */
  .hero-banner {
    margin: 0 16px 16px;
    border-radius: 14px;
    overflow: hidden;
    height: 160px;
    position: relative;
    cursor: pointer;
  }
  .hero-bg {
    position: absolute; inset: 0;
    background-image: var(--hero-bg);
    background-size: cover; background-position: center;
    filter: blur(28px) brightness(.35) saturate(1.6);
    transform: scale(1.15);
  }
  .hero-content {
    position: relative; z-index: 1;
    display: flex; align-items: center; gap: 14px;
    padding: 16px; height: 100%;
  }
  .hero-art {
    width: 96px; height: 96px; border-radius: 10px;
    object-fit: cover; flex-shrink: 0;
    box-shadow: 0 6px 20px rgba(0,0,0,.5);
  }
  .hero-text { flex: 1; min-width: 0; }
  .hero-tag {
    font-size: 10px; font-weight: 700; color: var(--accent);
    text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px;
  }
  .hero-title {
    font-size: 18px; font-weight: 800;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  .hero-artist {
    font-size: 12px; color: rgba(255,255,255,.65);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 12px;
  }
  .hero-play-btn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--accent); color: #fff;
    border-radius: 20px; padding: 7px 16px;
    font-size: 13px; font-weight: 700;
  }
  .hero-play-btn:active { opacity: .8; }
  .hero-dots {
    position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 5px; z-index: 2;
  }
  .hero-dot {
    width: 6px; height: 6px; border-radius: 3px;
    background: rgba(255,255,255,.35); padding: 0;
    transition: width .3s, background .3s;
  }
  .hero-dot.active { width: 18px; background: var(--accent); }

  /* ── Section headers with scroll arrows ── */
  .section-hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px 4px;
  }
  .section-title { font-size: 13px; font-weight: 600; color: var(--fg3); padding: 10px 16px 4px; text-transform: uppercase; letter-spacing: var(--ls-section, .05em); }
  .section-title--inline { padding: 0; }
  .scroll-arrows { display: flex; gap: 4px; }
  .scroll-arrow {
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--bg3); color: var(--fg2);
    font-size: 15px; display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,.08);
  }
  .scroll-arrow:active { background: var(--accent); color: #fff; }

  /* ── Play overlay on cards ── */
  .card-img-wrap { position: relative; width: 120px; height: 120px; }
  .card-play-overlay {
    position: absolute; inset: 0; border-radius: 10px;
    background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .15s;
    color: #fff;
  }
  .content-card:active .card-play-overlay { opacity: 1; }
  .disc-hd { padding: 10px 16px 2px; }
  .disc-hd-title { font-size: 16px; font-weight: 700; }
  .disc-reason { font-size: 11px; color: var(--fg3); margin-left: 6px; }
  .scroll-fade-wrap { position: relative; }
  .h-scroll { display: flex; gap: 10px; overflow-x: auto; padding: 8px 16px; }
  .h-scroll::-webkit-scrollbar { display: none; }
  /* D24: card press feedback */
  .content-card { flex-shrink: 0; width: 120px; cursor: pointer; transition: transform .12s ease, opacity .12s ease; }
  .content-card:active { transform: scale(0.96); opacity: 0.85; }
  .card-img { width: 120px; height: 120px; border-radius: 10px; object-fit: cover; display: block; }
  .card-name { font-size: 12px; font-weight: 600; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* D30: 11→12px for better legibility */
  .card-sub { font-size: 12px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chart-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; }
  .chart-row:active { background: rgba(255,255,255,.05); }
  .chart-img { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; flex-shrink: 0; }
  .chart-info { flex: 1; min-width: 0; }
  .chart-title { font-size: 14px; font-weight: 600; }
  .chart-sub { font-size: 12px; color: var(--fg3); }
  #browse-detail {
    position: fixed; inset: 0; z-index: 50;
    background: var(--bg); overflow-y: auto;
    transform: translateX(100%);
    transition: transform .32s cubic-bezier(.32,.72,0,1);
  }
  #browse-detail.open { transform: translateX(0); }
  #browse-artist-detail {
    position: fixed; inset: 0; z-index: 52;
    background: var(--bg); overflow-y: auto;
    transform: translateX(100%);
    transition: transform .32s cubic-bezier(.32,.72,0,1);
  }
  #browse-artist-detail.open { transform: translateX(0); }
  #browse-album-from-artist {
    position: fixed; inset: 0; z-index: 54;
    background: var(--bg); overflow-y: auto;
    transform: translateX(100%);
    transition: transform .32s cubic-bezier(.32,.72,0,1);
  }
  #browse-album-from-artist.open { transform: translateX(0); }
  .pl-view-hdr { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; padding-top: calc(16px + env(safe-area-inset-top)); }
  /* D11: back-btn style in BackButton.svelte */
  .pl-view-title { font-size: 16px; font-weight: 700; text-align: center; flex: 1; }
  .empty-wrap { display: flex; align-items: center; justify-content: center; padding: 60px 16px; color: var(--fg3); font-size: 14px; }
  .artist-img { border-radius: 50% !important; }
  .artist-hero { position: relative; width: 100%; max-height: 260px; overflow: hidden; }
  .artist-hero-img { width: 100%; height: 260px; object-fit: cover; display: block; }
  .artist-hero-overlay { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.85) 0%, transparent 50%); display: flex; flex-direction: column; justify-content: flex-end; padding: 16px; }
  .artist-hero-name { font-size: 26px; font-weight: 800; color: #fff; }
  .artist-followers { font-size: 13px; color: rgba(255,255,255,.6); }
  /* D25: extracted from inline styles */
  .artist-card-name { text-align: center; }
  .artist-view-hdr { position: sticky; top: 0; background: var(--bg); z-index: 1; }
  .section-title--pt { padding-top: 12px; }
  .artist-albums-scroll { padding: 8px 16px 16px; }
</style>
