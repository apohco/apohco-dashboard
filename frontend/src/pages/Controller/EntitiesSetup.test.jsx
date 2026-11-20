import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({
  listControllerEntities: vi.fn(),
  createControllerEntity: vi.fn(),
  updateControllerEntity: vi.fn(),
  deleteControllerEntity: vi.fn(),
}));
vi.mock('../../api/settings', () => ({ listGroups: vi.fn() }));

import {
  listControllerEntities,
  createControllerEntity,
  updateControllerEntity,
  deleteControllerEntity,
} from '../../api/controller';
import { listGroups } from '../../api/settings';
import EntitiesSetup, { splitList, toForm, toPayload } from './EntitiesSetup';

const lebanon = {
  entityId: 'e1', entityName: 'Lebanon', practiceQboId: 'q2', practiceQboName: 'Lebanon QBO',
  managementQboClassId: 'c1', managementClassName: 'Lebanon', managementQboName: 'MGMT',
  consolidationGroupId: null, aliases: ['Leb'], keywords: ['Main St'], isActive: true,
};
const options = {
  qbos: [{ qboId: 'q1', qboName: 'MGMT' }, { qboId: 'q2', qboName: 'Lebanon QBO' }],
  classes: [{ qboClassId: 'c1', className: 'Lebanon', qboId: 'q1', qboName: 'MGMT' }],
  consolidationGroups: [],
};

describe('form helpers', () => {
  test('splitList', () => {
    expect(splitList(' Leb, ,Lebanon Dental ,')).toEqual(['Leb', 'Lebanon Dental']);
  });

  test('toForm / toPayload round-trip, blanks become null', () => {
    expect(toPayload(toForm(lebanon))).toEqual({
      entityName: 'Lebanon', practiceQboId: 'q2', managementQboClassId: 'c1', consolidationGroupId: null,
      aliases: ['Leb'], keywords: ['Main St'], isActive: true,
    });
  });
});

describe('EntitiesSetup page', () => {
  beforeEach(() => {
    listGroups.mockResolvedValue([{ groupid: 'g1', groupname: 'APOHCO' }]);
    listControllerEntities.mockResolvedValue({ entities: [lebanon], options });
  });

  test('lists entities with their linked class and file', async () => {
    render(<EntitiesSetup />);
    expect(await screen.findByText('Lebanon (MGMT)')).toBeInTheDocument();
    expect(screen.getByText('Lebanon QBO')).toBeInTheDocument();
    expect(screen.getByText('Leb')).toBeInTheDocument();
  });

  test('adds an entity', async () => {
    const user = userEvent.setup();
    createControllerEntity.mockResolvedValue({});
    render(<EntitiesSetup />);
    await screen.findByText('Lebanon (MGMT)');

    await user.click(screen.getByRole('button', { name: 'Add entity' }));
    await user.type(screen.getByLabelText('Name'), 'Milford');
    await user.type(screen.getByLabelText('Other names (comma-separated)'), 'Milford Dental, MIL');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(createControllerEntity).toHaveBeenCalledWith('g1', {
      entityName: 'Milford', practiceQboId: null, managementQboClassId: null, consolidationGroupId: null,
      aliases: ['Milford Dental', 'MIL'], keywords: [], isActive: true,
    });
    await waitFor(() => expect(listControllerEntities).toHaveBeenCalledTimes(2));
  });

  test('shows a save error in the dialog', async () => {
    const user = userEvent.setup();
    updateControllerEntity.mockRejectedValue({ response: { data: { message: 'An entity with that name already exists in this Group' } } });
    render(<EntitiesSetup />);
    await user.click(await screen.findByLabelText('Edit Lebanon'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('An entity with that name already exists in this Group')).toBeInTheDocument();
    expect(updateControllerEntity).toHaveBeenCalledWith('g1', 'e1', expect.objectContaining({ entityName: 'Lebanon' }));
  });

  test('deletes after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteControllerEntity.mockResolvedValue({});
    render(<EntitiesSetup />);
    await user.click(await screen.findByLabelText('Delete Lebanon'));
    expect(deleteControllerEntity).toHaveBeenCalledWith('g1', 'e1');
  });
});
