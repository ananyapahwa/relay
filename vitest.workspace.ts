import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      include: ['packages/**/*.test.ts'],
      env: {
        DATABASE_URL: 'postgres://relay:relay_secret@localhost:5433/relay_test',
        REDIS_URL: 'redis://localhost:6380'
      }
    }
  },
  {
    test: {
      include: ['apps/**/*.test.ts'],
      env: {
        DATABASE_URL: 'postgres://relay:relay_secret@localhost:5433/relay_test',
        REDIS_URL: 'redis://localhost:6380'
      }
    }
  }
]);
