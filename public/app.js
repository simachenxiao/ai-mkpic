const $ = (id) => document.getElementById(id);

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

function phoneSize() {
  const scale = pxPerCm() || provisionalScale();
  const phone = view.phone;
  if (!phone || !scale) return null;

  const target = readTarget();
  const shortCm = target.w || phone.cmW || 7.2; // 宽 = 短边
  const longCm = target.h || phone.cmH || shortCm * (phone.h / phone.w); // 长 = 长边
  const mul = phone.mul || 1;

  // 切图横躺就把长边放到水平方向，竖着放就放到垂直方向
  const landscape = phone.w >= phone.h;
  const w = (landscape ? longCm : shortCm) * scale * mul;
  const h = (landscape ? shortCm : longCm) * scale * mul;
  return { w, h };
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
  g.translate(lightVector().x * geo.w * 0.06, lightVector().y * geo.w * 0.06);
  g.rotate(rad);
  g.scale(geo.w * 0.54, geo.h * 0.5 * squash);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, 'rgba(10,10,12,0.42)');
  grad.addColorStop(0.68, 'rgba(10,10,12,0.26)');
  grad.addColorStop(1, 'rgba(10,10,12,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 1, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // 主体（带透视压缩）
  g.save();
  g.rotate(rad);
  g.scale(1, squash);
  g.drawImage(phone.img, -geo.w / 2, -geo.h / 2, geo.w, geo.h);
  if (phone.bright) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = phone.bright > 0 ? `rgba(255,255,255,${phone.bright})` : `rgba(0,0,0,${-phone.bright})`;
    g.fillRect(-geo.w / 2, -geo.h / 2, geo.w, geo.h);
    g.globalCompositeOperation = 'source-over';
  }
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
    view.phone.cx = clampRange(state.placement.x, 0, canvas.width);
    view.phone.cy = clampRange(state.placement.y, 0, canvas.height);
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
  view.phone.cx = slot.x;
  view.phone.cy = slot.y;
  view.phone.rot = Number(state.scene?.planeDeg || 0);
  view.phone.squash = Number(state.scene?.squash || 1);
  view.phone.mul = 1;
  state.placedLabel = slot.label || '';
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
  const x = clampRange($('posX').value, 0, canvas.width);
  const y = clampRange($('posY').value, 0, canvas.height);
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

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function cutout(img) {
  const work = document.createElement('canvas');
  work.width = img.naturalWidth;
  work.height = img.naturalHeight;
  const g = work.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);

  const image = g.getImageData(0, 0, work.width, work.height);
  const px = image.data;
  const w = work.width;
  const h = work.height;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = px[i];
      const gg = px[i + 1];
      const b = px[i + 2];
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
      // 白底 → 透明；白底上的灰影留一半，浅色但有彩度的物体整块留下
      let alpha = Math.min(1, Math.max(0, (236 - lum) / 58));
      if (sat > 24 && lum > 140) alpha = Math.max(alpha, 0.9);
      alpha *= px[i + 3] / 255;

      if (alpha < 0.05) {
        px[i + 3] = 0;
        continue;
      }
      if (alpha < 0.99) {
        // 边缘是和白底混过的像素，先除掉白底，贴到别处才不会留一圈白边
        const inv = 1 / alpha;
        const outA = 255 * (1 - alpha);
        px[i] = clamp8((px[i] - outA) * inv);
        px[i + 1] = clamp8((px[i + 1] - outA) * inv);
        px[i + 2] = clamp8((px[i + 2] - outA) * inv);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  // 先粗网格找最大连通块，水印那种角落小碎块会被排除掉
  const G = 64;
  const cw0 = work.width / G;
  const ch0 = work.height / G;
  const cell = new Float32Array(G * G);
  for (let y = 0; y < h; y += 1) {
    const gy = Math.min(G - 1, Math.floor(y / ch0));
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 150) cell[gy * G + Math.min(G - 1, Math.floor(x / cw0))] += 1;
    }
  }
  const cellArea = cw0 * ch0;
  const solid = new Uint8Array(G * G);
  for (let i = 0; i < cell.length; i += 1) solid[i] = cell[i] > cellArea * 0.12 ? 1 : 0;

  let best = null;
  const seen = new Uint8Array(G * G);
  for (let i = 0; i < solid.length; i += 1) {
    if (!solid[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let count = 0;
    let gx0 = G;
    let gx1 = -1;
    let gy0 = G;
    let gy1 = -1;
    while (stack.length) {
      const idx = stack.pop();
      const gx = idx % G;
      const gy = (idx - gx) / G;
      count += 1;
      if (gx < gx0) gx0 = gx;
      if (gx > gx1) gx1 = gx;
      if (gy < gy0) gy0 = gy;
      if (gy > gy1) gy1 = gy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const nidx = ny * G + nx;
        if (solid[nidx] && !seen[nidx]) {
          seen[nidx] = 1;
          stack.push(nidx);
        }
      }
    }
    if (!best || count > best.count) best = { count, gx0, gx1, gy0, gy1 };
  }

  if (!best || best.count < 4) return null;

  // 在选中的块里按像素收紧边框
  let x0 = Math.floor(best.gx0 * cw0);
  let x1 = Math.min(w - 1, Math.ceil((best.gx1 + 1) * cw0));
  let y0 = Math.floor(best.gy0 * ch0);
  let y1 = Math.min(h - 1, Math.ceil((best.gy1 + 1) * ch0));
  let ix0 = x1;
  let iy0 = y1;
  let ix1 = x0;
  let iy1 = y0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 150) {
        if (x < ix0) ix0 = x;
        if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y;
        if (y > iy1) iy1 = y;
      }
    }
  }
  const pad = 3;
  x0 = Math.max(0, ix0 - pad);
  y0 = Math.max(0, iy0 - pad);
  x1 = Math.min(w - 1, ix1 + pad);
  y1 = Math.min(h - 1, iy1 + pad);

  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  if (cw < 60 || ch < 60) return null;

  g.putImageData(image, 0, 0);
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(work, x0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

/* --------------------------------------------------------------- 提示词 */

function subjectPrompt() {
  const desc = ($('prompt').value || DEFAULT_SUBJECT).trim();
  return `${desc}。正俯视图：镜头垂直向下 90°，正交投影，物体平铺在纯白色背景上，没有透视、没有斜角、没有侧立面；画面里只有这一个物体，没有别的物品、没有文字、没有水印，光线均匀。主体要和白色背景形成明显对比，不要画成白色或浅色的。`;
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

function scaleClause() {
  const target = readTarget();
  const refs = readRefs().filter((r) => r.w > 0);
  if (!target.w || !refs.length) return '';
  const ref = refs[0];
  const lines = [`尺寸：${target.name}实际宽 ${trim(target.w)} cm${target.h ? `、长 ${trim(target.h)} cm` : ''}；画面里${ref.name}宽约 ${trim(ref.w)} cm。`];
  lines.push(`${target.name}宽度约为${ref.name}宽度的 ${(target.w / ref.w).toFixed(2)} 倍`);
  if (target.h && ref.h) lines.push(`${target.name}长度约为${ref.name}长度的 ${(target.h / ref.h).toFixed(2)} 倍`);
  lines.push('请按这个真实比例摆放，不要放大。');
  return lines.join('');
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
    const meta = await callGenerate(
      { model: job.model, size: '1024x1024', kind: 'subject', save: false, prompt: job.prompt },
      job.controller.signal,
    );
    const img = new Image();
    img.src = meta.image;
    await img.decode();
    const cut = cutout(img);
    if (!cut) throw new Error('抠图失败：主体几乎全是白色。换个深色主体，或在描述里写明颜色。');
    addCandidate(cut, meta);
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

/* --------------------------------------------------------------- 候选 */

function addCandidate(cut, meta) {
  const candidate = {
    id: `c${state.candidates.length + 1}-${Date.now()}`,
    cut,
    thumb: cut.toDataURL('image/png'),
    meta,
  };
  state.candidates.unshift(candidate);
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
    cmW: readTarget().w || 7.2,
  };
  setTool('move');
  if (opts.autoPlace) autoPlace();
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
    row.append(spinner, name, clock, cancel);
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
  $('subjectVal').textContent = view.phone
    ? geo
      ? `${trim(target.w)}×${trim(target.h)} cm → ${Math.round(geo.w)}×${Math.round(geo.h)} px（宽×高）`
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
