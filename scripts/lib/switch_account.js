// 咸鱼之王「多开机器人切换账号」共享模块
//
// 多开机器人功能：主界面顶部标题(第XXXX关)是当前账号，标题左右各有一个切换位头像，
//   显示另外两个账号当前的关卡数。点某个切换位头像即切到那个账号（轮换：当前账号会被换到切换位上）。
//   实测最多 3 个账号轮换。
//
// 本模块只提供「读关卡数 / 读切换位 / 切到某切换位并验证」三个原子能力，
//   不建/销毁 ctrl/tasker、不读 process.argv —— 连接生命周期与多账号编排由调用方(daily_all.js)管理。
//
// 与 assets/resource/pipeline/xyzw_switch_account.json 配合：切号动作(点头像+关弹窗+回主界面)走 pipeline，
//   切到哪个号、是否轮换重复、是否切成功由本模块用 OCR 标题关卡数判定。
//
// 坐标基于 720 缩放系（须与 interface.json display_short_side=720 一致）。

const ENTRY = '切号_点头像' // 切号 pipeline 入口（assets/resource/pipeline/xyzw_switch_account.json）

// 标题关卡数 OCR 区域：屏幕顶部中间「第XXXX关」大字（720 缩放系）。
const TITLE_ROI = [240, 165, 240, 40]
// 两个切换位头像下方关卡数文字所在大区（同时覆盖左、右两个「第XXXX关」小字）。
const SLOT_ROI = [150, 240, 420, 50]
// 两个切换位头像的点击坐标（头像本体中心，关弹窗前的可点热区）。
const LEFT_SLOT = [208, 228, 1, 1]
const RIGHT_SLOT = [505, 228, 1, 1]
// 按 x 坐标把切换位关卡数文字归到左/右：左头像文字 x<360，右头像 x>=360。
const SPLIT_X = 360

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 从一段文本里抽「第XXXX关」的关卡数字；抽不到返回 null。
function parseStage(text) {
    if (!text) return null
    // OCR 偶尔把"关"识别成"天"等，故只要「第+数字」即可
    const m = String(text).match(/第\s*([0-9]{2,6})/)
    return m ? Number(m[1]) : null
}

// 在指定 roi 内 OCR 通配，返回命中 box 列表 [{text, box:[x,y,w,h], score}]。
async function ocrAll(ctrl, tasker, roi, expected = '第.*') {
    const img = await ctrl.post_screencap().wait().get()
    const node = 'TMP_SWITCH_OCR'
    const ov = { [node]: { recognition: 'OCR', expected, roi } }
    const d = await tasker.post_task(node, ov).wait().get()
    if (!d || !d.nodes || !d.nodes.length) return []
    const nd = tasker.node_detail(d.nodes[0])
    return nd?.reco?.detail?.all || []
}

// 读当前账号标题关卡数（如 9703）；读不到返回 null。
// 注意 expected 用 '第.*' 不带"关"：OCR 偶尔把标题的"关"识别成"天"(如"第9704天")，
// 带"关"会匹配失败；parseStage 只认"第+数字"，故这里也只要"第"打头即可。
async function readTitleStage(ctrl, tasker) {
    const all = await ocrAll(ctrl, tasker, TITLE_ROI, '第.*')
    for (const b of all) {
        const s = parseStage(b.text)
        if (s != null) return s
    }
    return null
}

// 读两个切换位（左/右头像）的关卡数与点击坐标（单次 OCR）。
// 返回 [{ side:'left'|'right', stage:Number, target:[x,y,w,h] }, ...]（只含 OCR 出关卡数的位）。
async function readSwitchSlotsOnce(ctrl, tasker) {
    const all = await ocrAll(ctrl, tasker, SLOT_ROI, '第.*')
    const slots = []
    for (const b of all) {
        const stage = parseStage(b.text)
        if (stage == null) continue
        const cx = b.box[0] + b.box[2] / 2
        if (cx < SPLIT_X) slots.push({ side: 'left', stage, target: LEFT_SLOT })
        else slots.push({ side: 'right', stage, target: RIGHT_SLOT })
    }
    // 去重：同一侧 OCR 可能多行命中，保留每侧第一个
    const seen = new Set()
    return slots.filter((s) => (seen.has(s.side) ? false : (seen.add(s.side), true)))
}

// 读两个切换位，带稳定性重试。
// 切号轮换后画面可能还没稳定，单次 OCR 常只读到一侧（另一侧关卡数漏识别），
// 若直接据此判「无未做位」会提前终止轮转、漏做账号（曾出现做完 2 号就停、第 3 号没切）。
// 故读到 1 个位时要求重读到 expectCount(默认2)个才算稳定，不足则等待重读，最多 retries+1 次；
// 到最后仍不足就返回读到最多的那次。
//
// 读到 0 个位则直接返回、不重试：切换位区域完全没号 = 单账号（没有其它号可切），
// 死等只会每轮白白浪费 retries*gapMs。代价是「多账号但某次两侧同时漏读(读到0个)」会被误当单账号，
// 但两侧同时漏读远比漏读一侧罕见（实测漏号故障都是读到1个、漏第3个号），此权衡换单账号不空等。
// opts: { retries=3, gapMs=1500, expectCount=2, log=console.log }
async function readSwitchSlots(ctrl, tasker, opts = {}) {
    const { retries = 3, gapMs = 1500, expectCount = 2, log = console.log } = opts
    let best = []
    for (let i = 0; i <= retries; i++) {
        const slots = await readSwitchSlotsOnce(ctrl, tasker)
        if (slots.length > best.length) best = slots
        if (slots.length >= expectCount) return slots
        if (slots.length === 0) return slots // 一个位都没有 = 单账号，不重试直接返回
        if (i < retries) {
            log(`  读切换位(第${i + 1}次): 仅读到 ${slots.length} 个位(期望 ${expectCount})，等待重读 ...`)
            await sleep(gapMs)
        }
    }
    log(`  读切换位重试结束，最终读到 ${best.length} 个位`)
    return best
}

// 切到指定切换位：跑切号 pipeline 点该位头像 + 关弹窗 + 回主界面，
//   再 OCR 标题验证关卡数已变成该位的 expectStage。
// slot: { target:[x,y,w,h], stage }（来自 readSwitchSlots）
// opts: { log=console.log, verifyRetries=3, verifyGapMs=2000 }
// 返回: true(切号成功且标题=expectStage) | false(pipeline 失败或标题没切过去)
async function switchToAccount(ctrl, tasker, slot, opts = {}) {
    const { log = console.log, verifyRetries = 3, verifyGapMs = 2000 } = opts
    const expectStage = slot.stage

    log(`切号：点${slot.side === 'left' ? '左' : '右'}切换位头像 -> 目标账号 第${expectStage}关`)
    const ov = { [ENTRY]: { target: slot.target } }
    const detail = await tasker.post_task(ENTRY, ov).wait().get()
    if (!detail || detail.status !== 3000) {
        log(`✗ 切号 pipeline 未成功 status=${detail && detail.status}`)
        return false
    }

    // 验证标题关卡数已切到目标号（切号+关弹窗后画面可能还在稳定，重试几次）
    for (let i = 0; i < verifyRetries; i++) {
        const cur = await readTitleStage(ctrl, tasker)
        if (cur === expectStage) {
            log(`✓ 切号成功，当前账号 第${cur}关`)
            return true
        }
        log(`  验证标题(第${i + 1}次): 当前第${cur}关，期望第${expectStage}关，等待 ...`)
        await sleep(verifyGapMs)
    }
    log(`✗ 切号后标题未变到 第${expectStage}关，判定切号失败`)
    return false
}

module.exports = { readTitleStage, readSwitchSlots, switchToAccount, ENTRY }
