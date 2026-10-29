// 离线回归：所有飞书请求均为模拟，不向私聊/群聊发消息，不修改生产数据。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/release-draft.js'), 'utf8');

function setup(t, targets = ['group1']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-draft-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let db = { pending: [{ at: 1, text: '上传更快了' }], history: [], announcedItems: [] };
  const calls = [];
  const failures = new Set();
  let block = null;
  const release = {
    targetChats: () => targets,
    fetchLatest: async () => ({ version: '1.0.8', versionId: 'v8', publishTime: 100 }),
    loadDb: () => structuredClone(db),
    saveDb: value => { db = structuredClone(value); return true; },
    collectItems: data => data.pending.filter(p => !data.announcedItems.includes(p.text)).map(p => p.text),
  };
  const api = { im: { v1: {
    chat: { get: async ({ path: p }) => ({ code: 0, data: { name: p.chat_id + '制作组' } }) },
    message: {
      create: async req => {
        calls.push({ kind: 'group', req });
        if (block) await block;
        if (failures.has(req.data.receive_id)) throw new Error('模拟发送失败');
        return { code: 0, data: { message_id: 'sent' } };
      },
      patch: async req => { calls.push({ kind: 'patch', req }); return { code: 0 }; },
    },
  } } };
  const deps = {
    './config': { ROOT: root, INBOX: { notifyOpenId: 'owner' } },
    './release': release,
    './cards': { releaseCard: rec => ({ header: { title: { content: '更新到 v' + rec.version } },
      elements: [{ text: { content: rec.items.join('\n') || '版本说明' } }] }) },
    './feishu': { getClient: () => api,
      sendInteractive: async (chatId, card) => { calls.push({ kind: 'private', chatId, card }); return true; },
      sendText: async () => true, withTimeout: p => p },
    './log': { log: () => {} },
  };
  function loadModule() {
    const module = { exports: {} };
    vm.runInNewContext(source, { require: name => deps[name] || require(name), module, Buffer }, { filename: 'release-draft.js' });
    return module.exports;
  }
  const mod = loadModule();
  const current = () => JSON.parse(fs.readFileSync(path.join(root, 'release-draft.json'), 'utf8'));
  const action = (a, extra = {}) => {
    const d = current();
    return { operator: 'owner', chatId: 'private', messageId: 'preview',
      action: { value: { a, d: d.id, rev: d.rev }, ...extra } };
  };
  return { mod, calls, current, action, failures, release, loadModule, api,
    db: () => db, addNote: p => db.pending.push(p),
    setBlock: promise => { block = promise; },
    prepare: () => mod.prepare({ operator: 'owner', chatId: 'private' }) };
}

test('预览/编辑/保存不发群，不消耗条目；确认发送内容与预览一致且不带按钮', async t => {
  const s = setup(t);
  await s.prepare();
  assert.equal(s.calls.filter(c => c.kind === 'group').length, 0);
  assert.equal(s.db().pending.length, 1);
  assert.match(JSON.stringify(s.calls[0].card), /发送到（group1制作组）/);
  await assert.rejects(s.mod.handle({ ...s.action('release_send'), operator: 'other' }), /只有乌小熊/);
  await assert.rejects(s.mod.handle({ ...s.action('release_send'), chatId: 'group1' }), /原私聊/);
  const stale = s.action('release_send');
  await s.mod.handle(s.action('release_edit'));
  await assert.rejects(s.mod.handle(stale), /已更新/);
  await assert.rejects(s.mod.handle(s.action('release_send')), /先保存/);
  let d = s.current();
  await s.mod.handle({ ...s.action('release_save'), action: {
    name: `release_save_${d.id}_${d.rev}`,
    form_value: { release_title: '自定义公告标题', release_body_0: '**自定义正文**\n第二行' },
  } });
  assert.equal(s.calls.filter(c => c.kind === 'group').length, 0);
  assert.equal(s.db().pending.length, 1);
  d = s.current();
  assert.equal(d.content, '**自定义正文**\n第二行');
  await s.loadModule().prepare({ operator: 'owner', chatId: 'private' });
  assert.equal(s.current().content, d.content, '重启后草稿不丢失');
  s.addNote({ at: d.createdAt + 1, text: '预览后新增的改动' });
  await s.mod.handle(s.action('release_send'));
  const sent = s.calls.find(c => c.kind === 'group');
  const card = JSON.parse(sent.req.data.content);
  assert.equal(card.header.title.content, d.title);
  assert.equal(card.body.elements[0].content, d.content);
  assert.ok(!JSON.stringify(card).includes('button'));
  assert.equal(s.db().pending.length, 1);
  assert.equal(s.db().pending[0].text, '预览后新增的改动');
  await assert.rejects(s.mod.handle(s.action('release_send')), /已发送/);
  assert.equal(s.calls.filter(c => c.kind === 'group').length, 1);
});

test('发送中重复点击被阻止；部分失败重试跳过已成功群，保留相同消息 uuid', async t => {
  const s = setup(t, ['group1', 'group2']);
  await s.prepare();
  let unlock;
  s.setBlock(new Promise(resolve => { unlock = resolve; }));
  s.failures.add('group2');
  const sending = s.mod.handle(s.action('release_send'));
  await assert.rejects(s.mod.handle(s.action('release_send')), /正在处理/);
  unlock();
  await assert.rejects(sending, /模拟发送失败/);
  assert.equal(s.db().pending.length, 1);
  assert.equal(s.current().delivered.join(','), 'group1');
  await assert.rejects(s.mod.handle(s.action('release_edit')), /已开始/);
  s.failures.clear();
  await s.loadModule().handle(s.action('release_send'));
  assert.equal(s.calls.filter(c => c.kind === 'group' && c.req.data.receive_id === 'group1').length, 1);
  const retry = s.calls.filter(c => c.kind === 'group' && c.req.data.receive_id === 'group2');
  assert.equal(retry.length, 2);
  assert.equal(retry[0].req.data.uuid, retry[1].req.data.uuid);
  assert.equal(s.db().pending.length, 0);
});

test('长公告全部预填，保存空正文被拒绝，取消修改保留原文，卡片更新失败可恢复', async t => {
  const s = setup(t);
  s.addNote({ at: 2, text: '长正文🙂'.repeat(400) });
  await s.prepare();
  const original = s.current().content;
  await s.mod.handle(s.action('release_edit'));
  const editor = s.mod.editorCard(s.current());
  const inputs = editor.body.elements.find(e => e.tag === 'form').elements.filter(e => e.name.startsWith('release_body_'));
  assert.equal(inputs.map(i => i.default_value).join(''), original);
  assert.ok(inputs.every(i => i.default_value.length <= 1000));
  const form = { release_title: '标题' };
  inputs.forEach(i => { form[i.name] = ''; });
  await assert.rejects(s.mod.handle(s.action('release_save', { form_value: form })), /不能为空/);
  s.api.im.v1.message.patch = async () => { throw new Error('模拟更新失败'); };
  await s.mod.handle(s.action('release_cancel'));
  assert.equal(s.current().content, original);
  assert.equal(s.calls.at(-1).kind, 'private', '更新失败自动重发私聊预览');
});
