jest.mock('../../src/shared/secretsManager', () => ({ getSecretJson: jest.fn() }));

const crypto = require('crypto');
const { getSecretJson } = require('../../src/shared/secretsManager');
const google = require('../../src/shared/googleApi');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'controller-evidence@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const okToken = { data: { access_token: 'tok-1', expires_in: 3600 } };
function httpMock(getImpl = async () => ({ data: {} })) {
  return { post: jest.fn().mockResolvedValue(okToken), get: jest.fn(getImpl) };
}

beforeEach(() => {
  google.resetCaches();
  process.env.GOOGLE_SA_SECRET_ID = 'apohco-dashboard/google-service-account';
  getSecretJson.mockResolvedValue(KEY);
});

test('signAssertion: an RS256 JWT for the subject and scopes, verifiable with the public key', () => {
  const jwt = google.signAssertion(KEY, 'info@apohco.com', [google.SCOPES.gmail], 1000);
  const [h, c, s] = jwt.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(c, 'base64url'))).toEqual({
    iss: KEY.client_email, sub: 'info@apohco.com', scope: google.SCOPES.gmail, aud: 'https://oauth2.googleapis.com/token', iat: 1000, exp: 4600,
  });
  expect(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
});

test('tokens are cached per subject and scopes', async () => {
  const http = httpMock();
  await google.getAccessToken('info@apohco.com', ['gmail'], { http });
  await google.getAccessToken('info@apohco.com', ['gmail'], { http });
  await google.getAccessToken('info@apohco.com', ['directory'], { http });
  expect(http.post).toHaveBeenCalledTimes(2);
  const body = new URLSearchParams(http.post.mock.calls[0][1]);
  expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
});

test('no key configured, or not a service account key, is reported plainly', async () => {
  delete process.env.GOOGLE_SA_SECRET_ID;
  await expect(google.getAccessToken('info@apohco.com', ['gmail'], { http: httpMock() })).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONFIGURED' });
  process.env.GOOGLE_SA_SECRET_ID = 'x';
  getSecretJson.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
  await expect(google.getAccessToken('info@apohco.com', ['gmail'], { http: httpMock() })).rejects.toThrow(/has not been stored yet/);
  google.resetCaches();
  getSecretJson.mockResolvedValue({ foo: 1 });
  await expect(google.getAccessToken('info@apohco.com', ['gmail'], { http: httpMock() })).rejects.toThrow(/not a service account JSON key/);
});

test('delegation problems are explained, never echoing the key', async () => {
  const http = httpMock();
  http.post.mockRejectedValue({ response: { status: 401, data: { error: 'unauthorized_client' } } });
  await expect(google.getAccessToken('info@apohco.com', ['gmail'], { http })).rejects.toThrow(/Domain-wide delegation is not set up/);
  expect(google.describeGoogleError({ response: { status: 403, data: { error: { message: 'Mail service not enabled' } } } })).toBe('Google 403: Mail service not enabled');
});

test('queryString repeats array keys', () => {
  expect(google.queryString({ format: 'metadata', metadataHeaders: ['From', 'Subject'], x: undefined })).toBe('?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
});

test('gmailSearch acts as the mailbox, with the Gmail scope only', async () => {
  const http = httpMock(async () => ({ data: { messages: [{ id: 'm1', threadId: 't1' }] } }));
  expect(await google.gmailSearch('info@apohco.com', '"1,250.00" after:2026/09/23', { maxResults: 5, http })).toEqual([{ id: 'm1', threadId: 't1' }]);
  const [url, opts] = http.get.mock.calls[0];
  expect(url).toMatch(/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/info%40apohco\.com\/messages\?q=/);
  expect(url).toMatch(/maxResults=5/);
  expect(opts.headers.Authorization).toBe('Bearer tok-1');
  const claims = JSON.parse(Buffer.from(new URLSearchParams(http.post.mock.calls[0][1]).get('assertion').split('.')[1], 'base64url'));
  expect(claims).toMatchObject({ sub: 'info@apohco.com', scope: google.SCOPES.gmail });
});

test('directory users and shared drives are paged', async () => {
  const pages = [
    { data: { users: [{ primaryEmail: 'a@apohco.com', name: { fullName: 'A' } }], nextPageToken: 'p2' } },
    { data: { users: [{ primaryEmail: 'b@apohco.com', name: { fullName: 'B' }, suspended: true }] } },
  ];
  const http = httpMock(async () => pages.shift());
  expect(await google.listDirectoryUsers('info@apohco.com', { http })).toEqual([
    { email: 'a@apohco.com', name: 'A', suspended: false },
    { email: 'b@apohco.com', name: 'B', suspended: true },
  ]);
  expect(http.get.mock.calls[1][0]).toMatch(/pageToken=p2/);
});

test('testConnection reports each check', async () => {
  const http = httpMock(async (url) => {
    if (url.includes('directory')) return { data: { users: [{ primaryEmail: 'info@apohco.com', name: { fullName: 'Info' } }] } };
    if (url.includes('/drives')) throw { response: { status: 403, data: { error: { message: 'Insufficient Permission' } } } };
    return { data: { messages: [] } };
  });
  const result = await google.testConnection('info@apohco.com', { http });
  expect(result.ok).toBe(false);
  expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
    ['Service account key', true],
    ['List workspace users', true],
    ['Read info@apohco.com mail', true],
    ['List shared drives', false],
  ]);
  expect(result.checks[3].detail).toBe('Google 403: Insufficient Permission');
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY/);
});
