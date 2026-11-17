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
 * One person = one row. The rules for "is this the same person" and "how are
 * two rows combined" live in matching.js; this file only reads and writes.
 *
 * A second tab, "Merge Log", is created on first use. Every merge copies the
 * removed row there in full (so nothing is ever lost), and every "these are
 * different people" decision is recorded there so the bot doesn't ask again.
 */

const { JWT } = require('google-auth-library');
const M = require('./matching');

const { COL, WIDTH, pad, str, safeCell, phoneCell, phoneUsable, phonesMatch, compareNames, appendParts } = M;

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'Members';
const LOG_TAB = 'Merge Log';
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const LAST_COL = 'R';
const TG_ID_HEADER = 'Telegram ID';
const LOG_HEADER = ['Date', 'Action', 'Kept ID', 'Other ID', 'By', 'Details',
    'ID', 'First Name', 'Last Name', 'Phone', 'Status', 'Residency', 'License Level', 'In Training For',
    'License Authority', 'Ratings', 'Flying Category', 'Employer', 'Aircraft', 'Platform Source',
    'Join Date', 'Notes', 'Needs Review', 'Telegram ID'];

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

const quoteTab = (t) => `'${t.replace(/'/g, "''")}'`;
const tabRange = (a1, tab = SHEET_TAB) => `${encodeURIComponent(quoteTab(tab))}!${a1}`;
const colLetter = (i) => String.fromCharCode(65 + i);
const todayIL = () => new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem' });

// ---------- layout ----------

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
let tabIds = null;          // { [title]: sheetId }

async function loadTabs(force = false) {
    if (tabIds && !force) return tabIds;
    const meta = await getClient().request({
        url: `${BASE}?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))`,
    });
    tabIds = {};
    let columns = 0;
    for (const p of (meta.data.sheets || []).map(x => x.properties)) {
        tabIds[p.title] = p.sheetId;
        if (p.title === SHEET_TAB) columns = p.gridProperties?.columnCount || 0;
    }
    return Object.assign(tabIds, { _membersColumns: columns });
}

async function ensureGrid() {
    if (gridReady) return true;
    try {
        const tabs = await loadTabs(true);
        if (tabs[SHEET_TAB] === undefined) throw new Error(`tab "${SHEET_TAB}" not found`);
        if (tabs._membersColumns < WIDTH) {
            await getClient().request({
                url: `${BASE}:batchUpdate`,
                method: 'POST',
                data: { requests: [{ appendDimension: { sheetId: tabs[SHEET_TAB], dimension: 'COLUMNS', length: WIDTH - tabs._membersColumns } }] },
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
        const header = str(pad(all[0])[COL.TG_ID]);
        const columnHasData = all.slice(1).some(r => str((r || [])[COL.TG_ID]));
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

const TEXT_COLS = [COL.FIRST, COL.LAST, COL.NOTES, COL.REVIEW, COL.EMPLOYER, COL.AIRCRAFT];
const cellFor = (c, v) => (c === COL.PHONE ? phoneCell(v) : TEXT_COLS.includes(c) ? safeCell(v) : String(v ?? ''));

function prepareForWrite(values) {
    return pad(values).slice(0, WIDTH).map((v, c) => (c === COL.ID ? v : cellFor(c, v)));
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

/** Writes only the given cells. `edits`: [{ rowNumber, changes: {col: value} }] */
async function writeCells(edits) {
    const data = [];
    for (const { rowNumber, changes } of edits) {
        for (const c of Object.keys(changes).map(Number)) {
            if (c === COL.ID || (!tgColumnState && c === COL.TG_ID)) continue;
            data.push({ range: `${quoteTab(SHEET_TAB)}!${colLetter(c)}${rowNumber}`, values: [[cellFor(c, changes[c])]] });
        }
    }
    if (!data.length) return;
    await getClient().request({
        url: `${BASE}/values:batchUpdate`,
        method: 'POST',
        data: { valueInputOption: 'USER_ENTERED', data },
    });
}
const writeChanges = (rowNumber, changes) => writeCells([{ rowNumber, changes }]);

// ---------- saving an approved applicant ----------

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
 *        merge - also update on a weaker match (admin confirmed it is the same person)
 *        new   - always add a row (admin confirmed it is a different person)
 * @returns {{action:'created'|'updated', memberId, rowNumber, match, replaced:string[], weakMatch}}
 */
async function saveMember(values, { telegramId, knownMemberId, mode = 'auto' } = {}) {
    const rows = await readMembers();
    const incoming = pad(values);
    if (telegramId) incoming[COL.TG_ID] = String(telegramId);
    const today = incoming[COL.JOIN_DATE] || todayIL();

    let target = null;
    let match = null;

    // A member the bot already wrote: locate the row by its ID, not by a stored
    // row number, so sorting or deleting rows in the sheet can't misdirect the update.
    if (knownMemberId) {
        const row = rows.find(r => str(r.values[COL.ID]) === String(knownMemberId));
        // ...unless the sheet clearly says that ID now belongs to someone else (the row was
        // deleted and the number reused): then fall through to normal matching.
        const owner = row ? str(row.values[COL.TG_ID]) : '';
        const otherAccount = owner && telegramId && owner !== String(telegramId);
        const bothPhones = row && phoneUsable(row.values[COL.PHONE]) && phoneUsable(incoming[COL.PHONE]);
        const otherPerson = row && !owner && bothPhones && !phonesMatch(row.values[COL.PHONE], incoming[COL.PHONE])
            && !compareNames(row.values, incoming);
        if (row && !otherAccount && !otherPerson) {
            target = row;
            match = { strength: 'strong', by: 'member', rowNumber: row.rowNumber, memberId: row.values[COL.ID], name: M.displayName(row.values) };
        }
    }

    let weakMatch = null;
    if (!target && mode !== 'new') {
        const found = M.findMatch(rows, {
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
        const { changes, replaced } = M.mergeRow(target.values, incoming, today);
        await writeChanges(target.rowNumber, changes);
        return {
            action: 'updated',
            memberId: parseInt(target.values[COL.ID], 10) || null,
            rowNumber: target.rowNumber,
            match, replaced, weakMatch: null,
        };
    }

    // Looks like an existing member but the evidence is weak: add the row, and
    // leave a visible flag so it shows up in the sheet's review workflow.
    if (weakMatch) {
        incoming[COL.REVIEW] = appendParts(incoming[COL.REVIEW], `possible duplicate of #${weakMatch.memberId} (same ${weakMatch.by.replace('_', ' ')})`);
    }
    const { memberId, rowNumber } = await appendRow(incoming, rows);
    return { action: 'created', memberId, rowNumber, match: null, replaced: [], weakMatch };
}

/** Looks up (without writing) whether this person already has a row. */
async function lookupMember({ telegramId, phone, name }) {
    return M.findMatch(await readMembers(), { telegramId, phone, name });
}

// ---------- Merge Log tab ----------

async function ensureLogTab() {
    let tabs = await loadTabs();
    if (tabs[LOG_TAB] !== undefined) return;
    try {
        await getClient().request({
            url: `${BASE}:batchUpdate`,
            method: 'POST',
            data: { requests: [{ addSheet: { properties: { title: LOG_TAB } } }] },
        });
    } catch (e) {
        if (!/already exists/i.test(e.message)) throw e;
    }
    tabs = await loadTabs(true);
    await getClient().request({
        url: `${BASE}/values/${tabRange('A1', LOG_TAB)}?valueInputOption=RAW`,
        method: 'PUT',
        data: { values: [LOG_HEADER] },
    });
}

async function appendLog(entries) {
    if (!entries.length) return;
    await ensureLogTab();
    await getClient().request({
        url: `${BASE}/values/${tabRange('A:X', LOG_TAB)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        method: 'POST',
        data: { values: entries },
    });
}

/** Pairs of member IDs an admin marked as different people ("id1-id2", sorted). */
async function readDifferentPairs() {
    const tabs = await loadTabs();
    if (tabs[LOG_TAB] === undefined) return new Set();
    const res = await getClient().request({ url: `${BASE}/values/${tabRange('A2:D', LOG_TAB)}` });
    const out = new Set();
    for (const r of res.data.values || []) {
        if (str(r[1]) === 'different') out.add(M.pairKey(r[2], r[3]));
    }
    return out;
}

// ---------- duplicate clean-up ----------

/** Suspected duplicate groups, minus pairs already marked as different people. Read-only. */
async function scanDuplicates() {
    const [rows, ignorePairs] = await Promise.all([readMembers(), readDifferentPairs()]);
    return M.findDuplicateGroups(rows, { ignorePairs });
}

/**
 * Re-reads the sheet and returns the group made of exactly these member IDs,
 * or null if it no longer stands (a row was edited, deleted, or already merged).
 */
async function loadGroup(ids) {
    const rows = await readMembers();
    const members = ids.map(id => rows.find(r => str(r.values[COL.ID]) === String(id)));
    if (members.some(m => !m)) return { rows, group: null };
    const groups = M.findDuplicateGroups(members);
    const group = groups.find(g => g.members.length === members.length) || null;
    return { rows, group, members };
}

/**
 * Merges the rows with these member IDs into the one with the lowest ID.
 * Order matters for safety: (1) every removed row is copied in full to the
 * Merge Log, (2) the kept row gets its new values, (3) only then are the
 * removed rows deleted, after checking they are still where we read them.
 */
async function applyMerge(ids, adminName) {
    const { group, members } = await loadGroup(ids);
    if (!group) return { ok: false, reason: 'stale' };

    const today = todayIL();
    const plan = M.mergeGroup(members, today);
    const keptId = str(plan.keep.values[COL.ID]);

    await appendLog(plan.remove.map(r => [today, 'merged', keptId, str(r.values[COL.ID]), adminName || '', group.evidence.join(', '), ...pad(r.values)]));
    await writeChanges(plan.keep.rowNumber, plan.changes);

    // Delete bottom-up, and only rows that still carry the ID we expect
    const check = await getClient().request({ url: `${BASE}/values/${tabRange('A1:A')}?valueRenderOption=UNFORMATTED_VALUE` });
    const colA = (check.data.values || []).map(r => str(r[0]));
    const toDelete = plan.remove
        .map(r => {
            const id = str(r.values[COL.ID]);
            if (colA[r.rowNumber - 1] === id) return r.rowNumber;
            const moved = colA.findIndex(v => v === id);
            return moved >= 0 ? moved + 1 : null;
        })
        .filter(Boolean)
        .sort((a, b) => b - a);
    const tabs = await loadTabs();
    if (toDelete.length) {
        await getClient().request({
            url: `${BASE}:batchUpdate`,
            method: 'POST',
            data: {
                requests: toDelete.map(rowNumber => ({
                    deleteDimension: { range: { sheetId: tabs[SHEET_TAB], dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } },
                })),
            },
        });
    }

    return {
        ok: true,
        keptId,
        removedIds: plan.remove.map(r => str(r.values[COL.ID])),
        merged: plan.merged,
        warnings: plan.warnings,
    };
}

/** Records that these rows are different people, so the scan stops suggesting them. */
async function markDifferent(ids, adminName) {
    const today = todayIL();
    const sorted = [...ids].map(String).sort((a, b) => Number(a) - Number(b));
    const entries = [];
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) entries.push([today, 'different', sorted[i], sorted[j], adminName || '', '']);
    }
    await appendLog(entries);
}

/**
 * Step 1 of the clean-up: fill missing Telegram IDs from the bot's own records,
 * and fix phones an earlier version of the bot saved without "+" or the 0.
 * Only empty Telegram ID cells and clearly malformed phones are touched.
 * `known`: [{ telegramId, memberId, phone, name }] from the bot's applicants table.
 * @returns {{tg: Array, phones: Array, conflicts: Array, apply: () => Promise}}
 */
async function planBackfill(known) {
    const rows = await readMembers();
    const edits = new Map();
    const tg = [];
    const phones = [];
    const conflicts = [];
    const add = (row, col, value) => {
        if (!edits.has(row.rowNumber)) edits.set(row.rowNumber, {});
        edits.get(row.rowNumber)[col] = value;
    };

    if (tgColumnState) {
        const owned = new Set(rows.map(r => str(r.values[COL.TG_ID])).filter(Boolean));
        for (const k of known) {
            const tid = String(k.telegramId);
            if (owned.has(tid)) continue;
            const words = str(k.name).split(/\s+/);
            const probe = pad([]);
            probe[COL.FIRST] = words[0] || '';
            probe[COL.LAST] = words.slice(1).join(' ');
            probe[COL.PHONE] = k.phone || '';
            // The row the bot wrote for this person, if it still looks like them...
            let row = k.memberId ? rows.find(r => str(r.values[COL.ID]) === String(k.memberId)) : null;
            if (row && !(phonesMatch(row.values[COL.PHONE], k.phone) || compareNames(row.values, probe))) row = null;
            // ...otherwise a row with the same phone
            if (!row && phoneUsable(k.phone)) {
                const hits = rows.filter(r => phonesMatch(r.values[COL.PHONE], k.phone));
                if (hits.length === 1) row = hits[0];
            }
            if (!row) continue;
            if (str(row.values[COL.TG_ID])) {
                if (str(row.values[COL.TG_ID]) !== tid) conflicts.push({ memberId: row.values[COL.ID], name: M.displayName(row.values) });
                continue;
            }
            add(row, COL.TG_ID, tid);
            owned.add(tid);
            tg.push({ memberId: row.values[COL.ID], name: M.displayName(row.values) });
        }
    }

    for (const r of rows) {
        const cur = str(r.values[COL.PHONE]);
        if (!cur || !phoneUsable(cur)) continue;
        const fixed = phoneCell(cur).replace(/^'/, '');
        if (fixed !== cur) {
            add(r, COL.PHONE, fixed);
            phones.push({ memberId: r.values[COL.ID], name: M.displayName(r.values), from: cur, to: fixed });
        }
    }

    return {
        tg, phones, conflicts,
        apply: () => writeCells([...edits.entries()].map(([rowNumber, changes]) => ({ rowNumber, changes }))),
    };
}

module.exports = {
    COL,
    getNextMemberId, saveMember, lookupMember,
    scanDuplicates, loadGroup, applyMerge, markDifferent, planBackfill,
    // pure helpers, re-exported for tests and older callers
    normalizePhone: M.normalizePhone, phonesMatch, phoneCell, findMatch: M.findMatch,
    mergeRow: M.mergeRow, findDuplicateGroups: M.findDuplicateGroups, safeCell,
};
