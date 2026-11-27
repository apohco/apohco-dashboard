jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/googleApi', () => ({ ...jest.requireActual('../../src/shared/googleApi'), gmailGetMessage: jest.fn() }));
jest.mock('../../src/shared/ctrlEvidence', () => ({ ...jest.requireActual('../../src/shared/ctrlEvidence'), searchLines: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueEvidenceSave: jest.fn() }));
jest.mock('../../src/shared/evidenceSave', () => ({
  ...jest.requireActual('../../src/shared/evidenceSave'),
  processSave: jest.fn(),
  downloadUrl: jest.fn(),
}));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const google = require('../../src/shared/googleApi');
const { searchLines } = require('../../src/shared/ctrlEvidence');
const { enqueueEvidenceSave } = require('../../src/shared/ctrlQueue');
const { processSave, downloadUrl } = require('../../src/shared/evidenceSave');
const { handler } = require('../../src/functions/controller/ctrlEvidence');
const worker = require('../../src/functions/controller/ctrlEvidenceWorker');
const { CONTROLLER_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LINE_ID = '11111111-1111-1111-1111-111111111111';
const CAND_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const SAVED_ID = '44444444-4444-4444-4444-444444444444';
const FOLDER_SRC = '55555555-5555-5555-5555-555555555555';
const b64 = (s) => Buffer.from(s).toString('base64url');

const runLine = { lineid: LINE_ID, fingerprint: 'f1', txndate: '2026-10-03', amount: '-1250', payeename: 'Minuteman', currententityid: 'ent-mil', suggestedentityid: 'ent-leb', decisionentityid: null, counterpartyentityid: null };
const candidate = (over = {}) => ({ candidateid: CAND_ID, qboid: 'q1', fingerprint: 'f1', source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1', title: 'Invoice 4471', entityhintid: null, ...over });
const mailboxOn = [/FROM CtrlGoogleSources WHERE GroupId = \$1 AND Kind = \$2/, (sql, p) => ({ rows: p[1] === 'Mailbox' ? [{ kind: 'Mailbox', sourcekey: 'info@apohco.com', enabled: true }] : [{ sourceid: FOLDER_SRC, kind: 'Folder', sourcekey: 'fld', enabled: true }] })];

function setup(routes = []) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [{ runid: RUN_ID, qboid: 'q1', month: '2026-10' }] }],
      [/FROM CtrlSuggestions s JOIN CtrlLedgerLines l/, { rows: [runLine] }],
      [/FROM CtrlEvidenceCandidates c\s+LEFT JOIN CtrlEvidenceSaved/, { rows: [{ candidateid: CAND_ID, source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1', score: '1', signals: {} }] }],
      [/FROM CtrlEvidenceSearches/, { rows: [] }],
      [/FROM CtrlEvidenceSaved WHERE GroupId = \$1 AND QBOId/, { rows: [] }],
    ])
  );
  enqueueEvidenceSave.mockResolvedValue([]);
}
const get = (resource, q, path) => handler(apiEvent({ method: 'GET', resource, query: { groupId: 'g1', ...q }, path }));
const post = (resource, body, path) => handler(apiEvent({ method: 'POST', resource, body: { groupId: 'g1', ...body }, path }));
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

test("GET: a line's candidates and saved support", async () => {
  setup();
  const data = parseBody(await get('/api/controller/evidence', { runId: RUN_ID, lineId: LINE_ID }));
  expect(data.candidates).toHaveLength(1);
  expect(data.saved).toEqual([]);
  expect(data.lastSearch).toBeNull();
});

test('Find Evidence searches the line now and returns its candidates', async () => {
  setup();
  searchLines.mockResolvedValue({ searched: 1, found: 1, sources: 2, errors: [] });
  const res = await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID });
  expect(res.statusCode).toBe(200);
  expect(searchLines.mock.calls[0][0]).toMatchObject({ groupId: 'g1', qboId: 'q1', via: 'FindEvidence', lines: [{ lineId: LINE_ID, fingerprint: 'f1', amount: -1250 }] });
});

test('Find Evidence before the Google key is stored: a clear 409', async () => {
  setup();
  searchLines.mockRejectedValue(Object.assign(new Error('The Google service account key has not been stored yet'), { code: 'GOOGLE_NOT_CONFIGURED' }));
  expect((await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID })).statusCode).toBe(409);
});

test('a line outside the run is not found', async () => {
  setup([[/FROM CtrlSuggestions s JOIN CtrlLedgerLines l/, { rows: [] }]]);
  expect((await post('/api/controller/evidence/find', { runId: RUN_ID, lineId: LINE_ID })).statusCode).toBe(404);
});

describe('preview', () => {
  const cand = (over) => [/FROM CtrlEvidenceCandidates WHERE CandidateId/, { rows: [candidate(over)] }];

  test('an email is fetched on demand (plain text) and audited', async () => {
    setup([cand(), mailboxOn]);
    google.gmailGetMessage.mockResolvedValue({
      id: 'm1', internalDate: String(Date.parse('2026-10-02T12:00:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Invoice' }, { name: 'From', value: 'ar@mm.com' }],
        mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/html', body: { data: b64('<b>Total</b> $1,250.00') } }, { filename: 'INV.pdf', mimeType: 'application/pdf', body: { size: 10, attachmentId: 'a' } }],
      },
    });
    const data = parseBody(await get('/api/controller/evidence/{candidateId}/preview', {}, { candidateId: CAND_ID }));
    expect(data).toMatchObject({ source: 'Gmail', subject: 'Invoice', text: 'Total $1,250.00', attachments: [{ name: 'INV.pdf', mimeType: 'application/pdf', size: 10 }] });
    expect(sqlCalls(/INSERT INTO CtrlAuditLog/).some(([, p]) => p[2] === 'ctrl.evidence.preview')).toBe(true);
  });

  test('a folder file shows its indexed text and link (no Google call)', async () => {
    setup([
      cand({ source: 'Drive', sourceaccount: FOLDER_SRC, externalid: 'file1' }),
      mailboxOn,
      [/FROM CtrlDriveFiles f JOIN CtrlGoogleSources s/, { rows: [{ name: 'INV-4471.pdf', owneremail: 'amy@apohco.com', path: '2026', webviewlink: 'https://drive/x', text: 'Total 1,250.00', extract: 'pdf', displayname: 'Invoices' }] }],
    ]);
    const data = parseBody(await get('/api/controller/evidence/{candidateId}/preview', {}, { candidateId: CAND_ID }));
    expect(data).toMatchObject({ source: 'Drive', subject: 'INV-4471.pdf', folder: 'Invoices / 2026', link: 'https://drive/x', text: 'Total 1,250.00', readBy: 'pdf' });
    expect(google.gmailGetMessage).not.toHaveBeenCalled();
  });

  test('a source switched off since is not read', async () => {
    setup([cand(), [/FROM CtrlGoogleSources WHERE GroupId = \$1 AND Kind = \$2/, { rows: [] }]]);
    expect((await get('/api/controller/evidence/{candidateId}/preview', {}, { candidateId: CAND_ID })).statusCode).toBe(403);
    expect(google.gmailGetMessage).not.toHaveBeenCalled();
  });
});

describe('Save as support', () => {
  const cand = (over) => [/FROM CtrlEvidenceCandidates WHERE CandidateId/, { rows: [candidate(over)] }];

  test('confirm queues the save, filed under the best-known practice', async () => {
    setup([cand({ entityhintid: 'ent-hint' }), mailboxOn, [/INSERT INTO CtrlEvidenceSaved/, { rows: [{ savedid: SAVED_ID, status: 'Saving' }] }]]);
    const res = await post('/api/controller/evidence/{candidateId}/confirm', { runId: RUN_ID, lineId: LINE_ID }, { candidateId: CAND_ID });
    expect(res.statusCode).toBe(202);
    expect(parseBody(res)).toEqual({ savedId: SAVED_ID, status: 'Saving' });
    const insert = sqlCalls(/INSERT INTO CtrlEvidenceSaved/)[0][1];
    // No decision yet: the evidence's own hint comes before the engine's suggestion.
    expect(insert).toEqual(['g1', 'q1', 'f1', LINE_ID, 'Gmail', 'info@apohco.com', 'm1', 'Invoice 4471', 'ent-hint', 'user-paul']);
    expect(enqueueEvidenceSave).toHaveBeenCalledWith(SAVED_ID);
    expect(sqlCalls(/INSERT INTO CtrlAuditLog/).some(([, p]) => p[2] === 'ctrl.evidence.confirm')).toBe(true);
  });

  test('already saved: returned as is, nothing queued', async () => {
    setup([
      cand(), mailboxOn,
      [/INSERT INTO CtrlEvidenceSaved/, { rows: [] }],
      [/SELECT SavedId, Status FROM CtrlEvidenceSaved WHERE QBOId/, { rows: [{ savedid: SAVED_ID, status: 'Saved' }] }],
    ]);
    const res = await post('/api/controller/evidence/{candidateId}/confirm', { runId: RUN_ID, lineId: LINE_ID }, { candidateId: CAND_ID });
    expect(parseBody(res)).toEqual({ savedId: SAVED_ID, status: 'Saved', alreadySaved: true });
    expect(enqueueEvidenceSave).not.toHaveBeenCalled();
  });

  test('evidence of another line is refused', async () => {
    setup([cand({ fingerprint: 'other' }), mailboxOn]);
    expect((await post('/api/controller/evidence/{candidateId}/confirm', { runId: RUN_ID, lineId: LINE_ID }, { candidateId: CAND_ID })).statusCode).toBe(409);
  });

  test('download: a short-lived link for saved support only; audited', async () => {
    setup([[/SELECT S3Key, FileName, Status FROM CtrlEvidenceSaved/, { rows: [{ s3key: 'k/a.pdf', filename: 'a.pdf', status: 'Saved' }] }]]);
    downloadUrl.mockResolvedValue('https://s3/signed');
    const data = parseBody(await get('/api/controller/evidence/saved/{savedId}/download', {}, { savedId: SAVED_ID }));
    expect(data).toEqual({ url: 'https://s3/signed', fileName: 'a.pdf', expiresInSeconds: 300 });
    expect(sqlCalls(/INSERT INTO CtrlAuditLog/).some(([, p]) => p[2] === 'ctrl.evidence.download')).toBe(true);
    setup([[/SELECT S3Key, FileName, Status FROM CtrlEvidenceSaved/, { rows: [{ s3key: null, filename: null, status: 'Saving' }] }]]);
    expect((await get('/api/controller/evidence/saved/{savedId}/download', {}, { savedId: SAVED_ID })).statusCode).toBe(409);
  });
});

test('job progress', async () => {
  setup([
    [/FROM CtrlEvidenceJobs WHERE JobId/, { rows: [{ jobid: JOB_ID, runid: RUN_ID, linecount: 25 }] }],
    [/GROUP BY 1/, { rows: [{ status: 'Succeeded', n: 2 }, { status: 'Running', n: 1 }] }],
    [/SELECT DISTINCT Error/, { rows: [] }],
  ]);
  expect(parseBody(await get('/api/controller/evidence/jobs/{jobId}', {}, { jobId: JOB_ID }))).toMatchObject({ lineCount: 25, batchCount: 3, finished: false });
});

describe('evidence worker', () => {
  const claim = (over = {}) => [/UPDATE CtrlEvidenceBatches b SET Status = 'Running'/, { rows: [{ batchid: 'b1', groupid: 'g1', lineids: [LINE_ID], attempts: 1, createdby: 'user-paul', qboid: 'q1', ...over }] }];
  const lines = [/FROM CtrlLedgerLines WHERE LineId = ANY/, { rows: [{ lineid: LINE_ID, fingerprint: 'f1', txndate: '2026-10-03', amount: '10', payeename: 'X' }] }];
  const finish = () => sqlCalls(/UPDATE CtrlEvidenceBatches SET Status = \$2/).map((c) => c[1]);

  test('Search All: searches the batch lines and finishes the batch', async () => {
    setup([claim(), lines]);
    searchLines.mockResolvedValue({ searched: 1, found: 0, sources: 1, errors: [] });
    expect(await worker.processBatch('b1')).toMatchObject({ status: 'Succeeded' });
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

  test('routes { saveId } to Save as support and { batchId } to Search All', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setup([[/UPDATE CtrlEvidenceBatches b SET Status = 'Running'/, { rows: [] }]]);
    processSave.mockResolvedValue({ saveId: SAVED_ID, status: 'Saved' });
    const out = await worker.handler({ Records: [{ body: JSON.stringify({ saveId: SAVED_ID }) }, { body: JSON.stringify({ batchId: 'b1' }) }, { body: '{}' }] });
    expect(processSave).toHaveBeenCalledWith(SAVED_ID);
    expect(out.results).toEqual([{ saveId: SAVED_ID, status: 'Saved' }, { batchId: 'b1', status: 'Skipped (nothing to do)' }]);
  });
});
