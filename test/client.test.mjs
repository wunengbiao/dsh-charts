import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html lang="zh-CN"><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:50058/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.DOMParser = dom.window.DOMParser
globalThis.XMLSerializer = dom.window.XMLSerializer
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

let definition
globalThis.window.__ModuleLoader__ = { load(value) { definition = value } }

const React = (await import('react')).default
const ReactDOM = (await import('react-dom')).default
const { createRoot } = await import('react-dom/client')
const testUtils = await import('react-dom/test-utils')
const act = React.act ?? testUtils.act

const clientUrl = pathToFileURL(new URL('../client.js', import.meta.url).pathname).href
await import(clientUrl)
assert.equal(definition.id, 'dsh-charts')
const plugin = definition.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  throw new Error('unexpected module ' + id)
})

const api = plugin.apply.__test

const registered = new Map()
const ctx = {
  effect(callback) { callback(); return () => {} },
  slots: {
    inject(slot, callback) { callback() },
    register(options, component) { registered.set(options.key, component); return () => {} },
  },
}

globalThis.fetch = async () => ({ ok: true, json: async () => ({ theme: 'auto', maxTextSize: 50000, maxEdges: 2000 }) })
window.mermaid = {
  initialize() {},
  async render(_id, code) {
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#123"/><text x="6" y="24">' + (code.includes('pie') ? 'pie' : 'flow') + '</text></svg>' }
  },
}

test('registers mermaid, mmd and svg fence layers', () => {
  plugin.apply(ctx)
  assert.deepEqual([...registered.keys()].sort(), ['mermaid', 'mmd', 'svg'])
})

test('normalizeConfig accepts valid values and falls back otherwise', () => {
  assert.deepEqual(api.normalizeConfig({ theme: 'dark', maxTextSize: 10, maxEdges: 20 }), { theme: 'dark', maxTextSize: 10, maxEdges: 20 })
  assert.deepEqual(api.normalizeConfig({ theme: 'bogus', maxTextSize: -1, maxEdges: 0 }), { theme: 'auto', maxTextSize: 50000, maxEdges: 2000 })
  assert.deepEqual(api.normalizeConfig(null), { theme: 'auto', maxTextSize: 50000, maxEdges: 2000 })
})

test('sanitizeSvg removes scripts, handlers and external references', () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="alert(1)">'
    + '<script>alert(1)</script>'
    + '<style>@import url(https://example.com/x.css); rect { fill: red }</style>'
    + '<a href="javascript:alert(1)"><rect width="10" height="10"/></a>'
    + '<use href="#icon"/>'
    + '<image href="https://example.com/a.png" width="5" height="5"/>'
    + '</svg>'
  const out = api.sanitizeSvg(input)
  assert.ok(!/script/i.test(out))
  assert.ok(!/onload/i.test(out))
  assert.ok(!/javascript:/i.test(out))
  assert.ok(!/@import/i.test(out))
  assert.ok(!/example\.com/.test(out))
  assert.ok(/#icon/.test(out))
  assert.ok(/viewBox="0 0 100 50"/.test(out))
  assert.ok(/max-width:100%/.test(out))
})

test('sanitizeSvg rejects non-svg content', () => {
  assert.throws(() => api.sanitizeSvg(''), /empty svg/)
  assert.throws(() => api.sanitizeSvg('<div>hi</div>'), /root element is not <svg>/)
  assert.throws(() => api.sanitizeSvg('<svg><rect></svg>'), /invalid SVG|not <svg>/)
})

test('messageOf flattens and truncates errors', () => {
  assert.equal(api.messageOf(new Error('a\n b')), 'a b')
  assert.ok(api.messageOf(new Error('x'.repeat(600))).length <= 421)
})

function setupRoot() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

function click(element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

async function openPreview(container) {
  const embed = container.querySelector('.dshc-embed')
  assert.ok(embed, 'inline diagram embed exists')
  await act(async () => { click(embed) })
  return document.querySelector('.dshc-lb')
}

test('svg fence renders inline without a frame and opens preview on click', async () => {
  const SvgFence = registered.get('svg')
  const { container, root } = setupRoot()
  const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="teal"/></svg>'
  await act(async () => {
    root.render(React.createElement(SvgFence, { lang: 'svg', code, streaming: false, children: null }))
  })
  assert.ok(container.querySelector('.dshc-embed .dshc-svg svg'), 'svg is rendered inline')
  assert.equal(container.querySelector('.dshc-frame'), null, 'no framed header remains')
  assert.equal(container.querySelector('.dshc-embed').getAttribute('role'), 'button')

  const overlay = await openPreview(container)
  assert.ok(overlay, 'clicking the diagram opens the overlay')
  assert.ok(overlay.querySelector('.dshc-lb-stage svg'), 'overlay contains the diagram')

  await act(async () => { click(overlay.querySelector('.dshc-lb-stage')) })
  assert.equal(document.querySelector('.dshc-lb'), null, 'clicking the diagram closes the overlay')
  await act(async () => { root.unmount() })
  container.remove()
})

test('mermaid fence renders a diagram and opens the overlay', async () => {
  const MermaidFence = registered.get('mermaid')
  const { container, root } = setupRoot()
  const code = 'flowchart TD\n  A --> B'
  await act(async () => {
    root.render(React.createElement(MermaidFence, { lang: 'mermaid', code, streaming: false, children: null }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.ok(container.querySelector('.dshc-embed .dshc-svg svg'), 'mermaid svg is rendered inline')
  const overlay = await openPreview(container)
  assert.ok(overlay, 'overlay opens for mermaid')
  assert.ok(overlay.querySelector('.dshc-lb-stage svg'))
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await act(async () => { root.unmount() })
  container.remove()
})

test('streaming fences render the original code block', async () => {
  const MermaidFence = registered.get('mermaid')
  const { container, root } = setupRoot()
  const children = React.createElement('pre', { className: 'md-code-block' }, 'flowchart TD')
  await act(async () => {
    root.render(React.createElement(MermaidFence, { lang: 'mermaid', code: 'flowchart TD', streaming: true, children }))
  })
  assert.ok(container.querySelector('pre.md-code-block'))
  assert.equal(container.querySelector('.dshc-frame'), null)
  await act(async () => { root.unmount() })
  container.remove()
})

test('preview supports zoom and closes on Escape', async () => {
  const SvgFence = registered.get('svg')
  const { container, root } = setupRoot()
  const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="teal"/></svg>'
  await act(async () => {
    root.render(React.createElement(SvgFence, { lang: 'svg', code, streaming: false, children: null }))
  })
  const overlay = await openPreview(container)
  assert.ok(overlay, 'overlay is open')
  assert.equal(document.body.style.overflow, 'hidden')
  const zoomIn = overlay.querySelector('button[aria-label="放大"]')
  assert.ok(zoomIn, 'zoom control exists')
  await act(async () => { click(zoomIn) })
  assert.equal(overlay.querySelector('.dshc-lb-zoomlabel').textContent, '125%')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(document.querySelector('.dshc-lb'), null, 'Escape closes the overlay')
  assert.equal(document.body.style.overflow, '')
  await act(async () => { root.unmount() })
  container.remove()
})
test('inline diagram embeds are never height-capped or clipped', async () => {
  // Regression: 0.1.2 wrapped every diagram in a framed box capped at
  // min(72vh, 760px) with its own scroll area. On macOS the overlay scrollbar
  // is invisible, so a tall flowchart looked cut off / covered. Inline embeds
  // must grow with the diagram instead.
  const style = document.querySelector('style[data-dsh-charts]')
  assert.ok(style, 'styles are mounted')
  const cssText = style.textContent
  for (const selector of ['.dshc-embed', '.dshc-svg']) {
    const blockPattern = new RegExp(selector.replace(/\./g, '\\.') + '(?![\\w-])\\{([^}]*)\\}', 'g')
    const blocks = [...cssText.matchAll(blockPattern)].map((match) => match[1])
    assert.ok(blocks.length > 0, selector + ' has a rule')
    for (const block of blocks) {
      assert.doesNotMatch(block, /max-height/, selector + ' must not cap the diagram height')
      assert.doesNotMatch(block, /overflow\s*:\s*hidden/, selector + ' must not clip the diagram')
    }
  }

  const MermaidFence = registered.get('mermaid')
  const { container, root } = setupRoot()
  await act(async () => {
    root.render(React.createElement(MermaidFence, { lang: 'mermaid', code: 'flowchart TD\n  A --> B', streaming: false, children: null }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  const embed = container.querySelector('.dshc-embed')
  assert.ok(embed, 'diagram is embedded inline')
  assert.equal(embed.getAttribute('style'), null, 'no inline height/overflow is applied to the embed')
  await act(async () => { root.unmount() })
  container.remove()
})
