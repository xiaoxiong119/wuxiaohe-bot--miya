# 机器人迁移到新机 · 完整指南

> 2026-10-29 立。目标：小熊本机只写代码，公司新电脑（同系统 Mac）跑机器人。
> 解决的问题：机器人在本机驱动 Chrome 上传分秒帧，弹窗打扰 + 电脑卡。

## 架构

- **本机 = 开发机**：改代码（本仓库 `05-工程/video-bot`），不再跑机器人进程和 bsk。
- **新机 = 运行机**：跑 `~/video-bot`（本目录同步过去的副本）+ bsk + 一个专职伺候机器人的 Chrome。
- **同步**：Syncthing，双向（两边都 Send & Receive），保存秒级互推。同 WiFi 走局域网直连；开 VPN 导致局域网不通时自动走公网中继（慢一点但不断流）。
- **飞书**：机器人长连接是出站连接，哪台机器跑都行，不需要公网 IP。

## 只同步什么

代码与配置（`src/`、`scripts/`、`deploy/`、`admin/`、`help*.md`、`config.json`、`.env`、`releases.json`、`package.json` 等）。
运行态全部 ignore（见 `syncthing-ignore.txt`，配置时把它贴进两边的 `.stignore`）。

## 一次性准备（新机，手动）

1. 系统设置 → 通用 → 共享 → 打开「远程登录」（SSH），记下 IP。
2. 装 Google Chrome，登录分秒帧账号。
3. 装 bsk 浏览器扩展（参考本机 `~/.workbuddy/skills/browser-skill/SKILL.md`；扩展从 Chrome 商店或官方仓库装）。Chrome 登录态和扩展都没法从本机拷，必须新机重做一次。

## 迁移步骤（按顺序）

**A. 本机：首次全量拷贝**

```bash
cd ~/WorkBuddy/乌小河机器人/05-工程/video-bot/deploy
./migrate-first-copy.sh 新机用户名@新机IP
```

rsync 推 `video-bot` 全量（含 `.env`、`config.json`、状态文件快照；不含 node_modules / logs / downloads / inbox / backups），顺带拷 bsk 二进制（需新机同为 Apple Silicon）。

**B. 新机：一键初始化**

```bash
ssh 新机用户名@新机IP
bash ~/video-bot/deploy/bootstrap.sh
```

装依赖、配 launchd 开机自启、检查缺项（Node 22 / Syncthing 没装会给装法）。

**C. 两机：配 Syncthing 文件夹对**

1. 两边装好并启动 Syncthing（brew install --cask syncthing 或官网 app）。
2. 本机 Web UI（http://127.0.0.1:8384）添加设备 ↔ 新机 Web UI 里接受，互配设备 ID。
3. 本机添加文件夹，路径 = `~/WorkBuddy/乌小河机器人/05-工程/video-bot`，与「新机」共享。
4. 新机上接受共享，路径 = `~/video-bot`。
5. **两边都把 `syncthing-ignore.txt` 的内容贴进文件夹的 Ignore 设置**（`.stignore`）。
6. 等两边状态都变成「最新」。首次配置完成后，本机一保存文件，新机秒级收到。

**D. 切换日（正式搬家）**

1. 本机停机器人：`cd 05-工程/video-bot && ./stop.sh`（有 /tbpz 在跑就等它采完）。
2. 本机停 bsk：`./stop.sh --with-bsk`（bsk 是单机服务，别让两台都开）。
3. 新机起机器人：`ssh 新机 'bash ~/video-bot/start.sh'`（或直接重启新机，launchd 会自动拉起）。
4. 飞书私聊发条消息验证收发；发个视频走一遍上传链路。
5. 本机的 bsk daemon 之后别再常开（它闲置 10 分钟会自动退，正常）。

**同一时间只能一台机器跑机器人**——两台同时跑会抢同一个飞书应用的事件，消息会丢。`.bot.lock` 是单机文件锁管不了跨机，靠切换时人保证。

## 日常运维（本机 ssh 到新机）

```bash
REMOTE=新机用户名@新机IP

ssh $REMOTE 'bash ~/video-bot/restart.sh'      # 改完代码、同步过去后重启生效
ssh $REMOTE 'tail -100 ~/video-bot/logs/bot.log'   # 看日志
ssh $REMOTE 'cat ~/video-bot/bot.pid && ps -p $(cat ~/video-bot/bot.pid)'  # 活着没
```

改代码流程不变：本机改 → `node scripts/note.js "…"`（releases.json 会双向同步）→ 要生效就 ssh 重启。
注意：`src/index.js`、`src/reviewsync.js`、`config.json` 的改动要重启才生效；`scripts/tbpz-collect.sh` 每轮 spawn 新进程，改完即生效不用重启。

## 已知事项

- **VPN**：全局接管流量时局域网直连会断，Syncthing 自动降级公网中继，同步变慢但不断。ssh 在 VPN 下可能连不上新机，等 VPN 关掉再操作，或提前在新机 `/etc/hosts` 绑定固定名字。
- **`.env` 含飞书 App Secret**：只走 Syncthing 的 TLS 加密通道点对点传输，不落第三方。公司环境可接受；不放心就首次 rsync 后手动核对并删掉同步范围（从 `.stignore` 里放出来前先想清楚）。
- **/tbpz 排期同步（lark-cli）**：本机的 `~/.codebuddy/bin/lark-cli` 是指向 WorkBuddy 托管 Node 的 wrapper，新机没有这套。迁移初期 /tbpz 先不可用，之后在新机重装 @larksuite/cli 并重新授权，或改造成走飞书 SDK。不阻塞上传主链路。
- **launchd**：本机 launchd 起不来（怀疑中文路径），新机 `~/video-bot` 是纯英文路径，plist 已在 bootstrap.sh 里生成，大概率可用。若仍失败，退回登录后手动跑 `start.sh`。
- **help.md / 行为守则** 等仓库其他目录的文件不影响运行（机器人只读 video-bot 目录内文件），不同步没关系。
