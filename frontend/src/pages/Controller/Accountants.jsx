import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import {
  accountantAction,
  getAccountants,
  inviteAccountant,
  saveAccountantNotifySettings,
  sendAccountantNotifyTest,
  updateAccountant,
} from '../../api/controller';
import { formatWhen } from '../../components/aje/AjeParts';

const errorText = (err) => err?.response?.data?.message || err?.message;

// "casey.smith@firm.com" -> "casey.smith" (letters, digits, . _ - only).
export function suggestUsername(email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '');
  return local.length >= 3 ? local.slice(0, 64) : local ? `${local}.cpa` : '';
}

export function accessLabel(a, files) {
  if (!a.hasAccess) return 'No access to this Group';
  if (!a.qboIds) return 'All files';
  const names = a.qboIds.map((id) => files.find((f) => f.qboId === id)?.qboName).filter(Boolean);
  return names.length === 1 ? names[0] : `${names.length} files`;
}

const LOGIN_LABELS = {
  InvitePending: ['Invite sent', 'info'],
  Active: ['Active', 'success'],
  Disabled: ['Disabled', 'default'],
  Missing: ['Login missing', 'error'],
};

function AccountantDialog({ open, files, accountant, onClose, onSave }) {
  const isNew = !accountant;
  const [form, setForm] = useState({});
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setUsernameTouched(false);
    setForm({
      fullName: accountant?.fullName || '',
      email: accountant?.email || '',
      username: accountant?.username || '',
      firm: accountant?.firm || '',
      notifyByEmail: accountant ? accountant.notifyByEmail : true,
      allFiles: accountant ? !accountant.hasAccess || !accountant.qboIds : true,
      qboIds: accountant?.qboIds || [],
      grant: accountant ? accountant.hasAccess : true,
    });
  }, [open, accountant]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const toggleFile = (qboId) => set({ qboIds: form.qboIds.includes(qboId) ? form.qboIds.filter((x) => x !== qboId) : [...form.qboIds, qboId] });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const access = form.grant ? { qboIds: form.allFiles ? null : form.qboIds } : { access: false };
      const body = { fullName: form.fullName, email: form.email, firm: form.firm, notifyByEmail: form.notifyByEmail };
      await onSave(isNew ? { ...body, username: form.username, qboIds: access.qboIds } : { ...body, ...access });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const filesOk = !form.grant || form.allFiles || form.qboIds?.length > 0;
  const valid = form.fullName?.trim() && form.email?.trim() && (!isNew || form.username?.trim()) && filesOk;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isNew ? 'Add accountant' : `Edit ${accountant.fullName}`}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={form.fullName || ''} onChange={(e) => set({ fullName: e.target.value })} inputProps={{ maxLength: 200 }} required />
          <TextField
            label="Email"
            type="email"
            value={form.email || ''}
            onChange={(e) => set({ email: e.target.value, ...(isNew && !usernameTouched ? { username: suggestUsername(e.target.value) } : {}) })}
            helperText={isNew ? 'The sign-in invite and a temporary password go here.' : 'Changing it updates their sign-in email.'}
            required
          />
          {isNew && (
            <TextField
              label="Username"
              value={form.username || ''}
              onChange={(e) => {
                setUsernameTouched(true);
                set({ username: e.target.value });
              }}
              helperText="What they type to sign in. Letters, numbers, dot, dash or underscore."
              required
            />
          )}
          <TextField label="Firm (optional)" value={form.firm || ''} onChange={(e) => set({ firm: e.target.value })} inputProps={{ maxLength: 200 }} />
          <Box>
            {!isNew && (
              <FormControlLabel control={<Switch checked={Boolean(form.grant)} onChange={(e) => set({ grant: e.target.checked })} />} label="Can see this Group's reports" />
            )}
            {form.grant && (
              <>
                <RadioGroup value={form.allFiles ? 'all' : 'some'} onChange={(e) => set({ allFiles: e.target.value === 'all' })}>
                  <FormControlLabel value="all" control={<Radio size="small" />} label="All files, including ones added later" />
                  <FormControlLabel value="some" control={<Radio size="small" />} label="Only these files" />
                </RadioGroup>
                {!form.allFiles && (
                  <FormGroup sx={{ pl: 4 }}>
                    {files.map((f) => (
                      <FormControlLabel
                        key={f.qboId}
                        control={<Checkbox size="small" checked={form.qboIds.includes(f.qboId)} onChange={() => toggleFile(f.qboId)} />}
                        label={f.qboName}
                      />
                    ))}
                  </FormGroup>
                )}
              </>
            )}
          </Box>
          <FormControlLabel
            control={<Checkbox checked={Boolean(form.notifyByEmail)} onChange={(e) => set({ notifyByEmail: e.target.checked })} />}
            label="Email them when a report is published or a question is answered (if email is on)"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!valid || busy}>{busy ? 'Saving…' : isNew ? 'Send invite' : 'Save'}</Button>
      </DialogActions>
    </Dialog>
  );
}

function NotifyCard({ notify, onSave, onTest }) {
  const [controllerEmail, setControllerEmail] = useState(notify.controllerEmail || '');
  useEffect(() => setControllerEmail(notify.controllerEmail || ''), [notify.controllerEmail]);
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>Email notifications</Typography>
      {!notify.googleConnected ? (
        <Alert severity="info">Connect Google Workspace (Controller → Google Workspace) to send notification emails. The portal works without them.</Alert>
      ) : (
        <>
          <FormControlLabel
            control={<Switch checked={notify.emailEnabled} onChange={(e) => onSave({ emailEnabled: e.target.checked, controllerEmail: controllerEmail || null })} />}
            label={`Send emails from ${notify.senderEmail}`}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Accountants get an email when a report is published and when you answer their question; you get one when they ask. Needs the
            gmail.send scope on the service account&apos;s domain-wide delegation.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              label="Send questions to"
              placeholder={notify.senderEmail}
              value={controllerEmail}
              onChange={(e) => setControllerEmail(e.target.value)}
              sx={{ minWidth: 300 }}
            />
            <Button onClick={() => onSave({ emailEnabled: notify.emailEnabled, controllerEmail: controllerEmail || null })}>Save</Button>
            <Button onClick={onTest} disabled={!notify.emailEnabled}>Send test email</Button>
          </Stack>
        </>
      )}
    </Paper>
  );
}

// Controller > Accountants: who can sign in to the AJE portal, and what they see.
export default function Accountants() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [dialog, setDialog] = useState(null); // { accountant } (null accountant = new)
  const [menu, setMenu] = useState(null); // { anchor, accountant }

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      setData(await getAccountants(groupId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [groupId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const run = async (fn, done) => {
    setError(null);
    try {
      const result = await fn();
      if (result && result.accountants) setData(result);
      else await load();
      if (done) setMessage(done);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async (body) => {
    const accountant = dialog.accountant;
    if (accountant) {
      setData(await updateAccountant(groupId, accountant.accountantId, body));
      setMessage(`Saved ${body.fullName}.`);
    } else {
      await inviteAccountant(groupId, body);
      await load();
      setMessage(`Invite sent to ${body.email}. They'll set a password and an authenticator app at first sign-in.`);
    }
    setDialog(null);
  };

  const action = (a, name, done) => {
    setMenu(null);
    run(() => accountantAction(groupId, a.accountantId, name), done);
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h5" sx={{ flex: 1 }}>Accountants</Typography>
        <Button variant="contained" onClick={() => setDialog({ accountant: null })} disabled={!data}>Add accountant</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Accountants sign in to a separate AJE portal. They see only the reports you publish for their files, with the saved supporting PDFs, and
        nothing else in the dashboard.
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {message && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage(null)}>{message}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}
      {data && (
        <>
          <NotifyCard
            notify={data.notify}
            onSave={(body) => run(async () => { await saveAccountantNotifySettings(groupId, body); }, 'Email settings saved.')}
            onTest={() => run(async () => { await sendAccountantNotifyTest(groupId); }, 'Test email queued; it arrives within about 5 minutes.')}
          />
          {!data.accountants.length ? (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Typography color="text.secondary">No accountants yet. Add each person on the team who should work your AJE reports.</Typography>
            </Paper>
          ) : (
            <Paper variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Firm</TableCell>
                    <TableCell>Email / username</TableCell>
                    <TableCell>Sign-in</TableCell>
                    <TableCell>Can see</TableCell>
                    <TableCell>Last active</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.accountants.map((a) => {
                    const [label, color] = a.active ? LOGIN_LABELS[a.loginStatus] || LOGIN_LABELS.Missing : ['Deactivated', 'default'];
                    return (
                      <TableRow key={a.accountantId} sx={{ opacity: a.active ? 1 : 0.6 }}>
                        <TableCell>{a.fullName}</TableCell>
                        <TableCell>{a.firm || '—'}</TableCell>
                        <TableCell>
                          <Typography variant="body2">{a.email}</Typography>
                          <Typography variant="caption" color="text.secondary">{a.username}</Typography>
                        </TableCell>
                        <TableCell><Chip size="small" color={color} label={label} /></TableCell>
                        <TableCell>
                          {accessLabel(a, data.files)}
                          {a.otherGroups > 0 && <Typography variant="caption" color="text.secondary" display="block">+ {a.otherGroups} other Group{a.otherGroups === 1 ? '' : 's'}</Typography>}
                        </TableCell>
                        <TableCell>{a.lastActiveAt ? formatWhen(a.lastActiveAt) : 'Never'}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" aria-label={`Actions for ${a.fullName}`} onClick={(e) => setMenu({ anchor: e.currentTarget, accountant: a })}>
                            <MoreVertIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Paper>
          )}
        </>
      )}
      <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
        {menu && [
          <MenuItem key="edit" onClick={() => { setDialog({ accountant: menu.accountant }); setMenu(null); }}>Edit details and access</MenuItem>,
          menu.accountant.active && menu.accountant.loginStatus === 'InvitePending' && (
            <MenuItem key="resend" onClick={() => action(menu.accountant, 'resend-invite', 'Invite re-sent.')}>Resend invite</MenuItem>
          ),
          menu.accountant.active && menu.accountant.loginStatus === 'Active' && (
            <MenuItem key="pw" onClick={() => action(menu.accountant, 'reset-password', 'A reset code was emailed to them.')}>Reset password</MenuItem>
          ),
          menu.accountant.active && menu.accountant.loginStatus === 'Active' && (
            <MenuItem key="mfa" onClick={() => action(menu.accountant, 'reset-mfa', 'They will set up a new authenticator app at next sign-in.')}>Reset authenticator app</MenuItem>
          ),
          menu.accountant.active ? (
            <MenuItem key="off" onClick={() => action(menu.accountant, 'deactivate', `${menu.accountant.fullName} can no longer sign in.`)} sx={{ color: 'error.main' }}>
              Deactivate
            </MenuItem>
          ) : (
            <MenuItem key="on" onClick={() => action(menu.accountant, 'reactivate', `${menu.accountant.fullName} can sign in again.`)}>Reactivate</MenuItem>
          ),
        ].filter(Boolean)}
      </Menu>
      <AccountantDialog open={Boolean(dialog)} files={data?.files || []} accountant={dialog?.accountant || null} onClose={() => setDialog(null)} onSave={save} />
    </Box>
  );
}
