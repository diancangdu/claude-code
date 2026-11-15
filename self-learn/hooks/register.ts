import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

// 公共经验库（所有 Agent 共用，append-only）。⛔ 不复制副本：读写都直达这里。
// 库目录由环境变量 SELF_LEARN_LIB 指定（在 session.start 解析），便于移植到别的机器。
let libDir = ''
let learnPy = `${libDir}\\tools\\learn.py`
// 署名固定不变，否则库的署名分布会碎（见库 USAGE.md §4）。
const AUTHOR = 'claude-code'

type Entry = {
  kind: string
  date: string
  title: string
  body: string
  author?: string
  superseded_by?: string
}

const KIND_LABEL: Record<string, string> = {
  learn: '正向经验',
  error: '错误教训',
  best_practice: '沉淀准则',
}

// python 解释器：本机 python 在 PATH（3.15.2），失败时退回 py -3。首次成功后固定，
// 避免每次检索都试两个候选。
let pythonBase: string[] | undefined

async function runLearn(
  $: EngineInterface,
  args: readonly string[],
  timeoutMs = 8000,
): Promise<ProcessRunResult | undefined> {
  const bases = pythonBase ? [pythonBase] : [['python'], ['py', '-3']]
  for (const base of bases) {
    try {
      const r = await $.process.run([...base, learnPy, ...args], { timeoutMs })
      // 第一候选若是坏的（如应用商店占位符），换下一个再试一次。
      if (r.exitCode !== 0 && pythonBase === undefined && base !== bases[bases.length - 1]) continue
      pythonBase = base
      return r
    } catch {
      // 解释器不在 PATH 等启动失败 -> 试下一个候选
    }
  }
  return undefined
}

async function runLearnJson<T>(
  $: EngineInterface,
  args: readonly string[],
  timeoutMs?: number,
): Promise<T | undefined> {
  const r = await runLearn($, [...args, '--json'], timeoutMs)
  if (!r || r.exitCode !== 0) return undefined
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    return undefined
  }
}

function flat(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

function formatEntry(e: Entry, bodyMax: number): string {
  const by = e.author ? ` ·${e.author}` : ''
  const body = e.body ? ` — ${flat(e.body, bodyMax)}` : ''
  return `- [${KIND_LABEL[e.kind] ?? e.kind}·${(e.date || '').slice(0, 10)}] ${e.title}${by}${body}`
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(hi, Math.max(lo, n))
}

function argString(e: object, key: string): string {
  const v = (e as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// 可观测性：本会话计数 + 跨会话累计（$.store）。自进化需要反馈信号，
// 否则"注入有没有用、有没有白跑 rank"只能靠印象。
// ---------------------------------------------------------------------------
type Counters = {
  rankCalls: number
  rankHits: number
  injected: number
  misses: number
  throttled: number
  searches: number
  adds: number
  supersedes: number
  reminders: number
}

type Totals = {
  loads: number
  injected: number
  searches: number
  adds: number
  supersedes: number
  reminders: number
  updatedAt: string
}

const STORE_KEY = 'self-learn:stats'
const session: Counters = {
  rankCalls: 0,
  rankHits: 0,
  injected: 0,
  misses: 0,
  throttled: 0,
  searches: 0,
  adds: 0,
  supersedes: 0,
  reminders: 0,
}
let totals: Totals | undefined

async function loadTotals($: EngineInterface): Promise<void> {
  try {
    const v = await $.store.get(STORE_KEY)
    const t = (v && typeof v === 'object' ? v : {}) as Partial<Totals>
    totals = {
      loads: Number(t.loads ?? 0) + 1,
      injected: Number(t.injected ?? 0),
      searches: Number(t.searches ?? 0),
      adds: Number(t.adds ?? 0),
      supersedes: Number(t.supersedes ?? 0),
      reminders: Number(t.reminders ?? 0),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : '',
    }
  } catch {
    totals = undefined // 测试或无存储环境：不阻塞
  }
}

/** 会话结束时把本会话增量并进累计。只落盘这一次，重复调用不会重复累计。 */
async function persistTotals($: EngineInterface): Promise<void> {
  if (!totals) return
  const merged: Totals = {
    loads: totals.loads,
    injected: totals.injected + session.injected,
    searches: totals.searches + session.searches,
    adds: totals.adds + session.adds,
    supersedes: totals.supersedes + session.supersedes,
    reminders: totals.reminders + session.reminders,
    updatedAt: new Date().toISOString(),
  }
  try {
    await $.store.set(STORE_KEY, merged)
    // 落盘成功才把增量清零：失败时保留，会话结束钩子不再重试也无妨。
    session.injected = 0
    session.searches = 0
    session.adds = 0
    session.supersedes = 0
    session.reminders = 0
    totals = merged
  } catch {
    /* 存储不可用：跳过 */
  }
}

// 会话级的注入账本：同一标题注入一次；总量设上限，长会话里避免经验块无限膨胀。
const injected = new Set<string>()
let injectedTotal = 0
const MAX_INJECTED_PER_SESSION = 30

/**
 * 取与任务相关的经验并格式化成注入块。rank 是严档（标题至少命中 2 个词），
 * 只在真正相关时返回；词法检索查不到就是没有，不硬塞噪声（与库契约一致）。
 */
async function rankContext($: EngineInterface, task: string): Promise<string | undefined> {
  if (injectedTotal >= MAX_INJECTED_PER_SESSION) return undefined
  // 长提示（粘贴的代码、日志）会把检索词冲散，取前 600 字符已足够表征任务。
  session.rankCalls++
  const rows = await runLearnJson<Entry[]>($, ['rank', flat(task, 600), '--limit', '6'])
  if (!rows?.length) return undefined
  const fresh = rows.filter(r => !injected.has(r.title)).slice(0, 4)
  if (!fresh.length) return undefined
  session.rankHits++
  for (const r of fresh) {
    injected.add(r.title)
    injectedTotal++
  }
  session.injected += fresh.length
  const lines = fresh.map(r => formatEntry(r, 240))
  return [
    `【共享经验库 · 与本次任务相关的经验 ${fresh.length} 条】自动注入，先核对适用条件再照做；全文用 learn_search 查，反馈请 learn_add/supersede。`,
    ...lines,
  ].join('\n')
}

// 同一错误签名（工具 + 错误首段）第二次出现 = 真卡住，而不是正常的红绿迭代。
// 全会话只提醒一次；提醒时先替模型查一次库，把"去查查"变成"可能就是这个"。
const failureSeen = new Map<string, number>()
let remindedThisSession = false

// 上游插件可能整段跳过 prompt.compose（实测：cc-plugin-sec-default 抢先应答，
// 本插件的 compose 钩子不执行）。那时系统提示词里没有协议段，就改由
// prompt.submit 在会话首条提示词上补投一次，保证纪律一定到场、且只到场一次。
let composeRan = false
let protocolInjected = false

// 触发节流：长度按"内容字符"算（去空白/标点/符号），对话性的短回复不触发检索；
// 连续 3 条无命中后进入抽样（每 3 条 rank 一次）——降频而不是抬阈值，阈值会切掉
// 真正的短任务，抽样只延迟发现，且命中一次即恢复全量。
const MIN_CONTENT_CHARS = 12
let consecutiveMisses = 0
let eligiblePrompts = 0

function protocol(): string {
  return `【共享经验库 · 自学习协议（self-learn 插件）】
库：${libDir}（所有 Agent 共用、append-only；⛔ 不复制到项目里）。署名固定：${AUTHOR}。
读：动手前若领域陌生或可能踩过坑，先 learn_search（命令行等价：learn.cmd rank "<任务>" --limit 6；核对适用条件要 --full）。检索是词法（中文 bigram），查不到≠没有，换关键说法再查。
写：定案修复了非平凡问题、或得到可跨项目复用的判据时，用 learn_add 写一条（kind=error|learn|best_practice）；标题必须带前置条件（「仅当X时：Y」），正文给判据/读数不给形容词；写前先查重，同因重复用 learn_supersede 标记而不是新写，不删原文。
分工：跨项目经验进共享库；本工程逐轮流水仍写 memory/YYYY-MM-DD.md，两处别混。`
}

export const register: Register = on => {
  // ---- 观察所有工具调用：同一错误第二次出现时，附一条带库命中的反思提醒 ----
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool.startsWith('mcp__self-learn__')) return ran
    if (e.agentId !== undefined) return ran // 子代理的失败不替它反思
    if (ran.deny !== undefined) return ran
    if (ran.isError !== true) return ran
    const signature = `${e.tool}|${flat(ran.text ?? '', 60)}`
    const n = (failureSeen.get(signature) ?? 0) + 1
    failureSeen.set(signature, n)
    if (failureSeen.size > 200) failureSeen.clear()
    if (n < 2 || remindedThisSession) return ran
    remindedThisSession = true
    session.reminders++
    // 先查库：宽档 query（错误文本通常是英文/短句，严档会漏）。
    const hits = (await runLearnJson<Entry[]>($, ['query', flat(ran.text ?? '', 200)])) ?? []
    const list = hits.slice(0, 2).map(h => `- ${h.title}`)
    const note =
      `【self-learn】同一错误已出现 ${n} 次（${e.tool}：${flat(ran.text ?? '', 120)}）。` +
      (list.length
        ? `库里可能有相关经验：\n${list.join('\n')}\n先 learn_search 核对全文。`
        : '先 learn_search 用错误特征查库。') +
      '若最终定案修复且库里没有同因记录，收口前用 learn_add 写一条 error（标题写前置条件）。'
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // ---- 模型可调用的三个工具：检索、写入、取代都直达公共库 ----
  // 注意：引擎校验工具输出形状——result 只能是 string / 内容块数组 / undefined，
  // 返回普通对象会被拒（test kit 不校验，只有活体会抓到）。
  on('tool.call', { tool: 'mcp__self-learn__learn_search' }, async ($, e) => {
    const query = flat(argString(e, 'query'), 600)
    const limit = clampInt((e as Record<string, unknown>).limit, 1, 12, 6)
    if (!query) return { deny: 'learn_search: query 不能为空' }
    let rows = await runLearnJson<Entry[]>($, ['rank', query, '--limit', String(limit)])
    let tier: 'rank' | 'query' | 'none' = 'rank'
    if (!rows?.length) {
      // 严档没命中 -> 宽档再试（与库 USAGE 的两档口径一致）。
      rows = await runLearnJson<Entry[]>($, ['query', query])
      tier = rows?.length ? 'query' : 'none'
    }
    session.searches++
    if (rows === undefined) return { deny: `learn_search: 无法运行 ${learnPy}` }
    if (tier === 'none') {
      return { result: 'tier=none · 词法检索无命中；换一种关键说法再查（查不到≠库里没有）。' }
    }
    const out = rows.slice(0, limit).map(r => ({ ...r, body: r.body.slice(0, 1200) }))
    return {
      result: [
        `tier=${tier}（${tier === 'rank' ? '严档：标题命中≥2词' : '严档无命中，宽档回退'}） · ${out.length} 条`,
        ...out.map(r => formatEntry(r, 1000)),
      ].join('\n'),
    }
  }).catch(() => ({ deny: 'self-learn: learn_search 执行失败（插件内部错误）' }))

  on('tool.call', { tool: 'mcp__self-learn__learn_add' }, async ($, e) => {
    const kind = argString(e, 'kind')
    const title = argString(e, 'title').trim()
    const body = argString(e, 'body').trim()
    if (!['learn', 'error', 'best_practice'].includes(kind)) {
      return { deny: 'learn_add: kind 只能是 learn / error / best_practice' }
    }
    if (!title) return { deny: 'learn_add: title 不能为空，且必须带前置条件（仅当X时：Y）' }
    const r = await runLearn(
      $,
      ['add', kind, '--title', title, '--body', body, '--author', AUTHOR],
      10000,
    )
    if (!r) return { deny: `learn_add: 无法运行 ${learnPy}` }
    // CLI 的 stdout：第一行是 JSON 结果，其后可能有查重提示的纯文本行。
    const lines = r.stdout.split('\n')
    const firstLine = (lines[0] ?? '').trim()
    const rest = lines.slice(1).join('\n').trim()
    if (firstLine.startsWith('{')) {
      session.adds++
      await persistTotals($)
    }
    if (!firstLine.startsWith('{')) {
      // 解析不了时不要谎报失败：写入可能已发生，把原始输出交回模型判断。
      return { result: `exit=${r.exitCode}（CLI 输出无法解析为 JSON）\n${r.stdout.slice(0, 800)}` }
    }
    return { result: rest ? `${firstLine}\n${rest}` : firstLine }
  }).catch(() => ({ deny: 'self-learn: learn_add 执行失败（插件内部错误）' }))

  on('tool.call', { tool: 'mcp__self-learn__learn_supersede' }, async ($, e) => {
    const oldSub = argString(e, 'old').trim()
    const newTitle = argString(e, 'newTitle').trim()
    const why = argString(e, 'why').trim()
    if (!oldSub || !newTitle) {
      return { deny: 'learn_supersede: old（旧标题唯一子串）与 newTitle（取代它的新条目全标题）必填' }
    }
    const argv = ['supersede', '--old', oldSub, '--new', newTitle]
    if (why) argv.push('--why', why)
    const r = await runLearn($, argv, 10000)
    if (!r) return { deny: `learn_supersede: 无法运行 ${learnPy}` }
    if (r.exitCode === 0) {
      session.supersedes++
      await persistTotals($)
    }
    return { result: `exit=${r.exitCode}\n${(r.stdout || r.stderr).trim().slice(0, 1200)}` }
  }).catch(() => ({ deny: 'self-learn: learn_supersede 执行失败（插件内部错误）' }))

  // ---- 每轮提示词：按任务检索相关经验，经 e.context 注入（模型可见、用户不可见） ----
  // 不按 origin 筛：纯续写/机器提示由「内容长度 + rank 严档」自然滤掉，
  // 而 peer/定时任务这类机器来源也常常携带真任务，注入同样有价值。
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const contentLen = e.text.replace(/[\s\p{P}\p{S}]/gu, '').length
    if (contentLen < MIN_CONTENT_CHARS) return next(e)
    const ctx: string[] = []
    if (!composeRan && !protocolInjected) {
      protocolInjected = true
      ctx.push(protocol())
    }
    eligiblePrompts++
    if (consecutiveMisses >= 3 && eligiblePrompts % 3 !== 0) {
      session.throttled++
      if (!ctx.length) return next(e)
      return next({ ...e, context: [...(e.context ?? []), ...ctx] })
    }
    const lessons = await rankContext($, e.text)
    if (lessons) {
      consecutiveMisses = 0
      ctx.push(lessons)
    } else {
      session.misses++
      consecutiveMisses++
    }
    if (!ctx.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...ctx] })
  })

  // ---- 系统提示词：追加自学习协议（session 段，位于缓存边界之后，内容稳定） ----
  on('prompt.compose', async ($, e, next) => {
    composeRan = true
    const r = await next(e)
    return {
      ...r,
      sections: [...r.sections, { id: 'self-learn:protocol', text: protocol(), scope: 'session' as const }],
    }
  })

  // ---- 会话开始：读累计计数，注册工具与 /learn 命令（turn 1 就能看到） ----
  on('session.start', async ($, e, next) => {
    try {
      const override = await $.env.get('SELF_LEARN_LIB')
      if (typeof override === 'string' && override.trim()) {
        libDir = override.trim()
        learnPy = `${libDir}\\tools\\learn.py`
      }
    } catch {
      // 环境读取不可用：保持默认路径
    }
    await loadTotals($)
    await $.tool.register({
      name: 'learn_search',
      // 不进 ToolSearch 的延迟区：这是每次动手前都该顺手查的工具。
      isDeferred: false,
      description:
        '检索公共经验库（目录由环境变量 SELF_LEARN_LIB 指定，所有 Agent 共用）。' +
        '先用严档 rank（标题需命中≥2词），无命中自动退宽档 query。' +
        '动手前查：陌生领域、可能踩过的坑、错误信息。结果是词法检索，查不到可换说法再查。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '任务描述或错误特征（中文关键词效果最好）' },
          limit: { type: 'integer', minimum: 1, maximum: 12, description: '最多返回条数，默认 6' },
        },
        required: ['query'],
      },
    })
    await $.tool.register({
      name: 'learn_add',
      isDeferred: false,
      description:
        '向公共经验库写一条经验（署名固定 claude-code）。' +
        '用于：定案修复了非平凡问题（error）、确认了有效做法（learn）、沉淀了跨项目准则（best_practice）。' +
        '标题必须自带前置条件（「仅当X时：Y」）；正文给判据/读数，3-6 句；写前先 learn_search 查重。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['learn', 'error', 'best_practice'] },
          title: { type: 'string', description: '一句话标题，必须含适用条件（仅当X时：Y）' },
          body: { type: 'string', description: '判据/读数/复现方式，3-6 句，不给形容词' },
        },
        required: ['kind', 'title', 'body'],
      },
    })
    await $.tool.register({
      name: 'learn_supersede',
      isDeferred: false,
      description:
        '把公共经验库里一条已被推翻的旧条目标记为「已被取代」（不删原文，保留审计痕迹）。' +
        '流程：先用 learn_add 写新条目，再用本工具让旧条目指向新标题。仅当确认两条是同一结论的不同说法时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          old: { type: 'string', description: '旧标题的唯一子串（能唯一定位即可）' },
          newTitle: { type: 'string', description: '取代它的新条目全标题' },
          why: { type: 'string', description: '一句话说明为什么被取代（可选）' },
        },
        required: ['old', 'newTitle'],
      },
    })
    await $.command.register({
      name: 'learn',
      description: '查公共经验库：/learn [query|rank|review|status|stats] <关键词>',
      argumentHint: '[query|rank|review|status|stats] [关键词]',
    })
    return next(e)
  })

  // ---- 会话结束：把本会话的计数增量落盘（自进化的反馈信号） ----
  on('session.end', async ($, e, next) => {
    await persistTotals($)
    return next(e)
  })

  // ---- 人看的 /learn：只读；写入口是模型侧工具（保证标题条件与查重） ----
  on('command.run', { command: 'learn' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const kw = rest.join(' ').trim()
    switch (sub) {
      case '':
      case 'status': {
        const r = await runLearn($, ['status'])
        const head = r && r.exitCode === 0 ? r.stdout.trim() : `经验库不可达：${learnPy}`
        return { text: `${head}\n写经验请让 Claude 用 learn_add 工具（标题带前置条件，正文给判据）。` }
      }
      case 'stats': {
        const now = `本会话：rank 调用 ${session.rankCalls}（命中 ${session.rankHits}）· 注入 ${session.injected} 条 · 无命中 ${session.misses} · 降频跳过 ${session.throttled}`
        const tools = `本会话：工具检索 ${session.searches} 次 · 写经验 ${session.adds} 条 · supersede ${session.supersedes} 次 · 失败提醒 ${session.reminders} 次`
        const acc = totals
          ? `累计：加载 ${totals.loads} 次 · 注入 ${totals.injected} 条 · 检索 ${totals.searches} 次 · 写入 ${totals.adds} 条 · supersede ${totals.supersedes} 次 · 提醒 ${totals.reminders} 次（快照 ${totals.updatedAt || '无'}）`
          : '累计：存储不可用'
        return { text: [now, tools, acc].join('\n') }
      }
      case 'review': {
        const r = await runLearn($, ['review'], 15000)
        return { text: r && r.exitCode === 0 ? r.stdout.slice(0, 6000) : '经验库不可达。' }
      }
      case 'query':
      case 'rank': {
        if (!kw) return { text: `用法：/learn ${sub} <关键词>` }
        const args = sub === 'query' ? ['query', kw] : ['rank', kw, '--limit', '8']
        const rows = await runLearnJson<Entry[]>($, args)
        if (rows === undefined) return { text: '经验库不可达，或该说法没有任何命中（词法检索，换说法再试）。' }
        if (!rows.length) return { text: '(无匹配经验)' }
        return {
          text: rows
            .slice(0, 10)
            .map(r => formatEntry(r, 200) + (r.superseded_by ? '  [已取代]' : ''))
            .join('\n'),
        }
      }
      default:
        return { text: '用法：/learn [query|rank|review|status|stats] <关键词>（写经验走模型侧 learn_add）' }
    }
  })
}
