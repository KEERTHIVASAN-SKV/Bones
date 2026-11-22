/**
 * Simple, deterministic event emitter for the CRDT Kernel.
 *
 * Used to notify subscribers of state changes:
 * - sequenceChanged: sequence was modified
 * - membershipChanged: membership was modified
 * - gcEvent: garbage collection occurred
 *
 * Rules:
 * - No randomization in callback order
 * - Callbacks are executed in the order they were first registered
 * - A callback that throws never stops other callbacks and never propagates out of
 *   `emit`; the error is passed to the optional `onError` handler instead
 * - No console / DOM / global access (kernel purity): error reporting is the caller's choice
 */

/** Names of the events the kernel can emit. */
export type EventType = 'sequenceChanged' | 'membershipChanged' | 'gcEvent';

/** A listener callback. */
export type EventCallback = () => void;

/** Receives errors thrown by listener callbacks. */
export type EventErrorHandler = (event: EventType, error: unknown) => void;

/**
 * Simple event emitter.
 *
 * Example usage:
 * ```typescript
 * const emitter = new EventEmitter();
 * emitter.on('sequenceChanged', () => refreshUi());
 * emitter.emit('sequenceChanged');
 * ```
 */
export class EventEmitter {
  private readonly listeners: Map<EventType, Set<EventCallback>> = new Map();
  private readonly onError: EventErrorHandler | undefined;

  /**
   * @param onError - Optional handler called with (event, error) when a listener throws.
   *   If omitted, listener errors are swallowed.
   */
  constructor(onError?: EventErrorHandler) {
    this.onError = onError;
  }

  /**
   * Register a listener for an event.
   *
   * Listeners are stored in a Set: registering the same callback reference for the same
   * event more than once has no effect (it is called once per emit). Callbacks run in
   * the order they were first registered.
   *
   * @param event - Event type
   * @param callback - Function to call when the event fires
   */
  on(event: EventType, callback: EventCallback): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  /**
   * Remove a listener. Does nothing if the callback was not registered.
   *
   * @param event - Event type
   * @param callback - Function to unregister
   */
  off(event: EventType, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event, calling all registered listeners in registration order.
   *
   * Listeners added or removed during emission do not affect the current emission
   * (it iterates over a copy).
   *
   * @param event - Event type to emit
   */
  emit(event: EventType): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;

    for (const callback of Array.from(set)) {
      try {
        callback();
      } catch (error) {
        if (this.onError !== undefined) {
          try {
            this.onError(event, error);
          } catch {
            // The error handler itself failed; nothing more can safely be done.
          }
        }
      }
    }
  }

  /**
   * Check if there are any listeners for an event.
   *
   * @param event - Event type
   * @returns true if at least one callback is registered
   */
  hasListeners(event: EventType): boolean {
    const set = this.listeners.get(event);
    return set !== undefined && set.size > 0;
  }

  /**
   * Remove all listeners for all events. Useful for cleanup and tests.
   */
  clear(): void {
    this.listeners.clear();
  }
}
