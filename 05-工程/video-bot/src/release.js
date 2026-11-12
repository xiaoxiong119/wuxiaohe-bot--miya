const { writeJson } = require('./json-file');
/** 版本查询、待公告条目与公告群配置。发送统一由 release-draft 的预览确认流程负责。 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');
const { getClient, withTimeout } = require('./feishu');

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
    writeJson(DB_FILE, db);
    return true;
  } catch (e) {
    log('写 releases.json 失败：' + ((e && e.message) || e));
    return false;
  }
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
  writeJson(CONFIG_FILE, raw);
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
  loadDb, saveDb, addNote, changelogItems, fetchLatest, status,
  listChats, matchChats, setChats, handleChatCommand, startScheduler, targetChats, collectItems,
};
