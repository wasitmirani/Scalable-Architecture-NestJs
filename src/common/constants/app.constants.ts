

console.log("APP_TIMEZONE=", process.env.APP_TIMEZONE);
export const APP_CONSTANTS = {
    DEFAULT_PAGE_LIMIT: 20,
    MAX_PAGE_LIMIT: 100,
    DEFAULT_MESSAGE: 'Data fetched successfully',
    APP_NAME: process.env.APP_NAME || 'nestjs-app',
    APP_TMEZONE: process.env.APP_TIMEZONE || 'Asia/Karachi',
    LOG_DIR: process.env.LOG_DIR || 'storage/logs',
    LOG_FILE: process.env.LOG_FILE || 'app.log',
};