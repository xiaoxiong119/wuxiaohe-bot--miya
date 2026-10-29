/** 离线回归：不访问浏览器、不连飞书、不改线上配置。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbpz-profiles-'));
const sourceRoot = path.join(__dirname, '..');
const configFile = path.join(root, 'config.json');
const initial = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config.json')));
fs.writeFileSync(configFile, JSON.stringify(initial));
let collectorCode = 0;
let holdCollector = false;
let heldChild = null;
const kills = [];
let abortOnCreate = null;
let failWrite = false;
let existingRecords = [];
let recordWrites = false;
const calls = [];
const spawns = [];
const mockClient = { bitable: { v1: { appTableRecord: {
  search: async ({path: target}) => {
    calls.push({op: 'search', ...target});
    return {data: {items: existingRecords, has_more: false}};
  },
  create: async ({path: target, data}) => {
    calls.push({op: 'create', ...target, fields: data.fields});
    if (failWrite) throw new Error('模拟写入失败');
    if (recordWrites) existingRecords.push({fields: data.fields});
    abortOnCreate?.abort();
    return {code: 0};
  },
} } } };
const mod = { exports: {} };
const context = {
  module: mod, exports: mod.exports, process: {...process, kill: (pid, signal) => {
    kills.push({pid, signal}); setImmediate(() => heldChild.emit('close', null));
  }}, __dirname: path.join(sourceRoot, 'src'),
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: (name) => {
    if (name === './config') return {ROOT: root};
    if (name === './log') return {log: () => {}};
    if (name === './feishu') return {getClient: () => mockClient};
    if (name === 'child_process') return {spawn: (_cmd, args) => {
      spawns.push(args);
      const child = new EventEmitter();
      fs.writeFileSync(args[2], JSON.stringify({file: '71.mp4', body: '筛选\n审阅人\n00:21\n调整镜头衔接\n今天 10:00'}));
      if (holdCollector) { child.pid = 987654; heldChild = child; }
      else setImmediate(() => child.emit('close', collectorCode));
      return child;
    }};
    return require(name);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'src/reviewsync.js'), 'utf8'), context);
const sync = mod.exports;
async function main() {
  assert.equal(sync.collectionTimeoutMs(true, 123), 120 * 60000);
  assert.equal(sync.collectionTimeoutMs(false, 0), 120 * 60000);
  assert.equal(sync.collectionTimeoutMs(false, 123), 25 * 60000);
  assert.equal(sync.parseCommand('精剪 全量 预览').profile, 'fineCut');
  assert.equal(sync.parseCommand('精剪 全量 预览').arg, '全量 预览');
  assert.equal(sync.parseCommand('全量').profile, 'default');
  assert.equal(sync.readConfig('fineCut').lastSyncAt, 0);
  assert.throws(() => sync.readConfig('typo'));
  const defaultBefore = JSON.stringify(sync.readConfig());
  await sync.run({profile: 'fineCut', dryRun: true});
  assert.equal(spawns.at(-1)[1], initial.reviewSyncFineCut.mediatrackUrl);
  assert.equal(spawns.at(-1)[4], '0');
  assert.equal(calls.at(-1).table_id, '[已脱敏]');
  assert.equal(calls.filter(c => c.op === 'create').length, 0);
  assert.equal(sync.readConfig('fineCut').lastSyncAt, 0);
  const written = await sync.run({profile: 'fineCut'});
  assert.equal(written.written, 1);
  assert.equal(calls.at(-1).table_id, '[已脱敏]');
  assert.ok(sync.readConfig('fineCut').lastSyncAt > 0);
  assert.equal(JSON.stringify(sync.readConfig()), defaultBefore);
  const watermark = sync.readConfig('fineCut').lastSyncAt;
  await sync.run({profile: 'fineCut', dryRun: true});
  assert.equal(spawns.at(-1)[4], String(watermark));
  await sync.run({profile: 'fineCut', full: true, dryRun: true});
  assert.equal(spawns.at(-1)[4], '0');
  failWrite = true;
  await sync.run({profile: 'fineCut'});
  assert.equal(sync.readConfig('fineCut').lastSyncAt, watermark);
  failWrite = false; collectorCode = 1;
  await sync.run({profile: 'fineCut'});
  assert.equal(sync.readConfig('fineCut').lastSyncAt, watermark);
  await sync.run({dryRun: true});
  assert.equal(spawns.at(-1)[1], initial.reviewSync.mediatrackUrl);
  assert.equal(calls.at(-1).table_id, initial.reviewSync.tableId);
  assert.equal(JSON.stringify(sync.readConfig()), defaultBefore);
  const ledger = fs.readFileSync(path.join(root, 'tbpz-sync-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(ledger.every(e => e.profile === 'fineCut' && e.tableId === '[已脱敏]'));

  // 缓存写入应零采集，复用结构化日期，重复调用通过查表去重。
  const cacheFile = path.join(root, 'review-preview/fineCut.json');
  const originalCache = JSON.parse(fs.readFileSync(cacheFile));
  const spawnCount = spawns.length;
  const dates = originalCache.rows.map(r => r.at);
  recordWrites = true;
  const cached = await sync.run({profile: 'fineCut', writeCached: true});
  assert.equal(cached.written, 1);
  assert.equal(cached.cachedWrite, true);
  assert.equal(spawns.length, spawnCount);
  assert.deepEqual(existingRecords.map(r => r.fields['批注日期']), dates);
  const again = await sync.run({profile: 'fineCut', writeCached: true});
  assert.equal(again.written, 0);
  assert.equal(spawns.length, spawnCount);
  const cacheWatermark = sync.readConfig('fineCut').lastSyncAt;
  failWrite = true; existingRecords = [];
  const failed = await sync.run({profile: 'fineCut', writeCached: true});
  assert.equal(failed.failed, 1);
  assert.equal(sync.readConfig('fineCut').lastSyncAt, cacheWatermark);
  failWrite = false;
  fs.writeFileSync(cacheFile, JSON.stringify({...originalCache, complete: false}));
  const partial = await sync.run({profile: 'fineCut', writeCached: true});
  assert.equal(partial.cacheComplete, false);
  assert.equal(sync.readConfig('fineCut').lastSyncAt, cacheWatermark);
  sync.writeConfig({tableId: 'other'}, 'fineCut');
  await assert.rejects(sync.run({profile: 'fineCut', writeCached: true}), /目标已变更/);
  sync.writeConfig({tableId: originalCache.tableId}, 'fineCut');
  fs.unlinkSync(cacheFile);
  await assert.rejects(sync.run({profile: 'fineCut', writeCached: true}), /没有可用预览缓存/);
  assert.equal(spawns.length, spawnCount);
  assert.equal(JSON.stringify(sync.readConfig()), defaultBefore);

  // 中断正在运行的采集：杀进程组、保存部分缓存、不查表、不写表、不推水位。
  collectorCode = 0; holdCollector = true;
  const cancelController = new AbortController();
  const callCount = calls.length;
  const beforeCancel = JSON.stringify(sync.readConfig('fineCut'));
  const pending = sync.run({profile: 'fineCut', signal: cancelController.signal});
  cancelController.abort();
  const canceled = await pending;
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.cacheSaved, true);
  assert.equal(calls.length, callCount);
  assert.equal(JSON.stringify(sync.readConfig('fineCut')), beforeCancel);
  assert.equal(kills.at(-1).pid, -987654);
  assert.equal(kills.at(-1).signal, 'SIGTERM');
  assert.equal(JSON.parse(fs.readFileSync(cacheFile)).complete, false);
  holdCollector = false;
  // 写表期间中断：当前请求完成，后续行不再发送。
  const cacheForCancel = JSON.parse(fs.readFileSync(cacheFile));
  cacheForCancel.rows.push({...cacheForCancel.rows[0], timeline: '00:22'});
  fs.writeFileSync(cacheFile, JSON.stringify(cacheForCancel));
  existingRecords = []; abortOnCreate = new AbortController();
  const writeStopped = await sync.run({profile: 'fineCut', writeCached: true, signal: abortOnCreate.signal});
  assert.equal(writeStopped.canceled, true);
  assert.equal(writeStopped.written, 1);
  assert.equal(existingRecords.length, 1);
  assert.equal(JSON.stringify(sync.readConfig('fineCut')), beforeCancel);
  abortOnCreate = null;

  // 用主进程实际分发代码验证命令，不启动长连接或发送真实回执。
  const source = fs.readFileSync(path.join(sourceRoot, 'src/index.js'), 'utf8');
  const block = source.slice(source.indexOf('  // /tbpz ——'), source.indexOf('  // /driveup 名字'));
  const handler = new vm.Script('(async () => {' + block + '})()');

  async function dispatch(text, job = null) {
    let actual = null;
    const sent = [];
    const ctx = { text, msg: {chat_id: 'test', message_id: text}, state: {handled: []}, tbpzRunning: !!job, tbpzJob: job, AbortController,
      chatAllowed: () => true, saveState: () => {}, sendText: (_chat, t) => sent.push(t), log: () => {},
      setImmediate: cb => cb(), TBPZ_USAGE: '/tbpz 用法占位',
      reviewsync: {...sync, run: async opts => {
        actual = opts;
        return {perVideo: [], sample: [], videos: 0, comments: 0, fresh: 0, written: 0};
      }},
    };
    await handler.runInNewContext(ctx);
    return {actual, sent};
  }

  // 说明：带分支才跑；旧写法（不带分支名、只带动作）仍按粗剪，不打断同事习惯
  for (const [text, profile, dryRun, full] of [
    ['/tbpz 粗剪', 'default', false, false],
    ['/tbpz 粗剪 预览', 'default', true, false],
    ['/tbpz 粗剪 全量', 'default', false, true],
    ['/tbpz 粗剪 全量 预览', 'default', true, true],
    ['/tbpz 精剪', 'fineCut', false, false],
    ['/tbpz 精剪 预览', 'fineCut', true, false],
    ['/tbpz 精剪 全量 预览', 'fineCut', true, true],
    ['/tbpz 全量', 'default', false, true],
    ['/tbpz 预览', 'default', true, false],
  ]) {
    const {actual} = await dispatch(text);
    assert.ok(actual, text + ' 应该开跑');
    assert.equal(actual.profile, profile); assert.equal(actual.dryRun, dryRun); assert.equal(actual.full, full);
  }

  const jobController = new AbortController();
  const job = {profile: 'fineCut', chatId: 'test', controller: jobController};
  const mismatch = await dispatch('/tbpz 粗剪 中断', job);
  assert.equal(jobController.signal.aborted, false);
  assert.match(mismatch.sent[0], /这个分支没有/);
  await dispatch('/tbpz 精剪 中断', job);
  assert.equal(jobController.signal.aborted, true);
  const globalController = new AbortController();
  await dispatch('/tbpz 中断', {...job, controller: globalController});
  assert.equal(globalController.signal.aborted, true);
  const foreignController = new AbortController();
  await dispatch('/tbpz 中断', {...job, chatId: 'foreign', controller: foreignController});
  assert.equal(foreignController.signal.aborted, false);
  const noJob = await dispatch('/tbpz 中断');
  assert.match(noJob.sent[0], /当前没有/);

  const cacheRoute = await dispatch('/tbpz 精剪 写入');
  assert.equal(cacheRoute.actual.profile, 'fineCut');
  assert.equal(cacheRoute.actual.writeCached, true);
  assert.equal(cacheRoute.actual.dryRun, false);

  // 只发 /tbpz：不跑，只回用法
  const bare = await dispatch('/tbpz');
  assert.equal(bare.actual, null, '裸 /tbpz 不能开跑');
  assert.deepEqual(bare.sent, ['/tbpz 用法占位']);

  // 配置：回的是粗剪分支的配置和使用说明
  const conf = await dispatch('/tbpz 粗剪 配置');
  assert.equal(conf.actual, null);
  assert.match(conf.sent[0], /粗剪批注同步配置/);
  assert.match(conf.sent[0], /\/tbpz 粗剪 全量/);
  const confFine = await dispatch('/tbpz 精剪 配置');
  assert.match(confFine.sent[0], /精剪批注同步配置/);

  console.log('PASS：全量和首次采集120分钟、采集中断保存缓存、写入中断停止后续行、中断路由及会话隔离；缓存写入零采集、重试去重、日期保留、缺缓存/变更目标拦截、不完整缓存水位保留；命令路由（粗剪/精剪/裸命令只回用法）、独立目标/水位、预览不写、全量、失败保留水位、默认分支及台账隔离');
}
main().catch(e => {console.error(e);process.exitCode = 1}).finally(() => fs.rmSync(root, {recursive:true, force:true}));
