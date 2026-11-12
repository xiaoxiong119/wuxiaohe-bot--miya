const assert = require('assert/strict');
const path = require('path');
const Module = require('module');
const original = Module._load;
const fixture = require('./test-fixtures').fixtures();
let stored = '{}', sent, calls = [], messages = [];
const row = { recordId: 'r1', project: '测试', episode: '71', stage: '已粗剪待一审', review: '', trimStage: '', reviewers: [{ id: 'u' }], editors: [{ id: 'e' }] };
let current = { ...row };
const fakeFlow = { fetchAllRecords: async () => [current], sendCard: async (u,c) => { sent = c; return true; }, getRecord: async () => current,
  handleCardAction: async a => { calls.push(a); return { toast: { type: 'success', content: '完成' } }; } };
Module._load = function(name, parent, main) {
  if (parent?.filename.endsWith('/batch.js')) {
    if (name === 'fs') return { existsSync: () => true, readFileSync: () => stored, writeFileSync: (p,s) => { stored = s; }, renameSync: () => {} };
    if (name === './flow') return fakeFlow;
    if (name === './project-context') return fixture.pc;
    if (name === './config') return { BASE: {} };
    if (name === './feishu') return { sendTextTo: async(u,t) => messages.push(t), getClient: () => ({ bitable: { v1: { appTableField: { list: async () => ({ data: { items: [{ field_name: '修改意见', type: 1 }] } }) } } } }) };
  }
  return original.apply(this, arguments);
};
const b = require('../src/batch');
const action = (fields) => ({ name: sent.body.elements.find(e => e.tag === 'form').elements.at(-1).name, form_value: fields });
(async () => {
  assert(b.eligible(row, 'u', 'review')); assert(!b.eligible(row, 'e', 'review'));
  assert(!b.eligible({ ...row, review: '有修改' }, 'u', 'review'));
  await b.open('u', 'review');
  await assert.rejects(b.dispatch(action({pass:['r1'],fail:['r1']}), 'u', ''), /同时/);
  await assert.rejects(b.dispatch(action({fail:['r1']}), 'u', ''), /修改意见/);
  await assert.rejects(b.dispatch(action({pass:['r1']}), 'other', ''), /不属于/);
  await assert.rejects(b.dispatch(action({pass:['foreign']}), 'u', ''), /无效/);
  await b.dispatch(action({fail:['r1'], individual:'71：对白音量过低'}), 'u', '');
  assert.equal(calls[0].batch.note, '对白音量过低');
  await b.dispatch(action({fail:['r1'],note:'修改'}), 'u', ''); assert.equal(calls.length, 1);
  await b.open('u', 'review'); current = { ...row, review: '通过' };
  await b.dispatch(action({pass:['r1']}), 'u', ''); assert.equal(calls.length, 1);
  current = { ...row, review:'通过',stage:'已完成并上传',trimStage:'可剪辑' };
  assert(b.eligible(current,'e','trim'));
  await b.open('e','trim');
  await assert.rejects(b.dispatch(action({selected:['r1'],target:'review_pass'}),'e',''), /有效/);
  await b.dispatch(action({selected:['r1'],target:'trim_done'}),'e',''); assert.equal(calls.length,1);
  await b.dispatch(action({selected:['r1'],target:'trim_start'}),'e',''); assert.equal(calls.length,2);
  console.log('PASS: 权限、待审筛选、冲突、必填意见、非法记录、重复提交、状态变化、剪辑门禁和动作隔离');
})().catch(e => { console.error(e); process.exitCode = 1; });
