# 乌小河 · 多维表格自动化插件

飞书应用「乌小河」下的一个多维表格自动化插件（action），功能：**把表格内容发送到指定飞书用户或群聊**。

这份文档是给接手的人 / AI 看的操作手册。照着做就能改代码、编译、上传、配后台，不用再去翻官方 CLI 源码。

---

## 一、关键标识

| 项 | 值 |
| --- | --- |
| 应用名 | 乌小河（飞书企业自建应用，同时是机器人） |
| App ID | `[已脱敏]` |
| BlockTypeID | `blk_6ad9e6bc49cd0c06efb9b83c` |
| 应用能力类型 | 多维表格插件 → 自动化操作 |
| 开发者后台 | https://open.feishu.cn/app/[已脱敏] |
| 插件配置页 | https://open.feishu.cn/app/[已脱敏]/blocks/blk_6ad9e6bc49cd0c06efb9b83c |
| 已上传版本 | `0.0.1`（小组件名称：发送飞书消息） |
| 登录账号 | 用户254022 / uid `7545706986336337948` |

---

## 二、目录结构

```
feishu-base-notify/
├── app.json                  # {"appId": "cli_..."}  ← 必须放项目根，CLI 会往上一级找
├── login.js                  # 自写登录脚本（替代跑不通的 opdev login）
├── upload.js                 # 自写上传脚本（替代交互式的 npm run upload）
└── action-starter/           # 真正的插件工程，命令都在这里跑
    ├── block.json            # {"blockTypeID": "blk_..."}
    ├── package.json          # scripts 用 @lark-opdev/block-basekit-cli
    ├── tsconfig.json
    ├── src/register.ts       # 插件全部逻辑（唯一需要改的文件）
    ├── test/index.ts         # npm run test 的本地调用
    ├── node_modules/         # 含 @lark-opdev/cli、block-basekit-cli
    └── output/               # 编译产物，**上传时指向这里**
```

> `app.json` 与 `action-starter/` 是父子关系。`block-basekit-cli` 从 `action-starter/` 往上找 `app.json`，别放错层。

---

## 三、环境前提

- Node ≥ 20（本机用托管版本 `~/.workbuddy/binaries/node/versions/22.22.2-6/bin/node`）
- 依赖已装好（`action-starter/node_modules`，约 158 MB）。重装：
  ```bash
  cd action-starter
  env -u NODE_OPTIONS npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  ```
- **所有命令都要加 `env -u NODE_OPTIONS`**，否则 WorkBuddy 注入的 node shim 会让 npm 慢到 10 分钟且 postinstall 被安全删除拦截。

---

## 四、四条工作流

### 1. 改功能 → 只动 `action-starter/src/register.ts`

插件由三个部分组成：

```ts
basekit.addAction({
  formItems: [...],   // 表单 UI，itemId 会成为 execute 的入参 key
  execute: async (args, context) => {...},  // 运行逻辑，必须有返回值
  resultType: {...},  // 出参结构，供后续节点引用
});
```

当前实现要点：

- 接收人：`Component.ContactPicker`，`supportTypes: ['user','group']`，`mode: 'single'`
  - 回调值是数组：`[{ id, type: 'user' | 'group' }]`
- 内容：`Component.Input` + `mode: 'textarea'`
- 发消息：`context.fetch` 调 `POST /open-apis/im/v1/messages?receive_id_type=open_id|chat_id`
  - `type === 'group'` 用 `chat_id`，否则 `open_id`
  - Header `Authorization: Bearer ${context.tenantAccessToken}`
  - Body `{ receive_id, msg_type: 'text', content: JSON.stringify({ text }) }`
- 必须声明 `useTenantAccessToken: true` 才有 `context.tenantAccessToken`
- 出参：`success` / `messageId` / `error`

**只能用 `context.fetch`**，不能用 axios / got（线上沙箱不支持）。同理不能用 moment、sharp、jsdom、bcrypt。

### 2. 登录（凭证过期或换机器时）

```bash
cd feishu-base-notify
env -u NODE_OPTIONS node login.js
```

会打印飞书登录链接并自动打开浏览器，扫码后登录态写入本地，输出 `isLogin = true` 即成功。

原理（`opdev login` 跑不通，只能自己实现）：

1. `initEnvironments()` 初始化环境（**必须调用**，否则环境列表为空会静默卡死）
2. `new Account()` 后等 2.5 秒，等内部 Modules 异步 init 完
3. `service.Update({ environment: 'feishu' })` —— 环境 id 是**小写** `feishu`，写 `Feishu` 会卡住不报错
4. 起本地 Server 拿回调地址 → `Request(API.getToken)` 拿一次性 token
5. 拼链接：`https://passport.feishu.cn/accounts/page/login?app_id=7&redirect_uri=<cb>&lang=zh-CN`
   - `cb` = `https://open.feishu.cn/miniprogram/api/v4/passport/oauth/callback/?token=<t>&redirect=<本地/succeed>`
6. 扫码回调 → `Request(API.checkLogin, {token}, {responseHeader:true})` 从 `set-cookie` 取 cookie
7. `getUserInfo` → `storage.Set('accountInfo', {...})` + `accountInfoMap`

### 3. 编译

```bash
cd action-starter
env -u NODE_OPTIONS ./node_modules/.bin/block-basekit-cli build
```

输出「编译成功。Compile Success.」即 OK，产物在 `output/`。

### 4. 上传版本

```bash
cd feishu-base-notify
env -u NODE_OPTIONS node upload.js 0.0.1 "更新说明"
```

- 版本号必须是**递增的语义化版本**（`0.0.1` → `0.0.2`），否则服务端拒绝
- 成功标志：`✔ Upload succeed`，并返回后台链接
- **关键**：`upload.js` 里传给 `upload.block({ path })` 的必须是 `action-starter/output`（编译产物目录）。传项目根会报 `project.config.json is not found`
- 不用 `npm run upload`：它是交互式的，会逐字符问版本号和描述，管道喂不进去

上传后到后台配置页选版本、填名称介绍、保存：

1. 打开 https://open.feishu.cn/app/[已脱敏]/blocks/blk_6ad9e6bc49cd0c06efb9b83c
2. 「小组件版本」下拉选刚上传的版本号
3. 填小组件名称（≤32 字）、介绍（≤120 字），图标可用默认
4. 点保存

用浏览器自动化时注意：这是 React 受控组件，直接设 `value` 不生效，必须：

```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, value);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

### 5. 发布应用（插件可用前的最后一步）

后台「版本管理与发布」→ 创建版本 → 填应用版本号 + 更新说明 → 保存 → 申请线上发布（需管理员审核）。

---

## 五、踩坑清单（按踩过的顺序）

| 坑 | 现象 | 解决办法 |
| --- | --- | --- |
| `opdev` CLI 打包 bug | 任何子命令都报 `assignWith is not defined`，`--version` 正常 | 3.4.4 / 3.3.3 / 2.32.6 全中，别修了，直接驱动内部模块 |
| 环境 id 大小写 | 传 `'Feishu'` 静默卡死，不报错 | 必须用小写 `'feishu'` |
| 缺 `initEnvironments()` | 登录流程卡在取 token 前 | 调 `require('.../libs/utils/env').initEnvironments()` |
| Modules 异步 init | 构造完立刻调用会挂起 | `new Account()` 后 `await sleep(2500)` |
| `app.json` 位置 | 报 `Cannot find module .../app.json` | 放 `action-starter` 的**上一级** |
| upload 路径 | 报 `project.config.json is not found` | 传 `action-starter/output`，不是项目根 |
| upload 交互式 | 卡在 `Please enter version` | 用 `upload.js` 直接调 `upload.block()` |
| npm 装不动 | 装一条 10 分钟、postinstall 报 safe-delete | 命令前加 `env -u NODE_OPTIONS` |
| 私有依赖 404 | `@bdeefe/feishu-devtools-core` 在 npm 源查不到 | 它在 cli 的 `node_modules` 里，正常安装就有 |
| `checkLogin` 不可见 | `account.checkLogin is not a function`，`manager.moduleMap` 为空 | 直接调 `Request(API.checkLogin, {token}, {responseHeader:true})` |
| 后台表单填不进去 | 设 value 后页面无变化 | 用原生 setter + dispatch input 事件 |

---

## 六、需要时再查的东西

- 官方开发指南：https://open.feishu.cn/document/base-extensions/base-automation-extension-development-guide
  - 抓取方式：`curl "https://open.feishu.cn/document_portal/v1/document/get_detail?fullPath=/base-extensions/base-automation-extension-development-guide"`（返回 JSON，content 是 markdown）
- 组件 / 数据类型文档路径格式：`fullPath=/uAjLw4CM/uYjL24iN/base-extensions/base-automation-extensions/{api|component|data-type}/<name>`
- 模板 zip（可重新拉干净工程）：`https://sf3-scmcdn-cn.feishucdn.com/obj/feishu-static/lark/opdev/templates/action-starter_0.0.21.zip`
- 服务端接口可能需要额外权限：发消息要 `im:message:send_as_bot`

---

## 七、当前待办

- [ ] 创建应用版本并申请线上发布（插件才真正可选）
- [ ] 发布后在多维表格里实测：机器人 → 创建自动化流程 → 选「发送飞书消息」
- [ ] 可选增强：支持富文本 / 卡片消息、支持群机器人 webhook、支持 @ 人

---

_最后更新：2026-10-22 · 乌乌_
