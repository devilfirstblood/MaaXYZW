// 挂机领取共享模块 —— 按已挂机时长动态加钟助力后领取
//
// 供 daily_chain.js 等编排脚本复用（也被独立脚本 scripts/guaji.js 调用）。
// 与 login_check.js / switch_account.js 一样：不建/销毁连接、不读 process.argv，
// 连接与 tasker 生命周期由调用方管，识别 + 动作用临时节点驱动（720 缩放系）。
//
// 主流程 runGuaji(tasker, opts)：
//   1. 主界面点挂机入口（文字随状态变：奖励已满 / 倒计时 hh:mm:ss，两种都照常进）
//   2. 进挂机奖励弹窗页，全屏 OCR「你已挂机 hh:mm:ss」→ 解析已挂机小时数 t
//   3. 已挂机 < 4h：收益太少，本次不领(不加钟、不领取)，按返回键退出弹窗页回主界面，返回 'skip'。
//   4. ≥4h 按区间阶梯算「点几个好友助力加号」N：
//        4h ≤ t < 6h → 3 个（加号 x = 174, 286, 400）
//        6h ≤ t < 8h → 2 个（加号 x = 174, 286）
//        t ≥ 8h      → 1 个（加号 x = 174）
//      （加号从左往右取前 N 个；读不到时长则保守按 0 个处理，只领取不加钟）
//   5. N>0 时：点「前往加钟」→ 依次点前 N 个加号 → 点 X 关加钟弹窗，回奖励页
//   6. 点「领取」领收益 → 若弹「等级仍可提升，确定要领取吗」二次确认框则点「确定」(没弹也无妨)
//      → 点空白关「恭喜获得」弹窗 → 回主界面完成
//
// 前置：游戏已在主界面（底部「战斗」Tab）。返回 'success'(已领) / 'skip'(<4h 未领) / 'failed'。

// ==== 坐标 / ROI（720 缩放系，须与 interface.json display_short_side=720 一致）====
const ENTRY_ROI = [0, 450, 130, 80] // 挂机入口按钮（竞技大厅上方，文字随状态变）
const ENTRY_TARGET = [64, 489, 1, 1]
const PLUS_XS = [174, 286, 400, 514] // 好友助力加号：一排四个，从左到右
const PLUS_Y = 505
const CLOSE_JIAZHONG = [365, 932, 1, 1] // 关加钟弹窗的红色 X
const LINGQU_ROI = [160, 940, 160, 80] // 底部「挂机奖励/领取」按钮区域
const REWARD_ROI = [0, 0, 720, 1280] // 「恭喜获得」奖励弹窗全屏识别(也用于领取二次确认框「确定」按钮识别)
const REWARD_BLANK = [360, 200, 1, 1]
const TOP_BLANK = [360, 64, 1, 1] // 顶部空白遮罩区(<4h 时点此关挂机弹窗回主界面，同 demo「咸鱼_点空白关弹窗」)

// 已挂机时长文本「你已挂机 hh:mm:ss」→ 小时数（含分秒小数，如 5:23:00 → 5.383）。抽不到返回 null。
function parseIdleHours(text) {
    if (!text) return null
    const m = String(text).match(/(\d{1,2}):(\d{2}):(\d{2})/)
    if (!m) return null
    return Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600
}

// 已挂机小时数 → 点几个加号（区间阶梯）。
function plusCountByHours(hours) {
    if (hours < 4) return 0
    if (hours < 6) return 3
    if (hours < 8) return 2
    return 1
}

// 跑一个临时节点（识别 + 动作），返回 tasker 任务 detail。
async function runNode(tasker, name, node) {
    return await tasker.post_task(name, { [name]: node }).wait().get()
}

// OCR 通配，返回命中 box 列表 [{text, box:[x,y,w,h], score}, ...]（未命中返回 []）。不传 roi 则全屏识别。
async function ocrAll(tasker, expected, roi) {
    const node = { recognition: 'OCR', expected }
    if (roi) node.roi = roi
    const d = await runNode(tasker, 'TMP_GUAJI_OCR', node)
    if (!d || !d.nodes || !d.nodes.length) return []
    const nd = tasker.node_detail(d.nodes[0])
    return nd?.reco?.detail?.all || []
}

// 在指定 720 系坐标点击。
async function clickAt(tasker, target, postDelay = 500) {
    await runNode(tasker, 'TMP_GUAJI_CLICK', { action: 'Click', target, post_delay: postDelay })
}

// 读弹窗页「你已挂机 hh:mm:ss」→ 小时数；读不到返回 null。全屏 OCR，不设 roi。
async function readIdleHours(tasker, log) {
    const boxes = await ocrAll(tasker, '\\d{1,2}:\\d{2}:\\d{2}')
    if (boxes.length) log('  OCR 命中(挂机时长区):', boxes.map((b) => `"${b.text}"@[${b.box}]`).join(' '))
    for (const b of boxes) {
        const h = parseIdleHours(b.text)
        if (h != null) return h
    }
    return null
}

// 挂机领取主流程（含动态加钟）。前置：已在主界面。opts.log 为日志函数（缺省 console.log）。
async function runGuaji(tasker, opts = {}) {
    const log = opts.log || ((...a) => console.log(...a))

    // 1. 点挂机入口进奖励弹窗页
    log('点挂机入口 ...')
    const dEnter = await runNode(tasker, 'TMP_GUAJI_ENTER', {
        recognition: 'OCR',
        expected: '奖励已满|\\d\\d:\\d\\d:\\d\\d',
        roi: ENTRY_ROI,
        action: 'Click',
        target: ENTRY_TARGET,
        post_delay: 3500,
    })
    if (!dEnter || dEnter.status !== 3000) {
        log('✗ 未识别到挂机入口（是否在主界面？）')
        return 'failed'
    }

    // 2. 读已挂机时长 → 算加号数
    const hours = await readIdleHours(tasker, log)
    // 已挂机 < 4 小时：收益太少，本次不领(不加钟、不领取)，退出弹窗页回主界面等下次再领。
    // 点顶部空白遮罩区关弹窗(咸鱼弹窗均支持点弹窗外遮罩关闭)，坐标同 xyzw_demo「咸鱼_点空白关弹窗」。
    if (hours != null && hours < 4) {
        log(`已挂机 ${hours.toFixed(2)} 小时(<4h)，本次跳过不领，点顶部空白关弹窗回主界面等下次`)
        await clickAt(tasker, TOP_BLANK, 1500)
        return 'skip'
    }
    const N = hours == null ? 0 : plusCountByHours(hours)
    if (hours == null) log('⚠ 读不到「你已挂机」时长，保守按 0 个加号处理（只领取不加钟）')
    else log(`已挂机 ${hours.toFixed(2)} 小时 → 点 ${N} 个加号`)

    // 3. N>0：前往加钟 → 点前 N 个加号 → 关加钟
    if (N > 0) {
        log('点「前往加钟」...')
        const dJz = await runNode(tasker, 'TMP_GUAJI_JIAZHONG', {
            recognition: 'OCR',
            expected: '前往加钟|加钟',
            action: 'Click',
            target_offset: [5, 5, 1, 1],
            post_delay: 2500,
        })
        if (!dJz || dJz.status !== 3000) {
            log('⚠ 未识别到「前往加钟」（加钟次数可能已用完），跳过加号直接领取')
        } else {
            for (let i = 0; i < N; i++) {
                log(`  点加号 ${i + 1}/${N} @x=${PLUS_XS[i]}`)
                await clickAt(tasker, [PLUS_XS[i], PLUS_Y, 1, 1], 700)
            }
            log('关加钟弹窗 ...')
            await clickAt(tasker, CLOSE_JIAZHONG, 1800)
        }
    }

    // 4. 领取收益
    log('点「领取」...')
    const dLq = await runNode(tasker, 'TMP_GUAJI_LINGQU', {
        recognition: 'OCR',
        expected: '领取',
        roi: LINGQU_ROI,
        action: 'Click',
        post_delay: 2500,
    })
    if (!dLq || dLq.status !== 3000) {
        log('✗ 未识别到「领取」按钮')
        return 'failed'
    }

    // 5. 挂机奖励等级仍可提升时，领取后会先弹「系统提示：确定要领取挂机奖励吗？」二次确认框，
    //    弹了点「确定」继续；没弹此 node 就是 OCR 未命中，直接空过不影响流程(与下面关奖励弹窗同一手法)。
    log('检测「挂机奖励等级仍可以提升」二次确认框(没弹也无妨) ...')
    await runNode(tasker, 'TMP_GUAJI_LEVELUP_CONFIRM', {
        recognition: 'OCR',
        expected: '^确定$',
        roi: REWARD_ROI,
        action: 'Click',
        post_delay: 1500,
    })

    // 6. 关「恭喜获得」奖励弹窗（没弹也无妨）
    await runNode(tasker, 'TMP_GUAJI_CLOSE_REWARD', {
        recognition: 'OCR',
        expected: '恭喜获得|点击任意区域',
        roi: REWARD_ROI,
        action: 'Click',
        target: REWARD_BLANK,
        post_delay: 1200,
    })

    log('✓ 挂机领取完成')
    return 'success'
}

module.exports = { runGuaji, plusCountByHours, parseIdleHours }
