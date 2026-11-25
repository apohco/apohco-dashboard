import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Breadcrumbs,
  Chip,
  CircularProgress,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import useControllerGroup from '../../hooks/useControllerGroup';
import ControllerGroupSelect from '../../components/controller/ControllerGroupSelect';
import EntityStackedBars from '../../components/controller/EntityStackedBars';
import { getVendorProfile } from '../../api/controller';
import { monthsBetween } from '../../utils/months';
import { formatCurrency } from '../../utils/format';

const errorText = (err) => err?.response?.data?.message || err?.message;

// What a correction changed, in words.
export function describeCorrection(c, entityName) {
  if (c.action === 'Split') return `Split: ${(c.allocations || []).map((a) => `${entityName(a.entityId)} ${formatCurrency(a.amount)}`).join(', ')}`;
  if (c.action === 'Reclassify') return `Reclassified to ${[c.targetAccount?.code, c.targetAccount?.name].filter(Boolean).join(' ')}`;
  if (c.action === 'DueToFrom') return `Due To/From ${entityName(c.counterpartyEntityId)}`;
  return `${c.className || 'No class'} → ${entityName(c.entityId)}`;
}

function Stat({ label, value }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 160 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6">{value}</Typography>
    </Paper>
  );
}

export default function VendorProfile() {
  const { vendorId } = useParams();
  const { groupId, groups, groupsError, setGroupId } = useControllerGroup();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!groupId) return;
    setData(null);
    try {
      setData(await getVendorProfile(groupId, vendorId));
    } catch (err) {
      setError(err);
    }
  }, [groupId, vendorId]);
  useEffect(() => {
    load();
  }, [load]);

  const entities = useMemo(() => data?.entities || [], [data]);
  const entityName = useCallback((id) => (id ? entities.find((e) => e.entityId === id)?.entityName || 'Former entity' : 'Unassigned'), [entities]);
  const months = useMemo(() => {
    const ms = (data?.entitySplit || []).map((r) => r.month).sort();
    return ms.length ? monthsBetween(ms[0], ms[ms.length - 1]) : [];
  }, [data]);
  const totalSpend = (data?.entitySplit || []).reduce((s, r) => s + r.amount, 0);
  const rule = data?.ruleVersions?.[0];

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/controller/vendors">
          Vendors
        </Link>
        <Typography color="text.primary">{data?.vendor.displayName || 'Vendor'}</Typography>
      </Breadcrumbs>
      <Typography variant="h1" sx={{ mb: 2 }}>
        {data?.vendor.displayName || 'Vendor'}
        {data?.vendor.watchMode && <Chip size="small" label="Watch" sx={{ ml: 1, verticalAlign: 'middle' }} />}
      </Typography>
      <ControllerGroupSelect groups={groups} groupId={groupId} setGroupId={setGroupId} groupsError={groupsError} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorText(error)}</Alert>}
      {groupId && !data && !error && <CircularProgress size={24} />}

      {data && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Payee names: {data.vendor.aliases.join(', ') || '—'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
            <Stat label="Expense spend (all stored months)" value={formatCurrency(totalSpend)} />
            <Stat label="Lines" value={data.lineCount.toLocaleString()} />
            <Stat label="Approval rate" value={data.outcome.approvalRate === null ? '—' : `${Math.round(data.outcome.approvalRate * 100)}%`} />
            <Stat label="Approved · corrected · open" value={`${data.outcome.approved} · ${data.outcome.corrected} · ${data.outcome.open}`} />
            {data.outcome.relabeled > 0 && <Stat label="Relabeled history" value={data.outcome.relabeled.toLocaleString()} />}
            {data.ai?.decided > 0 && (
              <Stat label="AI suggestions you agreed with" value={`${data.ai.agreed} of ${data.ai.decided} (${Math.round(data.ai.agreeRate * 100)}%)`} />
            )}
          </Box>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <EntityStackedBars title="Spend by entity by month" rows={data.entitySplit} months={months} entities={entities} />
          </Paper>

          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Rule history
            </Typography>
            {!rule ? (
              <Typography color="text.secondary" variant="body2">
                No rule yet. Add one from Vendors → Edit.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Version</TableCell>
                    <TableCell>Default entity</TableCell>
                    <TableCell>Keywords</TableCell>
                    <TableCell>Written rule</TableCell>
                    <TableCell>Saved</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.ruleVersions.map((r) => (
                    <TableRow key={r.ruleId}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        v{r.version}
                        {r.ruleWins && <Chip size="small" variant="outlined" label="Rule wins" sx={{ ml: 1 }} />}
                      </TableCell>
                      <TableCell>{r.defaultEntityId ? entityName(r.defaultEntityId) : '—'}</TableCell>
                      <TableCell>{r.keywords.map((k) => `"${k.keyword}" → ${entityName(k.entityId)}`).join(', ') || '—'}</TableCell>
                      <TableCell sx={{ maxWidth: 360 }}>{r.ruleText || '—'}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {new Date(r.createdDate).toLocaleDateString()}
                        {r.createdBy ? ` · ${r.createdBy}` : ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>

          {(data.relabels || []).length > 0 && (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                History relabeled (rule wins)
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Decided</TableCell>
                    <TableCell>Relabeled to</TableCell>
                    <TableCell>Months</TableCell>
                    <TableCell align="right">Lines</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Adjusting entries</TableCell>
                    <TableCell>By</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.relabels.map((r) => (
                    <TableRow key={`${r.runId}-${r.entityId}-${r.requestAje}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(r.decidedAt).toLocaleDateString()}</TableCell>
                      <TableCell>{entityName(r.entityId)}</TableCell>
                      <TableCell>{r.fromMonth === r.toMonth ? r.fromMonth : `${r.fromMonth} to ${r.toMonth}`}</TableCell>
                      <TableCell align="right">{r.lineCount.toLocaleString()}</TableCell>
                      <TableCell align="right">{formatCurrency(r.amount)}</TableCell>
                      <TableCell>{r.requestAje ? 'Requested' : 'Not requested'}</TableCell>
                      <TableCell>{r.decidedBy || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          )}

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Corrections
            </Typography>
            {data.corrections.length === 0 ? (
              <Typography color="text.secondary" variant="body2">
                No corrections yet.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Decided</TableCell>
                    <TableCell>Line</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Change</TableCell>
                    <TableCell>By</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.corrections.map((c) => (
                    <TableRow key={c.decisionId}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(c.decidedAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {c.txnDate} · {c.qboName} · {c.account}
                        {c.memo && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            {c.memo}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{formatCurrency(c.amount)}</TableCell>
                      <TableCell>
                        {describeCorrection(c, entityName)}
                        {c.scope === 'Relabel' && <Chip size="small" variant="outlined" label="Relabeled history" sx={{ ml: 1 }} />}
                      </TableCell>
                      <TableCell>{c.decidedBy || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        </>
      )}
    </Box>
  );
}
