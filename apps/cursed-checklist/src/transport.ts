/**
 * A tiny wrapper over BroadcastChannel. It connects tabs of the same app in the SAME browser
 * (same origin); it does not reach other browsers or machines, and it does not replay messages
 * sent before a tab opened (sync.ts handles catch-up).
 */

/** Channel shared by every Cursed Checklist tab. */
export const CHANNEL_NAME = 'bones-checklist';

export interface Transport {
  /** Send a message to every other tab on the channel (never back to this one). */
  send(message: string): void;
  /**
   * Receive messages from other tabs. The data is whatever another tab posted, so it is
   * `unknown`: treat it as untrusted.
   *
   * @returns A function that stops this handler
   */
  onMessage(handler: (message: unknown) => void): () => void;
  /** Stop sending and receiving. */
  close(): void;
}

export function createBroadcastTransport(name: string = CHANNEL_NAME): Transport {
  const channel = new BroadcastChannel(name);
  return {
    send(message) {
      channel.postMessage(message);
    },
    onMessage(handler) {
      const listener = (event: MessageEvent): void => handler(event.data);
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close() {
      channel.close();
    },
  };
}
