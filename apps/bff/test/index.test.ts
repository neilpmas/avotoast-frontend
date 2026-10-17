import { describe, it, expect, vi } from 'vitest'
import worker from '../src/index'

vi.stubGlobal('fetch', async (url: string) => {
  if (url.includes('.well-known/openid-configuration')) {
    return new Response(JSON.stringify({
      issuer: 'https://test.example.com',
      authorization_endpoint: 'https://test.auth0.com/authorize',
      token_endpoint: 'https://test.auth0.com/oauth/token',
      jwks_uri: 'https://test.auth0.com/.well-known/jwks.json',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response('', { status: 404 })
})

describe('BFF Worker', () => {
  const env = (globalThis as any).env || {}
  const TEST_ENV = {
    ...env,
    SESSION_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    AUTH0_DOMAIN: 'test.example.com',
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
    AUTH0_AUDIENCE: 'https://api.test.example.com',
    APP_BASE_URL: 'https://test.example.com',
  }

  it('redirects to login on /auth/login', async () => {
    const request = new Request('https://test.example.com/auth/login')
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as any
    const response = await worker.fetch(request, TEST_ENV, ctx)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('auth0.com')
  })

  it('returns 401 for /api/me without session', async () => {
    const request = new Request('https://test.example.com/api/me')
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as any
    const response = await worker.fetch(request, TEST_ENV, ctx)

    expect(response.status).toBe(401)
  })
})
