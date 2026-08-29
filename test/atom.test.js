/**
 * The Atom parser, against checked-in captures of arXiv's real responses.
 *
 * No HTTP happens in this file at all: the parser is a pure function from a
 * feed body to papers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ArxivError } from '../src/errors.js'
import { parseAtomFeed, sanitizeText } from '../src/atom.js'
import { fixture, networkGuard } from './helpers.js'

networkGuard()

test('a search feed parses into one paper per entry, in feed order', () => {
  const papers = parseAtomFeed(fixture('search.xml'))

  assert.equal(papers.length, 2)
  assert.deepEqual(
    papers.map((paper) => paper.id),
    ['2202.09741v5', '2306.05427v2'],
  )
  assert.equal(papers[0].title, 'Visual Attention Network')
  assert.equal(papers[1].title, 'Grounded Text-to-Image Synthesis with Attention Refocusing')
})

test('an entry carries every field the tools promise', () => {
  const [paper] = parseAtomFeed(fixture('get.xml'))

  assert.deepEqual(Object.keys(paper).sort(), [
    'abs_url',
    'abstract',
    'authors',
    'id',
    'pdf_url',
    'published',
    'title',
  ])
  assert.equal(paper.id, '1706.03762v7')
  assert.equal(paper.title, 'Attention Is All You Need')
  assert.equal(paper.published, '2017-06-12T17:57:34Z')
  assert.equal(paper.abs_url, 'https://arxiv.org/abs/1706.03762v7')
  assert.equal(paper.pdf_url, 'https://arxiv.org/pdf/1706.03762v7')
  assert.deepEqual(paper.authors, [
    'Ashish Vaswani',
    'Noam Shazeer',
    'Niki Parmar',
    'Jakob Uszkoreit',
    'Llion Jones',
    'Aidan N. Gomez',
    'Lukasz Kaiser',
    'Illia Polosukhin',
  ])
  assert.match(paper.abstract, /^The dominant sequence transduction models/)
  assert.match(paper.abstract, /English constituency parsing both with large and limited training data\.$/)
})

test('the parser reports no PDF bytes — only the URL where they live', () => {
  const [paper] = parseAtomFeed(fixture('get.xml'))

  assert.equal(typeof paper.pdf_url, 'string')
  for (const value of Object.values(paper)) {
    assert.ok(typeof value === 'string' || Array.isArray(value))
  }
})

test('wrapped titles, abstracts, and author names are unwrapped to single lines', () => {
  const [paper] = parseAtomFeed(fixture('wrapped.xml'))

  assert.equal(
    paper.title,
    'Wrapped Titles & Escaped Entities: A Study of Whitespace in the arXiv API',
  )
  assert.equal(paper.authors[0], 'Ada Lovelace')
  assert.ok(!paper.abstract.includes('\n'))
  assert.match(paper.abstract, /^The arXiv API hard-wraps abstracts/)
  assert.match(paper.abstract, /survives a round trip\.$/)
})

test('XML entities are resolved rather than passed through', () => {
  const [paper] = parseAtomFeed(fixture('wrapped.xml'))

  assert.ok(paper.abstract.includes('q < p && p > 0'))
  assert.ok(paper.title.includes('&'))
  assert.ok(!paper.abstract.includes('&amp;'))
  assert.ok(!paper.abstract.includes('&lt;'))
})

test('URLs are derived from the id when the entry states no links', () => {
  const [paper] = parseAtomFeed(fixture('no-links.xml'))

  assert.equal(paper.id, 'hep-th/9901001v1')
  assert.equal(paper.abs_url, 'https://arxiv.org/abs/hep-th/9901001v1')
  assert.equal(paper.pdf_url, 'https://arxiv.org/pdf/hep-th/9901001v1')
})

test("arXiv's own error entry is not reported as a paper", () => {
  assert.deepEqual(parseAtomFeed(fixture('error.xml')), [])
})

test('the feed-level title and id are never mistaken for an entry', () => {
  const papers = parseAtomFeed(fixture('search.xml'))

  for (const paper of papers) {
    assert.ok(!paper.title.startsWith('arXiv Query'))
    assert.ok(!paper.id.startsWith('https://arxiv.org/api/'))
  }
})

test('a body that is not an Atom feed fails loudly', () => {
  for (const body of ['<html><body>503 Service Unavailable</body></html>', '', null, 42]) {
    assert.throws(
      () => parseAtomFeed(body),
      (error) => {
        assert.ok(error instanceof ArxivError)
        assert.equal(error.code, 'ARXIV_PARSE_ERROR')
        return true
      },
    )
  }
})

test('an empty feed parses to no papers rather than failing', () => {
  const empty =
    '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">' +
    '<title>arXiv Query: search_query=all:zzzz</title></feed>'

  assert.deepEqual(parseAtomFeed(empty), [])
})

test('sanitizeText collapses every run of whitespace and trims the ends', () => {
  assert.equal(sanitizeText('  a\n  b\t\tc  '), 'a b c')
  assert.equal(sanitizeText(''), '')
})
