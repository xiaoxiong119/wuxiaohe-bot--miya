/**
 * 飞书侧能力：client、下载资源、发文本、解析附件
 */
const Lark = require('@larksuiteoapi/node-sdk');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./log');

/**
 * 懒初始化：没填凭证时不要在建模块阶段就崩，
 * 否则 --selftest 的友好提示会被 SDK 的异常盖掉。
 */
let _client = null;
function getClient() {
  if (!_client) {
    if (!cfg.APP_ID || !cfg.APP_SECRET) {
      throw new Error('还没填 .env 里的 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    _client = new Lark.Client({ appId: cfg.APP_ID, appSecret: cfg.APP_SECRET });
  }
  return _client;
}

/** 去掉文件名里的非法字符，防路径穿越 */
function safeName(name) {
  return String(name)
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'unnamed';
}

/**
 * 解析消息里的附件。
 *
 * 事件推送的 content 是 JSON：{"file_key":"file_v3_xxx","file_name":"a.mp4"}
 * 老的 lark-cli 返回的是 XML：<video key="..." name="..."/> —— 两种都兼容。
 * 注意 media（视频）消息的 content 里**没有 file_name**，只能用 message_id 兜底。
 */
function parseAttachment(message) {
  const msgType = message.message_type || message.msg_type;
  if (msgType !== 'media' && msgType !== 'file') return null;

  const raw = String(message.content || '');
  let obj = {};
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    const k = raw.match(/key="([^"]+)"/);
    const n = raw.match(/name="([^"]+)"/);
    if (!k) return null;
    obj = { file_key: k[1], file_name: n ? n[1] : '' };
  }

  const fileKey = obj.file_key || obj.fileKey;
  if (!fileKey) return null;

  let fileName = obj.file_name || obj.fileName || '';
  if (!fileName) {
    fileName = `feishu-${message.message_id}${msgType === 'media' ? '.mp4' : ''}`;
  }

  return {
    messageId: message.message_id,
    fileKey,
    fileName: safeName(fileName),
    msgType,
    chatId: message.chat_id,
    chatType: message.chat_type || 'p2p',
  };
}

/**
 * 把飞书返回的错误翻成人话。
 *
 * 坑：下载接口是流式响应，出错时 axios 的 response.data 是个 IncomingMessage 流，
 * 不是对象，必须读出来再 JSON.parse，否则永远只能看到 "status code 400"。
 */
async function readErrorPayload(e) {
  const d = e && e.response && e.response.data;
  if (!d) return null;
  if (typeof d === 'string') {
    try { return JSON.parse(d); } catch (err) { return { msg: d }; }
  }
  if (typeof d.pipe === 'function') {
    const text = await new Promise((resolve) => {
      let buf = '';
      d.setEncoding('utf8');
      d.on('data', (c) => { buf += c; });
      d.on('end', () => resolve(buf));
      d.on('error', () => resolve(buf));
    });
    try { return JSON.parse(text); } catch (err) { return { msg: text }; }
  }
  if (typeof d === 'object' && (d.code || d.msg)) return d;
  return null;
}

function scopesFrom(msg) {
  const m = /\[([^\]]+)\]/.exec(String(msg || ''));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function scopeApplyUrl(scopes) {
  if (!scopes || !scopes.length) return '';
  return 'https://open.feishu.cn/page/scope-apply?clientID=' + cfg.APP_ID +
    '&scopes=' + encodeURIComponent(scopes.join(','));
}

async function describeError(e) {
  const payload = await readErrorPayload(e);
  if (payload && payload.code) {
    const scopes = scopesFrom(payload.msg);
    if (scopes.length) {
      // 飞书会给出「任选其一」的一组 scope，挑最窄的那条给链接，别让人顺手开了大权限
      const prefer = ['im:message:readonly', 'im:message.history:readonly', 'im:resource', 'im:message'];
      const narrow = prefer.find((s) => scopes.includes(s)) || scopes[0];
      return {
        text: `飞书 ${payload.code}：缺权限，任选其一开通即可 → ${scopes.join(' / ')}`,
        scopeUrl: scopeApplyUrl([narrow]),
      };
    }
    const raw = String(payload.msg || '')
      .split('点击链接')[0]
      .split('。应用尚未开通')[0]
      .replace(/[，。：\s]+$/, '')
      .trim();
    return { text: `飞书 ${payload.code}：${raw}`, scopeUrl: '' };
  }
  return { text: (e && e.message) || String(e), scopeUrl: '' };
}

/**
 * 下载消息里的资源文件。
 * 视频消息（media）的 type 也是 file；image 才用 image。
 * 注意：除了 im:resource，还需要 im:message:readonly 才能读这条消息的资源。
 */
// ---------------------------------------------------------------- 飞书文件下载（选路）
//
// 2026-10-28 实测：open.feishu.cn 解析出好几个 IP，速度天差地别
//   119.167.184.187 → 6.7 KB/s
//   39.91.185.82    → 21.7 KB/s
//   119.167.193.21  → 806 KB/s
// Node/axios 默认用解析到的第一个，赶上烂节点就变成「56 MB 下 16 分钟」。
// 所以下载前先对每个 IP 试拉 4 秒，挑最快的那个，30 分钟内复用。

const https = require('https');
const dns = require('dns');

const FEISHU_HOST = 'open.feishu.cn';
let _tok = null;
let _bestIp = { ip: '', at: 0 };

async function tenantToken() {
  if (_tok && Date.now() < _tok.exp) return _tok.v;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.APP_ID, app_secret: cfg.APP_SECRET }),
  });
  const d = await r.json();
  if (!d.tenant_access_token) throw new Error('取 tenant_access_token 失败：' + (d.msg || d.code || '?'));
  _tok = { v: d.tenant_access_token, exp: Date.now() + ((d.expire || 7200) - 120) * 1000 };
  return _tok.v;
}

/** 拉 4 秒看这个 IP 能给多少字节，0 = 基本没法用 */
function probeIp(ip, url, token, ms) {
  return new Promise((resolve) => {
    let n = 0;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(n); } };
    let req;
    try {
      req = https.request({
        host: ip,
        port: 443,
        path: url,
        method: 'GET',
        servername: FEISHU_HOST, // SNI 用域名，证书才对得上
        headers: { Authorization: 'Bearer ' + token, Host: FEISHU_HOST },
      }, (res) => {
        res.on('data', (d) => { n += d.length; if (n > 4 * 1024 * 1024) { req.destroy(); finish(); } });
        res.on('end', finish);
        res.on('error', finish);
      });
    } catch (e) {
      return resolve(0);
    }
    req.setTimeout(ms, () => { req.destroy(); finish(); });
    req.on('error', finish);
    req.end();
  });
}

async function bestIp(url, token) {
  if (_bestIp.ip && Date.now() - _bestIp.at < 30 * 60 * 1000) return _bestIp.ip;
  let ips = [];
  try {
    ips = await dns.promises.resolve4(FEISHU_HOST);
  } catch (e) {
    return '';
  }
  if (!ips.length) return '';
  const probes = await Promise.all(ips.map(async (ip) => ({ ip, bytes: await probeIp(ip, url, token, 4000) })));
  probes.sort((a, b) => b.bytes - a.bytes);
  const best = probes[0];
  if (!best.bytes) return '';
  if (probes.length > 1) {
    log(`飞书下载选路：${probes.map((p) => p.ip + ' ' + Math.round(p.bytes / 1024) + 'KB/4s').join('，')} → 用 ${best.ip}`);
  }
  _bestIp = { ip: best.ip, at: Date.now() };
  return best.ip;
}

/** 走到指定 IP 的 https 下载，边收边写盘（不落内存） */
function httpsDownload(url, token, ip, destPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const pin = !!(ip && u.hostname === FEISHU_HOST);
    const opts = {
      // 直连指定 IP，SNI / Host 还是域名（Node 22 的 lookup 回调签名跟 autoSelectFamily 打架，
      // 用 lookup 会报 Invalid IP address: undefined，所以走 host+servername 这条路）
      host: pin ? ip : u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    };
    if (pin) {
      opts.servername = FEISHU_HOST;
      opts.headers.Host = FEISHU_HOST;
    }
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpsDownload(next, token, '', destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (d) => { if (body.length < 300) body += d.toString(); });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 160)}`)));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => resolve(destPath));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 通用「按 URL 下载到文件」：自动挑最快的飞书线路、边收边写盘、按 MB 报进度。
 * 云盘文件（drive/v1/files/:token/download）和消息附件都用它。
 */
async function downloadToFile(url, token, destPath, onProgress) {
  const u = new URL(url);
  const ip = await bestIp(u.pathname + u.search, token);
  const pin = !!ip && u.hostname === FEISHU_HOST;
  return new Promise((resolve, reject) => {
    const opts = {
      host: pin ? ip : u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    };
    if (pin) {
      opts.servername = FEISHU_HOST;
      opts.headers.Host = FEISHU_HOST;
    }
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadToFile(next, token, destPath, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (d) => { if (body.length < 300) body += d.toString(); });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 160)}`)));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let mark = 0;
      res.on('data', (d) => {
        got += d.length;
        const mb = got / 1024 / 1024;
        if (onProgress && mb >= mark + 50) {
          mark = Math.floor(mb / 50) * 50;
          try { onProgress(mb, total / 1024 / 1024); } catch (e) { /* 忽略 */ }
        }
      });
      res.pipe(out);
      out.on('finish', () => resolve({ bytes: got, path: destPath }));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function downloadResource(att, destPath, onProgress) {
  const candidates = att.msgType === 'image' ? ['image'] : ['file'];
  const NET_RE = /connect failed|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|ECONNRESET|getaddrinfo/i;
  let lastErr;
  // 通道抖动常见持续几十秒：退避 5/10/20/30 秒共 5 次，能扛过一分钟的断网
  const BACKOFF_MS = [5000, 10000, 20000, 30000];
  for (const type of candidates) {
    for (let attempt = 1; attempt <= 1 + BACKOFF_MS.length; attempt++) {
      // 下载期间盯着文件大小：报进度 + 发现假死（90 秒不长个儿）就判失败重试
      let lastSize = 0;
      let lastGrow = Date.now();
      const reported = new Set();
      const watch = setInterval(() => {
        try {
          const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          if (size > lastSize) {
            lastSize = size;
            lastGrow = Date.now();
          }
          if (size > 0) {
            const mb = size / 1024 / 1024;
            const mbStr = mb.toFixed(1);
            const total = att.fileSize ? att.fileSize / 1024 / 1024 : 0;
            const pct = total ? Math.floor((mb / total) * 100) : 0;
            // 每 50 MB 报一次（2026-10-28 小熊定的，别刷屏）
            const mark = Math.floor(mb / 50) * 50;
            if (mark > 0 && !reported.has(mark)) {
              reported.add(mark);
              log(`下载中 ${att.fileName}：${mbStr} MB${total ? ' / ' + total.toFixed(1) + ' MB（' + pct + '%）' : ''}`);
              if (onProgress) onProgress(mb, total);
            }
          }
          if (Date.now() - lastGrow > 120000 && !reported.has('stall')) {
            reported.add('stall');
            log(`⚠️ 下载停滞 ${att.fileName}：已 ${Math.round((Date.now() - lastGrow) / 1000)} 秒没有增长，仍在等…`);
            if (onProgress) onProgress(-1, 0);
          }
        } catch (e) { /* 忽略 */ }
      }, 5000);
      try {
        const token = await tenantToken();
        const resPath = `/open-apis/im/v1/messages/${att.messageId}/resources/${att.fileKey}?type=${type}`;
        const ip = await bestIp(resPath, token);
        await httpsDownload(`https://${FEISHU_HOST}${resPath}`, token, ip, destPath);
        clearInterval(watch);
        const mb = fs.statSync(destPath).size / 1024 / 1024;
        log(`已下载 ${att.fileName}（${mb.toFixed(2)} MB）`);
        return destPath;
      } catch (e) {
        clearInterval(watch);
        lastErr = e;
        _bestIp = { ip: '', at: 0 }; // 这次走的路不通，下次重新选
        // 网络抖动（通道偶发 Connection refused）自动重试，权限/大小类错误不重试
        // 半截文件清掉，重试从头下
        try { fs.unlinkSync(destPath); } catch (e2) { /* 没有就算了 */ }
        const wait = BACKOFF_MS[attempt - 1];
        if (wait && NET_RE.test(String((e && e.message) || e))) {
          log(`下载网络抖动（第 ${attempt} 次），${Math.round(wait / 1000)} 秒后重试：${(e && e.message) || e}`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          break;
        }
      }
    }
  }
  const { text, scopeUrl } = await describeError(lastErr);
  const hint = att.msgType === 'media' || att.msgType === 'file'
    ? '\n\n（超过 100 MB 的视频飞书接口下不下来：传到云盘收件夹，或放本机 inbox/。要是提示网络连接失败，多半是通道抖动，重发一次 /upmedia 就行）'
    : '';
  const err = new Error(`下载失败：${text}${hint}`);
  err.scopeUrl = scopeUrl;
  throw err;
}

/**
 * 给任何 Promise 套超时。飞书 SDK 的 axios 默认 timeout=0（永不超时），
 * 一次网络半死就能把事件处理链挂住十几分钟——2026-10-27 踩过。
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label || '请求'}超时（${Math.round(ms / 1000)} 秒没响应）`)), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

/** 发一条纯文本到会话（20 秒超时，不许把事件循环挂死） */
async function sendText(chatId, text) {
  try {
    await withTimeout(getClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    }), 10000, '发消息');
    return true;
  } catch (e) {
    log('⚠️ 回发消息失败：' + (e && e.message));
    return false;
  }
}

/** 取文本消息的正文，剥掉 @ 标记，全角斜杠归一 */
function textContent(message) {
  const msgType = message.message_type || message.msg_type;
  if (msgType !== 'text') return '';
  try {
    const raw = JSON.parse(String(message.content || '{}')).text || '';
    return raw
      .replace(/@_user_\d+/g, ' ')
      .replace(/@_all/g, ' ')
      .replace(/／/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (e) {
    return '';
  }
}

/**
 * 解析文本命令：/upmedia 67
 *
 * 群里 @ 机器人时，文本前面会带 `@_user_1`，先剥掉。
 * 兼容全角斜杠「／」和命令后紧跟冒号、逗号的写法。
 * 返回 null 表示「不是命令」，返回 { name: '' } 表示「是命令但没给名字」。
 */
function parseTextCommand(message, command) {
  const text = textContent(message);
  if (!text) return null;

  const cmd = String(command || '/upmedia').toLowerCase();
  const lower = text.toLowerCase();
  if (lower !== cmd && !lower.startsWith(cmd + ' ') && !lower.startsWith(cmd + '：') && !lower.startsWith(cmd + ':')) {
    return null;
  }

  const name = text
    .slice(cmd.length)
    .replace(/^[\s:：,，、-]+/, '')
    .trim();

  return { name };
}

/** 按 open_id 发文本（投递箱回执用） */
async function sendTextTo(openId, text) {
  try {
    await withTimeout(getClient().im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
    }), 10000, '发消息');
    return true;
  } catch (e) {
    log('⚠️ 回发消息失败（open_id ' + openId + '）：' + (e && e.message));
    return false;
  }
}

/** 发一张卡片给某个人（open_id）—— 给小熊本人的回执用 */
async function sendCardTo(openId, card) {
  if (!openId) return false;
  try {
    await withTimeout(getClient().im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
    }), 10000, '发卡片');
    return true;
  } catch (e) {
    log('⚠️ 发卡片给 ' + openId + ' 失败：' + ((e && e.message) || e));
    return false;
  }
}

/** 发一张交互卡片到会话 */
async function sendInteractive(chatId, card) {
  try {
    await withTimeout(getClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    }), 10000, '发卡片');
    return true;
  } catch (e) {
    log('⚠️ 发卡片失败：' + (e && e.message));
    return false;
  }
}

module.exports = {
  getClient, parseAttachment, parseTextCommand, textContent,
  downloadResource, downloadToFile, tenantToken,
  sendText, sendTextTo, sendCardTo, sendInteractive, safeName, describeError, withTimeout,
};
