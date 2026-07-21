export class KeyedSingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined
    if (existing) return existing

    const operation = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
      })
    this.inFlight.set(key, operation)
    return operation
  }

  has(key: string): boolean {
    return this.inFlight.has(key)
  }
}
