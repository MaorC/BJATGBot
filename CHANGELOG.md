# Changelog

Every change to the BJA bot (@BlueJayAviationBot), newest first.
Add an entry with each change: date, what changed for admins and applicants, and the commit or PR.
Dates are when the change reached the `newbot` branch, which is what Netlify deploys.

Labels: **Admins** (what the team sees), **Applicants** (what members see), **Sheet** (the BJA Member Database), **Behind the scenes** (no visible change).

---

## [Pending] Rejection reasons fixed, sheet becomes one row per person
PR #1, branch `fix/reject-reason-and-sheet-dedupe`. Not live until merged.

**Fixed**
- A rejection reason typed in the admin chat was silently lost. The bot never reads text in that chat, so the applicant got no message, stayed "pending", and the card lost its buttons. The admin's next private message to the bot would also have been sent to that applicant as the reason.
- Every approval added a new sheet row, so a returning member got a duplicate.
- Updates found rows by row number, so sorting the sheet could overwrite the wrong member and blank Employer and Aircraft.

**Admins**
- ⛔ דחייה now opens a reason picker on the card: 3 ready reasons, "סיבה אחרת", "ללא סיבה", ביטול.
- "סיבה אחרת" and "השב למועמד" are typed in the private chat with the bot, with a preview before anything is sent.
- Each decision is stamped on the card: who decided, when, the reason, what happened in the sheet, and whether the applicant actually received the message.
- The card shows whether the applicant is already in the sheet, with buttons to overrule: 🆕 אישור כחבר חדש, 🔗 אישור + מיזוג.
- Admin panel: 🔎 סריקת כפילויות בגיליון, a read-only list of rows that look like the same person.

**Applicants**
- The rejection message now actually arrives, with the reason when one was chosen.

**Sheet**
- New column R, Telegram ID, added automatically.
- Matching order: Telegram ID, then phone, then full name (name only: an admin decides).
- An update writes only the cells that changed. The bot never touches the ID, listed name, Employer, Aircraft or Join Date. Replaced values are kept in Notes.
- Phones are stored as +972 text. Applicant text can't act as a formula.

Tested: 152/152 sandbox checks.

## 2026-10-16: Appeals after rejection, Commercial Aviation check
Commit `d97c3cf` (uploaded by hand; written as `9432ffe` and `805bde4`).

**Admins**
- Rejecting asks for a reason (this prompt is the part fixed in PR #1).
- A rejected applicant's reply reaches the admin chat with ↩️ השב למועמד and ✅ סגור ערעור.
- Requests for Commercial Aviation from people who don't fly commercially are flagged on the card, and held for a check for existing members.
- 🔀 בחירת קבוצות on the card, and ➕ הוספה לקבוצה in the admin panel, to choose groups by hand.

**Applicants**
- Can reply to a rejection in the chat and get an answer from the team.
- A short note in the interview when Commercial Aviation doesn't match their status.

## 2026-09-14: Every group join goes through the bot first
Commits `6aa1a08`, `d02f16d`.

**Fixed**
- A real applicant clicked a raw invite link and never heard from the bot (a bot can't message someone who never pressed Start).

**Applicants**
- Channel buttons and the in-bot menu open the bot first, and the real invite link is sent after approval.
- Existing members got "🛫 Request to join another group".

**Admins**
- If the bot can't message an applicant, the admin chat gets an alert instead of silence.

## 2026-08-31: Welcome copy and Fit2Fly
Commits `2a7644c`, `b6c480e`, `71d925b`, `d2a6097`, `32670cb`.

- Hebrew About Us and Community Rules for first-time users.
- Fit2Fly added as a group.
- Tap-to-message links to Maor.
- Bluejay Premium button hidden until its copy is ready.

## 2026-08-21: Join interview and member sheet sync
Commit `4d00dcd`.

- 7-question Hebrew interview for every join request.
- Admin card with approve, reject and manual fill.
- Approved members written to the BJA Member Database.
- Supabase `applicants` table.

## Before August 2026 (Tal Levi)
- Anonymous questions with admin approval, feedback, contact, pilot info update, bans, legacy message fetch and clean, on/off switch.
- Daily Supabase keepalive workflow.
- Per-user state and code cleanup (January and March 2026).
