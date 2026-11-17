// Xtractor Content Detector - Runs in ISOLATED extension context
// Captures accurate video titles, provides authenticated page proxy fetches, and records smooth video streams.

(function () {
  if (window.__XTRACTOR_DETECTOR_INITIALIZED__) return;
  window.__XTRACTOR_DETECTOR_INITIALIZED__ = true;

  const reportedUrls = new Set();
  let activeMediaRecorder = null;
  let recordedChunks = [];

  // Clean title for display & filesystem saving
  function sanitizeTitle(str) {
    if (!str) return '';
    let s = str.trim();
    // Strip common site suffixes and branding
    s = s.replace(/\s*[-|–—•:]\s*(YouTube|Vimeo|Dailymotion|Twitter|X|Facebook|TikTok|Twitch|Netflix|Hulu|Disney\+|Prime Video|Watch Online|Free Full|HD|1080p|720p|Official Video|Official Music Video|Video Player|Streaming|Movie|Full Movie|Apna College|ApnaCollege|Sigma 6\.0|Sigma 5\.0|Sigma 4\.0|Sigma|Coursera|Udemy|Physics Wallah|PW|Unacademy|GeeksforGeeks|GFG|Khan Academy|Classplus|Graphy|Teachable).*$/i, '');
    s = s.replace(/^(Watch|Playing|Video|Lecture|Lesson)\s*[-|–—•:]\s*/i, '');
    s = s.replace(/^Watch\s+/i, '');
    s = s.replace(/\s+Online\s*(Free)?$/i, '');
    // Remove invalid filesystem characters
    s = s.replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '_').trim();
    s = s.replace(/_+/g, '_').replace(/\.+$/, '');
    return s.slice(0, 100) || '';
  }

  function isGenericTitle(str) {
    if (!str) return true;
    const s = str.trim().toLowerCase();
    const genericWords = [
      'video', 'media', 'audio', 'player', 'video player', 'video_player',
      'interactive video', 'interactive video player', 'interactive content', 'interactive_video',
      'h5p', 'h5p interactive video', 'html5 video player', 'embedded video',
      'embed', 'home', 'untitled', 'document', 'index', 'master', 'playlist',
      'manifest', 'chunklist', 'stream', 'chunks', 'segment', 'output', 'variant',
      'apna college', 'apnacollege', 'sigma', 'sigma 6.0', 'sigma 5.0', 'sigma 4.0',
      'course', 'lecture', 'lesson', 'chapter', 'download', 'preview', 'playback',
      'watch video', 'watch'
    ];
    if (genericWords.includes(s)) return true;
    if (/^video[_-]?\d*$/i.test(s) || /^media[_-]?\d*$/i.test(s) || /^blob:/i.test(s)) return true;
    if (/^interactive[\s_-]*video/i.test(s)) return true;
    if (/^h5p[\s_-]*/i.test(s)) return true;
    if (/^(master|index|playlist|manifest|chunklist|stream|chunks|segment|output|variant)$/i.test(s)) return true;
    if (/^[0-9a-f_-]{6,}$/i.test(s) || /^\d+$/.test(s)) return true;
    if (s.includes('_mp4_h264_') || s.includes('_hls_') || s.includes('chunk_')) return true;
    return false;
  }

  // Extract the true human-readable video title from the page DOM
  function getBestVideoTitle(videoEl) {
    // 1. Check Course / LMS active lesson in sidebar, accordion, or playlist (Apna College, Coursera, Udemy, etc.)
    const activeLessonSelectors = [
      '[class*="active"] [class*="lesson"]',
      '[class*="active"] [class*="title"]',
      '[class*="active"] [class*="name"]',
      '[class*="selected"] [class*="title"]',
      '[class*="current"] [class*="title"]',
      '[class*="playing"] [class*="title"]',
      '.lesson-item.active', '.video-item.active', '.curriculum-item.active',
      '.sidebar-item.active', '.chapter-item.active',
      '[aria-current="true"]', '[aria-selected="true"]',
      '.lecture-title', '.lesson-title', '.video-title-text', '.topic-title',
      '.course-lesson-title', '.lesson-name', '.lecture-name'
    ];
    for (const sel of activeLessonSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = el.innerText?.trim();
          if (text && text.length >= 3 && text.length <= 150 && !isGenericTitle(text)) {
            return sanitizeTitle(text);
          }
        }
      } catch (_) {}
    }

    // 2. Modern video site heading selectors
    const titleSelectors = [
      'h1.title', 'h1.video-title', 'h1.lesson-title', '.video-info h1',
      '[data-testid="video-title"]', '[data-testid="lesson-title"]',
      '.video-title', '#video-title', '.film-name', '.anime-title', '.entry-title',
      '.media-title', '.player-title', 'h1', 'h2.title', 'h2.video-title'
    ];
    for (const sel of titleSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText) {
          const text = el.innerText.trim();
          if (text.length >= 3 && text.length <= 150 && !isGenericTitle(text)) {
            return sanitizeTitle(text);
          }
        }
      } catch (_) {}
    }

    // 3. OpenGraph metadata (og:title is the cleanest, most accurate video title on 95% of video sites!)
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle && ogTitle.trim() && !isGenericTitle(ogTitle)) {
      return sanitizeTitle(ogTitle);
    }

    const twTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute('content');
    if (twTitle && twTitle.trim() && !isGenericTitle(twTitle)) {
      return sanitizeTitle(twTitle);
    }

    const nameTitle = document.querySelector('meta[name="title"]')?.getAttribute('content');
    if (nameTitle && nameTitle.trim() && !isGenericTitle(nameTitle)) {
      return sanitizeTitle(nameTitle);
    }

    // 4. Document title
    if (document.title && document.title.trim()) {
      const cleanedDocTitle = sanitizeTitle(document.title);
      if (cleanedDocTitle && !isGenericTitle(cleanedDocTitle)) {
        return cleanedDocTitle;
      }
    }

    // 5. Direct video element attributes (last resort, strictly guarded against generic player titles)
    if (videoEl) {
      const elTitle = videoEl.getAttribute('title') || videoEl.getAttribute('aria-label');
      if (elTitle && elTitle.trim().length > 2 && !isGenericTitle(elTitle)) {
        return sanitizeTitle(elTitle);
      }
    }

    // 6. If in an iframe, return empty string so top frame or URL resolves it
    return '';
  }

  function sendMediaToBackground(mediaObj) {
    if (!mediaObj.url) return;
    if (reportedUrls.has(mediaObj.url)) return;
    reportedUrls.add(mediaObj.url);

    // If title is missing or generic, try to get the best title
    if (!mediaObj.title || isGenericTitle(mediaObj.title)) {
      mediaObj.title = getBestVideoTitle(null);
    }
    reportedUrls.add(mediaObj.url);

    try {
      chrome.runtime.sendMessage({
        type: 'MEDIA_DETECTED',
        media: mediaObj
      });
    } catch (e) {
      // Extension context invalidated
    }
  }

  // Listen for events fired by the MAIN world interceptor
  window.addEventListener('__xtractor_media_event__', (event) => {
    const detail = event.detail;
    if (detail && detail.url) {
      sendMediaToBackground({
        url: detail.url,
        title: getBestVideoTitle(null),
        source: detail.source || 'fetch'
      });
    }
  });

  // Scan all media elements in the DOM
  function scanMediaElements() {
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      const src = video.currentSrc || video.src;
      let res = null;
      if (video.videoWidth && video.videoHeight) {
        res = `${video.videoWidth}x${video.videoHeight}`;
      }

      const videoTitle = getBestVideoTitle(video);

      if (src && !src.startsWith('data:')) {
        if (src.startsWith('blob:')) {
          sendMediaToBackground({
            url: src,
            title: videoTitle,
            source: 'dom_blob_video',
            format: 'BLOB',
            category: 'video',
            resolution: res,
            isBlobPlayer: true
          });
        } else {
          sendMediaToBackground({
            url: src,
            title: videoTitle,
            source: 'dom_video',
            resolution: res
          });
        }
      }

      const sources = video.querySelectorAll('source');
      sources.forEach((source) => {
        const sSrc = source.src;
        if (sSrc && !sSrc.startsWith('blob:') && !sSrc.startsWith('data:')) {
          sendMediaToBackground({
            url: sSrc,
            title: videoTitle,
            source: 'dom_source',
            mimeType: source.type || ''
          });
        }
      });
    });

    const audios = document.querySelectorAll('audio');
    audios.forEach((audio) => {
      const src = audio.currentSrc || audio.src;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        sendMediaToBackground({
          url: src,
          title: getBestVideoTitle(audio),
          source: 'dom_audio',
          category: 'audio'
        });
      }
    });

    const mediaLinks = document.querySelectorAll('a[href$=".mp4"], a[href$=".m3u8"], a[href$=".webm"], a[href$=".mp3"]');
    mediaLinks.forEach((a) => {
      if (a.href) {
        sendMediaToBackground({
          url: a.href,
          title: a.innerText?.trim() || a.getAttribute('download') || getBestVideoTitle(null),
          source: 'dom_link'
        });
      }
    });
  }

  scanMediaElements();

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.querySelector?.('video, audio')) {
              shouldScan = true;
              break;
            }
          }
        }
      } else if (mutation.type === 'attributes' && (mutation.attributeName === 'src' || mutation.attributeName === 'currentSrc')) {
        shouldScan = true;
      }
      if (shouldScan) break;
    }

    if (shouldScan) {
      scanMediaElements();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc']
  });

  // Proxy Fetch in Page Context (bypasses CORS & includes page cookies/tokens)
  async function proxyFetchText(url) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      return { success: true, text };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Proxy Fetch Binary Buffer in Page Context (for protected segments & keys)
  // Uses native FileReader to serialize to base64, eliminating IPC payload memory bottlenecks
  async function proxyFetchBuffer(url) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result;
          if (typeof res === 'string') {
            const base64 = res.split(',')[1] || '';
            resolve({ success: true, base64 });
          } else {
            resolve({ success: false, error: 'Read failed' });
          }
        };
        reader.onerror = () => resolve({ success: false, error: 'FileReader error' });
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Client-Side Authenticated Blob Downloader
  async function downloadViaPageFetch(url, filename) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);

      const cleanFilename = sanitizeTitle(filename || 'video') + '.mp4';
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = cleanFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Smooth Hardware-Accelerated Video Capture
  function capturePlayingVideo(filename) {
    const video = document.querySelector('video');
    if (!video) return { success: false, error: 'No video player found on page' };

    try {
      const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      if (!stream) return { success: false, error: 'Could not capture stream' };

      recordedChunks = [];
      const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp9,opus';
      activeMediaRecorder = new MediaRecorder(stream, { mimeType: mime });

      activeMediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      activeMediaRecorder.onstop = () => {
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const cleanName = sanitizeTitle(filename || 'Captured_Video') + '.' + ext;
        const blob = new Blob(recordedChunks, { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = cleanName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
      };

      activeMediaRecorder.start(1000);
      return { success: true, recording: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function stopCapturing() {
    if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
      activeMediaRecorder.stop();
      activeMediaRecorder = null;
      return { success: true, stopped: true };
    }
    return { success: false, error: 'No active recording' };
  }

  // Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCAN_PAGE_NOW') {
      scanMediaElements();
      sendResponse({ success: true, count: reportedUrls.size });
    } else if (message.type === 'GET_PAGE_TITLE') {
      const video = document.querySelector('video');
      const title = getBestVideoTitle(video);
      sendResponse({ success: true, title });
    } else if (message.type === 'PAGE_PROXY_FETCH') {
      proxyFetchText(message.url).then(sendResponse);
      return true;
    } else if (message.type === 'PAGE_PROXY_FETCH_BLOB') {
      proxyFetchBuffer(message.url).then(sendResponse);
      return true;
    } else if (message.type === 'PAGE_FETCH_DOWNLOAD') {
      downloadViaPageFetch(message.url, message.filename).then(sendResponse);
      return true;
    } else if (message.type === 'START_VIDEO_CAPTURE') {
      const res = capturePlayingVideo(message.filename);
      sendResponse(res);
    } else if (message.type === 'STOP_VIDEO_CAPTURE') {
      const res = stopCapturing();
      sendResponse(res);
    }
  });
})();
