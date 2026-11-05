/* 飞书开发者工具登录 —— 直接复刻 opdev CLI 的登录链路
   `opdev login` 在当前环境因 oclif 打包 bug 无法运行（assignWith is not defined），
   这里直接驱动内部 Account 模块完成：取 token → 扫码 → 换 cookie → 落盘登录态。 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const base = __dirname;
const cliRoot = path.join(base, 'action-starter', 'node_modules', '@lark-opdev', 'cli');
const coreDir = path.join(cliRoot, 'node_modules', '@bdeefe', 'feishu-devtools-core');

const core = require(coreDir);
core.Logger.Config = { appenders: ['stdout'], logPath: path.join(os.homedir(), '.lark-opdev-cli') };

const envUtil = require(path.join(cliRoot, 'libs', 'utils', 'env'));
const api = require(path.join(coreDir, 'libs', 'config', 'api'));
const Server = require(path.join(coreDir, 'libs', 'modules', 'account', 'help', 'Server')).default;
const Account = require(path.join(cliRoot, 'libs', 'implements', 'account')).default;

const ENV = 'feishu';

(async () => {
  await envUtil.initEnvironments();
  const account = new Account();
  await new Promise((r) => setTimeout(r, 2500));

  const mgr = account.manager;
  const req = (spec, data, opt) => mgr.execute(core.ModuleName.service, core.ServiceCmdEnum.Request, spec, data, opt);
  const setStorage = (k, v) => mgr.execute(core.ModuleName.storage, core.StorageCmdEnum.Set, k, v);
  const getStorage = (k) => mgr.execute(core.ModuleName.storage, core.StorageCmdEnum.Get, k);

  await mgr.execute(core.ModuleName.service, core.ServiceCmdEnum.Update, { environment: ENV });

  const server = new Server({ language: 'zh-CN', showSuccessPage: true });
  const localUrl = await server.start();
  console.log('本地回调服务:', localUrl);

  const tokenResp = await req(api.API.getToken);
  const token = tokenResp.token;

  const cb =
    'https://open.feishu.cn/miniprogram/api/v4/passport/oauth/callback/' +
    `?token=${token}&redirect=${encodeURIComponent(localUrl + '/succeed')}`;
  const loginUrl = `https://passport.feishu.cn/accounts/page/login?app_id=7&redirect_uri=${encodeURIComponent(cb)}&lang=zh-CN`;

  fs.writeFileSync(path.join(base, 'login-url.txt'), loginUrl + '\n');
  console.log('已打开飞书登录页，请扫码');
  try { execSync(`open "${loginUrl}"`); } catch (e) {}

  server.onSuccess(async (query) => {
    console.log('收到回调，开始换取登录态...');
    try {
      // checkLogin 是模块内部方法，直接调 API 等价实现
      const resp = await req(api.API.checkLogin, { token: query.token }, { responseHeader: true });
      const rawSetCookie = resp && resp.headers ? resp.headers['set-cookie'] : null;
      let cookie = '';
      if (Array.isArray(rawSetCookie)) {
        cookie = rawSetCookie.map((c) => String(c).split(';')[0]).join('; ');
      } else if (typeof rawSetCookie === 'string') {
        cookie = rawSetCookie.split(';')[0];
      }
      if (!cookie) { console.log('未拿到 cookie'); process.exit(1); }

      const userInfo = await req(api.API.getUserInfo, {}, { headers: { Cookie: cookie } });
      console.log('用户:', userInfo.name, userInfo.uid);

      await mgr.execute(core.ModuleName.service, core.ServiceCmdEnum.Update, {
        environment: ENV,
        larkSession: userInfo.session,
        larkSessionList: userInfo.session_list,
      });

      const accountInfo = {
        mpSession: cookie,
        env: ENV,
        larkSession: userInfo.session,
        larkSessionList: userInfo.session_list,
        user: {
          id: userInfo.uid,
          name: userInfo.name,
          avatar: userInfo.avatar_url || '',
          env: ENV,
        },
        tenant: {
          id: userInfo.tenant_id,
          name: userInfo.tenant_name,
          avatar: '',
          isLogin: true,
        },
        tenantList: [],
      };

      setStorage('accountInfo', accountInfo);
      const map = getStorage('accountInfoMap') || {};
      map[ENV] = accountInfo;
      setStorage('accountInfoMap', map);

      await new Promise((r) => setTimeout(r, 500));
      console.log('登录态已写入，isLogin =', account.isLogin(ENV));
      process.exit(0);
    } catch (e) {
      console.log('登录失败:', e && e.message);
      process.exit(1);
    }
  });

  setTimeout(() => { console.log('登录超时'); process.exit(1); }, 5 * 60 * 1000);
})();
