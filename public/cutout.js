/**
 * 主体抠图：按「底图采样到的背景色」做色度键（chroma key）+ flood fill。
 *
 * 为什么不能只按亮度切白底：
 *   ① 模型会在主体四周画一圈软阴影/光晕 —— 亮度刚好卡在阈值中间，
 *      变成半透明白灰像素，贴到深色桌面上就是一圈白边（最常见的「格格不入」）；
 *   ② 抗锯齿有 1~2 px 过渡边；
 *   ③ 被主体包住的内孔（戒指中间、耳环中间、杯口）flood fill 从四边进不去，
 *      直接留成一块死白；
 *   ④ 最要命的是「白底 + 白色主体」（白马克杯、AirPods 盒）：两者颜色一模一样，
 *      任何基于颜色的阈值都必然二选一地切错。
 *
 * 所以现在的做法：
 *   1. 采样图片四边，取中位色当「背景色」（key）——白底、灰底、绿幕都是同一套逻辑；
 *   2. 从四边 flood fill，只在「颜色接近 key、且无明显边缘」的地方扩散：
 *      软阴影/渐变底的梯度极小，物体轮廓一定有梯度，扩散到轮廓就停；
 *   3. 算「非背景」到背景的距离，紧贴背景的近似底色残余按距离衰减（去 1~3 px 描边）；
 *   4. 反过来找「被包住的大片近底色」= 内孔 → 判背景（小的白 logo/条码留着）；
 *   5. 边缘像素按背景色反预乘（去底色污染），贴到深色背景上不带边；
 *   6. 只留最大连通块（水印、角落里的小碎块会被丢掉），再裁到主体外框。
 */

/** 一处像素到背景色的最大通道差（0~255） */
function keyDistance(px, i, key) {
  const dr = Math.abs(px[i] - key[0]);
  const dg = Math.abs(px[i + 1] - key[1]);
  const db = Math.abs(px[i + 2] - key[2]);
  return dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
}

/**
 * 「离背景色多远才算主体」不能写死：灰底上的白杯子只差 50 级，
 * 白底上的金戒指差 120 级。用 Otsu 按这张图自己的距离直方图找分界。
 */
function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** 背景色是哪种幕布：绿幕/蓝幕要额外做溢色抑制 */
function classifyKey(key) {
  const [r, g, b] = key;
  if (g - Math.max(r, b) >= 36) return 'green';
  if (b - Math.max(r, g) >= 36) return 'blue';
  if (r - Math.max(g, b) >= 36) return 'red';
  return 'neutral';
}

/** 这个像素处有没有「边缘」（软阴影没有，物体轮廓有） */
const EDGE_GRAD = 7;

/** 采样四边一圈，取中位色当背景色 */
function sampleKey(px, w, h) {
  const rs = [];
  const gs = [];
  const bs = [];
  const push = (p) => {
    rs.push(px[p * 4]);
    gs.push(px[p * 4 + 1]);
    bs.push(px[p * 4 + 2]);
  };
  for (let x = 0; x < w; x += 1) {
    push(x);
    push((h - 1) * w + x);
    if (h > 3) {
      push(w + x);
      push((h - 2) * w + x);
    }
  }
  for (let y = 0; y < h; y += 1) {
    push(y * w);
    push(y * w + w - 1);
    if (w > 3) {
      push(y * w + 1);
      push(y * w + w - 2);
    }
  }
  const med = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return [med(rs), med(gs), med(bs)];
}

/**
 * 画面里有没有一大块「绿幕」：有就返回它的中位色（模型偶尔会把绿幕画成卡片）
 * 每 4 个像素跳一个采样，几百万像素也只要几毫秒。
 */
function medianGreenPlate(px, N) {
  const step = Math.max(1, Math.floor(N / 80000));
  const rs = [];
  const gs = [];
  const bs = [];
  let total = 0;
  for (let p = 0; p < N; p += step) {
    const i = p * 4;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    total += 1;
    if (g - Math.max(r, b) >= 30) {
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }
  if (rs.length < total * 0.2) return null; // 面积不够大就别当幕布，免得把绿色物品吃掉
  const med = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  const out = [med(rs), med(gs), med(bs)];
  if (out[1] < 110) return null; // 幕布是亮的，暗绿的布料不算
  return out;
}

export function cutout(img) {
  const work = document.createElement('canvas');
  work.width = img.naturalWidth || img.width;
  work.height = img.naturalHeight || img.height;
  const g = work.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);

  const image = g.getImageData(0, 0, work.width, work.height);
  const px = image.data;
  const w = work.width;
  const h = work.height;
  const N = w * h;

  let key = sampleKey(px, w, h);
  let keyKind = classifyKey(key);

  // 有的模型会把绿幕画成一张「绿卡片」贴在浅色台面上：四边采样到的是白/灰，
  // 真正的幕布是中间那块绿。四边采样判成中性、但画面里绿得够多时，改用那块绿当幕布。
  if (keyKind === 'neutral') {
    const plate = medianGreenPlate(px, N);
    if (plate) {
      key = plate;
      keyKind = 'green';
    }
  }
  const chromatic = keyKind !== 'neutral';
  const keyLum = 0.299 * key[0] + 0.587 * key[1] + 0.114 * key[2];

  /**
   * 「这个像素是不是幕布」——有色幕布按色相判，比按色差更宽：
   * 洞里的绿、幕布上偏暗的投影，色差能拉开 60~100 级，但「绿明显压过红蓝」这条不变。
   */
  const spillOf = (p) => {
    const i = p * 4;
    const r = px[i];
    const g2 = px[i + 1];
    const b = px[i + 2];
    if (keyKind === 'green') return g2 - Math.max(r, b);
    if (keyKind === 'blue') return b - Math.max(r, g2);
    if (keyKind === 'red') return r - Math.max(g2, b);
    return 0;
  };
  const keyLike = (p) => spillOf(p) >= 26;

  /* --------------------------- 幕布有没有铺满画面（模型有时会画成一张「卡片」） */
  const inset = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const edgeStats = (pick) => {
    let hit = 0;
    let total = 0;
    for (let i = 0; i < 240; i += 1) {
      const [x, y] = pick(i);
      const p = y * w + x;
      total += 1;
      if (chromatic ? spillOf(p) >= 26 : keyDistance(px, p * 4, key) < 55) hit += 1;
    }
    return total ? hit / total : 0;
  };
  // 四条边分别算，取中位数：模型的角标/水印只污染一条边，不该整张判成「幕布没铺满」
  const edges = [
    edgeStats((i) => [Math.round((i / 239) * (w - 1)), inset]),
    edgeStats((i) => [Math.round((i / 239) * (w - 1)), h - 1 - inset]),
    edgeStats((i) => [inset, Math.round((i / 239) * (h - 1))]),
    edgeStats((i) => [w - 1 - inset, Math.round((i / 239) * (h - 1))]),
  ].sort((a, b) => a - b);
  const backdropOk = (edges[1] + edges[2]) / 2 > 0.7;

  /* ------------------------------------------- 亮度图 / 梯度图 / 底色距离 */
  const lumMap = new Float32Array(N);
  const distMap = new Uint8Array(N);
  for (let p = 0; p < N; p += 1) {
    const i = p * 4;
    lumMap[p] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    distMap[p] = keyDistance(px, i, key);
  }
  const grad = new Uint8Array(N);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      const l = x > 0 ? lumMap[p - 1] : lumMap[p];
      const r2 = x < w - 1 ? lumMap[p + 1] : lumMap[p];
      const t = y > 0 ? lumMap[p - w] : lumMap[p];
      const b2 = y < h - 1 ? lumMap[p + w] : lumMap[p];
      grad[p] = Math.round(Math.max(Math.abs(r2 - l), Math.abs(b2 - t)));
    }
  }

  /* --------------------------------------- 自适应阈值（Otsu → 软边带宽） */
  const hist = new Float64Array(256);
  for (let p = 0; p < N; p += 1) hist[distMap[p]] += 1;
  const otsu = otsuThreshold(hist, N);
  // 软边带宽：用 Otsu 的分界
  const KEY_T1 = Math.min(96, Math.max(16, otsu));
  const KEY_T0 = Math.max(4, KEY_T1 * 0.42);
  // flood 要宽一点：底幕有渐变、绿幕上还有偏暗的投影，都还是「同一族颜色」
  const FLOOD_T = Math.min(chromatic ? 150 : 110, Math.max(38, KEY_T1 * (chromatic ? 2.2 : 1.9)));
  // 内孔要严一点：孔里看到的就是同一块底色，只会差几级
  const HOLE_T = Math.max(10, Math.min(26, KEY_T1 * 0.5));
  // 有色幕布的软遮罩带：溢色量 <= LO 算主体，>= HI 算幕布
  // 幕布自己的「绿度」：亮处 ~117，暗角降到 ~30；阈值必须跟着它走，
  // 否则暗角（绿度 30 左右）会被当成不透明，留下一整块绿色鬼影
  const keySpill = chromatic
    ? Math.max(
        0,
        keyKind === 'green'
          ? key[1] - Math.max(key[0], key[2])
          : keyKind === 'blue'
            ? key[2] - Math.max(key[0], key[1])
            : key[0] - Math.max(key[1], key[2]),
      )
    : 0;
  const SPILL_LO = chromatic ? Math.max(8, Math.round(keySpill * 0.12)) : 44;
  const SPILL_HI = chromatic ? Math.max(20, Math.round(keySpill * 0.26)) : 64;

  /* ---------------------------------------- 1) 从四边 flood（梯度门控） */
  const bg = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const seed = (p) => {
    if (bg[p]) return;
    if (chromatic) {
      // 有色幕布：纯色键，只按色相判，不看梯度。
      // 幕布上的投影是「暗一点的同色」→ 色相还在，照样扩散干净；
      // 主体哪怕被染了点绿，色相也不够 → 一律不进，边界干净利落。
      if (!keyLike(p)) return;
    } else {
      if (grad[p] > EDGE_GRAD) return; // 碰到物体轮廓就停
      if (distMap[p] > FLOOD_T) return;
    }
    bg[p] = 1;
    stack[sp++] = p;
  };
  for (let x = 0; x < w; x += 1) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y += 1) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }

  let bgCount = 0;
  let objectPixels = 0;
  for (let p = 0; p < N; p += 1) {
    if (bg[p]) bgCount += 1;
    else objectPixels += 1;
  }

  // 背景没占住大片面积（满幅物体 / 彩色复杂背景）→ 不做 flood，退回纯色度曲线
  const floodOk = bgCount >= N * 0.06 && bgCount <= N * 0.985 && objectPixels > 0;
  if (!floodOk) bg.fill(0);

  /* ------------------------- 2) 物体到背景的距离（去掉 1~3 px 描边用） */
  const ring = new Uint8Array(N);
  if (floodOk) {
    ring.fill(255);
    const queue = new Int32Array(N);
    let head = 0;
    let tail = 0;
    for (let p = 0; p < N; p += 1) {
      if (bg[p]) continue;
      const x = p % w;
      const y = (p - x) / w;
      const touches =
        (x > 0 && bg[p - 1]) ||
        (x < w - 1 && bg[p + 1]) ||
        (y > 0 && bg[p - w]) ||
        (y < h - 1 && bg[p + w]);
      if (touches) {
        ring[p] = 1;
        queue[tail++] = p;
      }
    }
    while (head < tail) {
      const p = queue[head++];
      const d = ring[p];
      if (d >= 3) continue;
      const x = p % w;
      const y = (p - x) / w;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (bg[q] || ring[q] !== 255) continue;
        ring[q] = d + 1;
        queue[tail++] = q;
      }
    }
  }

  /* ------------------ 3) 内孔：被主体包住的「大片近底色」→ 也算背景 */
  const hole = new Uint8Array(N);
  if (floodOk) {
    const cand = new Uint8Array(N);
    for (let p = 0; p < N; p += 1) {
      if (bg[p] || ring[p] !== 255) continue;
      if (distMap[p] <= HOLE_T || keyLike(p)) cand[p] = 1;
    }
    const minHole = Math.max(64, objectPixels * 0.02);
    const seenHole = new Uint8Array(N);
    const queue = new Int32Array(N);
    let holePixels = 0;
    for (let p0 = 0; p0 < N; p0 += 1) {
      if (!cand[p0] || seenHole[p0]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = p0;
      seenHole[p0] = 1;
      const members = [p0];
      // 围墙：这个浅色块的外面是不是背景？孔是被主体围住的，不该大面积碰背景
      let wallBg = 0;
      let wallTotal = 0;
      const judge = (q) => {
        if (cand[q]) return;
        wallTotal += 1;
        if (bg[q]) wallBg += 1;
      };
      while (head < tail) {
        const p = queue[head++];
        const x = p % w;
        const y = (p - x) / w;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (cand[q]) {
            if (!seenHole[q]) {
              seenHole[q] = 1;
              queue[tail++] = q;
              members.push(q);
            }
          } else {
            judge(q);
          }
        }
      }
      // 挖孔条件：够大 + 几乎不碰背景（<=5%）
      const sealed = wallTotal > 0 && wallBg / wallTotal <= 0.05;
      if (sealed && members.length >= minHole) {
        for (const m of members) hole[m] = 1;
        holePixels += members.length;
      }
    }
    // 主体本身就是浅色 且 孔比主体还大 → 说明切反了，取消挖孔
    if (objectPixels && holePixels > objectPixels * 0.9) hole.fill(0);
  }

  /* ----------------------------------------------- 4) 逐像素定 alpha */
  const keySat = Math.max(key[0], key[1], key[2]) - Math.min(key[0], key[1], key[2]);
  for (let p = 0; p < N; p += 1) {
    const i = p * 4;
    // 有色幕布不走「flood 判背景」那条路：主体被染绿的侧光面 spill 也在 25~35，
    // 用 flood 的硬边界会把它啃成锯齿。这里只认「里面的孔」，边界交给下面的软遮罩。
    if ((chromatic ? hole[p] : bg[p] || hole[p])) {
      px[i + 3] = 0;
      continue;
    }

    const d = distMap[p];
    const spill = chromatic ? spillOf(p) : 0;
    // 有色幕布：按「绿得有多明显」给软遮罩 —— 硬阈值会在 JPEG 噪声上抖成锯齿
    // 其他底（白/灰）：离底色越远越不透明
    let alpha = chromatic
      ? Math.min(1, Math.max(0, (SPILL_HI - spill) / (SPILL_HI - SPILL_LO)))
      : Math.min(1, Math.max(0, (KEY_T1 - d) / (KEY_T1 - KEY_T0)));
    // 有色差的物体（金、蓝、红）哪怕很亮也要留住，别被当成浅底
    const sat = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
    if (!chromatic && sat > keySat + 18) alpha = Math.max(alpha, 0.92);

    if (floodOk && !chromatic) {
      const rd = ring[p];
      if (rd === 255) {
        alpha = Math.max(alpha, 0.98); // 物体内部：实心
      } else if (d <= FLOOD_T + 12) {
        // 紧贴背景的「接近底色」残余 = 模型留的描边/光晕，按距离衰减
        if (rd === 1) alpha *= 0.15;
        else if (rd === 2) alpha *= 0.5;
        else alpha *= 0.85;
      }
    }

    alpha *= px[i + 3] / 255;
    if (alpha < 0.04) {
      px[i + 3] = 0;
      continue;
    }
    if (alpha < 0.995 && !chromatic) {
      // 中性底：边缘是底色混过的像素，按底色反预乘，贴到别处才不留底边。
      // 绿幕不做这步 —— 被染绿的白像素减掉绿只会剩红蓝，一圈紫边；那交给下面的消色。
      const inv = 1 / alpha;
      const outA = 1 - alpha;
      px[i] = clamp8((px[i] - key[0] * outA) * inv);
      px[i + 1] = clamp8((px[i + 1] - key[1] * outA) * inv);
      px[i + 2] = clamp8((px[i + 2] - key[2] * outA) * inv);
    }

    // 溢色抑制：幕布的光会反到主体上，不处理就是一圈绿边。
    // 判据不看 alpha（不透明的地方也会被染），看「这个像素本身有多绿」——
    // 绿得可疑就按嫌疑度削回去，正常颜色（红蓝占优、或中性白）完全不动。
    if (chromatic) {
      const c0 = px[i];
      const c1 = px[i + 1];
      const c2 = px[i + 2];
      const edgeW = alpha < 0.95 ? 1 : 0.55; // 边缘本来就该削干净；实心面也要削掉反光
      let spill = Math.max(0, Math.min(255, c1 - Math.max(c0, c2)));
      if (keyKind === 'green' && spill > 5) {
        const wSpill = Math.max(edgeW, Math.min(0.92, (spill - 5) / 24));
        px[i + 1] = clamp8(c1 - spill * wSpill);
      } else if (keyKind === 'blue') {
        spill = Math.max(0, Math.min(255, c2 - Math.max(c0, c1)));
        if (spill > 8) {
          const wSpill = Math.max(edgeW, Math.min(0.88, (spill - 8) / 30));
          px[i + 2] = clamp8(c2 - spill * wSpill);
        }
      } else if (keyKind === 'red') {
        spill = Math.max(0, Math.min(255, c0 - Math.max(c1, c2)));
        if (spill > 8) {
          const wSpill = Math.max(edgeW, Math.min(0.88, (spill - 8) / 30));
          px[i] = clamp8(c0 - spill * wSpill);
        }
      }
    }

    px[i + 3] = Math.round(alpha * 255);
  }

  /* --------- 4.5) 整体绿偏置校正：消了溢色之后还剩的那层「绿味」一刀削掉 ---------
     * 幕布的光会均匀地反到整块主体上，尤其是深色布料，逐像素消色只能削到阈值附近，
     剩下的一层绿会让深灰变墨绿。这里量一下中位数残差，整体削回去。 */
  if (chromatic) {
    const res = [];
    const step4 = Math.max(1, Math.floor(N / 40000));
    for (let p = 0; p < N; p += step4) {
      const i = p * 4;
      if (px[i + 3] < 220) continue;
      const sp2 = spillOf(p);
      if (sp2 > -24) res.push(sp2);
    }
    if (res.length > 200) {
      res.sort((a, b) => a - b);
      const cast = res[Math.floor(res.length * 0.5)];
      if (cast > 2) {
        const drop = Math.min(cast, 30);
        for (let p = 0; p < N; p += 1) {
          const i = p * 4;
          if (px[i + 3] === 0) continue;
          const sp3 = spillOf(p);
          if (sp3 > 0) px[i + 1] = clamp8(px[i + 1] - Math.min(sp3, drop));
        }
      }
    }
  }

  /* ----------------------------- 5) 只在最大连通块里取外框（丢弃水印碎块） */
  const G = 64;
  const cw0 = w / G;
  const ch0 = h / G;
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
    const stack2 = [i];
    seen[i] = 1;
    const comp = new Uint8Array(G * G);
    comp[i] = 1;
    let count = 0;
    let gx0 = G;
    let gx1 = -1;
    let gy0 = G;
    let gy1 = -1;
    while (stack2.length) {
      const idx = stack2.pop();
      const gx = idx % G;
      const gy = (idx - gx) / G;
      count += 1;
      if (gx < gx0) gx0 = gx;
      if (gx > gx1) gx1 = gx;
      if (gy < gy0) gy0 = gy;
      if (gy > gy1) gy1 = gy;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const nidx = ny * G + nx;
        if (solid[nidx] && !seen[nidx]) {
          seen[nidx] = 1;
          comp[nidx] = 1;
          stack2.push(nidx);
        }
      }
    }
    if (!best || count > best.count) best = { count, gx0, gx1, gy0, gy1, cells: comp };
  }

  if (!best || best.count < 4) return null;

  /* ---- 只留最大连通块：角落的水印、文字、badge 都清成透明（外扩一格防切边） ---- */
  const keep = new Uint8Array(G * G);
  for (let gy2 = 0; gy2 < G; gy2 += 1) {
    for (let gx2 = 0; gx2 < G; gx2 += 1) {
      if (!best.cells[gy2 * G + gx2]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = gx2 + dx;
          const ny = gy2 + dy;
          if (nx >= 0 && ny >= 0 && nx < G && ny < G) keep[ny * G + nx] = 1;
        }
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    const gy3 = Math.min(G - 1, Math.floor(y / ch0));
    for (let x = 0; x < w; x += 1) {
      if (keep[gy3 * G + Math.min(G - 1, Math.floor(x / cw0))]) continue;
      px[(y * w + x) * 4 + 3] = 0;
    }
  }

  // 在选中的块里按像素收紧边框
  const x0 = Math.floor(best.gx0 * cw0);
  const x1 = Math.min(w - 1, Math.ceil((best.gx1 + 1) * cw0));
  const y0 = Math.floor(best.gy0 * ch0);
  const y1 = Math.min(h - 1, Math.ceil((best.gy1 + 1) * ch0));
  let ix0 = x1;
  let iy0 = y1;
  let ix1 = x0;
  let iy1 = y0;
  let solidCount = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 150) {
        solidCount += 1;
        if (x < ix0) ix0 = x;
        if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y;
        if (y > iy1) iy1 = y;
      }
    }
  }
  if (ix1 < ix0 || iy1 < iy0) return null;

  const pad = 3;
  const bx0 = Math.max(0, ix0 - pad);
  const by0 = Math.max(0, iy0 - pad);
  const bx1 = Math.min(w - 1, ix1 + pad);
  const by1 = Math.min(h - 1, iy1 + pad);

  const outW = bx1 - bx0 + 1;
  const outH = by1 - by0 + 1;
  if (outW < 60 || outH < 60) return null;

  g.putImageData(image, 0, 0);
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  out.getContext('2d').drawImage(work, bx0, by0, outW, outH, 0, 0, outW, outH);
  // 给调用方一点诊断信息：主体是不是被画框切了、幕布是什么色
  out.__keyKind = keyKind;
  out.__touchesEdge = ix0 <= 1 || iy0 <= 1 || ix1 >= w - 2 || iy1 >= h - 2;
  out.__backdropOk = backdropOk;
  // 不透明像素占外框面积的比例：正常物体 0.3~0.8；接近 1 说明留住了整块矩形（卡片/水印）
  out.__fill = solidCount / Math.max(1, (ix1 - ix0 + 1) * (iy1 - iy0 + 1));
  // 卡片/水印残留：会留下一条又长又直的边。真物体的轮廓是波浪的。
  const edgeVotes = new Map();
  let rowsChecked = 0;
  for (let y = 0; y < h; y += 2) {
    rowsChecked += 1;
    let first = -1;
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 70) {
        first = x;
        break;
      }
    }
    if (first >= 0) edgeVotes.set(first, (edgeVotes.get(first) || 0) + 1);
  }
  let edgePeak = 0;
  for (const v of edgeVotes.values()) if (v > edgePeak) edgePeak = v;
  out.__straight = rowsChecked > 0 && edgePeak / rowsChecked > 0.22;
  return out;
}

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
