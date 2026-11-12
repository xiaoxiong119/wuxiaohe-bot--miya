'use strict';
/**
 * 进展跟踪与周报（《逆天萌兽3》多维表格）
 *
 *   每日快照 → 事件流水 → 周报 / 日报
 *
 * 为什么要有它：
 *   多维表格只存「当前状态」，没有变更历史。要看「这周谁推进了什么」，
 *   只能自己按天采样、把两次采样之间的差异记成事件。周报就是事件流水的汇总。
 *
 * 数据落盘：
 *   reports/weekly-track/snapshots/YYYY-MM-DD.json   当天最后一次采样的全表状态
 *   reports/weekly-track/events.jsonl                每次采样 diff 出来的变更事件（只追加）
 *   reports/daily/日报_YYYY-MM-DD_vNNN.md            当日变化简报
 *   reports/weekly/周报_YYYY-Www_vNNN.md             每人本周工作记录
 *
 * 用法：
 *   node scripts/weekly-track.js snapshot            采一次（静默）
 *   node scripts/weekly-track.js daily               采 + 出今日日报
 *   node scripts/weekly-track.js report              出本周周报（不发）
 *   node scripts/weekly-track.js report --send-weekly  出周报并发给小熊预览
 *   node scripts/weekly-track.js report --send-group   出周报并发到群（需小熊明确同意后才用）
 */
const fs = require('fs');
const path = require('path');

const cfg = require('../src/config');
const ROOT = cfg.ROOT;
const { log } = require('../src/log');

const TRACK_DIR = path.join(ROOT, 'reports', 'weekly-track');
const SNAP_DIR = path.join(TRACK_DIR, 'snapshots');
const EVENT_FILE = path.join(TRACK_DIR, 'events.jsonl');
const DAILY_DIR = path.join(ROOT, 'reports', 'daily');
const WEEKLY_DIR = path.join(ROOT, 'reports', 'weekly');

const { allPages } = require('../src/pagination');
const { writeJson } = require('../src/json-file');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const project = (raw.sceneProjects || []).find(p => p.key === 'nts3');
const XIAOXIONG = cfg.INBOX?.notifyOpenId || '';
const MAIN = { appToken: project?.base?.appToken || '', tableId: project?.base?.tableId || '', url: project?.tableUrl || raw.scheduleSync?.targetUrl || '' };
const POINTS = { appToken: raw.scheduleSync?.appToken || MAIN.appToken, tableId: raw.scheduleSync?.pointsTableId || '' };

const F = {
  ep: '集数',
  scene: '场次',
  sceneName: '场景',
  artists: '制作师',
  editors: '剪辑师',
  reviewers: '审片人',
  progress: '进展',
  stage: '素材生成进展',
  review: '审阅反馈',
  trim: '剪辑进度',
  second: '二轮审阅反馈',
  delay: '是否延期',
  start: '开始日期',
  due: '预计完成日期',
  done: '实际完成日期',
  type: '剧集类型',
  segment: '排期分段',
};

/** 按字段顺序判断「推进了还是退回了」，周报里加箭头用 */
const PROGRESS_ORDER = {
  素材生成进展: ['待开始', '生成中', '修改中', '已粗剪待一审', '已完成并上传'],
  剪辑进度: ['待开始', '可剪辑', '剪辑中', '待审片', '审片中', '已定剪'],
  进展: ['待开始', '进行中', '已完成'],
  审阅反馈: ['未审阅', '有修改', '通过'],
  二轮审阅反馈: ['修改', '重做', '通过'],
};

const STATUS_FIELDS = ['进展', '素材生成进展', '审阅反馈'];

// ------------------------------------------------------------------ 工具

function mkdirs() {
  for (const d of [TRACK_DIR, SNAP_DIR, DAILY_DIR, WEEKLY_DIR]) fs.mkdirSync(d, { recursive: true });
}

function flat(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flat).join('');
  if (typeof v === 'object') {
    if (Array.isArray(v.value)) return v.value.map(flat).join('');
    return v.text || v.name || '';
  }
  return String(v);
}

function persons(v) {
  let arr = v;
  if (arr && typeof arr === 'object' && !Array.isArray(arr)) arr = arr.value;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => (typeof p === 'string' ? { id: '', name: p } : { id: p.id || '', name: p.name || p.en_name || '' }))
    .filter((p) => p.name);
}

function ymd(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(d);
}
function dstr(ms) { return typeof ms === 'number' && ms ? ymd(new Date(ms)) : ''; }

/** ISO 周：返回 { year, week, start(周一), end(周日), label } */
function isoWeek(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay() || 7; // 周一=1
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow - 1));
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.floor(((thursday - jan1) / 864e5) / 7) + 1;
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { year, week, start: ymd(monday), end: ymd(sunday), label: `${year}-W${String(week).padStart(2, '0')}` };
}

function inRange(dateStr, start, end) {
  return dateStr >= start && dateStr <= end;
}

function md(weekday) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return names[new Date(weekday + 'T00:00:00').getDay()];
}

/** 同一天里同一文件重跑 → 版本号递增，不覆盖旧文件 */
function nextVersion(dir, prefix, ext = '.md') {
  fs.mkdirSync(dir, { recursive: true });
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)${ext.replace('.', '\\.')}$`).exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}_v${String(max + 1).padStart(3, '0')}${ext}`;
}

// ------------------------------------------------------------------ 读表

async function readTable(appToken, tableId) {
  if (!appToken || !tableId) throw new Error('第三季报表数据源未配置，请核对 config.json');
  const c = require('../src/feishu').getClient();
  return allPages(token => c.bitable.v1.appTableRecord.search({
    path: {app_token: appToken, table_id: tableId},
    params: {page_size:500, page_token:token}, data:{},
  }), {label:'读周报数据',limit:30});
}

function normalize(it) {
  const f = it.fields || {};
  const artists = persons(f[F.artists]);
  const editors = persons(f[F.editors]);
  const reviewers = persons(f[F.reviewers]);
  return {
    id: it.record_id,
    ep: flat(f[F.ep]),
    scene: flat(f[F.scene]),
    sceneName: flat(f[F.sceneName]),
    artists: artists.map((p) => p.name),
    editors: editors.map((p) => p.name),
    reviewers: reviewers.map((p) => p.name),
    progress: flat(f[F.progress]),
    stage: flat(f[F.stage]),
    review: flat(f[F.review]),
    trim: flat(f[F.trim]),
    second: flat(f[F.second]),
    delay: flat(f[F.delay]),
    start: dstr(f[F.start]),
    due: dstr(f[F.due]),
    done: dstr(f[F.done]),
    type: flat(f[F.type]),
    segment: flat(f[F.segment]),
  };
}

async function readAll() {
  const rows = await readTable(MAIN.appToken, MAIN.tableId);
  const map = new Map();
  for (const it of rows) {
    const r = normalize(it);
    // 999 是自检专用集，不进报表
    if (Number(r.ep) === 999) continue;
    map.set(r.id, r);
  }
  return map;
}

async function readPoints() {
  try {
    const rows = await readTable(POINTS.appToken, POINTS.tableId);
    return rows.map((it) => {
      const f = it.fields || {};
      return {
        ep: flat(f['集数']),
        scene: flat(f['场次']),
        total: Number(flat(f['单集总计'])) || 0,
        maker: (persons(f['制作师'])[0] || {}).name || '',
      };
    });
  } catch (e) {
    log(`积分表读取失败（周报里积分段留空）：${e.message}`);
    return [];
  }
}

// ------------------------------------------------------------------ 快照与事件

function loadLastSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TRACK_DIR, 'last.json'), 'utf8'));
  } catch (e) {
    // 找最近的一个快照文件兜底
    try {
      const files = fs.readdirSync(SNAP_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      if (!files.length) return null;
      return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, files[files.length - 1]), 'utf8'));
    } catch (e2) {
      return null;
    }
  }
}

function taskLabel(r) {
  return `${r.ep ? `第${r.ep}集` : '?'}${r.scene ? `-${r.scene}` : ''}`;
}

function diffRecords(prev, cur, at) {
  const date = ymd(new Date(at));
  const events = [];
  const base = (r) => ({
    at,
    date,
    recordId: r.id,
    task: taskLabel(r),
    sceneName: r.sceneName,
    artists: r.artists,
    editors: r.editors,
  });

  if (prev) {
    for (const [id, r] of cur) {
      const old = prev.records[id];
      if (!old) {
        events.push({ ...base(r), kind: 'add', field: '记录', from: '', to: '新建' });
        continue;
      }
      if (old.artists.join('/') !== r.artists.join('/')) {
        events.push({ ...base(r), kind: 'assign', field: '制作师', from: old.artists.join('、'), to: r.artists.join('、') });
      }
      for (const f of STATUS_FIELDS) {
        const key = { 进展: 'progress', 素材生成进展: 'stage', 审阅反馈: 'review', 剪辑进度: 'trim', 二轮审阅反馈: 'second' }[f];
        if ((old[key] || '') !== (r[key] || '')) {
          events.push({ ...base(r), kind: 'status', field: f, from: old[key] || '空', to: r[key] || '空' });
        }
      }
      if ((old.done || '') !== (r.done || '')) {
        events.push({ ...base(r), kind: 'date', field: '实际完成日期', from: old.done || '空', to: r.done || '空' });
      }
    }
    for (const [id, r] of Object.entries(prev.records)) {
      if (!cur.has(id) && Number(r.ep) !== 999) events.push({ ...base(r), kind: 'remove', field: '记录', from: taskLabel(r), to: '删除' });
    }
  }
  return events;
}

/** 采一次样：写 last.json + 当日快照 + 追加事件 */
async function snapshot(quiet) {
  mkdirs();
  const cur = await readAll();
  const at = new Date().toISOString();
  const date = ymd();

  const prev = loadLastSnapshot();
  const prevDate = prev && prev.takenAt ? prev.takenAt.slice(0, 10) : '';

  // 跨天时，上一天的 last 已经是历史，diff 只跟「今天内的上一次采样」比才有意义；
  // 但跨天第一次采样也要能发现隔夜变化 → 照样比，事件记在今天。
  const events = diffRecords(prev, cur, at);

  const payload = {
    takenAt: at,
    date,
    count: cur.size,
    records: Object.fromEntries(cur),
  };

  // 事件按「同一天同一任务同一字段」合并：只保留当天最后一次的 to，
  // 但事件流水保留原始逐条（周报要看推进过程），这里全量追加。
  if (events.length) {
    fs.appendFileSync(EVENT_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  writeJson(path.join(SNAP_DIR, `${date}.json`), payload);
  writeJson(path.join(TRACK_DIR, 'last.json'), payload);

  if (!quiet) {
    console.log(`快照 ${date}：${cur.size} 条记录，新增事件 ${events.length} 条${prevDate && prevDate !== date ? `（上一份快照 ${prevDate}）` : ''}`);
  }
  return { date, count: cur.size, events, records: cur };
}

function loadEvents() {
  try {
    return fs.readFileSync(EVENT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter((e) => e && !/第999集/.test(e.task || ''));
  } catch (e) {
    return [];
  }
}

/** 同一天同一任务的同字段只留最后一条，避免周报里刷屏 */
function condense(events) {
  const seen = new Map();
  for (const e of events) {
    const k = `${e.date}|${e.recordId}|${e.field}`;
    if (seen.has(k)) {
      const old = seen.get(k);
      old.to = e.to;
      if (e.kind === 'remove') old.kind = 'remove';
    } else {
      seen.set(k, { ...e });
    }
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------ 日报

function buildDaily(date, events) {
  const days = events.filter((e) => e.date === date);
  const cur = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `${date}.json`), 'utf8'));
  const recs = Object.values(cur.records);

  const uploadedTodayIds = new Set(days.filter((e) => e.field === '素材生成进展' && e.to === '已完成并上传').map((e) => e.recordId));
  const doneToday = recs.filter((r) => uploadedTodayIds.has(r.id));
  const byArtist = new Map();
  for (const e of condense(days)) {
    const names = e.artists.length ? e.artists : ['（未指派）'];
    for (const n of names) {
      if (!byArtist.has(n)) byArtist.set(n, []);
      byArtist.get(n).push(e);
    }
  }

  const w = isoWeek(new Date(`${date}T00:00:00`));
  const schedWeek = recs.filter((r) => inRange(r.start, w.start, w.end));
  const dueWeek = recs.filter((r) => inRange(r.due, w.start, w.end));
  const dueToday = recs.filter((r) => r.due === date);
  const dueTodayDone = dueToday.filter((r) => r.stage === '已完成并上传' || r.progress === '已完成');

  const tally = (key) => {
    const m = new Map();
    for (const r of recs) {
      const v = r[key] || '（空）';
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、');
  };

  const uploadedWeekIds = new Set(
    events.filter((e) => inRange(e.date, w.start, w.end) && e.field === '素材生成进展' && e.to === '已完成并上传').map((e) => e.recordId)
  );

  const lines = [];
  lines.push(`# 逆天萌兽3 · 进展日报 ${date}（${md(date)}）`);
  lines.push('');
  lines.push(`- 全表记录：${recs.length} 条（不含 999 自检集）`);
  lines.push(`- 今日变更：${condense(days).length} 条｜今日完成上传：${doneToday.length} 条`);
  lines.push(`- 今日到期：${dueToday.length} 场，其中已完成上传 ${dueTodayDone.length} 场`);
  lines.push(`- 本周排期 ${schedWeek.length} 场｜应完成 ${dueWeek.length} 场｜完成上传 ${uploadedWeekIds.size} 场`);
  lines.push('');
  lines.push('## 当前状态分布（制作师维度）');
  lines.push('');
  lines.push(`- 素材生成：${tally('stage')}`);
  lines.push(`- 审阅反馈：${tally('review')}`);
  lines.push('');
  if (!byArtist.size) {
    lines.push('## 今日变化');
    lines.push('');
    lines.push('今天表里没有状态变化。');
  } else {
    lines.push('## 今日变化（按制作师）');
    for (const [name, list] of [...byArtist.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push('');
      lines.push(`**${name}**（${list.length} 条）`);
      for (const e of list.sort((a, b) => a.at.localeCompare(b.at))) {
        lines.push(`- ${e.task}${e.sceneName ? ` · ${e.sceneName}` : ''} · ${e.field}：${e.from} → ${e.to}`);
      }
    }
  }
  if (doneToday.length) {
    lines.push('');
    lines.push('## 今日完成');
    for (const r of doneToday) {
      lines.push(`- ${taskLabel(r)}${r.sceneName ? ` · ${r.sceneName}` : ''}（${r.artists.join('、') || '未指派'}）`);
    }
  }
  lines.push('');
  lines.push(`> 数据源：${MAIN.url}`);
  return lines.join('\n');
}

/** 飞书私聊用的纯文本版（不带 markdown 符号） */
function buildDailyBrief(date, events) {
  const days = events.filter((e) => e.date === date);
  const cur = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `${date}.json`), 'utf8'));
  const recs = Object.values(cur.records);
  const w = isoWeek(new Date(`${date}T00:00:00`));
  const schedWeek = recs.filter((r) => inRange(r.start, w.start, w.end));
  const doneWeek = new Set(
    events
      .filter((e) => inRange(e.date, w.start, w.end) && e.field === '素材生成进展' && e.to === '已完成并上传')
      .map((e) => e.recordId)
  );
  const dueToday = recs.filter((r) => r.due === date);
  const uploadedTodayIds = new Set(days.filter((e) => e.field === '素材生成进展' && e.to === '已完成并上传').map((e) => e.recordId));
  const doneToday = recs.filter((r) => uploadedTodayIds.has(r.id));
  const changes = condense(days);

  const L = [];
  L.push(`逆天萌兽3 · 进展日报 ${date}（${md(date)}）`);
  L.push(`今日变更 ${changes.length} 条 · 今日完成上传 ${doneToday.length} 条 · 今日到期 ${dueToday.length} 场`);
  L.push(`本周排期 ${schedWeek.length} 场 / 本周完成上传 ${doneWeek.size} 场`);
  L.push('');
  if (!changes.length) {
    L.push('今天表里没有状态变化。');
  } else {
    const byArtist = new Map();
    for (const e of changes) {
      for (const n of (e.artists.length ? e.artists : ['（未指派）'])) {
        if (!byArtist.has(n)) byArtist.set(n, []);
        byArtist.get(n).push(e);
      }
    }
    for (const [name, list] of [...byArtist.entries()].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`${name}：${list.length} 条`);
      for (const e of list.slice(0, 8)) L.push(`· ${e.task} ${e.field} ${e.from}→${e.to}`);
      if (list.length > 8) L.push(`· ……另有 ${list.length - 8} 条`);
    }
  }
  L.push('');
  L.push('（明细见 reports/daily/ 当日文件）');
  return L.join('\n');
}


// ------------------------------------------------------------------ 周报

/** [1,2,3,5,7,8] → 第1-3集、第5集、第7-8集 */
function compressEps(eps) {
  const nums = [...new Set(eps.map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  if (!nums.length) return '';
  const parts = [];
  let s = nums[0];
  let prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(s === prev ? `第${s}集` : `第${s}-${prev}集`);
    s = prev = n;
  }
  parts.push(s === prev ? `第${s}集` : `第${s}-${prev}集`);
  return parts.join('、');
}

function progressArrow(field, from, to) {
  const order = PROGRESS_ORDER[field];
  if (!order) return '';
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a >= 0 && b >= 0) return b > a ? '↑' : b < a ? '↓' : '';
  return '';
}

function buildWeekly(today = new Date()) {
  const w = isoWeek(today);
  const events = loadEvents();
  const cur = loadLastSnapshot();
  if (!cur) throw new Error('还没有任何快照，先跑一次 snapshot');
  const recs = Object.values(cur.records);

  const weekEvents = condense(events.filter((e) => inRange(e.date, w.start, w.end)));

  const startedThisWeek = recs.filter((r) => inRange(r.start, w.start, w.end));

  // 制作师视角的「完成」= 素材生成进展走到「已完成并上传」。
  // 表里没有这个状态的日期字段，只能用事件流水捕捉它是什么时候变的；
  // 兜底再看实际完成日期有没有落在本周。
  const uploadedIds = new Set(
    weekEvents.filter((e) => e.field === '素材生成进展' && e.to === '已完成并上传').map((e) => e.recordId)
  );
  const doneThisWeek = recs.filter(
    (r) => uploadedIds.has(r.id) || (r.stage === '已完成并上传' && inRange(r.done, w.start, w.end))
  );

  const isDone = (r) => r.stage === '已完成并上传' || r.progress === '已完成';
  const overdue = recs.filter((r) => r.due && r.due < ymd(today) && !isDone(r));

  const names = new Set();
  for (const r of recs) r.artists.forEach((n) => names.add(n));

  const byPerson = new Map([...names].map((n) => [n, { events: [], done: [] }]));
  const ensure = (n) => {
    if (!byPerson.has(n)) byPerson.set(n, { events: [], done: [] });
    return byPerson.get(n);
  };

  for (const e of weekEvents) {
    const targets = e.artists.length ? e.artists : ['（未指派）'];
    for (const n of targets) ensure(n).events.push(e);
  }
  for (const r of doneThisWeek) {
    for (const n of r.artists.length ? r.artists : ['（未指派）']) ensure(n).done.push(r);
  }

  const L = [];
  L.push(`# 《逆天萌兽3》制作周报 · ${w.label}`);
  L.push('');
  L.push(`周期：${w.start}（周一）~ ${w.end}（周日）｜生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  L.push('');
  L.push('## 本周总览');
  L.push('');
  L.push(`- 全表任务：${recs.length} 条（按集-场）`);
  L.push(`- 本周排期（开始日期落在本周）：${startedThisWeek.length} 条`);
  L.push(`- 本周应完成（预计完成日期落在本周）：${recs.filter((r) => inRange(r.due, w.start, w.end)).length} 条`);
  L.push(`- 本周完成上传（素材生成进展 → 已完成并上传）：${doneThisWeek.length} 条`);
  L.push(`- 本周状态变更：${weekEvents.length} 项`);
  L.push(`- 逾期未完成：${overdue.length} 条`);
  L.push(`- 涉及制作师：${[...byPerson.keys()].filter((n) => n !== '（未指派）').length} 人`);
  L.push('');
  L.push('## 各制作师本周记录');
  L.push('');

  const todayStr = ymd(today);
  const recsByArtist = new Map();
  for (const r of recs) {
    for (const n of (r.artists.length ? r.artists : ['（未指派）'])) {
      if (!recsByArtist.has(n)) recsByArtist.set(n, []);
      recsByArtist.get(n).push(r);
    }
  }

  const order = [...byPerson.entries()].sort((a, b) => (b[1].events.length + b[1].done.length) - (a[1].events.length + a[1].done.length));
  for (const [name, data] of order) {
    const mine = recsByArtist.get(name) || [];
    const sched = mine.filter((r) => inRange(r.start, w.start, w.end));
    const shouldFinish = mine.filter((r) => inRange(r.due, w.start, w.end));
    const wip = mine.filter((r) => r.start && r.start <= todayStr && !isDone(r));
    const overdueMine = overdue.filter((r) => (r.artists.length ? r.artists : ['（未指派）']).includes(name));
    const total = data.events.length + data.done.length + sched.length + wip.length + overdueMine.length;
    if (!total) continue;
    L.push(`### ${name}`);
    L.push('');
    L.push(`- 本周排期 ${sched.length} 场${sched.length ? `（${compressEps(sched.map((r) => r.ep))}）` : ''}｜应完成 ${shouldFinish.length} 场｜完成上传 ${data.done.length} 场｜在手未完成 ${wip.length} 场`);
    if (data.events.length) L.push(`- 本周状态变更 ${data.events.length} 项`);
    if (sched.length) {
      const byDay = new Map();
      for (const r of [...sched].sort((a, b) => a.start.localeCompare(b.start))) {
        if (!byDay.has(r.start)) byDay.set(r.start, []);
        byDay.get(r.start).push(r);
      }
      L.push(`- 排期明细：${[...byDay.entries()].map(([d, list]) => `${d.slice(5)} ${compressEps(list.map((r) => r.ep))}`).join('；')}`);
    }
    if (overdueMine.length) {
      L.push(`- 逾期未完成 ${overdueMine.length} 场：${overdueMine.slice(0, 6).map((r) => taskLabel(r)).join('、')}${overdueMine.length > 6 ? ' 等' : ''}`);
    }
    L.push('');

    const byTask = new Map();
    for (const e of data.events) {
      const k = `${e.task}|${e.sceneName}`;
      if (!byTask.has(k)) byTask.set(k, []);
      byTask.get(k).push(e);
    }
    if (byTask.size) {
      L.push('进度推进：');
      for (const [k, list] of byTask) {
        const [task, scene] = k.split('|');
        const steps = list
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((e) => `${e.field} ${e.from}→${e.to}${progressArrow(e.field, e.from, e.to)}（${e.date.slice(5)}）`)
          .join('；');
        L.push(`- ${task}${scene ? ` · ${scene}` : ''}｜${steps}`);
      }
      L.push('');
    }
    if (data.done.length) {
      L.push(`本周完成上传：${data.done.map((r) => `${taskLabel(r)}${r.sceneName ? `·${r.sceneName}` : ''}`).join('、')}`);
      L.push('');
    }
  }

  const emptyPeople = [...recsByArtist.entries()].filter(([n, mine]) => {
    const d = byPerson.get(n) || { events: [], done: [] };
    const sched = mine.filter((r) => inRange(r.start, w.start, w.end));
    return !(d.events.length + d.done.length + sched.length);
  });
  if (emptyPeople.length) {
    L.push(`本周表内无变化：${emptyPeople.map(([n]) => n).filter((n) => n !== '（未指派）').join('、')}`);
    L.push('');
  }

  if (overdue.length) {
    L.push('## 逾期未完成');
    L.push('');
    for (const r of overdue.slice(0, 40)) {
      L.push(`- ${taskLabel(r)}${r.sceneName ? ` · ${r.sceneName}` : ''}（${r.artists.join('、') || '未指派'}）预计 ${r.due}，当前 ${r.stage || r.progress || '未填'}`);
    }
    if (overdue.length > 40) L.push(`- ……共 ${overdue.length} 条`);
    L.push('');
  }

  L.push('---');
  const dueThisWeek = recs.filter((r) => inRange(r.due, w.start, w.end)).length;
  if (dueThisWeek > doneThisWeek.length) {
    L.push(`> 提醒：本周应完成 ${dueThisWeek} 场，表里完成上传 ${doneThisWeek.length} 场。若实际有推进但没更新表，周报会失真 —— 建议收工前更新「素材生成进展」。`);
  }
  L.push(`> 说明：只统计制作师的素材进展（不含剪辑）；状态变化来自每日快照比对，一天多次变化只记首尾；完成以上传到「已完成并上传」为准，开工以开始日期为准。`);
  L.push(`> 数据源：${MAIN.url}`);
  return { text: L.join('\n'), week: w, stats: { records: recs.length, events: weekEvents.length, done: doneThisWeek.length, overdue: overdue.length } };
}

// ------------------------------------------------------------------ CLI

async function main() {
  const cmd = process.argv[2] || 'snapshot';
  const flags = new Set(process.argv.slice(3));

  if (cmd === 'snapshot') {
    const r = await snapshot(false);
    if (r.events.length) {
      for (const e of r.events.slice(0, 20)) console.log(`  ${e.task} ${e.field}：${e.from} → ${e.to}`);
      if (r.events.length > 20) console.log(`  …… 共 ${r.events.length} 条`);
    }
    return;
  }

  if (cmd === 'daily') {
    const r = await snapshot(true);
    const text = buildDaily(r.date, loadEvents());
    const file = path.join(DAILY_DIR, nextVersion(DAILY_DIR, `日报_${r.date}`));
    fs.writeFileSync(file, text);
    console.log(`日报：${file}`);
    console.log(text.split('\n').slice(0, 14).join('\n'));
    if (flags.has('--send')) {
      const { sendTextTo } = require('../src/feishu');
      const brief = buildDailyBrief(r.date, loadEvents());
      const ok = await sendTextTo(XIAOXIONG, brief);
      console.log(`私聊小熊：${ok ? '已发' : '失败'}`);
    }
    return;
  }

  if (cmd === 'report') {
    // 出周报前先采一次，保证终值是今天的
    await snapshot(true);
    const { text, week, stats } = buildWeekly();
    const file = path.join(WEEKLY_DIR, nextVersion(WEEKLY_DIR, `周报_${week.label}`));
    fs.writeFileSync(file, text);
    console.log(`周报：${file}`);
    console.log(`统计：${JSON.stringify(stats)}`);
    if (flags.has('--send-weekly')) {
      const { sendTextTo } = require('../src/feishu');
      const brief = [
        `《逆天萌兽3》周报 ${week.label} 已生成（测试版，未发群）`,
        `全表 ${stats.records} 条 · 本周变更 ${stats.events} 项 · 完成 ${stats.done} 条 · 逾期 ${stats.overdue} 条`,
        `文件：${path.relative(ROOT, file)}`,
        '看完回我一句「可以发群」，我再发到制作组群。',
      ].join('\n');
      const ok = await sendTextTo(XIAOXIONG, brief);
      console.log(`私聊小熊：${ok ? '已发' : '失败'}`);
    }
    if (flags.has('--send-group')) {
      const { sendText } = require('../src/feishu');
      const chat = (cfg.RELEASE.chats || [])[0] || (cfg.ALLOW_GROUPS || [])[0];
      if (!chat) throw new Error('没有配置群 chat_id');
      const ok = await sendText(chat, text);
      console.log(`发群 ${chat}：${ok ? '已发' : '失败'}`);
    }
    return;
  }

  throw new Error(`未知命令：${cmd}（可用 snapshot / daily / report）`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e && e.message);
    process.exit(1);
  });
}

module.exports = { snapshot, buildWeekly, buildDaily, isoWeek, readAll, readPoints, F, diffRecords, condense };
