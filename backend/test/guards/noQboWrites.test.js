// Guard: the app must never write to QuickBooks. The QBO OAuth scope
// (com.intuit.quickbooks.accounting) technically allows writes, so this is
// enforced in code: every QBO data call is an HTTP GET, and the only POST
// anywhere is the OAuth token exchange/refresh to Intuit's token endpoint.
// If one of these tests fails, a write path to QBO has been introduced.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

const files = jsFiles(SRC).map((file) => ({ file: path.relative(SRC, file), text: fs.readFileSync(file, 'utf8') }));

describe('static: no write calls to QBO', () => {
  test('no source file uses axios put/patch/delete/request or calls axios() directly', () => {
    const offenders = files.filter(({ text }) => /\baxios\s*\.\s*(put|patch|delete|request)\s*\(|\baxios\s*\(/.test(text));
    // The manual-upload S3 presigned PUT lives in the frontend, not here.
    expect(offenders.map((f) => f.file)).toEqual([]);
  });

  test('the only axios.post is the OAuth token request in qboClient', () => {
    const posts = files.flatMap(({ file, text }) => (text.match(/\baxios\s*\.\s*post\s*\([^,]*/g) || []).map((m) => `${file}: ${m}`));
    expect(posts).toEqual([`${path.join('shared', 'qboClient.js')}: axios.post(TOKEN_ENDPOINT`]);
  });

  test('only qboClient talks to the QuickBooks API hosts', () => {
    const hostUsers = files.filter(({ text }) => /quickbooks\.api\.intuit\.com/.test(text)).map((f) => f.file);
    expect(hostUsers).toEqual([path.join('shared', 'qboClient.js')]);
  });

  test('Controller code never imports axios directly', () => {
    const controller = files.filter(({ file }) => file.startsWith(path.join('functions', 'controller')));
    expect(controller.length).toBeGreaterThan(0);
    expect(controller.filter(({ text }) => /require\(['"]axios['"]\)/.test(text)).map((f) => f.file)).toEqual([]);
  });
});

describe('runtime: qboClient exposes only read operations', () => {
  const READ_ONLY_EXPORTS = [
    'buildAuthorizeUrl',
    'exchangeCodeForTokens',
    'refreshAccessToken',
    'queryAccounts',
    'queryClasses',
    'getGeneralLedgerReport',
    'flattenGeneralLedgerReport',
    'buildAccountLookup',
  ].sort();

  test('the exported API is exactly the reviewed read-only set', () => {
    const qboClient = require('../../src/shared/qboClient');
    expect(Object.keys(qboClient).sort()).toEqual(READ_ONLY_EXPORTS);
  });

  test('data calls issue GET requests only', async () => {
    jest.resetModules();
    jest.doMock('../../src/shared/secretsManager', () => ({
      getSecretJson: async () => ({ qboEnvironment: 'sandbox', qboClientId: 'id', qboClientSecret: 's', qboRedirectUri: 'r' }),
    }));
    const axios = require('axios');
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { QueryResponse: {} } });
    const writes = ['post', 'put', 'patch', 'delete'].map((m) => jest.spyOn(axios, m));

    const qboClient = require('../../src/shared/qboClient');
    await qboClient.queryAccounts('realm', 'token');
    await qboClient.queryClasses('realm', 'token');
    await qboClient.getGeneralLedgerReport('realm', 'token', '2026-10-01', '2026-10-31');

    expect(get).toHaveBeenCalledTimes(3);
    for (const [url] of get.mock.calls) expect(url).toMatch(/^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/realm\//);
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
