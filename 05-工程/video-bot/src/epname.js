/**
 * 文件名归一化：把「122-改.mov」「54集-修改版.mp4」还原成「122.mov」「54集.mp4」
 *
 * 为什么需要：同事改完片习惯在云盘文件名后面加「-改」，机器人若照抄这个名字上传，
 * 分秒帧里找不到同名条目 → 会新建一份「122-改.mov」，而不是用右键菜单的「上传版本」
 * 更新 122 那一条。
 * 2026-10-28 实测：119~126 集全都多出了一份带「-改」的重复文件，列表从 126 涨到 135。
 */
const path = require('path');

/** 可以作为分隔符的字符（去掉后不影响主体名） */
const SEP_CH = '\\s\\-_·.．、,，()（）\\[\\]【】';

/**
 * 修改标记词。必须按长度倒序拼进正则，否则「改版」会先被「改」吃掉、留下一个「版」。
 * 只收明确的「这是同一集的另一版」的词，不收数字序号（52-2 是分卷，不是版本）。
 */
const REV_WORDS = [
  '修改版', '改版', '重改版', '再改版',
  '修改', '修订', '修正', '改后',
  '重改', '再改', '终稿', '定稿', '定版',
  'revision', 'final', 'rev', 'fix',
  'v\\d+',
  '改',
];

const WORD = '(?:' + REV_WORDS.slice().sort((a, b) => b.length - a.length).join('|') + ')';

/** 文件名末尾的「-改 / _改2 / (修改版) / 改-2 / v2 / final」 */
const RE_TAIL = new RegExp(
  `[${SEP_CH}]*${WORD}(?:\\d+)?(?:[${SEP_CH}]*\\d+)*[${SEP_CH}]*$`,
  'i'
);

/**
 * 去掉结尾的修改标记，保留扩展名。
 *   122-改.mov        → 122.mov
 *   54集-修改版.mp4    → 54集.mp4
 *   52-2修改.mp4      → 52-2.mp4（分卷 -2 留着）
 *   122 改 2.mov      → 122.mov
 *   122-final.mov     → 122.mov
 *   73.mp4            → 73.mp4（没标记，原样返回）
 */
function stripRev(name) {
  const s = String(name || '');
  const ext = path.extname(s);
  let base = ext ? s.slice(0, -ext.length) : s;

  // 连剥几次：「122-改-修改」这种叠着写的
  for (let i = 0; i < 3; i++) {
    const next = base.replace(RE_TAIL, '').replace(new RegExp(`[${SEP_CH}]+$`), '');
    if (next === base) break;
    if (!next) break; // 整个名字就是「改」——别吃光
    base = next;
  }
  return base + ext;
}

/** 文件名里带没带修改标记 */
function isRev(name) {
  const s = String(name || '');
  return stripRev(s) !== s;
}

/**
 * 宽匹配键：用来在分秒帧列表里认「这是同一集」。
 * 忽略扩展名、修改标记、书名号前缀、「集」字、各种分隔符和大小写。
 *   122-改.mp4            → 122
 *   122.mov               → 122
 *   《逆天萌兽2》65.mov     → 65
 *   54集-改.mp4           → 54
 *   第54集.mp4            → 54
 *   ep54.mp4              → 54
 * 但 57-2.mp4 → 572 ≠ 57，分卷不会被当成同一集。
 */
function subjectKey(name) {
  let s = String(name || '').replace(/\.[^.]+$/, '');
  s = stripRev(s);
  s = s.replace(/^《[^》]*》\s*/, '');
  s = s.replace(/(\d+)\s*集$/, '$1');
  s = s.replace(/^(?:第|ep\.?|e)\s*(\d+)$/i, '$1');
  s = s.replace(new RegExp(`[${SEP_CH}]`, 'g'), '');
  return s.toLowerCase();
}

/** 从文件名里取集数（第一个数字），给回写多维表格用 */
function episodeOf(name) {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  const m = /\d{1,4}/.exec(base);
  return m ? Number(m[0]) : null;
}

module.exports = { stripRev, isRev, subjectKey, episodeOf };
