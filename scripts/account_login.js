// 咸鱼之王「微信登录」检测与提醒脚本（独立运行）
// 启动游戏 -> 检测登录页 -> 掉登录则调扫码工具出二维码发企微群 -> 轮询扫码授权成功后切回。
//
// 登录校验核心逻辑在共享模块 scripts/lib/login_check.js(ensureLoggedIn)，
// daily_chain.js 也复用它做一条龙前置校验。本脚本只是它的独立运行外壳(连设备 + 参数解析)。
//
// 企微机器人 key 通过环境变量 WECOM_KEY 传入（不要硬编码进脚本提交）；独立运行时 key 必填。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   set WECOM_KEY=你的key && node scripts/account_login.js                 # 默认设备 emulator-5554
//   node scripts/account_login.js 16384                                    # 指定设备(name/address 包含匹配)
//   node scripts/account_login.js emulator-5554 8                          # 设备 + 点登录后等待二维码加载的秒数(默认8)
//   node scripts/account_login.js emulator-5554 8 10                       # 第3参=等待扫码授权的最长分钟数(默认5,兜底超时仍返回)
//
// 上报二维码后会每 5 秒截图 OCR 检测"授权成功"，检测到即立即切回咸鱼；超过最长分钟数仍未授权则放弃。
//
// 依赖 maa-tools 下载的 maa-node binding（npx maa-tools check 会自动准备）。

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

const { ensureLoggedIn } = require('./lib/login_check')

// 资源目录：相对本脚本定位到项目 assets/resource
const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const SHOT_WAIT_SEC = Number(process.argv[3] || 8) // 点"微信登录"后等待二维码页加载再截图的秒数
const MAX_WAIT_MIN = Number(process.argv[4] || 5) // 上报后等待人工扫码授权的最长分钟数(兜底,默认5)
const WECOM_KEY = process.env.WECOM_KEY || '' // 企微机器人 key（用环境变量 WECOM_KEY 传入）

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, `[${TARGET}]`, ...a)

async function run() {
    if (!WECOM_KEY) throw new Error('未设置企微机器人 key：请设置环境变量 WECOM_KEY')

    const devices = await maa.AdbController.find()
    if (!devices) throw new Error('未发现任何 adb 设备')
    const dev = devices.find((d) => d[0].includes(TARGET) || d[2].includes(TARGET)) ?? devices[0]
    const [name, adb_path, address, scr, inp, config] = dev
    log('使用设备:', name, address)

    // ★ 截图方式：强制用标准 adb 截图(RawWithGzip=4) + config={}，与 daily_all 一致。
    //   原因：MuMu 多开时 extras 通道(scr=64)可能 display_id=-1 截到横屏，导致竖屏坐标全失效。
    //   (可设环境变量 USE_FIND_SCR=1 改回 find() 默认的截图方式。)
    const useFindScr = process.env.USE_FIND_SCR === '1'
    const SCREENCAP = useFindScr ? scr : '4' // 4 = MaaAdbScreencapMethod.RawWithGzip
    const CONFIG = useFindScr ? config : '{}'
    const ctrl = new maa.AdbController(adb_path, address, SCREENCAP, inp, CONFIG)
    ctrl.screenshot_target_short_side = 720 // 必须与 interface.json display_short_side 一致
    if (!(await ctrl.post_connection().wait().succeeded)) throw new Error('设备连接失败')

    const res = new maa.Resource()
    if (!(await res.post_bundle(RESOURCE).wait().succeeded)) throw new Error('资源加载失败')

    const tasker = new maa.Tasker()
    tasker.resource = res
    tasker.controller = ctrl

    try {
        const result = await ensureLoggedIn(ctrl, tasker, {
            wecomKey: WECOM_KEY,
            target: TARGET,
            shotWaitSec: SHOT_WAIT_SEC,
            maxWaitMin: MAX_WAIT_MIN,
            log,
        })
        if (result === 'authorized') log('✓ 扫码授权成功，已切回游戏，结束。')
        else if (result === 'timeout') log('⚠ 等不到扫码授权，结束。')
        else log('已登录(无需登录)，结束。')
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
}

run().catch((e) => {
    log('致命错误:', e.message ?? e)
    process.exit(1)
})
