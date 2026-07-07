// 咸鱼之王「每日任务一键全完成」定时执行脚本
// 一条链：启动进主界面 -> 进任务页 -> 赠送/招募/点金/宝箱/黑市/竞技场(已完成的自动跳过)
//         -> 统一领取任务奖 + 周/日活跃全部领取
// 与 interface.json 的「咸鱼之王-每日任务一键全完成」task 完全一致(入口+override)。
//
// 单轮超时保护：每个账号各自限时 15 分钟，某账号超时(未拿到 status=3000)则中止该账号流水线，
// 尝试继续切下一个号；不关游戏(账号间/收尾都不关，仅开头冷启动前关一次)。
//
// 多账号：一轮内做完当前号 → 读标题关卡数去重 → 挑未做过的切换位切号 → 再做，最多 3 个
//   (复用 lib/switch_account.js + lib/account_rotation.js；无其它账号时只做 1 个，向后兼容)。
//
// 登录校验：设了环境变量 WECOM_KEY 时，每轮跑每日任务前先校验登录态(共享 lib/login_check.js)——
//   掉登录则调扫码工具出二维码发企微群、等人工扫码授权成功后再跑每日任务；授权超时则跳过本轮等下周期。
//   未设 WECOM_KEY 则跳过登录校验，直接跑每日任务(向后兼容)。
//
// 定时方式：每天在指定整点执行一次（传 8 = 每天 8:00，传 13 = 每天 13:00）。
//   脚本启动后先等到当天/次日最近的那个整点再首跑，之后每天同一整点循环。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   node scripts/daily_all.js                   # 默认设备 emulator-5554，每天 8:00 执行
//   node scripts/daily_all.js 16384             # 指定设备(name/address 包含匹配，如 MuMu 模拟器1)
//   node scripts/daily_all.js 16416 13          # 指定设备 + 每天执行的整点小时(0-23，默认8)
//   node scripts/daily_all.js 16384 8 once      # 立即只跑一次，不循环(忽略定时)
//   node scripts/daily_all.js 16384 8 once 15   # 第5参=每账号超时分钟数(默认15)
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
const { readTitleStage, readSwitchSlots, switchToAccount } = require('./lib/switch_account')
const { pickNextSlot } = require('./lib/account_rotation')
const { runDati } = require('./lib/dati')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const DAILY_HOUR = Number(process.argv[3] ?? 8) // 每天执行的整点小时(0-23，默认 8 点)
const ONCE = process.argv[4] === 'once' // 立即只跑一次（忽略定时）

const PACKAGE = 'com.hortor.games.xyzw' // 咸鱼之王包名（超时时强制关闭）
// 每账号超时：默认 15 分钟（新账号全任务真实执行较久），超时即中止该账号、不关游戏。第5参(分钟)可覆盖。
const RUN_TIMEOUT_MS = (Number(process.argv[5]) || 15) * 60 * 1000

// 「每日任务一键全完成」串联：入口 全日常_启动 + override 衔接各段
// （与 interface.json 的「咸鱼之王-每日任务一键全完成」task 一致）
const MAX_ACCOUNTS = 3 // 多开机器人实测最多 3 号轮换；实际做几个由"还能读到未访问切换位"决定
const ENTRY_FIRST = '全日常_启动' // 账号1：StartApp 冷启动进游戏
const ENTRY_NEXT = '全日常_开任务页' // 账号2+：切号后已在主界面，直接进任务页热接入
const OVERRIDE = {
    '赠送金币_完成': { next: ['全日常_复位1'] },
    '赠送金币_已完成跳过': { next: ['全日常_复位1'] }, // 赠送已完成走的是跳过出口，也要接复位
    '招募_完成': { next: ['全日常_复位2'] },
    '点金_完成': { next: ['全日常_复位3'] },
    '宝箱_完成': { next: ['全日常_复位4'] },
    '黑市_完成': { next: ['全日常_复位5'] },
    '竞技场_完成': { next: ['全日常_复位6'] },
    '每日任务_完成': { next: ['邮件_启动'] },   // 领奖完 -> 收邮件
    '邮件_完成': { next: ['充值_启动'] },        // 收完邮件 -> 领福利
    '充值_完成': { next: ['咸王_入口']},
    '咸王_完成': { next: ['钓鱼_入口']},
    '钓鱼_完成': { next: ['俱乐部_启动']},
    '俱乐部_完成': { next: ['珍宝阁_启动']},
}

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}

// 环形日志缓冲：每行日志除了打印，也存进来，失败/超时告警时取最近若干条随企微消息发出。
// 只留最近 LOG_BUFFER_MAX 条，避免长跑内存无限涨。
const LOG_BUFFER_MAX = 50
const logBuffer = []
const log = (...a) => {
    const line = `[${ts()}] [${TARGET}] ${a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')}`
    console.log(line)
    logBuffer.push(line)
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
}

// 账号 failed/timeout 时发企微告警：附最近 10 条执行日志。
// 复用 login_check 的 sendTextToWecom；未设 WECOM_KEY 则不发(向后兼容)。发送失败只记日志、不影响主流程。
const { ensureLoggedIn, sendTextToWecom, sendImageToWecom } = require('./lib/login_check')
async function alertFail(ctrl, reason) {
    const key = process.env.WECOM_KEY || ''
    if (!key) return
    const recent = logBuffer.slice(-10).join('\n')
    const text = `【咸鱼-每日任务-${TARGET}】${reason}\n最近日志：\n${recent}`
    try {
        await sendTextToWecom(key, text)
    } catch (e) {
        log('发送失败告警到企微出错(忽略):', e.message ?? e)
    }
    try {
        const shot = await ctrl.post_screencap().wait().get()
        if (shot) await sendImageToWecom(key, shot)
    } catch (e) {
        log('发送失败告警截图到企微出错(忽略):', e.message ?? e)
    }
}

// 跑一轮：每次新建连接/资源/tasker，跑完销毁，避免长时间持有句柄。
// 一轮内多账号轮转（做完一个号→切到未做过的号→再做，最多 MAX_ACCOUNTS 个）。
// 每账号各自超时：某账号超时(拿不到 status=3000)则中止该账号流水线、不关游戏，尝试继续切下个号。
// 关游戏仅在：开头冷启动前一次、以及登录掉线等不到扫码授权时；账号间与收尾都不关。
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

    // 节点级日志：每进入一个 pipeline 节点打印一行(便于观察长链执行进度、定位卡在哪个节点)。
    // add_context_sink 监听任务执行上下文通知；PipelineNode.Starting = 刚命中并进入某节点、准备执行其识别/动作。
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

    // 登录校验：掉登录态时走扫码授权流程；未设 WECOM_KEY 或本就已登录则直接放行。
    // 返回 false 表示掉登录且等不到扫码授权，调用方应放弃继续。
    async function checkLogin() {
        const WECOM_KEY = process.env.WECOM_KEY || ''
        if (!WECOM_KEY) {
            log('未设置 WECOM_KEY，跳过登录校验，直接跑每日任务')
            return true
        }
        const loginResult = await ensureLoggedIn(ctrl, tasker, { wecomKey: WECOM_KEY, target: TARGET, log })
        if (loginResult === 'timeout') {
            log('⚠ 检测到掉登录态但等不到扫码授权')
            return false
        }
        return true // 'authorized'(刚扫码登录) 或 'already'(本就已登录)
    }

    // 跑一个账号的每日任务，failed/timeout 时自动重试一次：重试从 killGame（强制关游戏重启）开始，
    // 重新走登录校验 + 冷启动入口(ENTRY_FIRST，因为killGame后不能再热接入)。
    // 两次都不成功才把最终结果报给调用方(由调用方决定是否 alertFail)。
    async function runAccountWithRetry(entry, i) {
        const r = await runDailyChain(tasker, entry, OVERRIDE, RUN_TIMEOUT_MS, { log })
        if (r !== 'failed' && r !== 'timeout') return r

        log(`⚠ 账号 ${i} 每日任务${r === 'timeout' ? '超时' : '失败'}，重试一次(先关游戏重启)...`)
        await killGame()
        if (!(await checkLogin())) {
            log('重试前登录校验未通过(掉登录且等不到授权)，放弃本次重试')
            return r
        }
        const r2 = await runDailyChain(tasker, ENTRY_FIRST, OVERRIDE, RUN_TIMEOUT_MS, { log })
        log(`账号 ${i} 重试结果: ${r2}`)
        return r2
    }

    await killGame()

    try {
        // 跑每日任务前先做登录校验：掉登录态时走扫码授权流程，授权成功后再跑每日任务。
        if (!(await checkLogin())) {
            log('跳过本轮每日任务，关游戏等下个周期')
            await killGame()
            return // finally 仍会 destroy ctrl/res/tasker
        }

        // ==== 多账号轮转：做完一个号 → 切到未做过的号 → 再做，最多 MAX_ACCOUNTS 个 ====
        // 用「已做过账号的关卡数集合」去重：每做完一个号读标题关卡数即"刚做完的账号"，
        // 再从切换位里挑第一个未访问的切过去。天然适配 1/2/3 号并自动终止。
        const visited = new Set()
        let entry = ENTRY_FIRST // 账号1冷启动，之后热接入
        for (let i = 1; i <= MAX_ACCOUNTS; i++) {
            log(`==== 账号 ${i}/${MAX_ACCOUNTS}：入口 ${entry} ====`)
            const r = await runAccountWithRetry(entry, i)
            log(`账号 ${i} 每日链结果: ${r}`)
            if (r === 'failed' || r === 'timeout') await alertFail(ctrl, `账号 ${i} 结果 ${r}(已重试)`)

            await runDatiIfMonday(ctrl, tasker, { log })
            await runNiudanIfWeekday(ctrl, tasker, { log })
            await runMengjingIfWeekday(ctrl, tasker, { log })

            // 链尾(钓鱼_完成)会自动回主界面，读顶部标题关卡数标识"刚做完的账号"
            const cur = await readTitleStage(ctrl, tasker)
            if (cur == null) {
                log('⚠ 读不到标题关卡数(可能未回到主界面/超时卡住)，停止多账号轮转')
                await alertFail(ctrl, `账号 ${i} 读不到标题关卡数，可能未回到主界面/超时卡住`)
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
            entry = ENTRY_NEXT
        }
        // 收尾不关游戏，留前台(下轮开头 killGame 会清干净)
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
}

// 跑一个账号的每日全链，带独立超时。返回 'success' | 'timeout' | 'failed'。
// 超时：中止该账号流水线(post_stop)。本函数不关游戏——账号间/收尾是否关由调用方决定。
async function runDailyChain(tasker, entry, override, timeoutMs, { log }) {
    log('开始执行每日任务一键全完成:', entry, `(超时 ${timeoutMs / 60000} 分钟)`)
    const job = tasker.post_task(entry, override)

    // 任务完成 vs 超时，赛跑
    let timer
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('__TIMEOUT__'), timeoutMs)
    })
    const detail = await Promise.race([job.wait().get(), timeout])
    clearTimeout(timer)

    if (detail === '__TIMEOUT__') {
        log(`⚠ 每日任务超时(${timeoutMs / 60000} 分钟未完成)，中止该账号流水线`)
        try {
            await tasker.post_stop().wait() // 中止 tasker 当前流水线
        } catch (e) {
            log('post_stop 异常:', e.message ?? e)
        }
        return 'timeout'
    }
    if (detail && detail.status === 3000) {
        log('✓ 每日任务完成 status=', detail.status, 'nodes=', detail.nodes.length)
        return 'success'
    }
    log('✗ 每日任务未成功 status=', detail && detail.status, 'nodes=', detail && detail.nodes.length)
    return 'failed'
}

// 「咸鱼大冲关」答题：题库提示该活动每周任务周一8点重置，只在周一跑。
// 导航(答题_启动)+答题循环(runDati)+关结算弹窗(答题_确定)，跟 scripts/dati.js 独立脚本同一套流程，
// 这里复用同一个 ctrl/tasker（当前账号已在主界面）。失败/超时用当天剩余次数重试(实测上限3次)，
// 中途成功就提前停止。任何一步异常都只记日志、不向上抛，避免影响账号轮转继续往下走。
async function runDatiIfMonday(ctrl, tasker, { log }) {
    if (new Date().getDay() !== 1) return
    log('今天是周一，跑「咸鱼大冲关」答题 ...')
    try {
        const dEnter = await tasker.post_task('答题_启动').wait().get()
        if (!dEnter || dEnter.status !== 3000) {
            log('✗ 未能进入答题页(是否在主界面？)，跳过答题')
            return
        }
        const MAX_ATTEMPTS = 3
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            log(`==== 答题第 ${attempt}/${MAX_ATTEMPTS} 次尝试 ====`)
            const r = await runDati(ctrl, tasker, { log })
            log('本局结束:', JSON.stringify(r))

            const dEnd = await tasker.post_task('答题_确定').wait().get()
            log('点击「确定」结束答题页:', dEnd?.status === 3000 ? '成功' : '失败')

            if (r.result === 'success') {
                log('✅ 答题成功完成')
                const dRece = await tasker.post_task('答题_任务').wait().get()
                log('点击「领取奖励」:', dRece?.status === 3000 ? '成功' : '失败')
                break
            }
            if (attempt === MAX_ATTEMPTS) log('已用完重试次数，停止答题')
        }

        // 退出答题页回主界面，后续账号轮转要靠主界面顶部标题读关卡数，不能停在答题活动页。
        const dExit = await tasker.post_task('答题_返回').wait().get()
        log('退出答题页回主界面:', dExit?.status === 3000 ? '成功' : '失败')
    } catch (e) {
        log('答题流程出错(忽略，继续后续流程):', e.message ?? e)
    }
}

// 「扭蛋工坊」免费领取：只在周二/四/六开放，直接跑一次，失败/异常只记日志不重试(与其他子流程一致)。
async function runNiudanIfWeekday(ctrl, tasker, { log }) {
    if (![2, 4, 6].includes(new Date().getDay())) return
    log('今天是周二/四/六，跑「扭蛋」...')
    try {
        const r = await tasker.post_task('扭蛋_启动').wait().get()
        log('扭蛋流程结束:', r?.status === 3000 ? '成功' : `未成功 status=${r && r.status}`)
    } catch (e) {
        log('扭蛋流程出错(忽略，继续后续流程):', e.message ?? e)
    }
}

// 「咸王梦境」商人驿站购买：只在周一/三开放，直接跑一次，失败/异常只记日志不重试(与其他子流程一致)。
async function runMengjingIfWeekday(ctrl, tasker, { log }) {
    if (![1, 3].includes(new Date().getDay())) return
    log('今天是周一/三，跑「梦境」...')
    try {
        const r = await tasker.post_task('梦境_入口').wait().get()
        log('梦境流程结束:', r?.status === 3000 ? '成功' : `未成功 status=${r && r.status}`)
    } catch (e) {
        log('梦境流程出错(忽略，继续后续流程):', e.message ?? e)
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 计算从现在到「下一个 DAILY_HOUR 整点」的下一个执行时刻：
// 取今天的 DAILY_HOUR:00:00，若已过则顺延到明天同一时刻。
function nextRunTime() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(DAILY_HOUR, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next
}

;(async () => {
    if (ONCE) {
        log('==== 咸鱼每日任务一键全完成 定时脚本启动 ====', `设备=${TARGET}`, '(立即只跑一次)')
        log('资源目录:', RESOURCE)
        try {
            await runOnce()
        } catch (e) {
            log('本轮执行出错:', e.message ?? e)
        }
        log('单次模式，结束。')
        return
    }

    log('==== 咸鱼每日任务一键全完成 定时脚本启动 ====', `设备=${TARGET}`, `(每天 ${DAILY_HOUR}:00 执行)`)
    log('资源目录:', RESOURCE)
    while (true) {
        const next = nextRunTime()
        const waitMs = next.getTime() - Date.now()
        log(`下一次执行时间: ${next.toLocaleString('zh-CN', { hour12: false })}（${(waitMs / 3600000).toFixed(1)} 小时后）`)
        await sleep(waitMs)
        try {
            await runOnce()
        } catch (e) {
            log('本轮执行出错（不中断循环）:', e.message ?? e)
        }
    }
})().catch((e) => {
    log('致命错误:', e)
    process.exit(1)
})
