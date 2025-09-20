import { buildApp } from './app';
import { env } from './env';

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info('transactions service listening on port ' + env.PORT);
  } catch (error) {
    app.log.error(error, 'failed to start transactions service');
    process.exitCode = 1;
    await app.close();
  }
}

start();
