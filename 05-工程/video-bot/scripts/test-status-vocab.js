'use strict';
/**
 * 状态词表适配自测（2026-11-03）
 *
 * 逆天萌兽2 的「剪辑进度」有 剪辑中/待审片/审片中，逆天萌兽3 只有 待开始/可剪辑/已定剪。
 * 卡片流程是同一套，所以：
 *   • 表里有那一档 → 照旧写表
 *   • 表里没有那一档 → 不写表（写了飞书报错），记在机器人本地的 trimShadow 里
 *   • 走完「精剪完成 → 查看成片 → 剪辑通过」流程不被打断，最后一刀「已定剪」照常写表
 * 这里同时模拟两种表，确认两边都不报错、且萌兽3 不会去写一个不存在的选项。
 */
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..'), PC = require('../src/project-context');
const C = require('../src/cards');
const projects = PC.projects();
const t2 = projects.find(p => p.key === 'legacy').base.tableId;
const t3 = projects.find(p => p.key === 'nts3').base.tableId;

// 两张表的「剪辑进度」实际选项
const TRIM_OPTS = {
  [t2]: ['待开始', '可剪辑', '剪辑中', '待审片', '审片中', '已定剪'],
  [t3]: ['待开始', '可剪辑', '已定剪'],
};
const VOCAB = {
  load: async () => null,
  has: (field, value) => {
    if (field !== '剪辑进度') return true;
    const opts = TRIM_OPTS[PC.current().base.tableId];
    return !opts || opts.includes(value);
  },
  options: () => null,
  isOptionError: () => false,
  fields: () => null,
};

const make = (id, table) => ({
  record_id: id, table,
  fields: {
    集数: 64, 素材生成进展: '已完成并上传', 审阅反馈: '通过', 剪辑进度: '可剪辑',
    制作师: [{ id: 'artist', name: '测试制作师' }],
    审片人: [{ id: 'reviewer', name: '测试审片人' }],
    剪辑师: [{ id: 'editor', name: '测试剪辑师' }],
  },
});
const rows = { t2: make('legacy1', t2), t3: make('nts3a', t3), t3b: make('nts3b', t3), t3c: make('nts3c', t3) };
const tables = { [t2]: [rows.t2], [t3]: [rows.t3, rows.t3b, rows.t3c] };
const writes = [];
const records = {
  search: async ({ path: p }) => ({ data: { items: tables[p.table_id], has_more: false } }),
  get: async ({ path: p }) => ({ data: { record: tables[p.table_id].find(r => r.record_id === p.record_id) } }),
  update: async ({ path: p, data }) => {
    const row = tables[p.table_id].find(r => r.record_id === p.record_id);
    assert(row);
    const trim = data.fields['剪辑进度'];
    // 模拟飞书：写了一个表里没有的选项就报错，卡片就废了
    assert(!trim || TRIM_OPTS[p.table_id].includes(trim), `往表里写了不存在的选项：${trim}`);
    writes.push({ table: p.table_id, id: p.record_id, fields: data.fields });
    Object.assign(row.fields, data.fields);
    return { code: 0 };
  },
};
const realRequire = require('module').createRequire(path.join(root, 'src/flow.js'));
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/flow.js'), 'utf8'), {
  module: mod, exports: mod.exports,
  process: { env: { FLOW_STATE_READONLY: '1' } },
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: n => {
    if (n === 'fs') return { readFileSync: p => { if (String(p).endsWith('config.json')) return '{}'; throw Error('no state'); } };
    if (n === './config') return { ROOT: root, BASE: PC.base, FLOW: { enabled: true, tickMinutes: 1 } };
    if (n === './feishu') return { getClient: () => ({ bitable: { v1: { appTableRecord: records } }, im: { v1: { message: { create: async () => ({ code: 0 }) } } } }), withTimeout: p => p, sendTextTo: async () => {} };
    if (n === './log') return { log: () => {} };
    if (n === './status-vocab') return VOCAB;
    return realRequire(n);
  },
});

const click = (a, id) => mod.exports.handleCardAction({ a, r: id }, 'reviewer', '');

// 批量模块走同一份（vm 里的）flow：它 require('./flow') 时拿到的就是这里，
// 这样批量待办看到的状态跟卡片流程完全一致
const sentCards = [];
const Module = require('module'), originalLoad = Module._load;
Module._load = function (name, parent, main) {
  if (parent && parent.filename && parent.filename.endsWith('/batch.js')) {
    if (name === './flow') return mod.exports;
    if (name === 'fs') return { existsSync: () => true, readFileSync: () => batchStore, writeFileSync: (p, s) => { batchStore = s; }, renameSync: () => {} };
  }
  return originalLoad.apply(this, arguments);
};
let batchStore = '{}';
const origSend = mod.exports.sendCard;
mod.exports.sendCard = async (u, c) => { sentCards.push(c); return origSend(u, c); };

(async () => {
  const flow = mod.exports;

  // ---- 逆天萌兽3：表里没有中间三档 ----
  let rec = await flow.getRecord('nts3a');
  assert.equal(rec.cap.inProgress, false);
  assert.equal(rec.cap.awaiting, false);
  assert.equal(rec.cap.reviewing, false);

  await click('trim_start', 'nts3a');
  assert.equal(writes.filter(w => w.id === 'nts3a').length, 0, '萌兽3 不该往表里写「剪辑中」');
  rec = await flow.getRecord('nts3a');
  assert.equal(rec.trimStage, '可剪辑', '表上的值不变');
  assert.equal(rec.trimEffective, '剪辑中', '机器人这边要记成剪辑中');

  await click('trim_done', 'nts3a');
  rec = await flow.getRecord('nts3a');
  assert.equal(rec.trimStage, '可剪辑');
  assert.equal(rec.trimEffective, '待审片');
  await click('final_view', 'nts3a');
  rec = await flow.getRecord('nts3a');
  assert.equal(rec.trimEffective, '审片中');
  // 重复点不再改状态、也不再重发终审卡
  const again = await click('trim_start', 'nts3a');
  assert.match(again.toast.content, /已经是/);
  rec = await flow.getRecord('nts3a');
  assert.equal(rec.trimEffective, '审片中');

  const pass = await click('final_pass', 'nts3a');
  assert.equal(pass.toast.type, 'success');
  assert.equal(rows.t3.fields['剪辑进度'], '已定剪', '最后一刀照常写表');
  rec = await flow.getRecord('nts3a');
  assert.equal(rec.trimEffective, '已定剪', '影子状态作废');

  // ---- 逆天萌兽2：表里有中间三档，行为跟以前一样 ----
  const r2 = await flow.getRecord('legacy1');
  assert.equal(r2.cap.inProgress, true);
  await click('trim_start', 'legacy1');
  assert.equal(rows.t2.fields['剪辑进度'], '剪辑中');
  await click('trim_done', 'legacy1');
  assert.equal(rows.t2.fields['剪辑进度'], '待审片');
  await click('final_view', 'legacy1');
  assert.equal(rows.t2.fields['剪辑进度'], '审片中');
  await click('final_pass', 'legacy1');
  assert.equal(rows.t2.fields['剪辑进度'], '已定剪');

  // ---- 卡片文案：萌兽3 的终审卡不能说「会把剪辑进度记成审片中」 ----
  const rec3 = { ...(await flow.getRecord('nts3b')), trimEffective: '待审片' };
  const card3 = JSON.stringify(C.finalCard(rec3));
  assert(!/记成「审片中」/.test(card3), '萌兽3 的终审卡不该承诺写「审片中」');
  assert(/没有中间档位/.test(card3));
  assert(/记到「待审片」/.test(card3));
  const rec2 = { ...(await flow.getRecord('legacy1')), trimEffective: '待审片', trimStage: '待审片', cap: { inProgress: true, awaiting: true, reviewing: true } };
  assert(/记成「审片中」/.test(JSON.stringify(C.finalCard(rec2))), '萌兽2 的终审卡保持原样');

  // ---- 批量：萌兽3 走过「开始剪辑」后，精剪完成要能放行 ----
  const B = require('../src/batch');
  await click('trim_start', 'nts3c');
  const cur = await flow.getRecord('nts3c');
  assert.equal(cur.trimEffective, '剪辑中');
  assert(B.eligible(cur, 'editor', 'trim'), '影子状态要算进批量待办');
  assert(!B.eligible({ ...cur, trimEffective: '', trimStage: '已定剪' }, 'editor', 'trim'), '已定剪不该再进待办');
  const opened = await B.open('editor', 'trim', 'nts3');
  assert.equal(opened.count, 2, 'nts3c（机器人记到剪辑中）和 nts3b（表里可剪辑）都在待办里');
  const batchText = JSON.stringify(sentCards.at(-1));
  assert(/精剪完成 → 通知审片人终审/.test(batchText), '批量卡的目标进度要说真话');
  assert(!/→ 剪辑中|→ 待审片/.test(batchText), '批量卡不该承诺写表里没有的档位');

  console.log('PASS: 状态词表适配——萌兽3 不写表也不报错、流程走通到已定剪；萌兽2 行为不变；终审卡文案按表说话');
})().catch(e => { console.error(e); process.exitCode = 1; });
