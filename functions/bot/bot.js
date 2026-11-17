/**
 * Blue Jay Aviation - Anonymous Forwarding Bot
 * 
 * Flow Overview:
 * 1. Users start the bot and are identified as first-time or existing users.
 * 2. Navigation is handled via inline keyboards and state stored in Supabase (chat_mode).
 * 3. Anonymous questions are queued for admin approval before being published to the main group.
 * 4. Join requests: every "join a group" entry point (channel post, in-bot menu) routes
 *    through the bot first via startJoinFlow() - either a /start deep-link payload
 *    (join_<key>) or an in-bot picker button - which guarantees the user has opened a
 *    chat with the bot before the interview DM is attempted, and only then hands out the
 *    real group invite link. The native chat_join_request handler below stays in place as
 *    a fallback safety net for anyone who still arrives via an old/raw invite link.
 * 5. Admin decisions happen on the applicant's card in the admin chat. The bot never reads
 *    free text typed in that chat: a rejection reason is either a one-tap preset, or typed
 *    in the admin's PRIVATE chat with the bot and confirmed in a preview before it is sent.
 *    Every decision is stamped on the card (who, when, sheet result, delivery status).
 * 6. The member sheet is one row per person: sheets.saveMember() updates the person's
 *    existing row (matched by Telegram ID, phone, or the row this bot wrote earlier) and
 *    only otherwise adds one. See sheets.js for the merge rules.
 */

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const sheets = require('./sheets');
const matching = require('./matching');
const { createInterview } = require('./interview');

dotenv.config();

// --- Configuration & Initialization ---

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TOPIC_ID = parseInt(process.env.TOPIC_ID);
const ADMINS = process.env.ADMINS.split(',').map(id => parseInt(id.trim()));
const FEEDBACK_CHANNEL_ID = process.env.FEEDBACK_CHANNEL_ID;
const GROUP_ID = process.env.GROUP_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const SUPA_TABLE = process.env.SUPABASE_TABLE; // Status/Config table
const SUPA_KEY = process.env.SUPABASE_KEY_NAME; // Key for 'enabled' state

const BOT_USERNAME = 'BlueJayAviationBot';
const MAOR_USERNAME = 'maor_c';   // where rejected applicants are referred for a conversation
const MAOR_URL = `https://t.me/${MAOR_USERNAME}`;

/**
 * Single source of truth for community groups. `key` is the stable slug used
 * in /start deep-link payloads (join_<key>) and in-bot picker callback data
 * (join_pick:<key>) - never expose the raw `url` directly in the channel post
 * or the in-bot picker; route through startJoinFlow() instead so every path
 * to a group goes through the bot first.
 */
const GROUP_LINKS = [
  { key: 'lounge', text: '🛋️ Lounge', url: 'https://t.me/+V2SBxQBz0Z9hOWQ0' },
  { key: 'commercial', text: '✈️ Commercial Aviation', url: 'https://t.me/+OszqxsBH8vY0NjBk' },
  { key: 'instructors', text: '🧑‍🏫 Flight Instructors', url: 'https://t.me/+swR-eigAntViN2I0' },
  { key: 'cadets', text: '👨‍✈️ Cadet Pilots', url: 'https://t.me/+8ynMfyN0zzZlNDlk' },
  { key: 'fit2fly', text: '💪 Fit2Fly (Fitness Squad)', url: 'https://t.me/+JGTG3PlkZ1M3ODRk' },
];

/**
 * Escapes characters for Telegram HTML parse_mode.
 */
function escapeHTML(str) {
  if (!str) return 'N/A';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const interview = createInterview({
  supabase,
  telegram: bot.telegram,
  escapeHTML,
  FEEDBACK_CHANNEL_ID,
  GROUP_LINKS,
  sheets,
});

/**
 * One-tap rejection reasons shown to the admin after "⛔ דחייה". `text` is what
 * the applicant reads after "📝 סיבה:". Edit freely; keep `code` short and unique.
 */
const REJECT_PRESETS = [
  {
    code: 'notyet',
    label: '🎓 עוד לא בתהליך הכשרה',
    text: 'הקהילה מיועדת לטייסים שכבר נמצאים בתהליך מקצועי לקראת רישיון מסחרי. כשתתחיל/י את ההכשרה, נשמח לבחון את הבקשה מחדש.',
  },
  {
    code: 'verify',
    label: '🛂 לא ניתן לאמת את הפרטים',
    text: 'לא הצלחנו לאמת את הפרטים שנמסרו בבקשה. פרטים נוספים (למשל קישור ללינקדאין) יעזרו לנו לבחון אותה מחדש.',
  },
  {
    code: 'partial',
    label: '🧩 פרטים חסרים',
    text: 'הפרטים שנמסרו בבקשה חלקיים מדי כדי שנוכל לאשר אותה.',
  },
];
const MAX_ADMIN_TEXT = 1000;


// =============================================================================
// SECTION 1: State & Database Helpers
// =============================================================================

/**
 * Retrieves the current interaction mode of a user.
 * @param {number} userId - Telegram User ID
 * @returns {string|null} - Current mode or null
 */
async function getUserMode(userId) {
  const { data } = await supabase
    .from('users')
    .select('chat_mode')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.chat_mode || null;
}

/**
 * Updates the user's interaction mode in the database.
 * @param {number} userId - Telegram User ID
 * @param {string|null} mode - Mode to set
 */
async function setUserMode(userId, mode) {
  await supabase
    .from('users')
    .update({ chat_mode: mode })
    .eq('user_id', userId);
}

/**
 * Ensures a user exists in the 'users' table.
 * @param {object} ctx - Telegraf context
 * @returns {object} - { isFirstTime: boolean }
 */
async function ensureUserRow(ctx) {
  const { id: user_id, username, first_name } = ctx.from;

  const { data } = await supabase
    .from('users')
    .select('user_id')
    .eq('user_id', user_id)
    .maybeSingle();

  if (data) return { isFirstTime: false };

  await supabase.from('users').insert([{ user_id, username, first_name }]);
  return { isFirstTime: true };
}

/**
 * Checks if the bot is currently enabled via Supabase config.
 */
async function isBotEnabled() {
    const { data, error } = await supabase
        .from(SUPA_TABLE)
        .select('value')
        .eq('key', SUPA_KEY)
        .single();

    if (error) {
        console.error("Supabase read error:", error.message);
        return false;
    }
    return data?.value === 'true';
}

/**
 * Toggles the bot's enabled state in Supabase.
 * @param {boolean} state 
 */
async function setBotEnabled(state) {
    const { error } = await supabase
        .from(SUPA_TABLE)
        .update({ value: String(state) })
        .eq('key', SUPA_KEY);

    if (error) {
        console.error("Supabase write error:", error.message);
    }
}


// =============================================================================
// SECTION 2: Keyboards & Menus
// =============================================================================

/**
 * Menu shown to users who have never used the bot before.
 */
function getFirstTimeMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'ℹ️ About us', callback_data: 'ft_about' }],
        [{ text: '📜 Community Rules', callback_data: 'ft_rules' }],
        [{ text: '🛫 Request to Join', callback_data: 'ft_join' }],
      ],
    },
  };
}

/**
 * Primary menu for registered users.
 */
function getExistingUserMenu(isAdmin = false) {
  const keyboard = [
    [{ text: '🛫 Request to join another group', callback_data: 'ft_join' }],
    [{ text: '❓ Ask anonymously', callback_data: 'ex_anon' }],
    [{ text: '🗣️ Send Feedback', callback_data: 'feedback' }],
    // 'ex_premium' (Bluejay Premium) hidden until real onboarding copy is ready - see project memory.
    [{ text: '🧾 Update pilot info', callback_data: 'ex_crm' }],
    [{ text: '☎️ Contact us', callback_data: 'ex_contact' }],
  ];
  if (isAdmin) keyboard.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

/**
 * In-bot group picker. Buttons call back into the bot (join_pick:<key>)
 * rather than linking straight to the group, so every join always goes
 * through startJoinFlow() first.
 */
function getGroupPickerMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...GROUP_LINKS.map(g => [{ text: g.text, callback_data: `join_pick:${g.key}` }]),
        [{ text: '🔙 Back', callback_data: 'back_home' }],
      ],
    },
  };
}

/**
 * Tools for bot administrators.
 */
function getAdminPanel() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 On', callback_data: 'admin_on' }, { text: '⛔ Off', callback_data: 'admin_off' }],
                [{ text: '📊 Status', callback_data: 'admin_status' }],
                [{ text: '📥 Fetch Legacy', callback_data: 'admin_fetch' }, { text: '🧹 Clean Legacy', callback_data: 'admin_clean' }],
                [{ text: '🚫 Ban user', callback_data: 'admin_ban' }],
                [{ text: '➕ הוספה לקבוצה', callback_data: 'admin_addgroup' }],
                [{ text: '🧹 ניקוי כפילויות בגיליון', callback_data: 'cl:start' }],
                [{ text: '🔗 Post Links to Channel', callback_data: 'admin_links' }],
                [{ text: '🔙 Back', callback_data: 'back_home' }]
            ]
        }
    };
}


// =============================================================================
// SECTION 3: Navigation Logic
// =============================================================================

/**
 * Clears mode and shows the appropriate home menu based on user history.
 */
async function showHomeMenu(ctx) {
  await setUserMode(ctx.from.id, null);
  const { isFirstTime } = await ensureUserRow(ctx);

  if (isFirstTime) {
    return ctx.reply(
      '👋 Welcome! Choose an option:',
      { ...getFirstTimeMenu(), parse_mode: 'HTML' }
    );
  }

  return ctx.reply(
    '👋 Welcome back! What would you like to do?',
    { ...getExistingUserMenu(ADMINS.includes(ctx.from.id)), parse_mode: 'HTML' }
  );
}


// =============================================================================
// SECTION 3.5: Join Requests & Applicant Approval
// =============================================================================

/**
 * Builds the group multi-select keyboard used both on a pending applicant's
 * admin card (aq:groups / aq:gtoggle / aq:gconfirm / aq:gcancel) and on the
 * standalone "add an existing member to a group" admin flow (aq:addsend /
 * aq:addcancel). Selection state lives transiently in answers._admin_pick.
 */
function groupToggleKeyboard(tidStr, selectedKeys, confirmVerb, cancelVerb) {
    return {
        inline_keyboard: [
            ...GROUP_LINKS.map(g => [{
                text: `${selectedKeys.includes(g.key) ? '✅' : '⬜'} ${g.text}`,
                callback_data: `aq:gtoggle:${tidStr}:${g.key}`,
            }]),
            [
                { text: '✅ אישור ושליחה', callback_data: `aq:${confirmVerb}:${tidStr}` },
                { text: '🔙 ביטול', callback_data: `aq:${cancelVerb}:${tidStr}` },
            ],
        ],
    };
}

/**
 * Posts a lightweight review card when an already-known applicant (approved
 * member, or retro_pending with a complete profile) requests a group that
 * doesn't match their stated flying category - holds the real invite link
 * until an admin explicitly sends it, instead of handing it out instantly.
 */
async function notifyAdminGroupMismatch(applicant, key) {
    const group = GROUP_LINKS.find(g => g.key === key);
    const a = applicant.answers || {};
    const text =
        `🔁 <b>בקשה לקבוצה נוספת - דורשת בדיקה</b>\n\n` +
        `👤 ${escapeHTML(a.name || applicant.tg_first_name || '')} (@${escapeHTML(applicant.username || 'אין')})\n` +
        `🆔 ${applicant.telegram_id}\n` +
        `💬 <a href="tg://user?id=${applicant.telegram_id}">פנייה ישירה למועמד</a>\n` +
        `✈️ סטטוס קיים: ${interview.categoryLabel(a.category)}\n` +
        `🎯 מבקש/ת להצטרף ל: ${group ? group.text : key}`;
    await bot.telegram.sendMessage(FEEDBACK_CHANNEL_ID, text, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ שלח קישור', callback_data: `aq:extra_send:${applicant.telegram_id}:${key}` },
                { text: '⛔ לא כרגע', callback_data: `aq:extra_deny:${applicant.telegram_id}:${key}` },
            ]],
        },
    }).catch(() => {});
}

/** Looks up an approved member by Telegram ID or @username, for the standalone "add to group" admin flow. */
async function resolveApprovedApplicant(input) {
    const trimmed = input.trim();
    let query = supabase.from('applicants').select('*').eq('status', 'approved');
    query = /^\d+$/.test(trimmed)
        ? query.eq('telegram_id', parseInt(trimmed))
        : query.ilike('username', trimmed.replace(/^@/, ''));
    const { data } = await query.maybeSingle();
    return data || null;
}

/** Reason-picker keyboard that replaces the card's buttons after "⛔ דחייה". */
function rejectReasonKeyboard(tidStr) {
    return {
        inline_keyboard: [
            ...REJECT_PRESETS.map(p => [{ text: p.label, callback_data: `aq:rejp:${tidStr}:${p.code}` }]),
            [{ text: '✍️ סיבה אחרת (כתיבה חופשית)', callback_data: `aq:rejother:${tidStr}` }],
            [{ text: '⏭️ דחייה ללא סיבה', callback_data: `aq:rejskip:${tidStr}` }],
            [{ text: '🔙 ביטול', callback_data: `aq:rejback:${tidStr}` }],
        ],
    };
}

const REJECTED_CARD_KEYBOARD = (tidStr) => ({
    inline_keyboard: [[
        { text: '↩️ אשר בדיעבד', callback_data: `aq:retro:${tidStr}` },
        { text: '📋 השלמה ידנית', callback_data: `aq:fill:${tidStr}` },
    ]],
});

const nowIL = () => new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
const applicantName = (applicant) => applicant.answers?.name || applicant.tg_first_name || String(applicant.telegram_id);

/**
 * Writes the decision onto the applicant's admin card itself (who, when, what
 * happened), so the admin chat doubles as a readable log. Works both when the
 * button was pressed on the card and when the decision was completed elsewhere
 * (the card's location is stored in answers._card). Returns false if the card
 * could not be edited, so the caller can fall back to a plain reply.
 */
async function stampCard(applicant, stamp, keyboard) {
    const ref = applicant.answers?._card;
    if (!ref?.c || !ref?.m) return false;
    try {
        await bot.telegram.editMessageText(ref.c, ref.m, undefined,
            `${interview.summaryText(applicant, { decided: true })}\n\n${stamp}`,
            { parse_mode: 'HTML', reply_markup: keyboard || { inline_keyboard: [] }, link_preview_options: { is_disabled: true } }
        );
        return true;
    } catch (e) {
        console.error('Could not stamp admin card:', e.message);
        return false;
    }
}

const MATCH_LABELS = matching.MATCH_LABELS_HE;

/** Rejects after `ms` so a hanging Google request can't run the function into its time limit. */
const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
]);

/** Human-readable (Hebrew) line describing what happened in the member sheet. */
function describeSheetResult(res) {
    if (res.action === 'created') {
        let line = `🗂️ נוסף לגיליון כחבר #${res.memberId}.`;
        if (res.weakMatch) {
            line += ` שימו לב: ייתכן שזה אותו אדם כמו #${escapeHTML(String(res.weakMatch.memberId))} (${MATCH_LABELS[res.weakMatch.by]}), השורה החדשה סומנה לבדיקה.`;
        }
        return line;
    }
    const by = MATCH_LABELS[res.match?.by];
    const id = escapeHTML(String(res.memberId ?? res.match?.memberId ?? '?'));
    let line = by
        ? `🗂️ זוהה כחבר קיים #${id} (${by}): השורה הקיימת עודכנה, לא נוצרה כפילות.`
        : `🗂️ השורה הקיימת בגיליון (#${id}) עודכנה.`;
    if (res.replaced.length) line += `\nערכים שהוחלפו ונשמרו בהערות: ${escapeHTML(res.replaced.join(', '))}`;
    return line;
}

/**
 * Saves the applicant to the BJA Members sheet, admits them to the requested
 * group(s), and notifies them. One person = one row: sheets.saveMember()
 * updates the person's existing row when there is one (same Telegram ID or
 * phone, or the row this bot wrote for them earlier) and only otherwise adds
 * a row. Sheet failures never lose data: answers stay in Supabase and admins
 * are told.
 * `overrideGroupKeys`, when given (from the admin card's group picker), sends
 * invite links for that exact set of groups instead of just the one requested.
 * `mergeMode`: 'auto' (default) | 'new' (admin: different person, add a row) |
 * 'merge' (admin: same person as the name-only match, update that row).
 * Returns { sheetNote, delivered } for the admin-facing confirmation.
 */
async function approveApplicant(applicant, adminId, overrideGroupKeys, mergeMode = 'auto') {
    const tid = applicant.telegram_id;
    let sheetNote = '';

    try {
        const row = interview.buildSheetRow(applicant);
        const res = await withTimeout(sheets.saveMember(row, {
            telegramId: tid,
            knownMemberId: mergeMode === 'new' ? null : applicant.member_id,
            mode: mergeMode,
        }), 7000, 'sheet write');
        await interview.upsertApplicant({ telegram_id: tid, member_id: res.memberId, sheet_row: res.rowNumber });
        sheetNote = describeSheetResult(res);
    } catch (e) {
        console.error('Sheets write failed:', e.message);
        sheetNote = '⚠️ הכתיבה לגיליון נכשלה - הנתונים שמורים ב-Supabase, יש להעתיק ידנית.';
    }

    let admittedDirectly = false;
    if (applicant.chat_requested) {
        try {
            await bot.telegram.approveChatJoinRequest(applicant.chat_requested, tid);
            admittedDirectly = true;
        } catch (e) {
            console.error('approveChatJoinRequest failed:', e.message);
        }
    }

    await interview.upsertApplicant({
        telegram_id: tid,
        status: 'approved',
        decided_by: adminId || null,
        decided_at: new Date().toISOString(),
    });

    // If there was a real pending Telegram join request, approveChatJoinRequest above
    // already admitted them and no link is needed. Otherwise (the bot-first flow -
    // startJoinFlow) they were never actually issued a Telegram join request, so send
    // the real invite link(s) for whichever group(s) they end up with. `overrideGroupKeys`
    // (set via the admin card's "🔀 בחירת קבוצות" picker) wins over the single requested one.
    const groupKey = applicant.answers?.requested_group_key;
    const keysToSend = (overrideGroupKeys && overrideGroupKeys.length) ? overrideGroupKeys : (groupKey ? [groupKey] : []);
    const groupsToSend = keysToSend.map(k => GROUP_LINKS.find(g => g.key === k)).filter(Boolean);

    let delivered = true;
    const send = (text, extra) => bot.telegram.sendMessage(tid, text, extra).catch((e) => {
        console.error('Approval DM failed:', e.message);
        delivered = false;
    });

    if (admittedDirectly && !(overrideGroupKeys && overrideGroupKeys.length)) {
        await send('🔵 ברוך הבא ל-Blue Jay Aviation! הבקשה שלך אושרה 🎉\n\nטיסות בטוחות! ✈️');
    } else if (groupsToSend.length) {
        const joinLine = groupsToSend.length === 1
            ? `לחץ כדי להצטרף ל-${groupsToSend[0].text}:`
            : 'לחץ כדי להצטרף לקבוצות:';
        await send(
            `🔵 ברוך הבא ל-Blue Jay Aviation! הבקשה שלך אושרה 🎉\n\n${joinLine}`,
            { reply_markup: { inline_keyboard: groupsToSend.map(g => [{ text: g.text, url: g.url }]) } }
        );
    } else {
        await send('🔵 ברוך הבא ל-Blue Jay Aviation! הבקשה שלך אושרה 🎉\n\nטיסות בטוחות! ✈️');
    }

    return { sheetNote, delivered };
}

/**
 * Shared tail of every admin approval button: approve, stamp the card with
 * who/when/what happened in the sheet, and only post a separate message if
 * the card itself could not be updated.
 */
async function approveAndReport(ctx, applicant, adminId, overrideGroupKeys, mergeMode) {
    const { sheetNote, delivered } = await approveApplicant(applicant, adminId, overrideGroupKeys, mergeMode);
    const deliveryNote = delivered ? '' : '\n⚠️ הודעת האישור לא נמסרה למועמד (ייתכן שחסם את הבוט). כדאי לפנות אליו ישירות.';
    const stamp = `✅ <b>אושר</b> ע"י ${escapeHTML(ctx.from.first_name)} · ${nowIL()}\n${sheetNote}${deliveryNote}`;

    const fresh = await interview.getApplicant(applicant.telegram_id) || applicant;
    if (!fresh.answers?._card && ctx.callbackQuery?.message) {
        fresh.answers = { ...(fresh.answers || {}), _card: { c: ctx.callbackQuery.message.chat.id, m: ctx.callbackQuery.message.message_id } };
    }
    if (await stampCard(fresh, stamp)) return;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    return ctx.reply(`✅ ${escapeHTML(applicantName(applicant))} אושר.\n${sheetNote}${deliveryNote}`, { parse_mode: 'HTML' });
}

/** Completes a retroactive approval (no admin click involved) and notes it on the original card. */
async function approveRetro(applicant) {
    const { sheetNote } = await approveApplicant(applicant, null);
    const fresh = await interview.getApplicant(applicant.telegram_id) || applicant;
    await stampCard(fresh, `✅ <b>אושר בדיעבד</b> · ${nowIL()}\n${sheetNote}`);
}

/** Buttons offered to anyone whose application was declined. */
function appealKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📝 הגשת ערעור', callback_data: 'ap:open' }],
            [{ text: '📞 תיאום שיחה עם מאור', callback_data: 'ap:call' }],
        ],
    };
}

const PREVIOUSLY_REJECTED_MSG =
    '🔵 הבקשה הקודמת שלך לא אושרה, ולכן אי אפשר להגיש בקשה חדשה באופן אוטומטי.\n\n' +
    'אם משהו השתנה מאז (למשל התחלת הכשרה), אפשר להגיש ערעור או לתאם שיחה עם מאור:';

/**
 * `reason`, when given, is shown to the applicant: either one of the
 * REJECT_PRESETS or free text the admin typed in their private chat with the
 * bot and confirmed in a preview. null/undefined means "⏭️ דחייה ללא סיבה".
 * After rejecting, the applicant is put into a listening mode (chat_mode
 * 'rejected_appeal') so a reply they type isn't silently swallowed by the
 * generic menu fallback - it gets relayed to admins and can go back and
 * forth via the bot itself, which (unlike a tg://user?id= link) always
 * works once someone has messaged the bot, regardless of their privacy settings.
 * Returns true when the decline message actually reached the applicant.
 */
async function rejectApplicant(applicant, adminId, reason) {
    await interview.upsertApplicant({
        telegram_id: applicant.telegram_id,
        status: 'rejected',
        decided_by: adminId,
        decided_at: new Date().toISOString(),
    });

    if (applicant.chat_requested) {
        await bot.telegram.declineChatJoinRequest(applicant.chat_requested, applicant.telegram_id).catch(() => {});
    }

    // Keep the reason with the application, so a later appeal or call request shows it to admins
    await interview.upsertApplicant({
        telegram_id: applicant.telegram_id,
        answers: { ...(applicant.answers || {}), _rej_reason: reason || '' },
    });

    const reasonLine = reason ? `\n\n📝 סיבה: ${escapeHTML(reason)}` : '';
    let delivered = true;
    await bot.telegram.sendMessage(applicant.telegram_id,
        `🔵 תודה על הפנייה ל-Blue Jay Aviation.\n\nלצערנו הבקשה לא אושרה בשלב זה.${reasonLine}\n\n` +
        `חושב/ת שטעינו, או שמשהו השתנה? אפשר להגיש ערעור, או לתאם שיחה עם מאור, בכפתורים כאן למטה.`,
        { parse_mode: 'HTML', reply_markup: appealKeyboard() }
    ).catch((e) => {
        console.error('Rejection DM failed:', e.message);
        delivered = false;
    });

    // Upsert (not setUserMode's plain update) so this works even for a legacy
    // chat_join_request applicant who may have no `users` row yet. Only include
    // username/first_name when we actually have a value, so a missing one here
    // doesn't null out something already on file for this user.
    const userPatch = { user_id: applicant.telegram_id, chat_mode: 'rejected_appeal' };
    if (applicant.username) userPatch.username = applicant.username;
    const nameVal = applicant.answers?.name || applicant.tg_first_name;
    if (nameVal) userPatch.first_name = nameVal;
    await supabase.from('users').upsert([userPatch], { onConflict: 'user_id' });

    return delivered;
}

/**
 * Shared tail of every rejection path (preset, no reason, custom text):
 * reject, then stamp the card with who/when/why and whether the applicant
 * actually received the message. Returns the admin-facing summary line.
 */
async function rejectAndReport(ctx, applicant, reason) {
    const delivered = await rejectApplicant(applicant, ctx.from.id, reason);
    const tidStr = String(applicant.telegram_id);
    const deliveryLine = delivered
        ? '📨 ההודעה נמסרה למועמד.'
        : '⚠️ ההודעה לא נמסרה למועמד (ייתכן שחסם את הבוט). כדאי לפנות אליו ישירות.';
    const reasonLine = reason ? `📝 סיבה: ${escapeHTML(reason)}` : '📝 ללא סיבה';
    const stamp = `⛔ <b>נדחה</b> ע"י ${escapeHTML(ctx.from.first_name)} · ${nowIL()}\n${reasonLine}\n${deliveryLine}`;

    const fresh = await interview.getApplicant(applicant.telegram_id) || applicant;
    const stamped = await stampCard(fresh, stamp, REJECTED_CARD_KEYBOARD(tidStr));
    return { delivered, stamped, summary: `⛔ ${escapeHTML(applicantName(applicant))} נדחה.\n${reasonLine}\n${deliveryLine}` };
}

/**
 * Sends the admin a prompt in their PRIVATE chat with the bot and arms the
 * matching input mode. Free text is only ever collected there: the bot does
 * not read text typed in the admin chat, which is how reasons used to get lost.
 * `kind` is 'rejreason' or 'admin_reply'.
 */
async function promptAdminInPrivate(ctx, kind, applicant) {
    const adminId = ctx.from.id;
    const tidStr = String(applicant.telegram_id);
    const name = escapeHTML(applicantName(applicant));
    const prompt = kind === 'rejreason'
        ? `✍️ <b>דחיית ${name}</b>\n\nכתוב/כתבי כאן את הסיבה. לפני שמשהו נשלח למועמד תוצג לך תצוגה מקדימה לאישור.\n\nלביטול: /cancel`
        : `✍️ <b>תשובה ל-${name}</b>\n\nכתוב/כתבי כאן את התשובה. לפני השליחה תוצג לך תצוגה מקדימה לאישור.\n\nלביטול: /cancel`;

    try {
        await bot.telegram.sendMessage(adminId, prompt, { parse_mode: 'HTML' });
    } catch (e) {
        // The admin has never opened a private chat with the bot (or blocked it)
        return ctx.reply(
            `⚠️ ${escapeHTML(ctx.from.first_name)}, לא הצלחתי לשלוח לך הודעה פרטית. פתח/י את הצ'אט הפרטי עם הבוט, לחץ/י Start, ואז נסה/י שוב.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🤖 פתיחת הצ\'אט עם הבוט', url: `https://t.me/${BOT_USERNAME}` }]] } }
        );
    }
    // Upsert, not update: an admin who only ever worked from the admin chat may have no `users` row yet
    await supabase.from('users').upsert([{ user_id: adminId, chat_mode: `${kind}:${tidStr}` }], { onConflict: 'user_id' });

    if (ctx.chat?.type === 'private') {
        // "✏️ כתיבה מחדש" on a preview: retire that preview so its Send button can't fire later
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } else {
        return ctx.reply(
            `✍️ ${escapeHTML(ctx.from.first_name)}, שלחתי לך הודעה בצ'אט הפרטי עם הבוט. הכתיבה נעשית שם.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🤖 מעבר לצ\'אט עם הבוט', url: `https://t.me/${BOT_USERNAME}` }]] } }
        );
    }
}

/**
 * Stores what the admin typed as a draft on the applicant and shows a preview
 * with explicit Send / Rewrite / Cancel buttons. Nothing reaches the applicant
 * until "send" is pressed, so a stray message to the bot can never be mistaken
 * for a rejection reason.
 */
async function previewAdminDraft(ctx, kind, target, text) {
    const tidStr = String(target.telegram_id);
    const body = text.slice(0, MAX_ADMIN_TEXT);
    const draftId = Math.random().toString(36).slice(2, 8);   // ties the preview's buttons to exactly this text
    await interview.upsertApplicant({
        telegram_id: target.telegram_id,
        answers: { ...(target.answers || {}), _draft: { k: kind, t: body, n: draftId, by: ctx.from.id } },
    });
    const name = escapeHTML(applicantName(target));
    const isRej = kind === 'rejreason';
    const head = isRej ? `👀 <b>תצוגה מקדימה: דחיית ${name}</b>\n\n📝 סיבה: ` : `👀 <b>תצוגה מקדימה: תשובה ל-${name}</b>\n\n`;
    const cut = text.length > MAX_ADMIN_TEXT ? `\n\n(הטקסט קוצר ל-${MAX_ADMIN_TEXT} תווים)` : '';
    return ctx.reply(`${head}${escapeHTML(body)}${cut}\n\nלשלוח למועמד?`, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: isRej ? '✅ שליחה ודחייה' : '✅ שליחה', callback_data: `aq:dsend:${tidStr}:${draftId}` }],
                [
                    { text: '✏️ כתיבה מחדש', callback_data: `aq:${isRej ? 'rejother' : 'replyto'}:${tidStr}` },
                    { text: '🔙 ביטול', callback_data: `aq:ddrop:${tidStr}:${draftId}` },
                ],
            ],
        },
    });
}

/**
 * Entry point for any "request to join a group" action - reached either via
 * a bot deep-link (/start join_<key>, e.g. from the channel post) or an
 * in-bot picker button (join_pick:<key>, from getGroupPickerMenu()). Both
 * paths guarantee the user has opened a chat with the bot before any
 * interview DM is attempted - the gap that let a real applicant's join
 * request go unanswered when they never messaged the bot first.
 */
async function startJoinFlow(ctx, key) {
    const group = GROUP_LINKS.find(g => g.key === key);
    if (!group) return ctx.reply('⚠️ קבוצה לא נמצאה, נסה שוב מהתפריט.');

    const userId = ctx.from.id;
    await ensureUserRow(ctx);

    const { data: banned } = await supabase.from('blacklist').select('user_id').eq('user_id', userId).maybeSingle();
    if (banned) return ctx.reply('🚫 You are banned.');

    let applicant = await interview.getApplicant(userId);

    // Previously rejected: no re-interview, offer an appeal or a call with Maor
    if (applicant?.status === 'rejected') {
        return ctx.reply(PREVIOUSLY_REJECTED_MSG, { reply_markup: appealKeyboard() });
    }

    // Already an approved member (e.g. joining another BJA group): straight to the real
    // link - unless their on-file profile doesn't match this group, in which case hold it
    // for a manual check instead of handing it out automatically.
    if (applicant?.status === 'approved') {
        if (interview.isCommercialMismatch(key, applicant.answers?.category)) {
            await notifyAdminGroupMismatch(applicant, key);
            return ctx.reply(interview.GROUP_MISMATCH_NUDGE_EXTRA);
        }
        return ctx.reply(
            `🔵 אתה כבר חבר מאושר בקהילה! לחץ כדי להצטרף ל-${group.text}:`,
            { reply_markup: { inline_keyboard: [[{ text: group.text, url: group.url }]] } }
        );
    }

    // Retro-approved: admit once any missing questions are completed (same mismatch hold
    // applies here, since this path also auto-approves without going through the admin queue)
    if (applicant?.status === 'retro_pending') {
        applicant = await interview.upsertApplicant({
            telegram_id: userId,
            answers: { ...(applicant.answers || {}), requested_group_key: key },
        });
        if (interview.nextQuestion(applicant) === null) {
            if (interview.isCommercialMismatch(key, applicant.answers?.category)) {
                await notifyAdminGroupMismatch(applicant, key);
                await ctx.reply(interview.GROUP_MISMATCH_NUDGE_EXTRA);
            } else {
                await approveRetro(applicant);
            }
        } else {
            await ctx.reply('🔵 כמעט שם! נשארו כמה פרטים קצרים להשלמה:');
            await interview.advance(userId, applicant);
        }
        return;
    }

    // Interview already submitted, still under review
    if (applicant?.status === 'submitted') {
        return ctx.reply('🔵 הבקשה שלך כבר אצל הצוות ותיענה בתוך 24 שעות לכל היותר. תודה על הסבלנות!');
    }

    // New applicant, or resuming an unfinished interview
    const isNew = !applicant;
    applicant = await interview.upsertApplicant({
        telegram_id: userId,
        username: ctx.from.username || null,
        tg_first_name: ctx.from.first_name || null,
        status: 'in_progress',
        answers: { ...(applicant?.answers || {}), requested_group_key: key },
    });
    if (!applicant) return;

    if (isNew) {
        await ctx.reply(
            `👋 היי! שמח/ה שהתעניינת להצטרף ל-${group.text} בקהילת Blue Jay Aviation.\n\n` +
            `Blue Jay Aviation היא קהילה של כ-400 טייסים מקצועיים - ליווי ממנטורים, מאגר ידע, וקשר ישיר לטייסים מובילים בתעופה. (המידע המלא זמין בכפתור "About us" בתפריט בכל שלב)`
        );
        await ctx.reply(interview.INTRO_MSG);
    } else {
        await ctx.reply('🔵 ממשיכים מהיכן שעצרנו:');
    }
    await interview.advance(userId, applicant);
}

bot.on('chat_join_request', async (ctx) => {
    const req = ctx.chatJoinRequest;
    const userId = req.from.id;
    const chatId = req.chat.id;

    try {
        // Banned users: silent decline
        const { data: banned } = await supabase.from('blacklist').select('user_id').eq('user_id', userId).maybeSingle();
        if (banned) return ctx.telegram.declineChatJoinRequest(chatId, userId).catch(() => {});

        let applicant = await interview.getApplicant(userId);

        // Previously rejected: auto-decline, point to @maor_c, no re-interview
        if (applicant?.status === 'rejected') {
            await ctx.telegram.declineChatJoinRequest(chatId, userId).catch(() => {});
            return ctx.telegram.sendMessage(userId, PREVIOUSLY_REJECTED_MSG, { reply_markup: appealKeyboard() }).catch(() => {});
        }

        // Already an approved member (e.g. joining another BJA group): straight in
        if (applicant?.status === 'approved') {
            await ctx.telegram.approveChatJoinRequest(chatId, userId).catch(() => {});
            return ctx.telegram.sendMessage(userId, '🔵 ברוך הבא! אושרת אוטומטית כחבר קהילה קיים ✈️').catch(() => {});
        }

        // Retro-approved: admit; complete any missing questions first
        if (applicant?.status === 'retro_pending') {
            applicant = await interview.upsertApplicant({ telegram_id: userId, chat_requested: chatId });
            if (interview.nextQuestion(applicant) === null) {
                await approveRetro(applicant);
            } else {
                await ctx.telegram.sendMessage(userId, '🔵 כמעט שם! נשארו כמה פרטים קצרים להשלמה:').catch(() => {});
                await interview.advance(userId, applicant);
            }
            return;
        }

        // Interview already submitted, still under review
        if (applicant?.status === 'submitted') {
            await interview.upsertApplicant({ telegram_id: userId, chat_requested: chatId });
            return ctx.telegram.sendMessage(userId,
                '🔵 הבקשה שלך כבר אצל הצוות ותיענה בתוך 24 שעות לכל היותר. תודה על הסבלנות!'
            ).catch(() => {});
        }

        // New applicant (or resuming an unfinished interview)
        applicant = await interview.upsertApplicant({
            telegram_id: userId,
            username: req.from.username || null,
            tg_first_name: req.from.first_name || null,
            chat_requested: chatId,
            status: 'in_progress',
        });

        if (!applicant) return;
        try {
            await ctx.telegram.sendMessage(userId, interview.INTRO_MSG);
        } catch (e) {
            // Most likely cause: this user has never opened a chat with the bot,
            // so Telegram won't let us DM them (403 "bot can't initiate conversation").
            // Don't call interview.advance() - it would just fail silently the same way.
            // Leave their join request pending in Telegram and flag it for a human.
            console.error('Cannot DM applicant:', e.message);
            const name = escapeHTML(req.from.first_name || '');
            const uname = req.from.username ? `@${escapeHTML(req.from.username)}` : 'אין יוזרנייס';
            await bot.telegram.sendMessage(FEEDBACK_CHANNEL_ID,
                `⚠️ <b>לא הצלחנו ליצור קשר עם מועמד חדש</b>\n\n` +
                `👤 ${name} (${uname})\n` +
                `🆔 ${userId}\n\n` +
                `הבקשה שלו נשארת ממתינה בטלגרם, אבל לא הצלחנו לשלוח לו הודעה פרטית - קרוב לוודאי כי הוא מעולם לא פתח שיחה עם הבוט. יש לבקש ממנו (למשל דרך מי שהפנה אותו, או הודעה אישית אם אפשר) ללחוץ קודם /start לבוט, ואז לנסות שוב להצטרף.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }
        await interview.advance(userId, applicant);
    } catch (e) {
        console.error('chat_join_request error:', e);
    }
});


// =============================================================================
// SECTION 3.6: Appeals and call requests from declined applicants
// =============================================================================

const CALL_NOTIFY_GAP_MS = 12 * 60 * 60 * 1000;   // don't re-alert admins more than twice a day per person

async function handleAppealAction(ctx, action) {
    const userId = ctx.from.id;
    const applicant = await interview.getApplicant(userId);
    if (applicant?.status !== 'rejected') {
        return ctx.reply('ℹ️ אין כרגע בקשה שלך שממתינה לערעור.', getExistingUserMenu(ADMINS.includes(userId)));
    }
    const a = applicant.answers || {};

    if (action === 'ap:open') {
        const userPatch = { user_id: userId, chat_mode: 'rejected_appeal' };
        if (ctx.from.username) userPatch.username = ctx.from.username;
        await supabase.from('users').upsert([userPatch], { onConflict: 'user_id' });
        return ctx.reply(
            '📝 כתוב/כתבי כאן את הערעור: מה השתנה, או מה חשוב שנדע. קישור ללינקדאין או לרישיון יעזור לנו.\n\n' +
            'ההודעה תועבר לצוות, ונחזור אליך כאן בצ\'אט.'
        );
    }

    // ap:call
    const last = a._call_at ? Date.parse(a._call_at) : 0;
    const alreadyAsked = last && Date.now() - last < CALL_NOTIFY_GAP_MS;
    if (!alreadyAsked) {
        const reason = a._rej_reason ? escapeHTML(a._rej_reason) : 'ללא סיבה';
        await bot.telegram.sendMessage(FEEDBACK_CHANNEL_ID,
            `📞 <b>בקשה לשיחה עם מאור</b>\n\n` +
            `👤 ${escapeHTML(a.name || ctx.from.first_name || '')} (@${escapeHTML(ctx.from.username || 'אין')})\n` +
            `🆔 ${userId}\n` +
            `💬 <a href="tg://user?id=${userId}">פנייה ישירה למועמד</a>\n` +
            `⛔ הבקשה נדחתה. סיבה: ${reason}\n` +
            `🕒 ${nowIL()}`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '↩️ השב למועמד', callback_data: `aq:replyto:${userId}` }]] },
            }
        ).catch((e) => console.error('call request alert failed:', e.message));
        await interview.upsertApplicant({ telegram_id: userId, answers: { ...a, _call_at: new Date().toISOString() } });
    }
    return ctx.reply(
        alreadyAsked
            ? '📞 הבקשה לשיחה כבר אצל מאור, והוא יחזור אליך. אפשר גם לכתוב לו ישירות:'
            : '📞 העברנו למאור את הבקשה לשיחה, והוא יחזור אליך לתיאום. אפשר גם לכתוב לו ישירות עכשיו:',
        { reply_markup: { inline_keyboard: [[{ text: '💬 כתיבה למאור בטלגרם', url: MAOR_URL }]] } }
    );
}


// =============================================================================
// SECTION 3.7: Member sheet clean-up (admin panel → 🧹)
// Step 1 fills Telegram IDs from the bot's own records and fixes phones saved
// without "+" or the 0. Step 2 walks through suspected duplicates one by one:
// merge, mark as different people, or skip. Nothing changes without a tap, and
// every merged-away row is copied in full to the "Merge Log" tab first.
// All steps are stateless: each button carries what it needs and re-reads the sheet.
// =============================================================================

const shortRow = (v) => {
    const C = matching.COL;
    const parts = [
        v[C.PHONE] || 'בלי טלפון',
        v[C.STATUS] || '',
        v[C.CATEGORY] && v[C.CATEGORY] !== 'Unknown' ? v[C.CATEGORY] : '',
        v[C.LICENSE] || '',
        v[C.TG_ID] ? 'TG ✓' : '',
    ].filter(Boolean);
    return parts.map(x => escapeHTML(String(x))).join(' · ');
};

async function knownApplicantsForBackfill() {
    const { data } = await supabase.from('applicants').select('telegram_id, member_id, answers, status').eq('status', 'approved');
    return (data || []).map(a => ({
        telegramId: a.telegram_id,
        memberId: a.member_id,
        phone: a.answers?.phone || '',
        name: a.answers?.name || '',
    }));
}

async function showBackfillStep(ctx) {
    const plan = await withTimeout(sheets.planBackfill(await knownApplicantsForBackfill()), 8000, 'sheet read');
    if (!plan.tg.length && !plan.phones.length) return showDuplicate(ctx, 0, '✅ שלב 1: אין פרטים להשלים.\n\n');

    const list = (items, fmt) => items.slice(0, 12).map(fmt).join('\n') + (items.length > 12 ? `\n...ועוד ${items.length - 12}` : '');
    let text = '🧹 <b>ניקוי הגיליון, שלב 1 מתוך 2: השלמת פרטים</b>\n\n';
    if (plan.tg.length) {
        text += `🔗 <b>${plan.tg.length} חברים יקבלו Telegram ID</b> מהרשומות של הבוט (כדי שמיזוג לא יאבד את הקישור):\n` +
            list(plan.tg, x => `#${escapeHTML(String(x.memberId))} ${escapeHTML(x.name)}`) + '\n\n';
    }
    if (plan.phones.length) {
        text += `📱 <b>${plan.phones.length} טלפונים יתוקנו</b> (נשמרו בלי + או בלי 0):\n` +
            list(plan.phones, x => `#${escapeHTML(String(x.memberId))} ${escapeHTML(x.from)} ← ${escapeHTML(x.to)}`) + '\n\n';
    }
    if (plan.conflicts.length) {
        text += `⚠️ ${plan.conflicts.length} שורות כבר מחזיקות Telegram ID אחר ולא ישונו.\n\n`;
    }
    text += 'רק תאים ריקים של Telegram ID וטלפונים בפורמט שגוי משתנים. שום שורה לא נמחקת בשלב הזה.';
    return ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [{ text: '✅ ביצוע והמשך לשלב 2', callback_data: 'cl:bf' }],
            [{ text: '⏭️ דילוג לשלב 2', callback_data: 'cl:show:0' }],
        ] },
    });
}

async function showDuplicate(ctx, index, prefix = '') {
    const groups = await withTimeout(sheets.scanDuplicates(), 8000, 'sheet read');
    if (!groups.length) {
        return ctx.reply(`${prefix}✅ <b>לא נמצאו כפילויות.</b> כל אדם מופיע בגיליון פעם אחת.`, { parse_mode: 'HTML' });
    }
    if (index >= groups.length) {
        return ctx.reply(
            `${prefix}🏁 עברת על כל ההצעות. נשארו ${groups.length} שדילגת עליהן, הן יופיעו שוב בפעם הבאה.`,
            { reply_markup: { inline_keyboard: [[{ text: '🔁 מההתחלה', callback_data: 'cl:show:0' }]] } }
        );
    }

    const g = groups[index];
    const ids = g.members.map(m => m.memberId);
    const plan = matching.mergeGroup(g.members, new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem' }));
    const C = matching.COL;
    const v = plan.merged;
    const why = g.evidence.map(e => matching.MATCH_LABELS_HE[e] || e).join(' + ');
    const warn = [];
    if (g.conflicts.includes('telegram') || plan.warnings.includes('two_telegram_accounts')) warn.push('לשתי השורות יש חשבון טלגרם שונה.');
    if (g.conflicts.includes('phone')) warn.push('מספרי הטלפון שונים (אולי החליף מספר).');
    if (g.conflicts.includes('name')) warn.push('אותו טלפון אבל שמות שונים (אולי בן משפחה).');

    const text =
        `${prefix}🧹 <b>שלב 2: כפילות אפשרית ${index + 1} מתוך ${groups.length}</b>\n` +
        `התאמה: ${matching.LEVEL_LABELS_HE[g.level]} · ${escapeHTML(why)}\n\n` +
        g.members.map(m => `<b>#${escapeHTML(String(m.memberId))} ${escapeHTML(m.name)}</b>\n${shortRow(m.values)}`).join('\n\n') +
        `\n\n<b>אחרי מיזוג תישאר שורה #${escapeHTML(String(ids[0]))}</b> (הוותיקה):\n` +
        `${escapeHTML(matching.displayName(v))} · ${shortRow(v)}` +
        (v[C.AUTHORITY] ? `\nרשות: ${escapeHTML(v[C.AUTHORITY])}` : '') +
        (v[C.RATINGS] ? ` · הגדרים: ${escapeHTML(v[C.RATINGS])}` : '') +
        `\nשורה ${ids.slice(1).map(i => '#' + escapeHTML(String(i))).join(', ')} תימחק, ועותק מלא שלה יישמר בלשונית Merge Log.` +
        (warn.length ? `\n\n⚠️ ${warn.join(' ')}` : '');

    const idStr = ids.join('-');
    return ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [{ text: '✅ מיזוג', callback_data: `cl:ok:${index}:${idStr}` }, { text: '🙅 אנשים שונים', callback_data: `cl:diff:${index}:${idStr}` }],
            [{ text: '⏭️ דילוג', callback_data: `cl:show:${index + 1}` }, { text: '⏹️ סיום', callback_data: 'cl:stop' }],
        ] },
    });
}

async function handleCleanupAction(ctx, action) {
    const [, verb, idxStr, idStr] = action.split(':');
    const index = parseInt(idxStr, 10) || 0;
    const next = { inline_keyboard: [[{ text: '➡️ להצעה הבאה', callback_data: `cl:show:${index}` }, { text: '⏹️ סיום', callback_data: 'cl:stop' }]] };

    if (verb === 'start') return showBackfillStep(ctx);
    if (verb === 'show') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return showDuplicate(ctx, index);
    }
    if (verb === 'stop') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return ctx.reply('⏹️ הניקוי הופסק. אפשר להמשיך מתי שרוצים מפאנל הניהול.');
    }
    if (verb === 'bf') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        const plan = await withTimeout(sheets.planBackfill(await knownApplicantsForBackfill()), 8000, 'sheet read');
        await withTimeout(plan.apply(), 8000, 'sheet write');
        return ctx.reply(
            `✅ שלב 1 הושלם: ${plan.tg.length} Telegram ID נוספו, ${plan.phones.length} טלפונים תוקנו.`,
            { reply_markup: { inline_keyboard: [[{ text: '➡️ לשלב 2: כפילויות', callback_data: 'cl:show:0' }]] } }
        );
    }

    const ids = (idStr || '').split('-').filter(Boolean);
    if (ids.length < 2) return ctx.reply('⚠️ הצעה לא תקינה.');
    const by = ctx.from.first_name || String(ctx.from.id);

    if (verb === 'ok') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        // No timeout here: a merge that is cut off half way is safe to repeat, but reporting
        // "failed" while it actually finished would be misleading.
        const res = await sheets.applyMerge(ids, by);
        if (!res.ok) {
            return ctx.reply('ℹ️ ההצעה הזו כבר לא עדכנית (השורות השתנו או כבר מוזגו). שום דבר לא שונה.', { reply_markup: next });
        }
        // The bot's own records pointing at a removed row now point at the kept one
        for (const removed of res.removedIds) {
            await supabase.from('applicants').update({ member_id: parseInt(res.keptId, 10), sheet_row: null }).eq('member_id', parseInt(removed, 10));
        }
        return ctx.reply(
            `✅ מוזג: נשארה שורה #${escapeHTML(res.keptId)}, ושורה ${res.removedIds.map(i => '#' + escapeHTML(i)).join(', ')} נמחקה (עותק בלשונית Merge Log). מוזג ע"י ${escapeHTML(by)}.`,
            { parse_mode: 'HTML', reply_markup: next }
        );
    }
    if (verb === 'diff') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        await withTimeout(sheets.markDifferent(ids, by), 8000, 'sheet write');
        return ctx.reply(
            `🙅 סומן: ${ids.map(i => '#' + escapeHTML(i)).join(', ')} הם אנשים שונים. ההצעה לא תופיע שוב.`,
            { parse_mode: 'HTML', reply_markup: next }
        );
    }
}


// =============================================================================
// SECTION 4: Callback Query Handlers (Button Clicks)
// =============================================================================

bot.on('callback_query', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}

    const action = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const isAdmin = ADMINS.includes(userId);

    // --- Guards (same as text handler; admins bypass the enabled check) ---
    if (!isAdmin) {
        const { data: banned } = await supabase.from('blacklist').select('user_id').eq('user_id', userId).maybeSingle();
        if (banned) return ctx.reply('🚫 You are banned.');

        const enabled = await isBotEnabled();
        if (!enabled) return ctx.reply('🛑 Bot is currently disabled.');
    }

    // --- Interview answers (applicant, or admin in fill mode) ---
    if (action.startsWith('iv:')) {
        try {
            let target = null;
            let fillOpts = {};
            const mode = await getUserMode(userId);
            if (isAdmin && mode?.startsWith('fill:')) {
                target = await interview.getApplicant(parseInt(mode.slice(5)));
                fillOpts = { fillMode: true, adminId: userId };
            } else {
                target = await interview.getApplicant(userId);
            }
            if (!target) return;
            await interview.handleCallback(ctx, target, fillOpts);
        } catch (e) {
            console.error('interview callback error:', e);
        }
        return;
    }

    // --- Declined applicant: appeal or ask for a call with Maor ---
    if (action === 'ap:open' || action === 'ap:call') {
        try {
            return await handleAppealAction(ctx, action);
        } catch (e) {
            console.error('appeal action error:', e);
            return ctx.reply('⚠️ משהו השתבש, נסה/י שוב בעוד רגע.');
        }
    }

    // --- Admin: duplicate clean-up of the member sheet ---
    if (action.startsWith('cl:')) {
        if (!isAdmin) return ctx.reply('❌ Unauthorized.');
        try {
            return await handleCleanupAction(ctx, action);
        } catch (e) {
            console.error('cleanup action error:', e);
            return ctx.reply('⚠️ הפעולה נכשלה (ייתכן שהגיליון לא זמין כרגע). שום דבר לא נמחק. אפשר לנסות שוב.');
        }
    }

    // --- Admin decisions on applicants ---
    if (action.startsWith('aq:')) {
        if (!isAdmin) return ctx.reply('❌ Unauthorized.');
        const [, verb, tidStr, extraArg] = action.split(':');
        const applicant = await interview.getApplicant(parseInt(tidStr));
        if (!applicant) return ctx.reply('⚠️ מועמד לא נמצא.');

        try {
            // --- Approve: default, or overruling the automatic sheet match in either direction ---
            if (verb === 'app' || verb === 'appnew' || verb === 'appmerge') {
                if (applicant.status === 'approved') return ctx.reply('ℹ️ כבר אושר.');
                const mergeMode = verb === 'appnew' ? 'new' : verb === 'appmerge' ? 'merge' : 'auto';
                return approveAndReport(ctx, applicant, userId, null, mergeMode);
            }

            // --- Reject: the card's buttons turn into a reason picker. Nothing is typed in
            // the admin chat, and the card stays actionable until the rejection really happened. ---
            const isRejectVerb = ['rej', 'rejp', 'rejskip', 'rejother'].includes(verb);
            if (isRejectVerb && applicant.status === 'approved') {
                return ctx.reply('ℹ️ המועמד כבר אושר, ולכן אי אפשר לדחות אותו מכאן.');
            }
            if (verb === 'rej') {
                if (applicant.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
                const msg = ctx.callbackQuery.message;
                if (msg) {
                    await interview.upsertApplicant({
                        telegram_id: applicant.telegram_id,
                        answers: { ...(applicant.answers || {}), _card: { c: msg.chat.id, m: msg.message_id } },
                    });
                }
                await ctx.editMessageReplyMarkup(rejectReasonKeyboard(tidStr)).catch(() => {});
                return;
            }
            if (verb === 'rejback') {
                await ctx.editMessageReplyMarkup(interview.pendingCardKeyboard(tidStr, applicant.answers?._match)).catch(() => {});
                return;
            }
            if (verb === 'rejp' || verb === 'rejskip') {
                if (applicant.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
                let reason = null;
                if (verb === 'rejp') {
                    const preset = REJECT_PRESETS.find(p => p.code === extraArg);
                    if (!preset) return ctx.reply('⚠️ סיבה לא מוכרת, נסה שוב.');
                    reason = preset.text;
                }
                const { stamped, summary } = await rejectAndReport(ctx, applicant, reason);
                if (!stamped) {
                    await ctx.editMessageReplyMarkup(REJECTED_CARD_KEYBOARD(tidStr)).catch(() => {});
                    return ctx.reply(summary, { parse_mode: 'HTML' });
                }
                return;
            }
            if (verb === 'rejother') {
                if (applicant.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
                return promptAdminInPrivate(ctx, 'rejreason', applicant);
            }
            if (verb === 'replyto') {
                return promptAdminInPrivate(ctx, 'admin_reply', applicant);
            }

            // --- Preview buttons (in the admin's private chat): send or drop the typed draft ---
            if (verb === 'dsend' || verb === 'ddrop') {
                const draft = applicant.answers?._draft;
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                // The preview carries the id of the draft it shows. If the draft was rewritten
                // (or another admin drafted in the meantime), this preview is out of date.
                if (!draft || draft.n !== extraArg) {
                    return ctx.reply('ℹ️ התצוגה הזו כבר לא עדכנית (הטיוטה נשלחה, בוטלה או נכתבה מחדש). שום דבר לא נשלח.');
                }
                const cleanAnswers = { ...(applicant.answers || {}) };
                delete cleanAnswers._draft;
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: cleanAnswers });
                if (verb === 'ddrop') return ctx.reply('בוטל, שום דבר לא נשלח. ✔️');

                if (draft.k === 'rejreason') {
                    if (applicant.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
                    if (applicant.status === 'approved') return ctx.reply('ℹ️ המועמד אושר בינתיים, הדחייה לא נשלחה.');
                    const { summary } = await rejectAndReport(ctx, { ...applicant, answers: cleanAnswers }, draft.t);
                    return ctx.reply(summary, { parse_mode: 'HTML' });
                }
                let delivered = true;
                await ctx.telegram.sendMessage(applicant.telegram_id,
                    `💬 תגובה מצוות Blue Jay Aviation:\n\n${escapeHTML(draft.t)}`,
                    { parse_mode: 'HTML' }
                ).catch(() => { delivered = false; });
                return ctx.reply(delivered
                    ? '✅ התשובה נמסרה למועמד.'
                    : '⚠️ התשובה לא נמסרה למועמד (ייתכן שחסם את הבוט). כדאי לפנות אליו ישירות.');
            }
            if (verb === 'closeappeal') {
                await supabase.from('users').update({ chat_mode: null }).eq('user_id', applicant.telegram_id);
                await ctx.editMessageReplyMarkup({
                    inline_keyboard: [[{ text: '↩️ השב למועמד', callback_data: `aq:replyto:${tidStr}` }]],
                }).catch(() => {});
                return ctx.reply('✅ הערעור סומן כסגור. הודעות נוספות מהמועמד לא יועברו אוטומטית יותר (אפשר עדיין להשיב ידנית).');
            }
            if (verb === 'retro') {
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, status: 'retro_pending' });
                await ctx.telegram.sendMessage(applicant.telegram_id,
                    '🔵 עדכון מצוות Blue Jay Aviation: בקשתך אושרה!\n\nבחר קבוצה להצטרפות:',
                    getGroupPickerMenu()
                ).catch(() => {});
                return ctx.reply('↩️ המועמד קיבל תפריט בחירת קבוצה להצטרפות. בבחירה הבאה שלו הוא יאושר אוטומטית (כולל השלמת פרטים חסרים אם יש).');
            }
            if (verb === 'fill') {
                await supabase.from('users').upsert([{ user_id: userId, chat_mode: `fill:${tidStr}` }], { onConflict: 'user_id' });
                const missing = interview.nextQuestion(applicant);
                if (!missing) return ctx.reply('ℹ️ אין פרטים חסרים למועמד הזה. אפשר לאשר ישירות.');
                await ctx.telegram.sendMessage(userId, `📋 השלמה ידנית עבור ${applicant.answers?.name || applicant.tg_first_name || tidStr}.\nלביטול בכל שלב: /cancel`).catch(() => {});
                await interview.advance(userId, applicant, { fillMode: true, adminId: userId });
                return ctx.reply('📋 נשלחו אליך השאלות החסרות בצ\'אט הפרטי עם הבוט.');
            }

            // --- Manual group picker on the pending-applicant card ---
            if (verb === 'groups') {
                const initial = applicant.answers?.requested_group_key ? [applicant.answers.requested_group_key] : [];
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: { ...applicant.answers, _admin_pick: initial } });
                await ctx.editMessageReplyMarkup(groupToggleKeyboard(tidStr, initial, 'gconfirm', 'gcancel')).catch(() => {});
                return;
            }
            if (verb === 'gtoggle') {
                // Shared toggle handler for both the pending-applicant picker (gconfirm/gcancel)
                // and the standalone "add existing member" picker (addsend/addcancel) - inferred
                // from whether this applicant is already approved, so each flow keeps its own confirm verb.
                const [confirmVerb, cancelVerb] = applicant.status === 'approved' ? ['addsend', 'addcancel'] : ['gconfirm', 'gcancel'];
                const picks = new Set(applicant.answers?._admin_pick || []);
                picks.has(extraArg) ? picks.delete(extraArg) : picks.add(extraArg);
                const updated = [...picks];
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: { ...applicant.answers, _admin_pick: updated } });
                await ctx.editMessageReplyMarkup(groupToggleKeyboard(tidStr, updated, confirmVerb, cancelVerb)).catch(() => {});
                return;
            }
            if (verb === 'gconfirm') {
                const picks = (applicant.answers?._admin_pick?.length ? applicant.answers._admin_pick
                    : (applicant.answers?.requested_group_key ? [applicant.answers.requested_group_key] : []));
                if (applicant.status === 'approved') return ctx.reply('ℹ️ כבר אושר.');
                const cleanAnswers = { ...applicant.answers };
                delete cleanAnswers._admin_pick;
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: cleanAnswers });
                return approveAndReport(ctx, { ...applicant, answers: cleanAnswers }, userId, picks, 'auto');
            }
            if (verb === 'gcancel') {
                const cleanAnswers = { ...applicant.answers };
                delete cleanAnswers._admin_pick;
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: cleanAnswers });
                await ctx.editMessageReplyMarkup(interview.pendingCardKeyboard(tidStr, cleanAnswers._match)).catch(() => {});
                return;
            }

            // --- Mismatch review card: already-known member requesting a group that doesn't fit ---
            if (verb === 'extra_send') {
                const group = GROUP_LINKS.find(g => g.key === extraArg);
                if (!group) return ctx.reply('⚠️ קבוצה לא נמצאה.');
                await ctx.telegram.sendMessage(applicant.telegram_id,
                    `🔵 מצוות Blue Jay Aviation: הבקשה שלך אושרה, לחץ כדי להצטרף ל-${group.text}:`,
                    { reply_markup: { inline_keyboard: [[{ text: group.text, url: group.url }]] } }
                ).catch(() => {});
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                return ctx.reply('✅ הקישור נשלח.');
            }
            if (verb === 'extra_deny') {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                return ctx.reply('⛔ סומן כ"לא כרגע". אפשר לפנות למועמד ישירות מהכרטיס אם צריך.');
            }

            // --- Standalone "add existing member to group(s)" flow ---
            if (verb === 'addsend') {
                const picks = applicant.answers?._admin_pick || [];
                const groups = picks.map(k => GROUP_LINKS.find(g => g.key === k)).filter(Boolean);
                if (!groups.length) return ctx.reply('⚠️ לא נבחרו קבוצות.');
                const joinLine = groups.length === 1 ? `לחץ כדי להצטרף ל-${groups[0].text}:` : 'לחץ כדי להצטרף לקבוצות:';
                await ctx.telegram.sendMessage(applicant.telegram_id,
                    `🔵 מצוות Blue Jay Aviation: ${joinLine}`,
                    { reply_markup: { inline_keyboard: groups.map(g => [{ text: g.text, url: g.url }]) } }
                ).catch(() => {});
                const cleanAnswers = { ...applicant.answers };
                delete cleanAnswers._admin_pick;
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: cleanAnswers });
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                return ctx.reply('✅ הקישור/ים נשלחו.');
            }
            if (verb === 'addcancel') {
                const cleanAnswers = { ...applicant.answers };
                delete cleanAnswers._admin_pick;
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, answers: cleanAnswers });
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                return;
            }
        } catch (e) {
            console.error('admin queue action error:', e);
            return ctx.reply('⚠️ שגיאה בביצוע הפעולה, נסה שוב.');
        }
    }

    // --- Basic Navigation ---
    if (action === 'back_home') return showHomeMenu(ctx);

    if (action.startsWith('join_pick:')) {
        return startJoinFlow(ctx, action.slice('join_pick:'.length));
    }

    if (action === 'admin') {
        if (!isAdmin) return ctx.reply('❌ You are not authorized.');
        return ctx.reply('🔧 Admin Panel:', getAdminPanel());
    }

    // --- First-time Flow ---
    if (action === 'ft_about') {
        return ctx.reply(
            `🔵 <b>‏Blue Jay Aviation - הבית של הטייסים</b>

‏Blue Jay Aviation הוקמה בנובמבר 2023 ע״י נעמי סחייק ומאור כהן - וגדלה מקבוצה קטנה ואיכותית של טייסים ישראלים מכל העולם, לקבוצה של כ-400 טייסים מקצועיים שעברו סינון ויוצרים ביחד את הבית של הטייסים.

מה מקבלים בפנים:

🤝 ליווי אישי ממנטורים עתירי ניסיון - מכל רחבי הגלובוס, הסוגים וההפעלות המסחריות.
<a href="https://www.bluejayaviation.net/he/mentors">לחצו כאן לקריאה עוד</a>

📚 מאגר ידע בלתי מוגבל - כל הידע, הדיונים והשאלות שנשאלו פתוחים לכם, לקריאה, למידה והעשרת הידע המקצועי.

✈️ קשר ישיר לטייסים המובילים את התעופה בישראל ובעולם - מגייסים, מראיינים, קפטנים בוחנים, מדריכי טיסה ועוד.

🔒 סביבה בטוחה ומאומתת - כל המידע נשאר בקהילה, וכל החברים עברו אימות איכותי.

❤️ קהילה אמיתית שתומכת אחד בשנייה לאורך כל הקריירה - עם מטרה משותפת אחת: להעשיר ולקבל בחזרה.

טיסות בטוחות ✈️
‏Blue Jay Aviation - הבית של הטייסים`,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
    }
    if (action === 'ft_rules') {
        return ctx.reply(
            `📜 <b>כללי הקהילה</b>

1️⃣ כבוד הדדי - זו קהילה מקצועית, בלי דרמות
2️⃣ בלי ספאם או פרסומות ללא אישור מראש
3️⃣ סודיות - מה שנאמר בקהילה נשאר בקהילה
4️⃣ בלי דוקסינג או שיתוף פרטים אישיים של חברים אחרים
5️⃣ החברות מיועדת לטייסים שכבר בתהליך מקצועי לקראת רישיון מסחרי

הפרות יטופלו על ידי הצוות, ובמקרים חמורים עלולות להוביל להרחקה מהקהילה.

💬 יש שאלה או משהו לא ברור? פנו לאחד האדמינים, או <a href="tg://user?id=382965373">לחצו כאן ליצירת קשר ישיר עם מאור</a>.`,
            { parse_mode: 'HTML' }
        );
    }
    if (action === 'ft_join') {
        return ctx.reply('🛫 Choose the group you want to request joining:', getGroupPickerMenu());
    }

    // --- User Features ---
    if (action === 'ex_anon') {
        await setUserMode(userId, 'anon_pending_approval');
        return ctx.reply('📝 Type your anonymous question.\n\nIt will be reviewed by an admin before being published.');
    }
    if (action === 'feedback') {
        await setUserMode(userId, 'feedback');
        return ctx.reply('💬 Please leave your feedback:');
    }
    if (action === 'ex_contact') {
        await setUserMode(userId, 'contact_waiting');
        return ctx.reply('☎️ Please type your message and we’ll get back to you:');
    }
    if (action === 'ex_premium') {
        return ctx.reply('💎 Bluejay Premium:\n\n(Onboarding info pending)');
    }
    if (action === 'ex_crm') {
        await setUserMode(userId, 'crm_waiting');
        return ctx.reply('🧾 Update pilot info:\n\nSend your details in this format:\nName:\nLicense:\nAircraft/Type:\nBase:\nNotes:');
    }

    // --- Admin Queue Handling ---
    if (action.startsWith('q_approve:') || action.startsWith('q_reject:')) {
        if (!isAdmin) return ctx.reply('❌ Unauthorized.');

        const [verb, queueId] = action.split(':');
        const isApproval = verb === 'q_approve';

        const { data: row } = await supabase.from('queue').select('*').eq('id', queueId).maybeSingle();
        if (!row) return ctx.reply('⚠️ Item not found.');
        if (row.status !== 'pending') return ctx.reply(`ℹ️ Already ${row.status}.`);

        if (isApproval) {
            // No escape here because the question should be clean for the group, or we escape it when publishing
            await ctx.telegram.sendMessage(GROUP_ID, row.message, { message_thread_id: TOPIC_ID });
            await supabase.from('queue').update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString() }).eq('id', queueId);
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
            return ctx.reply(`✅ Published.`);
        } else {
            await supabase.from('queue').update({ status: 'rejected', approved_by: userId, approved_at: new Date().toISOString() }).eq('id', queueId);
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
            return ctx.reply(`⛔ Rejected.`);
        }
    }

    // --- Admin Panel Actions ---
    if (!isAdmin) return;

    switch (action) {
        case 'admin_on':
            await setBotEnabled(true);
            return ctx.reply('✅ Bot enabled.');
        case 'admin_off':
            await setBotEnabled(false);
            return ctx.reply('🛑 Bot disabled.');
        case 'admin_status':
            const enabled = await isBotEnabled();
            return ctx.reply(`Status: ${enabled ? '🟢 Enabled' : '🔴 Disabled'}`);
        case 'admin_fetch': {
            const { data } = await supabase.from('messages').select('*').limit(5).order('created_at', { ascending: false });
            if (!data?.length) return ctx.reply('📭 Empty.');
            const formatted = data.map((r, i) => `#${i + 1} - ${escapeHTML(r.username)}:\n${escapeHTML(r.message)}`).join('\n\n');
            return ctx.reply(`📝 Last 5 Legacy Messages:\n\n${formatted}`, { parse_mode: 'HTML' });
        }
        case 'admin_clean':
            await supabase.from('messages').delete().not('id', 'is', null);
            return ctx.reply('🧹 Legacy messages cleaned.');
        case 'admin_ban':
            await setUserMode(userId, 'ban_waiting');
            return ctx.reply('🚫 Enter user ID to ban:');
        case 'admin_addgroup':
            await setUserMode(userId, 'addgroup_waiting');
            return ctx.reply('✍️ שלח/י Telegram ID או @username של החבר להוספה לקבוצה:');
        case 'admin_links':
            const linkText = `🔵 ברוכים הבאים לערוץ <b>Blue Jay Aviation</b>!\n\n📌 <b>הקבוצות שלנו</b> - לחצו על הקבוצה שמעניינת אתכם כדי להתחיל תהליך הצטרפות קצר דרך הבוט:\n\nטיסות בטוחות! ✈️`;
            await ctx.telegram.sendMessage(parseInt(CHANNEL_ID), linkText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: GROUP_LINKS.map(g => [{ text: g.text, url: `https://t.me/${BOT_USERNAME}?start=join_${g.key}` }])
                }
            });
            return ctx.reply('✅ Links posted to channel.');
    }
});


// =============================================================================
// SECTION 5: Text Message Handlers
// =============================================================================

bot.start(async (ctx) => {
    const payload = ctx.startPayload; // text after "/start ", e.g. join_lounge from a deep-link
    if (payload && payload.startsWith('join_')) {
        const key = payload.slice('join_'.length);
        if (GROUP_LINKS.some(g => g.key === key)) {
            return startJoinFlow(ctx, key);
        }
    }
    return showHomeMenu(ctx);
});

bot.on(message('text'), async (ctx) => {
    if (ctx.message.chat.type !== 'private') return;

    const enabled = await isBotEnabled();
    if (!enabled) return ctx.reply('🛑 Bot is currently *disabled*.');

    const { id: userId, username } = ctx.from;
    const mode = await getUserMode(userId);
    const text = ctx.message.text?.trim();

    // --- Blacklist Check ---
    const { data: banned } = await supabase.from('blacklist').select('user_id').eq('user_id', userId).maybeSingle();
    if (banned) return ctx.reply('🚫 You are banned.');

    // --- Flow: Admin fill mode (completing an applicant's details) ---
    if (ADMINS.includes(userId) && mode?.startsWith('fill:')) {
        if (text === '/cancel') {
            await setUserMode(userId, null);
            return ctx.reply('בוטל. ✔️');
        }
        const target = await interview.getApplicant(parseInt(mode.slice(5)));
        if (target) {
            const consumed = await interview.handleText(ctx, target, text, { fillMode: true, adminId: userId });
            if (consumed) return;
        }
    }

    // --- Flow: Admin typing a custom rejection reason, or a reply to a rejected applicant.
    // Both are armed by a button (promptAdminInPrivate) and both only produce a PREVIEW
    // here: nothing reaches the applicant until the admin presses "send" on it. ---
    if (ADMINS.includes(userId) && (mode?.startsWith('rejreason:') || mode?.startsWith('admin_reply:'))) {
        const [kind, tidPart] = mode.split(':');
        await setUserMode(userId, null);
        if (text === '/cancel') return ctx.reply('בוטל, שום דבר לא נשלח. ✔️');
        const target = await interview.getApplicant(parseInt(tidPart));
        if (!target) return ctx.reply('⚠️ מועמד לא נמצא.');
        if (kind === 'rejreason' && target.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
        return previewAdminDraft(ctx, kind, target, text);
    }

    // --- Flow: Join interview (free-text answers) ---
    {
        const applicant = await interview.getApplicant(userId);
        if (applicant?.state) {
            const consumed = await interview.handleText(ctx, applicant, text, {});
            if (consumed) return;
        }
    }

    // --- Flow: Anonymous Question Submission ---
    if (mode === 'anon_pending_approval') {
        const { data, error } = await supabase.from('queue').insert([{
            type: 'anon_question',
            status: 'pending',
            user_id: userId,
            username,
            message: text,
        }]).select().single();

        if (error) return ctx.reply('⚠️ Submission failed.');

        const dateStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const adminNotify = `⏳ <b>Pending Question</b>\n\n🆔 User: ${userId} (@${escapeHTML(username)})\n🕒 Date: ${dateStr}\n\n💬 ${escapeHTML(text)}`;

        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, adminNotify, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Approve', callback_data: `q_approve:${data.id}` },
                    { text: '⛔ Reject', callback_data: `q_reject:${data.id}` },
                ]]
            }
        });

        await setUserMode(userId, null);
        return ctx.reply('✅ Submitted for review. It will be published if approved.');
    }

    // --- Flow: Feedback ---
    if (mode === 'feedback') {
        const dateStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const report = `📝 <b>Feedback</b>\n\n👤 From: ${escapeHTML(ctx.from.first_name)} (@${escapeHTML(username)})\n🆔 ID: ${userId}\n🕒 Date: ${dateStr}\n\n💬 ${escapeHTML(text)}`;
        
        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, report, { parse_mode: 'HTML' });
        await setUserMode(userId, null);
        return ctx.reply('✅ Thank you! Feedback submitted.');
    }

    // --- Flow: Contact Support ---
    if (mode === 'contact_waiting') {
        const dateStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const report = `☎️ <b>Contact Request</b>\n\n👤 From: ${escapeHTML(ctx.from.first_name)} (@${escapeHTML(username)})\n🕒 Date: ${dateStr}\n\n💬 ${escapeHTML(text)}`;
        
        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, report, { parse_mode: 'HTML' });
        await setUserMode(userId, null);
        return ctx.reply('✅ Message sent to admins.');
    }

    // --- Flow: Pilot Info Update (CRM) ---
    if (mode === 'crm_waiting') {
        const { error } = await supabase.from('queue').insert([{
            type: 'crm_update',
            status: 'pending',
            user_id: userId,
            username,
            message: text,
        }]);

        if (error) {
            console.error('CRM insert error:', error.message);
            return ctx.reply('⚠️ Submission failed. Please try again.');
        }

        const dateStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const report = `🧾 <b>Pilot Info Update</b>\n\n👤 From: ${escapeHTML(ctx.from.first_name)} (@${escapeHTML(username)})\n🆔 ID: ${userId}\n🕒 Date: ${dateStr}\n\n💬 ${escapeHTML(text)}`;

        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, report, { parse_mode: 'HTML' });
        await setUserMode(userId, null);
        return ctx.reply('✅ Thanks! Your info was sent to the team and will be updated in our records.');
    }

    // --- Flow: Reply from a rejected applicant (set by rejectApplicant) - stays open for
    // ongoing back-and-forth until an admin taps "✅ סגור ערעור" on a review card. ---
    if (mode === 'rejected_appeal') {
        const target = await interview.getApplicant(userId);
        const dateStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const report =
            `🔁 <b>תגובה לדחייה</b>\n\n` +
            `👤 ${escapeHTML(target?.answers?.name || ctx.from.first_name)} (@${escapeHTML(username || 'אין')})\n` +
            `🆔 ${userId}\n` +
            `💬 <a href="tg://user?id=${userId}">פנייה ישירה</a>\n` +
            `🕒 ${dateStr}\n\n${escapeHTML(text)}`;
        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, report, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '↩️ השב למועמד', callback_data: `aq:replyto:${userId}` },
                    { text: '✅ סגור ערעור', callback_data: `aq:closeappeal:${userId}` },
                ]],
            },
        });
        return ctx.reply('✅ ההודעה נשלחה לצוות, ניצור איתך קשר בהקדם.');
    }

    // --- Flow: Admin Ban Action ---
    if (mode === 'ban_waiting' && ADMINS.includes(userId)) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) return ctx.reply('⚠️ Invalid ID.');
        await supabase.from('blacklist').upsert([{ user_id: targetId }]);
        await setUserMode(userId, null);
        return ctx.reply(`✅ User ${targetId} banned.`);
    }

    // --- Flow: Admin "add existing member to group(s)" - standalone, any time, not tied to the approval queue ---
    if (mode === 'addgroup_waiting' && ADMINS.includes(userId)) {
        await setUserMode(userId, null);
        const target = await resolveApprovedApplicant(text);
        if (!target) return ctx.reply('⚠️ לא נמצא חבר מאושר עם המזהה הזה.');
        await interview.upsertApplicant({ telegram_id: target.telegram_id, answers: { ...target.answers, _admin_pick: [] } });
        return ctx.reply(
            `🔀 בחירת קבוצות עבור ${target.answers?.name || target.tg_first_name || target.telegram_id}:`,
            { reply_markup: groupToggleKeyboard(String(target.telegram_id), [], 'addsend', 'addcancel') }
        );
    }

    // Default: Show Menu
    ctx.reply('Please choose an option from the menu:', getExistingUserMenu(ADMINS.includes(userId)));
});


// =============================================================================
// SECTION 6: Media Handlers & Lifecycle
// =============================================================================

// Shared contact = phone answer during the join interview
bot.on(message('contact'), async (ctx) => {
    if (ctx.message.chat.type !== 'private') return;
    try {
        const userId = ctx.from.id;
        const mode = await getUserMode(userId);
        let target, fillOpts = {};
        if (ADMINS.includes(userId) && mode?.startsWith('fill:')) {
            target = await interview.getApplicant(parseInt(mode.slice(5)));
            fillOpts = { fillMode: true, adminId: userId };
        } else {
            target = await interview.getApplicant(userId);
        }
        if (target) await interview.handleContact(ctx, target, fillOpts);
    } catch (e) {
        console.error('contact handler error:', e);
    }
});

const rejectMedia = async (ctx) => {
    if (ctx.message.chat.type === 'private') ctx.reply('Text messages only, please!');
};

bot.on(message('photo'), rejectMedia);
bot.on(message('video'), rejectMedia);
bot.on(message('voice'), rejectMedia);
bot.on(message('document'), rejectMedia);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

exports.bot = bot;
exports.handler = async event => {
    try {
        await bot.handleUpdate(JSON.parse(event.body));
    } catch (e) {
        // Always return 200: a non-2xx response makes Telegram re-deliver the
        // same update repeatedly, causing duplicate processing.
        console.error('Webhook error:', e);
    }
    return { statusCode: 200, body: "" };
};
