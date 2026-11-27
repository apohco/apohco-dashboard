const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { chunk } = require('./bulkInsert');

let client = null;
const getClient = () => {
  if (!client) client = new SQSClient({});
  return client;
};

// Sends one message per id ({ [field]: id }) to `queueUrl`, 10 per
// SendMessageBatch call (the SQS maximum). Returns the ids SQS did not
// accept, so the caller can mark them Failed instead of leaving them
// Queued forever.
async function enqueueIds(ids, field, queueUrl, sqs) {
  const failed = [];
  for (const batch of chunk(ids, 10)) {
    try {
      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((id, i) => ({ Id: String(i), MessageBody: JSON.stringify({ [field]: id }) })),
        })
      );
      for (const f of result.Failed || []) failed.push(batch[Number(f.Id)]);
    } catch (err) {
      console.error('SendMessageBatch failed:', err.name, err.message);
      failed.push(...batch);
    }
  }
  return failed;
}

// One message per Controller sync task ({ taskId }) to the GL pull queue.
async function enqueueTasks(taskIds, { queueUrl = process.env.CTRL_GL_PULL_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_GL_PULL_QUEUE_URL is not set');
  return enqueueIds(taskIds, 'taskId', queueUrl, sqs);
}

// One message per AI batch ({ batchId }) to the AI queue.
async function enqueueAiBatches(batchIds, { queueUrl = process.env.CTRL_AI_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_AI_QUEUE_URL is not set');
  return enqueueIds(batchIds, 'batchId', queueUrl, sqs);
}

// One message per evidence "Search All" batch ({ batchId }).
async function enqueueEvidenceBatches(batchIds, { queueUrl = process.env.CTRL_EVIDENCE_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_EVIDENCE_QUEUE_URL is not set');
  return enqueueIds(batchIds, 'batchId', queueUrl, sqs);
}

// Arbitrary JSON messages, 10 per call. Returns the indexes SQS refused.
async function enqueueBodies(bodies, queueUrl, sqs = getClient()) {
  const failed = [];
  for (const [n, batch] of chunk(bodies.map((b, i) => [i, b]), 10).entries()) {
    try {
      const result = await sqs.send(
        new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: batch.map(([i, b]) => ({ Id: String(i), MessageBody: JSON.stringify(b) })) })
      );
      for (const f of result.Failed || []) failed.push(Number(f.Id));
    } catch (err) {
      console.error('SendMessageBatch failed:', err.name, err.message, 'batch', n);
      failed.push(...batch.map(([i]) => i));
    }
  }
  return failed;
}

// Drive index messages: { type: 'scan', indexRunId } | { type: 'files', indexRunId, files }.
async function enqueueDriveIndex(bodies, { queueUrl = process.env.CTRL_DRIVE_INDEX_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_DRIVE_INDEX_QUEUE_URL is not set');
  return enqueueBodies(bodies, queueUrl, sqs);
}

// Save-as-support messages ({ saveId }) go to the evidence queue.
async function enqueueEvidenceSave(saveId, { queueUrl = process.env.CTRL_EVIDENCE_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_EVIDENCE_QUEUE_URL is not set');
  return enqueueBodies([{ saveId }], queueUrl, sqs);
}

module.exports = { enqueueTasks, enqueueAiBatches, enqueueEvidenceBatches, enqueueBodies, enqueueDriveIndex, enqueueEvidenceSave };
