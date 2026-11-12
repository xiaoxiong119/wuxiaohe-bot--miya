/**
 * 多维表格：查一条、改一个字段
 *
 * 只面向 config.base 里配的那张表（当前是《逆天萌兽2》的 ✅任务管理），
 * 不做通用 base 客户端 —— 免得在飞书里误改别的东西。
 */
const cfg = require('./config');
const { getClient } = require('./feishu');
const { log } = require('./log');
const { allPages, dataOf } = require('./pagination');
const { withTimeout } = require('./feishu');

const B = cfg.BASE || {};

function ready() {
  return !!(B.appToken && B.tableId);
}

/** 字段元数据（含单选项），用于校验值、拿选项列表 */
async function listFields() {
  const rows = await allPages(pageToken => getClient().bitable.v1.appTableField.list({
    path: { app_token: B.appToken, table_id: B.tableId },
    params: { page_size: 100, page_token: pageToken },
  }), { label: '读字段' });
  return rows.map((f) => ({
    name: f.field_name,
    type: f.type,
    options: ((f.property && f.property.options) || []).map((o) => o.name),
  }));
}

/** 按「集数」精确查记录 */
async function findRecords(episode) {
  return allPages(pageToken => getClient().bitable.v1.appTableRecord.search({
    path: { app_token: B.appToken, table_id: B.tableId },
    params: { page_size: 500, page_token: pageToken },
    data: {
      field_names: [],
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: B.episodeField, operator: 'is', value: [String(episode)] },
        ],
      },
    },
  }), { label: '查制作任务' });
}

/** 改一条记录的若干字段 */
async function updateRecord(recordId, fields) {
  const res = await withTimeout(getClient().bitable.v1.appTableRecord.update({
    path: { app_token: B.appToken, table_id: B.tableId, record_id: recordId },
    data: { fields },
  }), 20000, '写记录');
  const record = dataOf(res, '写记录').record;
  if (!record) throw new Error('写记录返回缺少回执，请先核对表格再重试');
  return record;
}

/** 新建一条记录（测试集不存在时用） */
async function createRecord(fields) {
  const res = await withTimeout(getClient().bitable.v1.appTableRecord.create({
    path: { app_token: B.appToken, table_id: B.tableId },
    data: { fields },
  }), 20000, '写记录');
  const record = dataOf(res, '写记录').record;
  if (!record) throw new Error('写记录返回缺少回执，请先核对表格再重试');
  return record;
}

/** 把人名字段拍平 */
function personNames(record) {
  const v = (record.fields || {})[B.personField];
  if (!Array.isArray(v)) return [];
  return v.map((p) => (typeof p === 'string' ? p : p && p.name)).filter(Boolean);
}

/** 单选值可能是字符串也可能是数组 */
function flatValue(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
  if (v && typeof v === 'object') return v.text || v.name || '';
  return v == null ? '' : String(v);
}

/**
 * 从一句话里抠出「第几集 / 改哪个字段 / 改成什么」。
 * 例：把70集的素材生成进展改成已上传
 */
function parseEdit(text) {
  const ep = /(?:第)?(\d{1,4})(?:[-_](\d+))?\s*集/.exec(text) || /(\d{1,4})[-_](\d+)/.exec(text);
  const sc = /第?\s*(\d+)\s*场/.exec(text);
  const field = (B.writableFields || []).find((f) => text.includes(f)) || '';
  const vm = /(?:改成|改为|设为|设成|标记为|更新为|变成|调成)\s*[「“"'《]?([^「」“”"'《》，,。；;！!\s]+)/.exec(text);
  return {
    episode: ep ? ep[1] : '',
    scene: ep?.[2] || sc?.[1] || '',
    field,
    value: vm ? vm[1] : '',
  };
}

/** 把用户说的值对到选项上：先别名，再精确，再包含 */
function matchOption(input, options) {
  if (!input) return '';
  const v = String(input).trim();
  const aliases = B.valueAliases || {};
  if (aliases[v] && options.includes(aliases[v])) return aliases[v];
  if (options.includes(v)) return v;
  const matches = options.filter((o) => o.includes(v) || v.includes(o));
  return matches.length === 1 ? matches[0] : '';
}

/**
 * 执行一次「改字段」。返回给用户看的文本。
 */
async function editField(text) {
  if (!ready()) return '多维表格还没配（config.json 里缺 base 段）。';

  const { episode, scene, field, value } = parseEdit(text);
  if (!episode) return `没看出要改哪一集，说清「第几集」，比如：${'/base'} 把 70 集的素材生成进展改成已上传`;
  if (!field) {
    return `没认出要改哪个字段。可改的：${(B.writableFields || []).join(' / ')}`;
  }
  if (!value) return `没看出要改成什么，比如：把 ${episode} 集的${field}改成已上传`;

  const fields = await listFields();
  const target = fields.find((f) => f.name === field);
  if (!target) return `表里没有「${field}」这个字段。`;

  const val = matchOption(value, target.options);
  if (!val) {
    return `「${value}」不是「${field}」的选项。可选：${target.options.join(' / ') || '（非单选字段）'}`;
  }

  let records = await findRecords(episode);
  if (scene) records = records.filter(r => Number(flatValue(r.fields?.['场次'])) === Number(scene));
  if (!scene && require('./project-context').current().sceneMode) return '请明确场次，例如：逆天萌兽3 把64-1集的素材生成进展改成修改中';
  if (!records.length) return `没找到 ${episode} 集的记录（按「${B.episodeField}」查的）。`;

  let record = records[0];
  if (records.length > 1) {
    const names = records.map((r) => personNames(r).join('、') || '(空)');
    const hits = records.filter((r) => personNames(r).some((n) => text.includes(n)));
    const hit = hits.length === 1 ? hits[0] : null;
    if (!hit) {
      return `${episode} 集有 ${records.length} 条记录，分别属于：${names.join(' / ')}。\n请带上名字再说一次。`;
    }
    record = hit;
  }

  const taskLabel = `${episode}${scene ? '-' + scene : ''}`;
  const before = flatValue((record.fields || {})[field]);
  if (before === val) {
    return `${taskLabel} 集的${field}本来就是「${val}」，没动。`;
  }

  await updateRecord(record.record_id, { [field]: val });
  const who = personNames(record).join('、');
  log(`改表：${taskLabel} 集（${who}）${field} ${before || '空'} → ${val}`);
  return `✅ 已改：${taskLabel} 集${who ? `（${who}）` : ''} · ${field}：${before || '空'} → ${val}`;
}

module.exports = { ready, listFields, findRecords, updateRecord, createRecord, parseEdit, matchOption, editField, flatValue, personNames };
