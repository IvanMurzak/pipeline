// http-body.ts — release the socket behind a `fetch()` response nobody is
// going to read.
//
// ── THE BUG THIS EXISTS TO PREVENT ──────────────────────────────────────────
//
// A `fetch()` response is not finished when it resolves. The status line and
// the headers have arrived; the BODY is still an open stream, and under both
// Bun and Node that stream pins the underlying socket (and its libuv handle)
// until something either drains it — `res.json()`, `res.text()` — or cancels
// it. Garbage collection eventually reclaims an abandoned one, but only
// eventually, and a long-lived process that abandons responses faster than the
// GC notices simply accumulates handles until it dies of it.
//
// That is not hypothetical here. A user's `pipeline department notify` daemon
// (`DEFAULT_INTERVAL_MS = 60_000`, so one poll a minute) was found after
// ~5,350 poll cycles holding ~5,536 open handles. The ratio is the tell:
// `pollOnce` calls `fetchMe` FIRST and, on a credential the control plane no
// longer accepts, `fetchMe` did
//
//     if (res.status !== 200) return null;
//
// and the caller `continue`d to the next server. One response per server per
// cycle, abandoned with its body untouched — which is exactly ~1 handle per
// cycle, not the ~2 you would see if the `dept-tasks` call had leaked too (it
// never ran: the poll gives up as soon as identity fails). The daemon had been
// up for about four days. It would not have recovered on its own.
//
// The general shape of the bug is "an early `return`/`throw` on a non-2xx
// status that skips the `res.json()` further down the function". Every HTTP
// call site in this package that answers a bad status without reading the body
// has it, so the fix is one shared helper applied at each of those exits
// rather than eight hand-rolled try/catches.
//
// ── WHY `cancel()` AND NOT "just read it" ───────────────────────────────────
//
// Draining would also release the handle, but it makes this process buffer
// whatever the server decided to send — on an error path, from a server that
// may be answering badly for reasons we do not yet understand. `cancel()`
// releases the stream without reading a byte of it, which is the same choice
// `telemetry-upload.ts`'s `realUploadFetch` already makes for its own
// (deliberately unread) responses; this helper is the generalisation of that
// one-off, and is written to behave identically.
//
// ── WHY THE SIGNATURE IS THIS LOOSE ─────────────────────────────────────────
//
// Nothing in this package holds a real `Response` at the call sites that need
// this. Every HTTP call goes through a NARROWED injected seam — `cloud.ts`'s
// and `runner-enrol.ts`'s and `department-notify.ts`'s `HttpResponse`,
// `department-serve.ts`'s `ServeHttpResponse` — whose real adapters cast a
// genuine `Response` through `as unknown as …`. So `body` is present at
// runtime but absent from the declared type unless each seam opts in, and
// every test double is a plain `{ status, json }` object with no `body` at
// all. Hence: `body` optional, nullable (a real `Response` to a 204 has
// `body === null`), and the whole argument optional too, so a caller in a
// `catch` block can pass a response that may never have been assigned.
//
// ⚠ Do NOT call this before reading a body you still want. It is for exits
// that are abandoning the response, and cancelling first makes a later
// `json()`/`text()` fail.

/**
 * The body handle of a `fetch()` response, as much of it as this module needs.
 *
 * A real `Response.body` is a `ReadableStream | null`; only `cancel()` is
 * relevant here, so the seams that opt in declare exactly that and no more —
 * a seam should not start claiming to be a whole `Response`.
 */
export type ResponseBodyHandle = { cancel(): Promise<void> } | null;

/** A response whose body MAY be present — the shape {@link discardBody} needs
 *  and the member each narrowed HTTP seam adds to opt into it. */
export interface DiscardableResponse {
  body?: ResponseBodyHandle;
}

/**
 * Release the socket behind a response whose body will never be read.
 *
 * Call this on every early exit — `return`, `throw`, and inside a `catch`
 * where a response is still in scope — that leaves without calling
 * `res.json()` or `res.text()`. See this module's header for the daemon leak
 * (~5,350 poll cycles, ~5,536 handles) that made it necessary.
 *
 * Total, and deliberately silent. A body that is already drained, already
 * errored, or locked by a reader someone else holds throws from `cancel()`,
 * and in every one of those cases there is nothing left to release — so the
 * throw is the answer "already done", not a failure worth propagating out of
 * an error path that was on its way to reporting something more useful.
 * `undefined?.` short-circuits, so a test double with no `body` is a no-op.
 */
export async function discardBody(res: DiscardableResponse | null | undefined): Promise<void> {
  try {
    await res?.body?.cancel();
  } catch {
    /* already closed, errored, or locked — nothing left to release */
  }
}
