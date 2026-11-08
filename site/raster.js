import { WIDTH, MAX_HEIGHT } from './protocol.js';

export const FEED = 16;
export const START_SPACE = 4;
export const MARGIN = 16;
// A circular print measured 29 mm across but only 25.5 mm along the paper feed.
export const DEFAULT_FEED_SCALE = 29 / 25.5;

function calibratedRows(height, scale) {
  if (!Number.isFinite(scale) || scale < 0.8 || scale > 1.4) throw new Error('Paper-feed correction must be between 80% and 140%.');
  const rows = Math.round(height * scale);
  if (rows > MAX_HEIGHT) throw new Error('This print is too long with paper-feed correction. Shorten it or reduce the text size.');
  return rows;
}

export function calibrateInk(ink, height, scale = DEFAULT_FEED_SCALE) {
  if (ink.length !== WIDTH * height) throw new Error('Invalid print pixels.');
  const rows = calibratedRows(height, scale);
  const corrected = new Uint8Array(WIDTH * rows);
  for (let y = 0; y < rows; y++) {
    const source = Math.min(height - 1, Math.floor((y + 0.5) * height / rows));
    corrected.set(ink.subarray(source * WIDTH, (source + 1) * WIDTH), y * WIDTH);
  }
  return { ink: corrected, height: rows };
}

function grayscale(rgba, width, height, { threshold = 160, dither = true, contrast = 110, sharpen = true } = {}) {
  if (rgba.length !== width * height * 4) throw new Error('Invalid image pixels.');
  const gray = new Float32Array(width * height);
  // Change the input tones, not the diffusion threshold: diffusion otherwise
  // cancels out most of the user's ink adjustment by conserving the same error.
  const gamma = 2 ** ((threshold - 160) / 80);
  const clamp = value => Math.max(0, Math.min(255, value));
  // A midpoint contrast curve keeps black and white fixed, including transparent
  // backgrounds and the blank tear-off feed. A linear contrast shift would gray them.
  const tones = Float32Array.from({ length: 256 }, (_, i) => {
    const level = (i / 255) ** gamma;
    const light = level ** (contrast / 100), dark = (1 - level) ** (contrast / 100);
    return 255 * light / (light + dark);
  });
  for (let i = 0; i < gray.length; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    const value = clamp((0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) * alpha + 255 * (1 - alpha));
    const lower = Math.floor(value);
    gray[i] = dither ? tones[lower] + (value - lower) * (tones[Math.min(255, lower + 1)] - tones[lower]) : value;
  }
  if (!dither || !sharpen) return gray;
  const horizontal = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      horizontal[i] = (gray[y * width + Math.max(0, x - 1)] + 2 * gray[i] + gray[y * width + Math.min(width - 1, x + 1)]) / 4;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const blurred = (horizontal[Math.max(0, y - 1) * width + x] + 2 * horizontal[i] + horizontal[Math.min(height - 1, y + 1) * width + x]) / 4;
      gray[i] = clamp(gray[i] + 0.4 * (gray[i] - blurred));
    }
  }
  return gray;
}

const DIFFUSION = {
  stucki: { divisor: 42, taps: [[1,0,8], [2,0,4], [-2,1,2], [-1,1,4], [0,1,8], [1,1,4], [2,1,2], [-2,2,1], [-1,2,2], [0,2,4], [1,2,2], [2,2,1]] },
  atkinson: { divisor: 8, taps: [[1,0,1], [2,0,1], [-1,1,1], [0,1,1], [1,1,1], [0,2,1]] },
};

function quantize(gray, width, height, { threshold = 160, dither = true, method = 'stucki' } = {}) {
  const ink = new Uint8Array(gray.length);
  if (!dither) {
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < threshold ? 1 : 0;
    return ink;
  }
  const kernel = DIFFUSION[method];
  if (!kernel) throw new Error('Unknown dithering style.');
  const work = gray.slice();
  let noise = 0x6d2b79f5;
  for (let y = 0; y < height; y++) {
    // Mirror the kernel on alternating rows to avoid a directional dot pattern.
    const direction = y % 2 ? -1 : 1;
    for (let x = direction === 1 ? 0 : width - 1; x >= 0 && x < width; x += direction) {
      const i = y * width + x;
      // Small, repeatable threshold variation breaks regular worms in flat
      // photo tones. Error diffusion still conserves the average ink density.
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
      const jitter = method === 'stucki' ? (noise / 4294967296 - 0.5) * 32 : 0;
      ink[i] = work[i] < 127.5 + jitter ? 1 : 0;
      const error = (work[i] - (ink[i] ? 0 : 255)) / kernel.divisor;
      for (const [dx, dy, weight] of kernel.taps) {
        const nx = x + dx * direction, ny = y + dy;
        if (nx >= 0 && nx < width && ny < height) work[ny * width + nx] += error * weight;
      }
    }
  }
  return ink;
}

export function monochrome(rgba, width, height, options = {}) {
  return quantize(grayscale(rgba, width, height, options), width, height, options);
}

export function preparePrint(rgba, height, { feedScale = DEFAULT_FEED_SCALE, ...options } = {}) {
  const rows = calibratedRows(height, feedScale);
  const gray = grayscale(rgba, WIDTH, height, options);
  const artworkInk = quantize(gray, WIDTH, height, options);
  if (options.dither === false) return { ...calibrateInk(artworkInk, height, feedScale), artworkInk, artworkHeight: height };
  if (rows === height) return { ink: artworkInk, height, artworkInk, artworkHeight: height };
  const resized = new Float32Array(WIDTH * rows);
  for (let y = 0; y < rows; y++) {
    const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) * height / rows - 0.5));
    const top = Math.floor(sourceY), bottom = Math.min(height - 1, top + 1), fraction = sourceY - top;
    for (let x = 0; x < WIDTH; x++) resized[y * WIDTH + x] = gray[top * WIDTH + x] * (1 - fraction) + gray[bottom * WIDTH + x] * fraction;
  }
  // Resize continuous tones first. Stretching binary dots duplicates complete
  // rows and creates regular dark bands at the paper-feed correction interval.
  return { ink: quantize(resized, WIDTH, rows, options), height: rows, artworkInk, artworkHeight: height };
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
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

export function textCanvas(text, { size = 26, align = 'left', bold = false, startSpace = START_SPACE, endSpace = FEED } = {}) {
  const font = `${bold ? 700 : 400} ${size}px Arial, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const lines = wrapText(text, value => measure.measureText(value).width, WIDTH - MARGIN * 2);
  const lineHeight = Math.ceil(size * 1.35);
  const { canvas, ctx } = paper(startSpace + lines.length * lineHeight + endSpace);
  ctx.font = font;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? WIDTH / 2 : align === 'right' ? WIDTH - MARGIN : MARGIN;
  lines.forEach((line, i) => ctx.fillText(line, x, startSpace + i * lineHeight));
  return canvas;
}

export function imageCanvas(image, scaleY = DEFAULT_FEED_SCALE, { startSpace = START_SPACE, endSpace = FEED, imageScale = 1 } = {}) {
  if (!Number.isFinite(imageScale) || imageScale < 0.1 || imageScale > 1) throw new Error('Image size must be between 10% and 100%.');
  const maxWidth = WIDTH - MARGIN * 2;
  const maxHeight = Math.min(MAX_HEIGHT, Math.floor(MAX_HEIGHT / scaleY)) - startSpace - endSpace;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height) * imageScale;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const { canvas, ctx } = paper(height + startSpace + endSpace);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, Math.floor((WIDTH - width) / 2), startSpace, width, height);
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

export function drawPreview(canvas, ink, height, soft = true) {
  if (!soft) { drawInk(canvas, ink, height); return; }
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(WIDTH, height);
  const horizontal = new Float32Array(ink.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      horizontal[i] = (ink[y * WIDTH + Math.max(0, x - 1)] + 6 * ink[i] + ink[y * WIDTH + Math.min(WIDTH - 1, x + 1)]) / 8;
    }
  }
  // A mild optical blend and softer ink tone approximate paper at screen size.
  // The binary raster is untouched; PNG export uses drawInk instead.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      const coverage = (horizontal[Math.max(0, y - 1) * WIDTH + x] + 6 * horizontal[i] + horizontal[Math.min(height - 1, y + 1) * WIDTH + x]) / 8;
      pixels.data.fill(Math.round(255 - 231 * coverage), i * 4, i * 4 + 3);
      pixels.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
}
