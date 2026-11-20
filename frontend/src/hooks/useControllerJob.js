import { useEffect, useRef, useState } from 'react';
import { getControllerJob } from '../api/controller';

export const POLL_INTERVAL_MS = 4000;
const ACTIVE_STATUSES = ['Queued', 'Running'];

export const isJobActive = (job) => Boolean(job) && ACTIVE_STATUSES.includes(job.status);

// Polls one Controller pull job until it stops running, then calls
// onFinished(job) once.
export default function useControllerJob(groupId, jobId, onFinished) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (!groupId || !jobId) {
      setJob(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const latest = await getControllerJob(groupId, jobId);
        if (cancelled) return;
        setJob(latest);
        setError(null);
        if (isJobActive(latest)) timer = setTimeout(poll, POLL_INTERVAL_MS);
        else onFinishedRef.current?.(latest);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, jobId]);

  return { job, error };
}
