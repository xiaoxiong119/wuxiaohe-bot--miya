#!/usr/bin/env node
/**
 * 记一条「待发布」的改动说明。
 *
 * 用法：node scripts/note.js "一句话说清这次改了什么"
 *
 * 这些条目攒在 releases.json → pending 里，等小熊在飞书开放平台发布新版本时，
 * 机器人会自动把它们归到那个版本号下，并发一张公告卡到指定群。
 * 所以改完机器人随手记一条，发版公告就不用人再写一遍。
 *
 * 写法（2026-10-28 小熊定的规矩）：
 *   - 只写**同事用得到**的功能；只有乌小熊自己用的（体检、回执、重启之类）不写进群里公告
 *   - 人称一律用名字：写「乌小熊」，不要写「你」「别人」「我」
 *   - 一条一句，说清「改了什么 / 对同事有什么用」
 */
const path = require('path');
const release = require(path.join(__dirname, '..', 'src', 'release.js'));

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.log('用法：node scripts/note.js "一句话说清这次改了什么"');
  process.exit(1);
}

const r = release.addNote(text);
if (r.ok) {
  console.log(`✅ 已记下（待发布共 ${r.count} 条）：${text}`);
} else {
  console.log('没记下：' + r.reason);
  process.exit(1);
}
