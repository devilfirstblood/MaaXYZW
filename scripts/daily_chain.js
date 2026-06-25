// 咸鱼之王「一条龙」定时执行脚本
// 每隔 8 小时执行一次：启动游戏进主界面 -> 挂机领取 -> 盐罐加时+领奖 -> 退出游戏
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   node scripts/daily_chain.js                  # 默认设备 emulator-5554，每8小时循环
//   node scripts/daily_chain.js 127.0.0.1:16384  # 指定 adb 设备地址
//   node scripts/daily_chain.js emulator-5554 4  # 指定设备 + 间隔小时数(4小时)
//   node scripts/daily_chain.js emulator-5554 8 once  # 只跑一次，不循环
//
// 依赖 maa-tools 下载的 maa-node binding（npx maa-tools check 会自动准备）。

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

// 资源目录：相对本脚本定位到项目 assets/resource
const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const INTERVAL_HOURS = Number(process.argv[3] || 8) // 间隔小时数
const ONCE = process.argv[4] === 'once' // 只跑一次

// 「一条龙」串联：入口 咸鱼_启动游戏 + override 衔接三段
// （与 interface.json 的「咸鱼之王-一条龙」task 一致）
const CHAIN_ENTRY = '咸鱼_启动游戏'
const CHAIN_OVERRIDE = {
    '咸鱼_二次确认主界面': { next: ['挂机_入口'] },
    '挂机_完成': { next: ['盐罐_入口'] },
}

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, ...a)

// 跑一次一条龙：每次都新建连接/资源/tasker，跑完销毁，避免长时间持有句柄
async function runOnce() {
    const devices = await maa.AdbController.find()
    if (!devices) throw new Error('未发现任何 adb 设备')
    const dev = devices.find((d) => d[0].includes(TARGET) || d[2].includes(TARGET)) ?? devices[0]
    const [name, adb_path, address, scr, inp, config] = dev
    log('使用设备:', name, address)

    const ctrl = new maa.AdbController(adb_path, address, scr, inp, config)
    ctrl.screenshot_target_short_side = 720 // 必须与 interface.json display_short_side 一致
    if (!(await ctrl.post_connection().wait().succeeded)) throw new Error('设备连接失败')

    const res = new maa.Resource()
    if (!(await res.post_bundle(RESOURCE).wait().succeeded)) throw new Error('资源加载失败')

    const tasker = new maa.Tasker()
    tasker.resource = res
    tasker.controller = ctrl

    log('开始执行一条龙:', CHAIN_ENTRY)
    const detail = await tasker.post_task(CHAIN_ENTRY, CHAIN_OVERRIDE).wait().get()
    log('一条龙完成 status=', detail.status, 'nodes=', detail.nodes.length)

    tasker.destroy()
    res.destroy()
    ctrl.destroy()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
    log('==== 咸鱼一条龙定时脚本启动 ====', `设备=${TARGET}`, ONCE ? '(只跑一次)' : `(每 ${INTERVAL_HOURS} 小时一次)`)
    log('资源目录:', RESOURCE)
    while (true) {
        try {
            await runOnce()
        } catch (e) {
            log('本轮执行出错（不中断循环）:', e.message ?? e)
        }
        if (ONCE) {
            log('单次模式，结束。')
            break
        }
        const next = new Date(Date.now() + INTERVAL_HOURS * 3600 * 1000)
        log(`下一次执行时间: ${next.toLocaleString('zh-CN', { hour12: false })}（${INTERVAL_HOURS} 小时后）`)
        await sleep(INTERVAL_HOURS * 3600 * 1000)
    }
})().catch((e) => {
    log('致命错误:', e)
    process.exit(1)
})
