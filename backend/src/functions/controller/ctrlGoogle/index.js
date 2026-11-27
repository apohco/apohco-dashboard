// Controller Phase 4: the Google Workspace connection and the source
// allowlist (which mailboxes and Drives may be searched).
//
//   GET  /api/controller/google?groupId=            settings + sources
//   PUT  /api/controller/google                     { groupId, adminEmail }
//   POST /api/controller/google/test                { groupId }  test the connection
//   GET  /api/controller/google/directory?groupId=  workspace users (live from
//                                                   Google) with their Gmail opt-in state
//   POST /api/controller/google/folders             { groupId, link, actAs? } add an invoice folder
//   POST /api/controller/google/folders/{id}/index  index it again now
//   DELETE /api/controller/google/folders/{id}      remove it and its index
//   PUT  /api/controller/google/sources             { groupId, kind, sourceKey,
//                                                     displayName?, enabled }
//
// Only sources opted in here are ever searched (enforced by ctrlEvidence
// on every call). Drive is opted in folder by folder; adding a folder reads
// only its metadata (name, location) and starts indexing it. Nothing here
// reads mail.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { badRequest } = require('../../../shared/ctrlReviewData');
const google = require('../../../shared/googleApi');
const { loadGoogleSettings, loadSources } = require('../../../shared/ctrlEvidence');
const { startFolderIndex } = require('../../../shared/driveIndex');

// Sources that can be switched on and off here. Drive is searched only in
// invoice folders (added through /folders), never whole drives.
const KINDS = ['Mailbox', 'Folder'];
const domainOf = (email) => String(email).split('@')[1].toLowerCase();

function cleanEmail(value, field = 'email') {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!google.EMAIL_RE.test(email) || email.length > 255) throw badRequest(`${field} must be an email address`);
  return email;
}

// The folder id in a Drive folder link (or a bare id).
function folderIdFromLink(link) {
  const s = typeof link === 'string' ? link.trim() : '';
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{10,})$/);
  return m ? m[1] : null;
}

// Per folder: files indexed, and the latest indexing pass.
async function folderStats(groupId) {
  const { rows } = await query(
    `SELECT s.SourceId,
            (SELECT COUNT(*)::int FROM CtrlDriveFiles f WHERE f.SourceId = s.SourceId) AS Files,
            (SELECT COUNT(*)::int FROM CtrlDriveFiles f WHERE f.SourceId = s.SourceId AND f.Extract <> 'none') AS Readable,
            r.Status, r.FilesSeen, r.FilesToIndex, r.FilesIndexed, r.FilesFailed, r.OcrPages, r.Error, r.StartedAt, r.FinishedAt
     FROM CtrlGoogleSources s
     LEFT JOIN LATERAL (SELECT * FROM CtrlDriveIndexRuns x WHERE x.SourceId = s.SourceId ORDER BY x.StartedAt DESC LIMIT 1) r ON true
     WHERE s.GroupId = $1 AND s.Kind = 'Folder'`,
    [groupId]
  );
  return new Map(
    rows.map((r) => [
      r.sourceid,
      {
        files: r.files,
        readable: r.readable,
        lastRun: r.status
          ? {
              status: r.status, seen: r.filesseen, toIndex: r.filestoindex, indexed: r.filesindexed, failed: r.filesfailed, ocrPages: r.ocrpages,
              error: r.error, startedAt: r.startedat, finishedAt: r.finishedat,
            }
          : null,
      },
    ])
  );
}

async function view(groupId) {
  const settings = await loadGoogleSettings(groupId);
  const stats = await folderStats(groupId);
  const sources = (await loadSources(groupId, { all: true })).map((s) => (s.kind === 'Folder' ? { ...s, ...(stats.get(s.sourceId) || {}) } : s));
  return {
    keyConfigured: Boolean(process.env.GOOGLE_SA_SECRET_ID),
    settings,
    // Whole-drive sources from before folders existed are not searched.
    sources: sources.filter((s) => s.kind === 'Mailbox' || s.kind === 'Folder'),
  };
}

// POST /google/folders { groupId, link, actAs? }: add an invoice folder.
// actAs: the account that can read it (default the admin; a folder in
// someone's My Drive that isn't shared with the admin needs its owner).
async function handleAddFolder(claims, body) {
  const settings = await loadGoogleSettings(body.groupId);
  if (!settings) throw badRequest('Enter the workspace admin account first', 409);
  const folderId = folderIdFromLink(body.link);
  if (!folderId) throw badRequest('Paste a Google Drive folder link (drive.google.com/drive/folders/...)');
  const actAs = body.actAs ? cleanEmail(body.actAs, 'actAs') : settings.adminEmail;
  if (domainOf(actAs) !== settings.domain) throw badRequest(`Only ${settings.domain} accounts can be used`);

  let folder;
  try {
    folder = await google.driveGetFile(actAs, folderId);
  } catch (err) {
    throw badRequest(
      err.status === 404
        ? `${actAs} can't see that folder. Share it with ${actAs}, or enter the account that owns it.`
        : err.message,
      err.status === 404 ? 404 : 502
    );
  }
  if (folder.mimeType !== google.FOLDER_MIME) throw badRequest('That link is a file, not a folder');
  if (folder.trashed) throw badRequest('That folder is in the trash');

  // Where it is: the shared drive (or owner's My Drive) and parent folders.
  const names = [];
  let parent = folder.parents?.[0];
  for (let i = 0; parent && i < 8; i += 1) {
    try {
      const p = await google.driveGetFile(actAs, parent, { fields: 'id,name,parents,driveId' });
      if (folder.driveId && p.id === folder.driveId) break; // the shared drive root
      names.unshift(p.name);
      parent = p.parents?.[0];
    } catch {
      break;
    }
  }
  let root = `${folder.owners?.[0]?.emailAddress || actAs}'s My Drive`;
  if (folder.driveId) {
    const drive = (await google.listSharedDrives(settings.adminEmail).catch(() => [])).find((d) => d.id === folder.driveId);
    root = `Shared drive ${drive?.name || folder.driveId}`;
  }
  const folderPath = [root, ...names.filter((n) => n !== 'My Drive'), folder.name].join(' / ');

  const { rows } = await query(
    `INSERT INTO CtrlGoogleSources (GroupId, Kind, SourceKey, DisplayName, Enabled, AddedBy, FolderPath, DriveId, ActAs)
     VALUES ($1, 'Folder', $2, $3, true, $4, $5, $6, $7)
     ON CONFLICT (GroupId, Kind, SourceKey) DO UPDATE SET DisplayName = EXCLUDED.DisplayName, FolderPath = EXCLUDED.FolderPath,
       DriveId = EXCLUDED.DriveId, ActAs = EXCLUDED.ActAs, Enabled = true, LastUpdated = now()
     RETURNING SourceId`,
    [body.groupId, folderId, String(folder.name).slice(0, 255), claims.userId, folderPath, folder.driveId || null, actAs]
  );
  const sourceId = rows[0].sourceid;
  await recordAudit({ groupId: body.groupId, userId: claims.userId, action: 'ctrl.google.folder.add', targetType: 'Folder', targetId: folderId, details: { folderPath, actAs } });
  const index = await startFolderIndex(body.groupId, sourceId, 'Manual');
  return json(200, { ...(await view(body.groupId)), added: { sourceId, folderPath, indexRunId: index.indexRunId } });
}

async function folderSource(groupId, sourceId) {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId || '')) throw badRequest('Folder not found', 404);
  const { rows } = await query(`SELECT SourceId, SourceKey, Enabled FROM CtrlGoogleSources WHERE SourceId = $1 AND GroupId = $2 AND Kind = 'Folder'`, [sourceId, groupId]);
  if (!rows.length) throw badRequest('Folder not found', 404);
  return rows[0];
}

// POST /google/folders/{sourceId}/index: index it again now.
async function handleIndexFolder(claims, groupId, sourceId) {
  const src = await folderSource(groupId, sourceId);
  if (!src.enabled) throw badRequest('Switch the folder on first', 409);
  const r = await startFolderIndex(groupId, sourceId, 'Manual');
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.google.folder.index', targetType: 'Folder', targetId: src.sourcekey });
  return json(202, r);
}

// DELETE /google/folders/{sourceId}: remove it and its index (saved
// support is kept).
async function handleRemoveFolder(claims, groupId, sourceId) {
  const src = await folderSource(groupId, sourceId);
  await query(`DELETE FROM CtrlEvidenceCandidates WHERE GroupId = $1 AND Source = 'Drive' AND SourceAccount = $2`, [groupId, sourceId]);
  await query(`DELETE FROM CtrlGoogleSources WHERE SourceId = $1`, [sourceId]);
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.google.folder.remove', targetType: 'Folder', targetId: src.sourcekey });
  return json(200, await view(groupId));
}

async function handleSave(claims, body) {
  const adminEmail = cleanEmail(body.adminEmail, 'adminEmail');
  const domain = domainOf(adminEmail);
  const existing = await loadGoogleSettings(body.groupId);
  await query(
    `INSERT INTO CtrlGoogleSettings (GroupId, AdminEmail, Domain, UpdatedBy) VALUES ($1, $2, $3, $4)
     ON CONFLICT (GroupId) DO UPDATE SET AdminEmail = EXCLUDED.AdminEmail, Domain = EXCLUDED.Domain,
       UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now(),
       LastTestAt = CASE WHEN CtrlGoogleSettings.AdminEmail = EXCLUDED.AdminEmail THEN CtrlGoogleSettings.LastTestAt END,
       LastTestOk = CASE WHEN CtrlGoogleSettings.AdminEmail = EXCLUDED.AdminEmail THEN CtrlGoogleSettings.LastTestOk END,
       LastTestMessage = CASE WHEN CtrlGoogleSettings.AdminEmail = EXCLUDED.AdminEmail THEN CtrlGoogleSettings.LastTestMessage END`,
    [body.groupId, adminEmail, domain, claims.userId]
  );
  // First connection: the admin's own mailbox is the first source.
  if (!existing) {
    await query(
      `INSERT INTO CtrlGoogleSources (GroupId, Kind, SourceKey, DisplayName, AddedBy) VALUES ($1, 'Mailbox', $2, $2, $3)
       ON CONFLICT (GroupId, Kind, SourceKey) DO NOTHING`,
      [body.groupId, adminEmail, claims.userId]
    );
  }
  await recordAudit({ groupId: body.groupId, userId: claims.userId, action: 'ctrl.google.settings', details: { adminEmail, domain } });
  return json(200, await view(body.groupId));
}

async function handleTest(claims, groupId) {
  const settings = await loadGoogleSettings(groupId);
  if (!settings) throw badRequest('Enter the workspace admin account first', 409);
  const result = await google.testConnection(settings.adminEmail);
  const message = result.checks.map((c) => `${c.ok ? 'OK' : 'Failed'}: ${c.name}: ${c.detail}`).join('\n');
  await query(`UPDATE CtrlGoogleSettings SET LastTestAt = now(), LastTestOk = $2, LastTestMessage = $3 WHERE GroupId = $1`, [
    groupId,
    result.ok,
    message.slice(0, 4000),
  ]);
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.google.test', details: { ok: result.ok } });
  return json(200, result);
}

async function handleDirectory(groupId) {
  const settings = await loadGoogleSettings(groupId);
  if (!settings) throw badRequest('Enter the workspace admin account first', 409);
  let users;
  try {
    users = await google.listDirectoryUsers(settings.adminEmail);
  } catch (err) {
    throw badRequest(err.message, 502);
  }
  const sources = await loadSources(groupId, { all: true });
  const state = (kind, key) => sources.find((s) => s.kind === kind && s.sourceKey === key)?.enabled || false;
  // Mailboxes only: Drive is opted in folder by folder.
  return json(200, {
    users: users.filter((u) => domainOf(u.email) === settings.domain).map((u) => ({ ...u, mailbox: state('Mailbox', u.email.toLowerCase()) })),
  });
}

async function handleSource(claims, body) {
  if (!KINDS.includes(body.kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false');
  const settings = await loadGoogleSettings(body.groupId);
  if (!settings) throw badRequest('Enter the workspace admin account first', 409);
  let sourceKey;
  if (body.kind === 'Folder') {
    // Folders are added through /folders; here they are only switched on or off.
    const { rows } = await query(
      `UPDATE CtrlGoogleSources SET Enabled = $3, LastUpdated = now() WHERE GroupId = $1 AND Kind = 'Folder' AND SourceKey = $2 RETURNING SourceId`,
      [body.groupId, String(body.sourceKey || ''), body.enabled]
    );
    if (!rows.length) throw badRequest('Folder not found', 404);
    await recordAudit({
      groupId: body.groupId, userId: claims.userId, action: `ctrl.google.source.${body.enabled ? 'enable' : 'disable'}`, targetType: 'Folder', targetId: body.sourceKey,
    });
    return json(200, await view(body.groupId));
  } else {
    sourceKey = cleanEmail(body.sourceKey, 'sourceKey');
    // Only accounts in this workspace.
    if (domainOf(sourceKey) !== settings.domain) throw badRequest(`Only ${settings.domain} accounts can be added`);
  }
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 255) || null : null;
  await query(
    `INSERT INTO CtrlGoogleSources (GroupId, Kind, SourceKey, DisplayName, Enabled, AddedBy) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (GroupId, Kind, SourceKey) DO UPDATE SET Enabled = EXCLUDED.Enabled,
       DisplayName = COALESCE(EXCLUDED.DisplayName, CtrlGoogleSources.DisplayName), LastUpdated = now()`,
    [body.groupId, body.kind, sourceKey, displayName || sourceKey, body.enabled, claims.userId]
  );
  await recordAudit({
    groupId: body.groupId, userId: claims.userId, action: `ctrl.google.source.${body.enabled ? 'enable' : 'disable'}`,
    targetType: body.kind, targetId: sourceKey,
  });
  return json(200, await view(body.groupId));
}

exports.folderIdFromLink = folderIdFromLink;

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const { resource, httpMethod } = event;
  if (httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    if (resource.endsWith('/directory')) return handleDirectory(qs.groupId);
    return json(200, await view(qs.groupId));
  }
  if (httpMethod === 'DELETE' && resource.endsWith('/folders/{sourceId}')) {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    return handleRemoveFolder(claims, qs.groupId, event.pathParameters?.sourceId);
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  if (httpMethod === 'PUT' && resource.endsWith('/sources')) return handleSource(claims, body);
  if (httpMethod === 'POST' && resource.endsWith('/folders')) return handleAddFolder(claims, body);
  if (httpMethod === 'POST' && resource.endsWith('/folders/{sourceId}/index')) return handleIndexFolder(claims, body.groupId, event.pathParameters?.sourceId);
  if (httpMethod === 'POST' && resource.endsWith('/test')) return handleTest(claims, body.groupId);
  if (httpMethod === 'PUT' && resource.endsWith('/google')) return handleSave(claims, body);
  throw badRequest('Unknown Google route', 404);
});
