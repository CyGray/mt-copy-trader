package engine

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

type revisionPlan struct {
	applied                         bool
	reasons                         []string
	state                           domain.TradeState
	patch                           map[string]any
	slFrom                          *float64
	slTo                            *float64
	action                          string
	ticket                          int64
	priorPrice, priorSL, priorTP    float64
	targetPrice, targetSL, targetTP float64
	br                              broker.Broker
}

func (r *Runner) handleRevision(ctx context.Context, event domain.SignalEvent, existing domain.TradeSet) domain.HandleResult {
	if existing.Schema != 2 {
		return domain.HandleResult{Outcome: "noop", Reason: "legacy_trade_set"}
	}
	if existing.RevisionIntent != nil || existing.MutationIntent != nil {
		return domain.HandleResult{Outcome: "noop", State: existing.State, Reason: "revision_pending_reconciliation"}
	}
	for _, revision := range existing.SignalRevisions {
		if revision.EventID == event.EventID {
			return domain.HandleResult{Outcome: "noop", State: existing.State, Reason: "revision_already_applied"}
		}
	}
	plan, err := r.planRevision(ctx, existing, event.Signal)
	if err != nil {
		var ambiguous *broker.AmbiguousError
		var rejected *broker.RejectedError
		switch {
		case errors.As(err, &ambiguous):
			r.tradeEvent(ctx, existing.TradeSetID, existing.Mode, "revision_ambiguous_"+event.EventID, "execution_error", map[string]any{"reason_code": "revision_ambiguous", "message": err.Error(), "details": map[string]any{"event_id": event.EventID}})
			r.markMutationUnresolved(existing)
			return domain.HandleResult{Outcome: "revision", State: existing.State, Reason: "revision_ambiguous"}
		case errors.As(err, &rejected):
			plan = revisionPlan{reasons: []string{fmt.Sprintf("broker_rejected_%d", rejected.Retcode)}, state: existing.State}
		default:
			return domain.HandleResult{Outcome: "retry", Reason: "revision_broker_error"}
		}
	}
	if plan.applied && plan.action != "" {
		if plan.br == nil {
			return domain.HandleResult{Outcome: "retry", Reason: "revision_broker_unavailable"}
		}
		entry := domain.SignalRevision{EventID: event.EventID, TextHash: event.TextHash, ReceivedAt: store.ISO(r.cfg.Now()), Outcome: "applied", Reason: joinReasons(plan.reasons)}
		kind := "position"
		if plan.action == "PENDING_MODIFY" {
			kind = "pending"
		}
		revision := domain.RevisionIntent{Entry: entry, Patch: plan.patch, Reasons: plan.reasons, SLFrom: plan.slFrom, SLTo: plan.slTo,
			TargetKind: kind, PriorPrice: plan.priorPrice, PriorSL: plan.priorSL, PriorTP: plan.priorTP,
			TargetSL: plan.targetSL, TargetTP: plan.targetTP, TargetPrice: plan.targetPrice}
		intent := newMutationIntent(r, plan.action, plan.ticket)
		intent.PriorPrice, intent.PriorSL, intent.PriorTP = plan.priorPrice, plan.priorSL, plan.priorTP
		intent.TargetPrice, intent.TargetSL, intent.TargetTP = plan.targetPrice, plan.targetSL, plan.targetTP
		intent.EventID = event.EventID
		if err := r.persistRevisionIntent(ctx, existing.TradeSetID, revision, intent); err != nil {
			return domain.HandleResult{Outcome: "retry", Reason: "revision_intent_write_failed"}
		}
		err := sendRevisionMutation(ctx, plan.br, plan)
		if err != nil {
			var rejected *broker.RejectedError
			var unavailable *broker.UnavailableError
			if errors.As(err, &rejected) {
				_ = r.clearRevisionIntent(ctx, existing.TradeSetID)
				plan = revisionPlan{reasons: []string{fmt.Sprintf("broker_rejected_%d", rejected.Retcode)}, state: existing.State}
			} else if errors.As(err, &unavailable) {
				_ = r.clearRevisionIntent(ctx, existing.TradeSetID)
				return domain.HandleResult{Outcome: "retry", Reason: "revision_broker_unavailable"}
			} else {
				r.markMutationUnresolved(existing)
				r.tradeEvent(ctx, existing.TradeSetID, existing.Mode, "revision_ambiguous_"+event.EventID, "execution_error", map[string]any{"reason_code": "revision_ambiguous", "message": err.Error(), "details": map[string]any{"event_id": event.EventID}})
				return domain.HandleResult{Outcome: "revision", State: existing.State, Reason: "revision_ambiguous"}
			}
		} else {
			plan = revisionPlan{applied: true, reasons: plan.reasons, state: plan.state, patch: plan.patch, slFrom: plan.slFrom, slTo: plan.slTo}
		}
	}
	entry := domain.SignalRevision{EventID: event.EventID, TextHash: event.TextHash, ReceivedAt: store.ISO(r.cfg.Now()), Reason: joinReasons(plan.reasons)}
	if plan.applied {
		entry.Outcome = "applied"
	} else {
		entry.Outcome = "ignored"
	}
	recorded, err := r.commitRevision(ctx, existing.TradeSetID, event.EventID, entry, plan.patch)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "revision_persist_failed"}
	}
	if !recorded {
		return domain.HandleResult{Outcome: "noop", State: existing.State, Reason: "revision_already_applied"}
	}
	if plan.applied {
		if plan.slFrom != nil && plan.slTo != nil {
			r.tradeEvent(ctx, existing.TradeSetID, existing.Mode, "sl_modified_"+event.EventID, "sl_modified", map[string]any{"sl": *plan.slTo, "details": map[string]any{"previous_sl": *plan.slFrom, "event_id": event.EventID}})
		}
		r.tradeEvent(ctx, existing.TradeSetID, existing.Mode, "revision_"+event.EventID, "signal_revision_applied", map[string]any{"reason_code": "applied", "message": joinReasons(plan.reasons), "details": map[string]any{"event_id": event.EventID}})
	} else {
		reason := "ignored"
		if len(plan.reasons) > 0 {
			reason = plan.reasons[0]
		}
		r.tradeEvent(ctx, existing.TradeSetID, existing.Mode, "revision_"+event.EventID, "signal_revision_ignored", map[string]any{"reason_code": reason, "message": joinReasons(plan.reasons), "details": map[string]any{"event_id": event.EventID}})
	}
	return domain.HandleResult{Outcome: "revision", State: plan.state, Reason: joinReasons(plan.reasons)}
}

func (r *Runner) planRevision(ctx context.Context, trade domain.TradeSet, signal *domain.Signal) (revisionPlan, error) {
	ignored := func(reason string) revisionPlan { return revisionPlan{reasons: []string{reason}, state: trade.State} }
	if trade.State != domain.TradePendingOrder && trade.State != domain.TradeOpen && trade.State != domain.TradePartiallyClosed {
		return ignored("state_" + string(trade.State)), nil
	}
	if signal == nil {
		return ignored("missing_signal"), nil
	}
	if trade.ProfileSnapshot == nil || trade.Plan == nil || trade.Lifecycle == nil || trade.BrokerSymbol == nil {
		return ignored("incomplete_trade_set"), nil
	}
	entryRef := trade.Plan.EntryRefPrice
	if trade.BrokerRefs != nil && trade.BrokerRefs.FillPrice > 0 {
		entryRef = trade.BrokerRefs.FillPrice
	}
	adjusted := domain.ApplyProfileToSignal(*signal, *trade.ProfileSnapshot, entryRef)
	signal = &adjusted
	if r.cfg.BrokerForMode == nil {
		return revisionPlan{}, errors.New("broker factory unavailable")
	}
	br, err := r.cfg.BrokerForMode(ctx, trade.Mode)
	if err != nil {
		return revisionPlan{}, err
	}
	var plan revisionPlan
	if trade.State == domain.TradePendingOrder {
		plan, err = r.revisePending(ctx, trade, *signal, br)
	} else {
		plan, err = r.reviseOpen(ctx, trade, *signal, br)
	}
	plan.br = br
	return plan, err
}

func (r *Runner) revisePending(ctx context.Context, trade domain.TradeSet, signal domain.Signal, br broker.Broker) (revisionPlan, error) {
	ignored := func(reason string) revisionPlan { return revisionPlan{reasons: []string{reason}, state: trade.State} }
	profile, plan, lifecycle := *trade.ProfileSnapshot, *trade.Plan, *trade.Lifecycle
	if profile.Edits.BeforeFill != "apply_sl_tp" {
		return ignored("before_fill_" + string(profile.Edits.BeforeFill)), nil
	}
	if trade.BrokerRefs == nil || trade.BrokerRefs.OrderTicket <= 0 {
		return ignored("no_pending_order_ref"), nil
	}
	slCheck := domain.ValidateStopLoss(trade.Direction, plan.OrderPrice, signal.StopLoss, profile.StopLoss)
	if !slCheck.OK {
		return ignored(slCheck.Reason), nil
	}
	spec, err := br.GetSymbolInfo(ctx, *trade.BrokerSymbol)
	if err != nil {
		return revisionPlan{}, err
	}
	orders, err := br.GetOrders(ctx, *trade.BrokerSymbol)
	if err != nil {
		return revisionPlan{}, err
	}
	var currentOrder *broker.Order
	for i := range orders {
		if orders[i].Ticket == trade.BrokerRefs.OrderTicket && orders[i].Magic == br.Magic() {
			currentOrder = &orders[i]
			break
		}
	}
	if currentOrder == nil {
		return ignored("pending_order_not_found"), nil
	}
	planned := domain.PlanCheckpoints(plan.Volume, trade.Direction, plan.OrderPrice, signal.TakeProfits, profile.TakeProfit, domain.SizingSpec{VolumeMin: spec.VolumeMin, VolumeStep: spec.VolumeStep})
	if !planned.OK {
		return ignored(planned.Reason), nil
	}
	slSame := math.Abs(signal.StopLoss-plan.SL) <= priceEpsilon
	tpSame := checkpointPlansEqual(planned.Checkpoints, plan.Checkpoints) && planned.BrokerTP == plan.BrokerTP
	if slSame && tpSame {
		return ignored("unchanged"), nil
	}
	newPlan := plan
	newPlan.SL, newPlan.BrokerTP, newPlan.Checkpoints = signal.StopLoss, planned.BrokerTP, planned.Checkpoints
	newLife := lifecycle
	newLife.Checkpoints = lifecycleCheckpoints(planned.Checkpoints)
	newLife.CurrentSL, newLife.CurrentTP = signal.StopLoss, planned.BrokerTP
	patch := map[string]any{"plan": newPlan, "lifecycle": newLife}
	reasons := []string{"sl_applied", "tp_applied"}
	if slSame {
		reasons[0] = "sl_unchanged"
	}
	if tpSame {
		reasons[1] = "tp_unchanged"
	}
	planResult := revisionPlan{applied: true, reasons: reasons, state: trade.State, patch: patch,
		action: "PENDING_MODIFY", ticket: currentOrder.Ticket, priorPrice: currentOrder.PriceOpen, priorSL: currentOrder.SL, priorTP: currentOrder.TP,
		targetPrice: plan.OrderPrice, targetSL: signal.StopLoss, targetTP: planned.BrokerTP}
	if !slSame {
		from, to := plan.SL, signal.StopLoss
		planResult.slFrom, planResult.slTo = &from, &to
	}
	return planResult, nil
}

func (r *Runner) reviseOpen(ctx context.Context, trade domain.TradeSet, signal domain.Signal, br broker.Broker) (revisionPlan, error) {
	ignored := func(reason string) revisionPlan { return revisionPlan{reasons: []string{reason}, state: trade.State} }
	profile, plan, lifecycle := *trade.ProfileSnapshot, *trade.Plan, *trade.Lifecycle
	if profile.Edits.AfterFill == "ignore" {
		return ignored("after_fill_ignored"), nil
	}
	if trade.BrokerRefs == nil || trade.BrokerRefs.PositionTicket <= 0 {
		return ignored("no_position_ref"), nil
	}
	spec, err := br.GetSymbolInfo(ctx, *trade.BrokerSymbol)
	if err != nil {
		return revisionPlan{}, err
	}
	tol := math.Max(spec.Point*0.5, priceEpsilon)
	positions, err := br.GetPositions(ctx, *trade.BrokerSymbol)
	if err != nil {
		return revisionPlan{}, err
	}
	var pos *broker.Position
	for i := range positions {
		if positions[i].Ticket == trade.BrokerRefs.PositionTicket {
			pos = &positions[i]
			break
		}
	}
	if pos == nil {
		return ignored("position_not_found"), nil
	}
	buy := trade.Direction == domain.Buy
	reasons := []string{}
	finalSL, slChanged := pos.SL, false
	var slFrom, slTo *float64
	if math.Abs(signal.StopLoss-pos.SL) > tol {
		sideOK := buy && signal.StopLoss < pos.PriceCurrent || !buy && signal.StopLoss > pos.PriceCurrent
		tighter := pos.SL == 0 || buy && signal.StopLoss > pos.SL || !buy && signal.StopLoss < pos.SL
		if !sideOK {
			reasons = append(reasons, "sl_wrong_side_of_price")
		} else if profile.Edits.AfterFill == "apply_tighten_only" && !tighter {
			reasons = append(reasons, "sl_loosen_ignored")
		} else {
			finalSL, slChanged = signal.StopLoss, true
			from, to := pos.SL, signal.StopLoss
			slFrom, slTo = &from, &to
			reasons = append(reasons, "sl_applied")
		}
	} else {
		reasons = append(reasons, "sl_unchanged")
	}
	cps := lifecycle.Checkpoints
	next := make([]float64, len(cps))
	missing, touched := false, false
	for i, cp := range cps {
		next[i] = cp.Price
		if cp.Status != "pending" {
			continue
		}
		index := cp.TPIndex - 1
		if index < 0 || index >= len(signal.TakeProfits) || math.IsNaN(signal.TakeProfits[index]) || math.IsInf(signal.TakeProfits[index], 0) {
			missing = true
			continue
		}
		next[i] = signal.TakeProfits[index]
		if math.Abs(next[i]-cp.Price) > priceEpsilon {
			touched = true
		}
	}
	var prices []float64
	if missing {
		reasons = append(reasons, "tp_missing")
	} else if !touched {
		reasons = append(reasons, "tp_unchanged")
	} else if ladderValid(next, trade.Direction, plan.EntryRefPrice) {
		prices = next
		reasons = append(reasons, "tp_applied")
	} else {
		reasons = append(reasons, "tp_order_invalid")
	}
	if !slChanged && prices == nil {
		return revisionPlan{reasons: reasons, state: trade.State}, nil
	}
	finalTP, brokerTPChanged := pos.TP, false
	last := len(cps) - 1
	if prices != nil && profile.TakeProfit.BrokerTP == "final_checkpoint" && last >= 0 && cps[last].Status == "pending" {
		newTP := prices[last]
		if math.Abs(newTP-pos.TP) > tol {
			finalTP, brokerTPChanged = newTP, true
		}
	}
	if slChanged || brokerTPChanged {
		// The caller persists an exact-ticket intent before sending this absolute modify.
	}
	newLifecycle := lifecycle
	if prices != nil {
		for i := range newLifecycle.Checkpoints {
			if newLifecycle.Checkpoints[i].Status == "pending" {
				newLifecycle.Checkpoints[i].Price = prices[i]
			}
		}
	}
	newLifecycle.CurrentSL, newLifecycle.CurrentTP = finalSL, finalTP
	newPlan := plan
	if brokerTPChanged {
		newPlan.BrokerTP = finalTP
	}
	if prices != nil {
		for i := range newPlan.Checkpoints {
			for _, cp := range newLifecycle.Checkpoints {
				if cp.TPIndex == newPlan.Checkpoints[i].TPIndex {
					newPlan.Checkpoints[i].Price = cp.Price
					break
				}
			}
		}
	}
	result := revisionPlan{applied: true, reasons: reasons, state: trade.State, patch: map[string]any{"plan": newPlan, "lifecycle": newLifecycle}, slFrom: slFrom, slTo: slTo}
	if slChanged || brokerTPChanged {
		result.action, result.ticket = "POSITION_MODIFY", trade.BrokerRefs.PositionTicket
		result.priorSL, result.priorTP = pos.SL, pos.TP
		result.targetSL, result.targetTP = finalSL, finalTP
	}
	return result, nil
}

func (r *Runner) commitRevision(ctx context.Context, tradeID, eventID string, entry domain.SignalRevision, patch map[string]any) (bool, error) {
	created := false
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err == store.ErrNotFound {
			return nil
		}
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		for _, revision := range trade.SignalRevisions {
			if revision.EventID == eventID {
				return nil
			}
		}
		if trade.SignalRevisions == nil {
			trade.SignalRevisions = []domain.SignalRevision{}
		}
		trade.SignalRevisions = append(trade.SignalRevisions, entry)
		current, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		current["revision_intent"], current["mutation_intent"] = nil, nil
		for key, value := range patch {
			current[key] = value
		}
		current["updated_at"] = store.ISO(r.cfg.Now())
		if err := tx.Put("trade_sets", tradeID, current); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err == nil {
		r.resolveAlert(ctx, "mutation_unknown", tradeID, "revision_resolved")
	}
	return created, err
}

func (r *Runner) persistRevisionIntent(ctx context.Context, tradeID string, revision domain.RevisionIntent, mutation domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.Schema != 2 || trade.MutationIntent != nil || trade.RevisionIntent != nil {
			return errors.New("trade set cannot accept a new revision intent")
		}
		trade.MutationIntent, trade.RevisionIntent = &mutation, &revision
		trade.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", tradeID, updated)
	})
}

func (r *Runner) clearRevisionIntent(ctx context.Context, tradeID string) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		doc["revision_intent"], doc["mutation_intent"] = nil, nil
		doc["updated_at"] = store.ISO(r.cfg.Now())
		return tx.Put("trade_sets", tradeID, doc)
	})
}

func (r *Runner) resumeRevisionIntent(ctx context.Context, view reconcileView, trade domain.TradeSet) (domain.TradeSet, error) {
	revision := trade.RevisionIntent
	if revision == nil {
		return trade, nil
	}
	if trade.BrokerRefs == nil {
		return trade, r.unresolvedMutation(ctx, trade, "revision has no exact broker ticket")
	}
	tol := 1e-9
	if trade.BrokerSymbol != nil {
		if spec, err := view.broker.GetSymbolInfo(ctx, *trade.BrokerSymbol); err == nil {
			tol = math.Max(spec.Point/2, 1e-9)
		}
	}
	var prior, target bool
	var ticket int64
	if revision.TargetKind == "pending" {
		ticket = trade.BrokerRefs.OrderTicket
		order := findOrder(view.orders, ticket, view.broker.Magic())
		if order == nil && trade.State != domain.TradePendingOrder {
			entry := revision.Entry
			entry.Outcome, entry.Reason = "ignored", "pending_order_filled_before_revision_resolution"
			if _, err := r.commitRevision(ctx, trade.TradeSetID, entry.EventID, entry, nil); err != nil {
				return trade, err
			}
			trade.RevisionIntent, trade.MutationIntent = nil, nil
			return trade, nil
		}
		if order != nil {
			target = math.Abs(order.PriceOpen-revision.TargetPrice) <= tol && math.Abs(order.SL-revision.TargetSL) <= tol && math.Abs(order.TP-revision.TargetTP) <= tol
			prior = math.Abs(order.PriceOpen-revision.PriorPrice) <= tol && math.Abs(order.SL-revision.PriorSL) <= tol && math.Abs(order.TP-revision.PriorTP) <= tol
		}
	} else {
		ticket = trade.BrokerRefs.PositionTicket
		position := findPosition(view.positions, ticket, view.broker.Magic())
		if position != nil {
			target = math.Abs(position.SL-revision.TargetSL) <= tol && math.Abs(position.TP-revision.TargetTP) <= tol
			prior = math.Abs(position.SL-revision.PriorSL) <= tol && math.Abs(position.TP-revision.PriorTP) <= tol
		} else {
			positionID := positionIdentifier(trade)
			deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
			if err != nil {
				return trade, err
			}
			if domain.LastExitDeal(deals) != nil {
				entry := revision.Entry
				entry.Outcome, entry.Reason = "ignored", "position_closed_before_revision_resolution"
				lifecycle := domain.CloneTradeSet(trade).Lifecycle
				if lifecycle != nil {
					lifecycle.CurrentVolume = 0
				}
				result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: string(domain.ClassifyCloseReason(deals)), RealizedPnL: domain.RealizedPnLFromDeals(deals)}
				patch := map[string]any{"state": string(domain.TradeClosed), "lifecycle": lifecycle, "result": result}
				if _, err := r.commitRevision(ctx, trade.TradeSetID, entry.EventID, entry, patch); err != nil {
					return trade, err
				}
				trade.State, trade.Lifecycle, trade.Result = domain.TradeClosed, lifecycle, &result
				trade.RevisionIntent, trade.MutationIntent = nil, nil
				r.resolveAlert(ctx, "mutation_unknown", trade.TradeSetID, "position_closed_before_revision_resolution")
				return trade, nil
			}
		}
	}
	if target {
		if _, err := r.commitRevision(ctx, trade.TradeSetID, revision.Entry.EventID, revision.Entry, revision.Patch); err != nil {
			return trade, err
		}
		trade.RevisionIntent, trade.MutationIntent = nil, nil
		return trade, nil
	}
	if !prior {
		return trade, r.unresolvedMutation(ctx, trade, "revision target and prior values are both absent from the exact ticket")
	}
	if trade.MutationIntent != nil {
		return trade, r.unresolvedMutation(ctx, trade, "revision request has an unresolved durable broker mutation; expiry does not permit resubmission")
	}
	action := "POSITION_MODIFY"
	if revision.TargetKind == "pending" {
		action = "PENDING_MODIFY"
	}
	intent := newMutationIntent(r, action, ticket)
	intent.PriorPrice, intent.PriorSL, intent.PriorTP = revision.PriorPrice, revision.PriorSL, revision.PriorTP
	intent.TargetPrice, intent.TargetSL, intent.TargetTP = revision.TargetPrice, revision.TargetSL, revision.TargetTP
	intent.EventID = revision.Entry.EventID
	if err := r.replaceRevisionMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
		return trade, err
	}
	trade.MutationIntent = &intent
	plan := revisionPlan{action: action, ticket: ticket, targetPrice: revision.TargetPrice, targetSL: revision.TargetSL, targetTP: revision.TargetTP}
	err := sendRevisionMutation(ctx, view.broker, plan)
	if err == nil {
		if _, err := r.commitRevision(ctx, trade.TradeSetID, revision.Entry.EventID, revision.Entry, revision.Patch); err != nil {
			return trade, err
		}
		trade.RevisionIntent, trade.MutationIntent = nil, nil
		return trade, nil
	}
	var unavailable *broker.UnavailableError
	if errors.As(err, &unavailable) {
		if clearErr := r.clearUnsentMutation(ctx, trade.TradeSetID); clearErr != nil {
			return trade, clearErr
		}
		return trade, r.unresolvedMutation(ctx, trade, "broker did not accept the fresh revision request")
	}
	var rejected *broker.RejectedError
	if errors.As(err, &rejected) {
		entry := revision.Entry
		entry.Outcome, entry.Reason = "ignored", fmt.Sprintf("broker_rejected_%d", rejected.Retcode)
		if _, commitErr := r.commitRevision(ctx, trade.TradeSetID, entry.EventID, entry, nil); commitErr != nil {
			return trade, commitErr
		}
		trade.RevisionIntent, trade.MutationIntent = nil, nil
		return trade, nil
	}
	r.markMutationUnresolved(trade)
	return trade, r.unresolvedMutation(ctx, trade, err.Error())
}

func (r *Runner) replaceRevisionMutationIntent(ctx context.Context, tradeID string, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.RevisionIntent == nil {
			return errors.New("revision intent disappeared before mutation")
		}
		trade.MutationIntent = &intent
		trade.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", tradeID, updated)
	})
}

func sendRevisionMutation(ctx context.Context, br broker.Broker, plan revisionPlan) error {
	if br == nil {
		return errors.New("revision broker unavailable")
	}
	switch plan.action {
	case "PENDING_MODIFY":
		_, err := br.ModifyPendingOrder(ctx, plan.ticket, plan.targetPrice, plan.targetSL, plan.targetTP)
		return err
	case "POSITION_MODIFY":
		_, _, err := br.ModifyPosition(ctx, plan.ticket, plan.targetSL, plan.targetTP)
		return err
	default:
		return fmt.Errorf("unsupported revision mutation %q", plan.action)
	}
}

func checkpointPlansEqual(a []domain.PlannedCheckpoint, b []domain.PlannedCheckpoint) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].TPIndex != b[i].TPIndex || math.Abs(a[i].Price-b[i].Price) > priceEpsilon {
			return false
		}
	}
	return true
}

func ladderValid(prices []float64, direction domain.Direction, entry float64) bool {
	for i, price := range prices {
		if !finite(price) || direction == domain.Buy && price <= entry || direction == domain.Sell && price >= entry {
			return false
		}
		if i > 0 && (direction == domain.Buy && price <= prices[i-1] || direction == domain.Sell && price >= prices[i-1]) {
			return false
		}
	}
	return true
}

func finite(value float64) bool           { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func joinReasons(reasons []string) string { return strings.Join(reasons, "; ") }
