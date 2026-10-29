/**
 * 单实例锁
 *
 * start.sh 只检查 bot.pid，直接 `node src/index.js` 能绕过去。两个实例同时跑：
 * ① 抢同一个飞书应用的事件（谁抢到算谁的，消息随机丢）；
 * ② 两套上传队列同时驱动 Chrome（同一集传两遍、互相打断下载）。
 *
 * 锁文件放项目根（.bot.lock），内容 {pid, at}。判活两步：
 *   kill -0 看进程在不在 → ps 看命令行里是不是 src/index.js（防 pid 复用误判）。
 * 进程崩了留下的旧锁、pid 已死的锁，下一个进程直接接管。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { log } = require('./log');

const BOT_CMD = /src[\\/]index\.js/;

function lockPath(root) {
  return path.join(root, '.bot.lock');
}

function pidLooksLikeBot(pid) {
  try { process.kill(pid, 0); } catch (e) { return false; }
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (!cmd.trim()) return false; // 进程刚好退了
    return BOT_CMD.test(cmd);
  } catch (e) {
    return true; // ps 查不了（权限/沙箱）时保守当作在跑，宁可拒绝启动
  }
}

function readLockedPid(root) {
  try {
    return Number(JSON.parse(fs.readFileSync(lockPath(root), 'utf8')).pid) || 0;
  } catch (e) {
    return 0;
  }
}

/** 同步小睡：主进程还没进事件循环，只能用这个 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 兜底空转 */ }
  }
}

/**
 * @param {string} root 项目根目录
 * @param {{waitMs?: number}} [opts] 老进程还没退干净时最多等多久（重启场景：stop.sh 刚发 SIGTERM）
 * @returns {{ok: boolean, pid?: number}}
 */
function acquire(root, opts = {}) {
  const deadline = Date.now() + Math.max(0, Number(opts.waitMs) || 0);
  let told = false;
  for (;;) {
    const pid = readLockedPid(root);
    if (!pid || pid === process.pid || !pidLooksLikeBot(pid)) break;
    if (Date.now() >= deadline) return { ok: false, pid };
    if (!told) { log(`单实例锁还被 pid ${pid} 占着，等它退出…`); told = true; }
    sleepSync(1000);
  }
  try {
    fs.writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch (e) {
    log('⚠️ 单实例锁写不了（不拦启动）：' + ((e && e.message) || e));
  }
  return { ok: true };
}

/** 只删自己的锁：别人接管之后不能把对方的锁删掉 */
function release(root) {
  if (readLockedPid(root) !== process.pid) return;
  try { fs.unlinkSync(lockPath(root)); } catch (e) { /* 已经没了 */ }
}

module.exports = { acquire, release, pidLooksLikeBot, lockPath };
