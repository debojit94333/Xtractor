# Xtractor - Store Listing & Permission Justifications

Use this document when submitting **Xtractor** to the **Chrome Web Store Developer Dashboard** or **Microsoft Edge Partner Center**.

---

## 1. Extension Information

* **Name**: Xtractor - Video & Stream Downloader
* **Short Description**: Detect, preview, and download videos, audio, and HLS (.m3u8) streams from websites with built-in merger.
* **Category**: Productivity / Photos & Video

---

## 2. Chrome Web Store Permission Justifications

Chrome Web Store reviewers require explanations for host permissions and sensitive APIs:

### Host Permission (`<all_urls>`)
> **Reviewer Explanation**:
> "Xtractor is a universal media detector that sniffs video and audio streams embedded across arbitrary user-visited websites. To detect media players, HLS streaming manifests (.m3u8), and video files that the user wishes to download from any site they choose to browse, the extension requires access to inspect media requests across web origins."

### `webRequest` Permission
> **Reviewer Explanation**:
> "The webRequest API is used in passive observation mode to inspect HTTP response headers (Content-Type and Content-Length). This allows the extension to identify video MIME types (e.g., video/mp4, video/webm, application/x-mpegurl) and calculate file sizes before the user initiates a download."

### `downloads` Permission
> **Reviewer Explanation**:
> "Required to initiate the file download of detected video files, audio files, and merged HLS stream files directly to the user's local Downloads folder."

### `storage` Permission
> **Reviewer Explanation**:
> "Used locally to store user preferences such as minimum file size threshold filter, parallel connection counts, and download subfolder preferences."

---

## 3. Single Purpose Description
> "The single purpose of Xtractor is to allow users to detect, preview, and download video and audio media files and adaptive HLS streams from web pages they visit."

---

## 4. Privacy & Data Handling Declarations

In the Developer Dashboard under **Privacy Practices**:
* **Does this extension collect user data?** No.
* **Does this extension transmit user data to any remote server?** No. All network sniffing, stream chunk assembly, and AES-128 decryption execute 100% locally on the user's device.
* **Are you using remote code?** No. All code is bundled locally within the extension package.
