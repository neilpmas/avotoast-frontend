import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

// The template ships a placeholder tenant; an app replaces it with its real Auth0 domain.
const TEMPLATE_PLACEHOLDER = 'your-tenant.auth0.com'

// Logout is a same-origin form POST that the BFF answers with a 302 to Auth0's
// /v2/logout. Browsers enforce the submitting page's form-action against that
// redirect, so this page's CSP must allow the Auth0 origin or Logout silently does nothing.
describe('_headers CSP', () => {
  it('allows form-action to the Auth0 origin the BFF redirects logout to', () => {
    const wrangler = readFileSync(resolve(__dirname, '../../bff/wrangler.toml'), 'utf8')
    // Empty in the template; set once an app configures its tenant.
    const domain = /^AUTH0_DOMAIN\s*=\s*"([^"]*)"/m.exec(wrangler)?.[1] || TEMPLATE_PLACEHOLDER

    const headers = readFileSync(resolve(__dirname, '../public/_headers'), 'utf8')
    const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? ''
    const formAction = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action'))

    expect(formAction).toContain(`https://${domain}`)
  })
})
