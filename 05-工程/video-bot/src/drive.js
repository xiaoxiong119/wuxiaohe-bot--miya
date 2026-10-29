/**
 * 飞书云空间（Drive）文件下载
 *
 * 用途：超过 100 MB 的视频，飞书消息接口下不下来（im.messageResource.get 硬限），
 * 但可以先传到云空间，把文件链接发给机器人，机器人用 drive 接口拉。
 *
 * 链接形如 https://<租户>.feishu.cn/file/<file_token>
 * 注意：应用要能访问这个文件 —— 文件所有者得把「乌小河」加为协作者，
 * 或者文件放在应用可读的位置，否则会 403。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');
const { downloadToFile } = require('./feishu');

const FEISHU_HOST = 'https://open.feishu.cn';

let tokenCache = { token: '', exp: 0 };

async function tenantToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.APP_ID, app_secret: cfg.APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`取 tenant token 失败：${data.msg}`);
  tokenCache = { token: data.tenant_access_token, exp: Date.now() + data.expire * 1000 };
  return tokenCache.token;
}

/** 从一段文字里找飞书云空间文件链接 */
function parseLink(text) {
  const m = /https?:\/\/[^\s/]+\/(file)\/([A-Za-z0-9]{16,})/.exec(String(text || ''));
  if (!m) return null;
  return { token: m[2], url: m[0] };
}

/** 下载到 destPath；返回 { bytes } */
/**
 * 云盘文件下载。
 *
 * 2026-10-28 改：以前用 fetch + arrayBuffer 一次性读进内存（132 MB 就吃 132 MB 内存，
 * 中途没有任何日志和进度，看着像死了），而且不挑线路，撞上烂节点能慢到几十分钟。
 * 现在走 feishu.downloadToFile：挑最快 IP、边收边写盘、每 10 MB 回调一次进度。
 */
async function download(fileToken, destPath, onProgress) {
  const token = await tenantToken();
  const url = `${FEISHU_HOST}/open-apis/drive/v1/files/${fileToken}/download`;
  try {
    const r = await downloadToFile(url, token, destPath, onProgress);
    log(`云盘已下载 ${path.basename(destPath)}（${(r.bytes / 1024 / 1024).toFixed(2)} MB）`);
    return r;
  } catch (e) {
    throw new Error(`云盘下载失败：${(e && e.message) || e}`);
  }
}

/** 用 metas 接口拿文件名（拿不到就用 token 兜底） */
async function fileName(fileToken) {
  try {
    const token = await tenantToken();
    const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/metas/batch_query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_docs: [{ doc_token: fileToken, doc_type: 'file' }], with_url: false }),
    });
    const data = await res.json();
    const m = ((data.data || {}).metas || [])[0];
    return (m && m.title) || '';
  } catch (e) {
    return '';
  }
}

module.exports = { parseLink, download, tenantToken, fileName };
