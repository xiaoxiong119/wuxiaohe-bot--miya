const { writeJson } = require('./json-file');
/**
 * 分秒帧上传目标：读 / 改 / 存
 *
 * 目标存在 config.json 的 projectUrl 里（含 ?path= 文件夹）。
 * 每次调用都重新读盘，所以 /target 改完立刻生效，不用重启；
 * 上传本身跑在 worker 子进程里，本来每次都会重新加载配置。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

/** 从 URL 里抠出项目 id 和文件夹 id */
function parseTarget(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new Error('分秒帧目标链接无效'); }
  const m = /^\/projects\/(\d+)\/files\/?$/.exec(u.pathname);
  const folderId = u.searchParams.get('path') || '';
  if (u.protocol !== 'https:' || u.hostname !== 'app.mediatrack.cn' || u.username || u.password || u.port ||
      !m || (u.searchParams.has('path') && !/^\d+$/.test(folderId))) {
    throw new Error('链接不对，要形如 https://app.mediatrack.cn/projects/<项目id>/files?path=<文件夹id>');
  }
  return { projectUrl: u.href, projectId: m[1], folderId };

}

function getTarget() {
  const cfg = readConfig();
  const url = process.env.UPLOAD_TARGET_URL || cfg.projectUrl || '';
  let parsed = { projectId: '', folderId: '' };
  try {
    parsed = parseTarget(url);
  } catch (e) {
    /* 配置坏了就当空 */
  }
  return { projectUrl: url, projectId: parsed.projectId, folderId: parsed.folderId };
}

/** 改目标：校验 → 写回 config.json → 返回新目标 */
function setTarget(url) {
  const t = parseTarget(url);
  const cfg = readConfig();
  cfg.projectUrl = t.projectUrl;
  writeJson(CONFIG, cfg);
  return t;
}

/** 项目 id → 短标签（日志和回复里好看点） */
function describe(t) {
  const tid = t || getTarget();
  const parts = [`项目 ${tid.projectId}`];
  if (tid.folderId) parts.push(`文件夹 ${tid.folderId}`);
  return parts.join(' · ');
}

/**
 * 目标的人话说法，例：【《逆天萌兽2》的「粗剪」文件夹】
 * 名字查 config.json → targetNames；没登记的 id 就原样显示。
 */
function label() {
  const cfg = readConfig();
  const t = getTarget();
  const names = cfg.targetNames || {};
  const proj = names[t.projectId] || (t.projectId ? `项目 ${t.projectId}` : '（还没设目标）');
  if (t.folderId) {
    const folder = names[t.folderId];
    return folder ? `【${proj}的「${folder}」文件夹】` : `【${proj}的文件夹 ${t.folderId}】`;
  }
  return `【${proj}】`;
}

module.exports = { getTarget, setTarget, parseTarget, describe, label, CONFIG };
