const dataStore = require('./dataStore');
const { DEBT_STATUS } = require('./constants');

// Updates user's own username in settings and links pending debts
async function updateUserLinkInfo(bot, userId, username) {
    if (!userId || !username) return; // Cannot link without both

    const userData = await dataStore.readUserData(userId);
    let userChanged = false;
    let notificationsToSend = []; // { userId: string, message: string }

    // Store/update own username in settings
    if (userData.settings.username !== username) {
        console.log(`Updating username for ${userId} from ${userData.settings.username} to ${username}`);
        userData.settings.username = username;
        userChanged = true;
    }

    // Scan debts for pending confirmations initiated by others where partyIdentifier matches this user's *new* username
    const processList = async (list, isIOweList) => {
        let listChanged = false;
        for (const debt of list) {
            // If status is PENDING_CONFIRMATION, it means the *other* user added it using @username
            // and is waiting for *this* user (userId) to interact with the bot.
            // The debt.partyUserId should be the *other* user's ID.
            if (debt.status === DEBT_STATUS.PENDING_CONFIRMATION && debt.partyUserId && debt.linkedDebtId) {
                const otherUserId = debt.partyUserId;
                const otherUserData = await dataStore.readUserData(otherUserId);

                // Find the mirrored debt in the other user's data
                const otherListType = isIOweList ? 'oweMe' : 'iOwe';
                const mirroredDebt = otherUserData.debts[otherListType]?.find(d => d.linkedDebtId === debt.linkedDebtId);

                // Check if the identifier used by the *other* user matches *our* current username
                if (mirroredDebt && mirroredDebt.partyIdentifier?.toLowerCase() === username.toLowerCase()) {
                    console.log(`Linking debt ${debt.linkedDebtId} between ${otherUserId} and ${userId} upon ${username} interaction.`);
                    // Found a match! Activate the debt on both sides.
                    debt.status = DEBT_STATUS.ACTIVE;
                    mirroredDebt.status = DEBT_STATUS.ACTIVE;
                    mirroredDebt.partyUserId = userId; // Ensure partyUserId is set correctly on the mirrored debt

                    // Update known users for both parties
                    const otherUserUsername = otherUserData.settings.username || `User_${otherUserId}`;
                    userData.knownUsers[otherUserId] = otherUserUsername;
                    otherUserData.knownUsers[userId] = username;

                    listChanged = true;

                    // Prepare notifications
                    notificationsToSend.push({
                        userId: otherUserId,
                        message: `Долг с ${username} (${debt.amount.toFixed(2)} ${debt.currency}) был подтвержден и теперь активен.`
                    });
                     notificationsToSend.push({
                        userId: userId,
                        message: `Обнаружен и связан существующий долг с ${otherUserUsername} (${debt.amount.toFixed(2)} ${debt.currency}).`
                    });

                    // Save changes for the other user immediately
                    await dataStore.writeUserData(otherUserId, otherUserData);
                }
            }
        }
        return listChanged;
    };

    const iOweChanged = await processList(userData.debts.iOwe, true);
    const oweMeChanged = await processList(userData.debts.oweMe, false);

    if (userChanged || iOweChanged || oweMeChanged) {
        await dataStore.writeUserData(userId, userData); // Save changes for the current user
    }

    // Send notifications after saving data
    for (const notification of notificationsToSend) {
        try {
            // Check notification setting for recipient? Maybe not for linking confirmation.
            await bot.sendMessage(notification.userId, notification.message);
        } catch (error) {
            console.error(`Failed to send linking notification to ${notification.userId}:`, error.response?.body || error.message);
        }
    }
}

// Links debts based on an old username provided via /linkme
async function linkDebtsByOldUsername(bot, userId, currentUsername, oldUsername) {
     if (!userId || !currentUsername || !oldUsername || currentUsername.toLowerCase() === oldUsername.toLowerCase()) {
        console.error("Invalid input for linkDebtsByOldUsername");
        return 0; // Indicate no links made
    }

    let linkedCount = 0;
    const updatedUserData = await dataStore.readUserData(userId); // Load current user data once
    const lowerCaseOldUsername = oldUsername.toLowerCase();

    try {
        const allUserIds = await dataStore.getAllUserIds();
        for (const otherUserId of allUserIds) {
            if (otherUserId === userId) continue; // Skip self

            let otherUserData = await dataStore.readUserData(otherUserId);
            let otherUserUpdated = false;

            const processList = async (list, isIOweListOnOtherUser) => {
                for (const debt of list) {
                    // Look for debts added *by* otherUser where partyIdentifier is the oldUsername
                    // and status is PENDING_CONFIRMATION (meaning otherUser is waiting for oldUsername to appear)
                    if (debt.status === DEBT_STATUS.PENDING_CONFIRMATION && debt.partyIdentifier?.toLowerCase() === lowerCaseOldUsername && debt.linkedDebtId) {
                        console.log(`Found potential linkme match: Debt ${debt.id} from user ${otherUserId} waiting for ${oldUsername}`);

                        // Found a match! Link it to the current user (userId).
                        debt.status = DEBT_STATUS.ACTIVE;
                        debt.partyUserId = userId; // Link to the current user's ID

                        // Create/Update the mirrored debt for the current user (userId)
                        const mirroredDebtData = {
                            ...debt, // Copy details from the debt created by the other user
                            id: uuidv4(), // New ID for the mirrored entry
                            partyUserId: otherUserId, // Link back to the original user
                            partyIdentifier: otherUserData.settings.username || `User_${otherUserId}`, // Use other user's current username
                            linkedDebtId: debt.linkedDebtId, // Keep the same link ID
                            status: DEBT_STATUS.ACTIVE,
                        };

                        const targetList = isIOweListOnOtherUser ? updatedUserData.debts.oweMe : updatedUserData.debts.iOwe;
                        const existingIndex = targetList.findIndex(d => d.linkedDebtId === mirroredDebtData.linkedDebtId);

                        if (existingIndex === -1) { // Add if not already present
                             targetList.push(mirroredDebtData);
                             console.log(`Added mirrored debt for ${debt.linkedDebtId} to user ${userId}`);
                        } else {
                            // Update existing mirrored debt if necessary (e.g., status, partyIdentifier)
                            targetList[existingIndex] = { ...targetList[existingIndex], ...mirroredDebtData };
                             console.log(`Updated existing mirrored debt for ${debt.linkedDebtId} for user ${userId}`);
                        }

                        // Update known users
                        updatedUserData.knownUsers[otherUserId] = otherUserData.settings.username || `User_${otherUserId}`;
                        otherUserData.knownUsers[userId] = currentUsername;

                        linkedCount++;
                        otherUserUpdated = true;
                        console.log(`Manually linked debt ${debt.linkedDebtId} from ${oldUsername} to ${currentUsername} (${userId}) initiated by /linkme`);

                        // Notify the other party
                        try {
                            // Check notification setting?
                            await bot.sendMessage(otherUserId, `Долг с ${oldUsername} (${debt.amount.toFixed(2)} ${debt.currency}) был вручную привязан к ${currentUsername} по его/ее запросу /linkme.`);
                        } catch (error) {
                            console.error(`Failed to send linkme notification to ${otherUserId}:`, error.response?.body || error.message);
                        }
                    }
                }
            };

            // Check debts where otherUser owes oldUsername (otherUser's iOwe list)
            await processList(otherUserData.debts.iOwe, true);
            // Check debts where oldUsername owes otherUser (otherUser's oweMe list)
            await processList(otherUserData.debts.oweMe, false);

            if (otherUserUpdated) {
                await dataStore.writeUserData(otherUserId, otherUserData);
            }
        }
    } catch (error) {
        console.error("Error during /linkme scan:", error);
        // Notify the requesting user?
        try {
             await bot.sendMessage(userId, "Произошла ошибка при поиске долгов для привязки.");
        } catch (notifyError) {
             console.error("Failed to send linkme error notification:", notifyError);
        }
        return 0; // Indicate error/no links
    }

    // Save the requesting user's data if links were made or if their username needed updating
    if (linkedCount > 0 || updatedUserData.settings.username !== currentUsername) {
        updatedUserData.settings.username = currentUsername; // Ensure current username is saved
        await dataStore.writeUserData(userId, updatedUserData);
    }

    return linkedCount;
}


module.exports = {
    updateUserLinkInfo,
    linkDebtsByOldUsername
};
