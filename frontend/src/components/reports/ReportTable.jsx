import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
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

// A row's rendering only depends on its rowType: Grouping rows look like a
// normal line item (with an optional expanded account breakdown in Detail
// view); Total rows get a bold top border (today's old section-total
// style); Net rows get a bold grey band (today's old summary-row style) so
// things like "Net Income" still stand out at a glance.
function ReportRow({ row, periods, detailLevel, showPercentOfRevenue, revenueByPeriod }) {
  const isEmphasized = row.rowType === 'Total' || row.rowType === 'Net';
  const rowSx = row.rowType === 'Net' ? { bgcolor: 'grey.100' } : {};
  const cellSx = row.rowType === 'Total' ? { borderTop: '2px solid #E3E5E8' } : {};

  if (row.rowType !== 'Grouping' || detailLevel !== 'detail') {
    return (
      <TableRow sx={rowSx}>
        <TableCell sx={{ pl: row.rowType === 'Grouping' ? 2 : 0, fontWeight: isEmphasized ? 700 : 400, ...cellSx }}>
          {row.label}
        </TableCell>
        {periods.map((p) => (
          <AmountCell
            key={p.label}
            amount={row.valuesByPeriod[p.label]}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={revenueByPeriod?.[p.label]}
            bold={isEmphasized}
          />
        ))}
      </TableRow>
    );
  }

  return (
    <>
      <TableRow>
        <TableCell colSpan={periods.length + 1} sx={{ pl: 2, fontWeight: 600, bgcolor: 'grey.50' }}>
          {row.label}
        </TableCell>
      </TableRow>
      {(row.accounts || []).map((account) => (
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
        <TableCell sx={{ pl: 3, fontWeight: 600 }}>Total for {row.label}</TableCell>
        {periods.map((p) => (
          <AmountCell
            key={p.label}
            amount={row.valuesByPeriod[p.label]}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={revenueByPeriod?.[p.label]}
            bold
          />
        ))}
      </TableRow>
    </>
  );
}

// Renders a Report Layout's flat, ordered row list -- Grouping, Total, and
// Net rows interleaved exactly as configured in Settings > Report Layout
// (see reportHelpers.evaluateReportLayout on the backend), rather than the
// old fixed Income/Expenses-style sections.
export default function ReportTable({
  periods,
  rows, // [{rowId, rowType: 'Grouping'|'Total'|'Net', label, valuesByPeriod, accounts?}]
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
          {rows.map((row) => (
            <ReportRow
              key={row.rowId}
              row={row}
              periods={periods}
              detailLevel={detailLevel}
              showPercentOfRevenue={showPercentOfRevenue}
              revenueByPeriod={revenueByPeriod}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
