const pendingUploads = require('./pending-uploads').createStore(require('./config').ROOT);
const { writeJson } = require('./json-file');
/**
 * 乌小河 · 飞书视频 → 分秒帧 · 主进程
 *
 * 用法（私聊）：
 *   1. 发一个视频
 *   2. 发 /upmedia 名字     ← 名字随便起，比如 67、EP12-镜头03
 *   → 机器人把视频下载下来、重命名成「名字.mp4」、传到分秒帧，回列表数变化 + 项目链接
 *
 * 两个方向都支持：
 *   视频先到 → 缓存着等命令；命令先到 → 等 5 分钟内的下一个视频。
 *
 * 架构：
 *   飞书长连接（WSClient）收 im.message.receive_v1
 *     → 3 秒内返回（只做解析 + 入队，绝不在这里上传）
 *     → 串行队列：下载 → spawn worker 子进程上传 → 回消息
 *
 * 为什么上传要开子进程：mediatrack 用的是 bsk 的同步调用，
 * 在主进程会堵死事件循环，长连接心跳断了就收不到消息了。
 *
 * 启动：node src/index.js
 * 自检：node src/index.js --selftest   （只验证 app 凭证，不建长连接）
 */
const Lark = require('@larksuiteoapi/node-sdk');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawn, execFileSync } = require('child_process');

const cfg = require('./config');
const { log } = require('./log');
const {
  getClient, parseAttachment, parseTextCommand, textContent, downloadResource, sendText,
  sendTextTo, sendCardTo, sendInteractive, safeName, describeError,
} = require('./feishu');
const inbox = require('./inbox');
const drive = require('./drive');
const drivefolder = require('./drivefolder');
const reviewsync = require('./reviewsync');
const schedulesync = require('./schedulesync');
const epname = require('./epname');
const C = require('./cards');
const target = require('./target');
const { editField } = require('./bitable');
const flow = require('./flow');
const health = require('./health');
const workday = require('./workday');
const pointsReminder = require('./points-reminder');
const release = require('./release');
const releaseDraft = require('./release-draft');
const botLock = require('./lock');
const tempfile = require('./tempfile');
const queueorder = require('./queueorder');

const NODE_BIN = path.dirname(process.execPath);
const PATH_ENV = [path.join(process.env.HOME, '.local/bin'), NODE_BIN, process.env.PATH].join(':');

/** 跑子进程用的干净环境：不带 WorkBuddy 注入的 Node shim（会连 broker，broker 不在就 exit 1） */
function childEnv(extra) {
  const env = { ...process.env, PATH: PATH_ENV, ...(extra || {}) };
  if (/node-language-shim|node-brokered-fs-shim/.test(String(env.NODE_OPTIONS || ''))) delete env.NODE_OPTIONS;
  delete env.WORKBUDDY_FS_PROTECTION_ROLE;
  delete env.CODEBUDDY_SANDBOX_BROKER_SESSION_ID;
  return env;
}

const COMMAND = cfg.COMMAND;            // 默认 /upmedia
const WAIT_SECONDS = cfg.WAIT_SECONDS;  // 命令先到时等视频的秒数

// ---------------------------------------------------------------- 给小熊本人的上传回执

/** 老板自己的 open_id（config.inbox.notifyOpenId） */
const OWNER_OPEN_ID = (cfg.INBOX && cfg.INBOX.notifyOpenId) || '';

/**
 * help.md / help-lite.md 里的占位符 → 当前配置的值：
 * {{DRIVE_FOLDER_URL}} 云盘收件夹链接、{{TARGET_LABEL}} 分秒帧目标（例：【《逆天萌兽2》的「粗剪」文件夹】）
 */
function fillHelpVars(md) {
  const folder = (cfg.DRIVE_INBOX && cfg.DRIVE_INBOX.folderUrl) || '（云盘收件夹还没配）';
  let label = '（还没设上传目标）';
  try {
    label = target.label();
  } catch (e) {
    /* 目标坏了就用占位 */
  }
  return String(md || '')
    .replace(/\{\{DRIVE_FOLDER_URL\}\}/g, folder)
    .replace(/\{\{TARGET_LABEL\}\}/g, label);
}

/**
 * 别人用 /upmedia、/driveup 传完以后，给陈俊杰本人发一条：
 * 谁、哪一集、成功还是失败。自己传的就不打扰（聊天里已经能看到）。
 */
function feedbackToOwner(job, ok, resultText) {
  try {
    if (!OWNER_OPEN_ID) return;
    const byOpenId = (job.by && job.by.openId) || '';
    if (byOpenId && byOpenId === OWNER_OPEN_ID) return; // 自己传的不再另发

    const source = job.att && job.att.driveToken
      ? '云盘投递 /driveup'
      : (job.inboxItem ? '本机投递箱' : (byOpenId ? '飞书视频 /upmedia' : '本机/未知'));

    const card = C.uploadFeedbackCard({
      outName: job.outName,
      byOpenId,
      ok: !!ok,
      unknown: !!job.uploadUnknown,
      episode: reviewsync.episodeOf(job.outName),
      source,
      resultText,
      inbox: !!job.inboxItem,
    });
    sendCardTo(OWNER_OPEN_ID, card).then((sent) => {
      log(sent ? `已给本人回执：${job.outName} ${ok ? '成功' : '失败'}` : '⚠️ 给本人的回执没发出去');
    }).catch(() => {});
  } catch (e) {
    log('回执失败：' + ((e && e.message) || e));
  }
}

// ---------------------------------------------------------------- 状态（去重）

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(cfg.STATE_FILE, 'utf8'));
    if (!Array.isArray(s.handled)) s.handled = [];
    if (!Array.isArray(s.healthSent)) s.healthSent = [];
    if (!Array.isArray(s.pointsSent)) s.pointsSent = [];
    // 最近成功的上传耗时，用来给排队的人估时间（中位数，最多留 20 条）
    if (!Array.isArray(s.durations)) s.durations = [];
    // 每个上传名最近一次成功上传的大小与时间：同名同大小再投一次 = 重复投递，不再传
    if (!s.recentUploads || typeof s.recentUploads !== 'object') s.recentUploads = {};
    return s;
  } catch (e) {
    return { handled: [], healthSent: [], pointsSent: [], durations: [], recentUploads: {} };
  }
}

function saveState() {
  try {
    writeJson(cfg.STATE_FILE, state);
  } catch (e) {
    log('⚠️ 状态写盘失败：' + (e && e.message));
  }
}

const state = loadState();

// /tbpz 防重入：同一时刻只跑一轮同步
let tbpzRunning = false;
let tbpzJob = null;

// 只发 /tbpz 时回这段：先把用法说清楚，不猜用户要跑哪一路
const TBPZ_USAGE = [
  '/tbpz 要说清跑哪一路，我不猜：',
  '',
  '粗剪批注（主用）',
  '· /tbpz 粗剪 —— 增量同步：读上次之后更新 + 刚被批注的视频，写进粗剪批注表',
  '· /tbpz 粗剪 预览 —— 只读不写，先看会写什么',
  '· /tbpz 粗剪 全量 —— 不看水位，滚完整张列表再同步（久，几分钟到十几分钟）',
  '· /tbpz 粗剪 全量预览 —— 全量 + 只读',
  '· /tbpz 粗剪 配置 —— 看当前分秒帧链接和写入的表格',
  '',
  '精剪批注',
  '· /tbpz 精剪 / /tbpz 精剪 增量 —— 增量同步到精剪备份表（无水位时从最近24小时开始，历史补齐用全量）',
  '· /tbpz 精剪 预览 / 全量 / 全量预览 / 配置',
  '· /tbpz 精剪 写入 —— 使用最近一次精剪预览缓存写表，不重新采集',
  '· /tbpz 精剪 中断 / /tbpz 中断 —— 停止同步并保留缓存；全量上限 120 分钟，增量上限 60 分钟',
  '',
  '改同步目标',
  '· /tbpz 粗剪 分秒帧 <项目链接>',
  '· /tbpz 粗剪 表格 <表格链接>（链接要带 ?table=）',
  '',
  '一轮要好几分钟，跑完回结果；同一时间只能跑一路。',
].join('\n');

// 心跳统计
let eventCount = 0;
let lastEventAt = 0;

// 最近一次上传（整点体检要报）
let lastUpload = null;

const healthMeta = () => ({ lastEventAt, lastUpload });

// 卡片上点「通知小熊重启机器人」/「重启机器人」：
// 前者谁都能点（把现场情况报给小熊，给他一张带重启按钮的卡）；后者只有小熊能点。
const RESTART_FLAG = path.join(cfg.ROOT, '.restart-feedback.json');

function readRestartFlag() {
  try {
    return JSON.parse(fs.readFileSync(RESTART_FLAG, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeRestartFlag(obj) {
  try {
    writeJson(RESTART_FLAG, obj);
    return true;
  } catch (e) {
    log('写重启标记失败：' + ((e && e.message) || e));
    return false;
  }
}

/** 同事点「通知小熊重启机器人」：给小熊发一张带重启按钮的现场卡 */
function requestOwnerFix({ operator, chatId }) {
  const flag = readRestartFlag() || {};
  writeRestartFlag({
    ...flag,
    reporter: { openId: operator, chatId: chatId || '' },
    reportedAt: Date.now(),
    at: Date.now(),
  });

  health.buildOwnerFixCard({ reporterOpenId: operator, reporterChatId: chatId })
    .then((card) => sendCardTo(OWNER_OPEN_ID, card))
    .then((sent) => {
      log(`已把「通知重启」卡片发给小熊（${sent ? '成功' : '失败'}），反馈人 ${operator || '?'}`);
    })
    .catch((e) => log('通知小熊失败：' + ((e && e.message) || e)));

  return {
    toast: {
      type: 'success',
      content: '已通知小熊，他会去重启；重启后我会再来告诉你（注意：正在传的文件会中断，重启完要重新传）',
    },
  };
}

/** 小熊点「重启机器人」 */
function requestRestart({ operator, chatId, openId }) {
  if (!OWNER_OPEN_ID || operator !== OWNER_OPEN_ID) {
    return { toast: { type: 'error', content: '只有陈俊杰能重启机器人' } };
  }
  log(`收到重启指令（来自 ${operator || '?'}）`);
  const flag = readRestartFlag() || {};
  writeRestartFlag({ ...flag, owner: { openId: openId || OWNER_OPEN_ID, chatId: chatId || '' }, at: Date.now() });

  // 必须脱离本进程：stop.sh 会把当前 node 杀掉，这个脚本要活下来把新的拉起
  try {
    const child = spawn('/bin/bash', ['-c',
      `sleep 3; cd "${cfg.ROOT}" && ./stop.sh >/dev/null 2>&1; sleep 3; ./start.sh >> logs/restart.log 2>&1`],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, BSK_AUTO_START: '0', NO_PROXY: '*', no_proxy: '*' },
      });
    child.unref();
  } catch (e) {
    log('重启指令没起起来：' + ((e && e.message) || e));
    return { toast: { type: 'error', content: '重启失败：' + ((e && e.message) || e) } };
  }
  return { toast: { type: 'success', content: '正在重启，起来后我把体检结果发给你' } };
}

/** 启动后：上一轮是用户让重启的 → 给小熊发体检结果，给反馈人发「可以继续了」 */
function checkRestartFeedback() {
  const info = readRestartFlag();
  if (!info) return;
  try { fs.unlinkSync(RESTART_FLAG); } catch (e) { /* 删不掉就算了 */ }
  if (Date.now() - (info.at || 0) > 10 * 60 * 1000) return;

  // 等第一轮巡检跑完再体检，卡上才有真实数据
  setTimeout(async () => {
    try {
      // 1) 给小熊：重启后的体检结果
      const { ok, card } = await health.buildCard(healthMeta(), '重启后');
      const ownerChat = (info.owner && info.owner.chatId) || '';
      const ownerOpen = (info.owner && info.owner.openId) || OWNER_OPEN_ID;
      let sent = false;
      if (ownerChat) sent = await sendInteractive(ownerChat, card);
      if (!sent && ownerOpen) sent = await sendCardTo(ownerOpen, card);
      log(`重启反馈（小熊）${sent ? '已发' : '没发出去'}：${ok ? '全部正常' : '仍有失败项'}`);

      // 2) 给反馈人：可以接着干活了
      const rep = info.reporter || {};
      if (rep.openId || rep.chatId) {
        const txt = [
          `✅ 机器人已重启（pid ${process.pid}），刚才的问题处理完了。`,
          '',
          '可以继续你的上传 / 任务了。如果刚才有文件正在传，那次被中断了，需要重新发一次。',
        ].join('\n');
        let rSent = false;
        if (rep.chatId) rSent = await sendText(rep.chatId, txt);
        if (!rSent && rep.openId) rSent = await sendTextTo(rep.openId, txt);
        log(`重启通知（反馈人 ${rep.openId || rep.chatId}）${rSent ? '已发' : '没发出去'}`);
      }
    } catch (e) {
      log('重启反馈失败：' + ((e && e.message) || e));
    }
  }, 25000);
}

/** 整点体检：工作日每小时一次，发卡给陈俊杰本人 */
function startHealthScheduler() {
  const H = cfg.HEALTH || {};
  if (H.enabled === false) {
    log('整点体检：未开启');
    return;
  }
  const from = Number.isInteger(H.from) ? H.from : 10;
  const to = Number.isInteger(H.to) ? H.to : 19;
  log(`整点体检：工作日 ${from}:00-${to}:00 每个整点发一次体检卡`);
  setInterval(async () => {
    try {
      const now = new Date();
      if (!H.force && now.getMinutes() >= 10) return; // 只在整点那十分钟里触发
      const h = now.getHours();
      if (h < from || h > to) return;
      const key = `${now.toLocaleDateString('sv-SE')}-${h}`;
      if (state.healthSent.includes(key)) return;
      const wd = await workday.checkWorkday(now);
      if (!wd.work) return;
      state.healthSent.push(key);
      if (state.healthSent.length > 60) state.healthSent = state.healthSent.slice(-60);
      saveState();
      await health.report(healthMeta());
    } catch (e) {
      log('整点体检失败：' + ((e && e.message) || e));
    }
  }, 60000).unref();
}

// ---------------------------------------------------------------- 待处理

/** chatId → [att, ...] 收到但还没接到命令的视频 */
const pendingVideos = new Map();
/** chatId → { name, expiresAt } 命令先到，等视频 */
const pendingCommands = new Map();

const MAX_PENDING_VIDEOS = 20;

// 同一个群里的文件和等待命令按发送人隔离，避免给另一个人的视频改名。
function pendingKey(chatId, chatType, senderId) {
  return chatType === 'group' ? `${chatId}:${senderId || 'unknown'}` : chatId;
}

function pushVideo(att) {
  const key = pendingKey(att.chatId, att.chatType, att.senderId);
  const list = pendingVideos.get(key) || [];
  list.push(att);
  while (list.length > MAX_PENDING_VIDEOS) list.shift();
  pendingVideos.set(key, list);
}

/** 失败的视频放回队首（网络抖动时用户重发 /upmedia 就能重试，不用重传文件） */
function unshiftVideo(att) {
  if (!att || !att.chatId) return;
  const key = pendingKey(att.chatId, att.chatType, att.senderId);
  const list = pendingVideos.get(key) || [];
  list.unshift(att);
  while (list.length > MAX_PENDING_VIDEOS) list.pop();
  pendingVideos.set(key, list);
}

function takeVideo(key) {
  const list = pendingVideos.get(key) || [];
  const att = list.shift() || null;
  if (list.length) pendingVideos.set(key, list);
  else pendingVideos.delete(key);
  return att;
}

/** 用户输入的名字 → 分秒帧里的文件名（补扩展名、去非法字符、去「-改」这类版本后缀） */
function targetFileName(input, originalName) {
  const originalExt = (path.extname(originalName) || '.mp4').toLowerCase();
  // 和云盘那条路保持一致：/upmedia 93-改 也按 93 传，不然分秒帧会把条目名改成 93-改
  let base = epname.stripRev(safeName(String(input || '').trim()));
  if (!base) return '';
  if (!path.extname(base)) base += originalExt;
  return base;
}

// ---------------------------------------------------------------- 串行队列

const queue = [];
let busy = false;
let currentJob = null;
/** 正在跑上传的 worker 子进程（detached，退出时要手动收掉，否则会一直传下去） */
let currentWorker = null;
let lastOwnerId = ''; // 上一条是谁的，用来轮流（一个人连投五个，不能把别人全堵在后面）

/**
 * 取下一个任务：按先来后到，但如果队首和刚传完的是同一个人、
 * 后面还排着别人的，就先让别人的上（一轮一轮轮着来，不让人饿死）。
 */
function takeNext() {
  if (!queue.length) return null;
  const i = queueorder.pickIndex(queue, lastOwnerId);
  if (i > 0) {
    const [job] = queue.splice(i, 1);
    log(`队列让位：${job.outName} 先上（前面几条都是同一个人的，别人还在等）`);
    return job;
  }
  return queue.shift();
}

// ---------------------------------------------------------------- 排队时间估算
// 多人同时传的时候，排在后面的人不知道自己还要等多久。
// 用最近成功上传的耗时取中位数（下载 + 上传整条链路），乘前面还有几个任务。
const DEFAULT_JOB_SECONDS = 180;

function jobSeconds() {
  const ds = (state.durations || []).filter((n) => n > 5000 && n < 4 * 3600 * 1000).sort((a, b) => a - b);
  if (!ds.length) return DEFAULT_JOB_SECONDS;
  return Math.max(30, Math.round(ds[Math.floor(ds.length / 2)] / 1000));
}

function etaText(ahead) {
  const sec = jobSeconds() * Math.max(1, ahead);
  if (sec < 90) return '1 分钟内';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟后`;
  return `${(min / 60).toFixed(1)} 小时后`;
}

// ---------------------------------------------------------------- 下载用的临时目录
// 实现在 src/tempfile.js：每次一个 .t-xxx 子目录、文件名保持目标名，
// 避免两个人同一集同时下载写同一个文件（2026-10-29 修）。
function taskTempPath(outName, tag) {
  return tempfile.taskPath(cfg.DOWNLOAD_DIR, outName, tag);
}

function cleanupTemp(p) {
  tempfile.cleanup(p, cfg.DOWNLOAD_DIR);
}

// ---------------------------------------------------------------- 队列落盘
// 进程被重启（./stop.sh、机器重启、点重启按钮）会把内存里的队列清空，
// 一次下到 40 MB 的 56 MB 大文件就白下了（2026-10-28 连踩三次）。
// 所以把「飞书消息里来的」任务写进 .queue.json，起来后自动接着传。
const QUEUE_FILE = path.join(cfg.ROOT, '.queue.json');

function serializable(job) {
  return !!(job && job.att && job.att.messageId);
}

function saveQueue() {
  try {
    const list = [currentJob].concat(queue)
      .filter(serializable)
      .map((j) => ({
        att: j.att, outName: j.outName, uploadTarget: j.uploadTarget, projectKey: j.projectKey || '', cmdName: j.cmdName || '',
        sourceName: j.sourceName || '', by: j.by || null, notifyOpenId: j.notifyOpenId || '', queuedAt: j.queuedAt || Date.now(),
        localPath:j.localPath, inboxItem:j.inboxItem, driveSourceToken:j.driveSourceToken,
        confirmationRetry:!!j.confirmationRetry, started: !!j.started, taskBinding:j.taskBinding, confirmationId:j.confirmationId,
      }));
    writeJson(QUEUE_FILE, list);
  } catch (e) {
    log('⚠️ 队列写盘失败：' + ((e && e.message) || e));
  }
}

/**
 * 启动时清 downloads/ 里 3 天前的残留。
 * 传成功现在会自动删；失败/被重启打断的会留下来，攒久了占几个 G。
 */
function cleanOldDownloads() {
  if (currentJob || queue.length || pendingUploads.list().length) return; // 核对前保留上传源文件。
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  let n = 0;
  let bytes = 0;
  let names = [];
  // 任务目录里的文件算个大概体积，够看就行
  const dirBytes = (d) => {
    let sum = 0;
    try {
      for (const f of fs.readdirSync(d)) {
        try { sum += fs.statSync(path.join(d, f)).size; } catch (e) { /* 跳过 */ }
      }
    } catch (e) { /* 跳过 */ }
    return sum;
  };
  try {
    for (const f of fs.readdirSync(cfg.DOWNLOAD_DIR)) {
      const p = path.join(cfg.DOWNLOAD_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) continue;
        // 每次下载建的 .t-xxx 任务目录（被重启打断的、传失败的会留在这儿）
        if (st.isDirectory()) {
          if (!tempfile.isTaskDir(f)) continue;
          bytes += dirBytes(p);
          fs.rmSync(p, { recursive: true, force: true });
          n++;
          names.push(f + '/');
          continue;
        }
        if (!st.isFile()) continue;
        if (currentJob && currentJob.outName === f) continue; // 正在用的别动
        bytes += st.size;
        fs.unlinkSync(p);
        n++;
        names.push(f);
      } catch (e) { /* 单个失败跳过 */ }
    }
  } catch (e) {
    return;
  }
  if (n) log(`启动清理：删掉 ${n} 个 3 天前的临时文件（${(bytes / 1024 / 1024).toFixed(0)} MB）：${names.slice(0, 5).join('、')}${n > 5 ? ' 等' : ''}`);
}

function restoreQueue() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch (e) {
    return;
  }
  try { fs.unlinkSync(QUEUE_FILE); } catch (e) { /* 忽略 */ }
  if (!Array.isArray(list) || !list.length) return;
  // 超过 12 小时的不接（怕把昨天的老任务翻出来重传）
  const alive = list.filter((j) => j && j.att && j.outName && Date.now() - (j.queuedAt || 0) < 12 * 3600 * 1000);
  const stale = list.length - alive.length;
  if (stale > 0) log(`丢掉 ${stale} 个超过 12 小时的旧任务`);

  // 2026-11-10：已经开始传的（动过浏览器）不自动重传。
  // 那种重启大多发生在「文件其实已经传上去、只差收尾校验」的时刻，重传会把同一个文件顶成 v2 版本，
  // 而分秒帧的版本得手动删。宁可让人看一眼，也不要错传一版。
  const fresh = alive.filter((j) => !j.started && (!j.localPath || fs.existsSync(j.localPath)));
  const interrupted = alive.filter((j) => j.started);
  if (interrupted.length) {
    log(`不自动重传 ${interrupted.length} 个重启时正在传的任务：${interrupted.map((j) => j.outName).join('、')}`);
    interrupted.forEach((j) => {
      if (!j.confirmationId) pendingUploads.begin(j);
      pendingUploads.set(j.confirmationId, 'pending', '上传期间重启，需核对平台');
      const chatId = j.att && j.att.chatId;
      const text = `⏸ 传「${j.outName}」传到我重启了。它可能已经传上去了，也可能只传了一半——`
        + '已进入管理台待确认队列。请核对分秒帧后，在管理台选择已上传或确认未上传再重试。';
      const p = chatId ? sendText(chatId, text) : (j.notifyOpenId ? sendTextTo(j.notifyOpenId, text) : Promise.resolve(log(text)));
      Promise.resolve(p).catch((e) => log('「正在传」提示发不出去：' + ((e && e.message) || e)));
    });
  }
  if (!fresh.length) return;
  log(`恢复 ${fresh.length} 个重启前还没开始传的任务：${fresh.map((j) => j.outName).join('、')}`);
  fresh.forEach((j) => enqueue({ ...j, restored: true }));
}

/**
 * 当前上传回写的制作项目（config.json 每次现读，改完下一条视频生效，不用重启）。
 * 2026-11-03：《逆天萌兽2》归档，上传默认回写《逆天萌兽3》的多维表格。
 * 上传目录使用当前 config.projectUrl，并按项目绑定校验。
 * 临时回退：把 config.json 的 uploadProject 改成 "legacy" 或删掉这一行。
 */
function defaultUploadProject() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config.json'), 'utf8'));
    return c.uploadProject === 'nts3' ? 'nts3' : '';
  } catch (e) {
    log('默认上传项目读取失败，按 legacy 处理：' + (e && e.message));
    return '';
  }
}

/**
 * 上传总开关：config.json → upload.enabled（每次现读，改完不用重启）。
 * 2026-11-09 小熊要求「暂时停用上传粗剪到分秒帧的功能」。
 * 只有显式写成 false 才停；没配 / 写 true 都按正常跑，老配置不受影响。
 * 想恢复：把 upload.enabled 改回 true（或删掉整个 upload 段）。
 */
function uploadEnabled() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config.json'), 'utf8'));
    return !(c.upload && c.upload.enabled === false);
  } catch (e) {
    log('上传开关读取失败，暂停接收上传：' + (e && e.message));
    return false;
  }
}

/** 上传暂停时统一回的话 —— 别让人以为文件丢了 */
const UPLOAD_PAUSED_TEXT = '⏸ 上传分秒帧的功能已暂停，这次没传。\n文件还在（云盘/聊天记录里都在），等重新打开说一声，重发一次就行。';

/** 投递箱暂停提示的日志节流（10 秒扫一次，不能每轮都写一行） */
let lastInboxPauseLog = 0;

/**
 * 测试模式：config.json → upload.testMode（每次现读）。
 * 打开后文件名不匹配「集数-场次」也照传，只上传、不回写表格、不发一审卡 ——
 * 只用于验证上传链路（bsk/Chrome 登录态）通不通。日常必须关掉，
 * 否则谁传错名字都不会被拦住。
 */
function uploadTestMode() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config.json'), 'utf8'));
    return !!(c.upload && c.upload.testMode);
  } catch (e) {
    return false;
  }
}

function enqueue(job) {
  if (!job.onDone && job.driveSourceToken) job.onDone = ok => drivefolder.finish(job.driveSourceToken, job.localPath, ok);
  job.outName = safeName(job.outName);
  // 兜底：不管从哪个口进来（命令 / 云盘链接 / 投递箱 / 重启恢复），暂停就一条都不传
  if (!uploadEnabled()) {
    log(`上传已暂停，跳过 ${job.outName || (job.att && job.att.fileName) || '(未命名)'}`);
    Promise.resolve(reply(job, UPLOAD_PAUSED_TEXT)).catch((e) => log('暂停提示发不出去：' + ((e && e.message) || e)));
    if (job.inboxItem && inbox.clearBusy) inbox.clearBusy(job.inboxItem);
    if (job.onDone && !job.confirmationRetry) { try { job.onDone(false); } catch (e) { /* 忽略 */ } }
    return false;
  }
  if (!job.projectKey) job.projectKey = defaultUploadProject();
  if (!job.uploadTarget) job.uploadTarget = target.getTarget();
  if (!job.confirmationRetry && pendingUploads.blocks(job)) { log('上传源正在等待人工确认，禁止重复提交：' + job.outName); return false; }
  // 同一条源文件重复投（连着发三次 /upmedia 73 + 两次文件）→ 别再排一遍。
  // 2026-10-28 踩到：三份 56 MB 下载互相打断，一个都没传成。
  // 但「122-改1 / 122-改2 都按 122 传」是两个不同文件，得按顺序都传 —— 所以按来源比，
  // 不能只看 outName（归一化之后它们都叫 122.mov）。
  if (!job.retried) {
    const srcKey = (j) => (j && j.att && j.att.messageId) || '';
    const dup = [currentJob].concat(queue).find((j) =>
      j && j !== job && uploadKey(j.outName, j.uploadTarget, j.projectKey) === uploadKey(job.outName, job.uploadTarget, job.projectKey) &&
      srcKey(j) && srcKey(j) === srcKey(job));
    if (dup) {
      const where = dup === currentJob ? '正在传' : '已经在排队';
      log(`跳过重复入队 ${job.outName}：${where}`);
      reply(job, `「${job.outName}」${where}，这次不用重复发；传完我直接回结果。`);
      if (job.inboxItem && inbox.clearBusy) inbox.clearBusy(job.inboxItem);
      if (job.onDone) job.onDone(false);
      return false;
    }
  }
  // 前面还有几个要等：正在传的那一个 + 队列里排着的
  if (!job.queuedAt) job.queuedAt = Date.now();
  const ahead = queue.length + (busy ? 1 : 0);
  queue.push(job);
  log(`入队 ${job.att.fileName} → ${job.outName}（队列 ${queue.length} 条${ahead ? `，前面 ${ahead} 个` : ''}）`);
  saveQueue();
  pump();

  // 要让排队的人知道自己在等什么：回执里直接给排位和预计时间，不用再问
  if (ahead > 0 && !job.restored && !job.retried) {
    Promise.resolve(reply(job, `⏳ 已排队：前面还有 ${ahead} 个文件，预计 ${etaText(ahead)}轮到你。到我就开始传，不用重发。`))
      .catch((e) => log('排队提示发不出去：' + ((e && e.message) || e)));
  }
  return true;
}

/** 回执：飞书消息回原会话；投递箱的按 open_id 发给小熊 */
async function reply(job, text) {
  if (job.att && job.att.chatId) return sendText(job.att.chatId, text);
  if (job.notifyOpenId) return sendTextTo(job.notifyOpenId, text);
  log(text);
  return false;
}

/**
 * 同项目同目录、同名、同内容且时间很近时，按重复投递处理。
 * 2026-11-10 踩坑：95.mp4 在 17:17 已经传成功（列表 4→5），17:21 又收到一次完整的
 * 「/upmedia 95 + 同一份 78.41 MB 视频」，机器人照传，第二次走「上传版本」把 v1 顶成 v2。
 * 用 SHA-256 核对文件内容，避免把大小相同的新版本误拦。
 * 想强制重传：文件名带「改」（95-改.mp4，同事本来就习惯这么写）或等窗口过期。
 */
const DUP_WINDOW_MIN = Math.max(0, Number(cfg.UPLOAD?.dupWindowMinutes ?? 30));

function uploadKey(outName, uploadTarget, projectKey) {
  return JSON.stringify([projectKey || '', uploadTarget?.projectId || '', uploadTarget?.folderId || '', outName]);
}

function dupUpload(outName, size, srcName, uploadTarget, projectKey, sha256) {
  if (!DUP_WINDOW_MIN || !size) return null;
  const prev = (state.recentUploads || {})[uploadKey(outName, uploadTarget, projectKey)];
  if (!prev || !prev.size || !sha256 || prev.sha256 !== sha256) return null;
  const age = Date.now() - (prev.at || 0);
  if (age < 0 || age > DUP_WINDOW_MIN * 60 * 1000) return null;
  if (prev.size !== size) return null;
  if (epname.isRev(srcName)) return null; // 明说是改版，放行
  return { prev, age };
}

async function pump() {
  if (busy) return;
  const job = takeNext();
  if (!job) return;
  busy = true;
  currentJob = job;
  // 标记「已经开始动浏览器了」，并立刻落盘。
  // 2026-11-10 踩坑：正在传的时候重启，重启后队列把这个任务当「没传完」重传了一遍，
  // 而分秒帧那边上一次其实已经落库，于是干净的文件被顶成 v2。开始过的任务重启后一律不自动重传。
  job.started = true;
  saveQueue();
  const startedAt = Date.now();
  const waited = job.queuedAt ? Math.round((startedAt - job.queuedAt) / 1000) : 0;
  if (waited > 10) log(`${job.outName} 排队 ${waited} 秒后开始`);
  try {
    await runJob(job);
    if (!job.skipped) feedbackToOwner(job, job.uploadOk !== false, job.resultText);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (job.confirmationId && pendingUploads.list().some(r=>r.id===job.confirmationId && r.status==='verified')) job.uploadUnknown=true;
    const netDown = /下载失败/.test(msg) &&
      /connect failed|ECONNREFUSED|ETIMEDOUT|socket hang up|ECONNRESET|getaddrinfo/i.test(msg);
    // 飞书消息下载遇到网络抖动：自动重试一次（文件不用重传）
    if (netDown && job.att && job.att.messageId && !job.retried) {
      log(`${job.outName} 下载赶上断网，45 秒后自动重试`);
      await reply(job, `⚠️ ${job.outName} 下载时赶上断网（${msg.replace('下载失败：', '')}）。45 秒后我自动重试，不用重发文件。`);
      setTimeout(() => {
        enqueue({ ...job, retried: true });
      }, 45000);
    } else if (job.uploadUnknown) {
      const text = `⚠️ ${job.outName} 上传结果待确认：${msg}。已挂起，请在管理台核对后处理。`;
      if(job.inboxItem) inbox.clearBusy(job.inboxItem);
      await reply(job,text); feedbackToOwner(job,false,text);
    } else {
      log(`处理失败 ${job.outName}：${msg}`);
      try { require('./admin-runtime').failed(job, msg); } catch (e) { log('失败记录保存失败：' + e.message); }
      let text = `❌ ${job.outName} 处理失败：${msg || '未知错误'}`;
      if (e && e.scopeUrl) text += `\n\n缺权限，点这个开：\n${e.scopeUrl}`;
      // 网络原因且视频还在飞书服务器上：放回待传，重发 /upmedia 即可，不用重传 89MB 的文件
      if (netDown && job.att && job.att.messageId) {
        unshiftVideo(job.att);
        if (job.cmdName && job.att.chatId) {
          pendingCommands.set(pendingKey(job.att.chatId, job.att.chatType, job.att.senderId), { name: job.cmdName, projectKey: job.projectKey, uploadTarget: job.uploadTarget, by: job.by || null, expiresAt: Date.now() + WAIT_SECONDS * 1000 });
        }
        text += '\n\n这条视频我还留着，直接重发一次 /upmedia 就会重试（文件不用重传）。';
      }
      await reply(job, text);
      feedbackToOwner(job, false, text);
      if (job.inboxItem) {
        inbox.markFailed(job.inboxItem);
        inbox.clearBusy(job.inboxItem);
      }
      if (job.onDone) await job.onDone(false);
    }
  } finally {
    // 只有成功的才计入「一个文件大概多久」：失败、超时不代表正常速度
    if (job.uploadOk) {
      state.durations.push(Date.now() - startedAt);
      if (state.durations.length > 20) state.durations = state.durations.slice(-20);
      saveState();
    }
    // 收尾一定放 finally：catch 里回消息/写表再出错也不能把队列锁死
    lastOwnerId = (job.by && job.by.openId) || '';
    busy = false;
    currentJob = null;
    saveQueue();
    if (queue.length) setImmediate(pump);
  }
}

// 单个文件的上传上限：卡死时不能把整条队列一起拖住。
// 正常 500 MB 以内几分钟就完；真卡住（bsk 掉线、页面挂了）45 分钟也够判死刑了。
const UPLOAD_TIMEOUT_MS = Math.max(5, Number(process.env.UPLOAD_TIMEOUT_MIN || 45)) * 60 * 1000;

/** 收掉当前上传子进程（连它开的那组 bsk 一起），退出/重启时必须调用 */
function killWorkerGroup(sig = 'SIGKILL') {
  const pid = currentWorker && currentWorker.pid;
  if (!pid) return;
  // detached 起的是独立进程组，用负数 pid 杀整组，bsk 子进程才不会挂在那儿占着浏览器
  try { process.kill(-pid, sig); } catch (e) { /* 已经退了 */ }
  try { process.kill(pid, sig); } catch (e) { /* 已经退了 */ }
  log(`已收掉上传子进程（组 ${pid}）`);
  currentWorker = null;
}

/**
 * 启动时清掉上一次进程遗留的 worker。
 * worker 是 detached 起的，父进程被 kill 时它不会跟着死，会接着在浏览器里传——
 * 新进程又从队列里恢复同一个任务，于是两个窗口同时往同一个条目传，直接顶成 v2（2026-11-10 踩到）。
 */
function killOrphanWorkers() {
  const marker = path.join(__dirname, 'worker.js');
  let pids = [];
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }) || '';
    pids = out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
      .filter((n) => n && n !== process.pid);
  } catch (e) {
    return; // pgrep 没找到时退出码 1，正常
  }
  if (!pids.length) return;
  pids.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已经退了 */ } });
  log(`清掉上次遗留的 ${pids.length} 个上传子进程：${pids.join('、')}`);
}

/** 起子进程跑上传，从 stdout 里捞最后一行 RESULT_JSON */
function runWorker(filePath, uploadTarget) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), filePath], {
      env: childEnv({ BSK_AUTO_START: '0', ...(uploadTarget ? { UPLOAD_TARGET_URL: uploadTarget.projectUrl } : {}) }),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：超时时能连 worker 里 execFileSync 起的 bsk 子进程一起收掉，
      // 不然 worker 死了、bsk 还挂在浏览器上占着会话
      detached: true,
    });
    // 记下当前 worker：主进程收到退出信号时得把它一起收掉。
    // detached 的进程不会跟着父进程死，2026-11-10 就是这样出现「重启后两个窗口同时传同一个文件」。
    currentWorker = child;
    child.on('close', () => { if (currentWorker === child) currentWorker = null; });

    let out = '';
    let timedOut = false;
    const mins = Math.round(UPLOAD_TIMEOUT_MS / 60000);

    const timer = setTimeout(() => {
      timedOut = true;
      log(`⚠️ 上传超时（${mins} 分钟），中断 ${path.basename(filePath)}，接着传下一个`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* 已经退了 */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 已经退了 */ }
      }, 10 * 1000).unref();
    }, UPLOAD_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
      process.stderr.write(d);
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`上传超时（超过 ${mins} 分钟没传完），已中断。文件还在，重发 /upmedia 可以再试`));
        return;
      }
      const m = out.match(/RESULT_JSON:(\{[\s\S]*\})\s*$/);
      if (m) {
        try {
          resolve(JSON.parse(m[1]));
          return;
        } catch (e) {
          /* 落到下面报错 */
        }
      }
      reject(new Error(`上传进程异常退出（code ${code}）`));
    });
  });
}

async function runJob(job) {
  const { att, outName } = job;
  const PC = require('./project-context');
  const taskIdentity = require('./task-identity');
  const project = PC.projectForTarget(job.uploadTarget.projectUrl, job.projectKey);
  const taskId = taskIdentity.parse(outName);
  const candidates = (await flow.fetchAllRecords()).filter(r => r.projectKey === project.key);
  const taskRecord = taskId && project.uploadKind !== 'fine' ? taskIdentity.select(candidates, taskId) : null;
  const testMode = !!(job.testMode || uploadTestMode());
  if (project.sceneMode && project.uploadKind !== 'fine' && !taskRecord) {
    if (!testMode) throw new Error('场次项目必须使用明确的集数-场次文件名');
    log(`测试模式：${outName} 没匹配到集数-场次任务，只上传、不回写表格`);
  }
  job.taskBinding = taskRecord ? { recordId: taskRecord.recordId, projectKey: project.key,
    signature: JSON.stringify([taskRecord.episode, taskRecord.scene, taskRecord.stage, taskRecord.review, taskRecord.trimStage]), label: taskIdentity.display(taskRecord) } : null;
  // 落盘就用目标名（worker 按磁盘文件名认分秒帧条目），但目录每次独立，
  // 免得两个人同一集同时下载时写同一个文件
  let destPath = job.localPath || taskTempPath(outName, att.messageId || att.driveToken);
  let localCopy = false;
  if (job.localPath && path.basename(job.localPath) !== outName) {
    destPath = taskTempPath(outName, att.messageId);
    fs.mkdirSync(path.dirname(destPath), {recursive:true});
    await fs.promises.copyFile(job.localPath, destPath);
    localCopy = true;
  }
  if (att.driveToken) {
    await drive.download(att.driveToken, destPath);
  } else if (!job.localPath) {
    // 飞书这条链路下载可能很慢（10 MB/分钟级），必须报进度，不然看着像卡死
    await downloadResource(att, destPath, (mb, total) => {
      const chatId = job.chatId || att.chatId;
      if (!chatId) return;
      if (mb < 0) {
        sendText(chatId, `下载卡住了（${att.fileName}），已 2 分钟没增长，我还在等，不行就重发 /upmedia`);
        return;
      }
      const pct = total ? `/${(total).toFixed(0)} MB（${Math.floor((mb / total) * 100)}%）` : '';
      sendText(chatId, `下载中：${mb.toFixed(0)} MB${pct}`);
    });
  }

  // 同名同大小、短时间内已经传过 → 认成重复投递，不传第二遍（否则会把版本顶成 v2）
  let fileSize = 0;
  try { fileSize = fs.statSync(destPath).size; } catch (e) { /* 拿不到就跳过这道检查 */ }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(destPath)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const dupHit = job.retried ? null : dupUpload(outName, fileSize, job.cmdName || job.sourceName || (att && att.fileName), job.uploadTarget, job.projectKey, sha256);
  if (dupHit) {
    const when = new Date(dupHit.prev.at).toLocaleTimeString('zh-CN', { hour12: false });
    const mb = (fileSize / 1024 / 1024).toFixed(2);
    const text = `⏭ ${outName} 这次没传：${when} 刚传过一份，文件大小完全一样（${mb} MB），我按重复处理，免得把版本顶成 v2。\n`
      + `确实是新版本：文件名加个「改」再发（例：${path.basename(outName, path.extname(outName))}-改${path.extname(outName)}），或等 ${DUP_WINDOW_MIN} 分钟后再发。`;
    log(`跳过重复上传 ${outName}：${when} 已传过同样大小（${mb} MB）`);
    job.skipped = true;
    job.uploadOk = false;
    job.resultText = text;
    if (!job.localPath || localCopy) cleanupTemp(destPath);
    await reply(job, text);
    if (job.inboxItem) {
      inbox.markDone(job.inboxItem); // 同一份文件已经传过了，别留在箱里反复扫
      inbox.clearBusy(job.inboxItem);
    }
    if (job.onDone) await job.onDone(true);
    return;
  }

  log(`开始上传 ${att.fileName} → ${outName}`);
  pendingUploads.begin(job, destPath); // 必须先持久化，再动浏览器。
  saveQueue();
  let res;
  try { res = await runWorker(destPath, job.uploadTarget); }
  catch (e) { job.uploadUnknown=true; pendingUploads.set(job.confirmationId, 'pending', e.message); throw e; }
  job.uploadUnknown = !res.ok && (!res.error || res.unknown === true);
  if (!res.ok && !job.uploadUnknown) require('./admin-runtime').failed(job, res.error || '上传失败');
  pendingUploads.set(job.confirmationId, job.uploadUnknown ? 'pending' : res.ok ? 'verified' : 'failed', res.error || res.url);
  lastUpload = { at: Date.now(), file: outName, ok: !!res.ok, unknown: job.uploadUnknown };

  // 传成功就记下「这个名、这个大小、几点传的」，下次同名同大小直接跳过
  if (res.ok && fileSize) {
    if (!state.recentUploads) state.recentUploads = {};
    state.recentUploads[uploadKey(outName, job.uploadTarget, job.projectKey)] = { size: fileSize, sha256, at: Date.now(), version: res.version || '', mode: res.mode || '' };
    const names = Object.keys(state.recentUploads);
    if (names.length > 60) {
      names.sort((a, b) => (state.recentUploads[a].at || 0) - (state.recentUploads[b].at || 0))
        .slice(0, names.length - 40).forEach((n) => delete state.recentUploads[n]);
    }
    saveState();
  }

  let text;
  // 云盘原名和上传名不一样（122-改.mov → 122.mov）时，回执里点一句，省得以为传错了
  const srcName = job.sourceName || (att && att.fileName) || outName;
  const renamedNote = srcName !== outName ? `云盘原名 ${srcName}，按 ${outName} 传的` : '';
  if (res.ok && res.mode === 'version') {
    text = `✅ 已更新分秒帧版本：${res.fileName || outName} 现在是 ${res.version}\n（同名文件走「上传版本」，没有新建重复文件）`;
    if (renamedNote) text += `\n${renamedNote}`;
    text += `\n${res.url}`;
  } else if (res.ok) {
    text = `✅ 已上传分秒帧：${outName}\n列表 ${res.countBefore} → ${res.countAfter} 项\n${res.url}`;
  } else if (job.uploadUnknown) {
    text = `⚠️ ${outName} 上传结果待确认，已进入管理台核对队列；不会自动重传。${res.error || ''}\n${res.url || ''}`;
  } else if (res.error) {
    text = `❌ ${outName} 上传失败：${res.error}`;
  } else if (res.mode === 'version') {
    text = `⚠️ ${outName} 新版本已提交，但未确认版本号增加，请到分秒帧核对\n${res.url}`;
  } else {
    text = `⚠️ ${outName} 已提交，但列表数量没变（${res.countBefore} → ${res.countAfter}），请到分秒帧确认\n${res.url}`;
  }
  if (!job.taskBinding && testMode) text += '\n（测试模式：文件名没匹配「集数-场次」，只传了文件，没回写表格）';
  log(text);
  job.uploadOk = !!res.ok;
  job.resultText = text;

  // 传成功了就把下载下来的临时文件删掉（2026-10-28：以前 /upmedia 传完不删，
  // downloads/ 里越攒越多，今天一次就积了 300 多 MB）。失败留着，方便排查。
  if (res.ok && (!job.localPath || localCopy)) {
    cleanupTemp(destPath);
    log(`已清理临时文件 ${outName}`);
  }
  await reply(job, text);

  if (job.uploadUnknown) {
    if (job.inboxItem) inbox.clearBusy(job.inboxItem);
    return; // 原文件保留；不走 failed 或释放云盘源，管理台核对后处理。
  }
  if (job.inboxItem) {
    if (res.ok) inbox.markDone(job.inboxItem);
    else inbox.markFailed(job.inboxItem);
    inbox.clearBusy(job.inboxItem);
  }
  if (job.onDone) await job.onDone(res.ok);

  // 上传成功后：文件名带集数的，把该集素材生成进展记为已粗剪待一审（制作师 /upmedia、/driveup 都走这里）
  if (res.ok) {
    await markEpisodeReady(job.chatId || (job.att && job.att.chatId), outName, job.taskBinding, true);
    pendingUploads.set(job.confirmationId, 'completed', '平台已确认上传，收尾完成');
  }
}

/**
 * 上传成功回写多维表格：按文件名里的集数找记录，素材生成进展 → 已粗剪待一审，并重发一审卡片。
 * 已经在已完成并上传/已定剪的集不回退（那属于重传终稿版本）。
 */
async function markEpisodeReady(chatId, outName, binding, strict = false) {
  try {
    if (!binding) return;
    const rec = await flow.getRecord(binding.recordId);
    const ep = binding.label;
    if (JSON.stringify([rec.episode, rec.scene, rec.stage, rec.review, rec.trimStage]) !== binding.signature) {
      if (strict) throw new Error('任务状态已变化，未覆盖。请先核对任务表');
      if (chatId) sendText(chatId, `视频已上传，但 ${ep} 的表格状态在上传期间发生变化，本次不覆盖，请核对任务。`);
      return;
    }
    if (rec.stage === '已完成并上传' || rec.trimStage === '已定剪') {
      log(`上传回写：${ep} 集已完成并上传/已定剪，不回退状态`);
      return;
    }
    if (rec.stage !== '已粗剪待一审') {
      await flow.updateFields(rec.recordId, { 素材生成进展: '已粗剪待一审', 审阅反馈: '未审阅' });
      rec.stage = '已粗剪待一审';
      rec.review = '未审阅';
      if (chatId) sendText(chatId, `📋 已把 ${ep} 集的「素材生成进展」记为已粗剪待一审。`);
    }
    // 不管状态改没改，都补发/确保一审卡片在（防重复由 flowState 去重）
    const reviewSent = await flow.autoReview(rec, true);
    const delivered = flow.deliveredPeople(rec.reviewers);
    log(`上传回写：${ep} 集已标待一审，一审通知送达 ${delivered.length}/${rec.reviewers.length} 人`);
    // 真发出去了才告诉制作师「审片人已经收到了」（2026-10-28 小熊要求）
    if (delivered.length && chatId) {
      const names = delivered.filter((p) => p && p.id)
        .map((p) => `${p.name || '（未填名字）'}（审片人）`).join('、');
      if (names) sendText(chatId, `📨 已通知到 ${names}。${reviewSent ? '' : '其余人员的送达状态请查看管理台通知台账。'}`);
    }
  } catch (e) {
    if (strict) throw e;
    log('上传回写失败：' + ((e && e.message) || e));
    if (chatId) sendText(chatId, '视频上传后回写失败，请核对任务：' + e.message);
  }
}

// ---------------------------------------------------------------- 事件处理

function chatAllowed(chatType, chatId) {
  if (chatType === 'group') {
    if (!cfg.ALLOW_GROUPS.includes(chatId)) {
      log(`群 ${chatId} 不在白名单，忽略`);
      return false;
    }
    return true;
  }
  if (!cfg.ALLOW_P2P) {
    log('未开启私聊接收，忽略');
    return false;
  }
  return true;
}

/** /base 把 70 集的素材生成进展改成已上传 —— 改表入口 */
function isBaseCommand(text) {
  const p = String(cfg.BASE_COMMAND || '/base').toLowerCase();
  const l = text.toLowerCase();
  return l === p || l.startsWith(p + ' ') || l.startsWith(p + '：') || l.startsWith(p + ':') ||
    text.startsWith('改表');
}

function onBaseCommand(text, msg) {
  const chatId = msg.chat_id;
  const chatType = msg.chat_type || 'p2p';
  if (!chatAllowed(chatType, chatId)) return;

  const cmd = cfg.BASE_COMMAND || '/base';
  const rest = text
    .replace(/^\/base\s*/i, '')
    .replace(/^改表\s*/, '')
    .trim();

  if (!rest) {
    const fields = ((cfg.BASE && cfg.BASE.writableFields) || []).join(' / ');
    sendText(chatId, `用法：${cmd} 把 70 集的素材生成进展改成已上传\n可改字段：${fields}`);
    return;
  }

  require('./project-context').run(/逆天萌兽3|nts3/i.test(rest) ? 'nts3' : 'legacy', () => editField(rest))
    .then((reply) => sendText(chatId, reply))
    .catch(async (e) => {
      log('改表失败：' + (e && e.message));
      const { text: t, scopeUrl } = await describeError(e);
      let out = `❌ 改表失败：${t}`;
      if (scopeUrl) out += `\n\n缺权限，点这个开：\n${scopeUrl}`;
      sendText(chatId, out);
    });
}

/** /upmedia 67 —— 命令入口 */
async function onCommand(cmd, msg, operatorId) {
  const chatId = msg.chat_id;
  const chatType = msg.chat_type || 'p2p';
  const key = pendingKey(chatId, chatType, operatorId);
  if (!chatAllowed(chatType, chatId)) return;

  if (!uploadEnabled()) { sendText(chatId, UPLOAD_PAUSED_TEXT); return; }

  if (!cmd.name) {
    sendText(chatId, `用法：${COMMAND} 名字\n比如 ${COMMAND} 67 —— 会把最新那条视频传成分秒帧里的「67.mp4」。`);
    return;
  }

  // /upmedia 67 <云盘链接> —— 一条消息把文件也带上
  const projectMatch = /^(?:逆天萌兽3|nts3)\s+(.+)$/i.exec(cmd.name);
  if (projectMatch) {
    const p = require('./project-context').projects().find(p => p.key === 'nts3');
    if (!p?.sharedUploadUrl) { sendText(chatId, '第三季共享上传目录尚未配置'); return; }
    cmd = {...cmd, name: projectMatch[1], projectKey: 'nts3', uploadTarget: target.parseTarget(p.sharedUploadUrl)};
  }
  const inlineLink = drive.parseLink(cmd.name);
  if (inlineLink) {
    const clean = cmd.name.replace(inlineLink.url, '').replace(/^[\s:：,，-]+/, '').trim();
    if (!clean) {
      sendText(chatId, `要个名字，比如：${COMMAND} 67 ${inlineLink.url}`);
      return;
    }
    const driveAtt = {
      messageId: `drive-${inlineLink.token}`,
      fileName: `drive-${inlineLink.token.slice(-6)}.mp4`,
      chatId,
      chatType,
      driveToken: inlineLink.token,
    };
    const outName = targetFileName(clean, driveAtt.fileName);
    await sendText(chatId, `好，从云盘拉这个文件，传成「${outName}」，开始。`);
    enqueue({ att: driveAtt, outName, projectKey: cmd.projectKey, uploadTarget: cmd.uploadTarget, by: { openId: operatorId } });
    return;
  }

  const att = takeVideo(key);
  if (att) {
    const outName = targetFileName(cmd.name, att.fileName);
    pendingCommands.delete(key);
    // await 一下：不 await 的话失败回执可能比「开始」先到，看着像没开工就报错了（2026-11-10 踩到）
    await sendText(chatId, `好，把 ${att.fileName} 传成「${outName}」，开始。`);
    enqueue({ att, outName, projectKey: cmd.projectKey, uploadTarget: cmd.uploadTarget, cmdName: cmd.name, by: { openId: operatorId } });
    return;
  }

  // 命令先到：留个坑，等视频
  pendingCommands.set(key, { name: cmd.name, projectKey: cmd.projectKey, uploadTarget: cmd.uploadTarget, by: { openId: operatorId }, expiresAt: Date.now() + WAIT_SECONDS * 1000 });
  sendText(chatId, `好，把视频发到聊天框，我传成「${targetFileName(cmd.name, '.mp4')}」。（${Math.round(WAIT_SECONDS / 60)} 分钟内有效）\n如果文件在云盘收件夹里，改用：/driveup ${cmd.name}`);
}

/** 视频消息入口 */
async function onVideo(att) {
  if (!chatAllowed(att.chatType, att.chatId)) return;

  // 只处理视频扩展名
  const ext = path.extname(att.fileName).toLowerCase();
  if (cfg.ALLOWED_EXT.length && !cfg.ALLOWED_EXT.includes(ext)) {
    log(`不是视频（${att.fileName}），忽略`);
    sendText(att.chatId, `这个我只收视频文件，${att.fileName || '这个附件'} 先跳过了。`);
    return;
  }

  // 命令先到 → 直接开工
  const key = pendingKey(att.chatId, att.chatType, att.senderId);
  const pendingCmd = pendingCommands.get(key);
  if (pendingCmd && pendingCmd.expiresAt > Date.now()) {
    pendingCommands.delete(key);
    const outName = targetFileName(pendingCmd.name, att.fileName);
    await sendText(att.chatId, `收到 ${att.fileName}，传成「${outName}」，开始。`);
    // 操作人要从缓存里带下来：漏了的话回执卡会显示「（本机投递箱）/ 本机未知」（2026-11-10 93.mp4 就是这样）
    enqueue({ att, outName, projectKey: pendingCmd.projectKey, uploadTarget: pendingCmd.uploadTarget, cmdName: pendingCmd.name, by: pendingCmd.by || null });
    return;
  }

  // 否则缓存，等命令
  pushVideo(att);
  if (!uploadEnabled()) {
    sendText(att.chatId, UPLOAD_PAUSED_TEXT);
  } else if (cfg.REPLY_ON_RECEIVE) {
    sendText(att.chatId, `收到 ${att.fileName}。\n要传的话发：${COMMAND} 名字（例：${COMMAND} 67）`);
  }
}

function onMessage(data) {
  const msg = data && data.message;
  const sender = data && data.sender;
  if (!msg) return;
  eventCount++;
  lastEventAt = Date.now();

  // 机器人自己发的消息不用管
  if (sender && sender.sender_type && sender.sender_type !== 'user') return;

  const operatorId = (sender && sender.sender_id && sender.sender_id.open_id) || '';

  if (!chatAllowed(msg.chat_type || 'p2p', msg.chat_id)) return;
  // 所有消息统一去重，命令重投也不会重复改表、下载或上传。
  if (!msg.message_id || state.handled.includes(msg.message_id)) return;
  state.handled.push(msg.message_id);
  if (state.handled.length > 500) state.handled = state.handled.slice(-500);
  saveState();

  const text = textContent(msg);

  // 每条进来的消息都记一行，方便判断「没回」是没收到还是处理出错
  log(`收到消息 [${msg.message_type || msg.msg_type}] ${(text || '').replace(/\s+/g, ' ').slice(0, 40) || '(非文本)'}`);

  // /tbpq —— 独立项目排期同步（显式命令触发，不挂入审阅流程）
  if (text && /^\/tbpq(?:\s+.*)?$/i.test(text.trim())) {
    if (!chatAllowed(msg.chat_type || 'p2p', msg.chat_id)) return;
    const arg = text.trim().replace(/^\/tbpq\s*/i, '').trim();
    if (!['', '执行', '预览'].includes(arg)) {
      sendText(msg.chat_id, '用法：/tbpq 同步排期；/tbpq 预览 只读检查。');
      return;
    }
    const dryRun = arg === '预览';
    schedulesync.run({ dryRun, onProgress: (t) => sendText(msg.chat_id, t) })
      .then(result => sendText(msg.chat_id, schedulesync.summary(result)))
      .catch(error => { log('/tbpq 失败：' + error.message); sendText(msg.chat_id, '排期同步未完成：' + error.message); });
    return;
  }

  const sceneDir = text && /^\/项目目录\s+逆天萌兽3\s+(粗剪|精剪)\s+(https:\/\/\S+)$/.exec(text.trim());
  if (sceneDir) {
    if (operatorId !== OWNER_OPEN_ID || (msg.chat_type || 'p2p') !== 'p2p') {
      sendText(msg.chat_id, '请由管理员私聊绑定项目目录。'); return;
    }
    try {
      const t = target.parseTarget(sceneDir[2]);
      const f = path.join(cfg.ROOT, 'config.json');
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      const project = c.sceneProjects.find(p => p.key === 'nts3');
      project[sceneDir[1] === '粗剪' ? 'projectUrl' : 'trimPreviewUrl'] = t.projectUrl;
      c[sceneDir[1] === '粗剪' ? 'reviewSyncNts3' : 'reviewSyncNts3FineCut'].mediatrackUrl = t.projectUrl;
      writeJson(f, c);
      sendText(msg.chat_id, '已绑定《逆天萌兽3》' + sceneDir[1] + '目录。上传前用 /target 选择相应目录。');
    } catch (e) { sendText(msg.chat_id, '目录绑定失败：' + e.message); }
    return;
  }

  // /tbpz —— 分秒帧批注同步到多维表格
  if (text && /^\/tbpz(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const { profile, arg, named } = reviewsync.parseCommand(text.trim().replace(/^\/tbpz\s*/i, '').trim());
    const command = reviewsync.commandFor(profile);
    const label = ['fineCut','nts3FineCut'].includes(profile) ? '精剪批注' : '粗剪批注';
    const conf = reviewsync.readConfig(profile);

    // 只发 /tbpz（既没写分支也没写动作）：不动手，先把用法说清楚
    if (!named && !arg) {
      sendText(chatId, TBPZ_USAGE);
      return;
    }

    if (/^(中断|停止)$/.test(arg)) {
      if (!tbpzJob) {
        sendText(chatId, '当前没有正在运行的批注同步。');
      } else if (tbpzJob.chatId !== chatId) {
        sendText(chatId, '请在发起同步的会话里发送中断命令。');
      } else if (named && tbpzJob.profile !== profile) {
        sendText(chatId, '这个分支没有运行中的同步；可发 /tbpz 中断 停止当前同步。');
      } else {
        tbpzJob.controller.abort();
        sendText(chatId, '正在中断：停止采集或后续写入，保留已采集缓存；已写入的记录保留。当前飞书请求完成后会回报结果。');
      }
      return;
    }

    if (/^配置$/.test(arg)) {
      sendText(chatId, [
        `${label}同步配置：`,
        `分秒帧：${conf.mediatrackUrl || '(未设)'}`,
        `多维表格：${conf.bitableUrl || '(未设)'}`,
        `表：${conf.tableId || '(未设)'}`,
        '',
        '怎么用：',
        `· ${command} —— 增量同步（只读上次之后更新的视频，写表）`,
        `· ${command} 全量 —— 滚完整张列表再同步`,
        `· ${command} 预览 —— 增量只读不写`,
        `· ${command} 全量预览 —— 全量只读不写`,
        `· ${command} 写入 —— 把最近一次预览缓存写表，不重新采集`,
        `· ${command} 中断 —— 停止同步，保留缓存和已写入记录`,
        '采集上限：全量 120 分钟，增量 60 分钟（首次增量从最近24小时开始）。',
        '',
        '改目标：',
        `· ${command} 分秒帧 <项目链接>`,
        `· ${command} 表格 <表格链接>`,
      ].join('\n'));
      return;
    }

    const setMt = /^分秒帧\s+(.+)$/.exec(arg);
    if (setMt) {
      const url = setMt[1].trim();
      // 2026-11-10：粗剪批注改走「审片空间」链接，/reviews/<id>?fileId=… 也收
      if (!/mediatrack\.cn\/(projects|reviews)\/\d+/.test(url)) {
        sendText(chatId, '这不是分秒帧链接，要形如\n· 项目页：https://app.mediatrack.cn/projects/<id>/files\n· 审片空间：https://app.mediatrack.cn/reviews/<id>?fileId=<id>&inviteid=…');
        return;
      }
      reviewsync.writeConfig({ mediatrackUrl: url, lastSyncAt: 0 }, profile);
      sendText(chatId, `✅ 分秒帧链接已设为：\n${url}`);
      return;
    }

    const setTb = /^表格\s+(.+)$/.exec(arg);
    if (setTb) {
      const url = setTb[1].trim();
      sendText(chatId, '解析表格链接…');
      reviewsync.parseBitableUrl(url)
        .then((r) => {
          if (!r.tableId) throw new Error('链接里没有 table= 参数，指到具体数据表再复制');
          reviewsync.writeConfig({ bitableUrl: url, appToken: r.appToken, tableId: r.tableId, viewId: r.viewId, lastSyncAt: 0 }, profile);
          sendText(chatId, `✅ 表格已设为：\n${url}\n表：${r.tableId}`);
        })
        .catch((e) => sendText(chatId, '没设成：' + ((e && e.message) || e)));
      return;
    }

    if (!/^(?:执行|写入|增量(?:\s*预览)?|预览|全量(?:\s*预览)?)?$/.test(arg)) {
      sendText(chatId, `用法：${command} [增量|写入|预览|全量|全量预览|配置]`);
      return;
    }

    // 带分支/动作才真跑：粗剪（默认分支）直接同步会写表，预览只读，执行视同直接同步
    // 防重入：一轮同步要好几分钟，跑着的时候别再开第二轮
    if (tbpzRunning) {
      sendText(chatId, '⏳ 批注同步已经在跑了；全量最多 120 分钟，增量最多 60 分钟。可发 /tbpz 中断 停止。');
      return;
    }

    const writeCached = arg === '写入';
    const dryRun = /^(?:增量\s*)?预览$/.test(arg) || /^全量\s*预览$/.test(arg);
    const full = /^全量/.test(arg);
    tbpzRunning = true;
    tbpzJob = { profile, chatId, controller: new AbortController() };
    const signal = tbpzJob.controller.signal;
    log(`${command} 收到（${full ? '全量' : '增量'}${dryRun ? '·预览' : ''}），后台开跑`);
    sendText(chatId, `${label}：` + (writeCached ? '使用最近一次预览缓存写入表格，不重新采集…' : full
      ? (dryRun ? '开始全量预览（只读不写）。滚完整张列表，可能要几分钟…' : '开始全量同步（会写表）。滚完整张列表，可能要几分钟…')
      : (dryRun ? '开始增量预览（只读不写）…' : '开始增量同步（只读上次之后更新的视频，会写表）…')));

    // setImmediate：让上面的回执请求先跑出去，再开始慢活
    setImmediate(() => {
      reviewsync.run({
        profile,
        writeCached,
        signal,
        dryRun,
        full,
        onProgress: (t) => { try { sendText(chatId, t); } catch (e) {} },
      })
      .then((r) => {
        if (r.canceled) {
          sendText(chatId, [
            `${label}已中断，未推进增量水位。`,
            `已采集 ${r.videos} 个视频、${r.comments} 条批注；已写入 ${r.written} 条。`,
            r.cacheSaved || r.cachedWrite ? `缓存已保留，写入可发：${command} 写入` : '未产生新缓存，之前的预览缓存保持不变。',
          ].join('\n'));
          return;
        }
        const lines = [
          dryRun ? `${label}预览完成（没写表）` : `${label}同步完成`,
          `模式：${r.full ? '全量' : (r.sinceMs ? '增量（自 ' + new Date(r.sinceMs).toLocaleString('zh-CN') + '）' : '全量（首次）')}`,
          `视频 ${r.videos} 个 · 读到批注 ${r.comments} 条 · 新增 ${r.dryRun ? r.fresh : r.written} 条`,
        ];
        if (!r.cachedWrite && !r.cacheComplete) lines.push('⚠️ 采集未完整结束，增量水位未推进，请重试核对。');
        if (!r.cachedWrite && r.failed) lines.push(`⚠️ ${r.failed} 条批注未写入，增量水位未推进。`);
        if (r.cachedWrite) {
          lines.push('来源：最近一次预览缓存（未重新采集）');
          if (!r.cacheComplete) lines.push('⚠️ 原预览采集未完整结束，本次仅写入缓存部分，未推进增量水位。');
          if (r.failed) lines.push(`⚠️ ${r.failed} 条写入失败，可再次发「${command} 写入」重试。`);
        } else if (dryRun) {
          lines.push(`缓存已保存。写入请发：${command} 写入`);
          if (!r.cacheComplete) lines.push('⚠️ 采集未完整结束，缓存仅包含已读部分。');
        }
        if (r.perVideo.length) {
          lines.push('', '逐视频：');
          for (const v of r.perVideo.slice(0, 20)) {
            lines.push(`· ${v.file}（${v.episode || '?'} 集）：${v.got} 条${v.note ? '（' + v.note + '）' : ''}`);
          }
        }
        if (r.sample.length) {
          lines.push('', '样例：');
          for (const s of r.sample.slice(0, 5)) {
            lines.push(`· ${s.episode} 集 ${s.timeline}｜${String(s.content).slice(0, 40)}`);
          }
        }
        sendText(chatId, lines.join('\n'));
      })
      .catch((e) => sendText(chatId, `${label}同步失败：` + ((e && e.message) || e)))
      .finally(() => { tbpzRunning = false; tbpzJob = null; });
    });
    return;
  }

  // /driveup 名字 —— 从云盘收件夹里挑一个文件传（区别于 /upmedia：那是聊天框里的视频）
  if (text && /^\/driveup(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = text.trim().replace(/^\/driveup\s*/i, '').trim();

    if (!arg) {
      sendText(chatId, '用法：/driveup <文件名>\n例：/driveup test文件\n（从云盘收件夹里找，不用在聊天框发给我）');
      return;
    }

    if (!uploadEnabled()) { sendText(chatId, UPLOAD_PAUSED_TEXT); return; }

    log(`/driveup 收到「${arg}」（${chatType}）`);
    sendText(chatId, `在云盘收件夹里找「${arg}」…`);
    (async () => {
      if (!drivefolder.enabled()) {
        return sendText(chatId, '云盘收件夹还没配，先发：/drive <文件夹链接>');
      }
      const files = await drivefolder.listFiles(cfg.DRIVE_INBOX.folderToken);
      log(`/driveup 云盘里有 ${files.length} 个文件`);
      const norm = (x) => String(x || '').toLowerCase().replace(/\.[^.]+$/, '');
      const q = norm(arg);

      let hits = files.filter((f) => f.name.toLowerCase() === arg.toLowerCase());
      if (!hits.length) hits = files.filter((f) => norm(f.name) === q);
      if (!hits.length) hits = files.filter((f) => norm(f.name).includes(q));
      if (!hits.length) {
        const names = files.map((f) => '· ' + f.name).join('\n') || '（空）';
        return sendText(chatId, `云盘收件夹里没有匹配「${arg}」的文件。现有：\n${names}`);
      }
      if (hits.length > 1) {
        return sendText(chatId, `「${arg}」匹配到 ${hits.length} 个，说具体点：\n${hits.map((f) => '· ' + f.name).join('\n')}`);
      }

      const f = hits[0];
      const done = drivefolder.isDone(f.token);
      if (done) {
        log(`/driveup 跳过 ${f.name}：之前传过`);
        return sendText(chatId, `${f.name} 之前已经传过了（云端记录里有）。要重传我再放开，说一声。`);
      }

      // 「122-改.mov」这种修改版：按 122.mov 传，分秒帧那边才认得出是同一集、走「上传版本」
      // 而不是新建一份「122-改.mov」。（2026-10-28 之前全这么传的，119~126 集都多了一份）
      const uploadName = epname.stripRev(f.name);
      const renamed = uploadName !== f.name;
      if (renamed) log(`/driveup ${f.name} 识别为修改版，按 ${uploadName} 上传`);

      const tmp = taskTempPath(uploadName, f.token);
      log(`/driveup 开始下载 ${f.name}（token ${f.token}）`);
      let told = 0;
      await drive.download(f.token, tmp, (mb, total) => {
        if (told > 0 && mb - told < 50) return; // 每 50 MB 报一次，别刷屏
        told = mb;
        sendText(chatId, `下载中：${mb.toFixed(0)} MB${total ? '/' + total.toFixed(0) + ' MB' : ''}`);
      });
      log(`/driveup ${f.name} 下载完成，开始上传`);
      await sendText(chatId, renamed
        ? `收到 ${f.name}（修改版），按「${uploadName}」传成这一集的新版本，开始。`
        : `好，把云盘里的 ${f.name} 传成「${uploadName}」，开始。`);
      enqueue({
        att: { fileName: f.name, chatId, messageId: 'driveup-' + f.token },
        outName: uploadName,
        sourceName: f.name,
        localPath: tmp,
        driveSourceToken: f.token,
        by: { openId: operatorId },
        onDone: async (ok) => {
          if (ok) drivefolder.finish(f.token, tmp);
          cleanupTemp(tmp); // 成功失败都收掉，连任务子目录一起
        },
      });
    })().catch((e) => sendText(chatId, '失败：' + ((e && e.message) || e)));
    return;
  }

  // /drive —— 扫云盘投递文件夹；带链接就是换文件夹
  if (text && /^\/drive(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = text.trim().replace(/^\/drive\s*/i, '').trim();

    if (!arg) {
      if (!drivefolder.enabled()) {
        sendText(chatId, '云盘投递还没配。发：\n/drive <共享文件夹链接>\n然后用 /drive 手动扫一次（也会每 5 分钟自动扫）。');
        return;
      }
      if (!uploadEnabled()) { sendText(chatId, '⏸ 上传已暂停，云盘投递这会儿不扫（文件留在文件夹里，不会丢）。'); return; }
      sendText(chatId, '扫云盘文件夹中…');
      drivefolder.scanOnce(true).then((r) => {
        if (r.paused) return sendText(chatId, '⏸ 上传已暂停，这轮没扫。');
        if (r.skipped) return sendText(chatId, '正在扫或没配置，稍后再试。');
        for (const item of r.items) enqueueDriveItem(item, { chatId, operatorId });
        sendText(chatId, `扫描完成：文件夹里 ${r.files} 个文件，新视频 ${r.items.length} 个。\n${r.items.map((i) => '· ' + i.name).join('\n')}`);
      }).catch((e) => sendText(chatId, '扫描失败：' + ((e && e.message) || e)));
      return;
    }

    const m = /\/drive\/folder\/([A-Za-z0-9]+)/.exec(arg);
    if (!m) {
      sendText(chatId, '这是文件夹链接吗？要形如 https://<租户>.feishu.cn/drive/folder/<token>');
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config.json'), 'utf8'));
      raw.driveInbox = Object.assign({ enabled: true, pollMinutes: 5 }, raw.driveInbox, { folderToken: m[1], folderUrl: arg });
      writeJson(path.join(cfg.ROOT, 'config.json'), raw);
      sendText(chatId, `✅ 云盘投递文件夹已设为：\n${arg}\n\n每 5 分钟自动扫一次，也可以 /drive 立刻扫。\n前提：这个文件夹要把「乌小河」加为可阅读。`);
    } catch (e) {
      sendText(chatId, '设置失败：' + ((e && e.message) || e));
    }
    return;
  }

  // /target —— 看/换上传目标（分秒帧项目 + 文件夹）
  if (text && /^\/target(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = text.trim().replace(/^\/target\s*/i, '').trim();

    if (!arg) {
      const t = target.getTarget();
      sendText(chatId, [
        '当前上传目标：',
        t.projectUrl || '(没配)',
        target.describe(t),
        '',
        '要换：/target <分秒帧项目链接>',
        '例子：/target https://app.mediatrack.cn/projects/<项目id>/files?path=<文件夹id>',
        '带文件夹就带上 ?path=… —— 上传会进那个文件夹；不带就是项目根目录。',
      ].join('\n'));
      return;
    }

    try {
      const t = target.setTarget(arg);
      log(`上传目标改为 ${t.projectUrl}`);
      sendText(chatId, `✅ 已切换上传目标\n${t.projectUrl}\n${target.describe(t)}\n下一条视频就传到这儿。`);
    } catch (e) {
      sendText(chatId, `没改成：${(e && e.message) || e}\n链接要形如 https://app.mediatrack.cn/projects/<项目id>/files`);
    }
    return;
  }

  // /help —— 能力清单，现读 help.md（改内容不用重启）
  // 陈俊杰本人 → 完整版；其他同事 / 群聊 → 精简版 help-lite.md
  if (text && /^\/help$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const mine = !!(operatorId && OWNER_OPEN_ID && operatorId === OWNER_OPEN_ID);
    const file = mine ? 'help.md' : 'help-lite.md';
    let md = '';
    try {
      md = fillHelpVars(fs.readFileSync(path.join(cfg.ROOT, file), 'utf8').trim());
      log(`/help（${mine ? '完整版' : '精简版'}，${chatType}）读 ${file} 成功（${md.length} 字）`);
    } catch (e) {
      md = `（${file} 还没写，找乌乌补一份）`;
      log(`⚠️ /help 读 ${file} 失败：${(e && e.message) || e}`);
    }
    sendInteractive(chatId, C.helpCard(md, mine ? '乌小河 · 我会什么' : '乌小河 · 怎么用')).then((ok) => {
      if (!ok) sendText(chatId, md);
    });
    return;
  }

  // /health —— 手动体检：当场跑一遍八项检查，把卡片回在当前会话（谁发的回给谁）
  if (text && /^\/health(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    log(`收到 /health（${chatType}）`);
    sendText(chatId, '体检中，几秒钟…');
    health.reportTo(chatId, healthMeta(), '手动')
      .then(({ sent }) => {
        if (!sent) sendText(chatId, '体检卡没发出去，看 logs/bot.log');
      })
      .catch((e) => sendText(chatId, '体检失败：' + ((e && e.message) || e)));
    return;
  }

  // /积分提醒 —— 工作日 18:15 自动发到群；这条命令只是看名单 / 预览 / 手动补发
  if (text && /^\/(?:积分提醒|jftx)(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = (/^\/(?:积分提醒|jftx)(\s+.*)?$/i.exec(text.trim())[1] || '').trim();
    const mine = !!(operatorId && OWNER_OPEN_ID && operatorId === OWNER_OPEN_ID);
    log(`收到 /积分提醒 ${arg || ''}`.trim());

    if (/^发送$/.test(arg)) {
      if (!mine) {
        sendText(chatId, '只有陈俊杰能手动补发。这条提醒是自动的：工作日 18:15 机器自己发到群里，不用发命令。');
        return;
      }
      pointsReminder.send(pointsReminder.conf())
        .then((r) => sendText(chatId, r.sent
          ? `✅ 已补发到群：${r.people} 位制作师、${r.tasks} 条任务（${(r.names || []).join('、')}）`
          : `没发：${r.skipped || '未知原因'}`))
        .catch((e) => sendText(chatId, '补发失败：' + ((e && e.message) || e)));
      return;
    }

    if (/^预览$/.test(arg)) {
      pointsReminder.collect(pointsReminder.conf())
        .then(({ people }) => {
          if (!people.length) { sendText(chatId, '今天没有符合条件的制作排期，正式到点也不发。'); return null; }
          return sendInteractive(chatId, pointsReminder.buildCard(people, pointsReminder.conf(), { preview: true }))
            .then((ok) => { if (!ok) sendText(chatId, '预览卡没发出去，看 logs/bot.log'); });
        })
        .catch((e) => sendText(chatId, '预览失败：' + ((e && e.message) || e)));
      return;
    }

    pointsReminder.describe()
      .then((s) => sendText(chatId, `${s}\n\n这条提醒是自动的：工作日 18:15 机器人自己发到群里，不用发命令。\n想单独看：/积分提醒 预览 ｜ 想补发一次：/积分提醒 发送`))
      .catch((e) => sendText(chatId, '读表失败：' + ((e && e.message) || e)));
    return;
  }

  // /release —— 私聊预览，编辑保存后由按钮确认发送；now 也只生成预览。
  if (text && /^\/release(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = (/^\/release(\s+.*)?$/i.exec(text.trim())[1] || '').trim();
    const mine = !!(operatorId && OWNER_OPEN_ID && operatorId === OWNER_OPEN_ID);
    log(`收到 /release ${arg || ''}`.trim() + `（${mine ? '陈俊杰' : operatorId || '?'}）`);

    // 看现状：谁都能看，不往群里发东西
    if (/^status$/i.test(arg)) {
      release.status()
        .then((s) => sendText(chatId, s))
        .catch((e) => sendText(chatId, '查版本失败：' + ((e && e.message) || e)));
      return;
    }

    if (!mine || chatType !== 'p2p') {
      sendText(chatId, '请由乌小熊私聊发送 /release，先预览公告，再确认发送。');
      return;
    }

    const force = /^now$/i.test(arg);
    const chats = release.targetChats();
    if (!chats.length) {
      sendText(chatId, '还没指定公告群，先用 /公告群 <群名> 指定一个。');
      return;
    }
    sendText(chatId, '正在生成公告预览…');
    releaseDraft.prepare({ force, operator: operatorId, chatId })
      .catch((e) => sendText(chatId, '预览失败：' + ((e && e.message) || e)));
    return;
  }

  if (text && /^\/公告群(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    if (operatorId !== OWNER_OPEN_ID || chatType !== 'p2p') {
      sendText(chatId, '请由乌小熊在私聊中设置公告群。');
      return;
    }
    const arg = (/^\/公告群(\s+.*)?$/i.exec(text.trim())[1] || '').trim();
    log(`收到 /公告群 ${arg || ''}`.trim());
    release.handleChatCommand(arg)
      .then((s) => sendText(chatId, s))
      .catch((e) => sendText(chatId, '没设成：' + ((e && e.message) || e)));
    return;
  }

  if (text && /^(?:\/)?批量(审阅|剪辑)$/.test(text.trim())) {
    if (!chatAllowed(msg.chat_type || 'p2p', msg.chat_id)) return;
    require('./batch').open(operatorId, text.includes('审阅') ? 'review' : 'trim')
      .catch(e => sendText(msg.chat_id, '打开批量卡片失败：' + e.message));
    return;
  }

  // /flow —— 流程巡检；/flow test 70 —— 给某集发一审卡片；/flow backfill —— 补发全部待审
  const flowCmd = text && /^\/flow(\s+.*)?$/i.exec(text.trim());
  if (flowCmd) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const arg = (flowCmd[1] || '').trim();

    if (/^test\s+\d+/i.test(arg)) {
      const ep = /^test\s+(\d+)/i.exec(arg)[1];
      sendText(chatId, `给 ${ep} 集发一审卡片…`);
      flow.sendReviewFor(ep)
        .then((t) => sendText(chatId, t))
        .catch((e) => sendText(chatId, '失败：' + ((e && e.message) || e)));
      return;
    }

    if (/^backfill$/i.test(arg)) {
      sendText(chatId, '补发当前所有待审记录，稍等…');
      flow.backfill()
        .then((r) => sendText(chatId, `补发完成：待审 ${r.pending} 条，实际发出 ${r.sent} 条。`))
        .catch((e) => sendText(chatId, '补发失败：' + ((e && e.message) || e)));
      return;
    }

    sendText(chatId, '巡检中，稍等…');
    flow.tick().then((s) => {
      if (s && s.skipped) return sendText(chatId, '上一轮还没跑完，等会儿再试。');
      sendText(chatId, `巡检完成：扫了 ${s.scanned} 条，${s.started} 条置为进行中，${s.reviewed} 条发了一审卡片，失败 ${s.failed} 条。`);
    }).catch((e) => sendText(chatId, '巡检失败：' + ((e && e.message) || e)));
    return;
  }

  // 改表命令：/base 把 70 集的素材生成进展改成已上传
  if (text && isBaseCommand(text)) {
    onBaseCommand(text, msg);
    return;
  }

  const cmd = parseTextCommand(msg, COMMAND);
  if (cmd) {
    onCommand(cmd, msg, operatorId).catch((e) => log('命令处理异常：' + ((e && e.message) || e)));
    return;
  }

  // 纯云盘文件链接：直接按原文件名传，不用再发命令
  const link = drive.parseLink(text);
  if (link) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    if (!uploadEnabled()) { sendText(chatId, UPLOAD_PAUSED_TEXT); return; }
    (async () => {
      const name = (await drive.fileName(link.token)) || `drive-${link.token.slice(-6)}.mp4`;
      const tmp = taskTempPath(name, link.token);
      sendText(chatId, `收到云盘文件 ${name}，开始传…`);
      await drive.download(link.token, tmp);
      enqueue({
        att: { fileName: name, chatId, messageId: 'drive-' + link.token },
        outName: name,
        localPath: tmp,
        driveSourceToken: f.token,
        by: { openId: operatorId },
        onDone: async () => { cleanupTemp(tmp); },
      });
    })().catch((e) => sendText(chatId, '下载失败：' + ((e && e.message) || e)));
    return;
  }

  const att = parseAttachment(msg);
  if (!att) return;
  att.senderId = operatorId;
  onVideo(att).catch((e) => log('视频消息处理异常：' + ((e && e.message) || e)));
}

// ---------------------------------------------------------------- 启动

async function selfTest() {
  if (!cfg.APP_ID || !cfg.APP_SECRET) {
    throw new Error('还没填 .env 里的 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  const res = await fetch('https://example.invalid/feishu-resource', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.APP_ID, app_secret: cfg.APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`凭证无效：code=${data.code} msg=${data.msg}`);
  }
  log(`✅ 凭证有效（app_id ${cfg.APP_ID}），tenant_access_token 已取到`);
  return data;
}

// ---------------------------------------------------------------- 单实例锁
// 锁逻辑在 src/lock.js；这里只管拒绝第二个实例
async function main() {
  if (process.argv.includes('--selftest')) {
    await selfTest();
    return;
  }

  // 等 15 秒：重启时 stop.sh 刚发 SIGTERM，老进程退干净之前不能直接判失败
  const lock = botLock.acquire(cfg.ROOT, { waitMs: 15000 });
  if (!lock.ok) {
    log(`❌ 启动被拒绝：${lock.pid ? '已有实例 pid ' + lock.pid : lock.error || '单实例锁尚未就绪'}`);
    console.error('✗ 单实例锁未取得，请先核对已有进程与锁文件。');
    process.exit(1);
  }
  process.on('exit', () => botLock.release(cfg.ROOT));
  fs.writeFileSync(path.join(cfg.ROOT, 'bot.pid'), String(process.pid));
  await selfTest();

  fs.mkdirSync(cfg.DOWNLOAD_DIR, { recursive: true });
  log('目标项目：' + cfg.PROJECT_URL);
  log('接收范围：' + (cfg.ALLOW_P2P ? '私聊' : '') +
    (cfg.ALLOW_GROUPS.length ? ` + ${cfg.ALLOW_GROUPS.length} 个群` : ''));
  log(`触发方式：发视频 + ${COMMAND} 名字`);
  if (cfg.BASE && cfg.BASE.appToken) {
    log(`改表命令：${cfg.BASE_COMMAND} 把 70 集的素材生成进展改成已上传（表：${cfg.BASE.tableName || cfg.BASE.tableId}）`);
  }

  // 命令等待超时的清理（惰性判断为主，这里只是别让 Map 无限涨）
  setInterval(() => {
    const now = Date.now();
    for (const [chatId, c] of pendingCommands) {
      if (c.expiresAt <= now) pendingCommands.delete(chatId);
    }
  }, 60 * 1000).unref();

  // 心跳：每 5 分钟记一行，日志空白时能分清「空闲」还是「装死」
  setInterval(() => {
    const mins = lastEventAt ? Math.round((Date.now() - lastEventAt) / 60000) : -1;
    log(`♥ 心跳：启动后收到 ${eventCount} 条事件${mins >= 0 ? `，最近一条 ${mins} 分钟前` : ''}`);
  }, 5 * 60 * 1000).unref();

  const wsClient = new Lark.WSClient({
    appId: cfg.APP_ID,
    appSecret: cfg.APP_SECRET,
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
    onReady: () => log('✅ 长连接已建立，等视频'),
    onReconnecting: () => log('· 长连接断开，重连中…'),
    onReconnected: () => log('✅ 长连接已恢复'),
    onError: (e) => log('✗ 长连接错误：' + (e && e.message)),
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      // 同步返回，保证 3 秒内响应；重活全在队列里
      try {
        onMessage(data);
      } catch (e) {
        log('事件处理异常：' + (e && e.message));
      }
    },
    // 后台还订阅了「消息已读 / reaction」事件，机器人用不上。
    // 不注册空 handler 的话 SDK 每次收到就打印 [warn]: ['no im.message.message_read_v1 handle']，
    // 那行只是噪音，跟上传没关系（2026-10-28 小熊问过）。
    'im.message.message_read_v1': () => {},
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
    // 卡片按钮回调：必须在 3 秒内返回 toast/card
    // 卡片按钮回调：3 秒内必须应答，否则客户端报「回传失败」。
    // 所以先秒回「已收到」，读表/改表/发通知全在后台跑，跑完把原卡片替换成结果卡。
    'card.action.trigger': (data) => {
      const value = (data && data.action && data.action.value) || {};
      const operator = (data && data.operator && data.operator.open_id) || '';
      const msgId = (data && data.context && data.context.open_message_id)
        || (data && data.message && data.message.message_id) || '';
      log(`卡片点击 ${value.a || '?'}（记录 ${value.r || '?'}）`);
      eventCount++;
      lastEventAt = Date.now();
      const chatId = (data && data.context && data.context.open_chat_id) || '';
      if (String(value.a || '').startsWith('release_') || String(data?.action?.name || '').startsWith('release_save_')) {
        return releaseDraft.dispatch({ action: data.action, operator, chatId, messageId: msgId });
      }
      if (value.a === 'notify_owner_fix') {
        return requestOwnerFix({ operator, chatId });
      }
      if (value.a === 'restart_bot') {
        return requestRestart({ operator, chatId, openId: operator });
      }
      if (String(value.a || '').startsWith('batch_') || String(data.action?.name || '').startsWith('batch_submit_')) {
        require('./batch').dispatch(data.action, operator, msgId)
          .catch(e => require('./feishu').sendTextTo(operator, '批量操作失败：' + e.message));
        return { toast: { type: 'info', content: '已收到，正在处理…' } };
      }
      if (!value.a || !value.r) return { toast: { type: 'info', content: '没有可执行的操作' } };
      flow.handleCardAction(value, operator, msgId)
        .catch((e) => log('卡片处理异常：' + ((e && e.message) || e)));
      return { toast: { type: 'success', content: '已收到，正在处理…' } };
    },
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  log('服务已启动');
  startAdminRuntime();
  killOrphanWorkers(); // 先收掉上次没死透的上传子进程，不然会和本次恢复的任务同时传，顶成 v2
  restoreQueue(); // 上次没传完的接着传（进程重启不再白下）
  cleanOldDownloads(); // 顺手清掉 3 天前的残留
  flow.startScheduler();
  startHealthScheduler();
  pointsReminder.startScheduler(() => state, saveState);
  release.startScheduler();
  checkRestartFeedback();

  // 云盘投递文件夹：同事传的大文件走这里
  // 第二个参数是「上传是否被暂停」——停了就连扫描下载都跳过（见 config.json → upload）
  drivefolder.start(enqueueDriveItem, () => !uploadEnabled());

  // 本地投递箱：>100 MB 的大文件走这里
  inbox.start((item) => {
    if (!uploadEnabled()) {
      // 解开占用，恢复上传后下一轮扫描能自动捡起来；日志 10 分钟最多一条，别刷屏
      inbox.clearBusy(item);
      if (Date.now() - lastInboxPauseLog > 10 * 60 * 1000) {
        lastInboxPauseLog = Date.now();
        log(`上传已暂停，投递箱里的 ${item.outName} 先放着（恢复后自动接着传）`);
      }
      return;
    }
    log(`投递箱：发现 ${item.fileName}（${(item.size / 1024 / 1024).toFixed(1)} MB）→ ${item.outName}`);
    enqueue({
      att: { fileName: item.outName, chatId: null, messageId: 'inbox-' + Date.now() },
      outName: item.outName,
      sourceName: item.fileName,
      localPath: item.path,
      inboxItem: item,
      notifyOpenId: (cfg.INBOX && cfg.INBOX.notifyOpenId) || '',
    });
  });

  // 优雅退出
  const shutdown = () => {
    log('收到退出信号，关闭长连接');
    killWorkerGroup();  // detached 的 worker 不跟着死，会继续在浏览器里传 → 重启后变成两个窗口
    try { wsClient.close({ force: true }); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch((e) => {
  log('❌ 启动失败：' + (e && e.message));
  process.exit(1);
});

// 本机管理台只通过持久命令请求既有队列，不启动第二条上传链路。
function startAdminRuntime() { return setInterval(async () => {
  try {
    await require('./admin-runtime').tick({
      current: currentJob ? { name: currentJob.outName, queuedAt: currentJob.queuedAt } : null,
      queue: queue.map(j => ({ name: j.outName, queuedAt: j.queuedAt })),
      sync: tbpzRunning || (require('./schedulesync').isRunning?.() || false),
    }, enqueue, resolvePendingUpload);
  } catch (e) { log('管理台状态写入失败：' + e.message); }
}, 2000).unref(); }

function enqueueDriveItem(item, { chatId = null, operatorId = '' } = {}) {
  return enqueue({
    att: { fileName: item.name, chatId, messageId: 'drive-' + item.token },
    outName: item.uploadName || epname.stripRev(item.name),
    sourceName: item.name,
    localPath: item.local,
    by: operatorId ? { openId: operatorId } : null,
    notifyOpenId: OWNER_OPEN_ID,
    driveSourceToken: item.token,
    onDone: async (ok) => { drivefolder.finish(item.token, item.local, ok); },
  });
}

module.exports = { onMessage, onCommand, onVideo, pendingKey, targetFileName, uploadKey, dupUpload, enqueueDriveItem, runJob, resolvePendingUpload, restoreQueue };

async function resolvePendingUpload(command) {
  if (command.type === 'notification-retry') return flow.retryNotification(command.id);
  const record = pendingUploads.list().find(r=>r.id===command.id);
  if (!record) throw Error('待确认记录已处理或不存在');
  if (busy || queue.length) throw Error('请等待上传队列空闲后核对');
  const job = record.job;
  if (['confirmed-uploaded','confirmed-uploaded-no-backwrite'].includes(command.action)) {
    if (command.action === 'confirmed-uploaded') await markEpisodeReady(job.chatId || job.att?.chatId, job.outName, job.taskBinding, true);
    if (job.inboxItem) inbox.markDone(job.inboxItem);
    if (job.driveSourceToken) drivefolder.finish(job.driveSourceToken, job.localPath, true);
    pendingUploads.set(record.id, 'confirmed-uploaded', command.action === 'confirmed-uploaded' ? '操作者核对平台后确认；已补写适用任务状态' : '操作者确认文件已上传，保留当前任务表状态');
  } else if (command.action === 'confirmed-missing-retry') {
    const retry = {...job,confirmationRetry:true,confirmationId:record.id,queuedAt:Date.now()};
    if (retry.localPath && !fs.existsSync(retry.localPath)) throw Error('原文件不存在，请重新提交；不要确认已上传');
    if (job.driveSourceToken) retry.onDone = ok => drivefolder.finish(job.driveSourceToken, job.localPath, ok);
    if (!enqueue(retry)) throw Error('未入队，请检查上传开关');
    // 复用确认记录，begin() 会在再次动浏览器之前更新持久描述。
  } else throw Error('未识别的核对操作');
}
