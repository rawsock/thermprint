const API = 'https://commons.wikimedia.org/w/api.php';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);

export function commonsImageURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function searchURL(query, offset = 0, drawingsOnly = true) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: query.trim() + (drawingsOnly ? ' filetype:drawing' : ''),
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
    if (!thumbnail || !license || !info.mime?.startsWith('image/')) return [];
    return [{
      id: String(page.pageid), title: page.title.replace(/^File:/, ''), thumbnail,
      source: `https://commons.wikimedia.org/?curid=${page.pageid}`,
      artistHTML: info.extmetadata.Artist?.value || '', license,
    }];
  });
  return { items, next: data.continue?.gsroffset ?? null };
}

export async function searchGraphics(query, { offset = 0, drawingsOnly = true, signal } = {}) {
  const response = await fetch(searchURL(query, offset, drawingsOnly), { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(response.status === 429 ? 'The image library is busy. Wait a moment before searching again.' : 'The image library is unavailable. Please try again.');
  return galleryResults(await response.json());
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
