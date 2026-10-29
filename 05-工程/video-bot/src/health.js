/**
 * 整点体检（每小时一次，发卡给陈俊杰本人）
 *
 * 查三块：
 *   1. 多维表格链路：能不能读表（token / 权限 / 网络）、字段还在不在、今天的表更自动化有没有报错
 *   2. 上传分秒帧链路：bsk 能不能用（驱动 Chrome 上传靠它）、目标项目配没配、上次上传是什么时候
 *   3. 机器人自身：长连接有没有在收事件、今天的全流程自检过没过
 *
 * 只读为主，不改任何表数据。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cfg = require('./config');
const bitable = require('./bitable');
const flow = require('./flow');
const target = require('./target');
const C = require('./cards');
const { getClient, withTimeout, sendCardTo, sendInteractive } = require('./feishu');
const { log, errorLines } = require('./log');

const B = cfg.BASE || {};
const OWNER_OPEN_ID = (cfg.INBOX && cfg.INBOX.notifyOpenId) || '';

// 最近一次体检结果（同事点「通知小熊」时要带上一并汇报）
let lastReport = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 多维表格：读表 + 字段完整性（审阅流程要用的那几个单选必须还在） */
async function checkBitable() {
  const t0 = Date.now();
  try {
    const fields = await withTimeout(bitable.listFields(), 10000, '字段列表');
    const need = ['集数', '进展', '素材生成进展', '审阅反馈', '剪辑进度', '制作师', '审片人', '剪辑师', '开始日期'];
    const names = fields.map((f) => f.name);
    const missing = need.filter((n) => !names.includes(n));
    const ms = Date.now() - t0;

    let total = null;
    try {
      const res = await withTimeout(getClient().bitable.v1.appTableRecord.search({
        path: { app_token: B.appToken, table_id: B.tableId },
        params: { page_size: 1 },
        data: {},
      }), 10000, '读表');
      total = (res.data || res).total;
    } catch (e) {
      return { name: '多维表格读取', ok: false, detail: `读记录失败：${(e && e.message) || e}` };
    }

    if (missing.length) {
      return { name: '多维表格读取', ok: false, detail: `少字段：${missing.join('、')}` };
    }
    if (total == null || total === 0) {
      return { name: '多维表格读取', ok: false, detail: '记录数为 0，表被清了还是换了表？' };
    }
    return {
      name: '多维表格读取',
      ok: true,
      detail: `${names.length} 个字段、${total} 条记录，${ms} ms`,
    };
  } catch (e) {
    return { name: '多维表格读取', ok: false, detail: `${(e && e.message) || e}` };
  }
}

/** 表格自动化：最近一次巡检有没有成功、有没有报错 */
function checkFlowTick() {
  const t = flow.getLastTick();
  if (!t || !t.at) return { name: '表格自动化巡检', ok: false, detail: '启动后还没跑过巡检' };
  const ageMin = Math.round((Date.now() - t.at) / 60000);
  const s = t.stats || {};
  const failed = s.failed || 0;
  const okFresh = ageMin <= (cfg.FLOW && cfg.FLOW.tickMinutes ? cfg.FLOW.tickMinutes * 3 : 5) && failed === 0;
  return {
    name: '表格自动化巡检',
    ok: okFresh,
    detail: `${failed ? `最近一次有 ${failed} 项失败 · ` : ''}扫 ${s.scanned ?? '-'} 条 / 开工 ${s.started ?? '-'} / 发卡 ${s.reviewed ?? '-'}${s.trimmed ? ' / 精剪卡 ' + s.trimmed : ''}（${ageMin} 分钟前）`,
  };
}

/** 今天的每日自检结果（早上 8:30 那次） */
function checkDailySelfTest() {
  const file = path.join(cfg.ROOT, 'logs', `selftest-${new Date().toLocaleDateString('sv-SE')}.json`);
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r.skipped) return { name: '每日 8:30 自检', ok: true, detail: `今天非工作日，已跳过（${r.workday ? r.workday.note : ''}）` };
    const bad = (r.steps || []).filter((s) => !s.ok).map((s) => s.name);
    return {
      name: '每日 8:30 自检',
      ok: !!r.ok,
      detail: bad.length ? `未通过：${bad.join('、')}` : `通过（${r.durationSec || 0} 秒）`,
    };
  } catch (e) {
    return { name: '每日 8:30 自检', ok: false, detail: '今天还没跑（或报告缺失）' };
  }
}

/** bsk：上传分秒帧靠它驱动本机 Chrome */
function checkBsk() {
  try {
    const r = spawnSync('/Users/fanxiaoli/.local/bin/bsk', ['status', '--json'], {
      timeout: 8000,
      encoding: 'utf8',
      env: { ...process.env, BSK_AUTO_START: '0' },
    });
    if (r.error) return { name: '浏览器服务 bsk', ok: false, detail: `跑不起来：${r.error.message}` };
    if (r.status !== 0) return { name: '浏览器服务 bsk', ok: false, detail: `退出码 ${r.status}` };
    let j = null;
    try { j = JSON.parse(r.stdout); } catch (e) { /* 忽略 */ }
    return { name: '浏览器服务 bsk', ok: true, detail: j && j.running === false ? '在跑（自己说没跑，奇怪）' : '在跑' };
  } catch (e) {
    return { name: '浏览器服务 bsk', ok: false, detail: (e && e.message) || String(e) };
  }
}

function checkTarget() {
  try {
    const t = target.getTarget();
    if (!t || !t.projectUrl) return { name: '分秒帧目标', ok: false, detail: '还没配目标项目（/target <链接>）' };
    return { name: '分秒帧目标', ok: true, detail: t.projectUrl };
  } catch (e) {
    return { name: '分秒帧目标', ok: false, detail: (e && e.message) || String(e) };
  }
}

function checkDisk() {
  try {
    fs.mkdirSync(cfg.DOWNLOAD_DIR, { recursive: true });
    const probe = path.join(cfg.DOWNLOAD_DIR, '.healthcheck');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return { name: '下载目录可写', ok: true, detail: cfg.DOWNLOAD_DIR };
  } catch (e) {
    return { name: '下载目录可写', ok: false, detail: (e && e.message) || String(e) };
  }
}

/** meta 由 index.js 提供：{ lastEventAt, lastUpload } */
function checkRuntime(meta) {
  const ev = (meta && meta.lastEventAt) || 0;
  const ageMin = ev ? Math.round((Date.now() - ev) / 60000) : -1;
  return {
    name: '长连接在线',
    ok: true,
    detail: ageMin < 0 ? '启动后还没收到任何事件（没人发消息也正常）' : `最近一次事件 ${ageMin} 分钟前`,
  };
}

function checkLastUpload(meta) {
  const u = meta && meta.lastUpload;
  if (!u || !u.at) return { name: '最近一次上传', ok: true, detail: '今天还没有人上传过' };
  const ageMin = Math.round((Date.now() - u.at) / 60000);
  return {
    name: '最近一次上传',
    ok: true,
    detail: `${u.file}（${ageMin} 分钟前，${u.ok ? '成功' : '失败'}）`,
  };
}

/** 跑一遍所有检查，返回 { ok, checks } */
async function probe(meta) {
  const checks = [];
  checks.push(await checkBitable());
  checks.push(checkFlowTick());
  checks.push(checkDailySelfTest());
  checks.push(checkBsk());
  checks.push(checkTarget());
  checks.push(checkDisk());
  checks.push(checkRuntime(meta));
  checks.push(checkLastUpload(meta));
  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

/** 组装体检卡 */
async function buildCard(meta, why) {
  const { ok, checks } = await probe(meta);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lines = [ok ? '全部正常' : `有 ${checks.filter((c) => !c.ok).length} 项不对劲`, ''];
  for (const c of checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.name} · ${c.detail}`);
  lines.push('');
  if (ok) {
    lines.push('心情：放心干活　详细日志在 logs/bot.log');
  } else {
    lines.push('心情：看上面标 ✗ 的　详细日志在 logs/bot.log');
    lines.push('');
    lines.push('点「通知小熊重启机器人」＝告诉他这边出问题了；他点重启后我会回来通知你。注意：重启会中断正在传的文件，需要重新传一次。');
  }

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
  ];
  if (!ok) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '通知小熊重启机器人' },
          type: 'primary',
          value: { a: 'notify_owner_fix', r: 'self' },
        },
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: `${ok ? '✅' : '❌'} ${hhmm} 机器人体检${why ? '（' + why + '）' : ''}` },
    },
    elements,
  };
  lastReport = { ok, checks, at: Date.now() };
  return { ok, checks, card };
}

/** 发到某个会话（手动 /health 用：谁发的就回给谁） */
async function reportTo(chatId, meta, why) {
  const { ok, checks, card } = await buildCard(meta, why);
  const sent = await withTimeout(sendInteractive(chatId, card), 10000, '发体检卡');
  log(`体检卡${sent ? '已发到会话' : '没发出去'}：${ok ? '全部正常' : checks.filter((c) => !c.ok).map((c) => c.name).join('、')}`);
  return { sent, ok };
}

/** 发到本人（整点自动那次） */
async function report(meta, why) {
  const { ok, checks, card } = await buildCard(meta, why);
  if (!OWNER_OPEN_ID) {
    log('整点体检：没配 inbox.notifyOpenId，发不出去');
    return false;
  }
  const sent = await withTimeout(sendCardTo(OWNER_OPEN_ID, card), 10000, '发体检卡');
  log(`整点体检${sent ? '已发' : '没发出去'}：${ok ? '全部正常' : checks.filter((c) => !c.ok).map((c) => c.name).join('、')}`);
  return sent;
}

/** 最近一次体检里没过的项（没有就现跑一次） */
async function failingChecks() {
  if (lastReport && Date.now() - lastReport.at < 10 * 60 * 1000) {
    return (lastReport.checks || []).filter((c) => !c.ok);
  }
  const { checks } = await probe({ lastEventAt: 0, lastUpload: null });
  return checks.filter((c) => !c.ok);
}

/**
 * 「通知重启」卡片：发给陈俊杰本人
 * 内容 = 哪些功能坏了 + 最近的报错日志 + 谁反馈的 + 一个「重启机器人」按钮
 */
async function buildOwnerFixCard({ reporterOpenId, reporterChatId }) {
  const bad = await failingChecks();
  const logs = errorLines(12);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines = [
    '有人点了「通知小熊重启机器人」，下面是现场情况：',
    '',
    `**反馈人**：${reporterOpenId ? `<at id="${reporterOpenId}"></at>` : '（未知）'}`,
    `**出问题的功能**：${bad.length ? bad.map((c) => `${c.name}（${c.detail}）`).join('；') : '（刚重新体检了一遍，没抓到失败项）'}`,
    '',
    '**最近的错误日志**：',
    '```',
    ...(logs.length ? logs.map((l) => l.replace(/\[\d{4}\/\d{2}\/\d{2} [^\]]+\]\s*/, '')) : ['（日志里没抓到报错行）']),
    '```',
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `🚨 ${hhmm} 有人报告机器人出问题了` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '重启机器人' },
            type: 'primary',
            value: { a: 'restart_bot', r: 'self' },
          },
        ],
      },
    ],
  };
}

module.exports = { probe, buildCard, buildOwnerFixCard, report, reportTo };

