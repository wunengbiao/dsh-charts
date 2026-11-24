/**
 * Client half of dsh-charts.
 *
 * Registers Markdown fence layers for the conversation chat flow, so mermaid
 * fences (info string mermaid or mmd) render as SVG diagrams and svg fences
 * render as the SVG they contain — directly inside the message, with no file
 * submission, PNG conversion, or DOM post-processing.
 *
 * The bundle is loaded through window.__ModuleLoader__ and only depends on the
 * shared React module; the diagram engine stays behind the host route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-charts',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.chat.markdown.fence'
    const MERMAID_URL = '/dsh-charts/mermaid/mermaid.min.js'
    const CONFIG_URL = '/dsh-charts/config.json'
    const DEFAULT_CONFIG = { theme: 'auto', maxTextSize: 50000, maxEdges: 2000 }
    const THEMES = ['auto', 'default', 'dark', 'neutral', 'forest', 'base']
    const MAX_SVG_BYTES = 2 * 1024 * 1024
    const RENDER_TIMEOUT_MS = 20000

    const STRINGS = {
      zh: {
        diagram: '图表',
        source: '源码',
        copy: '复制',
        copied: '已复制',
        fullscreen: '全屏',
        exitFullscreen: '退出全屏',
        loading: '正在渲染图表…',
        error: '图表渲染失败',
      },
      en: {
        diagram: 'Diagram',
        source: 'Source',
        copy: 'Copy',
        copied: 'Copied',
        fullscreen: 'Fullscreen',
        exitFullscreen: 'Exit fullscreen',
        loading: 'Rendering diagram…',
        error: 'Diagram failed to render',
      },
    }

    const STYLES = [
      '.dshc-frame{display:flex;flex-direction:column;margin:10px 0;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));overflow:hidden}',
      '.dshc-head{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8a8f98);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.dshc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4c8dff);flex:none}',
      '.dshc-label{font-weight:600;color:var(--dsw-alias-label-primary,inherit);letter-spacing:.02em}',
      '.dshc-title{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.72}',
      '.dshc-busy{opacity:.72}',
      '.dshc-actions{margin-left:auto;display:flex;gap:2px;flex:none}',
      '.dshc-btn{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:3px 8px;border-radius:6px;white-space:nowrap}',
      '.dshc-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit)}',
      '.dshc-body{padding:12px;overflow:auto;max-height:min(72vh,760px)}',
      '.dshc-body-source{padding:0}',
      '.dshc-svg{display:flex;justify-content:center;align-items:center;min-width:0}',
      '.dshc-svg svg{max-width:100%;height:auto}',
      '.dshc-refreshing{opacity:.55}',
      '.dshc-placeholder{display:flex;align-items:center;justify-content:center;min-height:72px;padding:18px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}',
      '.dshc-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word}',
      '.dshc-body-source .dshc-error{padding:10px 12px 0}',
      '.dshc-code{margin:0;padding:10px 12px;overflow:auto;max-height:60vh;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;tab-size:2}',
      '.dshc-frame:fullscreen{width:100vw;height:100vh;max-height:none;border-radius:0;background:var(--dsw-alias-bg-base,#111);margin:0}',
      '.dshc-frame:fullscreen .dshc-body{flex:1 1 auto;max-height:none;display:flex;align-items:center;justify-content:center}',
      '.dshc-frame:fullscreen .dshc-svg svg{max-height:calc(100vh - 84px)}',
      '.dshc-frame:fullscreen .dshc-code{max-height:none;width:100%}',
    ].join('\n')

    let renderSeq = 0
    let renderChain = Promise.resolve()
    let mermaidPromise

    function messageOf(error) {
      if (error === null || error === undefined) return 'unknown error'
      let text
      if (typeof error === 'string') text = error
      else if (error && error.message) text = String(error.message)
      else text = String(error)
      const oneLine = text.replace(/\s+/g, ' ').trim()
      return oneLine.length > 420 ? oneLine.slice(0, 420) + '…' : oneLine
    }

    function normalizeConfig(raw) {
      if (raw === null || typeof raw !== 'object') return DEFAULT_CONFIG
      const theme = typeof raw.theme === 'string' && THEMES.indexOf(raw.theme) !== -1 ? raw.theme : DEFAULT_CONFIG.theme
      const maxTextSize = Number.isFinite(Number(raw.maxTextSize)) && Number(raw.maxTextSize) > 0 ? Number(raw.maxTextSize) : DEFAULT_CONFIG.maxTextSize
      const maxEdges = Number.isFinite(Number(raw.maxEdges)) && Number(raw.maxEdges) > 0 ? Number(raw.maxEdges) : DEFAULT_CONFIG.maxEdges
      return { theme, maxTextSize, maxEdges }
    }

    function loadConfig() {
      return fetch(CONFIG_URL, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((raw) => normalizeConfig(raw))
        .catch(() => DEFAULT_CONFIG)
    }

    function loadMermaid() {
      if (typeof window !== 'undefined' && window.mermaid) return Promise.resolve(window.mermaid)
      if (mermaidPromise) return mermaidPromise
      mermaidPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = MERMAID_URL
        script.async = true
        script.onload = () => {
          if (window.mermaid) resolve(window.mermaid)
          else reject(new Error('mermaid loaded but window.mermaid is missing'))
        }
        script.onerror = () => reject(new Error('failed to load mermaid from ' + MERMAID_URL))
        document.head.appendChild(script)
      })
      mermaidPromise.catch(() => { mermaidPromise = undefined })
      return mermaidPromise
    }

    function withTimeout(promise, ms) {
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('render timed out after ' + ms + 'ms')), ms)
        promise.then(
          (value) => { window.clearTimeout(timer); resolve(value) },
          (error) => { window.clearTimeout(timer); reject(error) },
        )
      })
    }

    function enqueue(task) {
      const run = renderChain.then(task, task)
      renderChain = run.then(() => undefined, () => undefined)
      return run
    }

    function renderMermaidSvg(mermaid, code, dark, config) {
      const theme = config.theme === 'auto' ? (dark ? 'dark' : 'default') : config.theme
      let fontFamily = 'sans-serif'
      try { fontFamily = getComputedStyle(document.body).fontFamily || fontFamily } catch (error) { fontFamily = 'sans-serif' }
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        fontFamily,
        maxTextSize: config.maxTextSize,
        maxEdges: config.maxEdges,
        suppressErrorRendering: true,
        flowchart: { useMaxWidth: true },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
      })
      const id = 'dsh-inline-diagram-' + (++renderSeq)
      return Promise.resolve(mermaid.render(id, code)).then((result) => {
        const svg = result && typeof result.svg === 'string' ? result.svg : ''
        if (svg === '') throw new Error('mermaid returned an empty svg')
        return svg
      })
    }

    const SVG_DROP = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas']

    function safeSvgUrl(value) {
      const url = String(value).trim()
      return url.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url)
    }

    function sanitizeSvg(code) {
      const text = String(code)
      if (text.length > MAX_SVG_BYTES) throw new Error('svg is larger than ' + MAX_SVG_BYTES + ' bytes')
      if (text.trim() === '') throw new Error('empty svg')
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const root = doc.documentElement
      if (root === null || root.localName.toLowerCase() !== 'svg') throw new Error('root element is not <svg>')
      if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('invalid SVG/XML')
      const all = root.getElementsByTagName('*')
      const elements = [root]
      for (let index = 0; index < all.length; index += 1) elements.push(all[index])
      const drop = []
      for (const element of elements) {
        const tag = element.localName.toLowerCase()
        if (SVG_DROP.indexOf(tag) !== -1) { drop.push(element); continue }
        if (tag === 'style') {
          element.textContent = String(element.textContent || '')
            .replace(/@import[^;]*;?/gi, '')
            .replace(/url\(\s*['"]?\s*(?:https?:|\/\/)[^)]*\)/gi, 'none')
        }
        const attributes = Array.from(element.attributes)
        for (const attribute of attributes) {
          const name = attribute.name.toLowerCase()
          if (name.startsWith('on')) { element.removeAttributeNode(attribute); continue }
          if ((name === 'href' || name === 'xlink:href' || name === 'src') && !safeSvgUrl(attribute.value)) {
            element.removeAttributeNode(attribute); continue
          }
          if (name === 'style' && /(?:expression\s*\(|@import|url\(\s*['"]?\s*(?:https?:|\/\/))/i.test(attribute.value)) {
            element.removeAttributeNode(attribute)
          }
        }
      }
      for (const element of drop) {
        if (element.parentNode) element.parentNode.removeChild(element)
      }
      if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const width = parseFloat(root.getAttribute('width') || '')
      const height = parseFloat(root.getAttribute('height') || '')
      if (!root.getAttribute('viewBox') && width > 0 && height > 0) {
        root.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
      }
      const style = root.getAttribute('style') || ''
      root.setAttribute('style', (style ? style.replace(/;?\s*$/, '; ') : '') + 'max-width:100%;height:auto;')
      return new XMLSerializer().serializeToString(root)
    }

    function readUi() {
      let lang = 'en'
      try {
        const declared = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase()
        lang = declared.startsWith('zh') ? 'zh' : 'en'
      } catch (error) { lang = 'en' }
      return { dark: document.body.hasAttribute('data-ds-dark-theme'), lang }
    }

    function createUiStore() {
      let snapshot = readUi()
      const listeners = new Set()
      const emit = () => {
        const next = readUi()
        if (next.dark === snapshot.dark && next.lang === snapshot.lang) return
        snapshot = next
        for (const listener of Array.from(listeners)) listener()
      }
      const observer = new MutationObserver(emit)
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      return {
        getSnapshot() { return snapshot },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        dispose() { observer.disconnect(); listeners.clear() },
      }
    }

    function useUi(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function mountStyles() {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-charts', '')
      style.textContent = STYLES
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    function copyText(text, done) {
      const fallback = () => {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
        } catch (error) { /* clipboard unavailable */ }
        done()
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback)
      } else {
        fallback()
      }
    }

    function DiagramFrame(props) {
      const t = props.t
      const [showSource, setShowSource] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [full, setFull] = React.useState(false)
      const copyTimer = React.useRef(0)
      React.useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current) }, [])
      React.useEffect(() => {
        const onChange = () => { setFull(document.fullscreenElement === props.frameRef.current) }
        document.addEventListener('fullscreenchange', onChange)
        return () => { document.removeEventListener('fullscreenchange', onChange) }
      }, [props.frameRef])
      const onCopy = () => {
        copyText(props.code, () => {
          setCopied(true)
          if (copyTimer.current) window.clearTimeout(copyTimer.current)
          copyTimer.current = window.setTimeout(() => { setCopied(false) }, 1400)
        })
      }
      const onFullscreen = () => {
        const element = props.frameRef.current
        if (element === null) return
        if (document.fullscreenElement) { void document.exitFullscreen() }
        else if (element.requestFullscreen) { void element.requestFullscreen() }
      }
      const label = props.lang === 'svg' ? 'SVG' : 'Mermaid'
      const title = props.meta && props.meta.trim() !== '' ? props.meta.trim() : ''
      return h('div', { className: 'dshc-frame', ref: props.frameRef, 'data-dshc-lang': props.lang },
        h('div', { className: 'dshc-head' },
          h('span', { className: 'dshc-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dshc-label' }, label),
          title ? h('span', { className: 'dshc-title', title }, title) : null,
          props.busy ? h('span', { className: 'dshc-busy' }, t.loading) : null,
          h('div', { className: 'dshc-actions' },
            h('button', {
              type: 'button', className: 'dshc-btn', 'aria-pressed': showSource ? 'true' : 'false',
              onClick: () => { setShowSource((value) => !value) },
            }, showSource ? t.diagram : t.source),
            h('button', { type: 'button', className: 'dshc-btn', onClick: onCopy }, copied ? t.copied : t.copy),
            h('button', { type: 'button', className: 'dshc-btn', onClick: onFullscreen }, full ? t.exitFullscreen : t.fullscreen),
          ),
        ),
        h('div', { className: 'dshc-body' + (showSource || props.error ? ' dshc-body-source' : '') },
          props.error ? h('div', { className: 'dshc-error' }, t.error + ': ' + props.error) : null,
          showSource || props.error
            ? h('pre', { className: 'dshc-code' }, h('code', null, props.code))
            : props.children,
        ),
      )
    }

    function createMermaidFence(runtime, configPromise) {
      return function MermaidFence(props) {
        const ui = useUi(runtime.ui)
        const t = STRINGS[ui.lang]
        const streaming = props.streaming
        const code = props.code
        const mode = ui.dark ? 'dark' : 'light'
        const frameRef = React.useRef(null)
        const [visible, setVisible] = React.useState(false)
        const [paint, setPaint] = React.useState({ status: 'idle' })

        React.useEffect(() => {
          if (streaming || visible) return undefined
          const element = frameRef.current
          if (element === null || typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined }
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) { setVisible(true); observer.disconnect(); return }
            }
          }, { rootMargin: '400px' })
          observer.observe(element)
          return () => { observer.disconnect() }
        }, [streaming, visible])

        React.useEffect(() => {
          if (streaming || !visible) return undefined
          let cancelled = false
          setPaint((previous) => (previous.status === 'ready' && previous.code === code && previous.mode === mode
            ? previous
            : { status: 'loading', previous: previous.status === 'ready' ? previous.svg : undefined }))
          const task = () => configPromise.then((config) => loadMermaid().then((mermaid) => (
            withTimeout(renderMermaidSvg(mermaid, code, ui.dark, config), RENDER_TIMEOUT_MS)
          )))
          enqueue(task).then(
            (svg) => { if (!cancelled) setPaint({ status: 'ready', svg, code, mode }) },
            (error) => { if (!cancelled) setPaint({ status: 'error', message: messageOf(error) }) },
          )
          return () => { cancelled = true }
        }, [streaming, visible, code, mode, configPromise])

        if (streaming) return props.children
        let content
        if (paint.status === 'ready') {
          content = h('div', { className: 'dshc-svg', dangerouslySetInnerHTML: { __html: paint.svg } })
        } else if (paint.status === 'loading' && paint.previous) {
          content = h('div', { className: 'dshc-svg dshc-refreshing', dangerouslySetInnerHTML: { __html: paint.previous } })
        } else if (paint.status === 'error') {
          content = h('div', { className: 'dshc-placeholder' }, t.error)
        } else {
          content = h('div', { className: 'dshc-placeholder' }, t.loading)
        }
        return h(DiagramFrame, {
          lang: props.lang,
          code,
          meta: props.meta,
          t,
          frameRef,
          busy: paint.status === 'loading' && paint.previous !== undefined,
          error: paint.status === 'error' ? paint.message : '',
          children: content,
        })
      }
    }

    function createSvgFence(runtime) {
      return function SvgFence(props) {
        const ui = useUi(runtime.ui)
        const t = STRINGS[ui.lang]
        const streaming = props.streaming
        const code = props.code
        const frameRef = React.useRef(null)
        const prepared = React.useMemo(() => {
          if (streaming) return null
          try { return { svg: sanitizeSvg(code) } }
          catch (error) { return { error: messageOf(error) } }
        }, [streaming, code])
        if (streaming) return props.children
        const content = prepared && prepared.svg
          ? h('div', { className: 'dshc-svg', dangerouslySetInnerHTML: { __html: prepared.svg } })
          : h('div', { className: 'dshc-placeholder' }, t.error)
        return h(DiagramFrame, {
          lang: 'svg',
          code,
          meta: props.meta,
          t,
          frameRef,
          busy: false,
          error: prepared && prepared.error ? prepared.error : '',
          children: content,
        })
      }
    }

    function apply(ctx) {
      const ui = createUiStore()
      ctx.effect(() => () => { ui.dispose() }, 'dsh-charts: ui observer')
      ctx.effect(() => mountStyles(), 'dsh-charts: styles')
      const configPromise = loadConfig()
      const mermaidFence = createMermaidFence({ ui }, configPromise)
      const svgFence = createSvgFence({ ui })
      ctx.slots.inject(SLOT, () => {
        ctx.slots.register({ name: SLOT, key: 'mermaid', id: 'dsh-charts/mermaid' }, mermaidFence)
        ctx.slots.register({ name: SLOT, key: 'mmd', id: 'dsh-charts/mermaid' }, mermaidFence)
        ctx.slots.register({ name: SLOT, key: 'svg', id: 'dsh-charts/svg' }, svgFence)
      })
    }

    apply.__test = {
      STRINGS,
      normalizeConfig,
      messageOf,
      sanitizeSvg,
      createUiStore,
      renderMermaidSvg,
    }

    return { name: 'dsh-charts', inject: ['slots'], apply }
  },
})