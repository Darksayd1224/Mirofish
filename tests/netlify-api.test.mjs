import assert from 'node:assert/strict'
import { test } from 'node:test'
import handler, { config } from '../netlify/functions/api.mts'

function mockBackend(context, origin, fetchImplementation) {
  const originalNetlify = globalThis.Netlify
  const originalFetch = globalThis.fetch
  globalThis.Netlify = { env: { get: () => origin } }
  globalThis.fetch = fetchImplementation || (() => {
    throw new Error('Unexpected backend request')
  })
  context.after(() => {
    globalThis.Netlify = originalNetlify
    globalThis.fetch = originalFetch
  })
}

test('API and health paths are handled separately from the SPA', () => {
  assert.deepEqual(config.path, ['/api/*', '/health'])
})

test('missing backend returns an actionable JSON error', async (context) => {
  mockBackend(context)
  const response = await handler(new Request('https://site.example/health'))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).code, 'BACKEND_NOT_CONFIGURED')
})

for (const origin of [
  'not-a-url',
  'http://backend.example',
  'https://backend.example/api',
  'https://backend.example/?invalid=true',
  'https://backend.example/#invalid',
  'https://user:password@backend.example',
  'https://site.example'
]) {
  test(`invalid backend origin is rejected: ${new URL(origin, 'https://placeholder.example').hostname}`, async (context) => {
    mockBackend(context, origin)
    const response = await handler(new Request('https://site.example/health'))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'BACKEND_NOT_CONFIGURED')
  })
}

test('unrelated routes are never forwarded', async (context) => {
  mockBackend(context, 'https://backend.example')
  const response = await handler(new Request('https://site.example/unrelated'))
  assert.equal(response.status, 404)
})

test('health check reaches the Python server', async (context) => {
  mockBackend(context, 'https://backend.example', async (target, options) => {
    assert.equal(target.href, 'https://backend.example/health')
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(options.redirect, 'error')
    return Response.json({ status: 'ok', service: 'MiroFish Backend' })
  })
  const response = await handler(new Request('https://site.example/health'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok', service: 'MiroFish Backend' })
})

test('API path, query, JSON body and language are preserved', async (context) => {
  mockBackend(context, 'https://backend.example', async (target, options) => {
    assert.equal(target.href, 'https://backend.example/api/simulation/prepare?round=2')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.get('accept-language'), 'en')
    assert.equal(options.headers.get('content-type'), 'application/json')
    assert.equal(options.headers.has('cookie'), false)
    assert.equal(new TextDecoder().decode(options.body), '{"project_id":"project-1"}')
    return Response.json({ success: true })
  })
  const response = await handler(new Request('https://site.example/api/simulation/prepare?round=2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'en', cookie: 'private=value' },
    body: '{"project_id":"project-1"}'
  }))
  assert.deepEqual(await response.json(), { success: true })
})

test('multipart document uploads preserve the boundary and content', async (context) => {
  const upload = new FormData()
  upload.append('files', new Blob(['Seed document']), 'seed.txt')
  upload.append('simulation_requirement', 'Predict the response')
  mockBackend(context, 'https://backend.example', async (target, options) => {
    assert.match(options.headers.get('content-type'), /^multipart\/form-data; boundary=/)
    const forwarded = new Request(target, { method: options.method, headers: options.headers, body: options.body })
    const data = await forwarded.formData()
    assert.equal(await data.get('files').text(), 'Seed document')
    assert.equal(data.get('simulation_requirement'), 'Predict the response')
    return Response.json({ success: true })
  })
  const response = await handler(new Request('https://site.example/api/graph/ontology/generate', { method: 'POST', body: upload }))
  assert.equal(response.status, 200)
})

test('backend JSON error and HTTP status are preserved', async (context) => {
  mockBackend(context, 'https://backend.example', async () => Response.json({ success: false, error: 'Project not found' }, { status: 404 }))
  const response = await handler(new Request('https://site.example/api/graph/project/missing'))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'Project not found')
})

test('HTML responses do not masquerade as successful API calls', async (context) => {
  mockBackend(context, 'https://backend.example', async () => new Response('<html>Frontend</html>', { headers: { 'content-type': 'text/html' } }))
  const response = await handler(new Request('https://site.example/health'))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'BACKEND_INVALID_RESPONSE')
})

test('network failures return a safe error without internal details', async (context) => {
  mockBackend(context, 'https://backend.example', async () => {
    throw new Error('Internal network details')
  })
  const response = await handler(new Request('https://site.example/health'))
  assert.equal(response.status, 502)
  const data = await response.json()
  assert.equal(data.code, 'BACKEND_UNAVAILABLE')
  assert.doesNotMatch(data.error, /Internal network details/)
})

test('timeouts return a specific retryable error', async (context) => {
  mockBackend(context, 'https://backend.example', async () => {
    throw new DOMException('Timed out', 'TimeoutError')
  })
  const response = await handler(new Request('https://site.example/api/graph/ontology/generate', { method: 'POST', body: '{}' }))
  assert.equal(response.status, 504)
  assert.equal((await response.json()).code, 'BACKEND_TIMEOUT')
})
