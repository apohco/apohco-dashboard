const { chunk, buildBatchInsert, batchSizeFor, insertRows } = require('../../src/shared/bulkInsert');

describe('chunk', () => {
  test('splits into fixed-size pieces with a remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  test('rejects a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('buildBatchInsert', () => {
  test('numbers placeholders across rows and flattens params in order', () => {
    const { sql, params } = buildBatchInsert('T', ['A', 'B'], [[1, 'x'], [2, null]]);
    expect(sql).toBe('INSERT INTO T (A, B) VALUES ($1, $2), ($3, $4)');
    expect(params).toEqual([1, 'x', 2, null]);
  });

  test('rejects rows whose width does not match the columns', () => {
    expect(() => buildBatchInsert('T', ['A', 'B'], [[1]])).toThrow('1 values but 2 columns');
  });

  test('rejects an empty batch', () => {
    expect(() => buildBatchInsert('T', ['A'], [])).toThrow();
  });
});

describe('batchSizeFor', () => {
  test('stays under the Postgres 65535-parameter limit', () => {
    expect(batchSizeFor(19) * 19).toBeLessThanOrEqual(65535);
    expect(batchSizeFor(2)).toBe(1000); // capped
    expect(batchSizeFor(100000)).toBe(1);
  });
});

describe('insertRows', () => {
  test('issues one statement per batch and appends the suffix', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    const rows = Array.from({ length: 2500 }, (_, i) => [i, `v${i}`]);
    await insertRows(client, 'T', ['A', 'B'], rows, 'ON CONFLICT DO NOTHING');
    expect(client.query).toHaveBeenCalledTimes(3);
    const [sql, params] = client.query.mock.calls[2];
    expect(sql.endsWith('ON CONFLICT DO NOTHING')).toBe(true);
    expect(params).toHaveLength(1000); // last 500 rows x 2 columns
  });
});
