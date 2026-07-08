// 咸鱼之王「咸鱼大冲关」答题独立脚本
//
// 薄壳：建连接 → 跑 xyzw_dati.json 的「答题_启动」导航进答题页 → 调 scripts/lib/dati.js 的 runDati → 销毁。
// 核心逻辑/坐标见 lib；导航(主界面 -> 客厅 -> 答题入口)见 assets/resource/pipeline/xyzw_dati.json。
// 前置：游戏在主界面（底部「战斗」Tab），剩余次数>0。
//
// ★ lib/dati.js 里的「对/错」按钮坐标是根据一张截图估算的，尚未经实机点击校准。
//   建议先用 --dry-run 跑：脚本不会点击任何按钮(含「开始答题」)，只截图识别题目+查题库打印
//   "识别到什么题、匹配到题库哪条、会点哪个按钮"，你自己手动点「开始答题」和「对/错」，
//   拿日志核对识别/匹配是否准确、坐标估算是否合理，不消耗真实点击。确认没问题后去掉 --dry-run 正式跑。
//
// 用法（在项目根目录运行）：
//   node scripts/dati.js --dry-run                    # 默认设备 emulator-5554，只观察不点击
//   node scripts/dati.js                               # 默认设备 emulator-5554，正式跑一局
//   node scripts/dati.js 127.0.0.1:16416 --dry-run     # 指定 adb 设备地址 + 空跑

const os = require('os')
const path = require('path')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

const { runDati } = require('./lib/dati')

const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const TARGET = args.find((a) => !a.startsWith('--')) || 'emulator-5554'

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, ...a)

;(async () => {
    log('==== 咸鱼大冲关答题脚本启动 ====', `设备=${TARGET}`, DRY_RUN ? '(dry-run，不点击)' : '(正式跑)')
    log('资源目录:', RESOURCE)

    const devices = await maa.AdbController.find()
    if (!devices) throw new Error('未发现任何 adb 设备')
    const dev = devices.find((d) => d[0].includes(TARGET) || d[2].includes(TARGET)) ?? devices[0]
    const [name, adb_path, address, scr, inp, config] = dev
    log('使用设备:', name, address)

    const useFindScr = process.env.USE_FIND_SCR === '1'
    const ctrl = new maa.AdbController(adb_path, address, useFindScr ? scr : '4', inp, useFindScr ? config : '{}')
    ctrl.screenshot_target_short_side = 720
    if (!(await ctrl.post_connection().wait().succeeded)) throw new Error('设备连接失败')

    const res = new maa.Resource()
    if (!(await res.post_bundle(RESOURCE).wait().succeeded)) throw new Error('资源加载失败')

    const tasker = new maa.Tasker()
    tasker.resource = res
    tasker.controller = ctrl

    // 失败(被淘汰)/超时都可能只是运气差或识别没跟上，答题次数当天有限(实测上限3次)，
    // 值得自动用剩下的次数重开一局再试；dry-run 模式不碰按钮，只跑一次观察。
    const MAX_ATTEMPTS = DRY_RUN ? 1 : 3

    try {
        if (DRY_RUN) {
            log('dry-run 模式：不会自动导航进入答题页，请自己在设备上操作')
        } else {
            log('导航进入「咸鱼大冲关」答题页 ...')
            const dEnter = await tasker.post_task('答题_启动').wait().get()
            if (!dEnter || dEnter.status !== 3000) {
                log('✗ 未能进入答题页(是否在主界面？)，退出')
                return
            }
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (MAX_ATTEMPTS > 1) log(`==== 第 ${attempt}/${MAX_ATTEMPTS} 次尝试 ====`)
            const r = await runDati(ctrl, tasker, { log, dryRun: DRY_RUN })
            log('本局结束:', JSON.stringify(r))

            if (r.result === 'success') log('✅ 答题成功完成')
            else if (r.result === 'fail') log(`❌ 答题失败${MAX_ATTEMPTS > 1 ? `(第 ${attempt}/${MAX_ATTEMPTS} 次)` : ''}`)
            else log('⚠ 超时退出，可能是题目识别/题库匹配不准确导致一直没点到「对/错」按钮')

            if (!DRY_RUN) {
                const dEnd = await tasker.post_task('答题_确定').wait().get()
                log('点击「确定」结束答题页:', dEnd?.status === 3000 ? '成功' : '失败')
            }

            if (r.result === 'success'){
                const dRece = await tasker.post_task('答题_任务').wait().get()
                log('点击「领取奖励」:', dRece?.status === 3000 ? '成功' : '失败')
                break
            } 
            if (attempt === MAX_ATTEMPTS && MAX_ATTEMPTS > 1) log('已用完重试次数，停止。')
        }

        const dEnd = await tasker.post_task('答题_返回').wait().get()
        log('返回主界面:', dEnd?.status === 3000 ? '成功' : '失败')
    } finally {
        tasker.destroy()
        res.destroy()
        ctrl.destroy()
    }
    log('结束。')
})().catch((e) => {
    log('致命错误:', e)
    process.exit(1)
})
