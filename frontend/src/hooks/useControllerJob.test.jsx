import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../api/controller', () => ({ getControllerJob: vi.fn() }));

import { getControllerJob } from '../api/controller';
import useControllerJob, { POLL_INTERVAL_MS, isJobActive } from './useControllerJob';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => act(async () => {});

describe('useControllerJob', () => {
  test('polls while the job runs and calls onFinished once at the end', async () => {
    getControllerJob
      .mockResolvedValueOnce({ jobId: 'j', status: 'Queued' })
      .mockResolvedValueOnce({ jobId: 'j', status: 'Running' })
      .mockResolvedValueOnce({ jobId: 'j', status: 'Succeeded' });
    const onFinished = vi.fn();

    const { result } = renderHook(() => useControllerJob('g', 'j', onFinished));
    await flush();
    expect(result.current.job.status).toBe('Queued');

    await act(async () => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(result.current.job.status).toBe('Running');

    await act(async () => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(result.current.job.status).toBe('Succeeded');
    expect(onFinished).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(POLL_INTERVAL_MS * 3));
    expect(getControllerJob).toHaveBeenCalledTimes(3);
    expect(getControllerJob).toHaveBeenCalledWith('g', 'j');
  });

  test('does nothing without a job', async () => {
    renderHook(() => useControllerJob('g', null, vi.fn()));
    await flush();
    expect(getControllerJob).not.toHaveBeenCalled();
  });

  test('keeps retrying after a network error', async () => {
    getControllerJob.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'Failed' });
    const { result } = renderHook(() => useControllerJob('g', 'j', vi.fn()));
    await flush();
    expect(result.current.error.message).toBe('offline');
    await act(async () => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(result.current.job.status).toBe('Failed');
    expect(result.current.error).toBeNull();
  });

  test('isJobActive', () => {
    expect(isJobActive({ status: 'Running' })).toBe(true);
    expect(isJobActive({ status: 'PartiallyFailed' })).toBe(false);
    expect(isJobActive(null)).toBe(false);
  });
});
