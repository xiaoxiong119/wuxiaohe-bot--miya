/**
 * 单集同步（2026-11-02 v001）
 *
 * 用途：只把一个采集结果文件里的某一集写进批注表，不动全局缓存、不推增量水位。
 * 背景：writePreview 走的是 review-preview/<profile>.json 整份缓存，单集场景会把整份缓存冲掉。
 *
 * 用法：node scripts/sync-single-episode_v001.js <采集jsonl> <集数> [--apply]
 *       不带 --apply 只预览（列出将写入的批注，不写表）。
 */
const path = require('path');
const rs = require('../src/reviewsync');
const I = rs._internal;

const file = process.argv[2];
const ep = Number(process.argv[3]);
const APPLY = process.argv.includes('--apply');
if (!file || !ep) {
  console.error('用法：node scripts/sync-single-episode_v001.js <采集jsonl> <集数> [--apply]');
  process.exit(2);
}

(async () => {
  const conf = rs.readConfig('fineCut');
  const { rows, perVideo } = I.parseCollected(path.resolve(file), Date.now(), conf);
  const mine = rows.filter((r) => Number(r.episode) === ep);
  console.log(`采集文件里 ${perVideo.length} 个视频，本集 ${ep} 解析出 ${mine.length} 条批注`);
  for (const r of mine) console.log(`  ${r.timeline} | ${rs.cleanAuthor(r.author) || '(无作者)'} | ${String(r.content).slice(0, 60)}`);
  if (!mine.length) { console.log('本集没有批注，不写表。'); return; }

  const records = await I.loadExisting(conf.appToken, conf.tableId);
  const seen = I.existingKeys(records, conf);
  const fresh = mine.filter((r) => !seen.has(I.rowKey(r.episode, r.timeline, r.content)));
  console.log(`表内已有 ${mine.length - fresh.length} 条，待新增 ${fresh.length} 条`);
  if (!APPLY) { console.log('预览模式，未写入。加 --apply 执行。'); return; }

  const written = await I.createRows(conf.appToken, conf.tableId, fresh, null, conf);
  console.log(`写入完成：成功 ${written}，失败 ${fresh.length - written}`);
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
