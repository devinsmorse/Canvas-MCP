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
// Matching sees through HTML entities (Jos&eacute;), %-encoding (jane%20doe) and
// invisible characters (soft hyphens, zero-width spaces); the output keeps them.
//
// residue() is a SECOND check run on the final output. It uses plain substring
// search for full names, emails, login and SIS IDs (word-bounded for first.last,
// first+last and names from parentheses), not the matcher above, so a bug
// in the patterns is caught by it. It shares one step with the matcher: fold(), the
// lower-casing and decoding of entities/%-codes. Any hit withholds the whole response.
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

// HTML entities that can spell part of a name: spaces, quotes, dashes, and Latin letters.
// Accented letters (&eacute;, &Ouml;, &scaron; ...) are built from ACCENT.
const ENTITY = { nbsp: '\u00a0', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  ndash: '\u2013', mdash: '\u2014', hyphen: '\u2010', shy: '\u00ad', szlig: '\u00df', aelig: '\u00e6', AElig: '\u00c6', oslash: '\u00f8', Oslash: '\u00d8', eth: '\u00f0', ETH: '\u00d0',
  thorn: '\u00fe', THORN: '\u00de', oelig: '\u0153', OElig: '\u0152' };
const ACCENT = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', ring: '\u030a', cedil: '\u0327', caron: '\u030c' };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/y;
const PCT_RE = /(?:%[0-9a-fA-F]{2}){1,4}/y;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

// One unit of source text at i: an HTML entity, a %-encoded UTF-8 character, or a plain character.
function unitAt(src, i) {
  const c = src[i];
  if (c === '&') {
    ENTITY_RE.lastIndex = i;
    const m = ENTITY_RE.exec(src);
    if (m) {
      let ch = null;
      if (m[1] || m[2]) { const n = parseInt(m[1] || m[2], m[1] ? 10 : 16); if (n > 0 && n <= 0x10ffff) ch = String.fromCodePoint(n); }
      else if (own(ENTITY, m[3])) ch = ENTITY[m[3]];
      else { const a = /^([A-Za-z])([a-z]+)$/.exec(m[3]); if (a && own(ACCENT, a[2])) ch = (a[1] + ACCENT[a[2]]).normalize('NFC'); }
      if (ch !== null) return { ch, len: m[0].length };
    }
  } else if (c === '%') {
    const b = parseInt(src.substr(i + 1, 2), 16);
    const n = isNaN(b) ? 0 : b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    PCT_RE.lastIndex = i;
    const m = n && PCT_RE.exec(src);
    if (m && m[0].length >= 3 * n) { try { return { ch: decodeURIComponent(m[0].slice(0, 3 * n)), len: 3 * n }; } catch (e) { /* not UTF-8 */ } }
  }
  return { ch: c, len: 1 };
}

// Lower-cases, strips accents and decodes units, keeping a map from each folded character back
// to the start of its unit in the original.
function fold(str) {
  const src = String(str || ''); let text = ''; const map = [];
  for (let i = 0; i < src.length;) {
    const code = src.charCodeAt(i);
    if (code < 128 && code !== 37 && code !== 38) { text += src[i].toLowerCase(); map.push(i); i++; continue; }   // plain ASCII
    const u = unitAt(src, i);
    const d = u.ch.replace(INVISIBLE, '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2010-\u2013]/g, '-').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (let k = 0; k < d.length; k++) { text += d[k]; map.push(i); }
    i += u.len;
  }
  map.push(src.length);
  return { text, map };
}
const fl = x => fold(x).text.trim();

// Display names can carry a suffix, pronouns, or another name: "Mark Smith Jr.", "Smith Jr., Mark",
// "Jane Doe (she/her)", "Xiaoming (Sam) Li", "Doe (Smith), Jane". Suffixes and pronouns are
// dropped, so "Jr." or "(she/her)" never becomes the surname and every "Jr." in course text isn't
// taken for that student. Any other word in parentheses or brackets is kept as another name for
// the student (aliases: "Sam", "Smith"), minus filler like "née" or "aka".
const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?,?$/i;
const PRONOUN_WORDS = new Set(('he him his she her hers they them their theirs themself it its ze zie zir hir xe xie xem xyr xir ' +
  'ey em eir fae faer ve ver vis any all pronouns pronoun ask use name no').split(' '));
const ALIAS_FILLER = new Set('nee born formerly former aka prefers preferred goes by or and also called known as was now'.split(' '));
function parseName(name) {
  const aliases = [];
  name = String(name || '').replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_, a, b) => {
    const words = (a !== undefined ? a : b).split(/[\s\/,;]+/).map(fl).filter(Boolean);
    if (!words.every(w => PRONOUN_WORDS.has(w))) {
      words.forEach(w => { if (/^\p{L}[\p{L}'-]+$/u.test(w) && !ALIAS_FILLER.has(w)) aliases.push(w); });
    }
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  const stripSuffix = words => { while (words.length > 1 && SUFFIX.test(words[words.length - 1])) words.pop(); return words; };
  let first, middles = [], lastWords;
  if (name.indexOf(',') > 0) {
    const [l, f] = name.split(',', 2).map(x => x.trim());
    const fs = stripSuffix((f || '').split(/\s+/).filter(Boolean)); first = fs[0] || ''; middles = fs.slice(1); lastWords = stripSuffix(l.split(/\s+/).filter(Boolean));
  } else {
    const ps = stripSuffix(name.split(/\s+/).filter(Boolean));
    first = ps[0] || '';
    let j = ps.length - 1;
    while (j - 1 >= 1 && PARTICLES.indexOf(ps[j - 1].toLowerCase()) >= 0) j--;
    lastWords = ps.slice(j); middles = ps.slice(1, j);
  }
  return { first: fl(first), middles: middles.map(fl), lastWords: lastWords.map(fl), aliases };
}

// Other ways a name with an apostrophe or hyphen gets written: without the mark
// ("OBrien", "obrien" in a URL slug; "MaryKate", "Jiwoo"), or with a space or hyphen
// in its place ("O Brien", "o-brien"; "Mary Kate"). Each spaced form is matched with
// any separator, like full names. fold() has already turned curly apostrophes into "'".
function variants(x) {
  const out = new Set([x]);
  [/'/g, /-/g, /['-]/g].forEach(re => { if (re.test(x)) { out.add(x.replace(re, '')); out.add(x.replace(re, ' ').replace(/\s+/g, ' ').trim()); } });
  return Array.from(out).filter(Boolean);
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
  n.first.split('-').filter(x => x.length >= 2).forEach(x => firsts.add(x));      // Mary-Kate -> Mary, Kate
  n.middles.filter(m => m.replace(/\./g, '').length >= 2).forEach(m => firsts.add(m.replace(/\./g, '')));
  (prefs || []).map(fl).filter(Boolean).forEach(p => firsts.add(p));
  n.aliases.forEach(a => { firsts.add(a); lasts.add(a); });                        // "(Sam)" may be a first or a former last name
  Array.from(firsts).forEach(x => variants(x).forEach(v => firsts.add(v)));        // MaryKate, Mary Kate; Jiwoo
  Array.from(lasts).forEach(x => variants(x).forEach(v => lasts.add(v)));          // OBrien, O Brien, o-brien; OkonkwoSmith
  const own = new Set(Array.from(firsts).concat(Array.from(lasts)));               // the student's own names, before nicknames
  Array.from(firsts).forEach(f => { (NICKNAMES[f] || []).forEach(x => firsts.add(x)); (NICK_TO_FORMAL[f] || []).forEach(x => firsts.add(x)); });
  const F = Array.from(firsts).filter(x => x.length >= 2).sort((a, b) => b.length - a.length).map(x => escRe(x).replace(/ /g, '[\\s_-]+')).join('|');
  const L = Array.from(lasts).filter(x => x.length >= 2).sort((a, b) => b.length - a.length).map(x => escRe(x).replace(/ /g, '[\\s_-]+')).join('|');
  const I = escRe(n.first.charAt(0)), LI = escRe((n.lastWords.filter(w => PARTICLES.indexOf(w) < 0)[0] || lastFull).charAt(0));
  const SEP = '[\\s_-]*';
  const MID = "(?:[\\s_-]+(?:[a-z]\\.?|[a-z][a-z'-]+)){0,2}";
  const alts = [
    '(?:' + F + ')' + MID + SEP + '(?:' + L + ')',                              // Jane (Q.) Doe, jane-doe, janedoe
    '(?:' + L + ')\\s*,\\s*(?:' + F + ')(?:\\s+[a-z]\\.?(?![a-z]))?',          // Doe, Jane (Q.)
    '(?:' + L + ')' + SEP + '(?:' + F + ')',                                   // Doe Jane, doe-jane, doejane
    '(?:' + F + ')\\s+' + LI + '\\.',                                           // Jane D.
    '(?:' + F + ')[.+](?:' + L + ')', '(?:' + L + ')[.+](?:' + F + ')',          // will.long@..., jane+doe (no spaces, no middle words)
  ];
  // Initials forms, kept apart so initialsKeep() can check them in the original text
  // (named groups: i = the initials, s = the surname).
  const initials = [
    '(?<i1>' + I + "\\.?(?:\\s?[a-z]\\.?)?)\\s+(?<s1>" + L + ')',             // J. Doe, J Doe, J.Q. Doe, JQ Doe
    '(?<s2>' + L + ')\\s*,\\s*(?<i2>' + I + '\\.?(?:\\s?[a-z]\\.)?)(?![a-z])', // Doe, J.
  ];
  const wrap = list => '(^|[^a-z])(' + list.join('|') + ')(?=[^a-z]|$)';
  const all = Array.from(new Set(Array.from(firsts).concat(Array.from(lasts))));   // multi-word names too ("o brien", "de la cruz")
  return { reG: new RegExp(wrap(alts), 'g'), reI: new RegExp(wrap(initials), 'gd'),
           tokens: all.filter(x => x.replace(/[\s_-]/g, '').length >= 3),
           short: all.filter(x => /^[a-z]{2}$/.test(x) && !SHORT_WORDS.has(x) && own.has(x)) };
}

// Two-letter names count alone only when they are the student's own (Li, Wu, a preferred "Ed"),
// not a nickname from NICKNAMES (ed, al, jo, zo: "2nd ed.", "et al."), and never these two-letter
// English words (a student surnamed He or An stays unscrubbed when the name stands alone; their
// full name is still scrubbed).
const SHORT_WORDS = new Set('a an am as at be by do go he hi if in is it me my no of oh ok on or ox so to up us we'.split(' ').filter(x => x.length === 2));

// The initials forms also fit ordinary words: "a long reading" for Alice Long, "or Long" for
// Olivia Long. So they only count when the initials have a dot ("J. Doe", "j.q. doe", "Doe, J."),
// or are capitals next to a capitalised surname ("J Doe", "JQ Doe", "Doe, J").
const decoded = s => { let out = ''; for (let i = 0; i < s.length;) { const u = unitAt(s, i); out += u.ch; i += u.len; } return out; };
function initialsKeep(w, t, group) {
  const ini = group('i1') !== null ? group('i1') : group('i2'), sur = group('s1') !== null ? group('s1') : group('s2');
  if (ini === null || sur === null) return true;
  const i = decoded(ini), s = decoded(sur);
  return i.indexOf('.') >= 0 || (!/\p{Ll}/u.test(i) && /(^|[^\p{L}])\p{Lu}/u.test(s));
}

// Identifier patterns, matched on folded text like the name patterns. Group 1 is the boundary
// (or URL prefix) before the identifier and is kept.
function idPatterns(s) {
  const p = [], bounded = x => new RegExp('(^|[^a-z0-9])(' + escRe(fl(x)) + ')(?=[^a-z0-9]|$)', 'g');
  if (s.email) p.push({ type: 'email', reG: new RegExp('()(' + escRe(fl(s.email)) + ')', 'g') });
  if (s.login && s.login !== s.email && s.login.length >= 3) p.push({ type: 'login', reG: bounded(s.login) });
  if (s.sis && String(s.sis).length >= 3) p.push({ type: 'sis', reG: bounded(String(s.sis)) });
  // Canvas user IDs only where they sit in a user URL (bare numbers are too common to replace)
  (s.userIds || []).forEach(id => p.push({ type: 'canvas_id', reG: new RegExp('(/(?:users|about)/)(' + escRe(String(id)) + ')(?=[^0-9]|$)', 'g') }));
  return p;
}

// ---- the roster: one entry per student, built from Canvas enrollments + roster.csv ----
// student = { code, email, login, sis, ids: ['unc:123'], names: [..], prefs: [..] }
function compile(students) {
  const out = students.map(s => {
    const primary = s.names[0] || '';
    const m = buildMatcher(primary, (s.prefs || []).concat(s.names.slice(1).map(x => parseName(x).first)));
    // extra matchers for other name forms whose surname differs (e.g. a changed name)
    const extra = s.names.slice(1).filter(x => parseName(x).lastWords.join(' ') !== parseName(primary).lastWords.join(' ')).map(x => buildMatcher(x, s.prefs));
    const matchers = [m].concat(extra);
    return Object.assign({}, s, { patterns: idPatterns(s).concat(matchers.map(x => ({ type: 'name', reG: x.reG })), matchers.map(x => ({ type: 'name', reG: x.reI, keep: initialsKeep }))),
      tokens: Array.from(new Set([].concat(...matchers.map(x => x.tokens)))), short: Array.from(new Set([].concat(...matchers.map(x => x.short)))) });
  });
  // single-name tokens -> owner code (or "student" if shared), as one pattern, longest first
  const owners = {};
  out.forEach(s => s.tokens.forEach(t => { t = tokNorm(t); (owners[t] = owners[t] || new Set()).add(s.code); }));
  const list = Object.keys(owners).sort((a, b) => b.length - a.length);
  const shortOwners = {};
  out.forEach(s => s.short.forEach(t => { (shortOwners[t] = shortOwners[t] || new Set()).add(s.code); }));
  const shortList = Object.keys(shortOwners);
  return { students: out, loaded: out.length > 0,
    tokenRe: list.length ? new RegExp('(^|[^a-z])(' + list.map(t => escRe(t).replace(/ /g, '[\\s_-]+')).join('|') + ')(?=[^a-z]|$)', 'g') : null,
    tokenCode: new Map(list.map(t => [t, owners[t].size === 1 ? Array.from(owners[t])[0] : 'student'])),
    shortRe: shortList.length ? new RegExp('(^|[^a-z])(' + shortList.join('|') + ')(?=[^a-z]|$)', 'g') : null,
    shortCode: new Map(shortList.map(t => [t, shortOwners[t].size === 1 ? Array.from(shortOwners[t])[0] : 'student'])) };
}

// Single-name tokens with several words ("o brien" from O'Brien, "de la cruz") match with any run of
// spaces, hyphens or underscores between the words, so "O Brien" and "o-brien-essay" are caught on
// their own, not only next to a first name (v1.2.4).
const tokNorm = t => t.replace(/[\s_-]+/g, ' ');
const tag = (type, code) => '{{' + type + ':' + code + '}}';

// ---- matching: each string is folded once; every pattern claims spans of the ORIGINAL string,
// earlier patterns first, and the replacements are applied in one pass at the end.
// keep(original match, folded match, group) can veto a match; group(name) is a named group's
// original text, or null (needs a regex with the 'd' flag) ----
function claim(f, str, reG, replacement, spans, keep) {
  reG.lastIndex = 0;
  let m;
  while ((m = reG.exec(f.text)) !== null) {
    if (m[0].length === 0) { reG.lastIndex++; continue; }
    const a = f.map[m.index + m[1].length], b = f.map[m.index + m[0].length];
    if (spans.some(s => a < s[1] && s[0] < b)) { reG.lastIndex = m.index + 1; continue; }   // taken: look for a later match
    const group = g => { const r = m.indices && m.indices.groups && m.indices.groups[g]; return r ? str.slice(f.map[r[0]], f.map[r[1]]) : null; };
    if (a < b && (!keep || keep(str.slice(a, b), m[2], group))) spans.push([a, b, typeof replacement === 'function' ? replacement(m[2]) : replacement]);
  }
}
function applySpans(str, spans) {
  let out = '', at = 0;
  spans.sort((x, y) => x[0] - y[0]).forEach(([a, b, r]) => { out += str.slice(at, a) + r; at = b; });
  return out + str.slice(at);
}

// Our own tags, already in the text, are left as they are. Only the exact tag format counts,
// so "{{note:Robert}}" in course content is still scrubbed.
const TAG_RE = /\{\{(?:name|email|login|sis|canvas_id):(?:S-[A-Z0-9]{4}|student)\}\}/g;
function tagSpans(str) {
  const spans = []; let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(str)) !== null) spans.push([m.index, m.index + m[0].length, m[0]]);
  return spans;
}

// Names that are also everyday English words (and nicknames from NICKNAMES that are), plus words
// used in HTML and in this server's own field names. In ordinary text these are only treated as
// a name when capitalised, so "a long reading" survives a student named Long, and "you will"
// one named Will. Anything not listed is a name in any case: "jane submitted" is scrubbed.
// Add a word here when a student's name keeps replacing an ordinary word in course text.
const EVERYDAY = new Set((
  // first names and nicknames
  'will bill rob bob jack mark frank grace hope faith joy rose iris ivy lily daisy violet holly heather olive ruby pearl ' +
  'amber crystal jade ginger sage sky river rain storm star dawn summer autumn winter april may june july august ' +
  'christian earl duke prince king queen baron major guy sandy rusty rocky buddy chance chase hunter archer art ' +
  'gene dean pat sue ray max cat kit dot rich dick chuck drew nick bash penny ally cam patty teddy joey harry hank ' +
  'don ted ken tom les val gabby sunny honey melody harmony justice liberty serenity trinity destiny ' +
  // surnames
  'mason cooper carter tanner fisher baker miller taylor turner walker porter butler cook wood woods hill hills hall ' +
  'field fields lake rivers brook brooks banks park parks stone stones rock wells ford bush rice price long short young ' +
  'little small black white brown green gray grey gold silver bell bells bishop church page lane west north south east ' +
  'love best strong wise sharp bright swift cash case marsh moss fox wolf bird crane swan finch drake hawk lamb bull ' +
  'steel ash oak birch pine reed rush beach shore land dale glen vale ridge cliff day knight paris mayo moody meek ' +
  'house rule post moon way story hart carpenter mills hood bond burns noble armstrong english french power powers ' +
  // HTML and this server's field names
  'alt link strong style span table center title image data target list class header footer section label button ' +
  'frame height width border align type name value content body head url module items rules notes reasons'
).split(/\s+/).filter(Boolean));

// Pass 1: identifiers and full names (in many forms), everywhere.
// Pass 2: single first, last or preferred names; everydayCapitalOnly applies EVERYDAY (ordinary text).
function scrubSpans(R, str, f, everydayCapitalOnly) {
  const spans = tagSpans(str);
  R.students.forEach(s => s.patterns.forEach(p => claim(f, str, p.reG, tag(p.type, s.code), spans, p.keep)));
  if (R.tokenRe) claim(f, str, R.tokenRe, t => tag('name', R.tokenCode.get(tokNorm(t)) || 'student'), spans,
    everydayCapitalOnly ? (w, t) => !EVERYDAY.has(t) || /^[A-Z\u00c0-\u00de]/.test(unitAt(w, 0).ch) : null);
  // two-letter names: in ordinary text only written as a name ("Li said", not "li" or all-caps
  // "AI policy", "MA thesis"); any case in labels and slugs
  if (R.shortRe) claim(f, str, R.shortRe, t => tag('name', R.shortCode.get(t)), spans,
    everydayCapitalOnly ? w => /^\p{Lu}\p{Ll}$/u.test(decoded(w)) : null);
  return applySpans(str, spans);
}

// Ordinary text (page bodies, descriptions): full names everywhere, plus a single first, last
// or preferred name ("Thanks to Robert", "jane submitted"). A name that is also an everyday
// word (EVERYDAY) only counts when capitalised, so "you will" survives a student named Will.
// This errs toward hiding: "Robert Nozick" in a reading list becomes "{{name:S-…}} Nozick"
// when a student is called Robert.
function scrubText(R, str) {
  if (typeof str !== 'string' || !str) return str;
  return scrubSpans(R, str, fold(str), true);
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
  const f = fold(str);
  const out = scrubSpans(R, str, f, false);
  const tags = out.match(/\{\{name:[^}]+\}\}/g);
  if (tags && STUDENT_MATTER.some(re => re.test(f.text.replace(/[_-]+/g, ' ')))) return Array.from(new Set(tags)).join(' ') + ' [student matter withheld]';
  return out;
}

const LABEL_KEYS = new Set(['title', 'name', 'module', 'url', 'page_url', 'display_name', 'filename', 'full_name', 'html_url', 'external_url', 'course_code', 'label']);

function scrubDeep(R, v, key) {
  if (typeof v === 'string') return LABEL_KEYS.has(key) ? scrubLabel(R, v) : scrubText(R, v);
  if (Array.isArray(v)) return v.map(x => scrubDeep(R, x, key));
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[scrubText(R, k)] = scrubDeep(R, v[k], k); }); return o; }
  return v;
}

// ---- independent backstop: plain substring search on the serialized output ----
// Each needle is [text, bounded]. Full names and IDs are plain substrings, as before. The forms
// added later, first.last / first+last and names from parentheses ("sam li"), only count between
// word boundaries, so "swill.longitude" isn't taken for Will Long, or "assam lions" for Sam Li.
function needlesFor(s) {
  const n = new Map();
  const add = (x, bounded) => { x = sepNorm(fl(x || '')); if (x.length >= 4 && !n.has(x)) n.set(x, !!bounded); };
  add(s.email); add(s.login); if (s.sis && String(s.sis).length >= 4) add(String(s.sis));
  (s.names || []).forEach(name => {
    const p = parseName(name);
    const last = p.lastWords.join(' ');
    const pairs = [];
    if (p.first && last) variants(p.first).forEach(f => variants(last).forEach(l => pairs.push([f, l, false])));   // also OBrien, MaryKate, Jiwoo
    p.aliases.forEach(a => { if (p.first) pairs.push([p.first, a, true]); if (last) pairs.push([a, last, true]); });
    pairs.forEach(([f, l, aliased]) => {
      ['', ' ', '-', '_'].forEach(sep => { add(f + sep + l, aliased); add(l + sep + f, aliased); });
      ['.', '+'].forEach(sep => { add(f + sep + l, true); add(l + sep + f, true); });
      add(l + ', ' + f, aliased);
    });
  });
  return Array.from(n);
}
const word = c => c !== undefined && /[a-z0-9]/.test(c);
function boundedHit(t, x) {
  for (let i = t.indexOf(x); i >= 0; i = t.indexOf(x, i + 1)) if (!word(t[i - 1]) && !word(t[i + x.length])) return true;
  return false;
}
// Text and needles both read any run of spaces, hyphens and underscores as one space, so
// "jane-doe", "jane_doe" and "jane  doe" are one needle, and slugs whose surname has several
// parts ("jose-de-la-cruz", "siobhan-o-brien") meet it too.
const sepNorm = x => x.replace(/[\s_-]+/g, ' ');
function residue(R, text) {
  const t = sepNorm(fl(text));
  for (const s of R.students) {
    for (const [needle, bounded] of (s._needles || (s._needles = needlesFor(s)))) {
      if (bounded ? boundedHit(t, needle) : t.indexOf(needle) >= 0) return s.code;   // which student, never what matched
    }
  }
  return null;
}

module.exports = { compile, scrubText, scrubLabel, scrubDeep, residue, fold, parseName, tag };
