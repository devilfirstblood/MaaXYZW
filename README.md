<!-- markdownlint-disable MD033 MD041 -->
<div align="center">
  <img alt="LOGO" src="https://cdn.jsdelivr.net/gh/MaaAssistantArknights/design@main/v1/icons/maa-logo_512x512.png" width="200" height="200" />

# MaaXYZW

基于 [MaaFramework](https://github.com/MaaXYZ/MaaFramework) 的《咸鱼之王》黑盒自动化项目

<p>
  <a href="https://github.com/devilfirstblood/MaaXYZW/actions/workflows/install.yml">
    <img alt="Build" src="https://img.shields.io/github/actions/workflow/status/devilfirstblood/MaaXYZW/install.yml?branch=main&label=Build" />
  </a>
  <a href="https://github.com/devilfirstblood/MaaXYZW/releases">
    <img alt="Release" src="https://img.shields.io/github/v/release/devilfirstblood/MaaXYZW?label=Release&include_prereleases" />
  </a>
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green" />
</p>

</div>

---

## 简介

MaaXYZW 是一个面向《咸鱼之王》安卓模拟器环境的自动化项目，基于 [MaaPracticeBoilerplate](https://github.com/MaaXYZ/MaaPracticeBoilerplate) 模板开发。

项目本体只包含「资源 + 逻辑」——pipeline JSON、`interface.json`，以及可选的 Python agent，**不含 GUI**。运行时由外部的 MaaFramework 运行库 + [MFAAvalonia](https://github.com/SweetSmellFox/MFAAvalonia) 图形界面加载本项目的 `assets/` 来执行。CI 会自动拉取 MaaFramework 与 MFAAvalonia，打包成开箱即用的多平台全量包。

核心理念是**低代码**：绝大多数自动化逻辑用 JSON pipeline 描述（图像识别 + 动作），只有复杂逻辑才落到 Python 自定义识别/动作。

除了 GUI，本项目还提供 `scripts/` 下的 Node 脚本，用于**无人值守的定时自动化**（一条龙、每日任务、掉登录二维码代登录提醒等）。

> 本项目仅用于学习与交流。自动化行为可能受游戏版本、模拟器环境、区服包名等因素影响，请自行承担使用风险。

## 下载

前往 [GitHub Releases](https://github.com/devilfirstblood/MaaXYZW/releases) 下载对应系统的全量包（已内置 MaaFramework + MFAAvalonia + 本项目资源）：

| 平台 | 文件名示例 |
| --- | --- |
| Windows x64 | `MaaXYZW-win-x86_64-v*.zip` |
| Windows ARM64 | `MaaXYZW-win-aarch64-v*.zip` |
| macOS Intel | `MaaXYZW-macos-x86_64-v*.zip` |
| macOS Apple Silicon | `MaaXYZW-macos-aarch64-v*.zip` |
| Linux x64 | `MaaXYZW-linux-x86_64-v*.zip` |
| Android | `MaaXYZW-android-*-v*.zip` |

绝大多数 Windows 用户请选择 `MaaXYZW-win-x86_64-*.zip`。

## 快速开始

1. 下载并解压对应平台的全量包。
2. Windows 双击运行 MFAAvalonia 图形界面入口（`MFAAvalonia.exe`）；macOS / Linux 运行解压目录中的对应可执行文件。
3. 打开安卓模拟器，确保已开启 ADB 调试。
4. 在 GUI 中添加设备，选择自动搜索到的模拟器，或手动填写 ADB 路径与地址。
5. 选择资源（官服 / B 服），勾选要运行的任务并按需配置选项。
6. 大多数任务请从游戏**主界面**启动；`咸鱼之王示例-进主界面`、`一条龙` 等带「启动游戏」的任务除外。

> **关于分辨率**：所有 pipeline 里的坐标 / ROI 都基于 `interface.json` 中 `display_short_side: 720` 缩放后的尺寸，而非设备物理分辨率。MuMu 多开等横屏场景建议把截图短边强制为 720，识别坐标才对得上。

## 功能

GUI 任务列表（以 `assets/interface.json` 的 `task` 为准）：

**每日任务（可单独跑，也可一键全完成）**

- 赠送好友金币、进行 2 次招募、进行 3 次点金、开启 3 次宝箱、黑市购买 1 次、竞技场战斗 3 次、钓鱼普通捕获 3 次
- 每日任务领奖（领任务奖 + 周 / 日活跃宝箱）
- 收邮件、领福利活动（签到 + 每日特惠 + 尊享福利卡）、每日咸王考验
- **每日任务一键全完成**：串成一条链，启动 → 任务页 → 各子任务（已完成的自动跳过）→ 统一领奖 → 收邮件 → 领福利 → 咸王 → 钓鱼

**挂机产出**

- 挂机领取、盐罐加时 + 领奖
- **一条龙**：启动游戏 → 挂机领取 → 盐罐加时 + 领奖 → 退出游戏

**账号 / 登录**

- 微信扫码代登录工具配套（见 [`apk/`](apk/)）+ 掉登录检测提醒

每个 GUI 任务对应 pipeline 中的某个入口节点，部分任务通过 `pipeline_override` 把各活动子链衔接成串联链路。任务能力以 `assets/resource/pipeline/*.json` 为准。

## 定时无人值守（`scripts/`）

GUI 之外的无人值守自动化用 `scripts/` 下的 Node 脚本驱动——直接调用 maa-node binding，每轮新建连接 / 资源 / tasker，跑完销毁，带单轮超时关游戏兜底：

| 脚本 | 说明 | 入口 |
| --- | --- | --- |
| `daily_chain.js` | 「一条龙」（挂机 + 盐罐），默认每 8 小时循环 | `咸鱼_启动游戏` + override |
| `daily_all.js` | 「每日任务一键全完成」，每天定点执行 | `全日常_启动` + override |
| `account_login.js` | 独立的「微信登录」掉线检测与二维码提醒 | `微信登录_启动` |

用法 / 参数见各脚本头部注释，例如：

```bash
node scripts/daily_all.js                 # 默认设备 emulator-5554，每天 8:00 执行
node scripts/daily_all.js 16384 13        # 指定设备(name/address 包含匹配) + 每天 13:00
node scripts/daily_all.js 16384 8 once    # 立即只跑一次，不循环

node scripts/daily_chain.js               # 默认每 8 小时跑一次一条龙
node scripts/daily_chain.js emulator-5554 4   # 指定设备 + 间隔小时数
```

脚本默认设备 `emulator-5554`，统一强制标准 adb 截图（`screencap=4`）+ `screenshot_target_short_side=720`（应对 MuMu 多开横屏问题）。

### 掉登录自动代登录

`daily_chain.js` / `daily_all.js` 跑任务**前**会复用共享模块 [`scripts/lib/login_check.js`](scripts/lib/login_check.js) 的 `ensureLoggedIn()` 检测登录态：

- 已登录则直接跑任务；
- 掉登录则先关后启扫码工具 `com.willh.wz`（刷新二维码）→ 截二维码发企微群 → 轮询 OCR「授权成功」→ 切回咸鱼并等主界面就绪后再跑任务。

需设置环境变量 `WECOM_KEY`（企微机器人 key）才发二维码；**定时脚本未设 key 则跳过登录校验直接跑**（向后兼容）。扫码工具 APK 见 [`apk/GameWxQRlogin-xyzw.apk`](apk/)。

## 项目结构

```text
.
├── assets/
│   ├── interface.json          # 项目门面：controller / resource / task / option
│   ├── resource/
│   │   └── pipeline/           # 各功能 pipeline（识别 + 动作）
│   └── MaaCommonAssets/        # 子模块：OCR 模型源
├── agent/                       # 可选的 Python 自定义识别 / 动作
│   ├── main.py                 # agent 进程入口
│   ├── my_reco.py              # @AgentServer.custom_recognition
│   └── my_action.py            # @AgentServer.custom_action
├── scripts/                     # 定时无人值守 Node 脚本
│   └── lib/                    # 登录校验 / 切号共享模块
├── apk/                         # 配套工具 APK（微信扫码代登录）
├── tools/                       # configure.py / validate_schema.py 等
├── deps/tools/                  # pipeline / interface 的 JSON Schema
└── .github/workflows/           # check 校验 + install 打包发布
```

## 开发说明

### 首次配置（克隆后必做）

```bash
git submodule update --init --recursive   # 拉取 assets/MaaCommonAssets（OCR 模型源）
python tools/configure.py                  # 复制 OCR 模型到 assets/resource/model/ocr/
npm install                                # 安装 Node 开发工具链（含 @nekosu/maa-tools）
```

`assets/resource/model/ocr/` 被 `.gitignore` 忽略，不入库；发版时 CI 会自动配置。

### 常用命令

```bash
# 校验 interface.json + 所有 pipeline 是否合法（CI 必跑，改完资源务必本地跑）
npx maa-tools check

# 离线截图回归测试（不连设备、不执行动作）
npx maa-tools test

# JSON Schema 校验（CI check.yml 的一部分，比 maa-tools check 更严格）
python -m pip install jsonschema==4.26.0 referencing==0.37.0
python tools/validate_schema.py --schema-dir deps/tools --resource-dirs assets/resource \
  --exclude-dirs assets/resource/announcement --interface-files assets/interface.json
```

### Pipeline 约定

- pipeline JSON 是 **JSONC**（允许 `//` 注释），字段权威定义在 [`deps/tools/pipeline.schema.json`](deps/tools/pipeline.schema.json)。
- 节点间靠 `next` 跳转，执行模型天然是「循环重试」：一个节点的 `next` 列表会被反复识别直到命中或超时。
- `recognition` 缺省为 `DirectHit`（必命中），放在 `next` 列表末尾做兜底，否则会抢占前面有识别条件的节点。
- 页面跳转要留足 `post_delay` / `post_wait_freezes`，否则会在页面没加载完时误判或截图错。

### 真机 / 模拟器调试

`maa-tools check` 只校验配置，要在真机 / 模拟器上**实际跑通** pipeline 需用 maa-tools 下载的 maa-node binding 写 Node 脚本（`scripts/` 下的脚本即范例）：`AdbController.find()` → `post_connection()` → `Resource.post_bundle('assets/resource')` → `Tasker.post_task('入口节点名')`。`screenshot_target_short_side` 要与 `interface.json` 的 `display_short_side` 一致，识别坐标才对得上。

推荐安装 VSCode 插件 **Maa Pipeline Support**（截图、取 ROI、取色、调试）。

### Python Agent（可选）

仅当 pipeline 不够用时启用。在 `agent/my_reco.py` / `my_action.py` 注册自定义识别 / 动作，pipeline 里通过 `custom_recognition` / `custom_action` 引用，并在 `interface.json` 启用 `agent.child_exec` / `child_args`。

## 常见问题

### 找不到模拟器怎么办？

先确认模拟器已启动并开启 ADB 调试。自动搜索失败时手动填写：

- ADB 路径：模拟器安装目录下的 `adb.exe`。
- ADB 地址：常见格式 `127.0.0.1:5555`、`127.0.0.1:16384` 或 `emulator-5554`。MuMu 多开端口通常随实例递增。

### 任务卡在某个界面 / 识别不到？

常见原因：

- 没有从任务预期界面启动（多数任务需在主界面开始）。
- 模拟器分辨率 / 截图短边与 `display_short_side: 720` 不一致，导致坐标错位（尤其 MuMu 多开横屏）。
- 游戏更新后按钮、图标或页面结构发生变化，需更新对应 pipeline 素材。

反馈时请尽量带上截图、任务名、资源选择、模拟器名称和日志。

### 定时脚本报找不到 maa-node？

`scripts/` 依赖 maa-tools 下载的 maa-node binding（位于 `~/.maa-tools/install/latest/...`）。先跑一次 `npx maa-tools check` 让其自动准备，并确保使用较新版本的 Node（旧版不兼容）。

## CI 与发布

- [`.github/workflows/check.yml`](.github/workflows/check.yml)：PR / push 校验 `interface.json` 与所有 pipeline。
- [`.github/workflows/install.yml`](.github/workflows/install.yml)：给 commit 打 `v*` tag 并推送即触发发布——自动拉取 MaaFramework + MFAAvalonia，打包 **win / macos / linux / android × aarch64 / x86_64**，用 `git-cliff` 生成 changelog 并发 Release。分支 push / PR 也会构建 CI 预发布包。

提交建议使用 Conventional Commits（`feat:` / `fix:` / `refactor:` / `ci:` …）。代码风格：JSON / YAML 用 prettier（配 `prettier-plugin-multiline-arrays`，保持数组多行），Markdown 用 markdownlint，PNG 用 oxipng 无损压缩；可 `pip install pre-commit && pre-commit install` 让提交时自动格式化。

## 鸣谢

本项目由 **[MaaFramework](https://github.com/MaaXYZ/MaaFramework)** 强力驱动，图形界面基于 **[MFAAvalonia](https://github.com/SweetSmellFox/MFAAvalonia)**，模板源自 **[MaaPracticeBoilerplate](https://github.com/MaaXYZ/MaaPracticeBoilerplate)**。

感谢以下开发者对本项目作出的贡献：

[![Contributors](https://contrib.rocks/image?repo=devilfirstblood/MaaXYZW&max=1000)](https://github.com/devilfirstblood/MaaXYZW/graphs/contributors)

## 许可

本项目使用 [MIT License](LICENSE) 发布。
