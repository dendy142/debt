const { DEBT_STATUS, HISTORY_ACTIONS, DEBTS_PAGE_SIZE, HISTORY_PAGE_SIZE } = require('../constants');

function formatUsername(username) {
    return username ? username.replace(/_/g, '\\_') : 'Неизвестный'; // Escape underscores for Markdown
}

function formatCurrency(amount, currency) {
    return `${amount.toFixed(2)} ${currency}`;
}

function formatDate(dateString) {
    if (!dateString) return 'Нет';
    try {
        // Assuming dateString is 'DD-MM-YYYY'
        const parts = dateString.split('-');
        if (parts.length === 3) {
            const day = parts[0];
            const month = parts[1];
            const year = parts[2];
            // Optional: Convert to Date object for more robust formatting if needed
            // const date = new Date(year, month - 1, day);
            // return date.toLocaleDateString('ru-RU');
            return `${day}.${month}.${year}`; // Keep original format for display consistency
        }
        return dateString; // Return as is if format is unexpected
    } catch (e) {
        return dateString; // Fallback
    }
}

function getStatusText(status, partyName = 'Контакт') {
     switch (status) {
        case DEBT_STATUS.MANUAL: return '(ручной)';
        case DEBT_STATUS.PENDING_CONFIRMATION: return `(ожидает ${partyName})`;
        case DEBT_STATUS.PENDING_APPROVAL: return `(ожидает ${partyName})`;
        case DEBT_STATUS.ACTIVE: return ''; // Active is the default, no extra text needed
        case DEBT_STATUS.PENDING_DELETION_APPROVAL: return `(ожидает удаления ${partyName})`;
        case DEBT_STATUS.PENDING_EDIT_APPROVAL: return `(ожидает изменения ${partyName})`; // New
        default: return `(${status})`; // Show unknown status
    }
}

function formatDebts(userData, aggregate = true, page = 1, pageSize = DEBTS_PAGE_SIZE) {
    const { debts = { iOwe: [], oweMe: [] }, settings = {}, knownUsers = {} } = userData;
    const { iOwe = [], oweMe = [] } = debts;
    const { showNetBalance, defaultCurrency } = settings;

    let message = '';
    let netBalance = {}; // { 'RUB': 0, 'USD': 0 }

    const formatList = (list, type, page, pageSize) => {
        let listMessage = '';
        let aggregated = {}; // { 'partyKey_currency': { amount: 0, debts: [] } }
        const partyKey = (debt) => `${debt.partyUserId || debt.partyIdentifier}_${debt.currency}`;

        // Filter only active/manual/pending edit debts for main view aggregation
        const relevantDebts = list.filter(d =>
            d.status === DEBT_STATUS.ACTIVE ||
            d.status === DEBT_STATUS.MANUAL ||
            d.status === DEBT_STATUS.PENDING_EDIT_APPROVAL // Show debts pending edit
        );

        if (aggregate) {
            relevantDebts.forEach(debt => {
                const key = partyKey(debt);
                if (!aggregated[key]) {
                    aggregated[key] = { amount: 0, debts: [], currency: debt.currency, partyUserId: debt.partyUserId, partyIdentifier: debt.partyIdentifier };
                }
                aggregated[key].amount += debt.amount;
                aggregated[key].debts.push(debt); // Keep original debts for details if needed later
            });
        } else {
            // If not aggregating, treat each debt individually for pagination
             relevantDebts.forEach((debt, index) => {
                 aggregated[index] = { amount: debt.amount, debts: [debt], currency: debt.currency, partyUserId: debt.partyUserId, partyIdentifier: debt.partyIdentifier };
             });
        }

        const aggregatedArray = Object.values(aggregated);
        const totalItems = aggregatedArray.length;
        const totalPages = Math.ceil(totalItems / pageSize);
        page = Math.max(1, Math.min(page, totalPages)); // Ensure page is within bounds
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const pageItems = aggregatedArray.slice(startIndex, endIndex);

        if (pageItems.length === 0) {
            return { message: '', totalPages: 0 };
        }

        pageItems.forEach((item, index) => {
            const partyName = knownUsers[item.partyUserId] || item.partyIdentifier || 'Неизвестный';
            // Determine status - if aggregated, show active unless *all* underlying are pending edit
            let displayStatus = DEBT_STATUS.ACTIVE;
            if (item.debts.every(d => d.status === DEBT_STATUS.PENDING_EDIT_APPROVAL)) {
                displayStatus = DEBT_STATUS.PENDING_EDIT_APPROVAL;
            }
            const statusText = getStatusText(displayStatus, partyName);
            const formattedAmount = formatCurrency(item.amount, item.currency);

            // Find earliest due date among aggregated debts if applicable
            let dueDateText = '';
            if (aggregate && item.debts.length > 0) {
                const dueDates = item.debts.map(d => d.dueDate).filter(Boolean).sort();
                if (dueDates.length > 0) {
                    dueDateText = ` (ближ. срок: ${formatDate(dueDates[0])})`;
                }
            } else if (!aggregate && item.debts[0].dueDate) {
                 dueDateText = ` (срок: ${formatDate(item.debts[0].dueDate)})`;
            }


            listMessage += `  ${index + 1 + startIndex}. ${partyName}: <b>${formattedAmount}</b>${statusText}${dueDateText}\n`;

            // Update net balance
            if (showNetBalance) {
                netBalance[item.currency] = (netBalance[item.currency] || 0) + (type === 'iOwe' ? -item.amount : item.amount);
            }
        });
        return { message: listMessage, totalPages };
    };

    // --- Format "Owe Me" ---
    message += '<b><u>🧾 Мне должны:</u></b>\n';
    const { message: oweMeMessage, totalPages: oweMeTotalPages } = formatList(oweMe, 'oweMe', page, pageSize);
    if (oweMeMessage) {
        message += oweMeMessage;
    } else {
        message += '  <i>Нет долгов</i>\n';
    }
     message += '\n'; // Add separator even if empty

    // --- Format "I Owe" ---
    message += '<b><u>💸 Я должен:</u></b>\n';
    const { message: iOweMessage, totalPages: iOweTotalPages } = formatList(iOwe, 'iOwe', page, pageSize);
     if (iOweMessage) {
        message += iOweMessage;
    } else {
        message += '  <i>Нет долгов</i>\n';
    }

    // --- Format Pending Approvals (Not aggregated, always shown) ---
    const pendingMyApproval = [...(iOwe.filter(d => d.status === DEBT_STATUS.PENDING_APPROVAL)), ...(oweMe.filter(d => d.status === DEBT_STATUS.PENDING_APPROVAL))];
    if (pendingMyApproval.length > 0) {
        message += '\n<b><u>⏳ Ожидают вашего подтверждения:</u></b>\n';
        pendingMyApproval.forEach((debt, index) => {
            const partyName = knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
            const typeText = iOwe.includes(debt) ? 'Вы должны' : 'Вам должен';
            message += `  ${index + 1}. ${typeText} ${partyName}: <b>${formatCurrency(debt.amount, debt.currency)}</b>\n`;
        });
    }

    // --- Format Pending Confirmation (Not aggregated, always shown) ---
     const pendingConfirmation = [...(iOwe.filter(d => d.status === DEBT_STATUS.PENDING_CONFIRMATION)), ...(oweMe.filter(d => d.status === DEBT_STATUS.PENDING_CONFIRMATION))];
     if (pendingConfirmation.length > 0) {
         message += '\n<b><u>❓ Ожидают связи с контактом:</u></b>\n';
         pendingConfirmation.forEach((debt, index) => {
             const partyName = debt.partyIdentifier || 'Неизвестный';
             const typeText = iOwe.includes(debt) ? 'Вы должны' : 'Вам должен';
             message += `  ${index + 1}. ${typeText} ${partyName}: <b>${formatCurrency(debt.amount, debt.currency)}</b>\n`;
         });
     }

     // --- Format Pending Deletion Approval (Not aggregated, always shown) ---
      const pendingDeletion = [...(iOwe.filter(d => d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL)), ...(oweMe.filter(d => d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL))];
      if (pendingDeletion.length > 0) {
          message += '\n<b><u>🗑️ Ожидают подтверждения удаления:</u></b>\n';
          pendingDeletion.forEach((debt, index) => {
              const partyName = knownUsers[debt.partyUserId] || debt.partyIdentifier || 'Неизвестный';
              const typeText = iOwe.includes(debt) ? 'Я должен' : 'Мне должны';
              message += `  ${index + 1}. ${typeText} ${partyName}: <b>${formatCurrency(debt.amount, debt.currency)}</b>\n`;
          });
      }


    // --- Net Balance ---
    if (showNetBalance && Object.keys(netBalance).length > 0) {
        message += '\n<b><u>⚖️ Чистый остаток (по активным):</u></b>\n';
        for (const currency in netBalance) {
            const balance = netBalance[currency];
            const sign = balance >= 0 ? '+' : '';
            message += `  ${currency}: <b>${sign}${formatCurrency(balance, currency)}</b>\n`;
        }
    }

    // Determine overall total pages (max of both lists for pagination controls)
    const totalPages = Math.max(oweMeTotalPages, iOweTotalPages);

    return { message, totalPages };
}


function formatHistory(history = [], knownUsers = {}, filters = {}, page = 1, pageSize = HISTORY_PAGE_SIZE) {
    if (!history || history.length === 0) {
        return { message: '📜 История пуста.', totalPages: 0 };
    }

    // Apply filters
    let filteredHistory = history.filter(entry => {
        let keep = true;
        if (filters.contactUserId && entry.partyUserId !== filters.contactUserId) {
            keep = false;
        }
        if (filters.startDate) {
            const entryDate = new Date(entry.resolvedDate || entry.createdDate); // Use resolvedDate first
            if (entryDate < filters.startDate) keep = false;
        }
         if (filters.endDate) {
            const entryDate = new Date(entry.resolvedDate || entry.createdDate);
            // Include the end date itself
            const endOfDay = new Date(filters.endDate);
            endOfDay.setHours(23, 59, 59, 999);
            if (entryDate > endOfDay) keep = false;
        }
        // Add more filters here (action, currency, etc.) if needed
        return keep;
    });

    // Sort by resolved/created date, newest first
    filteredHistory.sort((a, b) => {
        const dateA = new Date(a.resolvedDate || a.createdDate || 0);
        const dateB = new Date(b.resolvedDate || b.createdDate || 0);
        return dateB - dateA;
    });

    const totalItems = filteredHistory.length;
     if (totalItems === 0) {
        return { message: '📜 Нет записей в истории, соответствующих фильтрам.', totalPages: 0 };
    }

    const totalPages = Math.ceil(totalItems / pageSize);
    page = Math.max(1, Math.min(page, totalPages)); // Ensure page is within bounds
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageItems = filteredHistory.slice(startIndex, endIndex);


    let message = `<b>📜 История (Записи ${startIndex + 1}-${Math.min(endIndex, totalItems)} из ${totalItems}):</b>\n\n`;

    pageItems.forEach((entry, index) => {
        const partyName = knownUsers[entry.partyUserId] || entry.partyIdentifier || 'Неизвестный';
        const date = new Date(entry.resolvedDate || entry.createdDate).toLocaleDateString('ru-RU');
        const typeText = entry.type === 'iOwe' ? 'Я должен был' : 'Мне должны были';
        const action = entry.action || 'Неизвестно';

        message += `<b>${date} - ${action}</b>\n`;
        message += `  <i>${typeText} ${partyName}</i>\n`;

        switch (entry.action) {
            case HISTORY_ACTIONS.REPAID:
                message += `  Сумма: ${formatCurrency(entry.amount, entry.currency)}\n`;
                break;
            case HISTORY_ACTIONS.PARTIAL_REPAID: // New
                 message += `  Погашено: ${formatCurrency(entry.repaidAmount, entry.currency)}\n`;
                 message += `  Остаток: ${formatCurrency(entry.remainingAmount, entry.currency)}\n`;
                break;
            case HISTORY_ACTIONS.DELETED:
                message += `  Сумма на момент удаления: ${formatCurrency(entry.amount, entry.currency)}\n`;
                break;
            case HISTORY_ACTIONS.EDITED:
                const fieldMap = { // Map internal field names to readable names
                    amount: 'Сумма',
                    currency: 'Валюта',
                    dueDate: 'Дата возврата',
                    partyIdentifier: 'Контакт'
                };
                const fieldName = fieldMap[entry.editedField] || entry.editedField;
                const formatValue = (field, value) => {
                    if (field === 'amount') return formatCurrency(value, entry.currency); // Use the currency at time of edit
                    if (field === 'dueDate') return formatDate(value);
                    return value;
                };
                message += `  Поле: ${fieldName}\n`;
                message += `  Старое значение: ${formatValue(entry.editedField, entry.originalValue ?? entry.originalAmount)}\n`; // Handle amount rename
                message += `  Новое значение: ${formatValue(entry.editedField, entry.newValue)}\n`;
                break;
             case HISTORY_ACTIONS.ADDED: // If you decide to log additions
                 message += `  Сумма: ${formatCurrency(entry.amount, entry.currency)}\n`;
                 if (entry.dueDate) message += `  Срок: ${formatDate(entry.dueDate)}\n`;
                 message += `  Статус при добавлении: ${entry.status || 'N/A'}\n`;
                 break;
            default:
                message += `  Детали: ${JSON.stringify(entry)}\n`; // Fallback for unknown actions
        }
        message += '---\n';
    });

    return { message, totalPages };
}


module.exports = {
    formatDebts,
    formatHistory,
    formatUsername,
    formatCurrency,
    formatDate,
    getStatusText
};
