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
const { spawn } = require('child_process');

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
      episode: reviewsync.episodeOf(job.outName),
      source,
      resultText,
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
    // 最近成功的上传耗时，用来给排队的人估时间（中位数，最多留 20 条）
    if (!Array.isArray(s.durations)) s.durations = [];
    return s;
  } catch (e) {
    return { handled: [], healthSent: [], durations: [] };
  }
}

function saveState() {
  try {
    fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(state, null, 2));
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
  '· /tbpz 精剪 —— 增量同步到精剪备份表',
  '· /tbpz 精剪 预览 / 全量 / 全量预览 / 配置',
  '· /tbpz 精剪 写入 —— 使用最近一次精剪预览缓存写表，不重新采集',
  '· /tbpz 精剪 中断 / /tbpz 中断 —— 停止同步并保留缓存；全量及首次同步上限 120 分钟',
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
    fs.writeFileSync(RESTART_FLAG, JSON.stringify(obj, null, 2));
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
  if (operator && OWNER_OPEN_ID && operator !== OWNER_OPEN_ID) {
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

function pushVideo(att) {
  const list = pendingVideos.get(att.chatId) || [];
  list.push(att);
  while (list.length > MAX_PENDING_VIDEOS) list.shift();
  pendingVideos.set(att.chatId, list);
}

/** 失败的视频放回队首（网络抖动时用户重发 /upmedia 就能重试，不用重传文件） */
function unshiftVideo(att) {
  if (!att || !att.chatId) return;
  const list = pendingVideos.get(att.chatId) || [];
  list.unshift(att);
  while (list.length > MAX_PENDING_VIDEOS) list.pop();
  pendingVideos.set(att.chatId, list);
}

function takeVideo(chatId) {
  const list = pendingVideos.get(chatId) || [];
  const att = list.shift() || null;
  if (list.length) pendingVideos.set(chatId, list);
  else pendingVideos.delete(chatId);
  return att;
}

/** 用户输入的名字 → 分秒帧里的文件名（补扩展名、去非法字符） */
function targetFileName(input, originalName) {
  const originalExt = (path.extname(originalName) || '.mp4').toLowerCase();
  let base = safeName(String(input || '').trim());
  if (!base) return '';
  if (!path.extname(base)) base += originalExt;
  return base;
}

// ---------------------------------------------------------------- 串行队列

const queue = [];
let busy = false;
let currentJob = null;
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
  return !!(job && job.att && job.att.messageId && !job.localPath && !job.att.driveToken);
}

function saveQueue() {
  try {
    const list = [currentJob].concat(queue)
      .filter(serializable)
      .map((j) => ({
        att: j.att, outName: j.outName, cmdName: j.cmdName || '',
        by: j.by || null, notifyOpenId: j.notifyOpenId || '', queuedAt: j.queuedAt || Date.now(),
      }));
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 1));
  } catch (e) {
    log('⚠️ 队列写盘失败：' + ((e && e.message) || e));
  }
}

/**
 * 启动时清 downloads/ 里 3 天前的残留。
 * 传成功现在会自动删；失败/被重启打断的会留下来，攒久了占几个 G。
 */
function cleanOldDownloads() {
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
  const fresh = list.filter((j) => j && j.att && j.outName && Date.now() - (j.queuedAt || 0) < 12 * 3600 * 1000);
  const stale = list.length - fresh.length;
  if (stale > 0) log(`丢掉 ${stale} 个超过 12 小时的旧任务`);
  if (!fresh.length) return;
  log(`恢复 ${fresh.length} 个重启前没传完的任务：${fresh.map((j) => j.outName).join('、')}`);
  fresh.forEach((j) => enqueue({ ...j, restored: true }));
}

function enqueue(job) {
  // 同一条源文件重复投（连着发三次 /upmedia 73 + 两次文件）→ 别再排一遍。
  // 2026-10-28 踩到：三份 56 MB 下载互相打断，一个都没传成。
  // 但「122-改1 / 122-改2 都按 122 传」是两个不同文件，得按顺序都传 —— 所以按来源比，
  // 不能只看 outName（归一化之后它们都叫 122.mov）。
  if (!job.retried) {
    const srcKey = (j) => (j && j.att && j.att.messageId) || '';
    const dup = [currentJob].concat(queue).find((j) =>
      j && j !== job && j.outName === job.outName && srcKey(j) && srcKey(j) === srcKey(job));
    if (dup) {
      const where = dup === currentJob ? '正在传' : '已经在排队';
      log(`跳过重复入队 ${job.outName}：${where}`);
      reply(job, `「${job.outName}」${where}，这次不用重复发；传完我直接回结果。`);
      if (job.inboxItem && inbox.clearBusy) inbox.clearBusy(job.inboxItem);
      if (job.onDone) job.onDone(true);
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

async function pump() {
  if (busy) return;
  const job = takeNext();
  if (!job) return;
  busy = true;
  currentJob = job;
  const startedAt = Date.now();
  const waited = job.queuedAt ? Math.round((startedAt - job.queuedAt) / 1000) : 0;
  if (waited > 10) log(`${job.outName} 排队 ${waited} 秒后开始`);
  try {
    await runJob(job);
    feedbackToOwner(job, job.uploadOk !== false, job.resultText);
  } catch (e) {
    const msg = (e && e.message) || '';
    const netDown = /下载失败/.test(msg) &&
      /connect failed|ECONNREFUSED|ETIMEDOUT|socket hang up|ECONNRESET|getaddrinfo/i.test(msg);
    // 飞书消息下载遇到网络抖动：自动重试一次（文件不用重传）
    if (netDown && job.att && job.att.messageId && !job.retried) {
      log(`${job.outName} 下载赶上断网，45 秒后自动重试`);
      await reply(job, `⚠️ ${job.outName} 下载时赶上断网（${msg.replace('下载失败：', '')}）。45 秒后我自动重试，不用重发文件。`);
      setTimeout(() => {
        enqueue({ ...job, retried: true });
      }, 45000);
    } else {
      log(`处理失败 ${job.outName}：${msg}`);
      let text = `❌ ${job.outName} 处理失败：${msg || '未知错误'}`;
      if (e && e.scopeUrl) text += `\n\n缺权限，点这个开：\n${e.scopeUrl}`;
      // 网络原因且视频还在飞书服务器上：放回待传，重发 /upmedia 即可，不用重传 89MB 的文件
      if (netDown && job.att && job.att.messageId) {
        unshiftVideo(job.att);
        if (job.cmdName && job.att.chatId) {
          pendingCommands.set(job.att.chatId, { name: job.cmdName, expiresAt: Date.now() + WAIT_SECONDS * 1000 });
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

/** 起子进程跑上传，从 stdout 里捞最后一行 RESULT_JSON */
function runWorker(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), filePath], {
      env: childEnv({ BSK_AUTO_START: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：超时时能连 worker 里 execFileSync 起的 bsk 子进程一起收掉，
      // 不然 worker 死了、bsk 还挂在浏览器上占着会话
      detached: true,
    });

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
  // 落盘就用目标名（worker 按磁盘文件名认分秒帧条目），但目录每次独立，
  // 免得两个人同一集同时下载时写同一个文件
  const destPath = job.localPath || taskTempPath(outName, att.messageId || att.driveToken);
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

  log(`开始上传 ${att.fileName} → ${outName}`);
  const res = await runWorker(destPath);
  lastUpload = { at: Date.now(), file: outName, ok: !!res.ok };

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
  } else if (res.error) {
    text = `❌ ${outName} 上传失败：${res.error}`;
  } else {
    text = `⚠️ ${outName} 已提交，但列表数量没变（${res.countBefore} → ${res.countAfter}），请到分秒帧确认\n${res.url}`;
  }
  log(text);
  job.uploadOk = !!res.ok;
  job.resultText = text;

  // 传成功了就把下载下来的临时文件删掉（2026-10-28：以前 /upmedia 传完不删，
  // downloads/ 里越攒越多，今天一次就积了 300 多 MB）。失败留着，方便排查。
  if (res.ok && !job.localPath) {
    cleanupTemp(destPath);
    log(`已清理临时文件 ${outName}`);
  }
  await reply(job, text);

  if (job.inboxItem) {
    if (res.ok) inbox.markDone(job.inboxItem);
    else inbox.markFailed(job.inboxItem);
    inbox.clearBusy(job.inboxItem);
  }
  if (job.onDone) await job.onDone(res.ok);

  // 上传成功后：文件名带集数的，把该集素材生成进展记为已粗剪待一审（制作师 /upmedia、/driveup 都走这里）
  if (res.ok) await markEpisodeReady(job.chatId || (job.att && job.att.chatId), outName);
}

/**
 * 上传成功回写多维表格：按文件名里的集数找记录，素材生成进展 → 已粗剪待一审，并重发一审卡片。
 * 已经在已完成并上传/已定剪的集不回退（那属于重传终稿版本）。
 */
async function markEpisodeReady(chatId, outName) {
  try {
    const ep = reviewsync.episodeOf(outName);
    if (ep == null) return;
    const recs = await flow.fetchAllRecords();
    const rec = recs.find((r) => String(r.episode) === String(ep));
    if (!rec) {
      log(`上传回写：表里没有 ${ep} 集的记录，跳过`);
      return;
    }
    if (rec.stage === '已完成并上传' || rec.trimStage === '已定剪') {
      log(`上传回写：${ep} 集已完成并上传/已定剪，不回退状态`);
      return;
    }
    if (rec.stage !== '已粗剪待一审') {
      await flow.updateFields(rec.recordId, { 素材生成进展: '已粗剪待一审' });
      rec.stage = '已粗剪待一审';
      if (chatId) sendText(chatId, `📋 已把 ${ep} 集的「素材生成进展」记为已粗剪待一审。`);
    }
    // 不管状态改没改，都补发/确保一审卡片在（防重复由 flowState 去重）
    const reviewSent = await flow.autoReview(rec, true);
    log(`上传回写：${ep} 集已标待一审${reviewSent ? '，一审卡片已成功发给审片人' : '，一审卡片没发出去'}`);
    // 真发出去了才告诉制作师「审片人已经收到了」（2026-10-28 小熊要求）
    if (reviewSent && chatId) {
      const names = (rec.reviewers || []).filter((p) => p && p.id)
        .map((p) => `${p.name || '（未填名字）'}（审片人）`).join('、');
      if (names) sendText(chatId, `📨 已通知到 ${names}，审片人收到了这一集的审阅卡片。`);
    }
  } catch (e) {
    log('上传回写失败：' + ((e && e.message) || e));
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

  editField(rest)
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
function onCommand(cmd, msg, operatorId) {
  const chatId = msg.chat_id;
  const chatType = msg.chat_type || 'p2p';
  if (!chatAllowed(chatType, chatId)) return;

  if (!cmd.name) {
    sendText(chatId, `用法：${COMMAND} 名字\n比如 ${COMMAND} 67 —— 会把最新那条视频传成分秒帧里的「67.mp4」。`);
    return;
  }

  // /upmedia 67 <云盘链接> —— 一条消息把文件也带上
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
    sendText(chatId, `好，从云盘拉这个文件，传成「${outName}」，开始。`);
    enqueue({ att: driveAtt, outName, by: { openId: operatorId } });
    return;
  }

  const att = takeVideo(chatId);
  if (att) {
    const outName = targetFileName(cmd.name, att.fileName);
    pendingCommands.delete(chatId);
    sendText(chatId, `好，把 ${att.fileName} 传成「${outName}」，开始。`);
    enqueue({ att, outName, cmdName: cmd.name, by: { openId: operatorId } });
    return;
  }

  // 命令先到：留个坑，等视频
  pendingCommands.set(chatId, { name: cmd.name, expiresAt: Date.now() + WAIT_SECONDS * 1000 });
  sendText(chatId, `好，把视频发到聊天框，我传成「${targetFileName(cmd.name, '.mp4')}」。（${Math.round(WAIT_SECONDS / 60)} 分钟内有效）\n如果文件在云盘收件夹里，改用：/driveup ${cmd.name}`);
}

/** 视频消息入口 */
function onVideo(att) {
  if (!chatAllowed(att.chatType, att.chatId)) return;

  // 只处理视频扩展名
  const ext = path.extname(att.fileName).toLowerCase();
  if (cfg.ALLOWED_EXT.length && !cfg.ALLOWED_EXT.includes(ext)) {
    log(`不是视频（${att.fileName}），忽略`);
    sendText(att.chatId, `这个我只收视频文件，${att.fileName || '这个附件'} 先跳过了。`);
    return;
  }

  // 去重：长连接超时会重推同一事件
  if (state.handled.includes(att.messageId)) {
    log(`重复推送，已跳过 ${att.messageId}`);
    return;
  }
  state.handled.push(att.messageId);
  if (state.handled.length > 500) state.handled = state.handled.slice(-500);
  saveState();

  // 命令先到 → 直接开工
  const pendingCmd = pendingCommands.get(att.chatId);
  if (pendingCmd && pendingCmd.expiresAt > Date.now()) {
    pendingCommands.delete(att.chatId);
    const outName = targetFileName(pendingCmd.name, att.fileName);
    sendText(att.chatId, `收到 ${att.fileName}，传成「${outName}」，开始。`);
    enqueue({ att, outName });
    return;
  }

  // 否则缓存，等命令
  pushVideo(att);
  if (cfg.REPLY_ON_RECEIVE) {
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

  const text = textContent(msg);

  // 每条进来的消息都记一行，方便判断「没回」是没收到还是处理出错
  log(`收到消息 [${msg.message_type || msg.msg_type}] ${(text || '').replace(/\s+/g, ' ').slice(0, 40) || '(非文本)'}`);

  // /tbpq —— 测试项目排期同步（显式命令触发，不挂入审阅流程）
  if (text && /^\/tbpq(?:\s+.*)?$/i.test(text.trim())) {
    if (!chatAllowed(msg.chat_type || 'p2p', msg.chat_id)) return;
    const arg = text.trim().replace(/^\/tbpq\s*/i, '').trim();
    if (!['', '执行', '预览'].includes(arg)) {
      sendText(msg.chat_id, '用法：/tbpq 同步排期；/tbpq 预览 只读检查。');
      return;
    }
    const dryRun = arg === '预览';
    schedulesync.run({ dryRun })
      .then(result => sendText(msg.chat_id, schedulesync.summary(result)))
      .catch(error => { log('/tbpq 失败：' + error.message); sendText(msg.chat_id, '排期同步未完成：' + error.message); });
    return;
  }

  // /tbpz —— 分秒帧批注同步到多维表格
  if (text && /^\/tbpz(\s+.*)?$/i.test(text.trim())) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    const { profile, arg, named } = reviewsync.parseCommand(text.trim().replace(/^\/tbpz\s*/i, '').trim());
    const command = profile === 'fineCut' ? '/tbpz 精剪' : '/tbpz 粗剪';
    const label = profile === 'fineCut' ? '精剪批注' : '粗剪批注';
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
        '采集上限：全量 / 首次同步 120 分钟，普通增量 25 分钟。',
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
      if (!/mediatrack\.cn\/projects\/\d+/.test(url)) {
        sendText(chatId, '这不是分秒帧项目链接，要形如 https://app.mediatrack.cn/projects/<id>/files');
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

    if (!/^(?:执行|写入|预览|全量(?:\s*预览)?)?$/.test(arg)) {
      sendText(chatId, `用法：${command} [写入|预览|全量|全量预览|配置]`);
      return;
    }

    // 带分支/动作才真跑：粗剪（默认分支）直接同步会写表，预览只读，执行视同直接同步
    // 去重：长连接超时会重推同一事件
    if (state.handled.includes(msg.message_id)) return;
    state.handled.push(msg.message_id);
    if (state.handled.length > 500) state.handled = state.handled.slice(-500);
    saveState();

    // 防重入：一轮同步要好几分钟，跑着的时候别再开第二轮
    if (tbpzRunning) {
      sendText(chatId, '⏳ 批注同步已经在跑了；全量或首次同步最多 120 分钟。可发 /tbpz 中断 停止。');
      return;
    }

    const writeCached = arg === '写入';
    const dryRun = /^预览$/.test(arg) || /^全量\s*预览$/.test(arg);
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
      sendText(chatId, renamed
        ? `收到 ${f.name}（修改版），按「${uploadName}」传成这一集的新版本，开始。`
        : `好，把云盘里的 ${f.name} 传成「${uploadName}」，开始。`);
      enqueue({
        att: { fileName: f.name, chatId, messageId: 'driveup-' + f.token },
        outName: uploadName,
        sourceName: f.name,
        localPath: tmp,
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
      sendText(chatId, '扫云盘文件夹中…');
      drivefolder.scanOnce().then((r) => {
        if (r.skipped) return sendText(chatId, '正在扫或没配置，稍后再试。');
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
      fs.writeFileSync(path.join(cfg.ROOT, 'config.json'), JSON.stringify(raw, null, 2) + '\n');
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
        '例子：/target https://app.mediatrack.cn/projects/2109939996814217216/files',
        '带文件夹就带上 ?path=… —— 上传会进那个文件夹。',
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
    onCommand(cmd, msg, operatorId);
    return;
  }

  // 纯云盘文件链接：直接按原文件名传，不用再发命令
  const link = drive.parseLink(text);
  if (link) {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type || 'p2p';
    if (!chatAllowed(chatType, chatId)) return;
    if (state.handled.includes(msg.message_id)) return;
    state.handled.push(msg.message_id);
    if (state.handled.length > 500) state.handled = state.handled.slice(-500);
    saveState();

    (async () => {
      const name = (await drive.fileName(link.token)) || `drive-${link.token.slice(-6)}.mp4`;
      const tmp = taskTempPath(name, link.token);
      sendText(chatId, `收到云盘文件 ${name}，开始传…`);
      await drive.download(link.token, tmp);
      enqueue({
        att: { fileName: name, chatId, messageId: 'drive-' + link.token },
        outName: name,
        localPath: tmp,
        onDone: async () => { cleanupTemp(tmp); },
      });
    })().catch((e) => sendText(chatId, '下载失败：' + ((e && e.message) || e)));
    return;
  }

  const att = parseAttachment(msg);
  if (!att) return;
  onVideo(att);
}

// ---------------------------------------------------------------- 启动

async function selfTest() {
  if (!cfg.APP_ID || !cfg.APP_SECRET) {
    throw new Error('还没填 .env 里的 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
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

  await selfTest();

  // 等 15 秒：重启时 stop.sh 刚发 SIGTERM，老进程退干净之前不能直接判失败
  const lock = botLock.acquire(cfg.ROOT, { waitMs: 15000 });
  if (!lock.ok) {
    log(`❌ 已经有实例在跑（pid ${lock.pid}），这个进程退出`);
    console.error(`✗ 已经有实例在跑（pid ${lock.pid}）。要重启：./stop.sh 然后 ./start.sh`);
    process.exit(1);
  }
  process.on('exit', () => botLock.release(cfg.ROOT));

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
      if (!value.a || !value.r) return { toast: { type: 'info', content: '没有可执行的操作' } };
      flow.handleCardAction(value, operator, msgId)
        .catch((e) => log('卡片处理异常：' + ((e && e.message) || e)));
      return { toast: { type: 'success', content: '已收到，正在处理…' } };
    },
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  log('服务已启动');
  restoreQueue(); // 上次没传完的接着传（进程重启不再白下）
  cleanOldDownloads(); // 顺手清掉 3 天前的残留
  flow.startScheduler();
  startHealthScheduler();
  release.startScheduler();
  checkRestartFeedback();

  // 云盘投递文件夹：同事传的大文件走这里
  drivefolder.start((item) => {
    const outName = item.uploadName || epname.stripRev(item.name);
    log(`云盘投递：发现 ${item.name}（${(item.size / 1024 / 1024).toFixed(1)} MB）` +
      (outName !== item.name ? `，识别为修改版，按 ${outName} 上传` : ''));
    enqueue({
      att: { fileName: item.name, chatId: null, messageId: 'drive-' + item.token },
      outName,
      sourceName: item.name,
      localPath: item.local,
      notifyOpenId: (cfg.INBOX && cfg.INBOX.notifyOpenId) || '',
      onDone: async () => { drivefolder.finish(item.token, item.local); },
    });
  });

  // 本地投递箱：>100 MB 的大文件走这里
  inbox.start((item) => {
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
    try { wsClient.close({ force: true }); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('❌ 启动失败：' + (e && e.message));
  process.exit(1);
});
