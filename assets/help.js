'use strict';
// Standalone help pages do not load app.js, so initialize their own locale UI.
window.J2ME_I18N.init().then(() => {
  // The downloader's English HTML remains available if a translation fails.
  if (window.J2ME_DownloaderGuide)
    return window.J2ME_DownloaderGuide.translate(document.documentElement.lang);
}).catch(error => console.warn('Help page localization unavailable:', error));
