/* ════════════════════════════════════════════════════════
   processor.js  OpenCV.js 処理パイプライン
   Responsibility: 画像処理ロジックのみ。DOM 操作なし
   ════════════════════════════════════════════════════════ */
'use strict';

const LineRemovalProcessor = (() => {

  /* ── Default parameters ─────────────────────────────── */
  const defaultParams = () => ({
    binaryMethod:  'adaptive',
    manualThresh:  128,
    adaptiveBlock: 51,
    adaptiveC:     -5,
    enableHoriz:   true,
    horizLen:      5,
    horizThick:    1,
    horizDilate:   2,
    enableVert:    true,
    vertLen:       5,
    vertThick:     1,
    vertDilate:    2,
    maskDilate:    0,
    outputBase:    'original',
  });

  /* ── Mat helpers ────────────────────────────────────── */
  /**
   * 指定サイズの単チャンネル黒マスクを生成
   * @param {number} rows
   * @param {number} cols
   * @returns {cv.Mat} CV_8UC1
   */
  function zeroMat(rows, cols) {
    return new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
  }

  /**
   * src を RGBA (CV_8UC4) に変換して返す（元の Mat は変更しない）
   * @param {cv.Mat} src
   * @returns {cv.Mat}
   */
  function toRGBA(src) {
    const dst = new cv.Mat();
    if      (src.channels() === 4) src.copyTo(dst);
    else if (src.channels() === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2RGBA);
    else                           cv.cvtColor(src, dst, cv.COLOR_GRAY2RGBA);
    return dst;
  }

  /**
   * src をグレースケール (CV_8UC1) に変換
   * @param {cv.Mat} src
   * @returns {cv.Mat}
   */
  function toGray(src) {
    const dst = new cv.Mat();
    if      (src.channels() === 4) cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
    else if (src.channels() === 3) cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);
    else                           src.copyTo(dst);
    return dst;
  }

  /* ── Step: binarize ─────────────────────────────────── */
  /**
   * グレースケール → 二値化（暗い線 → 白, 背景 → 黒 の反転二値）
   * @param {cv.Mat} gray  CV_8UC1
   * @param {object} p     parameters
   * @returns {cv.Mat}     CV_8UC1 (白=線状暗部, 黒=背景)
   */
  function binarize(gray, p) {
    const dst = new cv.Mat();
    switch (p.binaryMethod) {
      case 'adaptive':
        cv.adaptiveThreshold(
          gray, dst, 255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY_INV,
          p.adaptiveBlock,
          p.adaptiveC
        );
        break;
      case 'manual':
        cv.threshold(gray, dst, p.manualThresh, 255, cv.THRESH_BINARY_INV);
        break;
      default: /* otsu */
        cv.threshold(gray, dst, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    }
    return dst;
  }

  /* ── Step: detect lines ─────────────────────────────── */
  /**
   * モルフォロジー Open（erode→dilate）で線を抽出する
   * @param {cv.Mat} binary  CV_8UC1 反転二値画像
   * @param {number} kw      カーネル幅
   * @param {number} kh      カーネル高さ
   * @param {number} dilIter 追加膨張回数
   * @returns {cv.Mat}       CV_8UC1 線マスク（白=線）
   */
  function detectLines(binary, kw, kh, dilIter) {
    const w   = Math.max(1, kw);
    const h   = Math.max(1, kh);
    const dst  = binary.clone();
    const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h));
    cv.erode (dst, dst, kern);
    cv.dilate(dst, dst, kern);
    kern.delete();
    if (dilIter > 0) {
      const kd = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      for (let i = 0; i < dilIter; i++) cv.dilate(dst, dst, kd);
      kd.delete();
    }
    return dst;
  }

  /* ── Step: build combined mask ──────────────────────── */
  /**
   * 水平・垂直のマスクを合成して最終マスクを返す
   * @param {cv.Mat} binary  CV_8UC1
   * @param {object} p
   * @returns {cv.Mat}       CV_8UC1
   */
  function buildMask(binary, p) {
    const hMask = p.enableHoriz
      ? detectLines(
          binary,
          Math.max(3, Math.round(binary.cols * p.horizLen / 100)),
          p.horizThick,
          p.horizDilate
        )
      : zeroMat(binary.rows, binary.cols);

    const vMask = p.enableVert
      ? detectLines(
          binary,
          p.vertThick,
          Math.max(3, Math.round(binary.rows * p.vertLen / 100)),
          p.vertDilate
        )
      : zeroMat(binary.rows, binary.cols);

    const combined = new cv.Mat();
    cv.bitwise_or(hMask, vMask, combined);
    hMask.delete();
    vMask.delete();

    if (p.maskDilate > 0) {
      const size = p.maskDilate * 2 + 1;
      const kd   = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
      cv.dilate(combined, combined, kd);
      kd.delete();
    }
    return combined;
  }

  /* ── Step: mask overlay visualization ──────────────── */
  /**
   * srcRGBA の上に mask（白=検出線）を赤くハイライトして返す
   * @param {cv.Mat} srcRGBA  CV_8UC4
   * @param {cv.Mat} mask     CV_8UC1
   * @returns {cv.Mat}        CV_8UC4
   */
  function maskToRedOverlay(srcRGBA, mask) {
    const result = srcRGBA.clone();
    const red    = new cv.Mat(srcRGBA.rows, srcRGBA.cols, cv.CV_8UC4,
                    new cv.Scalar(215, 45, 45, 255));
    red.copyTo(result, mask);
    red.delete();
    return result;
  }

  /* ── Step: apply mask → final result ───────────────── */
  /**
   * mask 部分を白で塗りつぶした最終画像を返す
   * @param {cv.Mat} src     元画像（任意チャンネル）
   * @param {cv.Mat} gray    CV_8UC1
   * @param {cv.Mat} binary  CV_8UC1 反転二値
   * @param {cv.Mat} mask    CV_8UC1 線マスク
   * @param {object} p
   * @returns {cv.Mat}       CV_8UC4
   */
  function applyMask(src, gray, binary, mask, p) {
    let base;
    switch (p.outputBase) {
      case 'gray': {
        base = new cv.Mat();
        cv.cvtColor(gray, base, cv.COLOR_GRAY2RGBA);
        break;
      }
      case 'binary': {
        const inv = new cv.Mat();
        cv.bitwise_not(binary, inv);
        base = new cv.Mat();
        cv.cvtColor(inv, base, cv.COLOR_GRAY2RGBA);
        inv.delete();
        break;
      }
      default: /* original */
        base = toRGBA(src);
    }
    const white = new cv.Mat(base.rows, base.cols, cv.CV_8UC4,
                   new cv.Scalar(255, 255, 255, 255));
    white.copyTo(base, mask);
    white.delete();
    return base;
  }

  /* ── Main pipeline ──────────────────────────────────── */
  /**
   * 4 ステップの処理を行い、RGBA Mat の配列を返す
   * @param {HTMLCanvasElement} srcCanvas  入力キャンバス
   * @param {object} p                     parameters
   * @returns {{ mats: cv.Mat[], error: string|null }}
   */
  function process(srcCanvas, p) {
    const result = { mats: [], error: null };
    let src = null;
    try {
      src = cv.imread(srcCanvas);

      /* ─ Step 0: 原画像 ─ */
      result.mats.push(toRGBA(src));

      /* ─ Step 1: グレー + 二値化 ─ */
      const gray   = toGray(src);
      const binary = binarize(gray, p);

      /* 表示用: 反転（白背景・黒線で自然に見える） */
      const binInv  = new cv.Mat();
      cv.bitwise_not(binary, binInv);
      const binRGBA = new cv.Mat();
      cv.cvtColor(binInv, binRGBA, cv.COLOR_GRAY2RGBA);
      binInv.delete();
      result.mats.push(binRGBA);

      /* ─ Step 2: 罫線マスク（赤ハイライト） ─ */
      const mask    = buildMask(binary, p);
      const overlay = maskToRedOverlay(result.mats[0], mask);
      result.mats.push(overlay);

      /* ─ Step 3: 罫線除去結果 ─ */
      result.mats.push(applyMask(src, gray, binary, mask, p));

      /* 内部 Mat 解放 */
      gray.delete();
      binary.delete();
      mask.delete();

    } catch (e) {
      result.error = (e && e.message) ? e.message : String(e);
    } finally {
      if (src) src.delete();
    }
    return result;
  }

  /* ── Render / cleanup ───────────────────────────────── */
  /**
   * Mat をキャンバスに描画する
   * @param {cv.Mat}            mat
   * @param {HTMLCanvasElement} canvas
   */
  function renderToCanvas(mat, canvas) {
    cv.imshow(canvas, mat);
  }

  /**
   * Mat 配列を一括解放する
   * @param {cv.Mat[]} mats
   */
  function cleanupMats(mats) {
    mats.forEach(m => {
      try { if (m && !m.isDeleted()) m.delete(); } catch (_) {}
    });
  }

  return { process, renderToCanvas, cleanupMats, defaultParams };

})();
