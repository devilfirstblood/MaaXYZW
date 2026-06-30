# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

本仓库基于 [MaaPracticeBoilerplate](https://github.com/MaaXYZ/MaaPracticeBoilerplate) 模板，是一个 **MaaFramework 黑盒自动化项目**。它本身只包含「资源 + 逻辑」（pipeline JSON、interface.json、可选的 Python agent），不含 GUI；运行时由外部的 MaaFramework 运行库 + GUI（MFAAvalonia）加载本项目的 `assets/` 来执行。

核心理念：**低代码**。绝大多数自动化逻辑用 JSON pipeline 描述（图像识别 + 动作），只有复杂逻辑才落到 Python 自定义识别/动作。

## 常用命令

```bash
# 安装 Node 开发工具依赖（含 @nekosu/maa-tools 调试工具链）
npm install

# 校验 interface.json + 所有 pipeline 是否合法（CI 必跑，改完资源务必本地跑）
npx maa-tools check

# 配置 OCR 模型：从 MaaCommonAssets 子模块复制默认 OCR 模型到 assets/resource/model/ocr/
python tools/configure.py

# JSON Schema 校验（CI check.yml 的一部分，比 maa-tools check 更严格）
python -m pip install jsonschema==4.26.0 referencing==0.37.0
python tools/validate_schema.py --schema-dir deps/tools --resource-dirs assets/resource \
  --exclude-dirs assets/resource/announcement --interface-files assets/interface.json
```

发版：给 commit 打 `v*` tag 并推送，CI（`.github/workflows/install.yml`）会自动拉取 MaaFramework + MFAAvalonia、打包四平台（win/macos/linux/android × aarch64/x86_64）、生成 changelog 并发 Release。

## 首次配置（克隆后必做）

1. `git submodule update --init --recursive` — 拉取 `assets/MaaCommonAssets`（OCR 模型源）
2. `python tools/configure.py` — 复制 OCR 模型到 `assets/resource/model/ocr/`（该目录被 `.gitignore` 忽略，不入库；发版时 CI 自动配置）
3. `npm install`

## 架构与关键概念

### interface.json（项目门面）
`assets/interface.json`（ProjectInterface V2）定义 GUI 上暴露的内容：
- `controller`：Adb（安卓/模拟器）和 Win32（桌面）两类控制器。**`display_short_side` 决定截图缩放**——所有 pipeline 里的坐标/ROI 都基于缩放后的尺寸，不是设备物理分辨率。
- `resource`：资源包路径（多服务器可指向不同目录）
- `task`：GUI 任务列表，每个 `entry` 指向某个 pipeline 节点名作为起点
- `option`：任务的可选项，通过 `pipeline_override` 在运行时覆盖 pipeline 字段
- `agent`（可选）：启用 Python 自定义识别/动作时配置 `child_exec`/`child_args`

### Pipeline（`assets/resource/pipeline/*.json`）
一组命名节点，每个节点 = 一次「识别 + 动作」。**节点间靠 `next` 跳转，这是核心执行模型**：

- 执行逻辑是 `while(!timeout) { foreach(next) 按顺序识别，命中第一个就执行其动作; sleep(rate_limit) }`。**这天然就是循环重试机制**——一个节点的 `next` 列表会被反复识别直到命中或超时，无需手动让节点互相 `next` 来构造循环。
- `recognition` 缺省为 `DirectHit`（必命中、不识别）。**DirectHit 节点在 `next` 列表里要放最后做兜底**，否则它每轮都命中、前面有识别条件的节点永远轮不到。
- 识别类型：`OCR`（`expected` 支持正则，注意 `"战斗"` 会匹配 `"战斗中"`，要精确用 `"^战斗$"`）、`TemplateMatch`、`ColorMatch` 等。
- 动作类型：`Click`、`StartApp`（拉起 App，比外部 adb 更可靠）、`ClickKey`（`key` 填 Android KeyEvent 码，返回键=4）、`Swipe`、`InputText`、`Custom` 等。
- 时序字段：`post_delay`（动作后延迟，页面跳转要留足时间，否则会在页面没加载完时误判/截图错）、`pre_wait_freezes`/`post_wait_freezes`（等画面静止，应对弹窗动画/陆续弹出）、`timeout`（默认 20s，-1 为无限）。

JSON 文件是 **JSONC**（允许 `//` 注释）。字段权威定义在 `deps/tools/pipeline.schema.json` / `interface.schema.json`——写 pipeline 前查 schema 比凭记忆准。

### Python Agent（可选，`agent/`）
仅当 pipeline 不够用时启用。`my_reco.py` 用 `@AgentServer.custom_recognition("名字")` 注册自定义识别，`my_action.py` 用 `@AgentServer.custom_action("名字")` 注册自定义动作，pipeline 里通过 `custom_recognition`/`custom_action` 引用。`main.py` 是 agent 进程入口。

## 本地真机/模拟器运行调试

`maa-tools check` 只校验配置；`maa-tools test` 是**离线截图回归测试**（不连设备、不执行动作）。要在真机/模拟器上**实际跑通 pipeline**，没有内置命令——需用 maa-tools 下载的 maa-node binding（位于 `~/.maa-tools/install/latest/node_modules/@maaxyz/maa-node`）写 Node 脚本：`AdbController.find()` 找设备 → `post_connection()` → `Resource.post_bundle('assets/resource')` → `Tasker.post_task('入口节点名')`。设置 `controller.screenshot_target_short_side` 要与 interface.json 的 `display_short_side` 一致，识别坐标才对得上。

调坐标/ROI 时：用 maa 截图（缩放后系，与 OCR 同坐标系）配合 `post_recognition('OCR', {expected,roi}, img)` 看命中的 box，比手动换算物理坐标可靠。推荐安装 VSCode 插件 **Maa Pipeline Support**（截图、取 ROI、取色、调试）。

## 定时执行脚本（`scripts/`）

GUI 之外的无人值守自动化用 `scripts/` 下的 Node 脚本驱动（直接调 maa-node binding，每轮新建连接/资源/tasker 跑完销毁、带单轮超时关游戏兜底）：

- `daily_chain.js` — 咸鱼之王「一条龙」（挂机+盐罐），定时循环。入口 `咸鱼_启动游戏` + override。
- `daily_all.js` — 「每日任务一键全完成」，每天定点。入口 `全日常_启动` + override：前段各活动 `xxx_完成`→复位节点串成主干，尾段再接 领奖→收邮件(`邮件_启动`)→领福利(`充值_启动`)→咸王→钓鱼。
- `account_login.js` — 独立的「微信登录」检测与提醒。

用法/参数见各脚本头部注释。默认设备 `emulator-5554`，截图统一强制标准 adb 截图（`screencap=4`）+ `screenshot_target_short_side=720`（应对 MuMu 多开横屏问题）。

### 登录校验共享模块 `scripts/lib/login_check.js`

`daily_chain.js` / `daily_all.js` 跑任务**前**、以及 `account_login.js` 都复用它的 `ensureLoggedIn(ctrl, tasker, opts)`：跑 `微信登录_启动` pipeline（`xyzw_login.json`）检测是否掉登录态——已登录返回 `'already'`；掉登录则**先关后启**扫码工具 `com.willh.wz`（刷新二维码）→ 截二维码发企微群 → 轮询 OCR「授权成功」→ 切回咸鱼并等主界面就绪，返回 `'authorized'`；等不到授权返回 `'timeout'`。模块不建/销毁连接、不读 `process.argv`，连接生命周期由调用方管。

- 需 **环境变量 `WECOM_KEY`**（企微机器人 key）才发二维码；定时脚本未设 key 则**跳过登录校验直接跑**（向后兼容）。授权超时则跳过本轮等下个周期。
- 注意「先关后启」是必须的：扫码工具若后台残留旧二维码/上次「授权成功」页，`post_start_app` 只切前台不刷新，会截到旧码或误判授权。

### 切号共享模块 `scripts/lib/switch_account.js`（多账号编排待启用）

「多开机器人」切号：主界面顶部标题（第XXXX关）是当前账号，标题左右两个切换位头像显示另两个账号的关卡数，点头像即切到那个号（轮换，实测最多 3 账号）。模块提供「读标题关卡数 / 读切换位 / 切到某位并用 OCR 关卡数验证」三个原子能力；切号动作（点头像+关弹窗+回主界面）走 `assets/resource/pipeline/xyzw_switch_account.json`（入口 `切号_点头像`）。坐标基于 720 缩放系。

- 和 `login_check.js` 一样不建/销毁连接、不读 `process.argv`，编排由调用方管。
- **已验证可用，但尚未被 `daily_all.js` 等接入**——多账号编排待启用，目前没有脚本/GUI 入口驱动它。

## 代码风格

JSON/YAML 用 prettier（配 `prettier-plugin-multiline-arrays`，**保持数组多行**），Markdown 用 markdownlint，PNG 用 oxipng 无损压缩。可 `pip install pre-commit && pre-commit install` 让提交时自动格式化。
