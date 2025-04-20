const DEFAULT_SETTINGS = {
    username: null, // Store user's username here
    defaultCurrency: 'RUB',
    showNetBalance: false,
    // notifyOnChanges: true, // Replaced by granular settings
    remindersEnabled: false,
    reminderDaysBefore: 1, // New setting for customizable reminders
    notificationSettings: { // New granular notification settings
        onNewPending: true,
        onAccepted: true,
        onRejected: true,
        onRepaid: true, // Covers full and partial repayment notifications
        onDeleteRequest: true,
        onDeleteConfirm: true,
        onDeleteReject: true,
        onEditRequest: true, // New
        onEditConfirm: true, // New
        onEditReject: true, // New
        onReminder: true // Separate setting for reminders? Maybe keep tied to remindersEnabled for now.
    },
    displayStyle: 'list', // 'list' or 'compact' (future)
    language: 'ru' // For future localization
};

const SUPPORTED_CURRENCIES = ['RUB', 'KZT', 'USD', 'EUR'];

const MAIN_MENU_BUTTONS = {
    ADD: '➕ Добавить долг',
    VIEW: '📊 Мои долги',
    REPAY: '✅ Погасить долг',
    DELETE: '🗑️ Удалить долг',
    EDIT: '✏️ Редактировать долг',
    HISTORY: '📜 История',
    SETTINGS: '⚙️ Настройки',
    HELP: '❓ Помощь'
};

const mainKeyboard = {
    keyboard: [
        [
            { text: MAIN_MENU_BUTTONS.ADD },
            { text: MAIN_MENU_BUTTONS.VIEW }
        ],
        [
            { text: MAIN_MENU_BUTTONS.REPAY },
            { text: MAIN_MENU_BUTTONS.DELETE }
        ],
        [
            { text: MAIN_MENU_BUTTONS.EDIT },
            { text: MAIN_MENU_BUTTONS.HISTORY }
        ],
        [
            { text: MAIN_MENU_BUTTONS.SETTINGS },
            { text: MAIN_MENU_BUTTONS.HELP }
        ]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

const DEBT_STATUS = {
    MANUAL: 'manual',
    PENDING_CONFIRMATION: 'pending_confirmation', // Added by @username, waiting for them to interact with bot
    PENDING_APPROVAL: 'pending_approval',       // Added by user A for user B, waiting for B to accept/reject
    ACTIVE: 'active',
    PENDING_DELETION_APPROVAL: 'pending_deletion_approval', // User A requested delete, waiting for B
    PENDING_EDIT_APPROVAL: 'pending_edit_approval', // User A requested edit, waiting for B (New)
    // DESYNCED: 'desynced' // Optional status for sync issues
};

const HISTORY_ACTIONS = {
    REPAID: 'Погашен',
    PARTIAL_REPAID: 'Погашен частично', // New
    DELETED: 'Удален',
    EDITED: 'Изменен',
    ADDED: 'Добавлен' // Could add if needed
};

// Reminder check interval (e.g., every hour)
const REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Default days before due date to remind (now configurable per user)
// const REMINDER_DAYS_BEFORE = 1; // Moved to user settings

// Pagination settings
const DEBTS_PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 10;


module.exports = {
    DEFAULT_SETTINGS,
    SUPPORTED_CURRENCIES,
    MAIN_MENU_BUTTONS,
    mainKeyboard,
    DEBT_STATUS,
    HISTORY_ACTIONS,
    REMINDER_CHECK_INTERVAL_MS,
    // REMINDER_DAYS_BEFORE, // Removed global constant
    DEBTS_PAGE_SIZE,
    HISTORY_PAGE_SIZE
};
