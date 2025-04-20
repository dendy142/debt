const dataStore = require('../dataStore');
const { validateAmount, validateDate, isValidUsername } = require('../utils/validation');
const { parseDate } = require('../utils/helpers');
const debtLogic = require('../debtLogic');
const { finalizeEdit } = require('./callbackQueryHandlers'); // Import finalizeEdit
const { SUPPORTED_CURRENCIES } = require('../constants');

// In-memory state store (passed from bot.js)
let userStates = {};
let botInstance; // Store bot instance

function initialize(bot, states) {
    botInstance = bot;
    userStates = states;
}

async function handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;
    const state = userStates[chatId];

    if (!state || !state.command) {
        // Not in a command state, ignore or provide help?
        // console.log(`Ignoring message from ${userId} as no state found.`);
        return;
    }

    // --- Handle Add Debt Flow ---
    if (state.command === 'add') {
        await handleAddDebtSteps(chatId, userId, text, state, msg.message_id);
    }
    // --- Handle Repay Debt Flow ---
    else if (state.command === 'repay') {
        await handleRepayDebtSteps(chatId, userId, text, state, msg.message_id);
    }
     // --- Handle Edit Debt Flow ---
     else if (state.command === 'edit') {
         await handleEditDebtSteps(chatId, userId, text, state, msg.message_id);
     }
     // --- Handle History Filter Flow ---
     else if (state.command === 'history_filter') {
         await handleHistoryFilterSteps(chatId, userId, text, state, msg.message_id);
     }
    // --- Handle other commands if needed ---

}

// --- Add Debt Step Handler ---
async function handleAddDebtSteps(chatId, userId, text, state, message_id) {
    const bot = botInstance; // Use stored instance

    // --- Ask Name/Username ---
    if (state.step === 'ask_name') {
        const partyIdentifier = text.trim();
        if (!partyIdentifier) {
            await bot.sendMessage(chatId, 'Имя/username не может быть пустым. Попробуйте снова:');
            return;
        }
        state.data.partyIdentifier = partyIdentifier;
        state.data.partyUserId = null; // Reset if name was typed

        // Check if it's a valid username format, try to find user ID
        if (isValidUsername(partyIdentifier)) {
            const foundUserId = await dataStore.findUserByUsername(userId, partyIdentifier);
            if (foundUserId) {
                state.data.partyUserId = foundUserId;
                console.log(`Add Debt: Linked user ${partyIdentifier} to ID ${foundUserId}`);
            } else {
                 console.log(`Add Debt: Username ${partyIdentifier} provided but user not found/linked yet.`);
            }
        }

        state.step = 'ask_amount';
        // Edit the previous message (which had the known user buttons)
        try {
            await bot.editMessageText(`Контакт: ${partyIdentifier}.\nВведите сумму долга:`, {
                chat_id: chatId,
                message_id: state.message_id || message_id, // Use stored message_id if available
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]] }
            });
            state.message_id = state.message_id || message_id; // Store message_id for next step
        } catch (e) {
            console.log("Info: Could not edit 'ask_name' message, sending new one.");
            const sentMsg = await bot.sendMessage(chatId, `Контакт: ${partyIdentifier}.\nВведите сумму долга:`, {
                 reply_markup: { inline_keyboard: [[{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]] }
             });
             state.message_id = sentMsg.message_id; // Store new message ID
        }
    }
    // --- Ask Amount ---
    else if (state.step === 'ask_amount') {
        const amount = validateAmount(text);
        if (amount === null) {
            await bot.sendMessage(chatId, 'Неверный формат суммы. Введите число (например, 100 или 50.25):');
            return;
        }
        state.data.amount = amount;
        state.step = 'ask_currency';

        const userData = await dataStore.readUserData(userId);
        const defaultCurrency = userData.settings.defaultCurrency;
        const currencyButtons = SUPPORTED_CURRENCIES.map(curr => ([{
            text: `${curr} ${defaultCurrency === curr ? '✅' : ''}`,
            callback_data: `add_${curr}` // Use simple callback data
        }]));
        currencyButtons.push([{ text: '⬅️ Отмена', callback_data: 'cancel_operation' }]);

        try {
            await bot.editMessageText(`Сумма: ${amount.toFixed(2)}.\nВыберите валюту:`, {
                chat_id: chatId,
                message_id: state.message_id,
                reply_markup: { inline_keyboard: currencyButtons }
            });
        } catch (e) {
             console.log("Info: Could not edit 'ask_amount' message, sending new one.");
             const sentMsg = await bot.sendMessage(chatId, `Сумма: ${amount.toFixed(2)}.\nВыберите валюту:`, {
                 reply_markup: { inline_keyboard: currencyButtons }
             });
             state.message_id = sentMsg.message_id;
        }
    }
    // --- Ask Due Date ---
    else if (state.step === 'ask_dueDate') {
        let dueDate = null;
        if (text.toLowerCase() !== '/skip') {
            dueDate = validateDate(text);
            if (dueDate === null) {
                await bot.sendMessage(chatId, 'Неверный формат даты. Введите ДД-ММ-ГГГГ или /skip:');
                return;
            }
        }
        state.data.dueDate = dueDate;

        // --- Final Step: Add Debt ---
        const result = await debtLogic.addDebt(bot, userId, state.data);
        try {
            // Edit the last message (currency/date prompt) to show the result
            await bot.editMessageText(result.message, {
                chat_id: chatId,
                message_id: state.message_id,
                reply_markup: null // Remove buttons
            });
        } catch (e) {
             console.log("Info: Could not edit final 'add' message, sending new one.");
             await bot.sendMessage(chatId, result.message);
        }
        delete userStates[chatId]; // Clear state
    }
}

// --- Repay Debt Step Handler ---
async function handleRepayDebtSteps(chatId, userId, text, state, message_id) {
    const bot = botInstance;

    // --- Ask Repay Amount ---
    if (state.step === 'ask_repay_amount') {
        const repayAmount = validateAmount(text);
        const selectedDebt = state.data.selectedDebt; // Get stored debt details

        if (repayAmount === null) {
            await bot.sendMessage(chatId, 'Неверный формат суммы. Введите число:');
            return;
        }
        if (!selectedDebt) {
             await bot.sendMessage(chatId, 'Ошибка: Не найден выбранный долг. Пожалуйста, начните заново.');
             delete userStates[chatId];
             return;
        }
        if (repayAmount > selectedDebt.amount + 0.001) { // Add tolerance
            await bot.sendMessage(chatId, `Сумма погашения (${repayAmount.toFixed(2)}) не может быть больше остатка долга (${selectedDebt.amount.toFixed(2)}). Введите сумму снова:`);
            return;
        }

        state.data.repayAmount = repayAmount;

        // --- Final Step: Repay Debt ---
        const result = await debtLogic.repayDebt(bot, userId, state.data.debtId, state.data.type, repayAmount, selectedDebt);
         try {
            // Edit the last message (amount prompt) to show the result
            await bot.editMessageText(result.message, {
                chat_id: chatId,
                message_id: state.message_id || message_id,
                reply_markup: null // Remove buttons
            });
        } catch (e) {
             console.log("Info: Could not edit final 'repay' message, sending new one.");
             await bot.sendMessage(chatId, result.message);
        }
        delete userStates[chatId]; // Clear state
    }
}

// --- Edit Debt Step Handler ---
async function handleEditDebtSteps(chatId, userId, text, state, message_id) {
    const bot = botInstance;

    // --- Ask New Value ---
    if (state.step === 'ask_new_value') {
        const field = state.data.fieldToEdit;
        let newValue = text.trim();
        let validationError = null;

        // Validate and parse new value based on field
        switch (field) {
            case 'amount':
                const amount = validateAmount(newValue);
                if (amount === null) {
                    validationError = 'Неверный формат суммы. Введите число (например, 100 или 50.25):';
                } else {
                    newValue = amount; // Store validated number
                }
                break;
            case 'dueDate':
                 if (newValue.toLowerCase() === '/skip') {
                    newValue = null; // Allow clearing the date
                } else {
                    const date = validateDate(newValue);
                    if (date === null) {
                         validationError = 'Неверный формат даты. Введите ДД-ММ-ГГГГ или /skip:';
                    } else {
                        newValue = date; // Store validated date string
                    }
                }
                break;
            case 'partyIdentifier': // Only for manual debts
                 if (!newValue) {
                     validationError = 'Имя контакта не может быть пустым.';
                 }
                 // No specific format validation here, maybe add length check?
                 break;
             case 'currency': // Should be handled by callback, but catch just in case
                 validationError = 'Пожалуйста, выберите валюту с помощью кнопок.';
                 break;
            default:
                 validationError = 'Неизвестное поле для редактирования.';
        }

        if (validationError) {
            await bot.sendMessage(chatId, validationError);
            return; // Keep state, wait for valid input
        }

        // Store the validated new value
        state.data.newValue = newValue;

        // --- Final Step: Call Finalize Edit ---
        // finalizeEdit handles the logic (manual edit vs linked request) and sends the result message
        await finalizeEdit(bot, chatId, userId, state);
        // State is cleared within finalizeEdit
    }
}

// --- History Filter Step Handler ---
async function handleHistoryFilterSteps(chatId, userId, text, state, message_id) {
    const bot = botInstance;
    const filterStateKey = `${chatId}_history_filters`;
    if (!userStates[filterStateKey]) userStates[filterStateKey] = {};

    // --- Ask Start Date ---
    if (state.step === 'ask_start_date') {
        let startDate = null;
        if (text.toLowerCase() !== '/skip') {
            startDate = parseDate(text); // Use parseDate which returns Date object or null
            if (startDate === null) {
                await bot.sendMessage(chatId, 'Неверный формат даты. Введите ДД-ММ-ГГГГ или /skip:');
                return;
            }
        }
        userStates[filterStateKey].startDate = startDate; // Store Date object or null
        state.step = 'ask_end_date';
        // Edit previous message
        try {
            await bot.editMessageText(`Начальная дата: ${startDate ? startDate.toLocaleDateString('ru-RU') : 'Пропущено'}.\nВведите конечную дату фильтра (ДД-ММ-ГГГГ) или /skip:`, {
                chat_id: chatId,
                message_id: state.message_id,
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад к истории', callback_data: 'history_back_to_main' }]] }
            });
        } catch (e) {
             console.log("Info: Could not edit 'ask_start_date' message, sending new one.");
             const sentMsg = await bot.sendMessage(chatId, `Начальная дата: ${startDate ? startDate.toLocaleDateString('ru-RU') : 'Пропущено'}.\nВведите конечную дату фильтра (ДД-ММ-ГГГГ) или /skip:`, {
                 reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад к истории', callback_data: 'history_back_to_main' }]] }
             });
             state.message_id = sentMsg.message_id;
        }
    }
    // --- Ask End Date ---
    else if (state.step === 'ask_end_date') {
        let endDate = null;
        if (text.toLowerCase() !== '/skip') {
            endDate = parseDate(text);
            if (endDate === null) {
                await bot.sendMessage(chatId, 'Неверный формат даты. Введите ДД-ММ-ГГГГ или /skip:');
                return;
            }
             // Basic validation: end date should not be before start date
             const startDate = userStates[filterStateKey].startDate;
             if (startDate && endDate < startDate) {
                 await bot.sendMessage(chatId, 'Конечная дата не может быть раньше начальной. Введите снова:');
                 return;
             }
        }
        userStates[filterStateKey].endDate = endDate; // Store Date object or null

        // --- Final Step: Apply Date Filter ---
        delete userStates[chatId]; // Clear command state
        await bot.answerCallbackQuery(state.callbackQueryId || '', { text: 'Фильтр по дате применен.' }); // Acknowledge if possible

        // Refresh history view (page 1)
        const fakeMsg = { chat: { id: chatId }, from: { id: userId }, message_id: state.message_id }; // Use stored message_id
        await require('./commandHandlers').handleHistoryButton(bot, fakeMsg, 1);
        // No need to delete message, handleHistoryButton will edit it
    }
}


module.exports = {
    initialize,
    handleTextMessage
};
