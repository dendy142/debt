// Dictionary for bot text messages and button labels
module.exports = {
    BUTTONS: {
        ADD: '➕ Добавить долг',
        VIEW: '📊 Мои долги',
        REPAY: '✅ Погасить долг',
        DELETE: '🗑️ Удалить долг',
        EDIT: '✏️ Редактировать долг',
        HISTORY: '📜 История',
        SETTINGS: '⚙️ Настройки',
        HELP: '❓ Помощь',
        SKIP_RETURN_DATE: 'Пропустить',
        ADD_RETURN_DATE: 'Добавить дату возврата'
    },
    MESSAGES: {
        CHOOSE_YEAR: 'Выберите год:',
        CHOOSE_MONTH: 'Выберите месяц:',
        CHOOSE_DAY: 'Выберите день:',
        INVALID_DATE: 'Неверная дата, попробуйте снова.',
        START_WELCOME: 'Добро пожаловать! Я помогу учитывать ваши долги.',
        NO_HISTORY: 'Нет истории по этому контакту.',
        HISTORY_HEADER: 'Последние события:'
    },
    NOTIFICATIONS: {
        DEBT_REQUEST: (from, amount, currency, date) => 
            `Пользователь ${from} добавил вам долг ${amount} ${currency}${date ? ` до ${date}` : ''}.`,
        DEBT_EDIT: (from, oldStr, newStr) => 
            `Пользователь ${from} изменил ваш долг: было ${oldStr}, стало ${newStr}.`,
        DEBT_DELETE: (from, amount, currency, date) => 
            `Пользователь ${from} удалил ваш долг ${amount} ${currency}${date ? ` до ${date}` : ''}.`,
        REPAY_REQUEST: (from, amount, currency, date) => 
            `Пользователь ${from} погас ваш долг ${amount} ${currency}${date ? ` до ${date}` : ''}.`
    }
};
