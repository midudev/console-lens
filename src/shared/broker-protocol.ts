/**
 * Protocol for the broker's *subscriber* channel — the link between the shared
 * broker process and each editor window / CLI viewer.
 *
 * Agents and browsers keep talking to the broker over the existing wire protocol
 * (TCP `port`, WebSocket `port + 1`). Editor windows instead connect to the
 * broker on `port + 2` and receive a fanned-out copy of every event, so any
 * number of windows can watch the same runtime at once.
 */
import type { ErrorMessage, LogMessage, NetworkMessage } from './protocol';

/** Subscriber control channel: TCP `port + 2` (agents use +0, browser WS +1). */
export const subPortFor = (tcpPort: number): number => tcpPort + 2;

/** One buffered message, replayed to a freshly-connected subscriber. */
export type SnapshotItem =
  | { type: 'log'; m: LogMessage }
  | { type: 'error'; m: ErrorMessage }
  | { type: 'network'; m: NetworkMessage };

/**
 * Newline-delimited JSON envelopes.
 * Broker → subscriber: every variant. Subscriber → broker: only `clear`
 * (a "Clear All" from one window clears every window).
 */
export type BrokerEnvelope =
  | { t: 'hello'; tcpPort: number; wsPort: number; pid: number }
  | { t: 'log'; m: LogMessage }
  | { t: 'error'; m: ErrorMessage }
  | { t: 'network'; m: NetworkMessage }
  | { t: 'snapshot'; items: SnapshotItem[] }
  | { t: 'newRun' }
  | { t: 'clear' };

export function isBrokerEnvelope(value: unknown): value is BrokerEnvelope {
  return !!value && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string';
}
