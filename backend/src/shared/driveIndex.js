// Controller Phase 4b: the invoice-folder index. Only folders Paul added
// (CtrlGoogleSources Kind 'Folder', enabled) are listed and read, each as
// its ActAs account. Text and metadata are kept; files are not copied.
//
//   startFolderIndex  a new pass over one folder (queues a 'scan')
//   scanFolder        lists the folder tree, drops removed files, queues
//                     changed files in small 'files' messages
//   indexFiles        reads a few files and stores their text
//   scheduleNightly   queues a pass for every enabled folder
const { query } = require('./db');
const google = require('./googleApi');
const { enqueueDriveIndex } = require('./ctrlQueue');
const { extractFile, extractAmounts, extractDates } = require('./docText');

const FILES_PER_MESSAGE = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const GDOC = 'application/vnd.google-apps.document';
const INDEXED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'text/plain', 'text/csv', GDOC];

const versionOf = (f) => `${f.modifiedTime || ''}|${f.size || ''}`;
const errorText = (e) => String(e?.message || e).slice(0, 1000);

async function loadFolderSource(sourceId) {
  const { rows } = await query(
    `SELECT SourceId, GroupId, SourceKey, DisplayName, FolderPath, ActAs, Enabled FROM CtrlGoogleSources WHERE SourceId = $1 AND Kind = 'Folder'`,
    [sourceId]
  );
  return rows[0] || null;
}

async function startFolderIndex(groupId, sourceId, trigger = 'Manual') {
  const { rows: running } = await query(
    `SELECT IndexRunId FROM CtrlDriveIndexRuns WHERE SourceId = $1 AND Status IN ('Scanning', 'Indexing') AND StartedAt > now() - interval '2 hours'`,
    [sourceId]
  );
  if (running.length) return { indexRunId: running[0].indexrunid, alreadyRunning: true };
  const { rows } = await query(
    `INSERT INTO CtrlDriveIndexRuns (GroupId, SourceId, Trigger) VALUES ($1, $2, $3) RETURNING IndexRunId`,
    [groupId, sourceId, trigger]
  );
  const indexRunId = rows[0].indexrunid;
  const failed = await enqueueDriveIndex([{ type: 'scan', indexRunId }]);
  if (failed.length) await finishRun(indexRunId, 'Failed', 'Could not be queued');
  return { indexRunId, alreadyRunning: false };
}

async function finishRun(indexRunId, status, error = null) {
  const { rows } = await query(
    `UPDATE CtrlDriveIndexRuns SET Status = $2, Error = COALESCE($3, Error), FinishedAt = now() WHERE IndexRunId = $1 RETURNING SourceId`,
    [indexRunId, status, error]
  );
  if (rows.length) {
    await query(`UPDATE CtrlGoogleSources SET LastIndexedAt = now(), LastIndexError = $2 WHERE SourceId = $1`, [rows[0].sourceid, status === 'Failed' ? error : null]);
  }
}

async function loadRun(indexRunId) {
  const { rows } = await query(
    `SELECT r.IndexRunId, r.GroupId, r.SourceId, r.Status, s.SourceKey, s.ActAs, s.Enabled, s.DisplayName
     FROM CtrlDriveIndexRuns r JOIN CtrlGoogleSources s ON s.SourceId = r.SourceId WHERE r.IndexRunId = $1`,
    [indexRunId]
  );
  return rows[0] || null;
}

// Lists the folder tree and queues what changed. A folder switched off
// since is skipped.
async function scanFolder(indexRunId, { api = google } = {}) {
  const run = await loadRun(indexRunId);
  if (!run || run.status !== 'Scanning') return { indexRunId, skipped: 'not scanning' };
  if (!run.enabled) {
    await finishRun(indexRunId, 'Failed', 'The folder was switched off');
    return { indexRunId, skipped: 'disabled' };
  }
  let walk;
  try {
    walk = await api.driveWalkFolder(run.actas, run.sourcekey);
  } catch (err) {
    await finishRun(indexRunId, 'Failed', errorText(err));
    return { indexRunId, error: errorText(err) };
  }
  const files = walk.files.filter((f) => INDEXED_MIME.includes(f.mimeType));
  const { rows: known } = await query(`SELECT FileId, Version FROM CtrlDriveFiles WHERE SourceId = $1`, [run.sourceid]);
  const knownVersion = new Map(known.map((k) => [k.fileid, k.version]));
  const seen = new Set(files.map((f) => f.id));
  const removed = known.filter((k) => !seen.has(k.fileid)).map((k) => k.fileid);
  if (removed.length) await query(`DELETE FROM CtrlDriveFiles WHERE SourceId = $1 AND FileId = ANY($2::text[])`, [run.sourceid, removed]);
  const changed = files.filter((f) => knownVersion.get(f.id) !== versionOf(f));

  await query(
    `UPDATE CtrlDriveIndexRuns SET FilesSeen = $2, FilesToIndex = $3, FilesRemoved = $4, Status = $5,
       Error = $6 WHERE IndexRunId = $1`,
    [indexRunId, files.length, changed.length, removed.length, changed.length ? 'Indexing' : 'Succeeded', walk.truncated ? 'The folder is very large; only part of it was indexed' : null]
  );
  if (!changed.length) {
    await finishRun(indexRunId, 'Succeeded');
    return { indexRunId, seen: files.length, changed: 0, removed: removed.length };
  }
  const slim = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size, owner: f.owners?.[0]?.emailAddress || null, webViewLink: f.webViewLink, path: f.path });
  const bodies = [];
  for (let i = 0; i < changed.length; i += FILES_PER_MESSAGE) bodies.push({ type: 'files', indexRunId, files: changed.slice(i, i + FILES_PER_MESSAGE).map(slim) });
  const failed = await enqueueDriveIndex(bodies);
  if (failed.length) {
    const lost = failed.reduce((n, i) => n + bodies[i].files.length, 0);
    await bumpCounters(indexRunId, { failed: lost });
  }
  return { indexRunId, seen: files.length, changed: changed.length, removed: removed.length, messages: bodies.length };
}

// Adds to the run's counters; finishes the run when every file is done.
async function bumpCounters(indexRunId, { indexed = 0, failed = 0, ocrPages = 0 }) {
  const { rows } = await query(
    `UPDATE CtrlDriveIndexRuns SET FilesIndexed = FilesIndexed + $2, FilesFailed = FilesFailed + $3, OcrPages = OcrPages + $4
     WHERE IndexRunId = $1 RETURNING FilesIndexed + FilesFailed >= FilesToIndex AS done, Status`,
    [indexRunId, indexed, failed, ocrPages]
  );
  if (rows[0]?.done && rows[0].status === 'Indexing') await finishRun(indexRunId, 'Succeeded');
}

// The bytes and mime type to read text from.
async function fetchContent(api, actAs, f) {
  if (f.mimeType === GDOC) return { mimeType: 'text/plain', data: await api.driveExport(actAs, f.id, 'text/plain') };
  if (Number(f.size || 0) > MAX_FILE_BYTES) throw new Error('Larger than 25 MB; indexed by name only');
  return { mimeType: f.mimeType, data: await api.driveDownload(actAs, f.id) };
}

async function indexFiles(indexRunId, files, { api = google, extract = extractFile } = {}) {
  const run = await loadRun(indexRunId);
  if (!run || run.status !== 'Indexing') return { indexRunId, skipped: 'not indexing' };
  let indexed = 0;
  let failed = 0;
  let ocrPages = 0;
  for (const f of files) {
    let result = { text: '', method: 'none', ocrPages: 0, error: null };
    try {
      result = await extract(await fetchContent(api, run.actas, f));
    } catch (err) {
      result.error = errorText(err);
    }
    ocrPages += result.ocrPages || 0;
    const method = f.mimeType === GDOC && !result.error ? 'gdoc' : result.method;
    // Stored even when unreadable, so a later pass skips it until it changes.
    await query(
      `INSERT INTO CtrlDriveFiles (GroupId, SourceId, FileId, Name, MimeType, Path, OwnerEmail, ModifiedTime, SizeBytes, WebViewLink, Version,
         Text, Amounts, Dates, Extract, ExtractError, IndexedAt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric[], $14::date[], $15, $16, now())
       ON CONFLICT (SourceId, FileId) DO UPDATE SET Name = EXCLUDED.Name, MimeType = EXCLUDED.MimeType, Path = EXCLUDED.Path,
         OwnerEmail = EXCLUDED.OwnerEmail, ModifiedTime = EXCLUDED.ModifiedTime, SizeBytes = EXCLUDED.SizeBytes, WebViewLink = EXCLUDED.WebViewLink,
         Version = EXCLUDED.Version, Text = EXCLUDED.Text, Amounts = EXCLUDED.Amounts, Dates = EXCLUDED.Dates, Extract = EXCLUDED.Extract,
         ExtractError = EXCLUDED.ExtractError, IndexedAt = now()`,
      [
        run.groupid, run.sourceid, f.id, String(f.name).slice(0, 1000), f.mimeType, f.path || null, f.owner, f.modifiedTime || null,
        f.size ? Number(f.size) : null, f.webViewLink || null, versionOf(f), result.text, extractAmounts(`${f.name}\n${result.text}`),
        extractDates(`${f.name}\n${result.text}`), method, result.error,
      ]
    );
    if (result.error) failed += 1;
    else indexed += 1;
  }
  await bumpCounters(indexRunId, { indexed, failed, ocrPages });
  return { indexRunId, indexed, failed, ocrPages };
}

// Nightly: a pass for every enabled folder of every Group.
async function scheduleNightly() {
  const { rows } = await query(`SELECT SourceId, GroupId FROM CtrlGoogleSources WHERE Kind = 'Folder' AND Enabled`);
  const out = [];
  for (const r of rows) out.push(await startFolderIndex(r.groupid, r.sourceid, 'Nightly'));
  return { folders: rows.length, started: out.filter((o) => !o.alreadyRunning).length };
}

module.exports = { INDEXED_MIME, FILES_PER_MESSAGE, versionOf, loadFolderSource, startFolderIndex, scanFolder, indexFiles, scheduleNightly, finishRun };
