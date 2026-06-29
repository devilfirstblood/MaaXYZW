// 咸鱼之王「微信登录」检测与提醒脚本
// 启动游戏 -> 跑 微信登录 pipeline(检测登录页并点"微信登录")：
//   - 检测到登录页并点了"微信登录" -> 启动扫码登录工具(com.willh.wz)调出"咸鱼之王官方版"专属二维码页
//     -> 等几秒让二维码加载 -> 截二维码页发企微群(提醒人工用手机微信扫码授权)
//     -> 1 分钟后重启咸鱼之王切回游戏 -> 结束
//   - 未检测到登录页(已在主界面/仍在加载) -> 不做动作，直接结束
//
// "启动 + 识别登录页 + 点微信登录"逻辑在 pipeline(assets/resource/pipeline/xyzw_login.json)里；
// 本脚本只做 pipeline 表达不了的外部动作：启动扫码工具、截图、发企微、定时切回。
//
// 企微机器人 key 通过环境变量 WECOM_KEY 传入（不要硬编码进脚本提交）。
//
// 用法（在项目根目录 C:\AndroidPro\MFAA\MaaTest 下运行）：
//   set WECOM_KEY=你的key && node scripts/account_login.js                 # 默认设备 emulator-5554
//   node scripts/account_login.js 16384                                    # 指定设备(name/address 包含匹配)
//   node scripts/account_login.js emulator-5554 8                          # 设备 + 点登录后等待二维码加载的秒数(默认8)
//   node scripts/account_login.js emulator-5554 8 10                       # 第3参=等待扫码授权的最长分钟数(默认5,兜底超时仍切回)
//
// 上报二维码后会每 5 秒截图 OCR 检测"授权成功"，检测到即立即切回咸鱼；超过最长分钟数仍未授权则兜底切回。
//
// 依赖 maa-tools 下载的 maa-node binding（npx maa-tools check 会自动准备）。

const os = require('os')
const path = require('path')
const crypto = require('crypto')
const https = require('https')

const maaPath = path.join(os.homedir(), '.maa-tools', 'install', 'latest', 'node_modules', '@maaxyz', 'maa-node')
const maa = require(maaPath)

// 资源目录：相对本脚本定位到项目 assets/resource
const RESOURCE = path.resolve(__dirname, '..', 'assets', 'resource')

const TARGET = process.argv[2] || 'emulator-5554' // 设备 name/address 包含匹配
const SHOT_WAIT_SEC = Number(process.argv[3] || 8) // 点"微信登录"后等待二维码页加载再截图的秒数
const MAX_WAIT_MIN = Number(process.argv[4] || 5) // 上报后等待人工扫码授权的最长分钟数(兜底,默认5)，超时仍切回
const POLL_SEC = 5 // 等待授权期间每隔多少秒截图 OCR 一次，检测到"授权成功"立即切回

const PACKAGE = 'com.hortor.games.xyzw' // 咸鱼之王包名
// 咸鱼之王微信扫码登录工具(apk/GameWxQRlogin-xyzw.apk，版本 1.5.1)。
// 咸鱼点"微信登录"后进入等待授权状态，再单独启动这个工具会调出"咸鱼之王官方版"专属扫码二维码页，
// 截这个二维码页发企微，人工用手机微信扫码即可授权登录。
const QR_PACKAGE = 'com.willh.wz'
const WECOM_KEY = process.env.WECOM_KEY || '' // 企微机器人 key（用环境变量 WECOM_KEY 传入）

// pipeline 入口 + 关键节点名（与 assets/resource/pipeline/xyzw_login.json 一致）
const ENTRY = '微信登录_启动'
const CLICK_NODE = '微信登录_点登录' // 据此节点 reco.hit 判断是否真的检测到登录页并点了登录

function ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false })
}
const log = (...a) => console.log(`[${ts()}]`, `[${TARGET}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 把 PNG 二进制(ArrayBuffer/Buffer)发到企微群机器人（与 app_screencap_report.js 一致）
function sendImageToWecom(key, image) {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.from(image)
        // 企微限制：原图 <= 2MB；仅支持 jpg/png（maa 截图为 PNG，已满足）
        if (buffer.length > 2 * 1024 * 1024) {
            return reject(new Error(`截图超过 2MB(${(buffer.length / 1024 / 1024).toFixed(2)}MB)，需压缩`))
        }
        // base64 对原始二进制；md5 也对原始二进制（关键，不是对 base64 串算）
        const base64 = buffer.toString('base64')
        const md5 = crypto.createHash('md5').update(buffer).digest('hex')
        const body = JSON.stringify({ msgtype: 'image', image: { base64, md5 } })
        const req = https.request(
            {
                hostname: 'qyapi.weixin.qq.com',
                path: `/cgi-bin/webhook/send?key=${key}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                let data = ''
                res.on('data', (c) => (data += c))
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data)
                        json.errcode === 0 ? resolve(json) : reject(new Error(`企微错误 ${json.errcode}: ${json.errmsg}`))
                    } catch {
                        reject(new Error(`响应解析失败: ${data}`))
                    }
                })
            }
        )
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

// 发文字消息到企微群（提醒去扫码）
function sendTextToWecom(key, text) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ msgtype: 'text', text: { content: text } })
        const req = https.request(
            {
                hostname: 'qyapi.weixin.qq.com',
                path: `/cgi-bin/webhook/send?key=${key}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                let data = ''
                res.on('data', (c) => (data += c))
                res.on('end', () => resolve(data))
            }
        )
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

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
        log('启动游戏并检测登录页:', ENTRY)
        const detail = await tasker.post_task(ENTRY).wait().get()

        // 据 微信登录_点登录 节点的 reco.hit 判断是否真检测到登录页并点了"微信登录"
        let clicked = false
        for (const nodeId of detail.nodes ?? []) {
            const nd = tasker.node_detail(nodeId)
            if (nd && nd.name === CLICK_NODE && nd.reco && nd.reco.hit) {
                clicked = true
                break
            }
        }

        if (!clicked) {
            log('未检测到登录页(已登录/仍在加载)，不做动作，结束。')
            return
        }

        // 咸鱼已点"微信登录"进入等待授权状态，此时启动扫码登录工具调出"咸鱼之王官方版"专属二维码页。
        log('检测到登录页并已点"微信登录"，启动扫码登录工具调出二维码:', QR_PACKAGE)
        await ctrl.post_start_app(QR_PACKAGE).wait()

        log(`等待 ${SHOT_WAIT_SEC} 秒让二维码页加载 ...`)
        await sleep(SHOT_WAIT_SEC * 1000)

        log('截图中(扫码二维码页) ...')
        const image = await ctrl.post_screencap().wait().get()
        if (!image) throw new Error('截图失败')

        log('上报企微(二维码图片 + 文字提醒) ...')
        await sendTextToWecom(WECOM_KEY, `【咸鱼之王-${TARGET}】检测到掉登录态，已调出微信扫码二维码，请用手机微信尽快扫码授权登录！(扫码授权成功后自动切回游戏，最多等 ${MAX_WAIT_MIN} 分钟)`)
        const result = await sendImageToWecom(WECOM_KEY, image)
        log('✓ 上报成功:', JSON.stringify(result))

        // 轮询等待人工扫码：每 POLL_SEC 秒截图 OCR 一次，扫码工具检测到授权会显示"授权成功"(实测"David授权成功")。
        // 检测到即立即切回咸鱼；到 MAX_WAIT_MIN 仍没检测到则兜底切回(避免无人扫码时无限等)。
        log(`等待人工扫码授权(每 ${POLL_SEC}s 检测一次"授权成功"，最长 ${MAX_WAIT_MIN} 分钟) ...`)
        const deadline = Date.now() + MAX_WAIT_MIN * 60 * 1000
        let authorized = false
        while (Date.now() < deadline) {
            await sleep(POLL_SEC * 1000)
            const shot = await ctrl.post_screencap().wait().get()
            // 临时 OCR 节点找"授权成功"(roi 全屏，DoNothing 不操作)
            const od = await tasker
                .post_recognition('OCR', { expected: '授权成功', roi: [0, 0, 720, 1280] }, shot)
                .wait()
                .get()
            if (od && od.status === 3000) {
                authorized = true
                log('✓ 检测到扫码授权成功，立即切回游戏')
                break
            }
            log(`  尚未授权，继续等待(剩余约 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s) ...`)
        }
        if (!authorized) log(`⚠ 等待 ${MAX_WAIT_MIN} 分钟仍未检测到授权成功，兜底切回游戏`)

        log('切回咸鱼之王:', PACKAGE)
        await ctrl.post_start_app(PACKAGE).wait()
        log('✓ 已切回游戏，结束。')
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
