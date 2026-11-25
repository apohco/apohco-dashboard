// Controller Phase 4: the Google Workspace connection and the source
// allowlist (which mailboxes and Drives may be searched).
//
//   GET  /api/controller/google?groupId=            settings + sources
//   PUT  /api/controller/google                     { groupId, adminEmail }
//   POST /api/controller/google/test                { groupId }  test the connection
//   GET  /api/controller/google/directory?groupId=  workspace users and shared
//                                                   drives (live from Google), with
//                                                   their opt-in state
//   PUT  /api/controller/google/sources             { groupId, kind, sourceKey,
//                                                     displayName?, enabled }
//
// Only sources opted in here are ever searched (enforced by ctrlEvidence
// on every call). Nothing here reads mail or files.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { badRequest } = require('../../../shared/ctrlReviewData');
const google = require('../../../shared/googleApi');
const { loadGoogleSettings, loadSources } = require('../../../shared/ctrlEvidence');

const KINDS = ['Mailbox', 'UserDrive', 'SharedDrive'];
const domainOf = (email) => String(email).split('@')[1].toLowerCase();

function cleanEmail(value, field = 'email') {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!google.EMAIL_RE.test(email) || email.length > 255) throw badRequest(`${field} must be an email address`);
  return email;
}

async function view(groupId) {
  const settings = await loadGoogleSettings(groupId);
  return {
    keyConfigured: Boolean(process.env.GOOGLE_SA_SECRET_ID),
    settings,
    sources: await loadSources(groupId, { all: true }),
  };
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
  let drives;
  try {
    [users, drives] = await Promise.all([google.listDirectoryUsers(settings.adminEmail), google.listSharedDrives(settings.adminEmail)]);
  } catch (err) {
    throw badRequest(err.message, 502);
  }
  const sources = await loadSources(groupId, { all: true });
  const state = (kind, key) => sources.find((s) => s.kind === kind && s.sourceKey === key)?.enabled || false;
  return json(200, {
    users: users
      .filter((u) => domainOf(u.email) === settings.domain)
      .map((u) => ({ ...u, mailbox: state('Mailbox', u.email.toLowerCase()), drive: state('UserDrive', u.email.toLowerCase()) })),
    sharedDrives: drives.map((d) => ({ ...d, enabled: state('SharedDrive', d.id) })),
  });
}

async function handleSource(claims, body) {
  if (!KINDS.includes(body.kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false');
  const settings = await loadGoogleSettings(body.groupId);
  if (!settings) throw badRequest('Enter the workspace admin account first', 409);
  let sourceKey;
  if (body.kind === 'SharedDrive') {
    sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey.trim() : '';
    if (!/^[A-Za-z0-9_-]{5,100}$/.test(sourceKey)) throw badRequest('sourceKey must be a shared drive id');
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
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  if (httpMethod === 'PUT' && resource.endsWith('/sources')) return handleSource(claims, body);
  if (httpMethod === 'POST' && resource.endsWith('/test')) return handleTest(claims, body.groupId);
  if (httpMethod === 'PUT' && resource.endsWith('/google')) return handleSave(claims, body);
  throw badRequest('Unknown Google route', 404);
});
