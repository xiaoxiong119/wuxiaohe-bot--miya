'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function timeoutError(message) {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
}

// 流式下载共用同一条有界链路：断流会失败，跨站跳转不携带飞书凭证。
async function downloadFile(url, token, ip, destPath, onProgress, options = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('下载链接必须使用 HTTPS');
  const deadline = options.deadline ?? Date.now() + (options.totalMs ?? 45 * 60 * 1000);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError('文件下载超时');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError('文件下载超时')), remaining);
  const pin = !!ip && u.hostname === 'open.feishu.cn';
  let output;
  try {
    const res = await new Promise((resolve, reject) => {
      const req = (options.request || https.request)({
        hostname: pin ? ip : u.hostname, port: u.port || 443,
        path: u.pathname + u.search, method: 'GET',
        ...(pin ? { servername: u.hostname } : {}),
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(pin ? { Host: u.host } : {}) },
        signal: controller.signal,
      }, resolve);
      req.setTimeout(options.idleMs ?? 120000, () => controller.abort(timeoutError('文件下载停滞（2 分钟没有响应）')));
      req.on('error', reject);
      req.end();
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const redirects = options.redirects ?? 0;
      if (redirects >= 5) throw new Error('文件下载重定向次数过多');
      const next = new URL(res.headers.location, u);
      return await downloadFile(next.href, next.origin === u.origin ? token : '', '', destPath, onProgress,
        { ...options, deadline, redirects: redirects + 1 });
    }
    if (res.statusCode !== 200) {
      let body = '';
      for await (const chunk of res) {
        body += chunk.toString();
        if (body.length > 4096) break;
      }
      throw new Error(`HTTP ${res.statusCode} ${body.slice(0, 160)}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    output = fs.createWriteStream(destPath);
    let got = 0, mark = 0;
    const total = Number(res.headers['content-length']) || 0;
    res.on('data', chunk => {
      got += chunk.length;
      const mb = got / 1048576;
      if (onProgress && mb >= mark + 50) {
        mark = Math.floor(mb / 50) * 50;
        try { onProgress(mb, total / 1048576); } catch { /* 回执失败不影响下载 */ }
      }
    });
    await pipeline(res, output, { signal: controller.signal });
    if (total && got !== total) throw new Error('文件下载不完整');
    return { bytes: got, path: destPath };
  } catch (error) {
    if (output) fs.rmSync(destPath, { force: true });
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { downloadFile };
