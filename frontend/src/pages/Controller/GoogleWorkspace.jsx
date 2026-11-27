// Controller → Google Workspace: the connection used for evidence (Phase 4),
// the Gmail mailboxes that may be searched, and the invoice folders that
// are indexed (Drive is indexed only inside these folders).
import { useCallback, useEffect, useRef, useState } from 'react';
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
  DialogContentText,
  DialogTitle,
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
import {
  addGoogleFolder,
  getGoogleDirectory,
  getGoogleSettings,
  indexGoogleFolder,
  removeGoogleFolder,
  saveGoogleSettings,
  setGoogleSource,
  testGoogleConnection,
} from '../../api/controller';

const errorText = (err) => err?.response?.data?.message || err?.message;
export const FOLDER_POLL_MS = 5000;
const isIndexing = (f) => ['Scanning', 'Indexing'].includes(f.lastRun?.status);

// One line about a folder's index.
export function folderStatus(f) {
  const r = f.lastRun;
  if (!r) return 'Not indexed yet';
  if (r.status === 'Scanning') return 'Listing files…';
  if (r.status === 'Indexing') return `Indexing: ${r.indexed + r.failed} of ${r.toIndex} files`;
  if (r.status === 'Failed') return `Failed: ${r.error || 'unknown error'}`;
  const when = r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '';
  return `${f.files ?? 0} file${f.files === 1 ? '' : 's'} indexed (${f.readable ?? 0} readable) · ${when}${r.failed ? ` · ${r.failed} couldn't be read` : ''}`;
}

export default function GoogleWorkspace() {
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [test, setTest] = useState(null);
  const [directory, setDirectory] = useState(null);
  const [addEmail, setAddEmail] = useState('');
  const [folderLink, setFolderLink] = useState('');
  const [folderOwner, setFolderOwner] = useState('');
  const [removing, setRemoving] = useState(null);
  const savedEmail = useRef('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const apply = (d) => {
    setData(d);
    // The field follows the saved value unless the user is editing it.
    const next = d.settings?.adminEmail || '';
    const prev = savedEmail.current;
    setAdminEmail((cur) => (cur === '' || cur === prev ? next : cur));
    savedEmail.current = next;
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
    setAdminEmail('');
    savedEmail.current = '';
    load();
  }, [load]);

  const sources = data?.sources || [];
  const mailboxes = sources.filter((s) => s.kind === 'Mailbox');
  const folders = sources.filter((s) => s.kind === 'Folder');
  const anyIndexing = folders.some(isIndexing);
  // Refresh while a folder is being indexed.
  useEffect(() => {
    if (!anyIndexing) return undefined;
    const t = setTimeout(load, FOLDER_POLL_MS);
    return () => clearTimeout(t);
  }, [anyIndexing, data, load]);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err);
      return false;
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
  const addFolder = () =>
    run('folder', async () => {
      const r = await addGoogleFolder(groupId, folderLink.trim(), folderOwner.trim() || undefined);
      apply(r);
      setFolderLink('');
      setFolderOwner('');
      setNotice(`Added ${r.added.folderPath}. Indexing has started.`);
    });
  const reindex = (f) =>
    run(`index-${f.sourceId}`, async () => {
      await indexGoogleFolder(groupId, f.sourceId);
      await load();
    });
  const remove = (f) =>
    run(`remove-${f.sourceId}`, async () => {
      apply(await removeGoogleFolder(groupId, f.sourceId));
      setNotice(`Removed ${f.displayName} and its index. Saved support is kept.`);
    });

  const settings = data?.settings;
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
              admin to list users. Saved support is filed in a <b>Controller Evidence</b> folder in the admin account's My Drive. Setup
              steps: SETUP.md, section 10.
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
              Invoice folders
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Drive is searched only inside these folders (and their subfolders). PDFs, Google Docs and scans or photos are read and
              re-indexed every night. Paste a folder link from Drive; the folder must be shared with {settings?.adminEmail || 'the admin account'}{' '}
              or be in a shared drive it belongs to — otherwise enter the account that owns it.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Folder</TableCell>
                  <TableCell>Index</TableCell>
                  <TableCell>Searched</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {folders.map((f) => (
                  <TableRow key={f.sourceId}>
                    <TableCell>
                      {f.folderPath || f.displayName}
                      {f.actAs && f.actAs !== settings?.adminEmail && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          Read as {f.actAs}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color={f.lastRun?.status === 'Failed' ? 'error' : 'text.primary'}>
                        {isIndexing(f) && <CircularProgress size={12} sx={{ mr: 1 }} />}
                        {folderStatus(f)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Switch
                        size="small"
                        checked={f.enabled}
                        disabled={Boolean(busy)}
                        onChange={(e) => setSource({ kind: 'Folder', sourceKey: f.sourceKey, enabled: e.target.checked })}
                        inputProps={{ 'aria-label': `Search ${f.displayName}` }}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Button size="small" disabled={Boolean(busy) || !f.enabled || isIndexing(f)} onClick={() => reindex(f)}>
                        Index now
                      </Button>
                      <Button size="small" color="error" disabled={Boolean(busy)} onClick={() => setRemoving(f)}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {folders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>
                      No invoice folders yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 2 }}>
              <TextField size="small" label="Folder link" placeholder="https://drive.google.com/drive/folders/…" value={folderLink} onChange={(e) => setFolderLink(e.target.value)} disabled={!settings} sx={{ flex: 1, minWidth: 300 }} />
              <TextField size="small" label="Owner (only if not shared with the admin)" value={folderOwner} onChange={(e) => setFolderOwner(e.target.value)} disabled={!settings} sx={{ minWidth: 280 }} />
              <Button variant="contained" disabled={!settings || !folderLink.trim() || Boolean(busy)} onClick={addFolder} startIcon={busy === 'folder' ? <CircularProgress size={16} color="inherit" /> : null}>
                Add folder
              </Button>
            </Box>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Gmail mailboxes
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Only the mailboxes switched on here are ever searched.
            </Typography>
            <Table size="small">
              <TableBody>
                {mailboxes.map((s) => (
                  <TableRow key={s.sourceId}>
                    <TableCell>{s.displayName || s.sourceKey}</TableCell>
                    <TableCell align="right">
                      <Switch
                        size="small"
                        checked={s.enabled}
                        disabled={Boolean(busy)}
                        onChange={(e) => setSource({ kind: 'Mailbox', sourceKey: s.sourceKey, enabled: e.target.checked })}
                        inputProps={{ 'aria-label': `Search ${s.sourceKey} (Gmail mailbox)` }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {mailboxes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={2} sx={{ color: 'text.secondary' }}>
                      No mailboxes yet. Save the admin account to start with its mailbox.
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
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" disabled={!settings || Boolean(busy)} onClick={browse} startIcon={busy === 'browse' ? <CircularProgress size={16} /> : null}>
                Browse workspace
              </Button>
            </Box>
            {directory && (
              <Table size="small" sx={{ mt: 2 }} data-testid="directory">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell align="center">Gmail</TableCell>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        </>
      )}

      <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)}>
        <DialogTitle>Remove folder</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Stop searching {removing?.folderPath || removing?.displayName} and delete its index? Files in Drive are not touched, and support
            you already saved is kept.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const f = removing;
              setRemoving(null);
              remove(f);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
