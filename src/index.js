/**
 * dsh-arxiv — a DeepSeek Harness function plugin for looking papers up on
 * arXiv.
 *
 * The plugin registers exactly two model-facing tools against the `tools`
 * service and owns nothing else: `arxiv_search` finds papers, `arxiv_get`
 * fetches one by identifier. Both are read-only, both talk to the public Atom
 * API over HTTPS and nothing else, and neither downloads a PDF — `pdf_url` is
 * reported so the caller can open it, never fetched here.
 *
 * Registration happens inside `apply` so the Cordis fiber owns the effect:
 * stopping, updating, or reloading the plugin unregisters both tools with no
 * bookkeeping here. Named exports preserve the loader's injection metadata.
 *
 * @module dsh-arxiv
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULTS_DEFAULT,
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  clampMaxResults,
  fetchFeed,
  idParams,
  normalizeArxivId,
  searchParams,
  toSearchQuery,
} from './arxiv.js'
import { parseAtomFeed } from './atom.js'
import { ArxivError } from './errors.js'

export { ArxivError, ARXIV_ERROR_CODES } from './errors.js'
export { parseAtomFeed, sanitizeText } from './atom.js'
export {
  ARXIV_API_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULTS_DEFAULT,
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  USER_AGENT,
  clampMaxResults,
  normalizeArxivId,
  toSearchQuery,
} from './arxiv.js'

/** The plugin's own identity, echoed by both tools so a caller can confirm the source. */
export const PLUGIN_NAME = 'dsh-arxiv'

/** The search tool's model-facing name. */
export const ARXIV_SEARCH_TOOL_NAME = 'arxiv_search'

/** The lookup tool's model-facing name. */
export const ARXIV_GET_TOOL_NAME = 'arxiv_get'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'arxiv'

/**
 * `tools` is a hard dependency: with no registry there is nothing for this
 * plugin to do, so it waits rather than degrading.
 */
export const inject = ['tools']

/**
 * The paper shape both tools report. Metadata only: no PDF bytes, and no full
 * text — an abstract is what the API returns and what this plugin passes on.
 */
const PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      required: true,
      description: 'The arXiv identifier, version suffix included — e.g. `1706.03762v7`.',
    },
    title: { type: 'string', required: true, description: 'The paper title, on one line.' },
    authors: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Author names in the order arXiv lists them.',
    },
    published: {
      type: 'string',
      required: true,
      description: 'When the first version was announced, ISO-8601.',
    },
    abstract: {
      type: 'string',
      required: true,
      description: "The abstract as arXiv states it, unwrapped. arXiv's, not this plugin's.",
    },
    pdf_url: {
      type: 'string',
      required: true,
      description: 'Where the PDF lives. Reported for the caller to open; never downloaded here.',
    },
    abs_url: { type: 'string', required: true, description: "The paper's abstract page." },
  },
}

/**
 * Resolve the plugin's effective settings from its patch row.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @returns The request bounds both tools are built with.
 */
export function resolveConfig(config = {}) {
  return {
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBytes: Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES,
  }
}

/**
 * Render one paper as the compact line a model reads in a result list.
 * @param paper - A paper from the feed.
 * @returns One line: id, title, and the first authors.
 */
function paperLine(paper) {
  const shown = paper.authors.slice(0, 3).join(', ')
  const authors = paper.authors.length > 3 ? `${shown} et al.` : shown
  return `${paper.id}  ${paper.title}${authors === '' ? '' : ` — ${authors}`}`
}

/**
 * Build the `arxiv_search` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time, each `apply` owns its own definition, and the
 * HTTP seam can be substituted. Exported so a host can drive the tool without
 * booting a profile.
 * @param options - `fetch` to use (default: global `fetch`), `timeoutMs`, `maxBytes`.
 * @returns A registry-ready tool definition.
 */
export function createArxivSearchTool(options = {}) {
  return defineTool({
    name: ARXIV_SEARCH_TOOL_NAME,
    description:
      'Search arXiv for papers and return their metadata and abstracts. Reach for it to find ' +
      'work on a topic, to check whether a paper exists, or to get the identifier of one you ' +
      'then look up with arxiv_get. A plain phrase is searched across all fields; a query that ' +
      "opens with one of arXiv's field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:`) is sent " +
      'as written, so `au:Hinton AND cat:cs.LG` works. Returns titles, authors, publication ' +
      'dates, abstracts, and URLs — never PDF contents or full text.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description:
          "What to search for: a phrase, or an arXiv search_query expression if it opens with a field prefix.",
      },
      max_results: {
        type: 'integer',
        description:
          `How many papers to return, ${MAX_RESULTS_MIN}–${MAX_RESULTS_MAX} ` +
          `(default ${MAX_RESULTS_DEFAULT}). Values outside that range are clamped into it.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            required: true,
            description: 'The `query` argument, echoed back unchanged.',
          },
          search_query: {
            type: 'string',
            required: true,
            description: 'The expression actually sent to arXiv, after any `all:` wrapping.',
          },
          max_results: {
            type: 'integer',
            required: true,
            description: 'The result count asked of arXiv, after clamping.',
          },
          returned: { type: 'integer', required: true, description: 'How many papers came back.' },
          papers: {
            type: 'array',
            required: true,
            items: PAPER_SCHEMA,
            description: 'The matching papers, in arXiv relevance order.',
          },
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.returned === 0
              ? `No arXiv papers matched ${value.search_query}.`
              : `${value.returned} arXiv paper(s) for ${value.search_query}:\n` +
                value.papers.map((paper) => paperLine(paper)).join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const searchQuery = toSearchQuery(args.query)
      const maxResults = clampMaxResults(args.max_results)
      const feed = await fetchFeed(searchParams(searchQuery, maxResults), {
        ...options,
        signal: exec?.signal,
      })
      const papers = parseAtomFeed(feed)

      return {
        query: args.query,
        search_query: searchQuery,
        max_results: maxResults,
        returned: papers.length,
        papers,
        plugin: PLUGIN_NAME,
      }
    },
  })
}

/**
 * Build the `arxiv_get` tool definition.
 *
 * Kept as a factory for the same reasons as {@link createArxivSearchTool}.
 * @param options - `fetch` to use (default: global `fetch`), `timeoutMs`, `maxBytes`.
 * @returns A registry-ready tool definition.
 */
export function createArxivGetTool(options = {}) {
  return defineTool({
    name: ARXIV_GET_TOOL_NAME,
    description:
      'Fetch one arXiv paper by identifier and return its metadata and abstract. Accepts the ' +
      'bare id (`1706.03762`), a versioned id (`1706.03762v7`), an `arxiv:`-prefixed id, or an ' +
      'arXiv abstract or PDF URL. A version suffix is honoured, so ask for the version you mean. ' +
      'Fails loudly if arXiv knows no such paper rather than returning an empty result. Returns ' +
      'the abstract only — never PDF contents or full text.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description:
          'The arXiv identifier: `1706.03762`, `1706.03762v7`, `arxiv:1706.03762`, or an ' +
          'arxiv.org /abs/ or /pdf/ URL.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requested_id: {
            type: 'string',
            required: true,
            description: 'The identifier that was asked of arXiv, after normalization.',
          },
          paper: { ...PAPER_SCHEMA, required: true, description: 'The paper arXiv returned.' },
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.paper.title}\n` +
            `${value.paper.authors.join(', ')}\n` +
            `arXiv:${value.paper.id} · published ${value.paper.published} · ${value.paper.abs_url}\n\n` +
            value.paper.abstract,
        },
      ],
    },
    async execute(args, exec) {
      const id = normalizeArxivId(args.id)
      const feed = await fetchFeed(idParams(id), { ...options, signal: exec?.signal })
      const [paper] = parseAtomFeed(feed)

      if (paper === undefined) {
        throw new ArxivError('ARXIV_NOT_FOUND', `arXiv returned no paper for ${id}`)
      }

      return { requested_id: id, paper, plugin: PLUGIN_NAME }
    },
  })
}

/**
 * Register both tools for the lifetime of this plugin's fiber.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param config - The `config` block of this plugin's row in the composed patch.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  ctx.tools.register(createArxivSearchTool(settings))
  ctx.tools.register(createArxivGetTool(settings))
}
