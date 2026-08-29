# dsh-arxiv

A small **DeepSeek Harness function plugin** for looking papers up on arXiv. It
registers exactly two model-facing tools — `arxiv_search` and `arxiv_get` — over
arXiv's public Atom API, and owns nothing else.

It is deliberately not a science platform. There is no PDF ingest, no full-text
extraction, no embedding store, no citation graph, no reference manager. It
answers two questions — *what has been written about this?* and *what is this
paper?* — and hands back metadata and the abstract. If you want the PDF, the
tools tell you where it lives; fetching it is somebody else's job.

Read-only, no API key, no credentials, no state.

## Install

```sh
dsh plugin --profile web add github:jwilson411/dsh-arxiv
```

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/web`, then reconciles
the profile against the installed state: because this package's manifest
declares `dsh.bundle.patch`, it is appended to the profile manifest's ordered
`dsh.profile.bundles` list and its patch becomes a layer.

Remove it the same way, with `remove` in place of `add`.

## Pinned DSH release candidate

This package is written and tested against the pinned release candidate
**`0.1.1-rc.2`** — the current `@deepseek-ai/dsh` release and the matching
`@deepseek-ai/dsh-tools@0.1.1-rc.2`, which is pinned exactly in
`devDependencies` so tests run against one known API. The peer range is
`^0.1.1-rc.2`, matching how the harness's own tool packages declare it.

Note that `@deepseek-ai/dsh-tools`'s npm `latest` tag still points at the older
`0.0.1-rc.1`; the `0.1.1-rc.2` line is published under `next`. Pin explicitly
rather than relying on the tag.

## What it registers

| | |
|---|---|
| Cordis plugin id | `arxiv` (the row id in `cordis.patch.yml`) |
| Injects | `tools` — a hard dependency; the plugin waits rather than degrading |

| Tool | Arguments | Returns |
|---|---|---|
| `arxiv_search` | `query` (string, required), `max_results` (integer, optional, 1–25, default 5) | `{ query, search_query, max_results, returned, papers[], plugin }` |
| `arxiv_get` | `id` (string, required) | `{ requested_id, paper, plugin }` |

Every paper is the same object in both tools:

```json
{
  "id": "1706.03762v7",
  "title": "Attention Is All You Need",
  "authors": ["Ashish Vaswani", "Noam Shazeer", "..."],
  "published": "2017-06-12T17:57:34Z",
  "abstract": "The dominant sequence transduction models are based on …",
  "pdf_url": "https://arxiv.org/pdf/1706.03762v7",
  "abs_url": "https://arxiv.org/abs/1706.03762v7"
}
```

`pdf_url` is reported so a caller can open it. **This plugin never fetches it.**

**`arxiv_search`** sends a plain phrase across all fields. A query that opens
with one of arXiv's field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:`, …) is
passed through as written, so `au:Hinton AND cat:cs.LG` works. `max_results` is
clamped into 1–25 rather than rejected — this is a lookup tool, not a harvester.

**`arxiv_get`** accepts `1706.03762`, `1706.03762v7`, `arxiv:1706.03762`, an
`/abs/` or `/pdf/` URL, and the pre-2007 `hep-th/9901001` form; all normalize to
the bare identifier. A version suffix is *kept*, since dropping it would quietly
answer about a different revision than the one asked for. arXiv answers an
unknown id with HTTP 200 and an error entry, so `arxiv_get` checks and throws
`ARXIV_NOT_FOUND` rather than reporting a silent nothing.

## Talking to arXiv

One endpoint, over HTTPS, with no key: `https://export.arxiv.org/api/query`.
Nothing scrapes an HTML page.

Every request is bounded twice and fails closed on either bound — an
`AbortSignal` deadline (15s) and a response byte cap (2 MiB) enforced while the
body streams, so an oversized response is abandoned rather than buffered. Both
are configurable from the plugin's patch row:

```yaml
- insert:
    - id: arxiv
      name: dsh-arxiv
      config:
        timeoutMs: 15000
        maxBytes: 2097152
```

Failures carry a stable `code` — `ARXIV_TIMEOUT`, `ARXIV_HTTP_ERROR`,
`ARXIV_RESPONSE_TOO_LARGE`, `ARXIV_NOT_FOUND`, `ARXIV_BAD_ID`,
`ARXIV_BAD_QUERY`, `ARXIV_PARSE_ERROR`, `ARXIV_UNREACHABLE` — so a caller can
tell a timeout from a missing paper without matching on prose.

Requests identify themselves with a User-Agent naming the plugin and its
repository, as arXiv's terms of use ask.

## Headless use

The tool factories take the `fetch` to use, so you can drive either tool from a
plain Node script without booting a profile:

```js
// titles.mjs — node titles.mjs
import { createArxivSearchTool } from 'dsh-arxiv'

// Omit `fetch` to use the global one and hit the real API. Doing so sends live
// requests to export.arxiv.org: be polite, and read the terms linked below.
const search = createArxivSearchTool({ fetch: globalThis.fetch })

const exec = { signal: AbortSignal.timeout(20_000) }
const result = await search.execute({ query: 'au:Hinton AND cat:cs.LG', max_results: 5 }, exec)

console.log(`${result.returned} paper(s) for ${result.search_query}`)
for (const paper of result.papers) {
  console.log(`  ${paper.id}  ${paper.title}`)
}
```

Swap in a stub `fetch` and the same script runs entirely offline — this is
exactly how the test suite drives it:

```js
const canned = async () =>
  new Response(await readFile('feed.xml', 'utf8'), {
    status: 200,
    headers: { 'content-type': 'application/atom+xml' },
  })

const search = createArxivSearchTool({ fetch: canned })
```

`execute` validates its arguments before the body runs, so a bad call rejects
with `ToolArgsError` and never reaches the network.

## arXiv's terms, and whose text this is

This plugin is an API client. It is not affiliated with or endorsed by arXiv.

Use of the API is governed by the [arXiv API Terms of
Use](https://info.arxiv.org/help/api/tou.html). In short: identify your client,
do not hammer the service, and respect the metadata's licensing.

**Abstracts and metadata returned by these tools are arXiv's and their authors',
not this plugin's.** They are passed through unaltered except for collapsing the
newlines arXiv wraps prose with. Attribute them to arXiv and to the paper's
authors, and cite the paper — the `abs_url` on every result is the place to
point. Thank you to arXiv for making the API and its data openly available.

## Layout

```
package.json        manifest + `dsh.bundle.patch` — what makes this a bundle
cordis.patch.yml    the bundle's patch layer: one insert, one plugin row
src/index.js        the plugin: `name`, `inject`, `apply(ctx)`, both tools
src/arxiv.js        the HTTP client: endpoint, bounds, id and query handling
src/atom.js         a small dedicated parser for arXiv's Atom feed
src/errors.js       `ArxivError` and its codes
test/               offline tests, with checked-in feed fixtures
```

The Atom parser is hand-written against arXiv's one documented response shape
rather than pulling in a general XML library, which is why this package has no
runtime dependencies at all.

## Tests

```sh
npm install
npm test
```

**Offline by construction.** Every test injects a `fetch` double answering from
a checked-in fixture, and each test file replaces the global `fetch` with a
guard that throws — so a code path that forgot its injected `fetch` fails as a
test failure instead of a live request to export.arxiv.org. `npm test` opens no
socket and reads no credential.

The suite covers registration, the Atom parser against captured real feeds,
clamping, id normalization, both render projections, output-schema validation,
loud failure on timeout, oversize, non-2xx, unknown id and bad arguments, and
the manifest/patch wiring.

CI (`.github/workflows/ci.yml`) runs the same two commands on Node 22 and 24
with `contents: read` and no secrets.

## License

MIT — see [LICENSE](LICENSE). Covers this plugin's code only, not the arXiv
content it retrieves.
