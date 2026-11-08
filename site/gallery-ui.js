import { searchGraphics, loadGraphic } from './gallery.js';

export function setupGallery({ onSelect, onLoading }) {
  const $ = id => document.getElementById(id);
  let next = null, query = '', source = 'iconify', monochromeOnly = true, selected = null, pending = [];
  let searchController, imageController;
  const status = text => { $('graphics-status').textContent = text; };
  const setSelection = () => {
    for (const card of $('graphics-gallery').children) card.setAttribute('aria-pressed', String(card.dataset.id === selected));
  };
  const choose = async item => {
    imageController?.abort();
    const controller = imageController = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    onLoading(true);
    status('Loading graphic…');
    try {
      const bitmap = await loadGraphic(item, controller.signal);
      if (controller !== imageController) { bitmap.close(); return; }
      if (controller.signal.aborted) { bitmap.close(); throw new Error('Image loading timed out. Try again.'); }
      selected = item.id;
      setSelection();
      $('graphics-selected-title').textContent = item.title;
      const artistText = (item.artistHTML || '').replace(/<[^>]*>/g, '');
      const artist = item.artist || new DOMParser().parseFromString(artistText, 'text/html').body.textContent.trim();
      $('graphics-credit').textContent = [artist, item.license].filter(Boolean).join(' · ');
      $('graphics-source').href = item.source;
      $('graphics-selection').hidden = false;
      onSelect(bitmap, item);
      status('Graphic selected. Adjust the ink balance or print when ready.');
    } catch (error) {
      if (controller === imageController) status(controller.signal.aborted ? 'Image loading timed out. Try again.' : error.message);
    } finally {
      clearTimeout(timer);
      if (controller === imageController) onLoading(false);
    }
  };
  const search = async more => {
    searchController?.abort();
    const controller = searchController = new AbortController();
    if (!more) {
      query = $('graphics-query').value.trim();
      source = $('graphics-library').value;
      monochromeOnly = $('graphics-monochrome').checked;
      $('graphics-gallery').replaceChildren();
      next = null;
      pending = [];
    }
    const timer = setTimeout(() => controller.abort(), 20000);
    $('graphics-more').hidden = true;
    $('graphics-broaden').hidden = true;
    if (!query) { clearTimeout(timer); $('graphics-search').textContent = 'Search'; status('Enter a few words to find images.'); return; }
    $('graphics-search').textContent = 'Searching…';
    status(source === 'iconify' ? 'Searching Iconify…' : 'Searching Wikimedia Commons…');
    try {
      if (!more || pending.length === 0) {
        const result = await searchGraphics(query, { source, offset: more ? next : 0, monochromeOnly, signal: controller.signal });
        if (controller !== searchController) return;
        next = result.next;
        pending = result.items;
      }
      for (const item of pending.splice(0, 48)) {
        if (Array.from($('graphics-gallery').children).some(card => card.dataset.id === item.id)) continue;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'graphic-card';
        card.dataset.id = item.id;
        card.title = `Use ${item.title}`;
        card.setAttribute('aria-label', `Use ${item.title}, ${item.license}`);
        const image = document.createElement('img');
        image.src = item.thumbnail;
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        const title = document.createElement('strong');
        title.textContent = item.title;
        const license = document.createElement('small');
        license.textContent = item.license;
        card.append(image, title, license);
        card.addEventListener('click', () => choose(item));
        $('graphics-gallery').append(card);
      }
      setSelection();
      $('graphics-more').hidden = next === null && pending.length === 0;
      const count = $('graphics-gallery').children.length;
      $('graphics-broaden').hidden = count > 0;
      $('graphics-broaden').textContent = source === 'iconify' ? 'Search Wikimedia instead' : 'Search Iconify instead';
      status(count ? `${count} graphics shown. Select one to preview and print.` : source === 'iconify' ?
        'No matching icons here. Try a short subject such as cat, include color icons, or search Wikimedia.' :
        'No images found. Try fewer words, or a broader subject such as cat.');
    } catch (error) {
      if (controller === searchController) {
        status(controller.signal.aborted ? 'Search timed out. Try again.' : error.message);
        $('graphics-more').hidden = next === null && pending.length === 0;
      }
    } finally {
      clearTimeout(timer);
      if (controller === searchController) $('graphics-search').textContent = 'Search';
    }
  };
  $('graphics-form').addEventListener('submit', event => { event.preventDefault(); search(false); });
  $('graphics-more').addEventListener('click', () => search(true));
  const updateLibrary = () => {
    const icons = $('graphics-library').value === 'iconify';
    $('graphics-monochrome-label').hidden = !icons;
    $('graphics-hint').textContent = icons ?
      'Search icons and symbols from Iconify. Short subjects like cat, flower or coffee work best.' :
      'Search photos and illustrations from Wikimedia Commons.';
    search(false);
  };
  $('graphics-library').addEventListener('change', updateLibrary);
  $('graphics-monochrome').addEventListener('change', () => search(false));
  $('graphics-broaden').addEventListener('click', () => {
    $('graphics-library').value = source === 'iconify' ? 'commons' : 'iconify';
    updateLibrary();
  });
}
