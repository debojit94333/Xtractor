// Xtractor Interceptor - Runs in MAIN world (page context)
// Intercepts window.fetch and XMLHttpRequest to catch media streams and playlists,
// while actively filtering out micro-chunks and fragments.

(function () {
  if (window.__XTRACTOR_INTERCEPTOR_INITIALIZED__) return;
  window.__XTRACTOR_INTERCEPTOR_INITIALIZED__ = true;

  const MEDIA_EXT_REGEX = /\.(m3u8|mpd|mp4|webm|mkv|mov|flv|m4a|aac|mp3|wav|ogg)(\?.*)?$/i;
  const STREAM_KEYWORDS = ['m3u8', 'manifest', 'playlist.m3u8', 'master.m3u8', '.mpd'];

  function isChunk(url) {
    const l = url.toLowerCase();
    if (l.includes('.m4s') || l.includes('.f4s')) return true;
    if (l.includes('/frag(') || l.includes('/segment') || l.includes('seg-') || l.includes('chunk_')) return true;
    if (l.includes('sq=') || l.includes('frag=') || l.includes('chunk=') || l.includes('part=')) return true;
    return false;
  }

  function notifyMedia(url, source) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;

    // Filter out micro-chunks
    if (isChunk(url)) return;

    // Check if matches extension or stream keyword
    const isMedia = MEDIA_EXT_REGEX.test(url) || STREAM_KEYWORDS.some(k => url.toLowerCase().includes(k));
    if (!isMedia) return;

    window.dispatchEvent(new CustomEvent('__xtractor_media_event__', {
      detail: {
        url: url.startsWith('//') ? window.location.protocol + url : url,
        source: source || 'fetch',
        pageTitle: document.title || ''
      }
    }));
  }

  // 1. Intercept window.fetch
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (...args) {
      const input = args[0];
      let url = '';
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input.url === 'string') {
        url = input.url;
      }

      if (url) {
        notifyMedia(url, 'fetch');
      }

      return originalFetch.apply(this, args);
    };
  }

  // 2. Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  if (originalOpen) {
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (url && typeof url === 'string') {
        notifyMedia(url, 'xhr');
      }
      return originalOpen.apply(this, [method, url, ...rest]);
    };
  }
})();
