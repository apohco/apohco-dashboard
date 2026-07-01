import { useEffect, useState } from 'react';
import { listQBOs, listConsolidationGroups } from '../api/settings';

// Combines connected QBOs and Consolidation Groups into a single option
// list for report/settings entity selectors. Option ids are prefixed so
// the caller can tell which endpoint a selection maps to:
// "qbo:<qboId>" or "consolidationGroup:<consolidationGroupId>".
export default function useEntityOptions(groupId) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([listQBOs(groupId), listConsolidationGroups(groupId)])
      .then(([qbos, consolidationGroups]) => {
        if (cancelled) return;
        setOptions([
          ...consolidationGroups.map((cg) => ({
            id: `consolidationGroup:${cg.consolidationgroupid}`,
            label: `${cg.consolidationgroupname} (Consolidated)`,
          })),
          ...qbos.map((q) => ({ id: `qbo:${q.qboid}`, label: q.qboname })),
        ]);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  return { options, loading, error };
}

export function parseEntityValue(value) {
  if (!value) return null;
  const [entityType, entityId] = value.split(':');
  return { entityType, entityId };
}
