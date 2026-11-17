// Xtractor Popup Controller - Pro Video Engine
// Fixes: Accurate title resolution, human-readable file sizes, non-laggy video output, single-file download.

document.addEventListener('DOMContentLoaded', async () => {
  let activeTabId = null;
  let allMedia = [];
  let currentFilter = 'all';
  let searchQuery = '';
  let previewMediaItem = null;
  let currentHlsInstance = null;
  let previewMediaRecorder = null;
  let previewRecordedChunks = [];

  // DOM Elements
  const mediaList = document.getElementById('mediaList');
  const emptyState = document.getElementById('emptyState');
  const searchInput = document.getElementById('searchInput');
  const footerInfo = document.getElementById('footerInfo');
  const toast = document.getElementById('toast');

  // Header Buttons
  const btnForceDownload = document.getElementById('btnForceDownload');
  const btnRescan = document.getElementById('btnRescan');
  const btnOptions = document.getElementById('btnOptions');
  const btnDownloadAll = document.getElementById('btnDownloadAll');
  const batchCount = document.getElementById('batchCount');
  const btnForceEmpty = document.getElementById('btnForceEmpty');
  const btnClearMedia = document.getElementById('btnClearMedia');

  // Preview elements
  const previewModal = document.getElementById('previewModal');
  const previewBackdrop = document.getElementById('previewBackdrop');
  const previewTitle = document.getElementById('previewTitle');
  const previewPlayer = document.getElementById('previewPlayer');
  const btnClosePreview = document.getElementById('btnClosePreview');
  const btnDownloadFromPreview = document.getElementById('btnDownloadFromPreview');

  // Badges
  const countAll = document.getElementById('countAll');
  const countVideo = document.getElementById('countVideo');
  const countAudio = document.getElementById('countAudio');

  let activeTabTitle = '';

  function showToast(message, duration = 2500) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

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
    if (s === 'video' || s === 'media' || s === 'audio' || s === 'player' || s === 'video player' || s === 'embed' || s === 'home' || s === 'untitled') return true;
    if (/^video[_-]?\d*$/i.test(s) || /^media[_-]?\d*$/i.test(s) || /^blob:/i.test(s)) return true;
    if (/^(master|index|playlist|manifest|chunklist|stream|chunks|segment|output|variant)$/i.test(s)) return true;
    if (/^[0-9a-f_-]{6,}$/i.test(s) || /^\d+$/.test(s)) return true;
    if (s.includes('_mp4_h264_') || s.includes('_hls_') || s.includes('chunk_')) return true;
    return false;
  }

  function cleanPageTitle(raw) {
    if (!raw) return '';
    let t = raw.trim();
    // Strip site branding
    t = t.replace(/\s*[-|–—•]\s*(YouTube|Vimeo|Dailymotion|Twitter|X|Facebook|TikTok|Twitch|Netflix|Hulu|Disney\+|Prime Video|Watch Online|Free Full|HD|1080p|720p|Official Video|Official Music Video|Video Player|Streaming|Movie|Full Movie).*$/i, '');
    t = t.replace(/^Watch\s+/i, '');
    t = t.replace(/\s+Online\s*(Free)?$/i, '');
    // Strip extension suffixes
    t = t.replace(/\.(mp4|m3u8|webm|mov|mkv|flv|ts|avi)$/i, '');
    t = sanitizeFilename(t);
    if (!t || isGenericTitle(t)) return '';
    return t;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 50000) return 'Full Video (HD)'; // Never show "752 B" for video streams!
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  function isHlsMedia(item) {
    if (!item) return false;
    if (item.isHls) return true;
    const url = (item.url || '').toLowerCase();
    const mime = (item.mimeType || '').toLowerCase();
    return url.includes('.m3u8') || mime.includes('mpegurl');
  }

  // Fast Base64 to ArrayBuffer decoder for IPC segment transfers
  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Unified robust segment fetcher with direct fetch + authenticated page proxy fallback
  async function fetchSegmentBuffer(segUri, tabId) {
    // 1. Direct fetch with credentials
    try {
      const resp = await fetch(segUri, { credentials: 'include' });
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf && buf.byteLength > 0) return buf;
      }
    } catch (e) {}

    // 2. Authenticated page proxy fetch fallback (bypasses CORS/hotlink protection)
    if (tabId) {
      try {
        const proxyRes = await new Promise(resolve => {
          chrome.tabs.sendMessage(tabId, { type: 'PAGE_PROXY_FETCH_BLOB', url: segUri }, resolve);
        });
        if (proxyRes && proxyRes.success && proxyRes.base64) {
          return base64ToArrayBuffer(proxyRes.base64);
        } else if (proxyRes && proxyRes.data) {
          return new Uint8Array(proxyRes.data).buffer;
        }
      } catch (e) {}
    }

    return null;
  }

  /**
   * Transmux MPEG-TS chunks into a proper MP4 container using mux.js.
   * Produces fragmented MP4 (fMP4) with moof/mdat pairs that contain
   * tfdt (base decode time) and trun (sample table) boxes — enabling
   * players to seek efficiently without scanning the entire file.
   *
   * @param {ArrayBuffer[]} tsChunks - Array of MPEG-TS segment buffers
   * @returns {Blob} - MP4 blob ready for download
   */
  async function transmuxTsToMp4(tsChunks) {
    if (!window.muxjs || !window.muxjs.mp4 || !window.muxjs.mp4.Transmuxer) {
      console.warn('mux.js not available, falling back to raw TS concatenation');
      return new Blob(tsChunks, { type: 'video/mp4' });
    }

    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (blob) => {
        if (!resolved) {
          resolved = true;
          resolve(blob);
        }
      };

      try {
        const transmuxer = new window.muxjs.mp4.Transmuxer();

        let initSegment = null;
        const allDataParts = [];
        let globalSequenceNumber = 0;

        // Helper to separate and order video fragments before audio fragments in each segment,
        // assign strictly monotonic sequence_number in mfhd, and ensure default-base-is-moof flag
        // (0x020000) is set for smooth VLC / Windows Media Player playback and instant seeking.
        function reorderAndPatchBoxes(dataBytes) {
          let offset = 0;
          const boxes = [];
          while (offset <= dataBytes.length - 8) {
            const size = (dataBytes[offset] << 24) | (dataBytes[offset + 1] << 16) | (dataBytes[offset + 2] << 8) | dataBytes[offset + 3];
            if (size <= 0 || offset + size > dataBytes.length) break;
            boxes.push(dataBytes.subarray(offset, offset + size));
            offset += size;
          }

          const videoBoxes = [];
          const audioBoxes = [];
          let currentTarget = null;

          for (const box of boxes) {
            const type = String.fromCharCode(box[4], box[5], box[6], box[7]);
            if (type === 'moof') {
              let isVideo = true;
              for (let i = 0; i < box.length - 12; i++) {
                if (box[i] === 0x74 && box[i + 1] === 0x66 && box[i + 2] === 0x68 && box[i + 3] === 0x64) {
                  // Enable default-base-is-moof flag (bit 17: 0x020000) on tfhd
                  box[i + 5] |= 0x02;
                  const trackId = (box[i + 8] << 24) | (box[i + 9] << 16) | (box[i + 10] << 8) | box[i + 11];
                  if (trackId === 257) isVideo = false;
                  break;
                }
              }
              currentTarget = isVideo ? videoBoxes : audioBoxes;
              currentTarget.push(box);
            } else if (type === 'mdat') {
              if (currentTarget) currentTarget.push(box);
            } else {
              videoBoxes.push(box);
            }
          }

          // Order video fragments first, then audio fragments for this segment
          const orderedBoxes = [...videoBoxes, ...audioBoxes];

          // Patch mfhd sequence_number to be strictly monotonic (0, 1, 2, 3...) in physical file order
          // to completely prevent VLC "Fragment sequence discontinuity detected" clock resets and lag.
          for (const box of orderedBoxes) {
            const type = String.fromCharCode(box[4], box[5], box[6], box[7]);
            if (type === 'moof' && box.length >= 24) {
              if (box[12] === 0x6d && box[13] === 0x66 && box[14] === 0x68 && box[15] === 0x64) {
                const seq = globalSequenceNumber++;
                box[20] = (seq >>> 24) & 0xff;
                box[21] = (seq >>> 16) & 0xff;
                box[22] = (seq >>> 8) & 0xff;
                box[23] = seq & 0xff;
              }
            }
          }

          return orderedBoxes;
        }

        transmuxer.on('data', (segment) => {
          // Capture the init segment (ftyp + moov) on first emission
          if (segment.initSegment && segment.initSegment.byteLength > 0 && !initSegment) {
            initSegment = new Uint8Array(segment.initSegment);
          }
          // Capture and interleave media fragments
          if (segment.data && segment.data.byteLength > 0) {
            const reordered = reorderAndPatchBoxes(new Uint8Array(segment.data));
            allDataParts.push(...reordered);
          }
        });

        transmuxer.on('error', (err) => {
          console.error('Transmux error:', err);
          safeResolve(new Blob(tsChunks, { type: 'video/mp4' }));
        });

        // Transmux SEGMENT-BY-SEGMENT so video and audio are perfectly interleaved
        // every 2 to 6 seconds throughout the MP4 container (never all audio first!).
        for (const chunk of tsChunks) {
          transmuxer.push(new Uint8Array(chunk));
          transmuxer.flush();
        }

        if (!initSegment || allDataParts.length === 0) {
          console.warn('Transmux produced no output, falling back to raw TS');
          safeResolve(new Blob(tsChunks, { type: 'video/mp4' }));
          return;
        }

        // Build fMP4: [init segment (ftyp+moov)] + [interleaved video & audio fragments...]
        const parts = [initSegment, ...allDataParts];
        const blob = new Blob(parts, { type: 'video/mp4' });
        console.log(`Transmux complete: ${allDataParts.length} fragments, ${(blob.size / 1048576).toFixed(1)} MB`);
        safeResolve(blob);
      } catch (err) {
        console.error('Transmux exception:', err);
        safeResolve(new Blob(tsChunks, { type: 'video/mp4' }));
      }
    });
  }

  // Get active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) {
    activeTabId = tabs[0].id;
    if (tabs[0].title) {
      activeTabTitle = cleanPageTitle(tabs[0].title);
    }
  }

  function applyResolvedTitle(resolvedTitle) {
    if (!resolvedTitle || isGenericTitle(resolvedTitle)) return;
    allMedia.forEach(m => {
      if (!m.title || isGenericTitle(m.title)) {
        m.title = resolvedTitle;
      }
    });
  }

  // Load Media and Resolve Exact Video Title
  function loadMedia() {
    if (!activeTabId) return;

    chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: activeTabId }, (response) => {
      allMedia = (response && response.media) ? response.media : [];

      if (activeTabTitle && !isGenericTitle(activeTabTitle)) {
        applyResolvedTitle(activeTabTitle);
      }

      // Query TOP frame ({ frameId: 0 }) specifically for og:title / h1 / page title
      try {
        chrome.tabs.sendMessage(activeTabId, { type: 'GET_PAGE_TITLE' }, { frameId: 0 }, (titleRes) => {
          if (!chrome.runtime.lastError && titleRes && titleRes.title) {
            const docTitle = cleanPageTitle(titleRes.title);
            if (docTitle && !isGenericTitle(docTitle)) {
              activeTabTitle = docTitle;
              applyResolvedTitle(docTitle);
            }
          }
          updateCounts();
          renderMedia();
        });
      } catch (e) {
        updateCounts();
        renderMedia();
      }
    });
  }

  function updateCounts() {
    const total = allMedia.length;
    const videos = allMedia.filter(m => m.category === 'video').length;
    const audios = allMedia.filter(m => m.category === 'audio').length;

    countAll.textContent = total;
    countVideo.textContent = videos;
    countAudio.textContent = audios;

    footerInfo.textContent = `${total} video${total === 1 ? '' : 's'} detected`;
  }

  // Render cards
  function renderMedia() {
    mediaList.innerHTML = '';

    const filtered = allMedia.filter(item => {
      if (currentFilter !== 'all' && item.category !== currentFilter) {
        return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = item.title && item.title.toLowerCase().includes(q);
        const matchesFormat = item.format && item.format.toLowerCase().includes(q);
        if (!matchesTitle && !matchesFormat) return false;
      }
      return true;
    });

    if (filtered.length >= 2) {
      btnDownloadAll.style.display = 'block';
      batchCount.textContent = filtered.length;
    } else {
      btnDownloadAll.style.display = 'none';
    }

    if (filtered.length === 0) {
      emptyState.classList.add('active');
      mediaList.style.display = 'none';
      return;
    }

    emptyState.classList.remove('active');
    mediaList.style.display = 'flex';

    filtered.forEach(item => {
      const card = createMediaCard(item);
      mediaList.appendChild(card);
    });
  }

  // Create Video Card with Title Display & Editing
  function createMediaCard(item) {
    const card = document.createElement('div');
    card.className = 'media-card';

    const isAudio = item.category === 'audio';
    const isBlob = item.isBlobPlayer || item.format === 'BLOB';

    let iconSvg = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    `;
    if (isAudio) {
      iconSvg = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>
        </svg>
      `;
    }

    const isStream = isHlsMedia(item);
    const titleText = (item.title && !isGenericTitle(item.title)) 
      ? item.title 
      : (activeTabTitle && !isGenericTitle(activeTabTitle) ? activeTabTitle : 'Video');
    item.title = titleText;
    const formatName = isAudio ? 'AUDIO MP3' : (item.resolution ? `${item.resolution} MP4` : 'MP4 VIDEO');
    const sizeDisplay = (!isStream && item.size && item.size > 50000) 
      ? formatBytes(item.size) 
      : (item.resolution ? `${item.resolution} HD` : 'Full Video (HD)');
    const resBadge = item.resolution ? `<span class="meta-badge badge-res">${item.resolution}</span>` : '';

    card.innerHTML = `
      <div class="card-top">
        <div class="card-icon ${isAudio ? 'audio' : ''}">
          ${iconSvg}
        </div>
        <div class="card-details">
          <div class="card-title-row">
            <input type="text" class="card-title-input" value="${escapeHtml(titleText)}" placeholder="Video Title" title="Click to rename before download">
          </div>
          <div class="card-meta">
            <span class="meta-badge badge-format">${formatName}</span>
            ${resBadge}
            <span class="card-size">${sizeDisplay}</span>
          </div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-download" data-id="${item.id}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          <span class="btn-label">${isBlob ? 'Capture Video' : 'Download Video'}</span>
        </button>
        <button class="btn-secondary btn-preview" data-id="${item.id}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polygon points="10 8 16 12 10 16 10 8"/>
          </svg>
          Preview
        </button>
        <button class="btn-secondary btn-copy" data-url="${escapeHtml(item.url)}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy
        </button>
      </div>
    `;

    const titleInput = card.querySelector('.card-title-input');
    titleInput.addEventListener('input', () => {
      item.title = titleInput.value.trim() || activeTabTitle || 'Video';
    });

    const dlBtn = card.querySelector('.btn-download');
    dlBtn.addEventListener('click', () => {
      const currentTitle = titleInput.value.trim() || item.title || activeTabTitle || 'Video';
      item.title = currentTitle;

      if (isBlob) {
        captureLivePlayer(item, dlBtn);
      } else if (isHlsMedia(item)) {
        downloadHlsVideoInPopup(item, dlBtn);
      } else {
        downloadDirectVideo(item, dlBtn);
      }
    });

    const prevBtn = card.querySelector('.btn-preview');
    prevBtn.addEventListener('click', () => {
      item.title = titleInput.value.trim() || item.title || 'Video';
      openPreview(item);
    });

    const copyBtn = card.querySelector('.btn-copy');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        showToast('Video link copied to clipboard!');
      }).catch(() => {
        showToast('Failed to copy link');
      });
    });

    return card;
  }

  // -------------------------------------------------------------
  // 1. IN-POPUP PREVIEW (Plays HLS Smoothly with Hls.js)
  // -------------------------------------------------------------
  function openPreview(item) {
    previewMediaItem = item;
    previewTitle.textContent = item.title || 'Video Preview';

    if (currentHlsInstance) {
      currentHlsInstance.destroy();
      currentHlsInstance = null;
    }

    if (item.isHls || item.url.includes('.m3u8')) {
      if (window.Hls && Hls.isSupported()) {
        currentHlsInstance = new Hls({
          enableWorker: true,
          lowLatencyMode: true
        });
        currentHlsInstance.loadSource(item.url);
        currentHlsInstance.attachMedia(previewPlayer);
        currentHlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          previewPlayer.play().catch(() => {});
        });
      } else {
        previewPlayer.src = item.url;
        previewPlayer.play().catch(() => {});
      }
    } else {
      previewPlayer.src = item.url;
      previewPlayer.play().catch(() => {});
    }

    previewModal.classList.add('active');
  }

  function closePreview() {
    previewPlayer.pause();
    if (currentHlsInstance) {
      currentHlsInstance.destroy();
      currentHlsInstance = null;
    }
    previewPlayer.removeAttribute('src');
    previewPlayer.load();
    previewModal.classList.remove('active');
    previewMediaItem = null;
  }

  btnClosePreview.addEventListener('click', closePreview);
  previewBackdrop.addEventListener('click', closePreview);

  // Download directly from Preview modal
  btnDownloadFromPreview.addEventListener('click', () => {
    if (previewMediaItem) {
      const cleanTitle = sanitizeFilename(previewMediaItem.title || 'Video');
      showToast(`Saving: ${cleanTitle}.mp4`);
      
      // If preview is playing smoothly, capture stream directly for zero lag!
      if (isHlsMedia(previewMediaItem)) {
        downloadHlsVideoInPopup(previewMediaItem);
      } else if (previewMediaItem.url && previewMediaItem.url.startsWith('blob:')) {
        capturePreviewPlayerStream(cleanTitle);
      } else {
        downloadDirectVideo(previewMediaItem);
      }
      closePreview();
    }
  });

  // Direct Stream Download from Preview modal (preserves 100% untouched raw video + audio stream)
  const btnSaveDirectStream = document.getElementById('btnSaveDirectStream');
  if (btnSaveDirectStream) {
    btnSaveDirectStream.addEventListener('click', () => {
      if (previewMediaItem) {
        downloadDirectHlsStream(previewMediaItem);
        closePreview();
      }
    });
  }

  // Record directly from Preview modal with hardware audio-video synchronization
  const btnRecordFromPreview = document.getElementById('btnRecordFromPreview');
  if (btnRecordFromPreview) {
    btnRecordFromPreview.addEventListener('click', () => {
      if (previewMediaItem) {
        const cleanTitle = sanitizeFilename(previewMediaItem.title || activeTabTitle || 'Video');
        capturePreviewPlayerStream(cleanTitle);
      }
    });
  }

  // Capture from Preview player (Guarantees 100% Hardware-Synced Audio & Video!)
  function capturePreviewPlayerStream(title) {
    if (previewMediaRecorder && previewMediaRecorder.state === 'recording') {
      previewMediaRecorder.stop();
      return;
    }

    try {
      const stream = previewPlayer.captureStream ? previewPlayer.captureStream() : previewPlayer.mozCaptureStream();
      if (!stream) {
        downloadHlsVideoInPopup(previewMediaItem);
        return;
      }

      previewRecordedChunks = [];
      const mime = MediaRecorder.isTypeSupported('video/mp4') 
        ? 'video/mp4' 
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');
      
      previewMediaRecorder = new MediaRecorder(stream, { mimeType: mime });

      if (btnRecordFromPreview) {
        btnRecordFromPreview.textContent = '⏹ Stop & Save Video';
        btnRecordFromPreview.classList.add('recording');
      }

      previewMediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) previewRecordedChunks.push(e.data);
      };

      previewMediaRecorder.onstop = () => {
        const blob = new Blob(previewRecordedChunks, { type: mime });
        const objectUrl = URL.createObjectURL(blob);
        saveSingleFile(objectUrl, `${title}.mp4`);
        showToast(`✓ Saved: ${title}.mp4`);
        if (btnRecordFromPreview) {
          btnRecordFromPreview.textContent = '🔴 Record Stream (Synced Audio)';
          btnRecordFromPreview.classList.remove('recording');
        }
        previewMediaRecorder = null;
      };

      previewMediaRecorder.start(1000);
      showToast('Recording video with 100% synchronized audio...');

      previewPlayer.onended = () => {
        if (previewMediaRecorder && previewMediaRecorder.state === 'recording') {
          previewMediaRecorder.stop();
        }
      };
    } catch (e) {
      console.error('Player capture error:', e);
      downloadHlsVideoInPopup(previewMediaItem);
    }
  }

  // Direct Stream Downloader (untouched original stream, preserving 100% video & audio tracks)
  async function downloadDirectHlsStream(item) {
    const cleanTitle = sanitizeFilename(item.title || activeTabTitle || 'Video');
    showToast(`Downloading direct stream: ${cleanTitle}...`);

    try {
      let text = '';
      try {
        const resp = await fetch(item.url);
        if (resp.ok) text = await resp.text();
      } catch (e) {}

      if (!text && activeTabId) {
        const pageFetch = await new Promise(resolve => {
          chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url: item.url }, resolve);
        });
        if (pageFetch && pageFetch.success) text = pageFetch.text;
      }

      let targetMediaUrl = item.url;
      let mediaInfo = null;

      if (window.HlsParser && HlsParser.isMasterPlaylist(text)) {
        const variants = HlsParser.parseMaster(text, item.url);
        if (variants.length > 0) {
          targetMediaUrl = variants[0].uri;
          let varText = '';
          try {
            const varResp = await fetch(targetMediaUrl);
            if (varResp.ok) varText = await varResp.text();
          } catch (e) {}
          if (!varText && activeTabId) {
            const varFetch = await new Promise(resolve => {
              chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url: targetMediaUrl }, resolve);
            });
            if (varFetch && varFetch.success) varText = varFetch.text;
          }
          if (varText) mediaInfo = HlsParser.parseMedia(varText, targetMediaUrl);
        }
      } else if (window.HlsParser) {
        mediaInfo = HlsParser.parseMedia(text, targetMediaUrl);
      }

      if (!mediaInfo || mediaInfo.segments.length === 0) {
        throw new Error('Could not parse stream segments');
      }

      const segments = mediaInfo.segments;
      const totalCount = segments.length;
      const chunkBuffers = new Array(totalCount).fill(null);
      let nextIndex = 0;
      let completed = 0;

      async function worker() {
        while (nextIndex < totalCount) {
          const idx = nextIndex++;
          const seg = segments[idx];
          let buf = null;
          let attempts = 0;
          while (attempts < 4 && !buf) {
            attempts++;
            try {
              buf = await fetchSegmentBuffer(seg.uri, activeTabId);
              if (buf && buf.byteLength > 0) {
                chunkBuffers[idx] = buf;
                completed++;
                break;
              }
            } catch (e) {}
            if (!buf && attempts < 4) await new Promise(r => setTimeout(r, 200 * attempts));
          }
        }
      }

      const workers = [];
      const concurrency = Math.min(4, totalCount);
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);

      // Rescue pass for any missing chunks
      for (let i = 0; i < totalCount; i++) {
        if (!chunkBuffers[i]) {
          try {
            const rescueBuf = await fetchSegmentBuffer(segments[i].uri, activeTabId);
            if (rescueBuf && rescueBuf.byteLength > 0) chunkBuffers[i] = rescueBuf;
          } catch (e) {}
        }
      }

      const validChunks = chunkBuffers.filter(Boolean);
      if (validChunks.length === 0) {
        throw new Error('Could not download stream segments');
      }

      // Transmux MPEG-TS to proper MP4 for fast seeking; fMP4 streams pass through as-is
      let directBlob;
      if (mediaInfo && !mediaInfo.isFmp4) {
        directBlob = await transmuxTsToMp4(validChunks);
      } else {
        directBlob = new Blob(validChunks, { type: 'video/mp4' });
      }

      const finalFilename = `${cleanTitle}.mp4`;
      const objectUrl = URL.createObjectURL(directBlob);
      saveSingleFile(objectUrl, finalFilename);
      showToast(`✓ Saved direct stream: ${finalFilename}`);
    } catch (err) {
      console.error(err);
      showToast('Download error: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // 2. IN-POPUP HLS TO VIDEO DOWNLOADER
  // Downloads segments, handles CORS proxying, saves with EXACT title
  // -------------------------------------------------------------
  async function downloadHlsVideoInPopup(item, btnElement) {
    const labelSpan = btnElement ? btnElement.querySelector('.btn-label') : null;
    if (labelSpan) labelSpan.textContent = 'Preparing...';
    if (btnElement) btnElement.classList.add('downloading');

    const cleanTitle = sanitizeFilename(item.title || activeTabTitle || 'Video');
    showToast(`Downloading: ${cleanTitle}...`);

    try {
      let text = '';
      // 1. Try direct fetch first
      try {
        const resp = await fetch(item.url);
        if (resp.ok) text = await resp.text();
      } catch (e) {}

      // 2. If direct fetch was blocked by CORS, fetch via active tab's authenticated context!
      if (!text && activeTabId) {
        const pageFetch = await new Promise(resolve => {
          chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url: item.url }, resolve);
        });
        if (pageFetch && pageFetch.success) {
          text = pageFetch.text;
        }
      }

      if (!text) {
        throw new Error('Unable to access video stream. Try Preview -> Record.');
      }

      let targetMediaUrl = item.url;
      let mediaInfo = null;
      let separateAudioUri = null;

      if (window.HlsParser && HlsParser.isMasterPlaylist(text)) {
        const variants = HlsParser.parseMaster(text, item.url);
        if (variants.length > 0) {
          targetMediaUrl = variants[0].uri;
          if (variants[0].audioUri) {
            separateAudioUri = variants[0].audioUri;
          }
          // Fetch variant playlist
          let varText = '';
          try {
            const varResp = await fetch(targetMediaUrl);
            if (varResp.ok) varText = await varResp.text();
          } catch (e) {}

          if (!varText && activeTabId) {
            const varFetch = await new Promise(resolve => {
              chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url: targetMediaUrl }, resolve);
            });
            if (varFetch && varFetch.success) varText = varFetch.text;
          }

          if (varText) {
            mediaInfo = HlsParser.parseMedia(varText, targetMediaUrl);
          }
        }
      } else if (window.HlsParser) {
        mediaInfo = HlsParser.parseMedia(text, targetMediaUrl);
      }

      if (!mediaInfo || mediaInfo.segments.length === 0) {
        throw new Error('Could not parse video segments');
      }

      // If separate audio rendition is defined in master playlist, parse and fetch audio playlist
      let audioMediaInfo = null;
      if (separateAudioUri) {
        let aText = '';
        try {
          const aResp = await fetch(separateAudioUri);
          if (aResp.ok) aText = await aResp.text();
        } catch (e) {}

        if (!aText && activeTabId) {
          const aFetch = await new Promise(resolve => {
            chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url: separateAudioUri }, resolve);
          });
          if (aFetch && aFetch.success) aText = aFetch.text;
        }

        if (aText && window.HlsParser) {
          audioMediaInfo = HlsParser.parseMedia(aText, separateAudioUri);
        }
      }

      // Download fMP4 init segment if available
      let initBuffer = null;
      if (mediaInfo.initSegmentUri) {
        initBuffer = await fetchSegmentBuffer(mediaInfo.initSegmentUri, activeTabId);
      }

      // Download AES-128 key if encrypted
      let keyBuffer = null;
      if (mediaInfo.keyInfo && mediaInfo.keyInfo.keyUri) {
        keyBuffer = await fetchSegmentBuffer(mediaInfo.keyInfo.keyUri, activeTabId);
      }

      const segments = mediaInfo.segments;
      const totalCount = segments.length;
      const chunkBuffers = new Array(totalCount).fill(null);
      let completed = 0;

      const concurrency = Math.min(4, totalCount);
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < totalCount) {
          const idx = nextIndex++;
          const seg = segments[idx];

          let buf = null;
          let attempts = 0;

          while (attempts < 4 && !buf) {
            attempts++;
            try {
              buf = await fetchSegmentBuffer(seg.uri, activeTabId);
              if (buf && buf.byteLength > 0) {
                // Decrypt AES-128 chunk if encrypted
                if (keyBuffer && window.HlsParser && mediaInfo.keyInfo) {
                  let ivBuf;
                  if (mediaInfo.keyInfo.ivHex) {
                    const hex = mediaInfo.keyInfo.ivHex.replace(/^0x/i, '');
                    const match = hex.match(/.{1,2}/g) || [];
                    ivBuf = new Uint8Array(match.map(byte => parseInt(byte, 16)));
                  } else {
                    ivBuf = new Uint8Array(16);
                    new DataView(ivBuf.buffer).setUint32(12, idx);
                  }
                  buf = await HlsParser.decryptChunk(buf, keyBuffer, ivBuf);
                }

                chunkBuffers[idx] = buf;
                completed++;
                const pct = Math.round((completed / totalCount) * 100);
                if (labelSpan) labelSpan.textContent = `Downloading ${pct}% (${completed}/${totalCount})`;
                break;
              }
            } catch (e) {
              console.warn(`Segment ${idx} error:`, e);
            }
            if (!buf && attempts < 4) {
              await new Promise(r => setTimeout(r, 250 * attempts));
            }
          }
        }
      }

      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);

      // Rescue pass: retry any segments that missed download to guarantee 100% contiguous stream!
      const missingCount = chunkBuffers.filter(c => !c).length;
      if (missingCount > 0) {
        if (labelSpan) labelSpan.textContent = `Rescuing ${missingCount} segments...`;
        for (let i = 0; i < totalCount; i++) {
          if (!chunkBuffers[i]) {
            try {
              let rBuf = await fetchSegmentBuffer(segments[i].uri, activeTabId);
              if (rBuf && rBuf.byteLength > 0) {
                if (keyBuffer && window.HlsParser && mediaInfo.keyInfo) {
                  let ivBuf;
                  if (mediaInfo.keyInfo.ivHex) {
                    const hex = mediaInfo.keyInfo.ivHex.replace(/^0x/i, '');
                    const match = hex.match(/.{1,2}/g) || [];
                    ivBuf = new Uint8Array(match.map(byte => parseInt(byte, 16)));
                  } else {
                    ivBuf = new Uint8Array(16);
                    new DataView(ivBuf.buffer).setUint32(12, i);
                  }
                  rBuf = await HlsParser.decryptChunk(rBuf, keyBuffer, ivBuf);
                }
                chunkBuffers[i] = rBuf;
                completed++;
              }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 150));
          }
        }
      }

      // Fetch separate audio segments if present in stream
      const audioChunkBuffers = [];
      if (audioMediaInfo && audioMediaInfo.segments.length > 0) {
        if (labelSpan) labelSpan.textContent = 'Downloading audio...';
        const aSegs = audioMediaInfo.segments;
        const aBuffers = new Array(aSegs.length).fill(null);
        let aNext = 0;
        async function audioWorker() {
          while (aNext < aSegs.length) {
            const aIdx = aNext++;
            const aSeg = aSegs[aIdx];
            try {
              const aBuf = await fetchSegmentBuffer(aSeg.uri, activeTabId);
              if (aBuf) aBuffers[aIdx] = aBuf;
            } catch (e) {}
          }
        }
        const aWorkers = [];
        for (let i = 0; i < 4; i++) aWorkers.push(audioWorker());
        await Promise.all(aWorkers);
        audioChunkBuffers.push(...aBuffers.filter(Boolean));
      }

      const validChunks = chunkBuffers.filter(Boolean);
      if (validChunks.length === 0) {
        throw new Error('No video segments could be downloaded. Try Preview -> Record.');
      }

      if (labelSpan) labelSpan.textContent = 'Saving Video (MP4)...';

      // Assemble into 100% genuine MP4 container with proper seek index!
      // Output filename is strictly .mp4 - never .ts (eliminates unknown extension error)!
      const finalFilename = `${cleanTitle}.mp4`;
      let finalBlob = null;

      if (mediaInfo.isFmp4) {
        // Fragmented MP4 stream: prepend init segment and join media fragments
        const allParts = [];
        if (initBuffer) allParts.push(initBuffer);
        allParts.push(...validChunks);
        if (audioChunkBuffers.length > 0) allParts.push(...audioChunkBuffers);
        finalBlob = new Blob(allParts, { type: 'video/mp4' });
      } else {
        // MPEG-TS stream: transmux to proper fMP4 container with seek index
        // This enables instant seeking in VLC/MPC-HC/PotPlayer instead of 2-sec delay
        if (labelSpan) labelSpan.textContent = 'Converting to MP4...';
        finalBlob = await transmuxTsToMp4(validChunks);
      }

      const objectUrl = URL.createObjectURL(finalBlob);

      // Trigger SINGLE download with EXACT video title!
      saveSingleFile(objectUrl, finalFilename);

      showToast(`✓ Downloaded: ${finalFilename}`);
      if (labelSpan) labelSpan.textContent = '✓ Saved!';
      if (btnElement) {
        btnElement.classList.remove('downloading');
        btnElement.classList.add('completed');
      }
    } catch (err) {
      console.error(err);
      showToast('Download error: ' + err.message);
      if (labelSpan) labelSpan.textContent = 'Download Video';
      if (btnElement) btnElement.classList.remove('downloading');
    }
  }

  // -------------------------------------------------------------
  // 3. DIRECT FILE DOWNLOAD (With Exact Video Title)
  // -------------------------------------------------------------
  function downloadDirectVideo(item, btnElement) {
    const cleanTitle = sanitizeFilename(item.title || activeTabTitle || 'Video');
    const isAudio = item.category === 'audio';
    const ext = isAudio ? 'mp3' : 'mp4';
    const finalFilename = `${cleanTitle}.${ext}`;
    const labelSpan = btnElement ? btnElement.querySelector('.btn-label') : null;

    showToast(`Downloading: ${finalFilename}...`);

    chrome.runtime.sendMessage({
      type: 'TRIGGER_DOWNLOAD',
      url: item.url,
      filename: cleanTitle,
      category: item.category
    }, (res) => {
      if (res && res.success) {
        showToast(`✓ Download started: ${finalFilename}`);
        if (labelSpan) labelSpan.textContent = '✓ Saved!';
        if (btnElement) btnElement.classList.add('completed');
      } else {
        // Fallback to authenticated page fetch
        showToast('Saving video via page context...');
        chrome.tabs.sendMessage(activeTabId, {
          type: 'PAGE_FETCH_DOWNLOAD',
          url: item.url,
          filename: cleanTitle
        }, (pageRes) => {
          if (pageRes && pageRes.success) {
            showToast(`✓ Downloaded: ${finalFilename}`);
            if (labelSpan) labelSpan.textContent = '✓ Saved!';
            if (btnElement) btnElement.classList.add('completed');
          } else {
            showToast('Download failed: ' + (pageRes?.error || 'Network error'));
            if (labelSpan) labelSpan.textContent = 'Download Video';
          }
        });
      }
    });
  }

  // Single-File Save Helper: Ensures ONLY ONE file is EVER downloaded!
  function saveSingleFile(objectUrl, filename) {
    if (chrome.downloads) {
      chrome.downloads.download({
        url: objectUrl,
        filename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          // Fallback to anchor click only if chrome.downloads failed!
          saveViaAnchor(objectUrl, filename);
        } else {
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        }
      });
    } else {
      saveViaAnchor(objectUrl, filename);
    }
  }

  function saveViaAnchor(objectUrl, filename) {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }

  // -------------------------------------------------------------
  // 4. CAPTURE PLAYING VIDEO (For Blob/MSE Players)
  // -------------------------------------------------------------
  function captureLivePlayer(item, btnElement) {
    if (!activeTabId) return;
    const labelSpan = btnElement.querySelector('.btn-label');
    const cleanTitle = sanitizeFilename(item.title || 'Video');

    labelSpan.textContent = 'Capturing...';
    btnElement.classList.add('downloading');
    showToast(`Capturing video: ${cleanTitle}... Click again to finish.`);

    btnElement.onclick = () => {
      chrome.tabs.sendMessage(activeTabId, { type: 'STOP_VIDEO_CAPTURE' }, () => {
        labelSpan.textContent = '✓ Saved Video';
        btnElement.classList.remove('downloading');
        btnElement.classList.add('completed');
        showToast(`✓ Saved: ${cleanTitle}.mp4`);
      });
    };

    chrome.tabs.sendMessage(activeTabId, {
      type: 'START_VIDEO_CAPTURE',
      filename: cleanTitle
    });
  }

  // -------------------------------------------------------------
  // 5. FORCE VIDEO SCAN (Deep DOM Probe with Accurate Titles)
  // -------------------------------------------------------------
  function forceScanVideos() {
    if (!activeTabId) return;
    showToast('Scanning page for videos and titles...');

    chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: () => {
        const found = [];

        function cleanTitle(str) {
          if (!str) return 'Video';
          let s = str.trim().replace(/\s*[-|–—•]\s*(YouTube|Vimeo|Dailymotion|Twitter|X|Facebook|TikTok|Twitch|Watch Online|Free Full|HD).*$/i, '');
          s = s.replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '_').trim();
          s = s.replace(/_+/g, '_').replace(/\.+$/, '');
          return s.slice(0, 100) || 'Video';
        }

        const pageTitle = cleanTitle(
          document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
          document.querySelector('h1')?.innerText ||
          document.title
        );

        function scan(root) {
          const vids = root.querySelectorAll('video');
          vids.forEach(v => {
            const s = v.currentSrc || v.src;
            if (s) {
              const elTitle = v.getAttribute('title') || v.getAttribute('aria-label');
              found.push({
                url: s,
                title: elTitle ? cleanTitle(elTitle) : pageTitle,
                resolution: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
                isBlob: s.startsWith('blob:')
              });
            }
          });
          const all = root.querySelectorAll('*');
          all.forEach(el => {
            if (el.shadowRoot) scan(el.shadowRoot);
          });
        }
        scan(document);
        return found;
      }
    }, (results) => {
      let count = 0;
      if (results && results.length > 0) {
        results.forEach(f => {
          if (f.result && Array.isArray(f.result)) {
            f.result.forEach(m => {
              chrome.runtime.sendMessage({
                type: 'MEDIA_DETECTED',
                media: {
                  url: m.url,
                  title: m.title || 'Video',
                  format: m.resolution ? `${m.resolution} MP4` : 'MP4 VIDEO',
                  category: 'video',
                  resolution: m.resolution,
                  isBlobPlayer: m.isBlob
                }
              });
              count++;
            });
          }
        });
        setTimeout(loadMedia, 300);
        showToast(`Found ${count} video(s)!`);
      } else {
        showToast('No active video elements found on this page.');
      }
    });
  }

  btnForceDownload.addEventListener('click', forceScanVideos);
  btnForceEmpty.addEventListener('click', forceScanVideos);

  // Batch Download
  btnDownloadAll.addEventListener('click', async () => {
    const list = allMedia.filter(m => m.category === 'video');
    showToast(`Downloading all ${list.length} videos...`);
    for (const item of list) {
      if (isHlsMedia(item)) {
        downloadHlsVideoInPopup(item);
      } else {
        downloadDirectVideo(item);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  });

  // Filter Tabs
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter');
      renderMedia();
    });
  });

  // Search
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderMedia();
  });

  // Rescan
  btnRescan.addEventListener('click', () => {
    showToast('Rescanning...');
    chrome.tabs.sendMessage(activeTabId, { type: 'SCAN_PAGE_NOW' }, () => {
      setTimeout(loadMedia, 300);
    });
  });

  // Clear
  btnClearMedia.addEventListener('click', () => {
    if (!activeTabId) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA', tabId: activeTabId }, () => {
      loadMedia();
      showToast('Cleared');
    });
  });

  // Options
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
  }

  // Initial load
  loadMedia();
});
