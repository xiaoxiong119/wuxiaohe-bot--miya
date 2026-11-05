/**
 * 回填「批注人」字段（2026-11-02）
 *
 * 背景：tbl4vFgW19bZgl41 新增了「批注人」文本列，历史记录里是空的。
 * 做法：把缓存 / 旧缓存 / 历史采集 jsonl 里出现过的批注（集数+时间码+正文）建成作者索引，
 *       再按同一键匹配表内记录，只补空值，不动已有值。
 *
 * 用法：
 *   node scripts/backfill-author-20261102.js          # 预览
 *   node scripts/backfill-author-20261102.js --apply  # 真写
 */
const fs = require('fs');
const path = require('path');
const { getClient } = require('../src/feishu');
const { cleanAuthor, parseCommentsFromBody } = require('../src/reviewsync');

const ROOT = path.join(__dirname, '..');
const APP = 'OL3WbEqoYaS6NbsV2Z4cLwDInOc';
const TBL = 'tbl4vFgW19bZgl41';
const APPLY = process.argv.includes('--apply');

const norm = (s) => String(s ?? '').replace(/\s+/g, '');
const key = (ep, tl, ct) => `${Number(ep)}|${String(tl ?? '').trim()}|${norm(ct)}`;
const flat = (v) => (Array.isArray(v) ? v.map((x) => x.text || '').join('') : String(v ?? ''));

function addFromCache(file, index) {
  if (!fs.existsSync(file)) return 0;
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; }
  let n = 0;
  for (const r of d.rows || []) {
    const who = cleanAuthor(r.author);
    if (!who || !r.episode) continue;
    index.set(key(r.episode, r.timeline, r.content), who);
    n++;
  }
  return n;
}

function addFromCollect(file, index) {
  let n = 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    const ep = Number((/(\d+)(?:-\d+)?\.(?:mp4|mov|mxf)/i.exec(d.file || '') || [])[1]);
    if (!ep) continue;
    // 新脚本输出结构化 comments；v001 及更早只有 body 整页文本，退回用解析器提取（仍能拿到作者）
    const comments = Array.isArray(d.comments) && d.comments.length
      ? d.comments
      : parseCommentsFromBody(d.body || '');
    for (const c of comments) {
      const who = cleanAuthor(c.author);
      if (!who || !c.timeline || !c.content) continue;
      index.set(key(ep, c.timeline, c.content), who);
      n++;
    }
  }
  return n;
}

async function listRecords(client) {
  const out = [];
  let token = '';
  do {
    const r = await client.bitable.v1.appTableRecord.search({
      path: { app_token: APP, table_id: TBL },
      params: { page_size: 500, page_token: token || undefined },
      data: {},
    });
    if (r.code) throw new Error(r.msg || `飞书错误 ${r.code}`);
    const d = r.data || r;
    out.push(...(d.items || []));
    token = d.has_more ? d.page_token : '';
  } while (token);
  return out;
}

(async () => {
  const index = new Map();
  console.log('缓存 fineCut.json           ' + addFromCache(path.join(ROOT, 'review-preview/fineCut.json'), index) + ' 条');
  for (const f of [
    'review-preview/fineCut.json.bak-20261102-1205',
    'review-preview/fineCut.json.bak-20261102-1138',
    'review-preview/fineCut.json.bak-20261102',
  ]) {
    console.log(`旧缓存 ${path.basename(f).padEnd(22)} ${addFromCache(path.join(ROOT, f), index)} 条`);
  }

  const tmp = '/var/folders/kc/ctg4lg0s2dx0t4q8h5353jw00000gn/T';
  const collects = fs.existsSync(tmp)
    ? fs.readdirSync(tmp).filter((f) => /^tbpz-.*\.jsonl$/.test(f))
    : [];
  let cn = 0;
  for (const f of collects) cn += addFromCollect(path.join(tmp, f), index);
  console.log(`历史采集 jsonl ${collects.length} 个     ${cn} 条`);
  console.log(`索引合计 ${index.size} 个不同批注\n`);

  const client = getClient();
  const records = await listRecords(client);
  const todo = [];
  let filled = 0;
  for (const rec of records) {
    const f = rec.fields || {};
    const ep = Number(flat(f['集数']));
    if (!ep) continue;
    if (flat(f['批注人']).trim()) { filled++; continue; }
    const who = index.get(key(ep, flat(f['Timeline']), flat(f['需求简述'])));
    if (who) todo.push({ record_id: rec.record_id || rec.id, ep, who, tl: flat(f['Timeline']) });
  }
  console.log(`表内记录 ${records.length} 条；已有批注人 ${filled} 条；可补 ${todo.length} 条`);
  const byWho = {};
  for (const t of todo) byWho[t.who] = (byWho[t.who] || 0) + 1;
  console.log('可补分布：' + JSON.stringify(byWho));

  if (!APPLY) {
    console.log('\n预览模式，未写入。加 --apply 执行。');
    return;
  }

  let ok = 0, fail = 0;
  for (const t of todo) {
    try {
      const r = await client.bitable.v1.appTableRecord.update({
        path: { app_token: APP, table_id: TBL, record_id: t.record_id },
        data: { fields: { 批注人: t.who } },
      });
      if (r.code) throw new Error(r.msg || `错误 ${r.code}`);
      ok++;
    } catch (e) {
      fail++;
      console.log(`失败 第${t.ep}集 ${t.tl}: ${(e && e.message) || e}`);
    }
  }
  console.log(`\n回填完成：成功 ${ok}，失败 ${fail}`);
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
