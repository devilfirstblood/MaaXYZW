// 咸鱼之王「咸鱼大冲关」答题共享模块 —— OCR 识别题目文字，查题库判断对/错并点击对应按钮
//
// 前置：游戏已进入「咸鱼大冲关」活动页（「开始答题」按钮可见，剩余次数>0）。
// 玩法：点「开始答题」匹配进一场实时淘汰赛，题目逐题出现，每题倒计时约 5 秒后结算对错，
//   答错即被淘汰、弹出结算页。本模块每轮快速截图+全屏 OCR，从题库(scripts/db/tiku.json)
//   里找最接近的题目 -> 点绿色「✓对」(左)或红色「✗错」(右)按钮，直到识别到结算/结束关键字为止。
//
// 与 login_check.js / switch_account.js 一样：不建/销毁 ctrl/tasker、不读 process.argv，
// 连接生命周期由调用方管。
//
// ★ 坐标是根据一张实机截图估算换算到 720 缩放系的，尚未经实机点击校准，
//   若点不中「对/错」按钮，需用户实测调整 TRUE_BTN / FALSE_BTN。

const fs = require('fs')
const path = require('path')

const TIKU_PATH = path.join(__dirname, '..', 'db', 'tiku.json')
const ENTRY_TEXT = '开始答题'

// ---- 坐标（720 缩放系，估算值，未经实机校准）----
const TRUE_BTN = [176, 1011, 1, 1] // 绿色「✓对」按钮，左
const FALSE_BTN = [526, 1011, 1, 1] // 红色「✗错」按钮，右
const QUESTION_Y_MAX = 320 // 题目文字所在顶部横幅区域的 y 上限，用来从全屏 OCR 结果里筛出题目文本
const SUCCESS_KEYWORDS = /也要做最咸的那条/
const FAIL_KEYWORDS = /下次一定翻身/
// 顶部横幅区域内会混入的非题目文字：右上角版本号「258080793|xxxx|a3a4|28」(含"|")、
// 金币/资源计数「100/100」这类分数格式——拼进题干里会让匹配全盘跑偏(实测 score 直接归零)，需要排除。
const NOISE_PATTERN = /\||^\d+\/\d+$/

// 归一化：去掉常见中英文标点/空白，只留下用于比对的正文字符。
function normalize(text) {
    return String(text || '').replace(/[《》「」“”"''‘’?？!！，,、；;：:.。\s]/g, '')
}

// 720 缩放系下"同一行"允许的 y 中心最大差值(经验值)。
const LINE_Y_TOLERANCE = 20

// 把 OCR 命中框按阅读顺序(先按行分组、行内按 x 从左到右)排好。
// 不能直接全局按 y 排序：同一行内不同文字框(比如带书名号/引号的片段)的 y 坐标常有几像素抖动，
// 并不严格相等，会被 y 的微小差异拆散、排出错误顺序(实测"「招募」无法"和"《咸鱼之王》中，"就被拼反过)。
// 这里先把 y 中心相近(差值在 LINE_Y_TOLERANCE 内)的框聚成同一行，行内再按 x 排序，行与行之间按 y 排序。
function sortReadingOrder(boxes) {
    const sorted = [...boxes].sort((a, b) => a.box[1] - b.box[1])
    const lines = []
    for (const box of sorted) {
        const yCenter = box.box[1] + box.box[3] / 2
        const line = lines.find((l) => Math.abs(l.y - yCenter) <= LINE_Y_TOLERANCE)
        if (line) {
            line.boxes.push(box)
            line.y = (line.y * (line.boxes.length - 1) + yCenter) / line.boxes.length
        } else {
            lines.push({ y: yCenter, boxes: [box] })
        }
    }
    lines.sort((a, b) => a.y - b.y)
    return lines.flatMap((line) => line.boxes.sort((a, b) => a.box[0] - b.box[0]))
}

// 题目结算瞬间的特效动画偶尔会被 OCR 认成结尾一串大写字母乱码(实测如 "KAAAAAK"/"ZAAAAAZ"，
// 特征是同一个字母连续重复3次以上——题库里真正含大写字母的题("...BOSS。""...NPC名字...")都不会这样连续重复，
// 可以放心用这个特征把噪声切掉，避免拖累匹配分数导致本来能识别的题目被判成"未找到可信匹配"。
function stripOcrNoise(text) {
    return String(text || '').replace(/[A-Z]*([A-Z])\1{2,}[A-Z]*$/, '')
}

// Levenshtein 编辑距离。
function editDistance(a, b) {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = new Array(n + 1)
    for (let j = 0; j <= n; j++) dp[j] = j
    for (let i = 1; i <= m; i++) {
        let prev = dp[0]
        dp[0] = i
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j]
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
            prev = tmp
        }
    }
    return dp[n]
}

// 加载题库(scripts/db/tiku.json，{question, answer} 结构)，附带预计算的归一化文本。
function loadTiku() {
    const raw = JSON.parse(fs.readFileSync(TIKU_PATH, 'utf-8'))
    return raw.map((q) => ({ ...q, norm: normalize(q.question) }))
}

// 在题库里找与 OCR 文本最接近的题目。返回 { entry, score }(score 0~1，1 为完全一致)；ocrText 为空返回 null。
function findAnswer(ocrText, tikuList) {
    const norm = normalize(ocrText)
    if (!norm) return null
    let best = null
    for (const q of tikuList) {
        const dist = editDistance(norm, q.norm)
        const score = 1 - dist / Math.max(norm.length, q.norm.length, 1)
        if (!best || score > best.score) best = { entry: q, score }
    }
    return best
}

async function runNode(tasker, name, node) {
    return await tasker.post_task(name, { [name]: node }).wait().get()
}

async function clickAt(tasker, target, postDelay = 200) {
    await runNode(tasker, 'TMP_DATI_CLICK', { action: 'Click', target, post_delay: postDelay })
}

// 把 720 缩放系坐标格式化成日志好读的形式，如 [176,1011]。
function fmtTarget(target) {
    return `[${target[0]},${target[1]}]`
}

// 对传入的 image(ArrayBuffer) 做全屏 OCR，返回命中框列表 [{text, box:[x,y,w,h], score}]。
async function ocrAll(tasker, image) {
    const d = await tasker
        .post_recognition('OCR', { expected: '.+', roi: [0, 0, 720, 1280] }, image)
        .wait()
        .get()
    if (!d || !d.nodes || !d.nodes.length) return []
    const nd = tasker.node_detail(d.nodes[0])
    return nd?.reco?.detail?.all || []
}

// 若在「开始答题」入口页则点击进入。返回 true(已点击)/false(未识别到，可能已在题目中)。
async function ensureStarted(tasker) {
    const d = await runNode(tasker, 'TMP_DATI_START', {
        recognition: 'OCR',
        expected: ENTRY_TEXT,
        action: 'Click',
        post_delay: 300,
    })
    return !!(d && d.status === 3000)
}

// 答题主循环。ctrl/tasker 由调用方建好、已连接。
// opts: { log, tikuList(缺省从 tiku.json 读), matchThreshold=0.75, pollMs=500, timeoutMs=60000, dryRun=false }
//   dryRun=true 时不点击任何按钮(含「开始答题」)，只截图识别+查题库打印会点哪个按钮 —— 用来在
//   坐标未经校准/不想消耗答题次数时，先验证 OCR 识别题目、题库匹配是否准确。
// 返回: { result: 'ended'|'timeout', answered: number }
async function runDati(ctrl, tasker, opts = {}) {
    const { log = console.log, matchThreshold = 0.8, pollMs = 500, timeoutMs = 150000, dryRun = false } = opts
    const tikuList = opts.tikuList || loadTiku()
    log(`题库已加载 ${tikuList.length} 题`)
    if (dryRun) log('⚠ dry-run 模式：不会点击任何按钮(含「开始答题」)，需要你自己在设备上操作进入答题页')

    if (!dryRun) await ensureStarted(tasker)

    // 点了「对/错」后要等倒计时结束才会换下一题，同一题在倒计时期间会被反复截图识别，
    // OCR 结果并非每次都完全一致(实测同一段文字连续几帧会有个别字抖动，题目刚出现的第一帧还可能没渲染完整
    // 就被截到，识别出截断的题干)。
    // “是否还是上一题”不能靠比较原始 OCR 文本(抖动幅度和题库里近似题的差异幅度可能重叠，阈值不好选)，
    // 而是比较查到题库后命中的具体是哪一条——只要抖动后仍命中同一条题库题就算同一题、跳过不重复点击；
    // 一旦命中变成另一条(哪怕文字很像)，就当新题处理，不会漏答近似题。
    //
    // 命中就立即点击，不等二次确认：倒计时结束前最后一次点击才生效，就算第一次是截断文本蒙对/蒙错了，
    // 后面识别到更完整的文本、判断出是不同题库条目时还会再点一次纠正过来，多点一次无妨，最终结果仍是对的。
    let lastAnsweredQuestion = null
    let answered = 0
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        const image = await ctrl.post_screencap().wait().get()
        const all = await ocrAll(tasker, image)
        const texts = all.map((b) => b.text).join('')

        if (SUCCESS_KEYWORDS.test(texts)) {
            log('检测到成功页，停止答题。')
            return { result: 'success', answered }
        }

        if (FAIL_KEYWORDS.test(texts)) {
            log('检测到失败页，停止答题。')
            return { result: 'fail', answered }
        }

        // 题目文字：取顶部横幅区域(y < QUESTION_Y_MAX)内足够长的文字框，按 y 再按 x 排序拼接成完整题干。
        const qBoxes = all.filter(
            (b) => b.box[1] < QUESTION_Y_MAX && b.text && b.text.length >= 6 && !NOISE_PATTERN.test(b.text)
        )
        if (qBoxes.length) {
            const qText = stripOcrNoise(sortReadingOrder(qBoxes).map((b) => b.text).join(''))
            const match = findAnswer(qText, tikuList)
            if (match && match.score >= matchThreshold) {
                if (match.entry.question !== lastAnsweredQuestion) {
                    lastAnsweredQuestion = match.entry.question
                    const ans = match.entry.answer
                    const btn = ans === '对' ? TRUE_BTN : FALSE_BTN
                    log(
                        `题目: "${qText}" -> 匹配: "${match.entry.question}" (score=${match.score.toFixed(2)}) -> 答案: ${ans}`
                    )
                    if (dryRun) {
                        log(`  [dry-run] 会点击「${ans}」按钮 @ ${fmtTarget(btn)}，本次不点击`)
                    } else {
                        await clickAt(tasker, btn)
                    }
                    answered++
                }
            } else {
                log(
                    `⚠ 题目: "${qText}" 未找到可信匹配(最佳 score=${match ? match.score.toFixed(2) : 'N/A'})，跳过本题`
                )
            }
        }
        await new Promise((r) => setTimeout(r, pollMs))
    }
    log(`⚠ 超时(${timeoutMs / 1000}s)仍未结束`)
    return { result: 'timeout', answered }
}

module.exports = {
    runDati,
    ensureStarted,
    findAnswer,
    normalize,
    stripOcrNoise,
    sortReadingOrder,
    editDistance,
    loadTiku,
    TRUE_BTN,
    FALSE_BTN,
}
