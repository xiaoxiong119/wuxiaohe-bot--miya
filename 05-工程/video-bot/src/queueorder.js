/**
 * 队列取下一个的规则
 *
 * 先来后到，但加一条公平：如果队首和刚传完的是同一个人、后面还排着别人的，
 * 先让别人的上 —— 一个人连投五个大文件时，别人不至于干等半小时。
 * 只影响「跨人」的顺序，同一个人的几条之间仍然保持原来的先后。
 */

/**
 * @param {Array} list 队列（不改动它）
 * @param {string} lastOwnerId 刚处理完那条的 open_id，空表示没有偏好
 * @returns {number} 应该取的下标，队列为空时返回 -1
 */
function pickIndex(list, lastOwnerId) {
  if (!Array.isArray(list) || !list.length) return -1;
  const head = list[0];
  const headOwner = (head && head.by && head.by.openId) || '';
  // 只有「队首还是刚传完那人的」才考虑让位；队首是系统任务（无主）就照常先来后到
  if (lastOwnerId && headOwner === lastOwnerId && list.length > 1) {
    const i = list.findIndex((j, idx) => idx > 0 && j && j.by && j.by.openId && j.by.openId !== lastOwnerId);
    if (i > 0) return i;
  }
  return 0;
}

module.exports = { pickIndex };
