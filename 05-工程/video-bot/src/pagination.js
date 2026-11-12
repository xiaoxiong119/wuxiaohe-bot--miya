'use strict';
const { withTimeout } = require('./feishu');

function dataOf(response, label = '飞书请求') {
  if (!response || typeof response !== 'object') throw new Error(`${label}返回为空`);
  if (response.code != null && response.code !== 0) {
    throw Object.assign(new Error(`${label}失败：${response.code} ${response.msg || ''}`), { code: response.code });
  }
  return response.data || response;
}

// 只在确认所有页均已读完时返回；分页错误不能伪装成空表或完整快照。
async function allPages(request, { label = '读表', limit = 20, timeout = 20000 } = {}) {
  const out = [], seen = new Set();
  let token;
  for (let page = 0; page < limit; page++) {
    const data = dataOf(await withTimeout(request(token), timeout, label), label);
    if (!Array.isArray(data.items)) throw new Error(`${label}返回缺少记录列表`);
    out.push(...data.items);
    if (!data.has_more) return out;
    const next = data.page_token;
    if (!next || seen.has(next)) throw new Error(`${label}分页异常，未读全`);
    seen.add(next);
    token = next;
  }
  throw new Error(`${label}分页超过上限，未读全`);
}

module.exports = { dataOf, allPages };
