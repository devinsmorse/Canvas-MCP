'use strict';
// =====================================================================
// Canvas MCP — Canvas HTTP client (Phase 1: read-only)
//
// Only GET. Only the endpoint shapes listed in ALLOWED. Only these query
// parameters. Anything else throws before a request is made, so a bug or a
// clever request can't reach submissions, grades, people or analytics.
// Only the Canvas sites set up at install (root-owned courses.json), each at exactly its
// address, so the token can't be sent anywhere else.
// The token comes from the macOS Keychain and is never logged. The installer stores it with
// no trusted apps, so every read shows Devin a macOS prompt; the server reads it the first
// time Canvas is needed (not at startup, so the app never waits on the prompt to start the
// server) and keeps it in memory until the server stops.
// =====================================================================
const { execFile } = require('child_process');
const KEYCHAIN_WAIT_MS = 90e3;          // how long a read waits for Devin to answer the prompt
const KEYCHAIN_RETRY_MS = 10 * 60e3;    // after a denied or unanswered prompt, don't ask again for this long

// The Canvas sites a token may go to are not in this file: the installer asks for them and
// stores them in courses.json ("instances"), which is root-owned like this file, so nothing
// running as you can add a site. Each site, by instance name (= the Keychain account):
//   base: where the API answers (https://host, nothing else); links: hosts a course link may
//   show in the browser (exact hosts; never matched by suffix).
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = /^[a-z0-9-]{1,32}$/;

// A site entry checked whole: returns { base, links } or throws "blocked: ...".
function checkSite(instance, site) {
  const no = why => { throw new Error('blocked: Canvas site "' + instance + '" ' + why); };
  if (!NAME.test(String(instance))) throw new Error('blocked: "' + instance + '" is not a valid site name (lower-case letters, digits, hyphens)');
  if (site === null || typeof site !== 'object' || Array.isArray(site)) no('is not a site entry');
  const m = /^https:\/\/([^/?#:@\s]+)$/.exec(String(site.base || '').replace(/\/$/, ''));
  if (!m || !HOST.test(m[1])) no('needs an address of the form https://host (no port, path or login)');
  const links = Array.isArray(site.links) ? site.links.map(String) : null;
  if (!links || !links.length || links.length > 4 || !links.every(h => HOST.test(h))) no('needs 1 to 4 link hosts, each a plain lower-case host name');
  if (links.indexOf(m[1]) < 0) no('must list its own API host among its link hosts');
  return { base: 'https://' + m[1], links };
}
const siteList = sites => Object.keys(sites).map(k => sites[k].links.join(' or ')).join('; ') || 'none set up yet';

// The API base for an instance: the base must be a plain https host (checked again here, before
// the Keychain is touched, whatever the caller passed).
function siteBase(instance, base) {
  if (!NAME.test(String(instance))) throw new Error('blocked: "' + instance + '" is not a valid site name');
  const m = /^https:\/\/([^/?#:@\s]+)$/.exec(String(base || '').replace(/\/$/, ''));
  if (!m || !HOST.test(m[1])) throw new Error('blocked: the Canvas address for ' + instance + ' must be https://host (no port, path or login)');
  return 'https://' + m[1];
}

// A course link pasted into the installer -> { instance, base, id } for a site in `sites`, or
// { instance: null, host, id } for a Canvas site not set up yet (the installer then asks).
// The link is parsed as a URL, never by pattern, so "https://evil.example?@school.instructure.com/courses/1"
// is evil.example.
function parseCourseUrl(link, sites) {
  sites = sites || {};
  let u = null;
  try { u = new URL(String(link).trim()); } catch (e) { /* reported below */ }
  const host = u ? u.hostname.toLowerCase() : '';
  const m = u && /^\/courses\/([1-9]\d{0,14})(?:\/|$)/.exec(u.pathname);
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port || !HOST.test(host) || !m) {
    throw new Error('not a Canvas course link (it should look like https://canvas.yourschool.edu/courses/12345)');
  }
  const instance = Object.keys(sites).find(k => own(sites, k) && sites[k].links.indexOf(host) >= 0) || null;
  return instance ? { instance, base: sites[instance].base, id: Number(m[1]) } : { instance: null, host, id: Number(m[1]) };
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

module.exports = { client, checkPath, buildQuery, parseCourseUrl, siteBase, checkSite, discoverBase, ALLOWED };

// Finds where a school's Canvas API answers, for the installer: GET https://<host>/api/v1/users/self
// without a token, following at most 3 redirects, https only. A Canvas API answers that request with
// 401 and {"status":"unauthenticated"} or "user authorization required"; anything else (a sign-in
// page, another site) is refused. Returns the API base. No token is ever involved.
async function discoverBase(host, fetchFn) {
  fetchFn = fetchFn || fetch;
  if (!HOST.test(String(host))) throw new Error('not a host name: ' + host);
  let url = 'https://' + host + '/api/v1/users/self';
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetchFn(url, { redirect: 'manual', headers: { Accept: 'application/json' } });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location') || '', url);
      if (next.protocol !== 'https:' || next.username || next.password || next.port || !HOST.test(next.hostname)) throw new Error(host + ' redirects somewhere that is not a plain https address');
      url = next.href; continue;
    }
    const body = await res.text().catch(() => '');
    const u = new URL(url);
    if (res.status === 401 && /unauthenticated|user authorization required/i.test(body) && u.pathname === '/api/v1/users/self') return 'https://' + u.hostname;
    throw new Error(host + ' did not answer like a Canvas API (got HTTP ' + res.status + ')');
  }
  throw new Error(host + ' redirected too many times');
}

// For install.command (each prints one tab-separated line, or a reason on stderr and exit 1):
//   node canvas.js course-link <link> <sites.json>   ->  known<TAB>instance<TAB>base<TAB>id  |  new<TAB>host<TAB>id
//   node canvas.js discover <host>                   ->  the API base, e.g. https://school.instructure.com
//   node canvas.js add-site <sites.json> <name> <base> <link host>   (adds a checked site to the file)
if (require.main === module) {
  const fs = require('fs');
  const readSites = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
  const fail = e => { console.error(e.message || e); process.exit(1); };
  const [cmd, a, b, c, d] = process.argv.slice(2);
  try {
    if (cmd === 'course-link') {
      const r = parseCourseUrl(a, readSites(b));
      console.log(r.instance ? ['known', r.instance, r.base, r.id].join('\t') : ['new', r.host, r.id].join('\t'));
    } else if (cmd === 'discover') {
      discoverBase(a).then(base => console.log(base), fail);
    } else if (cmd === 'add-site') {
      const sites = readSites(a);
      if (own(sites, b)) throw new Error('the name "' + b + '" is already used for ' + sites[b].base);
      const baseHost = String(c).replace(/^https:\/\//, '').replace(/\/$/, '');
      const site = checkSite(b, { base: c, links: Array.from(new Set([baseHost, String(d || '').toLowerCase()].filter(Boolean))) });
      const clash = Object.keys(sites).find(k => site.links.some(h => sites[k].links.indexOf(h) >= 0));
      if (clash) throw new Error('that Canvas is already set up as "' + clash + '"');
      sites[b] = site;
      fs.writeFileSync(a, JSON.stringify(sites));
    } else if (cmd) throw new Error('unknown command ' + cmd);
  } catch (e) { fail(e); }
}
