/**
 * 日志：打到控制台；如果是终端前台跑，再落一份到 logs/bot.log。
 *
 * 注意：start.sh 已经把 stdout 重定向进 logs/bot.log 了，
 * 这里再落盘会导致每行写两遍，所以只在 TTY（前台手动跑）时才写文件。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const TO_TTY = process.stdout.isTTY;
let stream = null;

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  if (!TO_TTY) return;
  try {
    if (!stream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      stream = fs.createWriteStream(path.join(LOG_DIR, 'bot.log'), { flags: 'a' });
    }
    stream.write(line + '\n');
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
}

/** 读日志文件最后 n 行（体检/报错回传时给小熊看原始日志） */
function tailLines(n = 40) {
  try {
    const txt = fs.readFileSync(path.join(LOG_DIR, 'bot.log'), 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch (e) {
    return [];
  }
}

/** 只要看起来像报错的行 */
function errorLines(n = 12) {
  const RE = /✗|⚠️|失败|错误|Error|error|超时|refused|ENOTFOUND/i;
  return tailLines(400).filter((l) => RE.test(l)).slice(-n);
}

module.exports = { log, tailLines, errorLines };
