// 咸鱼之王「一条龙」定时执行脚本（支持多账号轮转）
// 每隔 8 小时执行一次：一轮内对最多 3 个账号各跑一条龙(挂机领取 + 盐罐加时/领奖)，
//   做完一个号 → 读标题关卡数去重 → 挑未做过的切换位切号 → 再做(复用 lib/switch_account.js + lib/account_rotation.js)。
//   无其它账号时只做 1 个，向后兼容。
//
// 超时保护：每个账号一条龙各自限时 10 分钟，某账号超时(未拿到 status=3000)则中止该账号流水线、
// 不关游戏，尝试继续切下一个号；关游戏仅在开头冷启动前一次、及登录掉线等不到扫码授权时。
//
// 登录校验：设了环境变量 WECOM_KEY 时，每轮跑一条龙前先校验登录态(共享 lib/login_check.js)——
//   掉登录则调扫码工具出二维码发企微群、等人工扫码授权成功后再跑一条龙；授权超时则跳过本轮等下周期。
//   未设 WECOM_KEY 则跳过登录校验，直接跑一条龙(向后兼容)。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   node scripts/daily_chain.js                  # 默认设备 emulator-5554，每8小时循环
//   node scripts/daily_chain.js 127.0.0.1:16384  # 指定 adb 设备地址
//   node scripts/daily_chain.js emulator-5554 4  # 指定设备 + 间隔小时数(4小时)
//   node scripts/daily_chain.js emulator-5554 8 once  # 只跑一次，不循环
//   node scripts/daily_chain.js emulator-5554 8 once 10  # 第5参=每账号超时分钟数(默认10)
//
// 依赖 maa-tools 下载的 maa-node binding（npx maa-tools check 会自动准备）。

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

// 资源目录：相对本脚本定位到项目 assets/resource
const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')
const { readTitleStage, readSwitchSlots, switchToAccount } = require('./lib/switch_account')
const { pickNextSlot } = require('./lib/account_rotation')
const { runGuaji } = require('./lib/guaji')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const INTERVAL_HOURS = Number(process.argv[3] || 8) // 间隔小时数
const ONCE = process.argv[4] === 'once' // 只跑一次

const PACKAGE = 'com.hortor.games.xyzw' // 咸鱼之王包名（超时时强制关闭）
// 单轮一条龙超时：默认 10 分钟，超时即关游戏等下一周期。可用第 5 个参数(分钟)覆盖(便于调试)。
const RUN_TIMEOUT_MS = (Number(process.argv[5]) || 10) * 60 * 1000

// 「一条龙」串联：启动游戏(仅账号1冷启动) → 挂机领取(JS 动态加钟, lib/guaji.js) → 盐罐加时(pipeline)。
// 挂机段已从 pipeline 换成 JS(按已挂机时长动态点 0/1/2/3 个好友助力加号)，所以一条龙不再是
// 单个 post_task，而是在 runChainOnce 里分段执行：启动到主界面 → runGuaji → post_task('盐罐_入口')。
const MAX_ACCOUNTS = 3 // 多开机器人实测最多 3 号轮换；实际做几个由"还能读到未访问切换位"决定
const CHAIN_ENTRY_FIRST = '咸鱼_启动游戏' // 账号1：StartApp 冷启动进游戏
const CHAIN_ENTRY_NEXT = '挂机_入口' // 账号2+：切号后已在主界面，直接跑挂机(仅作首账号/热接入的标记)
const MAINSCREEN_NODE = '咸鱼_二次确认主界面' // 启动链到主界面就绪的终点节点(在此断开，交给 JS 挂机)
const YANGUAN_ENTRY = '盐罐_入口' // 盐罐段入口(主界面独立起跑，收尾回主界面)

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}

// 环形日志缓冲：每行日志除了打印，也存进来，失败/超时告警时取最近若干条随企微消息发出。
// 只留最近 LOG_BUFFER_MAX 条，避免长跑内存无限涨。
const LOG_BUFFER_MAX = 50
const logBuffer = []
const log = (...a) => {
    const line = `[${ts()}] ${a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')}`
    console.log(line)
    logBuffer.push(line)
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
}

// 账号 failed/timeout 时发企微告警：附最近 10 条执行日志。
// 复用 login_check 的 sendTextToWecom；未设 WECOM_KEY 则不发(向后兼容)。发送失败只记日志、不影响主流程。
const { ensureLoggedIn, sendTextToWecom } = require('./lib/login_check')
async function alertFail(reason) {
    const key = process.env.WECOM_KEY || ''
    if (!key) return
    const recent = logBuffer.slice(-10).join('\n')
    const text = `【咸鱼-一条龙-${TARGET}】${reason}\n最近日志：\n${recent}`
    try {
        await sendTextToWecom(key, text)
    } catch (e) {
        log('发送失败告警到企微出错(忽略):', e.message ?? e)
    }
}

// 跑一次一条龙：每次都新建连接/资源/tasker，跑完销毁，避免长时间持有句柄。
// 加 10 分钟超时：超时未完成(拿不到 status=3000)则中止任务 + 强制关游戏，等下一周期。
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

    // 节点级日志：每进入一个 pipeline 节点打印一行(便于观察一条龙执行进度、定位卡在哪个节点)。
    // add_context_sink 监听任务执行上下文通知，PipelineNode.Starting = 命中并进入某节点、准备执行其识别/动作。
    // sink 随 tasker.destroy() 一并清理，无需手动移除。
    tasker.add_context_sink((_ctx, m) => {
        if (m.msg === 'PipelineNode.Starting') log('  ▶', m.name)
    })

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

    await killGame()

    try {
        // 跑一条龙前先做登录校验：掉登录态时走扫码授权流程，授权成功后再跑一条龙。
        // 设了 WECOM_KEY 才启用(需要发企微二维码提醒人工扫码)；未设则跳过，保持原有不带 key 也能跑。
        const WECOM_KEY = process.env.WECOM_KEY || ''
        if (WECOM_KEY) {
            const loginResult = await ensureLoggedIn(ctrl, tasker, { wecomKey: WECOM_KEY, target: TARGET, log })
            if (loginResult === 'timeout') {
                log('⚠ 检测到掉登录态但等不到扫码授权，跳过本轮一条龙，关游戏等下个周期')
                await killGame()
                return // finally 仍会 destroy ctrl/res/tasker
            }
            // 'authorized'(刚扫码登录) 或 'already'(本就已登录) -> 继续跑一条龙
        } else {
            log('未设置 WECOM_KEY，跳过登录校验，直接跑一条龙')
        }

        // ==== 多账号轮转：做完一个号 → 切到未做过的号 → 再做，最多 MAX_ACCOUNTS 个 ====
        // 用「已做过账号的关卡数集合」去重：每做完一个号读标题关卡数即"刚做完的账号"，
        // 再从切换位里挑第一个未访问的切过去。天然适配 1/2/3 号并自动终止。
        // 前置：一条龙链尾停在主界面(盐罐已改造为领奖后回主界面、不退游戏)。
        const visited = new Set()
        let entry = CHAIN_ENTRY_FIRST // 账号1冷启动，之后热接入
        for (let i = 1; i <= MAX_ACCOUNTS; i++) {
            log(`==== 账号 ${i}/${MAX_ACCOUNTS}：入口 ${entry} ====`)
            const r = await runChainOnce(tasker, entry, RUN_TIMEOUT_MS, { log })
            log(`账号 ${i} 一条龙结果: ${r}`)
            if (r === 'failed' || r === 'timeout') await alertFail(`账号 ${i} 结果 ${r}`)

            // 链尾停在主界面，读顶部标题关卡数标识"刚做完的账号"
            const cur = await readTitleStage(ctrl, tasker)
            if (cur == null) {
                log('⚠ 读不到标题关卡数(可能未回到主界面/超时卡住)，停止多账号轮转')
                break
            }
            visited.add(cur)
            log(`当前账号 第${cur}关，已完成 ${visited.size} 个账号`)

            if (i >= MAX_ACCOUNTS) break

            const slots = await readSwitchSlots(ctrl, tasker)
            const slot = pickNextSlot(slots, visited)
            if (!slot) {
                log('无未做过的切换位，多账号轮转结束')
                break
            }
            const ok = await switchToAccount(ctrl, tasker, slot, { log })
            if (!ok) {
                log('✗ 切号失败，停止多账号轮转')
                break
            }
            entry = CHAIN_ENTRY_NEXT
        }
        // 收尾不关游戏，留前台(下轮开头 killGame 会清干净)
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
}

// 跑一个账号的一条龙，带独立超时。返回 'success' | 'timeout' | 'failed'。
// 分三段：① 启动到主界面(仅账号1冷启动，pipeline) ② 挂机领取(JS 动态加钟, lib/guaji) ③ 盐罐(pipeline)。
//   entry === CHAIN_ENTRY_FIRST 视为首账号(需冷启动)；否则(账号2+)切号后已在主界面，跳过第①段。
// 整条流水线在 timeoutMs 内赛跑；超时中止(post_stop)。本函数不关游戏——由调用方决定。
async function runChainOnce(tasker, entry, timeoutMs, { log }) {
    log('开始执行一条龙:', entry, `(超时 ${timeoutMs / 60000} 分钟)`)

    // 三段串行执行：任一段失败即返回 'failed'；全部完成返回 'success'。
    async function chain() {
        // ① 首账号：冷启动 → 跑到主界面就绪
        if (entry === CHAIN_ENTRY_FIRST) {
            log('段① 启动游戏 → 主界面 ...')
            const d1 = await tasker.post_task(CHAIN_ENTRY_FIRST, {}).wait().get()
            if (!d1 || d1.status !== 3000) return 'failed'
        }
        // ② 挂机领取(JS：读已挂机时长 → 动态加号 → 领取，完成后回主界面)
        //    'skip' = 已挂机<4h 本次不领(收益太少，退回主界面)，视为正常，继续跑盐罐。
        log('段② 挂机领取(JS 动态加钟) ...')
        const rg = await runGuaji(tasker, { log })
        if (rg !== 'success' && rg !== 'skip') return 'failed'
        // ③ 盐罐加时/领奖(pipeline，从主界面独立起跑，收尾回主界面)
        log('段③ 盐罐加时 ...')
        const d3 = await tasker.post_task(YANGUAN_ENTRY, {}).wait().get()
        if (!d3 || d3.status !== 3000) return 'failed'
        return 'success'
    }

    // 任务完成 vs 超时，赛跑
    let timer
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('__TIMEOUT__'), timeoutMs)
    })
    const result = await Promise.race([chain(), timeout])
    clearTimeout(timer)

    if (result === '__TIMEOUT__') {
        log(`⚠ 一条龙超时(${timeoutMs / 60000} 分钟未完成)，中止该账号流水线`)
        try {
            await tasker.post_stop().wait()
        } catch (e) {
            log('post_stop 异常:', e.message ?? e)
        }
        return 'timeout'
    }
    if (result === 'success') {
        log('✓ 一条龙完成')
        return 'success'
    }
    log('✗ 一条龙未成功')
    return 'failed'
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
