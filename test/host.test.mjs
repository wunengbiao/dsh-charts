import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, validateConfig, DIST_PREFIX, CONFIG_ROUTE, MERMAID_BUNDLE } from '../index.js'

function setup(rawConfig) {
  const routes = []
  const ctx = {
    effect(callback) { callback(); return () => {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, rawConfig)
  return routes
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(body) { this.body = body },
  }
}

test('validateConfig applies defaults and rejects bad values', () => {
  assert.deepEqual(validateConfig(undefined), { theme: 'auto', maxTextSize: 50000, maxEdges: 2000 })
  assert.deepEqual(validateConfig({ theme: 'forest', maxTextSize: 1000, maxEdges: 10 }), { theme: 'forest', maxTextSize: 1000, maxEdges: 10 })
  assert.throws(() => validateConfig({ theme: 'neon' }), /invalid theme/)
  assert.throws(() => validateConfig({ maxTextSize: 0 }), /invalid maxTextSize/)
  assert.throws(() => validateConfig({ maxEdges: -2 }), /invalid maxEdges/)
})

test('registers the config and mermaid asset routes', () => {
  const routes = setup({ theme: 'dark' })
  assert.deepEqual(routes.map((route) => route.kind + ' ' + route.path), ['exact ' + CONFIG_ROUTE, 'prefix ' + DIST_PREFIX])
})

test('serves the config endpoint', () => {
  const routes = setup({ theme: 'dark' })
  const response = mockResponse()
  routes[0].handler({ url: CONFIG_ROUTE }, response)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { theme: 'dark', maxTextSize: 50000, maxEdges: 2000 })
  assert.match(response.headers['content-type'], /application\/json/)
})

test('serves the mermaid bundle and refuses other files', async () => {
  const routes = setup(undefined)
  const prefix = routes[1]
  const bundle = mockResponse()
  await prefix.handler({ url: DIST_PREFIX + '/' + MERMAID_BUNDLE }, bundle)
  assert.equal(bundle.statusCode, 200)
  assert.match(bundle.headers['content-type'], /text\/javascript/)
  assert.ok(bundle.body.byteLength > 1000000)

  const missing = mockResponse()
  await prefix.handler({ url: DIST_PREFIX + '/package.json' }, missing)
  assert.equal(missing.statusCode, 404)

  const traversal = mockResponse()
  await prefix.handler({ url: DIST_PREFIX + '/..%2F..%2Fpackage.json' }, traversal)
  assert.equal(traversal.statusCode, 404)
})
