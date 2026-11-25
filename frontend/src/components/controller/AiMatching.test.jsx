import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/controller', () => ({
  getAiStatus: vi.fn(),
  getAiUsage: vi.fn(),
  startAiJob: vi.fn(),
  getAiJob: vi.fn(),
}));

import { getAiJob, startAiJob } from '../../api/controller';
import { AccuracyDialog, AiRuleTest, describeAi, describeOutcome } from './AiMatching';

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon' },
  { entityId: 'mil', entityName: 'Milford' },
];
const entityName = (id) => ENTITIES.find((e) => e.entityId === id)?.entityName || '—';
const finishedJob = (over) => ({
  finished: true, batchCount: 1, batches: { Succeeded: 1, Failed: 0, Skipped: 0, Stalled: 0, Queued: 0, Running: 0 }, costUsd: 0.12, entities: ENTITIES, ...over,
});

describe('words', () => {
  test('describeAi', () => {
    expect(describeAi({ action: 'Assign', entityId: 'mil' }, entityName)).toBe('Milford');
    expect(describeAi({ action: 'Keep' }, entityName)).toBe('Keep as is');
    expect(describeAi({ action: 'Reclassify', account: { code: '6150', name: 'Breakroom' } }, entityName)).toBe('Reclassify to 6150 Breakroom');
    expect(describeAi({ action: 'DueToFrom', entityId: 'leb' }, entityName)).toBe('Due To/From Lebanon');
    expect(describeAi({ action: 'Unsure' }, entityName)).toBe('Unsure');
    expect(describeAi(null, entityName)).toBeNull();
  });
  test('describeOutcome', () => {
    expect(describeOutcome('entity:leb', entityName)).toBe('Lebanon');
    expect(describeOutcome('due:mil', entityName)).toBe('Due To/From Milford');
    expect(describeOutcome('acct:code:6150', entityName)).toBe('6150');
    expect(describeOutcome('keep', entityName)).toBe('Keep as is');
    expect(describeOutcome(null, entityName)).toBe('—');
  });
});

describe('AccuracyDialog', () => {
  beforeEach(() => {
    startAiJob.mockResolvedValue({ jobId: 'bt1' });
  });

  test('starts a backtest on the file and shows how often the AI agreed', async () => {
    const user = userEvent.setup();
    getAiJob.mockResolvedValue(
      finishedJob({
        summary: { lines: 3, unsure: 1, agree: 1, disagree: 1, byConfidence: [{ level: 'High', lines: 1, agree: 1 }, { level: 'Medium', lines: 1, agree: 0 }, { level: 'Low', lines: 0, agree: 0 }] },
        results: [
          { lineId: 'a', txnDate: '2026-10-02', payeeName: 'Kroger', memo: 'snacks', amount: 10, current: 'entity:mil', aiOutcome: 'entity:leb', matches: false, ai: { confidence: 0.75, reason: 'r' } },
          { lineId: 'b', txnDate: '2026-10-03', payeeName: 'Gusto', memo: 'fee', amount: 20, current: 'entity:leb', aiOutcome: 'entity:leb', matches: true, ai: { confidence: 0.95, reason: 'r' } },
          { lineId: 'c', txnDate: '2026-10-04', payeeName: 'X', memo: 'y', amount: 30, current: 'entity:leb', aiOutcome: null, matches: false, ai: { confidence: 0.2, reason: 'r' } },
        ],
      })
    );
    render(<AccuracyDialog open groupId="g1" qboId="mgmt" month="2026-10" entityName={entityName} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Start check' }));
    expect(startAiJob).toHaveBeenCalledWith('g1', { kind: 'Backtest', qboId: 'mgmt', month: '2026-10' });
    expect(await screen.findByText(/The AI agreed with you on 1 of 2 lines \(50%\), and was unsure about 1\. Cost \$0.12\./)).toBeInTheDocument();
    expect(screen.getByText(/High 1 of 1 · Medium 0 of 1/)).toBeInTheDocument();
    expect(screen.getByText('Differs')).toBeInTheDocument();
    expect(screen.getByText('Lebanon (75%)')).toBeInTheDocument();
  });
});

describe('AiRuleTest', () => {
  test('tests the draft written rule and lists the lines it would change', async () => {
    const user = userEvent.setup();
    startAiJob.mockResolvedValue({ jobId: 'rt1' });
    getAiJob
      .mockResolvedValueOnce({ finished: false, batchCount: 2, batches: { Succeeded: 0, Failed: 0, Skipped: 0, Stalled: 0, Queued: 2, Running: 0 } })
      .mockResolvedValue(
        finishedJob({
          summary: { lines: 2, unsure: 0, agree: 1, disagree: 1 },
          results: [
            { lineId: 'a', txnDate: '2026-10-02', memo: 'Main St', amount: 50, current: 'entity:mil', aiOutcome: 'entity:leb', matches: false, ai: { confidence: 0.9, reason: 'Rule: Main St is Lebanon' } },
            { lineId: 'b', txnDate: '2026-10-03', memo: 'other', amount: 20, current: 'entity:leb', aiOutcome: 'entity:leb', matches: true, ai: { confidence: 0.8, reason: 'r' } },
          ],
        })
      );
    render(<AiRuleTest groupId="g1" vendorId="v1" ruleText="Main St is Lebanon" entities={ENTITIES} />);
    await user.click(screen.getByRole('button', { name: 'Test with AI' }));
    expect(startAiJob).toHaveBeenCalledWith('g1', { kind: 'RuleTest', vendorId: 'v1', ruleText: 'Main St is Lebanon', months: 3 });
    expect(await screen.findByText(/2 lines: with this rule the AI would label 1 differently from now, 1 the same/, {}, { timeout: 7000 })).toBeInTheDocument();
    expect(screen.getByText('Rule: Main St is Lebanon')).toBeInTheDocument();
    expect(screen.getByText('Lebanon (90%)')).toBeInTheDocument();
  }, 10000);

  test('needs a written rule', () => {
    render(<AiRuleTest groupId="g1" vendorId="v1" ruleText="  " entities={ENTITIES} />);
    expect(screen.getByRole('button', { name: 'Test with AI' })).toBeDisabled();
  });
});
