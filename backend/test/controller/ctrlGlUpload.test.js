jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/s3Client', () => ({
  getPresignedUploadUrl: jest.fn(),
  getObjectBuffer: jest.fn(),
  deleteObject: jest.fn(),
}));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { getPresignedUploadUrl, getObjectBuffer, deleteObject } = require('../../src/shared/s3Client');
const { handler, validatePeriod } = require('../../src/functions/controller/ctrlGlUpload');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const UPLOAD_ID = '11111111-2222-3333-4444-555555555555';
const GL = [
  'Distribution account,Transaction date,Transaction type,Name,Description,Split,Amount,Class',
  '6100 Supplies,10/03/2026,Expense,Kroger,Breakroom,1000 Checking,42.10,Lebanon',
  '1000 Checking,10/03/2026,Expense,Kroger,Breakroom,6100 Supplies,-42.10,Lebanon',
  '6100 Supplies,12/01/2026,Expense,Amazon,Gloves,1000 Checking,10.00,',
  '1000 Checking,12/01/2026,Expense,Amazon,Gloves,6100 Supplies,-10.00,',
  '2500 New Loan,12/02/2026,Journal Entry,,,,5.00,',
].join('\n');

const uploadRow = (over = {}) => ({
  uploadid: UPLOAD_ID, groupid: 'group-1', qboid: 'qbo-1', qboname: 'APOHCO', filename: 'gl.csv',
  s3key: 'controller-uploads/group-1/qbo-1/x-gl.csv', status: 'Pending', filesha256: null, ...over,
});

let client;
function setup({ upload = uploadRow(), saved = null, lockStatus = 'Pending', known = true } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  getObjectBuffer.mockResolvedValue(Buffer.from(GL, 'utf8'));
  getPresignedUploadUrl.mockResolvedValue('https://s3.example/put');
  deleteObject.mockResolvedValue();
  query.mockImplementation(
    sqlRouter([
      [/FROM QBOs WHERE QBOId/, { rows: [{ qboid: 'qbo-1', qboname: 'APOHCO' }] }],
      [/INSERT INTO CtrlUploads/, { rows: [{ uploadid: UPLOAD_ID }] }],
      [/FROM CtrlUploads u JOIN QBOs q ON q.QBOId = u.QBOId\s+WHERE u.UploadId/, { rows: upload ? [upload] : [] }],
      [
        /FROM ChartOfAccountsMappings/,
        {
          rows: known
            ? [
                { accountcode: '6100', accountname: 'Supplies', classification: 'Expense' },
                { accountcode: '1000', accountname: 'Checking', classification: 'Asset' },
              ]
            : [],
        },
      ],
      [/FROM QBOClasses/, { rows: [{ classname: 'Lebanon', qboclassid: 'class-leb' }] }],
      [/ColumnMapping->'headers'/, { rows: saved ? [saved] : [] }],
    ])
  );
  let snap = 0;
  client = {
    query: sqlRouter([
      [/FOR UPDATE/, { rows: [{ status: lockStatus }] }],
      [/INSERT INTO CtrlSnapshots/, () => ({ rows: [{ snapshotid: `snap-${++snap}` }] })],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
}

const post = (resource, body, path) => apiEvent({ method: 'POST', resource, body, path });
const analyze = (body) =>
  handler(post('/api/controller/uploads/{uploadId}/analyze', { groupId: 'group-1', ...body }, { uploadId: UPLOAD_ID }));
const importFile = (body) =>
  handler(post('/api/controller/uploads/{uploadId}/import', { groupId: 'group-1', ...body }, { uploadId: UPLOAD_ID }));

describe('access', () => {
  test.each([
    ['an Owner', OWNER],
    ['a SoftwareAdmin outside ControllerOwner', PLAIN_ADMIN],
  ])('403 for %s', async (_, claims) => {
    setup();
    requireAuth.mockResolvedValue(claims);
    const res = await analyze({});
    expect(res.statusCode).toBe(403);
    expect(getObjectBuffer).not.toHaveBeenCalled();
  });

  test('a malformed upload id is a 404, not a database error', async () => {
    setup();
    const res = await handler(post('/api/controller/uploads/{uploadId}/analyze', { groupId: 'group-1' }, { uploadId: 'nope' }));
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/controller/uploads', () => {
  test('records a pending upload and returns a presigned URL under the controller prefix', async () => {
    setup();
    const res = await handler(
      post('/api/controller/uploads', { groupId: 'group-1', qboId: 'qbo-1', fileName: 'Oct GL (final).xlsx' })
    );
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toMatchObject({ uploadId: UPLOAD_ID, uploadUrl: 'https://s3.example/put' });
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO CtrlUploads/.test(sql));
    expect(insert[1][3]).toMatch(/^controller-uploads\/group-1\/qbo-1\/.+-Oct GL _final_\.xlsx$/);
  });

  test('only csv and xlsx files', async () => {
    setup();
    const res = await handler(post('/api/controller/uploads', { groupId: 'group-1', qboId: 'qbo-1', fileName: 'gl.pdf' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('analyze', () => {
  test('detects the columns and previews without storing lines', async () => {
    setup();
    const res = await analyze({});
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data.mappingSource).toBe('detected');
    expect(data.mapping).toMatchObject({ account: 0, txnDate: 1, txnType: 2, name: 3, description: 4, split: 5, amount: 6, class: 7 });
    expect(data.lineCount).toBe(4);
    expect(data.unknownAccounts).toEqual([expect.objectContaining({ accountCode: '2500', suggested: 'Liability' })]);
    expect(data.months).toEqual([{ month: '2026-10', lineCount: 2 }, { month: '2026-12', lineCount: 2 }]);
    expect(data.sample[0]).toMatchObject({ payeeName: 'Kroger', splitAccount: '1000 Checking', qboClassId: 'class-leb' });
    expect(withTransaction).not.toHaveBeenCalled();
    expect(sqlOf(query).some((sql) => /INSERT INTO CtrlLedgerLines|INSERT INTO CtrlSnapshots/.test(sql))).toBe(false);
  });

  test('reuses the mapping saved from the last file with the same headers', async () => {
    setup({ saved: { columnmapping: { fields: { txnDate: 1, account: 0, amount: 6 } }, amountconvention: 'debitPositive' } });
    const data = parseBody(await analyze({}));
    expect(data.mappingSource).toBe('saved');
    expect(data.mapping.name).toBeNull();
    expect(data.amountConvention).toBe('debitPositive');
  });

  test('a file that is already imported cannot be analyzed again', async () => {
    setup({ upload: uploadRow({ status: 'Imported' }) });
    expect((await analyze({})).statusCode).toBe(409);
  });

  test('an expired staging file asks for a new upload', async () => {
    setup();
    getObjectBuffer.mockRejectedValue(new Error('NoSuchKey'));
    expect((await analyze({})).statusCode).toBe(410);
  });

  test('another Group cannot read the upload', async () => {
    setup({ upload: null });
    expect((await analyze({})).statusCode).toBe(404);
  });
});

describe('import', () => {
  const mapping = { account: 0, txnDate: 1, txnType: 2, name: 3, description: 4, split: 5, amount: 6, class: 7 };
  const body = {
    headerRow: 0, mapping, amountConvention: 'natural', classifications: { 'code:2500': 'Liability' },
    fromMonth: '2026-10', toMonth: '2026-12',
  };

  test('stores one upload snapshot per month, including an empty month, then marks the file imported', async () => {
    setup();
    const res = await importFile(body);
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data).toMatchObject({ lineCount: 5, outsideRange: 0 });
    expect(data.snapshots).toEqual([
      { snapshotId: 'snap-1', month: '2026-10', lineCount: 2 },
      { snapshotId: 'snap-2', month: '2026-11', lineCount: 0 },
      { snapshotId: 'snap-3', month: '2026-12', lineCount: 3 },
    ]);

    const sql = sqlOf(client.query);
    expect(sql.filter((s) => /INSERT INTO CtrlSnapshots/.test(s))).toHaveLength(3);
    expect(sql.filter((s) => /INSERT INTO CtrlSnapshots/.test(s)).every((s) => /'Upload'/.test(s))).toBe(true);
    expect(sql.filter((s) => /INSERT INTO CtrlLedgerLines/.test(s))).toHaveLength(2);
    expect(sql.some((s) => /SET Status = 'Imported'/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
    // The Controller never writes to the dashboard's own tables.
    expect([...sql, ...sqlOf(query)].some((s) => /(INSERT INTO|UPDATE|DELETE FROM)\s+(RawTransactions|ChartOfAccountsMappings|QBOClasses|QBOs)\b/i.test(s))).toBe(false);
    expect(deleteObject).toHaveBeenCalledWith(uploadRow().s3key);
  });

  test('the user-chosen classification sets the sign of a new account', async () => {
    setup();
    await importFile(body);
    const insert = client.query.mock.calls.filter(([s]) => /INSERT INTO CtrlLedgerLines/.test(s))[1];
    const params = insert[1];
    // 20 columns per line; the 2500 line is the last in December. Credit is column 18.
    const last = params.slice(-20);
    expect(last[12]).toBe('2500');
    expect([last[16], last[17]]).toEqual([0, 5]);
  });

  test('refuses while accounts are still unclassified', async () => {
    setup();
    const res = await importFile({ ...body, classifications: {} });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/Classify 1 account/);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('lines outside the chosen months are left out and counted', async () => {
    setup();
    const data = parseBody(await importFile({ ...body, fromMonth: '2026-10', toMonth: '2026-10' }));
    expect(data).toMatchObject({ lineCount: 2, outsideRange: 3 });
    expect(data.snapshots).toHaveLength(1);
  });

  test('a double-clicked import stores nothing the second time', async () => {
    setup({ lockStatus: 'Imported' });
    const res = await importFile(body);
    expect(res.statusCode).toBe(409);
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlSnapshots/.test(s))).toBe(false);
  });

  test('validates the period', async () => {
    expect(() => validatePeriod('2026-13', '2026-12')).toThrow(/YYYY-MM/);
    expect(() => validatePeriod('2026-12', '2026-10')).toThrow(/before/);
    expect(() => validatePeriod('2023-01', '2026-12')).toThrow(/at most 36/);
    expect(validatePeriod('2026-11', '2026-12')).toEqual(['2026-11', '2026-12']);
  });

  test('needs the mapping the user confirmed', async () => {
    setup();
    expect((await importFile({ fromMonth: '2026-10', toMonth: '2026-10' })).statusCode).toBe(400);
  });
});

describe('GET /api/controller/uploads', () => {
  test('lists imported files for the Group', async () => {
    setup();
    query.mockResolvedValueOnce({ rows: [{ uploadid: UPLOAD_ID, filename: 'gl.csv', qboid: 'qbo-1', qboname: 'APOHCO', frommonth: '2026-10', tomonth: '2026-12', linecount: 5, errorrowcount: 0, importeddate: 'd' }] });
    const res = await handler(apiEvent({ method: 'GET', resource: '/api/controller/uploads', query: { groupId: 'group-1' } }));
    expect(parseBody(res)).toEqual([expect.objectContaining({ uploadId: UPLOAD_ID, qboName: 'APOHCO', fromMonth: '2026-10' })]);
    expect(query.mock.calls[0][1]).toEqual(['group-1']);
  });
});
