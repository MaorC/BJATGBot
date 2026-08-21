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
 * Column layout (A:Q):
 * ID | First Name | Last Name | Phone | Status | Residency | License Level |
 * In Training For | License Authority | Ratings | Flying Category | Employer |
 * Aircraft | Platform Source | Join Date | Notes | Needs Review
 */

const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'Members';
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

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

/**
 * Next member ID = max numeric value in column A + 1 (ID doubles as seniority).
 */
async function getNextMemberId() {
    const client = getClient();
    const res = await client.request({
        url: `${BASE}/values/${encodeURIComponent(SHEET_TAB)}!A2:A`,
    });
    const rows = res.data.values || [];
    let max = 0;
    for (const r of rows) {
        const n = parseInt(r[0], 10);
        if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
}

/**
 * Appends a member row. Returns { memberId, rowNumber }.
 * @param {string[]} values - full A:Q row (values[0] may be empty; filled here)
 */
async function appendMemberRow(values) {
    const client = getClient();
    const memberId = await getNextMemberId();
    values[0] = String(memberId);

    const res = await client.request({
        url: `${BASE}/values/${encodeURIComponent(SHEET_TAB)}!A:Q:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        method: 'POST',
        data: { values: [values] },
    });

    // updatedRange looks like "Members!A326:Q326"
    let rowNumber = null;
    const range = res.data?.updates?.updatedRange || '';
    const m = range.match(/![A-Z]+(\d+):/);
    if (m) rowNumber = parseInt(m[1], 10);

    return { memberId, rowNumber };
}

/**
 * Overwrites an existing member row (keeps its ID / seniority).
 * @param {number} rowNumber - 1-based sheet row
 * @param {string[]} values - full A:Q row
 */
async function updateMemberRow(rowNumber, values) {
    const client = getClient();
    await client.request({
        url: `${BASE}/values/${encodeURIComponent(SHEET_TAB)}!A${rowNumber}:Q${rowNumber}?valueInputOption=USER_ENTERED`,
        method: 'PUT',
        data: { values: [values] },
    });
}

module.exports = { getNextMemberId, appendMemberRow, updateMemberRow };
