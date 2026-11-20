const { deriveJobStatus } = require('../../src/shared/ctrlJobs');
const { enqueueTasks } = require('../../src/shared/ctrlQueue');

describe('deriveJobStatus', () => {
  test.each([
    [{ queued: 3 }, 'Queued'],
    [{ queued: 2, running: 1 }, 'Running'],
    [{ queued: 1, succeeded: 2 }, 'Running'],
    [{ succeeded: 3 }, 'Succeeded'],
    [{ failed: 3 }, 'Failed'],
    [{ succeeded: 2, failed: 1 }, 'PartiallyFailed'],
    [{ succeeded: 2, stalled: 1 }, 'PartiallyFailed'],
    [{ stalled: 2 }, 'Stalled'],
    [{}, 'Failed'],
  ])('%j -> %s', (counts, expected) => {
    expect(deriveJobStatus(counts)).toBe(expected);
  });
});

describe('enqueueTasks', () => {
  const queueUrl = 'https://sqs.example/queue';

  test('sends batches of 10 with one { taskId } message each', async () => {
    const sqs = { send: jest.fn().mockResolvedValue({ Failed: [] }) };
    const ids = Array.from({ length: 23 }, (_, i) => `task-${i}`);
    await expect(enqueueTasks(ids, { queueUrl, sqs })).resolves.toEqual([]);

    expect(sqs.send).toHaveBeenCalledTimes(3);
    const firstBatch = sqs.send.mock.calls[0][0].input;
    expect(firstBatch.QueueUrl).toBe(queueUrl);
    expect(firstBatch.Entries).toHaveLength(10);
    expect(JSON.parse(firstBatch.Entries[0].MessageBody)).toEqual({ taskId: 'task-0' });
    expect(sqs.send.mock.calls[2][0].input.Entries).toHaveLength(3);
  });

  test('returns the tasks SQS rejected or could not be sent', async () => {
    const sqs = {
      send: jest
        .fn()
        .mockResolvedValueOnce({ Failed: [{ Id: '1' }] })
        .mockRejectedValueOnce(new Error('network down')),
    };
    const ids = Array.from({ length: 12 }, (_, i) => `task-${i}`);
    const failed = await enqueueTasks(ids, { queueUrl, sqs });
    expect(failed).toEqual(['task-1', 'task-10', 'task-11']);
  });

  test('refuses to run without a queue URL', async () => {
    await expect(enqueueTasks(['t'], { queueUrl: '', sqs: { send: jest.fn() } })).rejects.toThrow('CTRL_GL_PULL_QUEUE_URL');
  });
});
