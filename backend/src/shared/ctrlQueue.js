const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { chunk } = require('./bulkInsert');

let client = null;
const getClient = () => {
  if (!client) client = new SQSClient({});
  return client;
};

// Sends one message per Controller sync task ({ taskId }) to the GL pull
// queue, 10 per SendMessageBatch call (the SQS maximum). Returns the
// taskIds SQS did not accept, so the caller can mark them Failed instead
// of leaving them Queued forever.
async function enqueueTasks(taskIds, { queueUrl = process.env.CTRL_GL_PULL_QUEUE_URL, sqs = getClient() } = {}) {
  if (!queueUrl) throw new Error('CTRL_GL_PULL_QUEUE_URL is not set');
  const failed = [];

  for (const batch of chunk(taskIds, 10)) {
    try {
      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((taskId, i) => ({ Id: String(i), MessageBody: JSON.stringify({ taskId }) })),
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

module.exports = { enqueueTasks };
