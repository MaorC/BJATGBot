/**
 * Blue Jay Aviation - Join Interview Engine
 *
 * A short, Hebrew, button-first interview that maps 1:1 to the BJA Member
 * Database spreadsheet. Runs for applicants (via chat_join_request DM) and
 * for admins completing details on behalf of an applicant ("fill mode").
 *
 * State lives in the Supabase `applicants` table (see supabase/applicants.sql):
 *   telegram_id, username, tg_first_name, chat_requested, state, answers(jsonb),
 *   status: in_progress | submitted | approved | rejected | retro_pending
 *   needs_verification, verification_reasons, sheet_row, member_id, ...
 *
 * Callback data prefixes (Telegram limit 64 bytes):
 *   iv:<question>:<option>  - interview answers
 *   aq:<verb>:<telegram_id> - admin queue actions (handled in bot.js)
 */

const PHONE_SKIP_TEXT = 'מעדיף/ה לא לשתף כרגע';

// --- Option maps: [callback code, Hebrew label, spreadsheet value] ---

const RESIDENCY_OPTS = [
    ['il', 'ישראל', 'Israel'],
    ['us', 'ארה"ב', 'USA'],
    ['eu', 'אירופה', 'Europe'],
    ['ca', 'קנדה', 'Canada'],
];

const CATEGORY_OPTS = [
    ['student', 'בהכשרה', 'Student'],
    ['asp', 'עוד לא התחלתי', 'Aspiring'],
    ['inst', 'מדריך/ה', 'Instructor'],
    ['air', 'איירליין', 'Airline'],
    ['cargo', 'קרגו', 'Cargo'],
    ['biz', "ביזנס ג'ט", 'Corporate / Bizjet'],
    ['ga', 'תעופה כללית', 'GA / Aerial Work'],
    ['seek', 'מחפש/ת עבודה', 'Seeking Job'],
];

const LICENSE_OPTS = [
    ['none', 'אין עדיין', ''],
    ['ppl', 'PPL', 'PPL'],
    ['cpl', 'CPL', 'CPL'],
    ['atpl', 'ATPL', 'ATPL'],
];

const AUTH_OPTS = [
    ['caai', 'CAAI', 'CAAI'],
    ['faa', 'FAA', 'FAA'],
    ['easa', 'EASA', 'EASA'],
    ['tc', 'TC', 'TC'],
];

const TRAINING_OPTS = [
    ['ppl', 'PPL', 'PPL'],
    ['cpl', 'CPL', 'CPL'],
    ['ir', 'IR', 'IR'],
    ['atpl', 'ATPL', 'ATPL'],
    ['inst', 'הדרכה', 'Instructor'],
];

const RATING_OPTS = [
    ['ir', 'IR', 'IR'],
    ['mep', 'MEP', 'MEP'],
    ['cfi', 'CFI', 'CFI'],
    ['cfii', 'CFII', 'CFII'],
    ['mei', 'MEI', 'MEI'],
    ['tri', 'TRI', 'TRI'],
    ['tre', 'TRE', 'TRE'],
];

const sheetValue = (opts, code) => (opts.find(o => o[0] === code) || [])[2] || '';
const hebLabel = (opts, code) => (opts.find(o => o[0] === code) || [])[1] || code;

// --- Copy ---

const INTRO_MSG =
    '🔵 ברוכים הבאים ל-Blue Jay Aviation!\n\n' +
    'כדי לשמור על קהילה איכותית ומקצועית, כל מצטרף עובר סינון קצר - 7 שאלות, פחות מדקה.\n\n' +
    '🔒 הפרטים נשמרים אצל צוות BJA בלבד ולעולם לא יועברו לאף גורם ללא הסכמה מפורשת שלך.';

const CLOSING_MSG =
    '🔵 תודה! הבקשה הועברה לצוות BJA.\n\n' +
    '⏱️ בתוך 24 שעות לכל היותר הבקשה תאושר או תסורב בהתאם לתשובות.\n' +
    '💬 לערעור או כל שאלה - הודעה פרטית ל-@maor_c\n\n' +
    'טיסות בטוחות! ✈️';

const VERIFICATION_MSG =
    '🛂 לצורך השלמת הבקשה נבצע איתך אימות קצר - דרך לינקדאין / רשת חברתית / שיחה קולית קצרה באפליקציה, לפי בחירתך. אחד מאנשי הצוות ייצור איתך קשר.';

// --- Factory ---

function createInterview({ supabase, telegram, escapeHTML, FEEDBACK_CHANNEL_ID }) {

    // ---------- DB helpers ----------

    async function getApplicant(telegramId) {
        const { data } = await supabase
            .from('applicants').select('*').eq('telegram_id', telegramId).maybeSingle();
        return data;
    }

    async function upsertApplicant(row) {
        const { data, error } = await supabase
            .from('applicants')
            .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'telegram_id' })
            .select().single();
        if (error) console.error('applicants upsert error:', error.message);
        return data;
    }

    async function saveAnswers(applicant, patch, state) {
        const answers = { ...(applicant.answers || {}), ...patch };
        return upsertApplicant({
            telegram_id: applicant.telegram_id,
            answers,
            ...(state !== undefined ? { state } : {}),
        });
    }

    // ---------- Question flow ----------

    /**
     * Returns the next unanswered question key, or null when complete.
     * Used for fresh interviews, resumed ones, and admin fill mode alike.
     */
    function nextQuestion(applicant) {
        const a = applicant.answers || {};
        if (!a.name) return 'name';
        if (a.phone === undefined) return 'phone';
        if (!a.residency) return 'residency';
        if (!a.category) return 'category';
        if (!a.license) return 'license';
        if (a.license !== 'none' && !a.auth_done) return 'authority';
        if ((a.license === 'none' || a.category === 'student' || a.category === 'asp') && !a.training) return 'training';
        if (!a.ratings_done) return 'ratings';
        if (a.extra === undefined) return 'extra';
        return null;
    }

    function multiKeyboard(opts, selected, prefix, extraRows) {
        const rows = [];
        for (let i = 0; i < opts.length; i += 2) {
            rows.push(opts.slice(i, i + 2).map(([code, label]) => ({
                text: (selected.includes(code) ? '✅ ' : '') + label,
                callback_data: `${prefix}:${code}`,
            })));
        }
        return { inline_keyboard: [...rows, ...extraRows] };
    }

    function questionMessage(key, applicant) {
        const a = applicant.answers || {};
        switch (key) {
            case 'name':
                return { text: '1/7 - מה שמך המלא? (שם פרטי ושם משפחה)' };
            case 'phone':
                return {
                    text: '2/7 - מספר טלפון 📱\n\nאפשר לשתף בלחיצה אחת, או להקליד ידנית:',
                    reply_markup: {
                        keyboard: [
                            [{ text: '📱 שיתוף המספר שלי', request_contact: true }],
                            [{ text: PHONE_SKIP_TEXT }],
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true,
                    },
                };
            case 'residency':
                return {
                    text: '3/7 - היכן אתה גר כיום?',
                    reply_markup: {
                        inline_keyboard: [
                            ...RESIDENCY_OPTS.map(([code, label]) => ([{ text: label, callback_data: `iv:res:${code}` }])),
                            [{ text: 'אחר...', callback_data: 'iv:res:other' }],
                        ],
                    },
                };
            case 'category':
                return {
                    text: '4/7 - מה הסטטוס התעופתי שלך כרגע?',
                    reply_markup: {
                        inline_keyboard: [
                            ...chunk(CATEGORY_OPTS.map(([code, label]) => ({ text: label, callback_data: `iv:cat:${code}` })), 2),
                            [{ text: 'אחר...', callback_data: 'iv:cat:other' }],
                        ],
                    },
                };
            case 'license':
                return {
                    text: '5/7 - מהו הרישיון הגבוה ביותר שברשותך?',
                    reply_markup: {
                        inline_keyboard: [
                            ...chunk(LICENSE_OPTS.map(([code, label]) => ({ text: label, callback_data: `iv:lic:${code}` })), 2),
                            [{ text: 'אחר...', callback_data: 'iv:lic:other' }],
                        ],
                    },
                };
            case 'authority':
                return {
                    text: 'באיזו רשות (או רשויות) מונפק הרישיון שלך?\nאפשר לבחור יותר מאחת, ובסיום ללחוץ "סיימתי":',
                    reply_markup: multiKeyboard(AUTH_OPTS, a.authorities || [], 'iv:auth', [
                        [{ text: 'אחר...', callback_data: 'iv:auth:other' }],
                        [{ text: '✔️ סיימתי', callback_data: 'iv:auth:done' }],
                    ]),
                };
            case 'training':
                return {
                    text: 'לקראת מה אתה מתאמן / מתכנן להתאמן?',
                    reply_markup: {
                        inline_keyboard: [
                            ...chunk(TRAINING_OPTS.map(([code, label]) => ({ text: label, callback_data: `iv:train:${code}` })), 3),
                            [{ text: 'אחר...', callback_data: 'iv:train:other' }],
                        ],
                    },
                };
            case 'ratings':
                return {
                    text: '6/7 - אילו הגדרים יש ברשותך?\nאפשר לבחור כמה, ובסיום ללחוץ "סיימתי":',
                    reply_markup: multiKeyboard(RATING_OPTS, a.ratings || [], 'iv:rate', [
                        [{ text: 'אין הגדרים / דלג', callback_data: 'iv:rate:none' }],
                        [{ text: '✔️ סיימתי', callback_data: 'iv:rate:done' }],
                    ]),
                };
            case 'extra':
                return {
                    text: '7/7 - משהו נוסף שכדאי שנדע? (מעסיק, מטוס, מטרות)',
                    reply_markup: { inline_keyboard: [[{ text: 'דלג', callback_data: 'iv:extra:skip' }]] },
                };
        }
    }

    function chunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    /**
     * Sends the next question to `chatId` (applicant DM, or admin DM in fill mode).
     * When complete: submits (applicant flow) or notifies (fill mode).
     */
    async function advance(chatId, applicant, { fillMode = false, adminId = null } = {}) {
        const key = nextQuestion(applicant);

        if (!key) {
            if (fillMode) {
                await supabase.from('users').update({ chat_mode: null }).eq('user_id', adminId);
                await upsertApplicant({ telegram_id: applicant.telegram_id, state: null });
                await telegram.sendMessage(chatId, '✅ כל הפרטים הושלמו. אפשר לאשר את המועמד מכרטיס הבקשה, או לשלוח לו לינק דרך "אשר בדיעבד".');
            } else {
                await submitInterview(chatId, applicant);
            }
            return;
        }

        await upsertApplicant({ telegram_id: applicant.telegram_id, state: key });
        const msg = questionMessage(key, applicant);
        const prefix = fillMode ? `📋 (השלמה עבור ${applicant.answers?.name || applicant.tg_first_name || applicant.telegram_id})\n\n` : '';
        await telegram.sendMessage(chatId, prefix + msg.text, {
            reply_markup: msg.reply_markup,
        });
    }

    // ---------- Submission ----------

    function verificationReasons(applicant) {
        const a = applicant.answers || {};
        const reasons = [];
        if (a.phone === '') reasons.push('לא שותף מספר טלפון');
        if (a.extra === '') reasons.push('דילג על פרטים נוספים');
        return reasons;
    }

    async function submitInterview(chatId, applicant) {
        applicant = await getApplicant(applicant.telegram_id);
        const reasons = verificationReasons(applicant);
        const needsVerification = reasons.length > 0;

        await upsertApplicant({
            telegram_id: applicant.telegram_id,
            state: null,
            status: 'submitted',
            needs_verification: needsVerification,
            verification_reasons: reasons,
            submitted_at: new Date().toISOString(),
        });

        await telegram.sendMessage(chatId, CLOSING_MSG, { reply_markup: { remove_keyboard: true } });
        if (needsVerification) await telegram.sendMessage(chatId, VERIFICATION_MSG);

        await sendAdminCard(applicant.telegram_id);
    }

    function summaryText(applicant) {
        const a = applicant.answers || {};
        const lines = [
            `🛬 <b>בקשת הצטרפות חדשה</b>`,
            ``,
            `👤 ${escapeHTML(a.name)} (@${escapeHTML(applicant.username || 'אין')})`,
            `🆔 ${applicant.telegram_id}`,
            `📱 ${a.phone ? escapeHTML(a.phone) : 'לא שותף'}`,
            `🌍 מגורים: ${a.residency === 'other' ? escapeHTML(a.residency_other || '?') : hebLabel(RESIDENCY_OPTS, a.residency)}`,
            `✈️ סטטוס: ${a.category === 'other' ? escapeHTML(a.category_other || '?') : hebLabel(CATEGORY_OPTS, a.category)}`,
            `📜 רישיון: ${a.license === 'other' ? escapeHTML(a.license_other || '?') : hebLabel(LICENSE_OPTS, a.license)}` +
                (a.authorities?.length ? ` (${a.authorities.map(c => sheetValue(AUTH_OPTS, c)).join(', ')}${a.authority_other ? ', ' + escapeHTML(a.authority_other) : ''})` : ''),
        ];
        if (a.training) lines.push(`🎯 במסלול ל: ${a.training === 'other' ? escapeHTML(a.training_other || '?') : hebLabel(TRAINING_OPTS, a.training)}`);
        if (a.ratings?.length) lines.push(`⭐ הגדרים: ${a.ratings.map(c => sheetValue(RATING_OPTS, c)).join(', ')}`);
        if (a.extra) lines.push(`📝 ${escapeHTML(a.extra)}`);

        const reasons = applicant.verification_reasons || [];
        if (reasons.length) lines.push('', `⚠️ <b>דורש אימות:</b> ${reasons.join('; ')}`);
        return lines.join('\n');
    }

    async function sendAdminCard(telegramId) {
        const applicant = await getApplicant(telegramId);
        await telegram.sendMessage(FEEDBACK_CHANNEL_ID, summaryText(applicant), {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ אישור', callback_data: `aq:app:${telegramId}` },
                    { text: '⛔ דחייה', callback_data: `aq:rej:${telegramId}` },
                ], [
                    { text: '📋 השלמה ידנית', callback_data: `aq:fill:${telegramId}` },
                ]],
            },
        });
    }

    // ---------- Sheet row building ----------

    function buildSheetRow(applicant) {
        const a = applicant.answers || {};
        const notes = [];
        if (a.extra) notes.push(a.extra);
        if (a.residency === 'other' && a.residency_other) notes.push(`מגורים: ${a.residency_other}`);
        if (a.category === 'other' && a.category_other) notes.push(`סטטוס: ${a.category_other}`);
        if (a.license === 'other' && a.license_other) notes.push(`רישיון: ${a.license_other}`);
        if (a.training === 'other' && a.training_other) notes.push(`מסלול: ${a.training_other}`);
        if (a.authority_other) notes.push(`רשות: ${a.authority_other}`);
        if (applicant.username) notes.push(`TG: @${applicant.username}`);

        const review = [];
        if ((applicant.verification_reasons || []).length) review.push(...applicant.verification_reasons);
        if (a.residency === 'other' || a.category === 'other' || a.license === 'other' || a.training === 'other') {
            review.push('תשובת "אחר" בראיון - לסווג ידנית');
        }

        const [firstName, ...rest] = (a.name || '').trim().split(/\s+/);
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem' });

        // A:Q order - must match the Members tab exactly
        return [
            '',                                                            // A ID (filled by sheets.js)
            firstName || '',                                               // B First Name
            rest.join(' '),                                                // C Last Name
            a.phone || '',                                                 // D Phone
            'Active',                                                      // E Status
            a.residency === 'other' ? 'Other' : sheetValue(RESIDENCY_OPTS, a.residency), // F Residency
            a.license === 'other' ? '' : sheetValue(LICENSE_OPTS, a.license),            // G License Level
            a.training && a.training !== 'other' ? sheetValue(TRAINING_OPTS, a.training) : '', // H In Training For
            (a.authorities || []).map(c => sheetValue(AUTH_OPTS, c)).join(', '),        // I License Authority
            (a.ratings || []).map(c => sheetValue(RATING_OPTS, c)).join(', '),          // J Ratings
            a.category === 'other' ? 'Unknown' : sheetValue(CATEGORY_OPTS, a.category), // K Flying Category
            '',                                                            // L Employer
            '',                                                            // M Aircraft
            'Telegram',                                                    // N Platform Source
            today,                                                         // O Join Date
            notes.join('; '),                                              // P Notes
            review.join('; '),                                             // Q Needs Review
        ];
    }

    // ---------- Input handlers (wired from bot.js) ----------

    /**
     * Handles interview callback buttons (iv:*). `target` is the applicant the
     * answer belongs to (the clicker, or the fill-mode target for admins).
     * Returns true if handled.
     */
    async function handleCallback(ctx, target, fillOpts) {
        const [, q, opt] = ctx.callbackQuery.data.split(':');
        const chatId = ctx.chat.id;
        const a = target.answers || {};

        const freeTextStates = {
            res: 'residency_other_wait', cat: 'category_other_wait',
            lic: 'license_other_wait', auth: 'authority_other_wait',
            train: 'training_other_wait',
        };

        if (opt === 'other' && freeTextStates[q]) {
            await upsertApplicant({ telegram_id: target.telegram_id, state: freeTextStates[q] });
            return ctx.reply('אין בעיה, כתוב לי במילים שלך:');
        }

        switch (q) {
            case 'res':
                target = await saveAnswers(target, { residency: opt });
                return advance(chatId, target, fillOpts);
            case 'cat':
                target = await saveAnswers(target, { category: opt });
                return advance(chatId, target, fillOpts);
            case 'lic':
                target = await saveAnswers(target, { license: opt, ...(opt === 'none' ? { auth_done: true } : {}) });
                return advance(chatId, target, fillOpts);
            case 'auth': {
                if (opt === 'done') {
                    if (!(a.authorities || []).length && !a.authority_other) {
                        return ctx.reply('בחר לפחות רשות אחת, או לחץ "אחר..."');
                    }
                    target = await saveAnswers(target, { auth_done: true });
                    return advance(chatId, target, fillOpts);
                }
                const set = new Set(a.authorities || []);
                set.has(opt) ? set.delete(opt) : set.add(opt);
                target = await saveAnswers(target, { authorities: [...set] });
                const msg = questionMessage('authority', target);
                return ctx.editMessageReplyMarkup(msg.reply_markup).catch(() => {});
            }
            case 'rate': {
                if (opt === 'none') {
                    target = await saveAnswers(target, { ratings: [], ratings_done: true });
                    return advance(chatId, target, fillOpts);
                }
                if (opt === 'done') {
                    target = await saveAnswers(target, { ratings_done: true });
                    return advance(chatId, target, fillOpts);
                }
                const set = new Set(a.ratings || []);
                set.has(opt) ? set.delete(opt) : set.add(opt);
                target = await saveAnswers(target, { ratings: [...set] });
                const msg = questionMessage('ratings', target);
                return ctx.editMessageReplyMarkup(msg.reply_markup).catch(() => {});
            }
            case 'train':
                target = await saveAnswers(target, { training: opt });
                return advance(chatId, target, fillOpts);
            case 'extra':
                if (opt === 'skip') {
                    target = await saveAnswers(target, { extra: '' });
                    return advance(chatId, target, fillOpts);
                }
        }
        return false;
    }

    /**
     * Handles free-text/contact input while in an interview state.
     * Returns true if the input was consumed by the interview.
     */
    async function handleText(ctx, target, text, fillOpts) {
        const chatId = ctx.chat.id;
        const state = target.state;

        const otherMap = {
            residency_other_wait: ['residency', 'residency_other'],
            category_other_wait: ['category', 'category_other'],
            license_other_wait: ['license', 'license_other'],
            training_other_wait: ['training', 'training_other'],
        };

        if (state === 'name') {
            if (!text || text.length < 2) return ctx.reply('נסה שוב, שם מלא בבקשה:'), true;
            target = await saveAnswers(target, { name: text });
            await advance(chatId, target, fillOpts);
            return true;
        }
        if (state === 'phone') {
            if (text === PHONE_SKIP_TEXT) {
                target = await saveAnswers(target, { phone: '' });
            } else if (/^[+\d][\d\s\-()]{7,}$/.test(text)) {
                target = await saveAnswers(target, { phone: text.replace(/[\s\-()]/g, '') });
            } else {
                await ctx.reply('זה לא נראה כמו מספר תקין. אפשר להקליד שוב, ללחוץ על כפתור השיתוף, או על "' + PHONE_SKIP_TEXT + '"');
                return true;
            }
            await advance(chatId, target, fillOpts);
            return true;
        }
        if (otherMap[state]) {
            const [key, otherKey] = otherMap[state];
            const patch = { [key]: 'other', [otherKey]: text };
            if (key === 'license') patch.auth_done = true;
            target = await saveAnswers(target, patch);
            await advance(chatId, target, fillOpts);
            return true;
        }
        if (state === 'authority_other_wait') {
            target = await saveAnswers(target, { authority_other: text, auth_done: true });
            await advance(chatId, target, fillOpts);
            return true;
        }
        if (state === 'extra') {
            target = await saveAnswers(target, { extra: text });
            await advance(chatId, target, fillOpts);
            return true;
        }
        return false;
    }

    /** Handles a shared contact during the phone question. */
    async function handleContact(ctx, target, fillOpts) {
        if (target.state !== 'phone') return false;
        const phone = ctx.message.contact.phone_number;
        target = await saveAnswers(target, { phone: phone.startsWith('+') ? phone : '+' + phone });
        await advance(ctx.chat.id, target, fillOpts);
        return true;
    }

    return {
        INTRO_MSG,
        getApplicant, upsertApplicant, nextQuestion, advance,
        handleCallback, handleText, handleContact,
        buildSheetRow, sendAdminCard, summaryText,
    };
}

module.exports = { createInterview, PHONE_SKIP_TEXT };
