/**
 * 上传 worker（独立子进程）
 *
 * 为什么要单独一个进程：mediatrack.js 里用的是 execFileSync，
 * 在主进程跑会堵住事件循环、长连接心跳超时掉线。
 *
 * 用法：node src/worker.js <本地视频路径>
 * 输出：最后一行 `RESULT_JSON:{...}`
 */
const { uploadToMediatrack } = require('./mediatrack');
const { log } = require('./log');

const filePath = process.argv[2];

if (!filePath) {
  console.log('RESULT_JSON:' + JSON.stringify({ ok: false, error: '缺少文件路径参数' }));
  process.exit(2);
}

(async () => {
  const res = await uploadToMediatrack(filePath);
  console.log('RESULT_JSON:' + JSON.stringify(res));
})().catch((e) => {
  log('worker 失败：' + (e && e.message));
  console.log('RESULT_JSON:' + JSON.stringify({ ok: false, unknown: e.uploadSubmitted === true, error: shortError(e) }));
  process.exit(1);
});

/**
 * 给同事看的错误：bsk 的原始报错是一大坨（命令行 + JS 代码 + 升级提示 + 中文翻译），
 * 直接甩到聊天框没人看得懂，只留「错误/详情」那两行。
 */
function shortError(e) {
  const raw = [
    String((e && (e.stderr && e.stderr.toString())) || ''),
    String((e && (e.stdout && e.stdout.toString())) || ''),
    String((e && e.message) || ''),
  ].join('\n');
  const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  const picked = lines.filter((s) => /^(错误|详情|提示)[:：]/.test(s));
  const text = picked.length
    ? picked.join('；').replace(/(错误|详情|提示)[:：]\s*/g, '').trim()
    : (lines[lines.length - 1] || '未知错误');
  return text.slice(0, 160);
}
