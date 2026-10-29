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

function profileKey(profile) {
  if (!profile || profile === 'default') return 'reviewSync';
  if (profile === 'fineCut') return 'reviewSyncFineCut';
  throw new Error('未知批注同步分支：' + profile);
}

/**
 * 解析 `/tbpz` 后面的参数。
 *
 * 粗剪 / 精剪必须写明：不写分支就只回用法（`named=false` + 空 arg 由调用方判断）。
 * 旧写法（`/tbpz 全量`、`/tbpz 预览`、`/tbpz 执行`）不给分支名，仍按粗剪走，别打断同事习惯。
 */
function parseCommand(arg) {
  const match = /^(精剪|粗剪)(?:\s+|$)/.exec(arg);
  return {
    profile: match && match[1] === '精剪' ? 'fineCut' : 'default',
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
  const base = path.basename(name, path.extname(name));
  const m = /\d{1,4}/.exec(base);
  return m ? Number(m[0]) : null;
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

function existingKeys(records) {
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
    set.add(rowKey(ep, tl, ct));
  }
  return set;
}

async function createRows(appToken, tableId, rows, signal) {
  let ok = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    const fields = {
      集数: row.episode,
      Timeline: row.timeline,
      需求简述: row.content,
    };
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

function parseCollected(outFile, runStart) {
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
    const ep = episodeOf(o.file);
    const comments = parseCommentsFromBody(o.body);
    for (const c of comments) {
      rows.push({
        episode: ep,
        timeline: c.timeline,
        content: c.content,
        at: dateToMs(c.dateText, runStart),
        author: c.author,
        file: o.file,
      });
    }
    perVideo.push({ file: o.file, episode: ep, got: comments.length });
  }

  // 同集 + 同时间点只留第一条：后面的多是回复，按需求不写
  const seenSlot = new Set();
  const rowsNoReply = [];
  for (const r of rows) {
    const k = `${r.episode}|${r.timeline}`;
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

/** 仅用于迁移已核实来源的旧版采集文件；不采集、不连飞书、不写表。 */
function cacheCollectedPreview({ profile, collectedFile, runStart, full, sinceMs, complete = false }) {
  const conf = readConfig(profile);
  const parsed = parseCollected(collectedFile, runStart);
  savePreview({ version: 1, profile, runStart, full: !!full, sinceMs: sinceMs || 0,
    complete, mediatrackUrl: conf.mediatrackUrl, appToken: conf.appToken,
    tableId: conf.tableId, ...parsed });
  return parsed;
}

async function writePreview(opts) {
  const profile = opts.profile || 'default';
  const conf = readConfig(profile);
  const command = profile === 'fineCut' ? '/tbpz 精剪' : '/tbpz 粗剪';
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
  const seen = existingKeys(records);
  const fresh = cache.rows.filter(r => r.episode && !seen.has(rowKey(r.episode, r.timeline, r.content)));
  const written = await createRows(conf.appToken, conf.tableId, fresh, opts.signal);
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
  return (full || !sinceMs ? 120 : 25) * 60 * 1000;
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
  const cmd = profile === 'fineCut' ? '/tbpz 精剪' : '/tbpz 粗剪';
  if (!conf.mediatrackUrl) throw new Error(`还没配分秒帧链接，发：${cmd} 分秒帧 <项目链接>`);
  if (!conf.appToken || !conf.tableId) throw new Error(`还没配多维表格链接，发：${cmd} 表格 <表格链接>`);

  const projectUrl = conf.mediatrackUrl;
  const progress = opts.onProgress || (() => {});
  const runStart = Date.now();
  // 增量：只同步上次同步之后更新的视频（列表按更新时间倒序，滚 1-2 屏就到边界）
  const full = !!opts.full;
  const sinceMs = full ? 0 : (conf.lastSyncAt || 0);

  // 浏览器采集交给 bash 脚本：Node 里连续调 bsk evaluate 会卡住
  const outFile = opts.collectedFile || path.join(require('os').tmpdir(), `tbpz-${Date.now()}.jsonl`);
  const collector = path.join(__dirname, '..', 'scripts', 'tbpz-collect.sh');
  const limit = String(process.env.TBPZ_MAX || opts.maxVideos || 0);

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
        `${remain ? `，还差 ${remain} 个` : '，采集快收尾了'}` +
        `${eta != null ? `，预计还要 ${eta} 分钟` : ''}（已用 ${Math.floor(elapsed)} 分钟）`
      );
    } catch (e) { /* 进度读失败不影响主流程 */ }
  }, 5 * 60 * 1000);
  if (progTimer.unref) progTimer.unref();

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
  }
  }

  const { rows: rowsNoReply, perVideo } = opts.signal?.aborted && !fs.existsSync(outFile)
    ? { rows: [], perVideo: [] } : parseCollected(outFile, runStart);
  const cacheSaved = (opts.dryRun || opts.signal?.aborted) && (!opts.signal?.aborted || perVideo.length > 0);
  if (cacheSaved) {
    savePreview({ version: 1, profile, runStart, full, sinceMs, complete: collectOk,
      mediatrackUrl: projectUrl, appToken: conf.appToken, tableId: conf.tableId,
      rows: rowsNoReply, perVideo });
  }

  if (opts.signal?.aborted) {
    return { canceled: true, cacheSaved, videos: perVideo.length, comments: rowsNoReply.length,
      fresh: 0, written: 0, dryRun: !!opts.dryRun, full, sinceMs,
      cacheComplete: false, perVideo, sample: [] };
  }

  const records = await loadExisting(conf.appToken, conf.tableId, opts.signal);
  const seen = existingKeys(records);
  const fresh = rowsNoReply.filter((r) => r.episode && !seen.has(rowKey(r.episode, r.timeline, r.content)));



  let written = 0;
  if (!opts.dryRun) {
    progress(`写入 ${fresh.length} 条…`);
    written = await createRows(conf.appToken, conf.tableId, fresh, opts.signal);
  }

  if (opts.signal?.aborted && !cacheSaved) {
    savePreview({ version: 1, profile, runStart, full, sinceMs, complete: false,
      mediatrackUrl: projectUrl, appToken: conf.appToken, tableId: conf.tableId,
      rows: rowsNoReply, perVideo });
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
        videos: perVideo.length,
        comments: rowsNoReply.length,
        written,
        rows: fresh.map((r) => ({
          episode: r.episode, timeline: r.timeline,
          content: String(r.content).slice(0, 200), author: r.author || '', file: r.file,
        })),
      };
      fs.appendFileSync(path.join(cfg.ROOT, 'tbpz-sync-log.jsonl'), JSON.stringify(entry) + '\n');
      // 采集失败时绝不推水位：那样这批视频/批注就永久漏掉了（2026-10-28 之前一直是无条件推）
      if (!opts.signal?.aborted && collectOk && written === fresh.length) {
        writeConfig({ lastSyncAt: runStart }, profile);
        log(`批注同步台账已记（${entry.mode}，写 ${written} 条），水位推到 ${entry.at}`);
      } else {
        log('⚠️ 采集未成功收尾或写表未全部成功，水位不推进（下次仍从原水位捞，避免漏批注）');
      }
    } catch (e) {
      log('⚠️ 同步台账记录失败：' + ((e && e.message) || e));
    }
  }

  return {
    canceled: !!opts.signal?.aborted,
    cacheSaved: cacheSaved || !!opts.signal?.aborted,
    videos: perVideo.length,
    comments: rowsNoReply.length,
    fresh: fresh.length,
    written,
    cacheComplete: collectOk,
    dryRun: !!opts.dryRun,
    full,
    sinceMs,
    perVideo,
    sample: fresh.slice(0, 10),
  };
}

module.exports = {
  run, readConfig, writeConfig, parseCommand, collectionTimeoutMs, cacheCollectedPreview, parseBitableUrl, fileNameOf, episodeOf,
  parseCommentBox, parseCommentsFromBody, dateToMs,
};
