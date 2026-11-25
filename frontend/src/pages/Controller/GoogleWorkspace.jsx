// Controller → Google Workspace: the connection used for evidence (Phase 4)
// and the opt-in list of mailboxes and Drives that may be searched.
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Paper,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import { getGoogleDirectory, getGoogleSettings, saveGoogleSettings, setGoogleSource, testGoogleConnection } from '../../api/controller';

const errorText = (err) => err?.response?.data?.message || err?.message;
export const KIND_LABELS = { Mailbox: 'Gmail mailbox', UserDrive: 'My Drive', SharedDrive: 'Shared drive' };

export default function GoogleWorkspace() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [test, setTest] = useState(null);
  const [directory, setDirectory] = useState(null);
  const [addEmail, setAddEmail] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const apply = (d) => {
    setData(d);
    setAdminEmail(d.settings?.adminEmail || '');
  };
  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      apply(await getGoogleSettings(groupId));
    } catch (err) {
      setError(err);
    }
  }, [groupId]);
  useEffect(() => {
    setData(null);
    setTest(null);
    setDirectory(null);
    load();
  }, [load]);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run('save', async () => {
      apply(await saveGoogleSettings(groupId, adminEmail));
      setNotice('Saved. Test the connection next.');
    });
  const runTest = () =>
    run('test', async () => {
      setTest(await testGoogleConnection(groupId));
      await load();
    });
  const browse = () => run('browse', async () => setDirectory(await getGoogleDirectory(groupId)));
  const setSource = (source) =>
    run('source', async () => {
      apply(await setGoogleSource(groupId, source));
      if (directory) setDirectory(await getGoogleDirectory(groupId));
    });

  const settings = data?.settings;
  const sources = data?.sources || [];
  const lastTest = test ? { ok: test.ok } : settings?.lastTest;

  return (
    <Box>
      <Typography variant="h1" sx={{ mb: 2 }}>
        Google Workspace
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{errorText(error)}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}

      {data && (
        <>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Connection
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The dashboard reads mail and files through a Google service account with domain-wide delegation, acting as the workspace
              admin to list users and drives. Saved evidence will go to a <b>Controller Evidence</b> folder in the admin account's My Drive.
              Setup steps: SETUP.md, section 10.
            </Typography>
            {!data.keyConfigured && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                The service account key is not configured on the server yet.
              </Alert>
            )}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField size="small" label="Workspace admin account" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} sx={{ minWidth: 280 }} />
              <Button variant="outlined" onClick={save} disabled={Boolean(busy) || !adminEmail.trim() || adminEmail.trim() === settings?.adminEmail}>
                Save
              </Button>
              <Button variant="contained" onClick={runTest} disabled={Boolean(busy) || !settings} startIcon={busy === 'test' ? <CircularProgress size={16} color="inherit" /> : null}>
                Test connection
              </Button>
              {lastTest && <Chip size="small" color={lastTest.ok ? 'success' : 'error'} label={lastTest.ok ? 'Connected' : 'Not working'} />}
              {settings?.domain && (
                <Typography variant="body2" color="text.secondary">
                  Workspace: {settings.domain}
                </Typography>
              )}
            </Box>
            {test && (
              <Box component="ul" sx={{ mt: 1, mb: 0 }} data-testid="test-checks">
                {test.checks.map((c) => (
                  <li key={c.name}>
                    <Typography variant="body2" color={c.ok ? 'text.primary' : 'error'}>
                      {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
                    </Typography>
                  </li>
                ))}
              </Box>
            )}
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Sources searched for evidence
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Only the sources switched on here are ever searched. Gmail is searched now; Drives will be searched once the Drive index
              arrives.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Source</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Searched</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map((s) => (
                  <TableRow key={s.sourceId}>
                    <TableCell>{s.displayName || s.sourceKey}</TableCell>
                    <TableCell>{KIND_LABELS[s.kind]}</TableCell>
                    <TableCell>
                      <Switch
                        size="small"
                        checked={s.enabled}
                        disabled={Boolean(busy)}
                        onChange={(e) => setSource({ kind: s.kind, sourceKey: s.sourceKey, enabled: e.target.checked })}
                        inputProps={{ 'aria-label': `Search ${s.sourceKey} (${KIND_LABELS[s.kind]})` }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {sources.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} sx={{ color: 'text.secondary' }}>
                      No sources yet. Save the admin account to start with its mailbox.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 2 }}>
              <TextField size="small" label="Workspace account" placeholder={settings?.domain ? `name@${settings.domain}` : ''} value={addEmail} onChange={(e) => setAddEmail(e.target.value)} disabled={!settings} />
              <Button size="small" disabled={!settings || !addEmail.trim() || Boolean(busy)} onClick={() => setSource({ kind: 'Mailbox', sourceKey: addEmail.trim(), enabled: true }).then((ok) => ok && setAddEmail(''))}>
                Add mailbox
              </Button>
              <Button size="small" disabled={!settings || !addEmail.trim() || Boolean(busy)} onClick={() => setSource({ kind: 'UserDrive', sourceKey: addEmail.trim(), enabled: true }).then((ok) => ok && setAddEmail(''))}>
                Add My Drive
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" disabled={!settings || Boolean(busy)} onClick={browse} startIcon={busy === 'browse' ? <CircularProgress size={16} /> : null}>
                Browse workspace
              </Button>
            </Box>
          </Paper>

          {directory && (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="directory">
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                Workspace users
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell align="center">Gmail</TableCell>
                    <TableCell align="center">My Drive</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {directory.users.map((u) => (
                    <TableRow key={u.email}>
                      <TableCell>
                        {u.name}
                        {u.suspended && <Chip size="small" label="Suspended" sx={{ ml: 1 }} />}
                      </TableCell>
                      <TableCell>{u.email}</TableCell>
                      <TableCell align="center">
                        <Checkbox size="small" checked={u.mailbox} disabled={Boolean(busy)} inputProps={{ 'aria-label': `Gmail ${u.email}` }} onChange={(e) => setSource({ kind: 'Mailbox', sourceKey: u.email, displayName: u.name, enabled: e.target.checked })} />
                      </TableCell>
                      <TableCell align="center">
                        <Checkbox size="small" checked={u.drive} disabled={Boolean(busy)} inputProps={{ 'aria-label': `My Drive ${u.email}` }} onChange={(e) => setSource({ kind: 'UserDrive', sourceKey: u.email, displayName: u.name, enabled: e.target.checked })} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mt: 2, mb: 1 }}>
                Shared drives
              </Typography>
              {directory.sharedDrives.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No shared drives in this workspace.
                </Typography>
              ) : (
                <Table size="small">
                  <TableBody>
                    {directory.sharedDrives.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>{d.name}</TableCell>
                        <TableCell align="right">
                          <Checkbox size="small" checked={d.enabled} disabled={Boolean(busy)} inputProps={{ 'aria-label': `Shared drive ${d.name}` }} onChange={(e) => setSource({ kind: 'SharedDrive', sourceKey: d.id, displayName: d.name, enabled: e.target.checked })} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}
