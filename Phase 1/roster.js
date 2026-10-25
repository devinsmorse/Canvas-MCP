'use strict';
// =====================================================================
// Canvas MCP — roster and student codes
//
// Codes are shared with the Mail bridge: student-codes.json maps a lower-case
// email to a random code (S-XXXX). Same file, same format, same alphabet, so a
// student is S-4F7K in mail, in Calendar events and in Canvas.
//
// Students come from two places, merged by email:
//   1. Canvas: the student enrollments of every allowlisted course, fetched by
//      this server (names, sortable/short names, email, login ID, SIS ID, user ID).
//   2. roster.csv: the bridge's hand-made roster (adds preferred names you typed).
// The merged roster is cached in canvas-roster.json in the same private folder.
// Nothing in this folder is ever sent to Claude.
//
// Writing the codes file: re-read, add only missing entries, write to a temp file
// and rename. The bridge writes the same file, so a run of both at the same moment
// could drop a just-made code; every sync re-adds this server's codes from the
// cache, which keeps a student's code stable.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function paths(privateDir) {
  return {
    dir: privateDir,
    codes: path.join(privateDir, 'student-codes.json'),
    rosterCsv: path.join(privateDir, 'roster.csv'),
    cache: path.join(privateDir, 'canvas-roster.json'),
    log: path.join(privateDir, 'canvas-mcp-log.txt'),
  };
}

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }
// The temp file has a random name and is created exclusively ('wx'), so a file or link planted at
// that path is never written through. It is private (0600) and on disk before it replaces p.
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, p);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing left behind */ }
    throw e;
  }
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const t = String(text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}

function readRosterCsv(p) {
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
  const rows = parseCsv(raw); if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const iName = head.indexOf('name'), iEmail = head.indexOf('email'), iPref = head.indexOf('preferred');
  if (iName < 0 || iEmail < 0) return [];
  return rows.slice(1).map(r => ({
    email: String(r[iEmail] || '').trim().toLowerCase(),
    name: String(r[iName] || '').trim(),
    prefs: iPref >= 0 ? String(r[iPref] || '').split(/[;\/|]/).map(x => x.trim()).filter(Boolean) : [],
  })).filter(x => x.email.indexOf('@') > 0 && x.name);
}

function newCode(used) {
  let code;
  do { code = 'S-' + Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (used.has(code));
  return code;
}

// Key for the codes file: email when Canvas shows one (matches the bridge), else a Canvas-only key.
const keyOf = s => s.email || ('canvas:' + s.ids[0]);

// Merges Canvas users + roster.csv + previous cache, assigns codes, saves both files.
// synced: { 'unc:123': ISO time } — when each course's enrollments were last read successfully.
function build(P, canvasUsers, synced) {
  const prev = readJson(P.cache, { students: [] });
  const byKey = new Map();
  const get = k => { if (!byKey.has(k)) byKey.set(k, { email: null, login: null, sis: null, ids: [], userIds: [], names: [], prefs: [], courses: [] }); return byKey.get(k); };
  const addUnique = (arr, v) => { if (v !== undefined && v !== null && v !== '' && arr.indexOf(v) < 0) arr.push(v); };

  (prev.students || []).forEach(s => { const t = get(keyOf(s)); Object.assign(t, s); });
  (canvasUsers || []).forEach(u => {
    const email = (u.email || '').trim().toLowerCase() || null;
    const id = u.instance + ':' + u.id;
    // an earlier canvas-only entry for this user moves under the email key
    if (email && byKey.has('canvas:' + id)) { const old = byKey.get('canvas:' + id); byKey.delete('canvas:' + id); const t = get(email); old.names.forEach(n => addUnique(t.names, n)); }
    const t = get(email || ('canvas:' + id));
    if (email) t.email = email;
    if (u.login_id) t.login = String(u.login_id).trim().toLowerCase();
    if (u.sis_user_id) t.sis = String(u.sis_user_id).trim();
    addUnique(t.ids, id); addUnique(t.userIds, u.id);
    addUnique(t.names, u.name); addUnique(t.names, u.sortable_name); addUnique(t.names, u.short_name);
    if (u.short_name && u.name) { const a = u.short_name.split(/\s+/)[0], b = u.name.split(/\s+/)[0]; if (a && b && a.toLowerCase() !== b.toLowerCase()) addUnique(t.prefs, a); }
    addUnique(t.courses, u.course);
  });
  readRosterCsv(P.rosterCsv).forEach(r => { const t = get(r.email); t.email = r.email; addUnique(t.names, r.name); r.prefs.forEach(p => addUnique(t.prefs, p)); });

  // codes: re-read the shared file, add only what's missing, never change an existing code
  const codes = readJson(P.codes, {});
  const used = new Set(Object.values(codes));
  let added = 0;
  for (const [k, s] of byKey) {
    if (!s.names.length) continue;
    if (!codes[k] && s.code && !used.has(s.code)) { codes[k] = s.code; used.add(s.code); added++; }   // restore a code the bridge dropped
    if (!codes[k]) { codes[k] = newCode(used); used.add(codes[k]); added++; }
    s.code = codes[k];
  }
  if (added) {
    const fresh = readJson(P.codes, {});            // merge with anything written since we read
    Object.keys(fresh).forEach(k => { if (!(k in codes)) codes[k] = fresh[k]; else if (fresh[k] !== codes[k]) { codes[k] = fresh[k]; byKey.get(k) && (byKey.get(k).code = fresh[k]); } });
    writeAtomic(P.codes, JSON.stringify(codes, null, 1));
  }
  const students = Array.from(byKey.values()).filter(s => s.names.length && s.code);
  writeAtomic(P.cache, JSON.stringify({ synced_at: new Date().toISOString(), course_synced: Object.assign({}, prev.course_synced, synced), students }, null, 1));
  return students;
}

function loadCached(P) { const c = readJson(P.cache, null); return c ? c : null; }

module.exports = { paths, build, loadCached, readJson, writeAtomic, parseCsv };
