module.exports = {
  test: {
    environment: 'node',
    globals: true,
    include: ['services/accounts/test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
    },
  },
};
