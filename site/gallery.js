const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ICONIFY_API = 'https://api.iconify.design';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'image/bmp']);
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function commonsImageURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
    return url.href;
  } catch { return null; }
}

function iconifyImageURL(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ICONIFY_API || url.username || url.password ||
      !/^\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function searchURL(query, offset = 0) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: query.trim(),
    gsrnamespace: '6', gsrlimit: '48', gsroffset: String(offset),
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '500', iiurlheight: '700',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|AttributionRequired',
  });
  return `${COMMONS_API}?${params}`;
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

export function iconifyResults(data, monochromeOnly = true) {
  if (!Array.isArray(data.icons)) throw new Error('The icon library could not complete this search. Try again.');
  const items = data.icons.flatMap(id => {
    if (!ICON_NAME.test(id)) return [];
    const [prefix, name] = id.split(':');
    const collection = data.collections?.[prefix];
    if (!collection?.license?.title || (monochromeOnly && collection.palette !== false)) return [];
    const svg = height => `${ICONIFY_API}/${prefix}/${name}.svg?height=${height}&color=%23000`;
    return [{
      id, title: `${name.replaceAll('-', ' ')} · ${collection.name || prefix}`,
      thumbnail: svg(128), image: svg(768),
      source: `https://icon-sets.iconify.design/${prefix}/${name}/`,
      artist: collection.author?.name || '', license: collection.license.title,
    }];
  });
  // Pagination must use the raw count, before optional monochrome filtering.
  const next = data.limit > 0 && data.icons.length >= data.limit ? (data.start || 0) + data.icons.length : null;
  return { items, next };
}

export async function searchGraphics(query, { source = 'iconify', offset = 0, monochromeOnly = true, signal } = {}) {
  signal?.throwIfAborted();
  if (!['iconify', 'commons'].includes(source)) throw new Error('Choose an image library.');
  // Fetch two gallery pages first, then the remaining matches on demand, as
  // recommended by Iconify. No image downloads or pixel checks block search.
  const params = new URLSearchParams({ query: query.trim(), limit: offset === 0 ? '96' : '999', start: String(offset) });
  const url = source === 'iconify' ? `${ICONIFY_API}/search?${params}` : searchURL(query, offset);
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(response.status === 429 ? 'The image library is busy. Wait a moment before searching again.' : 'The image library is unavailable. Please try again.');
  const data = await response.json();
  return source === 'iconify' ? iconifyResults(data, monochromeOnly) : galleryResults(data);
}

async function rasterizeIcon(blob, signal) {
  const url = URL.createObjectURL(blob), image = new Image();
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new DOMException('Canceled', 'AbortError'));
      image.onload = resolve;
      image.onerror = () => reject(new Error('This icon could not be opened. Try another one.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // SVG stays in an image context, never inserted into the page as markup.
      image.src = url;
    });
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) throw new Error('This icon has no printable size.');
    const scale = Math.min(1, 768 / width, 768 / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await createImageBitmap(canvas);
  } finally {
    signal?.removeEventListener('abort', abort);
    image.onload = image.onerror = null;
    image.src = '';
    URL.revokeObjectURL(url);
  }
}

export async function loadGraphic(item, signal) {
  signal?.throwIfAborted();
  const value = item.image || item.thumbnail;
  const svgURL = iconifyImageURL(value);
  const url = svgURL || commonsImageURL(value);
  if (!url) throw new Error('Unsupported image source.');
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('This graphic could not be loaded. Try another one.');
  const blob = await response.blob();
  const type = blob.type.split(';')[0];
  if (blob.size > 15 * 1024 * 1024 || !(svgURL ? type === 'image/svg+xml' : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))) {
    throw new Error('This graphic is not available as a supported preview image.');
  }
  return svgURL ? rasterizeIcon(blob, signal) : createImageBitmap(blob);
}
