import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { listGroups } from '../api/settings';

const PLATFORM_ROLES = ['SoftwareAdmin', 'SoftwareRep'];

// Owner/Manager/TeamMember are tied to one Group (custom:groupId on their
// Cognito user), so pages can just use that. SoftwareAdmin/SoftwareRep are
// platform-level — no fixed Group — so pages they can reach (QBO Setup,
// QBO Data Sync) need an explicit Group selector instead. This hook picks
// whichever applies and, for platform roles, fetches the Group list to
// pick from.
export default function useEffectiveGroup() {
  const { role, groupId: ownGroupId } = useAuth();
  const needsGroupSelector = PLATFORM_ROLES.includes(role);

  const [groups, setGroups] = useState([]);
  const [groupsError, setGroupsError] = useState(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');

  useEffect(() => {
    if (!needsGroupSelector) return;
    listGroups()
      .then(setGroups)
      .catch(setGroupsError);
  }, [needsGroupSelector]);

  return {
    groupId: needsGroupSelector ? selectedGroupId || null : ownGroupId,
    needsGroupSelector,
    groups,
    groupsError,
    selectedGroupId,
    setSelectedGroupId,
  };
}
