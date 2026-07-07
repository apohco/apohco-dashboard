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

function AmountCell({ amount, showPercentOfRevenue, revenueForPeriod, bold, emphasizeBorder }) {
  return (
    <TableCell
      align="right"
      sx={{ fontWeight: bold ? 700 : 400, whiteSpace: 'nowrap', ...(emphasizeBorder ? { borderLeft: '2px solid #E3E5E8' } : {}) }}
    >
      {formatCurrency(amount)}
      {showPercentOfRevenue && (
        <Typography component="div" variant="caption" color="text.secondary">
          {formatPercent(amount, revenueForPeriod)}
        </Typography>
      )}
    </TableCell>
  );
}

function sumAcrossPeriods(valuesByPeriod, periods) {
  return periods.reduce((sum, p) => sum + (valuesByPeriod?.[p.label] || 0), 0);
}

// A row's rendering only depends on its rowType: Grouping rows look like a
// normal line item (with an optional expanded account breakdown in Detail
// view); Total rows get a bold top border (today's old section-total
// style); Net rows get a bold grey band (today's old summary-row style) so
// things like "Net Income" still stand out at a glance.
function ReportRow({ row, periods, detailLevel, showPercentOfRevenue, revenueByPeriod, showTotalColumn, totalRevenue }) {
  const isEmphasized = row.rowType === 'Total' || row.rowType === 'Net';
  const rowSx = row.rowType === 'Net' ? { bgcolor: 'grey.100' } : {};
  const cellSx = row.rowType === 'Total' ? { borderTop: '2px solid #E3E5E8' } : {};
  const colSpan = periods.length + 1 + (showTotalColumn ? 1 : 0);

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
        {showTotalColumn && (
          <AmountCell
            amount={sumAcrossPeriods(row.valuesByPeriod, periods)}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={totalRevenue}
            bold={isEmphasized}
            emphasizeBorder
          />
        )}
      </TableRow>
    );
  }

  return (
    <>
      <TableRow>
        <TableCell colSpan={colSpan} sx={{ pl: 2, fontWeight: 600, bgcolor: 'grey.50' }}>
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
          {showTotalColumn && (
            <AmountCell
              amount={sumAcrossPeriods(account.amountsByPeriod, periods)}
              showPercentOfRevenue={showPercentOfRevenue}
              revenueForPeriod={totalRevenue}
              emphasizeBorder
            />
          )}
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
        {showTotalColumn && (
          <AmountCell
            amount={sumAcrossPeriods(row.valuesByPeriod, periods)}
            showPercentOfRevenue={showPercentOfRevenue}
            revenueForPeriod={totalRevenue}
            bold
            emphasizeBorder
          />
        )}
      </TableRow>
    </>
  );
}

// Renders a Report Layout's flat, ordered row list -- Grouping, Total, and
// Net rows interleaved exactly as configured in Settings > Report Layout
// (see reportHelpers.evaluateReportLayout on the backend), rather than the
// old fixed Income/Expenses-style sections. `showTotalColumn` adds a
// right-hand column summing each row across all given periods (used by
// Multi-Month view).
export default function ReportTable({
  periods,
  rows, // [{rowId, rowType: 'Grouping'|'Total'|'Net', label, valuesByPeriod, accounts?}]
  detailLevel = 'summary',
  showPercentOfRevenue = false,
  revenueByPeriod,
  showTotalColumn = false,
}) {
  const totalRevenue = revenueByPeriod ? sumAcrossPeriods(revenueByPeriod, periods) : undefined;

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ display: 'inline-block', maxWidth: '100%' }}>
      <Table size="small" sx={{ width: 'auto' }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ minWidth: 260 }} />
            {periods.map((p) => (
              <TableCell key={p.label} align="right" sx={{ fontWeight: 700, minWidth: 130 }}>
                {p.label}
              </TableCell>
            ))}
            {showTotalColumn && (
              <TableCell align="right" sx={{ fontWeight: 700, minWidth: 130, borderLeft: '2px solid #E3E5E8' }}>
                Total
              </TableCell>
            )}
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
              showTotalColumn={showTotalColumn}
              totalRevenue={totalRevenue}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
