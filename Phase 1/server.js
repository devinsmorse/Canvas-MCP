#!/usr/bin/env node
'use strict';
// =====================================================================
// Canvas MCP server — Phase 1 (read-only)
//
// What Claude can do through this server:
//   list_courses, roster_status, list_pages, get_page, page_visibility,
//   list_modules, list_assignments, get_assignment, list_assignment_groups,
//   get_course_settings, list_files
// What it cannot do: anything that writes; submissions, grades, people,
// analytics, discussions (all refused in canvas.js before any request).
//
// Every response:
//   1. keeps only the fields named in the tool (FIELD LISTS below),
//   2. is scrubbed: students -> {{type:S-XXXX}} tags (scrub.js),
//   3. is checked again by an independent substring search; any hit withholds
//      the whole response and logs which code (never the text).
// If the roster can't be loaded, every tool that returns course text refuses.
//
// Files (installed root-owned, so nothing running as you can change them):
//   /usr/local/lib/canvas-mcp/{server.js, scrub.js, roster.js, canvas.js}
//   /usr/local/etc/canvas-mcp/courses.json      which courses, which Canvas
// Private (yours; never sent to Claude):
//   ~/Library/Application Support/Claude Bridge/ student-codes.json, roster.csv,
//   canvas-roster.json, canvas-mcp-log.txt
// Token: macOS Keychain, service "canvas-mcp", account = instance name.
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const scrub = require('./scrub');
const rosterLib = require('./roster');
const canvasLib = require('./canvas');

const VERSION = '1.0.0';
const CONFIG_PATH = process.env.CANVAS_MCP_CONFIG || '/usr/local/etc/canvas-mcp/courses.json';
const PRIVATE_DIR = process.env.CANVAS_MCP_PRIVATE || path.join(os.homedir(), 'Library/Application Support/Claude Bridge');
const ROSTER_TTL_HOURS = 24;

const P = rosterLib.paths(PRIVATE_DIR);
let config = null, clients = {}, R = null, rosterInfo = { loaded: false, problem: 'not loaded yet' };

function log(line) {
  try { fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 }); fs.appendFileSync(P.log, new Date().toISOString() + ' | ' + line + '\n', { mode: 0o600 }); } catch (e) { /* logging never breaks a reply */ }
}

function loadConfig(opts) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!c.instances || !Array.isArray(c.courses)) throw new Error('courses.json needs "instances" and "courses"');
  config = c;
  clients = {};
  Object.entries(c.instances).forEach(([name, inst]) => { clients[name] = canvasLib.client(name, inst.base, opts && opts.clientOpts && opts.clientOpts(name)); });
}

function course(ref) {
  const r = String(ref || '').trim().toLowerCase();
  const c = config.courses.find(x => String(x.id) === r || (x.label || '').toLowerCase() === r || (x.instance + ':' + x.id) === r);
  if (!c) throw new Error('unknown course "' + ref + '". Use list_courses; only allowlisted courses are reachable.');
  return { c, api: clients[c.instance], base: '/api/v1/courses/' + Number(c.id) };
}

// ---- roster ----
async function syncRoster(force) {
  const cached = rosterLib.loadCached(P);
  const fresh = cached && (Date.now() - Date.parse(cached.synced_at)) < ROSTER_TTL_HOURS * 3600e3;
  let students = cached ? cached.students : null, problem = null;
  if (force || !fresh) {
    try {
      const users = [];
      for (const c of config.courses) {
        const list = await clients[c.instance].getAll('/api/v1/courses/' + Number(c.id) + '/users',
          { 'enrollment_type[]': 'student', 'enrollment_state[]': ['active', 'invited', 'completed', 'inactive'], 'include[]': 'email' });
        list.forEach(u => users.push({ instance: c.instance, course: c.label || String(c.id), id: u.id, name: u.name, sortable_name: u.sortable_name, short_name: u.short_name, email: u.email, login_id: u.login_id, sis_user_id: u.sis_user_id }));
      }
      students = rosterLib.build(P, users);
      log('roster synced: ' + students.length + ' students across ' + config.courses.length + ' courses');
    } catch (e) {
      problem = 'roster sync failed (' + e.message + ')' + (students ? '; using the copy from ' + cached.synced_at : '');
      log(problem);
    }
  }
  if (!students || !students.length) {
    rosterInfo = { loaded: false, problem: problem || 'no students found in the allowlisted courses' };
    R = null;
    return;
  }
  R = scrub.compile(students);
  rosterInfo = { loaded: true, students: students.length, synced_at: (rosterLib.loadCached(P) || {}).synced_at, problem };
}

// ---- field lists ----
const pick = (o, keys) => { const out = {}; keys.forEach(k => { if (o && o[k] !== undefined) out[k] = o[k]; }); return out; };
const PAGE_FIELDS = ['page_id', 'url', 'title', 'published', 'publish_at', 'front_page', 'editing_roles', 'created_at', 'updated_at'];
const MODULE_FIELDS = ['id', 'name', 'position', 'published', 'unlock_at', 'require_sequential_progress', 'prerequisite_module_ids', 'requirement_type', 'items_count'];
const ITEM_FIELDS = ['id', 'title', 'type', 'content_id', 'page_url', 'position', 'indent', 'published', 'external_url'];
const ASSIGNMENT_FIELDS = ['id', 'name', 'due_at', 'unlock_at', 'lock_at', 'points_possible', 'grading_type', 'grading_standard_id', 'submission_types',
  'allowed_extensions', 'allowed_attempts', 'assignment_group_id', 'position', 'published', 'unpublishable', 'omit_from_final_grade', 'hide_in_gradebook',
  'peer_reviews', 'automatic_peer_reviews', 'peer_review_count', 'anonymous_grading', 'moderated_grading', 'grader_count', 'post_manually',
  'only_visible_to_overrides', 'has_overrides', 'is_quiz_assignment', 'quiz_id', 'group_category_id', 'grade_group_students_individually',
  'in_closed_grading_period', 'html_url', 'created_at', 'updated_at'];
const GROUP_FIELDS = ['id', 'name', 'position', 'group_weight', 'rules'];
const COURSE_FIELDS = ['id', 'name', 'course_code', 'workflow_state', 'start_at', 'end_at', 'default_view', 'apply_assignment_group_weights',
  'grading_standard_id', 'hide_final_grades', 'is_public', 'public_syllabus', 'public_syllabus_to_auth', 'time_zone', 'license', 'blueprint'];
const LATE_FIELDS = ['missing_submission_deduction_enabled', 'missing_submission_deduction', 'late_submission_deduction_enabled', 'late_submission_deduction',
  'late_submission_interval', 'late_submission_minimum_percent_enabled', 'late_submission_minimum_percent'];
const FILE_FIELDS = ['id', 'display_name', 'filename', 'folder_id', 'content-type', 'size', 'created_at', 'updated_at', 'locked', 'hidden', 'unlock_at', 'lock_at'];
const FOLDER_FIELDS = ['id', 'full_name', 'name', 'parent_folder_id', 'files_count', 'folders_count', 'locked', 'hidden', 'unlock_at', 'lock_at'];

const pickItem = it => Object.assign(pick(it, ITEM_FIELDS),
  it.completion_requirement ? { completion_requirement: pick(it.completion_requirement, ['type', 'min_score', 'min_percentage']) } : {},
  it.content_details ? { content_details: pick(it.content_details, ['points_possible', 'due_at', 'unlock_at', 'lock_at']) } : {});

// ---- visibility (computed here so Claude can explain it) ----
async function modulesWithItems(k) {
  const mods = await k.api.getAll(k.base + '/modules', { 'include[]': ['items', 'content_details'] });
  for (const m of mods) {
    if (!m.items && m.items_count) m.items = await k.api.getAll(k.base + '/modules/' + Number(m.id) + '/items', { 'include[]': 'content_details' });
  }
  return mods;
}
function pageVisibility(page, mods, tabs, now) {
  const reasons = [];
  if (!page.published) return { visible_to_students: false, reasons: [page.publish_at ? 'unpublished; scheduled to publish ' + page.publish_at : 'unpublished'] };
  const via = [];
  mods.forEach(m => (m.items || []).forEach(it => {
    if (it.type === 'Page' && it.page_url === page.url) {
      const blocks = [];
      if (!m.published) blocks.push('module unpublished');
      if (m.unlock_at && Date.parse(m.unlock_at) > now) blocks.push('module locked until ' + m.unlock_at);
      if (it.published === false) blocks.push('module item unpublished');
      if ((m.prerequisite_module_ids || []).length) blocks.push('after prerequisite modules');
      via.push({ module: m.name, module_id: m.id, open: blocks.filter(b => b !== 'after prerequisite modules').length === 0, notes: blocks });
    }
  }));
  const pagesTab = (tabs || []).find(t => t.id === 'pages');
  const pagesTabHidden = pagesTab ? !!pagesTab.hidden : null;
  const openVia = via.filter(v => v.open);
  let visible;
  if (page.front_page) { visible = true; reasons.push('published front page'); }
  else if (openVia.length) { visible = true; reasons.push('published, and in open module(s): ' + openVia.map(v => v.module).join(', ')); }
  else if (pagesTabHidden === false) { visible = true; reasons.push('published, and listed in the Pages index (Pages tab is visible)'); }
  else { visible = false; reasons.push(via.length ? 'published, but every module containing it is closed' : 'published, but in no module and the Pages tab is hidden: reachable only by a direct link'); }
  return { visible_to_students: visible, reasons, modules: via, pages_tab_hidden: pagesTabHidden };
}

// ---- tools ----
const COURSE_ARG = { course: { type: 'string', description: 'Course label, ID, or instance:ID from list_courses.' } };
const TOOLS = [
  { name: 'list_courses', description: 'The allowlisted Canvas courses this server can read (label, instance, ID).', inputSchema: { type: 'object', properties: {} },
    run: async () => config.courses.map(c => ({ label: c.label, instance: c.instance, id: c.id })) , text: false },
  { name: 'roster_status', description: 'Whether the student roster used for de-identification is loaded: counts and sync time only. refresh=true re-reads enrollments from Canvas.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } },
    run: async a => { if (a.refresh) await syncRoster(true); return Object.assign({ server_version: VERSION }, rosterInfo); }, text: false },
  { name: 'list_pages', description: 'Pages in a course: title, URL slug, published, scheduled publish date, front page, who can edit, dates. No page text.',
    inputSchema: { type: 'object', properties: Object.assign({}, COURSE_ARG, { search: { type: 'string' } }), required: ['course'] },
    run: async a => { const k = course(a.course); return (await k.api.getAll(k.base + '/pages', Object.assign({ sort: 'title' }, a.search ? { search_term: a.search } : {}))).map(p => pick(p, PAGE_FIELDS)); } },
  { name: 'get_page', description: 'One page with its HTML body (students shown as tags).',
    inputSchema: { type: 'object', properties: Object.assign({}, COURSE_ARG, { page: { type: 'string', description: 'URL slug or page ID' } }), required: ['course', 'page'] },
    run: async a => { const k = course(a.course); const p = await k.api.get(k.base + '/pages/' + encodeURIComponent(String(a.page))); return Object.assign(pick(p, PAGE_FIELDS), { body: p.body || '' }); } },
  { name: 'page_visibility', description: 'Whether each page (or one page) is visible to students, and why: published state, module state, unlock dates, Pages tab.',
    inputSchema: { type: 'object', properties: Object.assign({}, COURSE_ARG, { page: { type: 'string', description: 'optional URL slug; omit for all pages' } }), required: ['course'] },
    run: async a => {
      const k = course(a.course); const now = Date.now();
      const [pages, mods, tabs] = await Promise.all([k.api.getAll(k.base + '/pages'), modulesWithItems(k), k.api.getAll(k.base + '/tabs')]);
      return pages.filter(p => !a.page || p.url === a.page).map(p => Object.assign({ title: p.title, url: p.url }, pageVisibility(p, mods, tabs, now)));
    } },
  { name: 'list_modules', description: 'Modules with their items: published, unlock dates, prerequisites, sequential progress, completion requirements, item due dates and points.',
    inputSchema: { type: 'object', properties: COURSE_ARG, required: ['course'] },
    run: async a => { const k = course(a.course); return (await modulesWithItems(k)).map(m => Object.assign(pick(m, MODULE_FIELDS), { items: (m.items || []).map(pickItem) })); } },
  { name: 'list_assignments', description: 'Assignments and their settings (dates, points, grading type, submission types, group, peer review, anonymous/moderated grading, posting policy). No submissions or scores.',
    inputSchema: { type: 'object', properties: COURSE_ARG, required: ['course'] },
    run: async a => { const k = course(a.course); return (await k.api.getAll(k.base + '/assignments')).map(x => pick(x, ASSIGNMENT_FIELDS)); } },
  { name: 'get_assignment', description: 'One assignment with all its settings and its description HTML.',
    inputSchema: { type: 'object', properties: Object.assign({}, COURSE_ARG, { assignment_id: { type: 'integer' } }), required: ['course', 'assignment_id'] },
    run: async a => { const k = course(a.course); const x = await k.api.get(k.base + '/assignments/' + Number(a.assignment_id)); return Object.assign(pick(x, ASSIGNMENT_FIELDS), { description: x.description || '' }); } },
  { name: 'list_assignment_groups', description: 'Assignment groups with weights and drop rules, and whether the course uses weighting.',
    inputSchema: { type: 'object', properties: COURSE_ARG, required: ['course'] },
    run: async a => {
      const k = course(a.course);
      const [groups, c] = await Promise.all([k.api.getAll(k.base + '/assignment_groups'), k.api.get(k.base)]);
      const weights = groups.reduce((s, g) => s + (Number(g.group_weight) || 0), 0);
      return { weighting_on: !!c.apply_assignment_group_weights, total_weight: weights, groups: groups.map(g => pick(g, GROUP_FIELDS)) };
    } },
  { name: 'get_course_settings', description: 'Course settings, plus the grading-related settings Canvas exposes (grading scheme, weighting, hide totals, late/missing policy). Not the gradebook itself.',
    inputSchema: { type: 'object', properties: COURSE_ARG, required: ['course'] },
    run: async a => {
      const k = course(a.course);
      const [c, settings, late, standards, tabs] = await Promise.all([
        k.api.get(k.base), k.api.get(k.base + '/settings'),
        k.api.get(k.base + '/late_policy').catch(e => (e.status === 404 ? null : Promise.reject(e))),
        k.api.getAll(k.base + '/grading_standards').catch(() => []),
        k.api.getAll(k.base + '/tabs')]);
      return { course: pick(c, COURSE_FIELDS), settings, late_policy: late && late.late_policy ? pick(late.late_policy, LATE_FIELDS) : null,
        grading_standards: standards.map(s => ({ id: s.id, title: s.title, scheme: s.grading_scheme })),
        navigation: tabs.map(t => ({ id: t.id, label: t.label, hidden: !!t.hidden, position: t.position })) };
    } },
  { name: 'list_files', description: 'Files and folders in a course: names, sizes, dates, locked/hidden. Metadata only; file contents and download links are never returned.',
    inputSchema: { type: 'object', properties: Object.assign({}, COURSE_ARG, { search: { type: 'string' } }), required: ['course'] },
    run: async a => {
      const k = course(a.course);
      const [files, folders] = await Promise.all([k.api.getAll(k.base + '/files', a.search ? { search_term: a.search } : {}), k.api.getAll(k.base + '/folders')]);
      return { folders: folders.map(f => pick(f, FOLDER_FIELDS)), files: files.map(f => pick(f, FILE_FIELDS)) };
    } },
];

// The settings object from /settings is free-form; keep only simple values.
function sanitize(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sanitize);
  const o = {}; Object.keys(v).forEach(k => { o[k] = sanitize(v[k]); }); return o;
}

async function callTool(name, args) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error('unknown tool ' + name);
  if (!R && t.text !== false) {
    await syncRoster(false);
    if (!R) { log(name + ' refused: roster not loaded'); throw new Error('refused: the student roster is not loaded (' + rosterInfo.problem + '), so nothing can be de-identified. Run roster_status with refresh=true, or check the token.'); }
  } else if (R) {
    const cached = rosterLib.loadCached(P);
    if (!cached || (Date.now() - Date.parse(cached.synced_at)) > ROSTER_TTL_HOURS * 3600e3) await syncRoster(false);
  }
  let result = sanitize(await t.run(args || {}));
  let text;
  if (R) {
    result = scrub.scrubDeep(R, result);
    text = JSON.stringify(result, null, 1);
    const hit = scrub.residue(R, text);
    if (hit) { log(name + ' WITHHELD: residue for ' + hit + ' after scrubbing (args: ' + JSON.stringify(scrub.scrubDeep(R, args || {})) + ')'); throw new Error('withheld: a student identifier survived scrubbing, so the whole response was held back. Logged on the Mac for Devin.'); }
  } else {
    text = JSON.stringify(result, null, 1);
  }
  log(name + ' ok (' + text.length + ' chars)');
  return text;
}

// ---- MCP over stdio (newline-delimited JSON-RPC) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;        // notifications need no reply
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'canvas', version: VERSION },
        instructions: 'Read-only Canvas access for Devin\'s courses. Students appear only as tags like {{name:S-4F7K}}, the same codes as the Mail bridge. Never try to work out who a code is. Writes are not available in this version.' } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } })) } });
    if (method === 'tools/call') {
      try { const text = await callTool(params.name, params.arguments); return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }); }
      catch (e) { log((params && params.name) + ' error: ' + (R ? scrub.scrubText(R, e.message) : e.message)); return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: R ? scrub.scrubText(R, e.message) : e.message }] } }); }
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } });
  }
}

function startStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      handle(msg);
    }
  });
}

// --selftest: run by the installer in Terminal; prints counts only, never names.
async function selftest() {
  const out = [];
  for (const [name, api] of Object.entries(clients)) {
    if (!api.hasToken) { out.push(name + ': NO TOKEN in Keychain'); continue; }
    try { await api.get('/api/v1/users/self'); out.push(name + ': token works'); } catch (e) { out.push(name + ': token check failed (' + e.message + ')'); }
  }
  await syncRoster(true);
  out.push('roster: ' + (rosterInfo.loaded ? rosterInfo.students + ' students loaded' : 'NOT loaded: ' + rosterInfo.problem));
  for (const c of config.courses) {
    try { const n = (await clients[c.instance].getAll('/api/v1/courses/' + Number(c.id) + '/pages')).length; out.push((c.label || c.id) + ': ' + n + ' pages readable'); }
    catch (e) { out.push((c.label || c.id) + ': ' + e.message); }
  }
  console.log(out.join('\n'));
}

module.exports = { TOOLS, callTool, loadConfig, syncRoster, pageVisibility, handle, _state: () => ({ R, rosterInfo }) };

if (require.main === module) {
  try { loadConfig(); } catch (e) { log('config error: ' + e.message); }
  if (process.argv.includes('--selftest')) {
    if (!config) { console.log('Could not read ' + CONFIG_PATH); process.exit(1); }
    selftest().then(() => process.exit(0), e => { console.log('selftest failed: ' + e.message); process.exit(1); });
  } else {
    if (!config) { // still answer MCP so the app shows a clear error instead of a crash loop
      TOOLS.length = 0;
      TOOLS.push({ name: 'list_courses', description: 'Configuration problem', inputSchema: { type: 'object', properties: {} }, text: false, run: async () => { throw new Error('canvas-mcp: could not read ' + CONFIG_PATH); } });
    }
    log('server started v' + VERSION);
    startStdio();
  }
}
