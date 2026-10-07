// ============================================================
// TEMPORARY / TEST-ONLY — P2M-2 Authenticated Dispatch Test Harness
// ------------------------------------------------------------
// Purpose: exercise the existing SECURITY DEFINER RPC
//   public.record_dispatch(p_sales_order_id uuid, p_lines jsonb, p_notes text)
// from an AUTHENTICATED Winerix browser session, using the existing
// shared Supabase browser client and the current user's session.
//
// This component performs NO direct table writes. The ONLY state-changing
// operation is the record_dispatch RPC call. It is not wired into normal
// production navigation. Reachable only at /dispatch-test (dev/test use).
//
// DO NOT ship to production navigation. Remove after P2M-2 dispatch testing
// is complete (we still need it for the follow-up 40-bottle test).
// ============================================================
import { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Alert,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Chip,
  CircularProgress,
} from '@mui/material';
import { supabase } from '../services/supabase';

// --- Fixed test parameters (verified test data for SO-2026-0002) ---
const TEST_SALES_ORDER_ID = 'c865b8f5-24de-40c7-9f3a-513149849fa4';
const TEST_SALES_ORDER_NUMBER = 'SO-2026-0002';
const TEST_ALLOCATION_ID = '06a097ee-910f-4f76-977c-6687c9da7340';
const TEST_LOCATION_ID = '182fe838-b216-4438-82ea-48b7992bdcf5';
const TEST_LOCATION_NAME = 'FG-STORE-01';
const TEST_QTY = 40;
const TEST_NOTES = 'P2M-2 final dispatch test — 40 bottles';

const TEST_LINES = [
  {
    stock_allocation_id: TEST_ALLOCATION_ID,
    qty_bottles: TEST_QTY,
  },
];

// Order the result fields are shown in (matches record_dispatch RETURNS TABLE).
const RESULT_FIELDS = [
  'dispatch_id',
  'dispatch_number',
  'sales_order_id',
  'dispatch_status',
  'dispatched_at',
  'order_status',
  'dispatch_line_id',
  'stock_allocation_id',
  'sales_order_line_id',
  'finished_product_id',
  'location_id',
  'qty_bottles',
  'stock_movement_id',
  'allocation_status',
  'allocation_fulfilled',
  'location_physical',
];

export default function DispatchTestHarness() {
  // 'idle' | 'running' | 'done' | 'error'
  const [phase, setPhase] = useState('idle');
  const [rows, setRows] = useState(null);
  const [errorText, setErrorText] = useState(null);

  async function handleRunTest() {
    // Instruction 6: prevent accidental duplicate execution — guard against
    // re-entry while a call is in flight or after it has already run.
    if (phase === 'running' || phase === 'done') return;

    setPhase('running');
    setRows(null);
    setErrorText(null);

    try {
      // Instruction 1-4: use the existing shared, authenticated browser client
      // and call the existing RPC exactly as specified. No service role,
      // no alternative dispatch path, no direct table writes.
      const { data, error } = await supabase.rpc('record_dispatch', {
        p_sales_order_id: TEST_SALES_ORDER_ID,
        p_lines: TEST_LINES,
        p_notes: TEST_NOTES,
      });

      if (error) {
        // Instruction 8: surface the real Supabase/Postgres error verbatim.
        setErrorText(formatSupabaseError(error));
        setPhase('error');
        return;
      }

      // record_dispatch RETURNS TABLE -> supabase returns an array of row objects.
      const resultRows = Array.isArray(data) ? data : data ? [data] : [];
      setRows(resultRows);
      setPhase('done');
    } catch (e) {
      setErrorText(formatSupabaseError(e));
      setPhase('error');
    }
  }

  return (
    <Box sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Paper elevation={0} sx={{ p: 3, border: '2px dashed', borderColor: 'warning.main' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Chip label="TEST-ONLY" color="warning" size="small" />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            P2M-2 Authenticated Dispatch Test Harness
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Temporary developer harness. Calls the existing{' '}
          <code>record_dispatch</code> RPC once, using your current authenticated
          session. Performs no direct table writes.
        </Typography>

        <Divider sx={{ my: 2 }} />

        {/* Instruction 7: show the test parameters before calling the RPC. */}
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          Test parameters
        </Typography>
        <Table size="small" sx={{ mb: 2 }}>
          <TableBody>
            <ParamRow label="Order" value={`${TEST_SALES_ORDER_NUMBER} (${TEST_SALES_ORDER_ID})`} />
            <ParamRow label="Dispatch" value={`${TEST_QTY} bottles`} />
            <ParamRow label="Allocation" value={TEST_ALLOCATION_ID} />
            <ParamRow label="Location" value={`${TEST_LOCATION_NAME} / ${TEST_LOCATION_ID}`} />
            <ParamRow label="Notes" value={TEST_NOTES} />
          </TableBody>
        </Table>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Exact RPC call:
        </Typography>
        <Box
          component="pre"
          sx={{
            bgcolor: 'grey.100',
            p: 1.5,
            borderRadius: 1,
            fontSize: '0.75rem',
            overflowX: 'auto',
            mb: 2,
          }}
        >
{`supabase.rpc('record_dispatch', {
  p_sales_order_id: '${TEST_SALES_ORDER_ID}',
  p_lines: ${JSON.stringify(TEST_LINES)},
  p_notes: '${TEST_NOTES}'
})`}
        </Box>

        <Divider sx={{ my: 2 }} />

        {/* Instruction 6: single deliberate action, disabled while running / after done. */}
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={handleRunTest}
          disabled={phase === 'running' || phase === 'done'}
          startIcon={phase === 'running' ? <CircularProgress size={18} color="inherit" /> : null}
        >
          {phase === 'running'
            ? 'Running…'
            : phase === 'done'
            ? 'Test dispatch sent (reload page to run again)'
            : 'Run P2M-2 Test Dispatch'}
        </Button>
        {phase === 'done' && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            To avoid accidental duplicate dispatches, this button stays disabled
            after a successful run. Reload the page to run another test.
          </Typography>
        )}

        {/* Instruction 8: show the real backend error, verbatim. */}
        {phase === 'error' && errorText && (
          <Alert severity="error" sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              RPC returned an error (verbatim):
            </Typography>
            {errorText}
          </Alert>
        )}

        {/* Instruction 5: display the returned RPC result clearly. */}
        {phase === 'done' && rows && (
          <Box sx={{ mt: 2 }}>
            <Alert severity="success" sx={{ mb: 2 }}>
              RPC succeeded. {rows.length} dispatch line row
              {rows.length === 1 ? '' : 's'} returned.
            </Alert>
            {rows.map((row, idx) => (
              <Paper key={idx} variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                  Result row {idx + 1}
                </Typography>
                <Table size="small">
                  <TableBody>
                    {RESULT_FIELDS.map((field) => (
                      <TableRow key={field}>
                        <TableCell sx={{ fontWeight: 600, width: '45%', verticalAlign: 'top' }}>
                          {field}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                          {formatValue(row?.[field])}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            ))}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Raw response:
            </Typography>
            <Box
              component="pre"
              sx={{
                bgcolor: 'grey.100',
                p: 1.5,
                borderRadius: 1,
                fontSize: '0.7rem',
                overflowX: 'auto',
              }}
            >
              {JSON.stringify(rows, null, 2)}
            </Box>
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function ParamRow({ label, value }) {
  return (
    <TableRow>
      <TableCell sx={{ fontWeight: 600, width: '20%' }}>{label}</TableCell>
      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{value}</TableCell>
    </TableRow>
  );
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  return String(v);
}

// Surface the real backend error without replacing it with a generic message.
function formatSupabaseError(error) {
  if (!error) return 'Unknown error (no error object).';
  const parts = [];
  if (error.message) parts.push(`message: ${error.message}`);
  if (error.code) parts.push(`code: ${error.code}`);
  if (error.details) parts.push(`details: ${error.details}`);
  if (error.hint) parts.push(`hint: ${error.hint}`);
  if (parts.length === 0) parts.push(JSON.stringify(error));
  return parts.join('\n');
}
