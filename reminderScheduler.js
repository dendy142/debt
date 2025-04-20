const dataStore = require('./dataStore');
const { DEBT_STATUS, REMINDER_CHECK_INTERVAL_MS } = require('./constants');
const { parseDate } = require('./utils/helpers');
const { formatDate } = require('./utils/formatting');

let botInstance;
let intervalId = null;

function initialize(bot) {
    botInstance = bot;
}

function start() {
    if (intervalId) {
        console.log("Reminder scheduler already running.");
        return;
    }
    console.log("Starting reminder scheduler...");
    // Run once immediately, then set interval
    checkReminders();
    intervalId = setInterval(checkReminders, REMINDER_CHECK_INTERVAL_MS);
    console.log(`Reminder check interval set to ${REMINDER_CHECK_INTERVAL_MS / 1000 / 60} minutes.`);
}

function stop() {
    if (intervalId) {
        console.log("Stopping reminder scheduler...");
        clearInterval(intervalId);
        intervalId = null;
    } else {
        console.log("Reminder scheduler not running.");
    }
}

async function checkReminders() {
    console.log("Checking for due debts...");
    const userIds = await dataStore.getAllUserIds();

    for (const userId of userIds) {
        try {
            const userData = await dataStore.readUserData(userId);
            if (!userData.settings.remindersEnabled) {
                continue; // Skip user if reminders are disabled
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0); // Normalize to start of day

            const reminderDaysBefore = userData.settings.reminderDaysBefore ?? 1; // Use setting or default
            const reminderDate = new Date(today);
            reminderDate.setDate(today.getDate() + reminderDaysBefore);

            const debtsToCheck = [
                ...(userData.debts.iOwe || []),
                ...(userData.debts.oweMe || [])
            ].filter(debt =>
                debt.status === DEBT_STATUS.ACTIVE && // Only remind for active debts
                debt.dueDate && // Only if due date is set
                !debt.reminderSent // Avoid sending multiple reminders for the same due date (optional flag)
            );

            for (const debt of debtsToCheck) {
                const dueDate = parseDate(debt.dueDate); // Returns Date object or null
                if (!dueDate) continue; // Skip if date is invalid

                dueDate.setHours(0, 0, 0, 0); // Normalize due date

                // Check snooze status
                let isSnoozed = false;
                if (debt.reminderSnoozedUntil) {
                    const snoozedUntil = new Date(debt.reminderSnoozedUntil);
                    snoozedUntil.setHours(0, 0, 0, 0);
                    if (today < snoozedUntil) {
                        isSnoozed = true;
                        // console.log(`Reminder for debt ${debt.id} (user ${userId}) snoozed until ${snoozedUntil.toISOString()}`);
                    } else {
                        // Snooze period expired, clear the field
                        debt.reminderSnoozedUntil = null;
                        await dataStore.writeUserData(userId, userData); // Save cleared snooze
                    }
                }

                if (isSnoozed) continue; // Skip if currently snoozed

                // Check if due date matches the reminder date
                if (dueDate.getTime() === reminderDate.getTime()) {
                    await sendReminder(userId, debt, userData.knownUsers);
                    // Mark as sent to avoid duplicates (optional)
                    // debt.reminderSent = true;
                    // await dataStore.writeUserData(userId, userData);
                }
                 // Optional: Clear reminderSent flag if due date passed?
                 // else if (dueDate < today && debt.reminderSent) {
                 //    debt.reminderSent = false;
                 //    await dataStore.writeUserData(userId, userData);
                 // }
            }
        } catch (error) {
            console.error(`Error checking reminders for user ${userId}:`, error);
        }
    }
     console.log("Finished checking reminders.");
}

async function sendReminder(userId, debt, knownUsers) {
    const partyName = knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
    const typeText = debt.type === 'iOwe' ? 'Вы должны' : 'Вам должны вернуть';
    const message = `🔔 Напоминание: Срок долга (${typeText} ${partyName}, ${debt.amount.toFixed(2)} ${debt.currency}) наступает ${formatDate(debt.dueDate)}!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '😴 Отложить (1 день)', callback_data: `debt_snooze_${debt.id}` }
                    // Add other actions? e.g., 'Погасить', 'Посмотреть долг'
                ]
            ]
        }
    };


    try {
        // We assume if reminders are enabled globally, the user wants reminder notifications
        // No need to check granular notification settings here, unless a specific 'onReminder' setting exists
        await botInstance.sendMessage(userId, message, options);
        console.log(`Sent reminder to user ${userId} for debt ${debt.id}`);
    } catch (error) {
        console.error(`Failed to send reminder notification to ${userId}:`, error.response?.body || error.message);
         // Handle specific errors like blocked bot
        if (error.response && (error.response.statusCode === 403 || error.response.statusCode === 400)) {
            console.warn(`Bot might be blocked by user ${userId}. Disabling reminders for them.`);
            // Disable reminders for this user to prevent repeated errors
            try {
                const userData = await dataStore.readUserData(userId);
                userData.settings.remindersEnabled = false;
                await dataStore.writeUserData(userId, userData);
            } catch (disableError) {
                 console.error(`Failed to disable reminders for user ${userId} after send error:`, disableError);
            }
        }
    }
}


module.exports = {
    initialize,
    start,
    stop,
    checkReminders // Export for potential manual trigger
};
