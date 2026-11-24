/**
 * Host half of dsh-charts (0.1.2: in-app preview lightbox replaces OS fullscreen).
 *
 * Serves the pinned Mermaid UMD build and the effective client config from
 * this plugin's own dependency tree, so the browser bundle stays tiny and the
 * diagram engine is fetched only when a ```mermaid fence is rendered. The
 * client half registers Markdown fence layers through
 * `conversation.chat.markdown.fence`; no files, PNG conversion, or DOM
 * post-processing are involved.
 *
 * @module dsh-charts
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)

/** Cordis plugin name. */
export const name = 'dsh-charts'
/** The web server must exist before the asset routes can be registered. */
export const inject = ['webServer']

/** Route prefix serving the Mermaid browser build. */
export const DIST_PREFIX = '/dsh-charts/mermaid'
/** Fixed JSON endpoint with the effective client config. */
export const CONFIG_ROUTE = '/dsh-charts/config.json'
/** The UMD entry inside the mermaid package. */
export const MERMAID_DIST_FILE = 'mermaid/dist/mermaid.min.js'
/** Public file name under {@link DIST_PREFIX}. */
export const MERMAID_BUNDLE = 'mermaid.min.js'

/** Diagram themes mermaid ships; `auto` follows the GUI light/dark mode. */
const THEMES = new Set(['auto', 'default', 'dark', 'neutral', 'forest', 'base'])

/** Defaults mirrored by the client when the config endpoint is unreachable. */
export const DEFAULT_CONFIG = Object.freeze({
  theme: 'auto',
  maxTextSize: 50000,
  maxEdges: 2000,
})

/**
 * Validate one patch-row config object at activation, so a typo fails loudly
 * instead of silently rendering wrong diagrams.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {{ theme: string, maxTextSize: number, maxEdges: number }}
 */
export function validateConfig(raw) {
  const input = raw ?? {}
  let theme = DEFAULT_CONFIG.theme
  if (input.theme !== undefined) {
    if (typeof input.theme !== 'string' || !THEMES.has(input.theme)) {
      throw new Error(`dsh-charts: invalid theme "${String(input.theme)}" (expected one of ${[...THEMES].join(', ')})`)
    }
    theme = input.theme
  }
  const maxTextSize = input.maxTextSize === undefined ? DEFAULT_CONFIG.maxTextSize : Number(input.maxTextSize)
  if (!Number.isFinite(maxTextSize) || maxTextSize <= 0) {
    throw new Error(`dsh-charts: invalid maxTextSize "${String(input.maxTextSize)}" (expected a positive number)`)
  }
  const maxEdges = input.maxEdges === undefined ? DEFAULT_CONFIG.maxEdges : Number(input.maxEdges)
  if (!Number.isFinite(maxEdges) || maxEdges <= 0) {
    throw new Error(`dsh-charts: invalid maxEdges "${String(input.maxEdges)}" (expected a positive number)`)
  }
  return { theme, maxTextSize, maxEdges }
}

/** MIME types of the two files the prefix route may serve. */
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve one file below the Mermaid dist root, refusing traversal and any file
 * other than the bundle and its source map.
 * @param {string} distRoot
 * @param {string} pathname decoded path below {@link DIST_PREFIX}
 * @param {import('node:http').ServerResponse} res
 */
export async function serveDistFile(distRoot, pathname, res) {
  const rel = pathname.replace(/^\/+/, '')
  if (rel !== MERMAID_BUNDLE && rel !== `${MERMAID_BUNDLE}.map`) {
    res.writeHead(404)
    res.end()
    return
  }
  const target = resolve(normalize(join(distRoot, rel)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/** Resolve the Mermaid dist directory from this plugin's own dependencies. */
function resolveMermaidDist() {
  return dirname(require.resolve(MERMAID_DIST_FILE))
}

/**
 * Register the config endpoint and the Mermaid asset route.
 * @param {object} ctx Cordis context carrying `webServer` and `effect`.
 * @param {Record<string, unknown> | undefined} rawConfig patch-row config.
 */
export function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig)
  const distRoot = resolveMermaidDist()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(config))
    },
  }), 'dsh-charts: config route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DIST_PREFIX,
    handler: (req, res) => {
      let pathname
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const rel = pathname.startsWith(DIST_PREFIX) ? pathname.slice(DIST_PREFIX.length) : pathname
      return serveDistFile(distRoot, rel, res)
    },
  }), 'dsh-charts: mermaid asset route')
  // Ask every agent to answer diagram requests with a renderable fence instead
  // of writing an image file or converting one to PNG. Optional service: the
  // plugin still works when a deployment composes no system prompt.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    const guidance = [
      'When the user asks for a diagram, chart, flow chart, sequence diagram, mind map, timeline, or any visual explanation, write it as a fenced code block in your reply:',
      '- mermaid fences for flowcharts, sequence diagrams, class diagrams, state diagrams, pie charts, xychart-beta bar/line charts, gantt, timeline, mindmap, quadrant, sankey, and treemap.',
      '- svg fences for a hand-written SVG, including custom statistical charts that mermaid cannot express.',
      'The Web conversation renders these fences inline as diagrams. Do not create image files, do not convert diagrams to PNG, and do not present a file unless the user explicitly asks for a downloadable file.',
    ].join('\n')
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-charts',
      order: 850,
      text: guidance,
      interpolate: false,
    }), 'dsh-charts: system prompt guidance')
  }
}
