/**
 * Xtractor Offscreen Background Downloader
 * 
 * Runs in a dedicated background document so:
 * 1. Closing the extension popup NEVER interrupts or restarts downloads.
 * 2. Downloaded segments are saved to IndexedDB in real time.
 * 3. Transmuxing to standard MP4 via Mediabunny completes in the background
 *    and saves the file automatically to the user's Downloads folder.
 */

(() => {
  'use strict';

  let currentDownload = null;
  let isCancelled = false;

  function sanitizeFilename(name) {
    if (!name) return 'video';
    let clean = name.trim();
    clean = clean.replace(/[<>:"/\\|?*\x00-\x1F\r\n\t]/g, '_').trim();
    clean = clean.replace(/_+/g, '_').replace(/\.+$/, '');
    return clean.slice(0, 100) || 'video';
  }

  async function fetchSegmentBuffer(url, activeTabId) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        return await resp.arrayBuffer();
      }
    } catch (_) {}

    if (activeTabId) {
      try {
        const pageRes = await new Promise(resolve => {
          chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH_BLOB', url }, resolve);
        });
        if (pageRes && pageRes.success && pageRes.base64) {
          const binary = atob(pageRes.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          return bytes.buffer;
        }
      } catch (_) {}
    }
    return null;
  }

  async function transmuxTsToMp4(tsChunks, onProgress) {
    if (!tsChunks || tsChunks.length === 0) {
      return new Blob([], { type: 'video/mp4' });
    }

    const combinedBlob = new Blob(tsChunks, { type: 'video/mp2t' });
    const mb = window.Mediabunny || globalThis.Mediabunny;

    if (mb && mb.Input && mb.Output && mb.Conversion && mb.MpegTsInputFormat && mb.Mp4OutputFormat) {
      try {
        console.log('[Offscreen] Transmuxing TS to standard MP4 via Mediabunny...');
        const input = new mb.Input({
          formats: [new mb.MpegTsInputFormat()],
          source: new mb.BlobSource(combinedBlob),
        });

        const output = new mb.Output({
          format: new mb.Mp4OutputFormat(),
          target: new mb.BufferTarget(),
        });

        const conversion = await mb.Conversion.init({ input, output });

        if (conversion.isValid) {
          if (typeof onProgress === 'function') {
            conversion.onProgress = (prog) => {
              try { onProgress(prog); } catch (_) {}
            };
          }
          await conversion.execute();
          const mp4Buffer = output.target.buffer;
          if (mp4Buffer && mp4Buffer.byteLength > 0) {
            console.log(`[Offscreen] Mediabunny transmux complete: ${(mp4Buffer.byteLength / 1048576).toFixed(1)} MB`);
            return new Blob([mp4Buffer], { type: 'video/mp4' });
          }
        }
      } catch (err) {
        console.warn('[Offscreen] Mediabunny error, falling back to raw TS:', err);
      }
    }

    return new Blob(tsChunks, { type: 'video/mp4' });
  }

  async function startHlsDownload(item) {
    const { url, title, activeTabId } = item;
    const cleanTitle = sanitizeFilename(title || 'Video');
    const finalFilename = `${cleanTitle}.mp4`;

    isCancelled = false;
    currentDownload = {
      streamUrl: url,
      title: cleanTitle,
      finalFilename,
      completed: 0,
      total: 0,
      percent: 0,
      status: 'downloading'
    };

    const updateStatus = (status, completed, total, percent) => {
      currentDownload.status = status;
      currentDownload.completed = completed;
      currentDownload.total = total;
      currentDownload.percent = percent;

      const progressData = {
        streamUrl: url,
        title: cleanTitle,
        finalFilename,
        status,
        completed,
        total,
        percent,
        timestamp: Date.now()
      };

      // 1. Broadcast to any open popup
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        ...progressData
      }).catch(() => {});

      // 2. Persist in storage so popup can read it upon opening
      chrome.storage.local.set({
        [`dl_${url}`]: progressData,
        'activeDownload': progressData
      });
    };

    updateStatus('preparing', 0, 0, 0);

    try {
      // 1. Fetch playlist
      let text = '';
      try {
        const resp = await fetch(url);
        if (resp.ok) text = await resp.text();
      } catch (_) {}

      if (!text && activeTabId) {
        const pageFetch = await new Promise(resolve => {
          chrome.tabs.sendMessage(activeTabId, { type: 'PAGE_PROXY_FETCH', url }, resolve);
        });
        if (pageFetch && pageFetch.success) text = pageFetch.text;
      }

      if (!text) {
        throw new Error('Unable to access video stream playlist');
      }

      let targetMediaUrl = url;
      let mediaInfo = null;
      let separateAudioUri = null;

      if (window.HlsParser && HlsParser.isMasterPlaylist(text)) {
        const variants = HlsParser.parseMaster(text, url);
        if (variants.length > 0) {
          targetMediaUrl = variants[0].uri;
          if (variants[0].audioUri) separateAudioUri = variants[0].audioUri;
          let varText = '';
          try {
            const varResp = await fetch(targetMediaUrl);
            if (varResp.ok) varText = await varResp.text();
          } catch (_) {}
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

      // Check IndexedDB cache for previously downloaded segments
      const cachedMap = window.SegmentCache ? await SegmentCache.getAllCachedSegments(targetMediaUrl) : new Map();
      let completed = 0;

      for (let i = 0; i < totalCount; i++) {
        if (cachedMap.has(i)) {
          chunkBuffers[i] = cachedMap.get(i);
          completed++;
        }
      }

      console.log(`[Offscreen] Starting download: ${totalCount} segments, ${completed} already cached`);
      updateStatus('downloading', completed, totalCount, Math.round((completed / totalCount) * 100));

      // Decryption key if encrypted
      let keyBuffer = null;
      if (mediaInfo.keyInfo && mediaInfo.keyInfo.keyUri) {
        keyBuffer = await fetchSegmentBuffer(mediaInfo.keyInfo.keyUri, activeTabId);
      }

      let initBuffer = null;
      if (mediaInfo.initSegmentUri) {
        initBuffer = await fetchSegmentBuffer(mediaInfo.initSegmentUri, activeTabId);
      }

      const concurrency = Math.min(4, totalCount);
      let nextIndex = 0;
      let lastProgressBroadcast = Date.now();

      async function worker() {
        while (nextIndex < totalCount && !isCancelled) {
          const idx = nextIndex++;
          if (chunkBuffers[idx]) continue; // already cached!

          const seg = segments[idx];
          let buf = null;
          let attempts = 0;

          while (attempts < 4 && !buf && !isCancelled) {
            attempts++;
            try {
              buf = await fetchSegmentBuffer(seg.uri, activeTabId);
              if (buf && buf.byteLength > 0) {
                // Decrypt if AES-128
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

                // Save to persistent IndexedDB cache
                if (window.SegmentCache) {
                  SegmentCache.saveCachedSegment(targetMediaUrl, idx, buf).catch(() => {});
                }

                const now = Date.now();
                if (now - lastProgressBroadcast > 300 || completed === totalCount) {
                  lastProgressBroadcast = now;
                  updateStatus('downloading', completed, totalCount, Math.round((completed / totalCount) * 100));
                }
                break;
              }
            } catch (_) {}
            if (!buf && attempts < 4 && !isCancelled) {
              await new Promise(r => setTimeout(r, 200 * attempts));
            }
          }
        }
      }

      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (isCancelled) {
        updateStatus('cancelled', completed, totalCount, Math.round((completed / totalCount) * 100));
        return;
      }

      const validChunks = chunkBuffers.filter(Boolean);
      if (validChunks.length === 0) {
        throw new Error('Failed to download video segments');
      }

      updateStatus('transmuxing', totalCount, totalCount, 99);

      let finalBlob;
      if (mediaInfo && !mediaInfo.isFmp4) {
        finalBlob = await transmuxTsToMp4(validChunks, (p) => {
          updateStatus('transmuxing', totalCount, totalCount, 99);
        });
      } else {
        const allParts = [];
        if (initBuffer) allParts.push(initBuffer);
        allParts.push(...validChunks);
        finalBlob = new Blob(allParts, { type: 'video/mp4' });
      }

      const objectUrl = URL.createObjectURL(finalBlob);

      // Register filename to lock in exact title with background onDeterminingFilename
      try {
        await new Promise(r => chrome.runtime.sendMessage({
          type: 'REGISTER_BLOB_DOWNLOAD',
          url: objectUrl,
          filename: finalFilename
        }, r));
      } catch (_) {}

      // Trigger standard Chrome download
      chrome.downloads.download({
        url: objectUrl,
        filename: finalFilename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('[Offscreen] chrome.downloads error:', chrome.runtime.lastError.message);
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      });

      // Clear IndexedDB cache for completed video
      if (window.SegmentCache) {
        SegmentCache.clearCachedSegmentsForStream(targetMediaUrl).catch(() => {});
      }

      updateStatus('completed', totalCount, totalCount, 100);
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_COMPLETED',
        streamUrl: url,
        finalFilename
      }).catch(() => {});
      console.log(`[Offscreen] Successfully completed and saved: ${finalFilename}`);
    } catch (err) {
      console.error('[Offscreen] Download error:', err);
      updateStatus('error', 0, 0, 0);
      chrome.storage.local.set({
        [`dl_${url}`]: { status: 'error', error: err.message, title: cleanTitle, timestamp: Date.now() },
        'activeDownload': null
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_OFFSCREEN_DOWNLOAD') {
      startHlsDownload(message.item);
      sendResponse({ success: true });
    } else if (message.type === 'CANCEL_OFFSCREEN_DOWNLOAD') {
      isCancelled = true;
      sendResponse({ success: true });
    } else if (message.type === 'GET_OFFSCREEN_STATUS') {
      sendResponse({ currentDownload });
    }
  });

  console.log('[Offscreen] Background downloader initialized and ready.');
})();
