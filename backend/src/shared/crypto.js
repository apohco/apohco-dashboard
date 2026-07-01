const crypto = require('crypto');
const { getSecretJson } = require('./secretsManager');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

async function getKey() {
  const { tokenEncryptionKey } = await getSecretJson(process.env.APP_SECRETS_ARN);
  const key = Buffer.from(tokenEncryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error('tokenEncryptionKey must be a base64-encoded 32-byte key');
  }
  return key;
}

// Encrypts plaintext (e.g. a QBO OAuth token) for storage in the database.
// Output encodes iv + authTag + ciphertext together, base64.
async function encrypt(plaintext) {
  const key = await getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

async function decrypt(encoded) {
  const key = await getKey();
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
