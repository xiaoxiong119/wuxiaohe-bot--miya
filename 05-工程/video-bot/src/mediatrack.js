/**
 * 分秒帧上传
 *
 * 这段是从已跑通的 feishu-video-to-mediatrack/run.js 里搬过来的，
 * 与飞书完全解耦 —— 只依赖 bsk（浏览器控制）+ Chrome 里的分秒帧登录态。
 *
 * 在 worker.js 子进程里调用，不要在主进程直接调：
 * execFileSync 会阻塞事件循环，长连接心跳会断。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { getTarget } = require('./target');
const { log } = require('./log');
const { subjectKey, isRev } = require('./epname');

const HOME = process.env.HOME;
const BSK = path.join(HOME, '.local/bin/bsk');
const PATH_ENV = [path.join(HOME, '.local/bin'), process.env.PATH].join(':');

function bsk(args) {
  return execFileSync(BSK, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BSK_AUTO_START: '0', PATH: PATH_ENV },
    maxBuffer: 32 * 1024 * 1024,
  });
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function evalIn(sid, js) {
  const raw = bsk(['evaluate', '--session', sid, js]);
  return String(raw).trim().split('\n').pop();
}

/**
 * 找同名条目，顺手把这一屏出现过的文件名都带回来。
 * 带回来是为了「同名找不到、但同一集换个写法存在」时能接着降级匹配
 * （虚拟滚动只渲染可视区，过一屏就查不到了，只能边滚边收）。
 */
const JS_FIND_CARD = (name) => `
(() => {
  const cards = [...document.querySelectorAll('div.item')];
  const alts = cards
    .map((x) => { const i = x.querySelector('img[alt]'); return i ? i.getAttribute('alt') : null; })
    .filter(Boolean);
  const c = cards.find((x) => {
    const i = x.querySelector('img[alt]');
    return i && i.getAttribute('alt') === ${JSON.stringify(name)};
  });
  if (!c) return JSON.stringify({ st: 'NF', alts });
  c.scrollIntoView({ block: 'center' });
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
  return JSON.stringify({ st: 'OK', alts });
})()
`;

const JS_TAG_VERSION_MENU = `
(() => {
  const li = [...document.querySelectorAll('li[role=menuitem]')].find((e) => e.textContent.trim() === '上传版本');
  if (!li) return 'NF';
  li.id = 'bsk-menu-version';
  return 'OK';
})()
`;

/** 记下「上传版本」点到的是哪个 file input */
const JS_HOOK_INPUT = `
(() => {
  window.__lastFileInput = null;
  if (!window.__fileInputHooked) {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'file') window.__lastFileInput = t;
    }, true);
    window.__fileInputHooked = true;
  }
  return 'OK';
})()
`;

const JS_SHOW_PICKED_INPUT = `
(() => {
  const e = window.__lastFileInput || [...document.querySelectorAll('input[type=file]')].find((x) => x.accept === '*');
  if (!e) return 'NF';
  e.id = 'bsk-ver-input';
  e.style.cssText = 'display:block !important;visibility:visible !important;opacity:1 !important;position:fixed;top:0;left:0;width:20px;height:20px;z-index:999999;';
  return 'OK';
})()
`;

const JS_SCROLL = `
(() => {
  const it = document.querySelector('div.item');
  if (!it) return '-1';
  let p = it.parentElement;
  while (p && p.scrollHeight <= p.clientHeight + 20) p = p.parentElement;
  if (!p) return '-1';
  const b = p.scrollTop;
  p.scrollTop = b + p.clientHeight * 0.9;
  return b + '->' + p.scrollTop;
})()
`;

/** 列表滚回顶部（降级匹配要换个名字再找一遍，得从头开始） */
const JS_SCROLL_TOP = `
(() => {
  const it = document.querySelector('div.item');
  if (!it) return '-1';
  let p = it.parentElement;
  while (p && p.scrollHeight <= p.clientHeight + 20) p = p.parentElement;
  if (!p) return '-1';
  p.scrollTop = 0;
  return 'OK';
})()
`;

/** 列表是虚拟滚动，同名文件可能不在首屏：边滚边找，找到就右键打开菜单 */
async function seekCard(sid, name) {
  const alts = new Set();
  for (let i = 0; i < 15; i++) {
    let r;
    try {
      r = JSON.parse(evalIn(sid, JS_FIND_CARD(name)));
    } catch (e) {
      r = { st: 'NF', alts: [] };
    }
    (r.alts || []).forEach((a) => alts.add(a));
    if (r.st === 'OK') return { found: true, alts };
    const line = evalIn(sid, JS_SCROLL);
    const m = /^(\d+)->(\d+)$/.exec(String(line));
    if (!m || m[1] === m[2]) break;
    await sleep(1);
  }
  return { found: false, alts };
}

/**
 * 同名条目不存在时，找一个「同一集、只是写法不同」的条目：
 *   122.mp4 ↔ 122.mov（扩展名换了）
 *   54集-改.mp4 ↔ 54.mp4（早期用「集」，后来改成纯数字）
 *   《逆天萌兽2》65.mov ↔ 65-改.mp4
 * 优先挑不带修改标记的干净条目，别再挂到「xxx-改」这种脏条目上。
 */
function pickSameSubject(fileName, alts) {
  const key = subjectKey(fileName);
  if (!key) return '';
  const hits = [...alts].filter((a) => a && a !== fileName && subjectKey(a) === key);
  if (!hits.length) return '';
  const clean = hits.filter((a) => !isRev(a));
  return clean[0] || hits[0];
}

/**
 * 读卡片上的版本号。一次问多个名字：
 * 「上传版本」之后分秒帧会把条目名改成这次上传的文件名（122.mov 传成 122.mp4，名字就跟着变），
 * 所以上传前的名字和上传名都得认。
 */
const JS_READ_VERSION = (names) => `
(() => {
  const want = ${JSON.stringify(names)};
  const cards = [...document.querySelectorAll('div.item')];
  const out = {};
  for (const n of want) {
    const cs = cards.filter((x) => {
      const i = x.querySelector('img[alt]');
      return i && i.getAttribute('alt') === n;
    });
    if (!cs.length) continue;
    let best = 0;
    for (const c of cs) {
      const m = /v(\\d+)/.exec(c.innerText);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
    out[n] = String(best);
  }
  return JSON.stringify(out);
})()
`;

/** 页面上给隐藏 file input 打标记，并让第 0 个可见 */
const JS_PREPARE_UPLOAD = `
(() => {
  const btn = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '上传');
  if (btn) btn.click();
  const inputs = [...document.querySelectorAll('input[type=file]')];
  inputs.forEach((e, i) => { e.id = 'bsk-file-' + i; });
  const el = inputs[0];
  if (el) el.style.cssText = 'display:block !important;visibility:visible !important;opacity:1 !important;position:fixed;top:0;left:0;width:20px;height:20px;z-index:999999;';
  return JSON.stringify({ clicked: !!btn, inputs: inputs.length });
})()
`;

const JS_CHECK_PROGRESS = `
(() => {
  const t = document.body.innerText;
  return JSON.stringify({
    hasPanel: t.includes('传输列表'),
    done: t.includes('100%'),
    hasError: t.includes('上传失败'),
  });
})()
`;

/** 读列表页「共 N 项」 */
function readFileCount(sid) {
  const raw = bsk(['evaluate', '--session', sid,
    `(() => { const m = document.body.innerText.match(/共\\s*(\\d+)\\s*项/); return m ? m[1] : '0'; })()`]);
  const line = raw.trim().split('\n').pop();
  return parseInt(line, 10) || 0;
}

/**
 * 边滚边读版本号。列表是虚拟滚动，不在首屏的条目查不到 ——
 * 上传 122 这种排在列表中间的条目，刷新后光看首屏必然是「读不到」。
 */
async function readVersions(sid, names) {
  const want = names.filter(Boolean);
  for (let pass = 0; pass < 2; pass++) {
    evalIn(sid, JS_SCROLL_TOP);
    await sleep(1);
    for (let i = 0; i < 16; i++) {
      let map = {};
      try { map = JSON.parse(evalIn(sid, JS_READ_VERSION(want))) || {}; } catch (e) { map = {}; }
      if (Object.keys(map).length) return map;
      const line = evalIn(sid, JS_SCROLL);
      const m = /^(\d+)->(\d+)$/.exec(String(line));
      if (!m || m[1] === m[2]) break;
      await sleep(1);
    }
    await sleep(2); // 可能还没渲染完，再来一轮
  }
  return {};
}

async function uploadToMediatrack(filePath) {
  // 每次上传都现读目标，/target 改完立刻生效
  const PROJECT_URL = getTarget().projectUrl;
  const sessionRaw = bsk(['session', 'start', '--json']);
  const sid = JSON.parse(sessionRaw).session_id;
  log(`浏览器会话 ${sid}`);

  try {
    bsk(['navigate', '--session', sid, PROJECT_URL]);
    await sleep(5);

    // 登录态检查：过期会跳到 /welcome 或登录页
    const curUrl = bsk(['evaluate', '--session', sid, 'location.href']).trim().split('\n').pop();
    if (curUrl.includes('/welcome') || curUrl.includes('login')) {
      throw new Error('分秒帧登录已过期，请在电脑浏览器里扫码重新登录');
    }

    // 关掉可能弹出的「激活团队账号」遮罩
    try { bsk(['press', '--session', sid, 'Escape']); } catch (e) {}
    await sleep(1);

    const countBefore = readFileCount(sid);
    log(`当前列表 ${countBefore} 项`);

    // 同名文件已存在 → 走「上传版本」，不新建重复文件
    const fileName = path.basename(filePath);
    let target = fileName;
    let hit = await seekCard(sid, fileName);
    if (!hit.found) {
      // 同名一条都没有，但同一集换个写法在（扩展名不同 / 54集 vs 54 / 带《》前缀）
      // 也按那一条走「上传版本」，别在列表里再堆一份
      const alt = pickSameSubject(fileName, hit.alts);
      if (alt) {
        log(`列表里没有 ${fileName}，但同一集有 ${alt}，改按它上传版本`);
        evalIn(sid, JS_SCROLL_TOP);
        await sleep(1);
        const again = await seekCard(sid, alt);
        if (again.found) {
          hit = again;
          target = alt;
        }
      }
    }
    if (hit.found) {
      log(`已存在「${target}」，改为上传新版本`);
      await sleep(1);
      bsk(['evaluate', '--session', sid, JS_HOOK_INPUT]);
      const tagged = evalIn(sid, JS_TAG_VERSION_MENU);
      if (tagged !== 'OK') throw new Error('没找到「上传版本」菜单项');
      bsk(['click', '--session', sid, '--selector', '#bsk-menu-version']);
      await sleep(1.5);
      const shown = evalIn(sid, JS_SHOW_PICKED_INPUT);
      if (shown !== 'OK') throw new Error('「上传版本」没有出现文件选择框');
      await sleep(1);

      bsk(['upload', '--session', sid, '--selector', '#bsk-ver-input', '--file', filePath]);
      log('新版本已注入，等待上传完成…');

      let done = false;
      for (let i = 0; i < 100; i++) {
        await sleep(6);
        const line = evalIn(sid, JS_CHECK_PROGRESS);
        let st;
        try { st = JSON.parse(line); } catch (e) { continue; }
        if (st.hasError) throw new Error('分秒帧报上传失败');
        if (st.done) { done = true; break; }
        if (i > 0 && i % 5 === 0) log(`上传中…（第 ${i * 6}s）`);
      }
      if (!done) log('⚠️ 未在 10 分钟内看到 100%，请到页面确认');

      await sleep(2);
      bsk(['navigate', '--session', sid, PROJECT_URL]);
      await sleep(8);
      // 「上传版本」会把条目名改成这次上传的文件名，两个名字都认
      const verMap = await readVersions(sid, [fileName, target]);
      const ver = verMap[fileName] || verMap[target] || '';
      const countAfterV = readFileCount(sid);
      const okV = !!ver && ver !== '0';
      log(okV
        ? `✅ 版本更新完成：${target} 现在是 v${ver}（列表 ${countBefore} → ${countAfterV} 项）`
        : `⚠️ 版本已提交，但列表里没读到版本号（${countBefore} → ${countAfterV} 项），请到页面确认`);

      return {
        ok: okV,
        mode: 'version',
        version: okV ? `v${ver}` : '?',
        countBefore,
        countAfter: countAfterV,
        fileName: target,
        uploadedAs: fileName,
        url: PROJECT_URL,
      };
    }

    const prep = bsk(['evaluate', '--session', sid, JS_PREPARE_UPLOAD]);
    log(`上传菜单：${prep.trim().split('\n').pop()}`);
    if (!prep.includes('"clicked":true')) throw new Error('没找到上传按钮，页面可能没加载完');
    await sleep(1);

    bsk(['upload', '--session', sid, '--selector', '#bsk-file-0', '--file', filePath]);
    log('文件已注入，等待上传完成…');

    let finished = false;
    for (let i = 0; i < 100; i++) {
      await sleep(6);
      const line = bsk(['evaluate', '--session', sid, JS_CHECK_PROGRESS]).trim().split('\n').pop();
      let st;
      try { st = JSON.parse(line); } catch (e) { continue; }
      if (st.hasError) throw new Error('分秒帧报上传失败');
      if (st.done) { finished = true; break; }
      if (i > 0 && i % 5 === 0) log(`上传中…（第 ${i * 6}s）`);
    }
    if (!finished) log('⚠️ 未在 10 分钟内看到 100%，请到页面确认');

    // 刷新后用文件总数确认（同名文件会共存，不能靠文件名判断）
    await sleep(2);
    bsk(['navigate', '--session', sid, PROJECT_URL]);
    await sleep(8);
    const countAfter = readFileCount(sid);
    const ok = countAfter > countBefore;
    log(ok ? `✅ 上传成功：列表 ${countBefore} → ${countAfter} 项`
           : `⚠️ 列表数量没变（${countBefore} → ${countAfter}）`);

    return {
      ok,
      countBefore,
      countAfter,
      fileName: path.basename(filePath),
      url: PROJECT_URL,
    };
  } finally {
    try { bsk(['session', 'stop', sid]); } catch (e) {}
  }
}

module.exports = { uploadToMediatrack };
