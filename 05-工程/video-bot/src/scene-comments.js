'use strict';
const ID = require('./task-identity');
const flat = v => Array.isArray(v) ? v.map(x => x.text || '').join('') : String(v ?? '');
function content(row) {
  return `【场次任务：${row.episode}${row.scene == null ? '-整集' : '-' + row.scene}】\n【源视频：${String(row.file || '').replace(/[\r\n】]/g, '')}】\n【视频版本：${String(row.version || '未识别').replace(/[\r\n】]/g, '')}】\n${row.timeline ? '【时间码：' + row.timeline + '】\n' : ''}${row.content}`;
}
function decode(value) {
  const s = flat(value);
  const m = /^【场次任务：(\d+)-(\d+|整集)】\n【源视频：([^\n]*)】\n【视频版本：([^\n]*)】\n/.exec(s);
  const time = m ? /^【时间码：([^\n]*)】\n/.exec(s.slice(m[0].length)) : null;
  return m ? { ...(time ? {timeline: time[1]} : {}), episode: Number(m[1]), scene: m[2] === '整集' ? null : Number(m[2]), file: m[3], version: m[4] === '未识别' ? '' : m[4], content: s.slice(m[0].length + (time ? time[0].length : 0)) } : null;
}
function key(row) {
  return JSON.stringify([row.episode, row.scene ?? null, row.file || '', row.version || '', row.timeline || '', String(row.content).replace(/\s+/g, '')]);
}
function validate(rows, conf) {
  if (!conf.sceneMode) return rows;
  for (const r of rows) {
    if (!r.episode || (!conf.wholeEpisode && r.scene == null)) throw new Error(`场次批注无法定位：${r.file}，请使用 集数-场次 文件名后重新预览`);
  }
  return rows;
}
module.exports = { content, decode, key, validate };
