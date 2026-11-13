import test from 'node:test';
import assert from 'node:assert/strict';
import { monochrome, wrapText, preparePrint, calibrateInk } from '../site/raster.js';

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
  const options = { threshold: 160, contrast: 100, sharpen: false, dither: true };
  const ink = monochrome(pixels, 8, 8, options);
  const dark = ink.reduce((sum, value) => sum + value, 0);
  assert.ok(dark >= 28 && dark <= 36);
  assert.deepEqual(monochrome(pixels, 8, 8, options), ink);
});

test('word wrap preserves blank lines and splits oversized Unicode words', () => {
  const measure = text => [...text].length;
  assert.deepEqual(wrapText('Hello world\n\nA😀BCDEF', measure, 5), ['Hello', 'world', '', 'A😀BCD', 'EF']);
  assert.deepEqual(wrapText('Zażółć gęślą', measure, 12), ['Zażółć gęślą']);
});

const grayPixels = (width, height, value) => Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : value);
const coverage = ink => ink.reduce((sum, value) => sum + value, 0) / ink.length;

test('diffusion supports arbitrary tone counts with bounded deterministic output and preserved mean', () => {
  for (const levels of [2,3,4,5,8,16,31,256]) for (const method of ['stucki','atkinson']) {
    const options = { levels, method, contrast: 100, sharpen: false };
    for (const value of [0,32,96,128,192,224,255]) {
      const pixels = grayPixels(64,64,value), ink = monochrome(pixels,64,64,options);
      assert.ok(ink.every(tone => tone >= 0 && tone < levels));
      assert.deepEqual(ink,monochrome(pixels,64,64,options));
      if (value === 0 || value === 255) assert.ok(ink.every(tone => tone === (value ? 0 : levels-1)));
      if (method === 'stucki') assert.ok(Math.abs(coverage(ink)/(levels-1)-(1-value/255)) < 0.025);
    }
  }
  for (const levels of [0,1,2.5,257,NaN]) {
    assert.throws(() => monochrome(grayPixels(1,1,128),1,1,{levels}),/Tone count/);
  }
});

test('grayscale sampling doubles rows without stretching preview or white margins', () => {
  const pixels = grayPixels(384,20,255);
  for (let y=4;y<16;y++) for (let x=0;x<384;x++) pixels.fill(x%256,(y*384+x)*4,(y*384+x)*4+3);
  for (const levels of [3,4,31,256]) for (const feedScale of [0.8,1,1.4]) for (const dither of [false,true]) {
    const job = preparePrint(pixels,20,{nativeGray:true,levels,feedScale,dither,contrast:100,sharpen:false});
    assert.equal(job.height,Math.round(20*feedScale)*2);
    assert.equal(job.artworkHeight,20);
    assert.equal(job.artworkInk.length,384*20);
    assert.equal(job.levels,levels);
    assert.equal(job.nativeGray,true);
    assert.deepEqual([...new Set(job.ink)].sort((a,b)=>a-b),Array.from({length:levels},(_,i)=>i));
    assert.ok(job.ink.slice(0,384*2).every(tone => tone===0));
    assert.ok(job.ink.slice(-384*2).every(tone => tone===0));
  }
  assert.throws(() => preparePrint(grayPixels(384,1536,128),1536,{nativeGray:true,feedScale:1.4}),/too long/);
});

test('photo dithering preserves the average tone through highlights, midtones and shadows', () => {
  for (const tone of [32, 64, 96, 128, 160, 192, 224]) {
    const ink = monochrome(grayPixels(96, 96, tone), 96, 96, { threshold: 160, contrast: 100, sharpen: false });
    assert.ok(Math.abs(coverage(ink) - (1 - tone / 255)) < 0.025, `Tone ${tone} lost its ink density`);
  }
});

test('ink balance changes dithered midtone coverage rather than only moving the dots', () => {
  const pixels = grayPixels(96, 96, 128);
  for (const method of ['stucki', 'atkinson']) {
    const fractions = [80, 160, 220].map(threshold => coverage(monochrome(pixels, 96, 96, { method, threshold, contrast: 100, sharpen: false })));
    assert.ok(fractions[1] - fractions[0] > 0.15);
    assert.ok(fractions[2] - fractions[1] > 0.15);
  }
});

test('all contrast and ink extremes preserve white paper, transparent pixels and solid black', () => {
  for (const method of ['stucki', 'atkinson']) for (const contrast of [60, 110, 160]) for (const threshold of [50, 160, 230]) {
    for (const tone of [0, 255]) {
      const ink = monochrome(grayPixels(8, 8, tone), 8, 8, { method, contrast, threshold });
      assert.ok(ink.every(value => value === (tone === 0 ? 1 : 0)));
    }
    assert.ok(monochrome(new Uint8Array(8 * 8 * 4), 8, 8, { method, contrast, threshold }).every(value => value === 0));
  }
});

test('contrast separates highlights and shadows without changing their ordering', () => {
  for (const tone of [64, 192]) {
    const pixels = grayPixels(96, 96, tone);
    const soft = coverage(monochrome(pixels, 96, 96, { contrast: 60, sharpen: false }));
    const strong = coverage(monochrome(pixels, 96, 96, { contrast: 160, sharpen: false }));
    assert.ok(tone < 128 ? strong > soft + 0.1 : soft > strong + 0.1);
  }
});

test('photo and illustration styles are deterministic and have distinct highlight treatment', () => {
  const pixels = grayPixels(96, 96, 224);
  const smooth = monochrome(pixels, 96, 96, { method: 'stucki' });
  const crisp = monochrome(pixels, 96, 96, { method: 'atkinson' });
  assert.deepEqual(monochrome(pixels, 96, 96, { method: 'stucki' }), smooth);
  assert.deepEqual(monochrome(pixels, 96, 96, { method: 'atkinson' }), crisp);
  assert.ok(coverage(smooth) > coverage(crisp) + 0.025);
});

test('feed correction dithers at the final resolution without duplicated whole dot rows', () => {
  const pixels = grayPixels(384, 128, 128);
  const result = preparePrint(pixels, 128);
  assert.equal(result.artworkHeight, 128);
  assert.equal(result.height, 146);
  assert.deepEqual(result.artworkInk, monochrome(pixels, 384, 128));
  assert.notDeepEqual(result.ink, calibrateInk(result.artworkInk, 128).ink);
  for (let y = 1; y < result.height; y++) {
    assert.ok(result.ink.subarray(y * 384, (y + 1) * 384).some((value, x) => value !== result.ink[(y - 1) * 384 + x]));
  }
  assert.deepEqual(preparePrint(pixels, 128, { feedScale: 1 }).ink, result.artworkInk);
});

test('photo feed stays white and corrected prints remain bounded', () => {
  const pixels = grayPixels(384, 200, 128);
  pixels.fill(255, 384 * 100 * 4);
  for (const contrast of [60, 160]) {
    const result = preparePrint(pixels, 200, { contrast });
    assert.ok(result.ink.slice(-384 * 64).every(value => value === 0));
  }
  assert.throws(() => preparePrint(grayPixels(384, 1500, 128), 1500), /too long/);
});

test('non-dithered output preserves the binary correction used for text and QR codes', () => {
  const pixels = grayPixels(384, 20, 255);
  pixels.fill(0, 0, 384 * 10 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const result = preparePrint(pixels, 20, { dither: false });
  const expected = calibrateInk(monochrome(pixels, 384, 20, { dither: false }), 20);
  assert.deepEqual(result.ink, expected.ink);
  assert.equal(result.height, expected.height);
});
