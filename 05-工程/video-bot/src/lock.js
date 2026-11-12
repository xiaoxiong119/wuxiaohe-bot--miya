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
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
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
  const file = lockPath(root);
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (error.code !== 'EEXIST') {
        log('单实例锁无法建立，停止启动：' + error.message);
        return { ok: false, error: error.message };
      }
    }
    const pid = readLockedPid(root);
    if (pid === process.pid) return { ok: true };
    let stat;
    try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; return { ok: false }; }
    // 新锁可能刚创建还没写入 PID；不把这个短暂窗口当作陈旧锁。
    const writing = !pid && Date.now() - stat.mtimeMs < 5000;
    if (!writing && (!pid || !pidLooksLikeBot(pid))) {
      // 陈旧锁的接管也必须互斥，不能让两个新进程同时删掉对方刚建立的锁。
      const recovery = path.join(root, '.bot.lock-recovery');
      let ownsRecovery = false;
      try {
        fs.mkdirSync(recovery, {mode:0o700});
        ownsRecovery = true;
        const current = fs.statSync(file);
        if (current.ino !== stat.ino || readLockedPid(root) !== pid) continue;
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code === 'EEXIST') {
          if (Date.now() >= deadline) return {ok:false, error:'另一进程正在接管旧锁；若目录长期残留，请先核对进程'};
          sleepSync(100);
        } else if (error.code !== 'ENOENT') return { ok: false, error: error.message };
      } finally {
        if (ownsRecovery) fs.rmdirSync(recovery);
      }
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, pid };
    sleepSync(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

/** 只删自己的锁：别人接管之后不能把对方的锁删掉 */
function release(root) {
  if (readLockedPid(root) !== process.pid) return;
  try { fs.unlinkSync(lockPath(root)); } catch (e) { /* 已经没了 */ }
}

module.exports = { acquire, release, pidLooksLikeBot, lockPath };
