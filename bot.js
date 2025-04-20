const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const constants = require('./constants');
const dataStore = require('./dataStore');
const commandHandlers = require('./handlers/commandHandlers');
const callbackQueryHandlers = require('./handlers/callbackQueryHandlers');
const messageHandlers = require('./handlers/messageHandlers');
const reminderScheduler = require('./reminderScheduler');

// --- Initialization ---

// TODO: Load token securely (e.g., environment variable)
const token = '7705098910:AAG_S0pAtnn6vxugdF66nXnOt6_C93rQikk'; // Replace with your actual token
if (!token) {
    console.error("FATAL ERROR: Telegram Bot Token not found. Please set the TOKEN environment variable.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// In-memory state for multi-step operations (could be moved to a more persistent store if needed)
const userStates = {};

// Initialize handlers and modules with dependencies
commandHandlers.initialize(userStates);
callbackQueryHandlers.initialize(bot, userStates);
messageHandlers.initialize(bot, userStates); // Pass bot and userStates
reminderScheduler.initialize(bot);

// Ensure data directory exists on startup
dataStore.ensureDataDir().catch(err => {
    console.error("FATAL ERROR: Failed to ensure data directory exists:", err);
    process.exit(1);
});

// --- Bot Event Listeners ---

// Command Handlers (using onText for flexibility with button text)
bot.onText(/\/start/, (msg) => commandHandlers.handleStart(bot, msg));
bot.onText(/\/help/, (msg) => commandHandlers.handleHelp(bot, msg));
bot.onText(/\/linkme (.+)/, (msg, match) => commandHandlers.handleLinkMe(bot, msg, match));
// Add other specific commands if needed

// Main Menu Button Handlers (match exact button text)
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.ADD}$`), (msg) => commandHandlers.handleAddDebtButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.VIEW}$`), (msg) => commandHandlers.handleViewDebtsButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.REPAY}$`), (msg) => commandHandlers.handleRepayDebtButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.DELETE}$`), (msg) => commandHandlers.handleDeleteDebtButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.EDIT}$`), (msg) => commandHandlers.handleEditDebtButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.HISTORY}$`), (msg) => commandHandlers.handleHistoryButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.SETTINGS}$`), (msg) => commandHandlers.handleSettingsButton(bot, msg));
bot.onText(new RegExp(`^${constants.MAIN_MENU_BUTTONS.HELP}$`), (msg) => commandHandlers.handleHelpButton(bot, msg));

// Callback Query Handler (for inline buttons)
bot.on('callback_query', (callbackQuery) => {
    // Add basic error handling around the handler
    callbackQueryHandlers.handleCallbackQuery(callbackQuery).catch(error => {
        console.error("Unhandled error in handleCallbackQuery:", error);
        // Try to answer the callback query to prevent infinite loading
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла внутренняя ошибка.', show_alert: true })
           .catch(e => console.error("Failed to answer callback query on error:", e));
    });
});

// Message Handler (for user input during stateful operations)
bot.on('message', (msg) => {
     // Ignore messages that are commands or match main menu buttons
     if (msg.text && (msg.text.startsWith('/') || Object.values(constants.MAIN_MENU_BUTTONS).includes(msg.text))) {
         return;
     }
     // Add basic error handling around the handler
     // *** FIX: Call handleTextMessage instead of handleMessage ***
     messageHandlers.handleTextMessage(msg).catch(error => {
         console.error("Unhandled error in handleTextMessage:", error);
         // Notify user?
         bot.sendMessage(msg.chat.id, "Извините, произошла ошибка при обработке вашего сообщения.")
            .catch(e => console.error("Failed to send error message to chat:", e));
     });
});

// --- Error Handling ---
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, '-', error.message);
    // Consider specific error codes (e.g., ETIMEDOUT, ECONNRESET) and potential recovery logic
    if (error.code === 'EFATAL') {
        console.error("Fatal polling error detected. Exiting.");
        process.exit(1); // Exit on fatal errors
    } else if (error.message && error.message.includes("409 Conflict")) {
         console.error("------------------------------------------------------");
         console.error("ПОТЕНЦИАЛЬНАЯ ОШИБКА 409 CONFLICT: Запущено несколько экземпляров бота?");
         console.error("Убедитесь, что запущен только один процесс bot.js.");
         console.error("Попробуйте остановить все процессы node и запустить заново.");
         console.error("------------------------------------------------------");
         // Consider stopping the bot process here to prevent issues
         // process.exit(1); // Or implement a more robust restart mechanism
    }
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.code, '-', error.message);
});

// --- Start Scheduler ---
reminderScheduler.start();

// --- Graceful Shutdown ---
function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down...`);
    reminderScheduler.stop();
    console.log('Stopping polling...');
    bot.stopPolling({ cancel: true }) // Use cancel option for faster shutdown attempt
        .then(() => {
            console.log('Polling stopped.');
            process.exit(0);
        })
        .catch((err) => {
            console.error('Error stopping polling:', err);
            process.exit(1);
        });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('Бот запущен (v3.0 - Ready for Testing)...');
// Keep index.js minimal or remove if package.json points to bot.js
