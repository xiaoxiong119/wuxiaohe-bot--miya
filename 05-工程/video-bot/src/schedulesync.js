/** /tbpq：只同步排期字段；不接入 flow，不发人员通知。 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const cfg = require('./config');
const { getClient, withTimeout } = require('./feishu');

const CLI = path.join(process.env.HOME, '.codebuddy/bin/lark-cli');
const CONFIG = path.join(cfg.ROOT, 'config.json');
const CLI_ENV = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
let running = false;
function config() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).scheduleSync; }
function check(res) {
  if (!res || res.code !== 0) throw new Error(`飞书返回失败：${res && res.code} ${res && res.msg}${res?.error ? ' ' + JSON.stringify(res.error) : ''}`);
  return res.data || {};
}
async function cli(args) {
  const { stdout } = await execFile(CLI, ['--profile', cfg.APP_ID, ...args, '--as', 'bot', '--format', 'json'], {
    timeout: 90000, maxBuffer: 24 * 1024 * 1024,
    env: CLI_ENV,
  });
  const result = JSON.parse(stdout);
  if (result.ok !== true) throw new Error(result.error?.message || '飞书读取失败');
  return result.data;
}
/**
 * 完整读取单元格区域（2026-11-03 修）。
 * CLI 的 --max-chars 默认 50 万字符；源表带 style 后 26 列 × 215 行约 127 万字符，
 * 超限会返回 has_more=true / ranges[0].truncated=true，被 parseSource 判为「读取不完整」。
 * 用 --output-path 把 payload 落盘（上限自动升到 20M），校验回执 complete 后读回，
 * 保持 parseSource 的单 range / 单 revision 假设不变。
 * 注意：CLI 只允许把文件写到 cwd / /tmp / ~/files，临时文件放在自身 logs 目录下。
 */
async function cellsGetFull(args) {
  const out = path.join(cfg.ROOT, 'logs', `tbpq-cells-${process.pid}-${Date.now()}.json`);
  try {
    const { stdout } = await execFile(CLI, ['--profile', cfg.APP_ID, ...args, '--output-path', out,
      '--max-chars', '20000000', '--as', 'bot', '--format', 'json'], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: CLI_ENV,
    });
    const receipt = JSON.parse(stdout);
    if (receipt.ok !== true) throw new Error(receipt.error?.message || '源排期读取失败');
    const info = receipt.data || {};
    if (info.complete !== true || info.truncated === true) throw new Error('源排期读取不完整（返回被截断），未写表');
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (data.has_more || data.ranges?.length !== 1 || data.ranges[0].truncated) throw new Error('源排期读取不完整，未写表');
    return data;
  } finally {
    fs.rmSync(out, { force: true });
  }
}
/** 特殊日整列：表头出现这些词就不算制作排期（2026-11-03 补「缓冲」）。 */
const SPECIAL_COL_RE = /调整|修改|围读|交付|剪辑预留|提交|缓冲/;
function color(value) {
  const s = String(value || '').toLowerCase();
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)$/.exec(s);
  return rgb ? '#' + rgb.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('') : s;
}
function text(value) {
  if (Array.isArray(value)) return value.map(v => v.text || v.name || '').join('');
  return String(value ?? '').trim();
}
/** 列号 → 列名（1 → A，24 → X），读取范围用，不再写死 U 列 */
function colName(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function date(value, year) {
  const m = /^(?:(\d{4})[年/\-])?(\d{1,2})[月/\-](\d{1,2})日?$/.exec(text(value));
  if (!m) throw new Error(`无法确定日期：${value}`);
  const y = Number(m[1] || year), month = Number(m[2]), day = Number(m[3]);
  const result = Date.parse(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`);
  if (!Number.isFinite(result) || new Date(result + 8 * 3600000).getUTCDate() !== day) throw new Error('无效排期日期');
  return result;
}
/**
 * 源表配色会整批更换（2026-11-03 实测：制作师色块几乎全部换色，且旧映射与新表冲突）。
 * 每段制作期的首格会写姓名简称（阳/乐/蓓/蕊/昕/杰…），据此动态推断「颜色 → 制作师」，
 * config.people 只作兜底。同一颜色出现两个不同简称时停止写入，避免把人配错。
 */
function inferPeople(data, conf) {
  const range = data.ranges[0];
  const columns = range.col_indices, rows = range.row_indices.map(Number);
  const cell = (r, c) => { const i = columns.indexOf(c), j = rows.indexOf(r); return i < 0 || j < 0 ? {} : (range.cells[j] || {})[i] || {}; };
  const special = new Set(columns.filter(c => SPECIAL_COL_RE.test(text(cell(2, c).value))));
  const found = new Map();
  for (const r of rows) for (const c of columns) {
    if (special.has(c) || ['A', 'B'].includes(c)) continue;
    const x = cell(r, c), alias = text(x.value);
    if (!alias || !conf.personAliases?.[alias]) continue;
    const bg = color(x.cell_styles?.background_color);
    if (!bg) continue;
    const person = conf.personAliases[alias], prev = found.get(bg);
    if (prev && prev.id !== person.id) throw new Error(`颜色 ${bg} 同时标注了${prev.name}和${person.name}，无法判断，未写表`);
    found.set(bg, { name: person.name, id: person.id });
  }
  return { ...conf.people, ...Object.fromEntries(found) };
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
  // 特殊日整列：不参与制作排期分配。2026-11-03 源表新增「剪辑预留」「提交」两列，
  // 它们是后期节点不是拍摄日，一并按特殊列跳过，否则会被当成拍摄日拉长排期。
  const specialCols = new Set(columns.filter(c => SPECIAL_COL_RE.test(text(cell(2, c).value))));
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
    if (!assigned.length) { warnings.push(`${label}：没有制作排期，暂不写入`); continue; }
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
      fields: { '集数': Number(match[1]), '场次': Number(match[2] || 1), '排期分段': label, ...(scenes.length ? { '场景': [...new Set(scenes)] } : {}),
        '制作师': [{ id: ids[0] }], '开始日期': Math.min(...assigned.map(p => p.time)), '预计完成日期': Math.max(...assigned.map(p => p.time)) },
    });
  }
  // 同一集被拆成多段、但整集都是同一个制作师做的 → 合成一条「单集1场」，
  // 场景取并集；只有不同制作师才保留分行，免得一个人的任务里混进别人的场次。
  const mergedResult = mergeSameArtist(items);
  if (!mergedResult.items.length || new Set(mergedResult.items.map(i => i.key)).size !== mergedResult.items.length) throw new Error('排期为空或分段重复');
  return { items: mergedResult.items, merges: mergedResult.merges, warnings, revision: data.revision };
}

/**
 * 按集数分组，同一集的所有分段制作师相同就合并。
 * 合并后的记录：场次=1、排期分段=`第N集`、场景=各段并集、开始取最早、预计完成取最晚。
 * 原始分段名记在 mergedKeys 里，plan() 用它找到旧的 -1/-2 记录并清掉多余的那条。
 */
function mergeSameArtist(items) {
  const byEpisode = new Map();
  for (const item of items) {
    const ep = item.fields['集数'];
    if (!byEpisode.has(ep)) byEpisode.set(ep, []);
    byEpisode.get(ep).push(item);
  }
  const out = [], merges = [];
  for (const [episode, group] of byEpisode) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const artistIds = new Set(group.map(g => (g.fields['制作师']?.[0] || {}).id).filter(Boolean));
    if (artistIds.size !== 1) { out.push(...group); continue; }
    const scenes = [...new Set(group.flatMap(g => g.fields['场景'] || []))];
    const label = `第${episode}集`;
    out.push({
      key: label,
      sourceRow: group[0].sourceRow,
      sceneBasis: group.map(g => g.sceneBasis).filter(Boolean).join(' / '),
      cells: group.flatMap(g => g.cells || []),
      personName: group[0].personName,
      mergedKeys: group.map(g => g.key),
      fields: {
        ...group[0].fields,
        '场次': 1,
        '排期分段': label,
        ...(scenes.length ? { '场景': scenes } : {}),
        '开始日期': Math.min(...group.map(g => g.fields['开始日期'])),
        '预计完成日期': Math.max(...group.map(g => g.fields['预计完成日期'])),
      },
    });
    merges.push(`${label}：${group.length} 个分段都是${group[0].personName || '同一人'}，已合并为单集1场（场景 ${scenes.join('、') || '空'}）`);
  }
  return { items: out, merges };
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
  if (['集数', '场次'].includes(field) && value != null) return JSON.stringify(Number(value));
  if (field === '制作师') return JSON.stringify((value || []).map(p => p.id).sort());
  if (field === '场景') return JSON.stringify([...(value || [])].sort());
  return JSON.stringify(value ?? null);
}
function plan(items, records, defaults = {}) {
  const index = new Map(), composite = new Map();
  const identity = fields => {
    const episode = Number(fields?.['集数']), scene = Number(fields?.['场次']);
    return Number.isInteger(episode) && episode > 0 && Number.isInteger(scene) && scene > 0 ? `${episode}:${scene}` : null;
  };
  for (const record of records) {
    const key = text(record.fields?.['排期分段']);
    const pair = identity(record.fields);
    if (key) {
      if (index.has(key)) throw new Error(`目标分段重复：${key}`);
      index.set(key, record);
    } else if (record.fields?.['集数'] != null && !pair) {
      throw new Error('目标记录缺少有效场次，不能安全匹配，未写表');
    }
    if (pair) {
      if (composite.has(pair)) throw new Error(`目标集数与场次重复：${pair}`);
      composite.set(pair, record);
    }
  }
  const used = new Set();
  const create = [], update = [], remove = [];
  let unchanged = 0;
  for (const item of items) {
    const merged = Array.isArray(item.mergedKeys) && item.mergedKeys.length > 1;
    const byKey = index.get(item.key), byPair = composite.get(identity(item.fields));
    let record = byKey || byPair;
    // 合并项：把这一集原来按分段建的记录（第104集-1 / -2 …）都翻出来，
    // 留一条改写成合并后的一条，其余删除；不删的话表里会留下没人管的旧分段。
    if (merged) {
      const candidates = [], seen = new Set();
      const push = r => { if (r && !seen.has(r.record_id)) { seen.add(r.record_id); candidates.push(r); } };
      for (const k of item.mergedKeys) push(index.get(k));
      push(record);
      const keep = candidates.find(r => Number(r.fields?.['场次']) === 1) || candidates[0] || null;
      for (const r of candidates) if (keep && r.record_id !== keep.record_id && !used.has(r.record_id)) remove.push(r.record_id);
      record = keep;
    } else {
      if (byKey && byPair && byKey.record_id !== byPair.record_id) throw new Error(`${item.key} 分段与场次指向不同记录`);
      // 源表把同集的多段合并/重新拆分时，允许把旧分段名改成新名（会走 update 写回）；
      // 跨集一律拒绝，避免把别的集数的记录认错。2026-11-03 新排期表重排后实测 7 处。
      if (record && text(record.fields['排期分段']) && text(record.fields['排期分段']) !== item.key) {
        const oldSeg = text(record.fields['排期分段']);
        const oldEp = /^第(\d+)集(?:-(\d+))?$/.exec(oldSeg)?.[1];
        const newEp = /^第(\d+)集(?:-(\d+))?$/.exec(item.key)?.[1];
        if (!oldEp || oldEp !== newEp) throw new Error(`${item.key} 与目标分段冲突（${oldSeg}）`);
      }
      if (record && byKey && identity(record.fields) && identity(record.fields) !== identity(item.fields)) throw new Error(`${item.key} 与目标场次冲突`);
    }
    if (record && used.has(record.record_id)) throw new Error('多个源分段匹配同一目标记录');
    if (record) used.add(record.record_id);
    if (!record) { create.push({ fields: { ...defaults, ...item.fields } }); continue; }
    const changed = Object.fromEntries(Object.entries(item.fields).filter(([k, v]) => canonical(record.fields[k], k) !== canonical(v, k)));
    for (const [field, value] of Object.entries(defaults)) {
      const current = record.fields[field];
      if (current == null || current === '' || (Array.isArray(current) && current.length === 0)) changed[field] = value;
    }
    if (Object.keys(changed).length) update.push({ record_id: record.record_id, fields: changed });
    else unchanged++;
  }
  return { create, update, unchanged, remove };
}
function missingOptions(items, fields) {
  return fields.filter(f => [3, 4].includes(f.type)).map(field => {
    const existing = new Set((field.property?.options || []).map(o => o.name));
    const wanted = items.flatMap(item => {
      const value = item.fields[field.field_name];
      return value == null ? [] : Array.isArray(value) ? value : [value];
    });
    return { field, names: [...new Set(wanted)].filter(name => !existing.has(name)) };
  }).filter(entry => entry.names.length);
}
async function ensureOptions(client, target, items) {
  // 重新读取字段，保留已有选项 ID、颜色和完整属性，只追加所需名称。
  const fresh = await listAll(args => client.bitable.v1.appTableField.list(args), target);
  const additions = missingOptions(items, fresh);
  for (const { field, names } of additions) {
    check(await withTimeout(client.bitable.v1.appTableField.update({
      path: { ...target, field_id: field.field_id },
      data: { field_name: field.field_name, type: field.type,
        ...(field.description !== undefined ? { description: field.description } : {}),
        property: { ...field.property, options: [...(field.property?.options || []), ...names.map(name => ({ name }))] } },
    }), 20000, '补建排期选项'));
  }
  if (additions.length) {
    const actual = await listAll(args => client.bitable.v1.appTableField.list(args), target);
    if (missingOptions(items, actual).length) throw new Error('补建选项后回读不一致，未写记录');
  }
}
/** /tbpq 在飞书开放平台注册的 command_id（由 application +slash-command-list 取得）。 */
const TBPQ_COMMAND_ID = '7701925894633311246';

/**
 * 把「当前项目 / 上次同步时间 / 排到第几集」刷到飞书斜杠命令的描述上。
 * 菜单里选指令时直接能看到排期进度，不用先跑一次才知道同步到哪。
 * 失败不影响同步本身（调用方 catch 掉）。
 */
async function refreshCommandDescription(conf, items) {
  const eps = (items || []).map(i => Number(i && i.fields && i.fields['集数'])).filter(n => Number.isFinite(n) && n > 0);
  if (!eps.length) return null;
  const lo = Math.min(...eps), hi = Math.max(...eps);
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const project = conf.projectName || '排期项目';
  const range = lo === hi ? `第 ${hi} 集` : `第 ${lo}–${hi} 集`;
  const short = `${project} · ${when} 同步 · ${range}`;
  const long = `${project}排期同步：上次 ${when}，覆盖${range}（${items.length} 个分段）；/tbpq 预览只读检查，不写表不发通知`;
  await cli(['application', '+slash-command-update', '--command-id', TBPQ_COMMAND_ID,
    '--description', long, '--description-i18n', `zh_cn=${short}`]);
  return short;
}

async function run({ dryRun = false, onProgress = null } = {}) {
  if (running) throw new Error('排期正在同步，请等本轮结束');
  running = true;
  // 阶段性进度反馈（发到会话里，失败不影响同步本身）
  const say = (t) => { try { if (onProgress) onProgress(t); } catch (e) { /* ignore */ } };
  try {
    const conf = config();
    if (!conf || conf.enabled !== true) throw new Error('排期同步未配置');
    if (conf.appToken === cfg.BASE.appToken && conf.tableId === cfg.BASE.tableId) throw new Error('测试排期禁止指向正式流程表');
    say(`📅 排期同步${dryRun ? '（预览）' : ''}：开始读取源排期表…`);
    const meta = await cli(['sheets', '+workbook-info', '--spreadsheet-token', conf.spreadsheetToken]);
    const sheet = meta.sheets.find(s => s.sheet_id === conf.sheetId);
    // 列数不写死：源表 2026-11-03 已从 21 列扩到 26 列（缓冲/修改/剪辑预留/提交 + 排期延到 12 月）。
    // 只保下界（少了说明表被截断）和上界（防止读到无关的宽表）。
    if (!sheet || sheet.resource_type !== 'sheet' || sheet.column_count < 21 || sheet.column_count > 40 || sheet.row_count > 5000) throw new Error('源子表结构已变化');
    const lastCol = colName(sheet.column_count);
    const range = `A1:${lastCol}${sheet.row_count}`;
    const cellsArgs = ['sheets', '+cells-get', '--spreadsheet-token', conf.spreadsheetToken, '--sheet-id', conf.sheetId, '--range', range, '--include', 'value,style'];
    const layoutArgs = ['sheets', '+sheet-info', '--spreadsheet-token', conf.spreadsheetToken, '--sheet-id', conf.sheetId, '--include', 'merges,hidden_rows,hidden_cols'];
    // 源表可能正被编辑，两次读取 revision 不一致时重读，最多 3 轮；仍不一致就停，不写表。
    let parsed;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await cellsGetFull(cellsArgs);
      const layout = await cli(layoutArgs);
      if (layout.revision !== data.revision) {
        if (attempt === 2) throw new Error('源表在读取过程中被修改，请重新同步');
        continue;
      }
      parsed = parseSource(data, layout, { ...conf, people: inferPeople(data, conf) });
      break;
    }
    const epCount = new Set(parsed.items.map(i => i.fields['集数'])).size;
    say(`源排期读完了：${epCount} 集 / ${parsed.items.length} 个分段，正在比对目标表…`);
    const client = getClient(), target = { app_token: conf.appToken, table_id: conf.tableId };
    const fields = await listAll(args => client.bitable.v1.appTableField.list(args), target);
    const required = { '集数': 2, '场次': 2, '场景': 4, '制作师': 11, '开始日期': 5, '预计完成日期': 5 };
    for (const [name, type] of Object.entries(required)) if (!fields.some(f => f.field_name === name && f.type === type)) throw new Error(`目标字段不匹配：${name}`);
    const segmentField = fields.find(f => f.field_name === '排期分段');
    if (segmentField && segmentField.type !== 1) throw new Error('排期分段必须是文本字段');
    const defaults = conf.defaultFields || {};
    for (const name of Object.keys(defaults)) if (!fields.some(f => f.field_name === name && [1, 3, 4].includes(f.type))) throw new Error(`默认字段不存在或类型不支持：${name}`);
    const optionItems = [...parsed.items, { fields: defaults }];
    const optionAdditions = missingOptions(optionItems, fields).map(({ field, names }) => ({ field: field.field_name, names }));
    const records = await listAll(args => client.bitable.v1.appTableRecord.list(args), target);
    const changes = plan(parsed.items, records, defaults);
    const points = conf.pointsTableId ? await require('./points-sync').prepare(client, {app_token:conf.appToken,table_id:conf.pointsTableId}, parsed.items, listAll, conf.projectName) : null;
    // API 写人员字段不操作网页的“通知”选项，也不调用 IM；还须阻止表内工作流间接发信。
    const workflows = await cli(['base', '+workflow-list', '--base-token', conf.appToken]);
    if (workflows.total !== 0 || (workflows.items || []).length) throw new Error('目标存在工作流，无法保证静默，未写表');
    if (!dryRun) say(`比对完成：新增 ${changes.create.length}、更新 ${changes.update.length}、删除 ${changes.remove.length} 条（不变 ${changes.unchanged}），开始写入…`);
    const report = { at: new Date().toISOString(), dryRun, projectName: conf.projectName, sourceRevision: parsed.revision, sourceUrl: conf.sourceUrl, targetUrl: conf.targetUrl,
      notificationMode: 'OpenAPI-fields-only; no-IM; no-workflows', total: parsed.items.length, episodes: new Set(parsed.items.map(i => i.fields['集数'])).size,
      points: points ? {created:points.create.length, unchanged:points.unchanged} : null,
      created: changes.create.length, updated: changes.update.length, unchanged: changes.unchanged, removed: changes.remove.length, optionAdditions, merges: parsed.merges, warnings: parsed.warnings, items: parsed.items };
    const reportPath = path.join(cfg.ROOT, 'logs', `tbpq-${Date.now()}-${dryRun ? 'preview' : 'sync'}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: 'planned' }, null, 2));
    if (!dryRun) {
      await ensureOptions(client, target, optionItems);
      if (!segmentField) check(await client.bitable.v1.appTableField.create({ path: target, data: { field_name: '排期分段', type: 1 } }));
      for (const [kind, entries] of [['batchCreate', changes.create], ['batchUpdate', changes.update]]) {
        // 串行写入；每次重新读目标、按分段去重，避免重复触发排期更新。
        for (let i = 0; i < entries.length; i += 100) {
          const batch = entries.slice(i, i + 100);
          say(`写入中 ${Math.min(i + batch.length, entries.length)}/${entries.length} 条…`);
          const result = check(await withTimeout(client.bitable.v1.appTableRecord[kind]({ path: target, params: { user_id_type: 'open_id' }, data: { records: batch } }), 30000, '写排期'));
          if (result.records?.length !== batch.length) throw new Error('写入回执不完整，请运行预览核对后重试');
        }
      }
      // 合并后多余的旧分段（例如「第104集-2」）在这里清掉，否则表里会留着没人管的记录。
      // 放在写入之后：先保证合并后的那条已经写好，删错了也能从同步日志还原。
      for (let i = 0; i < changes.remove.length; i += 500) {
        const batch = changes.remove.slice(i, i + 500);
        check(await withTimeout(client.bitable.v1.appTableRecord.batchDelete({ path: target, data: { records: batch } }), 30000, '删除合并前的旧分段'));
      }
      const actual = await listAll(args => client.bitable.v1.appTableRecord.list(args), target);
      const remaining = plan(parsed.items, actual, defaults);
      if (remaining.create.length || remaining.update.length) throw new Error('写入后回读不一致，请查看同步日志');
      if (points) { say('写入完成，正在补齐积分统计行…'); await require('./points-sync').apply(client, points, parsed.items, listAll, check, withTimeout); }
      report.verified = true;
    }
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, status: dryRun ? 'preview' : 'verified' }, null, 2));
    // 真同步成功后，把「当前项目 / 上次同步时间 / 排到第几集」刷到飞书斜杠命令的描述上，
    // 这样在选择指令的菜单里一眼能看到排期进度，不用先跑一次。
    if (!dryRun) await refreshCommandDescription(conf, parsed.items).catch(e => console.error('刷新 /tbpq 命令描述失败：' + ((e && e.message) || e)));
    return { ...report, reportPath };
  } finally { running = false; }
}
function summary(r) {
  return [`${r.projectName || ''}${r.dryRun ? '排期预览' : '✅ 排期同步完成'}：${r.episodes} 集 / ${r.total} 个分段`,
    `${r.dryRun ? '将新增' : '新增'} ${r.created}，${r.dryRun ? '将更新' : '更新'} ${r.updated}，不变 ${r.unchanged}。`,
    ...(r.removed ? [`${r.dryRun ? '将删除' : '删除'} ${r.removed} 条合并前的旧分段（同一集同一制作师已合成单集1场）。`] : []),
    ...((r.optionAdditions || []).length ? [`${r.dryRun ? '将自动补建' : '自动补建'}选项：${r.optionAdditions.map(e => e.field + '：' + e.names.join('、')).join('；')}`] : []),
    ...(r.points ? [`积分统计：补齐 ${r.points.created} 行，已有 ${r.points.unchanged} 行保持不变；不修改积分。`] : []),
    '同步排期和制作师，空白状态补默认值；保留已有状态，不发送人员通知。',
    ...((r.merges || []).length ? ['合并提示：', ...r.merges] : []),
    ...(r.warnings.length ? ['待补场景：', ...r.warnings] : []), r.targetUrl].join('\n');
}
module.exports = { isRunning: () => running, run, summary, parseSource, plan, color, date, missingOptions, ensureOptions, refreshCommandDescription, TBPQ_COMMAND_ID };
