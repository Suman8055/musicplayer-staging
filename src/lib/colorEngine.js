// colorEngine.js — Album art dominant color extraction
// Extracted from index.html lines 2483–2538. Visual/CSS only — no audio.
import { Log } from './logger.js';

let _accentCanvas = null;
let _accentExtractId = null;

export function extractAndApplyAccent(imgUrl, songId) {
  if (!imgUrl || songId === _accentExtractId) return;
  _accentExtractId = songId;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      if (!_accentCanvas) {
        _accentCanvas = document.createElement('canvas');
        _accentCanvas.width = _accentCanvas.height = 8;
      }
      const ctx = _accentCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
      }
      if (!count) return;
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
      const [h, s, l] = rgbToHsl(r, g, b);
      const s2 = Math.max(60, s);
      const l2 = Math.max(35, Math.min(55, l));
      applyAccent(h, s2, l2);
    } catch (e) {
      if (e?.name === 'SecurityError') {
        Log.warn('colorEngine: canvas CORS taint — accent extraction skipped (CDN missing CORS headers)', { imgUrl });
      }
    }
  };
  img.onerror = () => {};
  img.src = imgUrl;
}

export function applyAccent(h, s, l) {
  // F33: the accentH/S/L stores were write-only — the CSS custom properties below
  // are the real source of truth (consumed in app.css). Stores removed.
  document.documentElement.style.setProperty('--accent-h', h);
  document.documentElement.style.setProperty('--accent-s', s + '%');
  document.documentElement.style.setProperty('--accent-l', l + '%');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
