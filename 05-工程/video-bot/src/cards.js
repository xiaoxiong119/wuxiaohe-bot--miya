/**
 * 审阅流程卡片
 *
 * 用经典卡片结构（config/header/elements），飞书全版本兼容。
 * 按钮带 value → 点击会推 card.action.trigger 事件，由 flow.js 处理。
 */
const { getTarget } = require('./target');

/**
 * 终审卡「查看成片」专用的成片目录（2026-10-28 小熊指定）。
 * 跟下面那个「项目素材目录」是两回：这里直接开成片存放的那个文件夹。
 */
const TRIM_PREVIEW_URL =
  'https://app.mediatrack.cn/projects/2109939996814217216/files?path=2112064548004433920';

function trimPreviewUrl() {
  return TRIM_PREVIEW_URL;
}

/** 卡片里的「查看」链接跟着 /target 走 */
function projectUrl() {
  return getTarget().projectUrl;
}

function epTitle(rec) {
  const project = rec.project || '《逆天萌兽2》';
  const ep = rec.episode || '?';
  return `${project} 第 ${ep} 集`;
}

function people(names) {
  return (names && names.length ? names.join('、') : '（未指定）');
}

/** 负责人 @ 引用：有人就发真 at（卡片里能点、有提醒），没 id 退回名字 */
function atList(ps) {
  if (!ps || !ps.length) return '（未指定）';
  return ps
    .map((p) => (p.id ? `<at id="${p.id}"></at>` : (p.name || '')))
    .filter(Boolean)
    .join(' ');
}

function line(label, value) {
  return `**${label}**：${value == null || value === '' ? '—' : value}`;
}

/** 一审卡片（发给审片人 + 剪辑师） */
function reviewCard(rec) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `${epTitle(rec)} · 一审` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            line('素材生成进展', rec.stage),
            line('制作师', atList(rec.artist)),
            line('审片人', atList(rec.reviewers)),
            line('剪辑师', atList(rec.editors)),
          ].join('\n'),
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看粗剪' },
            type: 'default',
            url: projectUrl(),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '一审通过' },
            type: 'primary',
            value: { a: 'review_pass', r: rec.recordId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '一审未通过' },
            type: 'danger',
            value: { a: 'review_fail', r: rec.recordId },
          },
        ],
      },
    ],
  };
}

/** 通知制作师上传素材（一审通过后发） */
function uploadCard(rec) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: `${epTitle(rec)} · 一审通过，请上传素材` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '一审已通过。请把粗剪上传到剪映云空间，传完后点下面的按钮。',
            '',
            line('制作师', atList(rec.artist)),
            line('审片人', atList(rec.reviewers)),
            line('剪辑师', atList(rec.editors)),
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '素材已上传' },
            type: 'primary',
            value: { a: 'uploaded', r: rec.recordId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看分秒帧' },
            type: 'default',
            url: projectUrl(),
          },
        ],
      },
    ],
  };
}

/** 通知制作师修改（一审未通过后发） */
function editCard(rec, feedback) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `${epTitle(rec)} · 一审未通过，请修改` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '审片意见：**一审未通过**，请按意见修改后重新提交。',
            feedback ? `\n修改说明：${feedback}` : '',
            '',
            line('制作师', atList(rec.artist)),
            line('审片人', atList(rec.reviewers)),
            '',
            '修改完成后，请使用 /upmedia 或 /driveup 上传修改版。上传成功后，我会自动将生成进展改回“待一审”，并重新发送审阅卡片。',
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看粗剪' },
            type: 'default',
            url: projectUrl(),
          },
        ],
      },
    ],
  };
}

/** 通知剪辑师开始精剪（素材上传后发） */
function trimCard(rec) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `${epTitle(rec)} · 素材已上传，开始精剪` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '素材已上传到剪映云空间。点「开始剪辑」开始，剪完点「精剪完成」。',
            '',
            line('剪辑师', atList(rec.editors)),
            line('制作师', atList(rec.artist)),
            line('审片人', atList(rec.reviewers)),
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '开始剪辑' },
            type: 'default',
            value: { a: 'trim_start', r: rec.recordId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '精剪完成' },
            type: 'primary',
            value: { a: 'trim_done', r: rec.recordId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看分秒帧' },
            type: 'default',
            url: projectUrl(),
          },
        ],
      },
    ],
  };
}

/**
 * 剪辑终审卡片（发给审片人）
 * 用卡片 JSON 2.0：按钮的 behaviors 可以同时配「跳转链接」和「回传交互」，
 * 这样点「查看成片」既打开分秒帧，又能把剪辑进度改成「审片中」。
 */
function finalCard(rec) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: `${epTitle(rec)} · 剪辑终审` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '剪辑师已完成精剪。点「查看成片」打开分秒帧，同时把剪辑进度记成「审片中」；看完点「剪辑通过」。',
            '',
            line('剪辑进度', rec.trimStage),
            line('剪辑师', atList(rec.editors)),
            line('审片人', atList(rec.reviewers)),
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  type: 'primary',
                  text: { tag: 'plain_text', content: '查看成片' },
                  behaviors: [
                    { type: 'open_url', default_url: trimPreviewUrl() },
                    { type: 'callback', value: { a: 'final_view', r: rec.recordId } },
                  ],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  type: 'default',
                  text: { tag: 'plain_text', content: '剪辑通过' },
                  behaviors: [{ type: 'callback', value: { a: 'final_pass', r: rec.recordId } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** 把已处理过的卡片换成一条结果说明（按钮消失） */
function settledCard(title, resultLines, template) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: template || 'grey',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: resultLines.join('\n') },
      },
    ],
  };
}

/**
 * 别人用 /upmedia、/driveup 传完以后发给本人（陈俊杰）的回执卡：
 * 谁传的、哪一集、成功还是失败。
 */
function uploadFeedbackCard({ outName, byOpenId, ok, episode, source, resultText }) {
  const who = byOpenId ? `<at id="${byOpenId}"></at>` : '（本机投递箱）';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: `${ok ? '✅' : '❌'} 有人上传了 ${outName}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**操作人**：${who}`,
            `**集数**：${episode == null ? '（文件名里没认出集数）' : episode + ' 集'}`,
            `**上传的文件**：${outName}`,
            `**来源**：${source || '未知'}`,
            `**结果**：${ok ? '成功（已进分秒帧）' : '失败'}`,
            '',
            String(resultText || '').replace(/\n+$/, ''),
          ].join('\n'),
        },
      },
    ],
  };
}

/** 2.0 版的结果卡（patch 一张 2.0 卡片时必须用 2.0 结构，否则 400） */
function settledCard2(title, resultLines, template) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: template || 'grey',
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [{ tag: 'markdown', content: resultLines.join('\n') }],
    },
  };
}

/** 把结果卡在 1.0 和 2.0 之间翻面：原卡片是哪种结构，结果卡也得用哪种 */
function flipSchema(card) {
  if (!card) return null;
  if (card.schema === '2.0') {
    const md = ((card.body && card.body.elements) || []).find((e) => e.tag === 'markdown');
    return settledCard(card.header.title.content, ((md && md.content) || '').split('\n'), 'grey');
  }
  const md = (card.elements || []).map((e) => (e.text && e.text.content) || '').filter(Boolean);
  return settledCard2(card.header.title.content, (md[0] || '').split('\n'), 'grey');
}

/**
 * 版本更新公告卡：发版后发到指定群，越短越好。
 * rec = { version, prevVersion, items: [], remark, publishTime }
 */
function releaseCard(rec) {
  const items = (rec.items || []).filter(Boolean);
  const when = rec.publishTime
    ? new Date(rec.publishTime).toLocaleString('zh-CN', { hour12: false })
    : '（时间未知）';
  const lines = ['**这次更新**'];
  if (items.length) {
    lines.push(items.map((t) => `• ${String(t).replace(/\s+$/, '')}`).join('\n'));
  } else {
    lines.push('• （这一版没记到改动说明，只有发版备注）');
  }
  const since = rec.sinceVersion || rec.prevVersion || '';
  lines.push('');
  lines.push(`🕒 ${when} 发布`);
  lines.push(since ? `📌 这是 v${since} 之后到现在的全部更新` : '📌 首次发布更新公告');
  if (rec.remark) lines.push(`📝 发版备注：${rec.remark}`);

  return {
    config: { wide_screen_mode: true, update_multi: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `🆕 乌小河 更新到 v${rec.version}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    ],
  };
}

/** /help 的卡片：正文来自 help.md / help-lite.md，现读现发 */
function helpCard(markdown, title) {
  return {
    config: { wide_screen_mode: true, update_multi: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title || '乌小河 · 我会什么' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: markdown } },
    ],
  };
}

module.exports = {
  reviewCard, uploadCard, editCard, trimCard, finalCard, settledCard, helpCard,
  epTitle, projectUrl, trimPreviewUrl, atList,
  settledCard2, flipSchema, uploadFeedbackCard, releaseCard,
};
