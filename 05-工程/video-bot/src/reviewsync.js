/**
 * /tbpz —— 分秒帧批注 → 飞书多维表格
 *
 * 做法：用 bsk 驱动本机 Chrome（分秒帧没有开放接口），
 * 打开项目 → 只挑缩略图上有批注角标的视频 → 进播放器读批注 → 一条批注一行写进表格。
 *
 * 配置存在 config.json 的 reviewSync 段，用 /tbpz 粗剪 分秒帧 <链接> 和 /tbpz 粗剪 表格 <链接> 改。
 * 精剪批注走 /tbpz 精剪（config.json 的 reviewSyncFineCut 段），两条线各存各的水位。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const { getClient } = require('./feishu');
const { log } = require('./log');

const HOME = process.env.HOME;
const BSK = path.join(HOME, '.local/bin/bsk');
const PATH_ENV = [path.join(HOME, '.local/bin'), process.env.PATH].join(':');

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function bsk(args, timeoutMs) {
  try {
    return execFileSync(BSK, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BSK_AUTO_START: '0', PATH: PATH_ENV },
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs || 60000,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    // 超时/被杀：播放器页会一直加载视频流，evaluate 容易卡住，这里兜住
    if (process.env.TBPZ_DEBUG) console.log('[dbg] bsk failed:', e.code || e.message);
    return '';
  }
}

function evalIn(sid, js) {
  const raw = bsk(['evaluate', '--session', sid, js], 15000);
  if (!raw) return '';
  return raw.trim().split('\n').pop();
}

// ---------------------------------------------------------------- 配置

const CONFIG_PATH = path.join(cfg.ROOT, 'config.json');

function commandFor(p) { return '/tbpz ' + (p.startsWith('nts3') ? '逆天萌兽3 ' : '') + (['fineCut','nts3FineCut'].includes(p) ? '精剪' : '粗剪'); }

function profileKey(profile) {
  if (!profile || profile === 'default') return 'reviewSync';
  if (profile === 'fineCut') return 'reviewSyncFineCut';
  if (profile === 'nts3') return 'reviewSyncNts3';
  if (profile === 'nts3FineCut') return 'reviewSyncNts3FineCut';
  throw new Error('未知批注同步分支：' + profile);
}

/**
 * 解析 `/tbpz` 后面的参数。
 *
 * 粗剪 / 精剪必须写明：不写分支就只回用法（`named=false` + 空 arg 由调用方判断）。
 * 旧写法（`/tbpz 全量`、`/tbpz 预览`、`/tbpz 执行`）不给分支名，仍按粗剪走，别打断同事习惯。
 */
function parseCommand(arg) {
  const project = /^(?:逆天萌兽3|萌兽3|nts3)\s+/.test(arg);
  if (project) arg = arg.replace(/^(?:逆天萌兽3|萌兽3|nts3)\s+/, '');
  const match = /^(精剪|粗剪)(?:\s+|$)/.exec(arg);
  return {
    profile: project ? (match && match[1] === '精剪' ? 'nts3FineCut' : 'nts3') : (match && match[1] === '精剪' ? 'fineCut' : 'default'),
    named: !!match,
    arg: match ? arg.slice(match[0].length).trim() : arg,
  };
}

function readConfig(profile = 'default') {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return raw[profileKey(profile)] || {};
}

function writeConfig(patch, profile = 'default') {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const key = profileKey(profile);
  raw[key] = Object.assign({}, raw[key], patch);
  if (profile.startsWith('nts3') && patch.mediatrackUrl) {
    const project = (raw.sceneProjects || []).find(p => p.key === 'nts3');
    if (project) project[profile === 'nts3FineCut' ? 'trimPreviewUrl' : 'projectUrl'] = patch.mediatrackUrl;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
  return raw[key];
}

/** 从 wiki/bitable 链接里解析 app_token + table_id + view_id */
async function parseBitableUrl(url) {
  const u = String(url || '');
  const tableId = (/[?&]table=([A-Za-z0-9]+)/.exec(u) || [])[1] || '';
  const viewId = (/[?&]view=([A-Za-z0-9]+)/.exec(u) || [])[1] || '';

  const wiki = /\/wiki\/([A-Za-z0-9]+)/.exec(u);
  if (wiki) {
    const res = await getClient().wiki.v2.space.getNode({ params: { token: wiki[1] } });
    const node = (res.data || res).node || {};
    if (node.obj_type !== 'bitable') throw new Error('这个 wiki 节点不是多维表格');
    return { appToken: node.obj_token, tableId, viewId };
  }

  const base = /\/base\/([A-Za-z0-9]+)/.exec(u);
  if (base) return { appToken: base[1], tableId, viewId };

  throw new Error('认不出这个表格链接，要 wiki 或 base 链接');
}

// ---------------------------------------------------------------- 浏览器

const JS_LIST = `
(() => {
  const items = [...document.querySelectorAll('div.item')];
  return JSON.stringify(items.map((c) => {
    const badge = c.querySelector('[class*="_comment_"]');
    return {
      text: c.innerText.replace(/\\n/g, ' ').trim(),
      count: badge ? (parseInt(badge.innerText, 10) || 0) : 0,
    };
  }));
})()
`;

const JS_COMMENTS = `
(() => {
  const boxes = [...document.querySelectorAll('.JaxCommentBox')];
  return JSON.stringify(boxes.map((b) => b.innerText));
})()
`;

const JS_HAS_PLAYER = `location.href.includes('/player/') ? '1' : '0'`;

/** 从卡片文字里抠文件名：「5 01:27 124 .mov 2026-10-27 11:55」→ 124.mov */
function fileNameOf(text) {
  const t = String(text || '').replace(/\s+\.(mov|mp4|mkv|avi|m4v|webm)\b/ig, '.$1');
  const m = /([^\s/]+\.(mov|mp4|mkv|avi|m4v|webm))\b/i.exec(t);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function episodeOf(name) {
  return require('./task-identity').parse(name)?.episode ?? null;
}

/** 「成艳@6524\n00:21\n眼睛这里改的\n今天 11:52\n0\n0」→ 结构化 */
function parseCommentBox(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const author = lines[0];
  let time = '';
  let date = '';
  let ti = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(lines[i])) {
      time = lines[i];
      ti = i;
      break;
    }
  }
  if (ti < 0) return null;

  for (let i = lines.length - 1; i > ti; i--) {
    if (/(今天|昨天|前天|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})/.test(lines[i])) {
      date = lines[i];
      break;
    }
  }

  let content = lines.slice(ti + 1);
  if (date) {
    const di = content.lastIndexOf(date);
    if (di >= 0) content = content.slice(0, di);
  }
  content = content.filter((l) => !/^\d+$/.test(l));

  return {
    author,
    timeline: time,
    content: content.join(' ').trim(),
    dateText: date,
  };
}

/** 把「今天 11:52」「昨天 09:01」「10-26」翻成毫秒时间戳 */
function dateToMs(text, at = Date.now()) {
  if (!text) return 0;
  const now = new Date(at);
  const hm = /(\d{1,2}):(\d{2})/.exec(text);
  const hh = hm ? Number(hm[1]) : 0;
  const mm = hm ? Number(hm[2]) : 0;

  if (text.includes('今天')) {
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  if (text.includes('昨天')) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  const md = /(\d{1,2})-(\d{1,2})/.exec(text);
  if (md) {
    const d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]), hh, mm, 0, 0);
    return d.getTime();
  }
  return 0;
}

/** 扫一个视频，返回批注数组 */
async function readVideoComments(sid, file) {
  const js = `
  (() => {
    const cards = [...document.querySelectorAll('div.item')];
    const hit = cards.find((c) => c.innerText.replace(/\\s+/g, '').includes(${JSON.stringify(file.replace(/\s+/g, ''))}));
    if (!hit) return 'NOT_FOUND';
    const th = hit.querySelector('[class*=thumbnail]') || hit;
    th.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return 'OK';
  })()
  `;
  if (process.env.TBPZ_DEBUG) console.log('[dbg] dblclick start');
  const r = evalIn(sid, js);
  if (process.env.TBPZ_DEBUG) console.log('[dbg] dblclick ->', String(r).slice(0, 40));
  if (r.includes('NOT_FOUND')) return null;

  // 播放器起来 + 批注加载都要时间，轮询最多 25 秒
  let clicked = false;
  for (let i = 0; i < 10; i++) {
    await sleep(2500);
    const got = readCommentsOnce(sid);
    if (process.env.TBPZ_DEBUG) console.log('[dbg] poll', i, 'got', got.length);
    if (got.length) return got;

    if (!clicked && i >= 2) {
      clicked = true;
      try {
        bsk(['evaluate', '--session', sid,
          `(() => { const t = [...document.querySelectorAll('*')].find(e => e.innerText === '批注' && !e.children.length); if (t) t.click(); return '1'; })()`]);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
  return [];
}

/**
 * 从整页可见文本里切批注。
 *
 * 为什么不用 DOM 选择器：批注条目的容器类名会变，且 .JaxCommentBox 只是头像。
 * 面板文本结构稳定：作者 → 时间码 → 正文… → 日期。
 */
function parseCommentsFromBody(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // 面板从「筛选」之后开始
  const start = lines.lastIndexOf('筛选');
  const seg = start >= 0 ? lines.slice(start + 1) : lines;

  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const m = /^(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(seg[i]);
    if (!m) continue;

    const timeline = m[1];
    let author = '';
    for (let k = i - 1; k >= 0; k--) {
      if (seg[k].length > 1) { author = seg[k]; break; }
      if (i - k > 3) break;
    }

    const content = [];
    let dateText = '';
    let j = i + 1;
    for (; j < seg.length; j++) {
      const line = seg[j];
      if (/^(今天|昨天|前天)/.test(line) || /^\d{1,2}-\d{1,2}(\s|$)/.test(line)) {
        dateText = line;
        break;
      }
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) break;
      content.push(line);
    }
    if (content.length) out.push({ author, timeline, content: content.join(' ').trim(), dateText });
    i = j;
  }
  return out;
}

function readCommentsOnce(sid) {
  const raw = evalIn(sid, 'document.body.innerText');
  let text = '';
  try {
    text = JSON.parse(raw);
  } catch (e) {
    text = raw;
  }
  return parseCommentsFromBody(text);
}

async function backToList(sid, projectUrl) {
  bsk(['navigate', '--session', sid, projectUrl]);
  await sleep(6);
}

// ---------------------------------------------------------------- 写表

async function loadExisting(appToken, tableId, signal) {
  const out = [];
  let token = '';
  for (let i = 0; i < 20; i++) {
    if (signal?.aborted) break;
    const res = await getClient().bitable.v1.appTableRecord.search({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: token || undefined },
      data: {},
    });
    if (res.code) throw new Error(res.msg || `飞书错误 ${res.code}`);
    const d = res.data || res;
    out.push(...(d.items || []));
    if (!d.has_more) break;
    token = d.page_token || '';
    if (!token) break;
  }
  return out;
}

function rowKey(episode, timeline, content) {
  return `${episode}|${timeline}|${String(content).replace(/\s+/g, '')}`;
}

function flatField(v) { return Array.isArray(v) ? v.map(x => x.text || '').join('') : String(v ?? ''); }

// 分秒帧的批注人是「名字@团队」形式（如 miya@2381的团队、冯先生@冯先生）。
// 表里「批注人」只要人名，取 @ 之前那段；全角 ＠ 也当分隔符，顺手去掉行首的 @。
function cleanAuthor(s) {
  return String(s || '').replace(/^[\s@＠]+/, '').split(/[@＠]/)[0].trim();
}

// 目标表不一定有「批注人」列（老的批注表就没有），写之前先探测一次并缓存。
const fieldNameCache = new Map();
async function tableHasField(appToken, tableId, name) {
  const key = `${appToken}|${tableId}`;
  if (!fieldNameCache.has(key)) {
    const res = await getClient().bitable.v1.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    });
    if (res.code) throw new Error(res.msg || `读字段失败 ${res.code}`);
    const d = res.data || res;
    fieldNameCache.set(key, new Set((d.items || []).map(f => f.field_name)));
  }
  return fieldNameCache.get(key).has(name);
}
function existingKeys(records, conf = {}) {
  const set = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const ep = Array.isArray(f['集数']) ? f['集数'][0] : f['集数'];
    const tl = Array.isArray(f['Timeline'])
      ? f['Timeline'].map((x) => x.text || '').join('')
      : f['Timeline'];
    const ct = Array.isArray(f['需求简述'])
      ? f['需求简述'].map((x) => x.text || '').join('')
      : f['需求简述'];
    if (conf.sceneMode) {
      if (conf.episodeRows) {
        for (const block of String(ct || '').split(/\n\n(?=【场次任务：)/)) {
          const meta = require('./scene-comments').decode(block);
          if (meta) set.add(require('./scene-comments').key(meta));
        }
        continue;
      }
      const meta = require('./scene-comments').decode(ct);
      if (meta) set.add(require('./scene-comments').key({ ...meta, timeline: tl }));
      else if (f['场次'] != null) set.add(require('./scene-comments').key({ episode: Number(ep), scene: Number(f['场次']), file: flatField(f['源视频']), version: flatField(f['视频版本']), timeline: tl, content: ct }));
    } else set.add(rowKey(ep, tl, ct));
  }
  return set;
}

async function upsertEpisodeRows(appToken, tableId, rows, signal) {
  const existing = await loadExisting(appToken, tableId, signal);
  const hasAuthor = await tableHasField(appToken, tableId, '批注人');
  const byEpisode = new Map();
  for (const record of existing) {
    const ep = Number(flatField(record.fields?.['集数']));
    if (!ep) continue;
    if (byEpisode.has(ep)) throw new Error(`批注表第${ep}集有多行，请先核对；本次未写入`);
    byEpisode.set(ep, record);
  }
  const groups = new Map();
  for (const row of rows) {
    const ep = Number(row.episode);
    if (!groups.has(ep)) groups.set(ep, []);
    groups.get(ep).push(row);
  }
  let written = 0;
  for (const [ep, incoming] of groups) {
    if (signal?.aborted) break;
    const previous = byEpisode.get(ep);
    const oldContent = flatField(previous?.fields?.['需求简述']);
    const blocks = new Set(oldContent.split(/\n\n(?=【场次任务：)/).filter(Boolean));
    for (const row of incoming) blocks.add(require('./scene-comments').content(row));
    const fields = { 集数: ep, 需求简述: [...blocks].join('\n\n') };
    const timelines = new Set(flatField(previous?.fields?.Timeline).split('、').filter(Boolean));
    for (const row of incoming) if (row.timeline) timelines.add(row.timeline);
    fields.Timeline = [...timelines].join('、');
    const at = Math.max(Number(previous?.fields?.['批注日期']) || 0, ...incoming.map(r => Number(r.at) || 0));
    if (at) fields['批注日期'] = at;
    if (hasAuthor) {
      const who = new Set(flatField(previous?.fields?.['批注人']).split(/[、,，]/).map(s => s.trim()).filter(Boolean));
      for (const row of incoming) { const n = cleanAuthor(row.author); if (n) who.add(n); }
      if (who.size) fields['批注人'] = [...who].join('、');
    }
    const api = getClient().bitable.v1.appTableRecord;
    const result = previous
      ? await api.update({path:{app_token:appToken,table_id:tableId,record_id:previous.record_id || previous.id},data:{fields}})
      : await api.create({path:{app_token:appToken,table_id:tableId},data:{fields}});
    if (result.code) throw new Error(result.msg || '整集批注汇总写入失败');
    written += incoming.length;
  }
  return written;
}

async function createRows(appToken, tableId, rows, signal, conf = {}) {
  require('./scene-comments').validate(rows, conf);
  if (conf.episodeRows) return upsertEpisodeRows(appToken, tableId, rows, signal);
  const hasAuthor = await tableHasField(appToken, tableId, '批注人');
  let ok = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    const fields = {
      集数: row.episode,
      Timeline: row.timeline,
      需求简述: conf.sceneMode ? require('./scene-comments').content(row) : row.content,
    };
    if (hasAuthor) {
      const who = cleanAuthor(row.author);
      if (who) fields['批注人'] = who;
    }
    if (conf.sceneFields) {
      if (row.scene != null) fields['场次'] = row.scene;
      fields['源视频'] = row.file || ''; fields['视频版本'] = row.version || '';
      if (row.taskRecordId) fields['场次任务'] = [row.taskRecordId];
    }
    if (row.at) fields['批注日期'] = row.at;
    try {
      const res = await getClient().bitable.v1.appTableRecord.create({
        path: { app_token: appToken, table_id: tableId },
        data: { fields },
      });
      if (res.code) throw new Error(res.msg || `飞书错误 ${res.code}`);
      ok++;
    } catch (e) {
      log(`写表失败（${row.episode} 集 ${row.timeline}）：${(e && e.message) || e}`);
    }
  }
  return ok;
}

function parseCollected(outFile, runStart, conf = {}) {
  const rows = [];
  const perVideo = [];
  let lines = [];
  try {
    lines = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean);
  } catch (e) {
    throw new Error('采集结果为空，看日志');
  }

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const identity = require('./task-identity').parse(o.file);
    const ep = identity?.episode ?? null;
    // v002 采集脚本直接给结构化 comments（已滚动读全 + 合并去重）；
    // 老 jsonl 只有整页 body，仍走文本解析兜底。
    const comments = Array.isArray(o.comments) ? o.comments : parseCommentsFromBody(o.body);
    for (const c of comments) {
      rows.push({
        episode: ep,
        scene: identity?.scene ?? null,
        version: o.versionId || o.version || '',
        timeline: c.timeline,
        content: c.content,
        at: dateToMs(c.dateText, runStart),
        author: c.author,
        file: o.file,
      });
    }
    perVideo.push({ file: o.file, episode: ep, got: comments.length, badge: Number(o.count) || 0 });
  }

  // 同一时间点可以有多条不同批注（40.mp4 有两条 00:17），只按「集数+时间码+正文」去重。
  // 2026-11-02 之前按「集数+时间码」去重，同一时间点的第二条直接被丢掉。
  const seenSlot = new Set();
  const rowsNoReply = [];
  for (const r of rows) {
    const k = conf.sceneMode
      ? require('./scene-comments').key(r)
      : rowKey(r.episode, r.timeline, r.content);
    if (seenSlot.has(k)) continue;
    seenSlot.add(k);
    rowsNoReply.push(r);
  }

  return { rows: rowsNoReply, perVideo };
}

function previewPath(profile) {
  profileKey(profile);
  return path.join(cfg.ROOT, 'review-preview', `${profile}.json`);
}

function savePreview(cache) {
  const dest = previewPath(cache.profile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = dest + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(temp, dest);
}

/**
 * 仅用于迁移已核实来源的旧版采集文件；不采集、不连飞书、不写表。
 * ⚠️ runStart 必须是「这轮采集的开始时间」，不是搬文件的时间 ——
 *    它会成为下一轮的增量水位（只捞更新时间 >= 它的视频），填晚了会漏掉中间那次采集期间的批注。
 */
function cacheCollectedPreview({ profile, collectedFile, runStart, full, sinceMs, complete = false }) {
  const conf = readConfig(profile);
  const parsed = parseCollected(collectedFile, runStart, conf);
  savePreview({ version: 1, profile, runStart, full: !!full, sinceMs: sinceMs || 0,
    complete, mediatrackUrl: conf.mediatrackUrl, appToken: conf.appToken,
    tableId: conf.tableId, ...parsed });
  return parsed;
}

async function writePreview(opts) {
  const profile = opts.profile || 'default';
  const conf = readConfig(profile);
  const command = commandFor(profile);
  let cache;
  try { cache = JSON.parse(fs.readFileSync(previewPath(profile), 'utf8')); }
  catch (e) { throw new Error(`没有可用预览缓存，请先发：${command} 预览`); }
  if (cache.version !== 1 || cache.profile !== profile || !Array.isArray(cache.rows) ||
      !Array.isArray(cache.perVideo) || !Number.isFinite(cache.runStart)) {
    throw new Error(`预览缓存损坏，请重新发：${command} 预览`);
  }
  if (cache.mediatrackUrl !== conf.mediatrackUrl || cache.appToken !== conf.appToken || cache.tableId !== conf.tableId) {
    throw new Error(`目标已变更，旧预览缓存不可写入，请重新发：${command} 预览`);
  }
  const progress = opts.onProgress || (() => {});
  progress(`使用 ${new Date(cache.runStart).toLocaleString('zh-CN')} 的预览缓存，不重新采集。` +
    (cache.complete ? '' : '该次采集未完整结束，仅写入已缓存部分，不推进增量水位。'));
  const records = await loadExisting(conf.appToken, conf.tableId, opts.signal);
  const seen = existingKeys(records, conf);
  require('./scene-comments').validate(cache.rows, conf);
  const fresh = cache.rows.filter(r => r.episode && !seen.has(conf.sceneMode ? require('./scene-comments').key(r) : rowKey(r.episode, r.timeline, r.content)));
  const written = await createRows(conf.appToken, conf.tableId, fresh, opts.signal, conf);
  fs.appendFileSync(path.join(cfg.ROOT, 'tbpz-sync-log.jsonl'), JSON.stringify({
    at: new Date().toISOString(), profile, mode: '缓存写入', previewAt: new Date(cache.runStart).toISOString(),
    mediatrackUrl: cache.mediatrackUrl, tableId: cache.tableId, videos: cache.perVideo.length,
    comments: cache.rows.length, written,
  }) + '\n');
  if (!opts.signal?.aborted && cache.complete && written === fresh.length) {
    writeConfig({ lastSyncAt: Math.max(conf.lastSyncAt || 0, cache.runStart) }, profile);
  }
  return { videos: cache.perVideo.length, comments: cache.rows.length, fresh: fresh.length, written,
    dryRun: false, full: cache.full, sinceMs: cache.sinceMs, perVideo: cache.perVideo,
    sample: fresh.slice(0, 10), cachedWrite: true, cacheComplete: cache.complete,
    canceled: !!opts.signal?.aborted, failed: opts.signal?.aborted ? 0 : fresh.length - written };
}

// 首次增量实际遍历全库，应与显式全量使用相同上限。
function collectionTimeoutMs(full, sinceMs) {
  return (full || !sinceMs ? 120 : 60) * 60 * 1000;
}

// ---------------------------------------------------------------- 主流程

/**
 * 跑一次同步。
 * @param {object} opts { dryRun, onProgress }
 */
async function run(opts = {}) {
  if (opts.writeCached) return writePreview(opts);
  const profile = opts.profile || 'default';
  const conf = readConfig(profile);
  const cmd = commandFor(profile);
  if (!conf.mediatrackUrl) throw new Error(`还没配分秒帧链接，发：${cmd} 分秒帧 <项目链接>`);
  if (!conf.appToken || !conf.tableId) throw new Error(`还没配多维表格链接，发：${cmd} 表格 <表格链接>`);

  const projectUrl = conf.mediatrackUrl;
  const progress = opts.onProgress || (() => {});
  const runStart = Date.now();
  // 增量：只同步上次同步之后更新的视频（列表按更新时间倒序，滚 1-2 屏就到边界）
  const full = !!opts.full;
  // 未建立历史水位时显式采用近期窗口，不把增量静默升级为全量。
  // 单独保存起点，失败/中断重试仍覆盖相同区间。
  const bootstrap = !full && !conf.lastSyncAt;
  const sinceMs = full ? 0 : (conf.lastSyncAt || conf.incrementalSinceAt || runStart - 24 * 60 * 60 * 1000);
  if (bootstrap && !conf.incrementalSinceAt) writeConfig({ incrementalSinceAt: sinceMs }, profile);
  if (bootstrap) progress('尚无成功同步水位：本轮增量从 ' + new Date(sinceMs).toLocaleString('zh-CN') + ' 开始；更早的历史批注请用「' + cmd + ' 全量」补齐。');

  // 浏览器采集交给 bash 脚本：Node 里连续调 bsk evaluate 会卡住
  const outFile = opts.collectedFile || path.join(require('os').tmpdir(), `tbpz-${Date.now()}.jsonl`);
  // v003（2026-11-02 12:35）：先确认列表排序为「更新时间/由近到远」，再按角标筛目标、滚动读全。
  // 旧版 tbpz-collect.sh / _v002 保留不删。
  // v005（2026-11-04）：审片空间 /reviews/ 链接专用 —— 页面上 bsk 走共享标签页策略，
  // 每次 evaluate 都要 cooperate context，v004 会静默读空。项目文件页仍用 v004（稳定）。
  const collector = /\/reviews\//.test(projectUrl)
    ? path.join(__dirname, '..', 'scripts', 'tbpz-collect_v005.sh')
    : path.join(__dirname, '..', 'scripts', 'tbpz-collect_v004.sh');
  const limit = String(process.env.TBPZ_MAX || opts.maxVideos || 0);

  // —— 边读边写（2026-11-04）：先把表里已有的批注键读出来，采集过程中每 20 秒把
  // 采集脚本新落的行解析、去重、直接写表，不用等整轮采完才见数据。
  const records = await loadExisting(conf.appToken, conf.tableId, opts.signal);
  const seen = existingKeys(records, conf);
  const keyOf = (r) => (conf.sceneMode ? require('./scene-comments').key(r) : rowKey(r.episode, r.timeline, r.content));
  const seenSlot = new Set();
  const rowsAll = [];
  const freshAll = [];
  const perVideoAll = [];
  const sampleRows = [];
  let rowsTotal = 0;
  let freshTotal = 0;
  let writtenTotal = 0;
  let processedLines = 0;
  // 写表串行队列：解析（同步）与写表（异步）分离，避免「等自己」死锁
  let writeChain = Promise.resolve();

  function doDrain(write) {
    if (!fs.existsSync(outFile)) return;
    const lines = fs.readFileSync(outFile, 'utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const todo = lines.slice(processedLines);
    processedLines = lines.length;
    for (const line of todo) {
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      const identity = require('./task-identity').parse(o.file);
      const ep = identity?.episode ?? null;
      const comments = Array.isArray(o.comments) ? o.comments : parseCommentsFromBody(o.body);
      const rows = comments.map((c) => ({
        episode: ep,
        scene: identity?.scene ?? null,
        version: o.versionId || o.version || '',
        timeline: c.timeline,
        content: c.content,
        at: dateToMs(c.dateText, runStart),
        author: c.author,
        file: o.file,
      }));
      perVideoAll.push({ file: o.file, episode: ep, got: comments.length, badge: Number(o.count) || 0 });
      const dedup = [];
      for (const r of rows) {
        const k = keyOf(r);
        if (seenSlot.has(k)) continue;
        seenSlot.add(k);
        dedup.push(r);
      }
      rowsTotal += dedup.length;
      rowsAll.push(...dedup);
      const fresh = dedup.filter((r) => r.episode && !seen.has(keyOf(r)));
      require('./scene-comments').validate(fresh, conf);
      freshAll.push(...fresh);
      freshTotal += fresh.length;
      if (sampleRows.length < 10) sampleRows.push(...fresh.slice(0, 10 - sampleRows.length));
      for (const r of fresh) seen.add(keyOf(r));
      if (write && fresh.length) {
        const batch = fresh;
        // 单个视频写失败不拖垮整轮（水位口径兜底：written < fresh 时不推水位）
        writeChain = writeChain.then(async () => {
          if (opts.signal?.aborted) return;
          writtenTotal += await createRows(conf.appToken, conf.tableId, batch, opts.signal, conf);
        }).catch((e) => log(`写入失败（${(batch[0] && batch[0].file) || '?'}）：${(e && e.message) || e}`));
      }
    }
  }

  function drainCollected(write) {
    // 先消化新行，再等已排队的写表任务落完
    return Promise.resolve()
      .then(() => doDrain(write))
      .then(() => writeChain)
      .catch((e) => log('边读边写调度失败：' + ((e && e.message) || e)));
  }

  let collectOk = false;
  if (!opts.collectedFile && !opts.signal?.aborted) {
  progress(sinceMs
    ? `增量同步：只读 ${new Date(sinceMs).toLocaleString('zh-CN')} 之后更新的视频…`
    : '全量同步：滚完整张列表，逐个视频读批注…');
  // 每 5 分钟汇报一次进度：读采集脚本写的 .progress 文件（TARGETS N + 每个 DONE 文件名 角标数）
  const progFile = outFile + '.progress';
  const startedAt = Date.now();
  const progTimer = setInterval(() => {
    try {
      if (!fs.existsSync(progFile)) return;
      const txt = fs.readFileSync(progFile, 'utf8');
      const tm = /TARGETS (\d+)/.exec(txt);
      const total = tm ? Number(tm[1]) : 0;
      if (!tm) {
        progress(`📊 进度：正在滚动视频列表、核对更新时间…（已用 ${Math.floor((Date.now() - startedAt) / 60000)} 分钟）`);
        return;
      }
      const dones = txt.split('\n').filter((l) => l.startsWith('DONE '));
      let comments = 0;
      for (const l of dones) {
        const parts = l.trim().split(/\s+/);
        comments += Number(parts[parts.length - 1]) || 0;
      }
      const done = dones.length;
      const elapsed = (Date.now() - startedAt) / 60000;
      const remain = total ? Math.max(0, total - done) : 0;
      const per = done ? elapsed / done : 0;
      const eta = per && remain ? Math.ceil(per * remain) : null;
      progress(
        `📊 进度：已读 ${done}/${total || '?'} 个视频、批注 ${comments} 条` +
        `${opts.dryRun ? '' : `，已写表 ${writtenTotal} 条`}` +
        `${remain ? `，还差 ${remain} 个` : '，采集快收尾了'}` +
        `${eta != null ? `，预计还要 ${eta} 分钟` : ''}（已用 ${Math.floor(elapsed)} 分钟）`
      );
    } catch (e) { /* 进度读失败不影响主流程 */ }
  }, 5 * 60 * 1000);
  if (progTimer.unref) progTimer.unref();

  // 边读边写：采集脚本每读完一个视频就落一行，这里每 20 秒消化一次新行
  const drainTimer = setInterval(() => {
    drainCollected(!opts.dryRun).catch(() => {});
  }, 20 * 1000);
  if (drainTimer.unref) drainTimer.unref();

  // 异步跑采集脚本：绝不能用 execFileSync——它会把 Node 事件循环冻住十几分钟，
  // 开工回执发不出去、长连接心跳停摆、所有消息都没响应（2026-10-27 踩过）
  const collectTimeout = collectionTimeoutMs(full, sinceMs);
  progress(`本轮采集时间上限 ${collectTimeout / 60000} 分钟，可发「${cmd} 中断」停止并保留缓存。`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [collector, projectUrl, outFile, limit, String(sinceMs)], {
        env: { ...process.env, BSK_AUTO_START: '0', PATH: PATH_ENV },
        // stdout 也要进日志：采集脚本的 MODE/TARGETS 诊断行打在 stderr，进度行在 stdout
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      });
      let stopReason = null;
      let forceTimer;
      const stop = (reason) => {
        if (stopReason) return;
        stopReason = reason;
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
        // 先让采集脚本清理会话；两秒后兜底终止整组进程。
        forceTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
        }, 2000);
      };
      const onAbort = () => stop(new Error('用户中断采集'));
      const timer = setTimeout(() => stop(new Error(`采集超时（${collectTimeout / 60000} 分钟）`)), collectTimeout);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(forceTimer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      child.on('error', (e) => { cleanup(); reject(e); });
      child.on('close', (code) => {
        cleanup();
        if (stopReason) reject(stopReason);
        else if (code === 0) { collectOk = true; resolve(); }
        else reject(new Error('采集脚本退出码 ' + code));
      });
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    });
  } catch (e) {
    log('采集脚本失败：' + ((e && e.message) || e));
  } finally {
    clearInterval(progTimer);
    clearInterval(drainTimer);
  }
  }

  // 收尾：把采集脚本最后落的几行也处理掉（平时 watcher 已经边读边写了）
  await drainCollected(!opts.dryRun && !opts.signal?.aborted);

  const cacheSaved = (opts.dryRun || opts.signal?.aborted) && perVideoAll.length > 0;
  if (cacheSaved) {
    savePreview({ version: 1, profile, runStart, full, sinceMs, complete: collectOk,
      mediatrackUrl: projectUrl, appToken: conf.appToken, tableId: conf.tableId,
      rows: rowsAll, perVideo: perVideoAll });
  }

  if (opts.signal?.aborted) {
    return { canceled: true, cacheSaved, videos: perVideoAll.length, comments: rowsTotal,
      fresh: freshTotal, written: writtenTotal, dryRun: !!opts.dryRun, full, sinceMs,
      cacheComplete: false, perVideo: perVideoAll, sample: sampleRows };
  }

  // 成功写完 → 记同步台账 + 更新增量水位（下次 /tbpz 从这儿往后同步）
  if (!opts.dryRun) {
    try {
      const entry = {
        at: new Date(runStart).toISOString(),
        profile,
        mediatrackUrl: projectUrl,
        tableId: conf.tableId,
        mode: full ? '全量' : '增量',
        since: sinceMs ? new Date(sinceMs).toISOString() : null,
        videos: perVideoAll.length,
        comments: rowsTotal,
        written: writtenTotal,
        rows: freshAll.map((r) => ({
          episode: r.episode, timeline: r.timeline,
          content: String(r.content).slice(0, 200), author: r.author || '', file: r.file,
        })),
      };
      fs.appendFileSync(path.join(cfg.ROOT, 'tbpz-sync-log.jsonl'), JSON.stringify(entry) + '\n');
      // 采集失败时绝不推水位：那样这批视频/批注就永久漏掉了（2026-10-28 之前一直是无条件推）
      // ⚠️ 水位 = runStart（本轮采集的「开始」时间），不是结束时间。任务持续过程中出现的
      //    新批注（更新时间落在本轮中途）下一轮会被「更新时间 >= 上次开始时间」重新捞到。
      //    小熊 2026-11-02 明确要求这个口径，别改成结束时间。
      if (collectOk && writtenTotal === freshTotal) {
        writeConfig({ lastSyncAt: runStart }, profile);
        log(`批注同步台账已记（${entry.mode}，写 ${writtenTotal} 条），水位推到 ${entry.at}`);
      } else {
        log('⚠️ 采集未成功收尾或写表未全部成功，水位不推进（下次仍从原水位捞，避免漏批注）');
      }
    } catch (e) {
      log('⚠️ 同步台账记录失败：' + ((e && e.message) || e));
    }
  }

  return {
    canceled: false,
    cacheSaved,
    videos: perVideoAll.length,
    comments: rowsTotal,
    fresh: freshTotal,
    written: writtenTotal,
    cacheComplete: collectOk,
    dryRun: !!opts.dryRun,
    full,
    sinceMs,
    perVideo: perVideoAll,
    sample: sampleRows,
  };
}

module.exports = {
  run, readConfig, writeConfig, parseCommand, commandFor, collectionTimeoutMs, cacheCollectedPreview, parseBitableUrl, fileNameOf, episodeOf,
  parseCommentBox, parseCommentsFromBody, dateToMs, cleanAuthor,
  // 供工具脚本复用（单集同步、回填等），不参与主流程
  _internal: { parseCollected, createRows, loadExisting, existingKeys, rowKey, tableHasField },
};
