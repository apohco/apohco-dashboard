jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { PDFDocument } = require('pdf-lib');
const { query } = require('../../src/shared/db');
const save = require('../../src/shared/evidenceSave');
const { sqlRouter } = require('../helpers');

const b64 = (s) => Buffer.from(s).toString('base64url');
const SAVE = { savedid: 'sv1', groupid: 'g1', qboid: 'q1', fingerprint: 'f1', lineid: 'l1', source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1', entityid: 'ent-leb', attempts: 1, confirmedby: 'user-paul' };
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

let folderSeq;
function setup({ saveRow = SAVE, folders = {} } = {}) {
  folderSeq = 0;
  query.mockImplementation(
    sqlRouter([
      [/UPDATE CtrlEvidenceSaved s SET Attempts/, { rows: saveRow ? [saveRow] : [] }],
      [/FROM CtrlLedgerLines l\s+LEFT JOIN CtrlVendorAliases/, { rows: [{ txndate: '2026-10-03', amount: '-1250', payeename: 'Minuteman', vendorid: 'v1', vendor: 'Minuteman Press' }] }],
      [/SELECT AdminEmail, Domain/, { rows: [{ adminemail: 'info@apohco.com', domain: 'apohco.com' }] }],
      [/SELECT EntityName FROM CtrlEntities/, { rows: [{ entityname: 'Lebanon' }] }],
      [/SELECT FolderId FROM CtrlEvidenceFolders/, (sql, p) => ({ rows: folders[p[1]] ? [{ folderid: folders[p[1]] }] : [] })],
      [/INSERT INTO CtrlEvidenceFolders/, (sql, p) => {
        folders[p[1]] = p[2];
        return { rows: [] };
      }],
      [/SELECT ActAs, Enabled FROM CtrlGoogleSources/, { rows: [{ actas: 'amy@apohco.com', enabled: true }] }],
    ])
  );
}
const api = (over = {}) => ({
  gmailGetMessage: jest.fn(async () => ({
    id: 'm1', internalDate: String(Date.parse('2026-10-02T12:00:00Z')),
    payload: {
      headers: [{ name: 'Subject', value: 'Invoice 4471' }, { name: 'From', value: 'Minuteman AR <AR@MM.com>' }],
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'text/plain', body: { data: b64('Total $1,250.00') } }, { filename: 'INV.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 900 } }],
    },
  })),
  gmailGetAttachment: jest.fn(async () => {
    const d = await PDFDocument.create();
    d.addPage();
    return Buffer.from(await d.save());
  }),
  driveCreateFolder: jest.fn(async (admin, name) => ({ id: `fld-${(folderSeq += 1)}-${name}` })),
  driveUpload: jest.fn(async () => ({ id: 'drive-file-1' })),
  ...over,
});
const s3 = () => ({ send: jest.fn().mockResolvedValue({}) });

test('an email: PDF (email + attachment pages) to S3, a copy filed in Drive, the sender learned', async () => {
  setup();
  const gm = api();
  const s3Client = s3();
  const out = await save.processSave('sv1', { api: gm, s3Client, bucket: 'evidence-bucket' });
  expect(out).toEqual({ saveId: 'sv1', status: 'Saved', fileName: '2026-10-03_Minuteman-Press_1250.00.pdf', bytes: expect.any(Number), driveCopied: true });
  const put = s3Client.send.mock.calls[0][0].input;
  expect(put).toMatchObject({ Bucket: 'evidence-bucket', Key: 'g1/q1/2026-10/sv1/2026-10-03_Minuteman-Press_1250.00.pdf', ContentType: 'application/pdf', ServerSideEncryption: 'AES256' });
  expect((await PDFDocument.load(put.Body)).getPageCount()).toBe(2);
  // Folders: Controller Evidence / Lebanon / 2026-10, created once each, as the admin.
  expect(gm.driveCreateFolder.mock.calls.map((c) => [c[0], c[1]])).toEqual([
    ['info@apohco.com', 'Controller Evidence'], ['info@apohco.com', 'Lebanon'], ['info@apohco.com', '2026-10'],
  ]);
  expect(gm.driveUpload.mock.calls[0][1]).toMatchObject({ name: '2026-10-03_Minuteman-Press_1250.00.pdf', parentId: 'fld-3-2026-10', mimeType: 'application/pdf' });
  const done = sqlCalls(/UPDATE CtrlEvidenceSaved SET Status = 'Saved'/)[0][1];
  expect(done[5]).toBe('Controller Evidence / Lebanon / 2026-10 / 2026-10-03_Minuteman-Press_1250.00.pdf');
  expect(sqlCalls(/INSERT INTO CtrlVendorSenders/)[0][1]).toEqual(['g1', 'v1', 'ar@mm.com']);
  expect(sqlCalls(/INSERT INTO CtrlAuditLog/)[0][1][2]).toBe('ctrl.evidence.save');
});

test('existing evidence folders are reused', async () => {
  setup({ folders: { 'Controller Evidence': 'root', 'Controller Evidence/Lebanon': 'leb', 'Controller Evidence/Lebanon/2026-10': 'oct' } });
  const gm = api();
  await save.processSave('sv1', { api: gm, s3Client: s3(), bucket: 'b' });
  expect(gm.driveCreateFolder).not.toHaveBeenCalled();
  expect(gm.driveUpload.mock.calls[0][1].parentId).toBe('oct');
});

test('a Drive copy failure is noted; the S3 save still counts', async () => {
  setup();
  const gm = api({ driveUpload: jest.fn().mockRejectedValue(new Error('Google 403: insufficient scope')) });
  const out = await save.processSave('sv1', { api: gm, s3Client: s3(), bucket: 'b' });
  expect(out).toMatchObject({ status: 'Saved', driveCopied: false });
  const done = sqlCalls(/UPDATE CtrlEvidenceSaved SET Status = 'Saved'/)[0][1];
  expect(done[6]).toBe('Saved; the Drive copy failed: Google 403: insufficient scope');
});

test('a Drive file: a PDF is stored as is, read as the folder\'s account', async () => {
  setup({ saveRow: { ...SAVE, source: 'Drive', sourceaccount: 'src-1', externalid: 'file1' } });
  const pdf = await (async () => {
    const d = await PDFDocument.create();
    d.addPage();
    return Buffer.from(await d.save());
  })();
  const gm = api({ driveGetFile: jest.fn(async () => ({ id: 'file1', name: 'INV.pdf', mimeType: 'application/pdf' })), driveDownload: jest.fn(async () => pdf) });
  const s3Client = s3();
  await save.processSave('sv1', { api: gm, s3Client, bucket: 'b' });
  expect(gm.driveDownload).toHaveBeenCalledWith('amy@apohco.com', 'file1');
  expect(s3Client.send.mock.calls[0][0].input.Body).toBe(pdf);
  expect(sqlCalls(/INSERT INTO CtrlVendorSenders/)).toHaveLength(0);
});

test('a transient error is retried; the last attempt (or a permanent problem) marks it Failed', async () => {
  setup();
  const gm = api({ gmailGetMessage: jest.fn().mockRejectedValue(new Error('Google 503')) });
  await expect(save.processSave('sv1', { api: gm, s3Client: s3(), bucket: 'b' })).rejects.toThrow('Google 503');
  setup({ saveRow: { ...SAVE, attempts: 3 } });
  expect((await save.processSave('sv1', { api: gm, s3Client: s3(), bucket: 'b' })).status).toBe('Failed');
  setup();
  expect(await save.processSave('sv1', { api: api(), s3Client: s3(), bucket: '' })).toMatchObject({ status: 'Failed', error: 'EVIDENCE_BUCKET is not set' });
});

test('nothing to do when already saved (SQS redelivery)', async () => {
  setup({ saveRow: null });
  expect((await save.processSave('sv1', { api: api(), s3Client: s3(), bucket: 'b' })).status).toMatch(/nothing to do/);
});

test('helpers', () => {
  expect(save.evidenceFileName({ txnDate: '2026-10-03', vendor: null, amount: 9.5 })).toBe('2026-10-03_no-payee_9.50.pdf');
  expect(save.winAnsi('“A” – B… ✓')).toBe('"A" - B... ?');
  expect(save.senderEmail('Name <X@Y.com>')).toBe('x@y.com');
});
