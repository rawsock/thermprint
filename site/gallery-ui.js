import { searchGraphics, loadGraphic } from './gallery.js';

export function setupGallery({ onSelect, onLoading }) {
  const $ = id => document.getElementById(id);
  let next = null, query = '', blackWhiteOnly = false, selected = null;
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
      const artistText = item.artistHTML.replace(/<[^>]*>/g, '');
      const artist = new DOMParser().parseFromString(artistText, 'text/html').body.textContent.trim();
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
      blackWhiteOnly = $('graphics-bw').checked;
      $('graphics-gallery').replaceChildren();
      next = null;
    }
    const timer = setTimeout(() => controller.abort(), blackWhiteOnly ? 45000 : 20000);
    $('graphics-more').hidden = true;
    $('graphics-broaden').hidden = true;
    if (!query) { clearTimeout(timer); $('graphics-search').textContent = 'Search'; status('Enter a few words to find images.'); return; }
    $('graphics-search').textContent = 'Searching…';
    status(blackWhiteOnly ? 'Finding artwork and checking for black ink on white…' : 'Searching Wikimedia Commons…');
    try {
      const result = await searchGraphics(query, { offset: more ? next : 0, blackWhiteOnly, signal: controller.signal });
      if (controller !== searchController) return;
      for (const item of result.items) {
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
      next = result.next;
      $('graphics-more').hidden = next === null;
      const count = $('graphics-gallery').children.length;
      $('graphics-broaden').hidden = count > 0 || !blackWhiteOnly;
      const resultMessage = count ? `${count} graphics. Select one to preview and print.` : blackWhiteOnly ?
        `No simple black-and-white artwork in these results. ${next !== null ? 'Load more, try fewer words, or search all images.' : 'Try fewer words, or search all images.'}` :
        'No images found. Try fewer words, or a broader subject such as cat.';
      status(resultMessage + (result.unavailable ? ' Some previews could not be checked.' : ''));
    } catch (error) {
      if (controller === searchController) status(controller.signal.aborted ? 'Search timed out. Try again.' : error.message);
    } finally {
      clearTimeout(timer);
      if (controller === searchController) $('graphics-search').textContent = 'Search';
    }
  };
  $('graphics-form').addEventListener('submit', event => { event.preventDefault(); search(false); });
  $('graphics-more').addEventListener('click', () => search(true));
  $('graphics-bw').addEventListener('change', () => search(false));
  $('graphics-broaden').addEventListener('click', () => { $('graphics-bw').checked = false; search(false); });
}
