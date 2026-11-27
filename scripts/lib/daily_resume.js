const RETRY_ENTRY = '全日常_启动'

const COMPLETION_TO_NEXT_ENTRY = new Map([
    ['赠送金币_完成', '招募_入口'],
    ['赠送金币_已完成跳过', '招募_入口'],
    ['招募_完成', '点金_入口'],
    ['点金_完成', '宝箱_入口'],
    ['宝箱_完成', '黑市_入口'],
    ['黑市_完成', '竞技场_入口'],
    ['竞技场_完成', '每日任务_确认在任务页'],
    ['每日任务_完成', '邮件_启动'],
    ['邮件_完成', '充值_启动'],
    ['充值_完成', '咸王_入口'],
    ['咸王_完成', '钓鱼_入口'],
    ['钓鱼_完成', '俱乐部_启动'],
    ['俱乐部_完成', null],
])

const TASK_PAGE_ENTRIES = new Set([
    '招募_入口',
    '点金_入口',
    '宝箱_入口',
    '黑市_入口',
    '竞技场_入口',
    '每日任务_确认在任务页',
])

function withNodeNext(override, nodeName, nextEntry) {
    return {
        ...override,
        [nodeName]: {
            ...(override[nodeName] || {}),
            next: [nextEntry],
        },
    }
}

function createDailyResumeCheckpoint() {
    let lastCompletedNode = null
    let nextEntry = null

    return {
        observeNode(nodeName) {
            if (!COMPLETION_TO_NEXT_ENTRY.has(nodeName)) return false
            lastCompletedNode = nodeName
            nextEntry = COMPLETION_TO_NEXT_ENTRY.get(nodeName)
            return true
        },

        getState() {
            return { lastCompletedNode, nextEntry }
        },

        buildRetryPlan(baseOverride) {
            let override = { ...(baseOverride || {}) }
            if (!nextEntry) {
                return {
                    entry: RETRY_ENTRY,
                    override,
                    resumed: false,
                    lastCompletedNode,
                    nextEntry,
                }
            }

            if (TASK_PAGE_ENTRIES.has(nextEntry)) {
                override = withNodeNext(override, '全日常_二次确认主界面', '全日常_开任务页')
                override = withNodeNext(override, '全日常_确认任务页', nextEntry)
            } else {
                override = withNodeNext(override, '全日常_二次确认主界面', nextEntry)
            }

            return {
                entry: RETRY_ENTRY,
                override,
                resumed: true,
                lastCompletedNode,
                nextEntry,
            }
        },
    }
}

module.exports = { createDailyResumeCheckpoint }
