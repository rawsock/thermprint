const API = 'https://commons.wikimedia.org/w/api.php';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'image/bmp']);

export function commonsImageURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function searchURL(query, offset = 0, artworkType = null) {
  const subject = query.trim();
  // Repeat the subject in each OR branch: CirrusSearch does not group these like SQL.
  const search = artworkType === 'vectors' ? `${subject} filetype:drawing` : artworkType === 'bitmaps' ?
    ['icon', 'silhouette', '"line art"', 'clipart', 'label', '"black and white"']
      .map(kind => `${subject} ${kind}`).join(' OR ') + ' filetype:bitmap' : subject;
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: search,
    gsrnamespace: '6', gsrlimit: '18', gsroffset: String(offset),
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '500', iiurlheight: '700',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|AttributionRequired',
  });
  return `${API}?${params}`;
}

export function galleryResults(data) {
  if (data.error) throw new Error('The image library could not complete this search. Try a simpler query.');
  const items = (data.query?.pages || []).sort((a, b) => a.index - b.index).flatMap(page => {
    const info = page.imageinfo?.[0];
    const thumbnail = commonsImageURL(info?.thumburl);
    const license = info?.extmetadata?.LicenseShortName?.value;
    if (!thumbnail || !license || !IMAGE_TYPES.has(info.mime)) return [];
    return [{
      id: String(page.pageid), title: page.title.replace(/^File:/, ''), thumbnail,
      source: `https://commons.wikimedia.org/?curid=${page.pageid}`,
      artistHTML: info.extmetadata.Artist?.value || '', license,
    }];
  });
  return { items, next: data.continue?.gsroffset ?? null };
}

export function isBlackWhiteArtwork(rgba, width) {
  const count = rgba.length / 4;
  const tones = new Float32Array(count), grayPixels = new Uint8Array(count);
  let black = 0, white = 0, colored = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    const r = rgba[i] * alpha + 255 * (1 - alpha);
    const g = rgba[i + 1] * alpha + 255 * (1 - alpha);
    const b = rgba[i + 2] * alpha + 255 * (1 - alpha);
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    tones[i / 4] = (r + g + b) / 3;
    if (low > 224) white++;
    else if (high - low > 24) colored++;
    else if (high < 64) black++;
    else grayPixels[i / 4] = 1;
  }
  const marks = count - white, gray = marks - black - colored;
  let shaded = 0;
  for (let y = 1; y < count / width - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (grayPixels[i] && [i - 1, i + 1, i - width, i + width].every(neighbor => Math.abs(tones[i] - tones[neighbor]) < 12)) shaded++;
    }
  }
  // Allow antialiased edges and JPEG noise, but reject shaded fills and even small
  // colored icons on large white backgrounds. Transparent pixels print as white.
  return black > count * 0.0005 && white > count * 0.05 &&
    colored <= marks * 0.01 && gray <= marks * 0.25 && gray <= count * 0.08 && shaded <= marks * 0.03;
}

export async function searchGraphics(query, { offset = 0, blackWhiteOnly = false, signal } = {}) {
  const fetchPage = async (start, type = null) => {
    const response = await fetch(searchURL(query, start, type), { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(response.status === 429 ? 'The image library is busy. Wait a moment before searching again.' : 'The image library is unavailable. Please try again.');
    return galleryResults(await response.json());
  };
  if (!blackWhiteOnly) return fetchPage(offset);
  const items = [];
  let next = offset === 0 ? { vectors: 0, bitmaps: 0 } : { ...offset }, unavailable = 0, checked = 0;
  for (let page = 0; page < 3; page++) {
    // Check both sources so photographs don't bury icons, while raster drawings
    // remain eligible. Each source keeps its own cursor when loading more.
    const results = await Promise.all(['vectors', 'bitmaps'].map(async type => {
      if (next[type] === null) return { items: [] };
      const result = await fetchPage(next[type], type);
      next[type] = result.next;
      return result;
    }));
    const candidates = [...new Map(results.flatMap(result => result.items).map(item => [item.id, item])).values()];
    const keep = new Set();
    let index = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (index < candidates.length) {
        signal?.throwIfAborted();
        const item = candidates[index++];
        let bitmap;
        try {
          bitmap = await loadGraphic(item, signal);
          signal?.throwIfAborted();
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          if (isBlackWhiteArtwork(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width)) keep.add(item.id);
          checked++;
        } catch (error) {
          if (signal?.aborted) throw error;
          unavailable++;
        } finally { bitmap?.close(); }
      }
    }));
    items.push(...candidates.filter(item => keep.has(item.id) && !items.some(existing => existing.id === item.id)));
    if (next.vectors === null && next.bitmaps === null) next = null;
    if (items.length >= 6 || next === null) break;
  }
  if (!checked && unavailable) throw new Error('Could not check the image previews. Try again, or turn off Black & white artwork.');
  return { items, next, unavailable };
}

export async function loadGraphic(item, signal) {
  const url = commonsImageURL(item.thumbnail);
  if (!url) throw new Error('Unsupported image source.');
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('This graphic could not be loaded. Try another one.');
  const blob = await response.blob();
  if (blob.size > 15 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type.split(';')[0])) {
    throw new Error('This graphic is not available as a supported preview image.');
  }
  return createImageBitmap(blob);
}
