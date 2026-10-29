#!/usr/bin/env node
/**
 * 飞书视频 → 分秒帧
 *
 * 用法：
 *   node run.js                  # 取乌小河私聊里最新一条视频/文件消息，下载并上传
 *   node run.js <message_id>     # 指定消息
 *   node run.js --file <path>    # 直接上传本地文件（跳过飞书下载）
 *   node run.js --dry-run        # 只下载不上传
 *
 * 依赖：lark-cli（飞书 connector 自带）、bsk（浏览器控制）、已登录的分秒帧网页
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME;
const LARK = path.join(HOME, '.workbuddy/binaries/node/versions/20.18.0/bin/lark-cli');
const BSK = path.join(HOME, '.local/bin/bsk');

/** 乌小河与用户的私聊 + 群「乌小熊」 */
const CHAT_IDS = [
  'oc_8f5af0785fc3b54e05f6717ef54e1f84',
  'oc_89cd2e64c440682663f4c40591f9ead4',
];
/** 分秒帧目标项目：2分钟了解分秒帧 */
const PROJECT_URL = 'https://app.mediatrack.cn/projects/2108023947898388480/files';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

const PATH_ENV = [
  path.join(HOME, '.local/bin'),
  path.join(HOME, '.workbuddy/binaries/node/versions/20.18.0/bin'),
  process.env.PATH,
].join(':');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BSK_AUTO_START: '0', PATH: PATH_ENV },
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`);
}

/** 列出私聊 + 群里所有 视频/文件 消息，按时间倒序 */
function listMedia() {
  const seen = new Set();
  const candidates = [];

  for (const chatId of CHAT_IDS) {
    for (const as of ['bot', 'user']) {
      let out;
      try {
        out = run(LARK, [
          'im', '+chat-messages-list',
          '--chat-id', chatId,
          '--as', as,
          '--order', 'desc',
          '--page-size', '15',
        ]);
      } catch (e) {
        continue; // 这个身份读不了就换一个
      }
      const data = JSON.parse(out);
      if (!data.ok) continue;
      for (const m of data.data.messages || []) {
        if (m.msg_type !== 'media' && m.msg_type !== 'file') continue;
        const keyMatch = m.content.match(/key="([^"]+)"/);
        if (!keyMatch) continue;
        const nameMatch = m.content.match(/name="([^"]+)"/);
        if (seen.has(m.message_id)) continue;
        seen.add(m.message_id);
        candidates.push({
          messageId: m.message_id,
          fileKey: keyMatch[1],
          name: nameMatch ? nameMatch[1] : `feishu-${Date.now()}.mp4`,
          createTime: m.create_time,
          timestamp: new Date(String(m.create_time).replace(/-/g, '/')).getTime(),
          chatId,
        });
      }
      break; // 读成功就不再用另一个身份
    }
  }

  if (!candidates.length) return [];
  candidates.sort((a, b) => b.timestamp - a.timestamp);
  return candidates;
}

/** 取最新一条（兼容旧调用） */
function latestMedia() {
  const list = listMedia();
  return list.length ? list[0] : null;
}

function download(messageId, fileKey, name) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const out = run(LARK, [
    'im', '+messages-resources-download',
    '--message-id', messageId,
    '--file-key', fileKey,
    '--type', 'file',
    '--as', 'bot',
  ], { cwd: DOWNLOAD_DIR });
  const res = JSON.parse(out);
  if (!res.ok) throw new Error('下载失败: ' + JSON.stringify(res.error));
  const saved = res.data.saved_path;

  // lark-cli 会用服务端文件名，若与原名不同则改回来
  const target = path.join(DOWNLOAD_DIR, name);
  if (path.resolve(saved) !== path.resolve(target)) {
    fs.renameSync(saved, target);
  }
  log(`已下载 ${name}（${(res.data.size_bytes / 1024 / 1024).toFixed(2)} MB）`);
  return target;
}

/** 页面上给 4 个隐藏 file input 打标记，并让第 0 个可见 */
const JS_PREPARE_UPLOAD = `
(() => {
  const btn = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '上传');
  if (btn) btn.click();
  const inputs = [...document.querySelectorAll('input[type=file]')];
  inputs.forEach((e, i) => { e.id = 'bsk-file-' + i; });
  const el = inputs[0];
  if (el) el.style.cssText = 'display:block !important;visibility:visible !important;opacity:1 !important;position:fixed;top:0;left:0;width:20px;height:20px;z-index:999999;';
  return JSON.stringify({ clicked: !!btn, inputs: inputs.length });
})()
`;

const JS_CHECK_PROGRESS = `
(() => {
  const t = document.body.innerText;
  const hasPanel = t.includes('传输列表');
  const done = t.includes('100%');
  return JSON.stringify({ hasPanel, done, hasError: t.includes('上传失败') });
})()
`;

/** 读列表页「共 N 项」 */
function readFileCount(sid) {
  const raw = run(BSK, ['evaluate', '--session', sid,
    `(() => { const m = document.body.innerText.match(/共\\s*(\\d+)\\s*项/); return m ? m[1] : '0'; })()`]);
  const line = raw.trim().split('\n').pop();
  return parseInt(line, 10) || 0;
}

async function uploadToMediatrack(filePath) {
  // 1. 会话
  const sessionRaw = run(BSK, ['session', 'start', '--json']);
  const session = JSON.parse(sessionRaw);
  const sid = session.session_id;
  log(`浏览器会话 ${sid}`);

  try {
    // 2. 打开项目文件页，记下当前文件数
    run(BSK, ['navigate', '--session', sid, PROJECT_URL]);
    await sleep(5);

    // 2.5 登录态检查：会话过期会跳到 /welcome，此时页面上没有上传按钮
    const curUrl = run(BSK, ['evaluate', '--session', sid, 'location.href']).trim().split('\n').pop();
    if (curUrl.includes('/welcome') || curUrl.includes('login')) {
      throw new Error('分秒帧登录已过期，请在电脑浏览器里扫码重新登录');
    }

    // 3. 关掉可能弹出的「激活团队账号」遮罩
    try { run(BSK, ['press', '--session', sid, 'Escape']); } catch (e) {}
    await sleep(1);

    const countBefore = readFileCount(sid);
    log(`当前列表 ${countBefore} 项`);

    // 4. 点上传 + 打标记
    const prep = run(BSK, ['evaluate', '--session', sid, JS_PREPARE_UPLOAD]);
    log(`上传菜单：${prep.trim().split('\n').pop()}`);
    if (!prep.includes('"clicked":true')) throw new Error('没找到上传按钮，页面可能没加载完');
    await sleep(1);

    // 5. 注入文件
    run(BSK, ['upload', '--session', sid, '--selector', '#bsk-file-0', '--file', filePath]);
    log('文件已注入，等待上传完成…');

    // 6. 轮询进度（最多 10 分钟）
    let finished = false;
    for (let i = 0; i < 100; i++) {
      await sleep(6);
      const raw = run(BSK, ['evaluate', '--session', sid, JS_CHECK_PROGRESS]);
      const line = raw.trim().split('\n').pop();
      let st;
      try { st = JSON.parse(line); } catch (e) { continue; }
      if (st.hasError) throw new Error('分秒帧报上传失败');
      if (st.done) { finished = true; break; }
      if (i % 5 === 0) log(`上传中…（第 ${i * 6}s）`);
    }
    if (!finished) log('⚠️ 未在 10 分钟内看到 100%，请到页面确认');

    // 7. 刷新，用文件总数确认（同名文件会共存，不能靠名字判断）
    await sleep(2);
    run(BSK, ['navigate', '--session', sid, PROJECT_URL]);
    await sleep(8);
    const countAfter = readFileCount(sid);
    const ok = countAfter > countBefore;
    log(ok
      ? `✅ 上传成功：列表 ${countBefore} → ${countAfter} 项`
      : `⚠️ 列表数量没变（${countBefore} → ${countAfter}），请手动确认`);

    return {
      ok,
      countBefore,
      countAfter,
      fileName: path.basename(filePath),
      shareUrl: PROJECT_URL,
      note: '分秒帧文件级分享链接在 SPA 弹层里，没有稳定 URL；这里给项目链接，点开即可看到该文件',
      url: PROJECT_URL,
    };
  } finally {
    try { run(BSK, ['session', 'stop', sid]); } catch (e) {}
  }
}

/** 往飞书发一条文本（默认私聊，可传 chatId） */
function notify(text, chatId = CHAT_IDS[0]) {
  try {
    run(LARK, ['im', '+messages-send', '--chat-id', chatId, '--text', text, '--as', 'bot']);
    return true;
  } catch (e) {
    log('⚠️ 回发飞书消息失败：' + (e && e.message));
    return false;
  }
}

module.exports = {
  PROJECT_URL,
  CHAT_IDS,
  listMedia,
  latestMedia,
  download,
  uploadToMediatrack,
  notify,
  run,
  log,
  sleep,
};

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const fileFlagIndex = argv.indexOf('--file');

    let localPath;
    if (fileFlagIndex >= 0) {
      localPath = path.resolve(argv[fileFlagIndex + 1]);
      if (!fs.existsSync(localPath)) throw new Error('文件不存在: ' + localPath);
      log(`使用本地文件 ${localPath}`);
    } else {
      const explicitId = argv.find((a) => a.startsWith('om_'));
      let media;
      if (explicitId) {
        const out = run(LARK, ['im', '+messages-mget', '--message-ids', explicitId, '--as', 'bot']);
        const m = JSON.parse(out).data.messages[0];
        const keyMatch = m.content.match(/key="([^"]+)"/);
        const nameMatch = m.content.match(/name="([^"]+)"/);
        media = {
          messageId: explicitId,
          fileKey: keyMatch[1],
          name: nameMatch ? nameMatch[1] : `feishu-${Date.now()}.mp4`,
        };
      } else {
        media = latestMedia();
      }
      if (!media) throw new Error('没找到视频或文件消息');
      log(`消息 ${media.messageId} · 文件 ${media.name}`);
      localPath = download(media.messageId, media.fileKey, media.name);
    }

    if (dryRun) {
      log('dry-run：只下载，不上传');
      return;
    }

    const result = await uploadToMediatrack(localPath);
    console.log(JSON.stringify({ ok: true, file: localPath, ...result }, null, 2));
  })().catch((e) => {
    console.error('❌ ' + (e && e.message));
    process.exit(1);
  });
}
