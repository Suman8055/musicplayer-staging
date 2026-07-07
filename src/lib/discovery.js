// discovery.js — Discovery features using extracted artist/trend metadata
// S4.3 + S4.4: Artist discovery, trending searches, smart ranking

// S4.3: Enhanced artist discovery using followers and metadata
export function sortArtistsByFollowers(artists) {
  // Sort artists by follower count for discovery ranking
  return artists.slice().sort((a, b) => {
    const followersA = a.followers || 0;
    const followersB = b.followers || 0;
    return followersB - followersA;
  });
}

export function formatArtistCard(artist) {
  // Format artist display with follower count
  let display = artist.name || '';
  if (artist.followers > 0) {
    const count = formatFollowers(artist.followers);
    display += ` (${count})`;
  }
  return display;
}

export function formatFollowers(count) {
  // Format follower count: 1000000 → "1M", 500000 → "500K"
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return count.toString();
}

export function filterArtistsByFollowers(artists, minFollowers = 1000) {
  // Filter artists by minimum follower count (for "Popular Artists")
  return artists.filter(a => (a.followers || 0) >= minFollowers);
}

export function canCreateArtistRadio(artist) {
  // Check if artist supports radio creation
  return artist.hasRadio === true;
}

// S4.4: Trending & discovery utilities
export function getTrendingScore(song) {
  // Combined score from popularity + recency for trending ranking
  const popularity = (song.popularity?.plays || 0) + (song.popularity?.views || 0);
  // Weight recent songs higher (year 2025 > 2024)
  const yearBoost = (song.year === new Date().getFullYear()) ? 1.5 : 1.0;
  return (popularity / 100000) * yearBoost;
}

export function getTrendingSongs(songs) {
  // Get trending songs sorted by combined score
  return songs
    .filter(s => s.popularity?.plays > 0 || s.popularity?.views > 0)
    .slice()
    .sort((a, b) => getTrendingScore(b) - getTrendingScore(a))
    .slice(0, 10);
}

export function getLatestSongs(songs) {
  // Get latest releases (this year or last year first)
  const currentYear = new Date().getFullYear();
  return songs
    .filter(s => s.year !== null)
    .slice()
    .sort((a, b) => (b.year || 0) - (a.year || 0))
    .slice(0, 10);
}

// S4.4: Trending searches (from autocomplete topquery)
export function formatTrendingSearch(searchTerm) {
  // Format trending search suggestion: "Bollywood Remixes" → "Trending: Bollywood Remixes"
  return `Trending: ${searchTerm}`;
}

export function rankTrendingSearches(searches) {
  // Rank trending searches by click-through rate
  return searches.slice().sort((a, b) => (b.ctr || 0) - (a.ctr || 0));
}

// Smart queue ranking based on song metadata
export function smartRankSongs(songs) {
  // Rank songs by: popularity → recency → availability
  return songs.slice().sort((a, b) => {
    // 1. Prefer available songs
    const availA = a.available !== false ? 1 : 0;
    const availB = b.available !== false ? 1 : 0;
    if (availA !== availB) return availB - availA;

    // 2. Prefer high-popularity songs
    const scoreA = getTrendingScore(a);
    const scoreB = getTrendingScore(b);
    if (scoreA !== scoreB) return scoreB - scoreA;

    // 3. Fallback: prefer recent songs
    return (b.year || 0) - (a.year || 0);
  });
}

// Export utilities for UI discovery sections
export const discoveryHelpers = {
  sortArtistsByFollowers,
  formatArtistCard,
  formatFollowers,
  filterArtistsByFollowers,
  canCreateArtistRadio,
  getTrendingScore,
  getTrendingSongs,
  getLatestSongs,
  formatTrendingSearch,
  rankTrendingSearches,
  smartRankSongs,
};
