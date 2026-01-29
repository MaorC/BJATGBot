const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const TOPIC_ID = parseInt(process.env.TOPIC_ID);
const ADMINS = process.env.ADMINS.split(',').map(id => parseInt(id.trim()));
const FEEDBACK_CHANNEL_ID = process.env.FEEDBACK_CHANNEL_ID;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SUPA_TABLE = process.env.SUPABASE_TABLE;
const SUPA_KEY = process.env.SUPABASE_KEY_NAME;

// --- State Management Helpers ---

async function getUserMode(userId) {
  const { data } = await supabase
    .from('users')
    .select('chat_mode')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.chat_mode || null;
}

async function setUserMode(userId, mode) {
  // We assume user row exists (ensureUserRow handles creation)
  // But upsert is safer if order of ops varies
  await supabase
    .from('users')
    .update({ chat_mode: mode })
    .eq('user_id', userId);
}

// function getMainMenu() {
//     return {
//         reply_markup: {
//             inline_keyboard: [
//                 [{ text: '✉️ Send Anonymous Message', callback_data: 'anon' }],
//                 [{ text: '🗣️ Send Feedback', callback_data: 'feedback' }],
//                 [{ text: '⚙️ Admin Panel', callback_data: 'admin' }]
//             ]
//         }
//     };
// }

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

function getJoinGroupsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛋️ Lounge', callback_data: 'join_lounge' }],
        [{ text: '✈️ Commercial Aviation', callback_data: 'join_commercial' }],
        [{ text: '🧑‍🏫 Flight Instructors', callback_data: 'join_instructors' }],
        [{ text: '👨‍✈️ Cadet Pilots', callback_data: 'join_cadets' }],
        [{ text: '🔙 Back', callback_data: 'back_home' }],
      ],
    },
  };
}

// small helper: decide if first-time user
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

async function showHomeMenu(ctx) {
  // Clear any existing mode in DB
  await setUserMode(ctx.from.id, null);

  const { isFirstTime } = await ensureUserRow(ctx);

  if (isFirstTime) {
    return ctx.reply(
      '👋 Welcome! Choose an option:',
      { ...getFirstTimeMenu(), parse_mode: 'Markdown' }
    );
  }

  return ctx.reply(
    '👋 Welcome back! What would you like to do?',
    { ...getExistingUserMenu(), parse_mode: 'Markdown' }
  );
}

function getAdminPanel() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 On', callback_data: 'admin_on' }, { text: '⛔ Off', callback_data: 'admin_off' }],
                [{ text: '📊 Status', callback_data: 'admin_status' }],
                [{ text: '📥 Fetch', callback_data: 'admin_fetch' }, { text: '🧹 Clean', callback_data: 'admin_clean' }],
                [{ text: '🚫 Ban user', callback_data: 'admin_ban' }],
                [{ text: '🔗 Links', callback_data: 'admin_links' }],
                [{ text: '🔙 Back to Main Menu', callback_data: 'back_to_main' }]
            ]
        }
    };
}


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

async function setBotEnabled(state) {
    const { error } = await supabase
        .from(SUPA_TABLE)
        .update({ value: String(state) })
        .eq('key', SUPA_KEY);

    if (error) {
        console.error("Supabase write error:", error.message);
    }
}

bot.on('callback_query', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const action = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    if (action === 'anon' || action === 'feedback') {
        await setUserMode(userId, action);
        const prompt = action === 'anon' ? '📝 Please type your anonymous message:\n\n⚠️ Warning: This bot is actively monitored. Misuse — including spam, offensive language, or abuse — will result in permanent removal and blocking of the user. Please use responsibly.' : '💬 Please leave your feedback:';
        return ctx.reply(prompt);
    }

    if (action === 'admin') {
        if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ You are not authorized.');
        return ctx.reply('🔧 Admin Panel:', getAdminPanel());
    }
    if (action === 'back_to_main') {
        await setUserMode(userId, null);
        return ctx.reply('Please choose an option from the menu to proceed:', getExistingUserMenu());
    }


    // universal back button
    if (action === 'back_home') {
        return showHomeMenu(ctx);
    }

    // ===== First-time menu =====
    if (action === 'ft_about') {
    return ctx.reply(
        `ℹ️ *About us*\n\nBlue Jay Aviation is a community for Israeli pilots — professional, helpful, and drama-free.\n\n(put your final “about us” text here)`,
        { parse_mode: 'Markdown' }
    );
    }

    if (action === 'ft_rules') {
        return ctx.reply(
            `📜 *Community Rules*\n\n1) Be respectful\n2) No spam\n3) Keep it professional\n4) No doxxing\n\n(put your final rules here)`,
            { parse_mode: 'Markdown' }
        );
    }

    if (action === 'ft_join') {
        await setUserMode(userId, 'join_select');
        return ctx.reply('🛫 Choose the group you want to request joining:', getJoinGroupsMenu());
    }

    // ===== Existing user menu =====
    if (action === 'ex_anon') {
        await setUserMode(userId, 'anon_pending_approval');
        return ctx.reply(
            '📝 Type your anonymous question.\n\nIt will be reviewed by an admin before being published.'
        );
    }

    if (action === 'ex_contact') {
        await setUserMode(userId, 'contact_waiting');
        return ctx.reply('☎️ Please type your message and we’ll get back to you:');
    }

    if (action === 'ex_premium') {
        return ctx.reply('💎 Bluejay Premium:\n\n(put your premium onboarding info here)');
    }

    if (action === 'ex_crm') {
        // you can turn this into a multi-step flow later
        await setUserMode(userId, 'crm_waiting');
        return ctx.reply(
            '🧾 Update pilot info:\n\nSend your details in this format:\nName:\nLicense:\nAircraft/Type:\nBase:\nNotes:'
        );
    }

    // ===== Join group selection =====
    if (action.startsWith('join_')) {
        const groupKey = action.replace('join_', '');

        const { id: user_id, username, first_name } = ctx.from;

        // store request (optional but recommended)
        await supabase.from('join_requests').insert([{
            user_id,
            username,
            group_key: groupKey
        }]);

        // Send form to Feedback group
        const now = new Date();
        const dateStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });

        const groupNames = {
            lounge: 'Lounge',
            commercial: 'Commercial Aviation',
            instructors: 'Flight Instructors',
            cadets: 'Cadet Pilots',
        };

        const formText =
        `🛫 *User request to join form*

        👤 Name: ${first_name || 'N/A'}
        🔖 Username: @${username || 'N/A'}
        🆔 User ID: ${user_id}
        🕒 Date: ${dateStr}

        📌 Requested group: *${groupNames[groupKey] || groupKey}*

        ✅ Action: Admin should contact + manually approve & add user.`;

        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, formText, { parse_mode: 'Markdown' });

        await setUserMode(user_id, null);
        return ctx.reply('✅ Your request was sent to the admins. They’ll contact you soon.');
    }

    // ===== Admin approval buttons in Feedback group =====
    // callback_data format: q_approve:<uuid> / q_reject:<uuid>
    if (action.startsWith('q_approve:') || action.startsWith('q_reject:')) {
        const isAdmin = ADMINS.includes(ctx.from.id);
        if (!isAdmin) return ctx.reply('❌ You are not authorized.');

        const [verb, queueId] = action.split(':');
        const approve = verb === 'q_approve';

        const { data: row, error } = await supabase
            .from('queue')
            .select('*')
            .eq('id', queueId)
            .maybeSingle();

        if (error || !row) return ctx.reply('⚠️ Queue item not found.');

        if (row.status !== 'pending') {
            return ctx.reply(`ℹ️ Already processed (status: ${row.status}).`);
        }

        if (approve) {
            // publish to public group topic
            await ctx.telegram.sendMessage(process.env.GROUP_ID, row.message, {
            message_thread_id: TOPIC_ID
            });

            await supabase.from('queue').update({
            status: 'approved',
            approved_by: ctx.from.id,
            approved_at: new Date().toISOString()
            }).eq('id', queueId);

            return ctx.editMessageReplyMarkup({ inline_keyboard: [] })
            .catch(() => {})
            .then(() => ctx.reply(`✅ Approved & published.`));
        } else {
            await supabase.from('queue').update({
            status: 'rejected',
            approved_by: ctx.from.id,
            approved_at: new Date().toISOString()
            }).eq('id', queueId);

            // optional: notify user it was rejected (if you want)
            // await ctx.telegram.sendMessage(row.user_id, '❌ Your anonymous question was not approved.');

            return ctx.editMessageReplyMarkup({ inline_keyboard: [] })
            .catch(() => {})
            .then(() => ctx.reply(`⛔ Rejected.`));
        }
    }


    if (!ADMINS.includes(ctx.from.id)) return ctx.reply('❌ You are not authorized.');

    switch (action) {
        case 'admin_on':
            await setBotEnabled(true);
            return ctx.reply('✅ Bot is now *enabled*.', { parse_mode: 'Markdown' });
        case 'admin_off':
            await setBotEnabled(false);
            return ctx.reply('🛑 Bot is now *disabled*.', { parse_mode: 'Markdown' });
        case 'admin_status': {
            const enabled = await isBotEnabled();
            const status = enabled ? '🟢 Enabled' : '🔴 Disabled';
            return ctx.reply(`Current bot status: *${status}*`, { parse_mode: 'Markdown' });
        }
        case 'admin_fetch': {
            const { data, error } = await supabase
                .from('messages')
                .select('user_id, username, message, created_at')
                .order('created_at', { ascending: false })
                .limit(5);

            if (error || !data || data.length === 0) return ctx.reply('📭 No messages found.');

            const formatted = data.map((row, i) => 
                `#${i + 1} - ${row.username || 'Unknown'} (${row.user_id}):\n${row.message}`
            ).join('\n\n');

            return ctx.reply(`📝 Last 5 messages:\n\n${formatted}`);
        }
        case 'admin_clean': {
            const { data, error } = await supabase
                .from('messages')
                .delete()
                .not('id', 'is', null)
                .select();

            if (error) return ctx.reply('⚠️ Failed to clean the messages table.');

            const deletedCount = data?.length || 0;
            return ctx.reply(`🧹 Successfully deleted ${deletedCount} message(s).`);
        }
        case 'admin_ban': {
            await setUserMode(ctx.from.id, 'ban_waiting');
            return ctx.reply('🚫 Please enter the user ID to ban:');
        }
        case 'admin_links': {
            const messageText = `
ברוכים הבאים לערוץ *Blue Jay Aviation* - קורת הגג של הטייסים הישראלים! ✈️

בערוץ תוכלו לצפות בהודעות בצורה מסודרת ומרוכזת, כמו כן גם להיכנס לשאר הקבוצות הרלוונטיות.

⚠️ *שימו לב!*  
לכל קבוצה יצטרך להתבצע אישור ע״י אחד מהאדמינים *(נעמי / מאור)* אשר יכלול שאלון כדי לוודא שאינכם בוט, שפרטיותכם נשמרת ושהקבוצה תשאר מקצועית.

📌 *הקבוצות שלנו:*

🔹 *Lounge*  
כאן הכל קורה - טיפים מקצועיים, נושאים חמים בתעופה ודיונים פתוחים.

🔹 *Commercial Aviation*  
דיונים מקצועיים עבור טייסי איירליין, קרגו וביזנס ג'ט.

🔹 *Flight Instructors*  
קבוצה למדריכי טיס וחניכי הדרכה.

🔹 *Cadet Pilots*  
קבוצה לטייסים אשר התחילו את דרכם המקצועית, מהלימודים ועד סיום ליין טריינינג.

📌 *בחרו קבוצה להצטרפות מהכפתורים למטה:*
`;
            await ctx.telegram.sendMessage(parseInt(process.env.CHANNEL_ID), messageText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🛋️ Lounge', url: 'https://t.me/+V2SBxQBz0Z9hOWQ0' }],
                        [{ text: '✈️ Commercial Aviation', url: 'https://t.me/+OszqxsBH8vY0NjBk' }],
                        [{ text: '🧑‍🏫 Flight Instructors', url: 'https://t.me/+swR-eigAntViN2I0' }],
                        [{ text: '👨‍✈️ Cadet Pilots', url: 'https://t.me/+8ynMfyN0zzZlNDlk' }]
                    ]
                }
            });
            return ctx.reply('✅ Links posted to the Blue Jay Aviation Channel!.');
        }
    }
});

// bot.start(async ctx => {
//     ctx.session = {}; // Reset mode
//     return ctx.reply(
//   '📋 Hi, this is *BJA Anonymous Messaging Bot*, which will anonymously forward your text to BJA.',
//   { ...getMainMenu(), parse_mode: 'Markdown' });    
// });

bot.start(async (ctx) => {
  return showHomeMenu(ctx);
});



bot.on(message('text'), async (ctx) => {
    if (ctx.message.chat.type !== 'private') return;

    const enabled = await isBotEnabled();
    if (!enabled) return ctx.reply('🛑 Bot is currently *disabled*.', { parse_mode: 'Markdown' });

    const { id: user_id, username } = ctx.from;
    const mode = await getUserMode(user_id);
    const text = ctx.message.text?.trim();

    const { data: bannedUser } = await supabase
        .from('blacklist')
        .select('user_id')
        .eq('user_id', user_id)
        .maybeSingle();

    if (bannedUser) return ctx.reply('🚫 You are banned from using this bot.');

    if (mode === 'anon_pending_approval') {
    // store queue item
        const { data, error } = await supabase.from('queue').insert([{
            type: 'anon_question',
            status: 'pending',
            user_id,
            username,
            message: text,
        }]).select().single();

    if (error || !data) {
        console.error('queue insert error:', error?.message);
        return ctx.reply('⚠️ Failed to submit. Please try again.');
    }

    const now = new Date();
    const dateStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });

    const pendingText =
    `⏳ *Pending anonymous question*

    🆔 User: ${user_id} (@${username || 'N/A'})
    🕒 Date: ${dateStr}

    💬 ${text}`;

    await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, pendingText, {
        parse_mode: 'Markdown',
        reply_markup: {
        inline_keyboard: [
            [
            { text: '✅ Approve', callback_data: `q_approve:${data.id}` },
            { text: '⛔ Reject', callback_data: `q_reject:${data.id}` },
            ]
        ]
        }
    });

    await setUserMode(user_id, null);
    return ctx.reply('✅ Submitted for admin approval. If approved, it will be published.');
    }


    if (mode === 'feedback') {
        const now = new Date();
        const dateStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });
        const escapeMarkdownV2 = (text) => {
            return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
        };

        const safeFeedback = escapeMarkdownV2(text);
        const safeName = escapeMarkdownV2(ctx.from.first_name || '');
        const safeUsername = escapeMarkdownV2(ctx.from.username || '');
        const safeDate = escapeMarkdownV2(dateStr);
        const user_id = ctx.from.id;

        const formattedFeedback = `📝 *New Feedback Received*\n\n👤 From: ${safeName} \\(@${safeUsername}\\)\n🆔 ID: ${user_id}\n🕒 Date: ${safeDate}\n\n💬 ${safeFeedback}`;

        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, formattedFeedback, {
            parse_mode: 'MarkdownV2'
        });

        await setUserMode(user_id, null);
        return ctx.reply('✅ Thank you! Your feedback has been submitted.');
    }

    if (mode === 'ban_waiting' && ADMINS.includes(user_id)) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) return ctx.reply('⚠️ Invalid ID. Please send a valid numeric user ID.');

        await supabase.from('blacklist').upsert([{ user_id: targetId }]);
        await setUserMode(user_id, null);
        return ctx.reply(`✅ User ${targetId} has been banned.`);
    }

    if (mode === 'contact_waiting') {
        const now = new Date();
        const dateStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' });

        const formatted =
        `☎️ *Contact us form received*

        👤 From: ${ctx.from.first_name || 'N/A'} (@${username || 'N/A'})
        🆔 User ID: ${user_id}
        🕒 Date: ${dateStr}

        💬 ${text}`;

        await ctx.telegram.sendMessage(FEEDBACK_CHANNEL_ID, formatted, { parse_mode: 'Markdown' });

        await setUserMode(user_id, null);
        return ctx.reply('✅ Thanks! Your message was sent to the admins.');
    }


    ctx.reply('Please choose an option from the menu to proceed:', getExistingUserMenu());
});

const rejectMedia = async (ctx) => {
    if (ctx.message.chat.type !== 'private') return;
    ctx.reply('Please send textual messages only!');
};

bot.on(message('photo'), rejectMedia);
bot.on(message('video'), rejectMedia);
bot.on(message('voice'), rejectMedia);
bot.on(message('audio'), rejectMedia);
bot.on(message('document'), rejectMedia);
bot.on(message('animation'), rejectMedia);
bot.on(message('contact'), rejectMedia);
bot.on(message('location'), rejectMedia);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot is running');

exports.bot = bot;
exports.handler = async event => {
    try {
        await bot.handleUpdate(JSON.parse(event.body));
        return { statusCode: 200, body: "" };
    } catch (e) {
        console.error("error in handler:", e);
        return { statusCode: 400, body: "This endpoint is meant for bot and telegram communication" };
    }
};
