/**
 * storymine 内核的进程封装层。
 *
 * 只做四件事：拼参数、起 python、收 UTF-8 输出、把退出码翻译成事实。
 * 不解析业务文本——内核的输出原样交给模型看。
 *
 * 独立成文件，好处是不用起 DSH 就能单独测（见 smoke/kernel_smoke.mjs）。
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  pythonPath: 'python',
  // 这两个必须由使用者配置，插件不猜任何人的机器。
  // 环境变量 STORYMINE_KERNEL / STORYMINE_DB，或插件 config 里的 kernelPath / dbPath。
  kernelPath: '',
  dbPath: '',
  baseUrl: '',
  model: '',
  /** query 一次塞进模型的条目上限（内核叫 query.max_entries）。越大批数越少、越快，但单次 prompt 越大。 */
  queryMaxEntries: 1200,
  /**
   * query 检索模式：
   *  'two-stage'（默认）第一轮全库只给「手法名+局面」挑候选，第二轮只看候选的完整做法精选；
   *  'single'    老做法：全库每条的完整内容一次性塞进去。
   */
  queryMode: 'two-stage',
  /** 两轮模式第一轮要挑出多少条候选（第二轮从这些里精选） */
  shortlistSize: 20,
  /** query 的模型来源：'auto'（宿主优先，失败回退内核）/ 'host'（只走宿主）/ 'kernel'（只走内核） */
  modelSource: 'auto',
  /** 宿主模式可显式指定，留空则自动取第一个已激活 provider */
  provider: '',
  modelId: '',
  /** 侧栏面板读的「最近几次查询」存档（host 写、client 读） */
  stateFile: join(tmpdir(), 'dsh-storymine', 'history.json'),
}

/** 配置优先级：插件 config > 环境变量 > 默认值 */
export function resolveConfig(config = {}) {
  const pick = (key, env) => config[key] || process.env[env] || DEFAULTS[key]
  return {
    pythonPath: pick('pythonPath', 'STORYMINE_PYTHON'),
    kernelPath: pick('kernelPath', 'STORYMINE_KERNEL'),
    dbPath: pick('dbPath', 'STORYMINE_DB'),
    baseUrl: pick('baseUrl', 'STORYMINE_BASE_URL'),
    model: pick('model', 'STORYMINE_MODEL'),
    queryMaxEntries: Number(config.queryMaxEntries ?? DEFAULTS.queryMaxEntries),
    queryMode: config.queryMode ?? DEFAULTS.queryMode,
    shortlistSize: Number(config.shortlistSize ?? DEFAULTS.shortlistSize),
    modelSource: config.modelSource ?? DEFAULTS.modelSource,
    provider: config.provider ?? DEFAULTS.provider,
    modelId: config.modelId ?? DEFAULTS.modelId,
    stateFile: config.stateFile ?? DEFAULTS.stateFile,
  }
}

/** 缺配置时的报错（比让子进程带着空路径乱跑清楚得多） */
export function requireKernel(cfg) {
  if (!cfg.kernelPath) {
    throw new Error('没配置 storymine 内核路径。设置环境变量 STORYMINE_KERNEL，'
      + '或在插件 config 里写 kernelPath（指到 storymine.py 的绝对路径）。')
  }
  return cfg
}

export function requireDb(cfg) {
  if (!cfg.dbPath) {
    throw new Error('没配置手法库路径。设置环境变量 STORYMINE_DB，'
      + '或在插件 config 里写 dbPath（指到 storymine.db 的绝对路径）。')
  }
  return cfg
}

/**
 * 内核没有 --max-entries 这种参数，只能靠 --config 覆盖整个配置文件。
 * 所以先读内核项目根自己的 config.json（里面可能有渠道/端点/key_env），
 * 在其上合并 query.max_entries，写到系统临时目录再传进去——
 * 不往内核目录里写任何东西。
 */
export function tempConfigWithMaxEntries(cfg, maxEntries) {
  const basePath = join(dirname(cfg.kernelPath), 'config.json')
  let base = {}
  try {
    base = JSON.parse(readFileSync(basePath, 'utf8'))
  } catch { /* 没有 config.json 就走内核默认 */ }
  const merged = {
    ...base,
    query: { ...(base.query ?? {}), max_entries: Number(maxEntries) },
  }
  const p = join(tmpdir(), `dsh-storymine-config-${process.pid}.json`)
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8')
  return p
}

/**
 * 跑一次内核命令。
 * @param cfg   resolveConfig() 的结果
 * @param argv  子命令及其参数，例如 ['stats'] 或 ['query', '我写到…', '-n', '3']
 * @param signal  AbortSignal（工具调用的 exec.signal），触发即 SIGTERM 子进程
 * @returns {{code:number|null, out:string, err:string, aborted:boolean}}
 */
export function runKernel(cfg, argv, signal, opts = {}) {
  return new Promise((resolve, reject) => {
    try { requireKernel(cfg) } catch (e) { reject(e); return }
    const full = [cfg.kernelPath]
    // ⚠️ --db/--base-url/--model/--config 是 argparse 的全局参数，必须排在子命令之前
    if (opts.configPath) full.push('--config', opts.configPath)
    if (cfg.dbPath) full.push('--db', cfg.dbPath)
    if (cfg.baseUrl) full.push('--base-url', cfg.baseUrl)
    if (cfg.model) full.push('--model', cfg.model)
    full.push(...argv)

    let child
    try {
      child = spawn(cfg.pythonPath, full, {
        cwd: dirname(cfg.kernelPath),
        windowsHide: true, // 不加这行，Windows 会给子进程开控制台窗口
        env: {
          ...process.env,
          // 不锁编码，Windows 下 python 走管道时可能吐 GBK，中文全成乱码
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      })
    } catch (e) {
      reject(e)
      return
    }

    let out = ''
    let err = ''
    let aborted = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    const onAbort = () => {
      aborted = true
      try { child.kill('SIGTERM') } catch { /* 已经死了 */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code, out, err, aborted })
    })
  })
}

/**
 * 把一次运行结果翻译成给人看的失败原因。
 * 内核的退出码是唯一硬信号：0 全成功 / 1 有失败 / 3 配额墙。
 */
export function explainFailure(r, what) {
  if (r.aborted) return `${what} 被取消（已停子进程）。`
  if (r.code === 3) return `${what} 撞上配额/额度墙，已停下（已入库的保住了，充上额度原命令重跑即可）。\n${r.err || r.out}`
  return `${what} 退出码 ${r.code}。\n${r.err || r.out}`
}
