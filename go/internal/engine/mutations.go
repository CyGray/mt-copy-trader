package engine

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const mutationRequestTTLSeconds = 8

var errMutationUnresolved = errors.New("broker mutation outcome is still unresolved")

func newMutationIntent(r *Runner, action string, ticket int64) domain.MutationIntent {
	now := r.cfg.Now()
	return domain.MutationIntent{Action: action, Ticket: ticket, At: store.ISO(now), ExpiresAt: now.Unix() + mutationRequestTTLSeconds}
}

func (r *Runner) persistMutationIntent(ctx context.Context, tradeID string, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.Schema != 2 {
			return errors.New("mutation intent requires schema-2 trade set")
		}
		if trade.MutationIntent != nil {
			return fmt.Errorf("trade set already has unresolved %s intent", trade.MutationIntent.Action)
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

func (r *Runner) persistTradeMutationIntent(ctx context.Context, tradeID string, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.Schema != 2 || trade.MutationIntent != nil {
			return errors.New("trade set cannot accept a new mutation intent")
		}
		trade.MutationIntent = &intent
		if trade.CancelRequested != nil {
			trade.CancelRequested.MutationStatus = "ambiguous"
		}
		if trade.CloseRequestedBy == "close_all" {
			trade.CloseRequestStatus = "ambiguous"
		}
		trade.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", tradeID, updated)
	})
}

func (r *Runner) completeMutationIntent(ctx context.Context, tradeID string, patch store.Document) error {
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.MutationIntent == nil {
			return nil
		}
		for key, value := range patch {
			doc[key] = value
		}
		doc["mutation_intent"] = nil
		doc["updated_at"] = store.ISO(r.cfg.Now())
		return tx.Put("trade_sets", tradeID, doc)
	})
	if err == nil {
		r.resolveAlert(ctx, "mutation_unknown", tradeID, "broker_mutation_resolved")
	}
	return err
}

func (r *Runner) clearUnsentMutation(ctx context.Context, tradeID string) error {
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		trade.MutationIntent = nil
		if trade.CancelRequested != nil {
			trade.CancelRequested.MutationStatus = ""
		}
		if trade.CloseRequestedBy == "close_all" {
			trade.CloseRequestStatus = "pending"
		}
		trade.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", tradeID, updated)
	})
	if err == nil {
		r.resolveAlert(ctx, "mutation_unknown", tradeID, "broker_mutation_not_sent")
	}
	return err
}

func (r *Runner) resolveMutationIntent(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	intent := trade.MutationIntent
	if intent == nil {
		return trade, nil
	}
	step, priceTol := 0.0, 1e-9
	if trade.BrokerSymbol != nil {
		if spec, err := view.broker.GetSymbolInfo(ctx, *trade.BrokerSymbol); err == nil {
			step = spec.VolumeStep
			priceTol = math.Max(spec.Point/2, 1e-9)
		}
	}
	position := findPosition(view.positions, intent.Ticket, view.broker.Magic())
	order := findOrder(view.orders, intent.Ticket, view.broker.Magic())
	if intent.Action == "CLOSE_POSITION" && intent.PartialConfirmed && position != nil {
		return r.resumeConfirmedPartialClose(ctx, view, trade, *position, summary)
	}
	if intent.Action == "POSITION_MODIFY" && position == nil && trade.BrokerRefs != nil {
		positionID := positionIdentifier(trade)
		deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
		if err != nil {
			return trade, err
		}
		if domain.LastExitDeal(deals) != nil {
			lifecycle := domain.CloneTradeSet(trade).Lifecycle
			if lifecycle != nil {
				lifecycle.CurrentVolume = 0
			}
			result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: string(domain.ClassifyCloseReason(deals)), RealizedPnL: domain.RealizedPnLFromDeals(deals)}
			if trade.RevisionIntent != nil {
				entry := trade.RevisionIntent.Entry
				entry.Outcome, entry.Reason = "ignored", "position_closed_before_revision_resolution"
				patch := map[string]any{"state": string(domain.TradeClosed), "lifecycle": lifecycle, "result": result}
				if _, err := r.commitRevision(ctx, trade.TradeSetID, entry.EventID, entry, patch); err != nil {
					return trade, err
				}
			} else if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeClosed), "lifecycle": lifecycle, "result": result}); err != nil {
				return trade, err
			}
			trade.State, trade.Lifecycle, trade.Result = domain.TradeClosed, lifecycle, &result
			trade.MutationIntent, trade.RevisionIntent = nil, nil
			return trade, nil
		}
	}
	observedTarget, observedPrior, superseded := false, false, false
	switch intent.Action {
	case "POSITION_MODIFY":
		if position != nil {
			observedTarget = math.Abs(position.SL-intent.TargetSL) <= priceTol && math.Abs(position.TP-intent.TargetTP) <= priceTol
			observedPrior = math.Abs(position.SL-intent.PriorSL) <= priceTol && math.Abs(position.TP-intent.PriorTP) <= priceTol
		}
	case "PENDING_MODIFY":
		if order == nil && trade.State != domain.TradePendingOrder {
			superseded = true
		} else if order != nil {
			observedTarget = math.Abs(order.PriceOpen-intent.TargetPrice) <= priceTol && math.Abs(order.SL-intent.TargetSL) <= priceTol && math.Abs(order.TP-intent.TargetTP) <= priceTol
			observedPrior = math.Abs(order.PriceOpen-intent.PriorPrice) <= priceTol && math.Abs(order.SL-intent.PriorSL) <= priceTol && math.Abs(order.TP-intent.PriorTP) <= priceTol
		}
	case "CANCEL_ORDER":
		if order == nil && trade.State == domain.TradePendingOrder {
			return trade, r.unresolvedMutation(ctx, trade, "pending order is absent without a correlated fill or exact cancellation result")
		} else if order == nil {
			// A pending order may have filled while its cancel was ambiguous. The
			// pending reconciler has already adopted that exact correlated state.
			superseded = true
		} else {
			observedPrior = math.Abs(order.VolumeCurrent-intent.PriorVolume) <= math.Max(step/2, 1e-9)
		}
	case "CLOSE_POSITION":
		observedTarget = position == nil
		if position != nil {
			observedTarget = position.Volume <= intent.TargetRemainingVolume+1e-9
			observedPrior = math.Abs(position.Volume-intent.PriorVolume) <= math.Max(step/2, 1e-9)
		}
	default:
		return trade, fmt.Errorf("unknown durable broker mutation %q", intent.Action)
	}
	if superseded {
		if trade.RevisionIntent != nil {
			entry := trade.RevisionIntent.Entry
			entry.Outcome, entry.Reason = "ignored", "pending_order_changed_state_before_revision_resolution"
			if _, err := r.commitRevision(ctx, trade.TradeSetID, entry.EventID, entry, nil); err != nil {
				return trade, err
			}
			trade.MutationIntent, trade.RevisionIntent = nil, nil
			return trade, nil
		}
		patch := store.Document{}
		if trade.CancelRequested != nil {
			request := *trade.CancelRequested
			request.MutationStatus = ""
			patch["cancel_requested"] = request
		}
		if intent.Reason == "close_all" {
			patch["close_request_status"] = "pending"
		}
		if err := r.completeMutationIntent(ctx, trade.TradeSetID, patch); err != nil {
			return trade, err
		}
		trade.MutationIntent = nil
		if intent.Reason == "close_all" {
			trade.CloseRequestStatus = "pending"
		}
		if trade.CancelRequested != nil {
			trade.CancelRequested.MutationStatus = ""
		}
		return trade, nil
	}
	if observedTarget {
		if trade.RevisionIntent != nil {
			revision := trade.RevisionIntent
			if _, err := r.commitRevision(ctx, trade.TradeSetID, revision.Entry.EventID, revision.Entry, revision.Patch); err != nil {
				return trade, err
			}
			trade.MutationIntent, trade.RevisionIntent = nil, nil
			return trade, nil
		}
		patch := store.Document{}
		for key, value := range intent.SuccessPatch {
			patch[key] = value
		}
		if intent.Action == "CLOSE_POSITION" && position == nil && (trade.State == domain.TradeOpen || trade.State == domain.TradePartiallyClosed) {
			positionID := positionIdentifier(trade)
			deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
			if err != nil {
				return trade, err
			}
			if domain.LastExitDeal(deals) == nil {
				return trade, r.unresolvedMutation(ctx, trade, "position disappeared without an exit deal")
			}
			lifecycle := domain.CloneTradeSet(trade).Lifecycle
			if lifecycle != nil {
				lifecycle.CurrentVolume = 0
			}
			patch["state"] = string(domain.TradeClosed)
			patch["lifecycle"] = lifecycle
			patch["result"] = domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: fallback(intent.Reason, "cancel"), RealizedPnL: domain.RealizedPnLFromDeals(deals)}
			if trade.CancelRequested != nil {
				request := *trade.CancelRequested
				request.MutationStatus = "done"
				patch["cancel_requested"] = request
			}
			if intent.Reason == "close_all" {
				patch["close_request_status"] = "done"
			}
			summary.cancelsApplied++
		}
		if err := r.completeMutationIntent(ctx, trade.TradeSetID, patch); err != nil {
			return trade, err
		}
		trade.MutationIntent = nil
		if raw, ok := patch["state"].(string); ok {
			trade.State = domain.TradeState(raw)
		}
		if trade.State == domain.TradeClosed && trade.Lifecycle != nil {
			trade.Lifecycle.CurrentVolume = 0
		}
		return trade, nil
	}
	if observedPrior {
		return trade, r.unresolvedMutation(ctx, trade, "exact ticket still shows the prior state; expiry does not prove the broker will not apply the request later")
	}
	return trade, r.unresolvedMutation(ctx, trade, "broker state does not confirm the requested target")
}

func (r *Runner) resumeConfirmedPartialClose(ctx context.Context, view reconcileView, trade domain.TradeSet, position broker.Position, summary *reconcileSummary) (domain.TradeSet, error) {
	intent := *trade.MutationIntent
	step := 0.0
	if trade.BrokerSymbol != nil {
		spec, err := view.broker.GetSymbolInfo(ctx, *trade.BrokerSymbol)
		if err != nil {
			return trade, err
		}
		step = spec.VolumeStep
	}
	if step <= 0 {
		return trade, r.unresolvedMutation(ctx, trade, "symbol volume step is unavailable for continued close")
	}
	volume, _ := domain.CloseVolumeFor(position.Volume, intent.TargetRemainingVolume, step)
	if volume <= 0 {
		return trade, r.unresolvedMutation(ctx, trade, "confirmed partial close has no remaining target volume")
	}
	fresh := intent
	fresh.At, fresh.ExpiresAt = store.ISO(r.cfg.Now()), r.cfg.Now().Unix()+mutationRequestTTLSeconds
	fresh.PriorSL, fresh.PriorTP, fresh.PriorVolume = position.SL, position.TP, position.Volume
	fresh.PartialConfirmed = false
	if err := r.replaceMutationIntent(ctx, trade.TradeSetID, fresh); err != nil {
		return trade, err
	}
	trade.MutationIntent = &fresh
	result, err := view.broker.ClosePosition(ctx, position.Ticket, &volume)
	if err != nil {
		var ambiguous *broker.AmbiguousError
		if errors.As(err, &ambiguous) {
			r.markMutationUnresolved(trade)
			return trade, r.unresolvedMutation(ctx, trade, "continued partial close did not confirm")
		}
		var rejected *broker.RejectedError
		var unavailable *broker.UnavailableError
		if errors.As(err, &rejected) || errors.As(err, &unavailable) {
			// The preceding 10010 was confirmed from an exact fresh position read.
			// A definite rejection or pre-send outage proves this continuation did
			// not hand off, so preserve that explicit retry permission. Ambiguous
			// outcomes leave the ordinary intent fenced above.
			fresh.PartialConfirmed = true
			if err := r.replaceMutationIntent(ctx, trade.TradeSetID, fresh); err != nil {
				return trade, err
			}
			trade.MutationIntent = &fresh
			return trade, nil
		}
		r.markMutationUnresolved(trade)
		return trade, r.unresolvedMutation(ctx, trade, "continued partial close returned an unclassified error")
	}
	complete, remaining, deals, next, err := r.confirmPositionClose(ctx, view.broker, trade, fresh, position, result)
	if err != nil {
		return trade, err
	}
	if !complete {
		if next != nil {
			trade.MutationIntent = next
		}
		if remaining == nil {
			return trade, r.unresolvedMutation(ctx, trade, "close response is awaiting exact position readback")
		}
		if next == nil || !next.PartialConfirmed {
			return trade, r.unresolvedMutation(ctx, trade, "close response did not confirm progress toward zero volume")
		}
		return trade, nil
	}
	return r.finishPositionCloseIntent(ctx, trade, fresh, deals, summary)
}

func (r *Runner) confirmPositionClose(ctx context.Context, br broker.Broker, trade domain.TradeSet, intent domain.MutationIntent, prior broker.Position, result broker.CloseResult) (bool, *broker.Position, []broker.Deal, *domain.MutationIntent, error) {
	symbol := prior.Symbol
	if symbol == "" && trade.BrokerSymbol != nil {
		symbol = *trade.BrokerSymbol
	}
	positions, err := br.GetPositions(ctx, symbol)
	if err != nil {
		return false, nil, nil, nil, &broker.AmbiguousError{Action: "CLOSE_POSITION", Message: "close response was acknowledged but exact position readback failed: " + err.Error()}
	}
	remaining := findPosition(positions, prior.Ticket, br.Magic())
	if remaining != nil {
		if remaining.Volume <= intent.TargetRemainingVolume+1e-9 {
			return false, remaining, nil, nil, nil
		}
		if result.Retcode == 10010 && remaining.Volume < prior.Volume-math.Max(1e-9, 1e-8) {
			next := intent
			next.PriorSL, next.PriorTP, next.PriorVolume = remaining.SL, remaining.TP, remaining.Volume
			next.At, next.ExpiresAt, next.PartialConfirmed = store.ISO(r.cfg.Now()), r.cfg.Now().Unix()+mutationRequestTTLSeconds, true
			if err := r.replaceMutationIntent(ctx, trade.TradeSetID, next); err != nil {
				return false, remaining, nil, nil, err
			}
			return false, remaining, nil, &next, nil
		}
		return false, remaining, nil, nil, nil
	}
	positionID := prior.Identifier
	if positionID <= 0 {
		positionID = positionIdentifier(trade)
	}
	if positionID <= 0 {
		return false, nil, nil, nil, errors.New("position close has no durable broker identifier")
	}
	deals, err := br.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	if err != nil {
		return false, nil, nil, nil, &broker.AmbiguousError{Action: "CLOSE_POSITION", Message: "position is absent after an acknowledged close but exact exit-deal readback failed: " + err.Error()}
	}
	if domain.LastExitDeal(deals) == nil {
		return false, nil, deals, nil, errors.New("position absent after close without exact exit deal")
	}
	return true, nil, deals, nil, nil
}

func (r *Runner) attemptPositionClose(ctx context.Context, br broker.Broker, trade domain.TradeSet, intent domain.MutationIntent, position broker.Position, summary *reconcileSummary) (broker.CloseResult, domain.TradeSet, bool, error) {
	volume := position.Volume - intent.TargetRemainingVolume
	if volume <= 0 {
		return broker.CloseResult{}, trade, false, errors.New("close target has no remaining volume")
	}
	result, err := br.ClosePosition(ctx, position.Ticket, &volume)
	if err != nil {
		return broker.CloseResult{}, trade, false, err
	}
	trade.MutationIntent = &intent
	complete, remaining, deals, next, err := r.confirmPositionClose(ctx, br, trade, intent, position, result)
	if err != nil {
		return result, trade, false, err
	}
	if !complete {
		if next != nil {
			trade.MutationIntent = next
		}
		if remaining == nil || next == nil || !next.PartialConfirmed {
			return result, trade, false, r.unresolvedMutation(ctx, trade, "close response did not confirm target completion or partial progress")
		}
		return result, trade, false, nil
	}
	trade, err = r.finishPositionCloseIntent(ctx, trade, intent, deals, summary)
	return result, trade, err == nil, err
}

func (r *Runner) finishPositionCloseIntent(ctx context.Context, trade domain.TradeSet, intent domain.MutationIntent, deals []broker.Deal, summary *reconcileSummary) (domain.TradeSet, error) {
	lifecycle := domain.CloneTradeSet(trade).Lifecycle
	if lifecycle != nil {
		lifecycle.CurrentVolume = 0
	}
	patch := store.Document{}
	for key, value := range intent.SuccessPatch {
		patch[key] = value
	}
	patch["state"] = string(domain.TradeClosed)
	patch["lifecycle"] = lifecycle
	patch["result"] = domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: fallback(intent.Reason, "cancel"), RealizedPnL: domain.RealizedPnLFromDeals(deals)}
	if intent.Reason == "close_all" {
		patch["close_request_status"] = "done"
	}
	if trade.CancelRequested != nil {
		request := *trade.CancelRequested
		request.MutationStatus = "done"
		patch["cancel_requested"] = request
	}
	if err := r.completeMutationIntent(ctx, trade.TradeSetID, patch); err != nil {
		return trade, err
	}
	trade.State, trade.Lifecycle, trade.MutationIntent = domain.TradeClosed, lifecycle, nil
	trade.Result = patchTradeResult(patch["result"])
	trade.CloseRequestStatus = stringValue(patch["close_request_status"])
	if trade.CancelRequested != nil {
		trade.CancelRequested.MutationStatus = "done"
	}
	if summary != nil {
		summary.cancelsApplied++
	}
	return trade, nil
}

func patchTradeResult(value any) *domain.TradeResult {
	if result, ok := value.(domain.TradeResult); ok {
		return &result
	}
	return nil
}

func (r *Runner) replaceMutationIntent(ctx context.Context, tradeID string, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.MutationIntent == nil || trade.MutationIntent.Action != intent.Action || trade.MutationIntent.Ticket != intent.Ticket {
			return errors.New("mutation intent changed before safe retry")
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

func (r *Runner) unresolvedMutation(ctx context.Context, trade domain.TradeSet, detail string) error {
	action, ticket := "revision", int64(0)
	if trade.MutationIntent != nil {
		action, ticket = trade.MutationIntent.Action, trade.MutationIntent.Ticket
	}
	r.raiseAlert(ctx, "mutation_unknown", trade.TradeSetID, "error", "Broker mutation needs reconciliation", fmt.Sprintf("Trade set %s has an unresolved %s request for ticket %d: %s. No repeat was sent.", trade.TradeSetID, action, ticket, detail), map[string]any{"trade_set_id": trade.TradeSetID, "action": action, "ticket": ticket})
	return fmt.Errorf("%w: %s", errMutationUnresolved, detail)
}

func findPosition(positions []broker.Position, ticket, magic int64) *broker.Position {
	for i := range positions {
		if positions[i].Ticket == ticket && positions[i].Magic == magic {
			return &positions[i]
		}
	}
	return nil
}

func positionIdentifier(trade domain.TradeSet) int64 {
	if trade.BrokerRefs == nil {
		return 0
	}
	if trade.BrokerRefs.PositionIdentifier > 0 {
		return trade.BrokerRefs.PositionIdentifier
	}
	return trade.BrokerRefs.PositionTicket
}

func findOrder(orders []broker.Order, ticket, magic int64) *broker.Order {
	for i := range orders {
		if orders[i].Ticket == ticket && orders[i].Magic == magic {
			return &orders[i]
		}
	}
	return nil
}
