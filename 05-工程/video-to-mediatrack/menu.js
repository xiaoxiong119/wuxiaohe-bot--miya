#!/usr/bin/env node
/**
 * 发一张「乌小河命令菜单」卡片
 *
 * 用法：
 *   node menu.js                # 发到私聊
 *   node menu.js --group        # 发到群「乌小熊」
 *   node menu.js --chat oc_xxx  # 指定会话
 */

const path = require('path');
const { run, CHAT_IDS, log } = require('./run');

const LARK = path.join(process.env.HOME, '.workbuddy/binaries/node/versions/20.18.0/bin/lark-cli');

const argv = process.argv.slice(2);
const chatIdx = argv.indexOf('--chat');
const chatId = chatIdx >= 0
  ? argv[chatIdx + 1]
  : (argv.includes('--group') ? CHAT_IDS[1] : CHAT_IDS[0]);

function buildCard() {
  const item = (cmd, desc) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${cmd}**  ${desc}`,
    },
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '乌小河 · 命令菜单' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '直接在下面挑一个发给我，或者手打也行 👇',
        },
      },
      { tag: 'hr' },
      item('/upmedia', '上传最新视频到分秒帧（可以先发命令再发视频）'),
      item('/doc', '读飞书文档并总结要点'),
      item('/table', '查飞书表格数据'),
      item('/kpi', '填月度 KPI 考核表'),
      item('/weekly', '生成本周周报'),
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '群里使用时：@乌小河 再发命令；输入 / 可调出全部命令',
          },
        ],
      },
    ],
  };
}

const card = JSON.stringify(buildCard());

try {
  const out = run(LARK, [
    'im', '+messages-send',
    '--chat-id', chatId,
    '--msg-type', 'interactive',
    '--content', card,
    '--as', 'bot',
  ]);
  const res = JSON.parse(out);
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  log(`菜单已发送 → ${chatId}`);
  console.log(JSON.stringify(res.data, null, 2));
} catch (e) {
  console.error('❌ 发送失败：' + (e && e.message));
  process.exit(1);
}
