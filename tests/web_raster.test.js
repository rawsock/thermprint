import test from 'node:test';
import assert from 'node:assert/strict';
import { monochrome, wrapText } from '../site/raster.js';

test('transparent pixels composite onto white and opaque black becomes ink', () => {
  assert.deepEqual([...monochrome(Uint8Array.of(0,0,0,0, 0,0,0,255, 255,255,255,255), 3, 1)], [0,1,0]);
});

test('threshold changes monochrome output without affecting solid white', () => {
  const pixels = Uint8Array.of(128,128,128,255, 255,255,255,255);
  assert.deepEqual([...monochrome(pixels, 2, 1, { threshold: 100, dither: false })], [0,0]);
  assert.deepEqual([...monochrome(pixels, 2, 1, { threshold: 180, dither: false })], [1,0]);
});

test('dithering preserves gray detail and is deterministic', () => {
  const pixels = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => i % 4 === 3 ? 255 : 128);
  const ink = monochrome(pixels, 8, 8, { threshold: 128, dither: true });
  const dark = ink.reduce((sum, value) => sum + value, 0);
  assert.ok(dark >= 28 && dark <= 36);
  assert.deepEqual(monochrome(pixels, 8, 8, { threshold: 128, dither: true }), ink);
});

test('word wrap preserves blank lines and splits oversized Unicode words', () => {
  const measure = text => [...text].length;
  assert.deepEqual(wrapText('Hello world\n\nA😀BCDEF', measure, 5), ['Hello', 'world', '', 'A😀BCD', 'EF']);
  assert.deepEqual(wrapText('Zażółć gęślą', measure, 12), ['Zażółć gęślą']);
});
