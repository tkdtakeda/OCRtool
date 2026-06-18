/* ════════════════════════════════════════════════════════
   db.js  IndexedDB 永続化レイヤー
   Responsibility: 帳票レイアウト(forms)とOCR結果(results)の永続化のみ。
                   DOM 操作・業務ロジックは持たない。
   ────────────────────────────────────────────────────────
   ストア:
     forms   … 登録工程で作成した帳票レイアウト（基準画像・識別アンカー・
               OCR領域・OCR設定・罫線除去パラメータ）
     results … OCR工程の認識結果（帳票判定・確信度・フィールド別信頼度）
   ════════════════════════════════════════════════════════ */
'use strict';

const FormDB = (() => {

  const DB_NAME    = 'chouhyou_ocr';
  const DB_VERSION = 2;
  const STORE_FORMS   = 'forms';
  const STORE_RESULTS = 'results';
  const STORE_PRESETS = 'presets';

  let _dbPromise = null;

  /* ── オープン（スキーマ定義） ───────────────────────── */
  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('このブラウザは IndexedDB に対応していません'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_FORMS)) {
          const s = db.createObjectStore(STORE_FORMS, { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt', { unique: false });
          s.createIndex('name',      'name',      { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_RESULTS)) {
          const r = db.createObjectStore(STORE_RESULTS, { keyPath: 'id' });
          r.createIndex('createdAt', 'createdAt', { unique: false });
          r.createIndex('formId',    'formId',    { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PRESETS)) {
          const pr = db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
          pr.createIndex('createdAt', 'createdAt', { unique: false });
          pr.createIndex('name',      'name',      { unique: false });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = () => reject(req.error || new Error('IndexedDB を開けませんでした'));
    });
    return _dbPromise;
  }

  /* ── 汎用 tx ヘルパー ───────────────────────────────── */
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t  = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      const r = fn(os);
      if (r !== undefined) {
        r.onsuccess = () => { result = r.result; };
        r.onerror   = () => reject(r.error);
      }
      t.oncomplete = () => resolve(result);
      t.onerror    = () => reject(t.error);
      t.onabort    = () => reject(t.error);
    });
  }

  function getAllFromStore(store, indexName, direction = 'prev', limit = 0) {
    return open().then(db => new Promise((resolve, reject) => {
      const t   = db.transaction(store, 'readonly');
      const os  = t.objectStore(store);
      const src = indexName ? os.index(indexName) : os;
      const out = [];
      const req = src.openCursor(null, indexName ? direction : 'next');
      req.onsuccess = e => {
        const cur = e.target.result;
        if (cur && (limit === 0 || out.length < limit)) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    }));
  }

  /* ── forms ──────────────────────────────────────────── */
  function putForm(form) {
    form.updatedAt = Date.now();
    if (!form.createdAt) form.createdAt = form.updatedAt;
    return tx(STORE_FORMS, 'readwrite', os => os.put(form)).then(() => form);
  }
  function getForm(id)    { return tx(STORE_FORMS, 'readonly', os => os.get(id)); }
  function getAllForms()  { return getAllFromStore(STORE_FORMS, 'updatedAt', 'prev'); }
  function deleteForm(id) { return tx(STORE_FORMS, 'readwrite', os => os.delete(id)); }
  function clearForms()   { return tx(STORE_FORMS, 'readwrite', os => os.clear()); }

  /* ── results ────────────────────────────────────────── */
  function putResult(result) {
    if (!result.createdAt) result.createdAt = Date.now();
    return tx(STORE_RESULTS, 'readwrite', os => os.put(result)).then(() => result);
  }
  function getAllResults(limit = 50) { return getAllFromStore(STORE_RESULTS, 'createdAt', 'prev', limit); }
  function deleteResult(id)          { return tx(STORE_RESULTS, 'readwrite', os => os.delete(id)); }
  function clearResults()            { return tx(STORE_RESULTS, 'readwrite', os => os.clear()); }

  /* ── presets（OCR/罫線除去設定のプリセット） ────────── */
  function putPreset(p) {
    if (!p.createdAt) p.createdAt = Date.now();
    return tx(STORE_PRESETS, 'readwrite', os => os.put(p)).then(() => p);
  }
  function getAllPresets() { return getAllFromStore(STORE_PRESETS, 'createdAt', 'prev'); }
  function deletePreset(id) { return tx(STORE_PRESETS, 'readwrite', os => os.delete(id)); }

  /* ── Public API ─────────────────────────────────────── */
  return {
    open,
    putForm, getForm, getAllForms, deleteForm, clearForms,
    putResult, getAllResults, deleteResult, clearResults,
    putPreset, getAllPresets, deletePreset,
  };

})();
