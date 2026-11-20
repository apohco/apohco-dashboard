// Multi-row INSERT helpers. One round-trip per batch of rows instead of
// one per row: row-by-row inserts of a few thousand GL lines routinely ran
// past API Gateway's fixed ~29-second integration timeout.

function chunk(array, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error('chunk size must be a positive integer');
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Builds a single "INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4) ..."
// statement and its flattened parameter list. `valueRows` is an array of
// arrays, each holding column values in the same order as `columns`.
function buildBatchInsert(table, columns, valueRows) {
  if (!valueRows.length) throw new Error('buildBatchInsert needs at least one row');
  const params = [];
  const valueGroups = valueRows.map((row) => {
    if (row.length !== columns.length) {
      throw new Error(`Row has ${row.length} values but ${columns.length} columns were given`);
    }
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')}`;
  return { sql, params };
}

// Postgres caps a statement at 65535 bound parameters, so the batch size
// is derived from the column count rather than fixed.
function batchSizeFor(columnCount, maxParams = 65535, cap = 1000) {
  return Math.max(1, Math.min(cap, Math.floor(maxParams / columnCount)));
}

// Inserts every row using `client` (a pg client or pool), batched.
async function insertRows(client, table, columns, valueRows, suffixSql = '') {
  for (const batch of chunk(valueRows, batchSizeFor(columns.length))) {
    const { sql, params } = buildBatchInsert(table, columns, batch);
    await client.query(suffixSql ? `${sql} ${suffixSql}` : sql, params);
  }
}

module.exports = { chunk, buildBatchInsert, batchSizeFor, insertRows };
