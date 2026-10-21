/**
 * query 的「宿主模型」实现。
 *
 * 为什么单独做一份、不走内核：老板要求插件用模型跟着 DSH 的配置走。
 * 内核是 python + curl 自己发请求，读的是自己的 config.json（另一套渠道），
 * 没法吃到 DSH 里激活的 provider/key/模型。所以检索这一步搬到插件侧：
 * 取候选用 node:sqlite（与内核同一张表、同一句 SQL），挑选用 ctx.llm。
 *
 * 内核那份逻辑（PROMPT_QUERY / 分批 / 精选 / 排版）照抄，逐字对齐，
 * 免得两个通道返回的东西长得不一样。
 */
import { DatabaseSync } from 'node:sqlite'

const SQL_BEATS = `
  SELECT b.id, k.title, b.chapter_seq, b.move, b.label, b.how, b.situation
  FROM beats b LEFT JOIN books k ON k.id = b.book_id
  ORDER BY b.id`

const PROMPT_QUERY = (q, n, lib) => `一个写作者卡住了，他的原话：

「${q}」

下面是一个"人类作者叙事手法库"的条目。请从中挑出**最相关的 ${n} 条**，按相关度排序。

对每条说明：**这一招能帮他解决什么**（一句话，别复述条目内容）。

输出 JSON 数组：
[{"id":"编号", "why_usable":"…"}]

只输出 JSON，不要解释。

手法库：
${lib}`

/** 与内核 _llm_pick 的条目行格式一致： [id] 动作:X | 手法:Y | 局面:Z | 做法:W */
const fmtRow = (r) => `[${r.id}] 动作:${r.move} | 手法:${r.label} | 局面:${r.situation} | 做法:${r.how}`

/** 第一轮用的速览行：只留「手法名 + 适用局面」，一条十几字，全库塞得下。 */
const fmtShort = (r) => `[${r.id}] 手法:${r.label} | 局面:${r.situation}`

/**
 * 第一轮（粗筛）的提示词。
 *
 * 为什么单独一轮：全库 873 条时，把每条的「做法」全塞进去约 7 万 token，模型注意力被稀释，
 * 而且库越大越慢。这一轮只给速览（手法名 + 局面），让它按「局面是不是同一类问题」挑候选；
 * 第二轮再让模型只看候选的完整做法做精选。召回看第一轮的全库覆盖，精度看第二轮的聚焦。
 */
const PROMPT_SHORTLIST = (q, k, lib) => `一个写作者卡住了，他的原话：

「${q}」

下面是「人类作者叙事手法库」的条目速览（只有手法名和适用局面，没有具体做法）。
请挑出**最可能帮到他**的 ${k} 条，只给编号，按相关度排序。

判断依据：这条手法适用的局面，是否和他的处境属于同一类问题。

输出 JSON 数组：
[{"id":"编号"}]

只输出 JSON，不要解释。

条目速览：
${lib}`

/** 容错解析：模型偶尔带前后废话，先试整体 JSON，再逐个截 {...} 段。 */
export function parsePicks(text) {
  const s = String(text ?? '').trim()
  const grab = (t) => {
    const out = []
    for (const seg of t.match(/\{[^{}]*\}/g) ?? []) {
      try {
        const o = JSON.parse(seg)
        if (o && o.id !== undefined) out.push(o)
      } catch { /* 跳过坏片段 */ }
    }
    return out
  }
  try {
    const arr = JSON.parse(s)
    if (Array.isArray(arr)) return arr.filter((o) => o && o.id !== undefined)
  } catch { /* 往下走容错 */ }
  // 模型常把数组包在 ```json 里
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      const arr = JSON.parse(fenced[1])
      if (Array.isArray(arr)) return arr.filter((o) => o && o.id !== undefined)
    } catch { /* 继续 */ }
  }
  return grab(s)
}

/** 读库取全部候选（只读打开，不建表不写盘） */
export function loadBeats(dbPath) {
  if (!dbPath) {
    throw new Error('没配置手法库路径。设置环境变量 STORYMINE_DB，或在插件 config 里写 dbPath。')
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(SQL_BEATS).all()
  } finally {
    db.close()
  }
}

/** 按 maxEntries 切批——与内核一致：库大了必须全覆盖，不能只取尾巴 */
export function splitBatches(rows, maxEntries) {
  const size = Math.max(1, Number(maxEntries) || 400)
  const out = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * 解析出「用哪个 provider / model」。
 * 实测（2026-10-20）：listProviders() 返回 [{id,name}]，且**没配模型的 provider 会返回空目录**
 * （deepseek-official / deepseek-account 都可能 0 个模型）。所以不能盲取第一个，
 * 必须挨个问 listModels，取第一个真有模型的。
 */
export async function pickTarget(ctx, cfg) {
  const norm = (p) => (typeof p === 'string' ? p : (p.id ?? p.provider ?? p.name))
  const firstModelOf = async (id) => {
    const models = (await ctx.llm.listModels?.(id)) ?? []
    const m = models[0]
    if (!m) return null
    return typeof m === 'string' ? m : m.id
  }

  if (cfg.provider && cfg.modelId) return { provider: cfg.provider, model: cfg.modelId }

  // 最贴近「跟着 DSH 走」的一步：问 agentDefaultModel 服务当前选的是哪个模型。
  // 不 inject 它（否则服务缺失时整个插件会卡在 PENDING），用 ctx.get 在使用点探一下，
  // 任何异常都当"读不到"处理。
  if (!cfg.provider && !cfg.modelId) {
    try {
      const dm = ctx.get?.('agentDefaultModel')
      const sel = dm?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch { /* 没有这个服务 / 读不到，继续往下 */ }
  }
  if (cfg.provider) {
    const m = cfg.modelId || (await firstModelOf(cfg.provider))
    if (!m) throw new Error(`provider ${cfg.provider} 没报出任何模型`)
    return { provider: cfg.provider, model: m }
  }

  const providers = ctx.llm.listProviders?.() ?? []
  const ids = providers.map(norm).filter(Boolean)
  if (!ids.length) throw new Error('宿主没有已激活的模型提供方（llm.listProviders() 为空）')
  for (const id of ids) {
    if (cfg.modelId) return { provider: id, model: cfg.modelId }
    const m = await firstModelOf(id)
    if (m) return { provider: id, model: m }
  }
  throw new Error(`宿主没有可用模型（${ids.join(' / ')} 都没报出模型）`)
}

/** 一次模型调用，返回文本。分片结构按 dsh-llm 的约定（text-delta），并容几种变体。 */
export async function callHostModel(ctx, { provider, model, prompt, signal }) {
  const parts = []
  const stream = ctx.llm.stream({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })
  for await (const chunk of stream) {
    if (signal?.aborted) break
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') parts.push(chunk.text ?? chunk.delta?.text ?? '')
    else if (chunk.type === 'finish') {
      // 实测形状：{ type:'finish', reason:{ kind:'error', failure:{ code, message } } }
      const kind = chunk.reason?.kind ?? chunk.kind
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason?.failure ?? chunk.failure ?? {}
        throw new Error(`模型调用失败：${f.code ?? kind}${f.message ? ' — ' + f.message : ''}`)
      }
    }
  }
  const text = parts.join('')
  if (!text.trim()) throw new Error('模型返回了空文本')
  return text
}

/** 从一批候选里让模型挑 n 条 */
async function pickFromBatch(ctx, target, rows, q, n, signal) {
  const lib = rows.map(fmtRow).join('\n')
  const text = await callHostModel(ctx, { ...target, prompt: PROMPT_QUERY(q, n, lib), signal })
  return parsePicks(text)
}

/** 第一轮：只看速览（手法名 + 局面）挑候选编号 */
async function shortlistFromBatch(ctx, target, rows, q, k, signal) {
  const lib = rows.map(fmtShort).join('\n')
  const text = await callHostModel(ctx, { ...target, prompt: PROMPT_SHORTLIST(q, k, lib), signal })
  return parsePicks(text).map((p) => Number(p.id)).filter((x) => Number.isFinite(x))
}

/**
 * 主流程。返回渲染好的文本（与内核输出同构）。
 * @throws 当宿主模型不可用 / 调用失败——交给调用方回退内核通道
 */
export async function hostQuery(ctx, cfg, { situation, n = 5, maxEntries, signal }) {
  const t0 = Date.now()
  const target = await pickTarget(ctx, cfg)
  const rows = loadBeats(cfg.dbPath)
  if (!rows.length) throw new Error(`库是空的：${cfg.dbPath}`)

  const batches = splitBatches(rows, maxEntries ?? cfg.queryMaxEntries)
  const idx = new Map(rows.map((r) => [r.id, r]))
  const seen = new Set()
  const cands = []

  // ── 选检索模式 ─────────────────────────────────────────────
  //  two-stage：第一轮全库速览挑候选 → 第二轮只看候选的完整做法精选
  //  single   ：老做法，全库每条完整内容一次性塞进去
  let picked = []          // [[row, why], ...]
  let shortlisted = 0
  const emptyResult = (why) => ({
    text: `「${situation}」——${why}\n（模型：${target.provider}/${target.model}）`,
    situation,
    model: `${target.provider}/${target.model}`,
    at: new Date().toISOString(),
    items: [],
  })

  if (cfg.queryMode === 'single') {
    const cands = []
    const seen = new Set()
    for (const batch of batches) {
      if (signal?.aborted) break
      for (const p of await pickFromBatch(ctx, target, batch, situation, n, signal)) {
        const id = Number(p.id)
        if (idx.has(id) && !seen.has(id)) {
          seen.add(id)
          cands.push([idx.get(id), p.why_usable ?? ''])
        }
      }
    }
    if (!cands.length) return emptyResult('模型一条都没挑出来。换个说法再试，或者这批内容库太偏。')
    picked = cands.slice(0, n)
    if (batches.length > 1 && cands.length > n) {
      const second = await pickFromBatch(ctx, target, cands.map(([r]) => r), situation, n, signal)
      const whyOf = new Map(cands.map(([r, why]) => [r.id, why]))
      const chosen = second.map((p) => Number(p.id)).map((id) => idx.get(id)).filter(Boolean)
      if (chosen.length) {
        picked = chosen.map((r) => [r, second.find((p) => Number(p.id) === r.id)?.why_usable ?? whyOf.get(r.id) ?? ''])
      }
    }
  } else {
    // 第一轮：全库速览，分批扫（库大了也要全覆盖）
    const shortIds = []
    const seen = new Set()
    const cap = Math.max(n, cfg.shortlistSize) * 2
    for (const batch of batches) {
      if (signal?.aborted || shortIds.length >= cap) break
      const ids = await shortlistFromBatch(ctx, target, batch, situation, cfg.shortlistSize, signal)
      for (const id of ids) {
        if (idx.has(id) && !seen.has(id)) {
          seen.add(id)
          shortIds.push(id)
        }
        if (shortIds.length >= cap) break
      }
    }
    shortlisted = shortIds.length
    if (!shortlisted) return emptyResult('第一轮在全库速览里没挑出候选。换个说法再试。')

    // 第二轮：只看候选的完整做法（含 how），做最终精选并写「为什么能用」
    const shortRows = shortIds.map((id) => idx.get(id))
    const second = await pickFromBatch(ctx, target, shortRows, situation, n, signal)
    picked = second
      .map((p) => [idx.get(Number(p.id)), p.why_usable ?? ''])
      .filter(([r]) => Boolean(r))
    // 第二轮挑空了就用候选原序补位——总比什么都不给强
    if (!picked.length) picked = shortRows.slice(0, n).map((r) => [r, ''])
  }

  const lines = [`「${situation}」`, '─'.repeat(68)]
  picked.forEach(([r, why], i) => {
    const src = r.title ? `${r.title}·第${r.chapter_seq}章` : `第${r.chapter_seq}章`
    lines.push(`\n${i + 1}. 「${r.label}」〔${r.move}〕   ← ${src}`)
    lines.push(`   做法：${r.how}`)
    if (why) lines.push(`   为什么能用在你这里：${why}`)
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  lines.push(`\n（模型：${target.provider}/${target.model} · 全库 ${rows.length} 条 / ${batches.length} 批 · ${secs}s）`)

  return {
    text: lines.join('\n'),
    situation,
    model: `${target.provider}/${target.model}`,
    at: new Date().toISOString(),
    elapsedSec: Number(secs),
    scanned: rows.length,
    batches: batches.length,
    // 两轮模式第一轮挑出多少候选（单轮模式为 0）
    shortlisted,
    items: picked.map(([r, why]) => ({
      id: r.id,
      label: r.label,
      move: r.move,
      how: r.how,
      why,
      source: r.title ? `${r.title}·第${r.chapter_seq}章` : `第${r.chapter_seq}章`,
    })),
  }
}
