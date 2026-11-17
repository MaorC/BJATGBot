# Changelog

Every change to the BJA bot (@BlueJayAviationBot), newest first.
Add an entry with each change: date, what changed for admins and applicants, and the commit or PR.
Dates are when the change reached the `newbot` branch, which is what Netlify deploys.

Labels: **Admins** (what the team sees), **Applicants** (what members see), **Sheet** (the BJA Member Database), **Behind the scenes** (no visible change).

---

## [Pending] Rejections reach applicants, appeals and calls with Maor, one row per person
PR #1, branch `fix/reject-reason-and-sheet-dedupe`. Not live until merged.

**Fixed**
- A rejection reason typed in the admin chat was silently lost. The bot never reads text in that chat, so the applicant got no message, stayed "pending", and the card lost its buttons. The admin's next private message to the bot would also have been sent to that applicant as the reason.
- Every approval added a new sheet row. 4 members already have two rows because of it (#151/#359, #166/#363, #228/#361, #307/#358): the old row is in English, the bot's row in Hebrew.
- The bot saved phones without "+" or without the leading 0 (7 rows, #358 to #364).
- Updates found rows by row number, so sorting the sheet could overwrite the wrong member and blank Employer and Aircraft.

**Admins**
- ⛔ דחייה opens a reason picker on the card: 3 ready reasons, "סיבה אחרת", "ללא סיבה", ביטול.
- "סיבה אחרת" and "השב למועמד" are typed in the private chat with the bot, with a preview before anything is sent.
- Each decision is stamped on the card: who, when, the reason, what happened in the sheet, and whether the applicant received the message.
- The card says whether the applicant is already in the sheet (also across Hebrew and English spelling), with buttons to overrule: 🆕 אישור כחבר חדש, 🔗 אישור + מיזוג.
- New "📞 בקשה לשיחה עם מאור" card when a declined applicant asks for a call.
- Admin panel: 🧹 ניקוי כפילויות בגיליון. Step 1 fills Telegram IDs from the bot's records and fixes phone formats. Step 2 shows each suspected duplicate with merge / different people / skip.

**Applicants**
- The rejection message arrives, with the reason when one was chosen, and two buttons: 📝 הגשת ערעור, 📞 תיאום שיחה עם מאור (direct link to t.me/maor_c).
- Someone declined earlier who tries to join again gets the same two options instead of a dead end.

**Sheet**
- New column R, Telegram ID, added automatically.
- Matching: Telegram ID, phone in any format, phone one digit off, and name including Hebrew against English. Only a Telegram ID or phone match updates a row on its own; anything weaker is an admin's call.
- An update writes only the cells that changed. Never touched: ID, listed name, Employer, Aircraft, Join Date. Replaced values go to Notes.
- A merge keeps the lowest ID (seniority) and copies the removed row in full to a new "Merge Log" tab first. "Different people" decisions are logged there too and never suggested again.
- Phones stored as +972 text. Applicant text can't act as a formula.

Tested: 196/196 sandbox checks, plus a dry run of the matching on the real sheet (4 duplicate pairs found, no false matches among 330 legacy members).

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
