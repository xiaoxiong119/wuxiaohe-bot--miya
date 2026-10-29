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
  console.log('RESULT_JSON:' + JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  process.exit(1);
});
