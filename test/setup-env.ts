// Loaded before each e2e test file: point the app at the disposable test database.
process.env.DB_NAME = process.env.DB_TEST_NAME || 'birdcrm_test';
process.env.DB_LOGGING = 'false';
process.env.MAIL_HOST = '';
process.env.FRONTEND_URL = 'http://localhost:5173';
