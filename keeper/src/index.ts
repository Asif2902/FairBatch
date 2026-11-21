import { loadKeeperConfig } from './config.js';
import { FairBatchKeeper, structuredLog } from './service.js';

async function main(): Promise<void> {
  const config = loadKeeperConfig(process.argv.slice(2));
  const keeper = new FairBatchKeeper(config, structuredLog);

  const shutdown = async (signal: string) => {
    structuredLog('info', 'shutdown_signal_received', { signal });
    await keeper.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await keeper.start();
}

main().catch((err) => {
  structuredLog('error', 'keeper_fatal_error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
