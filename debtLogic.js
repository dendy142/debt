const { v4: uuidv4 } = require('uuid');
const dataStore = require('./dataStore');
const { DEBT_STATUS, HISTORY_ACTIONS } = require('./constants');
const { isValidUsername } = require('./utils/validation'); // Assuming validation utils are separate
const { formatCurrency, formatDate } = require('./utils/formatting'); // For notifications

// --- Helper to send notification ---
async function sendNotification(bot, userId, message, options = {}) {
    if (!userId || !message) return;
    try {
        const userData = await dataStore.readUserData(userId);
        // Check general notification setting first (if applicable, though granular is preferred now)
        // if (!userData.settings.notifyOnChanges) {
        //     console.log(`Notifications globally disabled for user ${userId}`);
        //     return false;
        // }
        // Granular checks will happen before calling this helper
        await bot.sendMessage(userId, message, options);
        return true;
    } catch (error) {
        console.error(`Failed to send notification to ${userId}:`, error.response?.body || error.message);
        // Handle specific errors like blocked bot, user not found etc.
        if (error.response && (error.response.statusCode === 403 || error.response.statusCode === 400)) {
            console.warn(`Bot might be blocked by user ${userId} or chat not found.`);
            // Optionally disable notifications for this user?
            // const userData = await dataStore.readUserData(userId);
            // userData.settings.notifyOnChanges = false; // Or a specific flag
            // await dataStore.writeUserData(userId, userData);
        }
        return false;
    }
}


// --- Add Debt ---
async function addDebt(bot, userId, debtData) {
    const { type, partyIdentifier, amount, currency, dueDate, partyUserId: preFoundPartyUserId } = debtData;
    const currentUserData = await dataStore.readUserData(userId);
    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;

    const newDebtBase = {
        id: uuidv4(),
        amount: parseFloat(amount.toFixed(2)), // Ensure precision
        currency: currency,
        dueDate: dueDate,
        partyIdentifier: partyIdentifier, // Could be name or @username
        partyUserId: null, // Will be set if linked
        status: DEBT_STATUS.MANUAL, // Default
        linkedDebtId: null,
        createdDate: new Date().toISOString(),
        // Fields for edit confirmation
        pendingEdit: null, // { field, newValue, requestedBy }
        // Field for snooze
        reminderSnoozedUntil: null
    };

    const debtList = type === 'iOwe' ? currentUserData.debts.iOwe : currentUserData.debts.oweMe;
    let message = '';
    let targetUserId = preFoundPartyUserId; // Use if already found via known users button

    // If not pre-found, try finding by username if applicable
    if (!targetUserId && isValidUsername(partyIdentifier)) {
        targetUserId = await dataStore.findUserByUsername(userId, partyIdentifier);
    }

    // --- Linked Debt Scenario ---
    if (targetUserId && targetUserId !== userId) {
        console.log(`Attempting to add linked debt between ${userId} and ${targetUserId}`);
        const linkedId = uuidv4();
        newDebtBase.status = DEBT_STATUS.PENDING_APPROVAL; // Waiting for target user to accept
        newDebtBase.partyUserId = targetUserId;
        newDebtBase.linkedDebtId = linkedId;

        const targetUserData = await dataStore.readUserData(targetUserId);
        const targetUserUsername = targetUserData.settings.username || partyIdentifier; // Use identifier as fallback

        // Update known users for both
        currentUserData.knownUsers[targetUserId] = targetUserUsername;
        targetUserData.knownUsers[userId] = currentUserUsername;

        // Create mirrored debt for the target user
        const mirroredDebt = {
            ...newDebtBase,
            id: uuidv4(), // Generate new ID for the mirrored debt
            partyUserId: userId, // Link back to creator
            partyIdentifier: currentUserUsername,
            // Status is also PENDING_APPROVAL (target needs to act)
        };

        // Add mirrored debt to the correct list for the target user
        const targetListType = type === 'iOwe' ? 'oweMe' : 'iOwe';
        if (!targetUserData.debts[targetListType]) targetUserData.debts[targetListType] = [];
        targetUserData.debts[targetListType].push(mirroredDebt);

        debtList.push(newDebtBase); // Add debt to creator's list
        await dataStore.writeUserData(userId, currentUserData);
        await dataStore.writeUserData(targetUserId, targetUserData);

        message = `Долг добавлен: ${type === 'iOwe' ? 'Вы должны' : 'Вам должен'} ${targetUserUsername} ${amount.toFixed(2)} ${currency}.`;
        message += `\nОжидает подтверждения от ${targetUserUsername}.`;

        // Notify the target user if enabled
        if (targetUserData.settings.notificationSettings.onNewPending) {
            const notificationType = type === 'iOwe' ? 'вам должен' : 'вы должны ему';
            const notificationMsg = `${currentUserUsername} добавил(а) долг: ${notificationType} ${amount.toFixed(2)} ${currency}. Подтвердите или отклоните:`;
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Принять', callback_data: `debt_accept_${linkedId}` },
                            { text: '❌ Отклонить', callback_data: `debt_reject_${linkedId}` }
                        ]
                    ]
                }
            };
            const notified = await sendNotification(bot, targetUserId, notificationMsg, options);
             if (!notified) {
                 message += "\n(Не удалось отправить уведомление другому пользователю)";
             }
        } else {
             console.log(`Notifications 'onNewPending' disabled for target user ${targetUserId}`);
        }

    }
    // --- Pending Confirmation Scenario (Username used, but user not found/linked yet) ---
    else if (isValidUsername(partyIdentifier)) {
        console.log(`Adding debt for ${userId} with username ${partyIdentifier}, pending confirmation.`);
        newDebtBase.status = DEBT_STATUS.PENDING_CONFIRMATION; // Waiting for target user to interact with bot
        newDebtBase.linkedDebtId = uuidv4(); // Generate potential link ID
        newDebtBase.partyUserId = null; // Cannot know the ID yet

        debtList.push(newDebtBase);
        await dataStore.writeUserData(userId, currentUserData);

        message = `Долг добавлен: ${partyIdentifier} ${type === 'iOwe' ? 'вам должен' : 'должен вам'} ${amount.toFixed(2)} ${currency}.`;
        message += `\nСтатус: Ожидает первого контакта с ${partyIdentifier} в боте для связи.`;
        message += `\nЕсли ${partyIdentifier} уже пользуется ботом под другим именем, он(а) может использовать /linkme ${partyIdentifier}.`;
    }
    // --- Manual Debt Scenario ---
    else {
        console.log(`Adding manual debt for ${userId} with identifier ${partyIdentifier}.`);
        newDebtBase.status = DEBT_STATUS.MANUAL;
        newDebtBase.linkedDebtId = null;
        newDebtBase.partyUserId = null;

        debtList.push(newDebtBase);
        await dataStore.writeUserData(userId, currentUserData);
        message = `Добавлен не связанный (ручной) долг (${type === 'iOwe' ? 'Я должен' : 'Мне должны'} ${partyIdentifier}): ${amount.toFixed(2)} ${currency}.`;
    }

    return { success: true, message };
}

// --- Handle Debt Acceptance/Rejection ---
async function handleDebtAcceptance(bot, userId, linkedDebtId, isAccept) {
    const currentUserData = await dataStore.readUserData(userId);
    let debtFound = false;
    let debt = null;
    let otherUserId = null;
    let listType = null; // 'iOwe' or 'oweMe' for the current user

    // Find the debt in the current user's lists that is waiting for *their* approval
    const findDebt = (list, type) => {
        const d = list.find(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_APPROVAL);
        if (d) {
            debtFound = true;
            debt = d;
            otherUserId = d.partyUserId; // The user who initiated the debt
            listType = type;
            return d;
        }
        return null;
    };

    findDebt(currentUserData.debts.iOwe || [], 'iOwe') || findDebt(currentUserData.debts.oweMe || [], 'oweMe');

    if (!debtFound || !otherUserId || !debt) {
        return { success: false, message: 'Не удалось найти этот запрос на подтверждение долга. Возможно, он уже обработан или отменен.' };
    }

    const otherUserData = await dataStore.readUserData(otherUserId);
    const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
    const otherDebtIndex = otherUserData.debts[otherListType]?.findIndex(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_APPROVAL);

    if (otherDebtIndex === -1 || !otherUserData.debts[otherListType]) {
        console.error(`Sync Error: Debt ${linkedDebtId} not found in ${otherUserId}'s ${otherListType} list during ${isAccept ? 'accept' : 'reject'}`);
        // Attempt to clean up the current user's side?
        currentUserData.debts[listType] = currentUserData.debts[listType].filter(d => d.linkedDebtId !== linkedDebtId);
        await dataStore.writeUserData(userId, currentUserData);
        return { success: false, message: 'Ошибка синхронизации. Не удалось найти долг у другой стороны. Запрос отменен.' };
    }

    const otherDebt = otherUserData.debts[otherListType][otherDebtIndex];
    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
    const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;

    let finalMessage = '';
    let notificationMessage = '';
    let notifySetting = isAccept ? 'onAccepted' : 'onRejected';

    if (isAccept) {
        debt.status = DEBT_STATUS.ACTIVE;
        otherDebt.status = DEBT_STATUS.ACTIVE;

        // Update known users just in case
        currentUserData.knownUsers[otherUserId] = otherUserUsername;
        otherUserData.knownUsers[userId] = currentUserUsername;

        finalMessage = `Вы приняли долг: ${listType === 'iOwe' ? 'Вы должны' : 'Вам должен'} ${otherUserUsername} ${debt.amount.toFixed(2)} ${debt.currency}.`;
        notificationMessage = `${currentUserUsername} принял(а) долг (${debt.amount.toFixed(2)} ${debt.currency}). Теперь он активен.`;

    } else { // Reject
        // Remove the debt from both users
        currentUserData.debts[listType] = currentUserData.debts[listType].filter(d => d.linkedDebtId !== linkedDebtId);
        otherUserData.debts[otherListType].splice(otherDebtIndex, 1);

        finalMessage = `Вы отклонили долг (${debt.amount.toFixed(2)} ${debt.currency}) от ${otherUserUsername}.`;
        notificationMessage = `${currentUserUsername} отклонил(а) предложенный долг (${debt.amount.toFixed(2)} ${debt.currency}).`;
    }

    // Save data
    await dataStore.writeUserData(userId, currentUserData);
    await dataStore.writeUserData(otherUserId, otherUserData);

    // Notify the other user if enabled
    if (otherUserData.settings.notificationSettings[notifySetting]) {
        const notified = await sendNotification(bot, otherUserId, notificationMessage);
        if (!notified) {
            finalMessage += "\n<i>(Не удалось уведомить другую сторону)</i>";
        }
    } else {
         console.log(`Notification '${notifySetting}' disabled for user ${otherUserId}`);
    }

    return { success: true, message: finalMessage };
}


// --- Repay Debt ---
async function repayDebt(bot, userId, debtId, debtType, repayAmount, originalDebtState) {
    const currentUserData = await dataStore.readUserData(userId);
    const debtList = debtType === 'iOwe' ? currentUserData.debts.iOwe : currentUserData.debts.oweMe;
    const debtIndex = debtList.findIndex(d => d.id === debtId);

    if (debtIndex === -1) {
        return { success: false, message: 'Ошибка: Долг не найден. Возможно, он был изменен.' };
    }

    const currentDebt = debtList[debtIndex];

    // Verify status and amount again
    if ((currentDebt.status !== DEBT_STATUS.ACTIVE && currentDebt.status !== DEBT_STATUS.MANUAL)) {
         return { success: false, message: 'Ошибка: Этот долг не активен и не может быть погашен.' };
    }
     if (repayAmount > currentDebt.amount + 0.001) { // Tolerance
         return { success: false, message: `Ошибка: Сумма погашения (${repayAmount.toFixed(2)}) больше остатка (${currentDebt.amount.toFixed(2)}).` };
    }

    const originalAmountBeforeRepay = currentDebt.amount;
    currentDebt.amount -= repayAmount;
    currentDebt.amount = parseFloat(currentDebt.amount.toFixed(2)); // Ensure precision

    let finalMessage = '';
    let notifyOtherParty = false;
    let otherPartyMessage = '';
    let otherUserId = currentDebt.partyUserId;
    let otherUserData = null;
    let otherDebt = null;
    let otherDebtList = null;
    let otherDebtIndex = -1;
    let historyEntry = null;
    let otherHistoryEntry = null;
    const isFullRepayment = currentDebt.amount <= 0.001;

    // --- Synchronize with linked debt (if active) ---
    if (currentDebt.status === DEBT_STATUS.ACTIVE && currentDebt.linkedDebtId && otherUserId) {
        try {
            otherUserData = await dataStore.readUserData(otherUserId);
            const otherListType = debtType === 'iOwe' ? 'oweMe' : 'iOwe';
            otherDebtList = otherUserData.debts[otherListType];
            otherDebtIndex = otherDebtList?.findIndex(d => d.linkedDebtId === currentDebt.linkedDebtId);

            if (otherDebtIndex !== -1 && otherDebtList) {
                otherDebt = otherDebtList[otherDebtIndex];
                // Basic consistency check before modifying
                if (Math.abs(otherDebt.amount - originalAmountBeforeRepay) > 0.01) {
                    console.warn(`Repay inconsistency detected for linkedDebtId ${currentDebt.linkedDebtId}. Local amount before: ${originalAmountBeforeRepay}, Remote amount: ${otherDebt.amount}. Proceeding with local logic.`);
                    // Potentially mark as desynced or notify?
                }
                otherDebt.amount -= repayAmount;
                otherDebt.amount = parseFloat(otherDebt.amount.toFixed(2));
            } else {
                console.error(`Could not find mirrored debt for link ${currentDebt.linkedDebtId} in user ${otherUserId}`);
                finalMessage += "\n<i>Не удалось синхронизировать погашение (ошибка связи).</i>";
                otherUserId = null; // Prevent further processing if sync failed
            }
        } catch (readError) {
            console.error(`Error reading other user data (${otherUserId}) during repay sync:`, readError);
            finalMessage += "\n<i>Не удалось синхронизировать погашение (ошибка чтения данных).</i>";
            otherUserId = null;
        }
    }
    // --- End Synchronization Setup ---

    const partyName = currentUserData.knownUsers[currentDebt.partyUserId] || currentDebt.partyIdentifier || 'Неизвестный';
    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;

    if (isFullRepayment) { // Full repayment
        const removedDebt = debtList.splice(debtIndex, 1)[0];
        finalMessage = `Долг (${partyName}, ${originalAmountBeforeRepay.toFixed(2)} ${removedDebt.currency}) полностью погашен.`;

        // Add to history
        historyEntry = {
            ...removedDebt, // Keep original details
            resolvedDate: new Date().toISOString(),
            action: HISTORY_ACTIONS.REPAID,
            type: debtType, // Store original type
            amount: originalAmountBeforeRepay // Log the amount that was repaid fully
        };
        if (!currentUserData.history) currentUserData.history = [];
        currentUserData.history.push(historyEntry);

        // Handle mirrored debt removal
        if (otherDebt && otherDebt.amount <= 0.001 && otherDebtIndex !== -1 && otherDebtList) {
            const removedOtherDebt = otherDebtList.splice(otherDebtIndex, 1)[0];
            otherPartyMessage = `Долг с ${currentUserUsername} (${originalAmountBeforeRepay.toFixed(2)} ${removedOtherDebt.currency}) был полностью погашен.`;
            notifyOtherParty = true;

            // Add to other user's history
            otherHistoryEntry = {
                 ...removedOtherDebt,
                 resolvedDate: new Date().toISOString(),
                 action: HISTORY_ACTIONS.REPAID,
                 type: debtType === 'iOwe' ? 'oweMe' : 'iOwe', // Mirrored type
                 amount: originalAmountBeforeRepay
            };
            if (!otherUserData.history) otherUserData.history = [];
            otherUserData.history.push(otherHistoryEntry);

        } else if (otherDebt) {
            console.warn(`Repay inconsistency: Local debt removed, but remote amount is ${otherDebt.amount} for linkedDebtId ${currentDebt.linkedDebtId}`);
            finalMessage += "\n<i>Возникла ошибка синхронизации при удалении долга у другой стороны. Проверьте долги.</i>";
            if (otherDebt.amount > 0.01 && otherDebtIndex !== -1 && otherDebtList) {
                 // Don't remove, maybe mark as desynced?
                 // otherDebt.status = DEBT_STATUS.DESYNCED;
                 notifyOtherParty = true;
                 otherPartyMessage = `Возникла ошибка синхронизации при погашении долга с ${currentUserUsername}. Пожалуйста, проверьте ваши долги.`;
            } else if (otherDebtIndex !== -1 && otherDebtList) {
                 // If amount is effectively zero, remove it anyway
                 otherDebtList.splice(otherDebtIndex, 1);
            }
        }

    } else { // Partial repayment
        // --- Если долг связан с другим пользователем (linkedDebtId и partyUserId), инициируем подтверждение ---
        if (currentDebt.linkedDebtId && otherUserId && currentDebt.status === DEBT_STATUS.ACTIVE) {
            // Сохраняем желаемое новое значение суммы как pendingEdit и переводим в PENDING_EDIT_APPROVAL
            const pendingEditData = { field: 'amount', newValue: currentDebt.amount, requestedBy: userId, repayAmount };
            currentDebt.pendingEdit = pendingEditData;
            currentDebt.status = DEBT_STATUS.PENDING_EDIT_APPROVAL;
            if (otherDebt) {
                otherDebt.pendingEdit = pendingEditData;
                otherDebt.status = DEBT_STATUS.PENDING_EDIT_APPROVAL;
            }
            await dataStore.writeUserData(userId, currentUserData);
            if (otherUserData && otherUserId) await dataStore.writeUserData(otherUserId, otherUserData);
            // Отправляем запрос на подтверждение второй стороне
            if (otherUserData && otherUserData.settings.notificationSettings.onEditRequest) {
                const dueText = currentDebt.dueDate ? ` до ${formatDate(currentDebt.dueDate)}` : '';
                const who = debtType === 'iOwe' ? `${currentUserUsername} → ${partyName}` : `${partyName} → ${currentUserUsername}`;
                const notifMsg = `Запрос на частичное погашение долга:
${who}
Сумма к погашению: ${repayAmount.toFixed(2)} ${currentDebt.currency}
Остаток: ${currentDebt.amount.toFixed(2)} ${currentDebt.currency}${dueText}
Подтвердить изменение?`;
                await sendNotification(bot, otherUserId, notifMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Подтвердить', callback_data: `debt_edit_confirm_${currentDebt.linkedDebtId}` },
                                { text: '❌ Отклонить', callback_data: `debt_edit_reject_${currentDebt.linkedDebtId}` }
                            ]
                        ]
                    }
                });
            }
            return { success: true, message: 'Запрос на частичное погашение отправлен другой стороне. Ожидайте подтверждения.' };
        }
        // --- Обычное частичное погашение (ручной долг) ---
        finalMessage = `Погашено ${repayAmount.toFixed(2)} ${currentDebt.currency}. Остаток долга (${partyName}): ${currentDebt.amount.toFixed(2)} ${currentDebt.currency}.`;

        // Add partial repayment to history
        historyEntry = {
            // Base details from current state after partial repay
            id: currentDebt.id,
            linkedDebtId: currentDebt.linkedDebtId,
            partyIdentifier: currentDebt.partyIdentifier,
            partyUserId: currentDebt.partyUserId,
            currency: currentDebt.currency,
            dueDate: currentDebt.dueDate,
            // Specific history fields
            resolvedDate: new Date().toISOString(),
            action: HISTORY_ACTIONS.PARTIAL_REPAID,
            type: debtType,
            repaidAmount: repayAmount, // Amount paid in this transaction
            remainingAmount: currentDebt.amount // Amount remaining AFTER this transaction
        };
        if (!currentUserData.history) currentUserData.history = [];
        currentUserData.history.push(historyEntry);

        // Handle mirrored debt update
        if (otherDebt && otherDebtIndex !== -1) {
            otherPartyMessage = `${currentUserUsername} погасил(а) ${repayAmount.toFixed(2)} ${otherDebt.currency}. Остаток долга: ${otherDebt.amount.toFixed(2)} ${otherDebt.currency}.`;
            notifyOtherParty = true;

            // Add partial repayment to other user's history
            otherHistoryEntry = {
                ...historyEntry, // Copy most fields
                id: otherDebt.id, // Use the other debt's ID
                type: debtType === 'iOwe' ? 'oweMe' : 'iOwe', // Mirrored type
            };
            if (!otherUserData.history) otherUserData.history = [];
            otherUserData.history.push(otherHistoryEntry);
        } else if (otherUserId && currentDebt.status === DEBT_STATUS.ACTIVE) {
            finalMessage += "\n<i>Не удалось синхронизировать частичное погашение.</i>";
        }
    }

    // Save data
    await dataStore.writeUserData(userId, currentUserData);
    if (otherUserData && otherUserId) {
        await dataStore.writeUserData(otherUserId, otherUserData);
    }

    // Send notification if needed and enabled
    if (notifyOtherParty && otherUserId && otherUserData?.settings?.notificationSettings?.onRepaid) {
        const notified = await sendNotification(bot, otherUserId, otherPartyMessage);
         if (!notified) {
             finalMessage += `\n<i>(Не удалось отправить уведомление ${currentUserData.knownUsers[otherUserId] || `User_${otherUserId}`})</i>`;
         }
    } else if (notifyOtherParty && otherUserId) {
        console.log(`Notification 'onRepaid' disabled for user ${otherUserId}`);
    }

    return { success: true, message: finalMessage };
}

// --- Delete Debt ---

// Delete a purely manual debt
async function deleteManualDebt(userId, debtId) {
    const userData = await dataStore.readUserData(userId);
    let debtList = null;
    let debtIndex = -1;
    let debtType = null;

    // Find the debt
    debtIndex = userData.debts.iOwe?.findIndex(d => d.id === debtId);
    if (debtIndex !== -1) {
        debtList = userData.debts.iOwe;
        debtType = 'iOwe';
    } else {
        debtIndex = userData.debts.oweMe?.findIndex(d => d.id === debtId);
        if (debtIndex !== -1) {
            debtList = userData.debts.oweMe;
            debtType = 'oweMe';
        }
    }

    if (!debtList || debtIndex === -1) {
        return { success: false, message: 'Ошибка: Долг не найден.' };
    }

    const debtToDelete = debtList[debtIndex];

    // Allow deleting manual or pending confirmation debts directly
    if (debtToDelete.status !== DEBT_STATUS.MANUAL && debtToDelete.status !== DEBT_STATUS.PENDING_CONFIRMATION) {
         return { success: false, message: 'Ошибка: Этот долг не является ручным или ожидающим связи и не может быть удален напрямую.' };
    }

    // Remove the debt
    const removedDebt = debtList.splice(debtIndex, 1)[0];

    // Add to history
    const historyEntry = {
        ...removedDebt,
        resolvedDate: new Date().toISOString(),
        action: HISTORY_ACTIONS.DELETED,
        type: debtType
    };
    if (!userData.history) userData.history = [];
    userData.history.push(historyEntry);

    await dataStore.writeUserData(userId, userData);

    return { success: true, message: `Долг (${removedDebt.partyIdentifier}, ${removedDebt.amount.toFixed(2)} ${removedDebt.currency}) удален и перемещен в историю.` };
}

// Request deletion of a linked (active or pending edit) debt
async function requestLinkedDebtDeletion(bot, userId, debtId) {
    const currentUserData = await dataStore.readUserData(userId);
    let debt = null;
    let listType = null;

    // Find the debt (can be active or pending edit)
    const findDebt = (list, type) => list?.find(d => d.id === debtId && (d.status === DEBT_STATUS.ACTIVE || d.status === DEBT_STATUS.PENDING_EDIT_APPROVAL));
    debt = findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');

    if (!debt) {
         return { success: false, message: 'Ошибка: Активный долг для запроса удаления не найден.' };
    }
    listType = currentUserData.debts.iOwe?.includes(debt) ? 'iOwe' : 'oweMe';


    if (!debt.linkedDebtId || !debt.partyUserId) {
        return { success: false, message: 'Ошибка: Долг не связан и не может быть удален через запрос.' };
    }

    const otherUserId = debt.partyUserId;
    const otherUserData = await dataStore.readUserData(otherUserId);
    const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
    const otherDebtIndex = otherUserData.debts[otherListType]?.findIndex(d => d.linkedDebtId === debt.linkedDebtId);

    if (otherDebtIndex === -1 || !otherUserData.debts[otherListType]) {
         console.error(`Sync Error: Mirrored debt ${debt.linkedDebtId} not found for user ${otherUserId} during delete request.`);
         return { success: false, message: 'Ошибка синхронизации при запросе удаления.' };
    }
    const otherDebt = otherUserData.debts[otherListType][otherDebtIndex];

    // Check if the other debt is also in a valid state for deletion request
     if (otherDebt.status !== DEBT_STATUS.ACTIVE && otherDebt.status !== DEBT_STATUS.PENDING_EDIT_APPROVAL) {
         console.warn(`Cannot request deletion for debt ${debt.linkedDebtId}. Other user's debt status is ${otherDebt.status}.`);
         return { success: false, message: `Ошибка: Статус долга у другой стороны (${otherDebt.status}) не позволяет запросить удаление.` };
     }

    // Change status on both sides
    debt.status = DEBT_STATUS.PENDING_DELETION_APPROVAL;
    otherDebt.status = DEBT_STATUS.PENDING_DELETION_APPROVAL;
    // Clear any pending edit state if deletion is requested
    debt.pendingEdit = null;
    otherDebt.pendingEdit = null;


    await dataStore.writeUserData(userId, currentUserData);
    await dataStore.writeUserData(otherUserId, otherUserData);

    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
    const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;
    const partyName = currentUserData.knownUsers[otherUserId] || otherUserUsername;

    let message = `Запрос на удаление долга (${partyName}, ${debt.amount.toFixed(2)} ${debt.currency}) отправлен. Ожидание подтверждения.`;

    // Notify the other user if enabled
    if (otherUserData.settings.notificationSettings.onDeleteRequest) {
        const notificationMsg = `${currentUserUsername} запросил(а) удаление связанного долга (${debt.amount.toFixed(2)} ${debt.currency}). Подтвердите или отклоните:`;
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🗑️ Подтвердить удаление', callback_data: `debt_confirmdelete_${debt.linkedDebtId}` },
                        { text: '🚫 Отклонить удаление', callback_data: `debt_rejectdelete_${debt.linkedDebtId}` }
                    ]
                ]
            }
        };
        const notified = await sendNotification(bot, otherUserId, notificationMsg, options);
        if (!notified) {
            message += "\n(Не удалось отправить уведомление другому пользователю)";
            // Should we revert status if notification fails? Maybe not.
        }
    } else {
        console.log(`Notification 'onDeleteRequest' disabled for user ${otherUserId}`);
    }

    return { success: true, message: message };
}

// Handle confirmation/rejection of a delete request
async function handleDeletionConfirmation(bot, userId, linkedDebtId, isConfirm) {
    const currentUserData = await dataStore.readUserData(userId);
    let debt = null;
    let listType = null;

    // Find the debt waiting for *this user's* deletion approval
    const findDebt = (list, type) => list?.find(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL);
    debt = findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');


    if (!debt) {
         return { success: false, message: 'Не удалось найти запрос на удаление долга. Возможно, он уже обработан.' };
    }
     listType = currentUserData.debts.iOwe?.includes(debt) ? 'iOwe' : 'oweMe';

    if (!debt.partyUserId) {
         console.error(`Data Error: Debt ${debt.id} pending delete has no partyUserId.`);
         // Attempt cleanup? Revert status?
         debt.status = DEBT_STATUS.ACTIVE; // Revert locally
         await dataStore.writeUserData(userId, currentUserData);
         return { success: false, message: 'Ошибка данных: Не найден инициатор запроса на удаление.' };
    }

    const otherUserId = debt.partyUserId; // The user who requested deletion
    const otherUserData = await dataStore.readUserData(otherUserId);
    const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
    const otherDebtIndex = otherUserData.debts[otherListType]?.findIndex(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL);

     if (otherDebtIndex === -1 || !otherUserData.debts[otherListType]) {
        console.error(`Sync Error: Mirrored debt ${linkedDebtId} not found for user ${otherUserId} during delete confirmation.`);
        // Clean up current user's side?
        if (debt) debt.status = DEBT_STATUS.ACTIVE; // Revert status?
        await dataStore.writeUserData(userId, currentUserData);
        return { success: false, message: 'Ошибка синхронизации при подтверждении удаления.' };
    }
    const otherDebt = otherUserData.debts[otherListType][otherDebtIndex];
    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
    const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;

    let finalMessage = '';
    let notificationMessage = '';
    let notifySetting = isConfirm ? 'onDeleteConfirm' : 'onDeleteReject';

    if (isConfirm) {
        // Remove from both lists
        currentUserData.debts[listType] = currentUserData.debts[listType].filter(d => d.linkedDebtId !== linkedDebtId);
        otherUserData.debts[otherListType].splice(otherDebtIndex, 1);

        // Add to history for both
        const historyEntry = { ...debt, resolvedDate: new Date().toISOString(), action: HISTORY_ACTIONS.DELETED, type: listType };
        const otherHistoryEntry = { ...otherDebt, resolvedDate: new Date().toISOString(), action: HISTORY_ACTIONS.DELETED, type: otherListType };
        if (!currentUserData.history) currentUserData.history = [];
        if (!otherUserData.history) otherUserData.history = [];
        currentUserData.history.push(historyEntry);
        otherUserData.history.push(otherHistoryEntry);

        finalMessage = `Вы подтвердили удаление долга (${debt.amount.toFixed(2)} ${debt.currency}) с ${otherUserUsername}. Долг удален и перенесен в историю.`;
        notificationMessage = `${currentUserUsername} подтвердил(а) удаление долга (${debt.amount.toFixed(2)} ${debt.currency}). Долг удален.`;

    } else { // Reject deletion
        // Revert status to active on both sides
        debt.status = DEBT_STATUS.ACTIVE;
        otherDebt.status = DEBT_STATUS.ACTIVE;

        finalMessage = `Вы отклонили удаление долга (${debt.amount.toFixed(2)} ${debt.currency}) с ${otherUserUsername}. Долг остается активным.`;
        notificationMessage = `${currentUserUsername} отклонил(а) удаление долга (${debt.amount.toFixed(2)} ${debt.currency}). Долг остается активным.`;
    }

    // Save data
    await dataStore.writeUserData(userId, currentUserData);
    await dataStore.writeUserData(otherUserId, otherUserData);

    // Notify the other user if enabled
    if (otherUserData.settings.notificationSettings[notifySetting]) {
        const notified = await sendNotification(bot, otherUserId, notificationMessage);
        if (!notified) {
            finalMessage += "\n<i>(Не удалось уведомить другую сторону)</i>";
        }
    } else {
        console.log(`Notification '${notifySetting}' disabled for user ${otherUserId}`);
    }

    return { success: true, message: finalMessage };
}

// Cancel a pending (unconfirmed/unapproved) debt
async function cancelPendingDebt(bot, userId, debtId) {
     const currentUserData = await dataStore.readUserData(userId);
     let debt = null;
     let listType = null;
     let otherUserId = null;
     let linkedDebtId = null;

     // Find the debt initiated by the current user that is pending
     const findDebt = (list, type) => {
         const d = list?.find(d => d.id === debtId && (d.status === DEBT_STATUS.PENDING_APPROVAL || d.status === DEBT_STATUS.PENDING_CONFIRMATION));
         if (d) {
             debt = d;
             listType = type;
             otherUserId = d.partyUserId; // Might be null for PENDING_CONFIRMATION initially
             linkedDebtId = d.linkedDebtId;
         }
         return d;
     };
     findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');

     if (!debt) {
         return { success: false, message: 'Ошибка: Не найден ожидающий долг для отмены.' };
     }

     // Remove the debt from the current user's list
     currentUserData.debts[listType] = currentUserData.debts[listType].filter(d => d.id !== debtId);
     let message = `Ожидающий долг (${debt.partyIdentifier}, ${debt.amount.toFixed(2)} ${debt.currency}) отменен.`;

     // If it was PENDING_APPROVAL, try to remove from the other user too
     if (debt.status === DEBT_STATUS.PENDING_APPROVAL && otherUserId && linkedDebtId) {
         try {
             const otherUserData = await dataStore.readUserData(otherUserId);
             const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
             const originalLength = otherUserData.debts[otherListType]?.length ?? 0;
             otherUserData.debts[otherListType] = otherUserData.debts[otherListType]?.filter(d => d.linkedDebtId !== linkedDebtId);

             if ((otherUserData.debts[otherListType]?.length ?? 0) < originalLength) {
                 await dataStore.writeUserData(otherUserId, otherUserData);
                 // Notify other user if enabled (using 'onRejected' setting as it's similar)
                 if (otherUserData.settings.notificationSettings.onRejected) {
                     const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
                     await sendNotification(bot, otherUserId, `${currentUserUsername} отменил(а) предложенный ранее долг (${debt.amount.toFixed(2)} ${debt.currency}).`);
                 } else {
                      console.log(`Notification 'onRejected' (for cancel pending) disabled for user ${otherUserId}`);
                 }
             } else {
                 console.warn(`Could not find mirrored pending debt ${linkedDebtId} for user ${otherUserId} to cancel.`);
                 message += "\n<i>(Не удалось синхронизировать отмену с другой стороной)</i>";
             }
         } catch (readError) {
              console.error(`Error reading other user data (${otherUserId}) during cancel pending sync:`, readError);
              message += "\n<i>(Ошибка чтения данных при синхронизации отмены)</i>";
         }
     }

     await dataStore.writeUserData(userId, currentUserData);
     return { success: true, message: message };
}

// Cancel a delete request previously made by the current user
async function cancelDeleteRequest(bot, userId, debtId) {
    const currentUserData = await dataStore.readUserData(userId);
    let debt = null;
    let listType = null;

    // Find the debt waiting for deletion approval initiated by the current user
    const findDebt = (list, type) => list?.find(d => d.id === debtId && d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL);
    debt = findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');


    if (!debt) {
        return { success: false, message: 'Ошибка: Не найден активный запрос на удаление этого долга, инициированный вами.' };
    }
    listType = currentUserData.debts.iOwe?.includes(debt) ? 'iOwe' : 'oweMe';

    if (!debt.linkedDebtId || !debt.partyUserId) {
        return { success: false, message: 'Ошибка: Долг не связан.' };
    }

    const otherUserId = debt.partyUserId;
    const otherUserData = await dataStore.readUserData(otherUserId);
    const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
    const otherDebt = otherUserData.debts[otherListType]?.find(d => d.linkedDebtId === debt.linkedDebtId && d.status === DEBT_STATUS.PENDING_DELETION_APPROVAL);

    if (!otherDebt) {
        console.error(`Sync Error: Mirrored debt ${debt.linkedDebtId} not found or not pending delete for user ${otherUserId} during cancel request.`);
        // Don't change status if sync fails? Or revert only current user? Reverting both seems risky.
        return { success: false, message: 'Ошибка синхронизации при отмене запроса на удаление.' };
    }

    // Revert status to active on both sides
    debt.status = DEBT_STATUS.ACTIVE;
    otherDebt.status = DEBT_STATUS.ACTIVE;

    await dataStore.writeUserData(userId, currentUserData);
    await dataStore.writeUserData(otherUserId, otherUserData);

    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
    const partyName = currentUserData.knownUsers[otherUserId] || otherDebt.partyIdentifier;
    let message = `Запрос на удаление долга (${partyName}, ${debt.amount.toFixed(2)} ${debt.currency}) отменен. Долг снова активен.`;

    // Notify the other user if enabled (using 'onDeleteReject' setting)
    if (otherUserData.settings.notificationSettings.onDeleteReject) {
        const notified = await sendNotification(bot, otherUserId, `${currentUserUsername} отменил(а) свой запрос на удаление долга (${debt.amount.toFixed(2)} ${debt.currency}). Долг остается активным.`);
        if (!notified) {
            message += "\n(Не удалось отправить уведомление другому пользователю)";
        }
    } else {
         console.log(`Notification 'onDeleteReject' (for cancel delete request) disabled for user ${otherUserId}`);
    }

    return { success: true, message: message };
}


// --- Edit Debt ---
// Initiates edit for manual or requests confirmation for linked
async function editDebt(bot, userId, debtId, fieldToEdit, newValue, originalDebt) {
     const currentUserData = await dataStore.readUserData(userId);
     let debt = null;
     let listType = null;

     // Find the debt
     const findDebt = (list, type) => {
         const d = list?.find(d => d.id === debtId);
         if (d) listType = type;
         return d;
     };
     debt = findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');

     if (!debt) {
         return { success: false, message: 'Ошибка: Долг не найден.' };
     }
     // Allow editing active or manual debts
     if (debt.status !== DEBT_STATUS.ACTIVE && debt.status !== DEBT_STATUS.MANUAL) {
          return { success: false, message: 'Ошибка: Редактировать можно только активные или ручные долги.' };
     }
     // Prevent editing party for linked debts
     if (fieldToEdit === 'partyIdentifier' && debt.status !== DEBT_STATUS.MANUAL) {
         return { success: false, message: 'Ошибка: Нельзя изменить контакт для связанного долга.' };
     }

     const oldValue = debt[fieldToEdit];
     let formattedNewValue = newValue; // Will be updated after validation/formatting

     // --- Apply changes locally (for validation/formatting) ---
     let tempDebt = { ...debt }; // Create a temporary copy
     try {
         switch (fieldToEdit) {
             case 'amount':
                 tempDebt.amount = parseFloat(newValue.toFixed(2));
                 formattedNewValue = tempDebt.amount.toFixed(2);
                 break;
             case 'currency':
                 tempDebt.currency = newValue.toUpperCase();
                 formattedNewValue = tempDebt.currency;
                 break;
             case 'dueDate':
                 tempDebt.dueDate = newValue; // Already validated or null
                 formattedNewValue = formatDate(tempDebt.dueDate); // Use formatter
                 break;
             case 'partyIdentifier': // Renamed from 'party' for clarity
                 tempDebt.partyIdentifier = newValue;
                 formattedNewValue = tempDebt.partyIdentifier;
                 break;
             default:
                 return { success: false, message: `Ошибка: Неизвестное поле для редактирования: ${fieldToEdit}` };
         }
     } catch (formatError) {
         console.error("Error formatting/applying edit value:", formatError);
         return { success: false, message: `Ошибка форматирования нового значения для поля ${fieldToEdit}.` };
     }
     // --- End Local Apply ---


     // --- Handle Manual Debt Editing ---
     if (debt.status === DEBT_STATUS.MANUAL) {
         // Apply changes directly
         debt[fieldToEdit] = tempDebt[fieldToEdit];

         // Add to history
         const historyEntry = createEditHistoryEntry(originalDebt, debt, fieldToEdit, oldValue, listType);
         if (!currentUserData.history) currentUserData.history = [];
         currentUserData.history.push(historyEntry);

         await dataStore.writeUserData(userId, currentUserData);
         const partyName = debt.partyIdentifier || 'Неизвестный';
         return { success: true, message: `Поле '${fieldToEdit}' для ручного долга (${partyName}) успешно изменено на '${formattedNewValue}'.` };
     }

     // --- Handle Linked Debt Editing (Requires Confirmation) ---
     if (debt.status === DEBT_STATUS.ACTIVE && debt.linkedDebtId && debt.partyUserId) {
         const otherUserId = debt.partyUserId;
         const otherUserData = await dataStore.readUserData(otherUserId);
         const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
         const otherDebt = otherUserData.debts[otherListType]?.find(d => d.linkedDebtId === debt.linkedDebtId);

         if (!otherDebt || otherDebt.status !== DEBT_STATUS.ACTIVE) {
             console.error(`Sync Error: Mirrored debt ${debt.linkedDebtId} not found or not active for user ${otherUserId} during edit request.`);
             return { success: false, message: 'Ошибка синхронизации: Не найден активный связанный долг у другой стороны.' };
         }

         // Store pending edit details and change status
         const pendingEditData = { field: fieldToEdit, newValue: tempDebt[fieldToEdit], requestedBy: userId };
         debt.pendingEdit = pendingEditData;
         debt.status = DEBT_STATUS.PENDING_EDIT_APPROVAL;
         otherDebt.pendingEdit = pendingEditData; // Store on both sides
         otherDebt.status = DEBT_STATUS.PENDING_EDIT_APPROVAL;

         await dataStore.writeUserData(userId, currentUserData);
         await dataStore.writeUserData(otherUserId, otherUserData);

         const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
         const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;
         const partyName = currentUserData.knownUsers[otherUserId] || otherUserUsername;

         let message = `Запрос на изменение долга (${partyName}, ${originalDebt.amount.toFixed(2)} ${originalDebt.currency}) отправлен. Ожидание подтверждения.`;

         // Notify the other user if enabled
         if (otherUserData.settings.notificationSettings.onEditRequest) {
             const fieldMap = { amount: 'Сумма', currency: 'Валюта', dueDate: 'Дата возврата' };
             const readableField = fieldMap[fieldToEdit] || fieldToEdit;
             const notificationMsg = `${currentUserUsername} запросил(а) изменение связанного долга:\n`
                                  + `Поле: ${readableField}\n`
                                  + `Старое значение: ${formatValueForDisplay(fieldToEdit, oldValue, originalDebt.currency)}\n`
                                  + `Новое значение: ${formatValueForDisplay(fieldToEdit, tempDebt[fieldToEdit], tempDebt.currency)}\n`
                                  + `Подтвердите или отклоните:`;
             const options = {
                 reply_markup: {
                     inline_keyboard: [
                         [
                             { text: '✅ Принять изменение', callback_data: `debt_acceptedit_${debt.linkedDebtId}` },
                             { text: '❌ Отклонить изменение', callback_data: `debt_rejectedit_${debt.linkedDebtId}` }
                         ]
                     ]
                 }
             };
             const notified = await sendNotification(bot, otherUserId, notificationMsg, options);
             if (!notified) {
                 message += "\n(Не удалось отправить уведомление другому пользователю)";
                 // Should we revert status if notification fails? Maybe not.
             }
         } else {
             console.log(`Notification 'onEditRequest' disabled for user ${otherUserId}`);
         }
         return { success: true, message: message };

     } else {
         // Should not happen if status checks are correct
         console.error(`Edit Error: Unexpected state for debt ${debt.id}, status ${debt.status}`);
         return { success: false, message: 'Внутренняя ошибка при попытке редактирования долга.' };
     }
}

// Handle confirmation/rejection of an edit request
async function handleEditConfirmation(bot, userId, linkedDebtId, isConfirm) {
    const currentUserData = await dataStore.readUserData(userId);
    let debt = null;
    let listType = null;

    // Find the debt waiting for *this user's* edit approval
    const findDebt = (list, type) => list?.find(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_EDIT_APPROVAL);
    debt = findDebt(currentUserData.debts.iOwe, 'iOwe') || findDebt(currentUserData.debts.oweMe, 'oweMe');

    if (!debt || !debt.pendingEdit || !debt.partyUserId) {
        return { success: false, message: 'Не удалось найти запрос на изменение долга. Возможно, он уже обработан.' };
    }
    listType = currentUserData.debts.iOwe?.includes(debt) ? 'iOwe' : 'oweMe';

    const otherUserId = debt.partyUserId; // The user who requested the edit
    const otherUserData = await dataStore.readUserData(otherUserId);
    const otherListType = listType === 'iOwe' ? 'oweMe' : 'iOwe';
    const otherDebt = otherUserData.debts[otherListType]?.find(d => d.linkedDebtId === linkedDebtId && d.status === DEBT_STATUS.PENDING_EDIT_APPROVAL);

    if (!otherDebt || !otherDebt.pendingEdit) {
        console.error(`Sync Error: Mirrored debt ${linkedDebtId} not found or not pending edit for user ${otherUserId} during edit confirmation.`);
        // Clean up current user's side? Revert status?
        if (debt) {
            debt.status = DEBT_STATUS.ACTIVE;
            debt.pendingEdit = null;
        }
        await dataStore.writeUserData(userId, currentUserData);
        return { success: false, message: 'Ошибка синхронизации при подтверждении изменения.' };
    }

    // Ensure the pending edit data matches (basic check)
    if (JSON.stringify(debt.pendingEdit) !== JSON.stringify(otherDebt.pendingEdit)) {
         console.error(`Sync Error: Pending edit data mismatch for ${linkedDebtId}.`);
         // Revert both to active?
         debt.status = DEBT_STATUS.ACTIVE;
         debt.pendingEdit = null;
         otherDebt.status = DEBT_STATUS.ACTIVE;
         otherDebt.pendingEdit = null;
         await dataStore.writeUserData(userId, currentUserData);
         await dataStore.writeUserData(otherUserId, otherUserData);
         return { success: false, message: 'Ошибка синхронизации: Несоответствие данных изменения.' };
    }

    const currentUserUsername = currentUserData.settings.username || `User_${userId}`;
    const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;
    const { field, newValue } = debt.pendingEdit;
    const originalValue = otherDebt[field]; // Get original value from the other debt before applying change

    let finalMessage = '';
    let notificationMessage = '';
    let notifySetting = isConfirm ? 'onEditConfirm' : 'onEditReject';

    if (isConfirm) {
        // Apply the changes
        const originalDebtForHistory = { ...otherDebt }; // Capture state before change for history
        debt[field] = newValue;
        otherDebt[field] = newValue;
        // Ensure amount precision if edited
        if (field === 'amount') {
            debt.amount = parseFloat(debt.amount.toFixed(2));
            otherDebt.amount = parseFloat(otherDebt.amount.toFixed(2));
        }

        debt.status = DEBT_STATUS.ACTIVE;
        otherDebt.status = DEBT_STATUS.ACTIVE;
        debt.pendingEdit = null;
        otherDebt.pendingEdit = null;

        // Add history entry for the user who *requested* the edit
        const historyEntry = createEditHistoryEntry(originalDebtForHistory, otherDebt, field, originalValue, otherListType);
        if (!otherUserData.history) otherUserData.history = [];
        otherUserData.history.push(historyEntry);
        // Optionally add history for the confirmer too? Maybe less important.

        const formattedNewValue = formatValueForDisplay(field, newValue, debt.currency);
        finalMessage = `Вы подтвердили изменение долга с ${otherUserUsername}. Поле '${field}' теперь '${formattedNewValue}'.`;
        // Формируем информативное уведомление для подтверждения
        const dueText = debt.dueDate ? ` до ${formatDate(debt.dueDate)}` : '';
        const who = listType === 'iOwe' ? `${currentUserUsername} → ${otherUserUsername}` : `${otherUserUsername} → ${currentUserUsername}`;
        notificationMessage = `${currentUserUsername} подтвердил(а) изменение долга:
${who}
Поле '${field}' теперь: ${formattedNewValue}${dueText}.`;

    } else { // Reject edit
        // Revert status, clear pending data
        debt.status = DEBT_STATUS.ACTIVE;
        otherDebt.status = DEBT_STATUS.ACTIVE;
        debt.pendingEdit = null;
        otherDebt.pendingEdit = null;

        const dueText = debt.dueDate ? ` до ${formatDate(debt.dueDate)}` : '';
        const who = listType === 'iOwe' ? `${currentUserUsername} → ${otherUserUsername}` : `${otherUserUsername} → ${currentUserUsername}`;
        const formattedValue = formatValueForDisplay(field, newValue, debt.currency);
        finalMessage = `Вы отклонили изменение долга (${field} на ${formattedValue}) с ${otherUserUsername}. Долг остается без изменений.`;
        notificationMessage = `${currentUserUsername} отклонил(а) изменение долга:
${who}
Поле '${field}' на ${formattedValue}${dueText}. Долг не изменен.`;
    }

    // Save data
    await dataStore.writeUserData(userId, currentUserData);
    await dataStore.writeUserData(otherUserId, otherUserData);

    // Notify the other user (the initiator) if enabled
    if (otherUserData.settings.notificationSettings[notifySetting]) {
        const notified = await sendNotification(bot, otherUserId, notificationMessage);
        if (!notified) {
            finalMessage += "\n<i>(Не удалось уведомить другую сторону)</i>";
        }
    } else {
        console.log(`Notification '${notifySetting}' disabled for user ${otherUserId}`);
    }

    return { success: true, message: finalMessage };
}


// --- Helper Functions ---

function createEditHistoryEntry(originalDebt, currentDebt, field, oldValue, listType) {
     const historyEntry = {
         // Base info from current state
         id: originalDebt.id, // Use original ID for tracking
         linkedDebtId: originalDebt.linkedDebtId,
         partyIdentifier: originalDebt.partyIdentifier, // Use original party info
         partyUserId: originalDebt.partyUserId,
         currency: field === 'currency' ? oldValue : originalDebt.currency, // Log currency *before* change if currency itself changed
         // History specific
         resolvedDate: new Date().toISOString(),
         action: HISTORY_ACTIONS.EDITED,
         type: listType,
         editedField: field,
         newValue: currentDebt[field], // Log the final value applied
         originalValue: oldValue // Log the value before edit
     };
      // Special handling for amount history
     if (field === 'amount') {
         historyEntry.originalAmount = oldValue; // Keep original amount field for clarity
         delete historyEntry.originalValue; // Avoid redundancy
         historyEntry.currency = currentDebt.currency; // Ensure currency is the current one for amount edits
     }
      // Special handling for currency history
     if (field === 'currency') {
         historyEntry.originalCurrency = oldValue;
         historyEntry.amount = currentDebt.amount; // Log amount associated with the currency change
         // delete historyEntry.originalValue; // Keep originalValue as it holds the old currency code
     }
      // Special handling for due date
      if (field === 'dueDate') {
          historyEntry.originalDueDate = oldValue;
          delete historyEntry.originalValue;
      }

     return historyEntry;
}

function formatValueForDisplay(field, value, currency) {
     if (value === null || value === undefined) return 'Нет';
     switch (field) {
         case 'amount':
             return formatCurrency(value, currency);
         case 'dueDate':
             return formatDate(value);
         case 'currency':
         case 'partyIdentifier':
             return value;
         default:
             return String(value);
     }
 }


module.exports = {
    addDebt,
    handleDebtAcceptance,
    repayDebt,
    deleteManualDebt,
    requestLinkedDebtDeletion,
    handleDeletionConfirmation,
    cancelPendingDebt,
    cancelDeleteRequest,
    editDebt,
    handleEditConfirmation // New handler for accepting/rejecting edits
};
