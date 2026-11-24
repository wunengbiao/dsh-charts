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

test('svg fence renders the sanitized svg and toggles source', async () => {
  const SvgFence = registered.get('svg')
  const { container, root } = setupRoot()
  const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="teal"/></svg>'
  await act(async () => {
    root.render(React.createElement(SvgFence, { lang: 'svg', code, streaming: false, children: null }))
  })
  assert.ok(container.querySelector('.dshc-svg svg'), 'svg is rendered inline')
  assert.ok(container.querySelector('.dshc-label').textContent === 'SVG')

  const sourceButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '源码')
  assert.ok(sourceButton, 'source toggle exists')
  await act(async () => {
    sourceButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(container.querySelector('pre.dshc-code').textContent, code)
  await act(async () => { root.unmount() })
  container.remove()
})

test('mermaid fence renders a diagram and keeps code available', async () => {
  const MermaidFence = registered.get('mermaid')
  const { container, root } = setupRoot()
  const code = 'flowchart TD\n  A --> B'
  await act(async () => {
    root.render(React.createElement(MermaidFence, { lang: 'mermaid', code, streaming: false, children: null }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.ok(container.querySelector('.dshc-svg svg'), 'mermaid svg is rendered inline')
  assert.ok(container.querySelector('.dshc-label').textContent === 'Mermaid')
  const sourceButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '源码')
  await act(async () => {
    sourceButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(container.querySelector('pre.dshc-code').textContent, code)
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

test('preview opens an in-page lightbox with zoom and closes on Escape', async () => {
  const SvgFence = registered.get('svg')
  const { container, root } = setupRoot()
  const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="teal"/></svg>'
  await act(async () => {
    root.render(React.createElement(SvgFence, { lang: 'svg', code, streaming: false, children: null }))
  })
  const previewButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '预览')
  assert.ok(previewButton, 'preview button exists')
  await act(async () => {
    previewButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const overlay = document.querySelector('.dshc-lb')
  assert.ok(overlay, 'lightbox is portaled into the document body')
  assert.ok(overlay.querySelector('.dshc-lb-stage svg'), 'lightbox contains the diagram')
  assert.equal(document.body.style.overflow, 'hidden')
  const zoomIn = overlay.querySelector('button[aria-label="放大"]')
  assert.ok(zoomIn, 'zoom control exists')
  await act(async () => {
    zoomIn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(overlay.querySelector('.dshc-lb-zoomlabel').textContent, '125%')
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(document.querySelector('.dshc-lb'), null, 'Escape closes the lightbox')
  assert.equal(document.body.style.overflow, '')
  await act(async () => { root.unmount() })
  container.remove()
})
