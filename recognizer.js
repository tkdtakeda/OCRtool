/* ════════════════════════════════════════════════════════
   recognizer.js  認識パイプライン（OCR工程）
   Responsibility: 登録済み帳票に対する
     ① 全アンカー一括マッチング
     ② 帳票自動判定（FormVoting）
     ③ 傾き補正（回転）
     ④ 原点の再ローカライズ（平行移動量の確定）
     ⑤ 罫線除去（登録パラメータを引き継ぎ）
     ⑥ OCR領域ごとの認識
   を順に実行する。DOM は触らず、進捗は callback で通知する。
   ════════════════════════════════════════════════════════ */
'use strict';

const Recognizer = (() => {

  function dataURLtoImg(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error('画像の読み込みに失敗しました'));
      img.src = url;
    });
  }

  /** 帳票配列から「全アンカー」を matcher 用テンプレート配列へ展開 */
  async function buildAnchorTemplates(forms) {
    const list = [];
    for (const form of forms) {
      for (const a of (form.anchors || [])) {
        list.push({ id: a.id, imageElement: await dataURLtoImg(a.dataURL) });
      }
    }
    return list;
  }

  /**
   * マッチング + 自動判定のみを実行（採用前に結果を提示するため分離）。
   * @returns {{ decision, scores: Map, forms }}
   */
  async function classify(sourceCanvas, forms, opts = {}) {
    const angleRange = opts.angleRange ?? 2;
    const angleStep  = opts.angleStep  ?? 1;
    const tpls   = await buildAnchorTemplates(forms);
    const scores = MatcherEngine.matchAll(sourceCanvas, tpls, { angleRange, angleStep });
    const decision = FormVoting.decide(forms, scores, opts.voting || {});
    return { decision, scores };
  }

  /**
   * 確定した帳票に対して 傾き補正 → 罫線除去 → OCR を実行する。
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {object} form            採用された帳票レイアウト
   * @param {object} matchInfo       { angle, anchorId, loc } 判定結果の best
   * @param {object} cb              { onStage(name,pct), onOcr(i,total,name,status,pct) }
   * @returns {Promise<{
   *   angle, translation, resultCanvas, previewMats, fields:Array, error
   * }>}
   */
  /**
   * 傾き補正 → 原点再ローカライズ → 罫線除去 までを実行（OCR は行わない）。
   * PSM 比較など「同じ前処理結果に対して複数回 OCR したい」用途で再利用する。
   * @returns {Promise<{ angle, translation, resultCanvas, previewMats, error }>}
   */
  async function prepare(sourceCanvas, form, matchInfo, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);

    /* ③ 傾き補正 */
    stage('傾き補正', 0.1);
    const angle = matchInfo.angle || 0;
    const rotated = LineRemovalProcessor.rotateCanvas(sourceCanvas, angle);

    /* ④ 原点の再ローカライズ: 採用アンカーを回転後画像に角度固定で再マッチ */
    stage('原点の確定', 0.25);
    const anchor = (form.anchors || []).find(a => a.id === matchInfo.anchorId) || (form.anchors || [])[0];
    let translation = { x: 0, y: 0 };
    if (anchor) {
      try {
        const img = await dataURLtoImg(anchor.dataURL);
        const m   = MatcherEngine.matchAll(rotated, [{ id: '_loc', imageElement: img }],
                      { angleRange: 0, angleStep: 1 });
        const loc = m.get('_loc')?.loc || { x: 0, y: 0 };
        /* 平行移動量 = 入力上の位置 − 基準画像上の位置 */
        translation = { x: loc.x - (anchor.refX || 0), y: loc.y - (anchor.refY || 0) };
      } catch (_) { /* 失敗時は移動量 0 */ }
    }

    /* ⑤ 罫線除去（登録された罫線除去パラメータを引き継ぎ） */
    stage('罫線除去', 0.45);
    const params = form.lineRemoval || LineRemovalProcessor.defaultParams();
    const proc   = LineRemovalProcessor.process(rotated, params);
    if (proc.error) {
      LineRemovalProcessor.cleanupMats(proc.mats);
      return { angle, translation, resultCanvas: null, previewMats: [], error: proc.error };
    }
    /* mats[3] = 罫線除去結果。OCR 入力用に独立キャンバスへ描画 */
    const resultCanvas = document.createElement('canvas');
    const resMat = proc.mats[3];
    resultCanvas.width  = resMat.cols;
    resultCanvas.height = resMat.rows;
    LineRemovalProcessor.renderToCanvas(resMat, resultCanvas);

    return { angle, translation, resultCanvas, previewMats: proc.mats, error: null };
  }

  async function runOcr(sourceCanvas, form, matchInfo, opts = {}, cb = {}) {
    const stage = (name, pct) => cb.onStage && cb.onStage(name, pct);

    const prep = await prepare(sourceCanvas, form, matchInfo, cb);
    if (prep.error) {
      return { angle: prep.angle, translation: prep.translation, resultCanvas: null, previewMats: [], fields: [], error: prep.error };
    }
    const { angle, translation, resultCanvas } = prep;

    /* ⑥ OCR領域ごとに認識 */
    const regions = form.ocrRegions || [];
    const psm  = form.ocrSettings?.psm ?? 3;
    const lang = form.ocrSettings?.lang || 'eng';
    const whitelist = form.ocrSettings?.whitelist || '';
    const doNorm = form.ocrSettings?.normalize !== false;   // 既定で正規化ON
    const fields = [];
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      stage(`OCR ${i + 1}/${regions.length}`, 0.55 + 0.4 * (i / Math.max(1, regions.length)));
      const cropCanvas = LineRemovalProcessor.extractRegion(resultCanvas, translation, region);
      if (!cropCanvas) {
        fields.push({ name: region.name, text: '', confidence: 0, error: '領域の切り出しに失敗しました' });
        continue;
      }
      const res = await OcrProcessor.recognize(cropCanvas, psm, prog => {
        cb.onOcr && cb.onOcr(i, regions.length, region.name, prog.status, prog.progress);
      }, lang, whitelist);
      const conf = (!res.error && res.words.length)
        ? Math.round(res.words.reduce((sum, w) => sum + w.confidence, 0) / res.words.length)
        : 0;
      let text = (res.fullText || '').trim();
      if (doNorm) text = OcrProcessor.normalize(text);
      fields.push({
        name: region.name,
        text,
        confidence: conf,
        error: res.error || null,
        cropDataURL: cropCanvas.toDataURL('image/png'),
      });
    }

    stage('完了', 1);
    return { angle, translation, resultCanvas, previewMats: prep.previewMats, fields, error: null };
  }

  /**
   * 1 領域に対して複数 PSM で OCR を試し、結果を比較する。
   * @param {HTMLCanvasElement} resultCanvas  prepare() で得た罫線除去後キャンバス
   * @param {{x,y}} translation
   * @param {object} region    { name, x, y, w, h }
   * @param {number[]} psmList
   * @param {string} lang
   * @param {Function} onProg  (idx, total, psm) => void
   * @returns {Promise<Array<{ psm, text, confidence, error }>>}
   */
  async function comparePsm(resultCanvas, translation, region, psmList, opts, onProg) {
    const { lang = 'eng', whitelist = '', normalize = true } = opts || {};
    const crop = LineRemovalProcessor.extractRegion(resultCanvas, translation, region);
    const out = [];
    for (let i = 0; i < psmList.length; i++) {
      const psm = psmList[i];
      if (onProg) onProg(i, psmList.length, psm);
      if (!crop) { out.push({ psm, text: '', confidence: 0, error: '領域切り出し失敗' }); continue; }
      const res = await OcrProcessor.recognize(crop, psm, () => {}, lang, whitelist);
      const conf = (!res.error && res.words.length)
        ? Math.round(res.words.reduce((s, w) => s + w.confidence, 0) / res.words.length) : 0;
      let text = (res.fullText || '').trim();
      if (normalize) text = OcrProcessor.normalize(text);
      out.push({ psm, text, confidence: conf, error: res.error || null });
    }
    return out;
  }

  return { classify, prepare, runOcr, comparePsm, dataURLtoImg };

})();
