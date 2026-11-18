// Xtractor HLS / M3U8 Stream Parser and Processor
// Handles master playlists, media playlists, URL resolution, and AES-128 decryption.

class HlsParser {
  // Resolve relative URLs correctly against a base URL
  static resolveUrl(relativeUrl, baseUrl) {
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
      return relativeUrl;
    }
  }

  // Check whether M3U8 is a master playlist or media playlist
  static isMasterPlaylist(content) {
    if (!content) return false;
    // A media playlist always contains #EXTINF tags; a master playlist never does (RFC 8216)
    if (content.includes('#EXTINF')) return false;
    return content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:') || content.includes('#EXT-X-SUBTITLES');
  }

  // Parse Master Playlist
  static parseMaster(content, baseUrl) {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const variants = [];
    const audioGroups = new Map();

    // 1. Extract separate audio renditions (#EXT-X-MEDIA:TYPE=AUDIO)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        const groupMatch = line.match(/GROUP-ID="([^"]+)"/i);
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const isDefault = line.includes('DEFAULT=YES') || line.includes('AUTOSELECT=YES');
        if (groupMatch && uriMatch) {
          const gId = groupMatch[1];
          const audioUri = this.resolveUrl(uriMatch[1], baseUrl);
          if (!audioGroups.has(gId) || isDefault) {
            audioGroups.set(gId, audioUri);
          }
        }
      }
    }

    // 2. Extract video stream variants (#EXT-X-STREAM-INF)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const infoStr = line.substring('#EXT-X-STREAM-INF:'.length);
        const nextLine = lines[i + 1] || '';

        if (nextLine && !nextLine.startsWith('#')) {
          const uri = this.resolveUrl(nextLine, baseUrl);
          
          // Parse bandwidth
          const bwMatch = infoStr.match(/BANDWIDTH=(\d+)/i);
          const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

          // Parse resolution
          const resMatch = infoStr.match(/RESOLUTION=(\d+x\d+)/i);
          const resolution = resMatch ? resMatch[1] : null;

          // Parse codecs
          const codecMatch = infoStr.match(/CODECS="([^"]+)"/i);
          const codecs = codecMatch ? codecMatch[1] : '';

          // Parse matching audio group URI
          const audioGroupMatch = infoStr.match(/AUDIO="([^"]+)"/i);
          let audioUri = null;
          if (audioGroupMatch && audioGroups.has(audioGroupMatch[1])) {
            audioUri = audioGroups.get(audioGroupMatch[1]);
          } else if (audioGroups.size > 0) {
            audioUri = Array.from(audioGroups.values())[0];
          }

          // Generate human readable quality label
          let qualityLabel = 'Default Stream';
          if (resolution) {
            const height = resolution.split('x')[1];
            qualityLabel = `${height}p (${resolution})`;
          } else if (bandwidth > 0) {
            qualityLabel = `${Math.round(bandwidth / 1000)} kbps`;
          }

          variants.push({
            uri,
            audioUri,
            bandwidth,
            resolution,
            codecs,
            qualityLabel,
            rawInfo: infoStr
          });
        }
      }
    }

    // Sort variants by bandwidth descending
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants;
  }

  // Parse Media Playlist
  static parseMedia(content, baseUrl) {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const segments = [];
    let initSegmentUri = null;
    let keyInfo = null;
    let totalDuration = 0;
    let currentDuration = 0;
    let currentTitle = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Fragmented MP4 Init Segment (#EXT-X-MAP:URI="init.mp4")
      if (line.startsWith('#EXT-X-MAP:')) {
        const uriMatch = line.match(/URI="([^"]+)"/i);
        if (uriMatch) {
          initSegmentUri = this.resolveUrl(uriMatch[1], baseUrl);
        }
      }

      // AES-128 Encryption Key (#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x...)
      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);

        if (methodMatch && methodMatch[1] === 'AES-128' && uriMatch) {
          keyInfo = {
            method: 'AES-128',
            keyUri: this.resolveUrl(uriMatch[1], baseUrl),
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      }

      // Segment duration: #EXTINF:10.000, or #EXTINF:9.009,title
      if (line.startsWith('#EXTINF:')) {
        const parts = line.substring('#EXTINF:'.length).split(',');
        currentDuration = parseFloat(parts[0]) || 0;
        currentTitle = parts[1] || '';
      } else if (!line.startsWith('#')) {
        // Any non-empty line not starting with '#' is a media segment in HLS media playlists
        const segmentUri = this.resolveUrl(line, baseUrl);
        const segDur = currentDuration > 0 ? currentDuration : 6;
        segments.push({
          index: segments.length,
          uri: segmentUri,
          duration: segDur,
          title: currentTitle
        });
        totalDuration += segDur;
        currentDuration = 0;
        currentTitle = '';
      }
    }

    const isFmp4 = Boolean(initSegmentUri || (segments[0] && segments[0].uri.includes('.m4s')));

    return {
      isFmp4,
      initSegmentUri,
      keyInfo,
      totalDuration,
      totalSegments: segments.length,
      segments
    };
  }

  // Decrypt AES-128 HLS chunk using browser Web Crypto API
  static async decryptChunk(encryptedBuffer, keyBuffer, ivBuffer) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      return await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivBuffer },
        cryptoKey,
        encryptedBuffer
      );
    } catch (e) {
      console.error('Decryption failed for segment:', e);
      throw e;
    }
  }
}

// Export for browser
window.HlsParser = HlsParser;
