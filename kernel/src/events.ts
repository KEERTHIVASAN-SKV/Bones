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
 * - Callbacks are executed in the order they were registered
 * - Callbacks cannot throw (errors are swallowed to prevent cascade failures)
 */

type EventType = 'sequenceChanged' | 'membershipChanged' | 'gcEvent';
type EventCallback = () => void;

/**
 * Simple event emitter.
 *
 * Example usage:
 * ```typescript
 * const emitter = new EventEmitter();
 * emitter.on('sequenceChanged', () => console.log('changed'));
 * emitter.emit('sequenceChanged');
 * ```
 */
export class EventEmitter {
  private listeners: Map<EventType, Set<EventCallback>> = new Map();

  /**
   * Register a listener for an event.
   *
   * The same callback can be registered multiple times; it will be called multiple times.
   *
   * @param event - Event type
   * @param callback - Function to call when event fires
   */
  on(event: EventType, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  /**
   * Remove a listener.
   *
   * Removes the callback from the listener set. If the same callback was registered
   * multiple times, only one registration is removed (at the Set level, duplicates
   * are impossible).
   *
   * @param event - Event type
   * @param callback - Function to unregister
   */
  off(event: EventType, callback: EventCallback): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
    }
  }

  /**
   * Emit an event, calling all registered listeners in insertion order.
   *
   * Errors in callbacks are caught and swallowed (logged to console in debug mode).
   * This prevents a single callback from preventing others from running.
   *
   * @param event - Event type to emit
   */
  emit(event: EventType): void {
    const set = this.listeners.get(event);
    if (!set) return;

    // Convert to array to avoid issues if callbacks modify the listener set
    const callbacks = Array.from(set);
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        // Swallow errors to prevent cascade failures
        if (typeof console !== 'undefined' && console.error) {
          console.error(`EventEmitter: callback for '${event}' threw:`, error);
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
   * Clear all listeners.
   *
   * Useful for cleanup or testing.
   */
  clear(): void {
    this.listeners.clear();
  }
}
