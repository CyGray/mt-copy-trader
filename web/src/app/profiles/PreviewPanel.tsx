'use client';

import { Button } from '@/components/ui/Button';
import { fmt, fmtMoney, type PreviewForm } from './model';
import type { ProfilePreview } from '@/lib/profilePreview';

interface PreviewPanelProps {
  form: PreviewForm;
  busy: boolean;
  preview: ProfilePreview | null;
  previewRan: boolean;
  previewError: string | null;
  onChange: (field: keyof PreviewForm, value: string) => void;
  onRun: () => void;
}

const ORDER_TYPES: PreviewForm['orderType'][] = ['market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'];

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number';
}) {
  return (
    <label className="block text-xs text-marine-navy/70">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-lg border border-marine-navy/20 bg-white px-2 font-mono text-xs text-marine-navy focus:border-marine-accent focus:outline-none"
      />
    </label>
  );
}

function StageRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  const tone = ok === null ? 'text-marine-navy/40' : ok ? 'text-trade-up' : 'text-trade-down';
  const mark = ok === null ? 'not run' : ok ? 'pass' : 'refused';
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-marine-navy/5 py-2 text-sm last:border-b-0">
      <span className="font-medium text-marine-navy">{label}</span>
      <span className={`text-xs font-semibold uppercase ${tone}`}>{mark}</span>
      {detail ? <p className="w-full text-xs text-marine-navy/60">{detail}</p> : null}
    </div>
  );
}

function PreviewResults({ preview }: { preview: ProfilePreview }) {
  const { entry, stopLoss, sizing, checkpoints } = preview;
  const entryOk = entry ? entry.ok : null;
  const slOk = stopLoss ? stopLoss.ok : null;
  const sizingOk = sizing ? sizing.ok : null;
  const cpOk = checkpoints ? checkpoints.ok : null;

  return (
    <div className="space-y-4">
      <p className={`rounded-lg border px-3 py-2 text-sm ${preview.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
        {preview.ok
          ? 'The sample signal would be placed under this profile.'
          : `The sample signal is refused at the ${preview.failedAt?.replace('_', ' ') ?? 'unknown'} stage.`}
      </p>

      <div className="rounded-lg border border-marine-navy/10 px-3">
        <StageRow
          label="Symbol"
          ok={preview.symbolMapped}
          detail={preview.symbolMapped ? `Broker symbol ${preview.brokerSymbol}` : 'Signal symbol is not mapped in symbols[].'}
        />
        <StageRow
          label="Entry"
          ok={entryOk}
          detail={
            entry?.ok
              ? `${entry.orderType} at ${fmt(entry.orderPrice || entry.entryRefPrice, 2)}${entry.isPending ? ' (pending)' : ' (market)'}`
              : entry
                ? `${entry.reason}: ${entry.detail}`
                : ''
          }
        />
        <StageRow
          label="Stop loss"
          ok={slOk}
          detail={stopLoss ? (stopLoss.ok ? 'Side and distance within bounds.' : `${stopLoss.reason}: ${stopLoss.detail}`) : ''}
        />
        <StageRow
          label="Sizing"
          ok={sizingOk}
          detail={
            sizing
              ? sizing.ok
                ? `${sizing.volume.toFixed(2)} lots · risk ${fmtMoney(sizing.riskMoney)} (${fmt(sizing.riskPercent, 3)}% of equity)${sizing.clampedBy ? ` · clamped by ${sizing.clampedBy}` : ''}`
                : `${sizing.reason}: ${sizing.detail}`
              : ''
          }
        />
        <StageRow
          label="Checkpoints"
          ok={cpOk}
          detail={checkpoints ? (checkpoints.ok ? 'Split feasible.' : `${checkpoints.reason}: ${checkpoints.detail}`) : ''}
        />
      </div>

      {checkpoints && checkpoints.ok ? (
        <div>
          <div className="overflow-x-auto rounded-lg border border-marine-navy/10">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-marine-mist/60 uppercase tracking-wider text-marine-navy/60">
                <tr>
                  <th className="px-2 py-1.5 font-medium">TP</th>
                  <th className="px-2 py-1.5 font-medium">Price</th>
                  <th className="px-2 py-1.5 font-medium">Close %</th>
                  <th className="px-2 py-1.5 font-medium">Close volume</th>
                  <th className="px-2 py-1.5 font-medium">Remaining after</th>
                </tr>
              </thead>
              <tbody>
                {checkpoints.checkpoints.map((cp) => (
                  <tr key={cp.tpIndex} className="border-t border-marine-navy/10 font-mono">
                    <td className="px-2 py-1.5">TP{cp.tpIndex}</td>
                    <td className="px-2 py-1.5">{fmt(cp.price, 2)}</td>
                    <td className="px-2 py-1.5">{fmt(cp.closePercent, 2)}</td>
                    <td className="px-2 py-1.5">{cp.closeVolume.toFixed(2)}</td>
                    <td className="px-2 py-1.5">{cp.targetRemainingVolume.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {checkpoints.brokerTp > 0 ? (
            <p className="mt-2 text-xs text-marine-navy/60">Broker TP at {fmt(checkpoints.brokerTp, 2)}.</p>
          ) : null}
          {checkpoints.warnings.map((warning, index) => (
            <p key={index} className="mt-1 text-xs text-amber-700">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <p className="text-xs text-marine-navy/50">
        Effective limits: risk {fmt(preview.limits.maxRiskPercent, 2)}% / {fmtMoney(preview.limits.maxRiskMoney)} per
        trade · max {fmt(preview.limits.maxLots, 2)} lots · spread {fmt(preview.limits.maxSpreadPrice, 2)} · daily loss{' '}
        {fmtMoney(preview.limits.dailyLossLimit)}. Runtime checks (open positions, spread, signal age) are not part of this preview.
      </p>
    </div>
  );
}

/** Sample-signal preview. Runs the profile in the editor against these inputs via the validate route. */
export function PreviewPanel({
  form,
  busy,
  preview,
  previewRan,
  previewError,
  onChange,
  onRun,
}: PreviewPanelProps) {
  const set = (field: keyof PreviewForm) => (value: string) => onChange(field, value);

  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-marine-navy">Execution preview</h2>
      <p className="mt-1 text-sm text-marine-navy/70">
        Runs the entry, stop-loss, sizing and checkpoint steps for one sample signal. Nothing is sent to the broker.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Signal symbol" value={form.symbol} onChange={set('symbol')} />
        <label className="block text-xs text-marine-navy/70">
          Direction
          <select
            value={form.direction}
            onChange={(event) => onChange('direction', event.target.value)}
            className="mt-1 h-8 w-full rounded-lg border border-marine-navy/20 bg-white px-2 text-xs text-marine-navy"
          >
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        </label>
        <label className="block text-xs text-marine-navy/70">
          Order type
          <select
            value={form.orderType}
            onChange={(event) => onChange('orderType', event.target.value)}
            className="mt-1 h-8 w-full rounded-lg border border-marine-navy/20 bg-white px-2 text-xs text-marine-navy"
          >
            {ORDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <Field label="Equity" value={form.equity} onChange={set('equity')} type="number" />
        <Field label="Entry low" value={form.entryLow} onChange={set('entryLow')} type="number" />
        <Field label="Entry high" value={form.entryHigh} onChange={set('entryHigh')} type="number" />
        <Field label="Stop loss" value={form.stopLoss} onChange={set('stopLoss')} type="number" />
        <Field label="Take profits (comma-separated)" value={form.takeProfits} onChange={set('takeProfits')} />
        <Field label="Bid" value={form.bid} onChange={set('bid')} type="number" />
        <Field label="Ask" value={form.ask} onChange={set('ask')} type="number" />
      </div>

      <details className="mt-4 rounded-lg border border-marine-navy/10 p-3">
        <summary className="cursor-pointer text-xs font-medium text-marine-navy/70">Symbol spec (defaults are XAUUSD-like)</summary>
        <p className="mt-2 text-xs text-marine-navy/60">
          Illustrative values. Real tick size, tick value, volume limits and step come from the broker&apos;s SYMBOL_INFO at
          execution time.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="Tick size" value={form.tickSize} onChange={set('tickSize')} type="number" />
          <Field label="Tick value loss" value={form.tickValueLoss} onChange={set('tickValueLoss')} type="number" />
          <Field label="Volume min" value={form.volumeMin} onChange={set('volumeMin')} type="number" />
          <Field label="Volume max" value={form.volumeMax} onChange={set('volumeMax')} type="number" />
          <Field label="Volume step" value={form.volumeStep} onChange={set('volumeStep')} type="number" />
        </div>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={onRun} disabled={busy} loading={busy}>
          Run preview
        </Button>
        <p className="text-xs text-marine-navy/60">Uses the profile currently in the editor.</p>
      </div>

      <div className="mt-4 space-y-3">
        {previewError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{previewError}</p>
        ) : null}
        {preview ? <PreviewResults preview={preview} /> : null}
        {!preview && previewRan && !previewError ? (
          <p className="text-sm text-marine-navy/60">
            No preview result. The profile must validate, and stored safety limits must be valid, before a preview runs.
          </p>
        ) : null}
      </div>
    </section>
  );
}
