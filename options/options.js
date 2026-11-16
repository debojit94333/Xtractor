// Xtractor Options Controller

document.addEventListener('DOMContentLoaded', () => {
  const minSizeInput = document.getElementById('minSizeInput');
  const detectAudioToggle = document.getElementById('detectAudioToggle');
  const detectStreamsToggle = document.getElementById('detectStreamsToggle');
  const subfolderInput = document.getElementById('subfolderInput');
  const maxConnectionsSelect = document.getElementById('maxConnectionsSelect');
  const btnSave = document.getElementById('btnSave');
  const btnReset = document.getElementById('btnReset');
  const optToast = document.getElementById('optToast');

  const defaultSettings = {
    minVideoSizeKb: 50,
    detectAudio: true,
    detectStreams: true,
    downloadSubfolder: 'Xtractor',
    maxHlsConnections: 4
  };

  function showToast(msg) {
    optToast.textContent = msg;
    optToast.classList.add('show');
    setTimeout(() => {
      optToast.classList.remove('show');
    }, 2000);
  }

  // Load existing settings
  chrome.storage.local.get(['xtractorSettings'], (result) => {
    const settings = { ...defaultSettings, ...(result.xtractorSettings || {}) };
    minSizeInput.value = settings.minVideoSizeKb;
    detectAudioToggle.checked = settings.detectAudio;
    detectStreamsToggle.checked = settings.detectStreams;
    subfolderInput.value = settings.downloadSubfolder;
    maxConnectionsSelect.value = String(settings.maxHlsConnections);
  });

  // Save Settings
  btnSave.addEventListener('click', () => {
    const newSettings = {
      minVideoSizeKb: parseInt(minSizeInput.value, 10) || 50,
      detectAudio: detectAudioToggle.checked,
      detectStreams: detectStreamsToggle.checked,
      downloadSubfolder: subfolderInput.value.trim() || 'Xtractor',
      maxHlsConnections: parseInt(maxConnectionsSelect.value, 10) || 4
    };

    chrome.storage.local.set({ xtractorSettings: newSettings }, () => {
      showToast('Settings saved successfully!');
    });
  });

  // Restore Defaults
  btnReset.addEventListener('click', () => {
    minSizeInput.value = defaultSettings.minVideoSizeKb;
    detectAudioToggle.checked = defaultSettings.detectAudio;
    detectStreamsToggle.checked = defaultSettings.detectStreams;
    subfolderInput.value = defaultSettings.downloadSubfolder;
    maxConnectionsSelect.value = String(defaultSettings.maxHlsConnections);

    chrome.storage.local.set({ xtractorSettings: defaultSettings }, () => {
      showToast('Restored default settings');
    });
  });
});
