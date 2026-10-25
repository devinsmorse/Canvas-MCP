'use strict';
// node test/run-tests.js — every check prints PASS/FAIL; exit code 1 on any failure.
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
const priv = path.join(tmp, 'private'); fs.mkdirSync(priv);
// pre-existing bridge state: Jane already has a code from mail; roster.csv adds a nickname for José
fs.writeFileSync(path.join(priv, 'student-codes.json'), JSON.stringify({ 'jdoe@unc.edu': 'S-JANE' }));
fs.writeFileSync(path.join(priv, 'roster.csv'), 'name,email,course,preferred\n"de la Cruz, José",jcruz@elon.edu,PHIL 143,Pepito\n');
const GOOD_CONFIG = { instances: { unc: { base: 'https://uncch.instructure.com' } }, courses: [{ instance: 'unc', id: 1, label: 'PHIL 143' }] };
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
  check(codes['jdoe@unc.edu'] === 'S-JANE', 'existing bridge code kept for Jane');
  check(/^S-[A-Z2-9]{4}$/.test(codes['rokonkwo@unc.edu']) && /^S-[A-Z2-9]{4}$/.test(codes['jcruz@elon.edu']), 'new students get bridge-format codes, keyed by email');
  check(leaks(JSON.stringify(st)).length === 0, 'roster_status shows counts only');

  // every tool, scanned for every planted identifier
  const runs = [
    ['list_courses', {}], ['list_pages', { course: 'PHIL 143' }], ['get_page', { course: 'PHIL 143', page: 'syllabus' }], ['get_page', { course: 'PHIL 143', page: 'jane-doe-presentation' }],
    ['get_page', { course: 'PHIL 143', page: 'group-3' }], ['get_page', { course: 'PHIL 143', page: 'week-5-notes' }], ['get_page', { course: 'PHIL 143', page: 'hidden-resources' }],
    ['page_visibility', { course: 'PHIL 143' }], ['list_modules', { course: '1' }], ['list_assignments', { course: 'PHIL 143' }],
    ['get_assignment', { course: 'PHIL 143', assignment_id: 501 }], ['list_assignment_groups', { course: 'PHIL 143' }],
    ['get_course_settings', { course: 'PHIL 143' }], ['list_files', { course: 'PHIL 143' }],
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
    'Jos&eacute; de la Cruz', 'Jos&#233; de la Cruz', 'Siobhan O&rsquo;Brien', '<a href="/files/jane%20doe.pdf">', 'Jos%C3%A9 de la Cruz', 'jdoe&#64;unc.edu', 'Ja­ne Doe', 'Ja​ne Doe', 'See {{note:Robert}} later'];
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
  check(scrub.scrubText(R0, 'mailto:jdoe&#64;unc.edu') === 'mailto:{{email:S-JANE}}', 'entity-encoded email becomes the email tag');
  check(scrub.scrubText(R0, 'Ask &Eacute;mile or Jane') === 'Ask &Eacute;mile or {{name:S-JANE}}', 'entities that are not names are left as they are');
  check(scrub.residue(R0, 'Jos&eacute; de la Cruz') !== null && scrub.residue(R0, 'jane%20doe') !== null, 'backstop sees through entities and %-encoding');
  check(scrub.scrubText(R0, 'Already {{name:S-JANE}} here') === 'Already {{name:S-JANE}} here', 'existing tags are left alone');

  // visibility logic
  const vis = JSON.parse(outputs['page_visibility{"course":"PHIL 143"}']);
  const v = slugPart => vis.find(x => x.url.indexOf(slugPart) >= 0);
  check(v('syllabus').visible_to_students === true, 'front page visible');
  check(v('week-5-notes').visible_to_students === true, 'page in open module visible');
  check(v('group-3').visible_to_students === false, 'unpublished page hidden');
  check(v('hidden-resources').visible_to_students === false && /direct link/.test(v('hidden-resources').reasons[0]), 'published page outside modules with Pages tab hidden: link-only');
  const visText = outputs['page_visibility{"course":"PHIL 143"}'];
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
  check(JSON.parse(outputs['list_assignment_groups{"course":"PHIL 143"}']).groups.length === 2, 'bookmark pagination followed to the second page');
  const settings = JSON.parse(outputs['get_course_settings{"course":"PHIL 143"}']).settings;
  check(settings.allow_student_discussion_topics === true && settings.hide_final_grades === false, 'course settings keep listed keys');
  check(!('nested_example' in settings) && !('access_token' in settings) && !('student_email_addresses' in settings), 'course settings drop unlisted keys, even plain ones');

  // independent backstop withholds
  const R = server._state().R;
  check(scrub.residue(R, 'note: jane doe said') !== null, 'backstop catches a full name');
  check(scrub.residue(R, 'nothing here about anyone') === null, 'backstop quiet on clean text');

  // the client refuses anything outside the read-only list, before any request
  const before = calls.length;
  const api = canvas.client('unc', 'https://uncch.instructure.com', { fetch: fake.makeFetch(calls), token: 't' });
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
  try { await server.callTool('get_page', { course: 'PHIL 999', page: 'x' }); check(false, 'unknown course refused'); } catch (e) { check(/unknown course/.test(e.message), 'course outside the allowlist refused'); }

  // a token can only go to a known Canvas site, at exactly its address
  const sendsTo = link => { try { const c = canvas.parseCourseUrl(link); return c.instance + ' ' + c.base + ' ' + c.id; } catch (e) { return 'refused'; } };
  check(sendsTo('https://canvas.unc.edu/courses/12345') === 'unc https://uncch.instructure.com 12345', 'UNC link from the browser maps to the UNC API address');
  check(sendsTo('https://uncch.instructure.com/courses/12345/modules?x=1') === 'unc https://uncch.instructure.com 12345', 'link to a page inside a course is accepted');
  check(sendsTo('https://canvas.elon.edu/courses/77') === 'elon https://elon.instructure.com 77', 'Elon link maps to the Elon API address');
  ['https://evil.example?@uncch.instructure.com/courses/123', 'https://evil.example#@uncch.instructure.com/courses/123', 'https://uncch.instructure.com.evil.example/courses/1',
    'https://evil.uncch.instructure.com/courses/1', 'http://uncch.instructure.com/courses/1', 'https://me:pw@uncch.instructure.com/courses/1',
    'https://uncch.instructure.com:8443/courses/1', 'https://school.instructure.com/courses/1', 'https://uncch.instructure.com/courses/0',
    'https://uncch.instructure.com/users/1', 'not a link'].forEach(l => check(sendsTo(l) === 'refused', 'course link refused: ' + l));
  const clientRefused = (inst, base, what) => {
    try { canvas.client(inst, base, { token: 't', fetch: async () => { throw new Error('sent'); } }); check(false, what); }
    catch (e) { check(/^blocked/.test(e.message), what); }
  };
  clientRefused('unc', 'https://evil.example', 'client refuses an address that is not the site\'s');
  clientRefused('unc', 'https://elon.instructure.com', 'client refuses another known site\'s address for unc');
  clientRefused('other', 'https://uncch.instructure.com', 'client refuses an unknown instance name');
  clientRefused('unc', 'https://uncch.instructure.com:8443/x', 'client refuses an address with a port or path');
  ['/api/v1/courses/1/pages/..%2Fusers', '/api/v1/courses/1/pages/%2e%2e%2fusers', '/api/v1/courses/1/pages/a%5Cb', '/api/v1/courses/1/pages/a\\b', '/api/v1/courses/1/pages/..']
    .forEach(p => { try { canvas.checkPath(p); check(false, 'encoded path blocked: ' + p); } catch (e) { check(/blocked/.test(e.message), 'encoded path blocked: ' + p); } });
  check(calls.length === before, 'still no request sent');

  // courses.json is checked whole; a bad one is refused and the one in use is kept
  const cfgPath = process.env.CANVAS_MCP_CONFIG, U = { base: 'https://uncch.instructure.com' };
  [[{ instances: { unc: { base: 'https://evil.example' } }, courses: [{ instance: 'unc', id: 1 }] }, 'an address that is not the site\'s'],
    [{ instances: { 'Bad Name': U }, courses: [] }, 'an invalid instance name'],
    [{ instances: { unc: U }, courses: [{ instance: 'elon', id: 1 }] }, 'a course naming no listed instance'],
    [{ instances: { unc: U }, courses: [{ instance: 'unc', id: '1' }] }, 'a course id that is not a number'],
    [{ instances: { unc: U }, courses: [{ instance: 'unc', id: 1 }, { instance: 'unc', id: 1 }] }, 'the same course twice'],
    [{ instances: { unc: U }, courses: [{ instance: 'unc', id: 1, label: 'Phil' }, { instance: 'unc', id: 2, label: 'PHIL' }] }, 'the same label twice'],
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
  let r = await tryTool('get_page', { course: 'PHIL 143', page: 'jane-doe-presentation' });
  check(/^ERROR refused/.test(r) && leaks(r).length === 0, 'roster dropped while a call ran: refused, nothing sent unscrubbed');
  r = await tryTool('get_page', { course: 'PHIL 143', page: 'syllabus' });
  check(/^ERROR refused: the student roster is not loaded/.test(r), 'no roster and Canvas failing: text tools refuse');

  // a course whose students were last read 3 days ago is refused; a failing sync isn't retried on every call
  const stale = JSON.parse(goodCache);
  stale.synced_at = new Date().toISOString(); stale.course_synced = { 'unc:1': new Date(Date.now() - 72 * 3600e3).toISOString() };
  fs.writeFileSync(cacheFile, JSON.stringify(stale));
  const usersCalls = () => calls.filter(c => /\/courses\/1\/users\?/.test(c.url)).length;
  const u0 = usersCalls();
  r = await tryTool('list_pages', { course: 'PHIL 143' });
  check(/^ERROR refused: the students of PHIL 143 have not been read from Canvas for 72 hours/.test(r), 'course roster 72 hours old: refused');
  await tryTool('list_pages', { course: 'PHIL 143' });
  check(usersCalls() === u0, 'a failed sync is not retried on every call');
  const st2 = JSON.parse(await server.callTool('roster_status', {}));
  check(st2.loaded && /roster sync failed for PHIL 143/.test(st2.problem) && leaks(JSON.stringify(st2)).length === 0, 'roster_status names the failing course, counts only');
  fake.controls.failUsers = false;
  await server.callTool('roster_status', { refresh: true });
  r = await tryTool('list_pages', { course: 'PHIL 143' });
  check(!/^ERROR/.test(r) && leaks(r).length === 0, 'after a good sync the course is served again, scrubbed');
  check(JSON.parse(fs.readFileSync(path.join(priv, 'student-codes.json')))['jdoe@unc.edu'] === 'S-JANE', 'student codes unchanged by the failed and repeated syncs');

  // the limit is 24 hours, and a time in the future never counts as fresh
  // (just after a sync, so the retry wait keeps the server from re-reading Canvas)
  const restamp = iso => { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); c.synced_at = new Date().toISOString(); c.course_synced = { 'unc:1': iso }; fs.writeFileSync(cacheFile, JSON.stringify(c)); };
  restamp(new Date(Date.now() - 30 * 3600e3).toISOString());
  r = await tryTool('list_pages', { course: 'PHIL 143' });
  check(/^ERROR refused: the students of PHIL 143 have not been read from Canvas for 30 hours/.test(r), 'course roster 30 hours old: refused (limit is 24)');
  restamp(new Date(Date.now() + 30 * 24 * 3600e3).toISOString());
  r = await tryTool('list_pages', { course: 'PHIL 143' });
  check(/^ERROR refused: the students of PHIL 143 have not been read from Canvas yet/.test(r), 'roster stamped in the future: treated as never read');
  await server.callTool('roster_status', { refresh: true });
  r = await tryTool('list_pages', { course: 'PHIL 143' });
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
  check(run(process.execPath, [canvasJs, 'course-link', 'https://canvas.unc.edu/courses/12345']).out === 'unc\thttps://uncch.instructure.com\t12345\n', 'installer course-link check: a UNC link');
  const evil = run(process.execPath, [canvasJs, 'course-link', 'https://evil.example?@uncch.instructure.com/courses/123']);
  check(!evil.ok && /not a course link on a known Canvas site/.test(evil.out), 'installer course-link check: the crafted link is refused');

  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED'));
  if (process.argv.includes('--show')) console.log(outputs['get_page{"course":"PHIL 143","page":"group-3"}'] + '\n' + outputs['list_files{"course":"PHIL 143"}']);
  process.exit(fails ? 1 : 0);
})();
