import { useMemo, useState } from 'react';
import { Box, Button, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TEXT, CHART_SURFACE, GRID_COLOR, colorFor, entityColorMap, pivotByMonth } from '../../utils/entityColors';
import { formatCurrency } from '../../utils/format';
import { formatMonth } from '../../utils/months';

const shortMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};
const compactCurrency = (v) =>
  Math.abs(v) >= 1000 ? `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : `$${Math.round(v).toLocaleString('en-US')}`;

function ChartTooltip({ active, payload, label, nameOf, percent }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, p: 1, boxShadow: 1, minWidth: 180 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
        {formatMonth(label)}
      </Typography>
      {[...rows].reverse().map((p) => (
        <Box key={p.dataKey} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: p.color, flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            {nameOf(p.dataKey)}
          </Typography>
          <Typography variant="caption">{percent ? `${Math.round((p.value / total) * 100)}%` : formatCurrency(p.value)}</Typography>
        </Box>
      ))}
      {!percent && rows.length > 1 && (
        <Typography variant="caption" display="block" sx={{ mt: 0.5, textAlign: 'right' }}>
          Total {formatCurrency(total)}
        </Typography>
      )}
    </Box>
  );
}

// Stacked monthly bars, one color per entity (stable across charts).
//   rows: [{ month, entityId|null, amount }]; months: ['YYYY-MM', ...]
//   percent: show each month as shares of 100% (e.g. a vendor's split)
export default function EntityStackedBars({ rows, months, entities, title, percent = false, height = 280 }) {
  const [showTable, setShowTable] = useState(false);
  const colors = useMemo(() => entityColorMap(entities), [entities]);
  const { data, keys } = useMemo(() => pivotByMonth(rows, months, entities), [rows, months, entities]);
  const nameOf = (key) => (key ? entities.find((e) => e.entityId === key)?.entityName || 'Former entity' : 'Unassigned');

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
          {title}
        </Typography>
        <Button size="small" onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Show chart' : 'Show table'}
        </Button>
      </Box>
      {keys.length === 0 ? (
        <Typography color="text.secondary" variant="body2">
          No spend in these months.
        </Typography>
      ) : showTable ? (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={`${title} table`}>
            <TableHead>
              <TableRow>
                <TableCell>Month</TableCell>
                {keys.map((k) => (
                  <TableCell key={k} align="right">
                    {nameOf(k)}
                  </TableCell>
                ))}
                <TableCell align="right">Total</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((d) => {
                const total = keys.reduce((s, k) => s + (d[k] || 0), 0);
                return (
                  <TableRow key={d.month}>
                    <TableCell>{formatMonth(d.month)}</TableCell>
                    {keys.map((k) => (
                      <TableCell key={k} align="right">
                        {percent ? (total ? `${Math.round(((d[k] || 0) / total) * 100)}%` : '—') : formatCurrency(d[k] || 0)}
                      </TableCell>
                    ))}
                    <TableCell align="right">{formatCurrency(total)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      ) : (
        <Box sx={{ width: '100%', height }} data-testid="stacked-chart">
          <ResponsiveContainer>
            <BarChart data={data} stackOffset={percent ? 'expand' : 'sign'} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke={GRID_COLOR} />
              <XAxis dataKey="month" tickFormatter={shortMonth} tick={{ fill: AXIS_TEXT, fontSize: 12 }} axisLine={{ stroke: GRID_COLOR }} tickLine={false} />
              <YAxis
                tickFormatter={percent ? (v) => `${Math.round(v * 100)}%` : compactCurrency}
                tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={56}
              />
              <Tooltip content={<ChartTooltip nameOf={nameOf} percent={percent} />} cursor={{ fill: GRID_COLOR, fillOpacity: 0.4 }} />
              <Legend formatter={(key) => <span style={{ color: AXIS_TEXT, fontSize: 12 }}>{nameOf(key)}</span>} iconType="square" />
              {keys.map((k) => (
                <Bar key={k} dataKey={k} stackId="a" fill={colorFor(colors, k)} stroke={CHART_SURFACE} strokeWidth={2} name={k} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Box>
      )}
    </Box>
  );
}
