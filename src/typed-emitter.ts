import { EventEmitter } from 'events';

/**
 * Generic typed EventEmitter helper.
 * Provides type-safe emit/on/off/once for a known event map.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private emitter = new EventEmitter();

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    this.emitter.removeAllListeners(event);
    return this;
  }
}
