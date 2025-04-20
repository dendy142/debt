const fs = require('fs').promises;
const path = require('path');
const { DEFAULT_SETTINGS } = require('./constants');

const dataDir = path.join(__dirname, 'data');

async function ensureDataDir() {
    try {
        await fs.access(dataDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.mkdir(dataDir);
                console.log(`Data directory created: ${dataDir}`);
            } catch (mkdirError) {
                console.error(`Error creating data directory ${dataDir}:`, mkdirError);
                throw mkdirError; // Rethrow critical error
            }
        } else {
            console.error(`Error accessing data directory ${dataDir}:`, error);
            throw error; // Rethrow other critical errors
        }
    }
}

function getUserDataPath(userId) {
    if (!userId) {
        console.error("Attempted to get data path with null/undefined userId");
        return null; // Or throw error
    }
    return path.join(dataDir, `user_${userId}.json`);
}

// Helper to deeply merge settings, ensuring all default keys exist
function mergeSettings(savedSettings) {
    const merged = { ...DEFAULT_SETTINGS }; // Start with defaults

    for (const key in savedSettings) {
        if (savedSettings.hasOwnProperty(key)) {
            if (typeof savedSettings[key] === 'object' && savedSettings[key] !== null && !Array.isArray(savedSettings[key]) && typeof DEFAULT_SETTINGS[key] === 'object' && DEFAULT_SETTINGS[key] !== null) {
                // Recursively merge nested objects (like notificationSettings)
                merged[key] = { ...DEFAULT_SETTINGS[key], ...savedSettings[key] };
            } else if (DEFAULT_SETTINGS.hasOwnProperty(key)) {
                // Overwrite default with saved value if key exists in defaults
                merged[key] = savedSettings[key];
            }
            // Ignore saved keys that are not in defaults (handles removal of old settings)
        }
    }
     // Ensure all default keys are present even if not in savedSettings
     for (const key in DEFAULT_SETTINGS) {
         if (!merged.hasOwnProperty(key)) {
             merged[key] = DEFAULT_SETTINGS[key];
         }
         // Ensure nested defaults are present
         if (typeof DEFAULT_SETTINGS[key] === 'object' && DEFAULT_SETTINGS[key] !== null && !Array.isArray(DEFAULT_SETTINGS[key])) {
             if (typeof merged[key] !== 'object' || merged[key] === null || Array.isArray(merged[key])) {
                 merged[key] = { ...DEFAULT_SETTINGS[key] }; // Initialize if type mismatch or missing
             } else {
                 // Ensure all sub-keys from default exist
                 for (const subKey in DEFAULT_SETTINGS[key]) {
                     if (!merged[key].hasOwnProperty(subKey)) {
                         merged[key][subKey] = DEFAULT_SETTINGS[key][subKey];
                     }
                 }
             }
         }
     }

    return merged;
}


async function readUserData(userId) {
    if (!userId) {
        console.error("Attempted to read data for null/undefined userId");
        return { debts: { iOwe: [], oweMe: [] }, history: [], settings: mergeSettings({}), knownUsers: {} }; // Return default structure with merged settings
    }
    await ensureDataDir(); // Ensure directory exists before reading
    const userPath = getUserDataPath(userId);
    if (!userPath) return { debts: { iOwe: [], oweMe: [] }, history: [], settings: mergeSettings({}), knownUsers: {} };

    try {
        await fs.access(userPath); // Check if file exists first
        const data = await fs.readFile(userPath, 'utf-8');
        let jsonData = JSON.parse(data);

        // Ensure default structure and merge settings deeply
        jsonData.debts = jsonData.debts || { iOwe: [], oweMe: [] };
        jsonData.history = jsonData.history || [];
        jsonData.knownUsers = jsonData.knownUsers || {};
        jsonData.settings = mergeSettings(jsonData.settings || {}); // Use deep merge

        return jsonData;
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, return default structure
            console.log(`Data file not found for user ${userId}. Returning default structure.`);
            return { debts: { iOwe: [], oweMe: [] }, history: [], settings: mergeSettings({}), knownUsers: {} };
        } else if (error instanceof SyntaxError) {
             console.error(`Error parsing JSON data for user ${userId}:`, error);
             // Handle corrupted JSON - maybe return default or try to recover?
             // Returning default for now to prevent crashes
             return { debts: { iOwe: [], oweMe: [] }, history: [], settings: mergeSettings({}), knownUsers: {} };
        } else {
            console.error(`Error reading data file for user ${userId} (${userPath}):`, error);
            // Return default on other errors to prevent crashing, but log the error
            return { debts: { iOwe: [], oweMe: [] }, history: [], settings: mergeSettings({}), knownUsers: {} };
        }
    }
}

async function writeUserData(userId, data) {
     if (!userId || !data) {
        console.error("Attempted to write data with null/undefined userId or data");
        return false; // Indicate failure
    }
    await ensureDataDir(); // Ensure directory exists before writing
    const userPath = getUserDataPath(userId);
     if (!userPath) return false;

    try {
        // Ensure settings object exists and merges defaults deeply before writing
        data.settings = mergeSettings(data.settings || {});
        // Ensure other core structures exist
        data.debts = data.debts || { iOwe: [], oweMe: [] };
        data.history = data.history || [];
        data.knownUsers = data.knownUsers || {};

        // Clean up potential temporary fields before saving (e.g., pendingEdit)
        const cleanData = JSON.parse(JSON.stringify(data)); // Deep clone to avoid modifying original object
        const cleanDebts = (debts) => debts.map(d => {
            // delete d.pendingEdit; // Example cleanup if needed - handled differently now
            return d;
        });
        cleanData.debts.iOwe = cleanDebts(cleanData.debts.iOwe || []);
        cleanData.debts.oweMe = cleanDebts(cleanData.debts.oweMe || []);


        await fs.writeFile(userPath, JSON.stringify(cleanData, null, 2), 'utf-8');
        // console.log(`Data successfully written for user ${userId}`);
        return true; // Indicate success
    } catch (error) {
        console.error(`Error writing data file for user ${userId} (${userPath}):`, error);
        return false; // Indicate failure
    }
}

// --- User Discovery ---

// Finds a user ID if they are known by the requesting user OR if their username is stored in their own settings
async function findUserByUsername(requestingUserId, username) {
    if (!isValidUsername(username)) return null;

    const requestingUserData = await readUserData(requestingUserId);
    const lowerCaseUsername = username.toLowerCase();

    // 1. Check requesting user's known users
    for (const knownId in requestingUserData.knownUsers) {
        const knownUsername = requestingUserData.knownUsers[knownId];
        if (typeof knownUsername === 'string' && knownUsername.toLowerCase() === lowerCaseUsername) {
            console.log(`Found user ${username} (${knownId}) in known users of ${requestingUserId}`);
            return knownId;
        }
    }

    // 2. Fallback: Scan all data files (less efficient)
    console.log(`User ${username} not in known users of ${requestingUserId}, scanning all files...`);
    try {
        await ensureDataDir();
        const files = await fs.readdir(dataDir);
        for (const file of files) {
            if (file.startsWith('user_') && file.endsWith('.json')) {
                const potentialUserId = file.substring(5, file.length - 5);
                if (potentialUserId === requestingUserId) continue; // Skip self

                // Read only the settings part if possible for efficiency (requires more complex parsing or assumptions)
                // For simplicity, read the whole file for now.
                const potentialUserData = await readUserData(potentialUserId);
                if (potentialUserData.settings?.username?.toLowerCase() === lowerCaseUsername) {
                    console.log(`Found user ${username} (${potentialUserId}) by scanning their settings.`);
                    return potentialUserId;
                }
            }
        }
    } catch (error) {
        // Log errors accessing/reading directory or files during scan
        if (error.code !== 'ENOENT') { // Ignore if dataDir doesn't exist yet
             console.error("Error scanning user files by username:", error);
        }
    }

    console.log(`User ${username} not found.`);
    return null; // Not found
}

// Get all user IDs (e.g., for reminders)
async function getAllUserIds() {
    const userIds = [];
    try {
        await ensureDataDir();
        const files = await fs.readdir(dataDir);
        for (const file of files) {
            if (file.startsWith('user_') && file.endsWith('.json')) {
                const userId = file.substring(5, file.length - 5);
                if (userId) {
                    userIds.push(userId);
                }
            }
        }
    } catch (error) {
         if (error.code !== 'ENOENT') {
            console.error("Error getting all user IDs:", error);
         }
         // Return empty list or rethrow depending on desired behavior
    }
    return userIds;
}


module.exports = {
    readUserData,
    writeUserData,
    findUserByUsername,
    ensureDataDir,
    getAllUserIds,
    getUserDataPath // Export if needed for backup
};

// Local helper (not exported)
function isValidUsername(text) {
    return typeof text === 'string' && /^@[a-zA-Z0-9_]{5,32}$/.test(text);
}
