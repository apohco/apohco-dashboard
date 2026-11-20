const { query } = require('../../../shared/db');
const { getValidAccessToken, isRefreshTokenRejected } = require('../../../shared/qboTokens');
const { recordAudit } = require('../../../shared/audit');

// Scheduled daily (EventBridge, see template.yaml). Renews the OAuth tokens
// of every API-connected QBO file so a connection doesn't lapse just
// because nobody pulled from that file for a while. It reads no financial
// data: the only Intuit call is the OAuth token endpoint.
//
// Invoked by EventBridge, not API Gateway, so there is no caller JWT to
// verify; the function has no API route.
exports.handler = async () => {
  const { rows } = await query(
    `SELECT QBOId, GroupId, QBOName FROM QBOs WHERE RefreshToken IS NOT NULL ORDER BY QBOName`
  );

  const refreshed = [];
  const failed = [];

  // Sequential on purpose: a handful of files, and each refresh holds a
  // row lock on its QBOs row while it talks to Intuit.
  for (const qbo of rows) {
    try {
      await getValidAccessToken(qbo.qboid, { forceRefresh: true });
      refreshed.push(qbo.qboid);
    } catch (err) {
      const reason = isRefreshTokenRejected(err)
        ? 'Intuit rejected the refresh token; reconnect this file in Settings > QBO API Setup'
        : err?.response?.status
          ? `Intuit HTTP ${err.response.status}`
          : err?.message || 'Unknown error';
      console.error(`Token refresh failed for QBO ${qbo.qboid} (${qbo.qboname}): ${reason}`);
      failed.push({ qboId: qbo.qboid, groupId: qbo.groupid, qboName: qbo.qboname, reason });
    }
  }

  for (const f of failed) {
    await recordAudit({
      groupId: f.groupId,
      action: 'qbo.token_refresh_failed',
      targetType: 'QBO',
      targetId: f.qboId,
      details: { qboName: f.qboName, reason: f.reason },
    }).catch((err) => console.error('Could not write audit entry:', err.message));
  }

  console.log(`QBO token refresh: ${refreshed.length} refreshed, ${failed.length} failed`);
  return { refreshed: refreshed.length, failed: failed.length };
};
