# 飞书视频 → 分秒帧

把飞书私聊里收到的视频，自动下载并上传到分秒帧指定项目。

## 已验证（2026-10-23）

真实跑通：飞书视频消息（800 KB）→ 下载到本地 → 分秒帧网页上传 → 项目文件列表出现。

分秒帧项目「2分钟了解分秒帧」的列表从 5 项变成 7 项（两次测试）。

## 启动 / 停止

```bash
cd /Users/fanxiaoli/WorkBuddy/乌小河机器人/05-工程/video-to-mediatrack
./start.sh    # 启动 bsk 浏览器服务 + daemon 监听
./stop.sh     # 只停 daemon；加 --with-bsk 连 bsk 一起停
```

**必须自己在「终端」里跑 `./start.sh`**，跑完窗口可以关。

脚本用 python 的 `start_new_session` 启动，进程脱离启动它的那个 shell，WorkBuddy 会话结束也不会被带走（`nohup` 会被带走，别用）。launchd 试过但 `launchctl bootstrap` 一直报 error 5，放弃了。

日志：`tail -f logs/daemon.log`

## 用法

**飞书里（日常用法）**：

- 直接把视频发给乌小河（私聊或群）→ **自动上传，不用发命令**
- 连发多条会逐条处理
- `/upmedia` 还能用：手动催一次扫描，不用等 8 秒轮询
- @机器人但没带指令 → 回一张命令菜单卡片

**命令行**：

```bash
cd /Users/fanxiaoli/WorkBuddy/乌小河机器人/05-工程/video-to-mediatrack

node run.js                  # 取乌小河私聊/群里最新一条视频消息，立刻下载并上传
node watch.js                # 等待模式：等下一个新视频（/upmedia 用的就是这个）
node menu.js --group         # 发命令菜单卡片到群
node run.js om_xxx           # 指定某条消息
node run.js --file a.mp4     # 直接传本地文件，跳过飞书下载
node run.js --dry-run        # 只下载，不上传
```

输出最后会有一行 JSON：`{ ok, countBefore, countAfter, fileName, shareUrl, url }`。

`shareUrl` 目前是**项目链接**（`.../projects/2108023947898388480/files`），不是文件级链接 —— 分秒帧的文件详情是 SPA 弹层，没有稳定 URL 可复制。

## 前置条件

| 条件 | 说明 |
| --- | --- |
| 分秒帧网页已登录 | 脚本用你 Chrome 的登录态，过期就重登一次 |
| bsk daemon 在跑 | `bsk status`，不在就用 `bsk daemon start --foreground` 起 |
| Chrome 扩展已开「允许访问文件网址」 | 否则注入文件会报 `Not allowed`，在 chrome://extensions 里开 |
| 分秒帧项目未激活团队账号 | 页面会弹「激活团队账号」，脚本会自动按 Esc 关掉，不影响上传 |

## 流程

```
lark-cli im +chat-messages-list   取最新 media/file 消息
  → 解析 content 里的 <video key="file_v3_xxx" name="xxx.mp4"/>
lark-cli im +messages-resources-download   下载到 downloads/
bsk session start → navigate 项目文件页
  → Esc 关弹窗 → 点「上传」→ 给隐藏 input 打 id 并设可见
bsk upload --selector "#bsk-file-0" --file <本地路径>
  → 轮询传输列表到 100%
刷新列表 → 对比「共 N 项」数量 → 判定成功
```

## 改配置

脚本顶部常量：

```js
const CHAT_ID = 'oc_...';        // 收视频的私聊/群
const PROJECT_URL = 'https://app.mediatrack.cn/projects/<id>/files';
const DOWNLOAD_DIR = .../downloads
```

换项目只要改 `PROJECT_URL` 里的项目 id。

## 已知限制

- **测试素材要带序号**：`test-video-01.mp4`、`test-video-02.mp4`…每次换新名字，别重复用同一个
- **分秒帧同名文件不覆盖**，会并存（列表里出现两个同名文件），这是平台行为
- 大文件（>1 GB）上传耗时可能超过 10 分钟轮询上限，届时请到页面确认
- 上传内容依赖分秒帧网页结构，页面改版需要重新对选择器
- 没有拿"分享链接"：分秒帧的文件详情是 SPA 弹层，链接需要另做（点开文件 → 分享）
