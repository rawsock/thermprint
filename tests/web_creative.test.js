import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import jsQR from 'jsqr';
import { qrCanvas } from '../site/qr.js';
import { monochrome, calibrateInk, preparePrint, drawInk, drawPreview, DEFAULT_FEED_SCALE, imageCanvas, textCanvas, FEED, START_SPACE } from '../site/raster.js';
import { rasterPackets } from '../site/protocol.js';
import { drawStroke, canvasPoint, setupDrawing } from '../site/drawing.js';

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

test('paper preview softens screen dots while preserving exact export and print pixels', () => {
  const ink = new Uint8Array(384 * 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 384; x++) ink[y * 384 + x] = (x + y) % 2;
  const original = ink.slice();
  const soft = createCanvas(1, 1), exact = createCanvas(1, 1), exported = createCanvas(1, 1);
  drawPreview(soft, ink, 24);
  drawPreview(exact, ink, 24, false);
  drawInk(exported, ink, 24);
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, 384, 24).data;
  assert.ok(pixels(soft).some((value, index) => index % 4 !== 3 && value > 0 && value < 255));
  assert.deepEqual(pixels(exact), pixels(exported));
  assert.deepEqual(toInk(exported), original);
  assert.deepEqual(ink, original);
});

test('start and end spacing add only the requested rows and preserve QR quiet zones', () => {
  const source = createCanvas(352, 100), ctx = source.getContext('2d');
  ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 352, 100);
  for (const render of [options => imageCanvas(source, 1, options), options => textCanvas('Hello', options), options => qrCanvas('test', 240, options)]) {
    const bare = render({ startSpace: 0, endSpace: 0 });
    const padded = render({ startSpace: 8, endSpace: 32 });
    assert.equal(padded.height, bare.height + 40);
    const ink = toInk(padded);
    assert.ok(ink.slice(0, 8 * 384).every(value => value === 0));
    assert.ok(ink.slice(-32 * 384).every(value => value === 0));
    assert.deepEqual(ink.slice(8 * 384, -32 * 384), toInk(bare));
  }
  const qr = qrCanvas('test', 240, { startSpace: 0, endSpace: 0 });
  assert.equal(jsQR(rgba(toInk(qr)), 384, qr.height)?.data, 'test');
});

test('correction retains edge rows and packets contain every encoded row, including odd heights', () => {
  for (const height of [3, 7, 127, 1001]) {
    const ink = new Uint8Array(384 * height);
    ink.fill(1, 0, 384); ink.fill(1, -384);
    for (let y = 1; y < height - 1; y++) ink[y * 384 + y % 384] = 1;
    for (const scale of [0.8, 1, DEFAULT_FEED_SCALE, 1.4]) {
      const result = calibrateInk(ink, height, scale);
      assert.ok(result.ink.slice(0, 384).every(Boolean));
      assert.ok(result.ink.slice(-384).every(Boolean), 'last image row is retained');
      const unpacked = Uint8Array.from(rasterPackets(result.ink, result.height).flatMap(packet =>
        [...packet.slice(3, 99)].flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1))));
      assert.deepEqual(unpacked.slice(0, result.ink.length), result.ink);
      assert.ok(unpacked.slice(result.ink.length).every(value => value === 0));
    }
  }
});

test('QR artwork is square and vertical compensation is applied exactly once', () => {
  const canvas = qrCanvas('https://thermprint.github.io/', 320);
  const bounds = (ink, height) => {
    let left = 384, right = 0, top = height, bottom = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < 384; x++) if (ink[y * 384 + x]) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return [right - left + 1, bottom - top + 1];
  };
  const original = bounds(toInk(canvas), canvas.height);
  assert.equal(original[0], original[1]);
  for (const feedScale of [1, DEFAULT_FEED_SCALE, 1.4]) {
    const result = preparePrint(canvas.getContext('2d').getImageData(0, 0, 384, canvas.height).data, canvas.height, { dither: false, threshold: 128, feedScale });
    assert.deepEqual(bounds(result.artworkInk, canvas.height), original);
    const corrected = bounds(result.ink, result.height);
    assert.equal(corrected[0], original[0]);
    assert.ok(Math.abs(corrected[1] - original[1] * feedScale) <= 1);
  }
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
