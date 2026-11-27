// Phase 4a additions to ctrlReview: evidence summary per line, the evidence
// filter, and "Search All".
jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlAiJobs', () => ({ startReviewAiJob: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueEvidenceBatches: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { enqueueEvidenceBatches } = require('../../src/shared/ctrlQueue');
const { handler, parseFilters, buildFilterSql } = require('../../src/functions/controller/ctrlReview');
const { CONTROLLER_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const id = (n) => `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`;
const RUN_ROW = { runid: RUN_ID, qboid: 'qbo-mgmt', month: '2026-10', threshold: '0.900', mediumthreshold: '0.700' };

let client;
let batchSeq;
function setup(routes = []) {
  batchSeq = 0;
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/FROM CtrlReviewSettings/, { rows: [] }],
      [/FROM CtrlEntities e/, { rows: [] }],
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [RUN_ROW] }],
      [/FROM CtrlGoogleSources/, { rows: [{ '?column?': 1 }] }],
    ])
  );
  client = {
    query: sqlRouter([
      [/INSERT INTO CtrlEvidenceJobs/, { rows: [{ jobid: 'job-1' }] }],
      [/INSERT INTO CtrlEvidenceBatches/, () => ({ rows: [{ batchid: `b${(batchSeq += 1)}` }] })],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
  enqueueEvidenceBatches.mockResolvedValue([]);
}
const post = (body) => handler(apiEvent({ method: 'POST', resource: '/api/controller/review/evidence-search', body: { groupId: 'group-1', runId: RUN_ID, ...body } }));

test('lines carry an evidence summary', async () => {
  setup([
    [/GROUP BY s.Status/, { rows: [] }],
    [/SELECT COUNT\(\*\)::int AS n, COALESCE/, { rows: [{ n: 1, amount: '1' }] }],
    [/ORDER BY CASE s.Status/, { rows: [{ lineid: id(1), confidence: '0.5', status: 'NeedsEvidence', reasons: [], amount: '1', debit: '1', credit: '0', evidencecount: 2, evidencebest: '0.8500', evidencehint: 'leb', evidencesearchedat: 'now', evidencesaved: 1 }] }],
  ]);
  const res = await handler(apiEvent({ method: 'GET', resource: '/api/controller/review/lines', query: { groupId: 'group-1', runId: RUN_ID } }));
  expect(parseBody(res).lines[0].evidence).toEqual({ count: 2, best: 0.85, entityHintId: 'leb', searchedAt: 'now', saved: 1 });
});

test('the evidence filter', () => {
  expect(buildFilterSql(parseFilters({ evidence: 'found' }), 4).sql).toMatch(/ev\.n > 0/);
  expect(buildFilterSql(parseFilters({ evidence: 'none' }), 4).sql).toMatch(/es\.Fingerprint IS NOT NULL AND ev\.n = 0/);
  expect(buildFilterSql(parseFilters({ evidence: 'unsearched' }), 4).sql).toMatch(/es\.Fingerprint IS NULL/);
  expect(buildFilterSql(parseFilters({ evidence: 'saved' }), 4).sql).toMatch(/sv.saved > 0/);
  expect(() => parseFilters({ evidence: 'maybe' })).toThrow(/evidence must be/);
});

describe('Search All', () => {
  test('selected lines: one job, batches of 10, most money first, queued', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ lineid: id(i + 1), amt: String(i) }));
    setup([[/FROM CtrlSuggestions s/, { rows }]]);
    const res = await post({ lineIds: rows.map((r) => r.lineid) });
    expect(res.statusCode).toBe(202);
    expect(parseBody(res)).toEqual({ jobId: 'job-1', lineCount: 12, skipped: 0, batchCount: 2, failedToQueue: 0 });
    const batches = client.query.mock.calls.filter(([sql]) => /INSERT INTO CtrlEvidenceBatches/.test(sql)).map((c) => c[1][2]);
    expect(batches[0]).toHaveLength(10);
    expect(batches[0][0]).toBe(id(12));
    expect(enqueueEvidenceBatches).toHaveBeenCalledWith(['b1', 'b2']);
  });

  test('all matching lines (filter), capped at 300; a changed count stops it', async () => {
    const rows = Array.from({ length: 320 }, (_, i) => ({ lineid: id(i + 1), amt: '1' }));
    setup([[/FROM CtrlSuggestions s/, { rows }]]);
    expect(parseBody(await post({ filter: { evidence: 'unsearched' }, expectedCount: 320 }))).toMatchObject({ lineCount: 300, skipped: 20, batchCount: 30 });
    setup([[/FROM CtrlSuggestions s/, { rows }]]);
    expect((await post({ filter: {}, expectedCount: 5 })).statusCode).toBe(409);
  });

  test('needs an opted-in mailbox', async () => {
    setup([[/FROM CtrlGoogleSources/, { rows: [] }], [/FROM CtrlSuggestions s/, { rows: [{ lineid: id(1), amt: '1' }] }]]);
    const res = await post({ lineIds: [id(1)] });
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/No mailbox or invoice folder is switched on/);
  });

  test('batches SQS refused are marked Failed', async () => {
    setup([[/FROM CtrlSuggestions s/, { rows: [{ lineid: id(1), amt: '1' }] }]]);
    enqueueEvidenceBatches.mockResolvedValue(['b1']);
    expect(parseBody(await post({ lineIds: [id(1)] })).failedToQueue).toBe(1);
    expect(query.mock.calls.some(([sql]) => /UPDATE CtrlEvidenceBatches SET Status = 'Failed'/.test(sql))).toBe(true);
  });
});
