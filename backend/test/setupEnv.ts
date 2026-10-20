// Runs in every test worker before any app module is imported.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL_RESOLVED || process.env.TEST_DATABASE_URL || 'postgres://dojo:dojo@localhost:5432/tradedojo_test';
process.env.DB_CA_CERT_PATH = '';
process.env.JWT_SECRET = 'test-secret-123456';
process.env.PRICE_PROVIDER = 'mock';
process.env.ADMIN_EMAIL = 'admin@test';
process.env.ADMIN_PASSWORD = 'admin-password';
process.env.EMAIL_VERIFICATION = '0';
process.env.AI_COACH_ENABLED = '0';
process.env.DB_POOL_MAX = '5';

import { afterAll } from 'vitest';

afterAll(async () => {
  const { pool } = await import('../src/db/pool.js');
  await pool.end();
});
