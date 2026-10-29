#!/usr/bin/env node
/**
 * 每日自检 · 测试集 999 全流程体检
 *
 * 干什么：
 *   1. 判断今天是不是法定工作日（节假日/调休都算，非工作日直接跳过）
 *   2. 确认机器人进程在跑（不在就 ./start.sh 起来）
 *   3. 把 999 集的 审片人/制作师/剪辑师 都设成陈俊杰（已经是就不动），
 *      开始日期 = 今天，进展 / 素材生成进展 / 剪辑进度 = 待开始，审阅反馈 = 未审阅
 *   4. 等机器人巡检自己把「进展」改成进行中、「素材生成进展」改成生成中
 *   5. 把 一审 → 一审未通过 → 修改已上传 → 一审通过 → 素材已上传 →
 *      精剪完成 → 剪辑通过 整条流程真跑一遍（真改表、真发卡片）
 *   6. 结果写 logs/selftest-<日期>.json + 追加 logs/selftest-log.jsonl，
 *      并发一条飞书私聊报告给陈俊杰
 *
 * 用法：
 *   node scripts/selftest-999.js            正常跑（自动判断工作日）
 *   node scripts/selftest-999.js --force     忽略工作日判断，强制跑
 *   node scripts/selftest-999.js --no-notify 不发飞书报告（调试用）
 *
 * 注意：这是独立进程，靠 FLOW_STATE_READONLY=1 禁止写 flow-state.json，
 * 否则会覆盖机器人内存里的去重状态（两进程各存一份 = 卡片可能重发）。
 */

process.env.FLOW_STATE_READONLY = '1';
// 兜底：别继承任何代理，本地代理挂掉会让所有飞书请求 ECONNREFUSED
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'bot.log');
const EPISODE = '999';
const PROJECT = '《逆天萌兽2》';
const ME_NAME = '陈俊杰';
const FALLBACK_ME_ID = '[已脱敏]';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const NO_NOTIFY = argv.includes('--no-notify');

// ---------------------------------------------------------------- 日志捕获
// log.js 只在 TTY 时写 bot.log，脚本跑起来不是 TTY；这里把本进程打的日志都收进内存，
// 用来校验「卡片已发」这类只体现在日志里的动作。
const buf = [];
const origLog = console.log.bind(console);
console.log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  buf.push(line);
  origLog(line);
};

const flow = require(path.join(ROOT, 'src', 'flow'));
const bitable = require(path.join(ROOT, 'src', 'bitable'));
const { sendTextTo } = require(path.join(ROOT, 'src', 'feishu'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const todayTs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const ymd = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const hms = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function sizeOf(f) {
  try { return fs.statSync(f).size; } catch (e) { return 0; }
}

function readFrom(file, offset) {
  try {
    const st = fs.statSync(file);
    if (st.size <= offset) return '';
    const len = st.size - offset;
    const b = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, len, offset);
    fs.closeSync(fd);
    return b.toString('utf8');
  } catch (e) {
    return '';
  }
}

/** 等某段日志出现（source=file 读机器人日志，source=buf 读本进程日志） */
async function waitLog(pattern, opts) {
  const { from = 0, timeoutMs = 200000, source = 'file', label = '' } = opts || {};
  const t0 = Date.now();
  for (;;) {
    const text = source === 'file' ? readFrom(LOG_FILE, from) : buf.slice(from).join('\n');
    if (pattern.test(text)) return { ok: true, waited: Date.now() - t0, text };
    if (Date.now() - t0 > timeoutMs) return { ok: false, waited: Date.now() - t0, text };
    await sleep(2500);
  }
}

// ---------------------------------------------------------------- 结果记录
const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok: !!ok, detail: detail || '' });
  origLog(`${ok ? '✓' : '✗'} ${name}${detail ? ' · ' + detail : ''}`);
  return !!ok;
}

// ---------------------------------------------------------------- 工作日判断
// 和机器人主进程共用一份（src/workday.js）：节假日数据 + 调休补班都在这里判断
const workday = require(path.join(ROOT, 'src', 'workday'));
const checkWorkday = workday.checkWorkday;

// ---------------------------------------------------------------- 机器人进程
function botPid() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(ROOT, 'bot.pid'), 'utf8').trim(), 10);
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return 0;
  }
}

async function ensureBot() {
  let pid = botPid();
  if (pid) return { pid, started: false };
  origLog('机器人没在跑，先启动…');
  spawnSync('bash', [path.join(ROOT, 'start.sh')], { cwd: ROOT, stdio: 'inherit' });
  const mark = sizeOf(LOG_FILE);
  await waitLog(/长连接已建立/, { from: mark, timeoutMs: 60000 });
  pid = botPid();
  return { pid, started: true };
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const t0 = Date.now();
  const startedAt = new Date();
  const report = {
    version: 1,
    date: ymd(startedAt),
    startedAt: startedAt.toISOString(),
    episode: EPISODE,
    workday: null,
    skipped: false,
    botPid: 0,
    botStarted: false,
    rolesChanged: false,
    resetFields: [],
    autoStart: null,
    steps: [],
    ok: false,
    durationSec: 0,
  };

  // 0. 工作日
  const wd = await checkWorkday(startedAt);
  report.workday = wd;
  if (!wd.work && !FORCE) {
    report.skipped = true;
    report.ok = true;
    report.durationSec = Math.round((Date.now() - t0) / 1000);
    origLog(`${wd.date} 不是法定工作日（${wd.note || wd.from}），今天不自检。`);
    await finish(report);
    return;
  }
  origLog(`开工：${wd.date} ${wd.from === 'api' ? '法定工作日（' + (wd.note || '上班') + '）' : wd.note}`);

  // 1. 机器人
  const bot = await ensureBot();
  report.botPid = bot.pid;
  report.botStarted = bot.started;
  step('机器人在跑', !!bot.pid, bot.pid ? `pid ${bot.pid}${bot.started ? '（本次拉起）' : ''}` : '没有进程，start.sh 也没起来');

  // 2. 找 999 记录（没有就新建一条）+ 陈俊杰的 open_id
  const recs = await flow.fetchAllRecords();
  const findMe = (list) => (list || []).find((p) => (p.name || '').includes(ME_NAME) || p.id === FALLBACK_ME_ID);
  let me = null;
  for (const r of recs) {
    me = findMe(r.reviewers) || findMe(r.artist) || findMe(r.editors);
    if (me) break;
  }
  if (!me) me = { id: FALLBACK_ME_ID, name: ME_NAME };
  report.me = me.id;

  let rec = recs.find((r) => String(r.episode).trim() === EPISODE);
  report.createdRecord = false;
  if (!rec) {
    // 表里没有 999 集就现场建一条，省得体检直接罢工
    try {
      const created = await bitable.createRecord({
        集数: Number(EPISODE),
        '《项目名》': PROJECT,
        审片人: [{ id: me.id }],
        制作师: [{ id: me.id }],
        剪辑师: [{ id: me.id }],
        开始日期: todayTs(),
        进展: '待开始',
        素材生成进展: '待开始',
        审阅反馈: '未审阅',
        剪辑进度: '待开始',
      });
      rec = flow.mapRecord(created);
      report.createdRecord = true;
      step(`新建 ${EPISODE} 集记录`, true, `${rec.recordId}（表里原本没有，已建好）`);
    } catch (e) {
      step(`新建 ${EPISODE} 集记录`, false, `表里没有这条，新建也失败：${(e && e.message) || e}`);
      report.durationSec = Math.round((Date.now() - t0) / 1000);
      await finish(report);
      return;
    }
  } else {
    step(`找到 ${EPISODE} 集记录`, true, `${rec.recordId} · 陈俊杰 ${me.id}`);
  }

  // 3. 重置：角色 / 开始日期 / 各项进展
  const onlyMe = (list) => (list || []).length === 1 && list[0].id === me.id;
  const patch = {};
  if (!onlyMe(rec.reviewers)) patch['审片人'] = [{ id: me.id }];
  if (!onlyMe(rec.artist)) patch['制作师'] = [{ id: me.id }];
  if (!onlyMe(rec.editors)) patch['剪辑师'] = [{ id: me.id }];
  report.rolesChanged = Object.keys(patch).length > 0;
  patch['开始日期'] = todayTs();
  patch['进展'] = '待开始';
  patch['素材生成进展'] = '待开始';
  patch['审阅反馈'] = '未审阅';
  patch['剪辑进度'] = '待开始';
  patch['实际完成日期'] = null;
  report.resetFields = Object.keys(patch);

  await flow.updateFields(rec.recordId, patch);

  let cur = await flow.getRecord(rec.recordId);
  const resetOk =
    cur.progress === '待开始' &&
    cur.stage === '待开始' &&
    cur.review === '未审阅' &&
    cur.trimStage === '待开始' &&
    cur.artist.length === 1 && cur.artist[0].id === me.id &&
    cur.reviewers.length === 1 && cur.reviewers[0].id === me.id &&
    cur.editors.length === 1 && cur.editors[0].id === me.id;
  step('重置 999 集（角色/开始日期/进展三项）', resetOk,
    `进展=${cur.progress} 素材=${cur.stage} 一审=${cur.review} 剪辑=${cur.trimStage}` +
    `${report.rolesChanged ? ' · 角色已改为陈俊杰' : ' · 角色本来就是陈俊杰'}`);

  // 4. 等机器人自动：进展 → 进行中、素材生成进展 → 生成中
  const markAuto = sizeOf(LOG_FILE);
  const w1 = await waitLog(new RegExp(`①自动化：${EPISODE} 集已过开始日期`), { from: markAuto, timeoutMs: 200000 });
  let auto = null;
  if (w1.ok) {
    for (let i = 0; i < 12; i++) {
      auto = await flow.getRecord(rec.recordId);
      if (auto.progress === '进行中' && auto.stage === '生成中') break;
      await sleep(3000);
    }
  }
  const autoOk = !!(auto && auto.progress === '进行中' && auto.stage === '生成中');
  report.autoStart = auto ? { progress: auto.progress, stage: auto.stage, waitedSec: Math.round(w1.waited / 1000) } : null;
  step('机器人自动置「进展=进行中 / 素材生成进展=生成中」', autoOk,
    auto ? `进展=${auto.progress} 素材=${auto.stage}（等了 ${Math.round(w1.waited / 1000)} 秒）` : '等 200 秒没有巡检日志');

  // 5. 待一审 → 等机器人发一审卡片
  const markReview = sizeOf(LOG_FILE);
  await flow.updateFields(rec.recordId, { 素材生成进展: '已粗剪待一审' });
  const w2 = await waitLog(new RegExp(`卡片「一审 ${EPISODE}」已发 \\d+/\\d+ 人`), { from: markReview, timeoutMs: 200000 });
  step('待一审卡片由巡检自动发出', w2.ok, w2.ok ? `等了 ${Math.round(w2.waited / 1000)} 秒` : '等 200 秒没等到「一审 999」卡片');

  // 6. 按钮流程（真改表 + 真发卡片），一步一验
  const actBuf = () => buf.length;
  async function act(a, name, expect, cardPattern) {
    const from = actBuf();
    let res = null;
    try {
      res = await flow.handleCardAction({ a, r: rec.recordId }, me.id, null);
    } catch (e) {
      step(name, false, `按钮回调抛错：${(e && e.message) || e}`);
      return false;
    }
    const got = cardPattern
      ? await waitLog(cardPattern, { source: 'buf', from, timeoutMs: 20000 })
      : { ok: true };
    const now = await flow.getRecord(rec.recordId);
    const pairs = Object.entries(expect || {});
    const bad = pairs.filter(([k, v]) => String(now[k] == null ? '' : now[k]).trim() !== String(v));
    const detail = pairs.map(([k, v]) => `${k}=${now[k]}`).join(' ') +
      (cardPattern ? (got.ok ? ' · 卡片已发' : ' · 卡片没发') : '');
    const toastOk = !res || !res.toast || res.toast.type !== 'error';
    return step(name, got.ok && bad.length === 0 && toastOk, detail);
  }

  // 2026-10-29 对齐 flow.js:695：一审未通过置 审阅反馈=有修改、素材生成进展=修改中（旧断言 修改中/生成中 已过期）
  await act('review_fail', '一审未通过 → 请修改卡片', { review: '有修改', stage: '修改中' },
    new RegExp(`卡片「请修改 ${EPISODE}」已发 \\d+/\\d+ 人`));
  await act('reupload', '修改已上传 → 回到待一审并重发卡', { stage: '已粗剪待一审' },
    new RegExp(`卡片「一审 ${EPISODE}」已发 \\d+/\\d+ 人`));
  await act('review_pass', '一审通过 → 请上传卡片 + 剪辑进度=可剪辑', { review: '通过', trimStage: '可剪辑' },
    new RegExp(`卡片「请上传素材 ${EPISODE}」已发 \\d+/\\d+ 人`));
  await act('uploaded', '素材已上传 → 开始精剪卡片', { stage: '已完成并上传' },
    new RegExp(`卡片「开始精剪 ${EPISODE}」已发 \\d+/\\d+ 人`));
  await act('trim_start', '开始剪辑 → 剪辑进度=剪辑中', { trimStage: '剪辑中' }, null);
  await act('trim_done', '精剪完成 → 剪辑进度=待审片 + 终审卡片', { trimStage: '待审片' },
    new RegExp(`卡片「剪辑终审 ${EPISODE}」已发 \\d+/\\d+ 人`));
  await act('final_view', '查看成片 → 剪辑进度=审片中', { trimStage: '审片中' }, null);
  await act('final_pass', '剪辑通过 → 已定剪 + 进展已完成',
    { review: '通过', trimStage: '已定剪', progress: '已完成' }, null);

  report.steps = steps;
  report.ok = steps.every((s) => s.ok);
  report.durationSec = Math.round((Date.now() - t0) / 1000);
  await finish(report);
})().catch(async (e) => {
  origLog('自检脚本异常：' + ((e && e.stack) || e));
  steps.push({ name: '脚本异常', ok: false, detail: String((e && e.message) || e) });
  await finish({
    version: 1, date: ymd(), startedAt: new Date().toISOString(), episode: EPISODE,
    steps, ok: false, durationSec: 0, error: String((e && e.message) || e),
  });
});

// ---------------------------------------------------------------- 收尾
async function finish(report) {
  try {
    const dir = path.join(ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `selftest-${report.date || ymd()}.json`), JSON.stringify(report, null, 2));
    fs.appendFileSync(path.join(dir, 'selftest-log.jsonl'), JSON.stringify({
      at: report.startedAt, date: report.date, ok: report.ok, skipped: !!report.skipped,
      durationSec: report.durationSec, failed: (report.steps || []).filter((s) => !s.ok).map((s) => s.name),
    }) + '\n');
  } catch (e) {
    /* 写报告失败不影响结论 */
  }

  const failed = (report.steps || []).filter((s) => !s.ok);
  if (report.skipped) {
    origLog(`跳过（非工作日）。报告：logs/selftest-${report.date}.json`);
    process.exit(0);
  }
  if (!NO_NOTIFY && report.me) {
    const head = report.ok
      ? `✅ 每日体检通过（999 集 · ${hms()}）`
      : `❌ 每日体检有 ${failed.length} 项没过（999 集 · ${hms()}）`;
    const lines = [head, ''];
    for (const s of report.steps || []) lines.push(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ' · ' + s.detail : ''}`);
    lines.push('');
    lines.push(report.ok
      ? '表已跑回「已完成」状态，今天的流程正常。'
      : `卡住的地方看 logs/bot.log，报告：logs/selftest-${report.date}.json`);
    // 必须等发完再退出，否则 process.exit 会把还没回来的请求掐掉
    const sent = await sendTextTo(report.me, lines.join('\n')).catch(() => false);
    origLog(sent ? '体检报告已发飞书' : '⚠️ 体检报告没发出去（不影响结论）');
  }
  origLog(report.ok ? '体检通过' : `体检没过：${failed.map((s) => s.name).join('、')}`);
  process.exit(report.ok ? 0 : 1);
}
