// General helper functions

function parseDate(dateString) {
    // Parses DD-MM-YYYY into a Date object
    if (!dateString) return null;
    const parts = dateString.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!parts) return null;
    // Month is 0-indexed in Date constructor
    return new Date(parseInt(parts[3], 10), parseInt(parts[2], 10) - 1, parseInt(parts[1], 10));
}

function getDaysDifference(date1, date2) {
    const oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
    const diffTime = date2.getTime() - date1.getTime();
    return Math.round(diffTime / oneDay);
}

module.exports = {
    parseDate,
    getDaysDifference
};
