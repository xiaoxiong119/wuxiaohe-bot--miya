'use strict';
const path = require('path');
// 统一任务标识；版本后缀由 epname.stripRev 处理，绝不能将裸数字场次当版本。
function parse(name) {
  const raw = path.basename(String(name || '')).replace(/\.(mp4|mov|mkv|avi|m4v|webm)$/i, '').replace(/^《[^》]+》\s*/, '').trim();
  const m = /^(?:第\s*|ep\s*)?(\d{1,4})(?:\s*集)?(?:\s*[-_]\s*(\d{1,4})|\s*第\s*(\d{1,4})\s*场)?(?=$|[\s_\-（(]|修改|改|v\d|终稿|定稿)/i.exec(raw);
  if (!m) return null;
  const episode = Number(m[1]), scene = m[2] || m[3] ? Number(m[2] || m[3]) : null;
  if (episode < 1 || (scene !== null && scene < 1)) return null;
  return { episode, scene, whole: /整集/.test(raw), label: `${episode}${scene === null ? '' : '-' + scene}` };
}
function sceneOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const m = /^(?:\d+[-_])?(\d+)$/.exec(s);
  if (!m || Number(m[1]) < 1) throw new Error('场次格式无效：' + s);
  return Number(m[1]);
}
function select(rows, identity) {
  if (!identity) throw new Error('文件名无法识别，请使用 64-1.mp4 或 64-整集.mp4');
  const same = rows.filter(r => Number(r.episode) === identity.episode);
  if (!same.length) throw new Error('没有找到对应制作任务：' + identity.label);
  // 该集只有一条任务 → 场次号不再作区分。这既是「同集同制作师合并成单集1场」的结果，
  // 也让普通单场集可以直接用「64.mp4」上传，不必写死 -1。
  if (same.length === 1) return same[0];
  const matches = same.filter(r => sceneOf(r.scene) === identity.scene);
  if (identity.scene === null && same.some(r => sceneOf(r.scene) !== null) && !identity.whole)
    throw new Error('该集已拆分场次，请明确场次编号；整集请使用"集数-整集"');
  if (matches.length !== 1) throw new Error('任务不存在或不唯一：' + identity.label + '，请核对表格');
  return matches[0];
}
function display(r) { return `${r.episode}${r.scene == null || r.scene === '' ? '' : '-' + sceneOf(r.scene)}`; }
module.exports = { parse, sceneOf, select, display };
