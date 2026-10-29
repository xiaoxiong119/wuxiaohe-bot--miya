/** 私聊公告草稿：预览 → 编辑/保存 → 明确点击发送。草稿跨重启保留。 */
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const cfg = require('./config');
const release = require('./release');
const C = require('./cards');
const { getClient, sendInteractive, sendText, withTimeout } = require('./feishu');
const { log } = require('./log');
const FILE = path.join(cfg.ROOT, 'release-draft.json');
const busy = new Set();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function save(draft) {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(draft, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
function button(text, a, draft, type = 'default') {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type,
    behaviors: [{ type: 'callback', value: { a, d: draft.id, rev: draft.rev } }] };
}
function shell(title, elements) {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default', enable_forward: false },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    body: { direction: 'vertical', vertical_spacing: '12px', elements } };
}
function publicCard(draft) {
  return shell(draft.title, [{ tag: 'markdown', content: draft.content }]);
}
function previewCard(draft, notice = '') {
  const card = publicCard(draft);
  const names = draft.targets.map(t => t.name).join('、');
  card.body.elements.push({ tag: 'markdown', content: notice ||
    (draft.sent ? `✅ 已发送到：${names}` : `公告预览 · 确认后发送到：${names}`), text_size: 'notation' });
  if (!draft.sent) {
    const label = `发送到（${names}）`;
    card.body.elements.push(button(label.length <= 100 ? label : '发送到以上群聊', 'release_send', draft, 'primary_filled'));
    if (!draft.sendStarted) card.body.elements.push(button('修改公告内容', 'release_edit', draft));
  }
  return card;
}
// 飞书单个输入框最多 1000 字符；分段预填，避免长公告被截断。
function parts(content) {
  const out = [''];
  for (const char of content) {
    if (out[out.length - 1].length + char.length > 900) out.push('');
    out[out.length - 1] += char;
  }
  return out;
}
function editorCard(draft) {
  const chunks = parts(draft.content);
  const inputs = [{ tag: 'input', name: 'release_title', label: { tag: 'plain_text', content: '公告标题' },
    default_value: draft.title, required: true, max_length: 100, width: 'fill' }];
  chunks.forEach((content, i) => inputs.push({ tag: 'input', name: `release_body_${i}`,
    label: { tag: 'plain_text', content: chunks.length === 1 ? '公告正文' : `公告正文（${i + 1}/${chunks.length}，保存时按顺序拼接）` },
    default_value: content, input_type: 'multiline_text', rows: 8, max_length: 1000, width: 'fill' }));
  // 表单提交通过按钮 name 路由，不在 2.0 表单按钮上混用 behaviors/value。
  inputs.push({ tag: 'button', name: `release_save_${draft.id}_${draft.rev}`,
    text: { tag: 'plain_text', content: '保存并预览' }, type: 'primary_filled', form_action_type: 'submit' });
  return shell('修改公告内容', [
    { tag: 'markdown', content: '编辑标题和正文，保存后返回预览，再点击发送。保存不会发送到群聊。', text_size: 'notation' },
    { tag: 'form', name: 'release_form', elements: inputs },
    button('取消修改', 'release_cancel', draft),
  ]);
}

async function prepareUnlocked({ operator, chatId, force = false }) {
  if (!operator || operator !== cfg.INBOX.notifyOpenId) throw new Error('只有乌小熊可以预览公告');
  const targets = [...new Set(release.targetChats())];
  if (!targets.length) throw new Error('还没指定公告群，请先用 /公告群 <群名> 设置');
  const existing = load();
  if (!force && existing && !existing.sent && existing.owner === operator && existing.chatId === chatId &&
    JSON.stringify(existing.targets.map(t => t.id)) === JSON.stringify(targets)) {
    if (!await sendInteractive(chatId, existing.mode === 'edit' ? editorCard(existing) : previewCard(existing))) {
      throw new Error('草稿恢复失败，请重试 /release');
    }
    return existing;
  }
  const latest = await release.fetchLatest();
  if (!latest) throw new Error('没查到已发布版本');
  const db = release.loadDb();
  const sourceItems = release.collectItems(db);
  if (!sourceItems.length && !force) throw new Error('没有新的公告内容；如需重新编辑公告，可用 /release now');
  const payload = { ...latest, items: sourceItems, sinceVersion: db.lastAnnounced?.version || '' };
  const original = C.releaseCard(payload);
  const namedTargets = [];
  for (const id of targets) {
    const res = await withTimeout(getClient().im.v1.chat.get({ path: { chat_id: id } }), 10000, '查询公告群名称');
    if (res.code || !res.data?.name) throw new Error('无法读取公告群名称，请检查机器人是否仍在群内');
    namedTargets.push({ id, name: res.data.name });
  }
  const previous = !sourceItems.length && force ? db.history.find(h => h.announced) : null;
  const draft = { id: randomUUID(), rev: 0, owner: operator, chatId, latest, sourceItems,
    title: previous?.title || original.header.title.content,
    content: previous?.content || (previous ? C.releaseCard(previous).elements[0].text.content : original.elements[0].text.content),
    targets: namedTargets, delivered: [], mode: 'preview', createdAt: Date.now(), sent: false };
  save(draft);
  if (!await sendInteractive(chatId, previewCard(draft))) throw new Error('预览卡发送失败，请重试 /release');
  return draft;
}

async function prepare(options) {
  if (busy.size) throw new Error('公告正在处理，请稍后再试');
  busy.add('prepare');
  try { return await prepareUnlocked(options); }
  finally { busy.delete('prepare'); }
}

async function patch(messageId, card) {
  const res = await withTimeout(getClient().im.v1.message.patch({
    path: { message_id: messageId }, data: { content: JSON.stringify(card) },
  }), 10000, '更新公告预览');
  if (res.code) throw new Error(res.msg || '更新公告预览失败');
}

async function updatePreview(draft, messageId, card) {
  try { await patch(messageId, card); }
  catch (e) {
    // 更新失败时发一张新预览，草稿及修改内容均已落盘，旧卡因 rev 校验失效。
    if (!await sendInteractive(draft.chatId, card)) throw new Error('卡片更新失败，草稿已保存，请私聊 /release 恢复');
  }
}

function recordAnnouncement(draft) {
  const db = release.loadDb();
  const latest = draft.latest;
  db.announcedItems = [...new Set([...(db.announcedItems || []), ...draft.sourceItems])];
  // 只清掉生成这个草稿时收录的条目，预览期间新加的改动保留到下次。
  const source = new Set(draft.sourceItems);
  db.pending = db.pending.filter(p => !source.has(p.text) || p.at > draft.createdAt);
  db.last = latest;
  db.lastAnnounced = { ...latest, at: Date.now() };
  db.history.unshift({ ...latest, items: draft.sourceItems, title: draft.title, content: draft.content,
    announced: true, announcedAt: Date.now(), announcedTo: draft.delivered.slice(), recordedAt: draft.createdAt });
  db.history = db.history.slice(0, 200);
  if (!release.saveDb(db)) throw new Error('公告已发送，但发布记录保存失败，请重试以补记记录');
}

async function handle({ action, operator, chatId, messageId }) {
  if (!operator || operator !== cfg.INBOX.notifyOpenId) throw new Error('只有乌小熊可以操作公告');
  let value = action.value || {};
  if (action.name?.startsWith('release_save_')) {
    const match = /^release_save_([a-f0-9-]+)_(\d+)$/.exec(action.name);
    if (!match) throw new Error('无效的保存操作');
    value = { a: 'release_save', d: match[1], rev: Number(match[2]) };
  }
  const draft = load();
  if (!draft || draft.id !== value.d || draft.rev !== value.rev) throw new Error('这张预览已更新，请使用最新卡片');
  if (draft.owner !== operator || draft.chatId !== chatId) throw new Error('请在原私聊中操作公告');
  if (draft.sent) throw new Error('这份公告已发送，请勿重复发送');
  if (busy.size) throw new Error('正在处理，请勿重复点击');
  busy.add(draft.id);
  try {
    if (value.a === 'release_edit' || value.a === 'release_cancel') {
      if (draft.sendStarted) throw new Error('公告已开始向群聊发送，请先完成发送；重新编辑请用 /release now');
      draft.mode = value.a === 'release_edit' ? 'edit' : 'preview';
      draft.rev++;
      save(draft);
      await updatePreview(draft, messageId, draft.mode === 'edit' ? editorCard(draft) : previewCard(draft));
    } else if (value.a === 'release_save') {
      if (draft.mode !== 'edit') throw new Error('请先点击修改公告内容');
      const fields = action.form_value || {};
      const title = fields.release_title;
      const chunks = parts(draft.content).map((_, i) => fields[`release_body_${i}`]);
      if (typeof title !== 'string' || chunks.some(c => typeof c !== 'string')) throw new Error('表单内容不完整，请重新保存');
      const content = chunks.join('');
      if (!title.trim() || title.length > 100 || !content.trim()) throw new Error('标题和正文不能为空，标题最多 100 字');
      if (Buffer.byteLength(content, 'utf8') > 24000) throw new Error('公告正文过长，请精简后保存');
      draft.title = title.trim();
      draft.content = content;
      draft.mode = 'preview';
      draft.rev++;
      save(draft);
      await updatePreview(draft, messageId, previewCard(draft, '已保存 · 请确认公告内容，再点击发送。'));
    } else if (value.a === 'release_send') {
      if (draft.mode !== 'preview') throw new Error('请先保存修改并预览，再发送公告');
      draft.sendStarted = true;
      save(draft);
      for (const target of draft.targets) {
        if (draft.delivered.includes(target.id)) continue;
        // 固定 uuid：回调重投或网络超时后重试时，飞书按同一消息去重。
        const uuid = createHash('sha256').update(draft.id + target.id).digest('hex').slice(0, 40);
        const res = await withTimeout(getClient().im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: target.id, msg_type: 'interactive', content: JSON.stringify(publicCard(draft)), uuid },
        }), 10000, '发送公告');
        if (res.code || !res.data?.message_id) throw new Error(res.msg || '公告发送失败，请重试发送按钮');
        draft.delivered.push(target.id);
        save(draft);
      }
      recordAnnouncement(draft);
      draft.sent = true;
      save(draft);
      await updatePreview(draft, messageId, previewCard(draft));
      log(`公告确认发送完成：${draft.targets.map(t => t.name).join('、')}`);
    } else throw new Error('未知的公告操作');
  } finally { busy.delete(draft.id); }
}

function dispatch(context) {
  // 即刻响应回调，网络发送/更新卡片放到后台，避免超过飞书 3 秒限制。
  if (context.operator !== cfg.INBOX.notifyOpenId) return { toast: { type: 'error', content: '只有乌小熊可以操作公告' } };
  handle(context).catch(e => {
    log('公告操作失败：' + e.message);
    if (context.operator) sendText(context.chatId, '公告操作失败：' + e.message);
  });
  return { toast: { type: 'info', content: '已收到，正在处理…' } };
}

module.exports = { prepare, dispatch, handle, previewCard, editorCard, publicCard, parts };
