'use strict';
// A fake Canvas with three made-up students whose names, emails, login IDs,
// SIS IDs and user IDs are planted everywhere a real one could turn up.
const STUDENTS = [
  { id: 9001, name: 'Jane Quinn Doe', sortable_name: 'Doe, Jane Quinn', short_name: 'Janie Doe', email: 'jdoe@unc.edu', login_id: 'jdoe7', sis_user_id: '730111222' },
  { id: 9002, name: 'Robert Okonkwo-Smith', sortable_name: 'Okonkwo-Smith, Robert', short_name: 'Robert Okonkwo-Smith', email: 'rokonkwo@unc.edu', login_id: 'rokonkwo', sis_user_id: '730333444' },
  { id: 9004, name: "Siobhan O'Brien", sortable_name: "O'Brien, Siobhan", short_name: "Siobhan O'Brien", email: 'sobrien@unc.edu', login_id: 'sobrien', sis_user_id: '730777888' },
  { id: 9003, name: 'José de la Cruz', sortable_name: 'de la Cruz, José', short_name: 'Pepe de la Cruz', email: 'jcruz@elon.edu', login_id: 'jcruz3', sis_user_id: '400555666' },
];
// Every identifier that must never reach Claude, in the forms a leak would take.
const SECRETS = ['Jane Quinn Doe', 'Jane Doe', 'Janie', 'Doe, Jane', 'jane-doe', 'janedoe', 'jdoe@unc.edu', 'jdoe7', '730111222', 'users/9001',
  'Robert', 'Okonkwo', 'Bob Okonkwo', 'rokonkwo', '730333444', 'José', 'Jose', 'Cruz', 'Pepe', 'jcruz', '400555666', 'about/9003', 'Siobhan', "O'Brien", 'O’BRIEN', 'sobrien', 'accommodation'];

const page = (url, title, body, extra) => Object.assign({ page_id: Math.floor(Math.random() * 1e6), url, title, body, published: true, front_page: false,
  editing_roles: 'teachers', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  last_edited_by: { id: 9001, display_name: 'Jane Doe', avatar_image_url: 'x' } }, extra || {});

const PAGES = [
  page('syllabus', 'Syllabus', '<p>Office hours with TA Morgan Lee.</p>', { front_page: true }),
  page('jane-doe-presentation', "Jane Doe's presentation", '<p>Presenter: Doe, Jane Q. (jdoe@unc.edu, login jdoe7, PID 730111222). Profile: <a href="/courses/1/users/9001">link</a></p>'),
  page('group-3', 'Group 3', '<p>Members: Bob Okonkwo-Smith, J. de la Cruz, Janie D., and DOE JANE.</p><p>See <a href="/about/9003">Pepe</a>.</p>', { published: false }),
  page('week-5-notes', 'Week 5 notes', '<p>Thanks to Robert for the example; Jose asked about Frege.</p>'),
  page('hidden-resources', 'Hidden resources', '<p>Nothing personal here. SIOBHAN O’BRIEN wrote the guide.</p>'),
];
const MODULES = [
  { id: 1, name: 'Week 5', position: 1, published: true, unlock_at: null, require_sequential_progress: false, prerequisite_module_ids: [], items_count: 2,
    items: [{ id: 11, title: 'Week 5 notes', type: 'Page', page_url: 'week-5-notes', position: 1, indent: 0, published: true, completion_requirement: { type: 'must_view', completed: true } },
            { id: 12, title: "Jane Doe's presentation", type: 'Page', page_url: 'jane-doe-presentation', position: 2, indent: 0, published: true }] },
  { id: 2, name: 'Extensions: Okonkwo-Smith', position: 2, published: false, unlock_at: '2030-01-01T00:00:00Z', items_count: 1,
    items: [{ id: 21, title: 'Group 3', type: 'Page', page_url: 'group-3', position: 1, indent: 0, published: true }] },
];
const ASSIGNMENTS = [
  { id: 501, name: 'Paper 1', description: '<p>Rubric example from Jane Doe (used with permission).</p>', due_at: '2026-11-01T03:59:00Z', points_possible: 100,
    grading_type: 'points', submission_types: ['online_upload'], assignment_group_id: 1, published: true, unpublishable: false, post_manually: true,
    needs_grading_count: 7, submission: { score: 88, user_id: 9001 }, final_grader_id: 77, score_statistics: { mean: 80 },
    overrides: [{ title: 'Jane Doe', student_ids: [9001] }], html_url: 'https://canvas.example.edu/courses/1/assignments/501' },
];
const GROUPS = [{ id: 1, name: 'Papers', position: 1, group_weight: 60, rules: {} }, { id: 2, name: 'Participation', position: 2, group_weight: 30, rules: { drop_lowest: 1 } }];
const FILES = [
  { id: 1, display_name: 'Doe_Jane_accommodation_letter.pdf', filename: 'Doe_Jane_accommodation_letter.pdf', folder_id: 10, 'content-type': 'application/pdf', size: 1000,
    url: 'https://canvas.example.edu/files/1/download?verifier=SECRET', user: { display_name: 'Jane Doe' }, locked: false, hidden: true },
  { id: 2, display_name: 'week5-slides.pdf', filename: 'week5-slides.pdf', folder_id: 11, size: 2000, url: 'https://x/download?verifier=S2' },
];
const FOLDERS = [{ id: 10, full_name: 'course files/Students/Okonkwo-Smith R', name: 'Okonkwo-Smith R', files_count: 1 }, { id: 11, full_name: 'course files/Slides', name: 'Slides', files_count: 1 }];
const COURSE = { id: 1, name: 'PHIL 143', course_code: 'PHIL143', apply_assignment_group_weights: true, hide_final_grades: false, default_view: 'modules',
  teachers: [{ display_name: 'Devin' }], total_students: 3, enrollments: [{ user_id: 9001 }] };

function makeFetch(calls) {
  return async function fakeFetch(url, opts) {
    calls.push({ url, method: opts.method });
    const u = new URL(url), p = u.pathname.replace(/^\/api\/v1\/courses\/1/, '');
    const json = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
    if (u.pathname === '/api/v1/users/self') return json({ id: 77, name: 'Devin' });
    if (p === '/users') return json(STUDENTS);
    if (p === '/pages') return json(PAGES.map(x => Object.assign({}, x, { body: undefined })));
    if (p.startsWith('/pages/')) { const pg = PAGES.find(x => x.url === decodeURIComponent(p.slice(7))); return pg ? json(pg) : { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }; }
    if (p === '/modules') return json(MODULES);
    if (p === '/assignments') return json(ASSIGNMENTS);
    if (p.startsWith('/assignments/')) return json(ASSIGNMENTS[0]);
    if (p === '/assignment_groups') return json(GROUPS);
    if (p === '' ) return json(COURSE);
    if (p === '/settings') return json({ hide_final_grades: false, allow_student_discussion_topics: true });
    if (p === '/late_policy') return json({ late_policy: { late_submission_deduction_enabled: true, late_submission_deduction: 10 } });
    if (p === '/grading_standards') return json([]);
    if (p === '/tabs') return json([{ id: 'pages', label: 'Pages', hidden: true, position: 3 }, { id: 'people', label: 'People', position: 4 }]);
    if (p === '/files') return json(FILES);
    if (p === '/folders') return json(FOLDERS);
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
}
module.exports = { STUDENTS, SECRETS, makeFetch };
