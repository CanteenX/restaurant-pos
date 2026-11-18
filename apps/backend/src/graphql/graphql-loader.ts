// Per-request batch loader (the DataLoader pattern, without the dependency):
// every load() made while one level of the query resolves is collected and
// fetched with ONE query, so `orders { nodes { items … customer … } }` costs
// a query per field, not per row. Values are cached for the request only;
// create a new loader per request so no data crosses tenants.
export class BatchLoader<K, V> {
  private readonly cache = new Map<K, Promise<V | undefined>>();
  private queue: {
    key: K;
    resolve: (v: V | undefined) => void;
    reject: (e: unknown) => void;
  }[] = [];

  constructor(
    private readonly batch: (keys: readonly K[]) => Promise<Map<K, V>>,
  ) {}

  load(key: K): Promise<V | undefined> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const promise = new Promise<V | undefined>((resolve, reject) => {
      if (this.queue.length === 0) this.schedule();
      this.queue.push({ key, resolve, reject });
    });
    this.cache.set(key, promise);
    return promise;
  }

  // After the current promise jobs settle, like DataLoader: sibling list
  // items resolve in the same job queue, so they all land in one batch.
  private schedule() {
    void Promise.resolve().then(() => process.nextTick(() => this.dispatch()));
  }

  private dispatch() {
    const queue = this.queue;
    this.queue = [];
    this.batch(queue.map((q) => q.key)).then(
      (values) => queue.forEach((q) => q.resolve(values.get(q.key))),
      (error) => queue.forEach((q) => q.reject(error)),
    );
  }
}
