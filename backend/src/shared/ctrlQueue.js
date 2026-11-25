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

module.exports = { enqueueTasks, enqueueAiBatches };
