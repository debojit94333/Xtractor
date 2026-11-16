// Xtractor Recording Studio Controller
// Inspired by CocoCut: Turbo Acceleration, Buffer Progress Tracking, and Live Stream Capture.

document.addEventListener('DOMContentLoaded', () => {
  const videoPlayer = document.getElementById('captureVideoPlayer');
  const videoTitleDisplay = document.getElementById('videoTitleDisplay');
  const formatSelect = document.getElementById('formatSelect');
  const recordingStatusBadge = document.getElementById('recordingStatusBadge');
  const recordingOverlay = document.getElementById('recordingOverlay');

  // Timeline
  const bufferBarFill = document.getElementById('bufferBarFill');
  const playbackBarFill = document.getElementById('playbackBarFill');
  const bufferPercentText = document.getElementById('bufferPercentText');

  // Controls
  const speedButtons = document.querySelectorAll('.speed-btn');
  const btnStartRecord = document.getElementById('btnStartRecord');
  const btnStopSave = document.getElementById('btnStopSave');
  const chkAutoStop = document.getElementById('chkAutoStop');

  // Stats
  const statDuration = document.getElementById('statDuration');
  const statSize = document.getElementById('statSize');
  const statResolution = document.getElementById('statResolution');
  const recorderToast = document.getElementById('recorderToast');

  // State
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let recordTimer = null;
  let elapsedSeconds = 0;
  let totalRecordedBytes = 0;
  let currentTitle = 'Recorded_Video';

  function showToast(msg, duration = 2500) {
    recorderToast.textContent = msg;
    recorderToast.classList.add('show');
    setTimeout(() => {
      recorderToast.classList.remove('show');
    }, duration);
  }

  function formatDuration(sec) {
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0.0 MB';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Parse Query Parameters
  const params = new URLSearchParams(window.location.search);
  const paramUrl = params.get('url');
  const paramTitle = params.get('title');

  if (paramTitle) {
    currentTitle = paramTitle.replace(/[<>:"/\\|?*]/g, '_');
    videoTitleDisplay.textContent = currentTitle;
  }

  if (paramUrl) {
    videoPlayer.src = paramUrl;
    videoPlayer.play().catch(() => {
      // Auto-play might need user gesture
    });
  }

  // Update Resolution when video metadata is loaded
  videoPlayer.addEventListener('loadedmetadata', () => {
    if (videoPlayer.videoWidth && videoPlayer.videoHeight) {
      statResolution.textContent = `${videoPlayer.videoWidth} x ${videoPlayer.videoHeight}`;
    }
  });

  // Track Buffer Progress
  videoPlayer.addEventListener('progress', updateBufferProgress);
  videoPlayer.addEventListener('timeupdate', () => {
    if (videoPlayer.duration > 0) {
      const pct = (videoPlayer.currentTime / videoPlayer.duration) * 100;
      playbackBarFill.style.width = `${pct}%`;
    }
    updateBufferProgress();
  });

  function updateBufferProgress() {
    if (videoPlayer.duration > 0 && videoPlayer.buffered.length > 0) {
      const bufferedEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
      const pct = Math.min(100, Math.round((bufferedEnd / videoPlayer.duration) * 100));
      bufferBarFill.style.width = `${pct}%`;
      bufferPercentText.textContent = `${pct}% Buffered (${formatDuration(bufferedEnd)} / ${formatDuration(videoPlayer.duration)})`;
    }
  }

  // Turbo Playback Speed Accelerator (CocoCut Style)
  speedButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      speedButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const speed = parseFloat(btn.getAttribute('data-speed'));
      videoPlayer.playbackRate = speed;
      showToast(`Playback speed set to ${speed}x (Turbo Acceleration)`);
    });
  });

  // Start Stream Recording
  btnStartRecord.addEventListener('click', () => {
    if (isRecording) return;
    startRecording();
  });

  function startRecording() {
    try {
      const stream = videoPlayer.captureStream ? videoPlayer.captureStream() : videoPlayer.mozCaptureStream();
      if (!stream) {
        showToast('Error: Unable to capture video stream.');
        return;
      }

      recordedChunks = [];
      totalRecordedBytes = 0;
      elapsedSeconds = 0;

      let mimeType = formatSelect.value;
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm;codecs=vp9,opus';
      }

      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
          totalRecordedBytes += e.data.size;
          statSize.textContent = formatBytes(totalRecordedBytes);
        }
      };

      mediaRecorder.onstop = saveRecordedVideo;

      mediaRecorder.start(1000); // 1-second chunks
      isRecording = true;

      // Update UI
      recordingStatusBadge.textContent = 'RECORDING';
      recordingStatusBadge.className = 'status-badge recording';
      recordingOverlay.style.display = 'flex';
      btnStartRecord.disabled = true;
      btnStopSave.disabled = false;

      // Timer
      recordTimer = setInterval(() => {
        elapsedSeconds++;
        statDuration.textContent = formatDuration(elapsedSeconds);
      }, 1000);

      showToast('Recording started! Use 2x, 4x, or 8x to record faster.');
    } catch (e) {
      console.error(e);
      showToast('Failed to start recording: ' + e.message);
    }
  }

  // Stop Recording
  btnStopSave.addEventListener('click', () => {
    if (!isRecording) return;
    stopRecording();
  });

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    clearInterval(recordTimer);

    recordingStatusBadge.textContent = 'COMPLETED';
    recordingStatusBadge.className = 'status-badge';
    recordingOverlay.style.display = 'none';
    btnStartRecord.disabled = false;
    btnStopSave.disabled = true;
  }

  // Auto-stop when video reaches the end
  videoPlayer.addEventListener('ended', () => {
    if (isRecording && chkAutoStop.checked) {
      showToast('Video finished playing. Saving recorded file...');
      stopRecording();
    }
  });

  // Save Video File
  function saveRecordedVideo() {
    const mime = formatSelect.value;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const finalBlob = new Blob(recordedChunks, { type: mime });
    const filename = `${currentTitle}.${ext}`;

    const objectUrl = URL.createObjectURL(finalBlob);

    if (chrome.downloads) {
      chrome.downloads.download({
        url: objectUrl,
        filename,
        saveAs: true
      }, () => {
        showToast(`Video saved: ${filename}`);
      });
    } else {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`Saved ${filename}`);
    }
  }
});
