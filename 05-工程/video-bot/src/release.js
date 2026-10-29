/**
 * 版本更新公告
 *
 * 盯着飞书开放平台上「已发布」的版本号（application/v6/.../app_versions）：
 *   - 版本号/版本 id 变了 → 把 releases.json 里攒着的改动说明（pending）归档成这一版的记录
 *   - 然后发一张简洁的公告卡到 config.json → release.chats 里的群
 *
 * 改动说明由乌乌在改完机器人后用 `node scripts/note.js "一句话改动"` 往 pending 里加，
 * 所以发版时群里看到的就是这一版真实做了什么，不用人再手写一遍。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');
const { getClient, sendInteractive, sendCardTo, sendText, sendTextTo, withTimeout } = require('./feishu');
const C = require('./cards');

const DB_FILE = path.join(cfg.ROOT, 'releases.json');
const CONFIG_FILE = path.join(cfg.ROOT, 'config.json');

/** 空的存档结构 */
function emptyDb() {
  return { pending: [], last: null, history: [] };
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      pending: Array.isArray(db.pending) ? db.pending : [],
      last: db.last || null,
      history: Array.isArray(db.history) ? db.history : [],
      announcedItems: Array.isArray(db.announcedItems) ? db.announcedItems : [],
      lastAnnounced: db.lastAnnounced || null,
    };
  } catch (e) {
    return emptyDb();
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch (e) {
    log('写 releases.json 失败：' + ((e && e.message) || e));
    return false;
  }
}

function ownerOpenId() {
  return (cfg.INBOX && cfg.INBOX.notifyOpenId) || '';
}

/** 配置里的公告目标群 */
function targetChats() {
  const r = cfg.RELEASE || {};
  return Array.isArray(r.chats) ? r.chats.filter(Boolean) : [];
}

/**
 * 兜底：万一忘了用 scripts/note.js 记，就从工作空间的 CHANGELOG 里
 * 捞上一版发布之后写的条目（`## YYYY-MM-DD · 标题` 分节，下面 `- ` 开头的行）。
 */
function changelogItems(sinceMs) {
  const p = path.join(cfg.ROOT, '..', '..', '07-变更记录', 'CHANGELOG.md');
  if (!fs.existsSync(p)) return [];
  const since = Number(sinceMs) || 0;
  const sinceDay = since ? new Date(since) : null;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const floorDay = sinceDay ? ymd(sinceDay) : '';
  const out = [];
  let on = false;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const h = /^##\s+(\d{4}-\d{2}-\d{2})\s*·/.exec(line);
    if (h) {
      on = !floorDay || h[1] >= floorDay;
      continue;
    }
    if (!on) continue;
    const item = /^-\s+(.+)$/.exec(line.trim());
    if (item) out.push(item[1].trim());
  }
  return out.slice(0, 12);
}

/** 记一条「待发布」的改动说明 */
function addNote(text, at) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: '空的' };
  const db = loadDb();
  db.pending.push({ at: at || Date.now(), text: t });
  saveDb(db);
  return { ok: true, count: db.pending.length };
}

/** 从飞书开放平台拿最新的已发布版本 */
async function fetchLatest() {
  if (!cfg.APP_ID) throw new Error('没配 FEISHU_APP_ID');
  const res = await withTimeout(
    getClient().application.v6.applicationAppVersion.list({
      path: { app_id: cfg.APP_ID },
      params: { lang: 'zh_cn', page_size: 20, order: 0 },
    }),
    10000,
    '查应用版本',
  );
  const items = ((res && res.data && res.data.items) || []).filter((i) => i && i.version);
  if (!items.length) return null;
  // 只看发布过的（publish_time 有值），按发布时间取最新
  const published = items
    .filter((i) => Number(i.publish_time) > 0)
    .sort((a, b) => Number(b.publish_time) - Number(a.publish_time));
  const pick = published[0] || items[0];
  return {
    version: pick.version,
    versionId: pick.version_id || '',
    publishTime: Number(pick.publish_time) > 0 ? Number(pick.publish_time) * 1000 : 0,
    remark: (pick.remark && pick.remark.update_remark) || '',
  };
}

/** 把一条版本记录发成公告卡 */
async function announce(rec, chatIds) {
  const chats = (chatIds && chatIds.length ? chatIds : targetChats()).filter(Boolean);
  const card = C.releaseCard(rec);
  const sent = [];
  for (const chatId of chats) {
    const ok = await sendInteractive(chatId, card);
    sent.push(`${chatId}:${ok ? 'ok' : 'fail'}`);
  }
  if (!chats.length) {
    // 还没指定群：先发小熊本人，别让公告丢了
    const me = ownerOpenId();
    if (me) sent.push(`p2p:${(await sendCardTo(me, card)) ? 'ok' : 'fail'}`);
  }
  log(`版本公告 v${rec.version} 已发 → ${sent.join(' ') || '（没目标，也没发出去）'}`);
  return { chats: chats.length, sent };
}

/**
 * 攒出「上次公告之后到现在」的全部改动（2026-10-28 小熊定的：
 * 公告要写上次发公告那个版本 → 最新版本之间的所有更新，不是只写两版之间）。
 *
 * 已经公告过的条目记在 db.announcedItems 里，不会重复播。
 */
function collectItems(db) {
  const used = new Set(db.announcedItems || []);
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s && !used.has(s) && !out.includes(s)) out.push(s);
  };
  // 历史条目：从旧到新
  (db.history || []).slice().reverse().forEach((h) => (h.items || []).forEach(push));
  // 还没归到某个版本的零散记录
  (db.pending || []).forEach((p) => push(p.text));
  // 都没记过 → 从 CHANGELOG 兜
  if (!out.length) {
    const base = db.lastAnnounced || null;
    changelogItems(base ? base.publishTime : 0).forEach(push);
  }
  return out;
}

/**
 * 手动发布公告（2026-10-28 小熊改的规矩：不再自动发，只有他私聊发命令才发）。
 *
 * 内容 = 上次真正发出公告之后到现在的所有改动（跨多少个版本都算），归到当前最新版本名下。
 * 一条都没攒下来就回「没有新东西」（除非 force）。
 */
async function publish(opt) {
  const o = opt || {};
  const chats = (o.chats && o.chats.length ? o.chats : targetChats()).filter(Boolean);
  const latest = await fetchLatest();
  if (!latest) return { ok: false, reason: '没查到版本' };

  const db = loadDb();
  const base = db.lastAnnounced || null; // 上次真正发出去那一版（没有就是首次公告）
  const items = collectItems(db);

  if (!items.length && !o.force) {
    return {
      ok: true,
      sent: false,
      version: latest.version,
      reason: base ? `v${base.version} 之后没记到新改动` : '还没有可公告的改动',
    };
  }

  // 版本变了就新开一条记录，没变就挂在最新那条上
  let rec = (db.history || [])[0];
  if (!rec || rec.versionId !== latest.versionId) {
    rec = {
      version: latest.version,
      versionId: latest.versionId,
      publishTime: latest.publishTime,
      remark: latest.remark,
      recordedAt: Date.now(),
      announced: false,
      items: [],
    };
    db.history = [rec].concat(db.history || []).slice(0, 200);
  }
  if (!rec.items) rec.items = [];
  items.forEach((t) => { if (!rec.items.includes(t)) rec.items.push(t); });
  db.pending = [];
  db.last = { version: latest.version, versionId: latest.versionId, publishTime: latest.publishTime };

  const payload = {
    version: rec.version,
    remark: rec.remark,
    publishTime: rec.publishTime,
    items: rec.items.slice(),
    sinceVersion: base ? base.version : '',
  };

  const r = await announce(payload, chats);
  const anyOk = (r.sent || []).some((s) => String(s).endsWith('ok'));
  if (anyOk) {
    db.announcedItems = (db.announcedItems || []).concat(payload.items);
    db.lastAnnounced = { version: rec.version, versionId: rec.versionId, publishTime: rec.publishTime, at: Date.now() };
    rec.announced = true;
    rec.announcedAt = Date.now();
    rec.announcedTo = chats.slice();
  }
  saveDb(db);
  log(`版本公告 v${rec.version}（${payload.items.length} 条改动${base ? '，含 v' + base.version + ' 之后全部' : '，首次公告'}）已手动发出`);
  return { ok: true, sent: anyOk, version: rec.version, items: payload.items, result: r };
}

/**
 * 老接口保留：查一次版本并按需公告（现在默认不自动跑，别在定时任务里调）。
 * @param {object} opt force=强制把最新版本再播一次 | silent=只记录不发送（首次基线用）
 */
async function sync(opt) {
  const o = opt || {};
  const latest = await fetchLatest();
  if (!latest) return { ok: false, reason: '没查到版本' };

  const db = loadDb();
  const prev = db.last;
  const changed = !prev || prev.versionId !== latest.versionId || prev.version !== latest.version;

  if (!changed && !o.force) return { ok: true, changed: false, latest };

  // 首次运行：只记基线，不往群里刷公告
  const baseline = !prev && !o.force;
  let items = (db.pending || []).map((p) => p.text);
  if (!items.length) items = changelogItems(prev ? prev.publishTime : 0); // 忘了记就从 CHANGELOG 兜
  // 以前几版已经播过的别再重复播一次
  const used = new Set();
  (db.history || []).forEach((h) => (h.items || []).forEach((t) => used.add(t)));
  items = items.filter((t) => !used.has(t));
  const rec = {
    version: latest.version,
    versionId: latest.versionId,
    publishTime: latest.publishTime,
    remark: latest.remark,
    prevVersion: prev ? prev.version : '',
    items,
    recordedAt: Date.now(),
    announced: false,
  };

  db.pending = [];
  db.last = { version: latest.version, versionId: latest.versionId, publishTime: latest.publishTime };
  db.history = [rec].concat(db.history || []).slice(0, 200);

  let result = { ok: true, changed: true, baseline, latest, rec, sent: null };
  if (!baseline && !o.silent) {
    const r = await announce(rec, o.chats);
    rec.announced = r.chats > 0 || (r.sent || []).some((s) => s.endsWith('ok'));
    result.sent = r;
  }
  saveDb(db);
  log(`版本记录：v${latest.version}（${items.length} 条改动）${baseline ? ' ← 首次基线，未公告' : ''}`);
  return result;
}

/** /release：给一句人话的现状说明 */
async function status() {
  const db = loadDb();
  const latest = await fetchLatest().catch((e) => ({ error: (e && e.message) || e }));
  const lines = [];
  lines.push(`线上版本：${latest && latest.version ? 'v' + latest.version : '查不到（' + ((latest && latest.error) || '?') + '）'}`);
  if (latest && latest.publishTime) {
    lines.push(`发布时间：${new Date(latest.publishTime).toLocaleString('zh-CN', { hour12: false })}`);
  }
  lines.push(`已记录版本：${db.last ? 'v' + db.last.version : '（还没有）'}`);
  lines.push(`上次公告：${db.lastAnnounced ? 'v' + db.lastAnnounced.version + '（' + new Date(db.lastAnnounced.at).toLocaleString('zh-CN', { hour12: false }) + '）' : '（还没发过）'}`);
  const items = collectItems(db);
  lines.push(`还没公告的改动：${items.length} 条${db.lastAnnounced ? '（v' + db.lastAnnounced.version + ' 之后到现在）' : ''}`);
  items.forEach((t) => lines.push(`　• ${t}`));
  const chats = targetChats();
  lines.push(`公告群：${chats.length ? chats.length + ' 个' : '还没指定（用 /公告群 群名 设置）'}`);
  lines.push('模式：私聊 /release 先预览，可修改保存，点击发送按钮后才发送到群聊');
  return lines.join('\n');
}

/** 列出机器人在的群（供 /公告群 选目标） */
async function listChats() {
  const res = await withTimeout(
    getClient().im.v1.chat.list({ params: { page_size: 50 } }),
    10000,
    '查群列表',
  );
  return ((res && res.data && res.data.items) || []).map((c) => ({
    chatId: c.chat_id,
    name: c.name || '（无名群）',
  }));
}

/** 按名字关键字挑群 */
function matchChats(chats, kw) {
  const k = String(kw || '').trim();
  if (!k) return [];
  return chats.filter((c) => c.name.includes(k) || c.chatId.includes(k));
}

/** 把公告群写回 config.json（保留其它配置） */
function setChats(chatIds) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  raw.release = Object.assign({}, raw.release || {}, { enabled: true, chats: chatIds });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
  cfg.RELEASE = raw.release;
  return raw.release;
}

/**
 * /公告群 处理：无参数列现状，有参数按名字挑群并设为目标。
 * 设置目标不发送消息，须私聊 /release 预览并点击按钮确认。
 */
async function handleChatCommand(arg) {
  const kw = String(arg || '').trim();
  if (!kw) {
    const chats = await listChats();
    const cur = targetChats();
    const lines = [`当前公告群：${cur.length ? cur.join(', ') : '（没指定）'}`, '', '我在这些群里，挑一个：'];
    chats.forEach((c) => lines.push(`• ${c.name} — ${c.chatId}`));
    lines.push('', '用法：/公告群 逆天萌兽制作组');
    return lines.join('\n');
  }

  const chats = await listChats();
  const hit = matchChats(chats, kw);
  if (!hit.length) {
    return `没找到名字里带「${kw}」的群。我在这些群：\n${chats.map((c) => '• ' + c.name).join('\n')}`;
  }
  if (hit.length > 1) {
    return `「${kw}」匹配到 ${hit.length} 个群，说得更具体点：\n${hit.map((c) => '• ' + c.name).join('\n')}`;
  }

  setChats([hit[0].chatId]);
  return `✅ 公告群已设为「${hit[0].name}」（${hit[0].chatId}）。私聊 /release 预览，点击发送按钮后才会发到群里。`;
}

/**
 * 不再自动广播（2026-10-28 小熊要求：只有他私聊发 /release 才发）。
 * 这里只记一行日志；不再允许配置开启自动广播绕过预览确认。
 */
function startScheduler() {
  log('版本公告：私聊 /release 预览，点击确认按钮后才发送到群聊');
}

module.exports = {
  loadDb, saveDb, addNote, changelogItems, fetchLatest, sync, publish, announce, status,
  listChats, matchChats, setChats, handleChatCommand, startScheduler, targetChats, collectItems,
};
