// UI translations only. Archive filenames, metadata, and search data remain unchanged.
'use strict';
window.J2ME_I18N = (() => {
  const codes = ['en', 'de', 'es', 'pt-BR', 'ru', 'id', 'zh-CN'];
  const numberLocales = {
    en: 'en-US', de: 'de-DE', es: 'es-ES', 'pt-BR': 'pt-BR',
    ru: 'ru-RU', id: 'id-ID', 'zh-CN': 'zh-CN'
  };
  const urlLanguage = new URLSearchParams(location.search).get('lang');
  let language = 'en';
  try {
    const saved = localStorage.getItem('j2me-archive-language');
    language = urlLanguage !== null ? (codes.includes(urlLanguage) ? urlLanguage : 'en') : (codes.includes(saved) ? saved : 'en');
  } catch {
    language = codes.includes(urlLanguage) ? urlLanguage : 'en';
  }
  let english = {};
  let chosen = {};

  async function load(code) {
    const response = await fetch(`assets/locales/${code}.json`);
    if (!response.ok) throw new Error(`Translation ${code}: HTTP ${response.status}`);
    return response.json();
  }

  function t(key, vars = {}) {
    let message = chosen[key] ?? english[key] ?? key;
    if (message && typeof message === 'object') {
      const category = new Intl.PluralRules(numberLocales[language]).select(Number(vars.pluralCount ?? vars.count));
      message = message[category] ?? message.other ?? message.one;
    }
    return String(message).replace(/\{(\w+)\}/g,
      (whole, name) => Object.hasOwn(vars, name) ? String(vars[name]) : whole);
  }

  function translateStatic() {
    document.documentElement.lang = language;
    document.title = t('pageTitle');
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = t('metaDescription');
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

  return Object.freeze({init, t, numberLocale: () => numberLocales[language]});
})();
