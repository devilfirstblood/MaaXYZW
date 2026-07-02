// 咸鱼之王「多开机器人」账号轮转 —— 挑下一个要做的切换位。
// 纯逻辑、无副作用、无原生依赖，可独立单测（见 account_rotation.test.js）。
//
// slots: readSwitchSlots() 的返回，形如 [{ side, stage:Number, target:[x,y,w,h] }]。
// visited: 已做过账号的关卡数集合 Set<number>。
// 返回: 第一个 stage 有效且不在 visited 的 slot；没有则返回 null（作为轮转终止信号）。
function pickNextSlot(slots, visited) {
    if (!Array.isArray(slots)) return null
    for (const s of slots) {
        if (s && s.stage != null && !visited.has(s.stage)) return s
    }
    return null
}

module.exports = { pickNextSlot }
