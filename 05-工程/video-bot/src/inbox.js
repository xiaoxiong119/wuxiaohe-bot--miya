/**
 * 本地投递箱
 *
 * 飞书消息里的附件超过 100 MB 就下不下来（im.messageResource.get 的硬限制）。
 * 大文件走这里：把视频丢进 inbox/，机器人自己发现、上传、回执。
 *
 * 规则：
 *   - 文件名就是分秒帧里的名字（67.mp4 → 67.mp4）
 *   - 想改名又不想改文件名：同目录放一个同名 .txt，内容写目标名字
 *   - 传完移到 inbox/done/；失败留在原地并回执
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');
const { stripRev } = require('./epname');

const INBOX = cfg.INBOX_DIR;
const DONE = path.join(INBOX, 'done');
const FAILED = path.join(INBOX, 'failed');
const seen = new Map(); // path -> {size, mtime, stableCount}

function ensureDirs() {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(DONE, { recursive: true });
  fs.mkdirSync(FAILED, { recursive: true });
}

function isVideo(name) {
  const ext = path.extname(name).toLowerCase();
  return (cfg.ALLOWED_EXT.length ? cfg.ALLOWED_EXT.includes(ext) : true);
}

/** 等文件写完再动：连续两次扫描大小不变，且最后修改超过 3 秒 */
function isStable(full, size, mtime) {
  const key = full;
  const prev = seen.get(key);
  const now = Date.now();
  if (!prev || prev.size !== size || prev.mtime !== mtime) {
    seen.set(key, { size, mtime, stableCount: 1 });
    return false;
  }
  prev.stableCount += 1;
  return prev.stableCount >= 2 && now - mtime > 3000;
}

/**
 * 扫一遍投递箱，返回已经稳定的视频。
 * 返回 [{ path, fileName, outName }]
 */
function scan() {
  ensureDirs();
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(INBOX, { withFileTypes: true });
  } catch (e) {
    return out;
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    if (!isVideo(ent.name)) continue;

    const full = path.join(INBOX, ent.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.size) continue;
    if (!isStable(full, st.size, st.mtimeMs)) continue;

    // 同名 txt 可指定目标名字
    let outName = ent.name;
    let named = false;
    const sidecar = full.replace(/\.[^.]+$/, '.txt');
    if (fs.existsSync(sidecar)) {
      try {
        const t = fs.readFileSync(sidecar, 'utf8').trim();
        if (t) {
          outName = path.extname(t) ? t : `${t}${path.extname(ent.name)}`;
          named = true;
        }
      } catch (e) {
        /* 忽略，用原文件名 */
      }
    }

    // 没手写 .txt 时，把「122-改.mp4」这类修改标记去掉：按 122.mp4 传，
    // 分秒帧那边才认得出是同一集、走「上传版本」，而不是新建一份重复文件。
    let localPath = full;
    if (!named) {
      const clean = stripRev(outName);
      if (clean !== outName) {
        const target = path.join(INBOX, clean);
        try {
          if (fs.existsSync(target)) {
            log(`投递箱：${outName} 想按 ${clean} 传，但同名文件已在箱里，这份先按原名走`);
          } else {
            fs.renameSync(full, target);
            log(`投递箱：${outName} 是修改版，改名成 ${clean} 再传`);
            outName = clean;
            localPath = target;
            st = fs.statSync(target);
          }
        } catch (e) {
          log(`投递箱：改名 ${clean} 失败（${(e && e.message) || e}），按原名传`);
        }
      }
    }

    out.push({ path: localPath, fileName: ent.name, outName, size: st.size });
  }
  return out;
}

/** 传完挪进 done/，避免重复上传 */
function markDone(item) {
  try {
    const dest = path.join(DONE, path.basename(item.path));
    fs.renameSync(item.path, dest);
    const sidecar = item.path.replace(/\.[^.]+$/, '.txt');
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, path.join(DONE, path.basename(sidecar)));
    }
    seen.delete(item.path);
    log(`投递箱：${item.fileName} 已移入 done/`);
  } catch (e) {
    log('投递箱：移动到 done 失败 ' + (e && e.message));
  }
}

/** 失败挪进 failed/，别每 10 秒重试一遍 */
function markFailed(item) {
  try {
    fs.renameSync(item.path, path.join(FAILED, path.basename(item.path)));
    seen.delete(item.path);
    log(`投递箱：${item.fileName} 上传失败，已移入 failed/`);
  } catch (e) {
    log('投递箱：移动到 failed 失败 ' + (e && e.message));
  }
}

function start(onItem) {
  if (!(cfg.INBOX && cfg.INBOX.enabled)) return;
  ensureDirs();
  const sec = cfg.INBOX.pollSeconds || 10;
  log(`投递箱：${INBOX}（每 ${sec} 秒扫一次，大文件直接丢进去）`);

  setInterval(() => {
    let items = [];
    try {
      items = scan();
    } catch (e) {
      log('投递箱扫描失败：' + (e && e.message));
      return;
    }
    for (const it of items) {
      if (itemBusy.has(it.path)) continue;
      itemBusy.add(it.path);
      onItem(it);
    }
  }, sec * 1000).unref();
}

const itemBusy = new Set();

function clearBusy(item) {
  itemBusy.delete(item.path);
}

module.exports = { start, scan, markDone, markFailed, clearBusy, INBOX, DONE, FAILED };
