// 完全离线：SDK 替身记录请求，不发送真实消息。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const calls = [];
const sandbox = {
  require(name) {
    if (name === '@larksuiteoapi/node-sdk') return { Client: class {
      constructor() { this.im = { v1: { message: { create: async req => { calls.push(req); return { code: 0 }; } } } }; }
    } };
    if (name === './config') return { ROOT: root, APP_ID: 'mock', APP_SECRET: 'mock' };
    if (name === './notification-policy') return require('../src/notification-policy');
    if (name === './log') return { log() {} };
    return require(name);
  },
  module: { exports: {} }, setTimeout, clearTimeout, __dirname: path.join(root, 'src'),
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/feishu.js'), 'utf8'), sandbox);
(async () => {
  const api = sandbox.module.exports;
  const blocked = '[已脱敏]';
  assert.equal(await api.sendTextTo(blocked, '测试'), false);
  assert.equal(await api.sendCardTo(blocked, {}), false);
  await assert.rejects(api.getClient().im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: blocked, msg_type: 'interactive' } }), { code: 'PRIVATE_NOTIFICATION_OPT_OUT' });
  assert.equal(calls.length, 0);
  assert.equal(await api.sendTextTo('ou_other', '测试'), true);
  assert.equal(await api.sendCardTo('ou_other', {}), true);
  assert.equal(await api.sendInteractive('oc_group', {}), true);
  assert.equal(calls.length, 3);
  console.log('PASS：屏蔽文字、卡片及直接 SDK 通知；其他同事和群聊正常。');
})().catch(e => { console.error(e); process.exitCode = 1; });
