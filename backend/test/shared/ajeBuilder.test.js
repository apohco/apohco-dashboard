const B = require('../../src/shared/ajeBuilder');
const { buildEntityResolver } = require('../../src/shared/reviewEngine');

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon', managementQboClassId: 'c-leb', managementClassName: 'Lebanon', aliases: ['Lebanon Pediatric'] },
  { entityId: 'mil', entityName: 'Milford', managementQboClassId: 'c-mil', managementClassName: 'Milford', aliases: [] },
  { entityId: 'wpd', entityName: 'Westside', managementQboClassId: null, managementClassName: null, aliases: [] },
];
const ctx = { isClassBased: true, entitiesById: new Map(ENTITIES.map((e) => [e.entityId, e])), resolve: buildEntityResolver(ENTITIES) };
const acctCtx = { ...ctx, isClassBased: false };

const line = (over = {}) => ({
  sourceQboId: 'mgmt', fingerprint: over.fingerprint || 'f1', lineId: 'l1', txnDate: '2026-10-05', payeeName: 'Kroger', payeeKey: 'kroger',
  vendorKey: 'v:kroger', vendorName: 'Kroger', accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', qboClassId: null,
  debit: 100, credit: 0, ...over,
});
const dec = (over) => ({ decisionId: 'd1', scope: 'Line', requestAje: true, ...over });

describe('lineChange: class moves', () => {
  test('reassigning moves the amount between classes in the same account', () => {
    const c = B.lineChange(line(), dec({ action: 'Reassign', entityId: 'leb' }), null, ctx);
    expect(c.kind).toBe('ClassMove');
    expect(c.lines).toEqual(
      expect.arrayContaining([
        { code: '6100', name: 'Supplies', className: 'Lebanon', amount: 100 },
        { code: '6100', name: 'Supplies', className: 'Unclassified', amount: -100 },
      ])
    );
    expect(c.issues).toEqual([]);
  });

  test('a refund (credit line) moves the other way', () => {
    const c = B.lineChange(line({ debit: 0, credit: 40 }), dec({ action: 'Reassign', entityId: 'leb' }), null, ctx);
    const leb = c.lines.find((p) => p.className === 'Lebanon');
    expect(leb.amount).toBe(-40);
  });

  test('approving the class the line already has (even via an alias) books nothing', () => {
    expect(B.lineChange(line({ className: 'Lebanon Pediatric' }), dec({ action: 'Approve', entityId: 'leb' }), null, ctx)).toBeNull();
    expect(B.lineChange(line({ className: 'Lebanon' }), dec({ action: 'Keep', entityId: 'leb' }), null, ctx)).toBeNull();
  });

  test('a split debits each entity and credits the old class, balancing to the cent', () => {
    const c = B.lineChange(
      line({ debit: 100 }),
      dec({ action: 'Split', allocations: [{ entityId: 'leb', amount: 33.33 }, { entityId: 'mil', amount: 66.66 }] }),
      null,
      ctx
    );
    const total = c.lines.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100)).toBe(0);
    expect(c.lines.find((p) => p.className === 'Milford').amount).toBe(66.67);
    expect(c.lines.find((p) => p.className === 'Unclassified').amount).toBe(-100);
  });

  test('an entity without a linked class is flagged', () => {
    const c = B.lineChange(line(), dec({ action: 'Reassign', entityId: 'wpd' }), null, ctx);
    expect(c.issues[0]).toMatch(/Westside has no QuickBooks class/);
  });

  test('a relabel of an earlier month books only when an AJE was requested', () => {
    expect(B.lineChange(line(), dec({ action: 'Reassign', entityId: 'leb', scope: 'Relabel', requestAje: false }), null, ctx)).toBeNull();
    expect(B.lineChange(line(), dec({ action: 'Reassign', entityId: 'leb', scope: 'Relabel', requestAje: true }), null, ctx)).not.toBeNull();
  });
});

describe('lineChange: account review', () => {
  test('reclassify: debit the new account, credit the old', () => {
    const c = B.lineChange(line({ className: null }), dec({ action: 'Reclassify', targetAccount: { code: '6150', name: 'Breakroom' } }), null, acctCtx);
    expect(c.kind).toBe('Reclassify');
    expect(c.lines).toEqual(expect.arrayContaining([
      { code: '6150', name: 'Breakroom', className: null, amount: 100 },
      { code: '6100', name: 'Supplies', className: null, amount: -100 },
    ]));
  });

  test('due to/from: debit the intercompany account, with a note about the other side', () => {
    const c = B.lineChange(
      line({ className: null }),
      dec({ action: 'DueToFrom', counterpartyEntityId: 'leb', targetAccount: { code: '1500', name: 'Due From Lebanon' } }),
      null,
      { ...acctCtx, mirrorNote: () => 'The other side is drafted in Lebanon\'s file' }
    );
    expect(c.kind).toBe('DueToFrom');
    expect(c.lines.find((p) => p.code === '1500').amount).toBe(100);
    expect(c.warnings).toEqual(['The other side is drafted in Lebanon\'s file']);
  });
});

describe('lineChange: against earlier entries', () => {
  const published = [{ code: '6100', name: 'Supplies', className: 'Lebanon', amount: 100 }];

  test('a line already covered by a published entry books nothing', () => {
    expect(B.lineChange(line(), dec({ action: 'Reassign', entityId: 'leb' }), published, ctx)).toBeNull();
  });

  test('a changed decision moves from where the published entry put it', () => {
    const c = B.lineChange(line(), dec({ action: 'Reassign', entityId: 'mil' }), published, ctx);
    expect(c.lines).toEqual(expect.arrayContaining([
      { code: '6100', name: 'Supplies', className: 'Milford', amount: 100 },
      { code: '6100', name: 'Supplies', className: 'Lebanon', amount: -100 },
    ]));
  });

  test('an undone decision reverses the published entry', () => {
    const c = B.lineChange(line(), { decisionId: 'd2', action: 'Undo' }, published, ctx);
    expect(c.kind).toBe('Reversal');
    expect(c.lines.find((p) => p.className === 'Unclassified').amount).toBe(100);
  });
});

describe('mirrorChange', () => {
  const d = dec({ action: 'DueToFrom', counterpartyEntityId: 'leb', targetAccount: { code: '1500', name: 'Due From Lebanon' } });

  test('books the expense against Due To the deciding entity', () => {
    const c = B.mirrorChange(line({ className: null }), d, null, { dueAccount: { code: '2500', name: 'Due To Westside' }, issues: [], warnings: [] });
    expect(c.kind).toBe('DueToFromMirror');
    expect(c.lines).toEqual(expect.arrayContaining([
      { code: '6100', name: 'Supplies', className: null, amount: 100 },
      { code: '2500', name: 'Due To Westside', className: null, amount: -100 },
    ]));
  });

  test('without a Due To account it is drafted, flagged, with no lines', () => {
    const c = B.mirrorChange(line(), d, null, { dueAccount: null, issues: ['Choose the Due To/From account'], warnings: [] });
    expect(c.issues).toEqual(['Choose the Due To/From account']);
    expect(c.lines).toEqual([]);
  });

  test('a decision changed away from Due To/From reverses a published mirror', () => {
    const prior = [{ code: '6100', name: 'Supplies', className: null, amount: 100 }, { code: '2500', name: 'Due To Westside', className: null, amount: -100 }];
    const c = B.mirrorChange(line(), dec({ action: 'Keep' }), prior, { dueAccount: null, issues: [], warnings: [] });
    expect(c.kind).toBe('Reversal');
    expect(c.lines.find((p) => p.code === '2500').amount).toBe(100);
  });

  test('nothing when there was never a mirror', () => {
    expect(B.mirrorChange(line(), dec({ action: 'Keep' }), null, { dueAccount: null, issues: [], warnings: [] })).toBeNull();
  });
});

describe('groupChanges', () => {
  const move = (fp, amount, over = {}) => B.lineChange(line({ fingerprint: fp, debit: amount, txnDate: `2026-10-${fp.slice(1).padStart(2, '0')}`, ...over }), dec({ decisionId: `d${fp}`, action: 'Reassign', entityId: 'leb' }), null, ctx);

  test('grouped: same vendor and move become one entry with every line as backup', () => {
    const entries = B.groupChanges([move('f1', 10), move('f2', 20), move('f3', 30)], 'Grouped');
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(60);
    expect(entries[0].sources).toHaveLength(3);
    expect(entries[0].lines).toEqual([
      { accountCode: '6100', accountName: 'Supplies', className: 'Lebanon', debit: 60, credit: 0 },
      { accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', debit: 0, credit: 60 },
    ]);
    expect(entries[0].memo).toBe('Class change: Kroger, 3 transactions 10/01/2026-10/03/2026, from Unclassified to Lebanon. Controller review.');
  });

  test('per line: one entry each; different vendors never group', () => {
    expect(B.groupChanges([move('f1', 10), move('f2', 20)], 'PerLine')).toHaveLength(2);
    expect(B.groupChanges([move('f1', 10), move('f2', 20, { vendorKey: 'v:amazon', vendorName: 'Amazon' })], 'Grouped')).toHaveLength(2);
  });

  test('keys are stable and change when the underlying decision changes', () => {
    const a = B.groupChanges([move('f1', 10)])[0].key;
    expect(B.groupChanges([move('f1', 10)])[0].key).toBe(a);
    const other = B.lineChange(line({ fingerprint: 'f1', debit: 10, txnDate: '2026-10-01' }), dec({ decisionId: 'dX', action: 'Reassign', entityId: 'leb' }), null, ctx);
    expect(B.groupChanges([other])[0].key).not.toBe(a);
  });
});

describe('numbering', () => {
  test('report, entry and QBO Num forms', () => {
    expect(B.reportNumber('MGMT', '2026-10', 1)).toBe('MGMT-2026-10-AJE-001');
    expect(B.entryNumber('MGMT-2026-10-AJE-001', 3)).toBe('MGMT-2026-10-AJE-001.03');
    expect(B.qboNum('MGMT', '2026-10', 1, 3)).toBe('MGMT-2610-AJE001.03');
    expect(B.qboNum('ABCDEF', '2026-10', 999, 99).length).toBeLessThanOrEqual(B.QBO_NUM_MAX);
  });

  test('suggested file codes', () => {
    expect(B.suggestFileCode({ isClassBased: true, name: 'APOHCO' })).toBe('MGMT');
    expect(B.suggestFileCode({ isClassBased: false, name: 'Westside Pediatric Dentistry' })).toBe('WPD');
    expect(B.suggestFileCode({ isClassBased: false, name: 'Lebanon' })).toBe('LEBA');
    expect(B.suggestFileCode({ isClassBased: false, name: 'Westside Pediatric Dentistry' }, new Set(['WPD']))).toBe('WPD2');
    expect(B.FILE_CODE_RE.test(B.suggestFileCode({ isClassBased: false, name: '!!' }))).toBe(true);
  });
});

describe('matchPosting', () => {
  const reports = [{ reportId: 'r1', fileCode: 'MGMT', month: '2026-10', seq: 1, entries: [{ entryId: 'e1', seq: 1 }, { entryId: 'e2', seq: 2 }, { entryId: 'e10', seq: 10 }] }];

  test('finds an entry by its full number or its QBO Num, in Num or memo', () => {
    expect(B.matchPosting(['MGMT-2610-AJE001.02', null], reports)).toEqual([{ entryId: 'e2', matchedOn: 'Entry' }]);
    expect(B.matchPosting([null, 'MGMT-2026-10-AJE-001.10 Class change: Kroger'], reports)).toEqual([{ entryId: 'e10', matchedOn: 'Entry' }]);
    expect(B.matchPosting(['mgmt 2610 aje001.01'], reports)).toEqual([{ entryId: 'e1', matchedOn: 'Entry' }]);
  });

  test('a report number alone marks every entry of it', () => {
    expect(B.matchPosting(['MGMT-2026-10-AJE-001'], reports).map((m) => m.entryId).sort()).toEqual(['e1', 'e10', 'e2']);
  });

  test('ignores other reports and longer numbers', () => {
    expect(B.matchPosting(['MGMT-2610-AJE002.01'], reports)).toEqual([]);
    expect(B.matchPosting(['MGMT-2610-AJE0011'], reports)).toEqual([]);
    expect(B.matchPosting(['MGMT-2610-AJE001.03'], reports)).toEqual([]);
    expect(B.matchPosting(['Paid invoice 4471'], reports)).toEqual([]);
  });
});
