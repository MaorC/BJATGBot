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
 * Escapes characters for Telegram HTML parse_mode.
 */
function escapeHTML(str) {
  if (!str) return 'N/A';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


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
function getExistingUserMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❓ Ask anonymously', callback_data: 'ex_anon' }],
        [{ text: '🗣️ Send Feedback', callback_data: 'feedback' }],
        [{ text: '💎 Bluejay Premium', callback_data: 'ex_premium' }],
        [{ text: '🧾 Update pilot info', callback_data: 'ex_crm' }],
        [{ text: '☎️ Contact us', callback_data: 'ex_contact' }],
        [{ text: '⚙️ Admin Panel', callback_data: 'admin' }],
      ],
    },
  };
}

/**
 * Direct Telegram invite links for community groups.
 */
function getJoinGroupsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛋️ Lounge', url: 'https://t.me/+V2SBxQBz0Z9hOWQ0' }],
        [{ text: '✈️ Commercial Aviation', url: 'https://t.me/+OszqxsBH8vY0NjBk' }],
        [{ text: '🧑‍🏫 Flight Instructors', url: 'https://t.me/+swR-eigAntViN2I0' }],
        [{ text: '👨‍✈️ Cadet Pilots', url: 'https://t.me/+8ynMfyN0zzZlNDlk' }],
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
    { ...getExistingUserMenu(), parse_mode: 'HTML' }
  );
}


// =============================================================================
// SECTION 4: Callback Query Handlers (Button Clicks)
// =============================================================================

bot.on('callback_query', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    
    const action = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    // --- Basic Navigation ---
    if (action === 'back_home') return showHomeMenu(ctx);
    
    if (action === 'admin') {
        if (!ADMINS.includes(userId)) return ctx.reply('❌ You are not authorized.');
        return ctx.reply('🔧 Admin Panel:', getAdminPanel());
    }

    // --- First-time Flow ---
    if (action === 'ft_about') {
        return ctx.reply(
            `ℹ️ <b>About us</b>\n\nBlue Jay Aviation is a community for Israeli pilots — professional, helpful, and drama-free.\n\n(Final content pending)`,
            { parse_mode: 'HTML' }
        );
    }
    if (action === 'ft_rules') {
        return ctx.reply(
            `📜 <b>Community Rules</b>\n\n1) Be respectful\n2) No spam\n3) Keep it professional\n4) No doxxing\n\n(Final content pending)`,
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
        if (!ADMINS.includes(userId)) return ctx.reply('❌ Unauthorized.');

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
    if (!ADMINS.includes(userId)) return;

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
            const linkText = `ברוכים הבאים לערוץ <b>Blue Jay Aviation</b>!\n\n📌 <b>הקבוצות שלנו:</b> ...`; 
            await ctx.telegram.sendMessage(parseInt(CHANNEL_ID), linkText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: ' Couch Lounge', url: 'https://t.me/+V2SBxQBz0Z9hOWQ0' }],
                        [{ text: ' Airplane Commercial Aviation', url: 'https://t.me/+OszqxsBH8vY0NjBk' }],
                        [{ text: ' Teacher Flight Instructors', url: 'https://t.me/+swR-eigAntViN2I0' }],
                        [{ text: ' Pilot Cadet Pilots', url: 'https://t.me/+8ynMfyN0zzZlNDlk' }]
                    ]
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

    // --- Flow: Admin Ban Action ---
    if (mode === 'ban_waiting' && ADMINS.includes(userId)) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) return ctx.reply('⚠️ Invalid ID.');
        await supabase.from('blacklist').upsert([{ user_id: targetId }]);
        await setUserMode(userId, null);
        return ctx.reply(`✅ User ${targetId} banned.`);
    }

    // Default: Show Menu
    ctx.reply('Please choose an option from the menu:', getExistingUserMenu());
});


// =============================================================================
// SECTION 6: Media Handlers & Lifecycle
// =============================================================================

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
        return { statusCode: 200, body: "" };
    } catch (e) {
        return { statusCode: 400, body: "Webhook Error" };
    }
};
