import polish from './locale-pl.js';

let language = 'en';
let staticTexts = [], staticAttributes = [];
const messages = new Map();

export function t(message, values = {}) {
  const translated = language === 'pl' && Object.hasOwn(polish, message) ? polish[message] : message;
  return translated.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

export function setText(element, message, values = {}) {
  messages.set(element, { message, values });
  element.textContent = t(message, values);
}

export function formatNumber(value) {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
}

function save(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* Preferences still work for this visit. */ }
}
function saved(key) {
  try { return globalThis.localStorage?.getItem(key); } catch { return null; }
}

export function setLanguage(value, root = globalThis.document) {
  language = value === 'pl' ? 'pl' : 'en';
  save('thermprint-language', language);
  if (root) root.documentElement.lang = language;
  for (const { node, original, key } of staticTexts) {
    if (node.isConnected !== false) node.textContent = original.replace(key, t(key));
  }
  for (const { element, attribute, original } of staticAttributes) element.setAttribute(attribute, t(original));
  for (const [element, { message, values }] of messages) {
    if (element.isConnected === false) { messages.delete(element); continue; }
    element.textContent = t(message, values);
  }
}

export function themeFor(mode, prefersDark) {
  return mode === 'dark' || (mode === 'system' && prefersDark) ? 'dark' : 'light';
}

export function setupPreferences(root = document, browser = window) {
  // Capture static UI strings once, before runtime labels replace them. Never
  // translate editable text, QR content, image metadata, or the diagnostic log.
  staticTexts = []; staticAttributes = [];
  const walker = root.createTreeWalker(root.documentElement, 4);
  let node;
  while ((node = walker.nextNode())) {
    const key = node.textContent.trim();
    if (key && !node.parentElement?.closest('script, style, textarea, pre, [data-no-translate]')) {
      staticTexts.push({ node, original: node.textContent, key });
    }
  }
  for (const element of root.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      const original = element.getAttribute(attribute);
      if (original) staticAttributes.push({ element, attribute, original });
    }
  }
  const locale = root.getElementById('language'), theme = root.getElementById('theme');
  locale.value = saved('thermprint-language') === 'pl' ? 'pl' : 'en';
  setLanguage(locale.value, root);
  locale.addEventListener('change', () => {
    setLanguage(locale.value, root);
    browser.dispatchEvent(new Event('thermprint-language-change'));
  });
  const preference = saved('thermprint-theme');
  theme.value = ['light', 'dark'].includes(preference) ? preference : 'system';
  const scheme = browser.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => { root.documentElement.dataset.theme = themeFor(theme.value, scheme.matches); };
  theme.addEventListener('change', () => { save('thermprint-theme', theme.value); applyTheme(); });
  scheme.addEventListener('change', applyTheme);
  applyTheme();
}
