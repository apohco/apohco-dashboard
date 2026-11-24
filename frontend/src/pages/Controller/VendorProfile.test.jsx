import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../api/controller', () => ({ getVendorProfile: vi.fn() }));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { getVendorProfile } from '../../api/controller';
import { listGroups } from '../../api/settings';
import VendorProfile, { describeCorrection } from './VendorProfile';

const name = (id) => ({ leb: 'Lebanon', mil: 'Milford' })[id];

test('describeCorrection', () => {
  expect(describeCorrection({ action: 'Reassign', className: 'Milford', entityId: 'leb' }, name)).toBe('Milford → Lebanon');
  expect(describeCorrection({ action: 'Split', allocations: [{ entityId: 'leb', amount: 6 }, { entityId: 'mil', amount: 4 }] }, name)).toBe('Split: Lebanon $6.00, Milford $4.00');
  expect(describeCorrection({ action: 'Reclassify', targetAccount: { code: '6150', name: 'Breakroom' } }, name)).toBe('Reclassified to 6150 Breakroom');
  expect(describeCorrection({ action: 'DueToFrom', counterpartyEntityId: 'leb' }, name)).toBe('Due To/From Lebanon');
});

describe('VendorProfile page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    getVendorProfile.mockResolvedValue({
      vendor: { vendorId: 'v1', displayName: 'Kroger', watchMode: true, aliases: ['Kroger', 'KROGER #2'] },
      entities: [{ entityId: 'leb', entityName: 'Lebanon' }, { entityId: 'mil', entityName: 'Milford' }],
      ruleVersions: [
        { ruleId: 'r2', version: 2, defaultEntityId: 'leb', keywords: [{ keyword: 'Route 50', entityId: 'mil' }], ruleText: 'Mostly Lebanon', ruleWins: true, createdDate: '2026-11-20', createdBy: 'paul' },
        { ruleId: 'r1', version: 1, defaultEntityId: 'mil', keywords: [], ruleText: null, ruleWins: false, createdDate: '2026-11-01', createdBy: 'paul' },
      ],
      entitySplit: [{ month: '2026-08', entityId: 'leb', amount: 100 }, { month: '2026-10', entityId: 'mil', amount: 50 }],
      lineCount: 14,
      outcome: { approved: 6, corrected: 2, relabeled: 37, open: 6, approvalRate: 0.75 },
      relabels: [{ runId: 'run-1', entityId: 'leb', requestAje: false, decidedAt: '2026-11-21T10:00:00Z', decidedBy: 'paul', lineCount: 37, amount: 4210, fromMonth: '2026-01', toMonth: '2026-09' }],
      corrections: [
        { decisionId: 'd1', action: 'Reassign', entityId: 'leb', className: 'Milford', scope: 'Line', decidedAt: '2026-11-21T10:00:00Z', decidedBy: 'paul', qboName: 'APOHCO', txnDate: '2026-09-02', memo: 'store', amount: 25, account: '6100 Supplies' },
      ],
    });
  });

  test('shows stats, rule history and corrections for the vendor in the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/controller/vendors/v1']}>
        <Routes>
          <Route path="/controller/vendors/:vendorId" element={<VendorProfile />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('Payee names: Kroger, KROGER #2')).toBeInTheDocument();
    expect(getVendorProfile).toHaveBeenCalledWith('g1', 'v1');
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Rule wins')).toBeInTheDocument();
    expect(screen.getByText('"Route 50" → Milford')).toBeInTheDocument();
    expect(screen.getByText('Milford → Lebanon')).toBeInTheDocument();
    expect(screen.getByText('History relabeled (rule wins)')).toBeInTheDocument();
    expect(screen.getByText('2026-01 to 2026-09')).toBeInTheDocument();
    expect(screen.getByText('Not requested')).toBeInTheDocument();
    expect(screen.getByText('$4,210.00')).toBeInTheDocument();
  });
});
