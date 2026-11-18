'use strict';
// The English guide is maintained as HTML generated from docs/DOWNLOADER.md.
// Locales translate prose only. The original DOM supplies command/code/link nodes;
// numbered placeholders are reordered around them, never interpreted as HTML.
window.J2ME_DownloaderGuide = (() => {
  const REVISION = '20261118-guide-v1';
  const script = document.currentScript;
  const localeRoot = script?.src
    ? script.src.replace(/downloader-guide\.js(?:\?.*)?$/, 'guide-locales/')
    : '../assets/guide-locales/';
  const slotPattern = /\{([0-9]+)\}/g;

  async function translate(language) {
    const guide = document.querySelector('.guide-document');
    if (!guide || language === 'en') return;
    try {
      // The language code comes from the validated catalog, not an arbitrary URL.
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(language))
        throw new Error('Invalid language code');
      const response = await fetch(`${localeRoot}${language}.json?v=${REVISION}`, {cache: 'no-cache'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const messages = await response.json();
      const elements = [...guide.querySelectorAll('[data-guide-key]')];
      const expectedKeys = elements.map(element => element.dataset.guideKey);
      if (!messages || Array.isArray(messages) || typeof messages !== 'object' ||
          Object.keys(messages).length !== expectedKeys.length ||
          expectedKeys.some(key => !Object.hasOwn(messages, key)))
        throw new Error('Incomplete downloader guide translation');

      // Validate the entire translation before modifying any of the page.
      const compiled = elements.map(element => {
        const key = element.dataset.guideKey;
        const source = messages[key];
        if (typeof source !== 'string' || !source.trim() || /[<>]/.test(source))
          throw new Error(`Invalid text in ${key}`);
        const children = [...element.children];
        const pieces = [];
        let last = 0;
        for (const match of source.matchAll(slotPattern)) {
          const number = Number(match[1]);
          if (!Number.isSafeInteger(number) || number >= children.length)
            throw new Error(`Invalid placeholder in ${key}`);
          pieces.push(source.slice(last, match.index), children[number]);
          last = match.index + match[0].length;
        }
        pieces.push(source.slice(last));
        const actual = [...source.matchAll(slotPattern)].map(match => Number(match[1]));
        if (new Set(actual).size !== children.length ||
            actual.length !== children.length ||
            !children.every((_, index) => actual.includes(index)))
          throw new Error(`Missing or repeated placeholder in ${key}`);
        return {element, pieces};
      });
      // Inner text first. A parent's preserved child then already has its translation.
      for (const {element, pieces} of compiled.reverse()) {
        element.replaceChildren(...pieces);
      }
      guide.lang = language;
    } catch (error) {
      // Keep the complete, functional English guide instead of showing fragments.
      console.warn('Downloader guide translation unavailable; using English:', error);
    }
  }

  return Object.freeze({translate});
})();
