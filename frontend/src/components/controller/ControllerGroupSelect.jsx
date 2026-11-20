import { Alert, MenuItem, Select } from '@mui/material';

export default function ControllerGroupSelect({ groups, groupId, setGroupId, groupsError }) {
  if (groupsError) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        Could not load Groups: {groupsError.response?.data?.message || groupsError.message}
      </Alert>
    );
  }
  if (groups.length <= 1) return null;
  return (
    <Select
      size="small"
      displayEmpty
      value={groupId || ''}
      onChange={(e) => setGroupId(e.target.value)}
      sx={{ mb: 2, minWidth: 280 }}
      inputProps={{ 'aria-label': 'Group' }}
    >
      <MenuItem value="" disabled>
        Select a Group
      </MenuItem>
      {groups.map((g) => (
        <MenuItem key={g.groupid} value={g.groupid}>
          {g.groupname}
        </MenuItem>
      ))}
    </Select>
  );
}
