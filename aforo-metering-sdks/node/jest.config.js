/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  // Calibrated to the suite's current coverage as a regression floor — the gate
  // still fails the build if coverage drops below today's level. Raise these as
  // more tests are added.
  coverageThreshold: {
    global: { branches: 70, functions: 72, lines: 80, statements: 80 },
  },
};
