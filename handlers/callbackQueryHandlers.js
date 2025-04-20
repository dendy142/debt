const dataStore = require('../dataStore');
const { formatDebts, formatHistory, formatDate } = require('../utils/formatting');
const { isValidCurrency, validateAmount, validateDate } = require('../utils/validation');
const { parseDate } = require('../utils/helpers');
const debtLogic = require('../debtLogic'); // Assuming debt logic is moved here
const { MAIN_MENU_BUTTONS, SUPPORTED_CURRENCIES, DEBT_STATUS, HISTORY_ACTIONS, DEBTS_PAGE_SIZE, HISTORY_PAGE_SIZE } = require('../constants');
const path = require('path'); // Needed for export filename
const fs = require('fs'); // Use synchronous existsSync for export check

// In-memory state store (passed from bot.js)
let userStates = {};
let botInstance; // Store bot instance

function initialize(bot, states) {
    botInstance = bot;
    userStates = states;
}

async function handleCallbackQuery(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId];

    // --- Generic Cancel ---
    if (callbackData === 'cancel_operation') {
        delete userStates[chatId];
        try {
            await botInstance.editMessageText('Операция отменена.', {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: null
            });
        } catch (error) { console.log("Info: Tried to edit already deleted/modified message on cancel."); }
        await botInstance.answerCallbackQuery(callbackQuery.id);
        return;
    }
     // --- No Operation (for static buttons like page numbers) ---
    if (callbackData === 'noop') {
        await botInstance.answerCallbackQuery(callbackQuery.id);
        return;
    }

    // --- Route Callback ---
    try {
        if (callbackData.startsWith('settings_')) {
            await handleSettingsCallback(callbackQuery);
        } else if (callbackData.startsWith('debt_')) { // Accept/Reject/Confirm/Snooze etc.
            await handleDebtActionCallback(callbackQuery);
        } else if (callbackData.startsWith('add_')) {
            await handleAddCallback(callbackQuery);
        } else if (callbackData.startsWith('repay_')) {
            await handleRepayCallback(callbackQuery);
        } else if (callbackData.startsWith('delete_')) {
            await handleDeleteCallback(callbackQuery);
        } else if (callbackData.startsWith('edit_')) {
            await handleEditCallback(callbackQuery);
        } else if (callbackData.startsWith('history_')) {
            await handleHistoryCallback(callbackQuery);
        } else if (callbackData.startsWith('view_debts_page_')) { // Debts Pagination
             const page = parseInt(callbackData.substring(16), 10);
             await require('./commandHandlers').handleViewDebtsButton(botInstance, msg, page);
             await botInstance.answerCallbackQuery(callbackQuery.id);
        }
         else {
            // Acknowledge unhandled callbacks silently
            await botInstance.answerCallbackQuery(callbackQuery.id);
        }
    } catch (error) {
        console.error(`Error handling callback query ${callbackData} for user ${userId}:`, error);
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка.', show_alert: true });
        // Optionally send a message to the chat
        try {
            await botInstance.sendMessage(chatId, "Извините, произошла внутренняя ошибка при обработке вашего запроса.");
        } catch (sendError) {
             console.error("Failed to send error message to chat:", sendError);
        }
        delete userStates[chatId]; // Clear state on error
    }
}


// --- Settings Callbacks ---
async function handleSettingsCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;

    const userData = await dataStore.readUserData(userId);
    const currentSettings = userData.settings;

    // --- Close ---
    if (callbackData === 'settings_close') {
        try {
            await botInstance.deleteMessage(chatId, msg.message_id);
        } catch (error) { console.log("Info: Settings message already deleted."); }
        await botInstance.answerCallbackQuery(callbackQuery.id);
        return;
    }

    // --- Back to Main Settings (Improved Responsiveness) ---
    if (callbackData === 'settings_back_to_main') {
        delete userStates[chatId]; // Clear sub-state if any
        await botInstance.answerCallbackQuery(callbackQuery.id); // Acknowledge immediately
        try {
            await botInstance.deleteMessage(chatId, msg.message_id); // Delete sub-menu message
        } catch (error) { console.log("Info: Settings sub-menu message already deleted."); }
        // Re-trigger main settings display by simulating button press
        // Need to pass the original message context for it to work correctly
        const fakeMsg = { chat: { id: chatId }, from: { id: userId } }; // Minimal msg object
        await require('./commandHandlers').handleSettingsButton(botInstance, fakeMsg); // Send new message
        return; // Exit after handling back navigation
    }

    // --- Change Currency ---
    if (callbackData === 'settings_change_currency') {
        userStates[chatId] = { command: 'settings', step: 'select_currency' };
        const currencyButtons = SUPPORTED_CURRENCIES.map(curr => ([{
            text: `${curr} ${currentSettings.defaultCurrency === curr ? '✅' : ''}`,
            callback_data: `settings_set_currency_${curr}`
        }]));
        // Use a dedicated back button for currency selection
        currencyButtons.push([{ text: '⬅️ Назад к настройкам', callback_data: 'settings_back_to_main_from_currency' }]);

        await botInstance.editMessageText('Выберите валюту по умолчанию:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: currencyButtons }
        });
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Set Currency ---
    else if (callbackData.startsWith('settings_set_currency_')) {
        const newCurrency = callbackData.substring(22);
        if (isValidCurrency(newCurrency)) {
            currentSettings.defaultCurrency = newCurrency;
            await dataStore.writeUserData(userId, userData);
            await botInstance.answerCallbackQuery(callbackQuery.id, { text: `Валюта по умолчанию: ${newCurrency}` });
            // Go back to main settings view using the improved back logic
            await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' }); // Simulate back button
        } else {
            await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Неверная валюта.', show_alert: true });
        }
    }
    // --- Back from Currency Selection ---
    else if (callbackData === 'settings_back_to_main_from_currency') {
         // Use the improved back logic
         await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' });
    }
    // --- Toggle Net Balance ---
    else if (callbackData === 'settings_toggle_netbalance') {
        currentSettings.showNetBalance = !currentSettings.showNetBalance;
        await dataStore.writeUserData(userId, userData);
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: `Показ остатка: ${currentSettings.showNetBalance ? 'Включен' : 'Выключен'}` });
        // Refresh main settings view using the improved back logic
        await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' });
    }
    // --- Manage Reminders ---
    else if (callbackData === 'settings_manage_reminders') {
         const reminderText = `Напоминания ${currentSettings.remindersEnabled ? 'ВКЛ ✅' : 'ВЫКЛ ❌'}`;
         const daysText = `Дней до срока: ${currentSettings.reminderDaysBefore}`;
         const inline_keyboard = [
             [{ text: reminderText, callback_data: 'settings_toggle_reminders' }],
             [{ text: daysText, callback_data: 'settings_change_reminder_days' }],
             // Use dedicated back button
             [{ text: '⬅️ Назад к настройкам', callback_data: 'settings_back_to_main_from_reminders' }]
         ];
         await botInstance.editMessageText('Настройки напоминаний:', {
             chat_id: chatId,
             message_id: msg.message_id,
             reply_markup: { inline_keyboard }
         });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
     // --- Back from Reminder Management ---
     else if (callbackData === 'settings_back_to_main_from_reminders') {
         await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' });
     }
    // --- Toggle Reminders ---
     else if (callbackData === 'settings_toggle_reminders') {
        currentSettings.remindersEnabled = !currentSettings.remindersEnabled;
        await dataStore.writeUserData(userId, userData);
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: `Напоминания: ${currentSettings.remindersEnabled ? 'Включены' : 'Выключены'}` });
        // Refresh reminder settings view (edit is fine here as it's the same menu level)
        await handleSettingsCallback({ ...callbackQuery, data: 'settings_manage_reminders' });
    }
    // --- Change Reminder Days ---
    else if (callbackData === 'settings_change_reminder_days') {
         const daysOptions = [1, 3, 7, 0]; // 0 means on the due date
         const inline_keyboard = daysOptions.map(days => ([{
             text: `${days === 0 ? 'В день срока' : days + ' дн.'} ${currentSettings.reminderDaysBefore === days ? '✅' : ''}`,
             callback_data: `settings_set_reminder_days_${days}`
         }]));
         // Use dedicated back button
         inline_keyboard.push([{ text: '⬅️ Назад к напом.', callback_data: 'settings_back_to_reminders_from_days' }]);
         await botInstance.editMessageText('За сколько дней до срока напоминать?', {
             chat_id: chatId,
             message_id: msg.message_id,
             reply_markup: { inline_keyboard }
         });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
     // --- Back from Reminder Days Selection ---
     else if (callbackData === 'settings_back_to_reminders_from_days') {
         // Go back to the reminder management screen (edit is fine)
         await handleSettingsCallback({ ...callbackQuery, data: 'settings_manage_reminders' });
     }
    // --- Set Reminder Days ---
    else if (callbackData.startsWith('settings_set_reminder_days_')) {
         const days = parseInt(callbackData.substring(27), 10);
         if (!isNaN(days) && days >= 0) {
             currentSettings.reminderDaysBefore = days;
             await dataStore.writeUserData(userId, userData);
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: `Напоминать за ${days === 0 ? '0 (в день срока)' : days} дн.` });
             // Go back to reminder settings view (edit is fine)
             await handleSettingsCallback({ ...callbackQuery, data: 'settings_manage_reminders' });
         } else {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Неверное значение дней.', show_alert: true });
         }
    }
    // --- Manage Notifications ---
    else if (callbackData === 'settings_manage_notifications') {
        const ns = currentSettings.notificationSettings;
        const inline_keyboard = [
            // Group related notifications
            [{ text: `Новый/Принят/Отклонен ${ns.onNewPending && ns.onAccepted && ns.onRejected ? '✅' : (ns.onNewPending || ns.onAccepted || ns.onRejected ? '☑️' : '❌')}`, callback_data: 'settings_toggle_notify_group_new' }],
            [{ text: `Погашение (полное/частичн.) ${ns.onRepaid ? '✅' : '❌'}`, callback_data: 'settings_toggle_notify_onRepaid' }],
            [{ text: `Запрос/Подтв./Откл. Удаления ${ns.onDeleteRequest && ns.onDeleteConfirm && ns.onDeleteReject ? '✅' : (ns.onDeleteRequest || ns.onDeleteConfirm || ns.onDeleteReject ? '☑️' : '❌')}`, callback_data: 'settings_toggle_notify_group_delete' }],
            [{ text: `Запрос/Подтв./Откл. Изменения ${ns.onEditRequest && ns.onEditConfirm && ns.onEditReject ? '✅' : (ns.onEditRequest || ns.onEditConfirm || ns.onEditReject ? '☑️' : '❌')}`, callback_data: 'settings_toggle_notify_group_edit' }],
            // Use dedicated back button
            [{ text: '⬅️ Назад к настройкам', callback_data: 'settings_back_to_main_from_notify' }]
        ];
         await botInstance.editMessageText('Настройки уведомлений (нажмите для вкл/выкл группы):', {
             chat_id: chatId,
             message_id: msg.message_id,
             reply_markup: { inline_keyboard }
         });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
     // --- Back from Notification Management ---
     else if (callbackData === 'settings_back_to_main_from_notify') {
         await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' });
     }
    // --- Toggle Notification Groups/Individual ---
    else if (callbackData.startsWith('settings_toggle_notify_')) {
         const key = callbackData.substring(23);
         let changed = false;
         let newState = false; // Default to turning on if toggling a group

         const toggleGroup = (keys) => {
             const currentState = keys.every(k => currentSettings.notificationSettings[k]);
             newState = !currentState;
             keys.forEach(k => currentSettings.notificationSettings[k] = newState);
             changed = true;
         };

         if (key === 'group_new') {
             toggleGroup(['onNewPending', 'onAccepted', 'onRejected']);
         } else if (key === 'group_delete') {
             toggleGroup(['onDeleteRequest', 'onDeleteConfirm', 'onDeleteReject']);
         } else if (key === 'group_edit') {
             toggleGroup(['onEditRequest', 'onEditConfirm', 'onEditReject']);
         } else if (currentSettings.notificationSettings.hasOwnProperty(key)) {
             currentSettings.notificationSettings[key] = !currentSettings.notificationSettings[key];
             newState = currentSettings.notificationSettings[key]; // Get the new state for individual toggle
             changed = true;
         }

         if (changed) {
             await dataStore.writeUserData(userId, userData);
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: `Уведомления ${key.startsWith('group') ? 'группы' : ''} ${newState ? 'ВКЛ' : 'ВЫКЛ'}` });
             // Refresh notification settings view (edit is fine)
             await handleSettingsCallback({ ...callbackQuery, data: 'settings_manage_notifications' });
         } else {
             await botInstance.answerCallbackQuery(callbackQuery.id); // Acknowledge if key not found
         }
    }
    // --- Export Data ---
     else if (callbackData === 'settings_export_data') {
         const userPath = dataStore.getUserDataPath(userId);
         if (userPath && fs.existsSync(userPath)) {
             try {
                 await botInstance.sendDocument(chatId, userPath, { caption: `Ваши данные (${path.basename(userPath)}). Храните его в безопасности.` });
                 await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Файл данных отправлен.' });
             } catch (error) {
                 console.error(`Error sending document ${userPath} to ${userId}:`, error);
                 await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Не удалось отправить файл.', show_alert: true });
             }
         } else {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Файл данных не найден.', show_alert: true });
         }
         // Don't close settings automatically after export
         // Refresh main settings view using the improved back logic
         await handleSettingsCallback({ ...callbackQuery, data: 'settings_back_to_main' });
     }
    // --- Unknown Setting ---
    else {
        await botInstance.answerCallbackQuery(callbackQuery.id); // Acknowledge silently
    }
}

// --- Debt Action Callbacks (Accept/Reject/Confirm Delete/Confirm Edit/Snooze) ---
async function handleDebtActionCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data; // e.g., debt_accept_{linkedId}, debt_confirmdelete_{linkedId}, debt_acceptedit_{linkedId}, debt_snooze_{debtId}

    const parts = callbackData.split('_');
    if (parts.length < 3) {
        console.error("Invalid debt action callback format:", callbackData);
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка запроса.', show_alert: true });
        return;
    }

    const action = parts[1]; // accept, reject, confirmdelete, rejectdelete, acceptedit, rejectedit, snooze
    const id = parts.slice(2).join('_'); // Can be linkedDebtId or debtId

    let success = false;
    let responseText = 'Ошибка обработки.';
    let alert = true;
    let editOriginalMessage = true; // Flag to control if we edit the message with buttons

    if (action === 'accept' || action === 'reject') {
        const result = await debtLogic.handleDebtAcceptance(botInstance, userId, id, action === 'accept');
        success = result.success;
        responseText = result.message;
        alert = !success;
    } else if (action === 'confirmdelete' || action === 'rejectdelete') {
         const result = await debtLogic.handleDeletionConfirmation(botInstance, userId, id, action === 'confirmdelete');
         success = result.success;
         responseText = result.message;
         alert = !success;
    } else if (action === 'acceptedit' || action === 'rejectedit') { // New Edit Confirmation
         const result = await debtLogic.handleEditConfirmation(botInstance, userId, id, action === 'acceptedit');
         success = result.success;
         responseText = result.message;
         alert = !success;
    } else if (action === 'snooze') { // New Snooze Action
        const debtId = id;
        const userData = await dataStore.readUserData(userId);
        let debtFound = false;
        // Find the debt in either list
        const findAndSnooze = (list) => {
            const debt = list?.find(d => d.id === debtId);
            if (debt) {
                const snoozeUntil = new Date();
                snoozeUntil.setDate(snoozeUntil.getDate() + 1); // Snooze for 1 day
                snoozeUntil.setHours(0, 0, 0, 0); // Set to start of the next day
                debt.reminderSnoozedUntil = snoozeUntil.toISOString();
                debtFound = true;
                return true;
            }
            return false;
        };

        if (findAndSnooze(userData.debts.iOwe) || findAndSnooze(userData.debts.oweMe)) {
             await dataStore.writeUserData(userId, userData);
             success = true;
             responseText = `Напоминание отложено до ${new Date(userData.debts.iOwe.find(d=>d.id===debtId)?.reminderSnoozedUntil || userData.debts.oweMe.find(d=>d.id===debtId)?.reminderSnoozedUntil).toLocaleDateString('ru-RU')}.`;
             alert = false;
        } else {
            responseText = 'Не удалось найти долг для откладывания напоминания.';
        }
    }
    else {
        console.error("Unknown debt action:", action);
        responseText = 'Неизвестное действие.';
        editOriginalMessage = false; // Don't edit message for unknown actions
    }

    if (success && editOriginalMessage) {
        try {
            // Edit the original message (e.g., the one with Accept/Reject buttons)
            await botInstance.editMessageText(responseText, {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: null // Remove buttons
            });
        } catch (error) {
            console.log("Info: Could not edit debt action message (maybe already edited/deleted).");
            // Send as new message if editing fails and it wasn't just a snooze confirmation
            if (action !== 'snooze') {
                 await botInstance.sendMessage(chatId, responseText);
            }
        }
    } else if (!success && editOriginalMessage) {
         // Optionally edit message on failure too, keeping buttons might be confusing though
         try {
             await botInstance.editMessageText(`${responseText}\n\n(Пожалуйста, попробуйте снова или отмените операцию)`, {
                 chat_id: chatId,
                 message_id: msg.message_id,
                 // Keep original buttons? Or remove them? Removing seems safer.
                 reply_markup: null
             });
         } catch (error) {
              console.log("Info: Could not edit debt action failure message.");
         }
    }


    await botInstance.answerCallbackQuery(callbackQuery.id, { text: responseText, show_alert: alert });
}


// --- Add Debt Callbacks ---
async function handleAddCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId];

    if (!state || state.command !== 'add') {
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Сессия добавления неактивна.', show_alert: true });
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        return;
    }

    // --- Select Type ---
    if (state.step === 'ask_type' && (callbackData === 'add_oweMe' || callbackData === 'add_iOwe')) {
        state.data.type = callbackData.substring(4); // 'oweMe' or 'iOwe'
        state.step = 'ask_name';

        const userData = await dataStore.readUserData(userId);
        const knownUsers = userData.knownUsers || {};
        const knownUserIds = Object.keys(knownUsers);

        let prompt = `Тип: ${state.data.type === 'iOwe' ? 'Я должен' : 'Мне должны'}.\n`;
        const inline_keyboard = [];

        if (knownUserIds.length > 0) {
            prompt += `Введите имя/@username ${state.data.type === 'iOwe' ? 'кому вы должны' : 'кто вам должен'} или выберите из списка:`;
            // Add known user buttons (limit to a reasonable number initially?)
            const maxButtons = 5;
             knownUserIds.slice(0, maxButtons).forEach(knownId => {
                 const name = knownUsers[knownId] || `User_${knownId}`;
                 inline_keyboard.push([{ text: `👤 ${name}`, callback_data: `add_known_${knownId}` }]);
             });
             if (knownUserIds.length > maxButtons) {
                 // TODO: Add pagination for known users if many exist
                 inline_keyboard.push([{ text: `Показать больше...`, callback_data: `add_known_more_0` }]);
             }
        } else {
            prompt += `Введите имя или @username ${state.data.type === 'iOwe' ? 'кому вы должны' : 'кто вам должен'}:`;
        }

        inline_keyboard.push([{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]);

        await botInstance.editMessageText(prompt, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard }
        });
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Known User ---
    else if (state.step === 'ask_name' && callbackData.startsWith('add_known_')) {
        // Handle pagination for known users later if implemented
        if (callbackData.startsWith('add_known_more_')) {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Пагинация контактов пока не реализована.' });
             return;
        }

        const knownUserId = callbackData.substring(10);
        const userData = await dataStore.readUserData(userId);
        const knownUsername = userData.knownUsers[knownUserId];

        if (knownUsername) {
            state.data.partyIdentifier = knownUsername; // Use the known name/username
            state.data.partyUserId = knownUserId; // Store the ID for potential linking
            state.step = 'ask_amount';
            await botInstance.editMessageText(`Выбран контакт: ${knownUsername}.\nВведите сумму долга:`, {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]] }
            });
        } else {
            await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Контакт не найден.', show_alert: true });
            // Stay on the same step
        }
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Currency ---
    else if (state.step === 'ask_currency' && callbackData.startsWith('add_')) {
        const currency = callbackData.substring(4);
        if (isValidCurrency(currency)) {
            state.data.currency = currency;
            state.step = 'ask_dueDate';
            await botInstance.editMessageText(`Валюта: ${state.data.currency}.\nВведите дату возврата (ДД-ММ-ГГГГ) или /skip:`, {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]] }
            });
        } else {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Неверная валюта.', show_alert: true });
        }
         await botInstance.answerCallbackQuery(callbackQuery.id);
    } else {
        await botInstance.answerCallbackQuery(callbackQuery.id); // Acknowledge other add callbacks
    }
}

// --- Repay Debt Callbacks ---
async function handleRepayCallback(callbackQuery) {
     const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId];

     if (!state || state.command !== 'repay') {
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Сессия погашения неактивна.', show_alert: true });
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        return;
    }

    // --- Select Type ---
    if (state.step === 'ask_type' && (callbackData === 'repay_oweMe' || callbackData === 'repay_iOwe')) {
        state.data.type = callbackData.substring(6); // 'oweMe' or 'iOwe'
        state.step = 'select_debt';

        const userData = await dataStore.readUserData(userId);
        const debtsToList = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);
        // Filter for repayable debts (active or manual)
        const repayableDebts = debtsToList.filter(d => d.status === DEBT_STATUS.ACTIVE || d.status === DEBT_STATUS.MANUAL);

        if (repayableDebts.length === 0) {
            await botInstance.editMessageText('Нет активных долгов этого типа для погашения.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }

        const inline_keyboard = repayableDebts.map((debt) => {
            const partyName = userData.knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
            const text = `${partyName} - ${debt.amount.toFixed(2)} ${debt.currency}${debt.dueDate ? ' (до ' + formatDate(debt.dueDate) + ')' : ''}`;
            // Use the unique debt ID in the callback data
            return [{ text: text, callback_data: `repay_select_${debt.id}` }];
        });
        inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'repay_back_to_type' }]);

        await botInstance.editMessageText('Выберите долг для погашения:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard },
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Debt ---
    else if (state.step === 'select_debt' && callbackData.startsWith('repay_select_')) {
        const debtId = callbackData.substring(13);
        const userData = await dataStore.readUserData(userId);
        const debts = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);
        const selectedDebt = debts.find(d => d.id === debtId);

        if (!selectedDebt) {
            await botInstance.editMessageText('Ошибка: Долг не найден. Возможно, он был изменен. Попробуйте снова.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }
         // Double check status
        if (selectedDebt.status !== DEBT_STATUS.ACTIVE && selectedDebt.status !== DEBT_STATUS.MANUAL) {
            await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Этот долг нельзя погасить (он не активен).', show_alert: true });
            return; // Stay on selection screen
        }

        state.data.debtId = debtId; // Store ID instead of index
        state.data.selectedDebt = selectedDebt; // Store the debt details
        state.step = 'ask_repay_amount';

        const partyName = userData.knownUsers[selectedDebt.partyUserId] || selectedDebt.partyIdentifier || 'Неизвестный';
        await botInstance.editMessageText(`Выбран долг: ${partyName}, Сумма: ${selectedDebt.amount.toFixed(2)} ${selectedDebt.currency}.\n\nВведите сумму погашения (максимум ${selectedDebt.amount.toFixed(2)}):`, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад к выбору долга', callback_data: 'repay_back_to_select' }]] }
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Back Buttons ---
    else if (callbackData === 'repay_back_to_type') { // Back from selection to type
        state.step = 'ask_type';
        delete state.data.type; // Clear selection
        // Re-trigger the initial repay button handler to show type selection
        const fakeMsg = { chat: { id: chatId }, from: { id: userId } }; // Minimal msg object
        await require('./commandHandlers').handleRepayDebtButton(botInstance, fakeMsg);
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {} // Delete current message
        await botInstance.answerCallbackQuery(callbackQuery.id);
    } else if (callbackData === 'repay_back_to_select') { // Back from amount to selection
        state.step = 'select_debt';
        delete state.data.debtId;
        delete state.data.selectedDebt;
        // Simulate selecting the type again to re-render the debt list
        const typeCallback = state.data.type === 'iOwe' ? 'repay_iOwe' : 'repay_oweMe';
        await handleRepayCallback({ ...callbackQuery, data: typeCallback, message: msg }); // Re-call handler
        // No need to delete message here, handleRepayCallback will edit it
        await botInstance.answerCallbackQuery(callbackQuery.id);
    } else {
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
}

// --- Delete Debt Callbacks ---
async function handleDeleteCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId];

    if (!state || state.command !== 'delete') {
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Сессия удаления неактивна.', show_alert: true });
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        return;
    }

     // --- Select Type ---
    if (state.step === 'ask_type' && (callbackData === 'delete_oweMe' || callbackData === 'delete_iOwe')) {
        state.data.type = callbackData.substring(7); // 'oweMe' or 'iOwe'
        state.step = 'select_debt';

        const userData = await dataStore.readUserData(userId);
        const debtsToList = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);

        if (debtsToList.length === 0) {
            await botInstance.editMessageText('Нет долгов этого типа для удаления.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }

        const { getStatusText } = require('../utils/formatting'); // Import helper
        const inline_keyboard = debtsToList.map((debt) => {
            const partyName = userData.knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
            const statusText = getStatusText(debt.status, partyName); // Use helper
            const text = `${partyName} - ${debt.amount.toFixed(2)} ${debt.currency} ${statusText}`;
            return [{ text: text, callback_data: `delete_select_${debt.id}` }]; // Use ID
        });
        inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'delete_back_to_type' }]);

        await botInstance.editMessageText('Выберите долг для удаления/отмены:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard },
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Debt ---
    else if (state.step === 'select_debt' && callbackData.startsWith('delete_select_')) {
        const debtId = callbackData.substring(14);
        const userData = await dataStore.readUserData(userId);
        const debts = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);
        const selectedDebt = debts.find(d => d.id === debtId);

        if (!selectedDebt) {
            await botInstance.editMessageText('Ошибка: Долг не найден. Возможно, он был изменен. Попробуйте снова.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }

        state.data.debtId = debtId;
        state.data.selectedDebt = selectedDebt;
        state.step = 'confirm_delete';

        const partyName = userData.knownUsers[selectedDebt.partyUserId] || selectedDebt.partyIdentifier || 'Неизвестный';
        const details = `Долг: ${state.data.type === 'iOwe' ? 'Я должен' : 'Мне должны'} ${partyName}\nСумма: ${selectedDebt.amount.toFixed(2)} ${selectedDebt.currency}${selectedDebt.dueDate ? '\nДата: '+formatDate(selectedDebt.dueDate) : ''}`;
        let confirmationText = '';
        let keyboard;

        if (selectedDebt.status === DEBT_STATUS.MANUAL || selectedDebt.status === DEBT_STATUS.PENDING_CONFIRMATION) {
            confirmationText = `Вы уверены, что хотите удалить этот *${selectedDebt.status === DEBT_STATUS.MANUAL ? 'ручной' : 'ожидающий связи'}* долг?\n\n${details}`;
            keyboard = [[{ text: '🗑️ Да, удалить', callback_data: 'delete_confirm_yes' }], [{ text: '🚫 Нет, отмена', callback_data: 'delete_confirm_no' }]];
        } else if (selectedDebt.status === DEBT_STATUS.ACTIVE || selectedDebt.status === DEBT_STATUS.PENDING_EDIT_APPROVAL) {
             confirmationText = `Этот долг связан с ${partyName}. Удаление потребует его подтверждения.\n\n${details}\n\nОтправить запрос на удаление?`;
             keyboard = [[{ text: '✉️ Да, запросить удаление', callback_data: 'delete_confirm_request' }], [{ text: '🚫 Нет, отмена', callback_data: 'delete_confirm_no' }]];
        } else if (selectedDebt.status === DEBT_STATUS.PENDING_APPROVAL) {
             confirmationText = `Этот долг еще не подтвержден (${selectedDebt.partyUserId === userId ? 'вами' : partyName}). Вы уверены, что хотите отменить его?\n\n${details}`;
             keyboard = [[{ text: '🗑️ Да, отменить', callback_data: 'delete_confirm_cancel_pending' }], [{ text: '🚫 Нет, оставить', callback_data: 'delete_confirm_no' }]];
        } else if (selectedDebt.status === DEBT_STATUS.PENDING_DELETION_APPROVAL) {
             // Check who initiated the delete request (the other party)
             const initiatorIsOtherParty = selectedDebt.partyUserId !== userId; // If partyUserId is the other person, they initiated
             if (initiatorIsOtherParty) {
                 // This user received the request, they can confirm/reject
                 confirmationText = `${partyName} запросил удаление этого долга. Подтвердить или отклонить?\n\n${details}`;
                 keyboard = [
                     [{ text: '🗑️ Подтвердить удаление', callback_data: `debt_confirmdelete_${selectedDebt.linkedDebtId}` }], // Use action handler
                     [{ text: '🚫 Отклонить удаление', callback_data: `debt_rejectdelete_${selectedDebt.linkedDebtId}` }] // Use action handler
                 ];
                 // We don't need to proceed with the state machine here, the action handler will take over
                 state.step = 'external_confirmation'; // Mark state to prevent accidental reuse
             } else {
                 // This user initiated the request, they can cancel it
                 confirmationText = `Этот долг ожидает подтверждения удаления от ${partyName}. Вы хотите отменить свой запрос на удаление?\n\n${details}`;
                 keyboard = [[{ text: '↩️ Да, отменить запрос', callback_data: 'delete_confirm_cancel_request' }], [{ text: '🚫 Нет, оставить запрос', callback_data: 'delete_confirm_no' }]];
             }
        }
        else {
            // Should not happen for other statuses if filtering is correct
             confirmationText = `Не удалось определить действие для этого долга (статус: ${selectedDebt.status}). Отмена операции.`;
             keyboard = [[{ text: 'ОК', callback_data: 'delete_confirm_no' }]]; // Just provide a way back
        }

        await botInstance.editMessageText(confirmationText, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Confirm Delete Action (From User's Perspective) ---
    else if (state.step === 'confirm_delete') {
        const debtId = state.data.debtId;
        let result = { success: false, message: 'Действие не выполнено.' };

        if (callbackData === 'delete_confirm_yes') { // Delete manual or pending_confirmation
            result = await debtLogic.deleteManualDebt(userId, debtId); // Handles both manual and pending_confirmation
        } else if (callbackData === 'delete_confirm_request') { // Request linked delete
            result = await debtLogic.requestLinkedDebtDeletion(botInstance, userId, debtId);
        } else if (callbackData === 'delete_confirm_cancel_pending') { // Cancel pending add (PENDING_APPROVAL)
             result = await debtLogic.cancelPendingDebt(botInstance, userId, debtId);
        } else if (callbackData === 'delete_confirm_cancel_request') { // Cancel pending delete request (initiated by current user)
             result = await debtLogic.cancelDeleteRequest(botInstance, userId, debtId);
        } else if (callbackData === 'delete_confirm_no') { // Go back to selection
            state.step = 'select_debt';
            delete state.data.debtId;
            delete state.data.selectedDebt;
            const typeCallback = state.data.type === 'iOwe' ? 'delete_iOwe' : 'delete_oweMe';
            await handleDeleteCallback({ ...callbackQuery, data: typeCallback, message: msg }); // Re-call handler
            // No need to delete message here, handler will edit it
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return; // Don't proceed further
        }

        // If an action was taken (not 'no')
        if (callbackData !== 'delete_confirm_no') {
             await botInstance.editMessageText(result.message, {
                chat_id: chatId,
                message_id: msg.message_id,
                reply_markup: null
            });
            await botInstance.answerCallbackQuery(callbackQuery.id, { text: result.success ? 'Выполнено' : 'Ошибка' });
            delete userStates[chatId]; // Clear state after action
        }

    }
    // --- Back Buttons ---
    else if (callbackData === 'delete_back_to_type') {
        state.step = 'ask_type';
        delete state.data.type;
        const fakeMsg = { chat: { id: chatId }, from: { id: userId } }; // Minimal msg object
        await require('./commandHandlers').handleDeleteDebtButton(botInstance, fakeMsg);
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        await botInstance.answerCallbackQuery(callbackQuery.id);
    } else {
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
}

// --- Edit Debt Callbacks ---
async function handleEditCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId];

     if (!state || state.command !== 'edit') {
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Сессия редактирования неактивна.', show_alert: true });
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        return;
    }

    // --- Select Type ---
    if (state.step === 'ask_type' && (callbackData === 'edit_oweMe' || callbackData === 'edit_iOwe')) {
        state.data.type = callbackData.substring(5); // 'oweMe' or 'iOwe'
        state.step = 'select_debt';

        const userData = await dataStore.readUserData(userId);
        const debtsToList = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);
        // Filter for editable debts (active or manual)
        const editableDebts = debtsToList.filter(d => d.status === DEBT_STATUS.ACTIVE || d.status === DEBT_STATUS.MANUAL);

        if (editableDebts.length === 0) {
            await botInstance.editMessageText('Нет долгов этого типа для редактирования.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }

        const inline_keyboard = editableDebts.map((debt) => {
            const partyName = userData.knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
            const text = `${partyName} - ${debt.amount.toFixed(2)} ${debt.currency}${debt.dueDate ? ' (до ' + formatDate(debt.dueDate) + ')' : ''}`;
            return [{ text: text, callback_data: `edit_select_${debt.id}` }]; // Use ID
        });
        inline_keyboard.push([{ text: '⬅️ Назад', callback_data: 'edit_back_to_type' }]);

        await botInstance.editMessageText('Выберите долг для редактирования:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard },
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Debt ---
    else if (state.step === 'select_debt' && callbackData.startsWith('edit_select_')) {
        const debtId = callbackData.substring(12);
        const userData = await dataStore.readUserData(userId);
        const debts = state.data.type === 'iOwe' ? (userData.debts.iOwe || []) : (userData.debts.oweMe || []);
        const selectedDebt = debts.find(d => d.id === debtId);

        if (!selectedDebt || (selectedDebt.status !== DEBT_STATUS.ACTIVE && selectedDebt.status !== DEBT_STATUS.MANUAL)) {
            await botInstance.editMessageText('Ошибка: Долг не найден или не может быть отредактирован. Попробуйте снова.', { chat_id: chatId, message_id: msg.message_id, reply_markup: null });
            delete userStates[chatId];
            await botInstance.answerCallbackQuery(callbackQuery.id);
            return;
        }

        state.data.debtId = debtId;
        state.data.originalDebt = { ...selectedDebt }; // Store original for comparison/history
        state.step = 'select_field';

        const partyName = userData.knownUsers[selectedDebt.partyUserId] || selectedDebt.partyIdentifier || 'Неизвестный';
        const details = `Долг: ${state.data.type === 'iOwe' ? 'Я должен' : 'Мне должны'} ${partyName}\nСумма: ${selectedDebt.amount.toFixed(2)} ${selectedDebt.currency}${selectedDebt.dueDate ? '\nДата: '+formatDate(selectedDebt.dueDate) : ''}`;

        const inline_keyboard = [
            [{ text: `Сумма (${selectedDebt.amount.toFixed(2)})`, callback_data: 'edit_field_amount' }],
            [{ text: `Валюта (${selectedDebt.currency})`, callback_data: 'edit_field_currency' }],
            [{ text: `Дата (${formatDate(selectedDebt.dueDate)})`, callback_data: 'edit_field_dueDate' }],
            // [{ text: `Комментарий`, callback_data: 'edit_field_comment' }], // Future
        ];
        // Allow changing party only for manual debts
        if (selectedDebt.status === DEBT_STATUS.MANUAL) {
             inline_keyboard.push([{ text: `Контакт (${partyName})`, callback_data: 'edit_field_partyIdentifier' }]); // Use partyIdentifier
        }
         inline_keyboard.push([{ text: '⬅️ Назад к выбору долга', callback_data: 'edit_back_to_select' }]);
         inline_keyboard.push([{ text: '🚫 Отмена редактирования', callback_data: 'cancel_operation' }]);


        await botInstance.editMessageText(`Выбран долг:\n${details}\n\nКакое поле вы хотите изменить?`, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard }
        });
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    // --- Select Field to Edit ---
    else if (state.step === 'select_field' && callbackData.startsWith('edit_field_')) {
        const field = callbackData.substring(11); // amount, currency, dueDate, partyIdentifier
        state.data.fieldToEdit = field;
        state.step = 'ask_new_value';
        state.message_id = msg.message_id; // Store message ID to delete later

        let prompt = '';
        let keyboard = [[{ text: '⬅️ Назад к выбору поля', callback_data: 'edit_back_to_field' }]]; // Default back button

        switch (field) {
            case 'amount':
                prompt = `Введите новую сумму (текущая: ${state.data.originalDebt.amount.toFixed(2)}):`;
                break;
            case 'currency':
                prompt = `Выберите новую валюту (текущая: ${state.data.originalDebt.currency}):`;
                const currencyButtons = SUPPORTED_CURRENCIES.map(curr => ([{
                    text: `${curr} ${state.data.originalDebt.currency === curr ? '✅' : ''}`,
                    callback_data: `edit_set_currency_${curr}`
                }]));
                 keyboard = [...currencyButtons, ...keyboard]; // Add currency buttons
                state.step = 'set_currency'; // Special step for currency selection via buttons
                break;
            case 'dueDate':
                prompt = `Введите новую дату возврата (ДД-ММ-ГГГГ) или /skip для удаления (текущая: ${formatDate(state.data.originalDebt.dueDate)}):`;
                break;
             case 'partyIdentifier': // Only for manual
                 prompt = `Введите новое имя контакта (текущее: ${state.data.originalDebt.partyIdentifier}):`;
                 break;
            default:
                await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Неизвестное поле.', show_alert: true });
                return;
        }

        await botInstance.editMessageText(prompt, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: keyboard }
        });
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
     // --- Set Currency (via button) ---
     else if (state.step === 'set_currency' && callbackData.startsWith('edit_set_currency_')) {
         const newCurrency = callbackData.substring(18);
         if (isValidCurrency(newCurrency)) {
             state.data.newValue = newCurrency;
             // Now finalize the edit
             await finalizeEdit(botInstance, chatId, userId, state);
         } else {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Неверная валюта.', show_alert: true });
         }
         await botInstance.answerCallbackQuery(callbackQuery.id);
     }
    // --- Back Buttons ---
    else if (callbackData === 'edit_back_to_type') {
        state.step = 'ask_type';
        delete state.data.type;
        const fakeMsg = { chat: { id: chatId }, from: { id: userId } }; // Minimal msg object
        await require('./commandHandlers').handleEditDebtButton(botInstance, fakeMsg);
         try { await botInstance.deleteMessage(chatId, msg.message_id); } catch(e) {}
        await botInstance.answerCallbackQuery(callbackQuery.id);
    } else if (callbackData === 'edit_back_to_select') {
        state.step = 'select_debt';
        delete state.data.debtId;
        delete state.data.originalDebt;
        const typeCallback = state.data.type === 'iOwe' ? 'edit_iOwe' : 'edit_oweMe';
        await handleEditCallback({ ...callbackQuery, data: typeCallback, message: msg });
         // No need to delete message here, handler will edit it
        await botInstance.answerCallbackQuery(callbackQuery.id);
    } else if (callbackData === 'edit_back_to_field') {
         state.step = 'select_field';
         delete state.data.fieldToEdit;
         const debtCallback = `edit_select_${state.data.debtId}`;
         await handleEditCallback({ ...callbackQuery, data: debtCallback, message: msg });
         // No need to delete message here, handler will edit it
         await botInstance.answerCallbackQuery(callbackQuery.id);
    }
    else {
        await botInstance.answerCallbackQuery(callbackQuery.id);
    }
}

// --- History Callbacks ---
async function handleHistoryCallback(callbackQuery) {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id.toString();
    const callbackData = callbackQuery.data;
    const state = userStates[chatId]; // Use state for multi-step filtering

    const filterStateKey = `${chatId}_history_filters`;

    // --- Close History ---
    if (callbackData === 'history_close') {
        delete userStates[filterStateKey]; // Clear filters when closing
        delete userStates[chatId]; // Clear any active filter state
        try { await botInstance.deleteMessage(chatId, msg.message_id); } catch (e) {}
        await botInstance.answerCallbackQuery(callbackQuery.id);
        return;
    }

    // --- Reset Filters ---
    if (callbackData === 'history_filter_reset') {
        delete userStates[filterStateKey];
        delete userStates[chatId]; // Clear any active filter state
        await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Фильтры сброшены.' });
        // Refresh history view (page 1)
        await require('./commandHandlers').handleHistoryButton(botInstance, msg, 1);
        // No need to delete message, handleHistoryButton will edit it
        return;
    }

     // --- History Pagination ---
     if (callbackData.startsWith('history_page_')) {
         const page = parseInt(callbackData.substring(13), 10);
         await require('./commandHandlers').handleHistoryButton(botInstance, msg, page);
         await botInstance.answerCallbackQuery(callbackQuery.id);
         return;
     }


     // --- Filter by Contact ---
     if (callbackData === 'history_filter_contact') {
         const userData = await dataStore.readUserData(userId);
         const knownUsers = userData.knownUsers || {};
         // Get unique contacts *present in the history*
         const historyContacts = [...new Set(userData.history?.map(h => h.partyUserId).filter(id => id))]
            .map(id => ({ id: id, name: knownUsers[id] || `User_${id}` }))
            .sort((a, b) => a.name.localeCompare(b.name)); // Sort contacts alphabetically


         if (historyContacts.length === 0) {
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Нет контактов в истории для фильтрации.', show_alert: true });
             return;
         }

         userStates[chatId] = { command: 'history_filter', step: 'select_contact' }; // Use main state

         const inline_keyboard = historyContacts.map(contact => ([
             { text: contact.name, callback_data: `history_set_contact_${contact.id}` }
         ]));
         inline_keyboard.push([{ text: '🚫 Сбросить контакт', callback_data: 'history_set_contact_reset' }]);
         inline_keyboard.push([{ text: '⬅️ Назад к истории', callback_data: 'history_back_to_main' }]);

         await botInstance.editMessageText('Выберите контакт для фильтрации истории:', {
             chat_id: chatId,
             message_id: msg.message_id,
             reply_markup: { inline_keyboard }
         });
         await botInstance.answerCallbackQuery(callbackQuery.id);
     }
     // --- Set Contact Filter ---
     else if (state?.command === 'history_filter' && state.step === 'select_contact' && callbackData.startsWith('history_set_contact_')) {
         const contactId = callbackData.substring(20);
         if (!userStates[filterStateKey]) userStates[filterStateKey] = {};

         if (contactId === 'reset') {
             delete userStates[filterStateKey].contactUserId;
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Фильтр по контакту сброшен.' });
         } else {
             userStates[filterStateKey].contactUserId = contactId;
             await botInstance.answerCallbackQuery(callbackQuery.id, { text: 'Фильтр по контакту установлен.' });
         }
         delete userStates[chatId]; // Clear command state
         // Refresh history view (page 1)
         await require('./commandHandlers').handleHistoryButton(botInstance, msg, 1);
         // No need to delete message, handleHistoryButton will edit it
     }

     // --- Filter by Date ---
     else if (callbackData === 'history_filter_date') {
         userStates[chatId] = { command: 'history_filter', step: 'ask_start_date', message_id: msg.message_id };
         await botInstance.editMessageText('Введите начальную дату фильтра (ДД-ММ-ГГГГ) или /skip:', {
             chat_id: chatId,
             message_id: msg.message_id,
             reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад к истории', callback_data: 'history_back_to_main' }]] }
         });
         await botInstance.answerCallbackQuery(callbackQuery.id);
     }

     // --- Back to History Main View (from filter selection) ---
      else if (callbackData === 'history_back_to_main') {
         delete userStates[chatId]; // Clear command state
         // Refresh history view (stay on current page if possible, default to 1)
         // We don't easily know the current page here, so default to 1
         await require('./commandHandlers').handleHistoryButton(botInstance, msg, 1);
         // No need to delete message, handleHistoryButton will edit it
         await botInstance.answerCallbackQuery(callbackQuery.id);
     }

    else {
        await botInstance.answerCallbackQuery(callbackQuery.id); // Acknowledge others
    }
}


// --- Helper to Finalize Edit ---
// Called from message handler or directly if value set by button (e.g., currency)
async function finalizeEdit(bot, chatId, userId, state) {
    const { debtId, fieldToEdit, newValue, originalDebt, message_id } = state.data;

    if (!debtId || !fieldToEdit || newValue === undefined || !originalDebt) {
        console.error("Incomplete state for finalizeEdit:", state.data);
        await bot.sendMessage(chatId, "Ошибка: Недостаточно данных для завершения редактирования.");
        delete userStates[chatId];
        return;
    }

    // Call the logic function which now handles manual vs linked (request)
    const result = await debtLogic.editDebt(bot, userId, debtId, fieldToEdit, newValue, originalDebt);

    // Send result as new message, replacing the prompt message
    try {
        // Try to delete the message where the value was asked/set
        if (message_id) {
            await bot.deleteMessage(chatId, message_id);
        }
    } catch(e) { console.log("Info: Could not delete edit prompt message."); }

    await bot.sendMessage(chatId, result.message);

    delete userStates[chatId];
}


module.exports = {
    initialize,
    handleCallbackQuery,
    finalizeEdit // Export for message handler
};
