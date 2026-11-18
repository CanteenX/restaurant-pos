import { BatchLoader } from './graphql-loader';

describe('BatchLoader', () => {
  it('batches every load in the same tick into one call, deduplicated', async () => {
    const batch = jest.fn((keys: readonly string[]) =>
      Promise.resolve(new Map(keys.map((k) => [k, k.toUpperCase()]))),
    );
    const loader = new BatchLoader(batch);
    const values = await Promise.all(
      ['a', 'b', 'a', 'c'].map((k) => loader.load(k)),
    );
    expect(values).toEqual(['A', 'B', 'A', 'C']);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('batches loads made after a parent promise resolves (resolver chains)', async () => {
    const batch = jest.fn((keys: readonly number[]) =>
      Promise.resolve(new Map(keys.map((k) => [k, k * 2]))),
    );
    const loader = new BatchLoader(batch);
    const parents = await Promise.resolve([1, 2, 3]);
    const values = await Promise.all(parents.map((p) => loader.load(p)));
    expect(values).toEqual([2, 4, 6]);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('caches per request: a second load of a key does not refetch', async () => {
    const batch = jest.fn((keys: readonly string[]) =>
      Promise.resolve(new Map(keys.map((k) => [k, 1]))),
    );
    const loader = new BatchLoader(batch);
    await loader.load('a');
    await loader.load('a');
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('resolves a missing key to undefined', async () => {
    const loader = new BatchLoader(() => Promise.resolve(new Map()));
    await expect(loader.load('x')).resolves.toBeUndefined();
  });

  it('rejects every waiting load when the batch fails', async () => {
    const loader = new BatchLoader<string, number>(() =>
      Promise.reject(new Error('db down')),
    );
    await expect(
      Promise.all([loader.load('a'), loader.load('b')]),
    ).rejects.toThrow('db down');
  });
});
