// Minimum env vars so env.ts validation passes in unit tests that import
// services (which pull in env.ts at module load time). These values are never
// used to make real connections — all unit tests inject fake clients/mocks.
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test?sslmode=require';
process.env.JWT_SECRET = 'test-secret-minimum-16-chars';
