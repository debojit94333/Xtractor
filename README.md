# Xtractor - Universal Video & Stream Downloader Extension

**Xtractor** is a modern, high-performance browser extension (Manifest V3) inspired by tools like **Vidow** (`app.vidow.io` / Video Downloader Plus). It detects, sniffs, previews, and downloads video, audio, and adaptive HLS streams (`.m3u8`) across the web.

---

## 🚀 Key Features

* **Universal Media Detection**:
  * **Video**: MP4, WebM, MKV, MOV, FLV, AVI, etc.
  * **Audio**: MP3, AAC, WAV, M4A, OGG.
  * **Adaptive Streams**: HLS (`.m3u8`) and DASH (`.mpd`).
* **Multi-Layer Sniffing**:
  * **Network Layer**: Passive header inspection via `chrome.webRequest` capturing direct CDN media URLs and streams.
  * **Page Context Interceptor**: Injected at `document_start` to intercept `window.fetch` and `XMLHttpRequest` calls from custom web players (Video.js, Hls.js, Plyr, JWPlayer, etc.).
  * **DOM & Mutation Observer**: Live inspection of `<video>`, `<audio>`, `<source>`, and dynamically mounted players (e.g. SPAs, infinite scroll feeds).
* **CocoCut Pro Features**:
  * **Force Download Mode**: Deep shadow-DOM and iframe probing for custom, protected, or obfuscated players when standard sniffing fails.
  * **Recording Mode Studio**: Direct buffer capture engine with **Turbo Acceleration (2x, 4x, 8x, 16x)** to record and save videos in seconds.
  * **Batch Download**: One-click "Download All" for pages with multiple media files.
* **Integrated Stream Downloader Studio (HLS / M3U8)**:
  * Master Playlist parsing with quality variant selection (1080p, 720p, 480p, 360p, Audio-only).
  * Multi-threaded concurrent chunk fetcher (up to 8 parallel connections) with automatic retry logic.
  * Native AES-128 stream decryption using the browser's Web Crypto API.
  * In-browser segment concatenation and remuxing into a single, seamless video file (`.mp4` / `.ts`).
  * Real-time download progress bar, speed meter (MB/s), ETA, and visual segment map.
* **Modern Dark-Mode Popup UI**:
  * Real-time media counter badge on extension icon.
  * In-popup video preview player with full playback controls.
  * Instant search and category filter tabs (All, Video, Streams, Audio).
  * Quick 1-click download and clipboard URL copying.
* **Configurable Preferences**:
  * Customizable minimum file size filter (suppresses ad clips and audio pings).
  * Custom download subfolder name.
  * Parallel connection tuning.

---

## 📦 How to Install (Chrome, Edge, Brave, Opera)

1. Open your browser and navigate to the extensions management page:
   * **Chrome / Brave**: `chrome://extensions`
   * **Microsoft Edge**: `edge://extensions`
2. Turn on **Developer mode** (toggle in the top-right or sidebar).
3. Click the **Load unpacked** button.
4. Select the project folder:
   ```
   C:\Users\deboj\projects\Xtractor
   ```
5. The **Xtractor** icon will appear in your browser extensions bar. Pin it to your toolbar for easy access!

---

## 🛠️ Usage Guide

### 1. Downloading Standard Videos (MP4, WebM, MP3)
1. Open any webpage with media content.
2. Play the video or scroll to let the player load.
3. The Xtractor badge on the extension icon will display the count of detected media files (e.g. `1`, `3`).
4. Click the Xtractor icon to open the popup:
   * Click **Preview** to watch the video directly inside the popup.
   * Click **Download** to trigger an instant browser download.
   * Click **Copy** to copy the raw media link.

### 2. Downloading HLS Streams (`.m3u8`)
1. When browsing a video stream that uses HLS, Xtractor will highlight it with a pink **M3U8 / Stream** badge.
2. Click **HLS Downloader** on that item.
3. This opens the **Xtractor Stream Studio** tab with the stream pre-loaded:
   * Select your preferred resolution (e.g. 1080p, 720p).
   * Adjust parallel connections if desired.
   * Click **Start Stream Download & Merge**.
4. Watch the real-time segment download map and metrics.
5. Once complete, preview the merged video and click **Save Merged Video File** to save your video!

---

## 🧪 Testing the Extension

A built-in test sandbox is included:

1. **Option A (Direct File)**:
   * Double-click `test-page/test.html` or drag it into Chrome.
2. **Option B (Local Web Server)**:
   * Open a terminal in this directory and run:
     ```bash
     node test-page/test-server.js
     ```
   * Open `http://localhost:3000/` in your browser.
3. Test standard MP4 playback, MP3 audio, public HLS streams, and dynamically injected players.

---

## 📂 Project Architecture

```
Xtractor/
├── manifest.json              # Manifest V3 extension configuration
├── icons/                     # Crisp icons (16px, 32px, 48px, 128px)
├── background/
│   └── service_worker.js      # Network sniffing, tab media mapping, download manager
├── content/
│   ├── interceptor.js         # MAIN world fetch/XHR hook for streaming manifests
│   └── detector.js            # ISOLATED world DOM scanner & MutationObserver
├── popup/
│   ├── popup.html             # Modern popup UI with category tabs & search
│   ├── popup.css              # Dark mode styling with glowing accents
│   └── popup.js               # Popup interactions, preview player, download trigger
├── stream-downloader/
│   ├── downloader.html        # Full-page Stream Studio workspace
│   ├── downloader.css         # Stream Studio dashboard styling & segment map
│   ├── downloader.js          # Multi-worker chunk fetcher & progress engine
│   └── hls-parser.js          # M3U8 master/media parser & AES-128 decryptor
├── options/
│   ├── options.html           # Preferences page
│   ├── options.css            # Settings UI styling
│   └── options.js             # Storage synchronizer
├── test-page/
│   ├── test.html              # Multi-format media sandbox
│   └── test-server.js         # Local HTTP server for sandbox testing
└── README.md
```
