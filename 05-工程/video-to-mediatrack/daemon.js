#!/usr/bin/env node
/**
 * 乌小河 · 群/私聊常驻监听
 *
 * 为什么需要它：飞书通道的 agent 只会回话、不会执行本地命令（实测那个会话 0 次工具调用），
 * 所以「收到视频 → 传分秒帧」这条链必须由本进程接管。
 *
 * 行为（2026-10-23 起改为自动，不需要命令）：
 *   1. 每 8 秒轮询私聊 + 群「乌小熊」
 *   2. 发现没处理过的视频/文件 → 下载 → 浏览器上传分秒帧 → 回消息
 *   3. 连发多条会逐条处理，一条一条来
 *   4. 发 /upmedia 可立刻触发一次扫描（不用等轮询）
 *   5. @机器人但没指令 → 回命令菜单卡片
 *
 * 运行：node daemon.js
 */

const fs = require('fs');
const path = require('path');
const {
  CHAT_IDS,
  listMedia,
  download,
  uploadToMediatrack,
  notify,
  run,
  log,
} = require('./run');

const LARK = path.join(process.env.HOME, '.workbuddy/binaries/node/versions/20.18.0/bin/lark-cli');
const STATE_FILE = path.join(__dirname, 'daemon-state.json');
const BOT_APP_ID = '[已脱敏]';
const POLL_MS = 8000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {}
}

/** 拉最近消息（私聊 + 群），去掉自己发的 */
function recentMessages(limit = 10) {
  const all = [];
  for (const chatId of CHAT_IDS) {
    for (const as of ['user', 'bot']) {
      try {
        const out = run(LARK, [
          'im', '+chat-messages-list',
          '--chat-id', chatId,
          '--as', as,
          '--order', 'desc',
          '--page-size', String(limit),
        ]);
        const data = JSON.parse(out);
        if (!data.ok) continue;
        for (const m of data.data.messages || []) {
          const senderId = (m.sender && m.sender.id) || '';
          if (senderId === BOT_APP_ID) continue;
          if (all.some((x) => x.message_id === m.message_id)) continue;
          all.push({ ...m, chatId });
        }
        break;
      } catch (e) {
        // 换身份重试
      }
    }
  }
  all.sort((a, b) => String(b.create_time).localeCompare(String(a.create_time)));
  return all;
}

/** 首次启动：把现存的视频和命令都标记为已处理，避免把历史全传一遍 */
function bootstrap() {
  const st = loadState();
  if (st.bootstrapped && Array.isArray(st.handledVideos)) return st;

  let media = [];
  let msgs = [];
  try {
    media = listMedia();
    msgs = recentMessages(5);
  } catch (e) {
    log('初始化扫描失败：' + (e && e.message));
  }

  st.handledVideos = media.map((m) => m.messageId);
  st.handledCommands = msgs.map((m) => m.message_id);
  st.handledMenu = [...st.handledCommands];
  st.bootstrapped = true;
  saveState(st);
  log(`初始化：已有 ${media.length} 条视频、${msgs.length} 条消息按已处理跳过`);
  return st;
}

async function doUpload(media, chatId) {
  log(`开始处理 ${media.name}（${media.createTime}）`);
  try {
    const localPath = download(media.messageId, media.fileKey, media.name);
    const res = await uploadToMediatrack(localPath);
    const text = res.ok
      ? `✅ 已上传分秒帧：${media.name}\n列表 ${res.countBefore} → ${res.countAfter} 项\n${res.shareUrl}`
      : `⚠️ ${media.name} 上传异常（列表 ${res.countBefore} → ${res.countAfter}），请到页面确认\n${res.shareUrl}`;
    notify(text, chatId);
    log(text);
    return true;
  } catch (e) {
    notify(`❌ ${media.name} 上传失败：${e && e.message}`, chatId);
    log('上传失败：' + (e && e.message));
    return false;
  }
}

async function tick() {
  const state = bootstrap();
  const now = Date.now();

  // ---------- 0. 失败重试队列（比如分秒帧登录过期，登录后自动补传） ----------
  state.pending = state.pending || [];
  const retryItem = state.pending.find((p) => (p.nextTryAt || 0) <= now);
  if (retryItem) {
    const ok = await doUpload(retryItem.media, retryItem.chatId);
    if (ok) {
      state.pending = state.pending.filter((p) => p.media.messageId !== retryItem.media.messageId);
    } else {
      retryItem.retries = (retryItem.retries || 0) + 1;
      // 退避：30s → 60s → … 最多 5 分钟
      retryItem.nextTryAt = now + Math.min(5 * 60 * 1000, 30000 * retryItem.retries);
      if (retryItem.retries > 20) {
        state.pending = state.pending.filter((p) => p.media.messageId !== retryItem.media.messageId);
        state.handledVideos.push(retryItem.media.messageId);
        log(`重试 20 次仍失败，放弃 ${retryItem.media.name}`);
      }
    }
    saveState(state);
    return;
  }

  let list = [];
  try {
    list = listMedia();
  } catch (e) {
    log('扫描视频失败：' + (e && e.message));
    return;
  }

  // ---------- 1. 自动上传未处理过的视频 ----------
  const target = list.find((m) => !state.handledVideos.includes(m.messageId));
  if (target) {
    state.handledVideos.push(target.messageId);
    if (state.handledVideos.length > 200) state.handledVideos = state.handledVideos.slice(-200);
    saveState(state);

    const ok = await doUpload(target, target.chatId || CHAT_IDS[0]);
    if (!ok) {
      // 失败：从已处理里摘出来，进重试队列，等下次或用户重新登录后再试
      state.handledVideos = state.handledVideos.filter((id) => id !== target.messageId);
      state.pending.push({
        media: target,
        chatId: target.chatId || CHAT_IDS[0],
        retries: 1,
        nextTryAt: Date.now() + 60000,
      });
      saveState(state);
    }
    return;
  }

  // ---------- 2. /upmedia：手动催一下，立刻再扫 ----------
  let msgs = [];
  try {
    msgs = recentMessages();
  } catch (e) {
    return;
  }

  const cmd = msgs.find(
    (m) => (m.content || '').includes('/upmedia') && !state.handledCommands.includes(m.message_id),
  );
  if (cmd) {
    state.handledCommands.push(cmd.message_id);
    if (state.handledCommands.length > 50) state.handledCommands = state.handledCommands.slice(-50);
    saveState(state);
    log('收到 /upmedia，已扫描，暂无待处理视频');
    notify('收到，队列里暂时没有新视频；发了我会自动传。', cmd.chatId);
    return;
  }

  // ---------- 3. @机器人无指令 → 菜单 ----------
  const atBot = msgs.find((m) => {
    const c = m.content || '';
    const stripped = c.replace(/@_user_\d+/g, '').replace(/@乌小河/g, '').trim();
    return (
      (c.includes('@_user_1') || c.includes('@乌小河')) &&
      !c.includes('/upmedia') &&
      stripped.length < 6 &&
      !state.handledMenu.includes(m.message_id)
    );
  });

  if (atBot) {
    state.handledMenu.push(atBot.message_id);
    if (state.handledMenu.length > 50) state.handledMenu = state.handledMenu.slice(-50);
    saveState(state);
    log('收到 @ 无指令，发菜单');
    try {
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, [path.join(__dirname, 'menu.js'), '--chat', atBot.chatId], {
        encoding: 'utf8',
        env: { ...process.env, BSK_AUTO_START: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      log('发菜单失败：' + (e && e.message));
    }
  }
}

(async function loop() {
  log('常驻监听已启动（自动上传模式）');
  while (true) {
    try {
      await tick();
    } catch (e) {
      log('循环异常：' + (e && e.message));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
