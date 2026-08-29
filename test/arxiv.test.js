/**
 * The HTTP seam and the argument normalization around it.
 *
 * Every request in this file goes through an injected `fetch` double; the
 * global `fetch` is replaced with a guard that throws, so a path that forgot
 * to take the injected one fails here rather than reaching export.arxiv.org.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARXIV_API_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULTS_DEFAULT,
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  USER_AGENT,
  VERSION,
  clampMaxResults,
  fetchFeed,
  idParams,
  normalizeArxivId,
  searchParams,
  toSearchQuery,
} from '../src/arxiv.js'
import { ArxivError } from '../src/errors.js'
import {
  GUARD_MESSAGE,
  atomFetch,
  fixture,
  hangingFetch,
  networkGuard,
  recordingFetch,
} from './helpers.js'

const guard = networkGuard()

/** Assert a promise rejects with an {@link ArxivError} carrying `code`. */
async function rejectsWithCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof ArxivError, `expected ArxivError, got ${error}`)
    assert.equal(error.code, code)
    return true
  })
}

test('the endpoint is the public HTTPS query API and nothing else', () => {
  assert.equal(ARXIV_API_URL, 'https://export.arxiv.org/api/query')
  assert.ok(ARXIV_API_URL.startsWith('https://'))
})

test('the User-Agent names the plugin, its version, and a contact URL', () => {
  assert.equal(USER_AGENT, `dsh-arxiv/${VERSION} (+https://github.com/jwilson411/dsh-arxiv)`)
  assert.match(USER_AGENT, /https:\/\/github\.com\/jwilson411\/dsh-arxiv/)
})

test('requests carry the polite User-Agent and ask for Atom', async () => {
  const fetchImpl = atomFetch(fixture('search.xml'))

  await fetchFeed(searchParams('all:attention', 2), { fetch: fetchImpl })

  assert.equal(fetchImpl.calls.length, 1)
  const [{ url, init }] = fetchImpl.calls
  assert.ok(url.startsWith(`${ARXIV_API_URL}?`))
  assert.equal(init.headers['user-agent'], USER_AGENT)
  assert.equal(init.headers.accept, 'application/atom+xml')
  assert.equal(init.method, 'GET')
  assert.ok(init.signal instanceof AbortSignal)
})

test('max_results is clamped into 1–25, and defaults inside it', () => {
  assert.equal(clampMaxResults(undefined), MAX_RESULTS_DEFAULT)
  assert.ok(MAX_RESULTS_DEFAULT >= MAX_RESULTS_MIN && MAX_RESULTS_DEFAULT <= MAX_RESULTS_MAX)

  assert.equal(clampMaxResults(0), MAX_RESULTS_MIN)
  assert.equal(clampMaxResults(-7), MAX_RESULTS_MIN)
  assert.equal(clampMaxResults(1), 1)
  assert.equal(clampMaxResults(25), 25)
  assert.equal(clampMaxResults(26), MAX_RESULTS_MAX)
  assert.equal(clampMaxResults(10_000), MAX_RESULTS_MAX)
  assert.equal(clampMaxResults(Number.NaN), MAX_RESULTS_DEFAULT)
  assert.equal(clampMaxResults(Number.POSITIVE_INFINITY), MAX_RESULTS_DEFAULT)
})

test('every accepted id spelling normalizes to the same identifier', () => {
  for (const raw of [
    '1706.03762',
    ' 1706.03762 ',
    'arxiv:1706.03762',
    'arXiv:1706.03762',
    'https://arxiv.org/abs/1706.03762',
    'http://arxiv.org/abs/1706.03762',
    'arxiv.org/abs/1706.03762',
    'https://arxiv.org/pdf/1706.03762.pdf',
    'https://arxiv.org/abs/1706.03762?context=cs',
    'https://arxiv.org/abs/1706.03762#comments',
  ]) {
    assert.equal(normalizeArxivId(raw), '1706.03762', `for ${raw}`)
  }
})

test('a version suffix is part of the identifier and is kept', () => {
  assert.equal(normalizeArxivId('1706.03762v7'), '1706.03762v7')
  assert.equal(normalizeArxivId('arxiv:1706.03762v7'), '1706.03762v7')
  assert.equal(normalizeArxivId('https://arxiv.org/abs/1706.03762v7'), '1706.03762v7')
  assert.equal(normalizeArxivId('https://arxiv.org/pdf/1706.03762v7'), '1706.03762v7')
})

test('pre-2007 identifiers are accepted in every spelling too', () => {
  assert.equal(normalizeArxivId('hep-th/9901001'), 'hep-th/9901001')
  assert.equal(normalizeArxivId('math.GT/0309136'), 'math.GT/0309136')
  assert.equal(normalizeArxivId('arxiv:hep-th/9901001v2'), 'hep-th/9901001v2')
  assert.equal(normalizeArxivId('https://arxiv.org/abs/math.GT/0309136'), 'math.GT/0309136')
})

test('something that names no arXiv paper fails loudly', () => {
  for (const raw of ['', '   ', 'not an id', '17060376', 'https://example.com/abs/1706.03762x', 42, null]) {
    assert.throws(
      () => normalizeArxivId(raw),
      (error) => {
        assert.ok(error instanceof ArxivError)
        assert.equal(error.code, 'ARXIV_BAD_ID')
        return true
      },
      `expected ARXIV_BAD_ID for ${JSON.stringify(raw) ?? String(raw)}`,
    )
  }
})

test('a plain phrase searches all fields; a prefixed query is sent as written', () => {
  assert.equal(toSearchQuery('attention is all you need'), 'all:attention is all you need')
  assert.equal(toSearchQuery('  transformers  '), 'all:transformers')
  assert.equal(toSearchQuery('au:Hinton AND cat:cs.LG'), 'au:Hinton AND cat:cs.LG')
  assert.equal(toSearchQuery('ti:"attention"'), 'ti:"attention"')
  assert.equal(toSearchQuery('all:diffusion'), 'all:diffusion')
})

test('a blank query fails loudly instead of asking arXiv for everything', () => {
  for (const query of ['', '   ', null]) {
    assert.throws(() => toSearchQuery(query), (error) => {
      assert.equal(error.code, 'ARXIV_BAD_QUERY')
      return true
    })
  }
})

test('the query string sends the documented parameters', () => {
  const search = new URLSearchParams(searchParams('all:attention', 3))
  assert.equal(search.get('search_query'), 'all:attention')
  assert.equal(search.get('start'), '0')
  assert.equal(search.get('max_results'), '3')

  const byId = new URLSearchParams(idParams('1706.03762v7'))
  assert.equal(byId.get('id_list'), '1706.03762v7')
  assert.equal(byId.get('max_results'), '1')
  assert.equal(byId.get('search_query'), null)
})

test('a non-2xx status fails loudly and never reaches the parser', async () => {
  for (const status of [400, 403, 429, 500, 503]) {
    const fetchImpl = atomFetch('<html>nope</html>', { status })
    await rejectsWithCode(
      () => fetchFeed(searchParams('all:x', 1), { fetch: fetchImpl }),
      'ARXIV_HTTP_ERROR',
    )
  }
})

test('a body over the cap is abandoned mid-stream', async () => {
  const oversize = `<feed>${'x'.repeat(4096)}</feed>`
  const fetchImpl = atomFetch(oversize)

  await rejectsWithCode(
    () => fetchFeed(searchParams('all:x', 1), { fetch: fetchImpl, maxBytes: 512 }),
    'ARXIV_RESPONSE_TOO_LARGE',
  )
})

test('a declared content-length over the cap is refused before the body is read', async () => {
  let bodyRead = false
  const fetchImpl = recordingFetch(() => ({
    status: 200,
    headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
    text: async () => {
      bodyRead = true
      return 'x'
    },
  }))

  await rejectsWithCode(
    () => fetchFeed(searchParams('all:x', 1), { fetch: fetchImpl, maxBytes: 1024 }),
    'ARXIV_RESPONSE_TOO_LARGE',
  )
  assert.equal(bodyRead, false)
})

test('a response with no readable stream is still capped', async () => {
  const fetchImpl = recordingFetch(() => ({
    status: 200,
    headers: new Headers(),
    text: async () => 'x'.repeat(4096),
  }))

  await rejectsWithCode(
    () => fetchFeed(searchParams('all:x', 1), { fetch: fetchImpl, maxBytes: 512 }),
    'ARXIV_RESPONSE_TOO_LARGE',
  )
})

test('a body within the cap is returned whole', async () => {
  const fetchImpl = atomFetch(fixture('get.xml'))

  const body = await fetchFeed(idParams('1706.03762'), {
    fetch: fetchImpl,
    maxBytes: DEFAULT_MAX_BYTES,
  })

  assert.equal(body, fixture('get.xml'))
})

test('a request that outlives its deadline fails as a timeout', async () => {
  const hanging = hangingFetch()

  await rejectsWithCode(
    () => fetchFeed(searchParams('all:x', 1), { fetch: hanging, timeoutMs: 20 }),
    'ARXIV_TIMEOUT',
  )
})

test("the caller's own abort cancels the request and surfaces the caller's reason", async () => {
  const controller = new AbortController()
  const reason = new Error('caller went away')
  const hanging = hangingFetch()
  setTimeout(() => controller.abort(reason), 5)

  await assert.rejects(
    () => fetchFeed(searchParams('all:x', 1), { fetch: hanging, signal: controller.signal }),
    (error) => {
      assert.equal(error, reason)
      assert.ok(!(error instanceof ArxivError))
      return true
    },
  )
})

test('an unreachable host fails loudly rather than silently returning nothing', async () => {
  const failing = recordingFetch(() => {
    throw new TypeError('fetch failed')
  })

  await rejectsWithCode(
    () => fetchFeed(searchParams('all:x', 1), { fetch: failing }),
    'ARXIV_UNREACHABLE',
  )
})

test('the defaults bound every request even when nothing configures them', () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_TIMEOUT_MS))
  assert.ok(DEFAULT_MAX_BYTES > 0 && Number.isFinite(DEFAULT_MAX_BYTES))
})

test('nothing in this file reached the real network', () => {
  assert.deepEqual(guard.attempts, [])
  assert.equal(globalThis.fetch, guard)
})

test('a call that forgets the injected fetch is caught by the guard, not sent', async () => {
  await assert.rejects(
    () => fetchFeed(searchParams('all:x', 1), {}),
    (error) => {
      assert.equal(error.code, 'ARXIV_UNREACHABLE')
      assert.match(error.message, new RegExp(GUARD_MESSAGE))
      return true
    },
  )
  assert.deepEqual(guard.attempts, [`${ARXIV_API_URL}?${searchParams('all:x', 1)}`])
  guard.attempts.length = 0
})
