import type { Config } from '@netlify/functions'

function apiError(status: number, code: string, message: string) {
  return Response.json(
    { success: false, code, error: message },
    { status, headers: { 'Cache-Control': 'no-store' } }
  )
}

export default async (request: Request) => {
  const requestUrl = new URL(request.url)
  if (requestUrl.pathname !== '/health' && !requestUrl.pathname.startsWith('/api/')) {
    return apiError(404, 'NOT_FOUND', 'API endpoint not found.')
  }

  const backendUrl = Netlify.env.get('MIROFISH_BACKEND_URL')
  if (!backendUrl) {
    return apiError(503, 'BACKEND_NOT_CONFIGURED', 'The simulation backend is not connected. Set MIROFISH_BACKEND_URL to the HTTPS origin of your running MiroFish Python backend in Netlify environment settings.')
  }

  let target: URL
  try {
    target = new URL(backendUrl)
    if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash || target.origin === requestUrl.origin) {
      throw new Error('Invalid backend origin')
    }
    target.pathname = requestUrl.pathname
    target.search = requestUrl.search
  } catch {
    return apiError(503, 'BACKEND_NOT_CONFIGURED', 'MIROFISH_BACKEND_URL must be the HTTPS origin of a separate MiroFish Python backend, without a path, query string, or credentials.')
  }

  const headers = new Headers()
  for (const name of ['content-type', 'accept', 'accept-language']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'error',
      signal: AbortSignal.timeout(requestUrl.pathname === '/health' ? 8000 : 55000)
    })

    const contentType = response.headers.get('content-type') || ''
    if (response.status !== 204 && !contentType.includes('application/json')) {
      await response.body?.cancel()
      return apiError(502, 'BACKEND_INVALID_RESPONSE', 'The backend did not return JSON. Check that the configured address points to the MiroFish Python API, not the frontend.')
    }

    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': contentType || 'application/json',
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      return apiError(504, 'BACKEND_TIMEOUT', 'The simulation backend took too long to respond. Try again, or use a direct VITE_API_BASE_URL connection for long-running requests.')
    }
    return apiError(502, 'BACKEND_UNAVAILABLE', 'The simulation backend could not be reached. Check that the Python server is running and accessible over HTTPS.')
  }
}

export const config: Config = {
  path: ['/api/*', '/health']
}
