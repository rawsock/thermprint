import { WIDTH, MAX_HEIGHT } from './protocol.js';

export const FEED = 64;
export const MARGIN = 16;
// A circular print measured 29 mm across but only 25.5 mm along the paper feed.
export const DEFAULT_FEED_SCALE = 29 / 25.5;

export function calibrateInk(ink, height, scale = DEFAULT_FEED_SCALE) {
  if (!Number.isFinite(scale) || scale < 0.8 || scale > 1.4) throw new Error('Paper-feed correction must be between 80% and 140%.');
  if (ink.length !== WIDTH * height) throw new Error('Invalid print pixels.');
  const rows = Math.round(height * scale);
  if (rows > MAX_HEIGHT) throw new Error('This print is too long with paper-feed correction. Shorten it or reduce the text size.');
  const corrected = new Uint8Array(WIDTH * rows);
  for (let y = 0; y < rows; y++) {
    const source = Math.min(height - 1, Math.floor(y * height / rows));
    corrected.set(ink.subarray(source * WIDTH, (source + 1) * WIDTH), y * WIDTH);
  }
  return { ink: corrected, height: rows };
}

export function monochrome(rgba, width, height, { threshold = 160, dither = true } = {}) {
  if (rgba.length !== width * height * 4) throw new Error('Invalid image pixels.');
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    gray[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) * alpha + 255 * (1 - alpha);
  }
  const ink = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      ink[i] = gray[i] < threshold ? 1 : 0;
      if (!dither) continue;
      const error = gray[i] - (ink[i] ? 0 : 255);
      if (x + 1 < width) gray[i + 1] += error * 7 / 16;
      if (y + 1 < height) {
        if (x) gray[i + width - 1] += error * 3 / 16;
        gray[i + width] += error * 5 / 16;
        if (x + 1 < width) gray[i + width + 1] += error / 16;
      }
    }
  }
  return ink;
}

export function wrapText(text, measure, maxWidth) {
  const lines = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (measure(line + word) <= maxWidth) { line += word; continue; }
      if (line.trimEnd()) { lines.push(line.trimEnd()); line = ''; }
      if (!word.trim()) continue;
      // Break a single word that cannot fit, preserving Unicode code points.
      for (const letter of word) {
        if (line && measure(line + letter) > maxWidth) { lines.push(line); line = ''; }
        line += letter;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function paper(height) {
  if (height > MAX_HEIGHT) throw new Error('This print is too long. Shorten the text or use a smaller font (maximum about 19 cm).');
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = Math.max(96, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

export function textCanvas(text, { size = 26, align = 'left', bold = false } = {}) {
  const font = `${bold ? 700 : 400} ${size}px Arial, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const lines = wrapText(text, value => measure.measureText(value).width, WIDTH - MARGIN * 2);
  const lineHeight = Math.ceil(size * 1.35);
  const { canvas, ctx } = paper(MARGIN * 2 + lines.length * lineHeight + FEED);
  ctx.font = font;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? WIDTH / 2 : align === 'right' ? WIDTH - MARGIN : MARGIN;
  lines.forEach((line, i) => ctx.fillText(line, x, MARGIN + i * lineHeight));
  return canvas;
}

export function imageCanvas(image, scaleY = DEFAULT_FEED_SCALE) {
  const maxWidth = WIDTH - MARGIN * 2;
  const maxHeight = Math.min(MAX_HEIGHT, Math.floor(MAX_HEIGHT / scaleY)) - MARGIN * 2 - FEED;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const { canvas, ctx } = paper(height + MARGIN * 2 + FEED);
  ctx.drawImage(image, Math.floor((WIDTH - width) / 2), MARGIN, width, height);
  return canvas;
}

export function drawInk(canvas, ink, height) {
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(WIDTH, height);
  for (let i = 0; i < ink.length; i++) {
    pixels.data.fill(ink[i] ? 0 : 255, i * 4, i * 4 + 3);
    pixels.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
}
