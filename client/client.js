/**
 * dsh-storymine · 浏览器半（面板 v3：按会话分区 + 清理 + 分页）
 *
 * 手写、零构建：DSH 的 client bundle 就是
 *   window.__ModuleLoader__.load({ id, factory(require) })
 * 注册的工厂，require 由宿主提供。
 *
 * 配方来自 ChenRuoT/dsh-sidebar-qa（MIT）。四条硬规则：
 *  1. `guide` 是数组 [{id, order, title, description}]，写成对象会让整个 entry 激活失败。
 *  2. 三个席位都要注册：类型 / sidebar.right.pane.tab / sidebar.right.pane.tab.title。
 *  3. `slots` / `sidebarRightTabs` / `sidebarRight` 用 ctx.get 探测，**不要 inject**；
 *     而且服务可能晚于插件就绪，要重试（桌面版实测差了半秒，探一次就放弃=白屏没入口）。
 *  4. 数据走 host 的 HTTP 接口，不从工具返回值拿。
 */
window.__ModuleLoader__.load({
  id: 'dsh-storymine',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const TYPE_ID = 'dsh-storymine#cards'
    const KIND = 'storymine'
    const PAGE = 8 // 一次渲染多少条记录，剩下的点「更多」

    const inject = ['sessions', 'remote', 'remote.session', 'workspaces']

    const fmtTime = (iso) => {
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch { return '' }
    }

    const muted = (text, size = 11) => h('div', {
      style: { opacity: 0.55, fontSize: `${size}px`, marginTop: '2px' },
    }, text)

    const btn = (label, onClick, opts = {}) => h('button', {
      onClick,
      style: {
        fontSize: '11px', padding: '3px 8px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'inherit', opacity: opts.dim ? 0.6 : 1, marginLeft: '6px',
      },
    }, label)

    function ItemCard(it, idx) {
      return h('div', {
        key: String(it.id ?? idx),
        style: {
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))', borderRadius: '8px',
          padding: '10px 12px', marginBottom: '8px',
        },
      },
      h('div', { key: 'head', style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
        h('span', { key: 'l', style: { fontWeight: 600 } }, `「${it.label}」`),
        h('span', { key: 'm', style: { opacity: 0.55, fontSize: '11px' } }, `〔${it.move}〕`)),
      h('div', { key: 'src', style: { opacity: 0.5, fontSize: '11px', marginTop: '2px' } }, `← ${it.source}`),
      h('div', { key: 'how', style: { marginTop: '6px', fontSize: '12px', lineHeight: 1.55 } }, it.how),
      it.why ? h('div', { key: 'why', style: { marginTop: '6px', fontSize: '12px', lineHeight: 1.55, opacity: 0.85 } },
        h('span', { style: { opacity: 0.6 } }, '为什么能用：'), it.why) : null)
    }

    /** 把一次查询的条目按「动作」分组，组头显示动作名 + 条数（老板要的"按动作标签翻"） */
    function renderGroups(items) {
      const groups = new Map()
      for (const it of items) {
        const key = String(it.move ?? '').trim() || '其他'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(it)
      }
      const out = []
      for (const [move, list] of groups) {
        out.push(h('div', {
          key: 'g-' + move,
          style: {
            fontSize: '11px', opacity: 0.6, margin: '10px 0 6px',
            borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
            paddingTop: '6px',
          },
        }, `${move} · ${list.length} 条`))
        for (const it of list) out.push(ItemCard(it, out.length))
      }
      return out
    }

    function EntryBlock(entry) {
      return h('div', { key: String(entry.seq), style: { marginBottom: '18px' } },
        h('div', {
          style: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', opacity: 0.6, marginBottom: '6px' },
        },
        h('span', { key: 'q', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `「${entry.situation}」`),
        h('span', { key: 't', style: { flexShrink: 0 } }, fmtTime(entry.at))),
        (entry.items && entry.items.length)
          ? renderGroups(entry.items)
          : h('div', {
            style: {
              fontSize: '12px', opacity: 0.7, whiteSpace: 'pre-wrap', lineHeight: 1.6,
              border: '1px dashed rgba(127,127,127,0.35)', borderRadius: '8px', padding: '10px',
            },
          }, entry.text ? entry.text.slice(0, 900) : '（这次没有结构化条目）'),
        muted(`${entry.model ?? ''}${entry.elapsedSec ? ` · ${entry.elapsedSec}s` : ''}`
          + `${entry.scanned ? ` · 全库 ${entry.scanned} 条` : ''}`
          + `${entry.shortlisted ? ` · 候选 ${entry.shortlisted}` : ''}`
          + `${entry.kind === 'kernel' ? ' · 内核通道' : ''}`))
    }

    function CardsBody(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : null
      const [scope, setScope] = React.useState('session') // 'session' | 'all'
      const [shown, setShown] = React.useState(PAGE)
      const [state, setState] = React.useState({ loading: true, entries: [], total: 0, error: null })
      const [busy, setBusy] = React.useState(false)
      // 面板自带输入框：直接查，不经过主对话 → 正文一行都不占
      const [text, setText] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [askErr, setAskErr] = React.useState(null)
      const [hover, setHover] = React.useState(false)

      const qs = sessionId && scope === 'session' ? `?session=${encodeURIComponent(sessionId)}` : ''
      const endpoint = `/storymine/api/history${qs}`

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(endpoint, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const j = await res.json()
          setState({ loading: false, entries: j.entries ?? [], total: j.total ?? 0, error: null })
        } catch (e) {
          setState((s) => ({ ...s, loading: false, error: String(e && e.message) }))
        }
      }, [endpoint])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => { setShown(PAGE) }, [scope, sessionId])

      const clear = async () => {
        setBusy(true)
        try {
          await fetch(`/storymine/api/clear${qs}`, { method: 'POST', credentials: 'same-origin' })
          await load()
        } finally { setBusy(false) }
      }

      const submit = async () => {
        const situation = text.trim()
        if (!situation || sending) return
        setSending(true)
        setAskErr(null)
        try {
          const res = await fetch('/storymine/api/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ situation, n: 5, sessionId }),
          })
          const j = await res.json()
          if (!j.ok) throw new Error(j.error || '查询失败')
          setText('')
          if (scope === 'all') setScope('session')
          await load()
        } catch (e) {
          setAskErr(String((e && e.message) || e))
        } finally { setSending(false) }
      }

      const canScope = Boolean(sessionId)
      const head = h('div', {
        key: 'head',
        style: { padding: '12px 16px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
        h('span', { style: { fontSize: '13px', fontWeight: 600 } }, 'storymine 手法库'),
        h('span', { style: { fontSize: '11px', opacity: 0.5 } },
          `${state.entries.length}${state.total !== state.entries.length ? ` / 共 ${state.total}` : ''} 次`)),
      h('div', { style: { marginTop: '6px', display: 'flex', alignItems: 'center' } },
        h('span', { style: { fontSize: '11px', opacity: 0.6 } },
          canScope ? (scope === 'session' ? '只看本会话' : '全部会话') : '全部会话（拿不到会话 id）'),
        canScope ? btn(scope === 'session' ? '看全部' : '只看本会话',
          () => setScope(scope === 'session' ? 'all' : 'session')) : null,
        state.entries.length ? btn(busy ? '清理中…' : '清空这些', clear, { dim: busy }) : null))

      let body
      if (state.loading) body = muted('读取中…', 12)
      else if (state.error) {
        body = h('div', { style: { fontSize: '12px', lineHeight: 1.7 } },
          h('div', null, `读不到数据：${state.error}`),
          muted('宿主侧的 /storymine/api 没挂上？看 DSH 启动日志里有没有 [storymine]。'))
      } else if (!state.entries.length) {
        body = h('div', { style: { fontSize: '12px', lineHeight: 1.8, opacity: 0.75 } },
          h('div', null, scope === 'session' ? '本会话还没有查询记录。' : '还没有查询记录。'),
          h('div', null, '在下面输入一句话，或者让我在对话里用 storymine_query 问一次。'))
      } else {
        const slice = state.entries.slice(0, shown)
        body = slice.map(EntryBlock)
        if (state.entries.length > shown) {
          body.push(h('div', { key: 'more', style: { textAlign: 'center', marginTop: '4px' } },
            btn(`还有 ${state.entries.length - shown} 条，显示更多`, () => setShown(shown + PAGE))))
        }
      }

      // 底部输入框：绝对定位浮在内容上，右侧提交按钮。
      // 内容区底部留 110px 内边距，滚到底也压不到输入框下面。
      // 底部输入条：不透明底色走 DSH 自己的 --dsw-* 主题 token，
      // 输入框与按钮同一行且等高（alignItems: stretch）。
      const composer = h('div', {
        key: 'composer',
        style: {
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: '8px 12px 12px',
          background: 'var(--dsw-alias-bg-layer-1, Canvas)',
          borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
        },
      },
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'stretch' } },
        h('textarea', {
          value: text,
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          },
          rows: 2,
          placeholder: '一句话描述你写到哪、卡在哪…（Enter 提交，Shift+Enter 换行）',
          style: {
            flex: 1, resize: 'none', fontSize: '12px', lineHeight: 1.5, padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            background: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base, Canvas))',
            color: 'inherit', fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          },
        }),
        h('button', {
          onClick: submit,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          disabled: sending || !text.trim(),
          style: {
            fontSize: '12px', padding: '0 16px', borderRadius: '8px',
            cursor: sending || !text.trim() ? 'default' : 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            background: hover && !sending && text.trim()
              ? 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, Canvas))'
              : 'var(--dsw-alias-bg-layer-2, Canvas)',
            color: 'inherit',
            opacity: sending || !text.trim() ? 0.45 : 1,
            whiteSpace: 'nowrap',
            alignSelf: 'stretch',
            boxSizing: 'border-box',
          },
        }, sending ? '查询中…' : '查一下')),
      askErr ? h('div', { key: 'err', style: { fontSize: '11px', marginTop: '4px', opacity: 0.8, color: 'crimson' } }, askErr) : null)

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' } },
        head,
        h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 16px 110px', fontSize: '12px' } }, body),
        composer)
    }

    function CardsTitle() {
      return h('span', null, '手法库')
    }

    function apply(ctx) {
      try { fetch('/storymine/api/ping', { credentials: 'same-origin' }).catch(() => {}) } catch (e) {}

      let registered = false
      const tryRegister = () => {
        if (registered) return
        const tabs = ctx.get('sidebarRightTabs')
        const slots = ctx.get('slots')
        if (!tabs || typeof tabs.register !== 'function') return
        if (!slots || typeof slots.register !== 'function') return
        registered = true
        clearInterval(timer)
        console.log('[storymine] 侧栏服务就绪，开始注册 tab（kind=' + KIND + '）')

        ctx.effect(() => tabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: 'extension',
          title: () => '手法库',
          guide: [{ id: 'cards', order: 90, title: () => 'storymine 手法库', description: () => '查到的写作手法显示在这里' }],
        }), 'storymine: tab type')

        // inject 回调给组件带会话身份（拿不到就退化为「全部会话」）
        ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
          { name: 'sidebar.right.pane.tab', key: TYPE_ID, inject: (sessionId) => ({ sessionId }) },
          CardsBody)), 'storymine: tab body')
        ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
          { name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, CardsTitle)), 'storymine: tab title')

        console.log('[storymine] 侧栏 tab 已注册')
      }

      const timer = setInterval(tryRegister, 500)
      ctx.effect(() => () => clearInterval(timer))
      tryRegister()

      globalThis.__storymineOpen = () => {
        const sidebar = ctx.get('sidebarRight')
        if (!sidebar) return 'no sidebarRight service'
        try { sidebar.openTab(KIND); return 'ok' } catch (e) { return 'ERR ' + (e && e.message) }
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
