import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/controller', () => ({ listVendors: vi.fn(), updateVendor: vi.fn(), mergeVendor: vi.fn(), testVendorRule: vi.fn() }));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { listVendors, updateVendor, mergeVendor, testVendorRule } from '../../api/controller';
import { listGroups } from '../../api/settings';
import Vendors, { sortVendors, toBody, toForm } from './Vendors';

const kroger = {
  vendorId: 'v1', displayName: 'Kroger', watchMode: false, splitTemplate: null, aliases: ['Kroger', 'KROGER #2'],
  rule: { ruleId: 'r1', version: 2, defaultEntityId: 'leb', keywords: [{ keyword: 'Route 50', entityId: 'mil' }], ruleText: 'Mostly Lebanon', createdDate: '2026-11-01' },
  stats: { spend12: 5200, lineCount12: 40, reviewed: 40, decided: 30, reviewedPct: 0.75, avgConfidence: 0.91 },
};
const amazon = { vendorId: 'v2', displayName: 'AMZN Mktp', watchMode: true, splitTemplate: null, aliases: ['AMZN Mktp'], rule: null,
  stats: { spend12: 800, lineCount12: 9, reviewed: 0, decided: 0, reviewedPct: null, avgConfidence: null },
};

test('toForm / toBody round-trip and drop blank rows', () => {
  const form = toForm(kroger);
  form.keywords.push({ keyword: '  ', entityId: '' });
  form.split = [{ entityId: 'leb', percent: '60' }, { entityId: 'mil', percent: '40' }, { entityId: '', percent: '' }];
  expect(toBody(form)).toEqual({
    displayName: 'Kroger',
    watchMode: false,
    splitTemplate: [{ entityId: 'leb', percent: 60 }, { entityId: 'mil', percent: 40 }],
    rule: { defaultEntityId: 'leb', keywords: [{ keyword: 'Route 50', entityId: 'mil' }], ruleText: 'Mostly Lebanon' },
  });
  expect(toBody(toForm(amazon)).splitTemplate).toBeNull();
});

describe('Vendors page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    listVendors.mockResolvedValue({ entities: [{ entityId: 'leb', entityName: 'Lebanon' }, { entityId: 'mil', entityName: 'Milford' }], vendors: [kroger, amazon] });
  });

  test('lists vendors and searches payee names too', async () => {
    const user = userEvent.setup();
    render(<Vendors />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Kroger')).toBeInTheDocument();
    expect(screen.getByText('Lebanon')).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search vendors'), 'kroger #2');
    expect(screen.queryByText('AMZN Mktp')).not.toBeInTheDocument();
  });

  test('edits a rule and reports the new version', async () => {
    const user = userEvent.setup();
    updateVendor.mockResolvedValue({ vendorId: 'v1', ruleVersion: 3 });
    render(<Vendors />, { wrapper: MemoryRouter });
    await screen.findByText('Kroger');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.click(screen.getByRole('checkbox', { name: /Watch mode/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateVendor).toHaveBeenCalledWith('g1', 'v1', expect.objectContaining({ watchMode: true, rule: expect.objectContaining({ defaultEntityId: 'leb' }) }));
    expect(await screen.findByText('Saved Kroger (rule version 3).')).toBeInTheDocument();
  });

  test('merges another vendor in', async () => {
    const user = userEvent.setup();
    mergeVendor.mockResolvedValue({});
    render(<Vendors />, { wrapper: MemoryRouter });
    await screen.findByText('Kroger');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.click(screen.getByRole('combobox', { name: 'Vendor to merge in' }));
    await user.click(screen.getByRole('option', { name: 'AMZN Mktp' }));
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(mergeVendor).toHaveBeenCalledWith('g1', 'v1', 'v2');
    expect(await screen.findByText('Merged AMZN Mktp into Kroger.')).toBeInTheDocument();
  });
});

test('sortVendors: by spend, name or review stats, blanks last', () => {
  const ids = (key, dir) => sortVendors([amazon, kroger], { key, dir }).map((v) => v.vendorId);
  expect(ids('spend', 'desc')).toEqual(['v1', 'v2']);
  expect(ids('spend', 'asc')).toEqual(['v2', 'v1']);
  expect(ids('name', 'asc')).toEqual(['v2', 'v1']);
  expect(ids('reviewed', 'asc')).toEqual(['v1', 'v2']);
  expect(ids('confidence', 'desc')).toEqual(['v1', 'v2']);
});

describe('Vendors page, Phase 2b', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    listVendors.mockResolvedValue({ entities: [{ entityId: 'leb', entityName: 'Lebanon' }, { entityId: 'mil', entityName: 'Milford' }], vendors: [amazon, kroger] });
  });

  test('shows spend and review stats, and links each vendor to its profile', async () => {
    render(<Vendors />, { wrapper: MemoryRouter });
    const link = await screen.findByRole('link', { name: 'Kroger' });
    expect(link).toHaveAttribute('href', '/controller/vendors/v1');
    expect(screen.getByText('$5,200.00')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  test('tests the rule being edited before saving', async () => {
    const user = userEvent.setup();
    testVendorRule.mockResolvedValue({
      months: 6, fromMonth: '2026-05', toMonth: '2026-10', lineCount: 20, wouldChange: 3, changeAmount: 120, unchanged: 15, noEntity: 2, splits: 0,
      conflictsWithHistory: 3, history: { entityId: 'mil', confidence: 0.92 },
      changes: [{ lineId: 'x', txnDate: '2026-09-02', memo: 'store 12', amount: 40, fromEntityId: 'mil', toEntityId: 'leb', via: 'default entity', conflictsWithHistory: true }],
    });
    render(<Vendors />, { wrapper: MemoryRouter });
    await screen.findByText('Kroger');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.click(screen.getByRole('combobox', { name: 'Months to test' }));
    await user.click(screen.getByRole('option', { name: 'Last 6 months' }));
    await user.click(screen.getByRole('button', { name: 'Test rule' }));
    expect(testVendorRule).toHaveBeenCalledWith('g1', 'v1', { defaultEntityId: 'leb', keywords: [{ keyword: 'Route 50', entityId: 'mil' }] }, 6);
    expect(await screen.findByText(/3 would change entity/)).toBeInTheDocument();
    expect(screen.getByText(/3 changes would conflict with history \(Milford, 92%\)/)).toBeInTheDocument();
    expect(updateVendor).not.toHaveBeenCalled();
  });
});
