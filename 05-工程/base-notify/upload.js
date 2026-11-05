/* 多维表格自动化插件上传 —— 直接驱动内部 Upload 模块，避开交互式提示 */
const path = require('path');
const os = require('os');

const base = __dirname;
const cliRoot = path.join(base, 'action-starter', 'node_modules', '@lark-opdev', 'cli');
const coreDir = path.join(cliRoot, 'node_modules', '@bdeefe', 'feishu-devtools-core');

const core = require(coreDir);
core.Logger.Config = { appenders: ['stdout'], logPath: path.join(os.homedir(), '.lark-opdev-cli') };

const envUtil = require(path.join(cliRoot, 'libs', 'utils', 'env'));
const Upload = require(path.join(cliRoot, 'libs', 'implements', 'upload')).default;

const version = process.argv[2] || '0.0.1';
const description = process.argv[3] || '首次上传：发送飞书消息';

(async () => {
  await envUtil.initEnvironments();
  const upload = new Upload();
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`开始上传 version=${version} description=${description}`);
  try {
    const res = await upload.block({
      path: path.join(base, 'action-starter', 'output'),
      version,
      description,
    });
    console.log('上传成功:', JSON.stringify(res));
    process.exit(0);
  } catch (e) {
    console.log('上传失败:', e && e.message);
    if (e && e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }
})();
