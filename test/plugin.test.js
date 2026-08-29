/**
 * The plugin surface: what `apply` registers, and what each tool returns when
 * driven through the same `execute` the registry calls.
 *
 * Nothing here boots a profile or opens a socket. Every tool is built with an
 * injected `fetch` double answering from a checked-in fixture, and the global
 * `fetch` is a guard that throws, so a path that reached for the real network
 * would fail as a test failure rather than a live request to arXiv.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  ARXIV_GET_TOOL_NAME,
  ARXIV_SEARCH_TOOL_NAME,
  MAX_RESULTS_DEFAULT,
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  PLUGIN_NAME,
  apply,
  createArxivGetTool,
  createArxivSearchTool,
  inject,
  name,
  resolveConfig,
} from '../src/index.js'
import { atomFetch, execContext, fixture, networkGuard, stubContext } from './helpers.js'

const guard = networkGuard()

const exec = execContext()

/**
 * Build a search tool wired to one fixture body.
 * @param file - A fixture name, or `undefined` for the standard search feed.
 * @returns The tool and the `fetch` double it was built with.
 */
function searchTool(file = 'search.xml') {
  const fetchImpl = atomFetch(fixture(file))
  return { tool: createArxivSearchTool({ fetch: fetchImpl }), fetchImpl }
}

/**
 * Build a get tool wired to one fixture body.
 * @param file - A fixture name, or `undefined` for the single-paper feed.
 * @returns The tool and the `fetch` double it was built with.
 */
function getTool(file = 'get.xml') {
  const fetchImpl = atomFetch(fixture(file))
  return { tool: createArxivGetTool({ fetch: fetchImpl }), fetchImpl }
}

/** Read the `max_results` a recorded call asked arXiv for. */
function askedMaxResults(fetchImpl) {
  const { searchParams: query } = new URL(fetchImpl.calls.at(-1).url)
  return Number(query.get('max_results'))
}

test('apply registers exactly two tools, named arxiv_search and arxiv_get', () => {
  const { ctx, registered } = stubContext()

  apply(ctx)

  assert.equal(registered.length, 2)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    [ARXIV_SEARCH_TOOL_NAME, ARXIV_GET_TOOL_NAME],
  )
  assert.deepEqual([ARXIV_SEARCH_TOOL_NAME, ARXIV_GET_TOOL_NAME], ['arxiv_search', 'arxiv_get'])
})

test('the plugin declares its cordis name and its one hard dependency', () => {
  assert.deepEqual(inject, ['tools'])
  assert.equal(name, 'arxiv')
  assert.equal(PLUGIN_NAME, 'dsh-arxiv')
})

test('both registered tools describe themselves for the model', () => {
  const { ctx, registered } = stubContext()
  apply(ctx)

  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
    assert.equal(tool.parameters.type, 'object')
  }
  assert.deepEqual(registered[0].parameters.required, ['query'])
  assert.deepEqual(registered[1].parameters.required, ['id'])
  assert.equal(registered[0].parameters.properties.max_results.type, 'integer')
})

test('config bounds fall back to the defaults when the patch row sets none', () => {
  const defaults = resolveConfig()

  assert.ok(defaults.timeoutMs > 0)
  assert.ok(defaults.maxBytes > 0)
  assert.deepEqual(resolveConfig({ timeoutMs: 500, maxBytes: 1024 }), {
    timeoutMs: 500,
    maxBytes: 1024,
  })
})

test('a search parses the fixture feed into the promised paper fields', async () => {
  const { tool, fetchImpl } = searchTool()

  const value = await tool.execute({ query: 'attention', max_results: 2 }, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ARXIV_SEARCH_TOOL_NAME), [])
  assert.equal(value.query, 'attention')
  assert.equal(value.search_query, 'all:attention')
  assert.equal(value.returned, 2)
  assert.equal(value.papers.length, 2)
  assert.equal(value.plugin, PLUGIN_NAME)

  const [paper] = value.papers
  assert.deepEqual(Object.keys(paper).sort(), [
    'abs_url',
    'abstract',
    'authors',
    'id',
    'pdf_url',
    'published',
    'title',
  ])
  assert.equal(paper.id, '2202.09741v5')
  assert.equal(paper.title, 'Visual Attention Network')
  assert.ok(Array.isArray(paper.authors) && paper.authors.length > 0)
  assert.ok(paper.authors.every((author) => typeof author === 'string'))
  assert.match(paper.published, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(paper.abstract.length > 0 && !paper.abstract.includes('\n'))
  assert.match(paper.pdf_url, /^https:\/\/arxiv\.org\/pdf\//)
  assert.match(paper.abs_url, /^https:\/\/arxiv\.org\/abs\//)

  // The URL the caller is handed is the only PDF contact this plugin makes.
  assert.equal(fetchImpl.calls.length, 1)
  assert.ok(fetchImpl.calls[0].url.startsWith('https://export.arxiv.org/api/query?'))
})

test('a search that matches nothing returns an empty list, not a failure', async () => {
  const empty = '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"></feed>'
  const tool = createArxivSearchTool({ fetch: atomFetch(empty) })

  const value = await tool.execute({ query: 'zzzznotathing' }, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ARXIV_SEARCH_TOOL_NAME), [])
  assert.equal(value.returned, 0)
  assert.deepEqual(value.papers, [])
})

test('max_results reaches arXiv clamped into 1–25', async () => {
  for (const [requested, expected] of [
    [undefined, MAX_RESULTS_DEFAULT],
    [0, MAX_RESULTS_MIN],
    [-5, MAX_RESULTS_MIN],
    [1, 1],
    [25, MAX_RESULTS_MAX],
    [500, MAX_RESULTS_MAX],
  ]) {
    const { tool, fetchImpl } = searchTool()
    const args = requested === undefined ? { query: 'x' } : { query: 'x', max_results: requested }

    const value = await tool.execute(args, exec)

    assert.equal(value.max_results, expected, `for ${requested}`)
    assert.equal(askedMaxResults(fetchImpl), expected, `for ${requested}`)
  }
})

test('a get parses the fixture feed into one paper', async () => {
  const { tool } = getTool()

  const value = await tool.execute({ id: '1706.03762' }, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ARXIV_GET_TOOL_NAME), [])
  assert.equal(value.requested_id, '1706.03762')
  assert.equal(value.plugin, PLUGIN_NAME)
  assert.equal(value.paper.id, '1706.03762v7')
  assert.equal(value.paper.title, 'Attention Is All You Need')
  assert.equal(value.paper.published, '2017-06-12T17:57:34Z')
  assert.equal(value.paper.authors[0], 'Ashish Vaswani')
  assert.match(value.paper.abstract, /^The dominant sequence transduction models/)
  assert.equal(value.paper.pdf_url, 'https://arxiv.org/pdf/1706.03762v7')
  assert.equal(value.paper.abs_url, 'https://arxiv.org/abs/1706.03762v7')
})

test('every accepted id spelling reaches arXiv as the same id_list', async () => {
  for (const raw of [
    '1706.03762',
    'arxiv:1706.03762',
    'arXiv:1706.03762',
    'https://arxiv.org/abs/1706.03762',
    'https://arxiv.org/pdf/1706.03762.pdf',
  ]) {
    const { tool, fetchImpl } = getTool()

    const value = await tool.execute({ id: raw }, exec)

    const { searchParams: query } = new URL(fetchImpl.calls[0].url)
    assert.equal(query.get('id_list'), '1706.03762', `for ${raw}`)
    assert.equal(value.requested_id, '1706.03762', `for ${raw}`)
  }

  // A version suffix names a specific revision and survives normalization.
  const { tool, fetchImpl } = getTool()
  await tool.execute({ id: 'arxiv:1706.03762v7' }, exec)
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('id_list'), '1706.03762v7')
})

test('an id arXiv knows nothing about fails loudly rather than returning nothing', async () => {
  // arXiv answers an unknown id with HTTP 200 and a feed holding an error
  // entry, so "no paper" has to be caught here or it reads as success.
  const { tool } = getTool('error.xml')

  await assert.rejects(
    () => tool.execute({ id: '9999.99999' }, exec),
    (error) => {
      assert.equal(error.code, 'ARXIV_NOT_FOUND')
      assert.match(error.message, /9999\.99999/)
      return true
    },
  )
})

test('an id that names no arXiv paper never reaches the network', async () => {
  const { tool, fetchImpl } = getTool()

  await assert.rejects(
    () => tool.execute({ id: 'not an id' }, exec),
    (error) => {
      assert.equal(error.code, 'ARXIV_BAD_ID')
      return true
    },
  )
  assert.deepEqual(fetchImpl.calls, [])
})

test('a transport failure surfaces from the tool rather than being swallowed', async () => {
  for (const status of [429, 503]) {
    const tool = createArxivSearchTool({ fetch: atomFetch('<html>nope</html>', { status }) })
    await assert.rejects(
      () => tool.execute({ query: 'x' }, exec),
      (error) => {
        assert.equal(error.code, 'ARXIV_HTTP_ERROR')
        return true
      },
      `expected ARXIV_HTTP_ERROR for ${status}`,
    )
  }

  const oversize = createArxivGetTool({
    fetch: atomFetch(`<feed>${'x'.repeat(4096)}</feed>`),
    maxBytes: 256,
  })
  await assert.rejects(
    () => oversize.execute({ id: '1706.03762' }, exec),
    (error) => {
      assert.equal(error.code, 'ARXIV_RESPONSE_TOO_LARGE')
      return true
    },
  )
})

test('render projects each validated value into text content blocks', async () => {
  const { tool: search } = searchTool()
  const searchValue = await search.execute({ query: 'attention', max_results: 2 }, exec)
  const searchBlocks = search.output.render({ query: 'attention' }, searchValue)

  assert.equal(searchBlocks.length, 1)
  assert.equal(searchBlocks[0].type, 'text')
  assert.ok(searchBlocks[0].text.includes('Visual Attention Network'))
  assert.ok(searchBlocks[0].text.includes('2202.09741v5'))

  const { tool: get } = getTool()
  const getValue = await get.execute({ id: '1706.03762' }, exec)
  const getBlocks = get.output.render({ id: '1706.03762' }, getValue)

  assert.equal(getBlocks.length, 1)
  assert.equal(getBlocks[0].type, 'text')
  assert.ok(getBlocks[0].text.startsWith('Attention Is All You Need'))
  assert.ok(getBlocks[0].text.includes('https://arxiv.org/abs/1706.03762v7'))
  assert.ok(getBlocks[0].text.includes('The dominant sequence transduction models'))
})

test('render says so plainly when a search matched nothing', async () => {
  const empty = '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"></feed>'
  const tool = createArxivSearchTool({ fetch: atomFetch(empty) })
  const value = await tool.execute({ query: 'zzzznotathing' }, exec)

  const [block] = tool.output.render({ query: 'zzzznotathing' }, value)
  assert.equal(block.type, 'text')
  assert.match(block.text, /^No arXiv papers matched/)
})

test('invalid arguments fail loudly instead of executing', async () => {
  const { tool: search, fetchImpl: searchFetch } = searchTool()
  for (const args of [{}, { query: 42 }, { query: null }, { max_results: 3 }, null, [], 'attention']) {
    await assert.rejects(
      () => search.execute(args, exec),
      (error) => {
        assert.ok(error instanceof ToolArgsError)
        assert.ok(error.violations.length > 0)
        return true
      },
      `expected ToolArgsError for ${JSON.stringify(args) ?? String(args)}`,
    )
  }

  const { tool: get, fetchImpl: getFetch } = getTool()
  for (const args of [{}, { id: 42 }, { id: null }, null, '1706.03762']) {
    await assert.rejects(() => get.execute(args, exec), ToolArgsError)
  }

  // Validation runs before the body, so no rejected call reached arXiv.
  assert.deepEqual(searchFetch.calls, [])
  assert.deepEqual(getFetch.calls, [])
})

test('a non-integer max_results is rejected by the declared schema', async () => {
  const { tool } = searchTool()

  await assert.rejects(() => tool.execute({ query: 'x', max_results: 2.5 }, exec), ToolArgsError)
  await assert.rejects(() => tool.execute({ query: 'x', max_results: '3' }, exec), ToolArgsError)
})

test('the manifest declares the bundle patch the profile installer looks for', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.name, PLUGIN_NAME)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')

  const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, new RegExp(`^\\s+- id: ${name}$`, 'm'))
  assert.match(patch, new RegExp(`^\\s+name: ${manifest.name}$`, 'm'))
})

test('nothing in this file reached the real network', () => {
  assert.deepEqual(guard.attempts, [])
  assert.equal(globalThis.fetch, guard)
})
