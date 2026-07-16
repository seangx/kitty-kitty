/**
 * Serializes asynchronous work per key while allowing different keys to run
 * concurrently. A rejected task never poisons the queue behind it.
 */
export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(() => undefined, () => undefined)

    this.tails.set(key, tail)
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })

    return result
  }
}

export type DedupedTaskResult<T> =
  | { kind: 'already-present' }
  | { kind: 'ran'; value: T }

/**
 * Re-checks dedupe state only after the task reaches the head of its keyed
 * queue. This closes the race where another producer lands the same content
 * while the task is waiting.
 */
export function runSerializedWithDedupe<T>(
  queue: KeyedTaskQueue,
  key: string,
  alreadyPresent: () => boolean,
  task: () => Promise<T>,
): Promise<DedupedTaskResult<T>> {
  return queue.run(key, async () => {
    if (alreadyPresent()) return { kind: 'already-present' }
    return { kind: 'ran', value: await task() }
  })
}
