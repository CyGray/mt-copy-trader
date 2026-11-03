package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const (
	maxCloseAttempts      = 5
	ambiguousCloseWindow  = 15 * time.Second
	closeMarketRetry      = 60 * time.Second
	pendingExpiryGrace    = 30 * time.Second
	marketClosedRetcode   = 10018
	slFailuresBeforeAlert = 3
)

var activeTradeStates = []string{"OPEN", "PARTIALLY_CLOSED", "PENDING_ORDER"}

type TickSummary struct {
	TradeSets            int      `json:"trade_sets"`
	Checked              int      `json:"checked"`
	SkippedModes         []string `json:"skipped_modes"`
	PartialCloses        int      `json:"partial_closes"`
	PartialCloseRejected int      `json:"partial_close_rejected"`
	CloseAmbiguous       int      `json:"close_ambiguous"`
	SLModified           int      `json:"sl_modified"`
	Closed               int      `json:"closed"`
	PendingFilled        int      `json:"pending_filled"`
	PendingCancelled     int      `json:"pending_cancelled"`
	Errors               int      `json:"errors"`
}

type lifecycleProgress struct {
	trade     domain.TradeSet
	lifecycle domain.TradeLifecycle
	saved     string
}

type modeSnapshot struct {
	broker    broker.Broker
	positions []broker.Position
	orders    []broker.Order
	symbols   map[string]any
}

func (r *Runner) Tick(ctx context.Context) error {
	docs, err := r.db.ListTradeSetsByState(ctx, activeTradeStates, 10000)
	if err != nil {
		return err
	}
	groups := map[string][]domain.TradeSet{}
	for _, doc := range docs {
		trade, err := decodeTrade(doc)
		if err != nil {
			continue
		}
		if trade.Mode != "paper" && trade.Mode != "demo" && trade.Mode != "live" {
			r.warnOnce("mode:"+trade.TradeSetID, "lifecycle_unmanaged_mode", map[string]any{"trade_set_id": trade.TradeSetID, "mode": trade.Mode})
			continue
		}
		groups[trade.Mode] = append(groups[trade.Mode], trade)
	}
	summary := TickSummary{TradeSets: len(docs), SkippedModes: []string{}}
	var first error
	for mode, group := range groups {
		snapshot, err := r.readBroker(ctx, mode, group)
		if err != nil {
			summary.SkippedModes = append(summary.SkippedModes, mode)
			r.audit(ctx, "warn", "lifecycle_mode_skipped", map[string]any{"mode": mode, "error": err.Error(), "trade_sets": len(group)})
			if first == nil {
				first = err
			}
			continue
		}
		for _, trade := range group {
			summary.Checked++
			if err := r.processTrade(ctx, snapshot, trade, &summary); err != nil {
				summary.Errors++
				r.audit(ctx, "warn", "lifecycle_trade_failed", map[string]any{"trade_set_id": trade.TradeSetID, "error": err.Error()})
				if first == nil {
					first = fmt.Errorf("lifecycle trade %s: %w", trade.TradeSetID, err)
				}
			}
		}
	}
	if first != nil {
		return first
	}
	return nil
}

func (r *Runner) readBroker(ctx context.Context, mode string, group []domain.TradeSet) (modeSnapshot, error) {
	br, err := r.brokerFor(ctx, mode)
	if err != nil {
		return modeSnapshot{}, err
	}
	if evaluator, ok := br.(interface {
		Evaluate(context.Context) (broker.EvaluateReport, error)
	}); ok {
		if _, err := evaluator.Evaluate(ctx); err != nil {
			r.audit(ctx, "warn", "lifecycle_evaluate_failed", map[string]any{"mode": mode, "error": err.Error()})
		}
	}
	positions, err := br.GetPositions(ctx, "")
	if err != nil {
		return modeSnapshot{}, err
	}
	orders, err := br.GetOrders(ctx, "")
	if err != nil {
		return modeSnapshot{}, err
	}
	snapshot := modeSnapshot{broker: br, positions: positions, orders: orders, symbols: map[string]any{}}
	for _, trade := range group {
		if trade.BrokerSymbol == nil {
			continue
		}
		name := *trade.BrokerSymbol
		if _, ok := snapshot.symbols[name]; ok {
			continue
		}
		info, err := br.GetSymbolInfo(ctx, name)
		if err != nil {
			snapshot.symbols[name] = err
		} else {
			snapshot.symbols[name] = info
		}
	}
	return snapshot, nil
}

func (r *Runner) processTrade(ctx context.Context, snapshot modeSnapshot, trade domain.TradeSet, summary *TickSummary) error {
	if trade.MutationIntent != nil || trade.RevisionIntent != nil {
		return nil
	}
	if trade.State == domain.TradePendingOrder {
		return r.managePending(ctx, snapshot, trade, summary)
	}
	return r.manageOpen(ctx, snapshot, trade, summary)
}

func (r *Runner) manageOpen(ctx context.Context, snapshot modeSnapshot, trade domain.TradeSet, summary *TickSummary) error {
	if trade.MutationIntent != nil || trade.RevisionIntent != nil {
		return nil
	}
	if trade.BrokerRefs == nil || trade.BrokerRefs.PositionTicket <= 0 {
		return errors.New("missing_position_ref")
	}
	if trade.ProfileSnapshot == nil {
		return errors.New("missing_profile_snapshot")
	}
	if trade.Lifecycle == nil {
		return errors.New("missing_lifecycle")
	}
	progress := lifecycleProgress{trade: trade, lifecycle: cloneLifecycle(*trade.Lifecycle)}
	progress.saved = lifecycleJSON(progress.lifecycle)
	var position *broker.Position
	for i := range snapshot.positions {
		candidate := &snapshot.positions[i]
		if candidate.Ticket == trade.BrokerRefs.PositionTicket && candidate.Magic == snapshot.broker.Magic() {
			position = candidate
			break
		}
	}
	if position == nil {
		return r.resolveMissingPosition(ctx, snapshot, &progress, summary)
	}
	spec, err := symbolFor(snapshot, trade)
	if err != nil {
		return err
	}
	closeAttempted := false
	ordered := append([]domain.CheckpointState(nil), progress.lifecycle.Checkpoints...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].TPIndex < ordered[j].TPIndex })
	now := r.cfg.Now()
	for _, copied := range ordered {
		cp := findCheckpoint(&progress.lifecycle, copied.TPIndex)
		if cp == nil {
			continue
		}
		action := domain.CheckpointDecision(*cp, position.Volume, position.PriceCurrent, trade.Direction, now.Unix(), spec.VolumeStep)
		if action == domain.CheckpointMarkDone {
			cp.Status, cp.PartialConfirmed, cp.ConfirmedAt, cp.AmbiguousUntil = "done", false, store.ISO(now), nil
			progress.lifecycle.CurrentVolume = position.Volume
			if err := r.saveProgress(ctx, &progress); err != nil {
				return err
			}
			r.resolveAlert(ctx, "mutation_unknown", trade.TradeSetID, "checkpoint_target_observed")
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, fmt.Sprintf("tp%d_partial_close_confirmed", cp.TPIndex), "partial_close_confirmed", map[string]any{"position_ticket": position.Ticket, "volume": position.Volume, "reason_code": "volume_reached_target", "details": map[string]any{"tp_index": cp.TPIndex, "target_remaining_volume": cp.TargetRemainingVolume}})
			continue
		}
		if action != domain.CheckpointSendClose {
			continue
		}
		key := fmt.Sprintf("%s:%d", trade.TradeSetID, cp.TPIndex)
		if r.marketClosedUntil[key] > now.Unix() {
			break
		}
		if err := r.requestCheckpointClose(ctx, snapshot, &progress, cp, *position, spec.VolumeStep, summary); err != nil {
			return err
		}
		closeAttempted = true
		if cp.PartialConfirmed {
			freshPositions, readErr := snapshot.broker.GetPositions(ctx, position.Symbol)
			if readErr != nil {
				return fmt.Errorf("read position before protective management after partial close: %w", readErr)
			}
			if fresh := findPosition(freshPositions, position.Ticket, snapshot.broker.Magic()); fresh != nil {
				if err := r.manageStops(ctx, snapshot, &progress, *fresh, spec, summary); err != nil {
					return err
				}
			}
		}
		break
	}
	if !closeAttempted {
		if err := r.manageStops(ctx, snapshot, &progress, *position, spec, summary); err != nil {
			return err
		}
	}
	return r.flushProgress(ctx, &progress)
}

func (r *Runner) requestCheckpointClose(ctx context.Context, snapshot modeSnapshot, progress *lifecycleProgress, cp *domain.CheckpointState, position broker.Position, step float64, summary *TickSummary) error {
	trade, now := progress.trade, r.cfg.Now()
	volume, full := domain.CloseVolumeFor(position.Volume, cp.TargetRemainingVolume, step)
	if !(volume > 0) {
		return fmt.Errorf("checkpoint close volume is zero for tp%d", cp.TPIndex)
	}
	cp.Status, cp.PartialConfirmed, cp.Attempts, cp.RequestedAt = "closing", false, cp.Attempts+1, store.ISO(now)
	ambiguousUntil := now.Add(ambiguousCloseWindow).Unix()
	cp.AmbiguousUntil = &ambiguousUntil
	if err := r.saveProgress(ctx, progress); err != nil {
		return err
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, fmt.Sprintf("tp%d_reached", cp.TPIndex), "tp_checkpoint_reached", map[string]any{"position_ticket": position.Ticket, "price": cp.Price, "details": map[string]any{"tp_index": cp.TPIndex, "market_price": position.PriceCurrent}})
	fullReason := "checkpoint_partial_close"
	if full {
		fullReason = "final_full_close"
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, fmt.Sprintf("tp%d_partial_close_requested_%d", cp.TPIndex, cp.Attempts), "partial_close_requested", map[string]any{"position_ticket": position.Ticket, "volume": volume, "price": position.PriceCurrent, "reason_code": fullReason, "details": map[string]any{"tp_index": cp.TPIndex, "attempt": cp.Attempts, "full": full, "target_remaining_volume": cp.TargetRemainingVolume}})
	result, err := snapshot.broker.ClosePosition(ctx, position.Ticket, &volume)
	if err != nil {
		return r.handleCloseFailure(ctx, progress, cp, position, volume, err, summary)
	}
	positions, err := snapshot.broker.GetPositions(ctx, position.Symbol)
	if err != nil {
		cp.LastError = "close acknowledged; exact position readback failed"
		if saveErr := r.saveProgress(ctx, progress); saveErr != nil {
			return saveErr
		}
		return fmt.Errorf("read position after checkpoint close: %w", err)
	}
	remaining := findPosition(positions, position.Ticket, snapshot.broker.Magic())
	positionID := position.Identifier
	if positionID <= 0 {
		positionID = position.Ticket
	}
	var deals []broker.Deal
	if remaining == nil {
		deals, err = snapshot.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
		if err != nil {
			cp.LastError = "position absent after close; exit-deal readback failed"
			if saveErr := r.saveProgress(ctx, progress); saveErr != nil {
				return saveErr
			}
			return fmt.Errorf("read exit deals after checkpoint close: %w", err)
		}
		if domain.LastExitDeal(deals) == nil {
			cp.LastError = "position absent after close without an exact exit deal"
			if saveErr := r.saveProgress(ctx, progress); saveErr != nil {
				return saveErr
			}
			return errors.New(cp.LastError)
		}
	}
	remainingVolume := 0.0
	if remaining != nil {
		remainingVolume = roundVolume(remaining.Volume, step)
	}
	progress.lifecycle.CurrentVolume = remainingVolume
	tolerance := math.Max(step/2, 1e-9)
	reached := remaining == nil || remaining.Volume <= cp.TargetRemainingVolume+tolerance
	if !reached {
		madeProgress := result.Retcode == 10010 && remaining.Volume < position.Volume-tolerance
		cp.PartialConfirmed = madeProgress
		cp.LastError = ""
		if madeProgress {
			// A confirmed partial fill is safe to continue only from the next tick's
			// fresh position snapshot. It does not wait on the ambiguous-send TTL.
			until := r.cfg.Now().Unix()
			cp.AmbiguousUntil = &until
		} else {
			cp.LastError = "close response made no confirmed progress"
		}
		if err := r.saveProgress(ctx, progress); err != nil {
			return err
		}
		summary.PartialCloses++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, fmt.Sprintf("tp%d_partial_close_confirmed_%d", cp.TPIndex, cp.Attempts), "partial_close_confirmed", map[string]any{
			"position_ticket": position.Ticket, "deal_ticket": result.DealTicket, "volume": result.ClosedVolume, "price": result.Price, "retcode": result.Retcode,
			"reason_code": "target_remaining_volume_not_reached", "details": map[string]any{"tp_index": cp.TPIndex, "target_remaining_volume": cp.TargetRemainingVolume, "remaining_volume": remainingVolume},
		})
		return nil
	}
	var pnl *float64
	if deals == nil {
		deals, _ = snapshot.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	}
	if deals != nil {
		for _, deal := range deals {
			if deal.Ticket == result.DealTicket {
				v := domain.RealizedPnLFromDeals([]broker.Deal{deal})
				pnl = &v
				break
			}
		}
	}
	cp.Status, cp.PartialConfirmed, cp.ConfirmedAt, cp.DealTicket, cp.RealizedPnL = "done", false, store.ISO(r.cfg.Now()), int64Ptr(result.DealTicket), pnl
	cp.AmbiguousUntil, cp.LastError = nil, ""
	if err := r.saveProgress(ctx, progress); err != nil {
		return err
	}
	r.resolveAlert(ctx, "mutation_unknown", trade.TradeSetID, "checkpoint_target_observed")
	summary.PartialCloses++
	fields := map[string]any{"position_ticket": position.Ticket, "deal_ticket": result.DealTicket, "volume": result.ClosedVolume, "price": result.Price, "retcode": result.Retcode, "details": map[string]any{"tp_index": cp.TPIndex, "remaining_volume": progress.lifecycle.CurrentVolume}}
	if pnl != nil {
		fields["realized_pnl"] = *pnl
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, fmt.Sprintf("tp%d_partial_close_confirmed", cp.TPIndex), "partial_close_confirmed", fields)
	return nil
}

func (r *Runner) handleCloseFailure(ctx context.Context, p *lifecycleProgress, cp *domain.CheckpointState, position broker.Position, volume float64, err error, summary *TickSummary) error {
	message, attempt := err.Error(), cp.Attempts
	var unavailable *broker.UnavailableError
	if errors.As(err, &unavailable) {
		cp.Status, cp.PartialConfirmed, cp.Attempts, cp.LastError, cp.AmbiguousUntil = "pending", false, maxInt(0, attempt-1), message, nil
		return r.saveProgress(ctx, p)
	}
	var rejected *broker.RejectedError
	if errors.As(err, &rejected) && rejected.Retcode == marketClosedRetcode {
		cp.Status, cp.Attempts, cp.LastError, cp.AmbiguousUntil = "pending", maxInt(0, attempt-1), message, nil
		if saveErr := r.saveProgress(ctx, p); saveErr != nil {
			return saveErr
		}
		r.marketClosedUntil[fmt.Sprintf("%s:%d", p.trade.TradeSetID, cp.TPIndex)] = r.cfg.Now().Add(closeMarketRetry).Unix()
		r.warnOnce(fmt.Sprintf("market_closed:%s:%d", p.trade.TradeSetID, cp.TPIndex), "lifecycle_partial_close_market_closed", map[string]any{"trade_set_id": p.trade.TradeSetID, "tp_index": cp.TPIndex, "error": message})
		return nil
	}
	if errors.As(err, &rejected) {
		cp.Status, cp.LastError, cp.AmbiguousUntil = "pending", message, nil
		if attempt >= maxCloseAttempts {
			cp.Status = "failed"
		}
		if saveErr := r.saveProgress(ctx, p); saveErr != nil {
			return saveErr
		}
		summary.PartialCloseRejected++
		code := "broker_rejected"
		if cp.Status == "failed" {
			code = "attempts_exhausted"
		}
		r.tradeEvent(ctx, p.trade.TradeSetID, p.trade.Mode, fmt.Sprintf("tp%d_partial_close_failed_%d", cp.TPIndex, attempt), "partial_close_failed", map[string]any{"position_ticket": position.Ticket, "volume": volume, "retcode": rejected.Retcode, "reason_code": code, "message": message})
		if cp.Status == "failed" {
			r.raiseAlert(ctx, "partial_close_failed", fmt.Sprintf("%s_tp%d", p.trade.TradeSetID, cp.TPIndex), "error", fmt.Sprintf("TP%d partial close failed", cp.TPIndex), message, map[string]any{"trade_set_id": p.trade.TradeSetID, "tp_index": cp.TPIndex, "position_ticket": position.Ticket, "volume": volume, "retcode": rejected.Retcode})
		}
		return nil
	}
	cp.LastError = message
	if saveErr := r.saveProgress(ctx, p); saveErr != nil {
		return saveErr
	}
	summary.CloseAmbiguous++
	r.raiseAlert(ctx, "mutation_unknown", p.trade.TradeSetID, "error", "Checkpoint close needs reconciliation", fmt.Sprintf("Trade set %s checkpoint TP%d has an unresolved close for position ticket %d. The request will not be repeated without a confirmed partial result or observed target.", p.trade.TradeSetID, cp.TPIndex, position.Ticket), map[string]any{"trade_set_id": p.trade.TradeSetID, "position_ticket": position.Ticket, "tp_index": cp.TPIndex, "target_remaining_volume": cp.TargetRemainingVolume, "requested_volume": volume})
	r.tradeEvent(ctx, p.trade.TradeSetID, p.trade.Mode, fmt.Sprintf("tp%d_partial_close_ambiguous_%d", cp.TPIndex, attempt), "execution_error", map[string]any{"position_ticket": position.Ticket, "volume": volume, "reason_code": "partial_close_ambiguous", "message": message})
	return nil
}

func (r *Runner) resolveMissingPosition(ctx context.Context, snapshot modeSnapshot, progress *lifecycleProgress, summary *TickSummary) error {
	trade := progress.trade
	positionID := positionIdentifier(trade)
	deals, err := snapshot.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	if err != nil {
		return err
	}
	last := domain.LastExitDeal(deals)
	if last == nil {
		r.warnOnce("no_exit:"+trade.TradeSetID, "lifecycle_position_missing_no_exit_deal", map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": positionID})
		return nil
	}
	for i := range progress.lifecycle.Checkpoints {
		cp := &progress.lifecycle.Checkpoints[i]
		if cp.TargetRemainingVolume != 0 || cp.Status == "done" {
			continue
		}
		if last.Reason == "TP" || last.Reason == "CLIENT" && cp.Status == "closing" {
			cp.Status, cp.ConfirmedAt, cp.DealTicket, cp.AmbiguousUntil = "done", store.ISO(r.cfg.Now()), int64Ptr(last.Ticket), nil
		}
	}
	allDone := len(progress.lifecycle.Checkpoints) > 0
	for _, cp := range progress.lifecycle.Checkpoints {
		if cp.Status != "done" {
			allDone = false
			break
		}
	}
	closeReason := string(domain.ClassifyCloseReason(deals))
	if trade.CloseRequestedBy == "close_all" {
		closeReason = "close_all"
	} else if allDone {
		closeReason = "checkpoints_complete"
	}
	realized := domain.RealizedPnLFromDeals(deals)
	progress.lifecycle.CurrentVolume = 0
	result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: closeReason, RealizedPnL: realized}
	doc := store.Document{"state": "CLOSED", "lifecycle": progress.lifecycle, "result": result}
	moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"OPEN", "PARTIALLY_CLOSED"}, doc)
	if err != nil {
		return err
	}
	if !moved {
		return nil
	}
	summary.Closed++
	r.resolveAlert(ctx, "mutation_unknown", trade.TradeSetID, "position_exit_observed")
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": positionID, "deal_ticket": last.Ticket, "price": last.Price, "realized_pnl": realized, "reason_code": closeReason})
	return nil
}

func (r *Runner) manageStops(ctx context.Context, snapshot modeSnapshot, progress *lifecycleProgress, position broker.Position, spec broker.SymbolInfo, summary *TickSummary) error {
	trade, lifecycle := progress.trade, &progress.lifecycle
	profile := trade.ProfileSnapshot
	if profile == nil || trade.BrokerRefs == nil {
		return errors.New("missing_profile_or_refs")
	}
	entry := trade.BrokerRefs.FillPrice
	if entry <= 0 && trade.Plan != nil {
		entry = trade.Plan.EntryRefPrice
	}
	if !(entry > 0) {
		return errors.New("missing_entry_reference")
	}
	view := domain.LifecycleView{Direction: trade.Direction, Entry: entry, ClosePrice: position.PriceCurrent, Checkpoints: lifecycle.Checkpoints}
	storedBest := lifecycle.BestPrice
	if storedBest <= 0 {
		storedBest = entry
	}
	best := domain.UpdateBestPrice(trade.Direction, storedBest, position.PriceCurrent)
	decision := domain.DesiredStopLoss(domain.StopLossInput{LifecycleView: view, Profile: *profile, CurrentSL: position.SL, BestPrice: best,
		BEApplied: lifecycle.BEApplied, TrailingActive: lifecycle.TrailingActive, Digits: spec.Digits})
	if profile.Trailing.Enabled && best != storedBest && math.Abs(best-storedBest) >= profile.Trailing.StepPrice {
		lifecycle.BestPrice = best
	}
	if domain.TrailingActivated(view, *profile) {
		lifecycle.TrailingActive = true
	}
	effectiveSL := position.SL
	if decision != nil {
		valid := domain.IsStopModificationValid(trade.Direction, decision.SL, spec.Bid, spec.Ask, spec.StopsLevelPoints, spec.FreezeLevelPoints, spec.Point)
		if !valid {
			r.warnOnce(fmt.Sprintf("stop_invalid:%s:%v", trade.TradeSetID, decision.SL), "lifecycle_stop_invalid_for_market", map[string]any{"trade_set_id": trade.TradeSetID, "sl": decision.SL, "bid": spec.Bid, "ask": spec.Ask})
		} else {
			targetLifecycle := *lifecycle
			targetLifecycle.CurrentSL, targetLifecycle.CurrentTP = decision.SL, position.TP
			for _, reason := range decision.Reasons {
				if reason == domain.StopBreakEven {
					targetLifecycle.BEApplied = true
				}
				if reason == domain.StopTrailing {
					targetLifecycle.TrailingActive = true
				}
			}
			intent := newMutationIntent(r, "POSITION_MODIFY", position.Ticket)
			intent.PriorSL, intent.PriorTP = position.SL, position.TP
			intent.TargetSL, intent.TargetTP = decision.SL, position.TP
			intent.SuccessPatch = map[string]any{"lifecycle": targetLifecycle}
			if err := r.persistMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
				return err
			}
			_, _, err := snapshot.broker.ModifyPosition(ctx, position.Ticket, decision.SL, position.TP)
			if err != nil {
				kind := "unconfirmed"
				var rejected *broker.RejectedError
				if errors.As(err, &rejected) {
					kind = "rejected"
				}
				var ambiguous *broker.AmbiguousError
				var unavailable *broker.UnavailableError
				if errors.As(err, &rejected) || errors.As(err, &unavailable) {
					if clearErr := r.completeMutationIntent(ctx, trade.TradeSetID, nil); clearErr != nil {
						return clearErr
					} else {
						trade.MutationIntent = nil
					}
				} else if errors.As(err, &ambiguous) || kind == "unconfirmed" {
					trade.MutationIntent = &intent
					current := r.Readiness()
					r.setReadiness(Readiness{Reason: "mutation_unresolved", LastReconciledAt: current.LastReconciledAt})
				}
				r.warnOnce("sl_"+kind+":"+trade.TradeSetID+fmt.Sprint(decision.SL), "lifecycle_sl_modify_failed", map[string]any{"trade_set_id": trade.TradeSetID, "sl": decision.SL, "kind": kind, "error": err.Error()})
				if !(errors.As(err, &rejected) && rejected.Retcode == marketClosedRetcode) {
					r.slFailures[trade.TradeSetID]++
					if r.slFailures[trade.TradeSetID] >= slFailuresBeforeAlert {
						r.raiseAlert(ctx, "sl_modify_failed", trade.TradeSetID, "error", "Stop-loss move keeps failing", err.Error(), map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": position.Ticket, "target_sl": decision.SL, "current_sl": position.SL})
					}
				}
			} else {
				if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document(intent.SuccessPatch)); err != nil {
					return err
				}
				*lifecycle = targetLifecycle
				progress.saved = lifecycleJSON(*lifecycle)
				delete(r.slFailures, trade.TradeSetID)
				effectiveSL, lifecycle.CurrentSL, lifecycle.CurrentTP = decision.SL, decision.SL, position.TP
				summary.SLModified++
				reasons := make([]string, len(decision.Reasons))
				for i, reason := range decision.Reasons {
					reasons[i] = string(reason)
				}
				key := fmt.Sprintf("sl_modified_%.*f", spec.Digits, decision.SL)
				r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, key, "sl_modified", map[string]any{"position_ticket": position.Ticket, "sl": decision.SL, "tp": position.TP, "price": position.PriceCurrent, "reason_code": stringsJoin(reasons, "+"), "details": map[string]any{"reasons": reasons}})
				if containsString(reasons, "break_even") {
					r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "break_even_applied", "break_even_applied", map[string]any{"position_ticket": position.Ticket, "sl": decision.SL, "price": position.PriceCurrent})
				}
				if containsString(reasons, "trailing") {
					r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "trailing_updated_"+fmt.Sprintf("%.*f", spec.Digits, decision.SL), "trailing_updated", map[string]any{"position_ticket": position.Ticket, "sl": decision.SL, "tp": position.TP, "price": position.PriceCurrent})
				}
			}
		}
	}
	if domain.BreakEvenTriggered(view, *profile) {
		beLevel := entry - profile.BreakEven.BufferPrice
		if trade.Direction == domain.Buy {
			beLevel = entry + profile.BreakEven.BufferPrice
		}
		atBE := effectiveSL > 0 && (trade.Direction == domain.Buy && effectiveSL >= beLevel-1e-9 || trade.Direction == domain.Sell && effectiveSL <= beLevel+1e-9)
		if atBE {
			lifecycle.BEApplied = true
		}
	}
	return nil
}

func (r *Runner) managePending(ctx context.Context, snapshot modeSnapshot, trade domain.TradeSet, summary *TickSummary) error {
	if trade.BrokerRefs == nil || trade.BrokerRefs.OrderTicket <= 0 {
		return errors.New("missing_order_ref")
	}
	if trade.Lifecycle == nil {
		return errors.New("missing_lifecycle")
	}
	for _, order := range snapshot.orders {
		if order.Ticket == trade.BrokerRefs.OrderTicket && order.Magic == snapshot.broker.Magic() {
			if trade.Submission != nil && trade.Submission.PendingExpiresAt != nil && r.cfg.Now().Unix() > *trade.Submission.PendingExpiresAt+int64(pendingExpiryGrace.Seconds()) {
				intent := newMutationIntent(r, "CANCEL_ORDER", order.Ticket)
				intent.PriorPrice, intent.PriorSL, intent.PriorTP, intent.PriorVolume = order.PriceOpen, order.SL, order.TP, order.VolumeCurrent
				intent.Reason = "expired"
				intent.SuccessPatch = map[string]any{"state": string(domain.TradeCancelled)}
				if err := r.persistMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
					return err
				}
				if _, err := snapshot.broker.CancelOrder(ctx, order.Ticket); err == nil {
					if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeCancelled)}); err != nil {
						r.markMutationUnresolved(trade)
						return err
					}
					r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_expired_by_worker", "pending_order_cancelled", map[string]any{"order_ticket": order.Ticket, "reason_code": "expired", "details": map[string]any{"pending_expires_at": *trade.Submission.PendingExpiresAt, "expiration_applied": trade.BrokerRefs.ExpirationApplied}})
				} else {
					var unavailable *broker.UnavailableError
					var rejected *broker.RejectedError
					if errors.As(err, &unavailable) || errors.As(err, &rejected) {
						if clearErr := r.clearUnsentMutation(ctx, trade.TradeSetID); clearErr != nil {
							return clearErr
						}
					} else {
						r.markMutationUnresolved(trade)
					}
				}
			}
			return nil
		}
	}
	for _, position := range snapshot.positions {
		if position.Magic == snapshot.broker.Magic() && position.Comment == trade.CorrelationComment {
			return r.pendingFilled(ctx, snapshot, trade, position, summary)
		}
	}
	deals, err := snapshot.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade)})
	if err != nil {
		return err
	}
	var entry *broker.Deal
	for i := range deals {
		if deals[i].Entry == "IN" && deals[i].Comment == trade.CorrelationComment {
			entry = &deals[i]
			break
		}
	}
	if entry != nil {
		exits := []broker.Deal{}
		for _, deal := range deals {
			if deal.PositionID == entry.PositionID {
				exits = append(exits, deal)
			}
		}
		last := domain.LastExitDeal(exits)
		if last == nil {
			r.warnOnce("filled_no_exit:"+trade.TradeSetID, "lifecycle_pending_filled_no_exit_deal", map[string]any{"trade_set_id": trade.TradeSetID, "position_id": entry.PositionID})
			return nil
		}
		result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: string(domain.ClassifyCloseReason(exits)), RealizedPnL: domain.RealizedPnLFromDeals(exits)}
		refs := map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "position_ticket": entry.PositionID, "position_identifier": entry.PositionID, "deal_ticket": entry.Ticket, "fill_price": entry.Price, "filled_volume": entry.Volume}
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"PENDING_ORDER"}, store.Document{"state": "CLOSED", "broker_refs": refs, "result": result})
		if err != nil {
			return err
		}
		if moved {
			summary.Closed++
		}
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_filled", "pending_order_filled", map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "position_ticket": entry.PositionID, "deal_ticket": entry.Ticket, "price": entry.Price})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": entry.PositionID, "deal_ticket": last.Ticket, "price": last.Price, "realized_pnl": result.RealizedPnL, "reason_code": result.CloseReason})
		return nil
	}
	moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"PENDING_ORDER"}, store.Document{"state": "CANCELLED"})
	if err != nil {
		return err
	}
	if moved {
		summary.PendingCancelled++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_cancelled", "pending_order_cancelled", map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "reason_code": "broker_expired_or_removed"})
	}
	return nil
}

func (r *Runner) pendingFilled(ctx context.Context, snapshot modeSnapshot, trade domain.TradeSet, position broker.Position, summary *TickSummary) error {
	positionID := position.Identifier
	deals, _ := snapshot.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	var entry *broker.Deal
	for i := range deals {
		if deals[i].Entry == "IN" && deals[i].PositionID == position.Identifier {
			entry = &deals[i]
			break
		}
	}
	fillPrice, dealTicket := position.OpenPrice, int64(0)
	if entry != nil {
		fillPrice, dealTicket = entry.Price, entry.Ticket
	}
	lifecycle := cloneLifecycle(*trade.Lifecycle)
	lifecycle.CurrentVolume = position.Volume
	if trade.ProfileSnapshot != nil {
		spec, err := symbolFor(snapshot, trade)
		if err != nil {
			return err
		}
		plannedVolume := 0.0
		if trade.Plan != nil {
			plannedVolume = trade.Plan.Volume
		}
		fitted := domain.FillCheckpoints(trade.Direction, fillPrice, position.Volume, &plannedVolume, *trade.ProfileSnapshot, domain.SizingSpec{VolumeMin: spec.VolumeMin, VolumeStep: spec.VolumeStep}, lifecycle.Checkpoints)
		if fitted != nil {
			lifecycle.Checkpoints = fitted
		} else {
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "partial_fill_replan_infeasible", "execution_error", map[string]any{"position_ticket": position.Ticket, "volume": position.Volume, "reason_code": "partial_fill_replan_infeasible"})
		}
	}
	refs := map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "position_ticket": position.Ticket, "position_identifier": position.Identifier, "deal_ticket": dealTicket, "fill_price": fillPrice, "filled_volume": position.Volume}
	moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"PENDING_ORDER"}, store.Document{"state": "OPEN", "broker_refs": refs, "lifecycle": lifecycle})
	if err != nil {
		return err
	}
	if !moved {
		return nil
	}
	summary.PendingFilled++
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_filled", "pending_order_filled", map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "position_ticket": position.Ticket, "deal_ticket": dealTicket, "volume": position.Volume, "price": fillPrice})
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "entry_confirmed", "entry_confirmed", map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "position_ticket": position.Ticket, "deal_ticket": dealTicket, "volume": position.Volume, "price": fillPrice})
	return nil
}

func (r *Runner) saveProgress(ctx context.Context, p *lifecycleProgress) error {
	from := string(p.trade.State)
	patch := store.Document{"lifecycle": p.lifecycle}
	if p.trade.State == domain.TradeOpen && p.lifecycle.CurrentVolume > 0 {
		for _, cp := range p.lifecycle.Checkpoints {
			if cp.Status == "done" {
				patch["state"] = string(domain.TradePartiallyClosed)
				break
			}
		}
	}
	moved, err := r.db.TransitionTradeSet(ctx, p.trade.TradeSetID, []string{from}, patch)
	if err != nil {
		return err
	}
	if !moved {
		return errors.New("trade state changed during lifecycle update")
	}
	if patch["state"] == string(domain.TradePartiallyClosed) {
		p.trade.State = domain.TradePartiallyClosed
	}
	p.trade.Lifecycle, p.saved = &p.lifecycle, lifecycleJSON(p.lifecycle)
	return nil
}

func (r *Runner) flushProgress(ctx context.Context, p *lifecycleProgress) error {
	if lifecycleJSON(p.lifecycle) == p.saved {
		return nil
	}
	return r.saveProgress(ctx, p)
}

func (r *Runner) lookbackFrom(trade domain.TradeSet) int64 {
	at, err := time.Parse(time.RFC3339Nano, trade.CreatedAt)
	if err != nil {
		return 0
	}
	return at.Unix() - 60
}

func symbolFor(snapshot modeSnapshot, trade domain.TradeSet) (broker.SymbolInfo, error) {
	if trade.BrokerSymbol == nil {
		return broker.SymbolInfo{}, errors.New("missing_broker_symbol")
	}
	value, ok := snapshot.symbols[*trade.BrokerSymbol]
	if !ok {
		return broker.SymbolInfo{}, fmt.Errorf("symbol not read: %s", *trade.BrokerSymbol)
	}
	if err, ok := value.(error); ok {
		return broker.SymbolInfo{}, err
	}
	info, ok := value.(broker.SymbolInfo)
	if !ok {
		return broker.SymbolInfo{}, errors.New("symbol info has invalid type")
	}
	return info, nil
}

func findCheckpoint(lifecycle *domain.TradeLifecycle, index int) *domain.CheckpointState {
	for i := range lifecycle.Checkpoints {
		if lifecycle.Checkpoints[i].TPIndex == index {
			return &lifecycle.Checkpoints[i]
		}
	}
	return nil
}

func cloneLifecycle(in domain.TradeLifecycle) domain.TradeLifecycle {
	data, _ := json.Marshal(in)
	var out domain.TradeLifecycle
	_ = json.Unmarshal(data, &out)
	return out
}

func lifecycleJSON(in domain.TradeLifecycle) string { data, _ := json.Marshal(in); return string(data) }
func int64Ptr(value int64) *int64                   { return &value }
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func roundVolume(value, step float64) float64 {
	text := fmt.Sprintf("%.*f", domain.VolumeDecimals(step), value)
	out, _ := strconv.ParseFloat(text, 64)
	return out
}

func stringsJoin(values []string, separator string) string {
	result := ""
	for i, value := range values {
		if i > 0 {
			result += separator
		}
		result += value
	}
	return result
}

func (r *Runner) warnOnce(key, event string, details map[string]any) {
	r.mu.Lock()
	if r.warned[key] {
		r.mu.Unlock()
		return
	}
	r.warned[key] = true
	r.mu.Unlock()
	r.audit(context.Background(), "warn", event, details)
}
