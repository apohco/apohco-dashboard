import { useEffect, useState } from 'react';
import { listGroups } from '../api/settings';

const STORAGE_KEY = 'apohco.controller.groupId';

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStored(value) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private window etc.): selection just isn't remembered.
  }
}

// The Controller is used by a SoftwareAdmin, who has no fixed Group, so
// every Controller page needs a Group picker. The choice is remembered
// across Controller pages, and picked automatically when there's only one.
export default function useControllerGroup() {
  const [groups, setGroups] = useState([]);
  const [groupsError, setGroupsError] = useState(null);
  const [groupId, setGroupIdState] = useState(readStored);

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((list) => {
        if (cancelled) return;
        setGroups(list);
        setGroupIdState((current) => {
          if (current && list.some((g) => g.groupid === current)) return current;
          const next = list.length === 1 ? list[0].groupid : '';
          writeStored(next);
          return next;
        });
      })
      .catch((err) => !cancelled && setGroupsError(err));
    return () => {
      cancelled = true;
    };
  }, []);

  const setGroupId = (value) => {
    writeStored(value);
    setGroupIdState(value);
  };

  return { groupId: groupId || null, groups, groupsError, setGroupId };
}
