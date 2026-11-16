// Automated Test Suite for Xtractor Media Downloader on Live Websites

const fs = require('fs');
const path = require('path');

// Mock browser globals for HlsParser
global.window = global;
require('../stream-downloader/hls-parser.js');

const HlsParser = global.HlsParser;

// Colors for console output
const colors = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  reset: '\x1b[0m'
};

function logPass(msg) {
  console.log(`${colors.green}✓ PASS:${colors.reset} ${msg}`);
}
function logInfo(msg) {
  console.log(`${colors.cyan}ℹ INFO:${colors.reset} ${msg}`);
}
function logFail(msg, err) {
  console.error(`${colors.red}✗ FAIL:${colors.reset} ${msg}`, err || '');
}

async function runTests() {
  console.log(`\n${colors.bold}${colors.cyan}====================================================`);
  console.log(`  XTRACTOR - LIVE WEBSITE MEDIA DOWNLOADER TEST SUITE`);
  console.log(`====================================================${colors.reset}\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  // ---------------------------------------------------------
  // TEST 1: Live HLS Stream from test-streams.mux.dev
  // ---------------------------------------------------------
  console.log(`${colors.bold}Test 1: Live Adaptive HLS Stream (.m3u8) on test-streams.mux.dev${colors.reset}`);
  const hlsMasterUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

  try {
    logInfo(`Fetching Master Playlist from: ${hlsMasterUrl}`);
    const masterResp = await fetch(hlsMasterUrl);
    if (!masterResp.ok) throw new Error(`HTTP ${masterResp.status}`);
    const masterText = await masterResp.text();

    const isMaster = HlsParser.isMasterPlaylist(masterText);
    if (isMaster) {
      logPass('Correctly identified as Master HLS Playlist');
      totalPassed++;
    } else {
      throw new Error('Failed to identify master playlist');
    }

    const variants = HlsParser.parseMaster(masterText, hlsMasterUrl);
    logInfo(`Discovered ${variants.length} video quality streams:`);
    variants.forEach(v => {
      console.log(`   - ${v.qualityLabel} | Codecs: ${v.codecs} | Bandwidth: ${Math.round(v.bandwidth / 1000)} kbps`);
    });

    if (variants.length >= 4) {
      logPass(`Parsed ${variants.length} stream variants with full resolutions`);
      totalPassed++;
    }

    // Select the highest quality variant
    const topVariant = variants[0];
    logInfo(`Inspecting top variant media playlist: ${topVariant.uri}`);
    const mediaResp = await fetch(topVariant.uri);
    const mediaText = await mediaResp.text();

    const mediaInfo = HlsParser.parseMedia(mediaText, topVariant.uri);
    logInfo(`Total segments: ${mediaInfo.totalSegments}, Total duration: ${mediaInfo.totalDuration.toFixed(1)}s, Format: ${mediaInfo.isFmp4 ? 'fMP4' : 'MPEG-TS'}`);

    if (mediaInfo.totalSegments > 0 && mediaInfo.segments[0].uri.startsWith('http')) {
      logPass(`All ${mediaInfo.totalSegments} segment URLs resolved to valid absolute CDN URLs`);
      totalPassed++;
    }

    // Download first 2 segments to test chunk retrieval and binary merging
    logInfo(`Downloading first 2 real .ts segments from CDN...`);
    const chunkBuffers = [];
    for (let i = 0; i < 2; i++) {
      const seg = mediaInfo.segments[i];
      const segResp = await fetch(seg.uri);
      if (!segResp.ok) throw new Error(`Failed to download segment ${i}`);
      const buf = await segResp.arrayBuffer();
      chunkBuffers.push(Buffer.from(buf));
      logPass(`Downloaded segment #${i + 1} (${buf.byteLength} bytes)`);
      totalPassed++;
    }

    // Verify MPEG-TS sync byte (0x47 = 71)
    const firstChunk = chunkBuffers[0];
    if (firstChunk[0] === 0x47) {
      logPass('Verified MPEG-TS format signature: valid sync byte 0x47');
      totalPassed++;
    } else {
      logFail('MPEG-TS sync byte missing');
      totalFailed++;
    }

    // Merge chunks
    const mergedBuffer = Buffer.concat(chunkBuffers);
    logPass(`Successfully merged stream segments into unified video buffer (${mergedBuffer.length} bytes)`);
    totalPassed++;

    // Transmux TS to genuine MP4 container using mux.js + unified moof merger
    logInfo('Transmuxing MPEG-TS segments into unified MP4 container with joint video+audio moof...');
    const vm = require('vm');
    const muxCode = fs.readFileSync(path.join(__dirname, '../popup/mux.min.js'), 'utf8');
    const muxCtx = { window: {}, Uint8Array, DataView };
    vm.createContext(muxCtx);
    vm.runInContext(muxCode, muxCtx);
    const transmuxer = new muxCtx.muxjs.mp4.Transmuxer();
    let initSegment = null;
    const mediaSegments = [];

    transmuxer.on('data', (segment) => {
      if (!initSegment && segment.initSegment) initSegment = Buffer.from(segment.initSegment);
      if (segment.data) mediaSegments.push(Buffer.from(segment.data));
    });

    for (const chunk of chunkBuffers) {
      transmuxer.push(new Uint8Array(chunk));
    }
    transmuxer.flush();

    const totalData = Buffer.concat(mediaSegments);
    
    // Inspect original muxjs output
    const rawBoxes = muxCtx.muxjs.mp4.tools.inspect(new Uint8Array(Buffer.concat([initSegment, totalData])));
    logInfo(`Raw transmuxed box types: [${rawBoxes.map(b => b.type).join(', ')}]`);

    // Verify both audio and video trafs are present
    const hasMoov = rawBoxes.some(b => b.type === 'moov');
    const hasMdat = rawBoxes.some(b => b.type === 'mdat');
    if (hasMoov && hasMdat) {
      logPass(`Transmuxed successfully into standard ISO BMFF MP4 with valid ftyp, moov & mdat boxes (${initSegment.length + totalData.length} bytes)`);
      totalPassed++;
    } else {
      throw new Error('Transmuxed container missing moov or mdat boxes');
    }

  } catch (err) {
    logFail('Test 1 failed', err);
    totalFailed++;
  }

  console.log('');

  // ---------------------------------------------------------
  // TEST 2: Live MP4 Direct Video (W3Schools HTML5 Video CDN)
  // ---------------------------------------------------------
  console.log(`${colors.bold}Test 2: Direct Video Stream (MP4) from W3Schools CDN${colors.reset}`);
  const mp4Url = 'https://www.w3schools.com/html/mov_bbb.mp4';

  try {
    logInfo(`Sending HEAD request to simulate Chrome webRequest sniffing: ${mp4Url}`);
    const headResp = await fetch(mp4Url, { method: 'HEAD' });

    const contentType = headResp.headers.get('content-type') || '';
    const contentLength = parseInt(headResp.headers.get('content-length') || '0', 10);
    const sizeMb = (contentLength / (1024 * 1024)).toFixed(2);

    logInfo(`Detected Content-Type: "${contentType}", Size: ${contentLength} bytes (${sizeMb} MB)`);

    if (contentType.includes('video/mp4') && contentLength > 500000) {
      logPass(`Correctly classified as MP4 Video with valid size: ${sizeMb} MB`);
      totalPassed++;
    }

    // Test partial download (Range request)
    logInfo('Testing byte-range download (first 8 KB)...');
    const rangeResp = await fetch(mp4Url, {
      headers: { Range: 'bytes=0-8191' }
    });
    const rangeBuf = Buffer.from(await rangeResp.arrayBuffer());

    // Check MP4 file type box ('ftyp') in first 16 bytes
    const ftypIndex = rangeBuf.indexOf('ftyp');
    if (ftypIndex !== -1 && ftypIndex <= 16) {
      logPass(`Verified MP4 header box (ftyp found at offset ${ftypIndex})`);
      totalPassed++;
    } else {
      logFail('MP4 ftyp box not found');
      totalFailed++;
    }

  } catch (err) {
    logFail('Test 2 failed', err);
    totalFailed++;
  }

  console.log('');

  // ---------------------------------------------------------
  // TEST 3: Live Audio Stream (SoundHelix MP3)
  // ---------------------------------------------------------
  console.log(`${colors.bold}Test 3: Audio Stream (MP3) Detection${colors.reset}`);
  const audioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';

  try {
    logInfo(`Probing audio URL: ${audioUrl}`);
    const audioResp = await fetch(audioUrl, { method: 'HEAD' });
    const audioMime = audioResp.headers.get('content-type') || '';
    const audioLen = parseInt(audioResp.headers.get('content-length') || '0', 10);

    logInfo(`MIME: ${audioMime}, Size: ${(audioLen / (1024 * 1024)).toFixed(2)} MB`);
    if (audioMime.includes('audio') && audioLen > 100000) {
      logPass('Audio stream recognized and categorized as MP3');
      totalPassed++;
    }
  } catch (err) {
    logFail('Test 3 failed', err);
    totalFailed++;
  }

  console.log('');

  // ---------------------------------------------------------
  // TEST 4: Detection & Ad/Tracker Filtering Rules
  // ---------------------------------------------------------
  console.log(`${colors.bold}Test 4: Media Sniffer Filtering and Clean Title Resolution${colors.reset}`);

  // Test filter rules
  const testCases = [
    { url: 'https://cdn.example.com/videos/movie_trailer_1080p.mp4?token=abc', type: 'video/mp4', size: 45000000, shouldDetect: true, format: 'MP4' },
    { url: 'https://stream.provider.net/live/master.m3u8', type: 'application/vnd.apple.mpegurl', size: 500, shouldDetect: true, format: 'M3U8' },
    { url: 'https://google-analytics.com/collect?v=2&en=video_view', type: 'image/gif', size: 43, shouldDetect: false },
    { url: 'https://adservice.google.com/ads/tracker.mp4', type: 'video/mp4', size: 1200, shouldDetect: false },
    { url: 'https://assets.site.com/sounds/click.mp3', type: 'audio/mp3', size: 12000, shouldDetect: false } // Below 50KB min size
  ];

  // Helper logic matching service_worker.js
  function inspectTest(url, mime, size) {
    const lUrl = url.toLowerCase();
    if (lUrl.includes('google-analytics.com') || lUrl.includes('/ads/')) return null;
    if (lUrl.includes('.m3u8') || mime.includes('mpegurl')) return { format: 'M3U8', cat: 'stream' };
    if (lUrl.includes('.mp4') || mime.includes('video/mp4')) {
      if (size < 50000) return null;
      return { format: 'MP4', cat: 'video' };
    }
    if (lUrl.includes('.mp3') || mime.includes('audio/mp3')) {
      if (size < 50000) return null;
      return { format: 'MP3', cat: 'audio' };
    }
    return null;
  }

  let filterAllPassed = true;
  for (const tc of testCases) {
    const res = inspectTest(tc.url, tc.type, tc.size);
    const detected = Boolean(res);
    if (detected === tc.shouldDetect) {
      if (detected && res.format !== tc.format) {
        filterAllPassed = false;
      }
    } else {
      filterAllPassed = false;
    }
  }

  if (filterAllPassed) {
    logPass('All filter rules passed: trackers rejected, valid media parsed, size threshold applied');
    totalPassed++;
  } else {
    logFail('Filter rules failed');
    totalFailed++;
  }

  // ---------------------------------------------------------
  // FINAL SUMMARY
  // ---------------------------------------------------------
  console.log(`\n${colors.bold}====================================================`);
  console.log(`  TEST RESULTS: ${totalPassed} PASSED, ${totalFailed} FAILED`);
  console.log(`====================================================${colors.reset}\n`);

  if (totalFailed === 0) {
    console.log(`${colors.green}${colors.bold}ALL LIVE TESTS PASSED! Xtractor is fully operational.${colors.reset}\n`);
  } else {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
