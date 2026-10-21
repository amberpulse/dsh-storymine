/**
 * 冒烟：不需要数据库、不需要模型，只验工具定义本身合法。
 *
 * 重点检查每个工具的 parameters 是**原始 JSON Schema**
 * （缺 type:'object' 会让 provider 在发请求时直接拒绝）。
 *
 *   node test/schema-check.mjs
 */
import { apply } from '../index.js'

const defs = {}
const ctx = {
  tools: { register: (d) => { defs[d.name] = d } },
  // 沙箱里没有 webServer：apply 会走「没有 ctx.inject」的分支，只打一行日志
}

apply(ctx, {})

let fail = 0
const check = (ok, label, detail = '') => {
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
}

const names = Object.keys(defs)
check(names.length > 0, `注册了 ${names.length} 个工具`, names.join(', '))

for (const name of names) {
  const def = defs[name]
  const p = def.parameters
  const problems = []

  if (!p || typeof p !== 'object') problems.push('parameters 缺失')
  else {
    if (p.type !== 'object') problems.push(`type=${JSON.stringify(p.type)}（必须是 "object"）`)
    if (!p.properties || typeof p.properties !== 'object') problems.push('缺 properties')
    if (p.additionalProperties === undefined) problems.push('缺 additionalProperties')
    if (p.required !== undefined) {
      if (!Array.isArray(p.required)) problems.push('required 必须是数组')
      else for (const k of p.required) if (!p.properties?.[k]) problems.push(`required 里的 ${k} 不在 properties`)
    }
    for (const [k, v] of Object.entries(p.properties ?? {})) {
      if (!v?.type) problems.push(`字段 ${k} 没有 type`)
      if (v?.type === 'object' && v?.additionalProperties === undefined) {
        problems.push(`字段 ${k} 是对象但没写 additionalProperties`)
      }
    }
  }

  if (!def.description || def.description.length < 10) problems.push('description 太短，模型看不懂该什么时候用')
  if (!def.output?.schema?.type) problems.push('输出 schema 没有 type')
  if (typeof def.output?.render !== 'function') problems.push('输出缺 render')

  check(problems.length === 0, `${name} 定义合法`, problems.join('; '))
}

console.log(fail ? `\n${fail} 项不合格` : '\n全部通过')
process.exitCode = fail ? 1 : 0
