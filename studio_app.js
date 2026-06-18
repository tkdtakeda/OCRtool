/* ════════════════════════════════════════════════════════
   studio_app.js  帳票OCR統合ツール コントローラー
   Responsibility: モード制御・状態管理・各モジュールの調整
     登録工程: 基準画像へのアンカー/OCR領域描画 → IndexedDB 保存
     OCR工程 : 画像 → マッチング → 帳票判定 → 補正 → 罫線除去 → OCR → 保存
   ════════════════════════════════════════════════════════ */
'use strict';

(function () {

  const $  = id => document.getElementById(id);
  const UI = StudioUI;

  /* ── State ──────────────────────────────────────────── */
  const S = {
    cvReady: false,
    forms: [],
    mode: 'register',
    /* 編集中の帳票 */
    editingId: null, isSampleForm: false,
    refImg: null, refNatW: 0, refNatH: 0, refDataURL: null,
    anchors: [], regions: [],
    /* 描画 */
    drawMode: 'anchor', zoom: 1, baseScale: 1,
    isDrawing: false, ds: { x: 0, y: 0 }, dc: { x: 0, y: 0 }, pending: null,
    /* 認識 */
    recogCanvas: null, lastClassify: null,
  };

  const uid = () => Math.random().toString(36).slice(2, 11);
  const dataURLtoImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load fail')); i.src = url; });
  const fileToDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(new Error('read fail')); r.readAsDataURL(file); });

  function canvasFromImg(img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }
  function thumbURL(canvas, w = 90) { const s = Math.min(1, w / canvas.width); const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s); c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }

  /* ── CV lifecycle ───────────────────────────────────── */
  document.addEventListener('cv-ready', () => { S.cvReady = true; $('loadingOverlay').classList.add('hidden'); UI.toast('OpenCV.js の準備が完了しました', 'success'); });
  document.addEventListener('cv-error', () => { $('loadingMsg').textContent = '読み込み失敗。インターネット接続を確認してください。'; UI.toast('OpenCV.js の読み込みに失敗しました', 'error', 6000); });

  /* ── モード切替 ─────────────────────────────────────── */
  function setMode(mode) {
    S.mode = mode;
    $('viewRegister').classList.toggle('hidden', mode !== 'register');
    $('viewRecognize').classList.toggle('hidden', mode !== 'recognize');
    $('modeRegister').classList.toggle('is-active', mode === 'register');
    $('modeRecognize').classList.toggle('is-active', mode === 'recognize');
    if (mode === 'recognize') { refreshHistory(); }
  }

  /* ════════════════════════════════════════════════════
     登録工程
     ════════════════════════════════════════════════════ */

  async function loadForms() {
    try { S.forms = await FormDB.getAllForms(); }
    catch (e) { S.forms = []; UI.toast('IndexedDB 読み込みエラー: ' + e.message, 'error'); }
    UI.renderFormLibrary(S.forms, { onEdit: editForm, onDelete: deleteForm });
  }

  function newForm() {
    S.editingId = null; S.isSampleForm = false;
    S.refImg = null; S.refNatW = 0; S.refNatH = 0; S.refDataURL = null;
    S.anchors = []; S.regions = []; S.pending = null; S.zoom = 1; S.drawMode = 'anchor';
    $('formNameInput').value = '';
    $('refPreview').style.display = 'none'; $('refDropHint').style.display = 'flex';
    $('rectNameInput').value = '';
    applyLineRemovalToUI(LineRemovalProcessor.defaultParams());
    $('regPsm').value = '7';
    setDrawMode('anchor');
    $('regCanvas').style.display = 'none'; $('regCanvasPlaceholder').style.display = 'flex';
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    UI.renderAnchorList(S.anchors, removeAnchor);
    UI.renderRegionList(S.regions, removeRegion);
    refreshSteps();
    setTimeout(() => $('formNameInput').focus(), 50);
  }

  async function editForm(id) {
    const f = S.forms.find(x => x.id === id); if (!f) return;
    S.editingId = f.id; S.isSampleForm = !!f.isSample;
    $('formNameInput').value = f.name || '';
    S.anchors = (f.anchors || []).map(a => ({ ...a }));
    S.regions = (f.ocrRegions || []).map(r => ({ ...r }));
    S.zoom = 1; S.pending = null;
    applyLineRemovalToUI(f.lineRemoval || LineRemovalProcessor.defaultParams());
    $('regPsm').value = String(f.ocrSettings?.psm ?? 7);
    $('editorEmpty').classList.add('hidden'); $('editorForm').classList.remove('hidden');
    setDrawMode('anchor');
    UI.renderAnchorList(S.anchors, removeAnchor);
    UI.renderRegionList(S.regions, removeRegion);
    await setReference(f.referenceImage.dataURL);
    refreshSteps();
  }

  async function deleteForm(id) {
    const f = S.forms.find(x => x.id === id);
    if (!confirm(`帳票「${f ? f.name : ''}」を削除しますか？`)) return;
    await FormDB.deleteForm(id);
    if (S.editingId === id) cancelEdit();
    await loadForms();
    UI.toast('帳票を削除しました', 'info');
  }

  function cancelEdit() {
    S.editingId = null;
    $('editorForm').classList.add('hidden'); $('editorEmpty').classList.remove('hidden');
  }

  /* ── 基準画像 ───────────────────────────────────────── */
  async function setReference(dataURL) {
    const img = await dataURLtoImg(dataURL);
    S.refImg = img; S.refNatW = img.naturalWidth; S.refNatH = img.naturalHeight; S.refDataURL = dataURL;
    $('refPreview').src = dataURL; $('refPreview').style.display = 'block'; $('refDropHint').style.display = 'none';
    $('regCanvasPlaceholder').style.display = 'none'; $('regCanvas').style.display = 'block';
    computeBaseScale(); redrawRegCanvas(); refreshSteps();
  }
  function computeBaseScale() {
    const wrap = $('regCanvasWrap');
    const avail = (wrap?.clientWidth || 600) - 24;
    S.baseScale = Math.max(0.1, Math.min(2, avail / (S.refNatW || 1)));
  }
  const activeScale = () => S.baseScale * S.zoom;

  /* ── 描画モード ─────────────────────────────────────── */
  function setDrawMode(m) {
    S.drawMode = m; S.pending = null;
    document.querySelectorAll('#drawModeSwitch .dm-btn').forEach(b => b.classList.toggle('is-active', b.dataset.dm === m));
    $('rectNameInput').placeholder = m === 'anchor' ? '識別アンカー名（例：タイトル）' : 'OCRフィールド名（例：番号）';
    redrawRegCanvas();
  }

  function redrawRegCanvas() {
    const c = $('regCanvas'); if (!c || !S.refImg) return;
    const sc = activeScale();
    c.width = Math.round(S.refNatW * sc); c.height = Math.round(S.refNatH * sc);
    const ctx = c.getContext('2d');
    ctx.drawImage(S.refImg, 0, 0, c.width, c.height);
    /* 識別アンカー（青） */
    S.anchors.forEach((a, i) => drawRect(ctx, a.refX * sc, a.refY * sc, a.w * sc, a.h * sc, UI.ANCHOR_COLOR, `A${i + 1}.${a.name}`));
    /* OCR領域（色分け） */
    S.regions.forEach((r, i) => drawRect(ctx, r.x * sc, r.y * sc, r.w * sc, r.h * sc, UI.REGION_COLORS[i % UI.REGION_COLORS.length], `${i + 1}.${r.name}`));
    /* 描画中／保留 */
    if (S.isDrawing) {
      const x = Math.min(S.ds.x, S.dc.x), y = Math.min(S.ds.y, S.dc.y), w = Math.abs(S.dc.x - S.ds.x), h = Math.abs(S.dc.y - S.ds.y);
      ctx.save(); ctx.strokeStyle = '#FF6B00'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,107,0,.12)'; ctx.fillRect(x, y, w, h); ctx.restore();
    } else if (S.pending) {
      const col = S.drawMode === 'anchor' ? UI.ANCHOR_COLOR : '#FF6B00';
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.setLineDash([5, 3]);
      ctx.strokeRect(S.pending.x * sc, S.pending.y * sc, S.pending.w * sc, S.pending.h * sc);
      ctx.fillStyle = col + '22'; ctx.fillRect(S.pending.x * sc, S.pending.y * sc, S.pending.w * sc, S.pending.h * sc); ctx.restore();
    }
  }
  function drawRect(ctx, x, y, w, h, col, label) {
    ctx.fillStyle = col + '24'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = col; ctx.font = 'bold 10px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(label, x + 3, y + 2); ctx.textBaseline = 'alphabetic';
  }

  function initRegCanvasEvents() {
    const c = $('regCanvas');
    c.addEventListener('mousedown', e => { if (!S.refImg) return; S.isDrawing = true; S.ds = { x: e.offsetX, y: e.offsetY }; S.dc = { ...S.ds }; });
    c.addEventListener('mousemove', e => { if (!S.isDrawing) return; S.dc = { x: e.offsetX, y: e.offsetY }; redrawRegCanvas(); });
    c.addEventListener('mouseup', e => { if (!S.isDrawing) return; S.dc = { x: e.offsetX, y: e.offsetY }; S.isDrawing = false; finishDraw(); });
    c.addEventListener('mouseleave', () => { if (S.isDrawing) { S.isDrawing = false; finishDraw(); } });
  }
  function finishDraw() {
    const sc = activeScale();
    const x = Math.min(S.ds.x, S.dc.x), y = Math.min(S.ds.y, S.dc.y), w = Math.abs(S.dc.x - S.ds.x), h = Math.abs(S.dc.y - S.ds.y);
    if (w < 5 || h < 5) { S.pending = null; redrawRegCanvas(); return; }
    S.pending = { x: Math.round(x / sc), y: Math.round(y / sc), w: Math.round(w / sc), h: Math.round(h / sc) };
    redrawRegCanvas();
    if ($('rectNameInput').value.trim()) commitPending(); else { $('btnAddRect').disabled = false; $('rectNameInput').focus(); }
  }
  /* commit pending rect */
  function commitPending() {
    if (!S.pending) { UI.toast('先に画像上でドラッグして範囲を指定してください', 'warning'); return; }
    const name = $('rectNameInput').value.trim();
    if (!name) { UI.toast('名前を入力してください', 'warning'); $('rectNameInput').focus(); return; }
    if (S.drawMode === 'anchor') {
      /* 基準画像から切り出してアンカー画像を生成 */
      const p = S.pending;
      const crop = document.createElement('canvas'); crop.width = p.w; crop.height = p.h;
      crop.getContext('2d').drawImage(S.refImg, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
      S.anchors.push({ id: uid(), name, dataURL: crop.toDataURL('image/png'), w: p.w, h: p.h, refX: p.x, refY: p.y });
      UI.renderAnchorList(S.anchors, removeAnchor);
    } else {
      const p = S.pending;
      S.regions.push({ id: uid(), name, x: p.x, y: p.y, w: p.w, h: p.h });
      UI.renderRegionList(S.regions, removeRegion);
    }
    S.pending = null; $('rectNameInput').value = ''; $('btnAddRect').disabled = true;
    redrawRegCanvas(); refreshSteps();
    UI.toast(`「${name}」を追加しました`, 'success', 1600);
  }
  function removeAnchor(id) { S.anchors = S.anchors.filter(a => a.id !== id); UI.renderAnchorList(S.anchors, removeAnchor); redrawRegCanvas(); refreshSteps(); }
  function removeRegion(id) { S.regions = S.regions.filter(r => r.id !== id); UI.renderRegionList(S.regions, removeRegion); redrawRegCanvas(); refreshSteps(); }

  /* ── 別画像から識別アンカーを自動配置 ───────────────── */
  async function addAnchorFromImage(dataURL) {
    if (!S.refImg) { UI.toast('先に基準画像を読み込んでください', 'warning'); return; }
    if (!S.cvReady) { UI.toast('OpenCV.js 読み込み中です', 'warning'); return; }
    try {
      const img = await dataURLtoImg(dataURL);
      const refCanvas = canvasFromImg(S.refImg);
      const map = MatcherEngine.matchAll(refCanvas, [{ id: '_a', imageElement: img }], { angleRange: 0, angleStep: 1 });
      const r = map.get('_a') || { score: 0, loc: { x: 0, y: 0 } };
      if (r.score < 0.5) { UI.toast(`基準画像内に見つかりませんでした（スコア ${r.score.toFixed(2)}）`, 'warning', 4000); return; }
      const name = prompt('識別アンカー名を入力', `アンカー${S.anchors.length + 1}`);
      if (name === null) return;
      S.anchors.push({ id: uid(), name: (name || 'アンカー').trim(), dataURL, w: img.naturalWidth, h: img.naturalHeight, refX: r.loc.x, refY: r.loc.y });
      UI.renderAnchorList(S.anchors, removeAnchor); redrawRegCanvas(); refreshSteps();
      UI.toast(`自動配置しました（スコア ${r.score.toFixed(2)}, 位置 ${r.loc.x},${r.loc.y}）`, 'success', 3500);
    } catch (e) { UI.toast('処理に失敗しました: ' + e.message, 'error'); }
  }

  /* ── 罫線除去パラメータ UI 連携 ─────────────────────── */
  function applyLineRemovalToUI(p) {
    const set = (id, v) => { const e = $(id); if (e) e[e.type === 'checkbox' ? 'checked' : 'value'] = v; };
    const txt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('regBinaryMethod', p.binaryMethod);
    set('regManualThresh', p.manualThresh); txt('regValThresh', p.manualThresh);
    set('regAdaptiveBlock', p.adaptiveBlock); txt('regValBlock', p.adaptiveBlock);
    set('regAdaptiveC', p.adaptiveC); txt('regValC', p.adaptiveC);
    set('regEnableHoriz', p.enableHoriz);
    set('regHorizLen', p.horizLen); txt('regValHLen', p.horizLen);
    set('regHorizThick', p.horizThick); txt('regValHThick', p.horizThick);
    set('regHorizDilate', p.horizDilate); txt('regValHDil', p.horizDilate);
    set('regEnableVert', p.enableVert);
    set('regVertLen', p.vertLen); txt('regValVLen', p.vertLen);
    set('regVertThick', p.vertThick); txt('regValVThick', p.vertThick);
    set('regVertDilate', p.vertDilate); txt('regValVDil', p.vertDilate);
    set('regMaskDilate', p.maskDilate); txt('regValMaskDil', p.maskDilate);
    updateBinaryRows();
  }
  function collectLineRemoval() {
    const v = id => $(id).value, vi = id => parseInt($(id).value, 10), vc = id => $(id).checked;
    return {
      binaryMethod: v('regBinaryMethod'), manualThresh: vi('regManualThresh'),
      adaptiveBlock: vi('regAdaptiveBlock'), adaptiveC: vi('regAdaptiveC'),
      enableHoriz: vc('regEnableHoriz'), horizLen: vi('regHorizLen'), horizThick: vi('regHorizThick'), horizDilate: vi('regHorizDilate'),
      enableVert: vc('regEnableVert'), vertLen: vi('regVertLen'), vertThick: vi('regVertThick'), vertDilate: vi('regVertDilate'),
      maskDilate: vi('regMaskDilate'), outputBase: 'original',
    };
  }
  function updateBinaryRows() {
    const m = $('regBinaryMethod').value;
    $('regRowThresh').classList.toggle('hidden', m !== 'manual');
    $('regRowBlock').classList.toggle('hidden', m !== 'adaptive');
    $('regRowC').classList.toggle('hidden', m !== 'adaptive');
  }

  /* ── 完了チェックリスト ─────────────────────────────── */
  function refreshSteps() {
    UI.refreshRegSteps({
      name: !!$('formNameInput').value.trim(),
      ref: !!S.refImg,
      anchor: S.anchors.length > 0,
      ocr: S.regions.length > 0,
      save: false,
    });
  }

  /* ── 保存 ───────────────────────────────────────────── */
  async function saveForm() {
    const name = $('formNameInput').value.trim();
    if (!name) { $('formNameInput').focus(); return UI.toast('帳票名を入力してください', 'warning'); }
    if (!S.refImg) return UI.toast('基準画像を設定してください', 'warning');
    if (!S.anchors.length) return UI.toast('識別アンカーを1つ以上設定してください', 'warning');
    if (!S.regions.length) return UI.toast('OCR領域を1つ以上設定してください', 'warning');

    const form = {
      id: S.editingId || uid(),
      name,
      referenceImage: { dataURL: S.refDataURL, w: S.refNatW, h: S.refNatH },
      anchors: S.anchors.map(a => ({ ...a })),
      ocrRegions: S.regions.map(r => ({ ...r })),
      ocrSettings: { psm: parseInt($('regPsm').value, 10), lang: 'eng' },
      lineRemoval: collectLineRemoval(),
      isSample: S.isSampleForm,
    };
    if (S.editingId) { const old = S.forms.find(f => f.id === S.editingId); if (old) form.createdAt = old.createdAt; }
    try {
      await FormDB.putForm(form);
      UI.refreshRegSteps({ name: true, ref: true, anchor: true, ocr: true, save: true });
      await loadForms();
      cancelEdit();
      UI.toast(`帳票「${name}」を保存しました`, 'success');
    } catch (e) { UI.toast('保存に失敗しました: ' + e.message, 'error'); }
  }

  /* ── サンプル帳票 ───────────────────────────────────── */
  async function loadSampleForms() {
    const samples = SampleForms.build();
    for (const f of samples) await FormDB.putForm(f);
    await loadForms();
    UI.toast(`${samples.length} 件のサンプル帳票を登録しました`, 'success');
  }
  function openSampleFormModal() {
    const grid = $('sampleFormGrid'); grid.innerHTML = '';
    SampleForms.build().forEach(f => {
      const card = document.createElement('div'); card.className = 'sample-card';
      const img = document.createElement('img'); img.src = f.referenceImage.dataURL; img.style.width = '100%'; img.style.display = 'block';
      const label = document.createElement('span'); label.className = 'sample-name'; label.textContent = f.name + '（テンプレ流用）';
      card.append(img, label);
      card.addEventListener('click', async () => {
        $('closeSampleFormModal').click();
        S.anchors = f.anchors.map(a => ({ ...a, id: uid() }));
        S.regions = f.ocrRegions.map(r => ({ ...r, id: uid() }));
        $('formNameInput').value = f.name;
        applyLineRemovalToUI(f.lineRemoval); $('regPsm').value = String(f.ocrSettings.psm);
        UI.renderAnchorList(S.anchors, removeAnchor); UI.renderRegionList(S.regions, removeRegion);
        await setReference(f.referenceImage.dataURL);
        UI.toast('サンプルレイアウトを読み込みました。確認して保存してください', 'info', 4000);
      });
      grid.appendChild(card);
    });
    $('sampleFormModal').classList.remove('hidden');
  }

  /* ════════════════════════════════════════════════════
     OCR工程
     ════════════════════════════════════════════════════ */

  function loadRecogImage(canvas) {
    S.recogCanvas = canvas; S.lastClassify = null;
    $('recogPreview').src = canvas.toDataURL('image/png'); $('recogPreview').style.display = 'block'; $('recogDropHint').style.display = 'none';
    $('btnRunRecognize').disabled = false;
    $('decisionPanel').classList.add('hidden'); $('recogResultArea').classList.add('hidden');
    UI.resetPipeline();
  }

  /* PDF 対応の拡張ポイント: ファイル種別で分岐（現状は画像のみ） */
  async function fileToCanvas(file) {
    if (file.type === 'application/pdf') {
      UI.toast('PDF は将来対応予定です。現在は画像を読み込んでください', 'warning', 4500);
      return null;
    }
    const url = await fileToDataURL(file);
    const img = await dataURLtoImg(url);
    return canvasFromImg(img);
  }

  async function runRecognize() {
    if (!S.cvReady) return UI.toast('OpenCV.js 読み込み中です', 'warning');
    if (!S.recogCanvas) return UI.toast('画像を読み込んでください', 'warning');
    if (!S.forms.length) return UI.toast('先に帳票を登録してください', 'warning');

    $('btnRunRecognize').disabled = true;
    UI.setPipeline('match', []);
    await new Promise(r => setTimeout(r, 30));
    try {
      const { decision, scores } = await Recognizer.classify(S.recogCanvas, S.forms,
        { angleRange: 2, angleStep: 1 });
      S.lastClassify = { decision, scores };
      UI.setPipeline('decide', ['match']);
      UI.renderDecision(decision, S.forms, {});
      /* 採用なら自動で OCR まで進める（要確認/不一致は手動確認） */
      if (decision.decision === 'accepted' && decision.best) {
        await applyForm(decision.best.formId);
      } else {
        UI.setPipeline(null, ['match', 'decide']);
        UI.toast(decision.decision === 'review' ? '要確認: 帳票を確認して「この帳票でOCR」を押してください'
                                                : '一致する帳票がありません。手動選択も可能です', 'warning', 4500);
      }
    } catch (e) {
      UI.toast('認識エラー: ' + e.message, 'error', 5000);
      UI.resetPipeline();
    } finally { $('btnRunRecognize').disabled = false; }
  }

  function bestAnchorFor(form, scores) {
    let best = { score: -1, angle: 0, loc: { x: 0, y: 0 }, anchorId: null };
    (form.anchors || []).forEach(a => { const r = scores.get(a.id); if (r && r.score > best.score) best = { score: r.score, angle: r.angle, loc: r.loc, anchorId: a.id }; });
    return best;
  }

  async function applyForm(formId) {
    if (!S.lastClassify) return UI.toast('先に「認識を実行」してください', 'warning');
    const form = S.forms.find(f => f.id === formId); if (!form) return;
    const scores = S.lastClassify.scores;
    const mi = bestAnchorFor(form, scores);

    $('recogResultArea').classList.remove('hidden');
    UI.showRecogProgress(true); UI.updateRecogProgress('初期化中…', 0);
    $('fieldResults').innerHTML = ''; $('saveStatus').textContent = '';

    try {
      const result = await Recognizer.runOcr(S.recogCanvas, form, mi, {}, {
        onStage: (name, pct) => {
          UI.updateRecogProgress(name, pct);
          const map = { '傾き補正': 'rotate', '原点の確定': 'rotate', '罫線除去': 'line' };
          if (name.startsWith('OCR')) UI.setPipeline('ocr', ['match', 'decide', 'rotate', 'line']);
          else if (map[name]) UI.setPipeline(map[name], ['match', 'decide']);
        },
        onOcr: (i, total, fname, status, pct) => UI.updateRecogProgress(`OCR ${i + 1}/${total}「${fname}」: ${status}`, 0.55 + 0.4 * ((i + (pct || 0)) / total)),
      });
      if (result.error) { UI.showRecogProgress(false); LineRemovalProcessor.cleanupMats(result.previewMats); return UI.toast('処理エラー: ' + result.error, 'error', 5000); }

      UI.setPipeline(null, ['match', 'decide', 'rotate', 'line', 'ocr']);
      UI.showRecogProgress(false);
      UI.renderRecogPreview(result.resultCanvas, result.translation, form.ocrRegions, result.angle);
      UI.renderFieldResults(result.fields);
      LineRemovalProcessor.cleanupMats(result.previewMats);

      await saveResult(form, result);
      const ok = result.fields.filter(f => !f.error).length;
      UI.toast(`OCR完了 — ${ok}/${result.fields.length} フィールド認識`, 'success');
    } catch (e) { UI.showRecogProgress(false); UI.toast('OCRエラー: ' + e.message, 'error', 5000); }
  }

  async function saveResult(form, result) {
    const dec = S.lastClassify.decision;
    const manual = !(dec.best && dec.best.formId === form.id);
    const avgConf = result.fields.length ? Math.round(result.fields.reduce((s, f) => s + (f.confidence || 0), 0) / result.fields.length) : 0;
    const record = {
      id: uid(),
      formId: form.id, formName: form.name,
      createdAt: Date.now(),
      sourceThumb: thumbURL(S.recogCanvas, 90),
      decision: manual ? 'review' : dec.decision,
      confidence: dec.confidence,
      angle: result.angle,
      overallFieldConfidence: avgConf,
      voting: { margin: dec.margin, legacySignal: dec.legacySignal, ranking: dec.ranking.map(r => ({ formName: r.formName, peak: r.peak, agg: r.agg, support: r.support })) },
      fields: result.fields.map(f => ({ name: f.name, text: f.text, confidence: f.confidence, error: f.error || null })),
    };
    try { await FormDB.putResult(record); $('saveStatus').innerHTML = `<i class="fas fa-circle-check"></i> IndexedDB に保存しました（平均信頼度 ${avgConf}%）`; refreshHistory(); }
    catch (e) { $('saveStatus').textContent = '保存に失敗: ' + e.message; }
  }

  function copyAllFields() {
    const rows = document.querySelectorAll('#fieldResults .field-row');
    if (!rows.length) return UI.toast('コピーするデータがありません', 'warning');
    const lines = Array.from(rows).map(r => `${r.querySelector('.field-name').textContent}: ${r.querySelector('.field-text').value}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => UI.toast('全フィールドをコピーしました', 'success')).catch(() => UI.toast('コピーに失敗しました', 'error'));
  }

  /* ── 履歴 ───────────────────────────────────────────── */
  async function refreshHistory() {
    let results = [];
    try { results = await FormDB.getAllResults(50); } catch (_) {}
    UI.renderHistory(results, { onDelete: async id => { await FormDB.deleteResult(id); refreshHistory(); } });
  }
  async function clearHistory() {
    if (!confirm('認識履歴をすべて削除しますか？')) return;
    await FormDB.clearResults(); refreshHistory(); UI.toast('履歴を削除しました', 'info');
  }

  /* ════════════════════════════════════════════════════
     共通 UI 配線
     ════════════════════════════════════════════════════ */
  function setupDrop(zoneId, onDataURL, clickFileId) {
    const z = $(zoneId); if (!z) return;
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag-over'); });
    z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
    z.addEventListener('drop', async e => { e.preventDefault(); z.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) onDataURL(await fileToDataURL(f)); });
    if (clickFileId) z.addEventListener('click', () => $(clickFileId).click());
  }

  function initAccordions() {
    document.querySelectorAll('.acc-hdr').forEach(hdr => {
      const body = $(hdr.dataset.acc);
      if (body && body.classList.contains('is-collapsed')) hdr.classList.add('is-collapsed');
      hdr.addEventListener('click', () => { const collapsed = body.classList.toggle('is-collapsed'); hdr.classList.toggle('is-collapsed', collapsed); });
    });
  }
  function initRegSliders() {
    [['regManualThresh', 'regValThresh'], ['regAdaptiveBlock', 'regValBlock'], ['regAdaptiveC', 'regValC'],
     ['regHorizLen', 'regValHLen'], ['regHorizThick', 'regValHThick'], ['regHorizDilate', 'regValHDil'],
     ['regVertLen', 'regValVLen'], ['regVertThick', 'regValVThick'], ['regVertDilate', 'regValVDil'],
     ['regMaskDilate', 'regValMaskDil']].forEach(([s, v]) => {
      const sl = $(s), vl = $(v); if (!sl || !vl) return;
      sl.addEventListener('input', () => { vl.textContent = sl.value; });
    });
  }

  /* ── グローバル paste（モード/モーダルに応じて振り分け） ── */
  function handlePaste(e) {
    const items = e.clipboardData?.items; if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      fileToDataURL(item.getAsFile()).then(url => {
        if (S.mode === 'register' && !$('editorForm').classList.contains('hidden')) {
          if (!S.refImg) setReference(url); else { /* 既に基準画像あり: アンカー候補として自動配置 */ addAnchorFromImage(url); }
        } else if (S.mode === 'recognize') {
          dataURLtoImg(url).then(img => loadRecogImage(canvasFromImg(img)));
        }
      });
      return;
    }
  }

  /* ── Init ───────────────────────────────────────────── */
  function init() {
    initAccordions(); initRegSliders(); initRegCanvasEvents();

    /* モード切替 */
    $('modeRegister').addEventListener('click', () => setMode('register'));
    $('modeRecognize').addEventListener('click', () => setMode('recognize'));

    /* ライブラリ */
    $('btnNewForm').addEventListener('click', newForm);
    $('btnNewForm2').addEventListener('click', newForm);
    $('btnLoadSampleForms').addEventListener('click', loadSampleForms);
    $('btnClearForms').addEventListener('click', async () => { if (!confirm('登録帳票をすべて削除しますか？')) return; await FormDB.clearForms(); await loadForms(); cancelEdit(); UI.toast('全帳票を削除しました', 'info'); });

    /* エディタ: 名前/基準画像/設定 */
    $('formNameInput').addEventListener('input', refreshSteps);
    setupDrop('refDropZone', url => setReference(url), 'refFileInput');
    $('refFileInput').addEventListener('change', async e => { const f = e.target.files[0]; if (f) setReference(await fileToDataURL(f)); e.target.value = ''; });
    $('btnRefSample').addEventListener('click', openSampleFormModal);
    setupDrop('anchorDropZone', url => addAnchorFromImage(url), 'anchorFileInput');
    $('anchorFileInput').addEventListener('change', async e => { const f = e.target.files[0]; if (f) addAnchorFromImage(await fileToDataURL(f)); e.target.value = ''; });
    $('regBinaryMethod').addEventListener('change', updateBinaryRows);

    /* 描画 */
    document.querySelectorAll('#drawModeSwitch .dm-btn').forEach(b => b.addEventListener('click', () => setDrawMode(b.dataset.dm)));
    $('rectNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitPending(); } });
    $('btnAddRect').addEventListener('click', commitPending);
    $('btnZoomIn').addEventListener('click', () => { S.zoom = Math.min(8, S.zoom * 1.3); redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });
    $('btnZoomOut').addEventListener('click', () => { S.zoom = Math.max(0.2, S.zoom / 1.3); redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });
    $('btnZoomFit').addEventListener('click', () => { S.zoom = 1; redrawRegCanvas(); $('zoomLabel').textContent = Math.round(activeScale() * 100) + '%'; });

    /* 保存 / キャンセル */
    $('btnSaveForm').addEventListener('click', saveForm);
    $('btnCancelEdit').addEventListener('click', cancelEdit);

    /* OCR工程 */
    setupDrop('recogDrop', url => dataURLtoImg(url).then(img => loadRecogImage(canvasFromImg(img))), 'recogFileInput');
    $('recogFileInput').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { const c = await fileToCanvas(f); if (c) loadRecogImage(c); } e.target.value = ''; });
    $('btnRecogSample').addEventListener('click', () => loadRecogImage(SampleForms.sampleInputCanvas(0, 1.5)));
    $('btnRunRecognize').addEventListener('click', runRecognize);
    $('btnApplyForm').addEventListener('click', () => applyForm($('dpFormSelect').value));
    $('btnCopyAll').addEventListener('click', copyAllFields);
    $('btnClearHistory').addEventListener('click', clearHistory);

    /* サンプル/ヘルプモーダル */
    $('closeSampleFormModal').addEventListener('click', () => $('sampleFormModal').classList.add('hidden'));
    $('sampleFormModal').addEventListener('click', e => { if (e.target === $('sampleFormModal')) $('sampleFormModal').classList.add('hidden'); });
    $('btnHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
    $('closeHelpModal').addEventListener('click', () => $('helpModal').classList.add('hidden'));
    $('helpModal').addEventListener('click', e => { if (e.target === $('helpModal')) $('helpModal').classList.add('hidden'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden')); });

    document.addEventListener('paste', handlePaste);

    /* 初期データ + IndexedDB 可用性チェック（file:// の Safari 等で無効な場合に通知） */
    setMode('register');
    if (!window.indexedDB) {
      UI.toast('このブラウザでは IndexedDB が無効のため帳票・履歴を保存できません（Chrome/Edge/Firefox 推奨）', 'warning', 8000);
    } else {
      FormDB.open().catch(() => UI.toast('IndexedDB を初期化できませんでした。Chrome/Edge で開くと保存できます', 'warning', 8000));
    }
    loadForms();
    refreshHistory();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
