// Claude on Amazon Bedrock, for the Controller's AI matching, through the
// standard bedrock-runtime API (InvokeModel) and a US cross-region
// inference profile, so requests are served from US regions only.
// (The newer "Mantle" Messages endpoint returned 404 for every model on
// this account when Phase 3 was built.) Credentials come from the Lambda's
// execution role; the region from AWS_REGION.
//
// Settings (environment, see template.yaml):
//   AI_MODEL_ID      inference profile id, default us.anthropic.claude-opus-5-5
//   AI_EFFORT        low | medium | high, default low (classification)
//   AI_PRICE_*       USD per million tokens, for the cost estimate only

const { OUTPUT_SCHEMA, estimateCost } = require('./aiMatcher');

const DEFAULT_MODEL = 'us.anthropic.claude-opus-5-5';
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 240000;

const modelId = () => process.env.AI_MODEL_ID || DEFAULT_MODEL;
const effort = () => (['low', 'medium', 'high'].includes(process.env.AI_EFFORT) ? process.env.AI_EFFORT : 'low');
const prices = () => ({
  input: Number(process.env.AI_PRICE_INPUT || 4.4),
  output: Number(process.env.AI_PRICE_OUTPUT || 22),
  cacheRead: Number(process.env.AI_PRICE_CACHE_READ || 0.44),
  cacheWrite: Number(process.env.AI_PRICE_CACHE_WRITE || 5.5),
});

let client = null;
const getClient = () => {
  if (!client) {
    // Loaded on first use, so functions that only read the model id (e.g.
    // ctrlReview starting a job) don't load the SDK.
    // eslint-disable-next-line global-require
    const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
    client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION, timeout: TIMEOUT_MS, maxRetries: 2 });
  }
  return client;
};

// Errors a later attempt may get past (throttling, overload, timeouts).
function isRetryable(err) {
  const status = err?.status;
  if (status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600)) return true;
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up|Connection error/i.test(`${err?.name} ${err?.message}`);
}

// One classification call. prompt: buildPrompt's { system, context, user }.
// Returns { text, stopReason, usage, costUsd, durationMs, model }.
// The file context is a cache breakpoint: every batch of a job sends the
// same system prompt + context, so later batches can read it from the cache.
async function classify(prompt, { anthropic = getClient() } = {}) {
  const started = Date.now();
  const model = modelId();
  const response = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: prompt.system },
      { type: 'text', text: prompt.context, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: prompt.user }],
    output_config: { effort: effort(), format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    stopReason: response.stop_reason,
    usage: response.usage || {},
    costUsd: estimateCost(response.usage, prices()),
    durationMs: Date.now() - started,
    model,
  };
}

module.exports = { classify, isRetryable, modelId, prices, DEFAULT_MODEL };
