'use strict';
// Standalone help pages do not load app.js, so initialize their own locale UI.
window.J2ME_I18N.init().catch(error => console.warn('Help page localization unavailable:', error));
