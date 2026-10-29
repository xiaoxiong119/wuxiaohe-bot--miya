/** /tbpq：只同步排期字段；不接入 flow，不发人员通知。 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const cfg = require('./config');
const { getClient, withTimeout } = require('./feishu');

const CLI = '/Users/fanxiaoli/.codebuddy/bin/lark-cli';
const CONFIG = path.join(cfg.ROOT, 'config.json');
let running = false;
function config() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).scheduleSync; }
function check(res) {
  if (!res || res.code !== 0) throw new Error(`飞书返回失败：${res && res.code} ${res && res.msg}`);
  return res.data || {};
}
async function cli(args) {
  const { stdout } = await execFile(CLI, ['--profile', cfg.APP_ID, ...args, '--as', 'bot', '--format', 'json'], {
    timeout: 90000, maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });
  const result = JSON.parse(stdout);
  if (result.ok !== true) throw new Error(result.error?.message || '飞书读取失败');
  return result.data;
}
function color(value) {
  const s = String(value || '').toLowerCase();
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)$/.exec(s);
  return rgb ? '#' + rgb.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('') : s;
}
function text(value) {
  if (Array.isArray(value)) return value.map(v => v.text || v.name || '').join('');
  return String(value ?? '').trim();
}
function date(value, year) {
  const m = /^(?:(\d{4})[年/\-])?(\d{1,2})[月/\-](\d{1,2})日?$/.exec(text(value));
  if (!m) throw new Error(`无法确定日期：${value}`);
  const y = Number(m[1] || year), month = Number(m[2]), day = Number(m[3]);
  const result = Date.parse(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`);
  if (!Number.isFinite(result) || new Date(result + 8 * 3600000).getUTCDate() !== day) throw new Error('无效排期日期');
  return result;
}
function parseSource(data, layout, conf) {
  if (data.has_more || data.ranges?.length !== 1 || data.ranges[0].truncated) throw new Error('源排期读取不完整，未写表');
  const range = data.ranges[0];
  const rows = new Map(range.row_indices.map((r, i) => [Number(r), range.cells[i]]));
  const columns = range.col_indices;
  const cell = (r, c) => rows.get(r)?.[columns.indexOf(c)] || {};
  if (text(cell(3, 'B').value) !== '集数') throw new Error('源表表头发生变化，请先核对');
  const dates = columns.filter(c => !['A', 'B'].includes(c)).map(c => ({ c, time: date(cell(3, c).value, conf.year) }));
  for (let i = 1; i < dates.length; i++) if (dates[i].time <= dates[i - 1].time) throw new Error('日期列没有按时间递增');
  const specialCols = new Set(columns.filter(c => /调整|修改|围读|交付/.test(text(cell(2, c).value))));
  const merges = layout.merged_cells || [];
  function sceneValue(r) {
    let value = text(cell(r, 'A').value);
    for (const merge of merges) {
      const m = /^A(\d+):A(\d+)$/.exec(merge.range);
      if (m && r >= Number(m[1]) && r <= Number(m[2])) value = text(cell(Number(m[1]), 'A').value);
    }
    return value;
  }
  const warnings = [], items = [];
  for (const r of range.row_indices.map(Number)) {
    const label = text(cell(r, 'B').value);
    const match = /^第(\d+)集(?:-(\d+))?$/.exec(label);
    if (!match) {
      if (r > 3 && label) throw new Error(`B${r} 集数格式不支持：${label}`);
      continue;
    }
    const assigned = [];
    for (const d of dates) {
      // 特殊日的整列背景不是人员分配；空文字的普通色块仍然代表排期。
      if (specialCols.has(d.c)) continue;
      const sourceCell = cell(r, d.c);
      const bg = color(sourceCell.cell_styles?.background_color);
      const person = conf.people[bg];
      if (!person) {
        if (bg && !conf.ignoredColors.includes(bg)) throw new Error(`${d.c}${r} 颜色 ${bg} 未配置人员，未写表`);
        if (text(sourceCell.value)) throw new Error(`${d.c}${r} 有文字但缺少人员色，未写表`);
        continue;
      }
      assigned.push({ ...d, ...person, address: `${d.c}${r}` });
    }
    if (!assigned.length) throw new Error(`${label} 没有可识别的制作排期`);
    const ids = [...new Set(assigned.map(p => p.id))];
    if (ids.length !== 1) throw new Error(`${label} 同段出现多人，需先拆分分段，避免混淆日期`);
    const rawScene = sceneValue(r);
    let scenes = rawScene ? rawScene.split(/[\/／\n]/).map(s => s.trim()).filter(Boolean).flatMap(s => conf.sceneAliases[s] || [s]) : [];
    let sceneBasis = rawScene ? '源表（含真实合并单元格）' : '';
    if (!scenes.length && !match[2] && conf.verifiedScenes[match[1]]) {
      scenes = conf.verifiedScenes[match[1]];
      sceneBasis = '正式任务表已核实场景（源排期为空）';
    }
    if (!scenes.length && !(conf.ignoredMissingScenes || []).includes(label)) warnings.push(`${label}（A${r}）：源场景空白，未推测分段场景`);
    items.push({ key: label, sourceRow: r, sceneBasis, cells: assigned.map(p => p.address), personName: assigned[0].name,
      fields: { '集数': Number(match[1]), '排期分段': label, ...(scenes.length ? { '场景': [...new Set(scenes)] } : {}),
        '制作师': [{ id: ids[0] }], '开始日期': Math.min(...assigned.map(p => p.time)), '预计完成日期': Math.max(...assigned.map(p => p.time)) },
    });
  }
  if (!items.length || new Set(items.map(i => i.key)).size !== items.length) throw new Error('排期为空或分段重复');
  return { items, warnings, revision: data.revision };
}
async function listAll(method, target) {
  let token, out = [];
  for (let page = 0; page < 100; page++) {
    const data = check(await withTimeout(method({ path: target, params: { page_size: 100, ...(token ? { page_token: token } : {}), user_id_type: 'open_id' } }), 20000, '读排期目标'));
    out.push(...(data.items || []));
    if (!data.has_more) return out;
    if (!data.page_token || data.page_token === token) throw new Error('分页未读全');
    token = data.page_token;
  }
  throw new Error('分页超过上限');
}
function canonical(value, field) {
  // OpenAPI 将数字主字段以数字字符串读回（即使 schema 为 Number）。
  if (field === '集数' && value != null) return JSON.stringify(Number(value));
  if (field === '制作师') return JSON.stringify((value || []).map(p => p.id).sort());
  if (field === '场景') return JSON.stringify([...(value || [])].sort());
  return JSON.stringify(value ?? null);
}
function plan(items, records) {
  const index = new Map();
  for (const record of records) {
    const key = text(record.fields?.['排期分段']);
    if (!key) {
      if (record.fields?.['集数'] != null) throw new Error('目标存在没有排期分段的记录，不能安全匹配，未写表');
      continue;
    }
    if (index.has(key)) throw new Error(`目标分段重复：${key}`);
    index.set(key, record);
  }
  const create = [], update = [];
  let unchanged = 0;
  for (const item of items) {
    const record = index.get(item.key);
    if (!record) { create.push({ fields: item.fields }); continue; }
    const changed = Object.fromEntries(Object.entries(item.fields).filter(([k, v]) => canonical(record.fields[k], k) !== canonical(v, k)));
    if (Object.keys(changed).length) update.push({ record_id: record.record_id, fields: changed });
    else unchanged++;
  }
  return { create, update, unchanged };
}
async function run({ dryRun = false } = {}) {
  if (running) throw new Error('排期正在同步，请等本轮结束');
  running = true;
  try {
    const conf = config();
    if (!conf || conf.enabled !== true) throw new Error('排期同步未配置');
    if (conf.appToken === cfg.BASE.appToken && conf.tableId === cfg.BASE.tableId) throw new Error('测试排期禁止指向正式流程表');
    const meta = await cli(['sheets', '+workbook-info', '--spreadsheet-token', conf.spreadsheetToken]);
    const sheet = meta.sheets.find(s => s.sheet_id === conf.sheetId);
    if (!sheet || sheet.resource_type !== 'sheet' || sheet.column_count !== 21 || sheet.row_count > 5000) throw new Error('源子表结构已变化');
    const data = await cli(['sheets', '+cells-get', '--spreadsheet-token', conf.spreadsheetToken, '--sheet-id', conf.sheetId, '--range', `A1:U${sheet.row_count}`, '--include', 'value,style']);
    const layout = await cli(['sheets', '+sheet-info', '--spreadsheet-token', conf.spreadsheetToken, '--sheet-id', conf.sheetId, '--include', 'merges,hidden_rows,hidden_cols']);
    if (layout.revision !== data.revision) throw new Error('源表在读取过程中被修改，请重新同步');
    const parsed = parseSource(data, layout, conf);
    const client = getClient(), target = { app_token: conf.appToken, table_id: conf.tableId };
    const fields = await listAll(args => client.bitable.v1.appTableField.list(args), target);
    const required = { '集数': 2, '场景': 4, '制作师': 11, '开始日期': 5, '预计完成日期': 5 };
    for (const [name, type] of Object.entries(required)) if (!fields.some(f => f.field_name === name && f.type === type)) throw new Error(`目标字段不匹配：${name}`);
    const segmentField = fields.find(f => f.field_name === '排期分段');
    if (segmentField && segmentField.type !== 1) throw new Error('排期分段必须是文本字段');
    const options = fields.find(f => f.field_name === '场景').property.options.map(o => o.name);
    for (const item of parsed.items) for (const scene of item.fields['场景'] || []) if (!options.includes(scene)) throw new Error(`目标缺少场景选项：${scene}`);
    const records = await listAll(args => client.bitable.v1.appTableRecord.list(args), target);
    const changes = plan(parsed.items, records);
    // API 写人员字段不操作网页的“通知”选项，也不调用 IM；还须阻止表内工作流间接发信。
    const workflows = await cli(['base', '+workflow-list', '--base-token', conf.appToken]);
    if (workflows.total !== 0 || (workflows.items || []).length) throw new Error('目标存在工作流，无法保证静默，未写表');
    const report = { at: new Date().toISOString(), dryRun, sourceRevision: parsed.revision, sourceUrl: conf.sourceUrl, targetUrl: conf.targetUrl,
      notificationMode: 'OpenAPI-fields-only; no-IM; no-workflows', total: parsed.items.length, episodes: new Set(parsed.items.map(i => i.fields['集数'])).size,
      created: changes.create.length, updated: changes.update.length, unchanged: changes.unchanged, warnings: parsed.warnings, items: parsed.items };
    const reportPath = path.join(cfg.ROOT, 'logs', `tbpq-${Date.now()}-${dryRun ? 'preview' : 'sync'}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: 'planned' }, null, 2));
    if (!dryRun) {
      if (!segmentField) check(await client.bitable.v1.appTableField.create({ path: target, data: { field_name: '排期分段', type: 1 } }));
      for (const [kind, entries] of [['batchCreate', changes.create], ['batchUpdate', changes.update]]) {
        // 串行写入；每次重新读目标、按分段去重，避免重复触发排期更新。
        for (let i = 0; i < entries.length; i += 100) {
          const batch = entries.slice(i, i + 100);
          const result = check(await withTimeout(client.bitable.v1.appTableRecord[kind]({ path: target, params: { user_id_type: 'open_id' }, data: { records: batch } }), 30000, '写排期'));
          if (result.records?.length !== batch.length) throw new Error('写入回执不完整，请运行预览核对后重试');
        }
      }
      const actual = await listAll(args => client.bitable.v1.appTableRecord.list(args), target);
      const remaining = plan(parsed.items, actual);
      if (remaining.create.length || remaining.update.length) throw new Error('写入后回读不一致，请查看同步日志');
      report.verified = true;
    }
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: dryRun ? 'preview' : 'verified' }, null, 2));
    return { ...report, reportPath };
  } finally { running = false; }
}
function summary(r) {
  return [`${r.dryRun ? '排期预览' : '✅ 排期同步完成'}：${r.episodes} 集 / ${r.total} 个分段`,
    `${r.dryRun ? '将新增' : '新增'} ${r.created}，${r.dryRun ? '将更新' : '更新'} ${r.updated}，不变 ${r.unchanged}。`,
    '仅写排期和制作师，不发送人员通知；分段保留各自场景和日期。',
    ...(r.warnings.length ? ['待补场景：', ...r.warnings] : []), r.targetUrl].join('\n');
}
module.exports = { run, summary, parseSource, plan, color, date };
