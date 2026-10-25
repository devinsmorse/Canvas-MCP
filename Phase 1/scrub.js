'use strict';
// =====================================================================
// Canvas MCP — student de-identification
//
// Every string that leaves the server passes through scrub(). Students are
// replaced by typed tags that carry the SAME code the Mail bridge uses
// (S-XXXX, kept in ~/Library/Application Support/Claude Bridge/student-codes.json,
// keyed by lower-case email):
//
//   {{name:S-4F7K}}  {{email:S-4F7K}}  {{login:S-4F7K}}  {{sis:S-4F7K}}  {{canvas_id:S-4F7K}}
//
// Name matching is ported from the bridge (claude-bridge-master v2.4.5): full
// names in many forms, nicknames, accents ignored. Added here: URL-slug forms
// (jane-doe, jane_doe, janedoe), because Canvas builds page URLs from titles.
//
// residue() is a SECOND, independent check run on the final output. It uses
// plain substring search, not the matcher above, so a bug in one is caught by
// the other. Any hit withholds the whole response.
// =====================================================================

// ---- ported from the bridge: names, nicknames, folding ----
const PARTICLES = ['de', 'del', 'della', 'der', 'den', 'la', 'le', 'van', 'von', 'da', 'di', 'du', 'dos', 'das', 'st', 'st.', 'bin', 'ibn', 'al', 'el', 'ben', 'mac', 'ter'];
const NICKNAMES = {
  robert: ['bob', 'bobby', 'rob', 'robbie', 'bert'], william: ['will', 'bill', 'billy', 'liam', 'willie'], james: ['jim', 'jimmy', 'jamie'],
  john: ['jack', 'johnny'], jonathan: ['jon', 'jonny', 'nathan'], michael: ['mike', 'mikey', 'mick'], elizabeth: ['liz', 'beth', 'eliza', 'lizzie', 'betsy', 'libby', 'betty'],
  katherine: ['kate', 'katie', 'kathy', 'kat', 'kit'], catherine: ['cate', 'cathy', 'kate', 'katie', 'cat'], kathryn: ['kate', 'katie', 'kathy'],
  margaret: ['maggie', 'meg', 'peggy', 'greta', 'marge'], richard: ['rick', 'ricky', 'rich', 'dick'], thomas: ['tom', 'tommy'],
  christopher: ['chris', 'kit'], christina: ['chris', 'tina', 'christy'], christine: ['chris', 'tina'], matthew: ['matt'], nicholas: ['nick', 'nico'],
  alexander: ['alex', 'xander', 'sasha'], alexandra: ['alex', 'lexi', 'sasha', 'sandra'], benjamin: ['ben', 'benny', 'benji'], daniel: ['dan', 'danny'],
  david: ['dave', 'davey'], joseph: ['joe', 'joey'], samuel: ['sam', 'sammy'], samantha: ['sam', 'sammy'], anthony: ['tony'], andrew: ['andy', 'drew'],
  edward: ['ed', 'eddie', 'ted', 'ned'], patricia: ['pat', 'patty', 'trish', 'tricia'], patrick: ['pat', 'paddy'], jennifer: ['jen', 'jenny'],
  jessica: ['jess', 'jessie'], rebecca: ['becca', 'becky'], stephanie: ['steph'], victoria: ['tori', 'vicky'], olivia: ['liv', 'livvy'], abigail: ['abby'],
  gabriel: ['gabe'], gabriella: ['gabby', 'ella'], gabrielle: ['gabby', 'elle'], isabella: ['izzy', 'bella'], isabel: ['izzy', 'bel'],
  zachary: ['zach', 'zack'], nathaniel: ['nate', 'nathan'], nathan: ['nate'], jacob: ['jake'], joshua: ['josh'], timothy: ['tim', 'timmy'],
  kenneth: ['ken', 'kenny'], steven: ['steve'], stephen: ['steve'], charles: ['charlie', 'chuck', 'chas'], charlotte: ['charlie', 'lottie'],
  frederick: ['fred', 'freddie'], theodore: ['ted', 'teddy', 'theo'], susan: ['sue', 'susie'], deborah: ['deb', 'debbie'], madeline: ['maddie'],
  madison: ['maddie'], jacqueline: ['jackie'], vincent: ['vince', 'vinny'], maximilian: ['max'], maxwell: ['max'], francis: ['frank', 'frankie'],
  frances: ['fran', 'frankie'], lawrence: ['larry'], leonard: ['leo', 'len', 'lenny'], peter: ['pete'], raymond: ['ray'], ronald: ['ron', 'ronnie'],
  donald: ['don', 'donny'], gregory: ['greg'], jeffrey: ['jeff'], gerald: ['gerry', 'jerry'], jeremy: ['jerry'], harold: ['harry', 'hal'],
  henry: ['harry', 'hank'], douglas: ['doug'], phillip: ['phil'], philip: ['phil'], allison: ['ally', 'allie'], alison: ['ally', 'allie'],
  amanda: ['mandy'], cynthia: ['cindy'], dorothy: ['dot', 'dottie'], eleanor: ['ellie', 'nora'], evelyn: ['evie'], josephine: ['josie', 'jo'],
  julia: ['jules'], juliana: ['jules'], lucas: ['luke'], alfred: ['alf', 'fred'], albert: ['al', 'bert'], benedict: ['ben'], cameron: ['cam'],
  jonah: ['jo'], kimberly: ['kim'], natalie: ['nat'], natasha: ['tasha', 'nat'], penelope: ['penny'], sebastian: ['seb', 'bash'], tobias: ['toby'],
  valentina: ['val'], valerie: ['val'], veronica: ['ronnie'], wesley: ['wes'], zoe: ['zo'],
};
const NICK_TO_FORMAL = {};
Object.keys(NICKNAMES).forEach(f => NICKNAMES[f].forEach(n => { (NICK_TO_FORMAL[n] = NICK_TO_FORMAL[n] || []).push(f); }));

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lower-cases and strips accents, keeping a map from each folded character back to the original.
function fold(str) {
  const src = String(str || ''); let text = ''; const map = [];
  for (let i = 0; i < src.length; i++) {
    const d = src[i].replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2010-\u2013]/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (let k = 0; k < d.length; k++) { text += d[k]; map.push(i); }
  }
  map.push(src.length);
  return { text, map };
}
const fl = x => fold(x).text.trim();

function parseName(name) {
  let first, middles = [], lastWords;
  if (name.indexOf(',') > 0) {
    const [l, f] = name.split(',', 2).map(x => x.trim());
    const fs = (f || '').split(/\s+/).filter(Boolean); first = fs[0] || ''; middles = fs.slice(1); lastWords = l.split(/\s+/).filter(Boolean);
  } else {
    const ps = name.split(/\s+/).filter(Boolean);
    first = ps[0] || '';
    let j = ps.length - 1;
    while (j - 1 >= 1 && PARTICLES.indexOf(ps[j - 1].toLowerCase()) >= 0) j--;
    lastWords = ps.slice(j); middles = ps.slice(1, j);
  }
  return { first: fl(first), middles: middles.map(fl), lastWords: lastWords.map(fl) };
}

// Same alternatives as the bridge, plus slug forms. Separator class "[\s_-]*" lets
// "jane-doe", "jane_doe", "JaneDoe" and "Jane  Doe" all match the full-name forms.
function buildMatcher(name, prefs) {
  const n = parseName(name);
  const lastFull = n.lastWords.join(' ');
  const lasts = new Set([lastFull]);
  n.lastWords.filter(w => PARTICLES.indexOf(w) < 0).forEach(w => { lasts.add(w); w.split('-').filter(x => x.length >= 2).forEach(x => lasts.add(x)); });
  lastFull.split('-').filter(x => x.length >= 2).forEach(x => lasts.add(x));
  const firsts = new Set([n.first]);
  n.middles.filter(m => m.replace(/\./g, '').length >= 2).forEach(m => firsts.add(m.replace(/\./g, '')));
  (prefs || []).map(fl).filter(Boolean).forEach(p => firsts.add(p));
  Array.from(firsts).forEach(f => { (NICKNAMES[f] || []).forEach(x => firsts.add(x)); (NICK_TO_FORMAL[f] || []).forEach(x => firsts.add(x)); });
  const F = Array.from(firsts).filter(x => x.length >= 2).sort((a, b) => b.length - a.length).map(escRe).join('|');
  const L = Array.from(lasts).filter(x => x.length >= 2).sort((a, b) => b.length - a.length).map(x => escRe(x).replace(/ /g, '[\\s_-]+')).join('|');
  const I = escRe(n.first.charAt(0)), LI = escRe((n.lastWords.filter(w => PARTICLES.indexOf(w) < 0)[0] || lastFull).charAt(0));
  const SEP = '[\\s_-]*';
  const MID = "(?:[\\s_-]+(?:[a-z]\\.?|[a-z][a-z'-]+)){0,2}";
  const alts = [
    '(?:' + F + ')' + MID + SEP + '(?:' + L + ')',                              // Jane (Q.) Doe, jane-doe, janedoe
    '(?:' + L + ')\\s*,\\s*(?:' + F + ')(?:\\s+[a-z]\\.?(?![a-z]))?',          // Doe, Jane (Q.)
    '(?:' + L + ')' + SEP + '(?:' + F + ')',                                   // Doe Jane, doe-jane, doejane
    I + "\\.?(?:\\s?[a-z]\\.?)?\\s+(?:" + L + ')',                             // J. Doe, J Doe, J.Q. Doe
    '(?:' + L + ')\\s*,\\s*' + I + '\\.?(?:\\s?[a-z]\\.)?(?![a-z])',           // Doe, J.
    '(?:' + F + ')\\s+' + LI + '\\.',                                           // Jane D.
  ];
  const src = '(^|[^a-z])(' + alts.join('|') + ')(?=[^a-z]|$)';
  return { reG: new RegExp(src, 'g'),
           tokens: Array.from(new Set(Array.from(firsts).concat(Array.from(lasts)))).filter(x => x.length >= 3 && x.indexOf(' ') < 0) };
}

// Replaces every match of a folded-text pattern in the ORIGINAL string.
function replaceFolded(str, reG, replacement) {
  const f = fold(str), spans = [];
  reG.lastIndex = 0;
  let m;
  while ((m = reG.exec(f.text)) !== null) {
    const a = m.index + m[1].length, b = m.index + m[0].length;
    spans.push([f.map[a], f.map[b]]);
    if (m[0].length === 0) reG.lastIndex++;
  }
  let out = str;
  for (let k = spans.length - 1; k >= 0; k--) out = out.slice(0, spans[k][0]) + replacement + out.slice(spans[k][1]);
  return out;
}

// ---- the roster: one entry per student, built from Canvas enrollments + roster.csv ----
// student = { code, email, login, sis, ids: ['unc:123'], names: [..], prefs: [..] }
function compile(students) {
  const out = students.map(s => {
    const primary = s.names[0] || '';
    const m = buildMatcher(primary, (s.prefs || []).concat(s.names.slice(1).map(x => parseName(x).first)));
    // extra matchers for other name forms whose surname differs (e.g. a changed name)
    const extra = s.names.slice(1).filter(x => parseName(x).lastWords.join(' ') !== parseName(primary).lastWords.join(' ')).map(x => buildMatcher(x, s.prefs));
    return Object.assign({}, s, { matchers: [m].concat(extra), tokens: Array.from(new Set([].concat(...[m].concat(extra).map(x => x.tokens)))) });
  });
  // single-name tokens -> owner code (or [student] if shared), longest first
  const owners = {};
  out.forEach(s => s.tokens.forEach(t => { (owners[t] = owners[t] || new Set()).add(s.code); }));
  const tokens = Object.keys(owners).sort((a, b) => b.length - a.length).map(t => ({
    reG: new RegExp('(^|[^a-z])(' + escRe(t) + ')(?=[^a-z]|$)', 'g'),
    code: owners[t].size === 1 ? Array.from(owners[t])[0] : null }));
  return { students: out, tokens, loaded: out.length > 0 };
}

const tag = (type, code) => '{{' + type + ':' + code + '}}';

// Replaces folded-pattern matches, but only where keep(originalMatchText) is true.
function replaceFoldedIf(str, reG, replacement, keep) {
  const f = fold(str), spans = [];
  reG.lastIndex = 0;
  let m;
  while ((m = reG.exec(f.text)) !== null) {
    const a = f.map[m.index + m[1].length], b = f.map[m.index + m[0].length];
    if (keep(str.slice(a, b))) spans.push([a, b]);
    if (m[0].length === 0) reG.lastIndex++;
  }
  let out = str;
  for (let k = spans.length - 1; k >= 0; k--) out = out.slice(0, spans[k][0]) + replacement + out.slice(spans[k][1]);
  return out;
}

// Runs fn on the parts of a string that are not already tags.
const TAG_SPLIT = /(\{\{[a-z_]+:[^}]+\}\})/;
const outsideTags = (str, fn) => str.split(TAG_SPLIT).map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');

// Pass 1: identifiers and full names (in many forms), everywhere.
function scrubIds(R, str) {
  let out = str.replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0');   // so "Jane&nbsp;Doe" is seen as two words
  R.students.forEach(s => {
    if (s.email) out = out.replace(new RegExp(escRe(s.email), 'gi'), tag('email', s.code));
    if (s.login && s.login !== s.email && s.login.length >= 3) out = out.replace(new RegExp('(^|[^A-Za-z0-9])' + escRe(s.login) + '(?=[^A-Za-z0-9]|$)', 'gi'), (_, p) => p + tag('login', s.code));
    if (s.sis && String(s.sis).length >= 3) out = out.replace(new RegExp('(^|[^A-Za-z0-9])' + escRe(String(s.sis)) + '(?=[^A-Za-z0-9]|$)', 'g'), (_, p) => p + tag('sis', s.code));
    // Canvas user IDs only where they sit in a user URL (bare numbers are too common to replace)
    (s.userIds || []).forEach(id => {
      out = out.replace(new RegExp('(/(?:users|about)/)' + escRe(String(id)) + '(?=[^0-9]|$)', 'g'), (_, p) => p + tag('canvas_id', s.code));
    });
    s.matchers.forEach(m => { out = outsideTags(out, part => replaceFolded(part, m.reG, tag('name', s.code))); });
  });
  return out;
}

// Ordinary text (page bodies, descriptions): full names everywhere, plus a single
// first, last or preferred name when it starts with a capital letter ("Thanks to Robert").
// Lower-case words are left alone, so "you will" survives a student named Will.
// This errs toward hiding: "Robert Nozick" in a reading list becomes "{{name:S-…}} Nozick"
// when a student is called Robert.
function scrubText(R, str) {
  if (typeof str !== 'string' || !str) return str;
  const out = scrubIds(R, str);
  return outsideTags(out, part => {
    let q = part;
    R.tokens.forEach(t => { q = replaceFoldedIf(q, t.reG, tag('name', t.code || 'student'), w => /^[A-ZÀ-Þ]/.test(w)); });
    return q;
  });
}

// Short labels (titles, file names, module names, URL slugs): single names match in any case,
// because slugs are lower-case ("jane-presentation"). A label that names a student AND a
// student matter (accommodation, grade appeal, extension, ...) keeps only the tag:
// "Doe_Jane_accommodation_letter.pdf" -> "{{name:S-4F7K}} [student matter withheld]".
// Word list taken from the Mail bridge's "students" category.
const STUDENT_MATTER = [/ferpa/i, /accommodat/i, /disabilit/i, /\bars\b|accessibility (services|resources)/i, /integrity|dishonest|misconduct|plagiar|cheat/i,
  /honou?r (code|council|court)/i, /grade[\s_-]*(appeal|change|dispute)/i, /\bgrades?\b|\bgpa\b|transcript/i, /incomplete/i, /extension/i, /absen(ce|t)/i,
  /medical|doctor|illness|health|counsel/i, /\bdean\b|\bconduct\b|probation/i, /\bletter\b/i];
function scrubLabel(R, str) {
  if (typeof str !== 'string' || !str) return str;
  const out = outsideTags(scrubIds(R, str), part => {
    let q = part;
    R.tokens.forEach(t => { q = replaceFolded(q, t.reG, tag('name', t.code || 'student')); });
    return q;
  });
  const tags = out.match(/\{\{name:[^}]+\}\}/g);
  if (tags && STUDENT_MATTER.some(re => re.test(str.replace(/[_-]+/g, ' ')))) return Array.from(new Set(tags)).join(' ') + ' [student matter withheld]';
  return out;
}

const LABEL_KEYS = new Set(['title', 'name', 'url', 'page_url', 'display_name', 'filename', 'full_name', 'html_url', 'external_url', 'course_code', 'label']);

function scrubDeep(R, v, key) {
  if (typeof v === 'string') return LABEL_KEYS.has(key) ? scrubLabel(R, v) : scrubText(R, v);
  if (Array.isArray(v)) return v.map(x => scrubDeep(R, x, key));
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[scrubText(R, k)] = scrubDeep(R, v[k], k); }); return o; }
  return v;
}

// ---- independent backstop: plain substring search on the serialized output ----
function needlesFor(s) {
  const n = new Set();
  const add = x => { x = fl(x || ''); if (x.length >= 4) n.add(x); };
  add(s.email); add(s.login); if (s.sis && String(s.sis).length >= 4) add(String(s.sis));
  (s.names || []).forEach(name => {
    const p = parseName(name);
    const last = p.lastWords.join(' ');
    if (p.first && last) {
      ['', ' ', '-', '_'].forEach(sep => { add(p.first + sep + last); add(last + sep + p.first); });
      add(last + ', ' + p.first);
    }
  });
  return Array.from(n);
}
function residue(R, text) {
  const t = fl(text).replace(/\s+/g, ' ');
  for (const s of R.students) {
    for (const needle of (s._needles || (s._needles = needlesFor(s)))) {
      if (t.indexOf(needle) >= 0) return s.code;   // which student, never what matched
    }
  }
  return null;
}

module.exports = { compile, scrubText, scrubLabel, scrubDeep, residue, fold, parseName, tag };
