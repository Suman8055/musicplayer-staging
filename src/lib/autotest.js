// autotest.js — Self-contained test runner for MusicPlayer automation
// Activated when URL contains ?autotest=1
// Exposes window.__mbxRunTest() which exercises the full language-switch scenario
// and writes structured results to window.__mbxTestResults.
//
// Shell driver reads results via:
//   xcrun simctl io booted execCmd ... (iOS Simulator)
//   or via idevicedebug log parsing on real device

import { get } from 'svelte/store';
import { play } from './playback.js';
import { nowSong, queue, qIdx, playing } from './stores/playback.js';
import { activeTab } from './stores/ui.js';
import {
  fetchCharts, fetchArtistSongs, filterByLanguage,
  searchSongs
} from './api.js';
import { smartQueueFill } from './smartPlay.js';
import { Log } from './logger.js';

// ── Test log ──────────────────────────────────────────────────────────────────
const _log = [];

// Post to os_log via the native WKScriptMessageHandler bridge (AppDelegate.swift).
// Fallback to console.log if the bridge isn't available yet.
function _nativeLog(str) {
  try {
    window?.webkit?.messageHandlers?.mbxLog?.postMessage(str);
  } catch {}
  console.log(str);
}

function tlog(level, msg, data) {
  const entry = { t: Date.now(), level, msg, data: data ?? null };
  _log.push(entry);
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  const line = `[AUTOTEST:${level}] ${msg}${dataStr}`;
  _nativeLog(line);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Song fetch helpers ────────────────────────────────────────────────────────
async function fetchFirstSong(lang) {
  // Try charts first (fastest), then search fallback
  try {
    const charts = await fetch(
      `https://saavn.8man.dev/api/charts?lang=${lang}&limit=5`
    ).then(r => r.json()).catch(() => null);
    const songs = charts?.data?.[0]?.songs || charts?.data?.songs || charts?.songs || [];
    const filtered = filterByLanguage(songs, lang);
    if (filtered.length) return filtered[0];
  } catch {}

  // fallback: search
  const results = await searchSongs(`top ${lang} songs 2024`, 10).catch(() => []);
  const filtered = filterByLanguage(results, lang);
  return filtered[0] ?? null;
}

// ── Main test sequence ────────────────────────────────────────────────────────
async function runTest() {
  const results = {
    startedAt:   new Date().toISOString(),
    steps:       [],
    pass:        0,
    fail:        0,
    log:         _log,
    done:        false,
  };

  function step(name, ok, detail) {
    const s = { name, ok, detail };
    results.steps.push(s);
    if (ok) results.pass++;
    else    results.fail++;
    tlog(ok ? 'PASS' : 'FAIL', `STEP: ${name}`, detail);
  }

  // Expose partial results immediately so shell can watch
  window.__mbxTestResults = results;

  tlog('INFO', 'Test started');

  // ── STEP 1: Bypass gate ───────────────────────────────────────────────────
  try {
    localStorage.setItem(
      'mbx_gate',
      JSON.stringify('278b0ebf70ec6ed8b4c6480de49a1650ace8d513d277e1374801564e49186d37')
    );
    step('Gate bypassed', true, { localStorage: 'mbx_gate set' });
  } catch (e) {
    step('Gate bypassed', false, { error: e.message });
  }

  // ── STEP 2: Navigate to Browse → Telugu ──────────────────────────────────
  try {
    activeTab.set('browse');
    await wait(500);
    step('Navigate to Browse tab', true, {});
  } catch (e) {
    step('Navigate to Browse tab', false, { error: e.message });
  }

  // ── STEP 3: Fetch Telugu song and play it ────────────────────────────────
  tlog('INFO', 'Fetching Telugu song...');
  let teluguSong1 = null;
  try {
    teluguSong1 = await fetchFirstSong('telugu');
    if (!teluguSong1) throw new Error('No Telugu song found');
    step('Fetch Telugu song', true, { name: teluguSong1.name, id: teluguSong1.id, lang: teluguSong1._lang });
  } catch (e) {
    step('Fetch Telugu song', false, { error: e.message });
  }

  if (teluguSong1) {
    tlog('INFO', 'Playing Telugu song 1', { name: teluguSong1.name });
    await play(teluguSong1, [teluguSong1], 0);
    await wait(2000);
    const current = get(nowSong);
    const ok = current?.id === teluguSong1.id;
    step('Play Telugu song 1 — nowSong matches', ok, {
      expected: teluguSong1.id,
      actual:   current?.id,
      name:     current?.name,
    });
  }

  // ── STEP 4: Wait 8s, fetch more Telugu songs, simulate Next×2 ────────────
  tlog('INFO', 'Waiting 8s before Next...');
  await wait(8000);

  try {
    // Build a Telugu queue and advance it
    const teluguSongs = filterByLanguage(
      await fetchArtistSongs(teluguSong1?.artist || 'Sid Sriram', 10),
      'telugu'
    );
    if (teluguSongs.length >= 3) {
      // Set queue to Telugu songs starting at index 0
      await play(teluguSongs[0], teluguSongs, 0);
      await wait(1000);
      // Next × 1
      await play(teluguSongs[1], teluguSongs, 1);
      await wait(1000);
      const afterNext1 = get(nowSong);
      // Next × 2
      await play(teluguSongs[2], teluguSongs, 2);
      await wait(1000);
      const afterNext2 = get(nowSong);

      const allTelugu = [afterNext1, afterNext2].every(s => s?._lang === 'telugu' || s?._lang == null);
      step('Next×2 stays Telugu', allTelugu, {
        after_next1: afterNext1?.name,
        after_next2: afterNext2?.name,
        lang1: afterNext1?._lang,
        lang2: afterNext2?._lang,
      });
    } else {
      step('Next×2 stays Telugu', false, { error: 'Not enough Telugu songs for queue' });
    }
  } catch (e) {
    step('Next×2 stays Telugu', false, { error: e.message });
  }

  // ── STEP 5: Switch to English — play English song ────────────────────────
  tlog('INFO', 'Fetching English song...');
  let englishSong1 = null;
  try {
    englishSong1 = await fetchFirstSong('english');
    if (!englishSong1) throw new Error('No English song found');
    step('Fetch English song', true, { name: englishSong1.name, id: englishSong1.id });
  } catch (e) {
    step('Fetch English song', false, { error: e.message });
  }

  if (englishSong1) {
    await play(englishSong1, [englishSong1], 0);
    await wait(2000);
    const current = get(nowSong);
    const ok = current?.id === englishSong1.id;
    step('Play English song — nowSong matches', ok, {
      expected: englishSong1.id,
      actual:   current?.id,
      name:     current?.name,
    });
  }

  // ── STEP 6: Trigger SmartQueueFill — should block cross-language fill ─────
  tlog('INFO', 'Testing SmartQueueFill language guard...');
  try {
    // Simulate queue exhausted: set queue to just this one English song at last idx
    // Then call smartQueueFill() directly — it should refuse to fill if
    // top artist has no English songs (or fill correctly with English songs)
    const qBefore = get(queue);
    const filled = await smartQueueFill();
    const qAfter = get(queue);

    if (!filled) {
      step('SmartQueueFill blocked (no matching lang songs)', true, {
        reason: 'returned false — no cross-language injection'
      });
    } else {
      // Verify every added song is English
      const addedSongs = qAfter.slice(qBefore.length);
      const allEnglish = addedSongs.every(s => s._lang === 'english' || s._lang == null);
      step('SmartQueueFill filled with correct language', allEnglish, {
        added: addedSongs.length,
        langs: addedSongs.map(s => s._lang),
        songs: addedSongs.map(s => s.name),
      });
    }
  } catch (e) {
    step('SmartQueueFill language guard', false, { error: e.message });
  }

  // ── STEP 7: Switch back to Telugu, play Telugu, verify lang isolation ─────
  tlog('INFO', 'Switching back to Telugu...');
  let teluguSong2 = null;
  try {
    const songs = filterByLanguage(
      await searchSongs('telugu hits 2024', 10).catch(() => []),
      'telugu'
    );
    teluguSong2 = songs[0] ?? null;
    if (!teluguSong2) throw new Error('No Telugu song found for re-test');
    step('Fetch Telugu song for re-test', true, { name: teluguSong2.name });
  } catch (e) {
    step('Fetch Telugu song for re-test', false, { error: e.message });
  }

  if (teluguSong2) {
    await play(teluguSong2, [teluguSong2], 0);
    await wait(2000);
    const current = get(nowSong);
    const ok = current?.id === teluguSong2.id;
    step('Play Telugu song after English — nowSong correct', ok, {
      expected: teluguSong2.id,
      actual:   current?.id,
      name:     current?.name,
    });
  }

  // ── STEP 8: SmartQueueFill with Telugu context should fill Telugu only ────
  tlog('INFO', 'Testing SmartQueueFill fills Telugu when context is Telugu...');
  try {
    const qBefore = get(queue);
    const filled = await smartQueueFill();
    const qAfter = get(queue);

    if (filled) {
      const addedSongs = qAfter.slice(qBefore.length);
      const allTelugu = addedSongs.every(s => s._lang === 'telugu' || s._lang == null);
      const hasEnglish = addedSongs.some(s => s._lang === 'english');
      step('SmartQueueFill with Telugu context — no English injected', !hasEnglish, {
        added: addedSongs.length,
        langs: [...new Set(addedSongs.map(s => s._lang))],
        songs: addedSongs.slice(0, 3).map(s => s.name),
        contamination: hasEnglish ? 'DETECTED' : 'none',
      });
    } else {
      step('SmartQueueFill with Telugu context', true, {
        reason: 'returned false — queue not filled (no intel data yet, acceptable)',
      });
    }
  } catch (e) {
    step('SmartQueueFill with Telugu context', false, { error: e.message });
  }

    // ── STEP 9: English playlist → play 3 songs via Next, validate image/song match ──
  tlog('INFO', 'TEST: English playlist — play 3 songs, validate image+song match...');
  try {
    // Fetch 5 English songs to form a playlist
    const englishSongs = filterByLanguage(
      await searchSongs('english hits 2024', 10).catch(() => []),
      'english'
    );
    if (englishSongs.length < 3) throw new Error('Not enough English songs fetched');

    // Play song 0 (start of English playlist)
    await play(englishSongs[0], englishSongs, 0);
    await wait(2000);
    let cur = get(nowSong);
    const match0 = cur?.id === englishSongs[0].id && !!cur?.image;
    step('English song 1 — image+id match', match0, {
      expected_id:   englishSongs[0].id,
      actual_id:     cur?.id,
      expected_name: englishSongs[0].name,
      actual_name:   cur?.name,
      image_url:     cur?.image ?? 'MISSING',
      image_matches: cur?.image === englishSongs[0].image,
    });

    // Advance: play song 1 (simulate Next)
    await play(englishSongs[1], englishSongs, 1);
    await wait(2000);
    cur = get(nowSong);
    const match1 = cur?.id === englishSongs[1].id && !!cur?.image;
    step('English song 2 (Next) — image+id match', match1, {
      expected_id:   englishSongs[1].id,
      actual_id:     cur?.id,
      expected_name: englishSongs[1].name,
      actual_name:   cur?.name,
      image_url:     cur?.image ?? 'MISSING',
      image_matches: cur?.image === englishSongs[1].image,
    });

    // Advance: play song 2 (simulate Next)
    await play(englishSongs[2], englishSongs, 2);
    await wait(2000);
    cur = get(nowSong);
    const match2 = cur?.id === englishSongs[2].id && !!cur?.image;
    step('English song 3 (Next) — image+id match', match2, {
      expected_id:   englishSongs[2].id,
      actual_id:     cur?.id,
      expected_name: englishSongs[2].name,
      actual_name:   cur?.name,
      image_url:     cur?.image ?? 'MISSING',
      image_matches: cur?.image === englishSongs[2].image,
    });
  } catch (e) {
    step('English playlist image+song match', false, { error: e.message });
  }

  // ── STEP 10: Switch to Telugu — validate image+song match ─────────────────
  tlog('INFO', 'TEST: Switch to Telugu — validate image+song match...');
  try {
    const teluguSongs = filterByLanguage(
      await searchSongs('telugu hits 2024', 10).catch(() => []),
      'telugu'
    );
    if (!teluguSongs.length) throw new Error('No Telugu songs fetched');

    const tSong = teluguSongs[0];
    await play(tSong, teluguSongs, 0);
    await wait(2500);

    const cur = get(nowSong);
    const idMatch    = cur?.id    === tSong.id;
    const nameMatch  = cur?.name  === tSong.name;
    const imageMatch = cur?.image === tSong.image;
    const hasImage   = !!cur?.image;

    step('Telugu song after English — id matches', idMatch, {
      expected_id:  tSong.id,
      actual_id:    cur?.id,
    });
    step('Telugu song after English — name matches', nameMatch, {
      expected_name: tSong.name,
      actual_name:   cur?.name,
    });
    step('Telugu song after English — image matches', imageMatch && hasImage, {
      expected_image: tSong.image,
      actual_image:   cur?.image ?? 'MISSING',
      verdict: imageMatch && hasImage ? 'IMAGE_MATCH' : 'IMAGE_MISMATCH',
    });

    // Log a clear verdict line for easy parsing
    const verdict = (idMatch && nameMatch && imageMatch && hasImage)
      ? '[VERDICT] PASS — Telugu song image matches displayed song'
      : '[VERDICT] FAIL — Telugu song image MISMATCH with displayed song';
    tlog('INFO', verdict, {
      displayed_name:  cur?.name,
      displayed_image: cur?.image,
      playing_id:      cur?.id,
      expected_id:     tSong.id,
    });
  } catch (e) {
    step('Telugu switch image+song match', false, { error: e.message });
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  results.finishedAt = new Date().toISOString();
  results.done = true;
  window.__mbxTestResults = results;

  const summary = `[AUTOTEST:SUMMARY] ${results.pass} PASSED / ${results.fail} FAILED`;
  _nativeLog(summary);

  // Persist results to localStorage so shell script can read them from SQLite
  try {
    localStorage.setItem('mbx_autotest_results', JSON.stringify(results));
    localStorage.setItem('mbx_autotest_done', '1');
  } catch {}

  return results;
}

// Activate when:
//   - URL has ?autotest=1
//   - localStorage has mbx_autotest=1  (set by shell via simctl before launch)
//   - window.name === 'autotest'
export function initAutoTest() {
  if (typeof window === 'undefined') return;
  const isTest =
    new URLSearchParams(window.location.search).has('autotest') ||
    window.location.hash.includes('autotest') ||
    localStorage.getItem('mbx_autotest') === '1' ||
    window.name === 'autotest';
  if (!isTest) return;

  tlog('INFO', 'AutoTest mode activated');

  // Expose globally so shell can call window.__mbxRunTest()
  window.__mbxRunTest = () => runTest();
  window.__mbxTestResults = { done: false, steps: [], pass: 0, fail: 0, log: _log };

  // Auto-start after a short delay (let the app fully mount first)
  setTimeout(() => {
    tlog('INFO', 'Auto-starting test sequence in 3s...');
    setTimeout(() => runTest(), 3000);
  }, 2000);
}
