const { SUPPORTED_CURRENCIES } = require('../constants');

// Basic email format check (adjust regex as needed for stricter validation)
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Telegram username format check (@ followed by 5-32 alphanumeric chars and underscores)
const usernameRegex = /^@[a-zA-Z0-9_]{5,32}$/;

// Date format check (DD-MM-YYYY) - Basic structure check
const dateRegex = /^\d{2}-\d{2}-\d{4}$/;

function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  return emailRegex.test(email.trim());
}

function isValidUsername(username) {
  if (!username || typeof username !== 'string') {
    return false;
  }
  return usernameRegex.test(username.trim());
}

function validateAmount(text) {
    if (text === null || text === undefined) return null; // Handle null/undefined input
    const cleanedText = String(text).trim().replace(',', '.'); // Ensure text is string, handle comma decimal separator
    if (!cleanedText) return null; // Handle empty string after trim

    const amount = parseFloat(cleanedText);

    // Check if NaN, not positive, OR not finite
    if (isNaN(amount) || amount <= 0 || !isFinite(amount)) {
        return null; // Invalid, non-positive, or non-finite amount
    }
    return amount; // Return the parsed number
}


function validateDate(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmedText = text.trim();
    if (!dateRegex.test(trimmedText)) {
        return null; // Doesn't match DD-MM-YYYY format
    }

    const parts = trimmedText.split('-');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10); // Month is 1-based in input
    const year = parseInt(parts[2], 10);

    // Basic sanity checks for date components
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) {
        return null;
    }

    // Check for valid day in month (handles leap years implicitly via Date object)
    // Note: JavaScript Date months are 0-indexed (0=Jan, 11=Dec)
    const dateObj = new Date(year, month - 1, day);

    // Verify that the components match the created date object
    // This catches invalid dates like 31-02-2023
    if (dateObj.getFullYear() !== year || dateObj.getMonth() !== month - 1 || dateObj.getDate() !== day) {
        return null;
    }

    // Optional: Check if the date is in the past? Decide based on requirements.
    // const today = new Date();
    // today.setHours(0, 0, 0, 0); // Set to start of today for comparison
    // if (dateObj < today) {
    //     return null; // Date is in the past
    // }

    // Return the validated date string in the original format
    return trimmedText;
}

function isValidCurrency(currency) {
    return SUPPORTED_CURRENCIES.includes(currency);
}


module.exports = {
    validateEmail,
    isValidUsername,
    validateAmount,
    validateDate,
    isValidCurrency
};
