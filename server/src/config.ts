import { resolve } from 'node:path';

const dataDir = resolve(process.env.TT_DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT || 4310),
  host: process.env.TT_HOST || '127.0.0.1',
  dataDir,
  dbPath: resolve(dataDir, 'tripletick.db'),
  mediaDir: resolve(dataDir, 'media'),
  publicUrl: process.env.TT_PUBLIC_URL || '',
  demo: process.env.TT_DEMO === '1',
  aiModel: process.env.TT_AI_MODEL || 'claude-opus-5-5',
  graphVersion: process.env.TT_GRAPH_VERSION || 'v26.0',
};
