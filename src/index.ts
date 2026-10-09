interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Ukraine public spending MCP — State Treasury payment transactions (keyless).
 *
 * Wraps the public transactions API behind spending.gov.ua (the State Treasury
 * Service of Ukraine / ДКСУ open-spending portal):
 *
 *   GET https://api.spending.gov.ua/api/v2/api/transactions/
 *       ?payers_edrpous=<code>&recipt_edrpous=<code>&startdate=YYYY-MM-DD&enddate=YYYY-MM-DD
 *
 * Measured live 2026-10-08:
 *   - keyless, plain JSON array of payment rows (no pagination, no envelope);
 *   - at least ONE of payers_edrpous / recipt_edrpous is required, and both
 *     together are an AND (payer -> recipient pair);
 *   - the date window may not exceed 92 days (HTTP 400, Ukrainian message);
 *   - dates must be YYYY-MM-DD (DD.MM.YYYY is a 400 "Error param [enddate]");
 *   - rows run ~2 days behind today (latest trans_date 2026-10-06 on 10-08);
 *   - payments to private individuals arrive with the recipient code masked as
 *     "xxxxxxxxxx" and digits in purpose text masked as "xxxx" by the Treasury;
 *   - some payers (e.g. the Ministry of Defence, 00034022) return an empty
 *     list for windows where they certainly paid — a publication restriction,
 *     not a missing payer — so an empty answer is reported as found:false with
 *     that caveat rather than as "this entity paid nothing".
 *
 * The ProZorro link uses the keyless ProZorro full-text search
 * (POST https://prozorro.gov.ua/api/search/tenders, same endpoint the prozorro
 * pack uses). A payment and a tender that share a counterparty do NOT prove the
 * payment settles that tender, so every link is labelled `candidate`.
 */


const UA = 'pipeworx-ukraine-public-spending/1.0 (+https://pipeworx.io)';
const SPEND_BASE = 'https://api.spending.gov.ua/api/v2/api/transactions/';
const PROZORRO_SEARCH = 'https://prozorro.gov.ua/api/search/tenders';
const MAX_WINDOW_DAYS = 92;
const SOURCE = 'State Treasury Service of Ukraine (ДКСУ) via spending.gov.ua';

async function pwFetch(url: string | URL, name: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, name, 45_000);
}

const DATE_DESC = 'YYYY-MM-DD.';
const EDRPOU_DESC =
  'EDRPOU code (8-digit Ukrainian legal-entity id; public bodies often 8 digits with leading zeros, e.g. "26510514" for Dnipro City Council). Several may be comma-separated.';

const tools: McpToolExport['tools'] = [
  {
    name: 'ua_spend_payments',
    description:
      "Ukrainian public-money payments from the State Treasury (spending.gov.ua, keyless): every treasury payment made BY a payer EDRPOU and/or TO a recipient EDRPOU in a date window of up to 92 days. Each row has transaction date, amount (UAH), payer name + EDRPOU, recipient name + EDRPOU, payment purpose text (Ukrainian), budget code, KEKV economic code, and the contract number when the Treasury recorded one. Returns totals and top counterparties across the whole window plus the newest `limit` rows. Use for: who a city council or ministry paid, which public bodies paid a supplier, and what for. Payments to private individuals arrive with the code masked by the Treasury. For payer->recipient pairs use ua_spend_between; to line payments up with ProZorro tenders use ua_spend_prozorro_link.",
    inputSchema: {
      type: 'object',
      properties: {
        recipient_edrpou: { type: 'string', description: `Recipient (payee) ${EDRPOU_DESC}` },
        payer_edrpou: { type: 'string', description: `Payer (spending body) ${EDRPOU_DESC}` },
        date_from: { type: 'string', description: `Window start, ${DATE_DESC} Default: 30 days before date_to. Window may not exceed 92 days.` },
        date_to: { type: 'string', description: `Window end, ${DATE_DESC} Default: today.` },
        purpose_contains: { type: 'string', description: 'Optional case-insensitive substring filter on the payment purpose text (Ukrainian, e.g. "харчування", "ремонт").' },
        limit: { type: ['number', 'string'], description: 'Rows to return, newest first (1-500). Default 50. Totals always cover every row in the window.' },
      },
    },
  },
  {
    name: 'ua_spend_between',
    description:
      "Payments from ONE Ukrainian public payer to ONE recipient (both by EDRPOU) in a window of up to 92 days, from State Treasury data on spending.gov.ua (keyless). Returns found true/false, payment count, total UAH, a per-month breakdown, and the payment rows with purpose text and any recorded contract number. found:false means the Treasury published no payment between the two in that window — not proof none was made (some payers, e.g. defence, are withheld). Use to check whether and how much a specific public body paid a specific supplier.",
    inputSchema: {
      type: 'object',
      properties: {
        payer_edrpou: { type: 'string', description: 'Payer (spending body) EDRPOU code, e.g. "26510514".' },
        recipient_edrpou: { type: 'string', description: 'Recipient (payee) EDRPOU code, e.g. "37988155".' },
        date_from: { type: 'string', description: `Window start, ${DATE_DESC} Default: 30 days before date_to.` },
        date_to: { type: 'string', description: `Window end, ${DATE_DESC} Default: today. Window may not exceed 92 days.` },
        limit: { type: ['number', 'string'], description: 'Rows to return, newest first (1-500). Default 100.' },
      },
      required: ['payer_edrpou', 'recipient_edrpou'],
    },
  },
  {
    name: 'ua_spend_prozorro_link',
    description:
      "Line up a Ukrainian supplier's State Treasury receipts (spending.gov.ua) with its ProZorro procurement tenders, by supplier EDRPOU. Returns the public bodies that paid the supplier in the window (count, total UAH), the supplier's ProZorro tenders (tenderID, title, buyer + buyer EDRPOU, value, status), and, for each of the largest payers, the ProZorro tenders where that payer was the buyer and this supplier took part — returned as CANDIDATE links. A shared counterparty does not prove which contract a payment settles — every link is labelled candidate, with the matching basis stated. Use for supplier due diligence across procurement and actual payments. Keyless.",
    inputSchema: {
      type: 'object',
      properties: {
        supplier_edrpou: { type: 'string', description: 'Supplier (payment recipient / ProZorro tenderer) EDRPOU code, 8 digits, e.g. "37988155".' },
        date_from: { type: 'string', description: `Payment window start, ${DATE_DESC} Default: 90 days before date_to.` },
        date_to: { type: 'string', description: `Payment window end, ${DATE_DESC} Default: today. Window may not exceed 92 days.` },
        max_payers: { type: ['number', 'string'], description: 'How many of the largest payers (by UAH in the window) to check against ProZorro, 1-8. Default 5.' },
      },
      required: ['supplier_edrpou'],
    },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────

function strArg(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function intArg(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : v === undefined || v === null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function edrpouList(v: unknown, field: string): string[] | undefined {
  const s = strArg(v);
  if (!s) return undefined;
  const codes = s.split(/[,\s;]+/).map((c) => c.trim()).filter(Boolean);
  for (const c of codes) {
    if (!/^\d{6,10}$/.test(c)) {
      throw new Error(`user_error: ${field} "${c}" is not an EDRPOU code — expected 8 digits (6-10 accepted), e.g. "26510514".`);
    }
  }
  return codes;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(v: string | undefined, field: string): Date | undefined {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`user_error: ${field} must be YYYY-MM-DD, got "${v}".`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`user_error: ${field} "${v}" is not a real date.`);
  return d;
}

function resolveWindow(args: Record<string, unknown>, defaultDays: number): { from: string; to: string } {
  const to = parseDay(strArg(args.date_to), 'date_to') ?? new Date();
  const from = parseDay(strArg(args.date_from), 'date_from') ?? new Date(to.getTime() - defaultDays * 86_400_000);
  if (from.getTime() > to.getTime()) throw new Error('user_error: date_from is after date_to.');
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_WINDOW_DAYS) {
    throw new Error(
      `user_error: the Treasury API allows at most ${MAX_WINDOW_DAYS} days per query; ${isoDay(from)}..${isoDay(to)} is ${days}. Split it into windows of 92 days or less.`,
    );
  }
  return { from: isoDay(from), to: isoDay(to) };
}

interface Payment {
  id: number | null;
  trans_date: string | null;
  doc_date: string | null;
  doc_number: string | null;
  amount: number | null;
  currency: string | null;
  payer_edrpou: string | null;
  payer_name: string | null;
  recipient_edrpou: string | null;
  recipient_name: string | null;
  purpose: string | null;
  budget_code: string | null;
  kekv: string | null;
  kpk: string | null;
  contract_number: string | null;
  contract_id: string | null;
  region_id: number | null;
  recipient_masked: boolean;
}

function shape(r: any): Payment {
  const recip = r.recipt_edrpou ?? null;
  return {
    id: r.id ?? null,
    trans_date: r.trans_date ?? null,
    doc_date: r.doc_date ?? null,
    doc_number: r.doc_number ?? null,
    amount: typeof r.amount === 'number' ? r.amount : r.amount != null ? Number(r.amount) : null,
    currency: r.currency ?? null,
    payer_edrpou: r.payer_edrpou ?? null,
    payer_name: r.payer_name ?? null,
    recipient_edrpou: recip,
    recipient_name: r.recipt_name ?? null,
    purpose: r.payment_details ?? null,
    budget_code: r.budgetCode ?? null,
    kekv: r.kekv ?? null,
    kpk: r.kpk ?? null,
    contract_number: r.contractNumber ?? null,
    contract_id: r.contractId != null ? String(r.contractId) : null,
    region_id: r.region_id ?? null,
    recipient_masked: typeof recip === 'string' && /^x+$/i.test(recip),
  };
}

async function fetchPayments(payers: string[] | undefined, recipients: string[] | undefined, from: string, to: string): Promise<Payment[]> {
  const p = new URLSearchParams();
  if (payers?.length) p.set('payers_edrpous', payers.join(','));
  if (recipients?.length) p.set('recipt_edrpous', recipients.join(','));
  p.set('startdate', from);
  p.set('enddate', to);
  const url = `${SPEND_BASE}?${p.toString()}`;
  // Measured from a Cloudflare Worker 2026-10-08: the first HTTPS request from a
  // cold isolate came back 525 (origin TLS handshake failed) twice out of two,
  // while 8/8 warm HTTPS calls and 8/8 plain-HTTP calls returned the same rows.
  // So: retry HTTPS once, then fall back to plain HTTP. The data is public and
  // read-only and no credential is sent, so the HTTP leg exposes nothing.
  let res = await pwFetch(url, 'spending.gov.ua');
  if (res.status >= 520 && res.status <= 526) res = await pwFetch(url, 'spending.gov.ua');
  if (res.status >= 520 && res.status <= 526) res = await pwFetch(url.replace(/^https:/, 'http:'), 'spending.gov.ua (http)');
  const text = await res.text();
  if (!res.ok) {
    let msg = summarizeErrorBody(text);
    try {
      const j = JSON.parse(text);
      if (j?.errorMessage) msg = String(j.errorMessage);
    } catch {
      /* keep raw text */
    }
    if (res.status === 429) throw new Error(`upstream_throttled: spending.gov.ua rate limit (HTTP 429). ${msg}`);
    if (res.status >= 500) throw new Error(`upstream_down: spending.gov.ua HTTP ${res.status}. ${msg}`);
    throw new Error(`user_error: spending.gov.ua rejected the query (HTTP ${res.status}): ${msg}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`upstream_down: spending.gov.ua returned HTTP ${res.status} with a non-JSON body: ${summarizeErrorBody(text)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`upstream_down: spending.gov.ua returned HTTP ${res.status} with an unexpected shape (not an array): ${summarizeErrorBody(text)}`);
  }
  const rows = data.map(shape);
  rows.sort((a, b) => (b.trans_date ?? '').localeCompare(a.trans_date ?? '') || (b.amount ?? 0) - (a.amount ?? 0));
  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumUah(rows: Payment[]): number {
  return round2(rows.reduce((s, r) => s + (r.currency && r.currency !== 'UAH' ? 0 : r.amount ?? 0), 0));
}

function topBy(rows: Payment[], side: 'payer' | 'recipient', n: number) {
  const m = new Map<string, { edrpou: string | null; name: string | null; payments: number; total_uah: number }>();
  for (const r of rows) {
    const code = side === 'payer' ? r.payer_edrpou : r.recipient_edrpou;
    const name = side === 'payer' ? r.payer_name : r.recipient_name;
    const key = `${code}|${name}`;
    const e = m.get(key) ?? { edrpou: code, name, payments: 0, total_uah: 0 };
    e.payments += 1;
    if (!r.currency || r.currency === 'UAH') e.total_uah = round2(e.total_uah + (r.amount ?? 0));
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.total_uah - a.total_uah).slice(0, n);
}

function freshness(rows: Payment[]) {
  return {
    data_as_of: new Date().toISOString(),
    latest_trans_date_in_result: rows.reduce<string | null>((mx, r) => (r.trans_date && (!mx || r.trans_date > mx) ? r.trans_date : mx), null),
    publication_lag_note: 'The Treasury publishes payments about 1-2 business days after they settle (latest row 2026-10-06 when checked on 2026-10-08), so the last days of a window ending today may be incomplete.',
  };
}

const EMPTY_NOTE =
  'No payment published for this filter and window. That is not proof of no payment: some payers (notably defence and security bodies) are withheld from the open portal, and the newest ~2 days are not loaded yet.';

// ── tools ─────────────────────────────────────────────────────────────────

async function payments(args: Record<string, unknown>) {
  const recipients = edrpouList(args.recipient_edrpou, 'recipient_edrpou');
  const payers = edrpouList(args.payer_edrpou, 'payer_edrpou');
  if (!recipients && !payers) {
    throw new Error('user_error: pass recipient_edrpou and/or payer_edrpou — the Treasury API needs at least one EDRPOU code to search.');
  }
  const { from, to } = resolveWindow(args, 30);
  const limit = intArg(args.limit, 50, 1, 500);
  let rows = await fetchPayments(payers, recipients, from, to);
  const fetched = rows.length;
  const purpose = strArg(args.purpose_contains);
  if (purpose) {
    const needle = purpose.toLowerCase();
    rows = rows.filter((r) => (r.purpose ?? '').toLowerCase().includes(needle));
  }
  const out: Record<string, unknown> = {
    found: rows.length > 0,
    query: { payer_edrpou: payers ?? null, recipient_edrpou: recipients ?? null, date_from: from, date_to: to, purpose_contains: purpose ?? null },
    payment_count: rows.length,
    total_uah: sumUah(rows),
    returned: Math.min(limit, rows.length),
    top_payers: topBy(rows, 'payer', 10),
    top_recipients: topBy(rows, 'recipient', 10),
    payments: rows.slice(0, limit),
    ...freshness(rows),
    source: SOURCE,
  };
  if (purpose) out.fetched_before_purpose_filter = fetched;
  if (!rows.length) out.note = EMPTY_NOTE;
  return out;
}

async function between(args: Record<string, unknown>) {
  const payer = edrpouList(args.payer_edrpou, 'payer_edrpou');
  const recipient = edrpouList(args.recipient_edrpou, 'recipient_edrpou');
  if (!payer || !recipient) throw new Error('user_error: ua_spend_between needs both payer_edrpou and recipient_edrpou.');
  const { from, to } = resolveWindow(args, 30);
  const limit = intArg(args.limit, 100, 1, 500);
  const rows = await fetchPayments(payer, recipient, from, to);
  const byMonth = new Map<string, { month: string; payments: number; total_uah: number }>();
  for (const r of rows) {
    const mo = (r.trans_date ?? '').slice(0, 7) || 'unknown';
    const e = byMonth.get(mo) ?? { month: mo, payments: 0, total_uah: 0 };
    e.payments += 1;
    if (!r.currency || r.currency === 'UAH') e.total_uah = round2(e.total_uah + (r.amount ?? 0));
    byMonth.set(mo, e);
  }
  const contracts = [...new Set(rows.map((r) => r.contract_number).filter((x): x is string => !!x))];
  const out: Record<string, unknown> = {
    found: rows.length > 0,
    query: { payer_edrpou: payer, recipient_edrpou: recipient, date_from: from, date_to: to },
    payer_name: rows[0]?.payer_name ?? null,
    recipient_name: rows[0]?.recipient_name ?? null,
    payment_count: rows.length,
    total_uah: sumUah(rows),
    by_month: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    recorded_contract_numbers: contracts,
    returned: Math.min(limit, rows.length),
    payments: rows.slice(0, limit),
    ...freshness(rows),
    source: SOURCE,
  };
  if (!rows.length) out.note = EMPTY_NOTE;
  return out;
}

interface TenderRow {
  tenderID: string | null;
  title: string | null;
  status: string | null;
  tender_value: { amount: number | null; currency: string | null } | null;
  buyer: string | null;
}

async function prozorroSearch(params: Record<string, string>): Promise<{ total: number; tenders: TenderRow[] }> {
  const p = new URLSearchParams(params);
  p.set('sort_by', 'dateCreated');
  p.set('order', 'desc');
  const res = await pwFetch(`${PROZORRO_SEARCH}?${p.toString()}`, 'ProZorro search', { method: 'POST' });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    if (res.status === 429) throw new Error(`upstream_throttled: ProZorro search rate limit (HTTP 429, 60 requests/min). ${summarizeErrorBody(raw)}`);
    throw new Error(`upstream_down: ProZorro search HTTP ${res.status}. ${summarizeErrorBody(raw)}`);
  }
  const data: any = await res.json().catch(() => {
    throw new Error(`upstream_down: ProZorro search HTTP ${res.status} returned a non-JSON body`);
  });
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return {
    total: Number(data?.total ?? 0),
    tenders: rows.map((d) => ({
      tenderID: d.tenderID ?? null,
      title: d.title ?? null,
      status: d.status ?? null,
      tender_value: d.value ? { amount: d.value.amount ?? null, currency: d.value.currency ?? null } : null,
      // The search index carries the buyer's NAME only — never its EDRPOU
      // (verified live 2026-10-08), which is why links are found by querying
      // buyer+tenderer together rather than by comparing codes on these rows.
      buyer: d.procuringEntity?.identifier?.legalName ?? d.procuringEntity?.name ?? null,
    })),
  };
}

async function prozorroLink(args: Record<string, unknown>) {
  const codes = edrpouList(args.supplier_edrpou, 'supplier_edrpou');
  if (!codes) throw new Error('user_error: supplier_edrpou is required (8-digit EDRPOU).');
  if (codes.length > 1) throw new Error('user_error: ua_spend_prozorro_link takes ONE supplier_edrpou.');
  const supplier = codes[0];
  const { from, to } = resolveWindow(args, 90);
  const maxPayers = intArg(args.max_payers, 5, 1, 8);

  const [rows, overall] = await Promise.all([
    fetchPayments(undefined, [supplier], from, to),
    prozorroSearch({ 'tenderer[0]': supplier, page: '1' }),
  ]);

  const payers = topBy(rows, 'payer', 50);
  const checked = payers.filter((p) => p.edrpou && /^\d+$/.test(p.edrpou)).slice(0, maxPayers);
  const links: Array<Record<string, unknown>> = [];
  // Sequential on purpose: ProZorro search allows ~60 requests/min shared by
  // every caller, and at most 8 payers are checked.
  for (const p of checked) {
    const hit = await prozorroSearch({ 'tenderer[0]': supplier, 'buyer[0]': p.edrpou as string, page: '1' });
    links.push({
      // `candidate` only when ProZorro actually shows a tender between the two;
      // a payer with none is reported, not labelled as a link.
      label: hit.total > 0 ? 'candidate' : 'no_prozorro_tender_found',
      payer_edrpou: p.edrpou,
      payer_name_treasury: p.name,
      payments_in_window: p.payments,
      paid_uah_in_window: p.total_uah,
      prozorro_tenders_with_this_buyer_and_supplier: hit.total,
      tenders: hit.tenders.slice(0, 10),
    });
  }

  const supplierName = rows.find((r) => r.recipient_name)?.recipient_name ?? null;
  return {
    supplier_edrpou: supplier,
    supplier_name_treasury: supplierName,
    payment_window: { date_from: from, date_to: to },
    payments_found: rows.length > 0,
    payment_count: rows.length,
    total_received_uah: sumUah(rows),
    payers,
    candidate_links: links.filter((l) => l.label === 'candidate'),
    payers_without_prozorro_tender: links.filter((l) => l.label !== 'candidate').map((l) => ({ payer_edrpou: l.payer_edrpou, payer_name_treasury: l.payer_name_treasury, paid_uah_in_window: l.paid_uah_in_window })),
    payers_checked_against_prozorro: checked.length,
    candidate_rule:
      'Every link is a CANDIDATE: ProZorro lists tenders where this payer was the buyer and this supplier took part, and the Treasury shows the same payer paying the supplier. That shared counterparty does not prove a given payment settles a given tender (tenders here span all years; the supplier may have bid and lost). Confirm with the contract number in the payment purpose or prozorro_get_tender awards.',
    prozorro_all_tenders: {
      total: overall.total,
      newest: overall.tenders,
      note: "Every ProZorro tender this supplier is associated with, newest 20 — not limited to the payers above. ProZorro's tenderer filter alone is fuzzy; the per-payer queries above are the tighter signal.",
    },
    ...freshness(rows),
    source: `${SOURCE}; ProZorro (prozorro.gov.ua) search index`,
    ...(rows.length ? {} : { note: EMPTY_NOTE }),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ua_spend_payments':
      return payments(args ?? {});
    case 'ua_spend_between':
      return between(args ?? {});
    case 'ua_spend_prozorro_link':
      return prozorroLink(args ?? {});
    default:
      throw new Error(`user_error: unknown tool ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
