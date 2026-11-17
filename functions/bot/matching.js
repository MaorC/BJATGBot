/**
 * Blue Jay Aviation - member matching and merging (pure functions, no network)
 *
 * Decides whether two rows of the BJA Member Database are the same person,
 * and how to combine them. Used in three places:
 *   - approving an applicant (update the person's row instead of adding one)
 *   - the admin duplicate scan
 *   - the retroactive clean-up of rows from before the bot existed
 *
 * Evidence, strongest first:
 *   telegram       same Telegram ID
 *   phone          same phone number (formatting ignored)
 *   phone_similar  phone differs by one digit, or two neighbouring digits swapped
 *   phone_partial  one number is cut short and the rest matches
 *   name           same name, also across Hebrew and English spelling
 *
 * Levels:
 *   strong    same Telegram ID, or same phone without a conflict
 *   likely    same name, and the phones are similar or one is missing
 *   possible  same name but different phones, a similar phone with a partly
 *             matching name, or a shared phone with different names
 * Only "strong" is ever acted on without a person deciding.
 */

const COL = {
    ID: 0, FIRST: 1, LAST: 2, PHONE: 3, STATUS: 4, RESIDENCY: 5, LICENSE: 6,
    TRAINING: 7, AUTHORITY: 8, RATINGS: 9, CATEGORY: 10, EMPLOYER: 11,
    AIRCRAFT: 12, PLATFORM: 13, JOIN_DATE: 14, NOTES: 15, REVIEW: 16, TG_ID: 17,
};
const WIDTH = 18;

const FIELD_LABELS = {
    [COL.PHONE]: 'Phone', [COL.STATUS]: 'Status', [COL.RESIDENCY]: 'Residency',
    [COL.LICENSE]: 'License Level', [COL.TRAINING]: 'In Training For',
    [COL.CATEGORY]: 'Flying Category', [COL.EMPLOYER]: 'Employer', [COL.AIRCRAFT]: 'Aircraft',
};

const LEVEL_RANK = { possible: 1, likely: 2, strong: 3 };

/** How each kind of evidence is described to admins (Hebrew UI). */
const MATCH_LABELS_HE = {
    telegram: 'חשבון טלגרם זהה',
    phone: 'טלפון זהה',
    phone_similar: 'טלפון כמעט זהה',
    phone_partial: 'טלפון חלקי תואם',
    name: 'שם תואם (גם בין עברית לאנגלית)',
    name_partial: 'שם תואם חלקית',
    member: 'חבר קיים',
};
const LEVEL_LABELS_HE = { strong: 'כמעט ודאי', likely: 'סביר', possible: 'לבדיקה' };

// ---------- small helpers ----------

function pad(row) {
    const r = (row || []).map(v => (v === undefined || v === null ? '' : String(v)));
    while (r.length < WIDTH) r.push('');
    return r;
}
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
const normName = (s) => str(s).toLowerCase().replace(/\s+/g, ' ');
const fullName = (row) => normName(`${row[COL.FIRST] || ''} ${row[COL.LAST] || ''}`);
const displayName = (row) => `${str(row[COL.FIRST])} ${str(row[COL.LAST])}`.trim();
const hasHebrew = (s) => /[֐-׿]/.test(s);

const splitList = (s) => str(s).split(',').map(x => x.trim()).filter(Boolean);
function unionList(...vals) {
    const out = [];
    for (const v of vals) {
        for (const item of splitList(v)) {
            if (!out.some(o => o.toLowerCase() === item.toLowerCase())) out.push(item);
        }
    }
    return out.join(', ');
}
function appendParts(...vals) {
    const out = [];
    for (const v of vals) {
        for (const part of str(v).split(';').map(x => x.trim()).filter(Boolean)) {
            if (!out.includes(part)) out.push(part);
        }
    }
    return out.join('; ');
}

/**
 * Values are written with USER_ENTERED so IDs and dates keep working in the
 * Dashboard formulas. That also means text typed by an applicant could be
 * read by Sheets as a formula ("=..."). A leading apostrophe stores it as text.
 */
function safeCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

// ---------- phones ----------

/** Digits only, no leading zeros. A cell Sheets stored as a number ("528414853.0") is handled too. */
function normalizePhone(raw) {
    let s = str(raw);
    if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
    return s.replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * The part of a number that identifies the line, without the country code.
 * Israeli numbers lose their 972 (and the stray 0 some people type after it);
 * other numbers are compared on their last 9 digits.
 */
function phoneCore(raw) {
    let d = normalizePhone(raw);
    if (d.startsWith('972')) d = d.slice(3).replace(/^0+/, '');
    return d;
}

function phonesMatch(a, b) {
    const x = phoneCore(a);
    const y = phoneCore(b);
    if (x.length < 8 || y.length < 8) return false;   // truncated / junk numbers never match exactly
    const n = Math.min(x.length, y.length, 9);
    return x.slice(-n) === y.slice(-n) && Math.abs(x.length - y.length) <= 3;
}

/** One digit different, or two neighbouring digits swapped (same length, 9+ digits). */
function phonesSimilar(a, b) {
    const x = phoneCore(a);
    const y = phoneCore(b);
    if (x.length < 9 || x.length !== y.length || x === y) return false;
    const diffs = [];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diffs.push(i);
    if (diffs.length === 1) return true;
    return diffs.length === 2 && diffs[1] === diffs[0] + 1 && x[diffs[0]] === y[diffs[1]] && x[diffs[1]] === y[diffs[0]];
}

/** One number is clearly cut short (7-8 digits) and is the end of the other. */
function phonesPartial(a, b) {
    const [s, l] = [phoneCore(a), phoneCore(b)].sort((p, q) => p.length - q.length);
    return s.length >= 7 && s.length <= 8 && l.length >= 9 && l.endsWith(s);
}

/** True when the cell holds something that looks like a full phone number. */
const phoneUsable = (raw) => phoneCore(raw).length >= 8;

/**
 * Phone as it is written to the sheet: an Israeli mobile typed locally
 * (05X-XXXXXXX), or saved without its 0 or + by an earlier version of the bot,
 * becomes +972...; an international number missing its + gets one. Always
 * stored as plain text so Sheets can't strip a "+" or a zero.
 */
function phoneCell(raw) {
    let v = str(raw);
    if (/^\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, '');
    if (!v) return '';
    const digits = v.replace(/\D/g, '');
    if (/^0?5\d{8}$/.test(digits)) v = `+972${digits.replace(/^0/, '')}`;
    else if (/^972\d{8,9}$/.test(digits) && !v.startsWith('+')) v = `+${digits}`;
    else if (/^[1-9]\d{10,13}$/.test(digits) && !/^[+0]/.test(v)) v = `+${digits}`;
    return `'${v}`;
}

// ---------- names, Hebrew and English ----------

/*
 * Each name word becomes a small set of consonant "skeletons" that ignore
 * vowels and the usual spelling choices, so Hebrew and English spellings of
 * the same name meet: חיים / Chaim / Haim -> "m" or "km", כהן / Cohen / Kohen
 * -> "kn", דוד / David -> "dd" or "dbd". Letters with two common readings
 * (ו, ח, ch/kh) produce both variants. Two words match when any skeletons are
 * equal, or differ by one letter for longer skeletons.
 */
const HEB = {
    'א': [''], 'ב': ['b'], 'ג': ['g'], 'ד': ['d'], 'ה': [''], 'ו': ['', 'b'], 'ז': ['z'],
    'ח': ['', 'k'], 'ט': ['t'], 'י': [''], 'כ': ['k'], 'ך': ['k'], 'ל': ['l'], 'מ': ['m'],
    'ם': ['m'], 'נ': ['n'], 'ן': ['n'], 'ס': ['s'], 'ע': [''], 'פ': ['p'], 'ף': ['p'],
    'צ': ['c', 'z'], 'ץ': ['c', 'z'], 'ק': ['k'], 'ר': ['r'], 'ש': ['s'], 'ת': ['t'],
};
const MAX_VARIANTS = 16;

function expand(parts) {
    let out = [''];
    for (const opts of parts) {
        const next = [];
        for (const prefix of out) for (const o of opts) next.push(prefix + o);
        out = [...new Set(next)].slice(0, MAX_VARIANTS);
    }
    return out.map(s => s.replace(/(.)\1+/g, '$1'));
}

function hebrewSkeletons(word) {
    return expand([...word].filter(ch => HEB[ch]).map(ch => HEB[ch]));
}

function englishSkeletons(word) {
    const w = word.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
    const parts = [];
    for (let i = 0; i < w.length; i++) {
        const two = w.slice(i, i + 2);
        if (two === 'ch' || two === 'kh') { parts.push(['', 'k']); i++; continue; }
        if (two === 'sh') { parts.push(['s']); i++; continue; }
        if (two === 'ph') { parts.push(['p']); i++; continue; }
        if (two === 'th') { parts.push(['t']); i++; continue; }
        if (two === 'ck') { parts.push(['k']); i++; continue; }
        if (two === 'tz' || two === 'ts') { parts.push(['c']); i++; continue; }
        const ch = w[i];
        if ('aeiouyh'.includes(ch)) continue;
        if (ch === 'v' || ch === 'w' || ch === 'b') { parts.push(['b']); continue; }
        if (ch === 'f' || ch === 'p') { parts.push(['p']); continue; }
        if (ch === 'c' || ch === 'q' || ch === 'k') { parts.push(['k']); continue; }
        if (ch === 'x') { parts.push(['ks']); continue; }
        if (ch === 'j') { parts.push(['', 'g']); continue; }   // Joseph = יוסף, Jack = ג'ק
        parts.push([ch]);
    }
    return expand(parts);
}

function wordSkeletons(word) {
    return hasHebrew(word) ? hebrewSkeletons(word) : englishSkeletons(word);
}

function editDistanceAtMostOne(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

const plain = (w) => (hasHebrew(w) ? w.replace(/[^א-ת]/g, '') : w.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, ''));

/**
 * Two name words written in the same language are compared by spelling
 * (one typo allowed for longer words). Only Hebrew against English is
 * compared by sound, through the skeletons above.
 */
function wordsMatch(a, b) {
    const pa = plain(a);
    const pb = plain(b);
    if (!pa || !pb) return false;
    if (hasHebrew(a) === hasHebrew(b)) {
        if (pa === pb) return true;
        return Math.min(pa.length, pb.length) >= 4 && editDistanceAtMostOne(pa, pb);
    }
    for (const x of wordSkeletons(a)) for (const y of wordSkeletons(b)) {
        if (!x || !y) continue;
        if (x === y) return true;
        if (Math.min(x.length, y.length) >= 4 && editDistanceAtMostOne(x, y)) return true;
    }
    return false;
}

const nameWords = (row) => `${str(row[COL.FIRST])} ${str(row[COL.LAST])}`
    .split(/[\s\-]+/).map(w => w.replace(/['"׳״`.]/g, '')).filter(w => plain(w).length >= 2);

// Small words that start many surnames ("Ben Ari", "Bar Asher", "De Leon")
const PARTICLES = new Set(['ben', 'bar', 'bat', 'bin', 'el', 'al', 'de', 'da', 'di', 'van', 'von', 'le', 'la', 'בן', 'בר', 'בת', 'דה']);

function lastNamesMatch(a, b) {
    if (!a.length || !b.length) return false;
    if (wordsMatch(a.join(''), b.join(''))) return true;
    const sig = (ws) => ws.filter(w => !PARTICLES.has(plain(w)) && plain(w).length >= 3);
    return sig(a).some(x => sig(b).some(y => wordsMatch(x, y)));
}

/**
 * 'exact'   same name, same spelling
 * 'match'   first and last name agree (any spelling, either order)
 * 'partial' only the first or only the last name agrees
 * null      no useful agreement (or a single-word name: too little to go on)
 */
function compareNames(rowA, rowB) {
    const a = nameWords(rowA);
    const b = nameWords(rowB);
    if (a.length < 2 || b.length < 2) return null;
    if (fullName(rowA) === fullName(rowB)) return 'exact';
    const firstOk = wordsMatch(a[0], b[0]);
    const lastOk = lastNamesMatch(a.slice(1), b.slice(1));
    if (firstOk && lastOk) return 'match';
    // swapped order (last name typed first)
    if (a.length === 2 && b.length === 2 && wordsMatch(a[0], b[1]) && wordsMatch(a[1], b[0])) return 'match';
    if (firstOk || lastOk) return 'partial';
    return null;
}

// ---------- comparing two rows ----------

/**
 * @returns {null | {level: 'strong'|'likely'|'possible', by: string, evidence: string[], conflict: string|null}}
 */
function compareRows(rowA, rowB) {
    const a = pad(rowA);
    const b = pad(rowB);
    const tgA = str(a[COL.TG_ID]);
    const tgB = str(b[COL.TG_ID]);
    const tgConflict = tgA && tgB && tgA !== tgB;
    const names = compareNames(a, b);
    const evidence = [];
    let phone = null;
    if (phonesMatch(a[COL.PHONE], b[COL.PHONE])) phone = 'phone';
    else if (phonesSimilar(a[COL.PHONE], b[COL.PHONE])) phone = 'phone_similar';
    else if (phonesPartial(a[COL.PHONE], b[COL.PHONE])) phone = 'phone_partial';
    const bothPhones = phoneUsable(a[COL.PHONE]) && phoneUsable(b[COL.PHONE]);

    if (tgA && tgA === tgB) {
        evidence.push('telegram');
        if (phone) evidence.push(phone);
        if (names) evidence.push('name');
        return { level: 'strong', by: 'telegram', evidence, conflict: null };
    }
    if (phone === 'phone') {
        evidence.push('phone');
        if (names) evidence.push('name');
        // A shared number with clearly different names (family, a typo) or two different
        // Telegram accounts is worth a look, but never merged without a person deciding.
        if (tgConflict) return { level: 'possible', by: 'phone', evidence, conflict: 'telegram' };
        if (!names && nameWords(a).length >= 2 && nameWords(b).length >= 2 && !compareNames(a, b)) {
            return { level: 'possible', by: 'phone', evidence, conflict: 'name' };
        }
        return { level: 'strong', by: 'phone', evidence, conflict: null };
    }
    if (names === 'exact' || names === 'match') {
        evidence.push('name');
        if (phone) evidence.push(phone);
        const conflict = tgConflict ? 'telegram' : (bothPhones && !phone ? 'phone' : null);
        return { level: conflict ? 'possible' : 'likely', by: 'name', evidence, conflict };
    }
    if (names === 'partial' && (phone === 'phone_similar' || phone === 'phone_partial')) {
        evidence.push(phone, 'name_partial');
        return { level: 'possible', by: phone, evidence, conflict: tgConflict ? 'telegram' : null };
    }
    return null;
}

/** A row worth comparing: has an ID or a name, and at least one of name / phone / Telegram ID. */
const isPersonRow = (v) => (str(v[COL.ID]) || displayName(v)) && (displayName(v) || phoneUsable(v[COL.PHONE]) || str(v[COL.TG_ID]));

/**
 * Finds the existing row for an incoming person (an applicant being approved).
 * Strong matches are acted on automatically; anything weaker goes to an admin.
 * @param {Array<{rowNumber:number, values:string[]}>} rows
 * @returns {null|{strength:'strong'|'weak', level, by, evidence, rowNumber, memberId, name}}
 */
function findMatch(rows, { telegramId, phone, name } = {}) {
    const words = str(name).split(/\s+/);
    const probe = pad([]);
    probe[COL.FIRST] = words[0] || '';
    probe[COL.LAST] = words.slice(1).join(' ');
    probe[COL.PHONE] = phone || '';
    probe[COL.TG_ID] = telegramId ? String(telegramId) : '';

    let best = null;
    for (const r of rows) {
        if (!isPersonRow(r.values)) continue;
        const c = compareRows(probe, r.values);
        if (!c) continue;
        const score = LEVEL_RANK[c.level] * 10 + (c.by === 'telegram' ? 3 : c.by === 'phone' ? 2 : 1);
        if (!best || score > best.score) best = { score, c, r };
    }
    if (!best) return null;
    const { c, r } = best;
    return {
        strength: c.level === 'strong' ? 'strong' : 'weak',
        level: c.level, by: c.by, evidence: c.evidence, conflict: c.conflict,
        rowNumber: r.rowNumber,
        memberId: r.values[COL.ID] || '',
        name: displayName(r.values),
    };
}

/**
 * Groups of rows that look like the same person, strongest first.
 * `ignorePairs`: a Set of "id1-id2" (sorted IDs) an admin already marked as different people.
 */
function findDuplicateGroups(rows, { ignorePairs = new Set(), minLevel = 'possible' } = {}) {
    const people = rows.filter(r => isPersonRow(r.values));
    const parent = new Map(people.map(r => [r.rowNumber, r.rowNumber]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    const links = [];

    for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) {
            const A = people[i], B = people[j];
            if (ignorePairs.has(pairKey(A.values[COL.ID], B.values[COL.ID]))) continue;
            const c = compareRows(A.values, B.values);
            if (!c || LEVEL_RANK[c.level] < LEVEL_RANK[minLevel]) continue;
            links.push({ a: A, b: B, ...c });
            parent.set(find(A.rowNumber), find(B.rowNumber));
        }
    }

    const groups = new Map();
    for (const l of links) {
        const root = find(l.a.rowNumber);
        if (!groups.has(root)) groups.set(root, { members: new Map(), links: [] });
        const g = groups.get(root);
        g.members.set(l.a.rowNumber, l.a);
        g.members.set(l.b.rowNumber, l.b);
        g.links.push(l);
    }

    return [...groups.values()].map(g => {
        const members = [...g.members.values()].sort((x, y) => idNum(x.values) - idNum(y.values));
        const level = g.links.reduce((m, l) => (LEVEL_RANK[l.level] > LEVEL_RANK[m] ? l.level : m), 'possible');
        const top = g.links.find(l => l.level === level);
        return {
            level,
            reason: top.by,
            evidence: [...new Set(g.links.flatMap(l => l.evidence))],
            conflicts: [...new Set(g.links.map(l => l.conflict).filter(Boolean))],
            members: members.map(m => ({
                rowNumber: m.rowNumber,
                memberId: m.values[COL.ID] || '',
                name: displayName(m.values),
                values: m.values,
            })),
        };
    }).sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || idNum(x.members[0].values) - idNum(y.members[0].values));
}

const idNum = (v) => { const n = parseInt(v[COL.ID], 10); return isNaN(n) ? Infinity : n; };
const pairKey = (x, y) => [str(x), str(y)].sort().join('-');

// ---------- merging ----------

const LICENSE_RANK = { '': 0, PPL: 1, CPL: 2, ATPL: 3 };
const APPLICATION_ONLY_FLAGS = ['דילג על פרטים נוספים', 'לא שותף מספר טלפון'];
const isVague = (v) => !str(v) || /^(unknown|other)$/i.test(str(v));

/**
 * Works out which cells of an existing member row should change when the same
 * person comes through the bot again (for example later in their career).
 * Rules: the ID / seniority, name, Employer, Aircraft and Join Date are kept;
 * career fields take the newest specific answer; a license never goes down;
 * authorities and ratings are added to, never removed; a training goal that
 * was reached is cleared; every replaced value is logged in Notes.
 * @returns {{changes: Object<number,string>, replaced: string[]}}
 */
function mergeRow(existingRow, incomingRow, today) {
    const old = pad(existingRow);
    const inc = pad(incomingRow);
    const changes = {};
    const replaced = [];

    // Name: only fill a blank, never rewrite how a member is listed
    for (const c of [COL.FIRST, COL.LAST]) {
        if (!str(old[c]) && str(inc[c])) changes[c] = inc[c];
    }

    if (phoneUsable(inc[COL.PHONE]) && !phonesMatch(old[COL.PHONE], inc[COL.PHONE])) {
        changes[COL.PHONE] = inc[COL.PHONE];
        if (str(old[COL.PHONE])) replaced.push(`${FIELD_LABELS[COL.PHONE]}: ${str(old[COL.PHONE])}`);
    }

    for (const c of [COL.STATUS, COL.RESIDENCY, COL.LICENSE, COL.TRAINING, COL.CATEGORY]) {
        const v = str(inc[c]);
        if (!v) continue;
        if (isVague(v) && !isVague(old[c])) continue;       // "other" answer: keep what we knew
        if (c === COL.LICENSE && (LICENSE_RANK[v] ?? 0) < (LICENSE_RANK[str(old[c])] ?? 0)) continue;
        if (same(old[c], v)) continue;
        changes[c] = v;
        if (!isVague(old[c])) replaced.push(`${FIELD_LABELS[c]}: ${str(old[c])}`);
    }

    for (const c of [COL.AUTHORITY, COL.RATINGS]) {
        const merged = unionList(old[c], inc[c]);
        if (merged !== splitList(old[c]).join(', ')) changes[c] = merged;
    }

    // A training goal that has since been reached is no longer "in training for".
    const goal = str(old[COL.TRAINING]);
    if (goal && !(COL.TRAINING in changes)) {
        const license = str(COL.LICENSE in changes ? changes[COL.LICENSE] : old[COL.LICENSE]);
        const ratings = splitList(COL.RATINGS in changes ? changes[COL.RATINGS] : old[COL.RATINGS]);
        if ([license, ...ratings].some(v => same(v, goal))) {
            changes[COL.TRAINING] = '';
            replaced.push(`${FIELD_LABELS[COL.TRAINING]}: ${goal}`);
        }
    }

    const platform = mergePlatform(old[COL.PLATFORM], inc[COL.PLATFORM]);
    if (platform !== str(old[COL.PLATFORM])) changes[COL.PLATFORM] = platform;

    let notes = appendParts(old[COL.NOTES], inc[COL.NOTES]);
    // The listed name is never rewritten, so keep the spelling the member used with the bot
    const given = displayName(inc);
    if (given && displayName(old) && normName(given) !== fullName(old)) notes = appendParts(notes, `Name in bot: ${given}`);
    if (replaced.length) notes = appendParts(notes, `Updated via bot ${today} (was ${replaced.join(', ')})`);
    if (notes !== str(old[COL.NOTES])) changes[COL.NOTES] = notes;

    const review = appendParts(old[COL.REVIEW], inc[COL.REVIEW]);
    if (review !== str(old[COL.REVIEW])) changes[COL.REVIEW] = review;

    if (str(inc[COL.TG_ID]) && str(old[COL.TG_ID]) !== str(inc[COL.TG_ID])) changes[COL.TG_ID] = str(inc[COL.TG_ID]);

    return { changes, replaced };
}

function mergePlatform(...vals) {
    const set = new Set();
    for (const v of vals.map(str)) {
        if (v === 'Both') { set.add('Telegram'); set.add('WhatsApp'); }
        else if (v === 'Telegram' || v === 'WhatsApp') set.add(v);
    }
    if (set.size === 2) return 'Both';
    if (set.size === 1) return [...set][0];
    return vals.map(str).find(Boolean) || '';
}

/** dd/mm/yyyy (as the sheet shows it) to a sortable number; unknown dates sort last. */
function dateValue(s) {
    const m = str(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
    const n = Number(str(s));
    if (n > 20000 && n < 80000) {   // a raw Sheets serial date
        const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
        return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    }
    return Infinity;
}

/**
 * Combines rows that belong to one person (the retroactive clean-up).
 * The row with the lowest ID is kept: it holds the member's seniority. Rows
 * are taken oldest to newest, so newer answers win for career fields.
 *   ID, name           kept from the oldest row (blanks filled; other spellings go to Notes)
 *   Phone              the newest full number; older ones go to Notes
 *   Status, Residency, Training, Category
 *                      the newest specific value
 *   License Level      the highest
 *   Authority, Ratings combined
 *   Employer, Aircraft the oldest filled value (these are kept by hand)
 *   Platform           combined (Telegram + WhatsApp = Both)
 *   Join Date          the earliest recorded (a blank on the oldest row stays blank)
 *   Notes, Needs Review combined, plus a "Merged from #.." note
 *   Telegram ID        the newest
 * @returns {{keep, remove: Array, merged: string[], changes: Object<number,string>, warnings: string[]}}
 */
function mergeGroup(groupRows, today) {
    const rows = [...groupRows].sort((x, y) => idNum(x.values) - idNum(y.values));
    const keep = rows[0];
    const others = rows.slice(1);
    const base = pad(keep.values);
    const out = [...base];
    const warnings = [];
    const history = [];

    for (const o of others) {
        const v = pad(o.values);
        for (const c of [COL.FIRST, COL.LAST]) if (!str(out[c]) && str(v[c])) out[c] = v[c];
        const otherName = displayName(v);
        if (otherName && normName(otherName) !== fullName(out)) history.push(`Also listed as: ${otherName}`);

        if (phoneUsable(v[COL.PHONE])) {
            if (str(out[COL.PHONE]) && !phonesMatch(out[COL.PHONE], v[COL.PHONE])) history.push(`Other phone: ${str(out[COL.PHONE])}`);
            if (!phonesMatch(out[COL.PHONE], v[COL.PHONE]) || !phoneUsable(out[COL.PHONE])) out[COL.PHONE] = v[COL.PHONE];
        } else if (!str(out[COL.PHONE]) && str(v[COL.PHONE])) out[COL.PHONE] = v[COL.PHONE];

        for (const c of [COL.STATUS, COL.RESIDENCY, COL.TRAINING, COL.CATEGORY]) {
            if (!isVague(v[c]) || isVague(out[c]) && str(v[c])) out[c] = v[c];
        }
        if ((LICENSE_RANK[str(v[COL.LICENSE])] ?? 0) > (LICENSE_RANK[str(out[COL.LICENSE])] ?? 0)) out[COL.LICENSE] = v[COL.LICENSE];
        for (const c of [COL.EMPLOYER, COL.AIRCRAFT]) if (!str(out[c]) && str(v[c])) out[c] = v[c];

        out[COL.AUTHORITY] = unionList(out[COL.AUTHORITY], v[COL.AUTHORITY]);
        out[COL.RATINGS] = unionList(out[COL.RATINGS], v[COL.RATINGS]);
        out[COL.PLATFORM] = mergePlatform(out[COL.PLATFORM], v[COL.PLATFORM]);
        // Join Date stays the oldest row's. If that was never recorded, a later row's date is when
        // the person applied through the bot, not when they joined, so it goes to Notes instead.
        if (str(out[COL.JOIN_DATE]) && dateValue(v[COL.JOIN_DATE]) < dateValue(out[COL.JOIN_DATE])) out[COL.JOIN_DATE] = v[COL.JOIN_DATE];
        else if (!str(base[COL.JOIN_DATE]) && str(v[COL.JOIN_DATE])) history.push(`Applied via bot: ${str(v[COL.JOIN_DATE])}`);
        out[COL.NOTES] = appendParts(out[COL.NOTES], v[COL.NOTES]);
        // Flags the bot raised about a new application ("skipped the extra details", "didn't share
        // a phone") don't apply once the person turns out to be a known member.
        out[COL.REVIEW] = appendParts(out[COL.REVIEW], str(v[COL.REVIEW]).split(';').map(x => x.trim())
            .filter(x => !APPLICATION_ONLY_FLAGS.includes(x)).join('; '));

        if (str(v[COL.TG_ID])) {
            if (str(out[COL.TG_ID]) && str(out[COL.TG_ID]) !== str(v[COL.TG_ID])) {
                warnings.push('two_telegram_accounts');
                history.push(`Other Telegram ID: ${str(out[COL.TG_ID])}`);
            }
            out[COL.TG_ID] = str(v[COL.TG_ID]);
        }
    }

    // A training goal that has been reached is no longer "in training for"
    if (str(out[COL.TRAINING]) && [out[COL.LICENSE], ...splitList(out[COL.RATINGS])].some(x => same(x, out[COL.TRAINING]))) out[COL.TRAINING] = '';

    // Review notes about the duplication itself are resolved by the merge
    const removedIds = others.map(o => str(o.values[COL.ID]));
    out[COL.REVIEW] = str(out[COL.REVIEW]).split(';').map(x => x.trim()).filter(Boolean)
        .filter(x => !removedIds.some(id => x.includes(`#${id}`)) && !/^possible duplicate/i.test(x)).join('; ');
    out[COL.NOTES] = appendParts(out[COL.NOTES], ...history, `Merged from #${removedIds.join(', #')} on ${today}`);

    const changes = {};
    for (let c = 1; c < WIDTH; c++) if (str(out[c]) !== str(base[c])) changes[c] = out[c];
    return { keep, remove: others, merged: out, changes, warnings };
}

module.exports = {
    COL, WIDTH, LEVEL_RANK, MATCH_LABELS_HE, LEVEL_LABELS_HE,
    pad, str, safeCell, displayName, fullName, normName, appendParts, unionList, splitList,
    normalizePhone, phoneCore, phonesMatch, phonesSimilar, phonesPartial, phoneUsable, phoneCell,
    wordSkeletons, wordsMatch, compareNames, compareRows,
    findMatch, findDuplicateGroups, pairKey,
    mergeRow, mergeGroup, mergePlatform,
};
