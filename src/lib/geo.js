// geo.js — Geolocation & availability checking for songs/content
// Detects region locks, provides better error messages for unavailable content

// Detect user's approximate country from browser/IP (fallback)
// Most users: India (IN), some: US, UK, other regions
export function detectCountry() {
  // Browser language hint (best effort)
  const lang = navigator.language || navigator.userLanguage || '';
  if (lang.includes('en-IN') || lang.includes('hi')) return 'IN';
  if (lang.includes('en-US')) return 'US';
  if (lang.includes('en-GB')) return 'GB';

  // Fallback: assume India (primary JioSaavn market)
  return 'IN';
}

// Parse available regions from API response
export function parseAvailableRegions(song) {
  if (song.availableCountries) return song.availableCountries;
  if (song.availableTerritories) return song.availableTerritories;
  // Default: assume available everywhere if field not present
  return null;
}

// Check if song is available in user's region
export function isSongAvailableInRegion(song, userCountry = null) {
  // If no region data, assume available (won't happen with S4.1 extraction)
  if (!song.availableCountries && !song.availableTerritories) {
    return song.available !== false;
  }

  const regions = parseAvailableRegions(song);
  if (!regions || regions.length === 0) return false;

  const country = userCountry || detectCountry();
  return regions.includes(country);
}

// Get friendly unavailability message
export function getUnavailabilityReason(song, userCountry = null) {
  if (song.available === false) {
    const regions = parseAvailableRegions(song);
    if (regions && regions.length > 0) {
      const country = userCountry || detectCountry();
      return `Not available in ${country}. Available in: ${regions.join(', ')}`;
    }
    return 'This song is not available in your region';
  }
  return 'This song is not currently available';
}

// Filter songs by availability in user's region
export function filterAvailableInRegion(songs, userCountry = null) {
  return songs.filter(s => isSongAvailableInRegion(s, userCountry));
}

// Smart queue: skip unavailable songs automatically
export function skipUnavailableSongs(queue, userCountry = null) {
  return queue.filter(s => isSongAvailableInRegion(s, userCountry));
}

// Store user's detected country in cache (can override)
let _userCountry = null;
export function setUserCountry(country) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('mbx_country', country);
  }
  _userCountry = country;
}

export function getUserCountry() {
  if (_userCountry) return _userCountry;
  if (typeof localStorage !== 'undefined') {
    _userCountry = localStorage.getItem('mbx_country');
    if (_userCountry) return _userCountry;
  }
  _userCountry = detectCountry();
  return _userCountry;
}
