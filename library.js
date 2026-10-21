/* Library of finished recordings on this device (IndexedDB).
   One entry per recording: title, parts (audio blobs), transcript, status.
   Audio is removed after AUDIO_DAYS, transcripts are kept. */
(function () {
  'use strict';

  const DB = 'm4asplit', VERSION = 2, ENTRIES = 'entries', OLD = 'session';
  const AUDIO_DAYS = 30;

  function open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('No IndexedDB'));
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(OLD)) db.createObjectStore(OLD);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(store, mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function get(id) { return tx(ENTRIES, 'readonly', (s) => s.get(id)).catch(() => null); }
  function put(entry) { return tx(ENTRIES, 'readwrite', (s) => s.put(entry)); }
  function remove(id) { return tx(ENTRIES, 'readwrite', (s) => s.delete(id)); }
  async function list() {
    const all = (await tx(ENTRIES, 'readonly', (s) => s.getAll()).catch(() => [])) || [];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Coalesce rapid saves of the same entry (one per finished part) into one write.
  const timers = {};
  function save(entry) {
    clearTimeout(timers[entry.id]);
    return new Promise((resolve) => {
      timers[entry.id] = setTimeout(() => {
        put({ ...entry, updatedAt: Date.now() }).then(resolve, (e) => { console.warn('Library save failed', e); resolve(); });
      }, 150);
    });
  }

  async function removeAudio(id) {
    const e = await get(id);
    if (!e) return;
    e.parts = e.parts.map((p) => ({ ...p, blob: null }));
    e.audioRemoved = true;
    await put(e);
  }

  // Drop audio of entries older than AUDIO_DAYS. Returns how many were cleaned.
  async function cleanup(now = Date.now()) {
    const cutoff = now - AUDIO_DAYS * 864e5;
    let n = 0;
    for (const e of await list()) {
      if (!e.audioRemoved && e.createdAt < cutoff) { await removeAudio(e.id); n++; }
    }
    return n;
  }

  // One-time move of the single saved session from the previous version.
  async function migrate() {
    const old = await tx(OLD, 'readonly', (s) => s.get('current')).catch(() => null);
    if (!old || !old.files) return [];
    const ids = [];
    for (const f of old.files) {
      const id = newId();
      await put({
        id, title: f.name.replace(/\.[^.]+$/, ''), name: f.name, mode: f.mode, aac: f.aac,
        createdAt: old.savedAt || Date.now(), updatedAt: Date.now(),
        duration: f.parts.length ? f.parts[f.parts.length - 1].end : 0, parts: f.parts,
      });
      ids.push(id);
    }
    await tx(OLD, 'readwrite', (s) => s.delete('current'));
    return ids;
  }

  async function usage() {
    try {
      const est = await navigator.storage.estimate();
      return est.usage || 0;
    } catch (e) {
      return null;
    }
  }

  // Ask the browser not to evict the library under storage pressure.
  async function persist() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch (e) { /* not supported */ }
  }

  window.Library = { AUDIO_DAYS, newId, get, put, save, remove, list, removeAudio, cleanup, migrate, usage, persist };
})();
