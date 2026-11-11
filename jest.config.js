module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  projects: [
    {
      displayName: 'node',
      testMatch: ['<rootDir>/tests/background.test.js', '<rootDir>/tests/integration.test.js', '<rootDir>/tests/hardening.test.js'],
      testEnvironment: 'node',
    },
    {
      displayName: 'jsdom',
      testMatch: ['<rootDir>/tests/scraping.test.js', '<rootDir>/tests/popup.test.js', '<rootDir>/tests/real-pages.test.js', '<rootDir>/tests/nested-pages.test.js'],
      testEnvironment: 'jsdom',
    },
  ],
};
