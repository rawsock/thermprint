import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, Image as CanvasImage } from '@napi-rs/canvas';
import { galleryResults, searchURL, commonsImageURL, iconifyResults, searchGraphics, loadGraphic } from '../site/gallery.js';
import { setupGallery } from '../site/gallery-ui.js';
import { imageCanvas, preparePrint } from '../site/raster.js';

const commons = { query: { pages: [
  { pageid: 7, index: 2, title: 'File:Cat.svg', imageinfo: [{ mime: 'image/svg+xml', thumburl: 'https://thumb.wikimedia.org/cat.png', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'An artist' } } }] },
  { pageid: 9, index: 1, title: 'File:Flower.svg', imageinfo: [{ mime: 'image/svg+xml', thumburl: 'https://upload.wikimedia.org/flower.png', extmetadata: { LicenseShortName: { value: 'Public domain' } } }] },
  { pageid: 11, index: 3, title: 'File:Unsupported.pdf', imageinfo: [{ mime: 'application/pdf', thumburl: 'https://other.example/test.png' }] },
] }, continue: { gsroffset: 48 } };
const collections = {
  mdi: { name: 'Material Design Icons', palette: false, author: { name: 'Pictogrammers' }, license: { title: 'Apache 2.0' } },
  emoji: { name: 'Emoji', palette: true, license: { title: 'CC BY 4.0' } },
};
const icons = { icons: ['mdi:cat', 'emoji:cat', 'mdi:cat-outline'], collections, start: 0, limit: 3, total: 3 };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 1600 800"><circle cx="800" cy="400" r="300" fill="#000"/></svg>';
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Commons search preserves query, ranking and license metadata with larger pages', () => {
  const url = new URL(searchURL('cat & flower', 48));
  assert.equal(url.searchParams.get('gsrsearch'), 'cat & flower');
  assert.equal(url.searchParams.get('origin'), '*');
  assert.equal(url.searchParams.get('gsroffset'), '48');
  assert.equal(url.searchParams.get('gsrlimit'), '48');
  const result = galleryResults(commons);
  assert.deepEqual(result.items.map(item => item.id), ['9', '7']);
  assert.equal(result.items[1].license, 'CC BY-SA 4.0');
  assert.equal(result.items[1].source, 'https://commons.wikimedia.org/?curid=7');
  assert.equal(result.next, 48);
  assert.equal(commonsImageURL('https://thumb.wikimedia.org.evil.example/test.png'), null);
  assert.equal(commonsImageURL('javascript:alert(1)'), null);
});

test('Iconify filters by collection metadata without losing pagination, attribution or high-resolution artwork', () => {
  const result = iconifyResults(icons);
  assert.deepEqual(result.items.map(item => item.id), ['mdi:cat', 'mdi:cat-outline']);
  assert.equal(result.next, 3, 'cursor counts all returned icons, including color sets');
  const cat = result.items[0];
  assert.equal(cat.artist, 'Pictogrammers');
  assert.equal(cat.license, 'Apache 2.0');
  assert.equal(cat.source, 'https://icon-sets.iconify.design/mdi/cat/');
  assert.equal(new URL(cat.image).searchParams.get('height'), '768');
  assert.equal(new URL(cat.thumbnail).searchParams.get('height'), '128');
  assert.equal(new URL(cat.image).searchParams.get('color'), '#000');
  assert.equal(iconifyResults(icons, false).items.length, 3);
  assert.equal(iconifyResults({ ...icons, icons: ['mdi:../../bad', 'unknown:cat'], limit: 96 }).items.length, 0);
  assert.equal(iconifyResults({ ...icons, icons: [], limit: 96 }).next, null);
});

test('default search is one Iconify metadata request, with no image fetch or decoding', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), options });
    return json(icons);
  });
  const first = await searchGraphics(' cat & dog ');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin, 'https://api.iconify.design');
  assert.equal(requests[0].url.searchParams.get('query'), 'cat & dog');
  assert.equal(requests[0].url.searchParams.get('limit'), '96');
  assert.equal(requests[0].options.credentials, 'omit');
  await searchGraphics('cat', { offset: first.next });
  assert.equal(requests[1].url.searchParams.get('start'), '3');
  assert.equal(requests[1].url.searchParams.get('limit'), '999');
  await assert.rejects(searchGraphics('cat', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(requests.length, 2);
});

test('Commons remains available and request failures produce actionable errors', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).hostname, 'commons.wikimedia.org');
    return json(commons);
  });
  assert.equal((await searchGraphics('cat', { source: 'commons' })).items.length, 2);
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(searchGraphics('cat'), /busy/);
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(searchGraphics('cat'), /unavailable/);
});

test('selected SVG decodes into printable pixels with preserved proportions, and releases its object URL', async t => {
  const nativeFetch = globalThis.fetch;
  const nativeSetSource = Object.getOwnPropertyDescriptor(CanvasImage.prototype, 'src').set;
  const revoked = t.mock.method(URL, 'revokeObjectURL');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
  });
  // Exercise real SVG decoding and canvas drawing while adapting the browser's
  // blob-URL Image interface to the native canvas implementation used in tests.
  globalThis.Image = function () {
    const image = new CanvasImage();
    Object.defineProperty(image, 'src', { set(url) {
      if (!url) return;
      nativeFetch(url).then(response => response.arrayBuffer()).then(buffer => {
        nativeSetSource.call(image, Buffer.from(buffer));
      }).catch(error => image.onerror?.(error));
    } });
    return image;
  };
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  globalThis.createImageBitmap = async canvas => canvas;
  try {
    const item = iconifyResults(icons).items[0];
    const bitmap = await loadGraphic(item);
    assert.deepEqual(requests, [item.image]);
    assert.equal(bitmap.width, 768);
    assert.equal(bitmap.height, 384);
    const canvas = imageCanvas(bitmap);
    const pixels = canvas.getContext('2d').getImageData(0, 0, 384, canvas.height).data;
    const print = preparePrint(pixels, canvas.height, { dither: false });
    assert.ok(print.ink.some(Boolean));
    assert.equal(print.artworkInk[92 * 384 + 192], 1);
    assert.equal(print.artworkInk[92 * 384 + 20], 0);
    assert.equal(revoked.mock.callCount(), 1);
  } finally { delete globalThis.Image; delete globalThis.document; delete globalThis.createImageBitmap; }
});

test('canceling SVG loading releases resources; untrusted SVG hosts and incorrect MIME types are rejected', async t => {
  const revoked = t.mock.method(URL, 'revokeObjectURL');
  t.mock.method(globalThis, 'fetch', async () => new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }));
  globalThis.Image = class {};
  try {
    const controller = new AbortController();
    const loading = loadGraphic(iconifyResults(icons).items[0], controller.signal);
    const canceled = assert.rejects(loading, { name: 'AbortError' });
    await tick();
    controller.abort();
    await canceled;
    assert.equal(revoked.mock.callCount(), 1);
    await assert.rejects(loadGraphic({ image: 'https://api.iconify.design.evil.example/mdi/cat.svg' }), /Unsupported/);
    await assert.rejects(loadGraphic({ image: 'https://upload.wikimedia.org/cat.svg' }), /supported preview/);
    globalThis.fetch = async () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(loadGraphic(iconifyResults(icons).items[0]), /supported preview/);
  } finally { delete globalThis.Image; }
});

class Element extends EventTarget {
  constructor() { super(); this.children = []; this.dataset = {}; this.hidden = false; this.value = ''; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
function galleryDOM() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: get, createElement: () => new Element() };
  get('graphics-library').value = 'iconify';
  get('graphics-monochrome').checked = true;
  get('graphics-query').value = 'cat';
  setupGallery({ onSelect() {}, onLoading() {} });
  return get;
}

test('gallery shows 48 results at a time, uses buffered results, then fetches remaining icons only on demand', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(new URL(url));
    const start = Number(new URL(url).searchParams.get('start'));
    const count = start === 0 ? 96 : 4;
    return json({ icons: Array.from({ length: count }, (_, i) => `mdi:cat-${start + i}`), collections, start, limit: start === 0 ? 96 : 999 });
  });
  const get = galleryDOM();
  try {
    get('graphics-form').dispatchEvent(new Event('submit'));
    await tick();
    assert.equal(get('graphics-gallery').children.length, 48);
    assert.equal(get('graphics-more').hidden, false);
    assert.equal(requests.length, 1);
    get('graphics-more').dispatchEvent(new Event('click'));
    await tick();
    assert.equal(get('graphics-gallery').children.length, 96);
    assert.equal(requests.length, 1, 'second page was already buffered');
    get('graphics-more').dispatchEvent(new Event('click'));
    await tick();
    assert.equal(get('graphics-gallery').children.length, 100);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get('start'), '96');
    assert.equal(get('graphics-more').hidden, true);
  } finally { delete globalThis.document; }
});

test('switching libraries ignores an older pending search and empty results offer the other library', async t => {
  let resolveOld;
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).hostname === 'api.iconify.design') return new Promise(resolve => { resolveOld = resolve; });
    return json({});
  });
  const get = galleryDOM();
  try {
    get('graphics-form').dispatchEvent(new Event('submit'));
    get('graphics-library').value = 'commons';
    get('graphics-library').dispatchEvent(new Event('change'));
    await tick();
    resolveOld(json(icons));
    await tick();
    assert.equal(get('graphics-gallery').children.length, 0);
    assert.equal(get('graphics-monochrome-label').hidden, true);
    assert.equal(get('graphics-broaden').hidden, false);
    assert.equal(get('graphics-broaden').textContent, 'Search Iconify instead');
    get('graphics-query').value = '';
    get('graphics-form').dispatchEvent(new Event('submit'));
    await tick();
    assert.equal(get('graphics-more').hidden, true);
  } finally { delete globalThis.document; }
});
