/* 儲存層：IndexedDB（容量大、非同步不卡頁面）。啟動時一次讀進記憶體，之後寫入在背景進行 */
(function () {
  const LW = (window.LW = window.LW || {});

  LW.KEYS = { config: 'lw.config', records: 'lw.records', overlayConfig: 'lw.overlayConfig', skipAnim: 'lw.skipAnim', prizeList: 'lw.prizeList', meta: 'lw.meta', excelHandle: 'excelHandle' };

  const idb = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('lucky-wheel', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  };

  const Store = {
    cache: new Map(),
    onError: null, // (err) => void
    async init(keys) {
      for (const k of keys) {
        let v;
        try { v = await idb.get(k); } catch { v = undefined; }
        if (v === undefined) { // 從舊版 localStorage 搬移
          try { const raw = localStorage.getItem(k); if (raw) { v = JSON.parse(raw); await idb.set(k, v); localStorage.removeItem(k); } } catch { /* ignore */ }
        }
        if (v !== undefined) this.cache.set(k, v);
      }
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
    },
    get(k, fb) { return this.cache.has(k) ? this.cache.get(k) : fb; },
    set(k, v) {
      this.cache.set(k, v);
      idb.set(k, JSON.parse(JSON.stringify(v))).catch((e) => { if (this.onError) this.onError(e); });
      return true;
    },
  };

  LW.idb = idb;
  LW.Store = Store;
})();
