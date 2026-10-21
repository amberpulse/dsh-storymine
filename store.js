/**
 * 最近几次查询的环形存档。
 *
 * 侧栏面板拿不到工具返回值（它在 host 进程里），所以工具执行完把结果丢进这里，
 * client 半边再通过 /storymine/api/history 读走。
 *
 * 每条都记 sessionId（工具执行时从 exec.agent.id 取，形如 session-xxxx），
 * 这样面板可以只看当前会话的记录，也能按会话清空。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function createStore({ limit = 30, file } = {}) {
  const entries = []
  let seq = 0

  if (file) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(j.entries)) {
        entries.push(...j.entries.slice(0, limit))
        seq = entries.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0)
      }
    } catch { /* 第一次跑没有文件，正常 */ }
  }

  const persist = () => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ entries }, null, 1), 'utf8')
    } catch { /* 写不进去不影响工具本身 */ }
  }

  return {
    add(entry) {
      seq += 1
      entries.unshift({ ...entry, seq })
      if (entries.length > limit) entries.length = limit
      persist()
      return seq
    },
    /**
     * @param sessionId 传了就只返回该会话的记录。
     * 没有 sessionId 的老记录（加这个字段之前写入的）在按会话看时也保留——
     * 否则升级一次以后，之前的记录会突然从面板里消失。
     */
    list(sessionId) {
      if (!sessionId) return entries
      return entries.filter((e) => e.sessionId === sessionId || !e.sessionId)
    },
    latest(sessionId) {
      const l = sessionId ? entries.find((e) => e.sessionId === sessionId) : entries[0]
      return l ?? null
    },
    /** 清空：给了 sessionId 只清那个会话，否则全清。返回删掉的条数。 */
    clear(sessionId) {
      const before = entries.length
      if (sessionId) {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].sessionId === sessionId) entries.splice(i, 1)
        }
      } else {
        entries.length = 0
      }
      persist()
      return before - entries.length
    },
    size() { return entries.length },
  }
}
