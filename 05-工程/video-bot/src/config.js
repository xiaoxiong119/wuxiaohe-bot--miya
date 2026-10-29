/**
 * 配置加载：读 .env + config.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 极简 .env 解析，避免为几十行代码再装 dotenv */
function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvFile();

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

module.exports = {
  ROOT,
  APP_ID: process.env.FEISHU_APP_ID || '',
  APP_SECRET: process.env.FEISHU_APP_SECRET || '',
  PROJECT_URL: raw.projectUrl,
  DOWNLOAD_DIR: path.resolve(ROOT, raw.downloadDir || './downloads'),
  ALLOW_P2P: raw.allowP2P !== false,
  ALLOW_GROUPS: raw.allowGroups || [],
  ALLOWED_EXT: (raw.allowedExtensions || []).map((e) => e.toLowerCase()),
  REPLY_ON_RECEIVE: raw.replyOnReceive !== false,
  COMMAND: raw.command || '/upmedia',
  WAIT_SECONDS: raw.waitSeconds || 300,
  BASE: raw.base || {},
  BASE_COMMAND: raw.baseCommand || '/base',
  FLOW: raw.flow || {},
  HEALTH: raw.health || {},
  RELEASE: raw.release || {},
  INBOX: raw.inbox || {},
  DRIVE_INBOX: raw.driveInbox || {},
  INBOX_DIR: path.resolve(ROOT, (raw.inbox && raw.inbox.dir) || './inbox'),
  STATE_FILE: path.join(ROOT, 'state.json'),
};
