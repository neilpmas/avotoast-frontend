import { Hono, type Context } from 'hono'
import { createBezzie, providers, cloudflareKVAdapter, type AuthenticatedVariables } from 'bezzie'
import { createClient, ConnectError, Code } from '@connectrpc/connect'
import { TemplateService } from '@template/proto'
import * as Sentry from '@sentry/cloudflare'
import { getTransport } from './lib/transport'
import { log } from './lib/log'

// This is a pure JSON API + auth-redirect service, not an HTML-rendering app --
// default-src 'none' is the correct baseline (nothing here needs scripts, styles,
// images, or frames of its own). bezzie's cspContributions() adds only what its
// OAuth flow actually needs (currently just form-action -- see bezzie's own docs
// for why connect-src/frame-src stay empty for a correct BFF architecture).
function buildCsp(contributions: Record<string, string[]>): string {
  const directives = new Map<string, string[]>([
    ['default-src', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
  ])
  for (const [directive, origins] of Object.entries(contributions)) {
    if (origins.length === 0) continue
    directives.set(directive, [...(directives.get(directive) ?? []), ...origins])
  }
  return Array.from(directives.entries())
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ')
}

export interface Env {
  SESSION_KV: KVNamespace
  AUTH0_DOMAIN: string
  AUTH0_CLIENT_ID: string
  AUTH0_CLIENT_SECRET: string
  AUTH0_AUDIENCE: string
  APP_BASE_URL: string
  BACKEND_URL: string
  // Optional -- unset SENTRY_DSN is a documented no-op in the SDK, not an error.
  SENTRY_DSN?: string
}

// Auth middleware is mounted once for /api/*, not per route, so route handlers
// don't infer bezzie's user/accessToken types from it -- declare them here.
type Variables = AuthenticatedVariables & {
  requestId: string
}

function buildApp(env: Env) {
  const isLocal = new URL(env.APP_BASE_URL).hostname === 'localhost'
  const auth = createBezzie({
    ...providers.auth0(env.AUTH0_DOMAIN),
    clientId: env.AUTH0_CLIENT_ID,
    clientSecret: env.AUTH0_CLIENT_SECRET,
    audience: env.AUTH0_AUDIENCE,
    adapter: cloudflareKVAdapter(env.SESSION_KV),
    baseUrl: env.APP_BASE_URL,
    defaultReturnTo: '/dashboard',
    // Plain http://localhost can't carry Secure / __Host- cookies in every browser.
    secureCookies: !isLocal,
    // Explicit rather than relying on bezzie's defaults staying put --
    // flood/quota protection on /auth/login and /auth/callback, not
    // brute-force protection (Auth0's hosted login handles that). Fails
    // open on any counter-store error.
    rateLimit: { enabled: true, limit: 10, windowSeconds: 120 },
  })

  const app = new Hono<{ Bindings: Env; Variables: Variables }>()

  // Runs before auth, so every request gets one log line -- including auth
  // failures and 404s, which otherwise log nothing at all. The request id is
  // threaded onto outgoing backend calls (x-request-id) so a single id greps
  // across both services' logs for the same request.
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    const startedAt = Date.now()
    await next()
    log.info('request completed', {
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      userSub: c.var.user?.sub,
    })
  })

  // Applies to every response, auth routes included -- bezzie's own routes
  // further tighten frame-ancestors on top of whatever's already set here.
  app.use('*', async (c, next) => {
    const contributions = await auth.cspContributions()
    c.header('Content-Security-Policy', buildCsp(contributions))
    await next()
  })

  // Auth runs first so the limiter below sees c.var.user and keys on the user's
  // sub. Mounted the other way round, the limiter never sees a user and silently
  // falls back to keying on IP. Doing auth first also means unauthenticated
  // requests are turned away without a counter write.
  app.use('/api/*', auth.middleware())

  // General API abuse protection, separate from bezzie's own auth-route
  // limiter (config'd on createBezzie above) -- generous enough that a real
  // user never notices, tight enough to blunt a scripted loop. Pair it with a
  // Cloudflare zone rate-limit rule, which stops floods before the Worker runs.
  app.use('/api/*', auth.rateLimiter({ limit: 30, windowSeconds: 60 }))

  app.route('/auth', auth.routes())
  app.get('/api/me', (c) => c.json(c.var.user))

  const handleConnectError = (err: unknown, c: Context<{ Bindings: Env; Variables: Variables }>) => {
    if (err instanceof ConnectError) {
      switch (err.code) {
        case Code.NotFound:
          return c.json({ error: 'Not Found' }, 404)
        case Code.PermissionDenied:
          return c.json({ error: 'Permission Denied' }, 403)
        case Code.Unauthenticated:
          return c.json({ error: 'Unauthenticated' }, 401)
      }
    }
    // Only reached for ConnectError codes not handled above (i.e. genuinely
    // unexpected ones, not the routine NotFound/PermissionDenied/Unauthenticated
    // cases) and non-Connect errors -- both are worth Sentry's attention.
    Sentry.captureException(err, { extra: { requestId: c.var.requestId } })
    if (err instanceof ConnectError) {
      log.error('backend call failed', {
        requestId: c.var.requestId,
        connectErrorCode: err.code,
        message: err.message,
        rawMessage: err.rawMessage,
      })
    } else {
      log.error('backend call failed with a non-Connect error', {
        requestId: c.var.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  app.get('/api/info', async (c) => {
    const client = createClient(TemplateService, getTransport(c.env.BACKEND_URL))
    try {
      const info = await client.getServerInfo(
        {},
        { headers: { authorization: `Bearer ${c.var.accessToken}`, 'x-request-id': c.var.requestId } },
      )
      // protobuf-es messages carry a $typeName field and other internals that
      // shouldn't leak into the JSON API -- pick only the fields the frontend uses.
      return c.json({ version: info.version, environment: info.environment })
    } catch (err) {
      return handleConnectError(err, c)
    }
  })

  return app
}

// Built once per isolate: createBezzie() owns an OIDC discovery cache (and the
// limiter's in-memory pre-filter), so constructing it per request throws both
// away and re-fetches Auth0's discovery document on every single request.
// Worker bindings are stable for the life of an isolate, so capturing them here is fine.
let app: ReturnType<typeof buildApp> | undefined

const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= buildApp(env)
    return app.fetch(request, env, ctx)
  },
}

// Error tracking only for now, no performance tracing -- matches the backend's
// Sentry config, and keeps a free-tier event quota from getting eaten by spans
// nothing here needs yet.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  }),
  worker,
)
