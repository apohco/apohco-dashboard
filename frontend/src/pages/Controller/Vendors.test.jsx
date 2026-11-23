import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({ listVendors: vi.fn(), updateVendor: vi.fn(), mergeVendor: vi.fn() }));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import { listVendors, updateVendor, mergeVendor } from '../../api/controller';
import { listGroups } from '../../api/settings';
import Vendors, { toBody, toForm } from './Vendors';

const kroger = {
  vendorId: 'v1', displayName: 'Kroger', watchMode: false, splitTemplate: null, aliases: ['Kroger', 'KROGER #2'],
  rule: { ruleId: 'r1', version: 2, defaultEntityId: 'leb', keywords: [{ keyword: 'Route 50', entityId: 'mil' }], ruleText: 'Mostly Lebanon', createdDate: '2026-11-01' },
};
const amazon = { vendorId: 'v2', displayName: 'AMZN Mktp', watchMode: true, splitTemplate: null, aliases: ['AMZN Mktp'], rule: null };

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
    render(<Vendors />);
    expect(await screen.findByText('Kroger')).toBeInTheDocument();
    expect(screen.getByText('Lebanon')).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search vendors'), 'kroger #2');
    expect(screen.queryByText('AMZN Mktp')).not.toBeInTheDocument();
  });

  test('edits a rule and reports the new version', async () => {
    const user = userEvent.setup();
    updateVendor.mockResolvedValue({ vendorId: 'v1', ruleVersion: 3 });
    render(<Vendors />);
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
    render(<Vendors />);
    await screen.findByText('Kroger');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.click(screen.getByRole('combobox', { name: 'Vendor to merge in' }));
    await user.click(screen.getByRole('option', { name: 'AMZN Mktp' }));
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(mergeVendor).toHaveBeenCalledWith('g1', 'v1', 'v2');
    expect(await screen.findByText('Merged AMZN Mktp into Kroger.')).toBeInTheDocument();
  });
});
