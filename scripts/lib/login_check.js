// 咸鱼之王「微信登录」校验共享模块
//
// 导出 ensureLoggedIn(ctrl, tasker, opts)：检测是否掉登录态，若是则走扫码授权流程。
// 被 scripts/account_login.js(独立登录提醒) 和 scripts/daily_chain.js(一条龙前置校验) 复用。
//
// 流程(与 xyzw_login.json pipeline 配合，逻辑已实机扫码验证)：
//   跑 微信登录_启动 pipeline -> 据 微信登录_点登录 节点 reco.hit 判断是否在登录页
//     - 不在登录页(已登录/仍在加载) -> 返回 'already'
//     - 在登录页 -> 启动扫码工具(com.willh.wz)调出"咸鱼之王官方版"二维码 -> 截图发企微群
//         -> 每 pollSec 秒 OCR 检测"授权成功" -> 检测到返回 'authorized'；到 maxWaitMin 超时返回 'timeout'
//
// 本模块不建/销毁 ctrl/tasker、不读 process.argv —— 连接生命周期由调用方管理，只接收参数、返回结果。

const crypto = require('crypto')
const https = require('https')

const PACKAGE = 'com.hortor.games.xyzw' // 咸鱼之王包名
// 咸鱼之王微信扫码登录工具(apk/GameWxQRlogin-xyzw.apk，版本 1.5.1)。
// 咸鱼点"微信登录"后进入等待授权状态，再单独启动这个工具会调出"咸鱼之王官方版"专属扫码二维码页。
const QR_PACKAGE = 'com.willh.wz'

// pipeline 入口 + 关键节点名（与 assets/resource/pipeline/xyzw_login.json 一致）
const ENTRY = '微信登录_启动'
const CLICK_NODE = '微信登录_点登录' // 据此节点 reco.hit 判断是否真的检测到登录页并点了登录

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

// 检测登录态并在掉登录时走扫码授权流程。
// ctrl/tasker: 调用方已建好并连接的 maa 控制器/任务器（复用同一连接）。
// opts: { wecomKey(必填), target, shotWaitSec=8, maxWaitMin=5, pollSec=5, log=console.log }
// 返回: 'already'(本就已登录/不在登录页) | 'authorized'(检测到登录页且扫码授权成功) | 'timeout'(检测到但等不到授权)
async function ensureLoggedIn(ctrl, tasker, opts = {}) {
    const { wecomKey, target = '', shotWaitSec = 8, maxWaitMin = 5, pollSec = 5, log = console.log } = opts
    if (!wecomKey) throw new Error('ensureLoggedIn 需要 wecomKey')

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
        log('未检测到登录页(已登录/仍在加载)，无需登录。')
        return 'already'
    }

    // 咸鱼已点"微信登录"进入等待授权状态，此时启动扫码登录工具调出"咸鱼之王官方版"专属二维码页。
    // ★ 先关闭扫码工具再启动(冷启动)：否则它若在后台残留(旧二维码/上次"授权成功"页)，
    //   post_start_app 只切前台不刷新，会截到旧码、或轮询误判上次的"授权成功"。
    log('检测到登录页并已点"微信登录"，先关闭再启动扫码登录工具(刷新二维码):', QR_PACKAGE)
    try {
        await ctrl.post_stop_app(QR_PACKAGE).wait()
    } catch (e) {
        log('关闭扫码工具异常(忽略):', e.message ?? e)
    }
    await sleep(1000) // 等进程真正退出，再冷启动
    await ctrl.post_start_app(QR_PACKAGE).wait()

    log(`等待 ${shotWaitSec} 秒让二维码页加载 ...`)
    await sleep(shotWaitSec * 1000)

    log('截图中(扫码二维码页) ...')
    const image = await ctrl.post_screencap().wait().get()
    if (!image) throw new Error('截图失败')

    log('上报企微(二维码图片 + 文字提醒) ...')
    await sendTextToWecom(
        wecomKey,
        `【咸鱼之王-${target}】检测到掉登录态，已调出微信扫码二维码，请用手机微信尽快扫码授权登录！(扫码授权成功后自动继续，最多等 ${maxWaitMin} 分钟)`
    )
    const result = await sendImageToWecom(wecomKey, image)
    log('✓ 上报成功:', JSON.stringify(result))

    // 轮询等待人工扫码：每 pollSec 秒截图 OCR 一次，扫码工具检测到授权会显示"授权成功"(实测"David授权成功")。
    // 检测到返回 authorized；到 maxWaitMin 仍没检测到返回 timeout(避免无人扫码时无限等)。
    log(`等待人工扫码授权(每 ${pollSec}s 检测一次"授权成功"，最长 ${maxWaitMin} 分钟) ...`)
    const deadline = Date.now() + maxWaitMin * 60 * 1000
    while (Date.now() < deadline) {
        await sleep(pollSec * 1000)
        const shot = await ctrl.post_screencap().wait().get()
        const od = await tasker
            .post_recognition('OCR', { expected: '授权成功', roi: [0, 0, 720, 1280] }, shot)
            .wait()
            .get()
        if (od && od.status === 3000) {
            log('✓ 检测到扫码授权成功')
            // 切回咸鱼之王（扫码工具会停在"授权成功 跳转中"，主动拉回游戏更稳）
            log('切回咸鱼之王:', PACKAGE)
            await ctrl.post_start_app(PACKAGE).wait()
            return 'authorized'
        }
        log(`  尚未授权，继续等待(剩余约 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s) ...`)
    }
    log(`⚠ 等待 ${maxWaitMin} 分钟仍未检测到授权成功`)
    return 'timeout'
}

module.exports = { ensureLoggedIn, sendImageToWecom, sendTextToWecom, PACKAGE, QR_PACKAGE }
