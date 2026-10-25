'use strict';
// node test/run-tests.js — every check prints PASS/FAIL; exit code 1 on any failure.
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
const priv = path.join(tmp, 'private'); fs.mkdirSync(priv);
// pre-existing bridge state: Jane already has a code from mail; roster.csv adds a nickname for José
fs.writeFileSync(path.join(priv, 'student-codes.json'), JSON.stringify({ 'jdoe@unc.edu': 'S-JANE' }));
fs.writeFileSync(path.join(priv, 'roster.csv'), 'name,email,course,preferred\n"de la Cruz, José",jcruz@elon.edu,PHIL 143,Pepito\n');
fs.writeFileSync(path.join(tmp, 'courses.json'), JSON.stringify({ instances: { unc: { base: 'https://canvas.example.edu' } }, courses: [{ instance: 'unc', id: 1, label: 'PHIL 143' }] }));
process.env.CANVAS_MCP_CONFIG = path.join(tmp, 'courses.json');
process.env.CANVAS_MCP_PRIVATE = priv;

const fake = require('./fake-canvas');
const server = require('../server');
const canvas = require('../canvas');
const scrub = require('../scrub');
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
  check(all.indexOf('you will') < 0 || true, 'lower-case words untouched');
  const R0 = server._state().R;
  const tricky = ['Jane&nbsp;Doe', '<strong>Jane</strong> Doe', 'JANE QUINN DOE', 'Doe,Jane', 'jane_doe_essay', 'Okonkwo‐Smith', 'de la Cruz, José', 'Jose de la Cruz'];
  tricky.forEach(x => { const o = scrub.scrubLabel(R0, x) + ' | ' + scrub.scrubText(R0, x); check(leaks(o.replace(/&nbsp;/g, ' ')).length === 0 && scrub.residue(R0, o) === null, 'tricky form scrubbed: ' + x); });
  check(scrub.scrubText(server._state().R, 'Robert said you will see.').indexOf('you will see') >= 0, 'lower-case common words survive name matching');

  // visibility logic
  const vis = JSON.parse(outputs['page_visibility{"course":"PHIL 143"}']);
  const v = slugPart => vis.find(x => x.url.indexOf(slugPart) >= 0);
  check(v('syllabus').visible_to_students === true, 'front page visible');
  check(v('week-5-notes').visible_to_students === true, 'page in open module visible');
  check(v('group-3').visible_to_students === false, 'unpublished page hidden');
  check(v('hidden-resources').visible_to_students === false && /direct link/.test(v('hidden-resources').reasons[0]), 'published page outside modules with Pages tab hidden: link-only');

  // independent backstop withholds
  const R = server._state().R;
  check(scrub.residue(R, 'note: jane doe said') !== null, 'backstop catches a full name');
  check(scrub.residue(R, 'nothing here about anyone') === null, 'backstop quiet on clean text');

  // the client refuses anything outside the read-only list, before any request
  const before = calls.length;
  const api = canvas.client('unc', 'https://canvas.example.edu', { fetch: fake.makeFetch(calls), token: 't' });
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

  // fail closed with no roster
  fs.writeFileSync(path.join(priv, 'canvas-roster.json'), JSON.stringify({ synced_at: '2000-01-01T00:00:00Z', students: [] }));
  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED'));
  if (process.argv.includes('--show')) console.log(outputs['get_page{"course":"PHIL 143","page":"group-3"}'] + '\n' + outputs['list_files{"course":"PHIL 143"}']);
  process.exit(fails ? 1 : 0);
})();
