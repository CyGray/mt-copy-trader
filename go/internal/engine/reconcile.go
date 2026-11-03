package engine

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const (
	claimedStaleAfter    = 5 * time.Minute
	submittingStaleAfter = 2 * time.Minute
	submitResolveGrace   = 5 * time.Second
	unknownEscalateAfter = 5 * time.Minute
)

var reconciliationStates = []string{"CLAIMED", "SUBMITTING", "SUBMIT_UNKNOWN", "PENDING_ORDER", "OPEN", "PARTIALLY_CLOSED"}

type reconcileSummary struct {
	checked, staleClaims, staleSubmitting, resolved, rejected, cancelsApplied, volumeUpdates, orphans, errors int
	skippedModes                                                                                              []string
}

type reconcileView struct {
	mode      string
	broker    broker.Broker
	positions []broker.Position
	orders    []broker.Order
	ping      broker.PingInfo
}

func (r *Runner) Reconcile(ctx context.Context) error {
	if r.db == nil {
		return errors.New("engine store unavailable")
	}
	docs, err := r.db.ListTradeSetsByState(ctx, reconciliationStates, 10000)
	if err != nil {
		r.recordReconcileFailure(ctx, "list", err)
		return err
	}
	r.recordReconcileSuccess(ctx, "list")

	trades := make([]domain.TradeSet, 0, len(docs))
	byMode := map[string][]domain.TradeSet{}
	links := newReconcileLinks()
	var first error
	summary := reconcileSummary{checked: len(docs)}
	for _, doc := range docs {
		trade, err := decodeTrade(doc)
		if err != nil {
			if first == nil {
				first = fmt.Errorf("decode trade set: %w", err)
			}
			continue
		}
		trade, err = r.applyStaleRules(ctx, trade, &summary)
		if err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		trades = append(trades, trade)
		links.addTrade(trade)
		if trade.Mode == "paper" || trade.Mode == "demo" || trade.Mode == "live" {
			byMode[trade.Mode] = append(byMode[trade.Mode], trade)
		}
	}
	control, controlErr := r.control(ctx)
	if controlErr != nil && first == nil {
		first = fmt.Errorf("read current execution control: %w", controlErr)
	}
	if controlErr == nil && (control.Mode == "paper" || control.Mode == "demo" || control.Mode == "live") {
		if _, exists := byMode[control.Mode]; !exists {
			byMode[control.Mode] = []domain.TradeSet{}
		}
	}

	for mode, group := range byMode {
		view, err := r.readReconcileView(ctx, mode)
		if err != nil {
			summary.skippedModes = append(summary.skippedModes, mode)
			r.audit(ctx, "warn", "reconciler_mode_skipped", map[string]any{"mode": mode, "error": err.Error()})
			r.recordReconcileFailure(ctx, mode, err)
			if first == nil {
				first = fmt.Errorf("reconcile %s broker state: %w", mode, err)
			}
			continue
		}
		r.recordReconcileSuccess(ctx, mode)
		for _, listed := range group {
			trade, err := r.reconcileTrade(ctx, view, listed, links, &summary)
			if err != nil {
				summary.errors++
				r.audit(ctx, "warn", "reconciler_trade_failed", map[string]any{"trade_set_id": listed.TradeSetID, "mode": mode, "error": err.Error()})
				if first == nil {
					first = fmt.Errorf("reconcile trade %s: %w", listed.TradeSetID, err)
				}
				continue
			}
			if trade.State != listed.State {
				links.addTrade(trade)
			}
		}
		r.reportOrphans(ctx, view, links, &summary)
	}
	r.escalateUnknown(ctx, byMode)
	r.audit(ctx, "info", "reconciler_pass_completed", map[string]any{"checked": summary.checked, "stale_claims": summary.staleClaims, "stale_submitting": summary.staleSubmitting, "resolved": summary.resolved, "rejected": summary.rejected, "cancels_applied": summary.cancelsApplied, "volume_updates": summary.volumeUpdates, "orphans": summary.orphans, "errors": summary.errors, "skipped_modes": summary.skippedModes})
	return first
}

func (r *Runner) readReconcileView(ctx context.Context, mode string) (reconcileView, error) {
	br, err := r.brokerFor(ctx, mode)
	if err != nil {
		return reconcileView{}, err
	}
	ping, err := br.Ping(ctx)
	if err != nil {
		return reconcileView{}, err
	}
	if br.Kind() == broker.MT5 && ping.GMTTime <= 0 {
		return reconcileView{}, errors.New("MT5 TimeGMT is unavailable; broker state cannot establish request expiry")
	}
	positions, err := br.GetPositions(ctx, "")
	if err != nil {
		return reconcileView{}, err
	}
	orders, err := br.GetOrders(ctx, "")
	if err != nil {
		return reconcileView{}, err
	}
	return reconcileView{mode: mode, broker: br, positions: positions, orders: orders, ping: ping}, nil
}

func (r *Runner) applyStaleRules(ctx context.Context, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	now := r.cfg.Now()
	if trade.State == domain.TradeClaimed {
		claimed, err := time.Parse(time.RFC3339Nano, trade.Claim.ClaimedAt)
		if err == nil && now.Sub(claimed) <= claimedStaleAfter {
			return trade, nil
		}
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"CLAIMED"}, store.Document{"state": "ERROR", "error": "stale_claim"})
		if err != nil {
			return trade, err
		}
		if !moved {
			return trade, nil
		}
		summary.staleClaims++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "stale_claim", "execution_error", map[string]any{"reason_code": "stale_claim", "message": "claim older than 5 minutes; nothing was sent"})
		r.audit(ctx, "warn", "reconciler_stale_claim", map[string]any{"trade_set_id": trade.TradeSetID})
		trade.State, trade.Error = domain.TradeError, "stale_claim"
		return trade, nil
	}
	if trade.State == domain.TradeSubmitting {
		submitted := trade.Claim.ClaimedAt
		if trade.Submission != nil && trade.Submission.SubmittedAt != "" {
			submitted = trade.Submission.SubmittedAt
		}
		at, err := time.Parse(time.RFC3339Nano, submitted)
		if err == nil && now.Sub(at) <= submittingStaleAfter {
			return trade, nil
		}
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"SUBMITTING"}, store.Document{"state": "SUBMIT_UNKNOWN"})
		if err != nil {
			return trade, err
		}
		if !moved {
			return trade, nil
		}
		summary.staleSubmitting++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "entry_unknown_stale_submitting", "entry_unknown", map[string]any{"reason_code": "stale_submitting", "message": "submission older than 2 minutes; outcome resolved from broker after expiry"})
		r.audit(ctx, "warn", "reconciler_stale_submitting", map[string]any{"trade_set_id": trade.TradeSetID})
		r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "error", "Entry interrupted mid-send", fmt.Sprintf("Trade set %s stayed SUBMITTING for more than 120 seconds. Broker state will be checked; nothing is resent.", trade.TradeSetID), map[string]any{"trade_set_id": trade.TradeSetID, "mode": trade.Mode, "correlation_comment": trade.CorrelationComment})
		trade.State = domain.TradeSubmitUnknown
	}
	return trade, nil
}

func (r *Runner) reconcileTrade(ctx context.Context, view reconcileView, trade domain.TradeSet, links *reconcileLinks, summary *reconcileSummary) (domain.TradeSet, error) {
	var err error
	if trade.State == domain.TradeSubmitUnknown {
		trade, err = r.resolveUnknown(ctx, view, trade, links, summary)
		if err != nil {
			return trade, err
		}
		if trade.State != domain.TradeSubmitUnknown {
			r.resolveAlert(ctx, "submit_unknown", trade.TradeSetID, "resolved_"+string(trade.State))
		}
	}
	if trade.State == domain.TradePendingOrder {
		trade, err = r.reconcilePending(ctx, view, trade, summary)
		if err != nil {
			return trade, err
		}
	}
	if trade.MutationIntent != nil {
		trade, err = r.resolveMutationIntent(ctx, view, trade, summary)
		if err != nil {
			return trade, err
		}
	}
	if trade.RevisionIntent != nil && trade.MutationIntent == nil {
		trade, err = r.resumeRevisionIntent(ctx, view, trade)
		if err != nil {
			return trade, err
		}
	}
	if trade.CloseRequestedBy == "close_all" {
		trade, err = r.applyCloseAllRequest(ctx, view, trade, summary)
		if err != nil {
			return trade, err
		}
	}
	if trade.CancelRequested != nil && (trade.State == domain.TradePendingOrder || trade.State == domain.TradeOpen || trade.State == domain.TradePartiallyClosed) {
		trade, err = r.applyCancelRequest(ctx, view, trade, summary)
		if err != nil {
			return trade, err
		}
	}
	if trade.State == domain.TradeOpen || trade.State == domain.TradePartiallyClosed {
		if err := r.checkReconcileVolume(ctx, view, trade, summary); err != nil {
			return trade, err
		}
	}
	if trade.State == domain.TradeSubmitUnknown {
		expires := int64(0)
		if trade.Submission != nil {
			expires = trade.Submission.ExpiresAt
		}
		if expires == 0 {
			if created, e := time.Parse(time.RFC3339Nano, trade.CreatedAt); e == nil {
				expires = created.Unix() + 8
			}
		}
		if r.cfg.Now().Unix()-expires >= int64(unknownEscalateAfter.Seconds()) {
			r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Entry outcome still unknown", fmt.Sprintf("Trade set %s (%s) remains SUBMIT_UNKNOWN after request expiry. Inspect exact comment %s in MT5.", trade.TradeSetID, trade.Mode, trade.CorrelationComment), map[string]any{"trade_set_id": trade.TradeSetID, "mode": trade.Mode, "correlation_comment": trade.CorrelationComment})
		}
	}
	return trade, nil
}

func (r *Runner) resolveUnknown(ctx context.Context, view reconcileView, trade domain.TradeSet, links *reconcileLinks, summary *reconcileSummary) (domain.TradeSet, error) {
	expires := int64(0)
	if trade.Submission != nil {
		expires = trade.Submission.ExpiresAt
	}
	if expires == 0 {
		if created, err := time.Parse(time.RFC3339Nano, trade.CreatedAt); err == nil {
			expires = created.Unix() + 8
		}
	}
	extra := int64(0)
	if view.broker.Kind() == broker.MT5 && view.ping.GMTTime > 0 {
		extra = maxInt64(0, r.cfg.Now().Unix()-view.ping.GMTTime)
	}
	if r.cfg.Now().Unix() <= expires+int64(submitResolveGrace.Seconds())+extra {
		return trade, nil
	}
	if trade.Lifecycle == nil {
		return trade, errors.New("SUBMIT_UNKNOWN has no lifecycle snapshot")
	}

	positions := matchingPositions(view, trade.CorrelationComment)
	orders := matchingOrders(view, trade.CorrelationComment)
	deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade)})
	if err != nil {
		return trade, err
	}
	entryDeals := matchingEntryDeals(deals, trade.CorrelationComment, view.broker.Magic())
	positionIDs := map[int64]bool{}
	for _, deal := range entryDeals {
		positionIDs[deal.PositionID] = true
	}
	if len(positions) > 1 || len(orders) > 1 || len(positionIDs) > 1 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"positions": ticketsPosition(positions), "orders": ticketsOrder(orders), "entry_positions": keysInt64(positionIDs)})
		return trade, nil
	}
	if len(positions) > 0 && len(orders) > 0 {
		r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Entry still has a working broker order", fmt.Sprintf("Trade set %s has both a correlated live position and working order. It remains SUBMIT_UNKNOWN until the order remainder is no longer live.", trade.TradeSetID), map[string]any{"trade_set_id": trade.TradeSetID, "positions": ticketsPosition(positions), "orders": ticketsOrder(orders), "correlation_comment": trade.CorrelationComment})
		return trade, nil
	}
	if len(positions) == 1 {
		pos := positions[0]
		entry := firstEntryForPosition(entryDeals, pos.Identifier)
		if entry == nil {
			entry = firstEntryForPosition(entryDeals, pos.Ticket)
		}
		fillPrice, orderTicket, dealTicket := pos.OpenPrice, int64(0), int64(0)
		if entry != nil {
			fillPrice, orderTicket, dealTicket = entry.Price, entry.Order, entry.Ticket
		}
		if fillPrice <= 0 {
			fillPrice = pos.OpenPrice
		}
		refs := domain.BrokerRefs{OrderTicket: orderTicket, PositionTicket: pos.Ticket, PositionIdentifier: pos.Identifier, DealTicket: dealTicket, FillPrice: fillPrice, FilledVolume: pos.Volume}
		lifecycle := domain.CloneTradeSet(trade).Lifecycle
		lifecycle.CurrentVolume = pos.Volume
		if trade.ProfileSnapshot != nil {
			spec, specErr := view.broker.GetSymbolInfo(ctx, stringPointerValue(trade.BrokerSymbol))
			if specErr != nil {
				return trade, specErr
			}
			planned := 0.0
			if trade.Plan != nil {
				planned = trade.Plan.Volume
			}
			fitted := domain.FillCheckpoints(trade.Direction, fillPrice, pos.Volume, &planned, *trade.ProfileSnapshot, domain.SizingSpec{VolumeMin: spec.VolumeMin, VolumeStep: spec.VolumeStep}, lifecycle.Checkpoints)
			if fitted != nil {
				lifecycle.Checkpoints = fitted
			} else {
				r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "partial_fill_replan_infeasible", "execution_error", map[string]any{"position_ticket": pos.Ticket, "volume": pos.Volume, "reason_code": "partial_fill_replan_infeasible"})
			}
		}
		patch, _ := jsonDocument(map[string]any{"state": "OPEN", "broker_refs": refs, "lifecycle": lifecycle})
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"SUBMIT_UNKNOWN"}, patch)
		if err != nil {
			return trade, err
		}
		if !moved {
			return trade, nil
		}
		summary.resolved++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "entry_confirmed", "entry_confirmed", map[string]any{"position_ticket": pos.Ticket, "deal_ticket": dealTicket, "volume": pos.Volume, "price": fillPrice, "details": map[string]any{"source": "reconciler"}})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "reconciliation_submit_unknown_resolved", "reconciliation", map[string]any{"position_ticket": pos.Ticket, "reason_code": "open_position_found", "details": map[string]any{"previous_state": "SUBMIT_UNKNOWN", "new_state": "OPEN"}})
		r.audit(ctx, "info", "reconciler_entry_open", map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": pos.Ticket})
		trade.State, trade.BrokerRefs, trade.Lifecycle = domain.TradeOpen, &refs, lifecycle
		links.addTrade(trade)
		return trade, nil
	}
	if len(orders) == 1 {
		order := orders[0]
		refs := domain.BrokerRefs{OrderTicket: order.Ticket}
		patch, _ := jsonDocument(map[string]any{"state": "PENDING_ORDER", "broker_refs": refs})
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"SUBMIT_UNKNOWN"}, patch)
		if err != nil {
			return trade, err
		}
		if !moved {
			return trade, nil
		}
		summary.resolved++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_placed", "pending_order_placed", map[string]any{"order_ticket": order.Ticket, "price": order.PriceOpen, "volume": order.VolumeInitial, "details": map[string]any{"source": "reconciler"}})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "reconciliation_submit_unknown_resolved", "reconciliation", map[string]any{"order_ticket": order.Ticket, "reason_code": "pending_order_found", "details": map[string]any{"previous_state": "SUBMIT_UNKNOWN", "new_state": "PENDING_ORDER"}})
		r.audit(ctx, "info", "reconciler_entry_pending", map[string]any{"trade_set_id": trade.TradeSetID, "order_ticket": order.Ticket})
		trade.State, trade.BrokerRefs = domain.TradePendingOrder, &refs
		links.addTrade(trade)
		return trade, nil
	}
	if len(entryDeals) > 0 {
		entry := entryDeals[0]
		exits := make([]broker.Deal, 0, len(deals))
		for _, deal := range deals {
			if deal.PositionID == entry.PositionID {
				exits = append(exits, deal)
			}
		}
		for _, position := range view.positions {
			if position.Magic == view.broker.Magic() && (position.Identifier == entry.PositionID || position.Ticket == entry.PositionID) && position.Comment != trade.CorrelationComment {
				r.raiseCorrelationMismatch(ctx, trade, map[string]any{"position_ticket": position.Ticket, "position_identifier": position.Identifier, "position_comment": position.Comment, "entry_position_id": entry.PositionID})
				return trade, nil
			}
		}
		if !completeExitEvidence(exits, entry.PositionID, view.broker.Magic(), trade.CorrelationComment) {
			r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Entry history does not prove a complete exit", fmt.Sprintf("Trade set %s has exact entry history for position identifier %d, but no exact live correlated position or complete exit volume is visible. It remains SUBMIT_UNKNOWN.", trade.TradeSetID, entry.PositionID), map[string]any{"trade_set_id": trade.TradeSetID, "position_identifier": entry.PositionID, "correlation_comment": trade.CorrelationComment})
			return trade, nil
		}
		closeReason := string(domain.ClassifyCloseReason(exits))
		refs := domain.BrokerRefs{OrderTicket: entry.Order, PositionTicket: entry.PositionID, PositionIdentifier: entry.PositionID, DealTicket: entry.Ticket, FillPrice: entry.Price, FilledVolume: entry.Volume}
		lifecycle := domain.CloneTradeSet(trade).Lifecycle
		lifecycle.CurrentVolume = 0
		result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: closeReason, RealizedPnL: domain.RealizedPnLFromDeals(exits)}
		patch, _ := jsonDocument(map[string]any{"state": "CLOSED", "broker_refs": refs, "lifecycle": lifecycle, "result": result})
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"SUBMIT_UNKNOWN"}, patch)
		if err != nil {
			return trade, err
		}
		if !moved {
			return trade, nil
		}
		summary.resolved++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "entry_confirmed", "entry_confirmed", map[string]any{"position_ticket": entry.PositionID, "deal_ticket": entry.Ticket, "price": entry.Price, "details": map[string]any{"source": "reconciler"}})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": entry.PositionID, "realized_pnl": result.RealizedPnL, "reason_code": closeReason})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "reconciliation_submit_unknown_resolved", "reconciliation", map[string]any{"position_ticket": entry.PositionID, "reason_code": "closed_position_found", "details": map[string]any{"previous_state": "SUBMIT_UNKNOWN", "new_state": "CLOSED"}})
		r.audit(ctx, "info", "reconciler_entry_closed", map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": entry.PositionID, "close_reason": closeReason})
		trade.State, trade.BrokerRefs, trade.Lifecycle, trade.Result = domain.TradeClosed, &refs, lifecycle, &result
		links.addTrade(trade)
		return trade, nil
	}
	candidates := correlationCandidates(view, trade, links, deals)
	if len(candidates) > 0 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"candidates": candidates})
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "correlation_candidates", "reconciliation", map[string]any{"reason_code": "possible_uncorrelated_fill", "message": "unlinked EA-magic activity is in the submission window; no ticket was linked", "details": map[string]any{"candidates": candidates}})
		return trade, nil
	}
	// Request expiry prevents late handoff by the EA but does not prove the
	// broker cannot publish or execute an accepted request later. Keep the exact
	// correlation fence active until state or an operator decision resolves it.
	r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Entry outcome still unknown", fmt.Sprintf("Trade set %s (%s) remains SUBMIT_UNKNOWN after request expiry. No exact correlated position, order, or deal is visible; it stays fenced for operator review.", trade.TradeSetID, trade.Mode), map[string]any{"trade_set_id": trade.TradeSetID, "mode": trade.Mode, "correlation_comment": trade.CorrelationComment})
	return trade, nil
}

func (r *Runner) reconcilePending(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	if trade.BrokerRefs == nil || trade.BrokerRefs.OrderTicket <= 0 {
		return trade, errors.New("pending trade has no order ticket")
	}
	positions := matchingPositions(view, trade.CorrelationComment)
	correlatedOrders := matchingOrders(view, trade.CorrelationComment)
	if len(positions) > 1 || len(correlatedOrders) > 1 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"positions": ticketsPosition(positions), "orders": ticketsOrder(correlatedOrders)})
		return trade, nil
	}
	if len(positions) > 0 && len(correlatedOrders) > 0 {
		r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Pending entry has both a position and working order", fmt.Sprintf("Trade set %s has a correlated live position and working order. It remains PENDING_ORDER until the remainder is no longer live.", trade.TradeSetID), map[string]any{"trade_set_id": trade.TradeSetID, "positions": ticketsPosition(positions), "orders": ticketsOrder(correlatedOrders), "correlation_comment": trade.CorrelationComment})
		return trade, nil
	}
	for _, order := range view.orders {
		if order.Ticket == trade.BrokerRefs.OrderTicket && order.Magic == view.broker.Magic() {
			if order.Comment != trade.CorrelationComment {
				r.raiseCorrelationMismatch(ctx, trade, map[string]any{"order_ticket": order.Ticket, "order_comment": order.Comment})
			}
			return trade, nil
		}
	}
	if len(correlatedOrders) > 0 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"orders": ticketsOrder(correlatedOrders), "expected_order_ticket": trade.BrokerRefs.OrderTicket})
		return trade, nil
	}
	if len(positions) == 1 {
		if err := r.pendingToOpen(ctx, view, trade, positions[0], summary); err != nil {
			return trade, err
		}
		updated, err := r.getTrade(ctx, trade.TradeSetID)
		return updated, err
	}
	if len(positions) > 1 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"positions": ticketsPosition(positions)})
		return trade, nil
	}
	deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade)})
	if err != nil {
		return trade, err
	}
	entries := matchingEntryDeals(deals, trade.CorrelationComment, view.broker.Magic())
	unique := map[int64]broker.Deal{}
	for _, entry := range entries {
		unique[entry.PositionID] = entry
	}
	if intent := trade.MutationIntent; intent != nil && (intent.Action == "CANCEL_ORDER" || intent.Action == "PENDING_MODIFY") && len(unique) == 0 {
		// Order absence and elapsed request TTL do not prove that a delayed broker
		// action cannot still apply. Hold the durable intent without resending.
		return trade, r.unresolvedMutation(ctx, trade, "pending order is absent without exact correlated fill or cancellation evidence")
	}
	if len(unique) > 1 {
		r.raiseCorrelationMismatch(ctx, trade, map[string]any{"entry_positions": keysInt64(unique)})
		return trade, nil
	}
	for _, entry := range unique {
		exits := []broker.Deal{}
		for _, deal := range deals {
			if deal.PositionID == entry.PositionID {
				exits = append(exits, deal)
			}
		}
		for _, position := range view.positions {
			if position.Magic == view.broker.Magic() && (position.Identifier == entry.PositionID || position.Ticket == entry.PositionID) && position.Comment != trade.CorrelationComment {
				r.raiseCorrelationMismatch(ctx, trade, map[string]any{"position_ticket": position.Ticket, "position_identifier": position.Identifier, "position_comment": position.Comment, "entry_position_id": entry.PositionID})
				return trade, nil
			}
		}
		if !completeExitEvidence(exits, entry.PositionID, view.broker.Magic(), trade.CorrelationComment) {
			r.raiseAlert(ctx, "mutation_unknown", trade.TradeSetID, "error", "Pending fill history does not prove a complete exit", fmt.Sprintf("Trade set %s has an exact entry deal for position identifier %d, but no exact live correlated position or complete exit volume is visible. It remains PENDING_ORDER.", trade.TradeSetID, entry.PositionID), map[string]any{"trade_set_id": trade.TradeSetID, "order_ticket": trade.BrokerRefs.OrderTicket, "position_identifier": entry.PositionID, "correlation_comment": trade.CorrelationComment})
			return trade, nil
		}
		last := domain.LastExitDeal(exits)
		if last == nil {
			return trade, nil
		}
		refs := domain.BrokerRefs{OrderTicket: trade.BrokerRefs.OrderTicket, PositionTicket: entry.PositionID, PositionIdentifier: entry.PositionID, DealTicket: entry.Ticket, FillPrice: entry.Price, FilledVolume: entry.Volume}
		lifecycle := domain.CloneTradeSet(trade).Lifecycle
		if lifecycle != nil {
			lifecycle.CurrentVolume = 0
		}
		result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: string(domain.ClassifyCloseReason(exits)), RealizedPnL: domain.RealizedPnLFromDeals(exits)}
		patch, _ := jsonDocument(map[string]any{"state": "CLOSED", "broker_refs": refs, "lifecycle": lifecycle, "result": result})
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"PENDING_ORDER"}, patch)
		if err != nil {
			return trade, err
		}
		if moved {
			summary.resolved++
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_filled", "pending_order_filled", map[string]any{"order_ticket": refs.OrderTicket, "position_ticket": refs.PositionTicket, "deal_ticket": refs.DealTicket, "price": refs.FillPrice})
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": refs.PositionTicket, "deal_ticket": last.Ticket, "realized_pnl": result.RealizedPnL, "reason_code": result.CloseReason})
		}
		trade.State, trade.BrokerRefs, trade.Lifecycle, trade.Result = domain.TradeClosed, &refs, lifecycle, &result
		return trade, nil
	}
	r.raiseAlert(ctx, "mutation_unknown", trade.TradeSetID, "error", "Pending order is absent without exact resolution", fmt.Sprintf("Trade set %s order ticket %d is absent, but no correlated position or entry/exit deal proves cancellation. It remains fenced for later reconciliation.", trade.TradeSetID, trade.BrokerRefs.OrderTicket), map[string]any{"trade_set_id": trade.TradeSetID, "order_ticket": trade.BrokerRefs.OrderTicket, "mode": trade.Mode})
	return trade, nil
}

func completeExitEvidence(deals []broker.Deal, positionID, magic int64, comment string) bool {
	entryVolume, exitVolume := 0.0, 0.0
	for _, deal := range deals {
		if deal.PositionID != positionID || deal.Magic != magic {
			continue
		}
		switch deal.Entry {
		case "IN":
			if deal.Comment == comment {
				entryVolume += deal.Volume
			}
		case "OUT", "OUT_BY":
			exitVolume += deal.Volume
		case "INOUT":
			// INOUT includes a reversal entry and is not proof of a flat hedging
			// position; leave the trade fenced for operator reconciliation.
			return false
		}
	}
	return entryVolume > 0 && exitVolume+1e-8 >= entryVolume
}

func (r *Runner) pendingToOpen(ctx context.Context, view reconcileView, trade domain.TradeSet, position broker.Position, summary *reconcileSummary) error {
	refs := domain.BrokerRefs{OrderTicket: trade.BrokerRefs.OrderTicket, PositionTicket: position.Ticket, PositionIdentifier: position.Identifier, FillPrice: position.OpenPrice, FilledVolume: position.Volume}
	positionID := position.Identifier
	deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	if err != nil {
		return err
	}
	for _, deal := range deals {
		if deal.Entry == "IN" && deal.PositionID == position.Identifier {
			refs.DealTicket, refs.FillPrice = deal.Ticket, deal.Price
			break
		}
	}
	lifecycle := domain.CloneTradeSet(trade).Lifecycle
	if lifecycle == nil {
		return errors.New("pending trade has no lifecycle")
	}
	lifecycle.CurrentVolume = position.Volume
	if trade.ProfileSnapshot != nil {
		spec, err := view.broker.GetSymbolInfo(ctx, stringPointerValue(trade.BrokerSymbol))
		if err != nil {
			return err
		}
		planned := 0.0
		if trade.Plan != nil {
			planned = trade.Plan.Volume
		}
		fitted := domain.FillCheckpoints(trade.Direction, refs.FillPrice, position.Volume, &planned, *trade.ProfileSnapshot, domain.SizingSpec{VolumeMin: spec.VolumeMin, VolumeStep: spec.VolumeStep}, lifecycle.Checkpoints)
		if fitted != nil {
			lifecycle.Checkpoints = fitted
		} else {
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "partial_fill_replan_infeasible", "execution_error", map[string]any{"position_ticket": position.Ticket, "volume": position.Volume, "reason_code": "partial_fill_replan_infeasible"})
		}
	}
	patch, _ := jsonDocument(map[string]any{"state": "OPEN", "broker_refs": refs, "lifecycle": lifecycle})
	moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"PENDING_ORDER"}, patch)
	if err != nil {
		return err
	}
	if !moved {
		return nil
	}
	summary.resolved++
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_filled", "pending_order_filled", map[string]any{"order_ticket": refs.OrderTicket, "position_ticket": position.Ticket, "deal_ticket": refs.DealTicket, "volume": position.Volume, "price": refs.FillPrice})
	r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "entry_confirmed", "entry_confirmed", map[string]any{"order_ticket": refs.OrderTicket, "position_ticket": position.Ticket, "deal_ticket": refs.DealTicket, "volume": position.Volume, "price": refs.FillPrice})
	return nil
}

func (r *Runner) applyCloseAllRequest(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	if trade.BrokerRefs == nil {
		return trade, nil
	}
	if trade.State == domain.TradePendingOrder {
		if trade.CloseRequestStatus == "ambiguous" || trade.CloseRequestStatus == "done" {
			return trade, nil
		}
		for _, order := range view.orders {
			if order.Ticket != trade.BrokerRefs.OrderTicket || order.Magic != view.broker.Magic() {
				continue
			}
			intent := newMutationIntent(r, "CANCEL_ORDER", order.Ticket)
			intent.PriorPrice, intent.PriorSL, intent.PriorTP, intent.PriorVolume = order.PriceOpen, order.SL, order.TP, order.VolumeCurrent
			intent.Reason = "close_all"
			intent.SuccessPatch = map[string]any{"state": string(domain.TradeCancelled), "close_request_status": "done"}
			if err := r.persistTradeMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
				return trade, err
			}
			if _, err := view.broker.CancelOrder(ctx, order.Ticket); err != nil {
				var unavailable *broker.UnavailableError
				var rejected *broker.RejectedError
				if errors.As(err, &unavailable) || errors.As(err, &rejected) {
					return trade, r.clearUnsentMutation(ctx, trade.TradeSetID)
				}
				r.markMutationUnresolved(trade)
				return trade, nil
			}
			if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeCancelled), "close_request_status": "done"}); err != nil {
				return trade, err
			}
			trade.State, trade.CloseRequestStatus = domain.TradeCancelled, "done"
			trade.MutationIntent = nil
			summary.cancelsApplied++
			r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_cancelled", "pending_order_cancelled", map[string]any{"order_ticket": order.Ticket, "reason_code": "close_all"})
			return trade, nil
		}
		return trade, nil
	}
	if trade.State != domain.TradeOpen && trade.State != domain.TradePartiallyClosed {
		return trade, nil
	}
	if trade.CloseRequestStatus == "ambiguous" {
		return trade, nil
	}
	if trade.CloseRequestStatus == "done" {
		for _, pos := range view.positions {
			if pos.Ticket == trade.BrokerRefs.PositionTicket && pos.Magic == view.broker.Magic() {
				return trade, nil
			}
		}
		return r.finalizeCloseAll(ctx, view, trade, summary)
	}
	for _, pos := range view.positions {
		if pos.Ticket != trade.BrokerRefs.PositionTicket || pos.Magic != view.broker.Magic() {
			continue
		}
		intent := newMutationIntent(r, "CLOSE_POSITION", pos.Ticket)
		intent.PriorSL, intent.PriorTP, intent.PriorVolume = pos.SL, pos.TP, pos.Volume
		intent.TargetRemainingVolume, intent.Reason = 0, "close_all"
		intent.SuccessPatch = map[string]any{"close_request_status": "done"}
		if err := r.persistTradeMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
			return trade, err
		}
		trade.MutationIntent, trade.CloseRequestStatus = &intent, "ambiguous"
		closeResult, updated, complete, err := r.attemptPositionClose(ctx, view.broker, trade, intent, pos, summary)
		if err != nil {
			var unavailable *broker.UnavailableError
			var rejected *broker.RejectedError
			if errors.As(err, &unavailable) || errors.As(err, &rejected) {
				if clearErr := r.clearUnsentMutation(ctx, trade.TradeSetID); clearErr != nil {
					return trade, clearErr
				}
				trade.MutationIntent, trade.CloseRequestStatus = nil, "pending"
				return trade, nil
			}
			r.markMutationUnresolved(trade)
			return trade, err
		}
		trade = updated
		if !complete {
			return trade, nil
		}
		pnl := float64(0)
		if trade.Result != nil {
			pnl = trade.Result.RealizedPnL
		}
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": pos.Ticket, "deal_ticket": closeResult.DealTicket, "volume": closeResult.ClosedVolume, "price": closeResult.Price, "realized_pnl": pnl, "reason_code": "close_all"})
		return trade, nil
	}
	if trade.CloseRequestStatus == "done" {
		return r.finalizeCloseAll(ctx, view, trade, summary)
	}
	return trade, nil
}

func (r *Runner) finalizeCloseAll(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	if trade.BrokerRefs == nil {
		return trade, nil
	}
	positionID := positionIdentifier(trade)
	deals, err := view.broker.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	if err != nil {
		return trade, err
	}
	if domain.LastExitDeal(deals) == nil {
		return trade, nil
	}
	lifecycle := domain.CloneTradeSet(trade).Lifecycle
	if lifecycle != nil {
		lifecycle.CurrentVolume = 0
	}
	result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: "close_all", RealizedPnL: domain.RealizedPnLFromDeals(deals)}
	patch, _ := jsonDocument(map[string]any{"state": "CLOSED", "lifecycle": lifecycle, "result": result, "close_request_status": "done"})
	moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"OPEN", "PARTIALLY_CLOSED"}, patch)
	if err != nil {
		return trade, err
	}
	if moved {
		trade.State, trade.Lifecycle, trade.Result, trade.CloseRequestStatus = domain.TradeClosed, lifecycle, &result, "done"
		summary.cancelsApplied++
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": positionID, "realized_pnl": result.RealizedPnL, "reason_code": "close_all"})
	}
	return trade, nil
}

func (r *Runner) applyCancelRequest(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) (domain.TradeSet, error) {
	request := trade.CancelRequested
	if request == nil {
		return trade, nil
	}
	profile := trade.ProfileSnapshot
	ignore := func() {
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "cancel_ignored_"+request.Reason, "signal_revision_ignored", map[string]any{"reason_code": "cancel_not_applicable", "message": fmt.Sprintf("cancel (%s) not applied for state %s under frozen profile edits", request.Reason, trade.State)})
	}
	if profile == nil {
		ignore()
		return trade, nil
	}
	if trade.State == domain.TradePendingOrder {
		allowed := request.Reason == "unparseable_edit" && profile.Edits.UnparseableEdit == "cancel_pending_only" || request.Reason != "unparseable_edit" && (profile.Edits.ExplicitCancel == "cancel_pending_only" || profile.Edits.ExplicitCancel == "close_position")
		if !allowed {
			ignore()
			return trade, nil
		}
		if trade.BrokerRefs == nil || request.MutationStatus == "ambiguous" {
			return trade, nil
		}
		for _, order := range view.orders {
			if order.Ticket == trade.BrokerRefs.OrderTicket && order.Magic == view.broker.Magic() {
				intent := newMutationIntent(r, "CANCEL_ORDER", order.Ticket)
				intent.PriorPrice, intent.PriorSL, intent.PriorTP, intent.PriorVolume = order.PriceOpen, order.SL, order.TP, order.VolumeCurrent
				intent.Reason, intent.EventID = request.Reason, request.EventID
				intent.SuccessPatch = map[string]any{"state": string(domain.TradeCancelled)}
				if err := r.persistTradeMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
					return trade, err
				}
				if _, err := view.broker.CancelOrder(ctx, order.Ticket); err != nil {
					var unavailable *broker.UnavailableError
					var rejected *broker.RejectedError
					if errors.As(err, &unavailable) || errors.As(err, &rejected) {
						return trade, r.clearUnsentMutation(ctx, trade.TradeSetID)
					}
					r.markMutationUnresolved(trade)
					return trade, nil
				}
				if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeCancelled)}); err != nil {
					return trade, err
				}
				trade.State = domain.TradeCancelled
				summary.cancelsApplied++
				r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "pending_order_cancelled", "pending_order_cancelled", map[string]any{"order_ticket": order.Ticket, "reason_code": "cancel_requested_" + request.Reason})
				r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "cancel_applied", "cancel_requested", map[string]any{"order_ticket": order.Ticket, "reason_code": request.Reason})
				return trade, nil
			}
		}
		return trade, nil
	}
	if trade.State == domain.TradeOpen || trade.State == domain.TradePartiallyClosed {
		if request.Reason != "explicit_cancel" || profile.Edits.ExplicitCancel != "close_position" {
			ignore()
			return trade, nil
		}
		if trade.BrokerRefs == nil {
			return trade, errors.New("cancel request has no broker reference")
		}
		if request.MutationStatus == "ambiguous" {
			return trade, nil
		}
		for _, pos := range view.positions {
			if pos.Ticket == trade.BrokerRefs.PositionTicket && pos.Magic == view.broker.Magic() {
				intent := newMutationIntent(r, "CLOSE_POSITION", pos.Ticket)
				intent.PriorSL, intent.PriorTP, intent.PriorVolume = pos.SL, pos.TP, pos.Volume
				intent.TargetRemainingVolume, intent.Reason, intent.EventID = 0, "cancel", request.EventID
				intent.SuccessPatch = map[string]any{"state": string(domain.TradeClosed)}
				if err := r.persistTradeMutationIntent(ctx, trade.TradeSetID, intent); err != nil {
					return trade, err
				}
				trade.MutationIntent = &intent
				if trade.CancelRequested != nil {
					trade.CancelRequested.MutationStatus = "ambiguous"
				}
				closeResult, updated, complete, err := r.attemptPositionClose(ctx, view.broker, trade, intent, pos, summary)
				if err != nil {
					var unavailable *broker.UnavailableError
					var rejected *broker.RejectedError
					if errors.As(err, &unavailable) || errors.As(err, &rejected) {
						if clearErr := r.clearUnsentMutation(ctx, trade.TradeSetID); clearErr != nil {
							return trade, clearErr
						}
						trade.MutationIntent = nil
						trade.CancelRequested.MutationStatus = ""
						return trade, nil
					}
					r.markMutationUnresolved(trade)
					return trade, err
				}
				trade = updated
				if !complete {
					return trade, nil
				}
				pnl := float64(0)
				if trade.Result != nil {
					pnl = trade.Result.RealizedPnL
				}
				r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, "position_closed", "position_closed", map[string]any{"position_ticket": pos.Ticket, "deal_ticket": closeResult.DealTicket, "volume": closeResult.ClosedVolume, "realized_pnl": pnl, "reason_code": "cancel"})
				return trade, nil
			}
		}
		return trade, nil
	}
	return trade, nil
}

func (r *Runner) checkReconcileVolume(ctx context.Context, view reconcileView, trade domain.TradeSet, summary *reconcileSummary) error {
	if trade.BrokerRefs == nil || trade.Lifecycle == nil || trade.BrokerSymbol == nil {
		return nil
	}
	for _, pos := range view.positions {
		if pos.Ticket != trade.BrokerRefs.PositionTicket || pos.Magic != view.broker.Magic() {
			continue
		}
		if pos.Comment != trade.CorrelationComment {
			r.raiseAlert(ctx, "correlation_mismatch", trade.TradeSetID, "critical", "Broker did not preserve the order comment", fmt.Sprintf("Position %d carries comment %q instead of %q.", pos.Ticket, pos.Comment, trade.CorrelationComment), map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": pos.Ticket, "sent": trade.CorrelationComment, "stored": pos.Comment})
		}
		spec, err := view.broker.GetSymbolInfo(ctx, *trade.BrokerSymbol)
		if err != nil {
			return err
		}
		step, current := spec.VolumeStep, trade.Lifecycle.CurrentVolume
		if pos.Volume >= current-step/2 {
			return nil
		}
		explained := false
		for _, cp := range trade.Lifecycle.Checkpoints {
			if cp.Status == "closing" || math.Abs(pos.Volume-cp.TargetRemainingVolume) <= step/2+priceEpsilon {
				explained = true
				break
			}
		}
		if explained {
			return nil
		}
		previous := current
		patch := store.Document{"lifecycle": store.Document{"current_volume": pos.Volume}}
		moved, err := r.db.TransitionTradeSet(ctx, trade.TradeSetID, []string{"OPEN", "PARTIALLY_CLOSED"}, patch)
		if err != nil {
			return err
		}
		if !moved {
			return nil
		}
		summary.volumeUpdates++
		key := fmt.Sprintf("external_volume_change_%.*f", domain.VolumeDecimals(step), pos.Volume)
		r.tradeEvent(ctx, trade.TradeSetID, trade.Mode, key, "reconciliation", map[string]any{"position_ticket": pos.Ticket, "volume": pos.Volume, "reason_code": "external_volume_change", "details": map[string]any{"previous_volume": previous}})
		r.audit(ctx, "warn", "reconciler_external_volume_change", map[string]any{"trade_set_id": trade.TradeSetID, "position_ticket": pos.Ticket, "previous_volume": previous, "volume": pos.Volume})
		return nil
	}
	return nil
}

type reconcileLinks struct {
	positions map[string]map[int64]bool
	orders    map[string]map[int64]bool
	comments  map[string]bool
}

func newReconcileLinks() *reconcileLinks {
	return &reconcileLinks{positions: map[string]map[int64]bool{}, orders: map[string]map[int64]bool{}, comments: map[string]bool{}}
}
func (l *reconcileLinks) addTrade(t domain.TradeSet) {
	if t.CorrelationComment != "" {
		l.comments[t.CorrelationComment] = true
	}
	if t.Mode != "paper" && t.Mode != "demo" && t.Mode != "live" || t.BrokerRefs == nil {
		return
	}
	if t.BrokerRefs.PositionTicket > 0 {
		if l.positions[t.Mode] == nil {
			l.positions[t.Mode] = map[int64]bool{}
		}
		l.positions[t.Mode][t.BrokerRefs.PositionTicket] = true
	}
	if t.BrokerRefs.OrderTicket > 0 {
		if l.orders[t.Mode] == nil {
			l.orders[t.Mode] = map[int64]bool{}
		}
		l.orders[t.Mode][t.BrokerRefs.OrderTicket] = true
	}
}

func (r *Runner) reportOrphans(ctx context.Context, view reconcileView, links *reconcileLinks, summary *reconcileSummary) {
	present := map[string]bool{}
	for _, p := range view.positions {
		if links.positions[view.mode][p.Ticket] || links.comments[p.Comment] {
			continue
		}
		subject := fmt.Sprintf("%s_position_%d", view.mode, p.Ticket)
		present[subject] = true
		r.raiseAlert(ctx, "unknown_position", subject, orphanSeverity(view.mode), fmt.Sprintf("Unknown position with the EA magic (%s)", view.mode), fmt.Sprintf("Position %d (%s, %g lots, comment %q) has no trade set. It is left untouched.", p.Ticket, p.Symbol, p.Volume, p.Comment), map[string]any{"mode": view.mode, "symbol": p.Symbol, "volume": p.Volume, "comment": p.Comment})
		key := view.mode + ":position:" + fmt.Sprint(p.Ticket)
		r.mu.Lock()
		seen := r.warned["orphan:"+key]
		r.warned["orphan:"+key] = true
		r.mu.Unlock()
		if !seen {
			summary.orphans++
			r.audit(ctx, "warn", "orphan_position", map[string]any{"mode": view.mode, "ticket": p.Ticket, "symbol": p.Symbol, "volume": p.Volume, "comment": p.Comment})
		}
	}
	for _, o := range view.orders {
		if links.orders[view.mode][o.Ticket] || links.comments[o.Comment] {
			continue
		}
		subject := fmt.Sprintf("%s_order_%d", view.mode, o.Ticket)
		present[subject] = true
		r.raiseAlert(ctx, "unknown_position", subject, orphanSeverity(view.mode), fmt.Sprintf("Unknown pending order with the EA magic (%s)", view.mode), fmt.Sprintf("Order %d (%s, %g lots, comment %q) has no trade set. It is left untouched.", o.Ticket, o.Symbol, o.VolumeInitial, o.Comment), map[string]any{"mode": view.mode, "symbol": o.Symbol, "volume": o.VolumeInitial, "comment": o.Comment})
		key := view.mode + ":order:" + fmt.Sprint(o.Ticket)
		r.mu.Lock()
		seen := r.warned["orphan:"+key]
		r.warned["orphan:"+key] = true
		r.mu.Unlock()
		if !seen {
			summary.orphans++
			r.audit(ctx, "warn", "orphan_order", map[string]any{"mode": view.mode, "ticket": o.Ticket, "symbol": o.Symbol, "volume": o.VolumeInitial, "comment": o.Comment})
		}
	}
	for subject := range r.orphanSubjects {
		if strings.HasPrefix(subject, view.mode+"_") && !present[subject] {
			r.resolveAlert(ctx, "unknown_position", subject, "no_longer_at_broker")
			delete(r.orphanSubjects, subject)
		}
	}
	for subject := range present {
		r.orphanSubjects[subject] = true
	}
}

func orphanSeverity(mode string) string {
	if mode == "paper" {
		return "info"
	}
	return "warning"
}
func matchingPositions(v reconcileView, comment string) []broker.Position {
	out := []broker.Position{}
	for _, p := range v.positions {
		if p.Magic == v.broker.Magic() && p.Comment == comment {
			out = append(out, p)
		}
	}
	return out
}
func matchingOrders(v reconcileView, comment string) []broker.Order {
	out := []broker.Order{}
	for _, o := range v.orders {
		if o.Magic == v.broker.Magic() && o.Comment == comment {
			out = append(out, o)
		}
	}
	return out
}
func matchingEntryDeals(deals []broker.Deal, comment string, magic int64) []broker.Deal {
	out := []broker.Deal{}
	for _, d := range deals {
		if d.Entry == "IN" && d.Comment == comment && d.Magic == magic {
			out = append(out, d)
		}
	}
	return out
}
func firstEntryForPosition(deals []broker.Deal, id int64) *broker.Deal {
	for i := range deals {
		if deals[i].PositionID == id && deals[i].Entry == "IN" {
			return &deals[i]
		}
	}
	return nil
}
func ticketsPosition(values []broker.Position) []int64 {
	out := make([]int64, len(values))
	for i, v := range values {
		out[i] = v.Ticket
	}
	return out
}
func ticketsOrder(values []broker.Order) []int64 {
	out := make([]int64, len(values))
	for i, v := range values {
		out[i] = v.Ticket
	}
	return out
}
func keysInt64[T any](values map[int64]T) []int64 {
	out := make([]int64, 0, len(values))
	for key := range values {
		out = append(out, key)
	}
	return out
}
func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func (r *Runner) raiseCorrelationMismatch(ctx context.Context, trade domain.TradeSet, details map[string]any) {
	details["trade_set_id"] = trade.TradeSetID
	details["mode"] = trade.Mode
	details["correlation_comment"] = trade.CorrelationComment
	r.raiseAlert(ctx, "correlation_mismatch", trade.TradeSetID, "critical", "Entry outcome unknown: correlation does not uniquely match", fmt.Sprintf("Trade set %s could not be uniquely matched by exact correlation comment %s. No broker ticket was linked automatically.", trade.TradeSetID, trade.CorrelationComment), details)
}

func correlationCandidates(view reconcileView, trade domain.TradeSet, links *reconcileLinks, deals []broker.Deal) []map[string]any {
	if trade.BrokerSymbol == nil {
		return nil
	}
	start := trade.CreatedAt
	if trade.Submission != nil && trade.Submission.SubmittedAt != "" {
		start = trade.Submission.SubmittedAt
	}
	from := int64(0)
	if at, err := time.Parse(time.RFC3339Nano, start); err == nil {
		from = at.Unix() - 10
	}
	expires := int64(0)
	if trade.Submission != nil {
		expires = trade.Submission.ExpiresAt
	}
	if expires == 0 {
		expires = from + 18
	}
	to := expires + 60
	side := broker.Buy
	if trade.Direction == domain.Sell {
		side = broker.Sell
	}
	out := []map[string]any{}
	for _, p := range view.positions {
		if p.Magic == view.broker.Magic() && p.Symbol == *trade.BrokerSymbol && p.Type == side && !links.positions[view.mode][p.Ticket] && !links.comments[p.Comment] && p.TimeOpen >= from && p.TimeOpen <= to {
			out = append(out, map[string]any{"kind": "position", "ticket": p.Ticket, "volume": p.Volume, "time": p.TimeOpen, "comment": p.Comment})
		}
	}
	for _, o := range view.orders {
		if o.Magic == view.broker.Magic() && o.Symbol == *trade.BrokerSymbol && ((trade.Direction == domain.Buy && strings.HasPrefix(string(o.Type), "BUY")) || (trade.Direction == domain.Sell && strings.HasPrefix(string(o.Type), "SELL"))) && !links.orders[view.mode][o.Ticket] && !links.comments[o.Comment] && o.TimeSetup >= from && o.TimeSetup <= to {
			out = append(out, map[string]any{"kind": "order", "ticket": o.Ticket, "volume": o.VolumeInitial, "time": o.TimeSetup, "comment": o.Comment})
		}
	}
	for _, d := range deals {
		if d.Entry == "IN" && d.Magic == view.broker.Magic() && d.Symbol == *trade.BrokerSymbol && d.Type == side && !links.positions[view.mode][d.PositionID] && !links.comments[d.Comment] && d.Time >= from && d.Time <= to {
			duplicate := false
			for _, c := range out {
				if c["kind"] == "position" && c["ticket"] == d.PositionID {
					duplicate = true
					break
				}
			}
			if !duplicate {
				out = append(out, map[string]any{"kind": "deal", "ticket": d.Ticket, "volume": d.Volume, "time": d.Time, "comment": d.Comment})
			}
		}
	}
	return out
}

func (r *Runner) recordReconcileFailure(ctx context.Context, scope string, err error) {
	key := "reconcile_fail:" + scope
	r.mu.Lock()
	var streak int
	if existing, ok := r.reconcileFailures[key]; ok {
		streak = existing + 1
	} else {
		streak = 1
	}
	r.reconcileFailures[key] = streak
	r.mu.Unlock()
	if streak >= 3 {
		r.raiseAlert(ctx, "reconciliation_failed", scope, "error", "Reconciliation is failing", fmt.Sprintf("%d consecutive passes failed: %v", streak, err), map[string]any{"scope": scope, "consecutive_failures": streak})
	}
}
func (r *Runner) recordReconcileSuccess(ctx context.Context, scope string) {
	key := "reconcile_fail:" + scope
	r.mu.Lock()
	streak := r.reconcileFailures[key]
	delete(r.reconcileFailures, key)
	r.mu.Unlock()
	if streak > 0 {
		r.resolveAlert(ctx, "reconciliation_failed", scope, "pass_succeeded")
	}
}

func (r *Runner) escalateUnknown(ctx context.Context, groups map[string][]domain.TradeSet) {
	for _, trades := range groups {
		for _, trade := range trades {
			if trade.State != domain.TradeSubmitUnknown {
				continue
			}
			expires := int64(0)
			if trade.Submission != nil {
				expires = trade.Submission.ExpiresAt
			}
			if expires == 0 {
				if at, err := time.Parse(time.RFC3339Nano, trade.CreatedAt); err == nil {
					expires = at.Unix() + 8
				}
			}
			if r.cfg.Now().Unix()-expires >= int64(unknownEscalateAfter.Seconds()) {
				r.raiseAlert(ctx, "submit_unknown", trade.TradeSetID, "critical", "Entry outcome still unknown", fmt.Sprintf("Trade set %s (%s) remains SUBMIT_UNKNOWN after request expiry. Inspect exact comment %s in MT5.", trade.TradeSetID, trade.Mode, trade.CorrelationComment), map[string]any{"trade_set_id": trade.TradeSetID, "mode": trade.Mode, "correlation_comment": trade.CorrelationComment})
			}
		}
	}
}
