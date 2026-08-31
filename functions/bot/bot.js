/**
 * Blue Jay Aviation - Anonymous Forwarding Bot
 * 
 * Flow Overview:
 * 1. Users start the bot and are identified as first-time or existing users.
 * 2. Navigation is handled via inline keyboards and state stored in Supabase (chat_mode).
 * 3. Anonymous questions are queued for admin approval before being published to the main group.
 * 4. Join requests are now handled natively by Telegram via direct invite links.
 */

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const sheets = require('./sheets');
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

/**
 * Single source of truth for community group invite links.
 * Used by both the join menu and the channel links post.
 */
const GROUP_LINKS = [
  { text: '🛋️ Lounge', url: 'https://t.me/+V2SBxQBz0Z9hOWQ0' },
  { text: '✈️ Commercial Aviation', url: 'https://t.me/+OszqxsBH8vY0NjBk' },
  { text: '🧑‍🏫 Flight Instructors', url: 'https://t.me/+swR-eigAntViN2I0' },
  { text: '👨‍✈️ Cadet Pilots', url: 'https://t.me/+8ynMfyN0zzZlNDlk' },
  { text: '💪 Fit2Fly (Fitness Squad)', url: 'https://t.me/+JGTG3PlkZ1M3ODRk' },
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
});


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
 * Direct Telegram invite links for community groups.
 */
function getJoinGroupsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...GROUP_LINKS.map(link => [link]),
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
 * Writes the applicant to the BJA Members sheet (update if a row already
 * exists), admits them to the requested group, and notifies them.
 * Sheet failures never lose data: answers stay in Supabase and admins are told.
 */
async function approveApplicant(applicant, adminId) {
    const tid = applicant.telegram_id;
    let sheetNote = '';

    try {
        const row = interview.buildSheetRow(applicant);
        if (applicant.sheet_row) {
            row[0] = String(applicant.member_id || '');
            await sheets.updateMemberRow(applicant.sheet_row, row);
        } else {
            const { memberId, rowNumber } = await sheets.appendMemberRow(row);
            await interview.upsertApplicant({ telegram_id: tid, member_id: memberId, sheet_row: rowNumber });
        }
    } catch (e) {
        console.error('Sheets write failed:', e.message);
        sheetNote = '\n⚠️ הכתיבה לגיליון נכשלה - הנתונים שמורים ב-Supabase, יש להעתיק ידנית.';
    }

    if (applicant.chat_requested) {
        await bot.telegram.approveChatJoinRequest(applicant.chat_requested, tid).catch(e =>
            console.error('approveChatJoinRequest failed:', e.message));
    }

    await interview.upsertApplicant({
        telegram_id: tid,
        status: 'approved',
        decided_by: adminId || null,
        decided_at: new Date().toISOString(),
    });

    await bot.telegram.sendMessage(tid,
        '🔵 ברוך הבא ל-Blue Jay Aviation! הבקשה שלך אושרה 🎉\n\nטיסות בטוחות! ✈️'
    ).catch(() => {});

    return sheetNote;
}

async function rejectApplicant(applicant, adminId) {
    await interview.upsertApplicant({
        telegram_id: applicant.telegram_id,
        status: 'rejected',
        decided_by: adminId,
        decided_at: new Date().toISOString(),
    });

    if (applicant.chat_requested) {
        await bot.telegram.declineChatJoinRequest(applicant.chat_requested, applicant.telegram_id).catch(() => {});
    }

    await bot.telegram.sendMessage(applicant.telegram_id,
        '🔵 תודה על הפנייה ל-Blue Jay Aviation.\n\nלצערנו הבקשה לא אושרה בשלב זה. לבירור או ערעור - <a href="tg://user?id=382965373">לחצו כאן לפנייה ישירה למאור</a>',
        { parse_mode: 'HTML' }
    ).catch(() => {});
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
            return ctx.telegram.sendMessage(userId,
                '🔵 בקשתך סורבה בעבר ולכן לא ניתן להגיש בקשה נוספת.\n\nלבירור - <a href="tg://user?id=382965373">לחצו כאן לפנייה ישירה למאור</a>',
                { parse_mode: 'HTML' }
            ).catch(() => {});
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
                await approveApplicant(applicant, null);
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
        await ctx.telegram.sendMessage(userId, interview.INTRO_MSG).catch(e => {
            console.error('Cannot DM applicant:', e.message);
        });
        await interview.advance(userId, applicant);
    } catch (e) {
        console.error('chat_join_request error:', e);
    }
});


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

    // --- Admin decisions on applicants ---
    if (action.startsWith('aq:')) {
        if (!isAdmin) return ctx.reply('❌ Unauthorized.');
        const [, verb, tidStr] = action.split(':');
        const applicant = await interview.getApplicant(parseInt(tidStr));
        if (!applicant) return ctx.reply('⚠️ מועמד לא נמצא.');

        try {
            if (verb === 'app') {
                if (applicant.status === 'approved') return ctx.reply('ℹ️ כבר אושר.');
                const note = await approveApplicant(applicant, userId);
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
                return ctx.reply(`✅ ${applicant.answers?.name || tidStr} אושר ונוסף לגיליון.${note}`);
            }
            if (verb === 'rej') {
                if (applicant.status === 'rejected') return ctx.reply('ℹ️ כבר סורב.');
                await rejectApplicant(applicant, userId);
                await ctx.editMessageReplyMarkup({
                    inline_keyboard: [[
                        { text: '↩️ אשר בדיעבד', callback_data: `aq:retro:${tidStr}` },
                        { text: '📋 השלמה ידנית', callback_data: `aq:fill:${tidStr}` },
                    ]],
                }).catch(() => {});
                return ctx.reply(`⛔ ${applicant.answers?.name || tidStr} סורב. ניתן לאשר בדיעבד מהכרטיס.`);
            }
            if (verb === 'retro') {
                await interview.upsertApplicant({ telegram_id: applicant.telegram_id, status: 'retro_pending' });
                await ctx.telegram.sendMessage(applicant.telegram_id,
                    '🔵 עדכון מצוות Blue Jay Aviation: בקשתך אושרה!\n\nבחר קבוצה להצטרפות:',
                    getJoinGroupsMenu()
                ).catch(() => {});
                return ctx.reply('↩️ המועמד קיבל לינק הצטרפות. בכניסה הבאה שלו הוא יאושר אוטומטית (כולל השלמת פרטים חסרים אם יש).');
            }
            if (verb === 'fill') {
                await supabase.from('users').upsert([{ user_id: userId, chat_mode: `fill:${tidStr}` }], { onConflict: 'user_id' });
                const missing = interview.nextQuestion(applicant);
                if (!missing) return ctx.reply('ℹ️ אין פרטים חסרים למועמד הזה. אפשר לאשר ישירות.');
                await ctx.telegram.sendMessage(userId, `📋 השלמה ידנית עבור ${applicant.answers?.name || applicant.tg_first_name || tidStr}.\nלביטול בכל שלב: /cancel`).catch(() => {});
                await interview.advance(userId, applicant, { fillMode: true, adminId: userId });
                return ctx.reply('📋 נשלחו אליך השאלות החסרות בצ\'אט הפרטי עם הבוט.');
            }
        } catch (e) {
            console.error('admin queue action error:', e);
            return ctx.reply('⚠️ שגיאה בביצוע הפעולה, נסה שוב.');
        }
    }

    // --- Basic Navigation ---
    if (action === 'back_home') return showHomeMenu(ctx);
    
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
        return ctx.reply('🛫 Choose the group you want to request joining:', getJoinGroupsMenu());
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
        case 'admin_links':
            const linkText = `🔵 ברוכים הבאים לערוץ <b>Blue Jay Aviation</b>!\n\n📌 <b>הקבוצות שלנו</b> - לחצו על הכפתורים למטה כדי להצטרף:\n\nטיסות בטוחות! ✈️`;
            await ctx.telegram.sendMessage(parseInt(CHANNEL_ID), linkText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: GROUP_LINKS.map(link => [link])
                }
            });
            return ctx.reply('✅ Links posted to channel.');
    }
});


// =============================================================================
// SECTION 5: Text Message Handlers
// =============================================================================

bot.start(async (ctx) => showHomeMenu(ctx));

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

    // --- Flow: Admin Ban Action ---
    if (mode === 'ban_waiting' && ADMINS.includes(userId)) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) return ctx.reply('⚠️ Invalid ID.');
        await supabase.from('blacklist').upsert([{ user_id: targetId }]);
        await setUserMode(userId, null);
        return ctx.reply(`✅ User ${targetId} banned.`);
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
