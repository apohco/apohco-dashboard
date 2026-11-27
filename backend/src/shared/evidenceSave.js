// Controller Phase 4b: "Save as support". After Paul confirms a candidate:
//   1. an email becomes a PDF (headers + text, then its PDF attachments'
//      pages and image attachments); a Drive file is fetched (a Google Doc
//      exported to PDF)
//   2. it is stored in the private evidence bucket (EVIDENCE_BUCKET)
//   3. a copy is filed in the admin's My Drive under
//      Controller Evidence / <practice> / <YYYY-MM> / date_vendor_amount.pdf
//   4. a confirmed email's sender is remembered for the vendor
// S3 is the record; a failed Drive copy is noted but doesn't fail the save.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query } = require('./db');
const { recordAudit } = require('./audit');
const google = require('./googleApi');
const { extractMessage } = require('./evidenceMatcher');
const { loadGoogleSettings } = require('./ctrlEvidence');

const ROOT_FOLDER = 'Controller Evidence';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const DOWNLOAD_URL_SECONDS = 300;
const GDOC = 'application/vnd.google-apps.document';

let s3 = null;
const getS3 = () => {
  if (!s3) s3 = new S3Client({});
  return s3;
};

// "2026-10-03_Minuteman-Press_1250.00.pdf"
function evidenceFileName({ txnDate, vendor, amount, ext = 'pdf' }) {
  const v = String(vendor || 'no-payee').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'no-payee';
  return `${txnDate}_${v}_${Math.abs(Number(amount) || 0).toFixed(2)}.${ext}`;
}

// The standard PDF fonts only encode Windows-1252: replace anything else.
const winAnsi = (s) =>
  String(s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

function wrap(text, font, size, width) {
  const out = [];
  for (const para of winAnsi(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
      // A single very long word is cut.
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// An email (extractMessage output) as a PDF; attachments: [{ name,
// mimeType, data }] (PDFs appended, JPEG/PNG as pages, others listed).
async function emailToPdf(msg, attachments = []) {
  // eslint-disable-next-line global-require
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 50;
  let page = doc.addPage();
  const { width, height } = page.getSize();
  let y = height - margin;
  const write = (text, { f = font, size = 10, gap = 3 } = {}) => {
    for (const ln of wrap(text, f, size, width - margin * 2)) {
      if (y < margin) {
        page = doc.addPage();
        y = height - margin;
      }
      page.drawText(ln, { x: margin, y, size, font: f, color: rgb(0, 0, 0) });
      y -= size + gap;
    }
  };
  write(msg.subject || '(no subject)', { f: bold, size: 13, gap: 6 });
  write(`From: ${msg.from}`);
  if (msg.to) write(`To: ${msg.to}`);
  write(`Date: ${msg.sentAt ? new Date(msg.sentAt).toUTCString() : ''}`);
  if (attachments.length) write(`Attachments: ${attachments.map((a) => a.name).join(', ')}`);
  y -= 8;
  write(msg.text || '(no text)');

  for (const a of attachments) {
    try {
      if (a.mimeType === 'application/pdf') {
        const src = await PDFDocument.load(a.data, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (a.mimeType === 'image/jpeg' || a.mimeType === 'image/png') {
        const img = a.mimeType === 'image/png' ? await doc.embedPng(a.data) : await doc.embedJpg(a.data);
        const p = doc.addPage();
        const s = Math.min((width - margin * 2) / img.width, (height - margin * 2 - 20) / img.height, 1);
        p.drawText(winAnsi(a.name), { x: margin, y: height - margin, size: 9, font });
        p.drawImage(img, { x: margin, y: height - margin - 20 - img.height * s, width: img.width * s, height: img.height * s });
      }
    } catch {
      // An unreadable attachment stays listed by name only.
    }
  }
  return Buffer.from(await doc.save());
}

// An image as a one-page PDF.
async function imageToPdf(name, mimeType, data) {
  return emailToPdf({ subject: name, from: '', text: '' }, [{ name, mimeType, data }]);
}

// The admin's folder for this path (created as needed; ids cached in
// CtrlEvidenceFolders since drive.file only sees what the app created).
async function ensureFolder(groupId, adminEmail, parts, api) {
  let parentId = null;
  let path = '';
  for (const name of parts) {
    path = path ? `${path}/${name}` : name;
    const { rows } = await query(`SELECT FolderId FROM CtrlEvidenceFolders WHERE GroupId = $1 AND Path = $2`, [groupId, path]);
    if (rows.length) {
      parentId = rows[0].folderid;
      continue;
    }
    const created = await api.driveCreateFolder(adminEmail, name, parentId);
    await query(`INSERT INTO CtrlEvidenceFolders (GroupId, Path, FolderId) VALUES ($1, $2, $3) ON CONFLICT (GroupId, Path) DO NOTHING`, [groupId, path, created.id]);
    const { rows: again } = await query(`SELECT FolderId FROM CtrlEvidenceFolders WHERE GroupId = $1 AND Path = $2`, [groupId, path]);
    parentId = again[0].folderid;
  }
  return parentId;
}

const senderEmail = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '').trim()).toLowerCase();

async function loadSave(saveId) {
  const { rows } = await query(
    `UPDATE CtrlEvidenceSaved s SET Attempts = s.Attempts + 1, Error = NULL
     WHERE s.SavedId = $1 AND s.Status = 'Saving'
     RETURNING s.SavedId, s.GroupId, s.QBOId, s.Fingerprint, s.LineId, s.Source, s.SourceAccount, s.ExternalId, s.EntityId, s.Attempts, s.ConfirmedBy`,
    [saveId]
  );
  return rows[0] || null;
}

// Does the save. Throws for SQS to retry until the last attempt.
async function processSave(saveId, { api = google, s3Client = getS3(), bucket = process.env.EVIDENCE_BUCKET } = {}) {
  const save = await loadSave(saveId);
  if (!save) return { saveId, status: 'Skipped (nothing to do)' };
  const fail = async (message) => {
    await query(`UPDATE CtrlEvidenceSaved SET Status = 'Failed', Error = $2 WHERE SavedId = $1`, [saveId, String(message).slice(0, 1000)]);
    return { saveId, status: 'Failed', error: message };
  };
  try {
    if (!bucket) throw Object.assign(new Error('EVIDENCE_BUCKET is not set'), { permanent: true });
    const { rows: lines } = await query(
      `SELECT TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.Amount, l.PayeeName, v.VendorId, COALESCE(v.DisplayName, l.PayeeName) AS Vendor
       FROM CtrlLedgerLines l
       LEFT JOIN CtrlVendorAliases a ON a.GroupId = l.GroupId
         AND a.PayeeKey = NULLIF(btrim(regexp_replace(lower(COALESCE(l.PayeeName, '')), '[^a-z0-9]+', ' ', 'g')), '')
       LEFT JOIN CtrlVendors v ON v.VendorId = a.VendorId
       WHERE l.LineId = $1`,
      [save.lineid]
    );
    const line = lines[0];
    if (!line) throw Object.assign(new Error('The line no longer exists'), { permanent: true });
    const settings = await loadGoogleSettings(save.groupid);
    if (!settings) throw Object.assign(new Error('The Google Workspace connection is not set up'), { permanent: true });

    let data;
    let contentType = 'application/pdf';
    let ext = 'pdf';
    let sender = null;
    if (save.source === 'Gmail') {
      const raw = await api.gmailGetMessage(save.sourceaccount, save.externalid, { format: 'full' });
      const msg = extractMessage(raw);
      sender = senderEmail(msg.from);
      const attachments = [];
      for (const a of msg.attachments.slice(0, MAX_ATTACHMENTS)) {
        if (!a.attachmentId || a.size > MAX_ATTACHMENT_BYTES) continue;
        attachments.push({ name: a.name, mimeType: a.mimeType, data: await api.gmailGetAttachment(save.sourceaccount, save.externalid, a.attachmentId) });
      }
      data = await emailToPdf(msg, attachments);
    } else {
      const { rows: src } = await query(`SELECT ActAs, Enabled FROM CtrlGoogleSources WHERE SourceId = $1 AND Kind = 'Folder'`, [save.sourceaccount]);
      if (!src.length || !src[0].enabled) throw Object.assign(new Error('The invoice folder is no longer switched on'), { permanent: true });
      const meta = await api.driveGetFile(src[0].actas, save.externalid, { fields: 'id,name,mimeType,size' });
      if (meta.mimeType === GDOC) data = await api.driveExport(src[0].actas, save.externalid, 'application/pdf');
      else {
        data = await api.driveDownload(src[0].actas, save.externalid);
        if (meta.mimeType === 'image/jpeg' || meta.mimeType === 'image/png') data = await imageToPdf(meta.name, meta.mimeType, data);
        else if (meta.mimeType !== 'application/pdf') {
          contentType = meta.mimeType;
          ext = (meta.name.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] || 'bin').toLowerCase();
        }
      }
    }

    const fileName = evidenceFileName({ txnDate: line.txndate, vendor: line.vendor, amount: line.amount, ext });
    const month = line.txndate.slice(0, 7);
    const s3Key = `${save.groupid}/${save.qboid}/${month}/${saveId}/${fileName}`;
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));

    // The Drive copy, filed by practice and month.
    let driveFileId = null;
    let drivePath = null;
    let driveError = null;
    try {
      const { rows: ent } = await query(`SELECT EntityName FROM CtrlEntities WHERE EntityId = $1`, [save.entityid]);
      const practice = (ent[0]?.entityname || 'Unassigned').replace(/[/\\]/g, '-');
      const folderId = await ensureFolder(save.groupid, settings.adminEmail, [ROOT_FOLDER, practice, month], api);
      const up = await api.driveUpload(settings.adminEmail, { name: fileName, parentId: folderId, mimeType: contentType, data });
      driveFileId = up.id;
      drivePath = `${ROOT_FOLDER} / ${practice} / ${month} / ${fileName}`;
    } catch (err) {
      driveError = `Saved; the Drive copy failed: ${err.message}`;
    }

    await query(
      `UPDATE CtrlEvidenceSaved SET Status = 'Saved', S3Key = $2, FileName = $3, SizeBytes = $4, DriveFileId = $5, DrivePath = $6, Error = $7, SavedAt = now()
       WHERE SavedId = $1`,
      [saveId, s3Key, fileName, data.length, driveFileId, drivePath, driveError]
    );
    if (sender && line.vendorid && /@/.test(sender)) {
      await query(
        `INSERT INTO CtrlVendorSenders (GroupId, VendorId, Email) VALUES ($1, $2, $3)
         ON CONFLICT (VendorId, Email) DO UPDATE SET ConfirmCount = CtrlVendorSenders.ConfirmCount + 1, LastConfirmedAt = now()`,
        [save.groupid, line.vendorid, sender.slice(0, 255)]
      );
    }
    await recordAudit({
      groupId: save.groupid, userId: save.confirmedby, action: 'ctrl.evidence.save', targetType: 'CtrlEvidenceSaved', targetId: saveId,
      details: { source: save.source, fileName, bytes: data.length, driveCopied: Boolean(driveFileId) },
    });
    return { saveId, status: 'Saved', fileName, bytes: data.length, driveCopied: Boolean(driveFileId) };
  } catch (err) {
    if (err.permanent || save.attempts >= MAX_ATTEMPTS) return fail(err.message);
    throw err;
  }
}

// A short-lived download link for saved support.
async function downloadUrl(s3Key, fileName, { s3Client = getS3(), bucket = process.env.EVIDENCE_BUCKET } = {}) {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: s3Key, ResponseContentDisposition: `attachment; filename="${String(fileName).replace(/"/g, '')}"` }),
    { expiresIn: DOWNLOAD_URL_SECONDS }
  );
}

module.exports = { ROOT_FOLDER, evidenceFileName, winAnsi, wrap, emailToPdf, imageToPdf, ensureFolder, senderEmail, processSave, downloadUrl, DOWNLOAD_URL_SECONDS };
