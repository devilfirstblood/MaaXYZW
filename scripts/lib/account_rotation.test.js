// account_rotation.pickNextSlot 单测（node:assert，无第三方框架）。
// 运行：node scripts/lib/account_rotation.test.js
const assert = require('node:assert')
const { pickNextSlot } = require('./account_rotation')

// 1) 跳过已访问的号，返回第一个未访问切换位
{
    const slots = [
        { side: 'left', stage: 9703, target: [208, 228, 1, 1] },
        { side: 'right', stage: 8500, target: [505, 228, 1, 1] },
    ]
    assert.strictEqual(pickNextSlot(slots, new Set([9703])), slots[1])
}
// 2) 全部已访问 → null（轮转终止）
{
    const slots = [
        { side: 'left', stage: 9703 },
        { side: 'right', stage: 8500 },
    ]
    assert.strictEqual(pickNextSlot(slots, new Set([9703, 8500])), null)
}
// 3) 空切换位（单账号设备）→ null
{
    assert.strictEqual(pickNextSlot([], new Set()), null)
}
// 4) 忽略 stage 为 null 的位，返回下一个有效位
{
    const slots = [
        { side: 'left', stage: null },
        { side: 'right', stage: 8500 },
    ]
    assert.strictEqual(pickNextSlot(slots, new Set()).stage, 8500)
}
// 5) 非数组输入 → null（防御）
{
    assert.strictEqual(pickNextSlot(null, new Set()), null)
}
console.log('account_rotation.test.js: all passed')
