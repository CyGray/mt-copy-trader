'use client';

import type { ExecutionProfile } from '@shared/executionProfile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { formatTimestamp } from '@/lib/format';
import { fmt, type ProfileDetail } from './model';

interface ActiveProfileCardProps {
  activeDocId: string | null;
  detail: ProfileDetail | null;
  canRollback: boolean;
  isAdmin: boolean;
  busy: boolean;
  confirmingRollback: boolean;
  onRequestRollback: () => void;
  onCancelRollback: () => void;
  onConfirmRollback: () => void;
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-marine-navy/10 bg-marine-mist/40 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">{label}</p>
      <p className="mt-1 text-sm text-marine-navy">{value}</p>
    </div>
  );
}

function sizingText(profile: ExecutionProfile): string {
  const s = profile.sizing;
  const size =
    s.mode === 'fixed_lots'
      ? `${fmt(s.fixed_lots, 2)} lots fixed`
      : s.mode === 'fixed_risk_money'
        ? `${fmt(s.risk_money, 2)} money at risk`
        : `${fmt(s.risk_percent, 2)}% of equity at risk`;
  return `${size} · below min: ${s.below_min_volume.replace(/_/g, ' ')}`;
}

export function ActiveProfileCard({
  activeDocId,
  detail,
  canRollback,
  isAdmin,
  busy,
  confirmingRollback,
  onRequestRollback,
  onCancelRollback,
  onConfirmRollback,
}: ActiveProfileCardProps) {
  const profile = detail ? (detail.profile as unknown as ExecutionProfile) : null;

  return (
    <section className="rounded-2xl border border-marine-navy/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-marine-navy/60">Active profile</p>
          {!activeDocId ? (
            <p className="mt-2 text-sm text-marine-navy/70">
              No profile is active. Approve a version and activate it below.
            </p>
          ) : !profile || !detail ? (
            <p className="mt-2 text-sm text-marine-navy/70">Loading {activeDocId}…</p>
          ) : (
            <>
              <h2 className="mt-1 text-lg font-semibold text-marine-navy">{profile.name}</h2>
              <p className="font-mono text-xs text-marine-navy/60">
                {detail.doc_id} · version {profile.version}
              </p>
              <p className="mt-1 text-xs text-marine-navy/60">
                Activated {detail.meta.activated_by ?? 'unknown'} · {formatTimestamp(detail.meta.activated_at)}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          {activeDocId ? <StatusBadge status="success" label="active" size="md" /> : null}
          {isAdmin && canRollback && activeDocId ? (
            confirmingRollback ? (
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={onCancelRollback} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={onConfirmRollback} loading={busy}>
                  Confirm rollback
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={onRequestRollback} disabled={busy}>
                Roll back to previous
              </Button>
            )
          ) : null}
        </div>
      </div>

      {profile ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Setting label="Sizing" value={sizingText(profile)} />
            <Setting
              label="Entry"
              value={`${profile.entry.policy.replace(/_/g, ' ')} · tolerance ${fmt(profile.entry.market_tolerance_price, 2)} · expiry ${profile.entry.pending_expiry_minutes} min · market fallback ${profile.entry.allow_market_fallback ? 'yes' : 'no'}`}
            />
            <Setting
              label="Stop distance"
              value={`${fmt(profile.stop_loss.min_distance_price, 2)} to ${fmt(profile.stop_loss.max_distance_price, 2)} price units`}
            />
            <Setting
              label="Symbols"
              value={profile.symbols.map((s) => `${s.signal_symbol} → ${s.broker_symbol}`).join(', ')}
            />
            <Setting
              label="Break-even"
              value={
                profile.break_even.enabled
                  ? `on · ${profile.break_even.trigger.replace(/_/g, ' ')} ${fmt(profile.break_even.trigger_value, 2)} · buffer ${fmt(profile.break_even.buffer_price, 2)}`
                  : 'off'
              }
            />
            <Setting
              label="Trailing"
              value={
                profile.trailing.enabled
                  ? `on · ${profile.trailing.activation.replace(/_/g, ' ')} ${fmt(profile.trailing.activation_value, 2)} · distance ${fmt(profile.trailing.distance_price, 2)} · step ${fmt(profile.trailing.step_price, 2)}`
                  : 'off'
              }
            />
            <Setting
              label="Concurrency"
              value={`${profile.limits.max_concurrent_positions} total · ${profile.limits.max_positions_per_symbol} per symbol`}
            />
            <Setting
              label="Risk and loss caps"
              value={`daily loss ${fmt(profile.limits.daily_loss_limit_money, 2)} · total risk ${fmt(profile.limits.max_total_risk_percent, 2)}%`}
            />
            <Setting
              label="Spread and deviation"
              value={`max spread ${fmt(profile.limits.max_spread_price, 2)} · deviation ${profile.limits.max_deviation_points} pts · signal age ${profile.limits.signal_max_age_sec}s`}
            />
          </div>

          <div>
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-marine-navy/50">
              Take-profit checkpoints · missing TP: {profile.take_profit.missing_tp.replace(/_/g, ' ')} · infeasible split:{' '}
              {profile.take_profit.infeasible_split.replace(/_/g, ' ')} · broker TP: {profile.take_profit.broker_tp.replace(/_/g, ' ')}
            </p>
            <div className="overflow-x-auto rounded-lg border border-marine-navy/10">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-marine-mist/60 text-xs uppercase tracking-wider text-marine-navy/60">
                  <tr>
                    <th className="px-3 py-2 font-medium">Checkpoint</th>
                    <th className="px-3 py-2 font-medium">Close %</th>
                    <th className="px-3 py-2 font-medium">Stop after</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.take_profit.checkpoints.map((cp) => {
                    const move = profile.stop_loss.after_checkpoint.find((rule) => rule.after_tp_index === cp.tp_index);
                    return (
                      <tr key={cp.tp_index} className="border-t border-marine-navy/10">
                        <td className="px-3 py-2 font-mono">TP{cp.tp_index}</td>
                        <td className="px-3 py-2 font-mono">{fmt(cp.close_percent, 2)}%</td>
                        <td className="px-3 py-2 text-marine-navy/70">
                          {move
                            ? `${move.move_to.replace(/_/g, ' ')} (buffer ${fmt(move.buffer_price, 2)})`
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
