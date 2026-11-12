'use strict';
/**
 * 状态词表：读「当前项目表」里各单选字段实际有哪些选项。
 *
 * 为什么要这个：
 *   卡片流程是同一套代码，但两张表的下拉选项不一样 ——
 *   逆天萌兽2 的「剪辑进度」有 待开始/可剪辑/剪辑中/待审片/审片中/已定剪，
 *   逆天萌兽3 只有 待开始/可剪辑/已定剪（导演的表没加中间三档）。
 *   写一个表里不存在的选项，飞书直接报错，整张卡就废了。
 *   所以流程改成「按词表落地」：表里有这一档才写表，没有就记本地影子状态
 *   （flow-state.json → trimShadow），等走到表里真有的那一档（已定剪）再写。
 *
 * 词表每 5 分钟刷一次（跟着巡检走），改表选项不用重启机器人。
 */
const cfg = require('./config');
const { log } = require('./log');
const { allPages } = require('./pagination');

const TTL = 5 * 60 * 1000;
const cache = new Map(); // "appToken/tableId" -> { at, fields }

function key() {
  return `${cfg.BASE.appToken}/${cfg.BASE.tableId}`;
}

async function load(force) {
  const k = key();
  const hit = cache.get(k);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.fields;
  try {
    // 懒加载，避免自检脚本（没有凭证）在建模块阶段就崩
    const { getClient } = require('./feishu');
    const items = await allPages(pageToken => getClient().bitable.v1.appTableField.list({
      path: { app_token: cfg.BASE.appToken, table_id: cfg.BASE.tableId },
      params: { page_size: 100, page_token: pageToken },
    }), {label:'读状态词表',timeout:15000});
    const fields = {};
    for (const f of items) {
      const opts = (f.property && f.property.options) || [];
      fields[f.field_name] = new Set(opts.map((o) => o.name).filter(Boolean));
    }
    cache.set(k, { at: Date.now(), fields });
    return fields;
  } catch (e) {
    log(`状态词表读取失败（沿用上次，没有就按「全都有」处理）：${(e && e.message) || e}`);
    return hit ? hit.fields : null;
  }
}

function fields() {
  const hit = cache.get(key());
  return hit ? hit.fields : null;
}

/** 这张表里能不能写这个选项。词表还没读到时按「能写」处理，保持老行为 */
function has(field, value) {
  const f = fields();
  if (!f || !f[field]) return true;
  return f[field].has(value);
}

/** 某个字段的选项名列表；没读到返回 null */
function options(field) {
  const f = fields();
  return f && f[field] ? [...f[field]] : null;
}

/**
 * 写表失败时判断是不是「选项不存在」这类错误。
 * 真撞上了就退回影子状态，别让整张卡片报错。
 */
function isOptionError(e) {
  const m = String((e && e.message) || e);
  return /option|选项|optionvalue|invalid/i.test(m);
}

module.exports = { load, has, options, isOptionError, fields };
