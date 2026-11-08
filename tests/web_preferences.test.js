import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPreferences, setLanguage, setText, t, formatNumber, themeFor } from '../site/i18n.js';

class Element extends EventTarget {
  constructor(text = '', excluded = false) {
    super();
    this.excluded = excluded;
    this.attributes = new Map();
    this.textContent = text;
    this.value = '';
  }
  set textContent(value) {
    if (this.node) this.node.isConnected = false;
    this.node = { textContent: value, parentElement: this, isConnected: true };
  }
  get textContent() { return this.node.textContent; }
  closest() { return this.excluded ? this : null; }
  getAttribute(name) { return this.attributes.get(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}

function fixture(context, preferences = {}) {
  const stored = new Map(Object.entries(preferences));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value),
  } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  const elements = {
    language: new Element('Language'), theme: new Element('Theme'),
    button: new Element('  Connect printer  '), hint: new Element('No printer connected'),
    textarea: new Element('Connect printer', true), log: new Element('Connect printer', true),
    filename: new Element(),
  };
  elements.textarea.value = 'Zażółć gęślą jaźń {name} https://example.com';
  elements.textarea.setAttribute('placeholder', 'What would you like to print?');
  elements.button.setAttribute('aria-label', 'Connect printer');
  const root = {
    documentElement: { dataset: {} },
    getElementById: id => elements[id],
    querySelectorAll: () => Object.values(elements).filter(element => element.attributes.size),
    createTreeWalker: () => {
      const nodes = Object.values(elements).map(element => element.node);
      return { nextNode: () => nodes.shift() };
    },
  };
  const scheme = new EventTarget();
  scheme.matches = true;
  const browser = new EventTarget();
  browser.matchMedia = () => scheme;
  return { root, browser, scheme, elements, stored };
}

test('Polish preferences restore, translate live UI and preserve editable content and event listeners', context => {
  const { root, browser, elements, stored } = fixture(context, { 'thermprint-language': 'pl' });
  const content = elements.textarea.value;
  let clicks = 0, localeChanges = 0;
  elements.button.addEventListener('click', () => clicks++);
  browser.addEventListener('thermprint-language-change', () => localeChanges++);
  setupPreferences(root, browser);
  assert.equal(root.documentElement.lang, 'pl');
  assert.equal(elements.button.textContent, '  Połącz z drukarką  ');
  assert.equal(elements.button.getAttribute('aria-label'), 'Połącz z drukarką');
  assert.equal(elements.textarea.getAttribute('placeholder'), 'Co chcesz wydrukować?');
  assert.equal(elements.textarea.textContent, 'Connect printer');
  assert.equal(elements.log.textContent, 'Connect printer');
  setText(elements.hint, 'About {length} mm long', { length: 42 });
  setText(elements.filename, '{name}', { name: 'Connect printer {length}.png' });
  assert.equal(elements.hint.textContent, 'Długość: około 42 mm');
  elements.language.value = 'en';
  elements.language.dispatchEvent(new Event('change'));
  assert.equal(elements.hint.textContent, 'About 42 mm long');
  assert.equal(elements.button.textContent, '  Connect printer  ');
  assert.equal(elements.filename.textContent, 'Connect printer {length}.png');
  assert.equal(elements.textarea.value, content);
  assert.equal(stored.get('thermprint-language'), 'en');
  assert.equal(localeChanges, 1);
  elements.button.dispatchEvent(new Event('click'));
  assert.equal(clicks, 1);
});

test('System theme follows the device, explicit themes persist and override system changes', context => {
  const { root, browser, scheme, elements, stored } = fixture(context);
  setupPreferences(root, browser);
  assert.equal(elements.theme.value, 'system');
  assert.equal(root.documentElement.dataset.theme, 'dark');
  scheme.matches = false;
  scheme.dispatchEvent(new Event('change'));
  assert.equal(root.documentElement.dataset.theme, 'light');
  elements.theme.value = 'dark';
  elements.theme.dispatchEvent(new Event('change'));
  assert.equal(stored.get('thermprint-theme'), 'dark');
  scheme.dispatchEvent(new Event('change'));
  assert.equal(root.documentElement.dataset.theme, 'dark');
  setupPreferences(root, browser);
  assert.equal(elements.theme.value, 'dark');
  assert.equal(themeFor('light', true), 'light');
  assert.equal(themeFor('invalid', true), 'light');
});

test('Blocked preference storage still allows language and theme changes', context => {
  const { root, browser, elements } = fixture(context);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage disabled'); } });
  assert.doesNotThrow(() => setupPreferences(root, browser));
  elements.language.value = 'pl';
  elements.language.dispatchEvent(new Event('change'));
  elements.theme.value = 'dark';
  elements.theme.dispatchEvent(new Event('change'));
  assert.equal(root.documentElement.lang, 'pl');
  assert.equal(root.documentElement.dataset.theme, 'dark');
});

test('Translations format Polish numbers, interpolate values and safely fall back for unknown errors', context => {
  const { root, browser } = fixture(context);
  setupPreferences(root, browser);
  setLanguage('pl', root);
  assert.equal(formatNumber(113.725), '113,7');
  assert.equal(t('Load paper and close the printer lid.'), 'Włóż papier i zamknij pokrywę drukarki.');
  assert.equal(t('Use {title}', { title: '<cat & dog>' }), 'Użyj: <cat & dog>');
  assert.equal(t('Unknown browser error'), 'Unknown browser error');
  assert.equal(t('constructor'), 'constructor');
  assert.equal(t('Use {title}'), 'Użyj: {title}');
  setLanguage('unavailable', root);
  assert.equal(formatNumber(113.725), '113.7');
  assert.equal(t('Connect printer'), 'Connect printer');
});
