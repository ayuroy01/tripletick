import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Outbound requests to addresses an admin typed in (webhooks) must not reach this
 * server's own network: loopback, private ranges, link-local and cloud metadata.
 * Set TT_ALLOW_PRIVATE_WEBHOOKS=1 when the receiver really is on your own network.
 */
const allowPrivate = () => process.env.TT_ALLOW_PRIVATE_WEBHOOKS === '1';

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 3],
];

function v4ToInt(ip: string) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (isIP(ip) !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4 inside IPv6 (::ffff:1.2.3.4, ::1.2.3.4, NAT64 64:ff9b::1.2.3.4) gets the IPv4 rules.
  const embedded = /(?:^::(?:ffff:)?|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (embedded) return isPrivateAddress(embedded);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) return isPrivateAddress([parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.'));
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */ || (first & 0xff00) === 0xff00 /* multicast */;
}

export class BlockedTarget extends Error {}

/** Checks a URL an admin wants to send to, before it's saved. Sending checks again, at connect time. */
export async function checkOutboundUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BlockedTarget('That is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BlockedTarget('Webhook URLs must use http or https');
  if (url.username || url.password) throw new BlockedTarget("Put credentials in your receiver's settings, not in the URL");
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await new Promise<string[]>((res, rej) =>
    lookup(host, { all: true }, (e, list) => (e ? rej(new BlockedTarget(`Can't find ${host}`)) : res(list.map((a) => a.address)))));
  if (addresses.some(isPrivateAddress)) throw new BlockedTarget('Webhooks cannot point at private or internal network addresses');
  return url;
}

/**
 * Resolves and checks in one step, and the connection uses the address that was checked,
 * so DNS can't swap in an internal address between the check and the request.
 */
const guardedLookup: LookupFunction = (host, options, callback) => {
  lookup(host, { ...options, all: true }, (err, list) => {
    if (err) return (callback as any)(err);
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad && !allowPrivate()) return (callback as any)(new BlockedTarget(`${host} resolves to an internal address`));
    if ((options as any).all) return (callback as any)(null, list);
    return (callback as any)(null, list[0].address, list[0].family);
  });
};

/** POSTs without following redirects, because a redirect could point anywhere. Resolves to the HTTP status. */
export async function postGuarded(raw: string, body: string, headers: Record<string, string>, timeoutMs = 8000): Promise<number> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host) && !allowPrivate()) throw new BlockedTarget('Webhooks cannot point at private or internal network addresses');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: 'POST', lookup: guardedLookup, timeout: timeoutMs,
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
    }, (res) => {
      res.resume(); // the receiver's response body is not needed
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('Webhook timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
