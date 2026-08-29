/**
 * The one error type both tools fail with, carrying a stable machine-readable
 * code so a caller can tell a timeout from a missing paper without matching on
 * prose.
 *
 * @module dsh-arxiv/errors
 */

/** Every code {@link ArxivError} is thrown with, and what each one means. */
export const ARXIV_ERROR_CODES = Object.freeze({
  ARXIV_BAD_ID: 'The id argument is not an arXiv identifier.',
  ARXIV_BAD_QUERY: 'The query argument was blank.',
  ARXIV_HTTP_ERROR: 'arXiv answered with a non-2xx status.',
  ARXIV_NOT_FOUND: 'arXiv knows no paper with that identifier.',
  ARXIV_PARSE_ERROR: 'The response body was not an arXiv Atom feed.',
  ARXIV_RESPONSE_TOO_LARGE: 'The response exceeded the configured size cap.',
  ARXIV_TIMEOUT: 'The request was aborted before arXiv answered.',
  ARXIV_UNREACHABLE: 'The request to arXiv could not be completed.',
})

/** A failure reaching or reading the public arXiv API. */
export class ArxivError extends Error {
  /**
   * @param code - One of the keys of {@link ARXIV_ERROR_CODES}.
   * @param message - What went wrong, in prose, for a human reading a log.
   * @param options - Standard `Error` options; `cause` is preserved.
   */
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ArxivError'
    /** @type {string} The stable code callers branch on. */
    this.code = code
  }
}
