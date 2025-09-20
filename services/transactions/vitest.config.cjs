module.exports = {
  test: {
    environment: 'node',
    globals: true,
    include: ['services/transactions/test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
    },
  },
};
