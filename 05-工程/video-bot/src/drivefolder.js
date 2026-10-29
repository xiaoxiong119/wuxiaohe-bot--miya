/**
 * 云盘投递文件夹：同事把大文件丢进共享文件夹，机器人自己扫、自己传
 *
 * 为什么要这个：飞书消息里的附件最大只能下 100 MB，
 * 而本地投递箱要求文件在小熊这台 Mac 上 —— 同事传不了。
 * 云盘文件夹是两边都能碰的地方：同事有编辑权，机器人有可阅读权。
 *
 * 前提：
 *   1. 应用有 space:document:retrieve（列文件夹）
 *   2. 文件夹把「乌小河」加为协作者（可阅读）
 *
 * 流程：列目录 → 新文件（按 token 去重）→ 下载到临时目录 → 入队上传 → 删临时文件
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');
const { tenantToken } = require('./drive');
const { stripRev } = require('./epname');

const D = cfg.DRIVE_INBOX || {};
const STATE = path.join(cfg.ROOT, 'drive-state.json');
const TMP = path.join(os.tmpdir(), 'wuxiaohe-drive');

let state = loadState();
let scanning = false;
let blocked = false; // 缺权限时暂停，别每 5 分钟撞一次

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { done: new Set(Array.isArray(s.done) ? s.done : []) };
  } catch (e) {
    return { done: new Set() };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE, JSON.stringify({ done: [...state.done].slice(-1000) }, null, 2));
  } catch (e) {
    /* 忽略 */
  }
}

function enabled() {
  return !!(D.enabled && D.folderToken);
}

function isVideo(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return cfg.ALLOWED_EXT.length ? cfg.ALLOWED_EXT.includes(ext) : true;
}

/** 列文件夹里的文件（只要普通文件） */
async function listFiles(folderToken) {
  const token = await tenantToken();
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const url = new URL('https://open.feishu.cn/open-apis/drive/v1/files');
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '50');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      const err = new Error(`列云盘文件夹失败：${data.code} ${data.msg}`);
      err.scopeHint = /99991672/.test(String(data.code));
      throw err;
    }
    out.push(...((data.data && data.data.files) || []).filter((f) => f.type === 'file'));
    if (!data.data || !data.data.has_more) break;
    pageToken = data.data.next_page_token || '';
    if (!pageToken) break;
  }
  return out;
}

/** 扫一遍；返回新文件列表（含下载好的本地路径） */
async function scanOnce(force) {
  if (!enabled()) return { skipped: true, items: [] };
  if (blocked && !force) return { skipped: true, blocked: true, items: [] };
  if (force) blocked = false;
  if (scanning) return { skipped: true, items: [] };
  scanning = true;
  try {
    const files = await listFiles(D.folderToken);
    const picked = files.filter((f) => isVideo(f.name) && !state.done.has(f.token));
    const items = [];
    for (const f of picked) {
      try {
        const { download } = require('./drive');
        // 「122-改.mov」按 122.mov 落盘 —— 分秒帧按磁盘文件名找同名条目，
        // 名字里带时间戳或「-改」，就认不出是同一集，只会新建一份重复的。
        const uploadName = stripRev(f.name);
        const dir = path.join(TMP, `${Date.now()}-${String(f.token).slice(-6)}`);
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, uploadName);
        await download(f.token, local);
        items.push({
          token: f.token,
          name: f.name,
          uploadName,
          local,
          size: fs.statSync(local).size,
        });
      } catch (e) {
        log(`云盘投递：${f.name} 下载失败 ${(e && e.message) || e}`);
        // 权限问题就别在每一轮里反复撞
        if (/403/.test(String(e && e.message))) state.done.add(f.token);
      }
    }
    if (picked.length || files.length) {
      log(`云盘投递：文件夹里 ${files.length} 个文件，新视频 ${items.length} 个`);
    }
    return { files: files.length, items };
  } finally {
    scanning = false;
    saveState();
  }
}

/** 传完/失败后清场 */
function finish(token, local) {
  state.done.add(token);
  saveState();
  try {
    if (local && fs.existsSync(local)) fs.unlinkSync(local);
  } catch (e) {
    /* 忽略 */
  }
}

function start(onItem) {
  if (!enabled()) return;
  if (D.auto === false) {
    log('云盘投递：自动扫描已关（改用 /driveup <名字> 或 /drive 手动扫）');
    return;
  }
  const min = D.pollMinutes || 5;
  log(`云盘投递：${D.folderToken}（每 ${min} 分钟扫一次）`);
  setTimeout(async () => {
    try {
      const r = await scanOnce();
      for (const it of r.items || []) onItem(it);
    } catch (e) {
      if (/99991672/.test(String(e && e.message))) {
        blocked = true;
        log('云盘投递：缺 space:document:retrieve，暂停自动扫描（开完权限发 /drive 或重启）');
        return;
      }
      log('云盘投递扫描失败：' + ((e && e.message) || e));
    }
  }, 20000);
  setInterval(async () => {
    try {
      const r = await scanOnce();
      for (const it of r.items || []) onItem(it);
    } catch (e) {
      if (/99991672/.test(String(e && e.message))) {
        blocked = true;
        log('云盘投递：缺 space:document:retrieve，暂停自动扫描（开完权限发 /drive 或重启）');
        return;
      }
      log('云盘投递扫描失败：' + ((e && e.message) || e));
    }
  }, min * 60 * 1000).unref();
}

function isDone(token) {
  return state.done.has(token);
}

module.exports = { start, scanOnce, finish, enabled, listFiles, isDone, TMP };
