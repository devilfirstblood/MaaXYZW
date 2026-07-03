// dati.js 纯逻辑单测（node:assert，无第三方框架）。不连设备，只测文本归一化/编辑距离/题库匹配。
// 运行：node scripts/lib/dati.test.js
const assert = require('node:assert')
const { normalize, editDistance, findAnswer, loadTiku, stripOcrNoise, sortReadingOrder } = require('./dati')

// 1) normalize 去掉书名号/引号/问号等标点和空白（全角/半角问号都要能去掉）
{
    assert.strictEqual(normalize('《咸鱼之王》中，「黑市」每日0点自动刷新商品？'), '咸鱼之王中黑市每日0点自动刷新商品')
    assert.strictEqual(normalize('蔡文姬擅长音律?'), '蔡文姬擅长音律')
}

// 2) editDistance 基本用例
{
    assert.strictEqual(editDistance('abc', 'abc'), 0)
    assert.strictEqual(editDistance('abc', 'abd'), 1)
    assert.strictEqual(editDistance('', 'abc'), 3)
}

// 3) findAnswer：完整题库上，拿题库里的原文当"OCR文本"，必须精确命中自己(score=1)
{
    const tikuList = loadTiku()
    assert.ok(tikuList.length > 100, `题库题量异常少: ${tikuList.length}`)
    for (const q of tikuList.slice(0, 30)) {
        const best = findAnswer(q.question, tikuList)
        assert.ok(best.score > 0.999, `题目"${q.question}"未精确匹配自己 score=${best.score}`)
        assert.strictEqual(best.entry.answer, q.answer)
    }
}

// 4) findAnswer：模拟 OCR 常见误差(问号丢失)，应仍能匹配到正确题目
{
    const tikuList = loadTiku()
    const q = tikuList.find((x) => x.question.endsWith('?'))
    const ocrLike = q.question.slice(0, -1)
    const best = findAnswer(ocrLike, tikuList)
    assert.strictEqual(best.entry.question, q.question)
    assert.strictEqual(best.entry.answer, q.answer)
}

// 5) findAnswer：高度相似但答案相反的题目对（只差一个字）必须能分辨清楚，不能选错
{
    const tikuList = loadTiku()
    const a = tikuList.find((x) => x.question === '《三国演义》中，「拔矢啖睛」的是夏侯惇。')
    const b = tikuList.find((x) => x.question === '《三国演义》中，「拔矢啖睛」的是夏侯渊。')
    assert.ok(a && b, '题库缺少用于区分度测试的题目，请检查 tiku.json 是否变动')
    assert.notStrictEqual(a.answer, b.answer)
    assert.strictEqual(findAnswer(a.question, tikuList).entry.answer, a.answer)
    assert.strictEqual(findAnswer(b.question, tikuList).entry.answer, b.answer)
}

// 6) findAnswer：空/无意义文本不应给出高分匹配（避免在非题目画面误判）
{
    const tikuList = loadTiku()
    assert.strictEqual(findAnswer('', tikuList), null)
    const best = findAnswer('确定', tikuList)
    assert.ok(best.score < 0.75, `无关短文本"确定"不该有高匹配分，实际 score=${best.score}`)
}

// 7) 倒计时期间同一题被反复 OCR 识别时会有个别字抖动(实测同一段文字连续几帧不完全一致)。
//    runDati 主循环用"命中的题库题是否变化"而非"原始 OCR 文本是否变化"来判断是否还是同一题——
//    这里验证其前提成立：同一题的抖动文本仍应命中原题(不会被抖动带偏到 5) 里那种高度相似的近似题上)。
{
    const tikuList = loadTiku()
    const a = tikuList.find((x) => x.question === '《三国演义》中，「拔矢啖睛」的是夏侯惇。')
    const jittered = a.question.slice(0, 8) + '误' + a.question.slice(9) // 模拟倒计时期间 OCR 单字抖动
    assert.strictEqual(findAnswer(jittered, tikuList).entry.question, a.question)
}

// 8) stripOcrNoise：实测题目结算特效被 OCR 认成的结尾大写字母乱码要能切掉，
//    但题库里真正含大写字母的题("...BOSS。""...NPC名字...")不能被误伤
{
    assert.strictEqual(
        stripOcrNoise('《咸鱼之王》里「龙鱼·八卦」是咸将黄月英的专属鱼灵?KAAAAAK'),
        '《咸鱼之王》里「龙鱼·八卦」是咸将黄月英的专属鱼灵?'
    )
    assert.strictEqual(
        stripOcrNoise('《咸鱼之王》中，在「盐锭商店」中可以花费「盐锭」兑换到「AZAAAAAA'),
        '《咸鱼之王》中，在「盐锭商店」中可以花费「盐锭」兑换到「'
    )
    const tikuList = loadTiku()
    const bossQ = tikuList.find((x) => x.question.endsWith('不同BOSS。'))
    assert.ok(bossQ, '题库缺少用于验证"不误伤合法大写字母"的题目')
    assert.strictEqual(stripOcrNoise(bossQ.question), bossQ.question)
}

// 9) sortReadingOrder：同一行内不同文字框的 y 坐标常有几像素抖动、并不严格相等，
//    单纯按 y 排序会把行内顺序拆散拼反(实测"「招募」无法"/"《咸鱼之王》中，"就是这样被拼反的)。
//    这里用同样的场景验证：y 相近(同一行)的框要按 x 排，不同行的框要按 y 排。
{
    const boxes = [
        { text: '「招募」无法', box: [280, 145, 140, 30] }, // 同一行，x 更靠右，y 却略小
        { text: '《咸鱼之王》中，', box: [30, 148, 240, 30] }, // 同一行，x 更靠左
        { text: '获得咸将吕玲绮。', box: [30, 190, 220, 30] }, // 下一行
    ]
    const ordered = sortReadingOrder(boxes).map((b) => b.text)
    assert.deepStrictEqual(ordered, ['《咸鱼之王》中，', '「招募」无法', '获得咸将吕玲绮。'])
}

console.log('dati.test.js: all passed')
