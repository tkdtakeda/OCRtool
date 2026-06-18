/* ════════════════════════════════════════════════════════
   ocr.js  Tesseract.js OCR ラッパー
   Responsibility: OCR処理ロジックのみ。DOM操作・UI状態管理は持たない
   ════════════════════════════════════════════════════════ */
'use strict';

const OcrProcessor = (() => {

  /* ── CDN paths (file:// 対応・明示指定) ─────────────── */
  const CDN = {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/worker.min.js',
    langPath:   'https://tessdata.projectnaptha.com/4.0.0',
    corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@4/tesseract-core-simd.wasm.js',
  };

  /* ── ステータス日本語マップ ──────────────────────────── */
  const STATUS_JA = [
    ['loading tesseract core',       'OCRエンジンを読み込み中…'],
    ['loading language traineddata', '言語データを読み込み中… (初回は数十秒かかります)'],
    ['initializing api',             'OCRを初期化中…'],
    ['initializing tesseract',       'OCRを初期化中…'],
    ['recognizing text',             'テキストを認識中…'],
  ];

  let _worker = null;
  let _ready  = false;
  let _lang   = 'eng';
  let _logCb  = () => {};

  /* ── Worker 初期化（初回 / 言語変更時のみ実行） ─────── */
  async function ensureWorker(lang) {
    const want = lang || 'eng';
    if (_ready && _lang === want) return;
    if (!_worker) {
      _worker = await Tesseract.createWorker({
        ...CDN,
        logger: m => _logCb(m),
      });
    }
    /* 'eng' / 'jpn' / 'jpn+eng' などをまとめて読み込み・初期化 */
    await _worker.loadLanguage(want);
    await _worker.initialize(want);
    _lang  = want;
    _ready = true;
  }

  function toJa(raw) {
    if (!raw) return '処理中…';
    for (const [key, msg] of STATUS_JA) {
      if (raw.includes(key)) return msg;
    }
    return raw;
  }

  /* ── Public: recognize ──────────────────────────────── */
  /**
   * Canvas に対して OCR を実行する
   * @param {HTMLCanvasElement} canvas     対象キャンバス
   * @param {number}            psm        Page Segmentation Mode (3=auto, 6=block, 7=line)
   * @param {Function}          onProgress ({ status: string, progress: number }) => void
   * @returns {Promise<{
   *   fullText: string,
   *   words:    Array<{ text: string, confidence: number, bbox: object }>,
   *   error:    string|null
   * }>}
   */
  async function recognize(canvas, psm, onProgress, lang) {
    /* ログコールバックを更新（ensureWorker 呼び出し前に設定） */
    _logCb = m => {
      if (typeof onProgress === 'function') {
        onProgress({ status: toJa(m.status), progress: m.progress || 0 });
      }
    };

    try {
      await ensureWorker(lang);
      await _worker.setParameters({ tessedit_pageseg_mode: String(psm) });

      const { data } = await _worker.recognize(canvas);

      const words = (data.words || [])
        .filter(w => w.text && w.text.trim())
        .map(w => ({
          text:       w.text.trim(),
          confidence: Math.round(w.confidence),
          bbox:       w.bbox,
        }));

      return { fullText: data.text || '', words, error: null };

    } catch (e) {
      return {
        fullText: '',
        words:    [],
        error:    (e && e.message) ? e.message : String(e),
      };
    }
  }

  /* ── Public: terminate ──────────────────────────────── */
  /**
   * Worker を終了して解放する（ページ離脱時などに使用）
   */
  async function terminate() {
    if (_worker) {
      try { await _worker.terminate(); } catch (_) {}
      _worker = null;
      _ready  = false;
    }
  }

  return { recognize, terminate };

})();
