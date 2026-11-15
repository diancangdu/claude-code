import { expect, test } from 'claude-code/testing'

// 测试里 `$` 的调用由下方钩子代答（与 pane.test.tsx 同一个约定）。
const run = (stdout: string) => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const stubRegistrations = (on: any) => {
  // 测试套件需要一个 session.start 的兜底实现（同 pane.test.tsx）。
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
}

// 实测：测试套件给每个用例独立的模块状态（Set/Map 不跨用例），所以顺序无关。
test('prompt.compose 被上游跳过时：协议随首条提示词经 context 补投且只投一次', async ($, on) => {
  stubRegistrations(on)
  on('process.run', () => ({ value: run('[]') })) // rank 无命中
  const seen: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    seen.push(e)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '这是一句足够长的测试任务描述用来触发协议补投' })
  await $.prompt.submit({ text: '再发一条足够长的提示词看看协议不再重复' })

  expect(seen[0].context?.[0]).toContain('自学习协议')
  expect((seen[1].context ?? []).join('')).not.toContain('自学习协议')
})

test('prompt.compose 可达时：协议作为 session 段追加，此后提示词不再补投', async ($, on) => {
  stubRegistrations(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('process.run', () => ({ value: run('[]') }))
  const seen: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    seen.push(e)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const composed: any = await $.prompt.compose({
    model: 'claude-test',
    promptModel: 'claude-test',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  await $.prompt.submit({ text: '这是一句足够长的测试任务描述确认不再补投协议' })

  expect(composed.sections.some((s: any) => s.id === 'self-learn:protocol')).toBe(true)
  expect((seen[0].context ?? []).join('')).not.toContain('自学习协议')
})

test('prompt.submit：rank 命中经 context 注入，同一标题只注入一次', async ($, on) => {
  const rows = [
    {
      kind: 'error',
      date: '2026-11-01 10:00',
      title: '仅当测试注入时：假经验A',
      body: '判据：A',
      author: 'claude-code',
    },
  ]
  on('process.run', (_: unknown, e: any) => ({
    value: run(e.argv.includes('rank') ? JSON.stringify(rows) : '[]'),
  }))
  stubRegistrations(on)
  const seen: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    seen.push(e)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '这是一句足够长的测试任务描述用来触发注入' })
  await $.prompt.submit({ text: '这是一句足够长的测试任务描述用来触发注入' })

  expect(seen.length).toBe(2)
  // 只数"相关经验"块（协议块与它同前缀【共享经验库，用标题里的词区分）
  const rankBlocks = (e: any): any[] =>
    (e.context ?? []).filter((c: string) => c.includes('与本次任务相关'))
  expect(rankBlocks(seen[0]).length).toBe(1)
  expect(rankBlocks(seen[0])[0]).toContain('假经验A')
  // 同一标题已在会话内注入过 → 第二次不再注入
  expect(rankBlocks(seen[1]).length).toBe(0)
})

test('对话性短提示词不触发检索（按去标点的内容字符算）', async ($, on) => {
  stubRegistrations(on)
  let calls = 0
  on('process.run', () => {
    calls++
    return { value: run('[]') }
  })
  const seen: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    seen.push(e)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '好，取消吧。' })

  expect(calls).toBe(0)
  expect((seen[0].context ?? []).length).toBe(0)
})

test('连续 3 条无命中后进入抽样：每 3 条提示词才 rank 一次', async ($, on) => {
  stubRegistrations(on)
  let calls = 0
  on('process.run', (_: unknown, e: any) => {
    if (e.argv.includes('rank')) calls++
    return { value: run('[]') }
  })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 6; i++) {
    await $.prompt.submit({ text: `第${i}条足够长的测试提示词内容用来触发抽样降频` })
  }

  // 第 1、2、3 条各查一次；4、5 降频跳过；第 6 条再查
  expect(calls).toBe(4)
})

test('tool.call：同一错误签名第二次出现时提醒，并附带库里的相关标题', async ($, on) => {
  stubRegistrations(on)
  const row = {
    kind: 'error',
    date: '2026-11-03',
    title: '仅当测试提醒时：假错误经验D',
    body: '判据：D',
    author: 'claude-code',
  }
  on('process.run', (_: unknown, e: any) => ({
    value: run(e.argv.includes('query') ? JSON.stringify([row]) : '[]'),
  }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'same boom error text' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r1: any = await $.tool.call({ tool: 'Bash', command: 'false' })
  const r2: any = await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(r1.context ?? []).toHaveLength(0)
  expect(r2.context?.length).toBe(1)
  expect(r2.context[0]).toContain('同一错误已出现 2 次')
  expect(r2.context[0]).toContain('库里可能有')
  expect(r2.context[0]).toContain('假错误经验D')
})

test('tool.call：不同错误不累计（签名按工具+错误首段区分）', async ($, on) => {
  stubRegistrations(on)
  on('process.run', () => ({ value: run('[]') }))
  let n = 0
  on('tool.call', () => ({ result: {}, isError: true, text: `boom-${++n}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r1: any = await $.tool.call({ tool: 'Bash', command: 'false' })
  const r2: any = await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(r1.context ?? []).toHaveLength(0)
  expect(r2.context ?? []).toHaveLength(0)
})

test('learn_search：rank 空时退 query 并报告 tier=query', async ($, on) => {
  const row = {
    kind: 'best_practice',
    date: '2026-11-02',
    title: '仅当测试检索时：假经验B',
    body: '判据：B',
    author: 'claude-code',
  }
  on('process.run', (_: unknown, e: any) => ({
    value: run(e.argv.includes('rank') ? '[]' : JSON.stringify([row])),
  }))
  stubRegistrations(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const res: any = await $.tool.call({ tool: 'mcp__self-learn__learn_search', query: '测试检索' })
  expect(String(res.result)).toContain('tier=query')
  expect(String(res.result)).toContain('假经验B')
})

test('learn_add：固定署名 --author claude-code，并透传 CLI 的 JSON 结果', async ($, on) => {
  let argv: readonly string[] = []
  on('process.run', (_: unknown, e: any) => {
    argv = e.argv
    return {
      value: run(JSON.stringify({ ok: true, author: 'claude-code', title: '仅当测试时：假经验C' })),
    }
  })
  stubRegistrations(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const res: any = await $.tool.call({
    tool: 'mcp__self-learn__learn_add',
    kind: 'error',
    title: '仅当测试时：假经验C',
    body: '判据：C',
  })
  expect(argv).toContain('--author')
  expect(argv[argv.indexOf('--author') + 1]).toBe('claude-code')
  expect(String(res.result)).toContain('假经验C')
})

test('learn_supersede：argv 形状正确并透传 CLI 输出', async ($, on) => {
  let argv: readonly string[] = []
  on('process.run', (_: unknown, e: any) => {
    argv = e.argv
    return { value: run('{"ok":true}') }
  })
  stubRegistrations(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const res: any = await $.tool.call({
    tool: 'mcp__self-learn__learn_supersede',
    old: '假经验X',
    newTitle: '仅当测试时：假经验X新',
    why: '测试',
  })
  expect(argv).toContain('--old')
  expect(argv).toContain('假经验X')
  expect(argv).toContain('--new')
  expect(String(res.result)).toContain('"ok":true')
})
