/**
 * A small, dedicated parser for the Atom feed arXiv's query API returns.
 *
 * This is deliberately not a general XML parser. arXiv's `/api/query` response
 * is one fixed, documented shape — a `<feed>` of `<entry>` elements carrying
 * `id`, `title`, `summary`, `published`, `<author><name>`, and `<link>` — and
 * parsing exactly that keeps the plugin free of runtime dependencies. Anything
 * outside that shape is reported as unparseable rather than guessed at.
 *
 * @module dsh-arxiv/atom
 */
import { ArxivError } from './errors.js'

/** The prefix arXiv puts on the `<id>` of an error entry instead of a paper. */
const ERROR_ID_PREFIX = 'http://arxiv.org/api/errors'

/** Named XML entities that appear in arXiv titles, abstracts, and links. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * Resolve XML character references and the five named entities.
 * @param text - Raw text taken from between two tags.
 * @returns The text with references resolved.
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match
  })
}

/**
 * Collapse the line wrapping arXiv applies to titles and abstracts.
 *
 * The API hard-wraps prose with newlines and leading indentation, which is
 * layout, not content: a model reading `"Attention Is All\n  You Need"` sees a
 * different string than the one the paper is titled.
 * @param text - Decoded element text.
 * @returns The text with runs of whitespace collapsed to single spaces, trimmed.
 */
export function sanitizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Read the text content of the first `<tag>` in a fragment.
 * @param fragment - The XML fragment to search.
 * @param tag - The element name.
 * @returns The decoded, whitespace-sanitized text, or null if the tag is absent.
 */
function firstText(fragment, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(fragment)
  return match === null ? null : sanitizeText(decodeEntities(match[1]))
}

/**
 * Parse the attributes of every self-closing `<link .../>` in a fragment.
 * @param fragment - The XML fragment to search.
 * @returns One plain object of decoded attributes per link.
 */
function links(fragment) {
  return [...fragment.matchAll(/<link\b([^>]*?)\/?>/g)].map(([, attributes]) => {
    const parsed = {}
    for (const [, key, value] of attributes.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      parsed[key] = decodeEntities(value)
    }
    return parsed
  })
}

/**
 * Parse the `<author><name>` list of one entry, in document order.
 * @param fragment - The entry fragment.
 * @returns Author names, with empty ones dropped.
 */
function authors(fragment) {
  return [...fragment.matchAll(/<author>([\s\S]*?)<\/author>/g)]
    .map(([, author]) => firstText(author, 'name'))
    .filter((author) => author !== null && author !== '')
}

/**
 * Reduce an arXiv `<id>` URL to the bare identifier it names.
 * @param idUrl - An `http://arxiv.org/abs/…` URL as the feed states it.
 * @returns The identifier, version suffix retained.
 */
function idFromUrl(idUrl) {
  return idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
}

/**
 * Parse one `<entry>` into the paper shape both tools return.
 *
 * Both URLs are taken from the feed's own `<link>` elements when it states
 * them and derived from the id otherwise, so a paper is never reported with a
 * URL invented from a partial parse.
 * @param fragment - The inner XML of one `<entry>`.
 * @returns The paper, or null if the entry carries no usable id.
 */
function parseEntry(fragment) {
  const idUrl = firstText(fragment, 'id')
  if (idUrl === null || idUrl === '' || idUrl.startsWith(ERROR_ID_PREFIX)) return null

  const id = idFromUrl(idUrl)
  const entryLinks = links(fragment)
  const alternate = entryLinks.find((link) => link.rel === 'alternate')
  const pdf = entryLinks.find((link) => link.type === 'application/pdf')

  return {
    id,
    title: firstText(fragment, 'title') ?? '',
    authors: authors(fragment),
    published: firstText(fragment, 'published') ?? '',
    abstract: firstText(fragment, 'summary') ?? '',
    pdf_url: pdf?.href ?? `https://arxiv.org/pdf/${id}`,
    abs_url: alternate?.href ?? `https://arxiv.org/abs/${id}`,
  }
}

/**
 * Parse an arXiv Atom feed into papers.
 *
 * arXiv answers a malformed request with HTTP 200 and a feed holding a single
 * error entry; that entry is dropped here rather than surfaced as a paper, so
 * a bad id reads as "no results" to the caller and fails loudly there.
 * @param xml - The response body.
 * @returns The papers the feed listed, in feed order.
 * @throws {ArxivError} `ARXIV_PARSE_ERROR` if the body is not an Atom feed.
 */
export function parseAtomFeed(xml) {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) {
    throw new ArxivError('ARXIV_PARSE_ERROR', 'arXiv returned a body that is not an Atom feed')
  }

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, fragment]) => parseEntry(fragment))
    .filter((paper) => paper !== null)
}
