// 实际本机 HTTP 传输注入 HTTPS 请求接口，不访问飞书或分秒帧。
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadFile } = require('../src/http-download');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-download-'));
const headers = [];
const server = http.createServer((req, res) => {
  headers.push({ path: req.url, auth: req.headers.authorization });
  if (req.url === '/ok') { res.writeHead(200, {'Content-Length': 5}); return res.end('video'); }
  if (req.url === '/same') { res.writeHead(302, {Location: '/ok'}); return res.end(); }
  if (req.url === '/cross') { res.writeHead(302, {Location: 'https://cdn.example/ok'}); return res.end(); }
  if (req.url === '/loop') { res.writeHead(302, {Location: '/loop'}); return res.end(); }
  if (req.url === '/partial') { res.writeHead(200, {'Content-Length': 100}); res.write('x'); return setTimeout(() => res.destroy(), 10); }
  if (req.url === '/stall') { res.writeHead(200); res.write('x'); return; }
  res.writeHead(403); res.end('permission denied');
});
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = (options, callback) => http.request({...options, hostname:'127.0.0.1', port}, callback);
    const dest = path.join(root, 'nested/video.mp4');
    const run = (route, extra = {}) => downloadFile('https://open.feishu.cn' + route, 'fixture-token', '', dest, null,
      {request, idleMs:40, totalMs:1000, ...extra});
    const done = await run('/same'); assert.equal(done.bytes,5); assert.equal(fs.readFileSync(dest,'utf8'),'video');
    assert.equal(headers.at(-1).auth,'Bearer fixture-token');
    await run('/cross'); assert.equal(headers.at(-1).auth,undefined,'跨站不转发飞书 token');
    await assert.rejects(run('/loop'),/重定向次数/);
    await assert.rejects(run('/partial'),/aborted|reset|premature|closed/i); assert.equal(fs.existsSync(dest),false);
    await assert.rejects(run('/stall'),/停滞/); assert.equal(fs.existsSync(dest),false);
    await assert.rejects(run('/stall',{idleMs:1000,totalMs:30}),/下载超时/);
    await assert.rejects(run('/denied'),/HTTP 403/);
    await assert.rejects(downloadFile('http://insecure.example','', '',dest),/HTTPS/);
    console.log('PASS: 流式下载、同站跳转、跨站凭证隔离、跳转环、断流清理、停滞与总超时');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
