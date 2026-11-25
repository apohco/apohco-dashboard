jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/googleApi', () => ({ ...jest.requireActual('../../src/shared/googleApi'), gmailGetMessage: jest.fn() }));
jest.mock('../../src/shared/ctrlEvidence', () => ({
  ...jest.requireActual('../../src/shared/ctrlEvidence'),
  searchLines: jest.fn(),
}));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const google = require('../../src/shared/googleApi');
const { searchLines } = require('../../src/shared/ctrlEvidence');
const { handler } = require('../../src/functions/controller/ctrlEvidence');
const worker = require('../../src/functions/controller/ctrlEvidenceWorker');
const { CONTROLLER_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LINE_ID = '11111111-1111-1111-1111-111111111111';
const CAND_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const b64 = (s) => Buffer.from(s).toString('base64url');

function setup(routes = []) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [{ runid: RUN_ID, qboid: 'q1', month: '2026-10' }] }],
      [/FROM CtrlSuggestions s JOIN CtrlLedgerLines l/, { rows: [{ lineid: LINE_ID, fingerprint: 'f1', txndate: '2026-10-03', amount: '-1250', payeename: 'Minuteman' }] }],
      [/FROM CtrlEvidenceCandidates WHERE GroupId/, { rows: [{ candidateid: CAND_ID, source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1', score: '1', signals: {} }] }],
      [/FROM CtrlEvidenceSearches/, { rows: [] }],
    ])
  );
}
const get = (resource, q, path) => handler(apiEvent({ method: 'GET', resource, query: { groupId: 'g1', ...q }, path }));
const post = (resource, body) => handler(apiEvent({ method: 'POST', resource, body: { groupId: 'g1', ...body } }));

test("GET: a line's candidates", async () => {
  setup();
  const data = parseBody(await get('/api/controller/evidence', { runId: RUN_ID, lineId: LINE_ID }));
  expect(data.candidates).toHaveLength(1);
  expect(data.lastSearch).toBeNull();
});

test('Find Evidence searches the line now and returns its candidates', async () => {
  setup();
  searchLines.mockResolvedValue({ searched: 1, found: 1, sources: 1, errors: [] });
  const res = await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID });
  expect(res.statusCode).toBe(200);
  expect(searchLines).toHaveBeenCalledWith({
    groupId: 'g1', qboId: 'q1', userId: 'user-paul', via: 'FindEvidence',
    lines: [{ lineId: LINE_ID, fingerprint: 'f1', txnDate: '2026-10-03', amount: -1250, payeeName: 'Minuteman' }],
  });
  expect(parseBody(res)).toMatchObject({ found: 1, candidates: [{ candidateId: CAND_ID }] });
});

test('Find Evidence before the Google key is stored: a clear 409', async () => {
  setup();
  searchLines.mockRejectedValue(Object.assign(new Error('The Google service account key has not been stored yet'), { code: 'GOOGLE_NOT_CONFIGURED' }));
  const res = await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID });
  expect(res.statusCode).toBe(409);
  expect(parseBody(res).message).toMatch(/not been stored yet/);
});

test('a line outside the run is not found', async () => {
  setup([[/FROM CtrlSuggestions s JOIN CtrlLedgerLines l/, { rows: [] }]]);
  expect((await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID })).statusCode).toBe(404);
});

describe('preview', () => {
  const candidateRow = [/SELECT CandidateId, Source, SourceAccount, ExternalId FROM CtrlEvidenceCandidates/, { rows: [{ candidateid: CAND_ID, source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1' }] }];

  test('fetches the email on demand (plain text) and audits it', async () => {
    setup([candidateRow, [/FROM CtrlGoogleSources/, { rows: [{ kind: 'Mailbox', sourcekey: 'info@apohco.com', enabled: true }] }]]);
    google.gmailGetMessage.mockResolvedValue({
      id: 'm1', internalDate: String(Date.parse('2026-10-02T12:00:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Invoice' }, { name: 'From', value: 'ar@mm.com' }],
        mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/html', body: { data: b64('<b>Total</b> $1,250.00') } }, { filename: 'INV.pdf', mimeType: 'application/pdf', body: { size: 10, attachmentId: 'a' } }],
      },
    });
    const data = parseBody(await get('/api/controller/evidence/{candidateId}/preview', {}, { candidateId: CAND_ID }));
    expect(data).toEqual({
      candidateId: CAND_ID, mailbox: 'info@apohco.com', subject: 'Invoice', from: 'ar@mm.com', to: '', sentAt: '2026-10-02T12:00:00.000Z',
      text: 'Total $1,250.00', attachments: [{ name: 'INV.pdf', mimeType: 'application/pdf', size: 10 }],
    });
    expect(query.mock.calls.some(([sql, p]) => /INSERT INTO CtrlAuditLog/.test(sql) && p[2] === 'ctrl.evidence.preview')).toBe(true);
  });

  test('a mailbox opted out since is not read', async () => {
    setup([candidateRow, [/FROM CtrlGoogleSources/, { rows: [] }]]);
    const res = await get('/api/controller/evidence/{candidateId}/preview', {}, { candidateId: CAND_ID });
    expect(res.statusCode).toBe(403);
    expect(google.gmailGetMessage).not.toHaveBeenCalled();
  });
});

test('job progress', async () => {
  setup([
    [/FROM CtrlEvidenceJobs WHERE JobId/, { rows: [{ jobid: JOB_ID, runid: RUN_ID, linecount: 25 }] }],
    [/GROUP BY 1/, { rows: [{ status: 'Succeeded', n: 2 }, { status: 'Running', n: 1 }] }],
    [/SELECT DISTINCT Error/, { rows: [] }],
  ]);
  expect(parseBody(await get('/api/controller/evidence/jobs/{jobId}', {}, { jobId: JOB_ID }))).toMatchObject({
    lineCount: 25, batchCount: 3, finished: false, batches: { Succeeded: 2, Running: 1 },
  });
});

describe('Search All worker', () => {
  const claim = (over = {}) => [/UPDATE CtrlEvidenceBatches b SET Status = 'Running'/, { rows: [{ batchid: 'b1', groupid: 'g1', lineids: [LINE_ID], attempts: 1, createdby: 'user-paul', qboid: 'q1', ...over }] }];
  const lines = [/FROM CtrlLedgerLines WHERE LineId = ANY/, { rows: [{ lineid: LINE_ID, fingerprint: 'f1', txndate: '2026-10-03', amount: '10', payeename: 'X' }] }];
  const finish = () => query.mock.calls.filter(([sql]) => /UPDATE CtrlEvidenceBatches SET Status = \$2/.test(sql)).map((c) => c[1]);

  test('searches the batch lines and finishes the batch', async () => {
    setup([claim(), lines]);
    searchLines.mockResolvedValue({ searched: 1, found: 0, sources: 1, errors: [] });
    expect(await worker.processBatch('b1')).toMatchObject({ status: 'Succeeded' });
    expect(searchLines.mock.calls[0][0]).toMatchObject({ groupId: 'g1', qboId: 'q1', via: 'SearchAll', userId: 'user-paul' });
    expect(finish()).toEqual([['b1', 'Succeeded', null]]);
  });

  test('a transient error is retried; a missing key fails at once', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setup([claim(), lines]);
    searchLines.mockRejectedValue(new Error('Google 503'));
    await expect(worker.processBatch('b1')).rejects.toThrow('Google 503');
    setup([claim(), lines]);
    searchLines.mockRejectedValue(Object.assign(new Error('not configured'), { code: 'GOOGLE_NOT_CONFIGURED' }));
    expect((await worker.processBatch('b1')).status).toBe('Failed');
  });

  test('redelivery of a finished batch does nothing', async () => {
    setup([[/UPDATE CtrlEvidenceBatches b SET Status = 'Running'/, { rows: [] }]]);
    expect((await worker.processBatch('b1')).status).toMatch(/nothing to do/);
  });
});
