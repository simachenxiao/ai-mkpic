const $ = (id) => document.getElementById(id);

import { cutout } from '/cutout.js';
import { closeBatch, openBatch } from '/batch.js';
import {
  autoSurfaceMask as coreAutoSurface,
  buildSubjectPrompt,
  clampIntoCanvas as coreClampIntoCanvas,
  decodeSurface,
  findFittingCenter,
  sizeForCut,
  surfaceOk,
} from '/scene-core.js';

const DEFAULTS = {
  refs: [
    { name: '纸巾包', w: 3.5, h: 5.5 },
    { name: '充电器', w: 4.5, h: 5 },
  ],
  target: { name: '手机', w: 7.2, h: 15.2 },
};

const DEFAULT_SUBJECT = '一部平放的黑色智能手机，屏幕朝上、息屏，正面朝上，圆角机身';

const state = {
  config: null,
  history: [],
  current: null,
  jobs: [],
  failures: [],
  candidates: [],
  jobSeq: 0,
  clock: null,
  startedAt: 0,
  sizeTouched: false,
  refUrl: null,
  refLabel: 'base.jpg',
  scene: null,
  placement: { mode: 'auto', x: 0, y: 0 },
  quickBusy: false,
  itemInfo: null,
  promptEdited: false,
};

const view = {
  base: null,
  ruler: null,
  phone: null,
  tool: 'ruler', // ruler | move | erase
  drawing: false,
  drag: null,
  draft: null,
  layer: null,
  layerDirty: true,
  erase: null,
  eraseOn: false,
  brush: 46,
  lastErase: null,
};

const canvas = $('canvas');
const ctx = canvas.getContext('2d');

/* ---------------------------------------------------------------- boot */

boot().catch((err) => setStatus(`初始化失败：${err.message}`, 'error'));

async function boot() {
  const config = await fetch('/api/config').then((r) => r.json());
  state.config = config;

  const modelSel = $('model');
  for (const model of config.models) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.label;
    modelSel.append(opt);
  }
  modelSel.value = config.models[0].id;

  $('outDir').textContent = config.outputDir;
  if (config.hasKey) {
    $('keyState').textContent = `已连接 ${new URL(config.baseUrl).host} · 生图分组`;
    $('keyDot').classList.add('ok');
  } else {
    $('keyState').textContent = '未配置 API Key：在 .env 填写 IMAGE_API_KEY 后重启';
    $('keyDot').classList.add('bad');
  }

  $('prompt').value = DEFAULT_SUBJECT;
  syncModel();
  buildRulerRefOptions();

  const llm = config.llm || {};
  $('quickHint').innerHTML = llm.hasKey
    ? `只写名称就行：回车后由 <b>${escapeHtml(llm.model || 'LLM')}</b> 写好主体描述（已含正俯视）和实物尺寸，然后直接开始生成。`
    : '只写名称就行：没配 LLM_API_KEY，会用本地粗估的尺寸和模板描述，然后直接开始生成。';

  await loadBase(config.defaultBaseImage);
  await loadHistory();
  bind();
  updateAll();
}

function bind() {
  $('model').addEventListener('change', () => {
    syncModel();
    updateAll();
  });
  $('size').addEventListener('change', () => {
    state.sizeTouched = true;
    updateCompose();
  });

  for (const input of document.querySelectorAll('#refRows input, #targetRow input')) {
    input.addEventListener('input', () => {
      buildRulerRefOptions();
      updateAll();
      invalidate();
      draw();
    });
  }

  $('prompt').addEventListener('input', () => {
    if (state.itemInfo && !state.promptEdited) {
      state.promptEdited = true;
      renderPromptTag();
    }
    updateCompose();
  });

  $('btnMain').addEventListener('click', mainAction);
  $('btnSubject').addEventListener('click', generateSubject);

  $('btnQuick').addEventListener('click', quickGenerate);
  $('btnRedescribe').addEventListener('click', redescribe);
  $('itemName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      quickGenerate();
    }
  });
  $('itemName').addEventListener('input', () => $('quickHint').classList.remove('is-warn'));
  $('btnExport').addEventListener('click', exportComposite);
  $('btnRemeasure').addEventListener('click', () => {
    view.tool = 'ruler';
    $('board').dataset.tool = 'ruler';
    setStatus('在底图上沿参照物的宽度拖一条线。', '');
  });
  $('btnUseProfile').addEventListener('click', () => {
    view.ruler = null;
    setTool(view.phone ? 'move' : 'ruler');
    invalidate();
    draw();
    updateAll();
    setStatus('已改回场景档案的预标定值。', 'ok');
  });
  $('rulerRef').addEventListener('change', () => {
    updateAll();
    draw();
  });
  $('rot').addEventListener('input', () => {
    if (view.phone) view.phone.rot = Number($('rot').value);
    $('rotVal').textContent = `${$('rot').value}°`;
    draw();
  });
  $('sizeMul').addEventListener('input', () => {
    if (view.phone) view.phone.mul = Number($('sizeMul').value) / 100;
    $('sizeVal').textContent = `${$('sizeMul').value}%`;
    draw();
  });
  $('squash').addEventListener('input', () => {
    if (view.phone) view.phone.squash = Number($('squash').value) / 100;
    $('squashVal').textContent = `${$('squash').value}%`;
    invalidate();
    draw();
  });
  $('bright').addEventListener('input', () => {
    if (view.phone) view.phone.bright = Number($('bright').value) / 100;
    $('brightVal').textContent = `${$('bright').value}%`;
    invalidate();
    draw();
  });
  $('btnPosAuto').addEventListener('click', () => {
    state.placement = { ...state.placement, mode: 'auto' };
    if (view.phone) {
      autoPlace();
      syncSliders();
      invalidate();
      draw();
      setStatus(`自动挑空位：${state.placedLabel || ''}`, 'ok');
    } else {
      syncPlacementUI();
    }
  });
  $('btnPosFixed').addEventListener('click', () => {
    state.placement = {
      mode: 'fixed',
      x: view.phone?.cx ?? state.placement.x,
      y: view.phone?.cy ?? state.placement.y,
    };
    syncPlacementUI();
    setStatus('改成指定位置：改 X / Y，或者直接拖动物体。', '');
  });
  $('posX').addEventListener('input', applyPlacement);
  $('posY').addEventListener('input', applyPlacement);
  $('btnSavePlacement').addEventListener('click', savePlacement);
  $('btnErase').addEventListener('click', () => setTool(view.tool === 'erase' ? 'move' : 'erase'));
  $('brush').addEventListener('input', () => {
    view.brush = Number($('brush').value);
    $('brushVal').textContent = `${view.brush} px`;
  });
  $('btnEraseClear').addEventListener('click', () => {
    clearErase();
    invalidate();
    draw();
    setStatus('遮挡已清空。', '');
  });
  $('btnReveal').addEventListener('click', revealOutput);
  $('genThumbBtn').addEventListener('click', () => {
    if (state.lastFile) openLightbox(state.lastFile.url, state.lastFile.caption);
  });
  $('genOpen').addEventListener('click', () => {
    if (state.lastFile) openLightbox(state.lastFile.url, state.lastFile.caption);
  });
  $('genReveal').addEventListener('click', revealOutput);
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox')) closeLightbox();
  });
  $('btnBatch').addEventListener('click', async () => {
    const panel = $('batchPanel');
    const workspace = $('workspace');
    const opening = panel.hidden;
    if (opening) {
      $('btnBatch').textContent = '返回单张';
      await openBatch(panel);
      workspace.hidden = true;
      window.scrollTo(0, 0);
    } else {
      closeBatch();
      workspace.hidden = false;
      $('btnBatch').textContent = '批量';
    }
  });
  $('btnExample').addEventListener('click', applyExample);
  $('btnResetRef').addEventListener('click', () => loadBase(state.config.defaultBaseImage));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      generateSubject();
    }
    if (e.key === 'Escape') closeLightbox();
  });

  const refDrop = $('refDrop');
  $('refFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
  });
  refDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    refDrop.classList.add('dragging');
  });
  refDrop.addEventListener('dragleave', () => refDrop.classList.remove('dragging'));
  refDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    refDrop.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });

  window.addEventListener('resize', fitCanvas);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
}

/* ----------------------------------------------------------------- 底图 */

async function loadBase(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('读不到参考图');
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  if (state.refUrl) URL.revokeObjectURL(state.refUrl);
  state.refUrl = objectUrl;
  state.refLabel = url.split('/').pop();
  await useBaseImage(objectUrl, state.refLabel);
  await loadScene(state.refLabel);
  $('btnResetRef').hidden = true;
}

/** 场景档案：预标定比例、桌面角度、可用空位、光照方向 */
async function loadScene(name) {
  const key = String(name || '').replace(/\.(jpe?g|png|webp)$/i, '');
  const scene = key
    ? await fetch(`/api/scene?image=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .catch(() => ({}))
    : {};
  const usable = scene && (Number(scene.pxPerCm) > 0 || Number(scene.calibration?.pixels) > 0);
  state.scene = usable ? scene : null;
  const place = state.scene?.placement;
  state.placement =
    place && place.mode === 'fixed'
      ? { mode: 'fixed', x: Number(place.x) || 0, y: Number(place.y) || 0 }
      : { mode: 'auto', x: Number(place?.x) || 0, y: Number(place?.y) || 0 };
  updateAll();
  draw();
}

async function useBaseImage(url, label) {
  const img = new Image();
  img.src = url;
  await img.decode();
  view.base = img;
  view.ruler = null;
  view.phone = null;
  view.tool = 'ruler';
  view.draft = null;
  view.layer = null;
  view.erase = null;
  view.layerDirty = true;

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  $('refThumb').src = url;
  $('scope').textContent = label;
  $('stageBadge').textContent = `底图 · ${img.naturalWidth} × ${img.naturalHeight}`;
  $('subjectThumb').hidden = true;
  $('rot').value = 0;
  $('sizeMul').value = 100;
  $('rotVal').textContent = '0°';
  $('sizeVal').textContent = '100%';
  $('bright').value = 100;
  $('brightVal').textContent = '100%';
  $('board').dataset.tool = 'ruler';
  $('btnSave').hidden = true;
  pickSizeFor(img.naturalWidth, img.naturalHeight);
  fitCanvas();
  draw();
  updateAll();
}

function acceptFile(file) {
  if (!/image\/(jpeg|png|webp)/.test(file.type)) {
    return setStatus('只支持 jpg / png / webp 图片。', 'error');
  }
  if (file.size > 12 * 1024 * 1024) {
    return setStatus('图片太大了，请控制在 12MB 以内。', 'error');
  }
  const url = URL.createObjectURL(file);
  if (state.refUrl) URL.revokeObjectURL(state.refUrl);
  state.refUrl = url;
  state.refLabel = file.name;
  $('btnResetRef').hidden = false;
  state.scene = null;
  useBaseImage(url, file.name).then(() => {
    setStatus(`已换成 ${file.name}。沿参照物重新拖一条线，尺寸才会准。`, 'ok');
  });
}

/* ------------------------------------------------------------ 模型/画幅 */

function syncModel() {
  const model = state.config.models.find((m) => m.id === $('model').value) || state.config.models[0];
  const sizeSel = $('size');
  const previous = sizeSel.value;
  sizeSel.innerHTML = '';
  for (const size of model.sizes) {
    const opt = document.createElement('option');
    opt.value = size;
    opt.textContent = size === '1024x1024' ? '1024x1024（方）' : size;
    sizeSel.append(opt);
  }
  sizeSel.value = model.sizes.includes(previous) ? previous : (model.sizes.includes('1024x1024') ? '1024x1024' : model.sizes[0]);
  $('modelNote').textContent = model.note;
}

function pickSizeFor(width, height) {
  if (state.sizeTouched || !width || !height) return;
  const select = $('size');
  const ratio = width / height;
  const wanted = ratio > 1.15 ? '1536x1024' : ratio < 0.87 ? '1024x1536' : '1024x1024';
  if ([...select.options].some((o) => o.value === wanted)) select.value = wanted;
}

/* ------------------------------------------------------------- 尺寸数据 */

const num = (value) => {
  const n = Number.parseFloat(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function readRefs() {
  return [...document.querySelectorAll('[data-role="ref"]')].map((row) => {
    const inputs = row.querySelectorAll('input');
    return { name: inputs[0].value.trim() || '参照物', w: num(inputs[1].value), h: num(inputs[2].value) };
  });
}

function readTarget() {
  return {
    name: $('targetName').value.trim() || '新物体',
    w: num($('targetW').value),
    h: num($('targetH').value),
  };
}

function rulerRef() {
  const index = Number($('rulerRef').value || 0);
  const refs = readRefs();
  return refs[index] || refs[0] || { name: '参照物', w: 0 };
}

function buildRulerRefOptions() {
  const select = $('rulerRef');
  const previous = select.value;
  const refs = readRefs();
  select.innerHTML = '';
  refs.forEach((ref, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = ref.w ? `${ref.name} ${ref.w} cm` : ref.name;
    select.append(opt);
  });
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

/** 参照物的长边（厘米）：宽填短边、长填长边，取大的那个兜底 */
function refLongCm(ref) {
  return Math.max(Number(ref?.w) || 0, Number(ref?.h) || 0);
}

function pxPerCm() {
  // 手量优先（量的就是最长的一边）
  if (view.ruler) {
    const cm = refLongCm(rulerRef());
    if (cm > 0) {
      const length = Math.hypot(view.ruler.x2 - view.ruler.x1, view.ruler.y2 - view.ruler.y1);
      if (length > 8) return length / cm;
    }
  }
  // 没手量就用档案：像素长度 / 你填的长边厘米数（改尺寸参照立刻生效）
  const cal = state.scene?.calibration;
  if (cal && Number(cal.pixels) > 0) {
    const refs = readRefs();
    const ref = refs[Number(cal.index) || 0] || refs[0];
    const cm = refLongCm(ref);
    if (cm > 0) return Number(cal.pixels) / cm;
  }
  return Number(state.scene?.pxPerCm) || 0;
}

/* ------------------------------------------------------- 桌面可落区 */

let surfaceCache = null;

/** scenes/*.json 里的 surface：96×54 的桌面掩膜，摆大件时别让它们挂到桌沿外面 */
function surfaceMask() {
  const s = state.scene?.surface;
  if (s && s.mask) {
    if (!surfaceCache || surfaceCache.raw !== s.mask) {
      const decoded = decodeSurface(s);
      surfaceCache = decoded ? { ...decoded, raw: s.mask } : null;
    }
    return surfaceCache;
  }
  // 没有场景档案（用户换了自己的照片）：现场从底图估一张
  const auto = coreAutoSurface(view.base);
  return auto ? { ...auto, raw: 'auto' } : null;
}

/** 这个尺寸摆在这个位置上，九个采样点是不是都在桌面上 */
function surfaceFits(cx, cy, geo) {
  return surfaceOk(surfaceMask(), canvas.width, canvas.height, cx, cy, geo, view.phone?.rot || 0, view.phone?.squash ?? 1);
}

/** 别把物体拖出画布：按旋转后的外接框把中心点夹回来 */
function clampIntoCanvas(x, y, geo) {
  return coreClampIntoCanvas(canvas.width, canvas.height, x, y, geo, view.phone?.rot || 0, view.phone?.squash ?? 1);
}

/** 摆不下就往外找最近一个能整个落在桌面上的位置 */
function fitToSurface(cx, cy, geo) {
  return findFittingCenter(surfaceMask(), canvas.width, canvas.height, cx, cy, geo, view.phone?.rot || 0, view.phone?.squash ?? 1);
}

function sceneSlots() {
  if (Array.isArray(state.scene?.slots) && state.scene.slots.length) return state.scene.slots;
  return [{ x: canvas.width * 0.45, y: canvas.height * 0.6, r: canvas.width * 0.1, label: '桌面中间' }];
}

function sceneOccupied() {
  return Array.isArray(state.scene?.occupied) ? state.scene.occupied : [];
}

function trim(n) {
  return String(Math.round(n * 10) / 10);
}

/* --------------------------------------------------------------- 画布绘制 */

function draw() {
  if (!view.base) return;
  if (view.layerDirty || !view.layer) rebuildLayer();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(view.base, 0, 0);
  if (view.layer) ctx.drawImage(view.layer, 0, 0);
  const ruler = view.draft || view.ruler;
  if (ruler) drawRulerLine(ctx, ruler);
}

function invalidate() {
  view.layerDirty = true;
}

function provisionalScale() {
  return (canvas.width * 0.12) / (readTarget().w || 7.2);
}

/**
 * 摆到画布上的像素尺寸。
 *
 * 规矩：**长边对齐长边**，短边按切图自己的比例还原 —— 绝不按「填的宽高比」拉伸切图，
 * 否则模型画歪一点（比如口红的圆头被画成侧躺的长条）就会被压成变形。
 * 填的尺寸只决定「有多大」，不决定「什么形状」。
 */
function phoneSize() {
  const scale = pxPerCm() || provisionalScale();
  const phone = view.phone;
  if (!phone || !scale) return null;

  const target = readTarget();
  const longCm = Math.max(target.w || 0, target.h || 0) || phone.cmLong || 15.2;
  const { w, h, aspect } = sizeForCut(phone.w, phone.h, longCm, scale, phone.mul || 1);
  return {
    w,
    h,
    longCm,
    aspect,
    targetAspect: Math.max(target.w, target.h) / Math.max(0.1, Math.min(target.w, target.h)),
  };
}

/** 切图比例和你填的尺寸差太多时，给一句人话提示 */
function aspectNote(geo) {
  if (!geo) return '';
  const cut = Math.max(geo.aspect, 1 / geo.aspect);
  const want = Math.max(geo.targetAspect, 1);
  if (!Number.isFinite(cut) || !Number.isFinite(want) || want <= 0) return '';
  const off = cut / want;
  if (off > 1.25 || off < 0.8) {
    return `切图比例 ${cut.toFixed(2)}:1，你填的是 ${want.toFixed(2)}:1 —— 按长边对齐摆放，不受影响的就是形状`;
  }
  return '';
}

function lightVector() {
  const deg = Number(state.scene?.lightDeg ?? 135);
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** 手机单独画进一层：拖动时只重画这一层，不动底图 */
function rebuildLayer() {
  if (!view.layer) view.layer = document.createElement('canvas');
  const layer = view.layer;
  if (layer.width !== canvas.width || layer.height !== canvas.height) {
    layer.width = canvas.width;
    layer.height = canvas.height;
  }
  const g = layer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, layer.width, layer.height);
  view.layerDirty = false;

  const geo = phoneSize();
  const phone = view.phone;
  if (!geo || !phone) return;

  const rad = ((phone.rot || 0) * Math.PI) / 180;
  const squash = phone.squash || 1;

  // 地面投影：径向渐变当软阴影，比 blur 快一个量级
  g.save();
  g.translate(phone.cx, phone.cy);
  g.save();
  g.translate(lightVector().x * geo.w * 0.13, lightVector().y * geo.w * 0.13);
  g.rotate(rad);
  g.scale(geo.w * 0.6, geo.h * 0.56 * squash);
  const grad = g.createRadialGradient(0, 0, 0.1, 0, 0, 1);
  grad.addColorStop(0, 'rgba(12,12,14,0.34)');
  grad.addColorStop(0.6, 'rgba(12,12,14,0.2)');
  grad.addColorStop(1, 'rgba(12,12,14,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 1, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // 主体（带透视压缩 + 影调匹配）
  g.save();
  g.rotate(rad);
  g.scale(1, squash);
  const bright = phone.bright || 1;
  if (bright !== 1) g.filter = `brightness(${bright})`;
  g.drawImage(phone.img, -geo.w / 2, -geo.h / 2, geo.w, geo.h);
  g.filter = 'none';
  g.restore();
  g.restore();

  // 遮挡：橡皮层在图像坐标里把这几块抠掉（数据线、纸巾包边压住的部分）
  if (view.erase) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(view.erase, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }
}

/* --------------------------------------------------------------- 遮挡 */

function eraseCtx() {
  if (!view.erase) {
    view.erase = document.createElement('canvas');
    view.erase.width = canvas.width;
    view.erase.height = canvas.height;
  }
  return view.erase.getContext('2d');
}

function eraseAt(point) {
  const g = eraseCtx();
  g.strokeStyle = '#000';
  g.fillStyle = '#000';
  g.lineWidth = view.brush;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (view.lastErase) {
    g.beginPath();
    g.moveTo(view.lastErase.x, view.lastErase.y);
    g.lineTo(point.x, point.y);
    g.stroke();
  } else {
    g.beginPath();
    g.arc(point.x, point.y, view.brush / 2, 0, Math.PI * 2);
    g.fill();
  }
  view.lastErase = point;
}

function clearErase() {
  if (!view.erase) return;
  const g = view.erase.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, view.erase.width, view.erase.height);
}

/* --------------------------------------------------------------- 摆放 */

/** 从场景档案里挑一个空位：不压住已有物品，且离它们最远 */
function autoPlace() {
  const geo = phoneSize();
  if (!geo || !view.phone) return;

  if (state.placement.mode === 'fixed') {
    const clamped = clampIntoCanvas(
      clampRange(state.placement.x, 0, canvas.width),
      clampRange(state.placement.y, 0, canvas.height),
      geo,
    );
    view.phone.cx = clamped.x;
    view.phone.cy = clamped.y;
    view.phone.rot = Number(state.scene?.planeDeg || 0);
    view.phone.squash = Number(state.scene?.squash || 1);
    view.phone.mul = 1;
    state.placedLabel = '指定位置';
    syncPlacementUI();
    return { label: '指定位置' };
  }

  const slots = sceneSlots();
  const occupied = sceneOccupied();
  const rad = ((state.scene?.planeDeg || 0) * Math.PI) / 180;
  const shiftX = Math.abs(Math.cos(rad)) * geo.w / 2 + Math.abs(Math.sin(rad)) * geo.h / 2;
  const shiftY = Math.abs(Math.sin(rad)) * geo.w / 2 + Math.abs(Math.cos(rad)) * geo.h / 2;

  // 空位按档案里的顺序优先；压到已有物品的才往后排
  let chosen = null;
  let fallback = null;
  for (const slot of slots) {
    let clearance = Number.POSITIVE_INFINITY;
    let hits = 0;
    for (const box of occupied) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const dist = Math.hypot(cx - slot.x, cy - slot.y) - Math.max(box.w, box.h) / 2;
      clearance = Math.min(clearance, dist);
      const overlap =
        slot.x + shiftX + 10 > box.x &&
        slot.x - shiftX - 10 < box.x + box.w &&
        slot.y + shiftY + 10 > box.y &&
        slot.y - shiftY - 10 < box.y + box.h;
      if (overlap) hits += 1;
    }
    if (!occupied.length) clearance = slot.r || 200;
    const cand = { slot, hits, clearance };
    if (!hits && !chosen) chosen = cand;
    if (!fallback || clearance > fallback.clearance) fallback = cand;
  }
  const best = chosen || fallback;

  const slot = best ? best.slot : slots[0];
  let geo2 = geo;
  let fit = fitToSurface(slot.x, slot.y, geo2);
  let mul = 1;
  let shrank = false;
  // 桌面上根本放不下这么大的东西：等比缩小到能放下（最低 55%），别让它挂到桌沿外面
  if (!surfaceFits(fit.x, fit.y, geo2)) {
    for (let k = 0.95; k >= 0.55; k -= 0.05) {
      geo2 = { w: geo.w * k, h: geo.h * k };
      const alt = fitToSurface(slot.x, slot.y, geo2);
      if (surfaceFits(alt.x, alt.y, geo2)) {
        mul = k;
        fit = alt;
        shrank = true;
        break;
      }
    }
  }
  view.phone.cx = fit.x;
  view.phone.cy = fit.y;
  view.phone.rot = Number(state.scene?.planeDeg || 0);
  view.phone.squash = Number(state.scene?.squash || 1);
  view.phone.mul = mul;
  const nudged = Math.round(Math.hypot(fit.x - slot.x, fit.y - slot.y));
  const base = slot.label || '空位';
  state.placedLabel = shrank
    ? `${base} · 桌面放不下，缩到 ${Math.round(mul * 100)}%`
    : nudged > 8
      ? `${base} · 避开桌沿 ${nudged}px`
      : base;
  return slot;
}

function clampRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/** 位置配置：自动（挑空位）/ 指定（X、Y 像素） */
function syncPlacementUI() {
  const fixed = state.placement.mode === 'fixed';
  $('btnPosAuto').classList.toggle('is-on', !fixed);
  $('btnPosFixed').classList.toggle('is-on', fixed);
  $('posX').value = view.phone ? String(Math.round(view.phone.cx)) : String(Math.round(state.placement.x || 0));
  $('posY').value = view.phone ? String(Math.round(view.phone.cy)) : String(Math.round(state.placement.y || 0));
  const canSave = Boolean(state.scene);
  $('btnSavePlacement').disabled = !canSave;
  $('btnSavePlacement').title = canSave
    ? '把当前位置写进 scene 档案，下次自动用这里'
    : '换用自己的底图时没有场景档案，存不了默认位置';
}

function applyPlacement() {
  if (!view.phone) return;
  const geo = phoneSize() || { w: 0, h: 0 };
  const clamped = clampIntoCanvas(
    clampRange($('posX').value, 0, canvas.width),
    clampRange($('posY').value, 0, canvas.height),
    geo,
  );
  const x = clamped.x;
  const y = clamped.y;
  state.placement = { mode: 'fixed', x, y };
  view.phone.cx = x;
  view.phone.cy = y;
  invalidate();
  draw();
  syncPlacementUI();
}

async function savePlacement() {
  if (!state.scene) return setStatus('当前底图没有场景档案，存不了默认位置。', 'error');
  const key = state.refLabel.replace(/\.[^.]+$/, '');
  const placement = {
    mode: state.placement.mode,
    x: Math.round(view.phone?.cx ?? state.placement.x),
    y: Math.round(view.phone?.cy ?? state.placement.y),
  };
  try {
    const res = await fetch(`/api/scene?image=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placement }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    state.scene = data.scene;
    state.placement = placement;
    syncPlacementUI();
    setStatus(
      placement.mode === 'fixed'
        ? `已把这个位置（${placement.x}, ${placement.y}）存为默认。`
        : '已设为「自动挑空位」并存为默认。',
      'ok',
    );
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function setTool(tool) {
  view.tool = tool;
  view.eraseOn = tool === 'erase';
  $('board').dataset.tool = tool;
  $('btnErase').classList.toggle('is-on', view.eraseOn);
  $('btnErase').textContent = view.eraseOn ? '橡皮（开着）' : '橡皮';
  updateBoardNote();
}

function syncSliders() {
  const phone = view.phone;
  if (!phone) return;
  $('rot').value = String(Math.round(phone.rot || 0));
  $('sizeMul').value = String(Math.round((phone.mul || 1) * 100));
  $('squash').value = String(Math.round((phone.squash || 1) * 100));
  $('rotVal').textContent = `${Math.round(phone.rot || 0)}°`;
  $('sizeVal').textContent = `${Math.round((phone.mul || 1) * 100)}%`;
  $('squashVal').textContent = `${Math.round((phone.squash || 1) * 100)}%`;
  $('bright').value = String(Math.round((phone.bright || 1) * 100));
  $('brightVal').textContent = `${Math.round((phone.bright || 1) * 100)}%`;
}

function drawRulerLine(g, ruler) {
  const k = view.base.naturalWidth / 1000;
  const length = Math.hypot(ruler.x2 - ruler.x1, ruler.y2 - ruler.y1);
  const ref = rulerRef();
  const refCm = refLongCm(ref);
  const scale = refCm && length > 8 ? length / refCm : 0;

  g.save();
  g.strokeStyle = '#1e46c9';
  g.lineWidth = 3 * k;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(ruler.x1, ruler.y1);
  g.lineTo(ruler.x2, ruler.y2);
  g.stroke();

  g.fillStyle = '#1e46c9';
  for (const [x, y] of [
    [ruler.x1, ruler.y1],
    [ruler.x2, ruler.y2],
  ]) {
    g.beginPath();
    g.arc(x, y, 6 * k, 0, Math.PI * 2);
    g.fill();
  }

  const text = scale
    ? `${trim(refCm)} cm · 1 cm ≈ ${scale.toFixed(1)} px`
    : `${Math.round(length / k >= 0 ? length : 0)} px`;
  g.font = `600 ${26 * k}px ui-sans-serif, system-ui, sans-serif`;
  const width = g.measureText(text).width;
  const padX = 14 * k;
  const boxH = 42 * k;
  const boxW = width + padX * 2;
  let bx = (ruler.x1 + ruler.x2) / 2 - boxW / 2;
  let by = (ruler.y1 + ruler.y2) / 2 - boxH - 16 * k;
  bx = Math.min(Math.max(bx, 8 * k), canvas.width - boxW - 8 * k);
  by = Math.max(by, 8 * k);

  g.beginPath();
  g.roundRect ? g.roundRect(bx, by, boxW, boxH, 8 * k) : g.rect(bx, by, boxW, boxH);
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.fill();
  g.strokeStyle = '#1e46c9';
  g.lineWidth = 1.5 * k;
  g.stroke();

  g.fillStyle = '#16267a';
  g.textBaseline = 'middle';
  g.fillText(text, bx + padX, by + boxH / 2 + k);
  g.restore();
}

/* ------------------------------------------------------------- 指针交互 */

/** 让画布的显示框正好等于图片（不留 letterbox），否则指针坐标会偏 */
function fitCanvas() {
  if (!view.base) return;
  const board = $('board');
  const avail = board.clientWidth - 2;
  const maxHeight = window.innerHeight * 0.54;
  const ratio = canvas.width / canvas.height;
  const width = Math.max(160, Math.min(avail, maxHeight * ratio));
  canvas.style.width = `${Math.round(width)}px`;
  canvas.style.height = 'auto';
}

function toImagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointerDown(event) {
  if (!view.base) return;
  const point = toImagePoint(event);
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();

  if (view.tool === 'erase' && view.phone) {
    view.drawing = 'erase';
    view.lastErase = null;
    eraseAt(point);
    invalidate();
    draw();
    return;
  }

  if (view.tool === 'move' && view.phone && phoneSize()) {
    view.drag = { dx: point.x - view.phone.cx, dy: point.y - view.phone.cy };
    return;
  }

  view.drawing = 'ruler';
  view.draft = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
}

function onPointerMove(event) {
  const point = toImagePoint(event);
  if (view.drawing === 'erase') {
    eraseAt(point);
    invalidate();
    draw();
  } else if (view.drawing === 'ruler' && view.draft) {
    view.draft.x2 = point.x;
    view.draft.y2 = point.y;
    draw();
  } else if (view.drag && view.phone) {
    view.phone.cx = point.x - view.drag.dx;
    view.phone.cy = point.y - view.drag.dy;
    invalidate();
    draw();
  }
}

function onPointerUp() {
  if (view.drawing === 'ruler' && view.draft) {
    const length = Math.hypot(view.draft.x2 - view.draft.x1, view.draft.y2 - view.draft.y1);
    if (length > 12) {
      view.ruler = view.draft;
      setTool(view.phone ? 'move' : 'ruler');
      invalidate();
      setStatus(`手量完成：1 cm ≈ ${pxPerCm().toFixed(1)} px。`, 'ok');
    }
  }
  if (view.drag && view.phone) {
    // 拖过位置就记成“指定位置”，X/Y 跟着走
    state.placement = { mode: 'fixed', x: Math.round(view.phone.cx), y: Math.round(view.phone.cy) };
  }
  view.drawing = false;
  view.drag = null;
  view.lastErase = null;
  view.draft = null;
  draw();
  updateAll();
}

/* --------------------------------------------------------------- 抠图 */
/* 白底抠图在 ./cutout.js，测试页可以直接复用 */

/** 抠完之后主体还剩多少「绿色」像素：高了说明主体和绿幕撞色，边缘被啃掉了 */
function greenShare(canvasEl) {
  const c = document.createElement('canvas');
  const scale = Math.max(canvasEl.width, canvasEl.height) / 72;
  c.width = Math.max(8, Math.round(canvasEl.width / scale));
  c.height = Math.max(8, Math.round(canvasEl.height / scale));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvasEl, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  let green = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 160) continue;
    opaque += 1;
    const r = d[i];
    const gg = d[i + 1];
    const b = d[i + 2];
    if (gg - Math.max(r, b) >= 24) green += 1;
  }
  return opaque ? green / opaque : 0;
}

/* --------------------------------------------------------------- 提示词 */

/**
 * 主体提示词。backdrop：
 *   green —— 默认，纯绿色色键幕布（白/浅色主体也能抠干净）
 *   gray  —— 备用，浅灰幕布；绿幕反光把深色布料染绿、或主体本身就是绿色时改用它
 */
function subjectPrompt(backdrop = 'green') {
  return buildSubjectPrompt(($('prompt').value || DEFAULT_SUBJECT).trim(), backdrop);
}

/* ------------------------------------------------ 名称 → 描述 + 尺寸 */

/** 顶部主按钮：有名称就一键到底，没名称但有描述就直接生图 */
function mainAction() {
  if ($('itemName').value.trim()) return quickGenerate();
  if ($('prompt').value.trim().length >= 4) return generateSubject();
  setStatus('先写个物品名称（或一句主体描述）。', 'error');
  $('itemName').focus();
}

/** 一步到底：名称 → LLM 出描述+尺寸 → 填表单 → 直接开始生图 */
async function quickGenerate() {
  const name = $('itemName').value.trim();
  if (!name) {
    setStatus('先写个物品名称，比如「马克杯」。', 'error');
    $('itemName').focus();
    return;
  }
  const info = await runDescribe(name, { refresh: false });
  if (!info) return;
  setStatus(`「${name}」按 ${trim(info.w)} × ${trim(info.h)} cm 已开抽，可以继续输入下一个名称。`, 'ok');
  // 一步到底：直接开生图（多请求互不阻塞，已有逻辑支持并发）
  generateSubject();
}

/** 只重算描述和尺寸，不重新生图 */
async function redescribe() {
  const name = $('itemName').value.trim();
  if (!name) {
    setStatus('物品名称是空的，先在左上方写一个。', 'error');
    $('itemName').focus();
    return;
  }
  const info = await runDescribe(name, { refresh: true });
  if (info) setStatus(`已按「${name}」重算：${trim(info.w)} × ${trim(info.h)} cm。点「生成主体」重新出图。`, 'ok');
}

/** 问后端（或缓存）拿描述+尺寸，填进表单，返回结果 */
async function runDescribe(name, { refresh = false } = {}) {
  if (state.quickBusy) return null;
  state.quickBusy = true;

  const panel = document.querySelector('.block-quick');
  panel?.classList.add('is-busy');
  $('btnQuick').disabled = true;
  $('btnRedescribe').disabled = true;
  $('quickHint').classList.remove('is-warn');
  $('quickHint').textContent = refresh ? `正在重新估「${name}」的描述和尺寸…` : `正在为「${name}」估算描述和尺寸…`;
  setStatus(`正在让模型写「${name}」的描述和尺寸…`, '');

  const t0 = Date.now();
  try {
    const info = await describeItem(name, refresh);
    applyItemInfo(info);

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const src =
      info.source === 'llm'
        ? info.cached
          ? `缓存 ${info.model || ''}`.trim()
          : `AI ${info.model || ''}`.trim()
        : '本地粗估';
    $('quickHint').innerHTML = `「<b>${escapeHtml(name)}</b>」→ <b>${trim(info.w)} × ${trim(info.h)} cm</b>、描述已填好（${escapeHtml(src)}，${secs}s）。`;
    if (info.warning) {
      $('quickHint').classList.add('is-warn');
      $('quickHint').innerHTML += `<br>${escapeHtml(info.warning)}`;
    }
    return info;
  } catch (err) {
    $('quickHint').textContent = `没拿到「${name}」的描述：${err.message}`;
    $('quickHint').classList.add('is-warn');
    setStatus(err.message, 'error');
    return null;
  } finally {
    state.quickBusy = false;
    panel?.classList.remove('is-busy');
    $('btnQuick').disabled = false;
    $('btnRedescribe').disabled = false;
    $('itemName').select();
  }
}

async function describeItem(name, refresh = false) {
  const res = await fetch('/api/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(refresh ? { name, refresh: true } : { name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `描述接口 HTTP ${res.status}`);
  if (!data.desc || !data.w) throw new Error('模型没给出可用的描述或尺寸');
  return data;
}

/** 把名称/描述/尺寸填进表单（尺寸参照里的「目标行」跟这是同一份数据） */
function applyItemInfo(info) {
  const name = String(info.name || $('itemName').value || '').trim() || '新物体';
  $('itemName').value = name;
  $('targetName').value = name;
  $('targetW').value = String(trim(Number(info.w) || 0));
  $('targetH').value = String(trim(Number(info.h) || Number(info.w) || 0));
  if (info.desc) $('prompt').value = String(info.desc).trim();

  state.itemInfo = { name, w: Number(info.w) || 0, h: Number(info.h) || 0, source: info.source };
  state.promptEdited = false;
  renderPromptTag();
  $('promptActions').hidden = false;

  buildRulerRefOptions();
  updateAll();
  invalidate();
  draw();
}

/** 描述标题旁的来源小标：AI 自动 / 本地粗估 / 已手改 */
function renderPromptTag() {
  const tag = $('promptTag');
  const info = state.itemInfo;
  if (!info) {
    tag.hidden = true;
    return;
  }
  tag.hidden = false;
  const dims = `${trim(info.w)}×${trim(info.h)} cm`;
  if (state.promptEdited) {
    tag.textContent = `已手改 · ${dims}`;
    tag.classList.remove('is-ai');
  } else {
    tag.textContent = `${info.source === 'llm' ? 'AI 自动' : '本地粗估'} · ${dims}`;
    tag.classList.toggle('is-ai', info.source === 'llm');
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function updateCompose() {
  $('composeText').textContent = subjectPrompt();
}

/* --------------------------------------------------------------- 生成 */

async function generateSubject() {
  if (!view.base) return;
  const model = $('model').value;
  const prompt = subjectPrompt();

  const job = {
    id: (state.jobSeq += 1),
    model,
    prompt,
    started: Date.now(),
    controller: new AbortController(),
    timer: null,
  };
  state.jobs.push(job);
  renderJobs();
  setStatus(`已发出 ${state.jobs.length} 个请求，可以继续点，先出来的先上画布。`, '');
  runJob(job);
}

async function runJob(job) {
  job.timer = setInterval(renderJobs, 100);
  try {
    let prompt = job.prompt;
    let meta = null;
    let cut = null;
    let green = 0;
    // 绿幕会反光染到深色布料上，也可能把边切掉：出问题就换浅灰幕布重画一次
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      meta = await callGenerate(
        { model: job.model, size: '1024x1024', kind: 'subject', save: false, prompt },
        job.controller.signal,
      );
      const img = new Image();
      img.src = meta.image;
      await img.decode();
      cut = cutout(img);
      if (!cut) {
        throw new Error('抠图失败：主体和幕布几乎同色，被整块抠掉了。在描述里写明颜色（比如「深灰色卫衣」）再生成。');
      }
      green = greenShare(cut);
      // 主体本身就是绿的 → 换浅灰幕布；幕布没铺满整张画面（画成卡片/带水印）→ 同样重画
      const greenish = green > 0.2;
      // 整块矩形 + 又长又直的边 = 卡片/水印被留下了（方形的手机、充电宝只有其中一条）
      const slab = cut.__fill > 0.95 && cut.__straight;
      cut.__slab = slab;
      const dirty = greenish || cut.__backdropOk === false || slab;
      if (!dirty || attempt === 2) {
        cut.__dirty = dirty;
        break;
      }
      job.note = greenish
        ? '主体偏绿，换浅灰幕布重画一次…'
        : slab
          ? '背景里有整块矩形（像卡片/水印），重画一次…'
          : '背景没铺满整张画面，重画一次…';
      renderJobs();
      setStatus(job.note, '');
      if (greenish) prompt = subjectPrompt('gray');
    }
    addCandidate(cut, meta);
    if (cut.__dirty) {
      setStatus(
        `这张还是不行（${cut.__slab ? '背景里有整块矩形/水印' : `${Math.round(green * 100)}% 像素和幕布同色`}），没自动保存。` +
          '再点一次生成，或者在描述里把颜色和形态写具体一点。',
        'error',
      );
      return;
    }
    autoSaveComposite();
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('已取消一个生成。', '');
    } else {
      state.failures.unshift({
        id: job.id,
        model: job.model,
        prompt: job.prompt,
        message: err.message || '生成失败',
      });
      setStatus(err.message, 'error');
    }
  } finally {
    if (job.timer) clearInterval(job.timer);
    state.jobs = state.jobs.filter((item) => item !== job);
    renderJobs();
  }
}

/* ------------------------------------------------------- 影调匹配 */

/** 复用一块小画布量亮度，省得每次新建 */
function measureCtx() {
  if (!measureCtx.c) {
    measureCtx.c = document.createElement('canvas');
    measureCtx.c.width = 64;
    measureCtx.c.height = 64;
  }
  measureCtx.c.getContext('2d').clearRect(0, 0, 64, 64);
  return measureCtx.c.getContext('2d', { willReadFrequently: true });
}

/** 取中位数当「这个区域有多亮」：比平均值抗干扰（数据线、纸巾包压不垮它） */
function medianLum(data, minAlpha = 0) {
  const vals = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < minAlpha) continue;
    vals.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.5)];
}

/** 主体自身的亮度（只算不透明像素），算一次就挂在 canvas 上 */
function subjectLum(img) {
  if (img.__lum) return img.__lum;
  const g = img.getContext('2d', { willReadFrequently: true });
  const step = Math.max(1, Math.floor(Math.max(img.width, img.height) / 160));
  const w = Math.max(1, Math.floor(img.width / step));
  const h = Math.max(1, Math.floor(img.height / step));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sg = small.getContext('2d', { willReadFrequently: true });
  sg.drawImage(img, 0, 0, w, h);
  const lum = medianLum(sg.getImageData(0, 0, w, h).data, 200);
  img.__lum = lum || 0;
  return img.__lum;
}

/**
 * 模型是在摄影棚强光下画的主体，你的底图往往偏暗偏暖，
 * 直接贴上去就是「一张亮图盖在暗桌上」。这里按主体所在区域的底图亮度
 * 给主体算一个亮度系数（只压暗不调亮，最多压到 45%），让两者像一个光线下拍的。
 */
function matchSubjectBrightness() {
  const phone = view.phone;
  if (!phone || !view.base) return;
  const geo = phoneSize();
  if (!geo) return;

  const bx = Math.max(0, Math.round(phone.cx - geo.w / 2));
  const by = Math.max(0, Math.round(phone.cy - geo.h / 2));
  const bw = Math.min(view.base.naturalWidth - bx, Math.round(geo.w));
  const bh = Math.min(view.base.naturalHeight - by, Math.round(geo.h));
  if (bw < 8 || bh < 8) return;

  const g = measureCtx();
  g.drawImage(view.base, bx, by, bw, bh, 0, 0, 64, 64);
  const baseLum = medianLum(g.getImageData(0, 0, 64, 64).data);
  const subjLum = subjectLum(phone.img);
  if (!baseLum || !subjLum) return;

  // 底图比主体暗多少，就把主体压暗多少；不调亮（调亮会显得更假）
  let ratio = baseLum / subjLum;
  ratio = Math.min(1.02, Math.max(0.5, ratio));
  // 只压一半：完全按桌面亮度压，深色主体会被压成一团黑
  ratio = 1 - (1 - ratio) * 0.5;
  ratio = Math.max(0.78, ratio);
  // 别做无谓的微调
  if (Math.abs(ratio - 1) < 0.03) ratio = 1;
  phone.bright = Math.round(ratio * 100) / 100;
}

/* --------------------------------------------------------------- 候选 */

function addCandidate(cut, meta) {
  const candidate = {
    id: `c${state.candidates.length + 1}-${Date.now()}`,
    cut,
    thumb: cut.toDataURL('image/png'),
    meta,
  };
  state.candidates.unshift(candidate);
  if (state.candidates.length > 8) state.candidates.length = 8; // 只留最近 8 版，缩略图都是 base64
  applyCandidate(candidate, { autoPlace: true });
  showGenerated({
    url: candidate.thumb,
    file: '',
    title: '白底主体 · 已贴到画布',
    meta: `${meta.model} · ${(meta.ms / 1000).toFixed(1)}s · 中间图不落盘`,
    thumb: candidate.thumb,
  });
  setStatus(`出图：${meta.model} · ${(meta.ms / 1000).toFixed(1)} 秒，已自动贴上画布。`, 'ok');
}

function applyCandidate(candidate, opts = {}) {
  const previous = view.phone;
  view.phone = {
    img: candidate.cut,
    w: candidate.cut.width,
    h: candidate.cut.height,
    cx: previous?.cx ?? canvas.width * 0.42,
    cy: previous?.cy ?? canvas.height * 0.58,
    rot: previous?.rot ?? 0,
    mul: previous?.mul ?? 1,
    squash: previous?.squash ?? 1,
    cmLong: Math.max(readTarget().w, readTarget().h) || 15.2,
  };
  setTool('move');
  if (opts.autoPlace) autoPlace();
  matchSubjectBrightness(); // 自动把主体压到底图那个光照水平
  syncSliders();
  invalidate();
  draw();
  updateAll();
  renderCandidates(candidate.id);
}

function renderCandidates(activeId) {
  const box = $('candidates');
  box.innerHTML = '';
  box.hidden = state.candidates.length < 1;
  if (box.hidden) return;

  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = '候选';
  box.append(label);

  for (const candidate of state.candidates) {
    const img = document.createElement('img');
    img.src = candidate.thumb;
    img.alt = '候选主体';
    img.title = `${candidate.meta.model} · ${(candidate.meta.ms / 1000).toFixed(1)}s（点击换这一版）`;
    if (activeId && candidate.id === activeId) img.classList.add('is-on');
    img.addEventListener('click', () => {
      applyCandidate(candidate);
      setStatus('已换成这一版主体。', '');
    });
    box.append(img);
  }
}

function renderJobs() {
  const box = $('jobs');
  box.innerHTML = '';
  const total = state.jobs.length + state.failures.length;
  box.hidden = total === 0;
  if (!total) return;

  for (const job of state.jobs) {
    const row = document.createElement('div');
    row.className = 'job';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const name = document.createElement('span');
    name.className = 'job-name';
    name.textContent = job.model;
    const clock = document.createElement('span');
    clock.textContent = `${((Date.now() - job.started) / 1000).toFixed(1)}s`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-tiny';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => job.controller.abort());
    row.append(spinner, name, clock);
    if (job.note) {
      const note = document.createElement('span');
      note.className = 'job-msg';
      note.textContent = job.note;
      row.append(note);
    }
    row.append(cancel);
    box.append(row);
  }

  for (const failure of state.failures) {
    const row = document.createElement('div');
    row.className = 'job is-error';
    const name = document.createElement('span');
    name.className = 'job-name';
    name.textContent = `${failure.model} 失败`;
    const msg = document.createElement('span');
    msg.className = 'job-msg';
    msg.textContent = failure.message;
    msg.title = failure.message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-tiny';
    retry.textContent = '重试';
    retry.addEventListener('click', () => {
      state.failures = state.failures.filter((item) => item !== failure);
      renderJobs();
      const job = { id: (state.jobSeq += 1), model: failure.model, prompt: failure.prompt, started: Date.now(), controller: new AbortController(), timer: null };
      state.jobs.push(job);
      renderJobs();
      runJob(job);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-tiny';
    close.textContent = '×';
    close.addEventListener('click', () => {
      state.failures = state.failures.filter((item) => item !== failure);
      renderJobs();
    });
    row.append(name, msg, retry, close);
    box.append(row);
  }
}

async function callGenerate(body, signal) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({ error: '上游返回了无法解析的内容' }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (!data.image) throw new Error(data.error || '上游没给出图片，再点一次试试。');
  if (data.warning) setStatus(data.warning, 'error');
  return data;
}

/* --------------------------------------------------------------- 导出 */

function renderExport() {
  if (view.layerDirty || !view.layer) rebuildLayer();
  const out = document.createElement('canvas');
  out.width = view.base.naturalWidth;
  out.height = view.base.naturalHeight;
  const g = out.getContext('2d');
  g.drawImage(view.base, 0, 0);
  if (view.layer) g.drawImage(view.layer, 0, 0);
  return out.toDataURL('image/jpeg', 0.94);
}

async function saveComposite() {
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: renderExport(),
      name: readTarget().name,
      prompt: $('prompt').value.trim(),
      size: `${canvas.width}x${canvas.height}`,
      pxPerCm: Number(pxPerCm().toFixed(2)),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let autoSaveSeq = 0;

/** 主体一贴到画布就存一张成品：生成完直接能在 output/ 里找到 */
async function autoSaveComposite() {
  if (!view.phone || !pxPerCm()) return;
  const seq = ++autoSaveSeq;
  if (seq > 1) setStatus('又在生成新的…上一张会自动保存，先出的先存。', '');
  try {
    const data = await saveComposite();
    if (seq !== autoSaveSeq) return;
    $('btnSave').href = data.url;
    $('btnSave').setAttribute('download', data.file);
    $('btnSave').hidden = false;
    showGenerated({
      url: data.url,
      file: data.file,
      title: '合成结果 · 已自动保存到 output/',
      meta: `${data.file} · ${data.size} · 1 cm ≈ ${pxPerCm().toFixed(1)} px`,
      thumb: data.url,
    });
    setStatus(`已自动保存：output/${data.file}`, 'ok');
    await loadHistory(data.id);
  } catch (err) {
    if (seq === autoSaveSeq) setStatus(`自动保存失败：${err.message}（可点 ⑥ 手动导出）`, 'error');
  }
}

async function exportComposite() {
  if (!view.phone) return setStatus('先生成主体。', 'error');
  if (!pxPerCm()) return setStatus('先在底图上标定参照物的宽度，尺寸才有依据。', 'error');

  $('btnExport').disabled = true;
  setStatus('正在合成并保存…', '');
  try {
    const data = await saveComposite();

    $('btnSave').href = data.url;
    $('btnSave').setAttribute('download', data.file);
    $('btnSave').hidden = false;
    $('stageTitle').textContent = `实拍合成 · ${timeOf(data.createdAt)}`;
    $('stageBadge').textContent = `合成 · ${trim(readTarget().w)} cm 宽 · 1 cm ≈ ${pxPerCm().toFixed(1)} px`;
    showGenerated({
      url: data.url,
      file: data.file,
      title: '合成结果 · 已保存到 output/',
      meta: `${data.file} · ${data.size} · 1 cm ≈ ${pxPerCm().toFixed(1)} px`,
      thumb: data.url,
    });
    setStatus(`已保存 ${data.file}。点“下载”存到本地，或点下面的“在文件夹里看”。`, 'ok');
    await loadHistory(data.id);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('btnExport').disabled = !(view.phone && pxPerCm());
  }
}

/* --------------------------------------------------------------- 状态 */

function setStatus(text, kind = '') {
  const node = $('status');
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

/* --------------------------------------------------------------- 汇总 */

function updateAll() {
  renderRulerBars();
  renderFinding();
  updateCompose();
  updateToolstrip();
  updateBoardNote();
}

function updateToolstrip() {
  const scale = pxPerCm();
  $('rulerVal').textContent = scale
    ? `${view.ruler ? '手量' : '预标定'} · 1 cm ≈ ${scale.toFixed(1)} px`
    : '未标定';

  const geo = phoneSize();
  const target = readTarget();
  // 又长又细是正常物品（口红、笔、数据线）；只有「比你自己填的还夸张很多」才提醒
  const extreme =
    geo && Math.max(geo.aspect, 1 / geo.aspect) > 8 && Math.max(geo.aspect, 1 / geo.aspect) / Math.max(geo.targetAspect, 1) > 2;
  $('subjectVal').textContent = view.phone
    ? geo
      ? `${trim(geo.longCm)} cm 长边 → ${Math.round(geo.w)}×${Math.round(geo.h)} px` +
        (extreme
          ? '（切图太细长，像是被拉过 —— 换个描述重画更稳）'
          : aspectNote(geo)
            ? '（切图比例与填的尺寸不同，按长边对齐）'
            : '')
      : `${trim(target.w)} cm，等标定`
    : '白底主体会自动抠图';

  $('btnExport').disabled = !(view.phone && scale);
  $('btnUseProfile').hidden = !(state.scene && view.ruler);
  $('btnErase').disabled = !view.phone;
  syncPlacementUI();

  $('stageTitle').textContent = view.phone
    ? `实拍合成 · ${target.name}`
    : scale
      ? '实拍合成 · 等生成主体'
      : '实拍合成 · 等待标定';
}

function updateBoardNote() {
  const note = $('boardNote');
  if (!pxPerCm()) {
    note.textContent = `① 在底图上沿${rulerRef().name}最长的一边拖一条线，把厘米换成像素`;
  } else if (!view.phone) {
    note.textContent = `② 写个物品名称按回车（或一句描述），自动出描述和尺寸后直接生图；抠图完按 ${trim(readTarget().w)} cm 放进空位`;
  } else if (view.eraseOn) {
    note.textContent = '在压住它的东西上刷：露回底图就是遮挡（数据线、纸巾包边、桌角）';
  } else {
    note.textContent = '';
  }
}

function renderRulerBars() {
  const target = readTarget();
  const refs = readRefs().filter((r) => refLongCm(r) > 0);
  const items = [
    ...refs.map((r) => ({ name: r.name, cm: refLongCm(r), isTarget: false })),
    { name: target.name, cm: Math.max(target.w, target.h), isTarget: true },
  ];
  const max = Math.max(...items.map((i) => i.cm), 1);

  const box = $('ruler');
  box.innerHTML = '';
  for (const item of items) {
    if (!item.cm) continue;
    const row = document.createElement('div');
    row.className = `ruler-row${item.isTarget ? ' is-target' : ''}`;
    const name = document.createElement('span');
    name.className = 'ruler-name';
    name.textContent = item.name;
    const track = document.createElement('span');
    track.className = 'ruler-track';
    const bar = document.createElement('i');
    bar.className = 'ruler-bar';
    bar.style.width = `${Math.max(2, Math.round((item.cm / max) * 100))}%`;
    track.append(bar);
    const val = document.createElement('span');
    val.className = 'ruler-val';
    val.textContent = `${trim(item.cm)} cm`;
    row.append(name, track, val);
    box.append(row);
  }
}

function renderFinding() {
  const node = $('finding');
  node.textContent = '';
  node.hidden = false;
  const target = readTarget();
  const ref = rulerRef();
  const scale = pxPerCm();

  if (!scale) {
    node.append('画面里的尺子：');
    const b = document.createElement('b');
    b.textContent = readRefs().filter((r) => refLongCm(r)).map((r) => `${r.name} ${trim(refLongCm(r))} cm`).join('、') || '参照物';
    node.append(b, `。在底图上沿${ref.name}的长边拖一条线，就能把厘米换成像素，${target.name}按 ${trim(target.w)} × ${trim(target.h)} cm 贴进去。`);
    return;
  }

  // 已经预标定好、又没手量过 → 不显示说明行（比例在工具条第 1 步里就有）
  if (!view.ruler) {
    node.hidden = true;
    return;
  }

  const length = Math.hypot(view.ruler.x2 - view.ruler.x1, view.ruler.y2 - view.ruler.y1);
  const phonePx = Math.round(target.w * scale);
  node.append(`${ref.name} ${trim(ref.w)} cm 在底图上量得 `);
  const num1 = document.createElement('span');
  num1.className = 'num';
  num1.textContent = `${Math.round(length)} px`;
  const num2 = document.createElement('span');
  num2.className = 'num';
  num2.textContent = `${phonePx} px`;
  node.append(num1, `，所以 1 cm ≈ ${scale.toFixed(1)} px。${target.name} ${trim(target.w)} cm 宽就是 `, num2, '，贴进去即真实比例。');
}

/* --------------------------------------------------------------- 历史 */

async function loadHistory(activeId) {
  const data = await fetch('/api/history').then((r) => r.json()).catch(() => ({ items: [] }));
  state.history = data.items || [];
  renderHistory(activeId ?? state.current?.id);
}

function renderHistory(activeId) {
  const box = $('history');
  box.innerHTML = '';
  $('historyCount').textContent = state.history.length ? `${state.history.length} 张` : '';

  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '还没有记录。生成主体后会自动存一张到 output/，并出现在这里。';
    box.append(empty);
    return;
  }

  for (const item of state.history) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `tile${item.id === activeId ? ' is-active' : ''}`;
    tile.dataset.id = item.id;
    tile.title = `${labelOf(item)}\n${item.prompt || ''}`;
    tile.addEventListener('click', () => {
      openLightbox(item.url, `${labelOf(item)} · ${timeOf(item.createdAt)} · ${item.file}`);
      for (const other of document.querySelectorAll('.tile')) {
        other.classList.toggle('is-active', other.dataset.id === item.id);
      }
    });

    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.file;
    img.loading = 'lazy';

    const caption = document.createElement('span');
    caption.textContent = `${timeOf(item.createdAt)} · ${labelOf(item)}`;

    tile.append(img, caption);
    box.append(tile);
  }
}

function showGenerated({ url, file, title, meta, thumb }) {
  state.lastFile = { url, caption: `${title} · ${file}` };
  $('genResult').hidden = false;
  $('genTitle').textContent = title;
  $('genMeta').textContent = meta;
  $('genThumb').src = thumb || url;
  $('genDownload').hidden = !file;
  if (file) {
    $('genDownload').href = url;
    $('genDownload').setAttribute('download', file);
  } else {
    $('genDownload').removeAttribute('href');
    $('genDownload').removeAttribute('download');
  }
}

async function revealOutput() {
  try {
    const res = await fetch('/api/reveal', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '打不开文件夹');
    setStatus(`已在资源管理器里打开：${data.dir}`, 'ok');
  } catch (err) {
    setStatus(`${err.message}（手动打开项目里的 output/ 文件夹即可）`, 'error');
  }
}

function openLightbox(url, caption) {
  $('lightboxImg').src = url;
  $('lightboxCap').textContent = caption || '';
  $('lightbox').hidden = false;
}

function closeLightbox() {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
}

function labelOf(item) {
  if (item.kind === 'composite' || item.model === 'composite') return item.name || '合成';
  if (item.kind === 'subject') return '白底主体';
  return item.model === 'gemini-2.5-flash-image' ? 'gemini-flash' : item.model;
}

function timeOf(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* --------------------------------------------------------------- 示例 */

function applyExample() {
  const rows = [...document.querySelectorAll('[data-role="ref"]')];
  rows.forEach((row, index) => {
    const preset = DEFAULTS.refs[index];
    if (!preset) return;
    const inputs = row.querySelectorAll('input');
    inputs[0].value = preset.name;
    inputs[1].value = String(preset.w);
    inputs[2].value = String(preset.h);
  });
  $('targetName').value = DEFAULTS.target.name;
  $('targetW').value = String(DEFAULTS.target.w);
  $('targetH').value = String(DEFAULTS.target.h);
  if (view.phone) {
    view.phone.rot = 0;
    view.phone.mul = 1;
    view.phone.squash = 1;
    syncSliders();
    invalidate();
  }
  $('prompt').value = DEFAULT_SUBJECT;
  $('itemName').value = '';
  state.itemInfo = null;
  state.promptEdited = false;
  renderPromptTag();
  $('promptActions').hidden = true;
  buildRulerRefOptions();
  updateAll();
  draw();
  setStatus('已填回示例参数。', 'ok');
}
