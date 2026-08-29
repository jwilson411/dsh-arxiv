/**
 * The read-only client for arXiv's public query API.
 *
 * One endpoint, over HTTPS, with no key: `https://export.arxiv.org/api/query`.
 * Nothing here scrapes an HTML page and nothing downloads a PDF — the API is
 * the only source, and `pdf_url` is reported for the caller to open, never
 * fetched.
 *
 * Every request is bounded twice, and fails closed on either bound: an
 * `AbortSignal` deadline, and a byte cap enforced while the body streams so an
 * oversized response is abandoned rather than buffered whole.
 *
 * @module dsh-arxiv/arxiv
 */
import { ArxivError } from './errors.js'

/** The public query endpoint. HTTPS only, and not configurable. */
export const ARXIV_API_URL = 'https://export.arxiv.org/api/query'

/** This package's version, mirrored from the manifest for the User-Agent. */
export const VERSION = '0.1.0'

/**
 * The User-Agent every request sends.
 *
 * arXiv's terms of use ask that automated clients identify themselves and
 * offer a contact point, so this names the plugin and its repository.
 * @see https://info.arxiv.org/help/api/tou.html
 */
export const USER_AGENT = `dsh-arxiv/${VERSION} (+https://github.com/jwilson411/dsh-arxiv)`

/** How long to wait for arXiv before failing closed. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** How much response body to accept before failing closed. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Smallest, largest, and default `max_results` for a search. */
export const MAX_RESULTS_MIN = 1
export const MAX_RESULTS_MAX = 25
export const MAX_RESULTS_DEFAULT = 5

/** Modern arXiv identifiers: `1706.03762`, optionally versioned. */
const NEW_STYLE_ID = /^\d{4}\.\d{4,5}(v\d+)?$/

/** Pre-2007 identifiers: `hep-th/9901001`, `math.GT/0309136`. */
const OLD_STYLE_ID = /^[a-z][a-z-]*(\.[A-Za-z-]+)?\/\d{7}(v\d+)?$/

/** The field prefixes arXiv's `search_query` grammar defines. */
const FIELD_PREFIX = /^(all|ti|au|abs|co|jr|cat|rn|id):/i

/**
 * Reduce anything that names an arXiv paper to the bare identifier.
 *
 * Accepts `1706.03762`, `arxiv:1706.03762`, `1706.03762v7`, an `/abs/` or
 * `/pdf/` URL, and the pre-2007 `hep-th/9901001` form. A version suffix is
 * kept: it is part of the identifier, and dropping it would silently answer
 * about a different revision than the one asked for.
 * @param raw - The caller's `id` argument.
 * @returns The normalized identifier.
 * @throws {ArxivError} `ARXIV_BAD_ID` if it names no arXiv paper.
 */
export function normalizeArxivId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ArxivError('ARXIV_BAD_ID', 'an arXiv id is required')
  }

  let value = raw.trim().replace(/[?#].*$/, '')

  const path = /(?:^|\/)(?:abs|pdf)\/(.+)$/.exec(value)
  if (path !== null) value = path[1]

  value = value
    .replace(/^arxiv:/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/\/+$/, '')

  if (!NEW_STYLE_ID.test(value) && !OLD_STYLE_ID.test(value)) {
    throw new ArxivError('ARXIV_BAD_ID', `not an arXiv id: ${JSON.stringify(raw)}`)
  }

  return value
}

/**
 * Hold a requested result count inside the range the tool documents.
 *
 * The cap is the plugin's own politeness limit as much as a guard: this is a
 * lookup tool, not a bulk harvester.
 * @param requested - The caller's `max_results`, or undefined.
 * @returns An integer in `[MAX_RESULTS_MIN, MAX_RESULTS_MAX]`.
 */
export function clampMaxResults(requested) {
  if (!Number.isFinite(requested)) return MAX_RESULTS_DEFAULT
  return Math.min(MAX_RESULTS_MAX, Math.max(MAX_RESULTS_MIN, Math.trunc(requested)))
}

/**
 * Turn a caller's query into arXiv's `search_query` grammar.
 *
 * A query that already opens with a field prefix is a deliberate structured
 * query and is passed through verbatim; anything else is searched across all
 * fields, which is what a plain phrase means.
 * @param query - The caller's `query` argument.
 * @returns The `search_query` value to send.
 * @throws {ArxivError} `ARXIV_BAD_QUERY` if the query is blank.
 */
export function toSearchQuery(query) {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (trimmed === '') throw new ArxivError('ARXIV_BAD_QUERY', 'a non-empty query is required')
  return FIELD_PREFIX.test(trimmed) ? trimmed : `all:${trimmed}`
}

/**
 * Read a response body, abandoning it the moment it exceeds the cap.
 * @param response - The fetch response.
 * @param maxBytes - The byte cap.
 * @param deadline - The timeout signal, consulted to classify a read failure.
 * @returns The decoded body.
 * @throws {ArxivError} `ARXIV_RESPONSE_TOO_LARGE`, `ARXIV_TIMEOUT`, or `ARXIV_UNREACHABLE`.
 */
async function readCapped(response, maxBytes, deadline) {
  const tooLarge = () =>
    new ArxivError(
      'ARXIV_RESPONSE_TOO_LARGE',
      `arXiv response exceeded the ${maxBytes} byte cap`,
    )

  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()

  const body = response.body
  if (body === undefined || body === null || typeof body.getReader !== 'function') {
    // A response without a readable stream — the shape a hand-rolled test
    // double takes. Cap it after the fact; there is nothing to stop early.
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge()
    return text
  }

  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  } catch (cause) {
    if (cause instanceof ArxivError) throw cause
    if (deadline.aborted) throw new ArxivError('ARXIV_TIMEOUT', 'arXiv did not answer in time', { cause })
    throw new ArxivError('ARXIV_UNREACHABLE', `could not read the arXiv response: ${cause.message}`, { cause })
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Fetch one Atom feed from the query API.
 * @param params - The query string parameters.
 * @param options - `fetch` to use, `timeoutMs`, `maxBytes`, and the caller's `signal`.
 * @returns The feed body as text.
 * @throws {ArxivError} On timeout, an oversized body, a non-2xx status, or an unreachable host.
 */
export async function fetchFeed(params, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
  } = options

  const url = `${ARXIV_API_URL}?${params}`
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/atom+xml', 'user-agent': USER_AGENT },
      signal: combined,
    })
  } catch (cause) {
    if (deadline.aborted) {
      throw new ArxivError('ARXIV_TIMEOUT', `arXiv did not answer within ${timeoutMs}ms`, { cause })
    }
    // The caller cancelling is the caller's business, not an arXiv failure:
    // let the harness see its own abort reason rather than a wrapped one.
    if (signal?.aborted) throw cause
    throw new ArxivError('ARXIV_UNREACHABLE', `could not reach arXiv: ${cause.message}`, { cause })
  }

  const status = response.status ?? 0
  if (status < 200 || status >= 300) {
    throw new ArxivError('ARXIV_HTTP_ERROR', `arXiv answered ${status} for the query API`)
  }

  return readCapped(response, maxBytes, deadline)
}

/**
 * Build the query string for a search.
 * @param searchQuery - A value from {@link toSearchQuery}.
 * @param maxResults - A clamped result count.
 * @returns The encoded query string.
 */
export function searchParams(searchQuery, maxResults) {
  return new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(maxResults),
  }).toString()
}

/**
 * Build the query string for a single-id lookup.
 * @param id - A normalized identifier.
 * @returns The encoded query string.
 */
export function idParams(id) {
  return new URLSearchParams({ id_list: id, start: '0', max_results: '1' }).toString()
}
