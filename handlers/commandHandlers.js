const dataStore = require('../dataStore');
const userManagement = require('../userManagement');
const { formatDebts, formatHistory } = require('../utils/formatting');
const { isValidUsername } = require('../utils/validation');
const { mainKeyboard, MAIN_MENU_BUTTONS, SUPPORTED_CURRENCIES, DEFAULT_SETTINGS, DEBTS_PAGE_SIZE, HISTORY_PAGE_SIZE } = require('../constants');
const path = require('path'); // Needed for export filename
const fs = require('fs'); // Use synchronous existsSync for export check

// In-memory state store (passed from bot.js)
let userStates = {};

function initialize(states) {
    userStates = states;
}

// --- Command Handlers ---

async function handleStart(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const username = msg.from.username ? `@${msg.from.username}` : null;

    // Update user info and attempt to link pending debts on start
    await userManagement.updateUserLinkInfo(bot, userId, username);

    const welcomeMessage = `
Привет! Я бот для управления долгами v3.0.

Используй кнопки ниже для управления долгами.
    `;
    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'HTML',
        reply_markup: mainKeyboard
    });
    delete userStates[chatId]; // Clear any previous state
}

function handleHelp(bot, msg) {
    const chatId = msg.chat.id;
    const helpMessage = `
<b>Справка по боту v3.0:</b>

Используйте кнопки главного меню для основных действий:
- <b>${MAIN_MENU_BUTTONS.ADD}</b>: Добавить новый долг (ручной или связанный с @username). Можно выбрать из известных контактов.
- <b>${MAIN_MENU_BUTTONS.VIEW}</b>: Показать список активных долгов (агрегировано по контакту/валюте, с пагинацией).
- <b>${MAIN_MENU_BUTTONS.REPAY}</b>: Погасить существующий долг (полностью или частично).
- <b>${MAIN_MENU_BUTTONS.DELETE}</b>: Удалить ручной долг или запросить удаление связанного долга.
- <b>${MAIN_MENU_BUTTONS.EDIT}</b>: Изменить детали существующего долга (сумму, валюту, дату). Требует подтверждения для связанных долгов.
- <b>${MAIN_MENU_BUTTONS.HISTORY}</b>: Показать историю (с пагинацией и фильтрами).
- <b>${MAIN_MENU_BUTTONS.SETTINGS}</b>: Изменить параметры бота (валюта, остаток, уведомления, напоминания).
- <b>${MAIN_MENU_BUTTONS.HELP}</b>: Показать это сообщение.

<b>Дополнительные команды:</b>
/linkme @старый_юзернейм - Если вам добавили долг на старый юзернейм, используйте эту команду для привязки к текущему.
/start - Показать приветственное сообщение и главное меню.

<b>Связанные долги:</b>
- При добавлении долга с @username, он создается со статусом "ожидает подтверждения".
- Другой пользователь получит уведомление с кнопками "Принять"/"Отклонить".
- После принятия долг становится активным для обеих сторон.
- Погашение синхронизируется.
- Удаление и Редактирование связанных долгов требует подтверждения от другой стороны.
- Уведомления отправляются в соответствии с вашими настройками.
    `;
    bot.sendMessage(chatId, helpMessage, {
        parse_mode: 'HTML',
        reply_markup: mainKeyboard
    });
    delete userStates[chatId];
}

async function handleLinkMe(bot, msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const currentUsername = msg.from.username ? `@${msg.from.username}` : null;
    const oldUsername = match[1]?.trim(); // Use optional chaining

    if (!currentUsername) {
        bot.sendMessage(chatId, "Не удалось получить ваш текущий @username. Убедитесь, что он установлен в настройках Telegram.");
        return;
    }
    if (!isValidUsername(oldUsername)) {
        bot.sendMessage(chatId, "Неверный формат @username для /linkme. Пример: /linkme @my_old_name");
        return;
    }
    if (oldUsername.toLowerCase() === currentUsername.toLowerCase()) {
        bot.sendMessage(chatId, "Вы указали свой текущий @username.");
        return;
    }

    bot.sendMessage(chatId, `Ищем долги, ожидающие подтверждения от ${oldUsername}, и пытаемся привязать их к ${currentUsername}...`);

    const linkedCount = await userManagement.linkDebtsByOldUsername(bot, userId, currentUsername, oldUsername);

    if (linkedCount > 0) {
        bot.sendMessage(chatId, `Успешно привязано ${linkedCount} долг(ов) с ${oldUsername} к вашему аккаунту ${currentUsername}.`);
    } else {
        bot.sendMessage(chatId, `Не найдено ожидающих долгов, связанных с ${oldUsername}, которые можно было бы привязать. Возможно, они уже были привязаны или их не существует.`);
    }
     delete userStates[chatId];
}


// --- Main Menu Button Handlers ---

async function handleAddDebtButton(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId]; // Clear previous state first

    const userData = await dataStore.readUserData(userId);
    const knownUsers = userData.knownUsers || {};
    const hasKnownUsers = Object.keys(knownUsers).length > 0;

    userStates[chatId] = { command: 'add', step: 'ask_type', data: {} };

    const inline_keyboard = [
        [{ text: '🧾 Мне должны', callback_data: 'add_oweMe' }],
        [{ text: '💸 Я должен', callback_data: 'add_iOwe' }],
        // Add "Select Known User" button later in the flow (after type selection)
        [{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]
    ];

    bot.sendMessage(chatId, 'Выберите тип долга:', {
        reply_markup: { inline_keyboard }
    });
}

async function handleViewDebtsButton(bot, msg, page = 1) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId];

    const userData = await dataStore.readUserData(userId);
    // Pass true for aggregation, page number
    const { message, totalPages } = formatDebts(userData, true, page, DEBTS_PAGE_SIZE);

    const inline_keyboard = [];
    if (totalPages > 1) {
        const row = [];
        if (page > 1) {
            row.push({ text: '⬅️ Пред.', callback_data: `view_debts_page_${page - 1}` });
        }
        row.push({ text: `📄 ${page}/${totalPages}`, callback_data: 'noop' }); // No operation button
        if (page < totalPages) {
            row.push({ text: 'След. ➡️', callback_data: `view_debts_page_${page + 1}` });
        }
        inline_keyboard.push(row);
    }

    const options = {
        parse_mode: 'HTML',
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
    };

    // Check if called from a callback query (message edit) or command (new message)
    if (msg.message_id && msg.chat) { // Likely from callback
         try {
             await bot.editMessageText(message, {
                 chat_id: chatId,
                 message_id: msg.message_id,
                 ...options
             });
         } catch (e) { // Handle potential errors like message not modified
             console.warn("Failed to edit message for /debts, sending new one.", e.message);
             await bot.sendMessage(chatId, message, options);
         }
    } else { // Likely from command
        await bot.sendMessage(chatId, message, options);
    }
}


async function handleRepayDebtButton(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId];

    const userData = await dataStore.readUserData(userId);
    const { iOwe = [], oweMe = [] } = userData.debts;

    // Check only for debts that can be repaid (active or manual)
    const repayableIOwe = iOwe.filter(d => d.status === 'active' || d.status === 'manual');
    const repayableOweMe = oweMe.filter(d => d.status === 'active' || d.status === 'manual');


    if (repayableIOwe.length === 0 && repayableOweMe.length === 0) {
        bot.sendMessage(chatId, 'У вас нет активных долгов для погашения.');
        return;
    }

    userStates[chatId] = { command: 'repay', step: 'ask_type', data: {} };

    const inline_keyboard = [];
    if (repayableOweMe.length > 0) {
        inline_keyboard.push([{ text: '🧾 Погасить долг мне', callback_data: 'repay_oweMe' }]);
    }
     if (repayableIOwe.length > 0) {
        inline_keyboard.push([{ text: '💸 Погасить мой долг', callback_data: 'repay_iOwe' }]);
    }
    inline_keyboard.push([{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]);


    bot.sendMessage(chatId, 'Какой тип долга вы хотите погасить?', {
        reply_markup: { inline_keyboard }
    });
}

async function handleDeleteDebtButton(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId];

    const userData = await dataStore.readUserData(userId);
     const { iOwe = [], oweMe = [] } = userData.debts;

    // Allow deleting any status for now, logic will handle specifics later
    if (iOwe.length === 0 && oweMe.length === 0) {
        bot.sendMessage(chatId, 'У вас нет долгов для удаления.');
        return;
    }

    userStates[chatId] = { command: 'delete', step: 'ask_type', data: {} };

    const inline_keyboard = [];
     if (oweMe.length > 0) {
        inline_keyboard.push([{ text: '🧾 Удалить "Мне должны"', callback_data: 'delete_oweMe' }]);
    }
    if (iOwe.length > 0) {
        inline_keyboard.push([{ text: '💸 Удалить "Я должен"', callback_data: 'delete_iOwe' }]);
    }
    inline_keyboard.push([{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]);

    bot.sendMessage(chatId, 'Какой тип долга вы хотите удалить?', {
         reply_markup: { inline_keyboard }
     });
}

async function handleEditDebtButton(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId];

    const userData = await dataStore.readUserData(userId);
    const { iOwe = [], oweMe = [] } = userData.debts;

    // Allow editing active or manual debts for now
    const editableIOwe = iOwe.filter(d => d.status === 'active' || d.status === 'manual');
    const editableOweMe = oweMe.filter(d => d.status === 'active' || d.status === 'manual');

    if (editableIOwe.length === 0 && editableOweMe.length === 0) {
        bot.sendMessage(chatId, 'У вас нет долгов, доступных для редактирования.');
        return;
    }

    userStates[chatId] = { command: 'edit', step: 'ask_type', data: {} };

    const inline_keyboard = [];
    if (editableOweMe.length > 0) {
        inline_keyboard.push([{ text: '🧾 Редактировать "Мне должны"', callback_data: 'edit_oweMe' }]);
    }
     if (editableIOwe.length > 0) {
        inline_keyboard.push([{ text: '💸 Редактировать "Я должен"', callback_data: 'edit_iOwe' }]);
    }
    inline_keyboard.push([{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]);


    bot.sendMessage(chatId, 'Какой тип долга вы хотите редактировать?', {
        reply_markup: { inline_keyboard }
    });
}


async function handleHistoryButton(bot, msg, page = 1) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    // Don't delete state here, keep filters
    // delete userStates[chatId];

    const userData = await dataStore.readUserData(userId);
    const historyFilters = userStates[`${chatId}_history_filters`] || {}; // Get filters if they exist
    const { message, totalPages } = formatHistory(userData.history, userData.knownUsers, historyFilters, page, HISTORY_PAGE_SIZE);

    // --- Filter Buttons ---
    const filter_keyboard = [
        // Row 1: Filter options
        [
            { text: '👤 По контакту', callback_data: 'history_filter_contact' },
            { text: '📅 По дате', callback_data: 'history_filter_date' },
            // { text: '🏷️ По действию', callback_data: 'history_filter_action' } // Optional
        ],
        // Row 2: Reset
        [
             { text: '🔄 Сбросить все фильтры', callback_data: 'history_filter_reset' }
        ],
         // Row 3: Close
        [
             { text: '⬅️ Закрыть', callback_data: 'history_close' }
        ]
    ];

    // --- Pagination Buttons ---
     if (totalPages > 1) {
        const row = [];
        if (page > 1) {
            row.push({ text: '⬅️ Пред.', callback_data: `history_page_${page - 1}` });
        }
        row.push({ text: `📄 ${page}/${totalPages}`, callback_data: 'noop' }); // No operation button
        if (page < totalPages) {
            row.push({ text: 'След. ➡️', callback_data: `history_page_${page + 1}` });
        }
        filter_keyboard.unshift(row); // Add pagination buttons at the top
    }


    // Indicate active filters
    let filterStatus = '';
    if (Object.keys(historyFilters).length > 0) {
        filterStatus = '\n\n<i>Активные фильтры:</i>';
        if (historyFilters.contactUserId) {
             const contactName = userData.knownUsers[historyFilters.contactUserId] || `User_${historyFilters.contactUserId}`;
             filterStatus += ` Контакт (${contactName})`;
        }
        if (historyFilters.startDate || historyFilters.endDate) {
            filterStatus += ` Дата (${historyFilters.startDate?.toLocaleDateString('ru-RU') ?? '...'} - ${historyFilters.endDate?.toLocaleDateString('ru-RU') ?? '...'})`;
        }
         // Add other filters...
         filterStatus += '.';
    }

     const options = {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: filter_keyboard }
    };

     // Check if called from a callback query (message edit) or command (new message)
    if (msg.message_id && msg.chat) { // Likely from callback
         try {
             await bot.editMessageText(message + filterStatus, {
                 chat_id: chatId,
                 message_id: msg.message_id,
                 ...options
             });
         } catch (e) { // Handle potential errors like message not modified
             console.warn("Failed to edit message for /history, sending new one.", e.message);
             await bot.sendMessage(chatId, message + filterStatus, options);
         }
    } else { // Likely from command
        await bot.sendMessage(chatId, message + filterStatus, options);
    }
}

async function handleSettingsButton(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    delete userStates[chatId]; // Clear any previous command state

    const userData = await dataStore.readUserData(userId);
    const settings = userData.settings; // Already merged with defaults

    const settingsMessage = `
<b>⚙️ Настройки:</b>

- Валюта по умолчанию: <b>${settings.defaultCurrency}</b>
- Показывать чистый остаток: <b>${settings.showNetBalance ? 'Да ✅' : 'Нет ❌'}</b>
- Напоминания о сроках: <b>${settings.remindersEnabled ? `Вкл ✅ (за ${settings.reminderDaysBefore} д.)` : 'Выкл ❌'}</b>
${/* - Стиль отображения: <b>${settings.displayStyle}</b> */''}

Нажмите на кнопку, чтобы изменить настройку.
    `;

    const inline_keyboard = [
        [
            { text: `💲 Валюта (${settings.defaultCurrency})`, callback_data: 'settings_change_currency' },
            { text: `⚖️ Остаток (${settings.showNetBalance ? 'Вкл' : 'Выкл'})`, callback_data: 'settings_toggle_netbalance' }
        ],
        [
             { text: `🔔 Уведомления`, callback_data: 'settings_manage_notifications' }, // Changed
             { text: `⏰ Напоминания`, callback_data: 'settings_manage_reminders' } // Changed
        ],
        // [ { text: `🎨 Стиль (${settings.displayStyle})`, callback_data: 'settings_change_style' } ], // Future
        [ { text: `💾 Экспорт данных`, callback_data: 'settings_export_data' } ],
        [ { text: '⬅️ Закрыть', callback_data: 'settings_close' } ]
    ];

    bot.sendMessage(chatId, settingsMessage, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
    });
}

function handleHelpButton(bot, msg) {
    // Just call the /help handler
    handleHelp(bot, msg);
}

module.exports = {
    initialize,
    handleStart,
    handleHelp,
    handleLinkMe,
    handleAddDebtButton,
    handleViewDebtsButton,
    handleRepayDebtButton,
    handleDeleteDebtButton,
    handleEditDebtButton,
    handleHistoryButton,
    handleSettingsButton,
    handleHelpButton
};
