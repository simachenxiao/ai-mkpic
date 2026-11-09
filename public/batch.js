/**
 * 批量生成面板：跑在同一个页面里（右上角「批量」进入）。
 * 名单来自 /batch/items.json（物品名称分类汇总_最新.xlsx 导出的），
 * 每条走：/api/describe → /api/generate → cutout → 合成 → /api/save，
 * 并发 N 个（3~5 可选），进度、失败重试、断点续跑（localStorage）都在面板里。
 */
import { cutout } from '/cutout.js';
import { autoSurfaceMask, buildSubjectPrompt, decodeSurface, placeOnSurface, sizeForCut } from '/scene-core.js';

const STORE_KEY = 'batch.results.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  host: null,
  built: false,
  items: [],
  results: new Map(),
  running: false,
  paused: false,
  stop: false,
  queue: [],
  workers: 0,
  scene: null,
  base: null,
  surf: null,
  slots: [],
  occupied: [],
  model: 'gpt-image-2',
  pxPerCm: 12.9,
  startedAt: 0,
};

const q = (sel) => state.host.querySelector(sel);

/* ------------------------------------------------------------------ 合成 */

function ctx2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

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

const lumCache = new WeakMap();

function subjectLum(canvasEl) {
  if (lumCache.has(canvasEl)) return lumCache.get(canvasEl);
  const step = Math.max(1, Math.floor(Math.max(canvasEl.width, canvasEl.height) / 160));
  const w = Math.max(1, Math.floor(canvasEl.width / step));
  const h = Math.max(1, Math.floor(canvasEl.height / step));
  const { g } = ctx2d(w, h);
  g.drawImage(canvasEl, 0, 0, w, h);
  const lum = medianLum(g.getImageData(0, 0, w, h).data, 200) || 0;
  lumCache.set(canvasEl, lum);
  return lum;
}

function lightVector() {
  const deg = Number(state.scene?.lightDeg ?? 135);
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** 底图 + 投影 + 主体（规则与单张模式一致：长边对齐、影调只压一半、径向软投影） */
function compose(cut, geo, cx, cy) {
  const W = state.base.naturalWidth;
  const H = state.base.naturalHeight;
  const { c, g } = ctx2d(W, H);
  g.drawImage(state.base, 0, 0);

  const rot = Number(state.scene?.planeDeg ?? 0);
  const squash = Number(state.scene?.squash ?? 1);
  const rad = (rot * Math.PI) / 180;

  let bright = 1;
  const bx = Math.max(0, Math.min(W - 8, Math.round(cx - geo.w / 2)));
  const by = Math.max(0, Math.min(H - 8, Math.round(cy - geo.h / 2)));
  const bw = Math.max(8, Math.min(W - bx, Math.round(geo.w)));
  const bh = Math.max(8, Math.min(H - by, Math.round(geo.h)));
  const { g: mg } = ctx2d(64, 64);
  mg.drawImage(state.base, bx, by, bw, bh, 0, 0, 64, 64);
  const baseLum = medianLum(mg.getImageData(0, 0, 64, 64).data);
  const subjLum = subjectLum(cut);
  if (baseLum && subjLum) {
    let ratio = Math.min(1.02, Math.max(0.5, baseLum / subjLum));
    ratio = 1 - (1 - ratio) * 0.5;
    ratio = Math.max(0.78, ratio);
    if (Math.abs(ratio - 1) >= 0.03) bright = ratio;
  }

  g.save();
  g.translate(cx, cy);
  g.save();
  const lv = lightVector();
  g.translate(lv.x * geo.w * 0.13, lv.y * geo.w * 0.13);
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

  g.save();
  g.rotate(rad);
  g.scale(1, squash);
  if (bright !== 1) g.filter = `brightness(${bright})`;
  g.drawImage(cut, -geo.w / 2, -geo.h / 2, geo.w, geo.h);
  g.filter = 'none';
  g.restore();
  g.restore();

  return c;
}

/* ------------------------------------------------------------------ 面板 */

const TEMPLATE = `
  <div class="batch">
    <div class="batch-head">
      <h2>批量生成</h2>
      <span class="sub" id="bSrc">读取名单…</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-tiny" id="bBack" type="button">返回单张</button>
    </div>

    <div class="batch-bar">
      <label class="bfield"><strong>并发</strong>
        <select class="input" id="bConc">
          <option value="1">1（最稳）</option>
          <option value="2">2</option>
          <option value="3" selected>3</option>
          <option value="4">4</option>
          <option value="5">5（上游可能拒绝）</option>
        </select>
      </label>
      <label class="bfield"><strong>这次跑</strong>
        <input class="input" id="bLimit" type="number" min="0" step="1" value="0" />
      </label>
      <label class="bfield"><strong>模型</strong>
        <select class="input" id="bModel"></select>
      </label>
      <label class="bfield"><strong>参照长边 cm</strong>
        <input class="input" id="bRef" type="number" min="0.5" step="0.1" value="5.5" />
      </label>
      <div class="batch-actions">
        <button class="btn btn-primary btn-tiny" id="bStart" type="button">开始</button>
        <button class="btn btn-tiny" id="bPause" type="button" disabled>暂停</button>
        <button class="btn btn-tiny" id="bStop" type="button" disabled>停止</button>
        <button class="btn btn-tiny" id="bRetry" type="button" disabled>重试失败</button>
        <button class="btn btn-tiny" id="bClear" type="button">清空记录</button>
      </div>
    </div>

    <div class="batch-progress">
      <div class="bbar"><i id="bBar"></i></div>
      <div class="bstat" id="bStat">尚未开始</div>
      <div class="bstat" id="bPx">—</div>
    </div>

    <div class="batch-list">
      <table>
        <thead>
          <tr>
            <th style="width:40px">#</th>
            <th style="width:128px">物品</th>
            <th style="width:150px">分类</th>
            <th style="width:104px">状态</th>
            <th style="width:58px">耗时</th>
            <th style="width:60px">预览</th>
            <th>结果 / 说明</th>
          </tr>
        </thead>
        <tbody id="bRows"></tbody>
      </table>
    </div>

    <p class="batch-note">
      成品写进 <code>output/</code>（文件名 = 物品名 + 时间）；白底主体不落盘。
      已完成的默认跳过，可「清空记录」重跑。任务在浏览器里合成，跑的时候别关这个页面。
    </p>
  </div>`;

function paintRow(name) {
  const tr = q(`tr[data-name="${CSS.escape(name)}"]`);
  if (!tr) return;
  const res = state.results.get(name) || {};
  tr.classList.toggle('is-done', res.status === '完成');
  tr.classList.toggle('is-fail', res.status === '失败');
  tr.classList.toggle('is-run', res.status === '运行中');
  const tag = tr.querySelector('.btag');
  tag.className = `btag${res.status === '完成' ? ' ok' : res.status === '失败' ? ' err' : res.status === '运行中' ? ' run' : ''}`;
  tag.textContent = res.step || res.status || '待生成';
  tr.querySelector('.bmono-time').textContent = res.ms ? `${(res.ms / 1000).toFixed(0)}s` : '—';
  const thumb = tr.querySelector('.bthumb');
  if (thumb && res.url && thumb.getAttribute('src') !== res.url) thumb.src = res.url;
  tr.querySelector('.bfile').textContent = res.file ? res.file + (res.note ? `（${res.note}）` : '') : res.error || '';
}

function updateProgress() {
  const all = state.items.length;
  const done = [...state.results.values()].filter((r) => r.status === '完成').length;
  const failed = [...state.results.values()].filter((r) => r.status === '失败').length;
  const touched = done + failed;
  q('#bBar').style.width = `${all ? Math.round((touched / all) * 100) : 0}%`;
  const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const speed = elapsed > 5 ? touched / elapsed : 0;
  const eta = speed > 0 ? Math.max(0, Math.round((all - touched) / speed / 60)) : 0;
  q('#bStat').textContent =
    `完成 ${done} · 失败 ${failed} · 共 ${all} 条` +
    (state.running ? ` · 在跑 ${state.workers}` : '') +
    (elapsed > 1 ? ` · 已用 ${Math.max(1, Math.round(elapsed / 60))} 分` : '') +
    (speed > 0 && touched < all ? ` · 预计还要 ${eta} 分` : '');
  q('#bPause').disabled = !state.running;
  q('#bPause').textContent = state.paused ? '继续' : '暂停';
  q('#bStop').disabled = !state.running;
  q('#bRetry').disabled = state.running || !failed;
  q('#bStart').disabled = state.running;
}

function persist() {
  const plain = [...state.results.entries()].map(([name, r]) => [
    name,
    { status: r.status, step: r.step, file: r.file, ms: r.ms, error: r.error, note: r.note, at: r.at },
  ]);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(plain));
  } catch {
    /* 存不下就只留在内存 */
  }
}

function loadStore() {
  try {
    for (const [name, res] of JSON.parse(localStorage.getItem(STORE_KEY) || '[]')) {
      state.results.set(name, { ...res, status: res.status === '运行中' ? '待生成' : res.status });
    }
  } catch {
    /* 忽略 */
  }
}

function renderTable() {
  const tbody = q('#bRows');
  tbody.innerHTML = '';
  state.items.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.dataset.name = item.name;
    tr.innerHTML = `<td class="bmono">${i + 1}</td>
      <td class="bname"><b></b></td>
      <td class="bmono">${item.category || '—'}</td>
      <td><span class="btag"></span></td>
      <td class="bmono bmono-time">—</td>
      <td><img class="bthumb" alt="" /></td>
      <td class="bfile"></td>`;
    tr.querySelector('.bname b').textContent = item.name;
    tbody.append(tr);
    paintRow(item.name);
  });
}

/* ------------------------------------------------------------------ 跑批 */

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务端返回了非 JSON（${res.status}）`);
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function setStep(name, step) {
  const prev = state.results.get(name) || {};
  state.results.set(name, { ...prev, status: '运行中', step });
  paintRow(name);
}

async function processItem(item) {
  const name = item.name;
  const t0 = Date.now();
  setStep(name, '写描述…');
  const info = await postJSON('/api/describe', { name });
  const longCm = Math.max(Number(info.w) || 8, Number(info.h) || 8);

  setStep(name, '出图中…');
  const meta = await postJSON('/api/generate', {
    model: state.model,
    size: '1024x1024',
    kind: 'subject',
    save: false,
    prompt: buildSubjectPrompt(info.desc, 'green'),
  });
  const img = new Image();
  img.src = meta.image;
  await img.decode();

  setStep(name, '抠图中…');
  let cut = cutout(img);
  if (!cut || cut.__backdropOk === false || cut.__fill > 0.95) {
    setStep(name, '重画（浅灰幕布）…');
    const retry = await postJSON('/api/generate', {
      model: state.model,
      size: '1024x1024',
      kind: 'subject',
      save: false,
      prompt: buildSubjectPrompt(info.desc, 'gray'),
    });
    const img2 = new Image();
    img2.src = retry.image;
    await img2.decode();
    const cut2 = cutout(img2);
    if (cut2) cut = cut2;
  }
  if (!cut) throw new Error('抠图失败：主体和幕布撞色');

  setStep(name, '合成…');
  const placed = placeOnSurface({
    surf: state.surf,
    canvasW: state.base.naturalWidth,
    canvasH: state.base.naturalHeight,
    slots: state.slots,
    occupied: state.occupied,
    geo: sizeForCut(cut.width, cut.height, longCm, state.pxPerCm, 1),
    rotDeg: Number(state.scene?.planeDeg ?? 0),
    squash: Number(state.scene?.squash ?? 1),
  });
  const geo = sizeForCut(cut.width, cut.height, longCm * placed.mul, state.pxPerCm, 1);
  const out = compose(cut, geo, placed.x, placed.y);

  setStep(name, '保存…');
  const saved = await postJSON('/api/save', {
    image: out.toDataURL('image/jpeg', 0.94),
    name,
    prompt: buildSubjectPrompt(info.desc, 'green'),
    size: `${out.width}x${out.height}`,
    pxPerCm: Number(state.pxPerCm.toFixed(2)),
  });

  state.results.set(name, {
    status: '完成',
    step: '完成',
    file: saved.file,
    url: saved.url,
    ms: Date.now() - t0,
    at: new Date().toISOString(),
    note: placed.shrank ? `缩放 ${Math.round(placed.mul * 100)}%` : '',
  });
  paintRow(name);
  updateProgress();
  persist();
}

/** 单条最多试 3 次，退避 0 / 10s / 30s（上游抖动时很有用） */
const RETRY_WAITS = [0, 10000, 30000];

async function processItemWithRetry(item) {
  let lastError = null;
  for (let i = 0; i < RETRY_WAITS.length; i += 1) {
    if (state.stop) throw new Error('已停止');
    if (RETRY_WAITS[i]) {
      setStep(item.name, `等 ${RETRY_WAITS[i] / 1000}s 重试…`);
      await sleep(RETRY_WAITS[i]);
    }
    if (state.paused) {
      // 暂停时别硬跑
      while (state.paused && !state.stop) await sleep(400);
      if (state.stop) throw new Error('已停止');
    }
    try {
      await processItem(item);
      state.netFails = 0;
      return;
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || '');
      const network = /fetch failed|terminated|network|ECONN|ETIMEDOUT|连不上/i.test(msg);
      if (network) {
        state.netFails = (state.netFails || 0) + 1;
        if (state.netFails >= 6 && state.running) {
          state.paused = true;
          q('#bStat').textContent = '上游连续失败，已自动暂停。确认网络/额度后点「继续」。';
        }
      } else if (!/空图|超时/.test(msg)) {
        throw err; // 明显的业务错误不必重试
      }
    }
  }
  throw lastError || new Error('重试 3 次仍失败');
}

async function worker() {
  while (state.running && !state.stop) {
    if (state.paused) {
      await sleep(300);
      continue;
    }
    const item = state.queue.shift();
    if (!item) break;
    state.workers += 1;
    updateProgress();
    try {
      await processItemWithRetry(item);
    } catch (err) {
      const prev = state.results.get(item.name) || {};
      state.results.set(item.name, {
        ...prev,
        status: '失败',
        step: '失败',
        error: err?.message || '未知错误',
      });
      paintRow(item.name);
      updateProgress();
      persist();
    } finally {
      state.workers -= 1;
    }
  }
}

async function startRun(onlyFailed = false) {
  if (state.running) return;
  state.model = q('#bModel').value;
  const refCm = Number(q('#bRef').value) || 5.5;
  state.pxPerCm = (Number(state.scene?.calibration?.pixels) || 123) / refCm;
  q('#bPx').textContent = `1 cm ≈ ${state.pxPerCm.toFixed(1)} px`;

  const limit = Number(q('#bLimit').value) || 0;
  let pool;
  if (onlyFailed) {
    pool = state.items.filter((it) => state.results.get(it.name)?.status === '失败');
  } else {
    pool = state.items.filter((it) => {
      const res = state.results.get(it.name);
      return !res || (res.status !== '完成' && res.status !== '运行中');
    });
    if (limit > 0) pool = pool.slice(0, limit);
  }
  if (!pool.length) {
    q('#bStat').textContent = onlyFailed ? '没有失败的任务' : '都完成了，点「清空记录」可以重跑';
    return;
  }

  state.queue = pool.slice();
  state.running = true;
  state.paused = false;
  state.stop = false;
  state.startedAt = Date.now();
  updateProgress();

  const n = Math.max(1, Number(q('#bConc').value) || 2);
  await Promise.all(Array.from({ length: n }, () => worker()));
  state.running = false;
  updateProgress();
  const failed = [...state.results.values()].filter((r) => r.status === '失败').length;
  q('#bStat').textContent = `这一轮结束：完成 ${pool.length - failed} 条，失败 ${failed} 条`;
}

/* ------------------------------------------------------------------ 装配 */

async function loadContext() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const modelSel = q('#bModel');
  modelSel.innerHTML = '';
  for (const m of cfg.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelSel.append(opt);
  }
  modelSel.value = cfg.models[0].id;
  state.model = cfg.models[0].id;

  const scene = await fetch('/api/scene?image=base').then((r) => r.json()).catch(() => null);
  state.scene = scene && Object.keys(scene).length ? scene : null;

  state.base = await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = cfg.defaultBaseImage || '/base.jpg';
  });
  state.surf = state.scene?.surface ? decodeSurface(state.scene.surface) : autoSurfaceMask(state.base);
  state.slots =
    Array.isArray(state.scene?.slots) && state.scene.slots.length
      ? state.scene.slots
      : [{ x: state.base.naturalWidth * 0.45, y: state.base.naturalHeight * 0.6, r: state.base.naturalWidth * 0.1, label: '桌面中间' }];
  state.occupied = Array.isArray(state.scene?.occupied) ? state.scene.occupied : [];
  if (state.scene?.refCm) q('#bRef').value = String(state.scene.refCm);
  state.pxPerCm = (Number(state.scene?.calibration?.pixels) || 123) / (Number(q('#bRef').value) || 5.5);
  q('#bPx').textContent = `1 cm ≈ ${state.pxPerCm.toFixed(1)} px`;

  const data = await fetch('/batch/items.json').then((r) => r.json());
  state.items = (data.items || []).filter((it) => it.name && it.name !== '合计');
  q('#bSrc').textContent = `${data.source || '物品名单'} · ${state.items.length} 项`;
  renderTable();
  updateProgress();

  loadStore();
  for (const it of state.items) paintRow(it.name);
  updateProgress();

  q('#bStart').addEventListener('click', () => startRun(false));
  q('#bRetry').addEventListener('click', () => startRun(true));
  q('#bPause').addEventListener('click', () => {
    state.paused = !state.paused;
    updateProgress();
  });
  q('#bStop').addEventListener('click', () => {
    state.stop = true;
    state.paused = false;
    state.queue = [];
    updateProgress();
  });
  q('#bClear').addEventListener('click', () => {
    if (state.running) return;
    state.results.clear();
    localStorage.removeItem(STORE_KEY);
    for (const it of state.items) paintRow(it.name);
    updateProgress();
  });
  q('#bRef').addEventListener('input', () => {
    state.pxPerCm = (Number(state.scene?.calibration?.pixels) || 123) / (Number(q('#bRef').value) || 5.5);
    q('#bPx').textContent = `1 cm ≈ ${state.pxPerCm.toFixed(1)} px`;
  });
  setInterval(() => {
    if (state.running) updateProgress();
  }, 1000);
}

let loading = null;

/** 打开批量面板（第一次点「批量」时才初始化） */
export async function openBatch(host) {
  state.host = host;
  if (!state.built) {
    host.innerHTML = TEMPLATE;
    state.built = true;
    loading = loadContext().catch((err) => {
      q('#bStat').textContent = `初始化失败：${err.message}`;
      console.error(err);
    });
  }
  if (loading) await loading;
  host.hidden = false;
}

export function closeBatch() {
  if (state.host) state.host.hidden = true;
}
