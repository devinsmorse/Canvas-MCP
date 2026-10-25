'use strict';
// =====================================================================
// Canvas MCP — Canvas HTTP client (Phase 1: read-only)
//
// Only GET. Only the endpoint shapes listed in ALLOWED. Only these query
// parameters. Anything else throws before a request is made, so a bug or a
// clever request can't reach submissions, grades, people or analytics.
// Only the Canvas sites in SITES, each at exactly its listed address, so the
// token can't be sent anywhere else, whatever courses.json says.
// The token comes from the macOS Keychain and is never logged. The installer stores it with
// no trusted apps, so every read shows Devin a macOS prompt; the server reads it the first
// time Canvas is needed (not at startup, so the app never waits on the prompt to start the
// server) and keeps it in memory until the server stops.
// =====================================================================
const { execFile } = require('child_process');
const KEYCHAIN_WAIT_MS = 90e3;          // how long a read waits for Devin to answer the prompt
const KEYCHAIN_RETRY_MS = 10 * 60e3;    // after a denied or unanswered prompt, don't ask again for this long

// The only Canvas sites a token may go to, by instance name (= the Keychain account).
// base: where the API answers. links: hosts a course link may show in the browser.
// Checked 2026-10-25: uncch.instructure.com answers the API and canvas.unc.edu is its
// front door; canvas.elon.edu redirects to elon.instructure.com, which signs in through
// idp.elon.edu. Add a site only after checking it the same way; never match by suffix.
const SITES = {
  unc: { base: 'https://uncch.instructure.com', links: ['uncch.instructure.com', 'canvas.unc.edu'] },
  elon: { base: 'https://elon.instructure.com', links: ['elon.instructure.com', 'canvas.elon.edu'] },
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const siteList = () => Object.keys(SITES).map(k => SITES[k].links.join(' or ')).join('; ');

// The API base for an instance; the configured base must be exactly the listed one.
function siteBase(instance, base) {
  if (!own(SITES, instance)) throw new Error('blocked: "' + instance + '" is not one of the known Canvas sites (' + Object.keys(SITES).join(', ') + ')');
  if (String(base).replace(/\/$/, '') !== SITES[instance].base) throw new Error('blocked: the Canvas address for ' + instance + ' must be ' + SITES[instance].base);
  return SITES[instance].base;
}

// A course link pasted into the installer -> { instance, base, id }. The link is parsed as a
// URL, never by pattern, so "https://evil.example?@uncch.instructure.com/courses/1" is evil.example.
function parseCourseUrl(link) {
  let u = null;
  try { u = new URL(String(link).trim()); } catch (e) { /* reported below */ }
  const host = u ? u.hostname.toLowerCase() : '';
  const instance = Object.keys(SITES).find(k => SITES[k].links.indexOf(host) >= 0);
  const m = u && /^\/courses\/([1-9]\d{0,14})(?:\/|$)/.exec(u.pathname);
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port || !instance || !m) {
    throw new Error('not a course link on a known Canvas site (' + siteList() + '), like https://' + SITES.unc.links[1] + '/courses/12345');
  }
  return { instance, base: SITES[instance].base, id: Number(m[1]) };
}

const C = '/api/v1/courses/\\d+';
const ALLOWED = [
  // course, settings and grading-related settings (no gradebook data)
  new RegExp('^' + C + '$'),
  new RegExp('^' + C + '/settings$'),
  new RegExp('^' + C + '/late_policy$'),
  new RegExp('^' + C + '/grading_standards$'),
  new RegExp('^' + C + '/tabs$'),
  // pages
  new RegExp('^' + C + '/pages$'),
  new RegExp('^' + C + '/pages/[A-Za-z0-9_%.-]+$'),
  // modules
  new RegExp('^' + C + '/modules$'),
  new RegExp('^' + C + '/modules/\\d+/items$'),
  // assignments and groups
  new RegExp('^' + C + '/assignments$'),
  new RegExp('^' + C + '/assignments/\\d+$'),
  new RegExp('^' + C + '/assignment_groups$'),
  // files (metadata only; download URLs are dropped by the tools)
  new RegExp('^' + C + '/files$'),
  new RegExp('^' + C + '/folders$'),
  // roster sync only: student enrollments, used inside the server, never returned
  new RegExp('^' + C + '/users$'),
  // token check
  /^\/api\/v1\/users\/self$/,
];
// Allowed query parameters (name -> allowed values; null = any simple value)
const PARAMS = {
  per_page: null, page: null, sort: ['title', 'created_at', 'updated_at'], order: ['asc', 'desc'], search_term: null,
  published: ['true', 'false'],
  'include[]': ['body', 'items', 'content_details', 'email'],
  'enrollment_type[]': ['student'],
  'enrollment_state[]': ['active', 'invited', 'completed', 'inactive'],
};
// include[] values that would return student data — refused even if added above by mistake
const FORBIDDEN_INCLUDES = ['submission', 'score_statistics', 'assignment_visibility', 'overrides', 'all_dates', 'observed_users',
  'needs_grading_count', 'total_students', 'teachers', 'students', 'enrollments', 'assessments', 'user', 'avatar_url'];

// Resolves to the token, or null (no token saved, access denied, or the prompt not answered in time).
function readToken(instance, service, waitMs) {
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', instance, '-w'], { encoding: 'utf8', timeout: waitMs, stdio: ['ignore', 'pipe', 'ignore'] },
      (err, out) => resolve(err ? null : String(out || '').trim() || null));
  });
}

// Encoded slashes, backslashes and dots, control characters (%00-%1F, %7F), overlong
// UTF-8 (%C0, %C1) and dot segments are refused outright: a server
// or proxy that decoded them could route the request past the patterns above.
function checkPath(p) {
  if (typeof p !== 'string' || /%(?:2f|5c|2e|[01][0-9a-f]|7f|c0|c1)|\\/i.test(p) || /(^|\/)\.\.?(\/|$)/.test(p) || !ALLOWED.some(re => re.test(p))) {
    throw new Error('blocked: endpoint not on the read-only list');
  }
}
function buildQuery(params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    const vals = Array.isArray(v) ? v : [v];
    if (!(k in PARAMS)) throw new Error('blocked: query parameter ' + k);
    vals.forEach(x => {
      x = String(x);
      if (k === 'include[]' && FORBIDDEN_INCLUDES.indexOf(x) >= 0) throw new Error('blocked: include ' + x);
      if (PARAMS[k] && PARAMS[k].indexOf(x) < 0) throw new Error('blocked: value for ' + k);
      if (!/^[A-Za-z0-9 _.:-]{0,100}$/.test(x)) throw new Error('blocked: value for ' + k);
      q.append(k, x);
    });
  });
  return q;
}

function nextLink(h) {
  if (!h) return null;
  const m = h.split(',').map(s => s.trim()).find(s => /rel="next"/.test(s));
  if (!m) return null;
  const u = /<([^>]+)>/.exec(m); return u ? u[1] : null;
}

function client(instance, base, opts) {
  opts = opts || {};
  const origin = siteBase(instance, base);      // before the Keychain is touched
  const fetchImpl = opts.fetch || fetch;
  const read = opts.readToken || readToken, waitMs = opts.keychainWaitMs || KEYCHAIN_WAIT_MS, retryMs = opts.keychainRetryMs || KEYCHAIN_RETRY_MS;
  let token = opts.token !== undefined ? opts.token : null, pending = null, failedAt = 0;
  // One Keychain read at a time; a failed read isn't repeated for retryMs, so a denied prompt
  // doesn't come straight back on the next tool call.
  async function getToken() {
    if (token || opts.token !== undefined) return token;
    if (failedAt && Date.now() - failedAt < retryMs) return null;
    if (!pending) pending = read(instance, opts.keychainService || 'canvas-mcp', waitMs).then(t => { pending = null; if (t) { token = t; failedAt = 0; } else failedAt = Date.now(); return t; });
    return pending;
  }
  const noToken = () => new Error('no Canvas token for "' + instance + '": none saved in the Keychain, or Devin did not allow access on the Mac (the prompt waits ' + Math.round(waitMs / 1000) +
    ' s; after a denied or unanswered prompt the server waits ' + Math.round(retryMs / 60e3) + ' min before asking again)');

  async function getOnce(url, tk) {
    const u = new URL(url);
    if (u.origin !== origin) throw new Error('blocked: other host');
    checkPath(u.pathname);
    // re-validate every query parameter, including those in pagination links
    // (page is a number, or on some endpoints a "bookmark:WzEwMF0" token)
    const rebuilt = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k === 'per_page') { if (!/^\d{1,3}$/.test(v)) throw new Error('blocked: per_page'); rebuilt.append(k, v); continue; }
      if (k === 'page') { if (!/^[A-Za-z0-9_=:+\/-]{1,500}$/.test(v)) throw new Error('blocked: page'); rebuilt.append(k, v); continue; }
      buildQuery({ [k]: v }).forEach((vv, kk) => rebuilt.append(kk, vv));
    }
    u.search = rebuilt.toString();
    const res = await fetchImpl(u.toString(), { method: 'GET', headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) { const e = new Error('Canvas answered ' + res.status); e.status = res.status; throw e; }
    // a reply that isn't JSON (an HTML error page) is reported without any of its text
    let json; try { json = await res.json(); } catch (e) { throw new Error('Canvas sent a reply that is not JSON (' + res.status + ')'); }
    return { json, next: nextLink(res.headers.get('link')) };
  }

  return {
    // true once the token has been read (the first call shows Devin the Keychain prompt)
    async tokenReady() { return !!(await getToken()); },
    async get(p, params) {
      checkPath(p);                                  // refused paths never reach the Keychain
      const q = buildQuery(params);
      const tk = await getToken(); if (!tk) throw noToken();
      return (await getOnce(origin + p + (q.toString() ? '?' + q : ''), tk)).json;
    },
    async getAll(p, params, limit) {
      checkPath(p);
      const q = buildQuery(Object.assign({ per_page: 100 }, params));
      const tk = await getToken(); if (!tk) throw noToken();
      let url = origin + p + '?' + q, out = [], n = 0;
      while (url && n < (limit || 50)) {
        const r = await getOnce(url, tk);
        out = out.concat(Array.isArray(r.json) ? r.json : []);
        url = r.next; n++;
      }
      return out;
    },
  };
}

module.exports = { client, checkPath, buildQuery, parseCourseUrl, siteBase, SITES, ALLOWED };

// For install.command: node canvas.js course-link <link>  ->  "instance<TAB>base<TAB>id", or exit 1.
if (require.main === module && process.argv[2] === 'course-link') {
  try { const c = parseCourseUrl(process.argv[3]); console.log([c.instance, c.base, c.id].join('\t')); }
  catch (e) { console.error(e.message); process.exit(1); }
}
