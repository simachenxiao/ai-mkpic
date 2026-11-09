/**
 * 场景几何核心：尺寸换算、桌面掩膜、落点搜索。
 *
 * 这里只放纯函数（不碰 DOM 全局、不碰 app 的 state），
 * 主页面 (app.js) 和批量页 (batch.js) 共用同一套规则，避免两边算法漂移。
 *
 * 约定：
 *   - 尺寸一律「长边对齐长边」，短边按切图自身比例还原，绝不拉伸；
 *   - 桌面掩膜是 cols × rows 的 0/1 网格，1 = 可以摆；
 *   - 所有坐标都是「底图像素」坐标系。
 */

/**
 * 切图 → 画布上的像素尺寸。
 * @param {number} cutW 切图宽（px）
 * @param {number} cutH 切图高（px）
 * @param {number} longCm 长边的真实厘米数
 * @param {number} pxPerCm 标定比例
 * @param {number} mul 微调系数
 */
export function sizeForCut(cutW, cutH, longCm, pxPerCm, mul = 1) {
  const longPx = Math.max(1, longCm * pxPerCm * mul);
  const aspect = (cutW || 1) / (cutH || 1);
  const w = aspect >= 1 ? longPx : longPx * aspect;
  const h = aspect >= 1 ? longPx / aspect : longPx;
  return { w, h, aspect };
}

/** 旋转 + 压扁之后的外接半宽/半高 */
export function halfExtents(w, h, rotDeg = 0, squash = 1) {
  const rad = (rotDeg * Math.PI) / 180;
  const hw = w / 2;
  const hh = (h / 2) * squash;
  return {
    rx: Math.abs(hw * Math.cos(rad)) + Math.abs(hh * Math.sin(rad)),
    ry: Math.abs(hw * Math.sin(rad)) + Math.abs(hh * Math.cos(rad)),
  };
}

/** 把中心点夹回画布内（物体整个留在画面里） */
export function clampIntoCanvas(canvasW, canvasH, x, y, geo, rotDeg = 0, squash = 1) {
  const { rx, ry } = halfExtents(geo.w, geo.h, rotDeg, squash);
  const cx = Math.min(Math.max(x, rx), Math.max(rx, canvasW - rx));
  const cy = Math.min(Math.max(y, ry), Math.max(ry, canvasH - ry));
  return { x: cx, y: cy };
}

/* --------------------------------------------------------- 桌面掩膜 */

/** scenes/*.json 里的 surface（base64 位图）→ { cols, rows, grid } */
export function decodeSurface(surface) {
  if (!surface || !surface.mask || !surface.cols || !surface.rows) return null;
  const bin = atob(surface.mask);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const grid = new Uint8Array(surface.cols * surface.rows);
  for (let i = 0; i < grid.length; i += 1) grid[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return { cols: surface.cols, rows: surface.rows, grid };
}

const autoCache = new Map();

/**
 * 没有场景档案时，从底图现场估一张「可落区」：
 * 缩到 192×108 → 亮度直方图众数 ±14 的亮度带（桌面通常就是画面里面积最大的同一个亮度）
 * → 最大 4 连通块 → 补内部小洞 → 降采样到 96×54 → 腐蚀一圈。
 * 只有这块面积占画面 12%~80% 才采信，否则返回 null（不做限制）。
 */
export function autoSurfaceMask(img, cols = 96, rows = 54) {
  if (!img) return null;
  const key = `${img.src}|${cols}x${rows}`;
  if (autoCache.has(key)) return autoCache.get(key);

  const W = 192;
  const H = 108;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const n = W * H;
  const lum = new Float32Array(n);
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i += 1) {
    const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    lum[i] = v;
    hist[Math.min(255, Math.max(0, Math.round(v)))] += 1;
  }
  let mode = 128;
  let modeScore = -1;
  for (let t = 2; t < 254; t += 1) {
    const score = hist[t - 2] + hist[t - 1] + hist[t] + hist[t + 1] + hist[t + 2];
    if (score > modeScore) {
      modeScore = score;
      mode = t;
    }
  }
  const band = 14;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mask[i] = Math.abs(lum[i] - mode) <= band ? 1 : 0;

  const seen = new Uint8Array(n);
  const stack = [];
  let bestPixels = null;
  let bestCount = 0;
  for (let start = 0; start < n; start += 1) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const cells = [];
    while (stack.length) {
      const p = stack.pop();
      cells.push(p);
      const x = p % W;
      const y = (p - x) / W;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) {
        if (q >= 0 && mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (cells.length > bestCount) {
      bestCount = cells.length;
      bestPixels = cells;
    }
  }
  if (!bestPixels) {
    autoCache.set(key, null);
    return null;
  }
  const share = bestCount / n;
  if (share < 0.12 || share > 0.8) {
    autoCache.set(key, null);
    return null;
  }

  const gridLen = cols * rows;
  const grid = new Uint8Array(gridLen);
  const cw = W / cols;
  const ch = H / rows;
  const counts = new Uint32Array(gridLen);
  for (const p of bestPixels) {
    const x = p % W;
    const y = (p - x) / W;
    counts[Math.min(rows - 1, Math.floor(y / ch)) * cols + Math.min(cols - 1, Math.floor(x / cw))] += 1;
  }
  const cellArea = cw * ch;
  for (let i = 0; i < gridLen; i += 1) grid[i] = counts[i] > cellArea * 0.6 ? 1 : 0;

  // 补洞：一行/一列里被桌面夹住的短空档（纸巾包、阴影留下的洞）
  for (let r = 0; r < rows; r += 1) {
    for (let c2 = 1; c2 < cols - 1; c2 += 1) {
      if (grid[r * cols + c2]) continue;
      let right = c2;
      while (right < cols && !grid[r * cols + right]) right += 1;
      if (right < cols && right - c2 <= 8) {
        for (let k = c2; k < right; k += 1) grid[r * cols + k] = 1;
        c2 = right;
      }
    }
  }
  for (let c2 = 0; c2 < cols; c2 += 1) {
    for (let r = 1; r < rows - 1; r += 1) {
      if (grid[r * cols + c2]) continue;
      let down = r;
      while (down < rows && !grid[down * cols + c2]) down += 1;
      if (down < rows && down - r <= 8) {
        for (let k = r; k < down; k += 1) grid[k * cols + c2] = 1;
        r = down;
      }
    }
  }

  // 腐蚀一圈：别把东西摆到桌沿上
  const eroded = new Uint8Array(gridLen);
  for (let r = 1; r < rows - 1; r += 1) {
    for (let c2 = 1; c2 < cols - 1; c2 += 1) {
      const i = r * cols + c2;
      if (!grid[i]) continue;
      let ok = true;
      for (let dr = -1; dr <= 1 && ok; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (!grid[(r + dr) * cols + c2 + dc]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) eroded[i] = 1;
    }
  }

  const result = { cols, rows, grid: eroded };
  autoCache.set(key, result);
  return result;
}

/** 这个尺寸摆在这个位置上，九个采样点是不是都在桌面里 */
export function surfaceOk(surf, canvasW, canvasH, cx, cy, geo, rotDeg = 0, squash = 1) {
  if (!surf) return true;
  const rad = (rotDeg * Math.PI) / 180;
  const hw = geo.w / 2;
  const hh = (geo.h / 2) * squash;
  for (let sx = -1; sx <= 1; sx += 1) {
    for (let sy = -1; sy <= 1; sy += 1) {
      const x = sx * hw;
      const y = sy * hh;
      const px = cx + x * Math.cos(rad) - y * Math.sin(rad);
      const py = cy + x * Math.sin(rad) + y * Math.cos(rad);
      if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return false;
      const c = Math.min(surf.cols - 1, Math.floor((px / canvasW) * surf.cols));
      const r = Math.min(surf.rows - 1, Math.floor((py / canvasH) * surf.rows));
      if (!surf.grid[r * surf.cols + c]) return false;
    }
  }
  return true;
}

/** 摆不下就朝外找最近一个能整个落在桌面上的位置 */
export function findFittingCenter(surf, canvasW, canvasH, cx, cy, geo, rotDeg = 0, squash = 1, step, limit) {
  if (surfaceOk(surf, canvasW, canvasH, cx, cy, geo, rotDeg, squash)) return { x: cx, y: cy };
  const stride = step || Math.max(18, Math.round(geo.w * 0.1));
  const maxR = limit || Math.max(canvasW, canvasH) * 0.7;
  for (let r = stride; r <= maxR; r += stride) {
    for (let a = 0; a < 16; a += 1) {
      const ang = (a / 16) * Math.PI * 2;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (surfaceOk(surf, canvasW, canvasH, x, y, geo, rotDeg, squash)) return { x, y };
    }
  }
  return { x: cx, y: cy };
}

/**
 * 自动摆位：优先挑场景里的空位，落到桌面上；实在放不下就等比缩小（最低 55%）。
 * @returns {{ x:number, y:number, mul:number, shrank:boolean, nudged:number }}
 */
export function placeOnSurface(opts) {
  const { surf, canvasW, canvasH, slots, occupied, geo, rotDeg, squash, avoidRadius } = opts;
  const slot = pickSlot(slots, occupied, geo, canvasW, canvasH, avoidRadius) || slots[0];
  let scale = 1;
  let fit = findFittingCenter(surf, canvasW, canvasH, slot.x, slot.y, geo, rotDeg, squash);
  let ok = surfaceOk(surf, canvasW, canvasH, fit.x, fit.y, geo, rotDeg, squash);
  if (!ok) {
    for (let k = 0.95; k >= 0.55; k -= 0.05) {
      const g2 = { w: geo.w * k, h: geo.h * k };
      const alt = findFittingCenter(surf, canvasW, canvasH, slot.x, slot.y, g2, rotDeg, squash);
      if (surfaceOk(surf, canvasW, canvasH, alt.x, alt.y, g2, rotDeg, squash)) {
        scale = k;
        fit = alt;
        ok = true;
        break;
      }
    }
  }
  return {
    x: fit.x,
    y: fit.y,
    mul: scale,
    shrank: scale < 1,
    nudged: Math.round(Math.hypot(fit.x - slot.x, fit.y - slot.y)),
    slotLabel: slot.label || '空位',
  };
}

/** 按顺序挑第一个不压到 occupied 的空位 */
export function pickSlot(slots, occupied = [], geo, canvasW, canvasH, avoidRadius) {
  if (!Array.isArray(slots) || !slots.length) return null;
  const list = occupied && occupied.length ? occupied : [];
  for (const slot of slots) {
    const r = Math.min(avoidRadius || slot.r || 150, slot.r || avoidRadius || 150);
    const clear = list.every(
      (o) => Math.hypot((o.x + (o.w || 0) / 2) - slot.x, (o.y + (o.h || 0) / 2) - slot.y) > r,
    );
    if (clear) return slot;
  }
  return slots[0];
}

/* --------------------------------------------------------- 主体提示词 */

/**
 * 拼主体提示词：模型只画「正俯视 + 幕布 + 单物体」，位置尺寸由合成端决定。
 * backdrop：green = 纯绿幕（默认）；gray = 浅灰幕布（主体本身偏绿时用）
 */
export function buildSubjectPrompt(desc, backdrop = 'green') {
  const view =
    '正俯视图：镜头垂直向下 90°，正交投影，物体平放在桌面、从上往下看，没有透视、没有斜角、没有侧立面；画面里只有这一个物体，没有别的物品、没有文字、没有水印。';
  const frame =
    '背景是一整块铺满整张画面的幕布，四边都是它，不要画成一张卡片、不要给画面留白边、幕布里不要有任何文字、水印、图案或渐变；物体必须完整地落在画面里面，四周留出一圈空白，不要被画框裁切、不要贴边。';
  const bg =
    backdrop === 'gray'
      ? '背景必须是一整块均匀的浅灰色幕布（约 #E8E8E8），不是白、不是渐变、没有纹理、没有任何杂物；物体和背景对比清晰，物体边缘不要有灰色描边，四周不要有投影、不要有阴影、不要有光晕。'
      : '背景必须是一整块均匀的纯绿色色键幕布（chroma key green，约 #00C853），不是白、不是灰、不是渐变；物体四周不要有投影、不要有阴影、不要有光晕；物体表面不要被绿光染到，物体和幕布之间边缘清晰。物体本身的颜色必须和幕布明显不同：黑色、银色、金色、蓝色、红色、粉色、棕色都可以，不要用绿色、墨绿、橄榄绿、荧光绿。';
  return `${desc}。${view}${frame}${bg}`;
}
