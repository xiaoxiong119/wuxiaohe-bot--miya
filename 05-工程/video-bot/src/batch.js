'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getClient, sendTextTo } = require('./feishu');
const cfg = require('./config');
const file = path.join(__dirname, '../logs/batch-state.json');
let sessions = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const busy = new Set();
const flow = () => require('./flow');
const signature = r => JSON.stringify([r.projectKey, r.episode, r.scene, r.stage, r.review, r.trimStage, r.reviewers, r.editors]);
function eligible(r, user, kind) {
  if (!(kind === 'review' ? r.reviewers : r.editors).some(p => p.id === user)) return false;
  if (kind === 'review') return r.stage === '已粗剪待一审' && ['', '未审阅'].includes(r.review);
  // 剪辑进度：逆天萌兽3 的表里没有「剪辑中」，那一步记在机器人这边，所以看有效进度
  const trim = r.trimEffective || r.trimStage;
  return trim === '剪辑中' || (trim === '可剪辑' && r.review === '通过' && r.stage === '已完成并上传');
}
function save() {
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(sessions)); fs.renameSync(tmp, file);
}
const pt = content => ({ tag: 'plain_text', content });
const button = (text, value) => ({ tag: 'button', text: pt(text), behaviors: [{ type: 'callback', value }] });
function card(id, page = 0) {
  const s = sessions[id], rows = s.rows.slice(page * 20, page * 20 + 20);
  const options = rows.map(r => ({ text: pt(`${r.project} ${require('./task-identity').display(r)}集 · ${r.trimStage || r.stage}`), value: r.recordId }));
  const select = (name, label) => ({ tag: 'multi_select_static', name, placeholder: pt(label), options, width: 'fill' });
  const inputs = s.kind === 'review' ? [select('pass', '选择通过的集数'), select('fail', '选择不通过的集数'),
    { tag: 'input', name: 'note', label: pt('统一修改意见'), input_type: 'multiline_text', max_length: 1000 },
    { tag: 'input', name: 'individual', label: pt('逐集意见：每行写 集数：意见（同名集数请分开提交）'), input_type: 'multiline_text', max_length: 1000 }]
    : [select('selected', '选择本次处理的集数'), { tag: 'select_static', name: 'target', required: true, placeholder: pt('选择目标进度'), options: [
      { text: pt('开始剪辑'), value: 'trim_start' }, { text: pt('精剪完成 → 通知审片人终审'), value: 'trim_done' }] }];
  inputs.push({ tag: 'button', name: `batch_submit_${id}_${page}`, text: pt('提交本页所选集数'), type: 'primary_filled', form_action_type: 'submit' });
  const elements = [{ tag: 'markdown', content: `共 ${s.rows.length} 集，第 ${page + 1}/${Math.ceil(s.rows.length / 20)} 页。只提交当前页；翻页前请先提交。卡片有效期2小时。\n` + rows.map(r => `${r.project} ${require('./task-identity').display(r)}集 · ${r.trimStage || r.stage}`).join('\n') },
    { tag: 'form', name: 'batch_form', elements: inputs }];
  if (page > 0) elements.push(button('上一页', { a: 'batch_page', id, page: page - 1 }));
  if ((page + 1) * 20 < s.rows.length) elements.push(button('下一页', { a: 'batch_page', id, page: page + 1 }));
  elements.push(button('刷新待办（重新打开）', { a: 'batch_open', kind: s.kind, projectKey:s.projectKey }));
  return { schema: '2.0', config: { update_multi: true }, header: { title: pt((s.projectKey === 'legacy' ? '《逆天萌兽2》' : '') + (s.kind === 'review' ? '批量审阅粗剪' : '批量更新剪辑进度')), template: 'blue' }, body: { elements } };
}
async function patch(messageId, content) {
  const res = await getClient().im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(content) } });
  if (res.code) throw new Error(res.msg);
}
async function open(user, kind, projectKey) {
  if (fs.existsSync(file)) sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!user || !['review', 'trim'].includes(kind)) throw new Error('无效操作');
  // 待办只列当前巡检/发卡项目（2026-11-03 切到《逆天萌兽3》）；老测试脚本的 fakeFlow 没有 activeRecords，兜底回全查
  const list = await (flow().activeRecords ? flow().activeRecords() : flow().fetchAllRecords());
  const rows = list.filter(r => (!projectKey || r.projectKey === projectKey) && eligible(r, user, kind)).sort((a,b) => a.project.localeCompare(b.project) || a.episode.localeCompare(b.episode, 'zh', { numeric: true }));
  if (!rows.length) {
    const title = `${projectKey === 'legacy' ? '《逆天萌兽2》' : ''}${kind === 'review' ? '批量审阅粗剪' : '批量更新剪辑进度'}`;
    const empty = {schema:'2.0',header:{title:pt(title),template:'blue'},body:{elements:[{tag:'markdown',content:'目前没有分配给你且符合条件的待办。'},button('刷新待办',{a:'batch_open',kind,projectKey})]}};
    if (!await flow().sendCard(user, empty)) throw new Error('卡片发送失败');
    return {count:0};
  }
  for (const [k,s] of Object.entries(sessions)) if (Date.now() - s.at > 7200000) delete sessions[k];
  const id = crypto.randomBytes(8).toString('hex'); sessions[id] = { user, kind, projectKey, rows, at: Date.now(), results: {} }; save();
  if (!await flow().sendCard(user, card(id))) throw new Error('卡片发送失败');
  return {count:rows.length};
}
async function ensureNotes(projectKey) {
  return require('./project-context').run(projectKey || 'legacy', async () => {
  const b = cfg.BASE;
  const res = await getClient().bitable.v1.appTableField.list({ path: { app_token: b.appToken, table_id: b.tableId }, params: { page_size: 100 } });
  if (res.code) throw new Error(res.msg);
  const notesField = require('./project-context').current().notesField || '修改意见';
  const field = res.data.items.find(f => f.field_name === notesField);
  if (field) { if (field.type !== 1) throw new Error('修改意见字段不是文本类型'); return; }
  if (projectKey && projectKey !== 'legacy') throw new Error('缺少可写入的修改意见字段，请核对项目配置');
  const created = await getClient().bitable.v1.appTableField.create({ path: { app_token: b.appToken, table_id: b.tableId }, data: { field_name: '修改意见', type: 1 } });
  if (created.code) throw new Error(created.msg);
  });
}
async function dispatch(action, user, messageId) {
  if (!busy.size && fs.existsSync(file)) sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = action.value || {};
  if (v.a === 'batch_open') return open(user, v.kind, v.projectKey);
  const match = /^batch_submit_([a-f0-9]+)_(\d+)$/.exec(action.name || '');
  const id = match ? match[1] : v.id, s = sessions[id];
  if (!s || s.user !== user || Date.now() - s.at > 7200000) throw new Error('卡片已过期或不属于你，请重新打开');
  if (busy.has(id)) throw new Error('正在处理，请勿重复提交');
  if (v.a === 'batch_page') {
    if (!Number.isInteger(v.page) || v.page < 0 || v.page * 20 >= s.rows.length) throw new Error('无效页码');
    return patch(messageId, card(id, v.page));
  }
  if (!match) return;
  const f = action.form_value || {}, page = Number(match[2]), rows = s.rows.slice(page * 20, page * 20 + 20);
  const list = x => x == null ? [] : Array.isArray(x) && x.every(v => typeof v === 'string') ? [...new Set(x)] : (() => { throw new Error('无效的多选值'); })();
  const pass = list(f.pass), fail = list(f.fail), selected = list(f.selected);
  if (pass.some(r => fail.includes(r))) throw new Error('同一集不能同时通过和不通过');
  const jobs = s.kind === 'review' ? [...pass.map(r => [r, 'review_pass']), ...fail.map(r => [r, 'review_fail'])] : selected.map(r => [r, f.target]);
  if (s.kind === 'trim' && !['trim_start', 'trim_done'].includes(f.target)) throw new Error('请选择有效的剪辑目标');
  if (!jobs.length) throw new Error('请先选择集数');
  if (jobs.some(([r,a]) => !rows.some(x => x.recordId === r) || !['review_pass','review_fail','trim_start','trim_done'].includes(a))) throw new Error('无效选择');
  const notes = {};
  for (const line of String(f.individual || '').split('\n').filter(x => x.trim())) {
    const m = /^\s*(.+?)\s*[：:]\s*(.+)$/.exec(line);
    if (!m) throw new Error('逐集意见格式应为 集数：意见');
    const found = rows.filter(r => fail.includes(r.recordId) && require('./task-identity').display(r) === m[1].replace(/集$/, ''));
    if (found.length !== 1) throw new Error('逐集意见集数未选为不通过或存在重名：' + m[1]);
    notes[found[0].recordId] = m[2];
  }
  if (fail.some(r => !String(notes[r] || f.note || '').trim())) throw new Error('请为不通过的集数填写修改意见');
  busy.add(id);
  try {
    for (const key of new Set(rows.filter(r => fail.includes(r.recordId)).map(r => r.projectKey))) await ensureNotes(key);
    const results = [];
    for (const [r,a] of jobs) {
      const old = rows.find(x => x.recordId === r), label = `${old.project} ${require('./task-identity').display(old)}集`;
      if (s.results[r]) { results.push(`${label}：本卡已处理，已跳过`); continue; }
      try {
      const current = await flow().getRecord(r);
      const trim = current.trimEffective || current.trimStage;
      if (!eligible(current, user, s.kind) || signature(current) !== signature(old) || (a === 'trim_start' && trim !== '可剪辑') || (a === 'trim_done' && trim !== '剪辑中')) {
        results.push(`${label}：状态已变化或不满足目标条件，已跳过`); continue;
      }
      const result = await flow().handleCardAction({ a, r, batch: { kind: s.kind, signature: signature(old), note: notes[r] || String(f.note || '').trim() } }, user, '');
      const text = result?.toast?.content || '结果未知，请核对表格';
      if (result?.toast?.type === 'success') { s.results[r] = { a, at: Date.now() }; save(); }
      results.push(`${label}：${text}`);
      } catch (e) { results.push(`${label}：失败或部分完成，请核对表格：${e.message}`); }
    }
    await sendTextTo(user, '批量处理结果（通知失败请单独补发，勿重复改状态）：\n' + results.join('\n'));
  } finally { busy.delete(id); }
}
module.exports = { open, dispatch, eligible, signature, card };
