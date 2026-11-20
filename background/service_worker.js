// Xtractor Service Worker (Manifest V3) - Video-Focused Architecture
// Focuses strictly on detecting full playable videos with accurate titles and fail-proof downloads.

const tabMediaMap = new Map();
const knownUrlsPerTab = new Map();
const pendingBlobDownloads = new Map();

// Guarantee that downloads retain their exact human-readable titles
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // 1. Check registered blob downloads from Xtractor popup / downloader
    if (pendingBlobDownloads.has(item.url)) {
      const customName = pendingBlobDownloads.get(item.url);
      pendingBlobDownloads.delete(item.url);
      suggest({ filename: customName, conflictAction: 'uniquify' });
      return true;
    }

    // 2. Prevent Chrome from saving blob downloads as random UUIDs
    if (item.url && item.url.startsWith('blob:')) {
      if (item.filename && !/^[0-9a-f-]{30,}\.mp4$/i.test(item.filename)) {
        suggest({ filename: item.filename, conflictAction: 'uniquify' });
        return true;
      }
    }

    // 3. Downloads triggered by Xtractor
    if (item.byExtensionId === chrome.runtime.id && item.filename) {
      suggest({ filename: item.filename, conflictAction: 'uniquify' });
      return true;
    }

    suggest();
  });
}

// Default settings
let userSettings = {
  minVideoSizeKb: 100, // Filter out ad beacons, clicks, and icons
  detectAudio: true,
  downloadSubfolder: '', // Default to root Downloads to avoid path creation errors
  maxHlsConnections: 6
};

// Load saved settings
chrome.storage.local.get(['xtractorSettings'], (result) => {
  if (result.xtractorSettings) {
    userSettings = { ...userSettings, ...result.xtractorSettings };
  }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.xtractorSettings) {
    userSettings = { ...userSettings, ...changes.xtractorSettings.newValue };
  }
});

// Normalize URL for deduplication
function getNormalizedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const dropParams = [
      'range', 'start', 'end', 'offset', 'bytes', 'bytestart', 'byteend',
      'ts', 't', '_', 'cb', 'sq', 'seg', 'segment', 'part', 'frag', 'rn'
    ];
    dropParams.forEach(p => parsed.searchParams.delete(p));
    return parsed.origin + parsed.pathname;
  } catch (e) {
    return urlStr;
  }
}

// Clean range queries so downloading downloads the full video
function getCleanDownloadUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const rangeParams = ['range', 'start', 'end', 'offset', 'bytes', 'bytestart', 'byteend'];
    rangeParams.forEach(p => parsed.searchParams.delete(p));
    return parsed.href;
  } catch (e) {
    return urlStr;
  }
}

// Format bytes
function formatBytes(bytes) {
  if (!bytes || bytes <= 50000) return 'Full Video (HD)'; // Never show raw bytes for videos or playlists
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

// Clean filename for Windows / OS safety
function sanitizeFilename(name) {
  if (!name) return 'video';
  let clean = name.trim();
  clean = clean.replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '_').trim();
  clean = clean.replace(/_+/g, '_').replace(/\.+$/, '');
  return clean.slice(0, 100) || 'video';
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

// Extract human-readable Title: prioritize actual page & video title
function extractTitle(urlStr, headerTitle, pageTitle) {
  // 1. If pageTitle is provided and valid, prioritize it!
  if (pageTitle && pageTitle.trim()) {
    let clean = pageTitle.trim().replace(/\s*[-|–—•:]\s*(YouTube|Vimeo|Dailymotion|Twitter|X|Facebook|TikTok|Twitch|Netflix|Hulu|Disney\+|Prime Video|Watch Online|Free Full|HD|1080p|720p|Official Video|Official Music Video|Video Player|Streaming|Movie|Full Movie|Apna College|ApnaCollege|Sigma 6\.0|Sigma 5\.0|Sigma 4\.0|Sigma|Coursera|Udemy|Physics Wallah|PW|Unacademy|GeeksforGeeks|GFG|Khan Academy|Classplus|Graphy|Teachable).*$/i, '').trim();
    clean = clean.replace(/^(Watch|Playing|Video|Lecture|Lesson)\s*[-|–—•:]\s*/i, '');
    clean = clean.replace(/^Watch\s+/i, '').replace(/\s+Online\s*(Free)?$/i, '').trim();
    clean = sanitizeFilename(clean);
    if (clean.length > 2 && !isGenericTitle(clean)) {
      return clean;
    }
  }

  // 2. Content-Disposition header
  if (headerTitle && headerTitle.trim()) {
    const cleanHeader = sanitizeFilename(headerTitle);
    if (!isGenericTitle(cleanHeader)) return cleanHeader;
  }

  // 3. Last URL segment (only if clean and not numbers/hashes)
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';
    if (lastSeg && /\.[a-z0-9]{2,5}$/i.test(lastSeg)) {
      const decoded = decodeURIComponent(lastSeg).replace(/\.[a-z0-9]{2,5}$/i, '');
      const cleanSlug = decoded.replace(/[_-]+/g, ' ').trim();
      if (cleanSlug.length > 2 && !isGenericTitle(cleanSlug)) {
        return sanitizeFilename(cleanSlug);
      }
    }
  } catch (e) {}

  if (pageTitle && pageTitle.trim()) {
    const clean = sanitizeFilename(pageTitle);
    if (!isGenericTitle(clean)) return clean;
  }

  return 'Video';
}

// Filter out sub-chunks (prevents the 20+ file spam)
function isSubSegment(urlStr, contentType, contentLength) {
  const lUrl = urlStr.toLowerCase();
  const lMime = contentType.toLowerCase();

  if (lUrl.includes('.m4s') || lUrl.includes('.f4s') || lUrl.includes('.mp4s')) return true;

  if (
    lUrl.includes('/frag(') ||
    lUrl.includes('/fragment') ||
    lUrl.includes('/segment') ||
    lUrl.includes('/chunks/') ||
    lUrl.includes('/sq/') ||
    lUrl.includes('seg-') ||
    lUrl.includes('frag-') ||
    lUrl.includes('chunk_')
  ) return true;

  const queryPatterns = ['sq=', 'seg=', 'segment=', 'frag=', 'chunk=', 'part=', 'byterange='];
  if (queryPatterns.some(p => lUrl.includes(p))) return true;

  if (lUrl.includes('.ts') && contentLength < 5 * 1024 * 1024) return true;
  if (lMime.includes('iso.segment') || lMime.includes('mp4a-latm')) return true;

  return false;
}

// Inspect media
function inspectMedia(urlStr, contentType = '', contentLength = 0) {
  const lowerUrl = urlStr.toLowerCase();
  const lowerMime = contentType.toLowerCase();

  // Exclude tracking & ads
  if (
    lowerUrl.includes('google-analytics.com') ||
    lowerUrl.includes('doubleclick.net') ||
    lowerUrl.includes('/ads/') ||
    lowerUrl.includes('/analytics/') ||
    lowerUrl.includes('facebook.com/tr')
  ) {
    return null;
  }

  if (isSubSegment(urlStr, contentType, contentLength)) {
    return null;
  }

  // Adaptive Video Streams (HLS)
  if (
    lowerUrl.includes('.m3u8') ||
    lowerMime.includes('application/x-mpegurl') ||
    lowerMime.includes('application/vnd.apple.mpegurl') ||
    lowerMime.includes('audio/x-mpegurl')
  ) {
    return {
      format: 'HD VIDEO',
      category: 'video',
      isHls: true,
      mimeType: 'application/vnd.apple.mpegurl',
      ext: 'mp4'
    };
  }

  if (lowerUrl.includes('.mpd') || lowerMime.includes('application/dash+xml')) {
    return {
      format: 'DASH VIDEO',
      category: 'video',
      isHls: false,
      mimeType: 'application/dash+xml',
      ext: 'mp4'
    };
  }

  // Direct Video Formats
  if (lowerUrl.includes('.mp4') || lowerMime.includes('video/mp4')) {
    return { format: 'MP4', category: 'video', mimeType: contentType || 'video/mp4', ext: 'mp4' };
  }
  if (lowerUrl.includes('.webm') || lowerMime.includes('video/webm')) {
    return { format: 'WEBM', category: 'video', mimeType: contentType || 'video/webm', ext: 'webm' };
  }
  if (lowerUrl.includes('.mkv') || lowerMime.includes('video/x-matroska')) {
    return { format: 'MKV', category: 'video', mimeType: contentType || 'video/x-matroska', ext: 'mkv' };
  }
  if (lowerUrl.includes('.mov') || lowerMime.includes('video/quicktime')) {
    return { format: 'MOV', category: 'video', mimeType: contentType || 'video/quicktime', ext: 'mov' };
  }
  if (lowerUrl.includes('.flv') || lowerMime.includes('video/x-flv')) {
    return { format: 'FLV', category: 'video', mimeType: contentType || 'video/x-flv', ext: 'flv' };
  }
  if (lowerMime.startsWith('video/')) {
    const sub = lowerMime.split('/')[1]?.split(';')[0] || 'mp4';
    return { format: sub.toUpperCase(), category: 'video', mimeType: contentType, ext: sub };
  }

  // Audio Formats
  if (userSettings.detectAudio) {
    if (lowerUrl.includes('.mp3') || lowerMime.includes('audio/mpeg') || lowerMime.includes('audio/mp3')) {
      return { format: 'MP3', category: 'audio', mimeType: contentType || 'audio/mpeg', ext: 'mp3' };
    }
    if (lowerUrl.includes('.wav') || lowerMime.includes('audio/wav')) {
      return { format: 'WAV', category: 'audio', mimeType: contentType || 'audio/wav', ext: 'wav' };
    }
    if (lowerUrl.includes('.m4a') || lowerMime.includes('audio/mp4') || lowerMime.includes('audio/x-m4a')) {
      return { format: 'M4A', category: 'audio', mimeType: contentType || 'audio/mp4', ext: 'm4a' };
    }
    if (lowerUrl.includes('.aac') || lowerMime.includes('audio/aac')) {
      return { format: 'AAC', category: 'audio', mimeType: contentType || 'audio/aac', ext: 'aac' };
    }
    if (lowerUrl.includes('.ogg') || lowerMime.includes('audio/ogg')) {
      return { format: 'OGG', category: 'audio', mimeType: contentType || 'audio/ogg', ext: 'ogg' };
    }
    if (lowerMime.startsWith('audio/')) {
      const sub = lowerMime.split('/')[1]?.split(';')[0] || 'mp3';
      return { format: sub.toUpperCase(), category: 'audio', mimeType: contentType, ext: sub };
    }
  }

  return null;
}

// Register media with deduplication
function registerMedia(tabId, item) {
  if (!tabId || tabId <= 0) return;

  if (!tabMediaMap.has(tabId)) {
    tabMediaMap.set(tabId, []);
    knownUrlsPerTab.set(tabId, new Set());
  }

  const list = tabMediaMap.get(tabId);
  const known = knownUrlsPerTab.get(tabId);
  const cleanUrl = getNormalizedUrl(item.url);

  const existingIndex = list.findIndex(m => m.cleanUrl === cleanUrl);

  if (existingIndex >= 0) {
    const existing = list[existingIndex];
    if (item.size > existing.size) {
      existing.size = item.size;
      existing.sizeFormatted = formatBytes(item.size);
    }
    if (item.resolution && !existing.resolution) existing.resolution = item.resolution;
    if (item.title && !item.title.startsWith('Video_') && existing.title.startsWith('Video_')) {
      existing.title = item.title;
    }
    return;
  }

  if (!item.isHls && item.size > 0 && item.size < userSettings.minVideoSizeKb * 1024) {
    return;
  }

  // Deduplicate: If an HLS stream is detected, remove any duplicate generic blob player entries
  if (item.isHls) {
    const blobIdx = list.findIndex(m => m.isBlobPlayer || m.url.startsWith('blob:'));
    if (blobIdx >= 0) {
      list.splice(blobIdx, 1);
    }
    // If master.m3u8 arrives, replace any child variant of the same stream
    if (item.url.includes('master') || item.url.includes('manifest')) {
      const masterBase = item.url.split('?')[0].replace(/master[^/]*\.m3u8$/i, '');
      if (masterBase) {
        const childIdx = list.findIndex(m => m.isHls && m.url.startsWith(masterBase));
        if (childIdx >= 0) list.splice(childIdx, 1);
      }
    } else {
      // If a master playlist is already in list covering this child playlist, don't duplicate
      const hasMaster = list.some(m => m.isHls && (m.url.includes('master') || m.url.includes('manifest')) && item.url.startsWith(m.url.split('?')[0].replace(/master[^/]*\.m3u8$/i, '')));
      if (hasMaster) return;
    }
  } else if ((item.isBlobPlayer || item.url.startsWith('blob:')) && list.some(m => m.isHls)) {
    return; // Don't add blob duplicate when genuine HLS stream is already captured
  }

  known.add(cleanUrl);
  list.unshift(item);

  updateTabBadge(tabId);
}

// Update Badge
function updateTabBadge(tabId) {
  const items = tabMediaMap.get(tabId) || [];
  const count = items.length;
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';

  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4F46E5' });
}

// Network Listener (Passive webRequest)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    if (details.statusCode && details.statusCode !== 200 && details.statusCode !== 206) return;

    let contentType = '';
    let contentLength = 0;
    let contentRange = '';
    let contentDisposition = '';

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'content-type') contentType = h.value || '';
        if (name === 'content-length') contentLength = parseInt(h.value || '0', 10);
        if (name === 'content-range') contentRange = h.value || '';
        if (name === 'content-disposition') contentDisposition = h.value || '';
      }
    }

    let trueTotalSize = contentLength;
    if (contentRange) {
      const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
      if (match) {
        const start = parseInt(match[1], 10);
        const total = match[3] !== '*' ? parseInt(match[3], 10) : 0;
        if (total > 0) trueTotalSize = total;

        if (start > 0) {
          const list = tabMediaMap.get(details.tabId);
          if (list) {
            const cleanUrl = getNormalizedUrl(details.url);
            const existing = list.find(m => m.cleanUrl === cleanUrl);
            if (existing && total > existing.size) {
              existing.size = total;
              existing.sizeFormatted = formatBytes(total);
            }
          }
          return;
        }
      }
    }

    const mediaInfo = inspectMedia(details.url, contentType, trueTotalSize);
    if (!mediaInfo) return;

    let filenameFromHeader = '';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename\*?=['"]?(?:UTF-8'')?([^'";\r\n]+)['"]?/i);
      if (match && match[1]) {
        filenameFromHeader = decodeURIComponent(match[1]);
      }
    }

    chrome.tabs.get(details.tabId, (tab) => {
      const pageTitle = (tab && tab.title) ? tab.title : '';
      const pageUrl = (tab && tab.url) ? tab.url : '';
      const title = extractTitle(details.url, filenameFromHeader, pageTitle);
      const cleanDownloadUrl = getCleanDownloadUrl(details.url);

      const isHls = Boolean(mediaInfo.isHls);
      const displaySize = isHls ? 0 : trueTotalSize;
      const mediaItem = {
        id: 'med_' + Math.random().toString(36).substring(2, 9),
        url: cleanDownloadUrl,
        rawUrl: details.url,
        cleanUrl: getNormalizedUrl(details.url),
        referer: pageUrl,
        title,
        format: mediaInfo.format,
        category: mediaInfo.category,
        isHls,
        mimeType: mediaInfo.mimeType,
        ext: mediaInfo.category === 'audio' ? 'mp3' : 'mp4',
        size: displaySize,
        sizeFormatted: formatBytes(displaySize),
        source: 'network',
        resolution: null,
        tabId: details.tabId,
        timestamp: Date.now()
      };

      registerMedia(details.tabId, mediaItem);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Tab Lifecycle
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabMediaMap.delete(tabId);
    knownUrlsPerTab.delete(tabId);
    updateTabBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  knownUrlsPerTab.delete(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateTabBadge(activeInfo.tabId);
});

// Messages Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : message.tabId;

  switch (message.type) {
    case 'MEDIA_DETECTED': {
      if (message.media && tabId) {
        const item = message.media;
        const mediaInfo = inspectMedia(item.url, item.mimeType || '', item.size || 0);
        if (mediaInfo) {
          const isHls = Boolean(mediaInfo.isHls);
          const displaySize = isHls ? 0 : (item.size || 0);

          let resolvedTitle = (item.title && !isGenericTitle(item.title)) 
            ? sanitizeFilename(item.title) 
            : extractTitle(item.url, '', sender.tab?.title || '');

          const finalItem = {
            id: 'med_' + Math.random().toString(36).substring(2, 9),
            url: getCleanDownloadUrl(item.url),
            rawUrl: item.url,
            cleanUrl: getNormalizedUrl(item.url),
            referer: sender.tab?.url || '',
            title: resolvedTitle,
            format: item.format || mediaInfo.format,
            category: mediaInfo.category,
            isHls,
            mimeType: item.mimeType || mediaInfo.mimeType,
            ext: mediaInfo.category === 'audio' ? 'mp3' : 'mp4',
            size: displaySize,
            sizeFormatted: formatBytes(displaySize),
            source: item.source || 'dom',
            resolution: item.resolution || null,
            tabId,
            timestamp: Date.now()
          };
          registerMedia(tabId, finalItem);
          sendResponse({ success: true });
        }
      }
      break;
    }

    case 'GET_TAB_MEDIA': {
      const targetTabId = message.tabId;
      const mediaList = tabMediaMap.get(targetTabId) || [];
      sendResponse({ media: mediaList });
      break;
    }

    case 'CLEAR_TAB_MEDIA': {
      const targetTabId = message.tabId;
      tabMediaMap.delete(targetTabId);
      knownUrlsPerTab.delete(targetTabId);
      updateTabBadge(targetTabId);
      sendResponse({ success: true });
      break;
    }

    case 'REGISTER_BLOB_DOWNLOAD': {
      if (message.url && message.filename) {
        pendingBlobDownloads.set(message.url, message.filename);
        setTimeout(() => pendingBlobDownloads.delete(message.url), 120000);
      }
      sendResponse({ success: true });
      break;
    }

    // Direct Download - Safe and clean (NO forbidden headers like Origin/Referer in chrome.downloads)
    case 'TRIGGER_DOWNLOAD': {
      const { url, filename, category } = message;
      const ext = category === 'audio' ? 'mp3' : 'mp4';
      const safeFilename = sanitizeFilename(filename || 'video') + '.' + ext;

      chrome.downloads.download({
        url,
        filename: safeFilename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('chrome.downloads error:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
      return true;
    }

    default:
      break;
  }
});
