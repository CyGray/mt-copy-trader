package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func (r *Runner) handleCancel(ctx context.Context, event domain.SignalEvent) domain.HandleResult {
	tradeID := domain.TradeSetID(event.ChatID, event.MessageID)
	trade, err := r.getTrade(ctx, tradeID)
	if err == store.ErrNotFound {
		r.audit(ctx, "info", "cancel_without_trade_set", map[string]any{"trade_set_id": tradeID, "event_id": event.EventID})
		return domain.HandleResult{Outcome: "noop", Reason: "no_trade_set"}
	}
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_read_failed"}
	}
	if trade.MutationIntent != nil || trade.RevisionIntent != nil {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "mutation_pending_reconciliation"}
	}
	if trade.Schema != 2 {
		return domain.HandleResult{Outcome: "noop", Reason: "legacy_trade_set"}
	}
	if trade.Mode != "paper" && trade.Mode != "demo" && trade.Mode != "live" {
		return domain.HandleResult{Outcome: "noop", State: trade.State, Reason: "mode_disabled"}
	}
	reason := event.CancelReason
	if reason != "explicit_cancel" && reason != "unparseable_edit" {
		reason = "unparseable_edit"
	}
	policy := cancellationPolicy(trade.ProfileSnapshot, reason)
	switch trade.State {
	case domain.TradePendingOrder:
		if !policy.cancelPending {
			return r.cancelIgnored(ctx, trade, reason, "policy_keeps_pending_order")
		}
		return r.cancelPending(ctx, trade, event, reason)
	case domain.TradeOpen, domain.TradePartiallyClosed:
		if !policy.closeOpen {
			return r.cancelIgnored(ctx, trade, reason, "policy_keeps_open_position")
		}
		return r.closeForCancel(ctx, trade, event, reason)
	case domain.TradeClaimed, domain.TradeSubmitting, domain.TradeSubmitUnknown:
		if trade.ProfileSnapshot != nil && !policy.cancelPending && !policy.closeOpen {
			return r.cancelIgnored(ctx, trade, reason, "policy_ignores_cancel")
		}
		return r.requestCancel(ctx, trade, event, reason)
	default:
		return domain.HandleResult{Outcome: "noop", State: trade.State, Reason: "no_open_trade_in_" + string(trade.State)}
	}
}

type cancelPolicy struct {
	cancelPending bool
	closeOpen     bool
}

func cancellationPolicy(profile *domain.ExecutionProfile, reason string) cancelPolicy {
	if profile == nil {
		return cancelPolicy{}
	}
	if reason == "unparseable_edit" {
		return cancelPolicy{cancelPending: profile.Edits.UnparseableEdit == "cancel_pending_only"}
	}
	return cancelPolicy{cancelPending: profile.Edits.ExplicitCancel != "ignore", closeOpen: profile.Edits.ExplicitCancel == "close_position"}
}

func (r *Runner) cancelIgnored(ctx context.Context, trade domain.TradeSet, reason, why string) domain.HandleResult {
	r.audit(ctx, "info", "cancel_ignored", map[string]any{"trade_set_id": trade.TradeSetID, "reason": reason, "why": why, "state": trade.State})
	return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: why}
}

func (r *Runner) requestCancel(ctx context.Context, trade domain.TradeSet, event domain.SignalEvent, reason string) domain.HandleResult {
	updated := false
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", trade.TradeSetID)
		if err == store.ErrNotFound {
			return nil
		}
		if err != nil {
			return err
		}
		current, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if current.Schema != 2 || current.State != trade.State || current.EventID != trade.EventID {
			return nil
		}
		current.CancelRequested = &domain.CancelRequest{Reason: reason, At: store.ISO(r.cfg.Now()), EventID: event.EventID}
		updatedDoc, err := jsonDocument(current)
		if err != nil {
			return err
		}
		updatedDoc["updated_at"] = store.ISO(r.cfg.Now())
		if err := tx.Put("trade_sets", trade.TradeSetID, updatedDoc); err != nil {
			return err
		}
		updated = true
		return nil
	})
	if err != nil || !updated {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_request_write_failed"}
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "cancel_"+event.EventID, "cancel_requested", map[string]any{"reason_code": reason, "details": map[string]any{"event_id": event.EventID, "state": trade.State}})
	return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "cancel_requested"}
}

func (r *Runner) cancelPending(ctx context.Context, trade domain.TradeSet, event domain.SignalEvent, reason string) domain.HandleResult {
	if trade.BrokerRefs == nil || trade.BrokerRefs.OrderTicket <= 0 {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "no_pending_order_ref"}
	}
	br, err := r.brokerFor(ctx, trade.Mode)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_broker_unavailable"}
	}
	orders, err := br.GetOrders(ctx, stringPointerValue(trade.BrokerSymbol))
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_order_read_failed"}
	}
	var order *broker.Order
	for i := range orders {
		if orders[i].Ticket == trade.BrokerRefs.OrderTicket && orders[i].Magic == br.Magic() {
			order = &orders[i]
			break
		}
	}
	if order == nil {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "order_not_found"}
	}
	intent := newMutationIntent(r, "CANCEL_ORDER", order.Ticket)
	intent.PriorPrice, intent.PriorSL, intent.PriorTP, intent.PriorVolume = order.PriceOpen, order.SL, order.TP, order.VolumeCurrent
	intent.Reason, intent.EventID = reason, event.EventID
	intent.SuccessPatch = map[string]any{"state": string(domain.TradeCancelled)}
	if err := r.persistCancelMutation(ctx, trade, event, reason, intent); err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_intent_write_failed"}
	}
	_, err = br.CancelOrder(ctx, trade.BrokerRefs.OrderTicket)
	if err != nil {
		var ambiguous *broker.AmbiguousError
		var rejected *broker.RejectedError
		var unavailable *broker.UnavailableError
		if errors.As(err, &ambiguous) {
			r.recordTradeError(ctx, trade, "cancel_ambiguous", err.Error(), event.EventID)
			r.markMutationUnresolved(trade)
			return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "cancel_ambiguous"}
		}
		if errors.As(err, &rejected) {
			r.recordTradeError(ctx, trade, "cancel_rejected", err.Error(), event.EventID)
			_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "cancel_rejected"}
		}
		if errors.As(err, &unavailable) {
			_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			return domain.HandleResult{Outcome: "retry", Reason: "cancel_broker_unavailable"}
		}
		r.markMutationUnresolved(trade)
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_broker_error"}
	}
	if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeCancelled)}); err != nil {
		r.audit(ctx, "warn", "cancel_state_not_recorded", map[string]any{"trade_set_id": trade.TradeSetID, "ticket": trade.BrokerRefs.OrderTicket})
		r.markMutationUnresolved(trade)
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_cancelled", "pending_order_cancelled", map[string]any{"order_ticket": trade.BrokerRefs.OrderTicket, "reason_code": reason, "details": map[string]any{"event_id": event.EventID}})
	return domain.HandleResult{Outcome: "cancel", State: domain.TradeCancelled, Reason: reason}
}

func (r *Runner) closeForCancel(ctx context.Context, trade domain.TradeSet, event domain.SignalEvent, reason string) domain.HandleResult {
	if trade.BrokerRefs == nil || trade.BrokerRefs.PositionTicket <= 0 || trade.Lifecycle == nil {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "no_position_ref"}
	}
	br, err := r.brokerFor(ctx, trade.Mode)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "close_broker_unavailable"}
	}
	positions, err := br.GetPositions(ctx, stringPointerValue(trade.BrokerSymbol))
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "close_position_read_failed"}
	}
	found := false
	for _, pos := range positions {
		if pos.Ticket == trade.BrokerRefs.PositionTicket {
			found = true
			break
		}
	}
	if !found {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "position_not_found"}
	}
	var position *broker.Position
	for i := range positions {
		if positions[i].Ticket == trade.BrokerRefs.PositionTicket && positions[i].Magic == br.Magic() {
			position = &positions[i]
			break
		}
	}
	if position == nil {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "position_not_found"}
	}
	intent := newMutationIntent(r, "CLOSE_POSITION", position.Ticket)
	intent.PriorSL, intent.PriorTP, intent.PriorVolume = position.SL, position.TP, position.Volume
	intent.TargetRemainingVolume = 0
	intent.Reason, intent.EventID = "cancel", event.EventID
	intent.SuccessPatch = map[string]any{"state": string(domain.TradeClosed)}
	if err := r.persistCancelMutation(ctx, trade, event, reason, intent); err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "cancel_intent_write_failed"}
	}
	trade.MutationIntent = &intent
	trade.CancelRequested = &domain.CancelRequest{Reason: reason, At: store.ISO(r.cfg.Now()), EventID: event.EventID, MutationStatus: "ambiguous"}
	closeResult, updated, complete, err := r.attemptPositionClose(ctx, br, trade, intent, *position, nil)
	if err != nil {
		var ambiguous *broker.AmbiguousError
		var rejected *broker.RejectedError
		var unavailable *broker.UnavailableError
		if errors.As(err, &ambiguous) {
			r.recordTradeError(ctx, trade, "cancel_ambiguous", err.Error(), event.EventID)
			r.markMutationUnresolved(trade)
			return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "cancel_ambiguous"}
		}
		if errors.As(err, &rejected) {
			r.recordTradeError(ctx, trade, "close_rejected", err.Error(), event.EventID)
			_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "close_rejected"}
		}
		if errors.As(err, &unavailable) {
			_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			return domain.HandleResult{Outcome: "retry", Reason: "close_broker_unavailable"}
		}
		r.markMutationUnresolved(trade)
		return domain.HandleResult{Outcome: "retry", Reason: "close_broker_error"}
	}
	if !complete {
		return domain.HandleResult{Outcome: "cancel", State: trade.State, Reason: "cancel_close_partial_pending"}
	}
	trade = updated
	pnl, verified := r.realizedPnL(ctx, br, trade)
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": trade.BrokerRefs.PositionTicket,
		"deal_ticket": closeResult.DealTicket, "volume": closeResult.ClosedVolume, "price": closeResult.Price, "realized_pnl": pnl,
		"retcode": closeResult.Retcode, "reason_code": reason, "details": map[string]any{"event_id": event.EventID, "pnl_verified": verified}})
	return domain.HandleResult{Outcome: "cancel", State: domain.TradeClosed, Reason: reason}
}

func (r *Runner) persistCancelMutation(ctx context.Context, trade domain.TradeSet, event domain.SignalEvent, reason string, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", trade.TradeSetID)
		if err != nil {
			return err
		}
		current, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if current.State != trade.State || current.EventID != trade.EventID || current.MutationIntent != nil {
			return errors.New("trade changed before cancel intent")
		}
		current.CancelRequested = &domain.CancelRequest{Reason: reason, At: store.ISO(r.cfg.Now()), EventID: event.EventID, MutationStatus: "ambiguous"}
		current.MutationIntent = &intent
		current.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(current)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", trade.TradeSetID, updated)
	})
}

func (r *Runner) markMutationUnresolved(trade domain.TradeSet) {
	current := r.Readiness()
	r.setReadiness(Readiness{Reason: "mutation_unresolved", LastReconciledAt: current.LastReconciledAt})
}

func (r *Runner) realizedPnL(ctx context.Context, br broker.Broker, trade domain.TradeSet) (float64, bool) {
	from := int64(0)
	if trade.Submission != nil {
		if at, err := time.Parse(time.RFC3339Nano, trade.Submission.SubmittedAt); err == nil {
			from = at.Unix() - 60
		}
	}
	deals, err := br.GetDeals(ctx, broker.DealQuery{FromSec: from, PositionID: func() *int64 {
		if trade.BrokerRefs == nil {
			return nil
		}
		id := positionIdentifier(trade)
		return &id
	}()})
	if err != nil {
		return 0, false
	}
	pnl := 0.0
	for _, deal := range deals {
		if trade.BrokerRefs != nil && deal.PositionID == positionIdentifier(trade) && (deal.Entry == "OUT" || deal.Entry == "OUT_BY" || deal.Entry == "INOUT") {
			pnl += deal.Profit + deal.Commission + deal.Swap + deal.Fee
		}
	}
	return pnl, true
}

func (r *Runner) recordTradeError(ctx context.Context, trade domain.TradeSet, code, message, eventID string) {
	details := map[string]any{}
	if eventID != "" {
		details["event_id"] = eventID
	}
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "error_"+code+"_"+store.ISO(r.cfg.Now()), "execution_error", map[string]any{"reason_code": code, "message": message, "details": details})
	r.audit(ctx, "error", "execution_error", map[string]any{"trade_set_id": trade.TradeSetID, "reason_code": code, "detail": message})
}

func (r *Runner) brokerFor(ctx context.Context, mode string) (broker.Broker, error) {
	if mode != "paper" && mode != "demo" && mode != "live" {
		return nil, fmt.Errorf("unsupported broker mode %q", mode)
	}
	if r.cfg.BrokerForMode == nil {
		return nil, errors.New("broker factory unavailable")
	}
	return r.cfg.BrokerForMode(ctx, mode)
}
