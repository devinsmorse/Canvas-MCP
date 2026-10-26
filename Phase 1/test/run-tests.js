'use strict';
// node test/run-tests.js — every check prints PASS/FAIL; exit code 1 on any failure.
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
const priv = path.join(tmp, 'private'); fs.mkdirSync(priv);
// pre-existing bridge state: Jane already has a code from mail; roster.csv adds a nickname for José
fs.writeFileSync(path.join(priv, 'student-codes.json'), JSON.stringify({ 'jdoe@school.edu': 'S-JANE' }));
fs.writeFileSync(path.join(priv, 'roster.csv'), 'name,email,course,preferred\n"de la Cruz, José",jcruz@college.edu,TEST 101,Pepito\n');
const SITE = { base: 'https://school.instructure.com', links: ['school.instructure.com', 'canvas.school.edu'] };
const GOOD_CONFIG = { instances: { school: SITE }, courses: [{ instance: 'school', id: 1, label: 'TEST 101' }] };
fs.writeFileSync(path.join(tmp, 'courses.json'), JSON.stringify(GOOD_CONFIG));
process.env.CANVAS_MCP_CONFIG = path.join(tmp, 'courses.json');
process.env.CANVAS_MCP_PRIVATE = priv;

const { execFileSync } = require('child_process');
const fake = require('./fake-canvas');
const server = require('../server');
const canvas = require('../canvas');
const scrub = require('../scrub');
const rosterLib = require('../roster');
const claudeConfig = require('../claude-config');
const calls = [];
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
const leaks = text => fake.SECRETS.filter(s => scrub.fold(text).text.indexOf(scrub.fold(s).text) >= 0);

(async () => {
  server.loadConfig({ clientOpts: () => ({ fetch: fake.makeFetch(calls), token: 'test-token' }) });

  // roster + shared codes
  const st = JSON.parse(await server.callTool('roster_status', { refresh: true }));
  check(st.loaded && st.students === 4, 'roster loads 4 students');
  const codes = JSON.parse(fs.readFileSync(path.join(priv, 'student-codes.json')));
  check(codes['jdoe@school.edu'] === 'S-JANE', 'existing bridge code kept for Jane');
  check(/^S-[A-Z2-9]{4}$/.test(codes['rokonkwo@school.edu']) && /^S-[A-Z2-9]{4}$/.test(codes['jcruz@college.edu']), 'new students get bridge-format codes, keyed by email');
  check(leaks(JSON.stringify(st)).length === 0, 'roster_status shows counts only');

  // every tool, scanned for every planted identifier
  const runs = [
    ['list_courses', {}], ['list_pages', { course: 'TEST 101' }], ['get_page', { course: 'TEST 101', page: 'syllabus' }], ['get_page', { course: 'TEST 101', page: 'jane-doe-presentation' }],
    ['get_page', { course: 'TEST 101', page: 'group-3' }], ['get_page', { course: 'TEST 101', page: 'week-5-notes' }], ['get_page', { course: 'TEST 101', page: 'hidden-resources' }],
    ['page_visibility', { course: 'TEST 101' }], ['list_modules', { course: '1' }], ['list_assignments', { course: 'TEST 101' }],
    ['get_assignment', { course: 'TEST 101', assignment_id: 501 }], ['list_assignment_groups', { course: 'TEST 101' }],
    ['get_course_settings', { course: 'TEST 101' }], ['list_files', { course: 'TEST 101' }],
  ];
  const outputs = {};
  for (const [name, args] of runs) {
    let text;
    try { text = await server.callTool(name, args); } catch (e) { text = 'ERROR ' + e.message; }
    outputs[name + JSON.stringify(args)] = text;
    const l = leaks(text);
    check(l.length === 0 && !text.startsWith('ERROR'), name + ' ' + JSON.stringify(args) + (l.length ? ' LEAKED ' + l.length + ' identifier(s)' : '') + (text.startsWith('ERROR') ? ' ' + text : ''));
  }
  const all = Object.values(outputs).join('\n');
  check(all.indexOf('{{name:S-JANE}}') >= 0, 'Jane appears as {{name:S-JANE}}');
  check(all.indexOf('{{email:S-JANE}}') >= 0 && all.indexOf('{{login:S-JANE}}') >= 0 && all.indexOf('{{sis:S-JANE}}') >= 0 && all.indexOf('{{canvas_id:S-JANE}}') >= 0, 'email, login, SIS and user-ID tags carry their type');
  check(all.indexOf('Morgan Lee') >= 0, 'staff (TA) name passes through');
  check(!/needs_grading_count|"submission"|score_statistics|final_grader_id|overrides|verifier|last_edited_by|total_students|"teachers"\s*:|enrollments/.test(all), 'grading, submission, people and download fields never returned');
  check(!/"user"/.test(all), 'file uploader never returned');
  check(/\{\{name:S-JANE\}\} \[student matter withheld\]/.test(all), 'file naming a student + accommodation keeps only the tag');
  check(all.indexOf('for the example') >= 0 && all.indexOf('Frege') >= 0, 'ordinary words and non-student names pass through');
  const R0 = server._state().R;
  const tricky = ['Jane&nbsp;Doe', '<strong>Jane</strong> Doe', 'JANE QUINN DOE', 'Doe,Jane', 'jane_doe_essay', 'Okonkwo‐Smith', 'de la Cruz, José', 'Jose de la Cruz',
    'Jos&eacute; de la Cruz', 'Jos&#233; de la Cruz', 'Siobhan O&rsquo;Brien', '<a href="/files/jane%20doe.pdf">', 'Jos%C3%A9 de la Cruz', 'jdoe&#64;school.edu', 'Ja­ne Doe', 'Ja​ne Doe', 'See {{note:Robert}} later'];
  tricky.forEach(x => { const o = scrub.scrubLabel(R0, x) + ' | ' + scrub.scrubText(R0, x); check(leaks(o.replace(/&nbsp;/g, ' ')).length === 0 && scrub.residue(R0, o) === null, 'tricky form scrubbed: ' + x); });
  check(scrub.scrubText(server._state().R, 'Robert said you will see.').indexOf('you will see') >= 0, 'lower-case common words survive name matching');
  check(scrub.scrubText(R0, 'jane submitted the request; ask pepe or siobhan.') === '{{name:S-JANE}} submitted the request; ask ' +
    scrub.scrubText(R0, 'Pepe') + ' or ' + scrub.scrubText(R0, 'Siobhan') + '.', 'lower-case standalone names are scrubbed');
  const RW = scrub.compile([{ code: 'S-AAAA', names: ['Emma Young'], prefs: [] }, { code: 'S-BBBB', names: ['Daniel Price'], prefs: [] },
    { code: 'S-CCCC', names: ['Olivia Long'], prefs: [] }, { code: 'S-DDDD', names: ['William Alt'], prefs: [] }]);
  const prose = 'Week 3 is a long reading; the price is low, the young will like it. <img alt="x">';
  check(scrub.scrubText(RW, prose) === prose && scrub.residue(RW, prose) === null, 'everyday words that are also names survive in lower case (long, price, young, will, alt)');
  check(scrub.scrubText(RW, 'Ask Price, then Long.') === 'Ask {{name:S-BBBB}}, then {{name:S-CCCC}}.', '... and are still scrubbed when capitalised');
  check(scrub.scrubLabel(RW, 'long-essay.pdf') === '{{name:S-CCCC}}-essay.pdf', '... and in any case in labels (file names, slugs)');

  // initials forms need a dot, or capitals next to a capitalised surname
  const RI = scrub.compile([{ code: 'S-AL00', names: ['Alice Long'], prefs: [] }, { code: 'S-OY00', names: ['Olivia Young'], prefs: [] },
    { code: 'S-JD00', names: ['Jane Doe'], prefs: [] }, { code: 'S-JC00', names: ['José de la Cruz'], prefs: [] }]);
  [['A long reading, or Young, on long days.', 'A long reading, or {{name:S-OY00}}, on long days.'],
    ['Read a long essay.', 'Read a long essay.'],
    ['Long, a reading list', '{{name:S-AL00}}, a reading list'],
  ].forEach(([x, want]) => check(scrub.scrubText(RI, x) === want, 'short word before or after a surname is not an initial: ' + JSON.stringify(x)));
  [['A. Long', 'S-AL00'], ['A Long said', 'S-AL00'], ['J. Doe', 'S-JD00'], ['J Doe', 'S-JD00'], ['JQ Doe', 'S-JD00'], ['j.q. doe', 'S-JD00'],
    ['Doe, J.', 'S-JD00'], ['Doe, J', 'S-JD00'], ['J de la Cruz', 'S-JC00'], ['O. Young and A. Long', 'S-OY00']]
    .forEach(([x, code]) => { const o = scrub.scrubText(RI, x); check(/^\{\{name:S-[A-Z0-9]{4}\}\}/.test(o) && o.indexOf(code) >= 0 && !/\b(doe|long|young|cruz)\b/i.test(o), 'real initials still a name: ' + JSON.stringify(x)); });
  check(/^\{\{name:S-[A-Z0-9]{4}\}\}$/.test(scrub.scrubText(R0, 'Jos&eacute; de la Cruz')), 'entity-encoded full name becomes one tag');
  check(scrub.scrubText(R0, 'mailto:jdoe&#64;school.edu') === 'mailto:{{email:S-JANE}}', 'entity-encoded email becomes the email tag');
  check(scrub.scrubText(R0, 'Ask &Eacute;mile or Jane') === 'Ask &Eacute;mile or {{name:S-JANE}}', 'entities that are not names are left as they are');
  check(scrub.residue(R0, 'Jos&eacute; de la Cruz') !== null && scrub.residue(R0, 'jane%20doe') !== null, 'backstop sees through entities and %-encoding');
  check(scrub.scrubText(R0, 'Already {{name:S-JANE}} here') === 'Already {{name:S-JANE}} here', 'existing tags are left alone');

  // visibility logic
  const vis = JSON.parse(outputs['page_visibility{"course":"TEST 101"}']);
  const v = slugPart => vis.find(x => x.url.indexOf(slugPart) >= 0);
  check(v('syllabus').visible_to_students === true, 'front page visible');
  check(v('week-5-notes').visible_to_students === true, 'page in open module visible');
  check(v('group-3').visible_to_students === false, 'unpublished page hidden');
  check(v('hidden-resources').visible_to_students === false && /direct link/.test(v('hidden-resources').reasons[0]), 'published page outside modules with Pages tab hidden: link-only');
  const visText = outputs['page_visibility{"course":"TEST 101"}'];
  check(!/extension/i.test(visText) && /\[student matter withheld\]/.test(visText), 'page_visibility: a module named for a student matter keeps only the tag');
  const pv = (page, mod, tabs) => server.pageVisibility(Object.assign({ published: true, url: 'q' }, page), [Object.assign({ id: 9, name: 'M', published: true, items: [{ type: 'Page', page_url: 'q', position: 1 }] }, mod)], tabs || [], Date.now());
  check(pv({ front_page: true }, { unlock_at: '2030-01-01T00:00:00Z' }).visible_to_students === false, 'front page inside a date-locked module is not visible');
  const pre = pv({}, { prerequisite_module_ids: [1] });
  check(pre.visible_to_students === null && pre.after_requirements === true, 'page behind prerequisites: null (depends on the student), after requirements');
  const seq = pv({}, { require_sequential_progress: true, items: [{ type: 'Page', page_url: 'a', position: 1 }, { type: 'Page', page_url: 'q', position: 2 }] });
  check(seq.visible_to_students === null && seq.after_requirements === true, 'second item under sequential progress: null, after requirements');
  const preTab = pv({}, { prerequisite_module_ids: [1] }, [{ id: 'pages', hidden: false }]);
  check(preTab.visible_to_students === null, 'prerequisites still apply when the Pages list is visible');
  check(pv({}, { published: false }, [{ id: 'pages', hidden: false }]).visible_to_students === true, 'page in an unpublished module is still reachable from a visible Pages list');
  check(pv({}, { published: false }, [{ id: 'pages', hidden: true }]).visible_to_students === false, 'page in an unpublished module with the Pages tab hidden: link-only');

  // pagination and settings
  check(JSON.parse(outputs['list_assignment_groups{"course":"TEST 101"}']).groups.length === 2, 'bookmark pagination followed to the second page');
  const settings = JSON.parse(outputs['get_course_settings{"course":"TEST 101"}']).settings;
  check(settings.allow_student_discussion_topics === true && settings.hide_final_grades === false, 'course settings keep listed keys');
  check(!('nested_example' in settings) && !('access_token' in settings) && !('student_email_addresses' in settings), 'course settings drop unlisted keys, even plain ones');

  // independent backstop withholds
  const R = server._state().R;
  check(scrub.residue(R, 'note: jane doe said') !== null, 'backstop catches a full name');
  check(scrub.residue(R, 'nothing here about anyone') === null, 'backstop quiet on clean text');

  // the client refuses anything outside the read-only list, before any request
  const before = calls.length;
  const api = canvas.client('school', 'https://school.instructure.com', { fetch: fake.makeFetch(calls), token: 't' });
  const refused = async (fn, what) => { try { await fn(); check(false, what); } catch (e) { check(/blocked/.test(e.message), what); } };
  await refused(() => api.get('/api/v1/courses/1/assignments/501/submissions'), 'submissions endpoint blocked');
  await refused(() => api.get('/api/v1/courses/1/enrollments'), 'enrollments endpoint blocked');
  await refused(() => api.get('/api/v1/courses/1/analytics/activity'), 'analytics blocked');
  await refused(() => api.get('/api/v1/courses/1/discussion_topics'), 'discussions blocked (not in Phase 1)');
  await refused(() => api.get('/api/v1/courses/1/assignments', { 'include[]': 'submission' }), 'include[]=submission blocked');
  await refused(() => api.get('/api/v1/courses/1/assignments', { 'include[]': 'overrides' }), 'include[]=overrides blocked');
  await refused(() => api.get('/api/v1/courses/1/modules', { student_id: 9001 }), 'student_id parameter blocked');
  await refused(() => api.get('/api/v1/courses/1/pages/../../users/9001'), 'path tricks blocked');
  check(calls.length === before, 'no request was sent for any blocked call');
  check(calls.every(c => c.method === 'GET'), 'every request the server made was a GET');
  try { await server.callTool('get_page', { course: 'TEST 999', page: 'x' }); check(false, 'unknown course refused'); } catch (e) { check(/unknown course/.test(e.message), 'course outside the allowlist refused'); }

  // a token can only go to a Canvas site set up at install, at exactly its address
  const SITES = { school: SITE, college: { base: 'https://college.instructure.com', links: ['college.instructure.com', 'canvas.college.edu'] } };
  const sendsTo = link => { try { const c = canvas.parseCourseUrl(link, SITES); return c.instance ? c.instance + ' ' + c.base + ' ' + c.id : 'new ' + c.host + ' ' + c.id; } catch (e) { return 'refused'; } };
  check(sendsTo('https://canvas.school.edu/courses/12345') === 'school https://school.instructure.com 12345', 'school link from the browser maps to the school API address');
  check(sendsTo('https://school.instructure.com/courses/12345/modules?x=1') === 'school https://school.instructure.com 12345', 'link to a page inside a course is accepted');
  check(sendsTo('https://canvas.college.edu/courses/77') === 'college https://college.instructure.com 77', 'college link maps to the college API address');
  [['https://school.instructure.com.evil.example/courses/1', 'new school.instructure.com.evil.example 1'], ['https://evil.school.instructure.com/courses/1', 'new evil.school.instructure.com 1'],
    ['https://other.instructure.com/courses/1', 'new other.instructure.com 1']].forEach(([l, want]) => check(sendsTo(l) === want, 'look-alike link is never the school site (treated as a new site to check): ' + l));
  ['https://evil.example?@school.instructure.com/courses/123', 'https://evil.example#@school.instructure.com/courses/123', 'http://school.instructure.com/courses/1', 'https://me:pw@school.instructure.com/courses/1', 'https://school.instructure.com:8443/courses/1', 'https://school.instructure.com/courses/0',
    'https://school.instructure.com/users/1', 'not a link'].forEach(l => check(sendsTo(l) === 'refused', 'course link refused: ' + l));
  const clientRefused = (inst, base, what) => {
    try { canvas.client(inst, base, { token: 't', fetch: async () => { throw new Error('sent'); } }); check(false, what); }
    catch (e) { check(/^blocked/.test(e.message), what); }
  };
  clientRefused('school', 'http://school.instructure.com', 'client refuses plain http');
  clientRefused('school', 'https://me@school.instructure.com', 'client refuses an address with a login');
  clientRefused('Bad Name', 'https://school.instructure.com', 'client refuses an invalid site name');
  clientRefused('school', 'https://school.instructure.com:8443/x', 'client refuses an address with a port or path');
  const siteRefused = (site, what) => { try { canvas.checkSite('school', site); check(false, 'site refused: ' + what); } catch (e) { check(/^blocked/.test(e.message), 'site refused: ' + what); } };
  siteRefused({ base: 'https://evil.example', links: ['school.instructure.com'] }, 'API host not among its link hosts');
  siteRefused({ base: 'https://school.instructure.com' }, 'no link hosts');
  siteRefused({ base: 'https://school.instructure.com', links: ['school.instructure.com', '*.school.edu'] }, 'a wildcard link host');
  siteRefused({ base: 'https://school.instructure.com/api', links: ['school.instructure.com'] }, 'an API address with a path');

  // the installer finds the API address itself, without a token, and only accepts a Canvas API answer
  const resp = (status, headers, body) => ({ status, headers: { get: k => (headers || {})[k.toLowerCase()] || null }, text: async () => body || '' });
  const web = map => async (url, o) => { if (o.redirect !== 'manual' || (o.headers && o.headers.Authorization)) throw new Error('bad request options'); const r = map[url]; if (!r) throw new Error('unexpected ' + url); return r; };
  const UNAUTH = '{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}';
  const discovers = async (host, map) => { try { return await canvas.discoverBase(host, web(map)); } catch (e) { return 'refused'; } };
  check(await discovers('canvas.school.edu', { 'https://canvas.school.edu/api/v1/users/self': resp(302, { location: 'https://school.instructure.com/api/v1/users/self' }),
    'https://school.instructure.com/api/v1/users/self': resp(401, {}, UNAUTH) }) === 'https://school.instructure.com', 'discovery follows the front door to the API host');
  check(await discovers('school.instructure.com', { 'https://school.instructure.com/api/v1/users/self': resp(401, {}, UNAUTH) }) === 'https://school.instructure.com', 'discovery: the host itself answers');
  check(await discovers('canvas.school.edu', { 'https://canvas.school.edu/api/v1/users/self': resp(302, { location: 'http://school.instructure.com/api/v1/users/self' }) }) === 'refused', 'discovery refuses a redirect to plain http');
  check(await discovers('canvas.school.edu', { 'https://canvas.school.edu/api/v1/users/self': resp(302, { location: 'https://sso.school.edu/login' }), 'https://sso.school.edu/login': resp(200, {}, '<html>Sign in</html>') }) === 'refused', 'discovery refuses a sign-in page');
  check(await discovers('canvas.school.edu', { 'https://canvas.school.edu/api/v1/users/self': resp(302, { location: '/api/v1/users/self' }) }) === 'refused', 'discovery refuses a redirect loop');
  check(await discovers('fake.example', { 'https://fake.example/api/v1/users/self': resp(401, {}, 'nope') }) === 'refused', 'discovery refuses a 401 that is not Canvas');
  ['/api/v1/courses/1/pages/..%2Fusers', '/api/v1/courses/1/pages/%2e%2e%2fusers', '/api/v1/courses/1/pages/a%5Cb', '/api/v1/courses/1/pages/a\\b', '/api/v1/courses/1/pages/..']
    .forEach(p => { try { canvas.checkPath(p); check(false, 'encoded path blocked: ' + p); } catch (e) { check(/blocked/.test(e.message), 'encoded path blocked: ' + p); } });
  check(calls.length === before, 'still no request sent');

  // courses.json is checked whole; a bad one is refused and the one in use is kept
  const cfgPath = process.env.CANVAS_MCP_CONFIG, U = SITE;
  [[{ instances: { school: { base: 'https://evil.example', links: ['canvas.school.edu'] } }, courses: [{ instance: 'school', id: 1 }] }, 'an address that is not the site\'s'],
    [{ instances: { school: { base: 'https://school.instructure.com' } }, courses: [{ instance: 'school', id: 1 }] }, 'a site with no link hosts (a list from before v1.3)'],
    [{ instances: { school: U, other: { base: 'https://other.instructure.com', links: ['other.instructure.com', 'canvas.school.edu'] } }, courses: [] }, 'two sites sharing a link host'],
    [{ instances: { 'Bad Name': U }, courses: [] }, 'an invalid instance name'],
    [{ instances: { school: U }, courses: [{ instance: 'college', id: 1 }] }, 'a course naming no listed instance'],
    [{ instances: { school: U }, courses: [{ instance: 'school', id: '1' }] }, 'a course id that is not a number'],
    [{ instances: { school: U }, courses: [{ instance: 'school', id: 1 }, { instance: 'school', id: 1 }] }, 'the same course twice'],
    [{ instances: { school: U }, courses: [{ instance: 'school', id: 1, label: 'Test' }, { instance: 'school', id: 2, label: 'TEST' }] }, 'the same label twice'],
    [{ instances: [], courses: [] }, 'instances that are not an object'],
  ].forEach(([cfg, what]) => {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    try { server.loadConfig({ clientOpts: () => ({ fetch: fake.makeFetch(calls), token: 't' }) }); check(false, 'courses.json refused: ' + what); }
    catch (e) { check(/^(courses\.json|blocked)/.test(e.message), 'courses.json refused: ' + what); }
  });
  fs.writeFileSync(cfgPath, JSON.stringify(GOOD_CONFIG));
  check(JSON.parse(await server.callTool('list_courses', {})).length === 1, 'the good course list stays in use after refused ones');

  // fail closed: the roster vanishes while a call runs, and Canvas won't give it back
  const cacheFile = path.join(priv, 'canvas-roster.json');
  const goodCache = fs.readFileSync(cacheFile, 'utf8');
  const tryTool = async (name, args) => { try { return await server.callTool(name, args); } catch (e) { return 'ERROR ' + e.message; } };
  fake.controls.beforePage = async () => {
    fake.controls.beforePage = null; fs.unlinkSync(cacheFile); fake.controls.failUsers = true;
    await server.callTool('roster_status', { refresh: true });
  };
  let r = await tryTool('get_page', { course: 'TEST 101', page: 'jane-doe-presentation' });
  check(/^ERROR refused/.test(r) && leaks(r).length === 0, 'roster dropped while a call ran: refused, nothing sent unscrubbed');
  r = await tryTool('get_page', { course: 'TEST 101', page: 'syllabus' });
  check(/^ERROR refused: the student roster is not loaded/.test(r), 'no roster and Canvas failing: text tools refuse');

  // a course whose students were last read 3 days ago is refused; a failing sync isn't retried on every call
  const stale = JSON.parse(goodCache);
  stale.synced_at = new Date().toISOString(); stale.course_synced = { 'school:1': new Date(Date.now() - 72 * 3600e3).toISOString() };
  fs.writeFileSync(cacheFile, JSON.stringify(stale));
  const usersCalls = () => calls.filter(c => /\/courses\/1\/users\?/.test(c.url)).length;
  const u0 = usersCalls();
  r = await tryTool('list_pages', { course: 'TEST 101' });
  check(/^ERROR refused: the students of TEST 101 have not been read from Canvas for 72 hours/.test(r), 'course roster 72 hours old: refused');
  await tryTool('list_pages', { course: 'TEST 101' });
  check(usersCalls() === u0, 'a failed sync is not retried on every call');
  const st2 = JSON.parse(await server.callTool('roster_status', {}));
  check(st2.loaded && /roster sync failed for TEST 101/.test(st2.problem) && leaks(JSON.stringify(st2)).length === 0, 'roster_status names the failing course, counts only');
  fake.controls.failUsers = false;
  await server.callTool('roster_status', { refresh: true });
  r = await tryTool('list_pages', { course: 'TEST 101' });
  check(!/^ERROR/.test(r) && leaks(r).length === 0, 'after a good sync the course is served again, scrubbed');
  check(JSON.parse(fs.readFileSync(path.join(priv, 'student-codes.json')))['jdoe@school.edu'] === 'S-JANE', 'student codes unchanged by the failed and repeated syncs');

  // the limit is 24 hours, and a time in the future never counts as fresh
  // (just after a sync, so the retry wait keeps the server from re-reading Canvas)
  const restamp = iso => { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); c.synced_at = new Date().toISOString(); c.course_synced = { 'school:1': iso }; fs.writeFileSync(cacheFile, JSON.stringify(c)); };
  restamp(new Date(Date.now() - 30 * 3600e3).toISOString());
  r = await tryTool('list_pages', { course: 'TEST 101' });
  check(/^ERROR refused: the students of TEST 101 have not been read from Canvas for 30 hours/.test(r), 'course roster 30 hours old: refused (limit is 24)');
  restamp(new Date(Date.now() + 30 * 24 * 3600e3).toISOString());
  r = await tryTool('list_pages', { course: 'TEST 101' });
  check(/^ERROR refused: the students of TEST 101 have not been read from Canvas yet/.test(r), 'roster stamped in the future: treated as never read');
  await server.callTool('roster_status', { refresh: true });
  r = await tryTool('list_pages', { course: 'TEST 101' });
  check(!/^ERROR/.test(r), 'a real sync replaces the future stamp');

  // roster files: written whole through a private temp file
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-write-')), wfile = path.join(wdir, 'x.json');
  rosterLib.writeAtomic(wfile, '{"a":1}'); rosterLib.writeAtomic(wfile, '{"a":2}');
  check(fs.readFileSync(wfile, 'utf8') === '{"a":2}' && (fs.statSync(wfile).mode & 0o777) === 0o600 && fs.readdirSync(wdir).length === 1, 'roster files: replaced whole, private (0600), no temp files left');
  check((fs.statSync(path.join(priv, 'student-codes.json')).mode & 0o777) === 0o600 && (fs.statSync(cacheFile).mode & 0o777) === 0o600, 'codes file and roster cache are private (0600)');

  // Claude app settings: never clobbered, and only our own "canvas" entry is touched
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cfg-')), cfile = path.join(cdir, 'claude_desktop_config.json'), LIBD = '/usr/local/lib/canvas-mcp';
  const threw = fn => { try { fn(); return false; } catch (e) { return true; } };
  fs.writeFileSync(cfile, '{ "mcpServers": { "zotero": {} },, }');
  check(threw(() => claudeConfig.check(cfile, LIBD)) && threw(() => claudeConfig.add(cfile, LIBD, '/opt/node')) && threw(() => claudeConfig.remove(cfile, LIBD)) &&
    fs.readFileSync(cfile, 'utf8') === '{ "mcpServers": { "zotero": {} },, }', 'settings that are not valid JSON are left exactly as they are');
  fs.writeFileSync(cfile, JSON.stringify({ theme: 'dark', mcpServers: { canvas: { command: 'npx', args: ['some-other-canvas-mcp'] } } }));
  const other = fs.readFileSync(cfile, 'utf8');
  check(threw(() => claudeConfig.check(cfile, LIBD)) && threw(() => claudeConfig.add(cfile, LIBD, '/opt/node')) && /left as it is/.test(claudeConfig.remove(cfile, LIBD)) &&
    fs.readFileSync(cfile, 'utf8') === other, 'a different server named "canvas" is never replaced or removed');
  fs.writeFileSync(cfile, JSON.stringify({ theme: 'dark', mcpServers: { zotero: { command: 'z' }, canvas: { command: '/old/node', args: [LIBD + '/server.js'] } } }));
  claudeConfig.add(cfile, LIBD, '/opt/node');
  let s = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  check(s.theme === 'dark' && s.mcpServers.zotero && s.mcpServers.canvas.command === '/opt/node' && s.mcpServers.canvas.args[0] === LIBD + '/server.js', 'reinstall updates its own entry and keeps everything else');
  check(/Removed/.test(claudeConfig.remove(cfile, LIBD)), 'uninstall removes its own entry');
  s = JSON.parse(fs.readFileSync(cfile, 'utf8'));
  check(!('canvas' in s.mcpServers) && s.mcpServers.zotero && s.theme === 'dark' && fs.readdirSync(cdir).length === 1, '... and nothing else, with no temp files left');

  // the scripts: syntax, and the course-link check install.command runs
  const run = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, out: String(e.stderr || '') }; } };
  check(run('bash', ['-n', path.join(__dirname, '..', 'install.command')]).ok && run('bash', ['-n', path.join(__dirname, '..', 'uninstall.command')]).ok, 'install and uninstall scripts parse');
  const canvasJs = path.join(__dirname, '..', 'canvas.js');
  const sitesFile = path.join(tmp, 'sites.json'); fs.writeFileSync(sitesFile, JSON.stringify({ school: SITE }));
  check(run(process.execPath, [canvasJs, 'course-link', 'https://canvas.school.edu/courses/12345', sitesFile]).out === 'known\tschool\thttps://school.instructure.com\t12345\n', 'installer course-link: a link on a site already set up');
  check(run(process.execPath, [canvasJs, 'course-link', 'https://canvas.other.edu/courses/5', sitesFile]).out === 'new\tcanvas.other.edu\t5\n', 'installer course-link: a link on a new site');
  const evil = run(process.execPath, [canvasJs, 'course-link', 'https://me:pw@school.instructure.com/courses/123', sitesFile]);
  check(!evil.ok && /not a Canvas course link/.test(evil.out), 'installer course-link: a link with a login is refused');
  const addSite = (...a) => run(process.execPath, [canvasJs, 'add-site', sitesFile, ...a]);
  check(addSite('college', 'https://college.instructure.com', 'canvas.college.edu').ok && JSON.parse(fs.readFileSync(sitesFile, 'utf8')).college.links.join() === 'college.instructure.com,canvas.college.edu', 'installer add-site saves a checked site');
  check(!addSite('school', 'https://x.instructure.com', 'x.instructure.com').ok, 'installer add-site refuses a name already used');
  check(!addSite('again', 'https://school.instructure.com', 'canvas.school.edu').ok, 'installer add-site refuses a Canvas already set up');
  check(!addSite('Bad Name', 'https://y.instructure.com', 'y.instructure.com').ok && !addSite('y', 'https://y.instructure.com:444', 'y.instructure.com').ok, 'installer add-site refuses bad names and addresses');

  // ---- final check (2026-10-25): gaps found after the Claude Code and Codex rounds ----
  const Rf = scrub.compile([
    { code: 'S-WILL', email: 'wlong@school.edu', login: 'wlong', names: ['Will Long', 'Long, Will'], prefs: [] },
    { code: 'S-MARY', email: 'mko@school.edu', login: 'mko1', names: ['Mary-Kate Olsen', 'Olsen, Mary-Kate'], prefs: [] },
    { code: 'S-MARK', email: 'msm@school.edu', login: 'msm2', names: ['Mark Smith Jr.', 'Smith Jr., Mark', 'Mark Smith (he/him)'], prefs: [] },
    { code: 'S-LIWU', email: 'lwu@school.edu', login: 'lwu9', names: ['Li Wu', 'Wu, Li'], prefs: [] },
    { code: 'S-HEAN', email: 'han@school.edu', login: 'han3', names: ['Bo He', 'He, Bo'], prefs: [] },
  ]);
  const fc = x => scrub.scrubText(Rf, x), fl2 = x => scrub.scrubLabel(Rf, x);
  check(fc('Contact will.long@gmail.com') === 'Contact {{name:S-WILL}}@gmail.com', 'everyday-word names joined by a dot (will.long@...) are scrubbed');
  check(fc('see ?q=jane+doe').indexOf('+') >= 0 && fc('Will+Long') === '{{name:S-WILL}}', 'names joined by + are scrubbed as one name');
  check(scrub.residue(Rf, 'mail will.long@gmail.com') === 'S-WILL' && scrub.residue(Rf, 'will+long') === 'S-WILL', 'backstop also catches first.last and first+last');
  check(fc('Mary Olsen said') === '{{name:S-MARY}} said' && fc('Kate Olsen') === '{{name:S-MARY}}' && fc('Mary said') === '{{name:S-MARY}} said', 'each part of a hyphenated first name counts');
  check(fc('Jr. scholars, (he/him) pronouns') === 'Jr. scholars, (he/him) pronouns', 'a suffix or pronouns in a display name never become a "name"');
  check(fc('Mark Smith presented') === '{{name:S-MARK}} presented' && fc('Smith, Mark') === '{{name:S-MARK}}', 'a student whose name has Jr. or pronouns is still matched');
  check(fc('Li said hi. Wu agreed.') === '{{name:S-LIWU}} said hi. {{name:S-LIWU}} agreed.' && fc('Thanks, Will. Long readings follow.') === 'Thanks, {{name:S-WILL}}. {{name:S-WILL}} readings follow.', 'two-letter names (Li, Wu) are scrubbed when capitalised; the dot rule never joins words across a sentence break');
  check(fc('li said it') === 'li said it' && fl2('li-week-5') === '{{name:S-LIWU}}-week-5', 'two-letter names: lower case left in text, scrubbed in slugs');
  check(fc('He said it. An example.') === 'He said it. An example.' && fc('Bo He presented') === '{{name:S-HEAN}} presented', 'two-letter English words (He, An) are never single-name matches; full names still are');
  check(scrub.scrubText(server._state().R, 'Ｊａｎｅ Ｄｏｅ') !== 'Ｊａｎｅ Ｄｏｅ', 'full-width letters are folded (NFKD)');
  const cp = p => { try { canvas.checkPath(p); return 'allowed'; } catch (e) { return 'blocked'; } };
  check(cp('/api/v1/courses/1/pages/x%00') === 'blocked' && cp('/api/v1/courses/1/pages/%C0%AE%C0%AE') === 'blocked' && cp('/api/v1/courses/1/pages/week-5%C3%A9') === 'allowed',
    'paths with control characters or overlong UTF-8 are blocked; ordinary %-encoded slugs pass');
  const htmlApi = canvas.client('school', 'https://school.instructure.com', { token: 't', fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse('Jane Doe <html>') }) });
  try { await htmlApi.get('/api/v1/courses/1/pages/x'); check(false, 'non-JSON reply refused'); }
  catch (e) { check(e.message === 'Canvas sent a reply that is not JSON (200)', 'a non-JSON reply is reported without any of its text'); }

  // ---- v1.2.2: names in parentheses, own two-letter names, word-bounded backstop forms ----
  const Rp = scrub.compile([
    { code: 'S-K7Q2', names: ['Xiaoming (Sam) Li'], prefs: [] },
    { code: 'S-MAID', names: ['Doe (Smith), Jane'], prefs: [] },
    { code: 'S-ROEP', names: ['Ann Roe (née Pike)'], prefs: [] },
    { code: 'S-ALEX', names: ['Alex Kim (they/them)', 'Kim, Alex [any pronouns]'], prefs: [] },
  ]);
  const pt = x => scrub.scrubText(Rp, x);
  const sam = pt('Xiaoming (Sam) Li presented');
  check(!/xiaoming|sam|\bli\b/i.test(sam) && /presented$/.test(sam), 'a name in parentheses is scrubbed with the rest of the display name');
  check(pt('Thanks to Sam') === 'Thanks to {{name:S-K7Q2}}' && pt('Sam Li said') === '{{name:S-K7Q2}} said', 'a name in parentheses counts alone and with the surname');
  check(pt('Jane Smith said; Smith agreed') === '{{name:S-MAID}} said; {{name:S-MAID}} agreed', 'a former surname in parentheses counts');
  check(pt('Ann Pike, née Roe') === '{{name:S-ROEP}}, née {{name:S-ROEP}}', 'filler like "née" is not a name; the name after it is');
  check(pt('they said; any pronouns welcome (they/them)') === 'they said; any pronouns welcome (they/them)' && pt('Alex Kim (they/them)') === '{{name:S-ALEX}} (they/them)',
    'pronouns in parentheses or brackets are never names');
  check(scrub.residue(Rp, 'note: sam li said') === 'S-K7Q2' && scrub.residue(Rp, 'jane smith') === 'S-MAID' && scrub.residue(Rp, 'tea from assam lions') === null,
    'backstop: names from parentheses, word-bounded');
  const R2 = scrub.compile([{ code: 'S-AITA', names: ['Ai Tanaka'], prefs: [] }, { code: 'S-YIMA', names: ['Yi Ma'], prefs: [] },
    { code: 'S-EDWA', names: ['Edward Brooks'], prefs: [] }, { code: 'S-ALBE', names: ['Albert Lin'], prefs: [] }]);
  check(scrub.scrubText(R2, 'AI policy; MA thesis; the LI tag') === 'AI policy; MA thesis; the LI tag', 'two-letter names: all-caps forms (AI, MA) are left in page text');
  check(scrub.scrubText(R2, 'Ai said; Ma agreed') === '{{name:S-AITA}} said; {{name:S-YIMA}} agreed', '... and written as a name they are still scrubbed');
  check(scrub.scrubLabel(R2, 'Textbook, 2nd ed.') === 'Textbook, 2nd ed.' && scrub.scrubLabel(R2, 'Smith et al 2020.pdf') === 'Smith et al 2020.pdf' &&
    scrub.scrubText(R2, 'Ed said') === 'Ed said', 'two-letter nicknames (ed, al) are not names on their own');
  check(scrub.scrubText(R2, 'Ed Brooks and Al Lin') === '{{name:S-EDWA}} and {{name:S-ALBE}}', '... but nickname + surname still is');
  const R3 = scrub.compile([{ code: 'S-EDMU', names: ['Edmund Price'], prefs: ['Ed'] }]);
  check(scrub.scrubText(R3, 'Ed said') === '{{name:S-EDMU}} said', 'a two-letter preferred name of the student\'s own still counts');
  const Rw = scrub.compile([{ code: 'S-WILL', names: ['Will Long'], prefs: [] }]);
  check(scrub.residue(Rw, JSON.stringify({ file: 'data/swill.longitude.csv' })) === null && scrub.residue(Rw, 'swill+longs') === null,
    'backstop: first.last and first+last need word boundaries');
  check(scrub.residue(Rw, 'mail will.long@gmail.com') === 'S-WILL' && scrub.residue(Rw, 'q=will+long&x') === 'S-WILL', '... and still catch the real ones');

  // ---- v1.2.3: names with an apostrophe or hyphen, written without it or with a space ----
  const Rv = scrub.compile([
    { code: 'S-OBRN', names: ["Siobhan O'Brien"], prefs: [] }, { code: 'S-DANG', names: ['Marco D’Angelo'], prefs: [] },
    { code: 'S-MKOL', names: ['Mary-Kate Olsen'], prefs: [] }, { code: 'S-JIWO', names: ['Kim Ji-woo'], prefs: [] },
    { code: 'S-OKSM', names: ['Robert Okonkwo-Smith'], prefs: [] },
  ]);
  const vt = x => scrub.scrubText(Rv, x), vl = x => scrub.scrubLabel(Rv, x);
  check(vl('siobhan-obrien-notes') === '{{name:S-OBRN}}-notes' && vl('marco-dangelo-reflection') === '{{name:S-DANG}}-reflection', 'apostrophe names in slugs, apostrophe dropped (obrien, dangelo)');
  check(vt('Thanks to Siobhan OBrien.') === 'Thanks to {{name:S-OBRN}}.' && vt('Obrien and Dangelo') === '{{name:S-OBRN}} and {{name:S-DANG}}', '... and in text, full or alone');
  check(vt('Siobhan O Brien') === '{{name:S-OBRN}}' && vl('siobhan-o-brien') === '{{name:S-OBRN}}', 'apostrophe written as a space or hyphen');
  check(vt('MaryKate and Marykate') === '{{name:S-MKOL}} and {{name:S-MKOL}}' && vt('Jiwoo Kim') === '{{name:S-JIWO}}' && vt('Okonkwosmith') === '{{name:S-OKSM}}', 'hyphenated names written joined (MaryKate, Jiwoo, Okonkwosmith)');
  check(vl('jiwoo-kim') === '{{name:S-JIWO}}' && vt('Mary Kate Olsen') === '{{name:S-MKOL}}', '... in slugs, and with a space');
  check(['siobhan obrien', 'OBrien, Siobhan', 'siobhan-o-brien', 'marykate olsen', 'Olsen, MaryKate', 'jiwoo kim', 'kim-jiwoo'].every(x => scrub.residue(Rv, x) !== null), 'backstop catches the joined and apostrophe-less full names');
  check(vt('Read the O-ring report; a well-known example.') === 'Read the O-ring report; a well-known example.', 'ordinary hyphenated words are left alone');
  check(scrub.residue(R0, 'jose-de-la-cruz-essay') !== null, 'backstop: slugs of surnames with several parts');
  // ---- v1.2.4: a surname with an apostrophe, alone, written with a space or hyphen ----
  check(vt('Ask O Brien.') === 'Ask {{name:S-OBRN}}.' && vt('see o-brien') === 'see {{name:S-OBRN}}' && vt('D Angelo agreed') === '{{name:S-DANG}} agreed', 'apostrophe surname alone, with a space or hyphen, in text');
  check(vl('o-brien-essay.pdf') === '{{name:S-OBRN}}-essay.pdf' && vl('o_brien_notes') === '{{name:S-OBRN}}_notes' && vl('d-angelo') === '{{name:S-DANG}}', '... and in file names and slugs');
  check(vt('Read the O-ring report; a well-known example; the brief is due.') === 'Read the O-ring report; a well-known example; the brief is due.', '... ordinary words still left alone');

  // ---- v1.2.3: the token is read from the Keychain on first use, once, with a pause after a refusal ----
  let reads = 0, answer = 'tok-1';
  const kapi = canvas.client('school', 'https://school.instructure.com', { fetch: fake.makeFetch(calls), keychainRetryMs: 50,
    readToken: async (inst, service) => { reads++; return inst === 'school' && service === 'canvas-mcp' ? answer : null; } });
  check(reads === 0, 'creating the client does not touch the Keychain (no prompt at server start)');
  await refused(() => kapi.get('/api/v1/courses/1/assignments/501/submissions'), 'blocked path refused before any Keychain read');
  check(reads === 0, '... and without a Keychain prompt');
  await Promise.all([kapi.get('/api/v1/courses/1'), kapi.get('/api/v1/courses/1/settings'), kapi.getAll('/api/v1/courses/1/pages')]);
  check(reads === 1, 'three calls at once: one Keychain read');
  await kapi.get('/api/v1/courses/1'); check(reads === 1, 'later calls reuse the token');
  answer = null; reads = 0;
  const dapi = canvas.client('school', 'https://school.instructure.com', { fetch: fake.makeFetch(calls), keychainRetryMs: 50,
    readToken: async () => { reads++; return answer; } });
  let msg = ''; try { await dapi.get('/api/v1/courses/1'); } catch (e) { msg = e.message; }
  check(/did not allow access on the Mac/.test(msg), 'denied or unanswered prompt: the error says so');
  try { await dapi.get('/api/v1/courses/1'); } catch (e) { /* expected */ }
  check(reads === 1, 'right after a refusal the server does not ask again');
  await new Promise(r => setTimeout(r, 60)); answer = 'tok-2';
  check(await dapi.tokenReady() && reads === 2, 'after the pause it asks again, and a yes is used');
  const inst = fs.readFileSync(path.join(__dirname, '..', 'install.command'), 'utf8');
  check(/security add-generic-password [^\n]*-T "" -w/.test(inst) && !/add-generic-password[^\n]*-A/.test(inst), 'installer stores tokens with no trusted apps (-T ""), never -A');

  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED'));
  if (process.argv.includes('--show')) console.log(outputs['get_page{"course":"TEST 101","page":"group-3"}'] + '\n' + outputs['list_files{"course":"TEST 101"}']);
  process.exit(fails ? 1 : 0);
})();
