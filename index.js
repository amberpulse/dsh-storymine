/**
 * dsh-storymine
 *
 * 六个工具，对应内核六条命令：
 *   storymine_query     → query      （最高频：写作卡住时找招；走 DSH 宿主模型）
 *   storymine_stats     → stats      （家底）
 *   storymine_list      → list       （按动作浏览）
 *   storymine_failures  → failures   （失败/可疑的章）
 *   storymine_extract   → extract    （灌书，长任务，可取消）
 *   storymine_delete    → delete     （危险，默认只预览）
 *
 * 两条必须记住的规矩：
 *
 * 1. 不 import 任何 @deepseek-ai/* —— 安装版里没有祖先 node_modules，
 *    import 会 ERR_MODULE_NOT_FOUND；defineTool 只是类型糖，裸对象照样注册。
 *
 * 2. 裸对象注册 = 注册**原始 JSON Schema**，不是 DSH 自家的简写 DSL，也不是
 *    defineTool 那种 `{ key: { type, required } }`。parameters 必须是完整的
 *    `{ type: 'object', properties, required, additionalProperties }`，
 *    少了 `type: 'object'`，provider 会在发请求时报
 *    "schema must be a JSON Schema of type object, got type null"。
 *    另外既然绕过了 defineTool，**参数校验也得自己来**（见 need/optNum）。
 */
import { resolveConfig, runKernel, tempConfigWithMaxEntries, DEFAULTS } from './kernel.js'
import { hostQuery } from './query.js'
import { createStore } from './store.js'

export const name = 'storymine'
// 'llm' 是 query 走宿主模型必需的：不写进 inject，访问 ctx.llm 会直接报
// cannot get property "llm" without inject。
export const inject = ['tools', 'llm']

const textOut = (value) => [{ type: 'text', text: String(value ?? '') }]

/** 工具执行时从 exec 里取会话身份（实测：exec.agent.id 形如 session-xxxx） */
const sessionOf = (exec) => {
  try { return exec?.agent?.id ?? exec?.agent?.session?.id ?? null } catch { return null }
}

/** 按某个字段计数，用来给模型做「动作分布」播报 */
const tally = (items, key) => {
  const out = {}
  for (const it of items ?? []) {
    const k = String(it?.[key] ?? '').trim()
    if (!k) continue
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** 读请求体 JSON（带大小上限，别让人用超长 body 打爆内存） */
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('body 太大'))
        try { req.destroy() } catch { /* 忽略 */ }
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('body 不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 构造原始 JSON Schema 对象节点（显式节点必须声明 additionalProperties） */
const obj = (properties = {}, required = [], description) => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

/** 必填字符串参数校验（绕过 defineTool 后自己兜底） */
function need(args, key, label) {
  const v = args?.[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`缺少必填参数 ${key}（${label}）`)
  }
  return v.trim()
}

/** 可选数字参数 */
function optNum(args, key) {
  const v = args?.[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`参数 ${key} 必须是数字，收到 ${JSON.stringify(v)}`)
  return n
}

/** 长输出保留头尾——模型不需要看三千行进度条，但要知道发生了什么。 */
function clip(s, head = 3000, tail = 6000) {
  const t = (s ?? '').trim()
  if (t.length <= head + tail) return t
  return `${t.slice(0, head)}\n\n…（中间省略 ${t.length - head - tail} 字）…\n\n${t.slice(-tail)}`
}

/**
 * 统一的结果策略（对应 dsh 工具约定：不理想的状态写进规范值，异常只留给基础设施故障）：
 *   - 退出码 0            → 原样返回输出
 *   - 非 0 但有输出        → 返回输出 + 醒目说明（有章失败 / 没匹配到 / 配额墙 都是信息，不是崩溃）
 *   - 非 0 且没输出        → 抛错（这才是真崩了）
 *   - 被取消              → 返回已收到的部分
 */
function compose(label, r) {
  const body = clip(r.out)
  if (r.aborted) return `（${label} 被取消，下面是取消前已产出的部分）\n${body}`
  if (r.code === 0) return body
  const err = r.err.trim()
  if (!body && !err) throw new Error(`${label} 退出码 ${r.code}，且没有任何输出。`)
  const why = r.code === 3
    ? '配额/额度墙 —— 别重试，已入库的保住了；充上额度后用原命令续跑。'
    : '有失败或没匹配到结果，不是崩溃。'
  return `⚠️ ${label} 退出码 ${r.code}：${why}\n${body}${err ? `\n\n[stderr]\n${err}` : ''}`
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? {})
  const register = (def) => ctx.tools.register(def)
  const out = { schema: { type: 'string' }, render: (_a, v) => textOut(v) }

  // 最近几次查询的存档：工具写，侧栏面板读
  const store = createStore({ file: cfg.stateFile })
  // 浏览器半边的报到计数（诊断用）
  let pings = 0

  // ── 只读 JSON 接口，给浏览器半边的 tab 面板用 ─────────────────────────
  // 用 ctx.inject 开一个**子插件**去等 webServer：
  // 直接 inject 进主插件会让它依赖 webServer，而 headless 组合里没有这个服务，
  // 插件就永远 PENDING、工具也跟着没了。子插件等不到服务时只影响侧栏面板，
  // 工具本身照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const json = (res, code, body) => {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(body))
      }
      sub.effect(() => sub.webServer.register({
        kind: 'prefix',
        path: '/storymine/api',
        handler: async (req, res) => {
          try {
            const u = new URL(req.url ?? '/', 'http://dsh.internal')
            const pathname = u.pathname
            const method = pathname.startsWith('/storymine/api/')
              ? pathname.slice('/storymine/api/'.length)
              : ''
            const sid = u.searchParams.get('session') || undefined
              // 面板输入框直接查询：不经过主对话，结果只进本面板 → 正文一行都不占
              if (method === 'ask') {
                if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'ask 要用 POST' })
                let body
                try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { ok: false, error: String(e.message) }) }
                const situation = String(body.situation ?? '').trim()
                if (!situation) return json(res, 400, { ok: false, error: 'situation 不能为空' })
                const n = Math.min(Math.max(Number(body.n) || 5, 1), 20)
                // 允许调用方临时指定检索模式（方便单轮/两轮对比）
                const mode = body.queryMode === 'single' || body.queryMode === 'two-stage'
                  ? body.queryMode
                  : cfg.queryMode
                const askSid = body.sessionId ? String(body.sessionId) : undefined
                try {
                  // 强制走宿主模型：面板查询不该退到内核（那条要跑好几分钟）
                  const res0 = await hostQuery(ctx, { ...cfg, modelSource: 'host', queryMode: mode }, {
                    situation, n, maxEntries: cfg.queryMaxEntries, signal: undefined,
                  })
                  store.add({
                    kind: 'host',
                    sessionId: askSid ?? null,
                    situation,
                    at: res0.at,
                    model: res0.model,
                    items: res0.items,
                    elapsedSec: res0.elapsedSec,
                    scanned: res0.scanned,
                    shortlisted: res0.shortlisted,
                    via: 'panel',
                  })
                  return json(res, 200, { ok: true, count: res0.items.length, entry: store.latest(askSid) })
                } catch (e) {
                  return json(res, 500, { ok: false, error: String(e && e.message) })
                }
              }
              if (method === 'clear') {
                if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'clear 要用 POST' })
                const removed = store.clear(sid)
                return json(res, 200, { ok: true, removed, left: store.size() })
              }
              if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
              if (method === 'history') return json(res, 200, { ok: true, entries: store.list(sid), total: store.size(), scoped: Boolean(sid) })
              if (method === 'latest') return json(res, 200, { ok: true, entry: store.latest(sid) })
              // 浏览器半边的「报到」端点：client 插件一执行就敲一下，
              // 用来远程判断桌面版到底有没有加载浏览器半边。
              if (method === 'ping') {
                pings += 1
                console.log(`[storymine] client 报到 #${pings}`)
                return json(res, 200, { ok: true, pings })
              }
              return json(res, 404, { ok: false, error: `unknown method "${method}"` })
          } catch (e) {
            json(res, 500, { ok: false, error: String(e && e.message) })
          }
        },
      }), 'storymine: /storymine/api')
      console.log('[storymine] /storymine/api 已挂上（侧栏面板可以读了）')
    })
  } else {
    console.log('[storymine] 这个 Cordis 没有 ctx.inject：侧栏面板读不到数据，工具照常可用')
  }

  register({
    name: 'storymine_query',
    description:
      '在叙事手法库里找「别人怎么写这一段」的招数。传入**一句处境描述**（“我写到角色刚摊牌、下一拍该不该收”），'
      + '不要贴整段正文——上下文越长检索越偏。'
      + '\n\n条目会**自动推送到右侧「storymine 手法库」面板**，你这里只会拿到数量与动作分布，拿不到条目正文。'
      + '\n\n所以回答时：**不要在正文里罗列任何条目**。用一两句话说明已推送多少条、可按哪些动作标签翻；'
      + '如果合适，再主动提议下一步（例如用这些素材帮用户把这一章/这一段的节拍排出来，每拍标好字数）。'
      + '\n\n如果工具报错或没查到，如实说明，不要用自己记忆里的通用套路冒充库内容。',
    parameters: obj({
      situation: { type: 'string', description: '一句处境描述，不是正文原文' },
      n: { type: 'number', description: '要几条，默认 5' },
      max_entries: {
        type: 'number',
        description: '一次塞进模型的条目上限，默认 1200。库大起来后查询变慢就调大（批数变少、调用变少），prompt 想省就调小',
      },
    }, ['situation']),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          moves: { type: 'object', additionalProperties: true },
        },
      },
      // 只给模型「推送播报」，不给条目正文 —— 条目只在右侧面板里
      render: (_a, v) => {
        if (v && v.note === 'kernel') {
          return textOut('结果已推送到右侧「storymine 手法库」面板（这次走的是内核通道，面板里是文本形式）。'
            + '不要在正文复述内容，用一两句话说明已推送即可。')
        }
        const count = Number(v && v.count) || 0
        if (!count) {
          return textOut('这次没查到可用的条目（库是空的 / 模型一条都没挑出来）。如实告诉用户，不要编。')
        }
        const moves = Object.entries((v && v.moves) || {})
          .filter(([, c]) => c)
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => `${k} ${c}`)
          .join(' / ')
        return textOut(
          `已把 ${count} 条手法推送到右侧「storymine 手法库」面板${moves ? `（按动作：${moves}）` : ''}。\n\n`
          + '不要在正文里罗列条目内容。用一两句话说明已推送、告诉用户可以在面板按动作标签翻；'
          + '如果合适，再主动提议下一步（比如用这些素材帮他把这一章/这一段的节拍排出来，每拍标好字数）。',
        )
      },
    },
    async execute(args, exec) {
      const situation = need(args, 'situation', '一句处境描述')
      const n = optNum(args, 'n') ?? 5
      const maxEntries = optNum(args, 'max_entries') ?? cfg.queryMaxEntries

      // 一次性探测：exec 里到底有没有会话身份（决定记录能不能按会话分区）
      if (!apply.__execProbed) {
        apply.__execProbed = true
        try {
          console.log('[storymine] exec keys:', Object.keys(exec).join(','))
          const ag = exec.agent
          console.log('[storymine] exec.agent keys:', ag ? Object.keys(ag).join(',') : '(no agent)')
          if (ag) {
            console.log('[storymine] agent.sessionId =', ag.sessionId ?? '(none)',
              '| agent.id =', ag.id ?? '(none)')
          }
        } catch (e) { console.log('[storymine] exec 探测失败:', e && e.message) }
      }

      // 宿主模型优先：跟着 DSH 里激活的 provider / 模型走
      if (cfg.modelSource !== 'kernel') {
        try {
          const res = await hostQuery(ctx, cfg, { situation, n, maxEntries, signal: exec.signal })
          store.add({
            kind: 'host',
            sessionId: sessionOf(exec),
            situation,
            at: res.at,
            model: res.model,
            items: res.items,
            elapsedSec: res.elapsedSec,
            scanned: res.scanned,
          })
          return { count: res.items.length, moves: tally(res.items, 'move') }
        } catch (e) {
          if (cfg.modelSource === 'host') {
            throw new Error(`宿主模型通道失败：${e.message}\n（要改走内核自己的渠道，把插件配置 modelSource 设成 "kernel"）`)
          }
          console.log(`[storymine] 宿主通道不可用，回退内核通道：${e.message}`)
        }
      }

      const argv = ['query', situation]
      if (optNum(args, 'n') !== undefined) argv.push('-n', String(n))
      const kernelOpts = maxEntries !== DEFAULTS.queryMaxEntries
        ? { configPath: tempConfigWithMaxEntries(cfg, maxEntries) }
        : {}
      const r = await runKernel(cfg, argv, exec.signal, kernelOpts)
      const text = compose('storymine query', r)
      // 内核通道只有纯文本，侧栏面板拿不到结构化条目——照样记一条，让面板
      // 至少能显示「问了什么、什么时候、走的哪条通道」。
      store.add({ kind: 'kernel', sessionId: sessionOf(exec), situation, at: new Date().toISOString(), model: `kernel/${cfg.model || 'default'}`, items: [], text })
      return { note: 'kernel' }
    },
  })

  register({
    name: 'storymine_stats',
    description:
      '叙事手法库的家底：几本书、几条动作、动作分布、手法名频次、各书提取进度、未解决的失败。'
      + '引用「库里有什么」之前先跑它，比凭印象答靠谱。',
    parameters: obj(),
    output: out,
    async execute(_args, exec) {
      const r = await runKernel(cfg, ['stats'], exec.signal)
      return compose('storymine stats', r)
    },
  })

  register({
    name: 'storymine_list',
    description: '按叙事动作分组浏览整张手法表（引入/升级/反转/揭露…）。想看全貌或按动作找时用。',
    parameters: obj(),
    output: out,
    async execute(_args, exec) {
      const r = await runKernel(cfg, ['list'], exec.signal)
      return compose('storymine list', r)
    },
  })

  register({
    name: 'storymine_failures',
    description: '列出提取失败或切分可疑的章（含失败类型）。extract 报非零退出码之后先跑这个。',
    parameters: obj(),
    output: out,
    async execute(_args, exec) {
      const r = await runKernel(cfg, ['failures'], exec.signal)
      return compose('storymine failures', r)
    },
  })

  register({
    name: 'storymine_extract',
    description:
      '把一本 txt 小说逐章提取成叙事动作入库。**慢**（约 50–75 秒/章），必须分批（5 章一批），'
      + '中断后原命令重跑会接着跑（已入库的章自动跳过）。'
      + '退出码 3 = 配额墙，别重试；退出码 1 = 有章失败，用 storymine_failures 看是哪几章。'
      + '切分可疑（一章都切不出来 / 短章占比高）不要自己写脚本绕过，改用 pattern 重切或 skip 忽略。',
    parameters: obj({
      input: { type: 'string', description: 'txt 文件或目录的绝对路径' },
      chapters: { type: 'string', description: '章范围，如 "1-5"（默认全部）。分批跑时必填' },
      force: { type: 'boolean', description: '重跑已入库的章' },
      pattern: { type: 'string', description: '自定义章标题正则（切分失败时重切用）' },
      skip: { type: 'boolean', description: '切分可疑时静默跳过这一本' },
    }, ['input']),
    output: out,
    async execute(args, exec) {
      const input = need(args, 'input', 'txt 文件或目录的绝对路径')
      const argv = ['extract', input]
      if (args.chapters) argv.push('--chapters', String(args.chapters))
      if (args.force) argv.push('--force')
      if (args.pattern) argv.push('--pattern', String(args.pattern))
      if (args.skip) argv.push('--skip')
      const r = await runKernel(cfg, argv, exec.signal)
      return compose('storymine extract', r)
    },
  })

  register({
    name: 'storymine_delete',
    description:
      '从库里删条目。**默认只预览不删**——先去掉 confirm 跑一次，把预览给用户看过，得到明确同意再把 confirm 设 true。'
      + '内核自带三道闸：裸跑只预览、执行前自动备份、删完对账。',
    parameters: obj({
      book: { type: 'string', description: '书名（模糊匹配）' },
      chapters: { type: 'string', description: '章范围，如 "30-35"（须配合 book）' },
      before: { type: 'string', description: '入库时间早于，如 "2026-10-15"' },
      after: { type: 'string', description: '入库时间晚于' },
      confirm: { type: 'boolean', description: '真删。必须用户明确同意后才设 true' },
    }),
    output: out,
    async execute(args, exec) {
      const argv = ['delete']
      if (args.book) argv.push('--book', String(args.book))
      if (args.chapters) argv.push('--chapters', String(args.chapters))
      if (args.before) argv.push('--before', String(args.before))
      if (args.after) argv.push('--after', String(args.after))
      if (args.confirm) argv.push('--yes')
      const r = await runKernel(cfg, argv, exec.signal)
      return compose('storymine delete', r)
    },
  })

  console.log(`[storymine] 6 tools registered (db=${cfg.dbPath})`)
}
