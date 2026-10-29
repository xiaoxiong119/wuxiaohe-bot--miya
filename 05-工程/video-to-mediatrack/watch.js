#!/usr/bin/env node
/**
 * /upmedia 的"等待模式"
 *
 * 场景：视频还在上传中，用户先发了 /upmedia。
 * 这时候不能马上去找视频（还看不到），要等它到达。
 *
 * 用法：
 *   node watch.js                  # 从现在开始等，最多 5 分钟
 *   node watch.js --minutes 10     # 自定义超时
 *
 * 行为：每 3 秒扫一次私聊 + 群，靠消息 id 判断有没有新视频，
 *      发现就下载上传，结果发回发命令的那个会话。
 */

const path = require('path');
const {
  CHAT_IDS,
  listMedia,
  download,
  uploadToMediatrack,
  notify,
  run,
  log,
  sleep,
} = require('./run');

const LARK = path.join(process.env.HOME, '.workbuddy/binaries/node/versions/20.18.0/bin/lark-cli');

const argv = process.argv.slice(2);
const minutesIdx = argv.indexOf('--minutes');
const minutes = minutesIdx >= 0 ? Number(argv[minutesIdx + 1]) : 5;

/** 发命令的会话：优先取最近发过 /upmedia 的那个会话 */
function resolveChatId() {
  for (const chatId of CHAT_IDS) {
    for (const as of ['user', 'bot']) {
      try {
        const out = run(LARK, [
          'im', '+chat-messages-list',
          '--chat-id', chatId,
          '--as', as,
          '--order', 'desc',
          '--page-size', '5',
        ]);
        const data = JSON.parse(out);
        if (!data.ok) continue;
        const msgs = data.data.messages || [];
        if (msgs.some((m) => (m.content || '').includes('/upmedia'))) return chatId;
        break;
      } catch (e) {
        // 换身份重试
      }
    }
  }
  return CHAT_IDS[0];
}

(async () => {
  const replyChat = resolveChatId();

  const handle = async (media) => {
    log(`处理视频 ${media.name}（${media.createTime}）`);
    try {
      const localPath = download(media.messageId, media.fileKey, media.name);
      const res = await uploadToMediatrack(localPath);
      const text = res.ok
        ? `✅ 已上传分秒帧：${media.name}\n列表 ${res.countBefore} → ${res.countAfter} 项\n${res.shareUrl}`
        : `⚠️ ${media.name} 上传异常（列表 ${res.countBefore} → ${res.countAfter}），请到页面确认\n${res.shareUrl}`;
      notify(text, replyChat);
      log(text);
    } catch (e) {
      notify(`❌ ${media.name} 上传失败：${e && e.message}`, replyChat);
      log('上传失败：' + (e && e.message));
    }
  };

  // 情况一：视频比命令先到（90 秒内的算"刚发的"）
  let initial = [];
  try {
    initial = listMedia();
  } catch (e) {
    log('基线扫描失败：' + (e && e.message));
  }
  const recent = initial.find((m) => Date.now() - m.timestamp < 90 * 1000);
  if (recent) {
    log('检测到命令前刚发的视频，直接处理');
    await handle(recent);
    return;
  }

  // 情况二：命令先到，等视频
  const before = new Set(initial.map((m) => m.messageId));
  const deadline = Date.now() + minutes * 60 * 1000;
  log(`开始等待新视频（已有 ${before.size} 条旧媒体消息，超时 ${minutes} 分钟）`);
  notify('收到，等你上传完，到了我直接传分秒帧。', replyChat);

  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    let fresh = null;
    try {
      const list = listMedia();
      fresh = list.find((m) => !before.has(m.messageId)) || null;
    } catch (e) {
      log('扫描失败：' + (e && e.message));
    }

    if (fresh) {
      await handle(fresh);
      return;
    }

    if (Date.now() - lastBeat > 60000) {
      lastBeat = Date.now();
      log('还没等到新视频…');
    }
    await sleep(3);
  }

  log('等待超时');
  notify(`${minutes} 分钟内没等到新视频，已停止等待。`, replyChat);
})();
