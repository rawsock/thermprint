import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import jsQR from 'jsqr';
import { qrCanvas } from '../site/qr.js';
import { monochrome, calibrateInk, preparePrint, DEFAULT_FEED_SCALE, imageCanvas, textCanvas, FEED, START_SPACE } from '../site/raster.js';
import { drawStroke, canvasPoint, setupDrawing } from '../site/drawing.js';
import { galleryResults, searchURL, commonsImageURL, searchGraphics, loadGraphic, isBlackWhiteArtwork } from '../site/gallery.js';

globalThis.document = { createElement: tag => {
  assert.equal(tag, 'canvas');
  return createCanvas(384, 384);
} };
const toInk = canvas => monochrome(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { threshold: 128, dither: false });
const rgba = ink => Uint8ClampedArray.from({ length: ink.length * 4 }, (_, i) => i % 4 === 3 ? 255 : ink[Math.floor(i / 4)] ? 0 : 255);

test('QR codes decode as the original link and Unicode text before and after feed correction', () => {
  for (const value of ['https://rawsock.github.io/thermprint/', 'Zażółć gęślą jaźń · 你好 · 😀']) {
    const canvas = qrCanvas(value, 320);
    const ink = toInk(canvas);
    assert.equal(jsQR(rgba(ink), 384, canvas.height)?.data, value);
    const corrected = preparePrint(canvas.getContext('2d').getImageData(0, 0, 384, canvas.height).data, canvas.height, { dither: false, threshold: 128 });
    assert.deepEqual(corrected.artworkInk, ink);
    assert.equal(jsQR(rgba(corrected.ink), 384, corrected.height)?.data, value);
    assert.ok(ink.slice(0, 384 * 20).every(pixel => pixel === 0), 'quiet zone is white');
  }
});

test('QR capacity and minimum printable module size produce readable errors', () => {
  assert.throws(() => qrCanvas(''), /Enter/);
  assert.throws(() => qrCanvas('😀'.repeat(200)), /shorter/);
  assert.throws(() => qrCanvas('x'.repeat(650), 240), /too detailed/);
});

test('feed compensation uses the measured 29 / 25.5 ratio and keeps a circle physically round', () => {
  const canvas = createCanvas(384, 384), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 384, 384);
  ctx.fillStyle = 'black'; ctx.beginPath(); ctx.arc(192, 192, 116, 0, Math.PI * 2); ctx.fill();
  const ink = toInk(canvas);
  const output = calibrateInk(ink, 384);
  assert.equal(DEFAULT_FEED_SCALE, 29 / 25.5);
  assert.equal(output.height, 437);
  const rowsWithInk = [];
  for (let y = 0; y < output.height; y++) if (output.ink[y * 384 + 192]) rowsWithInk.push(y);
  const printedHeight = rowsWithInk.length * 25.5 / 29;
  assert.ok(Math.abs(printedHeight - 232) < 2);
  assert.deepEqual(calibrateInk(ink, 384, 1).ink, ink);
  assert.throws(() => calibrateInk(new Uint8Array(384 * 1500), 1500), /too long/);
});

test('tall images fit the maximum encoded print height without cropping at every calibration extreme', () => {
  const source = createCanvas(100, 2000);
  const ctx = source.getContext('2d');
  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 100, 2000);
  for (const scale of [0.8, 1, DEFAULT_FEED_SCALE, 1.4]) {
    const canvas = imageCanvas(source, scale);
    const ink = toInk(canvas);
    assert.ok(calibrateInk(ink, canvas.height, scale).height <= 1536);
    assert.ok(ink.slice(-384 * FEED).every(value => value === 0));
  }
});

test('image size keeps artwork centered, reduces paper length, and uses only the selected end spacing', () => {
  const source = createCanvas(352, 200), ctx = source.getContext('2d');
  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, source.width, source.height);
  for (const imageScale of [1, 0.5, 0.1]) {
    for (const endSpace of [0, 8, 16, 64]) {
      const canvas = imageCanvas(source, DEFAULT_FEED_SCALE, { imageScale, endSpace });
      const width = Math.round(352 * imageScale), height = Math.round(200 * imageScale);
      assert.equal(canvas.height, START_SPACE + height + endSpace);
      const ink = toInk(canvas);
      for (let y = 0; y < canvas.height; y++) {
        const row = ink.slice(y * 384, (y + 1) * 384);
        const hasImage = y >= START_SPACE && y < START_SPACE + height;
        assert.equal(row.reduce((a, b) => a + b, 0), hasImage ? width : 0);
        if (hasImage) assert.equal(row.indexOf(1), Math.floor((384 - width) / 2));
      }
    }
  }
});

test('text and QR end spacing changes paper length without changing content or QR readability', () => {
  for (const render of [endSpace => textCanvas('Hello', { endSpace }), endSpace => qrCanvas('https://example.com', 240, { endSpace })]) {
    const short = render(0), longer = render(64);
    assert.equal(longer.height - short.height, 64);
    assert.deepEqual(toInk(longer).slice(0, short.height * 384), toInk(short));
    assert.ok(toInk(longer).slice(-64 * 384).every(value => value === 0));
  }
  const qr = qrCanvas('https://example.com', 240, { endSpace: 0 });
  assert.equal(jsQR(rgba(toInk(qr)), 384, qr.height)?.data, 'https://example.com');
});

test('smooth strokes have round endpoints, dots work, and erasing restores white pixels', () => {
  const canvas = createCanvas(384, 384), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 384, 384);
  drawStroke(ctx, [{ x: 50, y: 100 }, { x: 150, y: 100 }, { x: 250, y: 100 }], { size: 20, erase: false });
  let ink = toInk(canvas);
  assert.equal(ink[100 * 384 + 42], 1);
  assert.equal(ink[100 * 384 + 150], 1);
  assert.equal(ink[85 * 384 + 150], 0);
  drawStroke(ctx, [{ x: 150, y: 100 }], { size: 40, erase: true });
  ink = toInk(canvas);
  assert.equal(ink[100 * 384 + 150], 0);
  assert.equal(ink[100 * 384 + 100], 1);
  drawStroke(ctx, [{ x: 300, y: 300 }], { size: 8, erase: false });
  assert.equal(toInk(canvas)[300 * 384 + 300], 1);
});

function eventSurface(canvas) {
  const target = new EventTarget();
  canvas.addEventListener = target.addEventListener.bind(target);
  canvas.dispatchEvent = target.dispatchEvent.bind(target);
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 192, height: 192 });
  canvas.getAttribute = () => 'false';
  canvas.setPointerCapture = () => {};
  canvas.hasPointerCapture = () => false;
  return canvas;
}
function pointer(canvas, type, x, y, pointerId = 1) {
  const event = new Event(type);
  Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId });
  canvas.dispatchEvent(event);
}

test('drawing maps resized touch coordinates, commits a tap, and supports undo including clear', () => {
  const canvas = eventSurface(createCanvas(384, 384));
  const undo = new EventTarget(), clear = new EventTarget();
  let changes = 0;
  setupDrawing(canvas, { tool: { value: 'pen' }, size: { value: '10' }, undo, clear, onChange: () => changes++ });
  assert.deepEqual(canvasPoint({ clientX: 106, clientY: 116 }, canvas), { x: 192, y: 192 });
  pointer(canvas, 'pointerdown', 106, 116);
  pointer(canvas, 'pointerup', 106, 116);
  assert.equal(toInk(canvas)[192 * 384 + 192], 1);
  clear.dispatchEvent(new Event('click'));
  assert.ok(toInk(canvas).every(value => value === 0));
  undo.dispatchEvent(new Event('click'));
  assert.equal(toInk(canvas)[192 * 384 + 192], 1);
  undo.dispatchEvent(new Event('click'));
  assert.ok(toInk(canvas).every(value => value === 0));
  assert.equal(undo.disabled, true);
  assert.equal(changes, 4);
});

const sample = { query: { pages: [
  { pageid: 7, index: 2, title: 'File:Cat.svg', imageinfo: [{ mime: 'image/svg+xml', thumburl: 'https://thumb.wikimedia.org/cat.png', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'An artist' } } }] },
  { pageid: 9, index: 1, title: 'File:Flower.svg', imageinfo: [{ mime: 'image/svg+xml', thumburl: 'https://upload.wikimedia.org/flower.png', extmetadata: { LicenseShortName: { value: 'Public domain' } } }] },
  { pageid: 11, index: 3, title: 'File:Unsupported.pdf', imageinfo: [{ mime: 'application/pdf', thumburl: 'https://other.example/test.png' }] },
] }, continue: { gsroffset: 18 } };

test('graphics search encodes query, uses CORS and keeps ranked images with license/source metadata', () => {
  const url = new URL(searchURL('cat & flower', 18));
  assert.equal(url.searchParams.get('gsrsearch'), 'cat & flower');
  assert.equal(url.searchParams.get('origin'), '*');
  assert.equal(url.searchParams.get('gsroffset'), '18');
  assert.equal(new URL(searchURL('funny cat')).searchParams.get('gsrsearch'), 'funny cat');
  const filteredQuery = new URL(searchURL('funny cat', 0, 'bitmaps')).searchParams.get('gsrsearch');
  assert.ok(filteredQuery.split(' OR ').every(branch => branch.startsWith('funny cat ')));
  assert.ok(!filteredQuery.includes('filetype:drawing'), 'raster artwork is included too');
  const result = galleryResults(sample);
  assert.deepEqual(result.items.map(item => item.id), ['9', '7']);
  assert.equal(result.items[1].license, 'CC BY-SA 4.0');
  assert.equal(result.items[1].source, 'https://commons.wikimedia.org/?curid=7');
  assert.equal(result.next, 18);
  assert.equal(commonsImageURL('https://thumb.wikimedia.org.evil.example/test.png'), null);
  assert.equal(commonsImageURL('javascript:alert(1)'), null);
});

test('black-and-white filter accepts antialiased ink and transparent icons, but rejects color and gray shading', () => {
  const canvas = createCanvas(100, 100), ctx = canvas.getContext('2d');
  const accepts = () => isBlackWhiteArtwork(ctx.getImageData(0, 0, 100, 100).data, 100);
  for (const background of ['white', 'transparent']) {
    ctx.clearRect(0, 0, 100, 100);
    ctx.fillStyle = background; ctx.fillRect(0, 0, 100, 100);
    assert.equal(accepts(), false, 'blank images have no ink');
    ctx.fillStyle = 'black'; ctx.beginPath(); ctx.arc(50, 50, 25, 0, Math.PI * 2); ctx.fill();
    assert.equal(accepts(), true, 'antialiased outlines are allowed');
    ctx.fillStyle = '#999'; ctx.fillRect(40, 40, 20, 20);
    assert.equal(accepts(), false, 'gray fills are not simple ink');
  }
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = 'black'; ctx.fillRect(10, 10, 10, 10);
  ctx.fillStyle = 'red'; ctx.fillRect(50, 50, 10, 10);
  assert.equal(accepts(), false, 'white background does not hide a small colored icon');
  ctx.fillStyle = '#330000'; ctx.fillRect(50, 50, 10, 10);
  assert.equal(accepts(), false, 'dark colors are not mistaken for black');
  const gradient = ctx.createLinearGradient(0, 0, 100, 0);
  gradient.addColorStop(0, 'black'); gradient.addColorStop(1, 'white');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 100, 100);
  assert.equal(accepts(), false, 'grayscale gradients are excluded');
});

test('artwork search checks thumbnails and continues past unsuitable results, preserving ranking and pagination', async t => {
  let pages = 0, closed = 0;
  const page = (id, color) => ({ pageid: id, index: id, title: `File:${color}.png`, imageinfo: [{ mime: 'image/png', thumburl: `https://upload.wikimedia.org/${color}.png`, extmetadata: { LicenseShortName: { value: 'CC0' } } }] });
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('https://commons.wikimedia.org/w/api.php')) {
      const offset = Number(new URL(url).searchParams.get('gsroffset'));
      pages++;
      return new Response(JSON.stringify({ query: { pages: offset === 0 ? [page(1, 'red')] : [page(2, 'black'), page(3, 'gray')] }, ...(offset === 0 ? { continue: { gsroffset: 18 } } : {}) }));
    }
    return new Response(String(url).split('/').at(-1).split('.')[0], { headers: { 'Content-Type': 'image/png' } });
  });
  globalThis.createImageBitmap = async blob => {
    const canvas = createCanvas(100, 100), ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = await blob.text(); ctx.fillRect(25, 25, 50, 50);
    canvas.close = () => closed++;
    return canvas;
  };
  try {
    const result = await searchGraphics('cat', { blackWhiteOnly: true });
    assert.deepEqual(result.items.map(item => item.id), ['2']);
    assert.equal(result.next, null);
    assert.equal(pages, 4);
    assert.equal(closed, 3);
    await assert.rejects(searchGraphics('cat', { blackWhiteOnly: true, signal: AbortSignal.abort() }), { name: 'AbortError' });
  } finally { delete globalThis.createImageBitmap; }
});

test('gallery fetch handles HTTP errors and imports the selected image without a manual download', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(sample), { headers: { 'Content-Type': 'application/json' } });
  });
  const result = await searchGraphics('cat');
  assert.equal(result.items.length, 2);
  assert.equal(requests[0].options.credentials, 'omit');
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(searchGraphics('cat'), /busy/);
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } });
  globalThis.createImageBitmap = async blob => ({ decoded: true, type: blob.type });
  assert.deepEqual(await loadGraphic(result.items[0]), { decoded: true, type: 'image/png' });
  await assert.rejects(loadGraphic({ thumbnail: 'http://example.com/x.png' }), /Unsupported/);
  delete globalThis.createImageBitmap;
});

test('filtered pagination keeps separate cursors and does not restart an exhausted artwork source', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const params = new URL(url).searchParams;
    const type = params.get('gsrsearch').includes('filetype:drawing') ? 'vectors' : 'bitmaps';
    const offset = Number(params.get('gsroffset'));
    requests.push({ type, offset });
    return new Response(JSON.stringify(type === 'bitmaps' && offset < 54 ? { continue: { gsroffset: offset + 18 } } : {}));
  });
  const first = await searchGraphics('cat', { blackWhiteOnly: true });
  assert.deepEqual(first.next, { vectors: null, bitmaps: 54 });
  const second = await searchGraphics('cat', { blackWhiteOnly: true, offset: first.next });
  assert.equal(second.next, null);
  assert.deepEqual(requests.filter(item => item.type === 'vectors').map(item => item.offset), [0]);
  assert.deepEqual(requests.filter(item => item.type === 'bitmaps').map(item => item.offset), [0, 18, 36, 54]);
});
