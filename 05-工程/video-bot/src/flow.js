/**
 * 审阅流程：定时触发 + 卡片按钮回调
 *
 * 对应流程图里的自动化：
 *   ① 到开始日期 → 进展=进行中、素材生成进展=生成中
 *   ② 素材生成进展=已粗剪待一审 → 发一审卡片（审片人 + 剪辑师）
 *   ③ 一审通过 → 通知制作师上传素材｜一审未通过 → 通知修改
 *   ④ 素材已上传 → 素材生成进展=已完成并上传 → 通知剪辑师精剪
 *   ③ 剪辑进度=可剪辑 + 素材已上传 + 一审通过 三者齐 → 发「开始精剪」卡片（剪辑师）
 *   ⑤ 开始剪辑 → 剪辑进度=剪辑中；精剪完成 → 待审片 + 发终审卡；审片人点「查看成片」→ 审片中
 *   ⑥ 剪辑通过 → 审阅反馈=通过、剪辑进度=已定剪、实际完成日期=今天
 *
 * ⑤ 那三档（剪辑中/待审片/审片中）逆天萌兽3 的表里没有 —— 导演的表只留了 待开始/可剪辑/已定剪。
 * 写不存在的选项飞书会报错、整张卡就废了，所以改按「状态词表」落地（src/status-vocab.js）：
 * 表里有这一档才写表，没有就记在 flow-state.json 的 trimShadow 里，流程判断一律走 effectiveTrim()。
 * 走到表里真有的「已定剪」时影子作废。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getClient, withTimeout, sendTextTo } = require('./feishu');
const { log } = require('./log');
const C = require('./cards');
const policy = require('./notification-policy');

const PC = require('./project-context');
const V = require('./status-vocab');
const B = cfg.BASE || {};
const F = { progress: '进展', stage: '素材生成进展', review: '审阅反馈', trim: '剪辑进度' };

// ---------------------------------------------------------------- 基础读写

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flat(v) {
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') return x.text || x.name || '';
      return '';
    }).join('');
  }
  if (v && typeof v === 'object') return v.text || v.name || '';
  return v == null ? '' : String(v);
}

function personList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((p) => (typeof p === 'string' ? { id: '', name: p } : { id: p.id, name: p.name }))
    .filter((p) => p.id);
}

function mapRecord(it) {
  const f = it.fields || {};
  const trimStage = flat(f[F.trim]);
  return {
    recordId: it.record_id,
    episode: flat(f['集数']),
    scene: flat(f['场次']),
    projectKey: PC.current().key,
    projectUrl: PC.current().projectUrl,
    tableUrl: PC.current().tableUrl,
    trimPreviewUrl: PC.current().trimPreviewUrl,
    sceneMode: !!PC.current().sceneMode,
    project: PC.current().key === 'legacy' ? (flat(f['《项目名》']) || '《逆天萌兽2》') : PC.current().name,
    progress: flat(f[F.progress]),
    stage: flat(f[F.stage]),
    review: flat(f[F.review]),
    trimStage,
    // 有效剪辑进度（表里写不进去的那几档记在机器人这边，卡片文案按它说）
    trimEffective: effectiveTrim({ recordId: it.record_id, trimStage }),
    startDate: typeof f['开始日期'] === 'number' ? f['开始日期'] : null,
    artist: personList(f['制作师']),
    reviewers: personList(f['审片人']),
    editors: personList(f['剪辑师']),
    // 这张表的「剪辑进度」有没有中间三档，卡片文案要按它说实话
    cap: {
      inProgress: V.has(F.trim, '剪辑中'),
      awaiting: V.has(F.trim, '待审片'),
      reviewing: V.has(F.trim, '审片中'),
    },
  };
}

async function fetchAllRecords() {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const res = await (async () => {
      const call = () => withTimeout(getClient().bitable.v1.appTableRecord.search({
        path: { app_token: B.appToken, table_id: B.tableId },
        params: { page_size: 500, page_token: pageToken || undefined },
        data: {},
      }), 10000, '读表');
      try {
        return await call();
      } catch (e) {
        // 早上首次读表偶发超时（冷连接），重试一次；还失败就让 tick 记失败，下一分钟再来
        await sleep(1500);
        return call();
      }
    })();
    const d = res.data || res;
    out.push(...((d.items) || []).map(it => PC.register(mapRecord(it))));
    if (!d.has_more) break;
    pageToken = d.page_token || '';
    if (!pageToken) break;
  }
  return out;
}

async function getRecord(recordId) {
  const res = await withTimeout(getClient().bitable.v1.appTableRecord.get({
    path: { app_token: B.appToken, table_id: B.tableId, record_id: recordId },
  }), 10000, '读记录');
  return mapRecord((res.data || res).record);
}

async function updateFields(recordId, fields) {
  const response = await withTimeout(getClient().bitable.v1.appTableRecord.update({
    path: { app_token: B.appToken, table_id: B.tableId, record_id: recordId },
    data: { fields },
  }), 10000, '改表');
  if (response.code) throw new Error(response.msg || '改表失败');
  log(`改表 ${recordId}：${Object.keys(fields).map((k) => `${k}=${flat(fields[k])}`).join('、')}`);
}

async function sendCard(openId, card) {
  if (!openId) return false;
  try {
    const sent = await withTimeout(getClient().im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    }), 10000, '发卡片');
    if (sent.code) throw new Error(sent.msg || '发卡失败');
    return true;
  } catch (e) {
    log(`⚠️ 发卡片给 ${openId} 失败：${(e && e.message) || e}`);
    return false;
  }
}

async function notify(people, card, label) {
  let ok = 0;
  for (const p of people) {
    if (await require('./notification-policy').context.run(require('./notification-policy').featureForLabel(label), () => sendCard(p.id, card))) ok++;
    await sleep(200);
  }
  log(`卡片「${label}」已发 ${ok}/${people.length} 人`);
  return ok;
}

/**
 * 制作师的卡这次发不发：空串=发；有值=不发，值是原因。
 *
 * 走的是统一通知策略（config.json → notificationPolicy.features.revision）：
 * 关了「修改与素材通知」、或碰上免打扰、或这个人被设为不接收私聊，都会挡掉。
 * 卡片文案必须靠它说实话——不能表改了、卡没发，还告诉审片人「已通知制作师」。
 */
function artistBlockReason(people) {
  if (!people || !people.length) return '这一集没填制作师';
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config.json'), 'utf8'));
  } catch (e) {
    return '';
  }
  const reasons = people.map((p) => policy.reason(raw, p.id, 'revision')).filter(Boolean);
  return reasons.length === people.length ? reasons[0] : '';
}

// ---------------------------------------------------------------- 去重状态

const SENT_FILE = path.join(cfg.ROOT, 'flow-state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
    return {
      sent: new Set(Array.isArray(s.sent) ? s.sent : []),
      initialized: !!s.initialized,
      tries: (s.tries && typeof s.tries === 'object') ? s.tries : {},
      seen: (s.seen && typeof s.seen === 'object') ? s.seen : null,
      undo: (s.undo && typeof s.undo === 'object') ? s.undo : {},
      trimAt: (s.trimAt && typeof s.trimAt === 'object') ? s.trimAt : {},
      trimShadow: (s.trimShadow && typeof s.trimShadow === 'object') ? s.trimShadow : {},
    };
  } catch (e) {
    return { sent: new Set(), initialized: false, tries: {}, seen: null, undo: {}, trimAt: {}, trimShadow: {} };
  }
}

const flowState = loadState();

function saveState() {
  // 自检脚本是独立进程（FLOW_STATE_READONLY=1），绝不能覆盖机器人内存里的去重状态
  if (process.env.FLOW_STATE_READONLY === '1') return;
  try {
    fs.writeFileSync(SENT_FILE, JSON.stringify({
      sent: [...flowState.sent].slice(-800),
      initialized: flowState.initialized,
      tries: flowState.tries || {},
      seen: flowState.seen || {},
      undo: flowState.undo || {},
      trimAt: flowState.trimAt || {},
      trimShadow: flowState.trimShadow || {},
    }, null, 2));
  } catch (e) {
    /* 写失败不影响主流程 */
  }
}

function remember(key) {
  flowState.sent.add(key);
  saveState();
}

// ------------------------------------------------- 剪辑进度的「影子档位」
//
// 「剪辑中 / 待审片 / 审片中」这三档，逆天萌兽2 的表里有，逆天萌兽3 的表里没有。
// 表里没有就不写表（写了会报错），改记在 flow-state.json 的 trimShadow 里：
//   trimShadow[recordId] = { stage, at }
// 有了它，流程判断一律走 effectiveTrim()，卡片文案也按它说实话；
// 走到表里真有的「已定剪」时把影子清掉。

function shadowStage(recordId) {
  const s = (flowState.trimShadow || {})[recordId];
  return (s && s.stage) || '';
}

function setShadow(recordId, stage) {
  flowState.trimShadow = flowState.trimShadow || {};
  if (!stage) {
    if (!flowState.trimShadow[recordId]) return;
    delete flowState.trimShadow[recordId];
  } else {
    flowState.trimShadow[recordId] = { stage, at: Date.now() };
  }
  saveState();
}

/** 有效剪辑进度：表里的值 + 表里写不进去的那几档 */
function effectiveTrim(rec) {
  if (!rec) return '';
  if (rec.trimStage === '已定剪') return '已定剪'; // 表已经走到终点，影子作废
  return shadowStage(rec.recordId) || rec.trimStage;
}

/**
 * 写剪辑进度：表里有这一档就写表，没有就只记影子。
 * 返回 true=写进表了，false=表里没这档（只记在机器人这边）。
 */
async function writeTrim(rec, stage) {
  if (!V.has(F.trim, stage)) {
    setShadow(rec.recordId, stage);
    log(`剪辑进度「${stage}」这张表没有这一档，只记在机器人这边（${rec.episode} 集）`);
    return false;
  }
  try {
    await updateFields(rec.recordId, { [F.trim]: stage });
  } catch (e) {
    // 词表过期（有人刚删了选项）时兜底：认得出是选项错误就不写表，记影子
    if (!V.isOptionError(e)) throw e;
    log(`剪辑进度「${stage}」写表失败（${(e && e.message) || e}），改记在机器人这边`);
    V.load(true).catch(() => {});
    setShadow(rec.recordId, stage);
    return false;
  }
  setShadow(rec.recordId, '');
  return true;
}

/** 该不该给这条发一审卡片 */
function isReviewCandidate(rec) {
  if (rec.stage !== '已粗剪待一审') return false;
  if (rec.review === '通过' || rec.review === '重做') return false;
  return true;
}

// ---------------------------------------------------------------- 自动化

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * ① 到今天为止该开的，置为进行中 / 生成中
 *
 * 条件：今天 >= 开始日期 且 进展=待开始（素材生成进展也还是待开始）
 * 改完进展就不是「待开始」了，后面每天巡检都不会再碰这条 —— 天然只改一次。
 */
async function autoStart(rec) {
  if (rec.progress !== '待开始') return false;
  if (!rec.startDate) return false;
  if (rec.startDate > todayStart()) return false;
  // 素材已经交付的不要倒回「进行中」，这类是历史数据没维护进展
  if (rec.stage === '已完成并上传') return false;

  const fields = { [F.progress]: '进行中' };
  // 素材生成进展只在还没动过时置「生成中」，免得把已到「修改中/已粗剪」的进度打回去
  if (!rec.stage || rec.stage === '待开始') fields[F.stage] = '生成中';

  await updateFields(rec.recordId, fields);
  log(`①自动化：${rec.episode} 集已过开始日期，置为进行中${fields[F.stage] ? '/生成中' : ''}`);
  return true;
}

/** ② 素材生成进展=已粗剪待一审 → 发一审卡片 */
async function autoReview(rec, force) {
  if (!isReviewCandidate(rec)) return false;

  const key = reviewKey(rec);
  if (!force && flowState.sent.has(key)) return false;

  // 只通知审片人：剪辑师要等一审通过、素材上传后才介入（2026-10-27 小熊定的）
  const targets = rec.reviewers;
  if (!targets.length) {
    log(`②自动化：${rec.episode} 集没有审片人，跳过`);
    return;
  }

  const ok = await notify(targets, C.reviewCard(rec), `一审 ${rec.episode}`);
  if (ok > 0) {
    remember(key);
    if (flowState.tries[key]) delete flowState.tries[key];
    return true;
  }
  // 发失败了：最多重试 3 轮，之后记成已发，避免每轮都撞（以前是失败一次就永不重试，会静默漏卡）
  const n = (flowState.tries[key] || 0) + 1;
  flowState.tries[key] = n;
  if (n >= 3) {
    log(`②自动化：${rec.episode} 集连发 ${n} 次都失败（多半是可用范围/跨租户），先放弃`);
    remember(key);
    delete flowState.tries[key];
  } else {
    log(`②自动化：${rec.episode} 集卡片没发出去，${n}/3，下一轮再试`);
  }
  saveState();
  return false;
}

function reviewKey(rec) {
  return `${rec.recordId}|${rec.stage}|${rec.review}`;
}

// ---------------------------------------------------------------- 开始精剪卡（三条件）

/** 开始精剪卡的三条件：剪辑进度=可剪辑、素材生成进展=已完成并上传、审阅反馈=通过 */
function trimReady(rec) {
  return effectiveTrim(rec) === '可剪辑' && rec.stage === '已完成并上传' && rec.review === '通过';
}

function trimMissing(rec) {
  const miss = [];
  const trim = effectiveTrim(rec);
  if (trim !== '可剪辑') miss.push(`剪辑进度=${trim || '空'}（要可剪辑）`);
  if (rec.stage !== '已完成并上传') miss.push(`素材生成进展=${rec.stage || '空'}（要已完成并上传）`);
  if (rec.review !== '通过') miss.push(`审阅反馈=${rec.review || '空'}（要通过）`);
  return miss;
}

function trimKey(rec) {
  return `${rec.recordId}|trim`;
}

/** ③ 三条件齐了才发「开始精剪」卡片给剪辑师；发过就不再发 */
const TRIM_COOLDOWN = 5 * 60 * 1000;

/** 5 分钟内同一集不再发第二次精剪卡（防手动点了 + 巡检又发） */
function trimRecentlySent(rec) {
  const t = (flowState.trimAt || {})[rec.recordId] || 0;
  return Date.now() - t < TRIM_COOLDOWN;
}

function markTrimSent(rec) {
  flowState.trimAt = flowState.trimAt || {};
  flowState.trimAt[rec.recordId] = Date.now();
  saveState();
}

/** 发精剪卡（唯一的出口：巡检和按钮都走这里，带冷却 + 去重） */
async function sendTrimCard(rec) {
  const key = trimKey(rec);
  if (flowState.sent.has(key)) return false;
  if (!rec.editors.length) {
    log(`③自动化：${rec.episode} 集没有剪辑师，跳过精剪卡`);
    return false;
  }
  if (trimRecentlySent(rec)) {
    log(`③${rec.episode} 集精剪卡 5 分钟内发过了，不再重复发`);
    return false;
  }
  const n = await notify(rec.editors, C.trimCard(rec), `开始精剪 ${rec.episode}`);
  if (n > 0) {
    remember(key);
    markTrimSent(rec);
    return true;
  }
  log(`③自动化：${rec.episode} 集精剪卡没发出去，下一轮再试`);
  return false;
}

async function autoTrim(rec) {
  if (!trimReady(rec)) return false;
  return sendTrimCard(rec);
}

let ticking = false;
let lastTick = { at: 0, stats: null };

async function tick() {
  if (ticking) return { skipped: true };
  if (!B.appToken || !B.tableId) return { skipped: true };
  ticking = true;
  const stats = { scanned: 0, started: 0, reviewed: 0, trimmed: 0, failed: 0 };
  try {
    await V.load(false); // 先看这张表的下拉选项（5 分钟一刷），卡片流程按它落地
    const records = await fetchAllRecords();
    stats.scanned = records.length;

    // 表里已经定剪的，影子状态清掉（可能在表里手动改过了）
    for (const rec of records) {
      if (rec.trimStage === '已定剪' && shadowStage(rec.recordId)) setShadow(rec.recordId, '');
    }

    // 同一条记录走完一轮又回到同一状态（比如 待一审 → 通过 → 又被改回待一审）时，
    // 旧的「已发」标记必须失效，否则永远不再发卡。靠记录状态变化来清。
    if (!flowState.seen) {
      flowState.seen = {};
      for (const rec of records) flowState.seen[rec.recordId] = `${rec.stage}|${rec.review}`;
      log(`去重状态首次记录：${records.length} 条`);
    } else {
      let cleared = 0;
      for (const rec of records) {
        const st = `${rec.stage}|${rec.review}`;
        const prev = flowState.seen[rec.recordId];
        if (prev && prev !== st) {
          for (const k of [...flowState.sent]) {
            if (!k.startsWith(rec.recordId + '|')) continue;
            const suffix = k.slice(rec.recordId.length + 1);
            // 「精剪卡」的标记不跟状态绑定：三条件还成立就留着，
            // 不然点「素材已上传」之后巡检会再发一张（2026-10-28 双发 BUG）
            if (suffix === 'trim') {
              if (!trimReady(rec)) { flowState.sent.delete(k); cleared++; }
              continue;
            }
            if (suffix !== st) { flowState.sent.delete(k); cleared++; }
          }
          for (const k of Object.keys(flowState.tries || {})) {
            if (k.startsWith(rec.recordId + '|')) delete flowState.tries[k];
          }
        }
        flowState.seen[rec.recordId] = st;
      }
      if (cleared) {
        saveState();
        log(`状态有变化：清掉 ${cleared} 条过期的「已发」标记`);
      }
    }

    // 首次启动：把已经在「已粗剪待一审」的历史记录标为已发，避免一上线群发一堆卡片
    if (!flowState.initialized) {
      let skipped = 0;
      for (const rec of records) {
        if (isReviewCandidate(rec)) {
          flowState.sent.add(reviewKey(rec));
          skipped++;
        }
      }
      flowState.initialized = true;
      saveState();
      log(`流程首次启动：${skipped} 条历史待审记录标记为已发，不补发卡片`);
      stats.backfilled = skipped;
    }
    for (const rec of records) {
      try {
        if (await autoStart(rec)) stats.started++;
      } catch (e) {
        stats.failed++;
        log(`①自动化失败（${rec.episode} 集）：${(e && e.message) || e}`);
      }
    }
    for (const rec of records) {
      try {
        if (await autoReview(rec)) stats.reviewed++;
      } catch (e) {
        stats.failed++;
        log(`②自动化失败（${rec.episode} 集）：${(e && e.message) || e}`);
      }
    }
    for (const rec of records) {
      try {
        if (await autoTrim(rec)) stats.trimmed++;
      } catch (e) {
        stats.failed++;
        log(`③自动化失败（${rec.episode} 集）：${(e && e.message) || e}`);
      }
    }
  } catch (e) {
    stats.failed++;
    log('流程巡检失败：' + ((e && e.message) || e));
  } finally {
    ticking = false;
  }
  log(`巡检：扫 ${stats.scanned} 条，开工 ${stats.started}，发卡 ${stats.reviewed}${stats.trimmed ? '，精剪卡 ' + stats.trimmed : ''}${stats.failed ? '，失败 ' + stats.failed : ''}`);
  lastTick = { at: Date.now(), stats };
  return stats;
}

function startScheduler() {
  const minutes = (cfg.FLOW && cfg.FLOW.tickMinutes) || 10;
  if (!(cfg.FLOW && cfg.FLOW.enabled !== false)) {
    log('流程自动化：未开启');
    return;
  }
  log(`流程自动化：每 ${minutes * 60} 秒巡检一次`);
  setTimeout(() => { tickProjects(); }, 15000); // 起来先跑一遍
  setInterval(() => { tickProjects(); }, minutes * 60 * 1000).unref();
}

// ---------------------------------------------------------------- 按钮回调

const ACTION_LABEL = {
  review_pass: '一审通过',
  review_fail: '一审未通过',
  uploaded: '素材已上传',
  reupload: '修改已上传',
  trim_start: '开始剪辑',
  final_view: '查看成片',
  trim_done: '精剪完成',
  final_pass: '剪辑通过',
};

/** 事后把卡片替换成结果（按钮回调 3 秒内必须应答，重活只能这么补） */
async function patchCard(messageId, card) {
  if (!messageId) return false;
  // 原来的卡片是 2.0 结构就只能拿 2.0 的内容去 patch，反之亦然；
  // 猜错了就翻面再试一次（2.0 的终审卡早期就是这么 400 的）。
  let lastErr = '';
  for (const content of [card, C.flipSchema(card)]) {
    if (!content) continue;
    try {
      await withTimeout(getClient().im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(content) },
      }), 10000, '更新卡片');
      return true;
    } catch (e) {
      lastErr = (e && e.message) || e;
    }
  }
  log(`⚠️ 卡片结果更新失败：${lastErr || '未知错误'}`);
  return false;
}

// ---------------------------------------------------------------- 撤回（undo）
//
// 每个会改表的按钮，点完都把「改之前的字段值」按卡片消息 id 记进 flow-state.json；
// 结果卡上多一个「↩︎ 撤回刚才的操作」，点它：字段写回去 + 卡片复原成原来那张。
// 注意：撤回只改表，改不了已经发出去的通知（制作师/剪辑师收到的卡片收不回来）。

const UNDO_KEEP = 300;

function snapshotOf(rec) {
  return {
    progress: rec.progress || '',
    stage: rec.stage || '',
    review: rec.review || '',
    trimStage: rec.trimStage || '',
  };
}

/**
 * 点按钮以后，如果这一步给别的负责人发了卡片，就回一句给点按钮的人：
 * 「已通知到 张三（审片人）……」。只有真发成功（notify 返回 >0）才说。
 */
async function tellOperator(operatorOpenId, people, role, what) {
  if (!operatorOpenId) return;
  const hit = (people || []).filter((p) => p && p.id);
  if (!hit.length) return;
  const names = hit.map((p) => `${p.name || '（未填名字）'}（${role}）`).join('、');
  try {
    await sendTextTo(operatorOpenId, `✅ 已通知到 ${names}：${what}。`);
    log(`已回执给操作人 ${operatorOpenId}：通知了 ${names}`);
  } catch (e) {
    log('给操作人发反馈失败：' + ((e && e.message) || e));
  }
}

/** 记下改前的值（撤回用） */
function rememberUndo(msgId, recordId, actionName, before) {
  if (!msgId || !before) return false;
  flowState.undo = flowState.undo || {};
  flowState.undo[msgId] = { action: actionName, recordId, before, at: Date.now() };
  const keys = Object.keys(flowState.undo);
  if (keys.length > UNDO_KEEP) {
    keys
      .sort((x, y) => (flowState.undo[x].at || 0) - (flowState.undo[y].at || 0))
      .slice(0, keys.length - UNDO_KEEP)
      .forEach((k) => delete flowState.undo[k]);
  }
  saveState();
  return true;
}

/**
 * 就地改卡片：只把「被点的那个按钮」换成撤回，其它按钮原样留着，
 * 顶上补一行结果说明。（2026-10-28 小熊要求：点「开始剪辑」后还能点「精剪完成」）
 */
function decorateCard(card, opt) {
  if (!card || typeof card !== 'object') return null;
  let hit = false;
  const isTarget = (v) => !!(v && v.a === opt.action);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.tag === 'button') {
      let matched = isTarget(node.value);
      if (!matched && Array.isArray(node.behaviors)) {
        matched = node.behaviors.some((b) => b && isTarget(b.value));
      }
      if (matched) {
        hit = true;
        if (opt.undoable) {
          node.text = { tag: 'plain_text', content: '↩︎ 撤回' };
          node.type = 'default';
          delete node.url;
          if (card.schema === '2.0') {
            delete node.value;
            node.behaviors = [{ type: 'callback', value: { a: 'undo', r: opt.recordId, m: opt.msgId } }];
          } else {
            delete node.behaviors;
            node.value = { a: 'undo', r: opt.recordId, m: opt.msgId };
          }
        }
        return;
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(card);
  if (!hit) return null;

  const line = String(opt.status || '已处理').replace(/\n+/g, ' ');
  if (card.schema === '2.0') {
    card.body = card.body || {};
    card.body.elements = card.body.elements || [];
    card.body.elements.unshift({ tag: 'markdown', content: `**✅ ${line}**` });
  } else {
    card.elements = card.elements || [];
    card.elements.unshift({ tag: 'div', text: { tag: 'lark_md', content: `**✅ ${line}**` } });
  }
  return card;
}

/** 兜底：卡片重建不出来时，在结果卡上额外挂一个撤回按钮 */
function withUndo(card, msgId, recordId, actionName, before) {
  if (!card || !msgId || !before) return card;
  rememberUndo(msgId, recordId, actionName, before);

  const value = { a: 'undo', r: recordId, m: msgId };
  const text = { tag: 'plain_text', content: '↩︎ 撤回' };
  if (card.schema === '2.0') {
    card.body = card.body || {};
    card.body.elements = card.body.elements || [];
    card.body.elements.push({ tag: 'button', text, type: 'default', behaviors: [{ type: 'callback', value }] });
  } else {
    card.elements = card.elements || [];
    card.elements.push({ tag: 'action', actions: [{ tag: 'button', text, type: 'default', value }] });
  }
  return card;
}

/** 撤回后按原动作把那张卡片重建出来 */
function rebuildCard(actionName, rec) {
  switch (actionName) {
    case 'review_pass':
    case 'review_fail':
      return C.reviewCard(rec);
    case 'reupload':
      return C.editCard(rec);
    case 'uploaded':
      return C.uploadCard(rec);
    case 'trim_start':
    case 'trim_done':
      return C.trimCard(rec);
    case 'final_view':
    case 'final_pass':
      return C.finalCard(rec);
    default:
      return null;
  }
}

// 防抖：同一张卡同一按钮，处理中再点忽略
const inflight = new Set();

/**
 * 处理卡片按钮点击。
 * index.js 收到回调后先秒回应答，把这里当后台任务跑；
 * 跑完用 msgId 把原卡片替换成结果卡（im:message:update）。
 * 返回值仅兼容旧结构：{ toast }。
 */
async function handleCardAction(action, operatorOpenId, msgId) {
  const { a, r } = action || {};
  if (!a || !r) return null;

  const key = `${a}|${r}`;
  if (inflight.has(key)) {
    log(`卡片重复点击，忽略（${ACTION_LABEL[a] || a} · ${r}）`);
    return { toast: { type: 'info', content: '正在处理，别急' } };
  }
  inflight.add(key);

  try {
    let rec;
    try {
      rec = await getRecord(r);
    } catch (e) {
      log(`按钮「${ACTION_LABEL[a] || a}」读记录失败：${(e && e.message) || e}`);
      await patchCard(msgId, C.settledCard('处理失败', [`读记录失败：${(e && e.message) || e}`], 'red'));
      return { toast: { type: 'error', content: '读记录失败' } };
    }

    if (action.batch) {
      const b = require('./batch');
      if (!b.eligible(rec, operatorOpenId, action.batch.kind) || b.signature(rec) !== action.batch.signature)
        return { toast: { type: 'error', content: '跳过：所属人员或状态已变化，请刷新清单' } };
    }
    const title = C.epTitle(rec);
    let card;
    let toast;
    let batchNotification = '';
    let before = null; // 改之前的字段值（撤回用）

    switch (a) {
      // ⇢ 撤回：把上一次点击改的字段写回去，卡片复原
      case 'undo': {
        const key = action.m || msgId;
        const info = (flowState.undo || {})[key];
        if (!info) {
          toast = '没有可撤回的操作（可能已经撤过，或是很久以前点的）';
          card = C.settledCard(`${title} · 撤回`, [toast], 'grey');
          break;
        }
        const b = info.before || {};
        const patch = {};
        if (b.progress !== rec.progress) patch[F.progress] = b.progress || null;
        if (b.stage !== rec.stage) patch[F.stage] = b.stage || null;
        if (b.review !== rec.review) patch[F.review] = b.review || null;
        if (b.trimStage !== rec.trimStage) patch[F.trim] = b.trimStage || null;
        if (info.action === 'final_pass') patch['实际完成日期'] = null;
        if (Object.keys(patch).length) {
          await updateFields(r, patch);
          log(`撤回 ${rec.episode} 集：${Object.keys(patch).join('、')} 改回原值（原动作 ${ACTION_LABEL[info.action] || info.action}）`);
        }
        // 剪辑的中间档位可能只记在机器人这边（表上没这一档），撤回时一起清掉
        setShadow(r, '');
        const restored = Object.assign({}, rec, {
          progress: b.progress, stage: b.stage, review: b.review, trimStage: b.trimStage,
        });
        delete flowState.undo[key];
        saveState();
        const orig = rebuildCard(info.action, restored);
        toast = '已撤回，字段改回去了';
        card = orig || C.settledCard(`${title} · 已撤回`, [
          '**字段已经改回原来的值**，但原来那张卡片重建不出来，去看一眼表格。',
        ], 'grey');
        break;
      }

      case 'review_pass': {
        if (rec.review === '通过') {
          toast = '这一集已经一审通过了';
          card = C.settledCard(`${title} · 一审已通过`, ['这一集之前已经一审通过了，不用重复点。'], 'grey');
          break;
        }
        // 一审过了就允许剪辑（素材还没上传时剪辑师只能等上传卡片）
        before = snapshotOf(rec);
        await updateFields(r, { [F.review]: '通过', [F.trim]: '可剪辑' });
        setShadow(r, ''); // 重新过一遍一审，旧的剪辑影子状态作废
        rec.review = '通过';
        rec.trimStage = '可剪辑';
        rec.trimEffective = '可剪辑';
        const uploadBlocked = artistBlockReason(rec.artist);
        const upN = uploadBlocked ? 0 : await notify(rec.artist, C.uploadCard(rec), `请上传素材 ${rec.episode}`);
        batchNotification = `制作师通知 ${upN}/${rec.artist.length} 人`;
        if (upN > 0) await tellOperator(operatorOpenId, rec.artist, '制作师', '「请上传素材」卡片');
        else log(`「请上传素材」卡没发（${uploadBlocked || '发送失败'}）：${rec.episode} 集`);
        // 素材可能已经先传了：三条件这时齐了就直接发精剪卡，不用等下一轮巡检
        const trimSent = trimReady(rec) ? await sendTrimCard(rec) : false;
        if (trimSent) await tellOperator(operatorOpenId, rec.editors, '剪辑师', '「开始精剪」卡片');
        toast = trimSent ? '一审通过，素材也齐了，已通知剪辑师开始精剪'
          : uploadBlocked ? `一审通过；制作师通知没发（${uploadBlocked}）`
          : '一审通过，已通知制作师上传素材';
        card = C.settledCard(`${title} · 一审通过`, [
          `**审阅反馈**：通过`,
          `**剪辑进度**：可剪辑`,
          `**素材生成进展**：${rec.stage}`,
          `**制作师**：${C.atList(rec.artist)}`,
          `**剪辑师**：${C.atList(rec.editors)}`,
          '',
          trimSent
            ? '素材已经上传过了，已直接通知剪辑师开始精剪。'
            : uploadBlocked
              ? `制作师通知没发（${uploadBlocked}），「请上传素材」这张卡没送出去；要通知制作师请直接跟他说。三条件（可剪辑 + 素材已上传 + 一审通过）齐了才会给剪辑师发「开始精剪」卡片。`
              : '已通知制作师上传素材。三条件（可剪辑 + 素材已上传 + 一审通过）齐了才会给剪辑师发「开始精剪」卡片。',
        ], 'green');
        break;
      }

      case 'review_fail': {
        // 2026-10-28 小熊定的：审阅反馈=有修改、素材生成进展=修改中（原来是 修改中/生成中）
        if (rec.review === '有修改' || rec.review === '修改中') {
          toast = '已经打过回修改了';
          card = C.settledCard(`${title} · 一审未通过（已处理）`, ['这一集之前已经打过回修改了，制作师在改。'], 'grey');
          break;
        }
        before = snapshotOf(rec);
        await updateFields(r, { [F.review]: '有修改', [F.stage]: '修改中', ...(action.batch ? { [PC.current().notesField || '修改意见']: action.batch.note } : {}) });
        rec.review = '有修改';
        rec.stage = '修改中';
        const editBlocked = artistBlockReason(rec.artist);
        const editN = editBlocked ? 0 : await notify(rec.artist, C.editCard(rec, action.batch && action.batch.note), `请修改 ${rec.episode}`);
        batchNotification = `制作师通知 ${editN}/${rec.artist.length} 人`;
        if (editN > 0) await tellOperator(operatorOpenId, rec.artist, '制作师', '「请修改」卡片');
        else log(`「请修改」卡没发（${editBlocked || '发送失败'}）：${rec.episode} 集`);
        toast = editBlocked ? `已记为一审未通过；制作师通知没发（${editBlocked}）` : '已记为一审未通过，通知制作师修改';
        card = C.settledCard(`${title} · 一审未通过`, [
          `**审阅反馈**：有修改`,
          `**素材生成进展**：修改中`,
          `**制作师**：${C.atList(rec.artist)}`,
          '',
          editBlocked
            ? `制作师通知没发（${editBlocked}），「请修改」这张卡没送出去；要通知制作师请直接跟他说。他用 /upmedia 或 /driveup 上传修改版成功后，素材生成进展会自动回到“待一审”，并重新发审阅卡片。`
            : '已通知制作师修改。制作师使用 /upmedia 或 /driveup 上传修改版成功后，我会自动将生成进展改回“待一审”，并重新发送审阅卡片。',
        ], 'red');
        break;
      }

      case 'uploaded': {
        if (rec.stage === '已完成并上传') {
          toast = '素材已经标记过上传了';
          card = C.settledCard(`${title} · 素材已上传（已处理）`, ['素材之前已经标记过上传了，不用重复点。'], 'grey');
          break;
        }
        before = snapshotOf(rec);
        await updateFields(r, { [F.stage]: '已完成并上传' });
        rec.stage = '已完成并上传';
        // 「开始精剪」卡片要三个条件一起满足才发
        const sent = trimReady(rec) ? await sendTrimCard(rec) : false;
        if (sent) await tellOperator(operatorOpenId, rec.editors, '剪辑师', '「开始精剪」卡片');
        if (!trimReady(rec)) {
          log(`③跳过开始精剪卡（${rec.episode} 集）：${trimMissing(rec).join('、')}`);
        }
        toast = sent ? '已记为素材已上传，通知剪辑师精剪' : '已记为素材已上传，还差一审通过才发精剪卡';
        card = C.settledCard(`${title} · 素材已上传`, [
          `**素材生成进展**：已完成并上传`,
          `**剪辑进度**：${rec.trimStage || '（空）'}`,
          `**审阅反馈**：${rec.review || '（空）'}`,
          `**剪辑师**：${C.atList(rec.editors)}`,
          '',
          sent
            ? '已通知剪辑师开始精剪。「进展」要等一审通过 + 精剪定剪后才算已完成。'
            : `三条件还没齐（${trimMissing(rec).join('、')}），一审通过后我会自动补发「开始精剪」卡片。`,
        ], 'turquoise');
        break;
      }

      case 'reupload': {
        // 制作师改完点「修改已上传」：素材生成进展 → 已粗剪待一审，并立刻重发审阅卡片
        if (rec.stage === '已粗剪待一审') {
          toast = '已经标记待一审了';
          card = C.settledCard(`${title} · 待一审（已处理）`, ['这一集之前已经标记过修改已上传了。'], 'grey');
          break;
        }
        before = snapshotOf(rec);
        await updateFields(r, { [F.stage]: '已粗剪待一审' });
        rec.stage = '已粗剪待一审';
        const again = await autoReview(rec, true); // 强制重发一审卡片
        if (again) await tellOperator(operatorOpenId, rec.reviewers, '审片人', '这一集的新一审卡片');
        toast = '已记回待一审，已重发审阅卡片';
        card = C.settledCard(`${title} · 修改已上传`, [
          `**素材生成进展**：已粗剪待一审`,
          `**审片人**：${C.atList(rec.reviewers)}`,
          '',
          '已重新发一审卡片给审片人和剪辑师。',
        ], 'blue');
        break;
      }

      case 'trim_start': {
        // 剪辑师点「开始剪辑」：剪辑进度 → 剪辑中（只做标记，不发新卡）
        const cur = effectiveTrim(rec);
        if (['剪辑中', '待审片', '审片中', '已定剪'].includes(cur)) {
          toast = `剪辑进度已经是「${cur}」了`;
          card = C.settledCard(`${title} · 开始剪辑（已处理）`, [`这一集剪辑进度已经是「${cur}」，不用重复点。`], 'grey');
          break;
        }
        before = snapshotOf(rec);
        const wrote = await writeTrim(rec, '剪辑中');
        toast = wrote ? '已记为剪辑中' : '已记为剪辑中（本表无「剪辑中」这一档，记在机器人这边）';
        card = C.settledCard(`${title} · 开始剪辑`, [
          `**剪辑进度**：${wrote ? '剪辑中' : (rec.trimStage || '（空）')}`,
          `**剪辑师**：${C.atList(rec.editors)}`,
          '',
          wrote
            ? '剪完点「精剪完成」，我再发终审卡片给审片人。'
            : '这张表的「剪辑进度」没有「剪辑中」这一档，所以表上仍是「可剪辑」；机器人这边已经记下你开始剪了，剪完点「精剪完成」。',
        ], 'blue');
        break;
      }

      case 'trim_done': {
        const cur = effectiveTrim(rec);
        if (['待审片', '审片中', '已定剪'].includes(cur)) {
          toast = `剪辑进度已经是「${cur}」了`;
          card = C.settledCard(`${title} · 精剪完成（已处理）`, [`这一集剪辑进度已经是「${cur}」，不用重复点。`], 'grey');
          break;
        }
        before = snapshotOf(rec);
        const wrote = await writeTrim(rec, '待审片');
        rec.trimEffective = effectiveTrim(rec);
        const finalN = await notify(rec.reviewers, C.finalCard(rec), `剪辑终审 ${rec.episode}`);
        batchNotification = `终审通知 ${finalN}/${rec.reviewers.length} 人`;
        if (finalN > 0) await tellOperator(operatorOpenId, rec.reviewers, '审片人', '「剪辑终审」卡片');
        toast = wrote ? '已记为待审片，通知审片人终审' : '已记为待审片（本表无此档，记在机器人这边），通知审片人终审';
        card = C.settledCard(`${title} · 精剪完成`, [
          `**剪辑进度**：${wrote ? '待审片' : (rec.trimStage || '（空）')}`,
          `**审片人**：${C.atList(rec.reviewers)}`,
          '',
          wrote
            ? '已发终审卡片。审片人点「查看成片」后，剪辑进度会自动变成「审片中」。'
            : `已发终审卡片。这张表的「剪辑进度」没有「待审片」这一档，表上仍是「${rec.trimStage || '空'}」；机器人这边已记下精剪完成，审片人点「查看成片」不会改表，看完点「剪辑通过」即定剪。`,
        ], 'orange');
        break;
      }

      case 'final_view': {
        // 终审卡 2.0 的「查看成片」：跳分秒帧的同时回传，这里记成审片中
        const cur = effectiveTrim(rec);
        if (cur === '审片中' || cur === '已定剪') {
          toast = `剪辑进度已经是「${cur}」了`;
          card = C.settledCard(`${title} · 查看成片`, [`这一集剪辑进度已经是「${cur}」，不用重复记。`], 'grey');
          break;
        }
        before = snapshotOf(rec);
        const wrote = await writeTrim(rec, '审片中');
        toast = wrote ? '已记为审片中，成片已打开' : '成片已打开（本表无「审片中」这一档，未改表）';
        card = C.settledCard2(`${title} · 审片中`, [
          `**剪辑进度**：${wrote ? '审片中' : (rec.trimStage || '（空）')}`,
          `**审片人**：${C.atList(rec.reviewers)}`,
          '',
          wrote
            ? '审完回原消息点「剪辑通过」。'
            : '这张表没有「审片中」这一档，只记在机器人这边，表上的剪辑进度不变。审完回原消息点「剪辑通过」。',
        ], 'blue');
        break;
      }

      case 'final_pass': {
        if (rec.trimStage === '已定剪') {
          toast = '这一集已经定剪了';
          card = C.settledCard(`${title} · 已定剪`, ['这一集之前已经定剪了。'], 'grey');
          break;
        }
        before = snapshotOf(rec);
        const now = Date.now();
        await updateFields(r, {
          [F.review]: '通过',
          [F.trim]: '已定剪',
          [F.progress]: '已完成', // 三个条件齐了：素材已上传 + 一审通过 + 剪辑完成
          实际完成日期: now,
        });
        setShadow(r, ''); // 走到表里真有的那一档了，影子状态作废
        toast = '已定剪，流程完成';
        card = C.settledCard2(`${title} · 已定剪`, [
          `**审阅反馈**：通过`,
          `**剪辑进度**：已定剪`,
          `**进展**：已完成`,
          `**实际完成日期**：${new Date(now).toLocaleDateString('zh-CN')}`,
          '',
          '这一集走完了：素材生成 → 一审 → 精剪 → 终审 → 定剪。',
        ], 'green');
        break;
      }

      default:
        toast = `没认出来的操作：${a}`;
        card = C.settledCard('处理失败', [`没认出来的操作：${a}`], 'red');
    }

    if (action.batch && batchNotification) toast = `表格已更新；${batchNotification}`;
    if (before) rememberUndo(msgId, r, a, before);
    // 优先在原卡上就地改：被点的按钮 → 撤回，其它按钮留着
    const recBefore = before
      ? Object.assign({}, rec, {
        progress: before.progress, stage: before.stage, review: before.review, trimStage: before.trimStage,
      })
      : rec;
    const orig = a === 'undo' ? null : rebuildCard(a, recBefore);
    const decorated = orig
      ? decorateCard(orig, { action: a, msgId, recordId: r, status: toast, undoable: !!before })
      : null;
    if (decorated) card = decorated;
    else if (before && a !== 'undo') card = withUndo(card, msgId, r, a, before);
    await patchCard(msgId, card);
    log(`按钮「${ACTION_LABEL[a] || a}」处理完成（${rec.episode} 集）`);
    return { toast: { type: 'success', content: toast } };
  } catch (e) {
    log(`按钮「${ACTION_LABEL[a] || a}」处理失败：${(e && e.message) || e}`);
    await patchCard(msgId, C.settledCard('处理失败', [
      `按钮：${ACTION_LABEL[a] || a}`,
      `错误：${(e && e.message) || '未知错误'}`,
      '',
      '表可能已经改了一半，重试前先核对多维表格。',
    ], 'red'));
    return { toast: { type: 'error', content: '处理失败' } };
  } finally {
    inflight.delete(key);
  }
}

/** 手动给某一集发一审卡片（/flow test 70） */
async function sendReviewFor(episode) {
  const recs = await activeRecords();
  const rec = recs.find((r) => String(r.episode) === String(episode));
  if (!rec) return `没找到 ${episode} 集的记录（按「集数」找的）。`;
  const targets = rec.reviewers;
  if (!targets.length) return `${episode} 集没有填审片人，没法发。`;
  const ok = await notify(targets, C.reviewCard(rec), `一审 ${episode}（手动）`);
  if (ok) remember(reviewKey(rec));
  return ok
    ? `已给 ${episode} 集发一审卡片：${targets.map((t) => t.name).join('、')}`
    : `${episode} 集卡片没发出去，看日志。`;
}

/** 把当前所有待审记录补发一遍（/flow backfill） */
async function backfill() {
  const recs = await activeRecords();
  const pending = recs.filter(isReviewCandidate);
  let ok = 0;
  for (const rec of pending) {
    if (await autoReview(rec, true)) ok++;
  }
  return { pending: pending.length, sent: ok };
}

/**
 * 巡检 / 发卡的目标项目：config.json → flow.projects（项目 key 数组）。
 * 每次现读，改完不用重启。没配或读失败 → 返回 null = 沿用老行为（全部项目）。
 * 2026-11-03 小熊要求从《逆天萌兽2》换成《逆天萌兽3》，现在配 ["nts3"]。
 */
function flowProjectKeys() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const list = c.flow && c.flow.projects;
    if (Array.isArray(list) && list.length) return list;
  } catch (e) {
    log('巡检项目配置读取失败，按全部项目处理：' + (e && e.message));
  }
  return null;
}

async function allProjectRecords() {
  const rows = [];
  for (const p of PC.projects()) rows.push(...await PC.run(p.key, fetchAllRecords));
  return rows;
}

/** 只查当前巡检/发卡项目的记录（/flow test、/flow backfill、批量待办用）。
 *  卡片按钮回调的 discover 仍走 allProjectRecords 全查，历史第二季卡片照常能点。 */
async function activeRecords() {
  const only = flowProjectKeys();
  if (!only) return allProjectRecords();
  const rows = [];
  for (const p of PC.projects()) {
    if (!only.includes(p.key)) continue;
    rows.push(...await PC.run(p.key, fetchAllRecords));
  }
  return rows;
}
let projectsTicking = false;
async function tickProjects() {
  if (projectsTicking) return { skipped: true };
  projectsTicking = true;
  try {
  let total = { scanned: 0, started: 0, reviewed: 0, failed: 0 };
  const only = flowProjectKeys();
  for (const p of PC.projects()) {
    if (only && !only.includes(p.key)) continue;          // 只巡检 config.flow.projects 指定的项目
    if (!only && p.sceneMode && !p.projectUrl) continue; // 没配时的老行为：视频目录未绑定前不自动发卡
    // 配了项目就不再因「没绑视频目录」跳过：cards.js 会把「查看粗剪/查看成片」降级成表格链接
    try { const stats = await PC.run(p.key, tick); for (const k of Object.keys(total)) total[k] += stats[k] || 0; }
    catch (e) { log(`项目巡检失败 ${p.name}：${e.message}`); total.failed++; }
  }
  lastTick = { at: Date.now(), stats: total };
  return total;
  } finally { projectsTicking = false; }
}
const scoped = fn => (id, ...args) => PC.forRecord(id, () => fn(id, ...args), allProjectRecords);
module.exports = {
  decorateCard,
  startScheduler, tick: tickProjects,
  getLastTick: () => lastTick,
  handleCardAction: (action, ...args) => PC.forRecord(action.r, () => handleCardAction(action, ...args), allProjectRecords),
  fetchAllRecords: allProjectRecords, activeRecords, flowProjectKeys, mapRecord, updateFields: scoped(updateFields),
  getRecord: scoped(getRecord), sendCard, notify, flat, sendReviewFor, backfill, effectiveTrim, setShadow,
  autoReview: (rec, ...args) => PC.run(rec.projectKey || 'legacy', () => autoReview(rec, ...args)), reviewKey,
};
