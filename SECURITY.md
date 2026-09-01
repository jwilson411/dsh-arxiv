# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for a security report.

Use GitHub's private advisory form:

https://github.com/jwilson411/dsh-arxiv/security/advisories/new

Include the version or commit, steps to reproduce, and what an attacker gains.

## Scope

dsh-arxiv is a DeepSeek Harness function plugin. It registers two model-facing tools, `arxiv_search` and `arxiv_get`. Both talk only to the public arXiv Atom API at `https://export.arxiv.org/api/query` over HTTPS. The endpoint is not configurable. There is no API key.

The plugin does not download PDFs. `pdf_url` is reported so the caller can open it; this package never fetches that URL. Abstracts and metadata only.

Every request fails closed on a timeout (default 15s) and a response byte cap (default 2 MiB) enforced while the body streams.

This plugin is not an SSRF guard. An attacker who already controls the process running the harness is out of scope.

## Supported versions

Only the latest release receives security fixes.
