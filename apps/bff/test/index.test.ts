import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExecutionContext } from '@cloudflare/workers-types'
import type { Client } from '@connectrpc/connect'
import { TemplateService } from '@template/proto'
import worker from '../src/index'
import type { Env } from '../src'
import { createClient } from '@connectrpc/connect'

vi.mock('../src/lib/transport', () => ({
  getTransport: vi.fn(),
}))

vi.mock('@connectrpc/connect', async () => {
  const actual = await vi.importActual<typeof import('@connectrpc/connect')>('@connectrpc/connect')
  return { ...actual, createClient: vi.fn() }
})

let discoveryFetches = 0

vi.stubGlobal('fetch', async (url: string) => {
  if (url.includes('.well-known/openid-configuration')) {
    discoveryFetches += 1
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
  const env = (globalThis as unknown as { env: Record<string, unknown> }).env || {}
  const TEST_ENV = {
    ...env,
    SESSION_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    AUTH0_DOMAIN: 'test.example.com',
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
    AUTH0_AUDIENCE: 'https://api.test.example.com',
    APP_BASE_URL: 'https://test.example.com',
    BACKEND_URL: 'https://backend.example.com',
  } as unknown as Env & { SESSION_KV: { get: Mock, put: Mock, delete: Mock } }

  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext

  beforeEach(() => {
    vi.clearAllMocks()
  })

  const setupSessions = (sessions: Record<string, string>) => {
    // sessions maps session id -> user sub
    const now = Math.floor(Date.now() / 1000)
    vi.mocked(TEST_ENV.SESSION_KV.get).mockImplementation(async (key: string, type?: string) => {
      const sub = sessions[key.replace(/^session:/, '')]
      if (!key.startsWith('session:') || !sub) return null
      const session = {
        _type: 'session',
        accessToken: `token-${sub}`,
        expiresAt: now + 3600,
        createdAt: now,
        user: { sub },
      }
      return type === 'json' ? session : JSON.stringify(session)
    })
  }

  it('redirects to login on /auth/login', async () => {
    const response = await worker.fetch(new Request('https://test.example.com/auth/login'), TEST_ENV, ctx)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('auth0.com')
  })

  it('returns 401 for /api/me without session', async () => {
    const response = await worker.fetch(new Request('https://test.example.com/api/me'), TEST_ENV, ctx)

    expect(response.status).toBe(401)
  })

  it('sets a locked-down Content-Security-Policy and hardening headers', async () => {
    const response = await worker.fetch(new Request('https://test.example.com/auth/login'), TEST_ENV, ctx)

    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })

  describe('GET /api/info', () => {
    it('returns only version and environment, not the protobuf-es $typeName field', async () => {
      setupSessions({ 'session-info': 'user-info' })
      const getServerInfo = vi.fn().mockResolvedValue({
        $typeName: 'template.v1.GetServerInfoResponse',
        version: '1.2.3',
        environment: 'production',
      })
      vi.mocked(createClient).mockReturnValue({ getServerInfo } as unknown as Client<typeof TemplateService>)

      const response = await worker.fetch(
        new Request('https://test.example.com/api/info', { headers: { Cookie: '__Host-session=session-info' } }),
        TEST_ENV,
        ctx,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ version: '1.2.3', environment: 'production' })
      expect(getServerInfo).toHaveBeenCalled()
    })
  })

  it('fetches Auth0 discovery once and reuses it across requests', async () => {
    // Every request runs cspContributions(), which reads OIDC discovery. The auth
    // instance (and its cache) is built once per isolate, so every request made by
    // this file's tests shares a single discovery fetch.
    for (let i = 0; i < 5; i++) {
      await worker.fetch(new Request('https://test.example.com/api/me'), TEST_ENV, ctx)
    }

    expect(discoveryFetches).toBe(1)
  })

  describe('/api/* rate limiting', () => {
    const getMe = (sessionId?: string, headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request('https://test.example.com/api/me', {
          headers: { ...(sessionId ? { Cookie: `__Host-session=${sessionId}` } : {}), ...headers },
        }),
        TEST_ENV,
        ctx,
      )

    it('turns unauthenticated requests away with 401 before they reach the limiter', async () => {
      // The CF-Connecting-IP header gives the limiter something to key on. If it ran
      // ahead of auth, this IP would start getting 429s after 30.
      const statuses = new Set<number>()
      for (let i = 0; i < 65; i++) {
        statuses.add((await getMe(undefined, { 'cf-connecting-ip': '203.0.113.9' })).status)
      }

      expect([...statuses]).toEqual([401])
      expect(TEST_ENV.SESSION_KV.put).not.toHaveBeenCalled()
    })

    it('limits an authenticated user by their own sub, without touching other users', async () => {
      setupSessions({ 'session-a': 'user-a', 'session-b': 'user-b' })

      // No CF-Connecting-IP header here, so bezzie skips limiting entirely unless it
      // keyed on the user -- a 429 at all proves identity keying. 65 requests
      // guarantees the limit is crossed even if the 60s window rolls over mid-loop.
      const responses: Response[] = []
      for (let i = 0; i < 65; i++) responses.push(await getMe('session-a'))

      const limited = responses.find((r) => r.status === 429)
      expect(limited).toBeDefined()
      expect(limited?.headers.get('Retry-After')).toBe('60')

      expect((await getMe('session-b')).status).toBe(200)
    })
  })
})
