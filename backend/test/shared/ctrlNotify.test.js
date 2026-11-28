jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/googleApi', () => ({ gmailSend: jest.fn() }));

const db = require('../../src/shared/db');
const google = require('../../src/shared/googleApi');
const notify = require('../../src/shared/ctrlNotify');
const worker = require('../../src/functions/controller/ctrlNotifyWorker');
const { sqlRouter, sqlOf } = require('../helpers');

const G = '11111111-1111-4111-8111-111111111111';
const MGMT = '22222222-2222-4222-8222-222222222222';
const ON = { emailenabled: true, controlleremail: null, adminemail: 'admin@apohco.com' };
const OFF = { emailenabled: false, controlleremail: null, adminemail: 'admin@apohco.com' };

const settingsRoute = (row) => [/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, { rows: [row] }];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.example.com/';
});

describe('buildRawEmail', () => {
  const decode = (raw) => Buffer.from(raw, 'base64url').toString('utf8');

  test('headers stay on one line, so a name or subject cannot add headers', () => {
    const raw = notify.buildRawEmail({ from: 'admin@apohco.com', to: 'casey@firm.com\r\nBcc: evil@x.com', subject: 'Hi\r\nBcc: evil@x.com', body: 'Body' });
    const text = decode(raw);
    const headers = text.split('\r\n\r\n')[0].split('\r\n');
    expect(headers.filter((h) => /^Bcc:/i.test(h))).toEqual([]);
    expect(headers).toContain('To: casey@firm.com Bcc: evil@x.com');
  });

  test('UTF-8 subject and body', () => {
    const text = decode(notify.buildRawEmail({ from: 'a@x.com', to: 'b@x.com', subject: 'Café — report', body: 'Résumé' }));
    const subject = text.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1];
    expect(Buffer.from(subject, 'base64').toString('utf8')).toBe('Café — report');
    const body = text.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Résumé');
  });
});

describe('queueing', () => {
  const report = { groupId: G, qboId: MGMT, reportId: 'r1', reportNumber: 'MGMT-2026-10-AJE-001', qboName: 'APOHCO Management', month: '2026-10', entryCount: 2, supersedes: null };

  test('a published report goes to each active accountant who can see the file, with a portal link', async () => {
    db.query.mockImplementation(sqlRouter([
      settingsRoute(ON),
      [/FROM CtrlAccountants a\s+JOIN CtrlAccountantAccess x/, { rows: [{ fullname: 'Casey', email: 'casey@firm.com' }, { fullname: 'Dana', email: 'dana@firm.com' }] }],
    ]));
    expect(await notify.notifyReportPublished({ query: db.query }, report)).toBe(2);
    const inserts = db.query.mock.calls.filter(([s]) => /INSERT INTO CtrlNotifications/.test(s)).map(([, p]) => p);
    expect(inserts.map((p) => p[2])).toEqual(['casey@firm.com', 'dana@firm.com']);
    expect(inserts[0][4]).toContain('https://app.example.com/portal/reports/r1');
    expect(inserts[0][4]).toContain('October 2026');
    const accessSql = db.query.mock.calls.find(([s]) => /JOIN CtrlAccountantAccess x/.test(s));
    expect(accessSql[0]).toMatch(/a\.Active AND a\.NotifyByEmail/);
    expect(accessSql[1]).toEqual([G, MGMT]);
  });

  test('nothing is queued while email is off', async () => {
    db.query.mockImplementation(sqlRouter([settingsRoute(OFF)]));
    expect(await notify.notifyReportPublished({ query: db.query }, report)).toBe(0);
    expect(sqlOf(db.query).some((s) => /CtrlAccountants|INSERT INTO CtrlNotifications/.test(s))).toBe(false);
  });

  test('a failure is swallowed and rolled back to its savepoint', async () => {
    db.query.mockImplementation(sqlRouter([[/FROM Groups grp/, () => { throw new Error('boom'); }]]));
    expect(await notify.notifyReportPublished({ query: db.query }, report)).toBe(0);
    expect(sqlOf(db.query)).toEqual(['SAVEPOINT ctrl_notify', expect.any(String), 'ROLLBACK TO SAVEPOINT ctrl_notify']);
  });

  test('a reply goes to the accountants in that thread', async () => {
    db.query.mockImplementation(sqlRouter([settingsRoute(ON), [/FROM CtrlAjeComments c\s+JOIN CtrlAccountants a/, { rows: [{ fullname: 'Casey', email: 'casey@firm.com' }] }]]));
    const entry = { entryId: 'e1', reportId: 'r1', entryNumber: 'MGMT-2026-10-AJE-001.01', qboName: 'APOHCO Management' };
    expect(await notify.notifyReply({ query: db.query }, { groupId: G, entry, body: 'Use Lebanon.' })).toBe(1);
    const p = db.query.mock.calls.find(([s]) => /INSERT INTO CtrlNotifications/.test(s))[1];
    expect(p.slice(0, 3)).toEqual([G, 'Reply', 'casey@firm.com']);
    expect(p[4]).toContain('Use Lebanon.');
  });
});

describe('ctrlNotifyWorker', () => {
  const row = (over) => ({ notificationid: 'n1', groupid: G, kind: 'Question', toemail: 'paul@apohco.com', subject: 'Q', body: 'B', attempts: 0, ...over });

  beforeEach(() => {
    db.withTransaction.mockImplementation(async (fn) => fn({ query: db.query }));
  });

  test('sends from the admin mailbox and marks Sent', async () => {
    db.query.mockImplementation(sqlRouter([[/FOR UPDATE SKIP LOCKED/, { rows: [row()] }], settingsRoute(ON)]));
    google.gmailSend.mockResolvedValue({ id: 'm1' });
    expect(await worker.handler()).toEqual({ sent: 1, retry: 0, failed: 0, skipped: 0 });
    expect(google.gmailSend).toHaveBeenCalledWith('admin@apohco.com', expect.any(String));
    expect(sqlOf(db.query).some((s) => /SET Status = 'Sent'/.test(s))).toBe(true);
  });

  test('a send error is retried, and marked Failed on the last attempt', async () => {
    google.gmailSend.mockRejectedValue(new Error('scope missing'));
    db.query.mockImplementation(sqlRouter([[/FOR UPDATE SKIP LOCKED/, { rows: [row()] }], settingsRoute(ON)]));
    expect((await worker.handler()).retry).toBe(1);
    db.query.mockImplementation(sqlRouter([[/FOR UPDATE SKIP LOCKED/, { rows: [row({ attempts: worker.MAX_ATTEMPTS - 1 })] }], settingsRoute(ON)]));
    expect((await worker.handler()).failed).toBe(1);
    const last = db.query.mock.calls.filter(([s]) => /SET Status = \$2, LastError/.test(s)).pop()[1];
    expect(last).toEqual(['n1', 'Failed', 'scope missing']);
  });

  test('messages queued before email was turned off are not sent', async () => {
    db.query.mockImplementation(sqlRouter([[/FOR UPDATE SKIP LOCKED/, { rows: [row()] }], settingsRoute(OFF)]));
    expect((await worker.handler()).skipped).toBe(1);
    expect(google.gmailSend).not.toHaveBeenCalled();
  });

  test('claims rows by bumping Attempts first, so overlapping runs never double-send', async () => {
    db.query.mockImplementation(sqlRouter([[/FOR UPDATE SKIP LOCKED/, { rows: [row()] }], settingsRoute(ON)]));
    google.gmailSend.mockResolvedValue({});
    await worker.handler();
    const sql = sqlOf(db.query);
    expect(sql.findIndex((s) => /SET Attempts = Attempts \+ 1/.test(s))).toBeLessThan(sql.findIndex((s) => /SET Status = 'Sent'/.test(s)));
  });
});
