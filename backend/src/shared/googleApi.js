// Google Workspace access for the Controller's evidence search (Phase 4).
//
// A service account with domain-wide delegation acts as one workspace user
// at a time ("subject"). Its key lives in AWS Secrets Manager
// (GOOGLE_SA_SECRET_ID) and is never logged or returned. Access tokens are
// signed here with Node's crypto (no googleapis dependency) and cached per
// subject + scopes until shortly before they expire.
//
// Read-only except drive.file (the app's own evidence folder, Phase 4b).
// Callers must check the source allowlist before calling (ctrlGoogle /
// ctrlEvidence do, server-side).
const crypto = require('crypto');
const axios = require('axios');
const { getSecretJson } = require('./secretsManager');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  directory: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
};
const TIMEOUT_MS = 15000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const tokenCache = new Map();
let keyPromise = null;

// The service account key ({ client_email, private_key, ... }).
async function loadKey() {
  const id = process.env.GOOGLE_SA_SECRET_ID;
  if (!id) {
    const err = new Error('The Google service account is not set up yet (see SETUP.md section 10)');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  if (!keyPromise) {
    keyPromise = getSecretJson(id).catch((e) => {
      keyPromise = null;
      const err = new Error(
        e.name === 'ResourceNotFoundException'
          ? 'The Google service account key has not been stored yet (see SETUP.md section 10)'
          : 'The Google service account key could not be read'
      );
      err.code = 'GOOGLE_NOT_CONFIGURED';
      throw err;
    });
  }
  const key = await keyPromise;
  if (!key?.client_email || !key?.private_key) {
    keyPromise = null;
    const err = new Error('The stored Google key is not a service account JSON key');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// A signed JWT assertion for the token endpoint.
function signAssertion(key, subject, scopes, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: key.client_email, sub: subject, scope: scopes.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

// Why Google refused, in words (no token or key material).
function describeGoogleError(err) {
  const data = err?.response?.data;
  const status = err?.response?.status;
  if (data?.error === 'unauthorized_client') {
    return 'Domain-wide delegation is not set up for this service account, or a scope is missing (Admin console → API controls)';
  }
  if (data?.error === 'invalid_grant') return 'Google refused the account (is it a user in this workspace, and active?)';
  const message = data?.error?.message || data?.error_description || err?.message || 'Google request failed';
  return `${status ? `Google ${status}: ` : ''}${message}`.slice(0, 500);
}

async function getAccessToken(subject, scopeNames, { http = axios } = {}) {
  if (!EMAIL_RE.test(subject || '')) throw new Error('A workspace email address is required');
  const scopes = scopeNames.map((s) => SCOPES[s]);
  const cacheKey = `${subject}|${scopes.join(' ')}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const key = await loadKey();
  try {
    const { data } = await http.post(
      TOKEN_URL,
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(key, subject, scopes) }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_MS }
    );
    tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
    return data.access_token;
  } catch (err) {
    const e = new Error(describeGoogleError(err));
    e.code = 'GOOGLE_AUTH';
    throw e;
  }
}

// Query string with repeated keys for arrays (Google's convention).
function queryString(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function get(url, subject, scopeNames, params, { http = axios } = {}) {
  const token = await getAccessToken(subject, scopeNames, { http });
  try {
    const { data } = await http.get(`${url}${queryString(params)}`, { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    return data;
  } catch (err) {
    const e = new Error(describeGoogleError(err));
    e.status = err?.response?.status;
    throw e;
  }
}

// ---- Gmail (read-only)

const gmailBase = (mailbox) => `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}`;

// Message ids matching a Gmail search query.
async function gmailSearch(mailbox, q, { maxResults = 10, http } = {}) {
  const data = await get(`${gmailBase(mailbox)}/messages`, mailbox, ['gmail'], { q, maxResults }, { http });
  return (data.messages || []).map((m) => ({ id: m.id, threadId: m.threadId }));
}

// One message. format 'metadata' (headers + snippet) or 'full' (with body).
async function gmailGetMessage(mailbox, id, { format = 'full', http } = {}) {
  const params = format === 'metadata' ? { format, metadataHeaders: ['From', 'To', 'Subject', 'Date'] } : { format };
  return get(`${gmailBase(mailbox)}/messages/${encodeURIComponent(id)}`, mailbox, ['gmail'], params, { http });
}

// ---- Directory and shared drives (acting as the workspace admin)

async function listDirectoryUsers(adminEmail, { http } = {}) {
  const users = [];
  let pageToken;
  do {
    const data = await get(
      'https://admin.googleapis.com/admin/directory/v1/users',
      adminEmail,
      ['directory'],
      { customer: 'my_customer', maxResults: 500, orderBy: 'email', ...(pageToken ? { pageToken } : {}) },
      { http }
    );
    for (const u of data.users || []) {
      users.push({ email: u.primaryEmail, name: u.name?.fullName || u.primaryEmail, suspended: Boolean(u.suspended) });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && users.length < 5000);
  return users;
}

async function listSharedDrives(adminEmail, { http } = {}) {
  const drives = [];
  let pageToken;
  do {
    const data = await get(
      'https://www.googleapis.com/drive/v3/drives',
      adminEmail,
      ['driveRead'],
      { useDomainAdminAccess: true, pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      { http }
    );
    for (const d of data.drives || []) drives.push({ id: d.id, name: d.name });
    pageToken = data.nextPageToken;
  } while (pageToken && drives.length < 2000);
  return drives;
}

// "Test connection": the key is readable and delegation works for the
// admin account (directory, Gmail and Drive scopes). Returns { ok, checks }.
async function testConnection(adminEmail, { http } = {}) {
  const checks = [];
  const attempt = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  };
  await attempt('Service account key', async () => `Key for ${(await loadKey()).client_email}`);
  if (checks[0].ok) {
    await attempt('List workspace users', async () => `${(await listDirectoryUsers(adminEmail, { http })).length} users`);
    await attempt(`Read ${adminEmail} mail`, async () => {
      await gmailSearch(adminEmail, 'newer_than:1d', { maxResults: 1, http });
      return 'Gmail search works';
    });
    await attempt('List shared drives', async () => `${(await listSharedDrives(adminEmail, { http })).length} shared drives`);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// For tests.
function resetCaches() {
  tokenCache.clear();
  keyPromise = null;
}

module.exports = {
  SCOPES,
  EMAIL_RE,
  signAssertion,
  describeGoogleError,
  getAccessToken,
  gmailSearch,
  gmailGetMessage,
  listDirectoryUsers,
  listSharedDrives,
  testConnection,
  resetCaches,
  queryString,
};
