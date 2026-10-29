/**
 * 下载临时文件
 *
 * 每次下载单独开一个 `.t-<时间戳>-<tag>/` 子目录，文件名仍然是目标名 —— worker 按
 * basename 认分秒帧里的条目（stripRev 之后同名走「上传版本」），所以文件名不能动。
 *
 * 为什么不再直接写 downloads/<目标名>：两个人同时 /driveup 同一集（122-改1 / 122-改2
 * 都归一化成 122.mov）会往同一个文件里同时写，谁后写完谁赢，传上去的可能是半截文件。
 */
const fs = require('fs');
const path = require('path');

const TASK_DIR_PREFIX = '.t-';

function isTaskDir(name) {
  return String(name || '').startsWith(TASK_DIR_PREFIX);
}

function taskPath(rootDir, outName, tag) {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const safeTag = String(tag || '').replace(/[^\w-]/g, '').slice(-8);
  return path.join(rootDir, `${TASK_DIR_PREFIX}${stamp}-${safeTag}`, outName);
}

/** 删文件，顺便把空的任务目录收掉；只碰 .t- 目录，别的地方不动物 */
function cleanup(filePath, rootDir) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (e) { /* 已删或删不掉 */ }
  try {
    const dir = path.resolve(path.dirname(filePath));
    // 只收「root 下面一层、名字是 .t- 开头」的目录，防止误删别处
    if (path.dirname(dir) === path.resolve(rootDir) && isTaskDir(path.basename(dir))) {
      fs.rmdirSync(dir);
    }
  } catch (e) { /* 目录非空/不存在都跳过 */ }
}

module.exports = { taskPath, cleanup, isTaskDir };
