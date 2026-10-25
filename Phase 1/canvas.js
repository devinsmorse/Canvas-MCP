'use strict';
// =====================================================================
// Canvas MCP — Canvas HTTP client (Phase 1: read-only)
//
// Only GET. Only the endpoint shapes listed in ALLOWED. Only these query
// parameters. Anything else throws before a request is made, so a bug or a
// clever request can't reach submissions, grades, people or analytics.
// The token comes from the macOS Keychain on each start and is never logged.
// =====================================================================
const { execFileSync } = require('child_process');

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

function readToken(instance, service) {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', instance, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return null; }
}

function checkPath(p) {
  if (!ALLOWED.some(re => re.test(p))) throw new Error('blocked: endpoint not on the read-only list');
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
  const fetchImpl = opts.fetch || fetch;
  const token = opts.token !== undefined ? opts.token : readToken(instance, opts.keychainService || 'canvas-mcp');
  const origin = new URL(base).origin;

  async function getOnce(url) {
    const u = new URL(url);
    if (u.origin !== origin) throw new Error('blocked: other host');
    checkPath(u.pathname);
    // re-validate every query parameter, including those in pagination links
    const rebuilt = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k === 'page' || k === 'per_page') { if (!/^[A-Za-z0-9_=-]{1,200}$/.test(v)) throw new Error('blocked: page'); rebuilt.append(k, v); continue; }
      buildQuery({ [k]: v }).forEach((vv, kk) => rebuilt.append(kk, vv));
    }
    u.search = rebuilt.toString();
    const res = await fetchImpl(u.toString(), { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) { const e = new Error('Canvas answered ' + res.status); e.status = res.status; throw e; }
    return { json: await res.json(), next: nextLink(res.headers.get('link')) };
  }

  return {
    hasToken: !!token,
    async get(p, params) {
      if (!token) throw new Error('no Canvas token in the Keychain for "' + instance + '"');
      checkPath(p);
      const q = buildQuery(params);
      return (await getOnce(origin + p + (q.toString() ? '?' + q : ''))).json;
    },
    async getAll(p, params, limit) {
      if (!token) throw new Error('no Canvas token in the Keychain for "' + instance + '"');
      checkPath(p);
      const q = buildQuery(Object.assign({ per_page: 100 }, params));
      let url = origin + p + '?' + q, out = [], n = 0;
      while (url && n < (limit || 50)) {
        const r = await getOnce(url);
        out = out.concat(Array.isArray(r.json) ? r.json : []);
        url = r.next; n++;
      }
      return out;
    },
  };
}

module.exports = { client, checkPath, buildQuery, ALLOWED };
