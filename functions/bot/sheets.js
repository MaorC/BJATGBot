/**
 * Blue Jay Aviation - Google Sheets integration (BJA Member Database)
 *
 * Uses a Google Cloud service account (share the spreadsheet with the
 * service account email as Editor).
 *
 * Env vars:
 *   SHEET_ID                      - spreadsheet ID
 *   SHEET_TAB                     - members tab name (default: "Members")
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  - service account email
 *   GOOGLE_PRIVATE_KEY            - service account private key (\n escaped)
 *
 * Column layout (A:R):
 * ID | First Name | Last Name | Phone | Status | Residency | License Level |
 * In Training For | License Authority | Ratings | Flying Category | Employer |
 * Aircraft | Platform Source | Join Date | Notes | Needs Review | Telegram ID
 *
 * One person = one row. Before anything is written, saveMember() looks for an
 * existing row for the same person (Telegram ID, then phone, then full name)
 * and updates that row instead of adding a second one. Updates only touch the
 * cells that actually changed, so manually maintained columns (Employer,
 * Aircraft, Join Date, the member's ID / seniority) are never overwritten.
 */

const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'Members';
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

// Column indexes (0-based) in the Members tab
const COL = {
    ID: 0, FIRST: 1, LAST: 2, PHONE: 3, STATUS: 4, RESIDENCY: 5, LICENSE: 6,
    TRAINING: 7, AUTHORITY: 8, RATINGS: 9, CATEGORY: 10, EMPLOYER: 11,
    AIRCRAFT: 12, PLATFORM: 13, JOIN_DATE: 14, NOTES: 15, REVIEW: 16, TG_ID: 17,
};
const WIDTH = 18;
const LAST_COL = 'R';
const TG_ID_HEADER = 'Telegram ID';
const FIELD_LABELS = {
    [COL.PHONE]: 'Phone', [COL.STATUS]: 'Status', [COL.RESIDENCY]: 'Residency',
    [COL.LICENSE]: 'License Level', [COL.TRAINING]: 'In Training For',
    [COL.CATEGORY]: 'Flying Category',
};

let jwtClient = null;

function getClient() {
    if (!jwtClient) {
        let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

        // Preferred: paste the entire service-account JSON file into
        // GOOGLE_SERVICE_ACCOUNT_JSON (no formatting gymnastics needed).
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            email = sa.client_email;
            key = sa.private_key;
        }

        jwtClient = new JWT({
            email,
            key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }
    return jwtClient;
}

const tabRange = (a1) => `${encodeURIComponent(SHEET_TAB)}!${a1}`;
const colLetter = (i) => String.fromCharCode(65 + i);

// ---------- Pure helpers (no network) ----------

/**
 * Digits-only phone for comparison, without leading zeros. Numbers reach the
 * sheet in many shapes (+972541234567, 054-1234567, or 541234567 when Sheets
 * stored a typed number and dropped its zero), so two phones are treated as
 * the same when one ends with the other and at least 9 digits agree.
 */
function normalizePhone(raw) {
    return String(raw === undefined || raw === null ? '' : raw).replace(/\D/g, '').replace(/^0+/, '');
}

function phonesMatch(a, b) {
    const x = normalizePhone(a);
    const y = normalizePhone(b);
    if (x.length < 9 || y.length < 9) return false;   // truncated / junk numbers never match
    return x.length >= y.length ? x.endsWith(y) : y.endsWith(x);
}

/**
 * Phone as it is written to the sheet: an Israeli mobile typed locally
 * (05X-XXXXXXX) is stored in the same +972 form as the rest of the sheet, and
 * every phone is forced to plain text so Sheets can't strip a "+" or a zero.
 */
function phoneCell(raw) {
    let v = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!v) return '';
    const digits = v.replace(/\D/g, '');
    if (/^05\d{8}$/.test(digits)) v = `+972${digits.slice(1)}`;
    return `'${v}`;
}

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const fullName = (row) => normName(`${row[COL.FIRST] || ''} ${row[COL.LAST] || ''}`);

/**
 * Values are written with USER_ENTERED so IDs and dates keep working in the
 * Dashboard formulas. That also means text typed by an applicant could be
 * read by Sheets as a formula ("=...") or a number ("+972..." loses its plus).
 * A leading apostrophe forces Sheets to store the value as plain text.
 */
function safeCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

const splitList = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
function unionList(oldVal, newVal) {
    const out = splitList(oldVal);
    for (const item of splitList(newVal)) {
        if (!out.some(o => o.toLowerCase() === item.toLowerCase())) out.push(item);
    }
    return out.join(', ');
}
function appendParts(oldVal, newVal) {
    const out = String(oldVal || '').split(';').map(x => x.trim()).filter(Boolean);
    for (const part of String(newVal || '').split(';').map(x => x.trim()).filter(Boolean)) {
        if (!out.includes(part)) out.push(part);
    }
    return out.join('; ');
}

function pad(row) {
    const r = (row || []).map(v => (v === undefined || v === null ? '' : String(v)));
    while (r.length < WIDTH) r.push('');
    return r;
}

/**
 * Finds the existing row for a person, strongest evidence first:
 *   1. Telegram ID (column R)            - strong
 *   2. phone number                      - strong (weak if the row belongs to another Telegram account)
 *   3. identical full name (2+ words)    - weak, an admin has to confirm
 * @param {Array<{rowNumber:number, values:string[]}>} rows
 * @returns {null|{strength:'strong'|'weak', by:'telegram'|'phone'|'name', rowNumber, memberId, name}}
 */
function findMatch(rows, { telegramId, phone, name } = {}) {
    const describe = (r, by, strength) => ({
        strength, by, rowNumber: r.rowNumber,
        memberId: r.values[COL.ID] || '',
        name: `${r.values[COL.FIRST] || ''} ${r.values[COL.LAST] || ''}`.trim(),
    });

    if (telegramId) {
        const hit = rows.find(r => String(r.values[COL.TG_ID] || '').trim() === String(telegramId));
        if (hit) return describe(hit, 'telegram', 'strong');
    }
    if (phone) {
        const hit = rows.find(r => phonesMatch(r.values[COL.PHONE], phone));
        if (hit) {
            // Same phone, but the row already belongs to a different Telegram account:
            // could be the same person on a new account or two people sharing a number,
            // so an admin decides instead of the bot.
            const owner = String(hit.values[COL.TG_ID] || '').trim();
            const conflict = owner && telegramId && owner !== String(telegramId);
            return describe(hit, 'phone', conflict ? 'weak' : 'strong');
        }
    }
    const wanted = normName(name);
    if (wanted && wanted.includes(' ')) {
        const hit = rows.find(r => fullName(r.values) === wanted);
        if (hit) return describe(hit, 'name', 'weak');
    }
    return null;
}

/**
 * Works out which cells of an existing member row should change when the same
 * person comes through the bot again (for example later in their career).
 * Rules: the ID / seniority, name, Employer, Aircraft and Join Date are kept;
 * career fields take the newest non-empty answer; authorities and ratings are
 * added to, never removed; every replaced value is logged in Notes.
 * @returns {{changes: Object<number,string>, replaced: string[]}}
 */
function mergeRow(existingRow, incomingRow, today) {
    const old = pad(existingRow);
    const inc = pad(incomingRow);
    const changes = {};
    const replaced = [];
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

    // Name: only fill a blank, never rewrite how a member is listed
    for (const c of [COL.FIRST, COL.LAST]) {
        if (!old[c].trim() && inc[c].trim()) changes[c] = inc[c];
    }

    if (inc[COL.PHONE].trim() && !phonesMatch(old[COL.PHONE], inc[COL.PHONE])
        && normalizePhone(old[COL.PHONE]) !== normalizePhone(inc[COL.PHONE])) {
        // (a number that is merely formatted differently is left exactly as it is)
        changes[COL.PHONE] = inc[COL.PHONE];
        if (old[COL.PHONE].trim()) replaced.push(`${FIELD_LABELS[COL.PHONE]}: ${old[COL.PHONE].trim()}`);
    }

    for (const c of [COL.STATUS, COL.RESIDENCY, COL.LICENSE, COL.TRAINING, COL.CATEGORY]) {
        const v = inc[c].trim();
        if (!v) continue;
        if (c === COL.CATEGORY && v === 'Unknown') continue;   // "other" answer: keep what we knew
        if (same(old[c], v)) continue;
        changes[c] = v;
        if (old[c].trim() && old[c].trim() !== 'Unknown') replaced.push(`${FIELD_LABELS[c]}: ${old[c].trim()}`);
    }

    for (const c of [COL.AUTHORITY, COL.RATINGS]) {
        const merged = unionList(old[c], inc[c]);
        if (merged !== splitList(old[c]).join(', ')) changes[c] = merged;
    }

    // A training goal that has since been reached (it now appears as the license
    // level or among the ratings) is no longer "in training for".
    const goal = old[COL.TRAINING].trim();
    if (goal && !(COL.TRAINING in changes)) {
        const license = (COL.LICENSE in changes ? changes[COL.LICENSE] : old[COL.LICENSE]).trim();
        const ratings = splitList(COL.RATINGS in changes ? changes[COL.RATINGS] : old[COL.RATINGS]);
        if ([license, ...ratings].some(v => same(v, goal))) {
            changes[COL.TRAINING] = '';
            replaced.push(`${FIELD_LABELS[COL.TRAINING]}: ${goal}`);
        }
    }

    const platform = old[COL.PLATFORM].trim();
    if (!platform || platform === 'Unknown') changes[COL.PLATFORM] = 'Telegram';
    else if (platform === 'WhatsApp') changes[COL.PLATFORM] = 'Both';

    let notes = appendParts(old[COL.NOTES], inc[COL.NOTES]);
    // The listed name is never rewritten, so keep the spelling the member used with the bot
    const listed = normName(`${old[COL.FIRST]} ${old[COL.LAST]}`);
    const given = `${inc[COL.FIRST]} ${inc[COL.LAST]}`.trim();
    if (given && listed && normName(given) !== listed) notes = appendParts(notes, `Name in bot: ${given}`);
    if (replaced.length) notes = appendParts(notes, `Updated via bot ${today} (was ${replaced.join(', ')})`);
    if (notes !== String(old[COL.NOTES]).trim()) changes[COL.NOTES] = notes;

    const review = appendParts(old[COL.REVIEW], inc[COL.REVIEW]);
    if (review !== String(old[COL.REVIEW]).trim()) changes[COL.REVIEW] = review;

    if (inc[COL.TG_ID].trim() && old[COL.TG_ID].trim() !== inc[COL.TG_ID].trim()) {
        changes[COL.TG_ID] = inc[COL.TG_ID].trim();
    }

    return { changes, replaced };
}

/** Groups of rows that look like the same person (same Telegram ID, phone or full name). */
function findDuplicateGroups(rows) {
    const buckets = new Map();
    const add = (key, reason, r) => {
        if (!buckets.has(key)) buckets.set(key, { reason, rows: [] });
        buckets.get(key).rows.push(r);
    };
    for (const r of rows) {
        const v = r.values;
        if (!v[COL.ID] && !fullName(v)) continue;
        const tg = String(v[COL.TG_ID] || '').trim();
        const ph = normalizePhone(v[COL.PHONE]);
        const nm = fullName(v);
        if (tg) add(`tg:${tg}`, 'telegram', r);
        if (ph.length >= 9) add(`ph:${ph.slice(-9)}`, 'phone', r);   // same rule as phonesMatch: last 9 digits agree
        if (nm.includes(' ')) add(`nm:${nm}`, 'name', r);
    }
    const seen = new Set();
    const groups = [];
    for (const { reason, rows: members } of buckets.values()) {
        if (members.length < 2) continue;
        const sig = members.map(m => m.rowNumber).sort((a, b) => a - b).join(',');
        if (seen.has(sig)) continue;      // same pair already reported for a stronger reason
        seen.add(sig);
        groups.push({
            reason,
            members: members.map(m => ({
                rowNumber: m.rowNumber,
                memberId: m.values[COL.ID] || '',
                name: `${m.values[COL.FIRST] || ''} ${m.values[COL.LAST] || ''}`.trim(),
            })),
        });
    }
    return groups;
}

// ---------- Sheet access ----------

/**
 * Column R ("Telegram ID") is new. The tab gets an 18th column once if it
 * doesn't have one, and R1 gets its header. If that can't be done right now
 * (Google hiccup, or the service account can't change the layout), or column R
 * already holds something else, this read/write cycle simply uses the original
 * A:Q layout instead of failing. A temporary failure is retried next time.
 */
let gridReady = false;      // true once the 18th column is confirmed to exist
let columnInUse = false;    // true if column R holds something that isn't ours
let tgColumnState = false;  // whether column R is usable in the current read/write cycle

async function ensureGrid() {
    if (gridReady) return true;
    const client = getClient();
    try {
        const meta = await client.request({
            url: `${BASE}?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))`,
        });
        const sheet = (meta.data.sheets || []).map(x => x.properties).find(p => p.title === SHEET_TAB);
        if (!sheet) throw new Error(`tab "${SHEET_TAB}" not found`);
        const columns = sheet.gridProperties?.columnCount || 0;
        if (columns < WIDTH) {
            await client.request({
                url: `${BASE}:batchUpdate`,
                method: 'POST',
                data: { requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: 'COLUMNS', length: WIDTH - columns } }] },
            });
        }
        gridReady = true;
    } catch (e) {
        console.error('Cannot prepare column R right now, using A:Q only:', e.message);
    }
    return gridReady;
}

/** Reads the whole Members tab once (raw values, so phones and IDs aren't reformatted). */
async function readMembers() {
    const client = getClient();
    const wide = !columnInUse && await ensureGrid();
    const res = await client.request({
        url: `${BASE}/values/${tabRange(`A1:${wide ? LAST_COL : 'Q'}`)}?valueRenderOption=UNFORMATTED_VALUE`,
    });
    const all = res.data.values || [];

    tgColumnState = false;
    if (wide) {
        const header = String(pad(all[0])[COL.TG_ID]).trim();
        const columnHasData = all.slice(1).some(r => String((r || [])[COL.TG_ID] ?? '').trim());
        if (/telegram|\btg\b/i.test(header)) {
            tgColumnState = true;
        } else if (!header && !columnHasData && all.length) {
            try {
                await client.request({
                    url: `${BASE}/values/${tabRange(`${LAST_COL}1`)}?valueInputOption=RAW`,
                    method: 'PUT',
                    data: { values: [[TG_ID_HEADER]] },
                });
                tgColumnState = true;
            } catch (e) {
                console.error('Could not write the Telegram ID header, using A:Q only:', e.message);
            }
        } else if (all.length) {
            // Column R already holds something else: leave it alone.
            console.error(`Column ${LAST_COL} is in use ("${header}"), using A:Q only`);
            columnInUse = true;
        }
    }

    const rows = [];
    for (let i = 1; i < all.length; i++) {
        const values = pad(all[i]);
        if (!tgColumnState) values[COL.TG_ID] = '';     // not ours: never match on it
        if (values.every(v => !v.trim())) continue;
        rows.push({ rowNumber: i + 1, values });
    }
    return rows;
}

function nextMemberId(rows) {
    let max = 0;
    for (const r of rows) {
        const n = parseInt(r.values[COL.ID], 10);
        if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
}

/** Next member ID = max numeric value in column A + 1 (ID doubles as seniority). */
async function getNextMemberId() {
    return nextMemberId(await readMembers());
}

function prepareForWrite(values) {
    const out = pad(values).slice(0, WIDTH);
    for (const c of [COL.FIRST, COL.LAST, COL.NOTES, COL.REVIEW]) out[c] = safeCell(out[c]);
    out[COL.PHONE] = phoneCell(out[COL.PHONE]);
    return out;
}

async function appendRow(values, rows) {
    const client = getClient();
    const memberId = nextMemberId(rows);
    let out = prepareForWrite(values);
    out[COL.ID] = String(memberId);
    const lastCol = tgColumnState ? LAST_COL : 'Q';
    if (!tgColumnState) out = out.slice(0, COL.TG_ID);

    const res = await client.request({
        url: `${BASE}/values/${tabRange(`A:${lastCol}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        method: 'POST',
        data: { values: [out] },
    });

    // updatedRange looks like "Members!A326:R326"
    let rowNumber = null;
    const range = res.data?.updates?.updatedRange || '';
    const m = range.match(/![A-Z]+(\d+):/);
    if (m) rowNumber = parseInt(m[1], 10);

    return { memberId, rowNumber };
}

async function writeChanges(rowNumber, changes) {
    const cols = Object.keys(changes).map(Number).filter(c => tgColumnState || c !== COL.TG_ID);
    if (!cols.length) return;
    const textCols = [COL.FIRST, COL.LAST, COL.NOTES, COL.REVIEW];
    const cell = (c) => (c === COL.PHONE ? phoneCell(changes[c]) : textCols.includes(c) ? safeCell(changes[c]) : changes[c]);
    const client = getClient();
    await client.request({
        url: `${BASE}/values:batchUpdate`,
        method: 'POST',
        data: {
            valueInputOption: 'USER_ENTERED',
            data: cols.map(c => ({
                range: `'${SHEET_TAB.replace(/'/g, "''")}'!${colLetter(c)}${rowNumber}`,
                values: [[cell(c)]],
            })),
        },
    });
}

/**
 * The single way the bot writes a member: update the person's existing row if
 * there is one, otherwise add a new row.
 *
 * @param {string[]} values       full A:R row built from the interview
 * @param {object}   opts
 * @param {number}   [opts.telegramId]
 * @param {number|string} [opts.knownMemberId]  member ID the bot already assigned to this Telegram user
 * @param {'auto'|'new'|'merge'} [opts.mode]
 *        auto  - update on a strong match (Telegram ID / phone), otherwise add a row
 *        merge - also update on a name-only match (admin confirmed it is the same person)
 *        new   - always add a row (admin confirmed it is a different person)
 * @returns {{action:'created'|'updated', memberId, rowNumber, match, replaced:string[], weakMatch}}
 */
async function saveMember(values, { telegramId, knownMemberId, mode = 'auto' } = {}) {
    const rows = await readMembers();
    const incoming = pad(values);
    if (telegramId) incoming[COL.TG_ID] = String(telegramId);
    const today = incoming[COL.JOIN_DATE];

    let target = null;
    let match = null;

    // A member the bot already wrote: locate the row by its ID, not by a stored
    // row number, so sorting or deleting rows in the sheet can't misdirect the update.
    if (knownMemberId) {
        const row = rows.find(r => String(r.values[COL.ID]).trim() === String(knownMemberId));
        // ...unless the sheet clearly says that ID now belongs to someone else (the row was
        // deleted and the number reused): then fall through to normal matching.
        const owner = row ? String(row.values[COL.TG_ID] || '').trim() : '';
        const otherAccount = owner && telegramId && owner !== String(telegramId);
        const bothPhones = row && normalizePhone(row.values[COL.PHONE]).length >= 9 && normalizePhone(incoming[COL.PHONE]).length >= 9;
        const otherPerson = !owner && bothPhones && !phonesMatch(row.values[COL.PHONE], incoming[COL.PHONE])
            && fullName(row.values) !== normName(`${incoming[COL.FIRST]} ${incoming[COL.LAST]}`);
        if (row && !otherAccount && !otherPerson) {
            target = row;
            match = { strength: 'strong', by: 'member', rowNumber: row.rowNumber, memberId: row.values[COL.ID], name: `${row.values[COL.FIRST]} ${row.values[COL.LAST]}`.trim() };
        }
    }

    let weakMatch = null;
    if (!target && mode !== 'new') {
        const found = findMatch(rows, {
            telegramId,
            phone: incoming[COL.PHONE],
            name: `${incoming[COL.FIRST]} ${incoming[COL.LAST]}`,
        });
        if (found && (found.strength === 'strong' || mode === 'merge')) {
            match = found;
            target = rows.find(r => r.rowNumber === found.rowNumber);
        } else if (found) {
            weakMatch = found;
        }
    }

    if (target) {
        const { changes, replaced } = mergeRow(target.values, incoming, today);
        await writeChanges(target.rowNumber, changes);
        return {
            action: 'updated',
            memberId: parseInt(target.values[COL.ID], 10) || null,
            rowNumber: target.rowNumber,
            match, replaced, weakMatch: null,
        };
    }

    // Looks like an existing member but the evidence is weak (same name only, or a
    // phone that belongs to another Telegram account): add the row, and leave a
    // visible flag so it shows up in the sheet's review workflow.
    if (weakMatch) {
        incoming[COL.REVIEW] = appendParts(incoming[COL.REVIEW], `possible duplicate of #${weakMatch.memberId} (same ${weakMatch.by})`);
    }
    const { memberId, rowNumber } = await appendRow(incoming, rows);
    return { action: 'created', memberId, rowNumber, match: null, replaced: [], weakMatch };
}

/** Looks up (without writing) whether this person already has a row. */
async function lookupMember({ telegramId, phone, name }) {
    return findMatch(await readMembers(), { telegramId, phone, name });
}

/** Scans the whole sheet for rows that look like the same person. Read-only. */
async function scanDuplicates() {
    return findDuplicateGroups(await readMembers());
}

module.exports = {
    COL,
    getNextMemberId, saveMember, lookupMember, scanDuplicates,
    // pure helpers, exported for tests
    normalizePhone, phonesMatch, phoneCell, findMatch, mergeRow, findDuplicateGroups, safeCell,
};
