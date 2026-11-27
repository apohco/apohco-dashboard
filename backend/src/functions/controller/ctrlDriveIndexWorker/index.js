// Controller Phase 4b: invoice-folder index worker.
//   EventBridge (nightly): queue a pass for every enabled folder.
//   SQS { type: 'scan', indexRunId }: list a folder, queue changed files.
//   SQS { type: 'files', indexRunId, files }: read and index those files.
// Reads only the folders Paul added; read-only to Google; never touches
// QuickBooks.
const { scanFolder, indexFiles, scheduleNightly } = require('../../../shared/driveIndex');

exports.handler = async (event) => {
  if (event?.source === 'aws.events' || event?.['detail-type'] === 'Scheduled Event') return scheduleNightly();
  const results = [];
  for (const record of event.Records || []) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch {
      body = null;
    }
    if (body?.type === 'scan' && body.indexRunId) results.push(await scanFolder(body.indexRunId));
    else if (body?.type === 'files' && body.indexRunId && Array.isArray(body.files)) results.push(await indexFiles(body.indexRunId, body.files));
    else console.error('Ignoring malformed Drive index message', record.messageId);
  }
  return { results };
};
