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
    const ReactDOM = require('react-dom')
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
        preview: '预览',
        zoomIn: '放大',
        zoomOut: '缩小',
        reset: '重置',
        loading: '正在渲染图表…',
        error: '图表渲染失败',
      },
      en: {
        preview: 'Preview',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        reset: 'Reset',
        loading: 'Rendering diagram…',
        error: 'Diagram failed to render',
      },
    }

    const STYLES = [
      '.dshc-embed{position:relative;display:block;margin:8px 0;cursor:zoom-in;outline:none;border:0;background:none}',
      '.dshc-embed:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:4px;border-radius:8px}',
      '.dshc-embed:hover .dshc-svg{opacity:.97}',
      '.dshc-svg{display:flex;justify-content:center;align-items:center;min-width:0;max-width:100%}',
      '.dshc-svg svg{max-width:100%;height:auto}',
      '.dshc-refreshing{opacity:.55}',
      '.dshc-placeholder{display:flex;align-items:center;justify-content:center;min-height:64px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}',
      '.dshc-embed-failed{cursor:default;margin:8px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06))}',
      '.dshc-error{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word}',
      '.dshc-code{margin:0;padding:10px 0 0;overflow:auto;max-height:50vh;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;tab-size:2}',
      '.dshc-lb{position:fixed;inset:0;z-index:2147483000;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);animation:dshc-fade .16s ease-out;overscroll-behavior:contain;outline:none;cursor:zoom-out}',
      'body[data-ds-dark-theme] .dshc-lb{background:rgba(0,0,0,.84)}',
      '.dshc-lb-stage{position:absolute;inset:0;z-index:1;overflow:auto;display:flex;padding:64px 24px 96px;overscroll-behavior:contain;cursor:zoom-out}',
      '.dshc-lb-stage.dshc-dragging{cursor:grabbing;user-select:none}',
      '.dshc-lb-zoom{margin:auto;display:block;width:100%;text-align:center;pointer-events:none}',
      '.dshc-lb-zoom svg{display:inline-block;max-width:100%;height:auto;pointer-events:auto;cursor:zoom-out}',
      '.dshc-lb-zoom-bar{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:2px;padding:4px 6px;border-radius:999px;background:rgba(255,255,255,.92);color:#1f2328;box-shadow:0 10px 36px rgba(0,0,0,.18);backdrop-filter:blur(10px);cursor:default}',
      'body[data-ds-dark-theme] .dshc-lb-zoom-bar{background:rgba(24,28,34,.9);color:#e8edf3;box-shadow:0 10px 36px rgba(0,0,0,.5)}',
      '.dshc-lb-btn{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;padding:5px 10px;border-radius:8px;white-space:nowrap}',
      '.dshc-lb-btn:hover{background:rgba(0,0,0,.07)}',
      'body[data-ds-dark-theme] .dshc-lb-btn:hover{background:rgba(255,255,255,.12)}',
      '.dshc-lb-btn:focus-visible{outline:2px solid #7cb2ff;outline-offset:1px}',
      '.dshc-lb-btn:focus:not(:focus-visible){outline:none}',
      '.dshc-lb-zoomlabel{min-width:50px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums;opacity:.8}',
      '@keyframes dshc-fade{from{opacity:0}to{opacity:1}}',
      '@media (max-width:720px){.dshc-lb-stage{padding:56px 10px 88px}}',
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

    function PreviewOverlay(props) {
      const t = props.t
      const [zoom, setZoom] = React.useState(1)
      const [dragging, setDragging] = React.useState(false)
      const overlayRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const startRef = React.useRef(null)
      const movedRef = React.useRef(false)

      React.useEffect(() => {
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
        document.addEventListener('keydown', onKey)
        if (overlayRef.current !== null) overlayRef.current.focus()
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = previous
        }
      }, [props.onClose])

      React.useEffect(() => {
        const overlay = overlayRef.current
        const stage = stageRef.current
        if (overlay === null || stage === null) return undefined
        const zoomByWheel = (event) => {
          event.preventDefault()
          setZoom((value) => {
            const next = value + (event.deltaY > 0 ? -0.15 : 0.15)
            return Math.round(Math.min(5, Math.max(0.5, next)) * 100) / 100
          })
        }
        const holdBackground = (event) => { event.preventDefault() }
        stage.addEventListener('wheel', zoomByWheel, { passive: false })
        overlay.addEventListener('wheel', holdBackground, { passive: false })
        return () => {
          stage.removeEventListener('wheel', zoomByWheel)
          overlay.removeEventListener('wheel', holdBackground)
        }
      }, [])

      const onPointerDown = (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return
        const stage = stageRef.current
        if (stage === null) return
        startRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }
        movedRef.current = false
      }
      const onPointerMove = (event) => {
        const start = startRef.current
        const stage = stageRef.current
        if (start === null || stage === null) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > 4) {
          movedRef.current = true
          setDragging(true)
          try { stage.setPointerCapture(event.pointerId) } catch (error) { /* capture unavailable */ }
        }
        if (movedRef.current) {
          stage.scrollLeft = start.left - dx
          stage.scrollTop = start.top - dy
        }
      }
      const endDrag = (event) => {
        startRef.current = null
        setDragging(false)
        const stage = stageRef.current
        if (stage === null) return
        try { stage.releasePointerCapture(event.pointerId) } catch (error) { /* capture unavailable */ }
      }
      const onOverlayClick = (event) => {
        const target = event.target
        if (target !== null && typeof target.closest === 'function' && target.closest('.dshc-lb-zoom-bar') !== null) return
        if (movedRef.current) { movedRef.current = false; return }
        props.onClose()
      }
      const changeZoom = (delta) => {
        setZoom((value) => Math.round(Math.min(5, Math.max(0.5, value + delta)) * 100) / 100)
      }
      return ReactDOM.createPortal(
        h('div', {
          className: 'dshc-lb',
          ref: overlayRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t.preview,
          tabIndex: -1,
          onClick: onOverlayClick,
        },
          h('div', {
            className: 'dshc-lb-stage' + (dragging ? ' dshc-dragging' : ''),
            ref: stageRef,
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onDragStart: (event) => { event.preventDefault() },
          },
            h('div', {
              className: 'dshc-lb-zoom',
              style: { zoom: String(zoom) },
              dangerouslySetInnerHTML: { __html: props.svg },
            }),
          ),
          h('div', { className: 'dshc-lb-zoom-bar', onClick: (event) => { event.stopPropagation() } },
            h('button', {
              type: 'button', className: 'dshc-lb-btn', 'aria-label': t.zoomOut, title: t.zoomOut,
              onClick: () => { changeZoom(-0.25) },
            }, '−'),
            h('span', { className: 'dshc-lb-zoomlabel' }, Math.round(zoom * 100) + '%'),
            h('button', {
              type: 'button', className: 'dshc-lb-btn', 'aria-label': t.zoomIn, title: t.zoomIn,
              onClick: () => { changeZoom(0.25) },
            }, '+'),
            h('button', { type: 'button', className: 'dshc-lb-btn', onClick: () => { setZoom(1) } }, t.reset),
          ),
        ),
        document.body,
      )
    }

    function DiagramEmbed(props) {
      const t = props.t
      const [preview, setPreview] = React.useState(false)
      const closePreview = React.useCallback(() => {
        setPreview(false)
        const node = props.frameRef.current
        if (node !== null) node.focus()
      }, [props.frameRef])
      const canPreview = Boolean(props.previewSvg)
      const open = () => { if (canPreview) setPreview(true) }
      const onKeyDown = (event) => {
        if (!canPreview) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          setPreview(true)
        }
      }
      const body = props.error
        ? h('div', { className: 'dshc-embed dshc-embed-failed', ref: props.frameRef },
            h('div', { className: 'dshc-error' }, t.error + ': ' + props.error),
            h('pre', { className: 'dshc-code' }, h('code', null, props.code)),
          )
        : h('div', {
            className: 'dshc-embed',
            ref: props.frameRef,
            role: canPreview ? 'button' : undefined,
            tabIndex: canPreview ? 0 : undefined,
            'aria-label': canPreview ? t.preview : undefined,
            title: canPreview ? t.preview : undefined,
            onClick: canPreview ? open : undefined,
            onKeyDown: canPreview ? onKeyDown : undefined,
            'data-dshc-lang': props.lang,
          }, props.children)
      return h(React.Fragment, null, body, preview && props.previewSvg
        ? h(PreviewOverlay, { svg: props.previewSvg, t, onClose: closePreview })
        : null)
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
        return h(DiagramEmbed, {
          lang: props.lang,
          code,
          meta: props.meta,
          t,
          frameRef,
          error: paint.status === 'error' ? paint.message : '',
          previewSvg: paint.status === 'ready' ? paint.svg : (paint.previous || ''),
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
        return h(DiagramEmbed, {
          lang: 'svg',
          code,
          meta: props.meta,
          t,
          frameRef,
          error: prepared && prepared.error ? prepared.error : '',
          previewSvg: prepared && prepared.svg ? prepared.svg : '',
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