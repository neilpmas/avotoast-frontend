import { createConnectTransport } from '@connectrpc/connect-web'
import type { Transport } from '@connectrpc/connect'
import { workersFetch } from './workersFetch'

// One transport per Worker isolate, rebuilt only if the backend URL changes.
// Building it inside a request handler would pay the setup cost on every request.
let cachedTransport: Transport | undefined
let cachedBaseUrl: string | undefined

export function getTransport(baseUrl: string): Transport {
  if (!cachedTransport || cachedBaseUrl !== baseUrl) {
    cachedTransport = createConnectTransport({
      baseUrl: `${baseUrl}/connect`,
      useBinaryFormat: true,
      fetch: workersFetch,
    })
    cachedBaseUrl = baseUrl
  }
  return cachedTransport
}
