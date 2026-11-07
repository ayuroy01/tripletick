import { randomUUID } from 'node:crypto';
import type { ChannelAdapter } from './index.ts';

/**
 * A pretend phone network, so the whole product works without a Meta account.
 * It follows the same rules as the real channel, including the 24-hour window.
 * Status callbacks are wired in at startup to avoid a circular import.
 */
let onStatus: (externalId: string, status: 'delivered' | 'read') => void = () => {};
export const setSimulatorStatusHandler = (fn: typeof onStatus) => { onStatus = fn; };

export let simulatorDelays = { delivered: 700, read: 2200 };
export const setSimulatorDelays = (d: typeof simulatorDelays) => { simulatorDelays = d; };

export const simulator: ChannelAdapter = {
  async send() {
    const externalId = `sim_${randomUUID()}`;
    setTimeout(() => onStatus(externalId, 'delivered'), simulatorDelays.delivered).unref();
    setTimeout(() => onStatus(externalId, 'read'), simulatorDelays.read).unref();
    return { externalId };
  },
};
