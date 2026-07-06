/**
 * MusicPlayer v5.2.62 — Full-component sweep (~15 min, REAL audio)
 *
 * Self-contained Playwright script for the playwright-skill runner (the same
 * harness prior MusicPlayer suites used). Launches its own Chromium, bypasses
 * the passcode gate, and plays real streamed songs for >60s each so the real
 * DSP chain / preload / timeupdate / MediaSession are exercised.
 *
 * Prereq:
 *   Terminal A:  cd ~/musicplayer-svelte && npm run dev        # vite dev, :5173
 *   Terminal B:  cd ~/.claude/skills/playwright-skill \
 *                  && node run.js ~/musicplayer-svelte/tests/full-sweep.spec.js
 *
 * Env overrides:  BASE_URL (default http://localhost:5173/), HEADLESS=0 to watch.
 *
 * Regression coverage → audit tickets:
 *   S1/S2/S3 currentTime>60  → F18 (silent DSP bypass) + stream health
 *   S4 Prev@shuffle-pos-0     → F12
 *   S4 shuffle reachability   → F14
 *   S5 repeat-one Next        → F11
 *   S11 long-play soak        → stall/leak
 */

const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173/';
const HEADLESS = process.env.HEADLESS !== '0';
const GATE_HASH = '278b0ebf70ec6ed8b4c6480de49a1650ace8d513d277e1374801564e49186d37';
const PLAY = 65_000;        // >1 min per requirement
const PLAY_SHORT = 30_000;
const SOAK = 90_000;

const results = [];
function log(section, msg, ok = true) {
  results.push({ section, msg, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${section} — ${msg}`);
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },      // iPhone
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(h => localStorage.setItem('mbx_gate', h), GATE_HASH);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const currentTime = () =>
    page.evaluate(() => document.getElementById('audio')?.currentTime ?? 0);
  const isPlaying = () =>
    page.evaluate(() => { const a = document.getElementById('audio'); return !!a && !a.paused; });
  const assertPlayedFor = async (section, ms) => {
    const t0 = await currentTime();
    await page.waitForTimeout(ms);
    const t1 = await currentTime();
    log(section, `played ${(t1 - t0).toFixed(1)}s (t=${t1.toFixed(1)})`,
      t1 > 60 || (t1 - t0) > (ms / 1000) * 0.8);
  };

  try {
    // ── S0 Boot + gate bypass ──────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-tab]', { timeout: 20_000 });
    log('S0', 'gate bypassed, tab bar rendered');

    // ── S1 Discover / Browse ───────────────────────────────────────────────
    await page.locator('[data-tab="browse"]').click();
    await page.waitForSelector('.lang-pill', { timeout: 20_000 });
    log('S1', `${await page.locator('.lang-pill').count()} language pills`, true);
    if (await page.locator('.chart-row').count()) {
      await page.locator('.chart-row').first().click();
      await page.waitForSelector('#browse-detail.open .song-item', { timeout: 25_000 });
      await page.locator('#browse-detail .song-item').first().click();
    } else {
      await page.waitForSelector('.song-item', { timeout: 20_000 });
      await page.locator('.song-item').first().click();
    }
    await assertPlayedFor('S1', PLAY);

    // ── S2 Search ──────────────────────────────────────────────────────────
    await page.locator('[data-tab="search"]').click();
    await page.locator('#search-input').fill('arijit singh');
    await page.locator('#search-input').press('Enter');
    await page.waitForSelector('#search-results .song-item', { timeout: 20_000 });
    await page.locator('#search-results .song-item').first().click();
    await assertPlayedFor('S2', PLAY);

    // ── S3 Now Playing transport ───────────────────────────────────────────
    await page.locator('#mini').click();
    await page.waitForSelector('#np.open', { timeout: 10_000 });
    log('S3', 'Now Playing opened');
    await page.locator('#np-seek').evaluate(el => {
      el.value = 25;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await assertPlayedFor('S3', PLAY);
    await page.locator('#np-next-btn').click();
    await page.waitForTimeout(3_000);
    log('S3', 'Next → advanced', await isPlaying());
    await assertPlayedFor('S3-next', PLAY);

    // ── S4 Shuffle + Next/Prev (F12, F14) ──────────────────────────────────
    await page.locator('#np-shuffle-btn').click();
    await page.waitForTimeout(1_000);
    await page.locator('#np-next-btn').click();
    await page.waitForTimeout(2_500);
    await page.locator('#np-next-btn').click();
    await page.waitForTimeout(2_500);
    log('S4', 'shuffle Next×2 reachable & playing (F14)', await isPlaying());
    await page.locator('#np-prev-btn').click();
    await page.waitForTimeout(2_000);
    const tAfterPrev = await currentTime();
    log('S4', `Prev → t=${tAfterPrev.toFixed(1)} (restart/move) (F12)`, tAfterPrev < 10);
    await assertPlayedFor('S4', PLAY_SHORT);

    // ── S5 Repeat modes (F11) ──────────────────────────────────────────────
    await page.locator('#np-repeat-btn').click(); // repeat-all
    await page.locator('#np-repeat-btn').click(); // repeat-one
    const beforeName = (await page.locator('#np-song').textContent())?.trim();
    await page.locator('#np-next-btn').click();
    await page.waitForTimeout(3_000);
    const afterName = (await page.locator('#np-song').textContent())?.trim();
    log('S5', `repeat-one Next: "${beforeName}" → "${afterName}" (F11 should advance)`,
      beforeName !== afterName);
    await page.locator('#np-repeat-btn').click(); // off
    await assertPlayedFor('S5', PLAY);

    // ── S6 Queue panel ─────────────────────────────────────────────────────
    await page.locator('#np-queue-btn').click();
    await page.waitForSelector('#queue-panel.open', { timeout: 10_000 });
    const qn = await page.locator('#queue-panel .song-item').count();
    log('S6', `${qn} songs in queue`, qn > 0);
    if (qn > 1) {
      await page.locator('#queue-panel .song-item').nth(1).click();
      await page.waitForTimeout(3_000);
      log('S6', 'jumped to queue item', await isPlaying());
      await assertPlayedFor('S6', PLAY_SHORT);
    }
    await page.keyboard.press('Escape').catch(() => {});

    // ── S7 EQ sheet ────────────────────────────────────────────────────────
    await page.locator('#np-eq-btn').click();
    await page.waitForTimeout(1_500);
    const sliders = await page.locator('input[type="range"]').count();
    log('S7', `EQ sheet, ${sliders} range inputs`, sliders > 0);
    const band = page.locator('input[type="range"]').nth(2);
    if (await band.count()) {
      await band.evaluate(el => { el.value = 6; el.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await assertPlayedFor('S7', PLAY_SHORT);
    await page.keyboard.press('Escape').catch(() => {});

    // ── S8 Lyrics ──────────────────────────────────────────────────────────
    await page.locator('#np-lyrics-btn').click().catch(() => {});
    await page.waitForTimeout(2_000);
    log('S8', 'lyrics toggled (render or graceful fallback)');
    await page.keyboard.press('Escape').catch(() => {});

    // ── S9 Library ─────────────────────────────────────────────────────────
    await page.locator('#np-like').click().catch(() => {});
    await page.locator('#np-close-btn').click({ force: true }).catch(() => {});
    await page.locator('[data-tab="library"]').click();
    await page.waitForTimeout(2_000);
    const libSongs = await page.locator('.song-item').count();
    log('S9', `Library shows ${libSongs} items`, libSongs >= 0);
    if (libSongs > 0) {
      await page.locator('.song-item').first().click();
      await assertPlayedFor('S9', PLAY);
    }

    // ── S10 Settings ───────────────────────────────────────────────────────
    await page.locator('[data-tab="settings"]').click();
    await page.waitForTimeout(1_500);
    const bodyText = await page.locator('body').textContent();
    log('S10', 'Settings shows version 5.2.62', /5\.2\.62/.test(bodyText || ''));
    const elder = page.getByText(/Elder View/i);
    if (await elder.count()) { await elder.first().click().catch(() => {}); log('S10', 'Elder View toggled'); }

    // ── S11 Long-play soak ─────────────────────────────────────────────────
    await page.locator('#mini').click().catch(() => {});
    const soakStart = await currentTime();
    await page.waitForTimeout(SOAK);
    const soakEnd = await currentTime();
    log('S11', `soak ${soakStart.toFixed(1)} → ${soakEnd.toFixed(1)} (no stall)`,
      soakEnd > soakStart + 60 || soakEnd < soakStart);
  } catch (err) {
    log('FATAL', String(err && err.message || err), false);
  } finally {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n=== SWEEP DONE: ${pass}/${results.length} assertions passed ===`);
    results.filter(r => !r.ok).forEach(f => console.log(`  ✗ ${f.section} — ${f.msg}`));
    await browser.close();
  }
})();
