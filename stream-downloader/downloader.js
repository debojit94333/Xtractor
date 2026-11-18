// Xtractor Stream Downloader & Merger Controller
// Coordinates stream parsing, multi-threaded segment downloading, AES decryption, and file assembly.

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const streamUrlInput = document.getElementById('streamUrl');
  const videoTitleInput = document.getElementById('videoTitle');
  const concurrencySelect = document.getElementById('concurrencySelect');
  const btnAnalyze = document.getElementById('btnAnalyze');

  // Analysis Elements
  const analysisCard = document.getElementById('analysisCard');
  const variantSelectorGroup = document.getElementById('variantSelectorGroup');
  const variantSelect = document.getElementById('variantSelect');
  const statDuration = document.getElementById('statDuration');
  const statSegments = document.getElementById('statSegments');
  const statFormat = document.getElementById('statFormat');
  const statEncryption = document.getElementById('statEncryption');
  const btnStartDownload = document.getElementById('btnStartDownload');

  // Progress Elements
  const progressCard = document.getElementById('progressCard');
  const progressStatus = document.getElementById('progressStatus');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressPercent = document.getElementById('progressPercent');
  const metricSegments = document.getElementById('metricSegments');
  const metricSpeed = document.getElementById('metricSpeed');
  const metricSize = document.getElementById('metricSize');
  const metricEta = document.getElementById('metricEta');
  const segmentGrid = document.getElementById('segmentGrid');
  const btnPauseResume = document.getElementById('btnPauseResume');
  const btnCancelDownload = document.getElementById('btnCancelDownload');

  // Success Elements
  const successCard = document.getElementById('successCard');
  const mergedPlayer = document.getElementById('mergedPlayer');
  const btnSaveFile = document.getElementById('btnSaveFile');
  const studioToast = document.getElementById('studioToast');

  // State
  let currentMasterUrl = '';
  let currentMediaUrl = '';
  let masterVariants = [];
  let selectedMediaInfo = null;
  let isDownloading = false;
  let isPaused = false;
  let isCancelled = false;

  let downloadedChunks = [];
  let chunkBuffers = [];
  let totalBytesDownloaded = 0;
  let speedInterval = null;
  let lastBytes = 0;
  let currentSpeedBps = 0;
  let startTime = 0;
  let activeWorkers = 0;
  let segmentBlocks = [];
  let finalMergedBlob = null;
  let finalFilename = 'stream.mp4';

  function showToast(msg, duration = 3000) {
    studioToast.textContent = msg;
    studioToast.classList.add('show');
    setTimeout(() => {
      studioToast.classList.remove('show');
    }, duration);
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  /**
   * Transmux MPEG-TS chunks into a standard MP4 container.
   * Primary: Mediabunny — produces standard non-fragmented MP4 with single moov and full stss
   * (Sync Sample Box) keyframe index. Plays smoothly with 0 lag/stutter in all media players
   * (VLC, Windows Media Player, QuickTime, Chrome, TV/mobile) and seeks instantaneously.
   * Fallback: mux.js with monotonic sequence numbering.
   *
   * @param {ArrayBuffer[]} tsChunks - Array of MPEG-TS segment buffers
   * @param {Function} [onProgress] - Optional progress callback (0 to 1)
   * @returns {Blob} - MP4 blob ready for download
   */
  async function transmuxTsToMp4(tsChunks, onProgress) {
    if (!tsChunks || tsChunks.length === 0) {
      return new Blob([], { type: 'video/mp4' });
    }

    const combinedBlob = new Blob(tsChunks, { type: 'video/mp2t' });

    // 1. Primary High-Performance Muxer: Mediabunny
    const mb = window.Mediabunny || globalThis.Mediabunny;
    if (mb && mb.Input && mb.Output && mb.Conversion && mb.MpegTsInputFormat && mb.Mp4OutputFormat) {
      try {
        console.log('[Xtractor] Transmuxing TS to standard MP4 via Mediabunny...');
        const input = new mb.Input({
          formats: [new mb.MpegTsInputFormat()],
          source: new mb.BlobSource(combinedBlob),
        });

        const output = new mb.Output({
          format: new mb.Mp4OutputFormat(),
          target: new mb.BufferTarget(),
        });

        const conversion = await mb.Conversion.init({
          input,
          output,
        });

        if (conversion.isValid) {
          if (typeof onProgress === 'function') {
            conversion.onProgress = (prog) => {
              try { onProgress(prog); } catch (_) {}
            };
          }
          await conversion.execute();
          const mp4Buffer = output.target.buffer;
          if (mp4Buffer && mp4Buffer.byteLength > 0) {
            console.log(`[Xtractor] Mediabunny transmux complete: ${(mp4Buffer.byteLength / 1048576).toFixed(1)} MB`);
            return new Blob([mp4Buffer], { type: 'video/mp4' });
          }
        } else {
          console.warn('[Xtractor] Mediabunny conversion invalid, discarded:', conversion.discardedTracks);
        }
      } catch (mbErr) {
        console.warn('[Xtractor] Mediabunny error, falling back to secondary transmuxer:', mbErr);
      }
    }

    // 2. Secondary Fallback: mux.js
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
                  box[i + 5] |= 0x02; // default-base-is-moof flag
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

          const orderedBoxes = [...videoBoxes, ...audioBoxes];

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
          if (segment.initSegment && segment.initSegment.byteLength > 0 && !initSegment) {
            initSegment = new Uint8Array(segment.initSegment);
          }
          if (segment.data && segment.data.byteLength > 0) {
            const reordered = reorderAndPatchBoxes(new Uint8Array(segment.data));
            allDataParts.push(...reordered);
          }
        });

        transmuxer.on('error', (err) => {
          console.error('Transmux error:', err);
          safeResolve(new Blob(tsChunks, { type: 'video/mp4' }));
        });

        for (const chunk of tsChunks) {
          transmuxer.push(new Uint8Array(chunk));
          transmuxer.flush();
        }

        if (!initSegment || allDataParts.length === 0) {
          console.warn('Transmux produced no output, falling back to raw TS');
          safeResolve(new Blob(tsChunks, { type: 'video/mp4' }));
          return;
        }

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

  // Parse query params (e.g. ?url=...&title=...)
  const params = new URLSearchParams(window.location.search);
  const paramUrl = params.get('url');
  const paramTitle = params.get('title');

  if (paramTitle) {
    videoTitleInput.value = paramTitle.replace(/[<>:"/\\|?*]/g, '_');
  }

  if (paramUrl) {
    streamUrlInput.value = paramUrl;
    analyzeStream(paramUrl);
  }

  btnAnalyze.addEventListener('click', () => {
    const url = streamUrlInput.value.trim();
    if (!url) {
      showToast('Please enter a valid M3U8 URL');
      return;
    }
    analyzeStream(url);
  });

  // Step 1: Analyze Stream Playlist
  async function analyzeStream(url) {
    currentMasterUrl = url;
    showToast('Analyzing stream playlist...');
    btnAnalyze.disabled = true;

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP Error ${resp.status}`);
      const text = await resp.text();

      if (HlsParser.isMasterPlaylist(text)) {
        masterVariants = HlsParser.parseMaster(text, url);
        if (masterVariants.length === 0) {
          throw new Error('Master playlist found but no valid stream variants detected.');
        }

        variantSelectorGroup.style.display = 'block';
        variantSelect.innerHTML = '';
        masterVariants.forEach((v, idx) => {
          const opt = document.createElement('option');
          opt.value = idx;
          opt.textContent = `${v.qualityLabel} - ${Math.round(v.bandwidth / 1000)} kbps`;
          variantSelect.appendChild(opt);
        });

        // Load metadata for the highest quality variant
        currentMediaUrl = masterVariants[0].uri;
        await loadVariantMetadata(masterVariants[0].uri);

        variantSelect.onchange = async () => {
          const selectedIdx = parseInt(variantSelect.value, 10);
          currentMediaUrl = masterVariants[selectedIdx].uri;
          await loadVariantMetadata(currentMediaUrl);
        };
      } else {
        // Direct media playlist
        variantSelectorGroup.style.display = 'none';
        currentMediaUrl = url;
        selectedMediaInfo = HlsParser.parseMedia(text, url);
        updateMetadataDisplay(selectedMediaInfo);
      }

      analysisCard.style.display = 'block';
      successCard.style.display = 'none';
      progressCard.style.display = 'none';
    } catch (e) {
      console.error(e);
      showToast('Failed to analyze stream: ' + e.message);
    } finally {
      btnAnalyze.disabled = false;
    }
  }

  async function loadVariantMetadata(variantUrl) {
    try {
      const resp = await fetch(variantUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      selectedMediaInfo = HlsParser.parseMedia(text, variantUrl);
      updateMetadataDisplay(selectedMediaInfo);
    } catch (e) {
      showToast('Error loading variant details: ' + e.message);
    }
  }

  function updateMetadataDisplay(mediaInfo) {
    statDuration.textContent = formatDuration(mediaInfo.totalDuration);
    statSegments.textContent = `${mediaInfo.totalSegments} Chunks`;
    statFormat.textContent = mediaInfo.isFmp4 ? 'Fragmented MP4 (fMP4)' : 'MPEG-2 TS';
    statEncryption.textContent = mediaInfo.keyInfo ? mediaInfo.keyInfo.method : 'None (Clear)';
  }

  // Step 2: Start Download Process
  btnStartDownload.addEventListener('click', () => {
    if (!selectedMediaInfo || selectedMediaInfo.segments.length === 0) {
      showToast('No media segments to download');
      return;
    }
    startDownloadProcess();
  });

  async function startDownloadProcess() {
    isDownloading = true;
    isPaused = false;
    isCancelled = false;

    analysisCard.style.display = 'none';
    progressCard.style.display = 'block';
    successCard.style.display = 'none';
    btnPauseResume.textContent = 'Pause';

    const segments = selectedMediaInfo.segments;
    const totalCount = segments.length;
    downloadedChunks = new Array(totalCount).fill(null);
    chunkBuffers = new Array(totalCount).fill(null);
    totalBytesDownloaded = 0;
    lastBytes = 0;
    startTime = Date.now();

    // Render Segment Grid
    segmentGrid.innerHTML = '';
    segmentBlocks = [];
    for (let i = 0; i < totalCount; i++) {
      const block = document.createElement('div');
      block.className = 'segment-block';
      block.title = `Segment #${i + 1}`;
      segmentGrid.appendChild(block);
      segmentBlocks.push(block);
    }

    // Start Speed Monitor
    if (speedInterval) clearInterval(speedInterval);
    speedInterval = setInterval(() => {
      const deltaBytes = totalBytesDownloaded - lastBytes;
      lastBytes = totalBytesDownloaded;
      currentSpeedBps = deltaBytes * 2; // 500ms interval -> bytes/sec
      metricSpeed.textContent = `${(currentSpeedBps / (1024 * 1024)).toFixed(1)} MB/s`;

      // Update ETA
      const completedCount = downloadedChunks.filter(Boolean).length;
      const remainingCount = totalCount - completedCount;
      if (currentSpeedBps > 0 && remainingCount > 0 && completedCount > 0) {
        const avgSegmentBytes = totalBytesDownloaded / completedCount;
        const remainingBytes = remainingCount * avgSegmentBytes;
        const etaSeconds = Math.round(remainingBytes / currentSpeedBps);
        metricEta.textContent = formatDuration(etaSeconds);
      }
    }, 500);

    // Pre-fetch AES-128 key if encrypted
    let keyBuffer = null;
    let ivBuffer = null;
    if (selectedMediaInfo.keyInfo && selectedMediaInfo.keyInfo.keyUri) {
      progressStatus.textContent = 'Fetching stream encryption key...';
      try {
        const keyResp = await fetch(selectedMediaInfo.keyInfo.keyUri);
        keyBuffer = await keyResp.arrayBuffer();

        if (selectedMediaInfo.keyInfo.ivHex) {
          const hex = selectedMediaInfo.keyInfo.ivHex.replace(/^0x/, '');
          const ivArr = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          ivBuffer = ivArr.buffer;
        }
      } catch (e) {
        showToast('Warning: Failed to fetch encryption key. Stream may be DRM protected.');
      }
    }

    // Pre-fetch fMP4 Init Segment if exists
    let initBuffer = null;
    if (selectedMediaInfo.initSegmentUri) {
      progressStatus.textContent = 'Fetching initialization chunk...';
      try {
        const initResp = await fetch(selectedMediaInfo.initSegmentUri);
        initBuffer = await initResp.arrayBuffer();
        totalBytesDownloaded += initBuffer.byteLength;
      } catch (e) {
        console.error('Init segment fetch failed:', e);
      }
    }

    // Worker Queue
    const concurrency = parseInt(concurrencySelect.value, 10) || 4;
    let nextIndex = 0;
    let completedCount = 0;

    // Check IndexedDB persistent segment cache
    const streamTargetUrl = currentMediaUrl || currentMasterUrl || '';
    let cachedMap = new Map();
    if (window.SegmentCache && streamTargetUrl) {
      try {
        cachedMap = await SegmentCache.getAllCachedSegments(streamTargetUrl);
      } catch (e) {
        console.warn('Failed reading segment cache:', e);
      }
    }

    for (let i = 0; i < totalCount; i++) {
      if (cachedMap.has(i)) {
        const cData = cachedMap.get(i);
        downloadedChunks[i] = true;
        chunkBuffers[i] = cData;
        totalBytesDownloaded += cData.byteLength;
        completedCount++;
        const block = segmentBlocks[i];
        if (block) block.className = 'segment-block completed';
      }
    }

    if (completedCount > 0) {
      const pct = Math.round((completedCount / totalCount) * 100);
      progressBarFill.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
      metricSegments.textContent = `${completedCount} / ${totalCount}`;
      metricSize.textContent = formatBytes(totalBytesDownloaded);
      progressStatus.textContent = `Restored ${completedCount}/${totalCount} segments from cache. Resuming...`;
    } else {
      progressStatus.textContent = `Downloading ${totalCount} segments with ${concurrency} connections...`;
    }

    async function worker() {
      while (nextIndex < totalCount && !isCancelled) {
        // Handle Pause
        if (isPaused) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const currentIndex = nextIndex++;
        if (downloadedChunks[currentIndex]) {
          continue; // Already downloaded or restored from cache!
        }

        const segment = segments[currentIndex];
        const block = segmentBlocks[currentIndex];

        if (block) block.className = 'segment-block downloading';

        // Fetch segment with retry logic
        let success = false;
        let attempts = 0;
        let chunkData = null;

        while (attempts < 3 && !success && !isCancelled) {
          try {
            attempts++;
            const resp = await fetch(segment.uri);
            if (!resp.ok) throw new Error(`Status ${resp.status}`);
            chunkData = await resp.arrayBuffer();

            // Decrypt if needed
            if (keyBuffer) {
              const iv = ivBuffer || new Uint8Array(16); // default IV is sequence number if null
              chunkData = await HlsParser.decryptChunk(chunkData, keyBuffer, iv);
            }

            success = true;
          } catch (err) {
            if (attempts >= 3) {
              console.error(`Chunk ${currentIndex} failed after 3 tries:`, err);
            } else {
              await new Promise(r => setTimeout(r, 500 * attempts));
            }
          }
        }

        if (success && chunkData) {
          downloadedChunks[currentIndex] = true;
          chunkBuffers[currentIndex] = chunkData;
          totalBytesDownloaded += chunkData.byteLength;
          completedCount++;

          if (window.SegmentCache && streamTargetUrl) {
            SegmentCache.saveCachedSegment(streamTargetUrl, currentIndex, chunkData).catch(() => {});
          }

          if (block) block.className = 'segment-block completed';

          // Update Progress
          const pct = Math.round((completedCount / totalCount) * 100);
          progressBarFill.style.width = `${pct}%`;
          progressPercent.textContent = `${pct}%`;
          metricSegments.textContent = `${completedCount} / ${totalCount}`;
          metricSize.textContent = formatBytes(totalBytesDownloaded);
        } else {
          if (block) block.className = 'segment-block failed';
        }
      }
    }

    // Launch worker pool
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (speedInterval) clearInterval(speedInterval);

    if (isCancelled) {
      progressStatus.textContent = 'Download cancelled.';
      return;
    }

    // Step 3: Merge Segments
    progressStatus.textContent = 'Merging video segments into single file...';
    progressBarFill.style.width = '100%';
    progressPercent.textContent = '100%';

    const validChunks = [];
    if (initBuffer) validChunks.push(initBuffer);

    for (let i = 0; i < totalCount; i++) {
      if (chunkBuffers[i]) {
        validChunks.push(chunkBuffers[i]);
      }
    }

    const cleanTitle = (videoTitleInput.value.trim() || 'Merged_Stream').replace(/[<>:"/\\|?*]/g, '_');
    finalFilename = `${cleanTitle}.mp4`; // ALWAYS .mp4!

    if (selectedMediaInfo && !selectedMediaInfo.isFmp4) {
      progressStatus.textContent = 'Transmuxing video to MP4 container (enabling instant seek)...';
      finalMergedBlob = await transmuxTsToMp4(validChunks, (prog) => {
        progressStatus.textContent = `Optimizing video for 100% smooth playback: ${(prog * 100).toFixed(0)}%`;
      });
    } else {
      finalMergedBlob = new Blob(validChunks, { type: 'video/mp4' });
    }

    const objectUrl = URL.createObjectURL(finalMergedBlob);
    mergedPlayer.src = objectUrl;

    // Clear cached chunks now that assembly succeeded
    if (window.SegmentCache && streamTargetUrl) {
      SegmentCache.clearCachedSegmentsForStream(streamTargetUrl).catch(() => {});
    }

    progressCard.style.display = 'none';
    successCard.style.display = 'block';
    showToast('Video stream assembled successfully!');
  }

  // Pause / Resume
  btnPauseResume.addEventListener('click', () => {
    isPaused = !isPaused;
    btnPauseResume.textContent = isPaused ? 'Resume' : 'Pause';
    progressStatus.textContent = isPaused ? 'Download paused' : 'Resuming download...';
  });

  // Cancel
  btnCancelDownload.addEventListener('click', () => {
    if (confirm('Are you sure you want to cancel this stream download?')) {
      isCancelled = true;
      if (speedInterval) clearInterval(speedInterval);
      progressCard.style.display = 'none';
      analysisCard.style.display = 'block';
      showToast('Download cancelled');
    }
  });

  // Save Merged File to Disk
  btnSaveFile.addEventListener('click', () => {
    if (!finalMergedBlob) return;

    const objectUrl = URL.createObjectURL(finalMergedBlob);

    // Register custom filename with background onDeterminingFilename
    try {
      chrome.runtime.sendMessage({
        type: 'REGISTER_BLOB_DOWNLOAD',
        url: objectUrl,
        filename: finalFilename
      });
    } catch (_) {}

    // Try chrome.downloads API first
    if (chrome.downloads) {
      chrome.downloads.download({
        url: objectUrl,
        filename: finalFilename,
        saveAs: false
      }, (id) => {
        if (chrome.runtime.lastError) {
          triggerBrowserDownload(objectUrl, finalFilename);
        } else {
          showToast(`File saved: ${finalFilename}`);
        }
      });
    } else {
      triggerBrowserDownload(objectUrl, finalFilename);
    }
  });

  function triggerBrowserDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(`Saved ${filename}`);
  }
});
