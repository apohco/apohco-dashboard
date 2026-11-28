import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { inviteUser, listUsers, updateUser, userAction } from '../../api/settings';

const PLATFORM_ROLES = ['SoftwareAdmin', 'SoftwareRep'];
const ROLE_LABELS = {
  SoftwareAdmin: 'Software Admin',
  SoftwareRep: 'Software Rep',
  Owner: 'Owner',
  Manager: 'Manager',
  TeamMember: 'Team Member',
};
const STATUS_LABELS = {
  CONFIRMED: 'Active',
  FORCE_CHANGE_PASSWORD: 'Invited',
  RESET_REQUIRED: 'Password reset sent',
  UNCONFIRMED: 'Unconfirmed',
};

// What each row action does, as shown in the confirmation dialog.
export const ACTIONS = {
  'resend-invite': {
    label: 'Resend invite',
    confirm: (u) => `Email ${u.username} a new temporary password?`,
    done: 'Invite sent.',
  },
  'reset-password': {
    label: 'Send password reset',
    confirm: (u) => `Email ${u.username} a reset code? Their current password stops working and they're signed out.`,
    done: 'Reset code sent.',
  },
  'reset-mfa': {
    label: 'Reset authenticator app',
    confirm: (u) => `Remove ${u.username}'s authenticator app? They'll set up a new one at their next sign-in, and they're signed out now.`,
    done: 'Authenticator reset.',
  },
  disable: {
    label: 'Disable account',
    confirm: (u) => `Disable ${u.username}? They're signed out and can't sign in until re-enabled.`,
    done: 'Account disabled.',
  },
  enable: {
    label: 'Re-enable account',
    confirm: (u) => `Re-enable ${u.username}?`,
    done: 'Account re-enabled.',
  },
};

const errorText = (err) => err?.response?.data?.message || err?.message;

// Which actions make sense for a user right now.
export function availableActions(user) {
  if (user.isSelf || user.isProtected || user.isAccountant) return [];
  if (!user.enabled) return ['enable'];
  const actions = [];
  if (user.status === 'FORCE_CHANGE_PASSWORD') actions.push('resend-invite');
  else actions.push('reset-password');
  if (user.mfaEnabled) actions.push('reset-mfa');
  actions.push('disable');
  return actions;
}

function UserDialog({ open, user, groups, onClose, onSaved }) {
  const isNew = !user;
  const [form, setForm] = useState({ username: '', email: '', role: 'TeamMember', groupId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      user
        ? { username: user.username, email: user.email || '', role: user.role || 'TeamMember', groupId: user.groupId || '' }
        : { username: '', email: '', role: 'TeamMember', groupId: groups.length === 1 ? groups[0].groupId : '' }
    );
  }, [open, user, groups]);

  const isPlatform = PLATFORM_ROLES.includes(form.role);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const valid = form.email.trim() && (isNew ? form.username.trim() : true) && (isPlatform || form.groupId);

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = { email: form.email.trim(), role: form.role, groupId: isPlatform ? null : form.groupId };
    try {
      if (isNew) await inviteUser({ username: form.username.trim(), ...payload });
      else await updateUser(user.username, payload);
      onSaved(isNew ? `Invite emailed to ${payload.email}.` : 'User updated.');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{isNew ? 'Invite user' : `Edit ${user.username}`}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
        {isNew && (
          <TextField
            fullWidth
            size="small"
            label="Username"
            helperText="What they sign in with. Letters, numbers, dot, dash or underscore."
            value={form.username}
            onChange={set('username')}
            sx={{ mt: 1, mb: 2 }}
            autoFocus
          />
        )}
        <TextField
          fullWidth
          size="small"
          type="email"
          label="Email"
          helperText={isNew ? 'The invite and any password resets go here.' : 'Saving marks this email verified, so password resets work.'}
          value={form.email}
          onChange={set('email')}
          sx={{ mt: isNew ? 0 : 1, mb: 2 }}
        />
        <TextField select fullWidth size="small" label="Role" value={form.role} onChange={set('role')} sx={{ mb: 2 }}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </TextField>
        {!isPlatform && (
          <TextField select fullWidth size="small" label="Practice" value={form.groupId} onChange={set('groupId')} sx={{ mb: 1 }}>
            {groups.map((g) => (
              <MenuItem key={g.groupId} value={g.groupId}>
                {g.groupName}
              </MenuItem>
            ))}
          </TextField>
        )}
        {!isNew && (form.role !== user.role || (!isPlatform && form.groupId !== (user.groupId || ''))) && (
          <Alert severity="info" sx={{ mt: 1 }}>
            Changing role or practice signs {user.username} out so the change takes effect.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving || !valid}>
          {saving ? 'Saving...' : isNew ? 'Send invite' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function UserManagement() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dialog, setDialog] = useState({ open: false, user: null });
  const [menu, setMenu] = useState({ anchor: null, user: null });
  const [pending, setPending] = useState(null); // { user, action }
  const [working, setWorking] = useState(false);

  const load = useCallback(() => {
    setError(null);
    listUsers().then(setData).catch(setError);
  }, []);

  useEffect(load, [load]);

  const runAction = async () => {
    const { user, action } = pending;
    setWorking(true);
    try {
      await userAction(user.username, action);
      setNotice(`${user.username}: ${ACTIONS[action].done}`);
      setPending(null);
      load();
    } catch (err) {
      setError(err);
      setPending(null);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h1">Users</Typography>
        <Button variant="contained" disabled={!data} onClick={() => setDialog({ open: true, user: null })}>
          Invite user
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}
      {!data && !error && <CircularProgress size={24} />}

      {data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Username</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Practice</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Authenticator</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {data.users.map((u) => {
                const actions = availableActions(u);
                return (
                  <TableRow key={u.username} sx={!u.enabled ? { '& td': { color: 'text.disabled' } } : undefined}>
                    <TableCell>
                      {u.username}
                      {u.isSelf && <Chip size="small" label="You" sx={{ ml: 1 }} />}
                      {u.isAccountant && (
                        <Tooltip title="Accountant portal login: manage it in Controller > Accountants">
                          <Chip size="small" variant="outlined" label="AJE portal" sx={{ ml: 1 }} />
                        </Tooltip>
                      )}
                      {u.isProtected && (
                        <Tooltip title="Protected account: can only be changed from the AWS CLI">
                          <LockOutlinedIcon fontSize="inherit" sx={{ ml: 1, verticalAlign: 'middle' }} aria-label="protected account" />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.email}
                      {u.email && !u.emailVerified && (
                        <Tooltip title="Not verified: password reset emails can't be sent. Edit and save the email to verify it.">
                          <Chip size="small" color="warning" variant="outlined" label="Unverified" sx={{ ml: 1 }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>{ROLE_LABELS[u.role] || u.role || '—'}</TableCell>
                    <TableCell>{u.groupName || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={u.enabled ? STATUS_LABELS[u.status] || u.status : 'Disabled'}
                        color={!u.enabled ? 'default' : u.status === 'CONFIRMED' ? 'success' : 'warning'}
                      />
                    </TableCell>
                    <TableCell>{u.mfaEnabled === null ? '—' : u.mfaEnabled ? 'Set up' : 'Not yet'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {!u.isSelf && !u.isProtected && !u.isAccountant && u.enabled && (
                        <Button size="small" onClick={() => setDialog({ open: true, user: u })}>
                          Edit
                        </Button>
                      )}
                      {actions.length > 0 && (
                        <IconButton size="small" aria-label={`More actions for ${u.username}`} onClick={(e) => setMenu({ anchor: e.currentTarget, user: u })}>
                          <MoreVertIcon fontSize="small" />
                        </IconButton>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Menu anchorEl={menu.anchor} open={Boolean(menu.anchor)} onClose={() => setMenu({ anchor: null, user: null })}>
        {menu.user &&
          availableActions(menu.user).map((action) => (
            <MenuItem
              key={action}
              onClick={() => {
                setPending({ user: menu.user, action });
                setMenu({ anchor: null, user: null });
              }}
            >
              {ACTIONS[action].label}
            </MenuItem>
          ))}
      </Menu>

      <Dialog open={Boolean(pending)} onClose={() => !working && setPending(null)}>
        {pending && (
          <>
            <DialogTitle>{ACTIONS[pending.action].label}</DialogTitle>
            <DialogContent>
              <DialogContentText>{ACTIONS[pending.action].confirm(pending.user)}</DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPending(null)} disabled={working}>
                Cancel
              </Button>
              <Button variant="contained" color={pending.action === 'disable' ? 'error' : 'primary'} onClick={runAction} disabled={working}>
                {working ? 'Working...' : 'Confirm'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {data && (
        <UserDialog
          open={dialog.open}
          user={dialog.user}
          groups={data.groups}
          onClose={() => setDialog({ open: false, user: null })}
          onSaved={(message) => {
            setDialog({ open: false, user: null });
            setNotice(message);
            load();
          }}
        />
      )}
    </Box>
  );
}
