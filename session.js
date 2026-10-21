/* Saves the current parts and transcripts on this device (IndexedDB), so a reload,
   a crash or Android killing the tab does not lose finished work. */
(function () {
  'use strict';

  const DB = 'm4asplit', STORE = 'session', KEY = 'current';

  function open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('No IndexedDB'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  // Only plain data and Blobs go in; IndexedDB stores Blobs natively.
  function snapshot(files) {
    return {
      savedAt: Date.now(),
      files: files.filter((f) => f.parts && f.parts.length).map((f) => ({
        name: f.name, mode: f.mode, aac: !!f.aac,
        parts: f.parts.map((p) => ({
          index: p.index, start: p.start, end: p.end, snapped: p.snapped, blob: p.blob, size: p.size,
          name: p.name, lufs: p.lufs, transcript: p.transcript || null, tStatus: p.tStatus === 'done' ? 'done' : null,
        })),
      })),
    };
  }

  let pending = null;
  // Coalesce rapid saves (one per finished part) into one write.
  function save(files) {
    clearTimeout(pending);
    return new Promise((resolve) => {
      pending = setTimeout(() => {
        const snap = snapshot(files);
        const op = snap.files.length ? (s) => s.put(snap, KEY) : (s) => s.delete(KEY);
        run('readwrite', op).then(resolve, (e) => { console.warn('Session save failed', e); resolve(); });
      }, 150);
    });
  }

  function load() {
    return run('readonly', (s) => s.get(KEY)).catch(() => null);
  }

  function clear() {
    clearTimeout(pending);
    return run('readwrite', (s) => s.delete(KEY)).catch(() => {});
  }

  window.Session = { save, load, clear };
})();
