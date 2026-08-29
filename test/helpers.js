/**
 * Shared offline scaffolding. Not a test file: the `npm test` glob only picks
 * up `*.test.js`, so nothing here runs on its own.
 *
 * Every helper exists to keep the suite off the network. {@link networkGuard}
 * replaces `globalThis.fetch` so that a code path which forgot its injected
 * `fetch` fails as a test failure rather than a live request to arXiv.
 */
import { readFileSync } from 'node:fs'

/** Thrown by the guard when something reaches for the real global `fetch`. */
export const GUARD_MESSAGE = 'the offline test suite attempted a real network request'

/**
 * Replace the global `fetch` with one that fails loudly.
 *
 * Called at import time by every test file. `node --test` runs each file in
 * its own process, so this never leaks between files.
 * @returns The guard, which records the calls it refused.
 */
export function networkGuard() {
  const attempts = []
  const guard = (url) => {
    attempts.push(String(url))
    throw new Error(GUARD_MESSAGE)
  }
  guard.attempts = attempts
  globalThis.fetch = guard
  return guard
}

/**
 * Read one checked-in Atom fixture.
 * @param filename - A name under `test/fixtures/`.
 * @returns The fixture body.
 */
export function fixture(filename) {
  return readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')
}

/**
 * A `fetch` double that records every call and delegates to a handler.
 * @param handler - Receives `(url, init)` and returns the response.
 * @returns The double, with a `calls` array of `{ url, init }`.
 */
export function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

/**
 * A `fetch` double answering every call with one Atom body.
 * @param xml - The body to return.
 * @param init - Response overrides, e.g. `{ status: 503 }`.
 * @returns The double, with a `calls` array.
 */
export function atomFetch(xml, init = {}) {
  return recordingFetch(
    () =>
      new Response(xml, {
        status: 200,
        headers: { 'content-type': 'application/atom+xml; charset=utf-8' },
        ...init,
      }),
  )
}

/**
 * A `fetch` double that never answers, for exercising the deadline.
 *
 * It holds a referenced timer for the life of the call. A real request keeps
 * the event loop alive through its socket, but `AbortSignal.timeout`'s own
 * timer is unreferenced by design — so without this, a test awaiting nothing
 * but the deadline drains the loop and `node --test` cancels it as pending.
 * @returns The double, with a `calls` array.
 */
export function hangingFetch() {
  return recordingFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000)
        init.signal.addEventListener(
          'abort',
          () => {
            clearInterval(keepAlive)
            reject(init.signal.reason)
          },
          { once: true },
        )
      }),
  )
}

/** The execution context the registry passes to `execute`. */
export function execContext() {
  return { signal: new AbortController().signal }
}

/**
 * A context stub exposing only what `apply` is allowed to touch.
 * @returns The stub context and the definitions it recorded.
 */
export function stubContext() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}
