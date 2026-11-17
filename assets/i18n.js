// UI translations only. Archive filenames, metadata, and search data remain unchanged.
'use strict';
window.J2ME_I18N = (() => {
  // Native language names and formatting rules live alongside the translations.
  // Loading the catalog first also keeps all three page menus in sync.
  let languages = [];
  let language = 'en';
  let english = {};
  let chosen = {};
  // A locale file can be updated while an older response is still in a browser
  // cache. Keep the request versioned and revalidate before displaying UI text.
  const LOCALE_REVISION = '20261117-export-speed';
  // Resolve locale assets relative to this JS file, not the HTML document,
  // because the standalone help pages live inside html/.
  const localePath = document.currentScript?.src
    ? document.currentScript.src.replace(/i18n\.js(?:\?.*)?$/, 'locales/')
    : 'assets/locales/';

  async function load(code) {
    const response = await fetch(`${localePath}${code}.json?v=${LOCALE_REVISION}`, {cache: 'no-cache'});
    if (!response.ok) throw new Error(`Translation ${code}: HTTP ${response.status}`);
    return response.json();
  }

  function t(key, vars = {}) {
    let message = chosen[key] ?? english[key] ?? key;
    if (message && typeof message === 'object') {
      const category = new Intl.PluralRules(numberLocale()).select(Number(vars.pluralCount ?? vars.count));
      message = message[category] ?? message.other ?? message.one;
    }
    return String(message).replace(/\{(\w+)\}/g,
      (whole, name) => Object.hasOwn(vars, name) ? String(vars[name]) : whole);
  }

  function numberLocale() {
    return languages.find(item => item.code === language)?.numberLocale || 'en-US';
  }

  function translateStatic() {
    document.documentElement.lang = language;
    // Other pages can opt into a localized title without affecting the homepage.
    document.title = t(document.querySelector('[data-i18n-title]')?.dataset.i18nTitle || 'pageTitle');
    for (const element of document.querySelectorAll('[data-i18n-content]')) {
      element.content = t(element.dataset.i18nContent);
    }
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
      element.placeholder = t(element.dataset.i18nPlaceholder);
    }
    for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
      element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    }
  }

  async function init() {
    try {
      const catalog = await load('languages');
      if (!Array.isArray(catalog) || !catalog.some(item => item.code === 'en') ||
          catalog.some(item => !item.code || !item.name || !item.numberLocale) ||
          new Set(catalog.map(item => item.code)).size !== catalog.length)
        throw new Error('Invalid language catalog');
      languages = catalog;
    } catch (error) {
      console.warn('Language catalog unavailable; using English:', error);
    }
    const codes = languages.map(item => item.code);
    const urlLanguage = new URLSearchParams(location.search).get('lang');
    try {
      const saved = localStorage.getItem('j2me-archive-language');
      language = urlLanguage !== null ? (codes.includes(urlLanguage) ? urlLanguage : 'en')
        : (codes.includes(saved) ? saved : 'en');
    } catch {
      language = codes.includes(urlLanguage) ? urlLanguage : 'en';
    }
    try {
      english = await load('en');
    } catch (error) {
      // A deployment missing translations must not prevent archive searches.
      console.warn('English translation file unavailable:', error);
    }
    if (language !== 'en') {
      try { chosen = await load(language); }
      catch (error) {
        console.warn('Translation unavailable; using English:', error);
        language = 'en';
      }
    }
    translateStatic();
    const select = document.getElementById('language-select');
    if (select) {
      select.replaceChildren(...languages.map(item => {
        const option = document.createElement('option');
        option.value = item.code;
        option.textContent = item.name;
        return option;
      }));
      select.value = language;
      select.setAttribute('aria-label', t('languageLabel'));
      select.addEventListener('change', () => {
        const next = select.value;
        if (!codes.includes(next)) return;
        try { localStorage.setItem('j2me-archive-language', next); } catch {}
        const url = new URL(location.href);
        if (next === 'en') url.searchParams.delete('lang');
        else url.searchParams.set('lang', next);
        location.assign(url.href);
      });
    }
    try { localStorage.setItem('j2me-archive-language', language); } catch {}
    // Make a stored non-English preference shareable without reloading the page.
    if (!urlLanguage && language !== 'en') {
      const url = new URL(location.href);
      url.searchParams.set('lang', language);
      history.replaceState(history.state, '', url.href);
    }
  }

  return Object.freeze({init, t, numberLocale});
})();
