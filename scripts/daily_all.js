// 咸鱼之王「每日任务一键全完成」定时执行脚本
// 一条链：启动进主界面 -> 进任务页 -> 赠送/招募/点金/宝箱/黑市/竞技场(已完成的自动跳过)
//         -> 统一领取任务奖 + 周/日活跃全部领取
// 与 interface.json 的「咸鱼之王-每日任务一键全完成」task 完全一致(入口+override)。
//
// 单轮超时保护：每轮限时 15 分钟，超时(未拿到 status=3000)则中止任务 + 强制关游戏，
// 然后等下一周期；避免卡死时一直占着游戏。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   node scripts/daily_all.js                  # 默认设备 emulator-5554，每24小时循环
//   node scripts/daily_all.js 16384            # 指定设备(name/address 包含匹配，如 MuMu 模拟器1)
//   node scripts/daily_all.js 16416 24         # 指定设备 + 间隔小时数(默认24，每日任务一天一次)
//   node scripts/daily_all.js 16384 24 once    # 只跑一次，不循环
//   node scripts/daily_all.js 16384 24 once 15 # 第5参=单轮超时分钟数(默认15)
//
// 多模拟器：两台分别用各自 address/name 起两个进程，例如：
//   node scripts/daily_all.js 16384   # 模拟器1
//   node scripts/daily_all.js 16416   # 模拟器2
//
// 依赖 maa-tools 下载的 maa-node binding（npx maa-tools check 会自动准备）。

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

// 资源目录：相对本脚本定位到项目 assets/resource
const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const INTERVAL_HOURS = Number(process.argv[3] || 24) // 间隔小时数（每日任务一天一次，默认24）
const ONCE = process.argv[4] === 'once' // 只跑一次

const PACKAGE = 'com.hortor.games.xyzw' // 咸鱼之王包名（超时时强制关闭）
// 单轮超时：默认 15 分钟（新账号全任务真实执行较久），超时即关游戏等下一周期。第5参(分钟)可覆盖。
const RUN_TIMEOUT_MS = (Number(process.argv[5]) || 15) * 60 * 1000

// 「每日任务一键全完成」串联：入口 全日常_启动 + override 衔接各段
// （与 interface.json 的「咸鱼之王-每日任务一键全完成」task 一致）
const ENTRY = '全日常_启动'
const OVERRIDE = {
    '赠送金币_完成': { next: ['全日常_复位1'] },
    '赠送金币_已完成跳过': { next: ['全日常_复位1'] }, // 赠送已完成走的是跳过出口，也要接复位
    '招募_完成': { next: ['全日常_复位2'] },
    '点金_完成': { next: ['全日常_复位3'] },
    '宝箱_完成': { next: ['全日常_复位4'] },
    '黑市_完成': { next: ['全日常_复位5'] },
    '竞技场_完成': { next: ['全日常_复位6'] },
}

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, `[${TARGET}]`, ...a)

// 跑一次每日任务全完成：每次新建连接/资源/tasker，跑完销毁，避免长时间持有句柄。
// 加 15 分钟超时：超时未完成(拿不到 status=3000)则中止任务 + 强制关游戏，等下一周期。
async function runOnce() {
    const devices = await maa.AdbController.find()
    if (!devices) throw new Error('未发现任何 adb 设备')
    const dev = devices.find((d) => d[0].includes(TARGET) || d[2].includes(TARGET)) ?? devices[0]
    const [name, adb_path, address, scr, inp, config] = dev
    log('使用设备:', name, address, 'scr(find)=', scr)

    // ★ 截图方式：强制用标准 adb 截图(RawWithGzip=4)，不用 find() 默认的 MuMu 专用通道(scr=64)。
    //   原因：MuMu 多开第二实例时 MuMuPlayerExtras 拿不到 display_id(display_id=-1)，
    //   会截到横屏(1280x720)而非竖屏(720x1280)，导致所有竖屏坐标失效、识别全失败、卡死。
    //   标准 adb 截图稍慢但方向正确、多开稳定。config 用空对象去掉 mumu extras。
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

    // 关游戏：优先用控制器 post_stop_app，失败兜底用 adb force-stop
    async function killGame() {
        try {
            await ctrl.post_stop_app(PACKAGE).wait()
            log('已发送关闭游戏指令(post_stop_app):', PACKAGE)
        } catch (e) {
            log('post_stop_app 失败，改用 adb force-stop:', e.message ?? e)
            try {
                require('child_process').execSync(`adb -s ${address} shell am force-stop ${PACKAGE}`)
                log('已 adb force-stop:', PACKAGE)
            } catch (e2) {
                log('adb force-stop 也失败:', e2.message ?? e2)
            }
        }
    }

    try {
        log('开始执行每日任务一键全完成:', ENTRY, `(超时 ${RUN_TIMEOUT_MS / 60000} 分钟)`)
        const job = tasker.post_task(ENTRY, OVERRIDE)

        // 任务完成 vs 超时，赛跑
        let timer
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve('__TIMEOUT__'), RUN_TIMEOUT_MS)
        })
        const detail = await Promise.race([job.wait().get(), timeout])
        clearTimeout(timer)

        if (detail === '__TIMEOUT__') {
            log(`⚠ 每日任务超时(${RUN_TIMEOUT_MS / 60000} 分钟未完成)，中止任务并关游戏`)
            try {
                await tasker.post_stop().wait() // 中止 tasker 当前任务流水线，等中止生效再 destroy
            } catch (e) {
                log('post_stop 异常:', e.message ?? e)
            }
            await killGame()
        } else if (detail && detail.status === 3000) {
            log('✓ 每日任务完成 status=', detail.status, 'nodes=', detail.nodes.length)
        } else {
            // 任务结束但非成功(如某段 4000 失败)：也关游戏，保持设备干净
            log('✗ 每日任务未成功 status=', detail && detail.status, 'nodes=', detail && detail.nodes.length, '-> 关游戏')
            await killGame()
        }
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
    log('==== 咸鱼每日任务一键全完成 定时脚本启动 ====', `设备=${TARGET}`, ONCE ? '(只跑一次)' : `(每 ${INTERVAL_HOURS} 小时一次)`)
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
