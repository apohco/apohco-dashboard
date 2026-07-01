const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({});

// Module-level cache: persists across warm invocations of the same Lambda
// execution environment, avoiding a Secrets Manager call on every request.
const cache = new Map();

async function getSecretJson(secretArn) {
  if (cache.has(secretArn)) {
    return cache.get(secretArn);
  }

  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = JSON.parse(result.SecretString);
  cache.set(secretArn, value);
  return value;
}

module.exports = { getSecretJson };
