/**
 * 物品舱 · 布景 —— 本地小服务
 * 零依赖：只用 Node 自带模块（Node 20+，需要全局 fetch）。
 * 作用：托管静态页面 + 代理上游 OpenAI Images API（含参考图）。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SCENES_DIR = path.join(ROOT, 'scenes');

loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.IMAGE_BASE_URL || 'https://www.ccsub.net/api/v1').replace(/\/+$/, '');
const API_KEY = (process.env.IMAGE_API_KEY || '').trim();
const UPSTREAM_TIMEOUT = Number(process.env.IMAGE_TIMEOUT_MS || 300000);
const AUTO_OPEN = process.argv.includes('--open');

/* 对话模型：只用来「输入物品名称 → 描述 + 尺寸」 */
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim();
const LLM_MODEL = (process.env.LLM_MODEL || 'deepseek-flash').trim();
const LLM_TIMEOUT = Number(process.env.LLM_TIMEOUT_MS || 90000);

const CACHE_DIR = path.join(ROOT, 'cache');
const ITEM_CACHE_FILE = path.join(CACHE_DIR, 'items.json');

/** 上游实测支持的模型；reference 表示是否真的吃得下参考图 */
const MODELS = [
  {
    id: 'gpt-image-2',
    label: 'gpt-image-2',
    note: '当前默认：细节和材质最稳，绿幕抠图干净',
    reference: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
  },
  {
    id: 'gpt-image-1.5',
    label: 'gpt-image-1.5',
    note: '同代旧版，出图更快一点，细节略少',
    reference: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
  },
  {
    id: 'gpt-image-1',
    label: 'gpt-image-1',
    note: '老版本，风格更平，偶尔糊',
    reference: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
  },
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'gpt-image-2.5-sunburst',
    note: '新一代变体，画面更亮、光比更大（未逐一验证）',
    reference: false,
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
  },
];

const DEFAULT_PROMPT =
  '在白色桌面上添加一部平放的黑色智能手机，屏幕朝上、息屏，大小要合理，参考边上的纸巾包和充电器的大小。';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ http */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/config') return await handleConfig(res);
    if (req.method === 'GET' && pathname === '/api/history') return await handleHistory(res);
    if (req.method === 'GET' && pathname === '/api/scene') return await handleScene(res, url);
    if (req.method === 'POST' && pathname === '/api/scene') return await handleSceneSave(req, res, url);
    if (req.method === 'POST' && pathname === '/api/describe') return await handleDescribe(req, res);
    if (req.method === 'POST' && pathname === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'POST' && pathname === '/api/save') return await handleSave(req, res);
    if (req.method === 'POST' && pathname === '/api/reveal') return await handleReveal(res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') return await serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req.method);
      if (pathname.startsWith('/output/')) {
        const name = path.basename(pathname);
        return await serveFile(res, path.join(OUTPUT_DIR, name), req.method, 'public, max-age=60');
      }
      const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
      for (const dir of [PUBLIC_DIR, ROOT]) {
        const target = path.join(dir, rel);
        if (!target.startsWith(dir) || target.includes(`${path.sep}output`)) continue;
        if (existsSync(target)) return await serveFile(res, target, req.method);
      }
    }

    return json(res, 404, { error: '没有这个地址' });
  } catch (err) {
    console.error('[error]', pathname, err?.message || err);
    if (!res.headersSent) json(res, 500, { error: err?.message || '服务器内部错误' });
    else res.end();
  } finally {
    if (process.env.DEBUG) console.log(`${req.method} ${pathname} → ${res.statusCode} ${Date.now() - started}ms`);
  }
});

server.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;
  console.log('');
  console.log('  物品舱 · 布景');
  console.log(`  ${local}`);
  console.log(`  上游：${BASE_URL}/images/generations`);
  console.log(`  API Key：${API_KEY ? `${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}` : '未配置（请在 .env 里填写）'}`);
  console.log(
    `  描述/尺寸：${LLM_API_KEY ? `${LLM_MODEL} @ ${hostOf(LLM_BASE_URL)}` : '未配置 LLM_API_KEY（退回本地粗估）'}`,
  );
  console.log('');
  if (AUTO_OPEN && process.platform === 'win32') {
    import('node:child_process').then(({ spawn }) =>
      spawn('cmd', ['/c', 'start', '', local], { detached: true, stdio: 'ignore' }).unref(),
    );
  }
});

/* --------------------------------------------------------------- handlers */

function handleConfig(res) {
  json(res, 200, {
    models: MODELS,
    defaultPrompt: DEFAULT_PROMPT,
    hasKey: Boolean(API_KEY),
    baseUrl: BASE_URL,
    defaultBaseImage: '/base.jpg',
    outputDir: path.relative(ROOT, OUTPUT_DIR) + path.sep,
    llm: { hasKey: Boolean(LLM_API_KEY), model: LLM_MODEL, host: hostOf(LLM_BASE_URL) },
  });
}

/* --------------------------------------------------- 名称 → 描述 + 尺寸 */

const DESCRIBE_SYSTEM = `你是产品布景师。用户给你一个物品名称，你返回它的「文生图描述」和「俯视轮廓尺寸」。

输出规则：
- 只输出一个 JSON 对象，不要解释，不要 markdown 代码块。
- 字段：{"desc": string, "w": number, "h": number}
- desc：中文，30~60 字，只描述物品外观本身——颜色、材质、光泽、形态、关键细节（按钮/接口/指示灯的位置）。
- desc 里严禁出现：俯视、俯拍、镜头、角度、背景、白色背景、构图、摆放、画布、光线、拍摄、尺寸、价格、品牌口号。

形态规则（重要）：
- 长条形、线性、软质的东西一律描述成**卷起来 / 盘起来 / 折叠起来**的形态，不要描述成摊平的长条：
  皮带、腰带、围巾、领带、丝巾、数据线、充电线、项链、绳子、跳绳、绳带、链条、发带、鞋带、毛巾、衣服（可叠）。
- 例：皮带 → 「一条深棕色皮质皮带，卷成一卷，金属扣头露在侧面」；围巾 → 「一条米色羊毛围巾，叠成方块」。
- 卷/叠之后的形态要能一眼看出是什么，扣头、吊坠、接口这些特征要露出来。
- **尺寸一律按卷好/叠好之后的俯视外接矩形给**，不是展开长度！

尺寸规则（重要）：
- w / h 是「物品平放在桌面上、从上往下看所占矩形」的短边与长边，单位厘米，保留一位小数；
- 不是高度，也不是厚度。杯子/圆柱取直径，不要取高；手机/充电盒取平放时的宽与长（厚度不算）；
- 必要时可互换：保证 w <= h。

示例：
- 「马克杯」→ {"desc":"一只白色亮面陶瓷马克杯，杯身圆柱形略微上宽下窄，杯口圆整，右侧一体式弧形手柄","w":8,"h":11}（11 是带手柄的总长）
- 「AirPods Pro 充电盒」→ {"desc":"白色亮面塑料充电盒，圆角矩形扁平机身，顶部翻盖接缝，正面小状态指示灯，底部充电口","w":4.5,"h":6.1}
- 「皮带」→ {"desc":"一条深棕色皮质皮带，卷成一卷平放着，侧面露出银色金属扣头","w":11,"h":11}（**不是 4×120**）
- 「围巾」→ {"desc":"一条米色羊毛围巾，叠成方块平放着，边缘有细流苏","w":22,"h":26}`;

/** 常见物品的兜底尺寸，LLM 不可用时也能给出可用值 */
const LOCAL_ITEMS = [
  { test: /手机|iphone|智能机|smartphone|pixel|小米|华为/i, w: 7.2, h: 15.2, desc: '一部平放的黑色智能手机，屏幕朝上、息屏，圆角机身边框，摄像头模组在背面' },
  { test: /平板|ipad|tablet/i, w: 17.5, h: 25, desc: '一台平放的深色平板电脑，屏幕朝上、息屏，金属直边框，四角圆润' },
  { test: /笔记本|macbook|laptop|电脑/i, w: 22, h: 32, desc: '一台合上的银色笔记本电脑，铝合金外壳，边缘圆角，顶盖中心有品牌标识' },
  { test: /充电盒|耳机盒|airpods|充电仓/i, w: 4.5, h: 6.1, desc: '一个白色亮面塑料耳机充电盒，圆角矩形扁平机身，正面小指示灯，底部充电口' },
  { test: /耳机|earphone|earbud/i, w: 2, h: 3.2, desc: '一副白色入耳式无线耳机，圆润光滑，带短柄' },
  { test: /马克杯|杯子|水杯|茶杯|咖啡杯/i, w: 8, h: 11, desc: '一只白色亮面陶瓷马克杯，圆柱形杯身略微上宽下窄，右侧一体式弧形手柄' },
  { test: /口红|唇膏/i, w: 2.1, h: 8.4, desc: '一支平放的口红，黑色金属外壳，细长圆柱形管身，管口露出一点正红色膏体，中段一圈金色饰环' },
  { test: /手表|手环|watch/i, w: 4, h: 4.6, desc: '一块深色方形表盘的智能手表，金属边框，左侧一枚圆形表冠' },
  { test: /钥匙/i, w: 2.2, h: 6, desc: '一把黄铜色金属钥匙，齿形清晰，柄部圆孔' },
  { test: /眼镜|墨镜/i, w: 5.5, h: 14, desc: '一副黑色细框眼镜，镜片透明，镜腿折起平放' },
  { test: /钱包|卡包/i, w: 9.5, h: 11.5, desc: '一个深棕色皮质短款钱包，翻盖接缝清晰，边缘缝线' },
  { test: /遥控器/i, w: 4.5, h: 17, desc: '一只黑色塑料遥控器，长条形，表面有按键阵列与圆形方向键' },
  { test: /手链|手串|链子|脚链/i, w: 6.5, h: 7, desc: '一条金色细链手链，链节细密、金属光泽柔和，收成一个圆圈平放着，中间是空的' },
  { test: /手镯|镯子/i, w: 6.5, h: 6.5, desc: '一只银色圆环手镯，环壁光洁、有金属反光，中间镂空' },
  { test: /戒指|指环/i, w: 1.8, h: 1.8, desc: '一枚金色金属戒指，环身圆润、表面抛光，戒圈中间镂空' },
  { test: /项链|吊坠/i, w: 9, h: 13, desc: '一条细银链项链，链条自然盘成一个水滴形环，带一枚小吊坠' },
  { test: /耳环|耳钉|耳坠/i, w: 1.2, h: 2.4, desc: '一对金色小耳钉，圆形亮面，边缘抛光' },
  { test: /皮带|腰带|皮带扣/i, w: 11, h: 11, desc: '一条深棕色皮质皮带，卷成一卷平放着，侧面露出银色金属扣头' },
  { test: /围巾|丝巾|披肩/i, w: 22, h: 26, desc: '一条米色羊毛围巾，叠成方块平放着，边缘有细流苏' },
  { test: /领带/i, w: 9, h: 12, desc: '一条深蓝色丝绸领带，卷成一卷平放着' },
  { test: /毛巾/i, w: 18, h: 24, desc: '一条浅灰色纯棉毛巾，叠成方块平放着' },
  { test: /衣服|上衣|T恤|t恤|卫衣|衬衫|外套|毛衣|针织|裙子|裤子/i, w: 26, h: 32, desc: '一件叠平的深灰色棉质上衣，袖口与下摆自然收拢，布面有细密织物纹理，颜色深灰偏冷' },
  { test: /包|背包|手提包|挎包|钱包?夹/i, w: 22, h: 28, desc: '一只深棕色皮质手提包，包身挺括，正面金属扣件，提手立起平放' },
  { test: /鞋|运动鞋|球鞋|皮鞋/i, w: 9, h: 26, desc: '一只黑色皮质运动鞋，鞋头圆润，鞋带整齐，侧边有白色条纹' },
  { test: /帽|鸭舌帽|棒球帽/i, w: 17, h: 24, desc: '一顶深蓝色棒球帽，帽身织物纹理清晰，前额有硬挺帽檐' },
  { test: /香水|香氛/i, w: 4.5, h: 9, desc: '一只透明玻璃香水瓶，瓶身方正，瓶盖为金属银色，内有淡琥珀色液体' },
  { test: /充电宝|移动电源|powerbank/i, w: 7, h: 14, desc: '一个深灰色金属外壳充电宝，圆角矩形扁平机身，侧面有两个接口和一排指示灯' },
  { test: /数据线|充电线|线缆/i, w: 4, h: 9, desc: '一根白色充电线，盘成圆形一圈，两端是金属接头' },
  { test: /鼠标|mouse/i, w: 6.5, h: 11, desc: '一个深灰色无线鼠标，流线型外壳，中缝滚轮为银色' },
  { test: /键盘|keyboard/i, w: 14, h: 44, desc: '一把白色机械键盘，键帽排列整齐，金属底板' },
  { test: /相机|camera/i, w: 9, h: 13, desc: '一台黑色微单相机，金属机身，正面圆形镜头' },
  { test: /笔|钢笔|签字笔|铅笔/i, w: 1.2, h: 14, desc: '一支黑色金属笔，笔身细长、笔夹为银色' },
  { test: /眼镜盒|墨镜盒/i, w: 6, h: 16, desc: '一个深灰色布面眼镜盒，拉链闭合，表面有细密纹理' },
  { test: /零食|饼干|巧克力|糖果|包装袋/i, w: 12, h: 19, desc: '一袋塑料包装零食，袋子鼓胀，正面有印刷图案，颜色为蓝白' },
  { test: /保温杯|水杯|随行杯/i, w: 7, h: 7, desc: '一只深灰色不锈钢保温杯，从上往下看是圆形杯口，杯盖有防滑纹' },
];

function localEstimate(name) {
  const hit = LOCAL_ITEMS.find((item) => item.test.test(name));
  if (hit) return { desc: hit.desc, w: hit.w, h: hit.h };
  // 不认识的：别瞎猜形态，把颜色和「避开绿幕」这两件必须的事说清楚
  return {
    desc: `${name}，写实的实物外观，形态完整、边缘清晰，材质质感真实，颜色为深色或金属色（不要绿色、不要墨绿、橄榄绿）`,
    w: 8,
    h: 12,
  };
}

const ITEM_PROMPT_VERSION = 3; // 提示词改了就加一，缓存自动失效

async function handleDescribe(req, res) {
  const body = await readJson(req, 8 * 1024);
  const name = String(body.name || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return json(res, 400, { error: '先写个物品名称，比如「马克杯」。' });
  if (name.length > 60) return json(res, 400, { error: '名称太长了，60 字以内就够。' });

  const force = body.refresh === true;
  const cacheKey = name.toLowerCase().replace(/[\s\-_/]+/g, '');

  if (!force) {
    const cache = await readItemCache();
    const hit = cache[cacheKey];
    if (hit?.source === 'llm' && hit.pv === ITEM_PROMPT_VERSION) {
      return json(res, 200, { ...hit, name, cached: true, ms: 0 });
    }
  }

  if (!LLM_API_KEY) {
    const local = localEstimate(name);
    return json(res, 200, {
      name,
      ...local,
      source: 'local',
      cached: false,
      warning: '没有配置 LLM_API_KEY，这次是本地粗估的尺寸。',
    });
  }

  const t0 = Date.now();
  try {
    const raw = await askLLM(name);
    const dims = normDims(raw.w, raw.h);
    const desc = cleanDesc(raw.desc);
    if (!desc) throw new Error('模型没给出可用的描述');
    if (!dims.w || !dims.h) throw new Error('模型没给出可用的尺寸');

    const entry = {
      name,
      desc,
      w: dims.w,
      h: dims.h,
      source: 'llm',
      model: LLM_MODEL,
      pv: ITEM_PROMPT_VERSION,
      ms: Date.now() - t0,
    };
    await writeItemCache(cacheKey, entry);
    console.log(`[describe] ${name} → ${entry.w}×${entry.h} cm ${entry.ms}ms（已缓存）`);
    return json(res, 200, entry);
  } catch (err) {
    const local = localEstimate(name);
    console.error('[describe]', name, err?.message || err);
    return json(res, 200, {
      name,
      ...local,
      source: 'local',
      cached: false,
      warning: `对话模型没返回可用结果（${err?.message || err}），先用本地粗估。`,
    });
  }
}

async function askLLM(name) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT);
    try {
      const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LLM_API_KEY}`,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: DESCRIBE_SYSTEM },
            { role: 'user', content: `物品名称：${name}` },
          ],
          temperature: 0,
          max_tokens: 4000,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      const text = await upstream.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }

      if (!upstream.ok) {
        const msg = data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${upstream.status}`;
        throw new Error(msg);
      }

      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        const reason = data?.choices?.[0]?.finish_reason || '空内容';
        throw new Error(`模型返回空内容（${reason}）`);
      }
      return parseJsonLoose(content);
    } catch (err) {
      lastError = err?.name === 'AbortError' ? new Error('对话模型超时') : err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('对话模型请求失败');
}

/** 模型偶尔会带 ```json 围栏或多说两句，这里都宽容处理 */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(slice);
  } catch {
    throw new Error('模型返回的不是 JSON');
  }
}

/** 去掉模型顺手加上的视角/背景词，避免和前端固定的「正俯视」措辞打架 */
function cleanDesc(text) {
  let s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'「『（(]+/, '')
    .replace(/["'」』）)]+$/, '');
  s = s
    .split(/[。；;\n]/)
    .filter((part) => !/(俯视|俯拍|镜头|角度|背景|构图|摆放|画布|光线|拍摄)/.test(part))
    .join('，')
    .replace(/[，,、\s]+/g, '，')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '');
  return s;
}

function normDims(w, h) {
  const clamp = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(Math.min(400, Math.max(0.3, n)) * 10) / 10;
  };
  let a = clamp(w);
  let b = clamp(h);
  if (a && b && a > b) [a, b] = [b, a];
  return { w: a, h: b };
}

async function readItemCache() {
  try {
    return JSON.parse(await readFile(ITEM_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeItemCache(key, entry) {
  const all = await readItemCache();
  all[key] = entry;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(ITEM_CACHE_FILE, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 在系统文件管理器里打开 output/，省得用户自己找 */
async function handleReveal(res) {
  await mkdir(OUTPUT_DIR, { recursive: true }).catch(() => {});
  const opener =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [OUTPUT_DIR], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => console.error('[reveal]', err.message));
    child.unref();
    json(res, 200, { ok: true, dir: OUTPUT_DIR });
  } catch (err) {
    json(res, 500, { error: `打不开文件夹：${err?.message || err}` });
  }
}

async function handleSceneSave(req, res, url) {
  const body = await readJson(req, 256 * 1024);
  const key = path.basename(url.searchParams.get('image') || 'base').replace(/\.(jpe?g|png|webp)$/i, '');
  if (!key || !/^[\w\-]+$/.test(key)) return json(res, 400, { error: '场景名只能用字母、数字、下划线、短横线' });

  const file = path.join(SCENES_DIR, `${key}.json`);
  let current = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* 新建 */
  }
  const next = { ...current, ...body, image: current.image || `${key}.jpg` };
  await mkdir(SCENES_DIR, { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}
`, 'utf8');
  console.log(`[scene] 保存 ${key}.json`);
  json(res, 200, { ok: true, scene: next });
}

async function handleScene(res, url) {
  const name = path.basename(url.searchParams.get('image') || 'base').replace(/\.(jpe?g|png|webp)$/i, '');
  try {
    const raw = await readFile(path.join(SCENES_DIR, `${name}.json`), 'utf8');
    json(res, 200, JSON.parse(raw));
  } catch {
    json(res, 200, {});
  }
}

async function handleHistory(res) {
  const entries = await readdir(OUTPUT_DIR).catch(() => []);
  const metas = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(OUTPUT_DIR, name), 'utf8');
      const meta = JSON.parse(raw);
      if (meta?.file) metas.push({ ...meta, url: `/output/${meta.file}` });
    } catch {
      /* 忽略坏记录 */
    }
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  json(res, 200, { items: metas.slice(0, 60) });
}

async function handleGenerate(req, res) {
  if (!API_KEY) {
    return json(res, 500, { error: '还没有配置 API Key，请在 .env 里填写 IMAGE_API_KEY 后重启服务。' });
  }

  const body = await readJson(req, 24 * 1024 * 1024);
  const model = MODELS.find((m) => m.id === body.model) || MODELS[0];
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 4) return json(res, 400, { error: '提示词太短了，至少写四个字。' });
  if (prompt.length > 6000) return json(res, 400, { error: '提示词太长了（上限 6000 字符）。' });

  const size = model.sizes.includes(body.size) ? body.size : model.sizes[0];
  const reference = typeof body.reference === 'string' ? body.reference : '';
  const useReference = Boolean(reference) && model.reference;

  if (reference && !model.reference) {
    // 继续生成，只是忽略参考图，前端会提示
  }
  if (useReference && !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(reference)) {
    return json(res, 400, { error: '参考图格式不对，需要 jpeg / png / webp 的 data URL。' });
  }

  const payload = { model: model.id, prompt, n: 1, size };
  if (useReference) payload.image = reference;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);

  const t0 = Date.now();
  const MAX_ATTEMPTS = Math.max(1, Number(process.env.IMAGE_RETRY ?? 2) + 1);

  try {
    let buffer = null;
    let attempts = 0;
    let upstreamError = null;

    // 上游会犯两种病：① 偶发回空图（转发超时）② 直接连不上（网络/CF 抖动）。
    // 两种都退避重试，批量跑的时候这点很有用。
    while (attempts < MAX_ATTEMPTS && !buffer) {
      attempts += 1;
      let upstream = null;
      try {
        upstream = await fetch(`${BASE_URL}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        upstreamError = `连不上上游（${err?.cause?.code || err?.message || 'network'}）`;
        console.log(`[generate] 第 ${attempts} 次网络失败：${upstreamError}`);
        if (attempts < MAX_ATTEMPTS) {
          const wait = 1500 * attempts * attempts; // 1.5s / 6s / 13.5s
          await new Promise((r) => setTimeout(r, wait));
        }
        continue;
      }

      const text = await upstream.text();
      const took = Date.now() - t0;
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }

      if (!upstream.ok) {
        const msg = data?.error?.message || data?.message || text.slice(0, 400) || `上游 HTTP ${upstream.status}`;
        // 5xx / 429 还有救，退避再试；4xx 是请求本身有问题，直接报
        if ((upstream.status >= 500 || upstream.status === 429) && attempts < MAX_ATTEMPTS) {
          upstreamError = msg;
          console.log(`[generate] 第 ${attempts} 次 HTTP ${upstream.status}，退避重试`);
          await new Promise((r) => setTimeout(r, 1500 * attempts * attempts));
          continue;
        }
        return json(res, 502, { error: `上游拒绝了这次请求：${msg}` });
      }
      if (!data) {
        return json(res, 502, { error: `上游返回的不是 JSON：${text.slice(0, 300)}` });
      }

      const item = Array.isArray(data.data) ? data.data[0] : null;
      if (!item?.b64_json && !item?.url) console.log('[generate] 原始响应:', text.slice(0, 300));
      if (item?.b64_json) {
        const decoded = Buffer.from(item.b64_json, 'base64');
        if (decoded.length >= 1024) buffer = decoded;
      } else if (item?.url) {
        const img = await fetch(item.url, { signal: controller.signal });
        if (img.ok) {
          const fetched = Buffer.from(await img.arrayBuffer());
          if (fetched.length >= 1024) buffer = fetched;
        }
      }
      if (!buffer) {
        upstreamError = data?.error?.message || '空图';
        if (attempts < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1200));
        console.log(
          `[generate] 第 ${attempts} 次返回空图（${model.id} · ${size} · ${took}ms），${attempts < MAX_ATTEMPTS ? '重试' : '放弃'}`,
        );
      }
    }

    if (!buffer) {
      return json(res, 502, {
        error: `中转站连续 ${attempts} 次返回空图（${upstreamError}）。多数是上游排队超时，不是提示词的问题：再点一次通常就出来了；也可以换个画幅或把描述改短试试。`,
      });
    }

    const ext = sniffExt(buffer);

    if (body.save === false) {
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      console.log(`[generate] ${model.id} ${size} ${Date.now() - t0}ms 临时图（不落盘）`);
      return json(res, 200, {
        image: `data:image/${mime};base64,${buffer.toString('base64')}`,
        model: model.id,
        size,
        ms: Date.now() - t0,
        attempts,
        temp: true,
      });
    }

    const createdAt = new Date();
    const id = stamp(createdAt);
    const baseName = `${id}_${model.id}`.replace(/[^\w.\-]+/g, '-');
    const fileName = `${baseName}.${ext}`;
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, fileName), buffer);

    const meta = {
      id,
      file: fileName,
      model: model.id,
      kind: body.kind === 'subject' ? 'subject' : 'image',
      size,
      usedReference: useReference,
      prompt,
      ms: Date.now() - t0,
      attempts,
      createdAt: createdAt.toISOString(),
      bytes: buffer.length,
    };
    await writeFile(path.join(OUTPUT_DIR, `${baseName}.json`), JSON.stringify(meta, null, 2), 'utf8');

    const notes = [];
    if (attempts > 1) notes.push(`上游第一次返回空图，重试第 ${attempts} 次成功。`);
    if (!useReference && reference) notes.push(`${model.id} 不接收参考图，这次是按纯文本提示词生成的。`);
    console.log(`[generate] ${model.id} ${size} ${meta.ms}ms ${buffer.length}B ref=${useReference}`);

    json(res, 200, { ...meta, url: `/output/${fileName}`, warning: notes.join(' ') });
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (res.writableEnded) return;
      return json(res, 499, { error: '已取消，或上游超时（默认 5 分钟）。' });
    }
    console.error('[generate]', err);
    if (!res.headersSent) json(res, 502, { error: `请求上游失败：${err?.message || err}` });
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }
}

async function handleSave(req, res) {
  const body = await readJson(req, 48 * 1024 * 1024);
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
  if (!match) return json(res, 400, { error: '图片格式不对，需要 data URL。' });

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 1024) return json(res, 400, { error: '图片是空的，没有东西可存。' });

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const createdAt = new Date();
  const illegal = new Set(['/', ':', '*', '?', '"', '<', '>', '|', String.fromCharCode(92)]);
  const safeName =
    [...String(body.name || '')].filter((ch) => !illegal.has(ch) && !/\s/.test(ch)).join('').slice(0, 24) ||
    '合成';

  const id = `${safeName}_${stamp(createdAt)}`;
  const fileName = `${id}.${ext}`;
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, fileName), buffer);

  const meta = {
    id,
    name: safeName,
    file: fileName,
    model: 'composite',
    kind: 'composite',
    size: String(body.size || ''),
    pxPerCm: Number(body.pxPerCm) || null,
    prompt: String(body.prompt || ''),
    ms: 0,
    createdAt: createdAt.toISOString(),
    bytes: buffer.length,
  };
  await writeFile(path.join(OUTPUT_DIR, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
  console.log(`[save] ${fileName} ${buffer.length}B`);

  json(res, 200, { ...meta, url: `/output/${fileName}` });
}

/* ---------------------------------------------------------------- helpers */

function sniffExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'webp';
  return 'png';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveFile(res, file, method = 'GET', cache = 'no-store') {
  try {
    const info = await stat(file);
    if (!info.isFile()) return json(res, 404, { error: '没有这个地址' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': cache,
    });
    if (method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: '没有这个地址' });
  }
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
