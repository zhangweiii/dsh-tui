/**
 * Minimal stand-in for the `ws` client the Web Host carrier opens: the tests
 * mock the `ws` module with this class so the Gateway mux protocol can be driven
 * without a socket.
 *
 * @module tests/fake-ws
 */

type Listener = (...args: unknown[]) => void

/** Fake `ws` WebSocket with the emitter surface the carrier uses. */
export class FakeSocket {
  /** Every socket this module created, in construction order. */
  static readonly instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  /** Headers the carrier passed to the handshake. */
  readonly options: { headers?: Record<string, string> } | undefined
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string, options?: { headers?: Record<string, string> }) {
    this.options = options
    FakeSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN
      this.emit('open')
    }, 0)
  }

  on(type: string, listener: Listener): this {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
    return this
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.emit('close')
  }

  /** Deliver one host→client frame. */
  receive(frame: unknown): void {
    this.emit('message', JSON.stringify(frame))
  }

  /** Last client→host message, parsed. */
  last(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? '{}') as Record<string, unknown>
  }

  private emit(type: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(...args)
  }
}
