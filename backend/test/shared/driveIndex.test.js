jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueDriveIndex: jest.fn() }));

const { query } = require('../../src/shared/db');
const { enqueueDriveIndex } = require('../../src/shared/ctrlQueue');
const idx = require('../../src/shared/driveIndex');
const worker = require('../../src/functions/controller/ctrlDriveIndexWorker');
const { sqlRouter } = require('../helpers');

const RUN = { indexrunid: 'r1', groupid: 'g1', sourceid: 's1', status: 'Scanning', sourcekey: 'fld1', actas: 'info@apohco.com', enabled: true };
const file = (id, over = {}) => ({ id, name: `${id}.pdf`, mimeType: 'application/pdf', modifiedTime: '2026-10-01T00:00:00Z', size: '100', owners: [{ emailAddress: 'amy@apohco.com' }], webViewLink: `https://d/${id}`, path: '2026', ...over });
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

function setup({ run = RUN, known = [], bump = { done: false, status: 'Indexing' } } = {}) {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlDriveIndexRuns r JOIN CtrlGoogleSources s/, { rows: run ? [run] : [] }],
      [/SELECT FileId, Version FROM CtrlDriveFiles/, { rows: known }],
      [/UPDATE CtrlDriveIndexRuns SET FilesIndexed/, { rows: [bump] }],
      [/UPDATE CtrlDriveIndexRuns SET Status = \$2/, { rows: [{ sourceid: 's1' }] }],
      [/SELECT IndexRunId FROM CtrlDriveIndexRuns WHERE SourceId/, { rows: [] }],
      [/INSERT INTO CtrlDriveIndexRuns/, { rows: [{ indexrunid: 'r-new' }] }],
      [/FROM CtrlGoogleSources WHERE Kind = 'Folder' AND Enabled/, { rows: [{ sourceid: 's1', groupid: 'g1' }, { sourceid: 's2', groupid: 'g1' }] }],
    ])
  );
  enqueueDriveIndex.mockResolvedValue([]);
}

describe('scanFolder', () => {
  test('queues new and changed files (5 per message), drops removed ones, skips unchanged and non-documents', async () => {
    const files = [file('a'), file('b', { modifiedTime: '2026-10-05T00:00:00Z' }), file('c'), file('d'), file('e'), file('f'), file('pic', { mimeType: 'image/heic' })];
    setup({ known: [{ fileid: 'a', version: '2026-10-01T00:00:00Z|100' }, { fileid: 'b', version: 'old' }, { fileid: 'gone', version: 'x' }] });
    const api = { driveWalkFolder: jest.fn().mockResolvedValue({ files, folders: 2, truncated: false }) };
    const out = await idx.scanFolder('r1', { api });
    expect(api.driveWalkFolder).toHaveBeenCalledWith('info@apohco.com', 'fld1');
    expect(out).toEqual({ indexRunId: 'r1', seen: 6, changed: 5, removed: 1, messages: 1 });
    expect(sqlCalls(/DELETE FROM CtrlDriveFiles/)[0][1]).toEqual(['s1', ['gone']]);
    const [bodies] = enqueueDriveIndex.mock.calls[0];
    expect(bodies[0].files.map((f) => f.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(bodies[0].files[0]).toEqual({ id: 'b', name: 'b.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-05T00:00:00Z', size: '100', owner: 'amy@apohco.com', webViewLink: 'https://d/b', path: '2026' });
    expect(sqlCalls(/UPDATE CtrlDriveIndexRuns SET FilesSeen/)[0][1]).toEqual(['r1', 6, 5, 1, 'Indexing', null]);
  });

  test('nothing changed: the run succeeds right away', async () => {
    setup({ known: [{ fileid: 'a', version: '2026-10-01T00:00:00Z|100' }] });
    const out = await idx.scanFolder('r1', { api: { driveWalkFolder: async () => ({ files: [file('a')], truncated: false }) } });
    expect(out.changed).toBe(0);
    expect(enqueueDriveIndex).not.toHaveBeenCalled();
    expect(sqlCalls(/UPDATE CtrlDriveIndexRuns SET Status = \$2/)[0][1].slice(0, 2)).toEqual(['r1', 'Succeeded']);
  });

  test('a folder switched off, or Google refusing, fails the run with the reason', async () => {
    setup({ run: { ...RUN, enabled: false } });
    expect((await idx.scanFolder('r1', { api: {} })).skipped).toBe('disabled');
    setup();
    const out = await idx.scanFolder('r1', { api: { driveWalkFolder: jest.fn().mockRejectedValue(new Error('Google 404: File not found')) } });
    expect(out.error).toBe('Google 404: File not found');
    const upd = sqlCalls(/UPDATE CtrlGoogleSources SET LastIndexedAt/).pop()[1];
    expect(upd).toEqual(['s1', 'Google 404: File not found']);
  });
});

describe('indexFiles', () => {
  test('reads each file, stores text, amounts and dates; finishes the run when done', async () => {
    setup({ run: { ...RUN, status: 'Indexing' }, bump: { done: true, status: 'Indexing' } });
    const api = { driveDownload: jest.fn(async () => Buffer.from('pdf')), driveExport: jest.fn(async () => Buffer.from('Doc text 10.00')) };
    const extract = jest.fn(async ({ mimeType }) => ({ text: mimeType === 'text/plain' ? 'Doc text 10.00' : 'Invoice dated 10/02/2026 total 1,250.00', method: mimeType === 'text/plain' ? 'text' : 'ocr', ocrPages: mimeType === 'text/plain' ? 0 : 2, error: null }));
    const out = await idx.indexFiles('r1', [
      { id: 'a', name: 'INV 4471.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-02T00:00:00Z', size: '100', owner: 'amy@apohco.com', path: '2026' },
      { id: 'g', name: 'Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-02T00:00:00Z' },
    ], { api, extract });
    expect(out).toEqual({ indexRunId: 'r1', indexed: 2, failed: 0, ocrPages: 2 });
    expect(api.driveExport).toHaveBeenCalledWith('info@apohco.com', 'g', 'text/plain');
    const [a, g] = sqlCalls(/INSERT INTO CtrlDriveFiles/).map((c) => c[1]);
    expect(a.slice(0, 11)).toEqual(['g1', 's1', 'a', 'INV 4471.pdf', 'application/pdf', '2026', 'amy@apohco.com', '2026-10-02T00:00:00Z', 100, null, '2026-10-02T00:00:00Z|100']);
    expect(a.slice(12, 15)).toEqual([[1250], ['2026-10-02'], 'ocr']);
    expect(g[14]).toBe('gdoc');
    expect(sqlCalls(/UPDATE CtrlDriveIndexRuns SET FilesIndexed/)[0][1]).toEqual(['r1', 2, 0, 2]);
    expect(sqlCalls(/UPDATE CtrlDriveIndexRuns SET Status = \$2/)[0][1].slice(0, 2)).toEqual(['r1', 'Succeeded']);
  });

  test('an unreadable or too-large file is stored by name (so it is not retried every night) and counted as failed', async () => {
    setup({ run: { ...RUN, status: 'Indexing' } });
    const api = { driveDownload: jest.fn() };
    const out = await idx.indexFiles('r1', [{ id: 'big', name: 'huge.pdf', mimeType: 'application/pdf', size: String(30 * 1024 * 1024) }], { api, extract: jest.fn() });
    expect(out.failed).toBe(1);
    expect(api.driveDownload).not.toHaveBeenCalled();
    const row = sqlCalls(/INSERT INTO CtrlDriveFiles/)[0][1];
    expect(row[14]).toBe('none');
    expect(row[15]).toMatch(/Larger than 25 MB/);
  });
});

test('startFolderIndex queues a scan, but not twice', async () => {
  setup();
  expect(await idx.startFolderIndex('g1', 's1')).toEqual({ indexRunId: 'r-new', alreadyRunning: false });
  expect(enqueueDriveIndex).toHaveBeenCalledWith([{ type: 'scan', indexRunId: 'r-new' }]);
  query.mockImplementation(sqlRouter([[/SELECT IndexRunId FROM CtrlDriveIndexRuns WHERE SourceId/, { rows: [{ indexrunid: 'r-old' }] }]]));
  expect(await idx.startFolderIndex('g1', 's1')).toEqual({ indexRunId: 'r-old', alreadyRunning: true });
});

test('worker: nightly schedule starts every enabled folder; queue messages are routed', async () => {
  setup();
  expect(await worker.handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' })).toEqual({ folders: 2, started: 2 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  setup({ run: null });
  const out = await worker.handler({ Records: [{ body: JSON.stringify({ type: 'scan', indexRunId: 'r1' }) }, { body: JSON.stringify({ type: 'files', indexRunId: 'r1', files: [] }) }, { body: 'x' }] });
  expect(out.results).toEqual([{ indexRunId: 'r1', skipped: 'not scanning' }, { indexRunId: 'r1', skipped: 'not indexing' }]);
});
