/**
 * 每日积分填写提醒
 *
 * 工作日 18:15 往「逆天萌兽制作组」群发一张卡：
 * 把《逆天萌兽3》任务管理表里今天有制作排期的制作师 @ 一遍，
 * 提醒他们去积分统计表填今天消耗的积分。
 *
 * 「今天有制作」的判定（2026-11-10 定，当天改严）：
 *   开始日期 = 今天，且 进展 ≠ 已完成。
 *   自检集（默认 999 集）不算；没有开始日期的记录不算。
 *   （早先按「开始日期 ≤ 今天 ≤ 预计完成日期」算区间，跨天场次会被重复提醒，小熊要求改成只认当天开工。）
 *
 * 配置在 config.json → pointsReminder，每轮现读，改完不用重启。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getClient, sendInteractive, sendCardTo, withTimeout } = require('./feishu');
const { log } = require('./log');
const { allPages } = require('./pagination');
const workday = require('./workday');
const PC = require('./project-context');

const CONFIG_FILE = path.join(cfg.ROOT, 'config.json');

function conf() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).pointsReminder || {};
  } catch (e) {
    return {};
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 当天 00:00:00.000 ~ 23:59:59.999 的时间戳 */
function todayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { start, end: start + 864e5 - 1 };
}

function atList(list) {
  return list.map((p) => (p.id ? `<at id="${p.id}"></at>` : p.name)).join('、');
}

async function fetchAllRecords(base) {
  return allPages(pageToken => getClient().bitable.v1.appTableRecord.search({
    path: { app_token: base.appToken, table_id: base.tableId },
    params: { page_size: 500, page_token: pageToken || undefined }, data: {},
  }), { label: '读任务管理表', timeout: 15000 });
}

/**
 * 读出「今天有制作」的制作师。
 * @returns {Promise<{people: Array<{id:string,name:string,tasks:string[]}>, raw:number}>}
 */
async function collect(c = conf()) {
  const key = c.projectKey || 'nts3';
  const exclude = new Set((c.excludeEpisodes || [999]).map(Number));
  const { start, end } = todayRange();

  return PC.run(key, async () => {
    const base = PC.current().base || {};
    if (!base.appToken || !base.tableId) throw new Error('任务管理表没配（project.base 缺 appToken/tableId）');
    const records = await fetchAllRecords(base);

    const byPerson = new Map();
    let raw = 0;
    for (const r of records) {
      const f = r.fields || {};
      if (String(f['进展'] || '') === '已完成') continue;
      const ep = Number(f['集数']);
      if (!Number.isInteger(ep) || ep <= 0 || exclude.has(ep)) continue;
      const s = typeof f['开始日期'] === 'number' ? f['开始日期'] : null;
      if (s == null) continue; // 没写开工日期的不算「今天有制作」
      if (s < start || s > end) continue; // 只认当天开工
      const scene = Number(f['场次']);
      raw++;
      for (const p of (f['制作师'] || [])) {
        if (!p || !p.id) continue;
        if (!byPerson.has(p.id)) byPerson.set(p.id, { id: p.id, name: p.name || '', tasks: [] });
        const item = byPerson.get(p.id);
        item.tasks.push(`第${ep}集${Number.isInteger(scene) && scene > 0 ? `·${scene}场` : ''}`);
      }
    }

    const people = [...byPerson.values()]
      .map((p) => ({ ...p, tasks: [...new Set(p.tasks)] }))
      .sort((a, b) => b.tasks.length - a.tasks.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return { people, raw };
  });
}

function buildCard(people, c = conf(), opts = {}) {
  const now = new Date();
  const day = `${now.getMonth() + 1}月${now.getDate()}日`;
  const totalTasks = people.reduce((n, p) => n + p.tasks.length, 0);
  const pointsUrl = c.pointsUrl || '';
  const taskUrl = c.taskUrl || '';

  const lines = [
    `今天排期上有制作任务的制作师，收工前把**今天消耗的积分**填进积分统计表。`,
    '',
    `今天共 **${people.length}** 位制作师、**${totalTasks}** 条排期任务：`,
    '',
    ...people.map((p) => `${p.id ? `<at id="${p.id}"></at>` : p.name}　${p.tasks.join('、')}`),
  ];

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    { tag: 'hr' },
  ];

  const actions = [];
  if (pointsUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '去填积分统计' },
      type: 'primary',
      url: pointsUrl,
    });
  }
  if (taskUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '看今天的任务' },
      type: 'default',
      url: taskUrl,
    });
  }
  if (actions.length) elements.push({ tag: 'action', actions });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '工作日 18:15 自动提醒 · 今天没消耗积分可以忽略这条' }],
  });

  if (opts.preview) {
    elements.unshift({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '🔎 **预览**：下面就是正式发到群里的内容，带 @ 的会真的提醒到人。',
      },
    });
  }

  if (opts.test) {
    elements.unshift({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '🧪 **测试卡**：这条是机器人在调试，不用理会；正式提醒每个工作日 18:15 自动发。',
      },
    });
  }

  const prefix = opts.test ? '🧪 测试 · ' : (opts.preview ? '🔎 预览 · ' : '');

  return {
    config: { wide_screen_mode: true },
    header: {
      template: opts.test ? 'yellow' : (opts.preview ? 'grey' : 'orange'),
      title: {
        tag: 'plain_text',
        content: `${prefix}📝 ${day} 积分填写提醒`,
      },
    },
    elements,
  };
}

/**
 * 发一次。
 * @returns {Promise<{sent:boolean, people:number, tasks:number, skipped?:string}>}
 */
async function send(c = conf(), opts = {}) {
  const { people, raw } = await collect(c);
  if (!people.length) {
    log(`积分提醒：今天没有排期中的制作任务（扫到 ${raw} 条符合条件的记录），不发`);
    return { sent: false, people: 0, tasks: 0, skipped: '今天没有制作排期' };
  }
  const openId = opts.openId || '';
  const chatId = opts.chatId || c.chatId;
  if (!openId && !chatId) throw new Error('pointsReminder.chatId 没配，不知道发哪个群');
  const card = buildCard(people, c, { preview: !!opts.preview, test: !!opts.test });
  const sent = openId
    ? await sendCardTo(openId, card)
    : await sendInteractive(chatId, card);
  const tasks = people.reduce((n, p) => n + p.tasks.length, 0);
  log(`积分提醒${sent ? '已发' : '没发出去'}：${people.length} 位制作师（${people.map((p) => p.name).join('、')}），${tasks} 条任务 → ${openId || chatId}`);
  return { sent, people: people.length, tasks, names: people.map((p) => p.name) };
}

/** 给 /积分提醒 命令用的文字概况 */
async function describe(c = conf()) {
  const { people, raw } = await collect(c);
  const wd = await workday.checkWorkday(new Date());
  const lines = [
    `目标群：${c.chatName || ''} ${c.chatId || '（没配）'}`,
    `触发：工作日 ${pad(c.hour ?? 18)}:${pad(c.minute ?? 15)}（今天：${wd.work ? '工作日' : '非工作日 · ' + wd.note}）`,
    `积分统计：${c.pointsUrl || '（没配）'}`,
    `判定：开始日期＝今天、进展≠已完成${(c.excludeEpisodes || [999]).length ? `，排除 ${(c.excludeEpisodes || [999]).join('/')} 集` : ''}`,
    '',
    people.length ? `今天会 @ 的 ${people.length} 位（${raw} 条记录）：` : '今天还没有符合条件的制作排期',
    ...people.map((p) => `· ${p.name}　${p.tasks.join('、')}`),
  ];
  return lines.join('\n');
}

/** 到点没到点：返回 true 时该发；returnWindowMin 内算补发 */
function inWindow(now, hour, minute, graceMin) {
  const since = now.getHours() * 60 + now.getMinutes() - (hour * 60 + minute);
  return since >= 0 && since <= graceMin;
}

/**
 * 定时器：每分钟看一眼，够点就发，一天只发一次。
 * @param {Function} getState 取 state.json
 * @param {Function} saveState 存 state.json
 */
function startScheduler(getState, saveState) {
  const c = conf();
  if (c.enabled === false) {
    log('积分提醒：未开启');
  }
  const hour = Number.isInteger(c.hour) ? c.hour : 18;
  const minute = Number.isInteger(c.minute) ? c.minute : 15;
  const grace = Number.isInteger(c.graceMinutes) ? c.graceMinutes : 45;
  log(`积分提醒：工作日 ${pad(hour)}:${pad(minute)} 发到「${c.chatName || c.chatId}」（错过最多补发 ${grace} 分钟）`);

  let running = false;
  setInterval(async () => {
    if (running) return;
    const now = new Date();
    const confNow = conf();
    if (confNow.enabled === false) return;
    const h = Number.isInteger(confNow.hour) ? confNow.hour : hour;
    const m = Number.isInteger(confNow.minute) ? confNow.minute : minute;
    if (!inWindow(now, h, m, Number.isInteger(confNow.graceMinutes) ? confNow.graceMinutes : grace)) return;

    const key = workday.ymd(now);
    let st;
    try {
      st = getState();
    } catch (e) {
      st = {};
    }
    if (!Array.isArray(st.pointsSent)) st.pointsSent = [];
    if (st.pointsSent.includes(key)) return;

    running = true;
    try {
      const wd = await workday.checkWorkday(now);
      const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
      if (!wd.work) {
        log(`积分提醒：今天${wd.note}，不发`);
        st.pointsSent.push(key);
        if (st.pointsSent.length > 30) st.pointsSent = st.pointsSent.slice(-30);
        saveState();
        return;
      }
      if (late > 0) log(`积分提醒：已经 ${late} 分钟了，补发一次`);
      const result = await send(confNow);
      // 发送失败保留补发资格；没有当天任务才按正常跳过记账。
      if (!result.sent && !result.skipped) return;
      st.pointsSent.push(key);
      if (st.pointsSent.length > 30) st.pointsSent = st.pointsSent.slice(-30);
      saveState();
    } catch (e) {
      log('积分提醒失败：' + ((e && e.message) || e));
    } finally {
      running = false;
    }
  }, 60000).unref();
}

module.exports = { collect, buildCard, send, describe, startScheduler, conf, todayRange, atList };
