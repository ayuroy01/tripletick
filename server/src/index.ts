import { createApp } from './app.ts';
import { aiMode } from './ai.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { startScheduler } from './scheduler.ts';
import { encryptStoredSecrets } from './secrets.ts';
import { seedDemo } from './seed.ts';

openDb(config.dbPath);
encryptStoredSecrets();
if (config.demo) seedDemo();

const app = await createApp();
await app.listen({ port: config.port, host: config.host });
startScheduler();

console.log(`
  ✓✓✓ Triple Tick is running at http://localhost:${config.port}
  AI: ${aiMode() === 'claude' ? `Claude (${config.aiModel})` : 'offline helpers (set ANTHROPIC_API_KEY to enable Claude)'}
${config.demo ? '  Demo login: demo@tripletick.local / tripletick\n' : ''}`);
