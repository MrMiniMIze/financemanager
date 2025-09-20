module.exports = {
  test: {
    environment: 'node',
    globals: true,
    include: ['services/profile/test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
    },
  },
};
