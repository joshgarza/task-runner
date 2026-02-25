// Generic concurrency-limited worker pool
// Preserves input ordering via indexed assignment into a pre-sized array.

/**
 * Process items with bounded concurrency, returning results in input order.
 *
 * When concurrency <= 1, items are processed sequentially.
 * When concurrency > 1, up to `concurrency` items are processed in parallel
 * using a shared-index worker pool.
 *
 * If `fn` throws, the worker that hit the error stops — remaining items are
 * picked up by other workers. Callers that need all items processed regardless
 * of errors should catch inside `fn` and return a failure result instead of throwing.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      results[i] = await fn(items[i]);
    }
    return results;
  }

  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.allSettled(workers);

  return results;
}
