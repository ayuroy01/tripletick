import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { onInbound } from './bots.ts';
import { setSimulatorStatusHandler } from './channels/simulator.ts';
import { applyStatus, setInboundHook } from './messaging.ts';
import { registerCallRoutes } from './calls.ts';
import { registerConnectorRoutes } from './connectors.ts';
import { registerPushRoutes, startPush } from './push.ts';
import { registerRoutes } from './routes.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Connects the layers that can't import each other, then builds the HTTP server. */
export async function createApp(opts: { logger?: boolean } = {}) {
  setInboundHook(onInbound);
  setSimulatorStatusHandler((id, status) => applyStatus(id, status));

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 12 * 1024 * 1024 });

  // Webhook signatures are computed over the exact bytes, so keep them.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
  });

  registerRoutes(app);
  registerCallRoutes(app);
  registerConnectorRoutes(app);
  registerPushRoutes(app);
  startPush();

  const dist = resolve(here, '../../web/dist');
  if (existsSync(dist)) await app.register(fastifyStatic, { root: dist });
  return app;
}
