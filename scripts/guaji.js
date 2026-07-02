// 咸鱼之王「挂机领取（按已挂机时长动态加钟助力）」独立脚本
//
// 薄壳：建连接 → 调 scripts/lib/guaji.js 的 runGuaji → 销毁。核心逻辑/坐标见 lib。
// 前置：游戏已在主界面（底部「战斗」Tab）。本脚本只做挂机领取，不启动游戏/登录校验。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   node scripts/guaji.js                    # 默认设备 emulator-5554，跑一次后退出
//   node scripts/guaji.js 127.0.0.1:16416    # 指定 adb 设备地址，跑一次
//   node scripts/guaji.js emulator-5554 8     # 指定设备 + 每 8 小时循环一次

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

const { runGuaji } = require('./lib/guaji')

const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')
const TARGET = process.argv[2] || 'emulator-5554'
const INTERVAL_HOURS = Number(process.argv[3]) || 0 // >0 则每隔该小时数循环；0/不给 = 跑一次退出
const RUN_TIMEOUT_MS = 5 * 60 * 1000 // 单轮总超时 5 分钟，超时只中止本轮（不关游戏）

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 跑一次：新建连接/资源/tasker，跑完销毁；带整轮超时（超时只中止本轮，不关游戏）。
async function runOnce() {
    const devices = await maa.AdbController.find()
    if (!devices) throw new Error('未发现任何 adb 设备')
    const dev = devices.find((d) => d[0].includes(TARGET) || d[2].includes(TARGET)) ?? devices[0]
    const [name, adb_path, address, scr, inp, config] = dev
    log('使用设备:', name, address)

    // 强制标准 adb 截图(RawWithGzip=4) + 空 config 去掉 mumu extras，应对 MuMu 多开横屏问题。
    // （可设环境变量 USE_FIND_SCR=1 改回 find() 默认截图方式。）
    const useFindScr = process.env.USE_FIND_SCR === '1'
    const ctrl = new maa.AdbController(adb_path, address, useFindScr ? scr : '4', inp, useFindScr ? config : '{}')
    ctrl.screenshot_target_short_side = 720 // 必须与 interface.json display_short_side 一致
    if (!(await ctrl.post_connection().wait().succeeded)) throw new Error('设备连接失败')

    const res = new maa.Resource()
    if (!(await res.post_bundle(RESOURCE).wait().succeeded)) throw new Error('资源加载失败')

    const tasker = new maa.Tasker()
    tasker.resource = res
    tasker.controller = ctrl

    try {
        let timer
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve('__TIMEOUT__'), RUN_TIMEOUT_MS)
        })
        const r = await Promise.race([runGuaji(tasker, { log }), timeout])
        clearTimeout(timer)
        if (r === '__TIMEOUT__') {
            log(`⚠ 本轮超时(${RUN_TIMEOUT_MS / 60000} 分钟未完成)，中止本轮（不关游戏）`)
            try {
                await tasker.post_stop().wait()
            } catch (e) {
                log('post_stop 异常:', e.message ?? e)
            }
        }
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
}

;(async () => {
    log('==== 咸鱼挂机领取脚本启动 ====', `设备=${TARGET}`, INTERVAL_HOURS > 0 ? `(每 ${INTERVAL_HOURS} 小时一次)` : '(跑一次)')
    log('资源目录:', RESOURCE)
    while (true) {
        try {
            await runOnce()
        } catch (e) {
            log('本轮执行出错:', e.message ?? e)
        }
        if (INTERVAL_HOURS <= 0) break
        const next = new Date(Date.now() + INTERVAL_HOURS * 3600 * 1000)
        log(`下一次执行时间: ${next.toLocaleString('zh-CN', { hour12: false })}（${INTERVAL_HOURS} 小时后）`)
        await sleep(INTERVAL_HOURS * 3600 * 1000)
    }
    log('结束。')
})().catch((e) => {
    log('致命错误:', e)
    process.exit(1)
})
