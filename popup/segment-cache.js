/**
 * Xtractor Persistent Segment Cache (IndexedDB)
 * 
 * Stores downloaded HLS segment chunks safely on disk so:
 * 1. Closing the popup NEVER loses downloaded segments.
 * 2. Downloads can resume instantaneously without re-fetching from segment 0.
 * 3. Chunks are shared seamlessly between popup, background workers, and downloader tabs.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SegmentCache = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'XtractorMediaDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'segment_chunks';

  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          return resolve(null);
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('streamUrl', 'streamUrl', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          console.warn('[SegmentCache] indexedDB open error:', req.error);
          resolve(null);
        };
      });
    }
    return dbPromise;
  }

  function makeKey(streamUrl, index) {
    return `${streamUrl}#seg#${index}`;
  }

  async function saveCachedSegment(streamUrl, index, buffer) {
    try {
      const db = await getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
          key: makeKey(streamUrl, index),
          streamUrl,
          index: Number(index),
          buffer,
          timestamp: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      console.warn('[SegmentCache] save error:', e);
      return false;
    }
  }

  async function getCachedSegment(streamUrl, index) {
    try {
      const db = await getDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(makeKey(streamUrl, index));
        req.onsuccess = () => resolve(req.result ? req.result.buffer : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function getAllCachedSegments(streamUrl) {
    try {
      const db = await getDB();
      if (!db) return new Map();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const idx = store.index('streamUrl');
        const req = idx.getAll(IDBKeyRange.only(streamUrl));
        req.onsuccess = () => {
          const results = req.result || [];
          const map = new Map();
          for (const item of results) {
            map.set(item.index, item.buffer);
          }
          resolve(map);
        };
        req.onerror = () => resolve(new Map());
      });
    } catch (e) {
      return new Map();
    }
  }

  async function getCachedSegmentCount(streamUrl) {
    try {
      const db = await getDB();
      if (!db) return 0;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const idx = store.index('streamUrl');
        const req = idx.count(IDBKeyRange.only(streamUrl));
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      });
    } catch (e) {
      return 0;
    }
  }

  async function clearCachedSegmentsForStream(streamUrl) {
    try {
      const db = await getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const idx = store.index('streamUrl');
        const req = idx.getAllKeys(IDBKeyRange.only(streamUrl));
        req.onsuccess = () => {
          const keys = req.result || [];
          for (const k of keys) {
            store.delete(k);
          }
          resolve(true);
        };
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  async function cleanOldSegmentCaches() {
    try {
      const db = await getDB();
      if (!db) return false;
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const idx = store.index('timestamp');
        const req = idx.openCursor(IDBKeyRange.upperBound(oneDayAgo));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve(true);
          }
        };
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  // Automatically purge caches older than 24 hours on initialization
  cleanOldSegmentCaches().catch(() => {});

  return {
    saveCachedSegment,
    getCachedSegment,
    getAllCachedSegments,
    getCachedSegmentCount,
    clearCachedSegmentsForStream,
    cleanOldSegmentCaches
  };
});
