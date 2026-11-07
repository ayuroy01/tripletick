import { get, parse } from '../db.ts';
import { openSecret } from '../secrets.ts';
import { simulator } from './simulator.ts';
import { whatsappCloud } from './whatsapp.ts';

export interface Channel { id: number; type: string; name: string; phone: string; config: string; enabled: number }

export type Outbound =
  | { kind: 'text'; to: string; body: string }
  | { kind: 'media'; to: string; body: string; filePath: string; mime: string; fileName: string }
  | { kind: 'buttons'; to: string; body: string; options: string[] }
  | { kind: 'template'; to: string; name: string; language: string; params: string[] }
  | { kind: 'flow'; to: string; body: string; cta: string; flowId: string; screen: string; token: string }
  | { kind: 'call_permission'; to: string; body: string };

/** Every messaging provider implements this. Add a new channel by adding one adapter. */
export interface ChannelAdapter {
  send(channel: Channel, message: Outbound): Promise<{ externalId: string }>;
}

const adapters: Record<string, ChannelAdapter> = { simulator, whatsapp_cloud: whatsappCloud };

export function adapterFor(type: string): ChannelAdapter {
  const a = adapters[type];
  if (!a) throw new Error(`No adapter for channel type: ${type}`);
  return a;
}

export const getChannel = (id: number) => get<Channel>('SELECT * FROM channels WHERE id = ?', id);
export const channelConfig = <T>(c: Channel) => parse<T>(openSecret(c.config), {} as T);

const SECRET_KEYS = ['accessToken', 'appSecret', 'verifyToken'];

/** Secrets never leave the server. The UI only learns whether each one is set. */
export function publicChannel(c: Channel) {
  const config = channelConfig<Record<string, string>>(c);
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) safe[k] = SECRET_KEYS.includes(k) ? !!v : v;
  return { ...c, config: safe };
}
