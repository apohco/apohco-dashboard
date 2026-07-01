import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Box,
  Typography,
} from '@mui/material';
import { formatCurrency, formatPercent } from '../../utils/format';

function AmountCell({ amount, showPercentOfRevenue, revenueForPeriod, bold }) {
  return (
    <TableCell align="right" sx={{ fontWeight: bold ? 700 : 400, whiteSpace: 'nowrap' }}>
      {formatCurrency(amount)}
      {showPercentOfRevenue && (
        <Typography component="div" variant="caption" color="text.secondary">
          {formatPercent(amount, revenueForPeriod)}
        </Typography>
      )}
    </TableCell>
  );
}

function GroupingRows({ grouping, periods, detailLevel, showPercentOfRevenue, revenueByPeriod }) {
  if (detailLevel !== 'detail') {
    return (
      <TableRow>
        <TableCell sx={{ pl: 2 }}>{grouping.groupingName}</TableCell>
        {periods.map((p) => (
          <AmountCell
            key={p.label}
            amount={grouping.subtotalsByPeriod[p.label]}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={revenueByPeriod?.[p.label]}
          />
        ))}
      </TableRow>
    );
  }

  return (
    <>
      <TableRow>
        <TableCell colSpan={periods.length + 1} sx={{ pl: 2, fontWeight: 600, bgcolor: 'grey.50' }}>
          {grouping.groupingName}
        </TableCell>
      </TableRow>
      {(grouping.accounts || []).map((account) => (
        <TableRow key={account.accountCode || account.accountName}>
          <TableCell sx={{ pl: 5 }}>{account.accountName}</TableCell>
          {periods.map((p) => (
            <AmountCell
              key={p.label}
              amount={account.amountsByPeriod[p.label]}
              showPercentOfRevenue={showPercentOfRevenue}
              revenueForPeriod={revenueByPeriod?.[p.label]}
            />
          ))}
        </TableRow>
      ))}
      <TableRow>
        <TableCell sx={{ pl: 3, fontWeight: 600 }}>Total for {grouping.groupingName}</TableCell>
        {periods.map((p) => (
          <AmountCell
            key={p.label}
            amount={grouping.subtotalsByPeriod[p.label]}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={revenueByPeriod?.[p.label]}
            bold
          />
        ))}
      </TableRow>
    </>
  );
}

// Generic renderer for report sections shaped like
// { groupings: [{groupingId, groupingName, subtotalsByPeriod, accounts?}], totalsByPeriod }
// as returned by the P&L / Balance Sheet / Cash Flow report Lambdas.
export default function ReportTable({
  periods,
  sections, // [{ title, section }]
  summaryRows = [], // [{ label, valuesByPeriod, emphasize? }]
  detailLevel = 'summary',
  showPercentOfRevenue = false,
  revenueByPeriod,
}) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell />
            {periods.map((p) => (
              <TableCell key={p.label} align="right" sx={{ fontWeight: 700 }}>
                {p.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sections.map(({ title, section }) => (
            <Box key={title} component="tbody" sx={{ display: 'contents' }}>
              <TableRow>
                <TableCell colSpan={periods.length + 1} sx={{ fontWeight: 700, borderBottom: 'none' }}>
                  {title}
                </TableCell>
              </TableRow>
              {section.groupings.map((grouping) => (
                <GroupingRows
                  key={grouping.groupingId || grouping.groupingName}
                  grouping={grouping}
                  periods={periods}
                  detailLevel={detailLevel}
                  showPercentOfRevenue={showPercentOfRevenue}
                  revenueByPeriod={revenueByPeriod}
                />
              ))}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, borderTop: '2px solid #E3E5E8' }}>
                  Total {title}
                </TableCell>
                {periods.map((p) => (
                  <AmountCell
                    key={p.label}
                    amount={section.totalsByPeriod[p.label]}
                    showPercentOfRevenue={showPercentOfRevenue}
                    revenueForPeriod={revenueByPeriod?.[p.label]}
                    bold
                  />
                ))}
              </TableRow>
            </Box>
          ))}

          {summaryRows.map((row) => (
            <TableRow key={row.label}>
              <TableCell sx={{ fontWeight: 700, bgcolor: 'grey.100' }}>{row.label}</TableCell>
              {periods.map((p) => (
                <TableCell key={p.label} align="right" sx={{ fontWeight: 700, bgcolor: 'grey.100' }}>
                  {formatCurrency(row.valuesByPeriod[p.label])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
