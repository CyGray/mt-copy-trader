package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const (
	adminCommandMaxAge    = 5 * time.Minute
	adminCommandScanLimit = 10000
	closeAllConfirmation  = "CLOSE ALL"
	closeAllTradePage     = 5000
)

var closeAllTradeStates = []string{"CLAIMED", "SUBMITTING", "SUBMIT_UNKNOWN", "PENDING_ORDER", "OPEN", "PARTIALLY_CLOSED"}

type closeAllEntry struct {
	Mode    string `json:"mode"`
	Ticket  int64  `json:"ticket,omitempty"`
	Kind    string `json:"kind"`
	Sweep   int    `json:"sweep"`
	OK      bool   `json:"ok"`
	Retcode int    `json:"retcode,omitempty"`
	Error   string `json:"error,omitempty"`
}

type closeAllBroker struct {
	modes  []string
	broker broker.Broker
}

// ProcessAdminCommands recovers existing work before starting a new command and
// handles at most one close-all command per poll.
func (r *Runner) ProcessAdminCommands(ctx context.Context) error {
	if !r.adminMu.TryLock() {
		return nil
	}
	defer r.adminMu.Unlock()
	if r.db == nil {
		return errors.New("engine store unavailable")
	}
	terminalID, terminalUnresolved, err := r.firstTerminalAdminCommandWithUnsettledLedger(ctx)
	if err != nil {
		return err
	}
	if terminalUnresolved {
		return r.recoverTerminalAdminCommand(ctx, terminalID)
	}
	running, err := r.db.List(ctx, "admin_commands", store.ListOptions{Filters: []store.Filter{{Field: store.StatusField, Values: []string{"running"}}}, Limit: 1})
	if err != nil {
		return err
	}
	if len(running) > 0 {
		id, _ := running[0]["_id"].(string)
		if id == "" {
			return errors.New("running admin command has no document ID")
		}
		if running[0]["recovery_only"] == true {
			return r.recoverRunningAdminCommand(ctx, id)
		}
		return r.processAdminCommand(ctx, id, true)
	}
	pending, err := r.db.List(ctx, "admin_commands", store.ListOptions{Filters: []store.Filter{{Field: store.StatusField, Values: []string{"pending"}}}, Limit: 1})
	if err != nil || len(pending) == 0 {
		return err
	}
	id, _ := pending[0]["_id"].(string)
	if id == "" {
		return errors.New("pending admin command has no document ID")
	}
	return r.processAdminCommand(ctx, id, false)
}

func (r *Runner) processAdminCommand(ctx context.Context, id string, recovered bool) error {
	command, claimed, err := r.claimAdminCommand(ctx, id, recovered)
	if err != nil || !claimed {
		return err
	}
	if err := r.executeAdminCommand(ctx, id, command, recovered); err != nil {
		r.audit(ctx, "error", "admin_command_execution_failed", map[string]any{"command_id": id, "error": err.Error()})
		unsettled, checkErr := r.hasUnsettledCloseAll(ctx, id)
		if checkErr != nil {
			return errors.Join(err, checkErr)
		}
		if unsettled {
			_ = r.markAdminCommandAwaitingReconciliation(ctx, id, "execution_error_with_unresolved_mutation")
			return err
		}
		_ = r.finishAdminCommand(ctx, id, "failed", map[string]any{"reason": "unexpected_error", "error": err.Error()})
		return err
	}
	return nil
}

func (r *Runner) firstTerminalAdminCommandWithUnsettledLedger(ctx context.Context) (string, bool, error) {
	var after *store.Cursor
	seen := 0
	for {
		limit := min(closeAllTradePage, adminCommandScanLimit-seen+1)
		page, err := r.db.List(ctx, "admin_commands", store.ListOptions{After: after, TimeField: store.CreatedAt, Limit: limit})
		if err != nil {
			return "", false, err
		}
		if len(page) == 0 {
			return "", false, nil
		}
		for _, doc := range page {
			if seen >= adminCommandScanLimit {
				return "", false, fmt.Errorf("admin command safety scan exceeded %d records", adminCommandScanLimit)
			}
			seen++
			status := stringValue(doc["status"])
			if status == "pending" || status == "running" {
				continue
			}
			unsettled, err := adminMutationLedgerUnsettled(doc)
			if err != nil {
				return "", false, err
			}
			if unsettled {
				id := stringValue(doc["_id"])
				if id == "" {
					return "", false, errors.New("terminal admin command with unresolved ledger has no ID")
				}
				return id, true, nil
			}
		}
		if len(page) < limit {
			return "", false, nil
		}
		last := page[len(page)-1]
		id := stringValue(last["_id"])
		if id == "" {
			return "", false, errors.New("admin command page has no cursor ID")
		}
		after = &store.Cursor{Time: stringValue(last["created_at"]), ID: id, TimeField: store.CreatedAt}
	}
}

func (r *Runner) recoverTerminalAdminCommand(ctx context.Context, id string) error {
	marked := false
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", id)
		if err != nil {
			return err
		}
		status := stringValue(doc["status"])
		if status == "pending" || status == "running" {
			return nil
		}
		unsettled, err := adminMutationLedgerUnsettled(doc)
		if err != nil || !unsettled {
			return err
		}
		doc["recovery_original_status"], doc["recovery_original_result"] = status, doc["result"]
		doc["recovery_only"], doc["status"], doc["runner"] = true, "running", r.cfg.Owner
		doc["result"] = map[string]any{"awaiting_reconciliation": true, "reason": "terminal_command_has_unresolved_mutation"}
		doc["updated_at"] = store.ISO(r.cfg.Now())
		delete(doc, "finished_at")
		if err := tx.Put("admin_commands", id, doc); err != nil {
			return err
		}
		marked = true
		return nil
	})
	if err != nil || !marked {
		return err
	}
	return r.recoverRunningAdminCommand(ctx, id)
}

func (r *Runner) recoverRunningAdminCommand(ctx context.Context, id string) error {
	doc, err := r.db.Get(ctx, "admin_commands", id)
	if err != nil {
		return err
	}
	if doc["status"] != "running" || doc["recovery_only"] != true {
		return nil
	}
	if err := r.reconcileAdminCommandLedger(ctx, id, doc); err != nil {
		_ = r.markAdminCommandAwaitingReconciliation(ctx, id, "admin_ledger_read_failed")
		return err
	}
	doc, err = r.db.Get(ctx, "admin_commands", id)
	if err != nil {
		return err
	}
	unsettled, err := adminMutationLedgerUnsettled(doc)
	if err != nil {
		return err
	}
	if unsettled {
		return r.markAdminCommandAwaitingReconciliation(ctx, id, "admin_mutation_still_unresolved")
	}
	return r.finishTerminalAdminRecovery(ctx, id)
}

func (r *Runner) reconcileAdminCommandLedger(ctx context.Context, id string, command store.Document) error {
	ledger, ok := command["mutation_intents"].(map[string]any)
	if !ok || len(ledger) == 0 {
		return nil
	}
	modes := []string{}
	for _, raw := range ledger {
		data, err := json.Marshal(raw)
		if err != nil {
			return err
		}
		var state adminMutationState
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
		if state.Status == "done" || state.Status == "retryable" {
			continue
		}
		if state.Mode != "paper" && state.Mode != "demo" && state.Mode != "live" {
			return fmt.Errorf("admin mutation ledger has invalid mode %q", state.Mode)
		}
		if !containsString(modes, state.Mode) {
			modes = append(modes, state.Mode)
		}
	}
	for _, mode := range modes {
		br, err := r.brokerFor(ctx, mode)
		if err != nil {
			return err
		}
		orders, err := br.GetOrders(ctx, "")
		if err != nil {
			return err
		}
		positions, err := br.GetPositions(ctx, "")
		if err != nil {
			return err
		}
		if err := r.markMissingAdminTargets(ctx, id, br, []string{mode}, orders, positions, 0); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) finishTerminalAdminRecovery(ctx context.Context, id string) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", id)
		if err != nil {
			return err
		}
		unsettled, err := adminMutationLedgerUnsettled(doc)
		if err != nil {
			return err
		}
		if unsettled {
			return nil
		}
		status := stringValue(doc["recovery_original_status"])
		if status == "" || status == "pending" || status == "running" {
			return errors.New("terminal admin recovery has no original terminal status")
		}
		doc["status"], doc["updated_at"] = status, store.ISO(r.cfg.Now())
		originalResult := object(doc["recovery_original_result"])
		if originalResult != nil {
			originalResult = cloneDocument(originalResult)
			if originalResult["awaiting_reconciliation"] == true {
				delete(originalResult, "awaiting_reconciliation")
				delete(originalResult, "reason")
			}
		}
		doc["result"] = originalResult
		delete(doc, "recovery_only")
		delete(doc, "recovery_original_status")
		delete(doc, "recovery_original_result")
		if doc["finished_at"] == nil {
			doc["finished_at"] = store.ISO(r.cfg.Now())
		}
		return tx.Put("admin_commands", id, doc)
	})
}

func (r *Runner) claimAdminCommand(ctx context.Context, id string, recovered bool) (store.Document, bool, error) {
	var claimed store.Document
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		status := stringValue(doc["status"])
		if status != "pending" && !(recovered && status == "running") {
			return nil
		}
		doc["status"], doc["started_at"], doc["runner"] = "running", store.ISO(r.cfg.Now()), r.cfg.Owner
		if err := tx.Put("admin_commands", id, doc); err != nil {
			return err
		}
		claimed = doc
		return nil
	})
	return claimed, claimed != nil, err
}

func (r *Runner) executeAdminCommand(ctx context.Context, id string, command store.Document, recovered bool) error {
	if command["type"] != "close_all" {
		return r.finishAdminCommand(ctx, id, "rejected", map[string]any{"reason": "unknown_type", "type": fmt.Sprint(command["type"])})
	}
	if command["confirm"] != closeAllConfirmation {
		return r.finishAdminCommand(ctx, id, "rejected", map[string]any{"reason": "confirm_mismatch"})
	}
	requested, err := time.Parse(time.RFC3339Nano, stringValue(command["requested_at"]))
	if err != nil {
		return r.finishAdminCommand(ctx, id, "rejected", map[string]any{"reason": "invalid_requested_at"})
	}
	if !recovered && r.cfg.Now().Sub(requested) > adminCommandMaxAge {
		return r.finishAdminCommand(ctx, id, "rejected", map[string]any{"reason": "expired"})
	}
	if recovered {
		unsettled, err := r.hasUnsettledCloseAllTradeIntents(ctx)
		if err != nil {
			return err
		}
		if unsettled {
			return r.markAdminCommandAwaitingReconciliation(ctx, id, "linked_mutation_intent_unresolved")
		}
	}
	return r.closeAll(ctx, id)
}

func (r *Runner) closeAll(ctx context.Context, id string) error {
	if err := r.engageKillSwitch(ctx); err != nil {
		_ = r.finishAdminCommand(ctx, id, "failed", map[string]any{"reason": "kill_switch_not_engaged", "error": err.Error(), "kill_switch_engaged": false})
		r.raiseAlert(ctx, "close_all_failed", id, "critical", "Close-all refused: kill switch could not be engaged", fmt.Sprintf("Close-all %s did not start because the kill switch write failed. Nothing was closed.", id), map[string]any{"command_id": id})
		return err
	}
	r.audit(ctx, "warn", "close_all_started", map[string]any{"command_id": id})
	control, controlErr := r.control(ctx)
	if controlErr != nil {
		r.audit(ctx, "warn", "close_all_control_unavailable", map[string]any{"command_id": id, "error": controlErr.Error()})
	}
	results := []closeAllEntry{}
	trades, err := r.listCloseAllTrades(ctx, &results, 1)
	if err != nil {
		return r.finishAdminCommand(ctx, id, "failed", map[string]any{"reason": "trade_listing_failed", "error": err.Error(), "kill_switch_engaged": true})
	}
	modes := []string{"paper"}
	for _, mode := range []string{"demo", "live"} {
		needed := control.Mode == mode
		for _, trade := range trades {
			if trade.Mode == mode {
				needed = true
			}
		}
		if needed {
			modes = append(modes, mode)
		}
	}
	groups := r.closeAllBrokerGroups(ctx, modes, &results)
	for _, group := range groups {
		r.closeAllSweep(ctx, id, group, trades, 1, &results)
	}
	r.audit(ctx, "warn", "close_all_settling", map[string]any{"command_id": id, "settle_ms": r.cfg.CloseAllSettle.Milliseconds()})
	if r.cfg.CloseAllSettle > 0 {
		timer := time.NewTimer(r.cfg.CloseAllSettle)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
	later, listErr := r.listCloseAllTrades(ctx, &results, 2)
	if listErr != nil {
		r.audit(ctx, "warn", "close_all_second_trade_listing_failed", map[string]any{"command_id": id, "error": listErr.Error()})
	}
	r.markInFlightCloseAll(ctx, later, &results)
	for _, group := range groups {
		r.closeAllSweep(ctx, id, group, later, 2, &results)
	}
	failed := 0
	for _, result := range results {
		if !result.OK && (result.Sweep == 2 || result.Kind == "mark" || result.Kind == "read" && strings.HasPrefix(result.Error, "broker_unavailable:")) {
			failed++
		}
	}
	status := "done"
	if failed > 0 {
		status = "failed"
	}
	usedModes := []string{}
	for _, group := range groups {
		usedModes = append(usedModes, group.modes...)
	}
	result := map[string]any{"brokers": usedModes, "results": results, "sweeps": 2, "kill_switch_engaged": true}
	unsettled, unsettledErr := r.hasUnsettledCloseAll(ctx, id)
	if unsettledErr != nil {
		r.audit(ctx, "warn", "close_all_reconciliation_check_failed", map[string]any{"command_id": id, "error": unsettledErr.Error()})
		return r.markAdminCommandAwaitingReconciliation(ctx, id, "linked_mutation_check_failed")
	}
	if unsettled {
		result["awaiting_reconciliation"] = true
		if err := r.saveAdminCommandProgress(ctx, id, result); err != nil {
			return err
		}
		r.raiseAlert(ctx, "close_all_failed", id, "critical", "Close-all is waiting for broker reconciliation", fmt.Sprintf("Close-all %s has unresolved per-ticket mutations. The command remains running and no uncertain request is repeated.", id), map[string]any{"command_id": id})
		r.audit(ctx, "warn", "close_all_awaiting_reconciliation", map[string]any{"command_id": id})
		return nil
	}
	if err := r.finishAdminCommand(ctx, id, status, result); err != nil {
		return err
	}
	r.resolveAlert(ctx, "close_all_failed", id, "all_linked_mutations_reconciled")
	r.audit(ctx, "info", "close_all_finished", map[string]any{"command_id": id, "status": status, "failed_count": failed, "result_count": len(results)})
	if status == "failed" {
		r.raiseAlert(ctx, "close_all_failed", id, "critical", "Close-all left positions or orders open", fmt.Sprintf("Close-all %s finished with %d failure(s) after two sweeps. The kill switch remains engaged.", id, failed), map[string]any{"failed_count": failed, "brokers": usedModes})
	}
	return nil
}

func (r *Runner) engageKillSwitch(ctx context.Context) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		trading := object(settings["trading"])
		trading["kill_switch"] = true
		settings["trading"] = trading
		return tx.Put("settings", "default", settings)
	})
}

func (r *Runner) listCloseAllTrades(ctx context.Context, results *[]closeAllEntry, sweep int) ([]domain.TradeSet, error) {
	trades := []domain.TradeSet{}
	_, err := r.walkTradeSets(ctx, []store.Filter{{Field: store.StateField, Values: closeAllTradeStates}}, func(doc store.Document) (bool, error) {
		trade, err := decodeTrade(doc)
		if err != nil {
			return false, err
		}
		trades = append(trades, trade)
		return false, nil
	})
	if err != nil {
		*results = append(*results, closeAllEntry{Mode: "paper", Kind: "read", Sweep: sweep, Error: "trade_listing_failed: " + err.Error()})
		return nil, err
	}
	return trades, nil
}

func (r *Runner) closeAllBrokerGroups(ctx context.Context, modes []string, results *[]closeAllEntry) []closeAllBroker {
	groups := []closeAllBroker{}
	for _, mode := range modes {
		br, err := r.brokerFor(ctx, mode)
		if err != nil {
			*results = append(*results, closeAllEntry{Mode: mode, Kind: "read", Sweep: 1, Error: "broker_unavailable: " + err.Error()})
			continue
		}
		key := string(br.Kind()) + ":" + strconv.FormatInt(br.Magic(), 10)
		found := -1
		for i, group := range groups {
			other := string(group.broker.Kind()) + ":" + strconv.FormatInt(group.broker.Magic(), 10)
			if key == other {
				found = i
				break
			}
		}
		if found >= 0 {
			groups[found].modes = append(groups[found].modes, mode)
		} else {
			groups = append(groups, closeAllBroker{modes: []string{mode}, broker: br})
		}
	}
	return groups
}

func (r *Runner) closeAllSweep(ctx context.Context, commandID string, group closeAllBroker, trades []domain.TradeSet, sweep int, results *[]closeAllEntry) {
	mode := group.modes[0]
	orders, err := group.broker.GetOrders(ctx, "")
	if err != nil {
		*results = append(*results, closeAllEntry{Mode: mode, Kind: "read", Sweep: sweep, Error: err.Error()})
		return
	}
	positions, err := group.broker.GetPositions(ctx, "")
	if err != nil {
		*results = append(*results, closeAllEntry{Mode: mode, Kind: "read", Sweep: sweep, Error: err.Error()})
		return
	}
	ping, pingErr := group.broker.Ping(ctx)
	if pingErr != nil {
		ping.GMTTime = 0
	}
	if err := r.markMissingAdminTargets(ctx, commandID, group.broker, group.modes, orders, positions, sweep); err != nil {
		*results = append(*results, closeAllEntry{Mode: mode, Kind: "mark", Sweep: sweep, Error: err.Error()})
	}
	for _, order := range orders {
		if order.Magic != group.broker.Magic() {
			continue
		}
		trade := tradeForAdminTarget(trades, group.modes, order.Ticket, true)
		targetMode := mode
		if trade != nil {
			targetMode = trade.Mode
		}
		key := adminMutationKey(targetMode, "order", order.Ticket)
		state, err := r.adminMutationState(ctx, commandID, key)
		if err != nil {
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: order.Ticket, Kind: "order", Sweep: sweep, Error: err.Error()})
			continue
		}
		if !r.adminTargetCanSend(state, order.PriceOpen, order.SL, order.TP, order.VolumeCurrent, ping.GMTTime) {
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: order.Ticket, Kind: "order", Sweep: sweep, Error: "ambiguous_previous_cancel"})
			continue
		}
		intent := newMutationIntent(r, "CANCEL_ORDER", order.Ticket)
		intent.PriorPrice, intent.PriorSL, intent.PriorTP, intent.PriorVolume = order.PriceOpen, order.SL, order.TP, order.VolumeCurrent
		intent.Reason = "close_all"
		intent.SuccessPatch = map[string]any{"state": string(domain.TradeCancelled), "close_request_status": "done"}
		if trade != nil {
			if err := r.persistCloseAllTradeIntent(ctx, *trade, intent); err != nil {
				*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: order.Ticket, Kind: "mark", Sweep: sweep, Error: "trade_intent_failed: " + err.Error()})
				continue
			}
		}
		if err := r.saveAdminMutationState(ctx, commandID, key, adminMutationState{Mode: targetMode, Kind: "order", Ticket: order.Ticket, Sweep: sweep, Status: "ambiguous", At: store.ISO(r.cfg.Now()), ExpiresAt: intent.ExpiresAt, PriorPrice: order.PriceOpen, PriorSL: order.SL, PriorTP: order.TP, PriorVolume: order.VolumeCurrent}); err != nil {
			if trade != nil {
				_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			}
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: order.Ticket, Kind: "mark", Sweep: sweep, Error: "intent_write_failed: " + err.Error()})
			continue
		}
		retcode, err := group.broker.CancelOrder(ctx, order.Ticket)
		entry := closeAllEntry{Mode: targetMode, Ticket: order.Ticket, Kind: "order", Sweep: sweep, OK: err == nil, Retcode: retcode}
		if err != nil {
			entry.Error, entry.Retcode = closeAllError(err)
			status := "ambiguous"
			var unavailable *broker.UnavailableError
			var rejected *broker.RejectedError
			var ambiguous *broker.AmbiguousError
			if errors.As(err, &unavailable) || errors.As(err, &rejected) {
				status = "retryable"
				if trade != nil {
					_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
				}
			} else if errors.As(err, &ambiguous) && trade != nil {
				r.markMutationUnresolved(*trade)
			}
			_ = r.setAdminMutationStatus(ctx, commandID, key, status)
			if status == "ambiguous" {
				r.raiseAlert(ctx, "mutation_unknown", adminMutationAlertSubject(commandID, key), "error", "Close-all broker mutation needs reconciliation", fmt.Sprintf("Close-all %s has an unresolved cancellation for order ticket %d. No repeat was sent.", commandID, order.Ticket), map[string]any{"command_id": commandID, "ticket": order.Ticket, "action": "CANCEL_ORDER"})
			}
		} else {
			_ = r.setAdminMutationStatus(ctx, commandID, key, "done")
			if trade != nil {
				if err := r.completeMutationIntent(ctx, trade.TradeSetID, store.Document{"state": string(domain.TradeCancelled), "close_request_status": "done"}); err != nil {
					entry.OK, entry.Error = false, "trade_state_not_recorded: "+err.Error()
					r.markMutationUnresolved(*trade)
				}
			}
		}
		*results = append(*results, entry)
	}
	for _, position := range positions {
		if position.Magic != group.broker.Magic() {
			continue
		}
		trade := tradeForAdminTarget(trades, group.modes, position.Ticket, false)
		targetMode := mode
		if trade != nil {
			targetMode = trade.Mode
		}
		key := adminMutationKey(targetMode, "position", position.Ticket)
		state, err := r.adminMutationState(ctx, commandID, key)
		if err != nil {
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: position.Ticket, Kind: "position", Sweep: sweep, Error: err.Error()})
			continue
		}
		if !r.adminTargetCanSend(state, 0, position.SL, position.TP, position.Volume, ping.GMTTime) {
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: position.Ticket, Kind: "position", Sweep: sweep, Error: "ambiguous_previous_close"})
			continue
		}
		intent := newMutationIntent(r, "CLOSE_POSITION", position.Ticket)
		intent.PriorSL, intent.PriorTP, intent.PriorVolume = position.SL, position.TP, position.Volume
		intent.TargetRemainingVolume, intent.Reason = 0, "close_all"
		intent.SuccessPatch = map[string]any{"close_request_status": "done"}
		if trade != nil {
			if err := r.persistCloseAllTradeIntent(ctx, *trade, intent); err != nil {
				*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: position.Ticket, Kind: "mark", Sweep: sweep, Error: "trade_intent_failed: " + err.Error()})
				continue
			}
		}
		if err := r.saveAdminMutationState(ctx, commandID, key, adminMutationState{Mode: targetMode, Kind: "position", Ticket: position.Ticket, PositionIdentifier: position.Identifier, Sweep: sweep, Status: "ambiguous", At: store.ISO(r.cfg.Now()), ExpiresAt: intent.ExpiresAt, PriorSL: position.SL, PriorTP: position.TP, PriorVolume: position.Volume}); err != nil {
			if trade != nil {
				_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
			}
			*results = append(*results, closeAllEntry{Mode: targetMode, Ticket: position.Ticket, Kind: "mark", Sweep: sweep, Error: "intent_write_failed: " + err.Error()})
			continue
		}
		var result broker.CloseResult
		var updated domain.TradeSet
		complete := false
		if trade != nil {
			trade.MutationIntent = &intent
			result, updated, complete, err = r.attemptPositionClose(ctx, group.broker, *trade, intent, position, nil)
		} else {
			volume := position.Volume
			result, err = group.broker.ClosePosition(ctx, position.Ticket, &volume)
		}
		entry := closeAllEntry{Mode: targetMode, Ticket: position.Ticket, Kind: "position", Sweep: sweep, OK: err == nil}
		if err != nil {
			entry.Error, entry.Retcode = closeAllError(err)
			status := "ambiguous"
			var unavailable *broker.UnavailableError
			var rejected *broker.RejectedError
			var ambiguous *broker.AmbiguousError
			if errors.As(err, &unavailable) || errors.As(err, &rejected) {
				status = "retryable"
				if trade != nil {
					_ = r.clearUnsentMutation(ctx, trade.TradeSetID)
				}
			} else if errors.As(err, &ambiguous) && trade != nil {
				r.markMutationUnresolved(*trade)
			}
			_ = r.setAdminMutationStatus(ctx, commandID, key, status)
			if status == "ambiguous" {
				r.raiseAlert(ctx, "mutation_unknown", adminMutationAlertSubject(commandID, key), "error", "Close-all broker mutation needs reconciliation", fmt.Sprintf("Close-all %s has an unresolved close for position ticket %d. No repeat was sent.", commandID, position.Ticket), map[string]any{"command_id": commandID, "ticket": position.Ticket, "action": "CLOSE_POSITION"})
			}
		} else {
			entry.Retcode = result.Retcode
			freshPositions, readErr := group.broker.GetPositions(ctx, position.Symbol)
			if readErr != nil {
				entry.OK, entry.Error = false, "close_waiting_for_position_readback: "+readErr.Error()
				if trade != nil {
					r.markMutationUnresolved(*trade)
				}
				*results = append(*results, entry)
				continue
			}
			remaining := findPosition(freshPositions, position.Ticket, group.broker.Magic())
			if remaining != nil {
				if result.Retcode == 10010 && remaining.Volume < position.Volume-1e-9 {
					state := adminMutationState{Mode: targetMode, Kind: "position", Ticket: position.Ticket, PositionIdentifier: position.Identifier, Sweep: sweep, Status: "partial", At: store.ISO(r.cfg.Now()), ExpiresAt: intent.ExpiresAt, PriorSL: remaining.SL, PriorTP: remaining.TP, PriorVolume: remaining.Volume}
					if err := r.saveAdminMutationState(ctx, commandID, key, state); err != nil {
						entry.OK, entry.Error = false, "partial_close_ledger_failed: "+err.Error()
					} else {
						entry.OK, entry.Error = false, "partial_close_waiting_for_remaining_volume"
					}
					if trade != nil {
						trade = &updated
					}
					*results = append(*results, entry)
					continue
				}
				entry.OK, entry.Error = false, "close_response_left_position_open"
				if trade != nil {
					r.markMutationUnresolved(*trade)
				}
				*results = append(*results, entry)
				continue
			}
			if trade != nil {
				if !complete {
					entry.OK, entry.Error = false, "close_waiting_for_trade_reconciliation"
					*results = append(*results, entry)
					continue
				}
				trade = &updated
				if err := r.completeAdminClose(ctx, group.broker, *trade, position); err != nil {
					entry.OK, entry.Error = false, "close_waiting_for_trade_reconciliation: "+err.Error()
					r.markMutationUnresolved(*trade)
					*results = append(*results, entry)
					continue
				}
			} else {
				positionID := position.Identifier
				if positionID <= 0 {
					positionID = position.Ticket
				}
				deals, dealErr := group.broker.GetDeals(ctx, broker.DealQuery{FromSec: position.TimeOpen - 60, PositionID: &positionID})
				if dealErr != nil || domain.LastExitDeal(deals) == nil {
					entry.OK, entry.Error = false, "orphan_close_waiting_for_exact_exit_deal"
					if dealErr != nil {
						entry.Error += ": " + dealErr.Error()
					}
					*results = append(*results, entry)
					continue
				}
			}
			_ = r.setAdminMutationStatus(ctx, commandID, key, "done")
		}
		*results = append(*results, entry)
	}
}

func (r *Runner) completeAdminClose(ctx context.Context, br broker.Broker, trade domain.TradeSet, target broker.Position) error {
	positions, err := br.GetPositions(ctx, target.Symbol)
	if err != nil {
		return err
	}
	if findPosition(positions, target.Ticket, br.Magic()) != nil {
		return errors.New("position remains visible after close response")
	}
	positionID := target.Identifier
	if positionID <= 0 {
		positionID = target.Ticket
	}
	deals, err := br.GetDeals(ctx, broker.DealQuery{FromSec: r.lookbackFrom(trade), PositionID: &positionID})
	if err != nil {
		return err
	}
	if domain.LastExitDeal(deals) == nil {
		return errors.New("exact exit deal is not visible after close response")
	}
	lifecycle := domain.CloneTradeSet(trade).Lifecycle
	if lifecycle != nil {
		lifecycle.CurrentVolume = 0
	}
	result := domain.TradeResult{ClosedAt: store.ISO(r.cfg.Now()), CloseReason: "close_all", RealizedPnL: domain.RealizedPnLFromDeals(deals)}
	patch := store.Document{"state": string(domain.TradeClosed), "lifecycle": lifecycle, "result": result, "close_request_status": "done"}
	return r.completeMutationIntent(ctx, trade.TradeSetID, patch)
}

type adminMutationState struct {
	Mode               string  `json:"mode"`
	Kind               string  `json:"kind"`
	Ticket             int64   `json:"ticket"`
	PositionIdentifier int64   `json:"position_identifier,omitempty"`
	Sweep              int     `json:"sweep"`
	Status             string  `json:"status"`
	At                 string  `json:"at"`
	ExpiresAt          int64   `json:"expires_at"`
	PriorPrice         float64 `json:"prior_price,omitempty"`
	PriorSL            float64 `json:"prior_sl,omitempty"`
	PriorTP            float64 `json:"prior_tp,omitempty"`
	PriorVolume        float64 `json:"prior_volume,omitempty"`
}

func adminMutationKey(mode, kind string, ticket int64) string {
	return fmt.Sprintf("%s:%s:%d", mode, kind, ticket)
}

func adminMutationAlertSubject(commandID, key string) string { return "admin:" + commandID + ":" + key }

func (r *Runner) adminMutationState(ctx context.Context, commandID, key string) (*adminMutationState, error) {
	doc, err := r.db.Get(ctx, "admin_commands", commandID)
	if err != nil {
		return nil, err
	}
	ledger := object(doc["mutation_intents"])
	raw, ok := ledger[key]
	if !ok {
		return nil, nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var state adminMutationState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (r *Runner) saveAdminMutationState(ctx context.Context, commandID, key string, state adminMutationState) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", commandID)
		if err != nil {
			return err
		}
		ledger := object(doc["mutation_intents"])
		ledger[key] = state
		doc["mutation_intents"] = ledger
		doc["updated_at"] = store.ISO(r.cfg.Now())
		return tx.Put("admin_commands", commandID, doc)
	})
}

func (r *Runner) setAdminMutationStatus(ctx context.Context, commandID, key, status string) error {
	state, err := r.adminMutationState(ctx, commandID, key)
	if err != nil {
		return err
	}
	if state == nil {
		return errors.New("admin mutation intent not found")
	}
	state.Status = status
	if err := r.saveAdminMutationState(ctx, commandID, key, *state); err != nil {
		return err
	}
	if status != "ambiguous" {
		r.resolveAlert(ctx, "mutation_unknown", adminMutationAlertSubject(commandID, key), "admin_mutation_"+status)
	}
	return nil
}

func (r *Runner) adminTargetCanSend(state *adminMutationState, price, sl, tp, volume float64, gmtTime int64) bool {
	if state == nil {
		return true
	}
	switch state.Status {
	case "done":
		return false
	case "retryable":
		return true
	case "partial":
		return math.Abs(price-state.PriorPrice) <= 1e-6 && math.Abs(sl-state.PriorSL) <= 1e-6 && math.Abs(tp-state.PriorTP) <= 1e-6 && math.Abs(volume-state.PriorVolume) <= 1e-6
	case "ambiguous":
		return false
	default:
		return false
	}
}

func (r *Runner) markMissingAdminTargets(ctx context.Context, commandID string, br broker.Broker, modes []string, orders []broker.Order, positions []broker.Position, sweep int) error {
	doc, err := r.db.Get(ctx, "admin_commands", commandID)
	if err != nil {
		return err
	}
	ledger := object(doc["mutation_intents"])
	for key, raw := range ledger {
		data, err := json.Marshal(raw)
		if err != nil {
			return err
		}
		var state adminMutationState
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
		if !containsString(modes, state.Mode) || state.Status != "ambiguous" && state.Status != "partial" {
			continue
		}
		present := false
		if state.Kind == "order" {
			for _, order := range orders {
				present = present || order.Magic == br.Magic() && order.Ticket == state.Ticket
			}
		} else if state.Kind == "position" {
			for _, position := range positions {
				present = present || position.Magic == br.Magic() && (position.Ticket == state.Ticket || state.PositionIdentifier > 0 && position.Identifier == state.PositionIdentifier)
			}
		}
		if !present {
			if state.Kind == "position" {
				positionID := state.PositionIdentifier
				if positionID <= 0 {
					positionID = state.Ticket
				}
				deals, err := br.GetDeals(ctx, broker.DealQuery{FromSec: 0, PositionID: &positionID})
				if err != nil {
					return err
				}
				if !completeAdminExitEvidence(deals, positionID, br.Magic(), state.PriorVolume) {
					continue
				}
			}
			state.Status, state.Sweep = "done", sweep
			if err := r.saveAdminMutationState(ctx, commandID, key, state); err != nil {
				return err
			}
			r.resolveAlert(ctx, "mutation_unknown", adminMutationAlertSubject(commandID, key), "admin_target_absent_after_reconciliation")
		}
	}
	return nil
}

func completeAdminExitEvidence(deals []broker.Deal, positionID, magic int64, priorVolume float64) bool {
	if positionID <= 0 || priorVolume <= 0 {
		return false
	}
	entryVolume, exitVolume := 0.0, 0.0
	for _, deal := range deals {
		if deal.PositionID != positionID || deal.Magic != magic {
			continue
		}
		switch deal.Entry {
		case "IN":
			entryVolume += deal.Volume
		case "OUT", "OUT_BY":
			exitVolume += deal.Volume
		case "INOUT":
			return false
		}
	}
	return entryVolume+1e-8 >= priorVolume && exitVolume+1e-8 >= entryVolume
}

func adminMutationLedgerUnsettled(doc store.Document) (bool, error) {
	raw, exists := doc["mutation_intents"]
	if !exists || raw == nil {
		return false, nil
	}
	ledger, ok := raw.(map[string]any)
	if !ok {
		return false, errors.New("admin mutation ledger is malformed")
	}
	for _, rawState := range ledger {
		data, err := json.Marshal(rawState)
		if err != nil {
			return false, err
		}
		var state adminMutationState
		if err := json.Unmarshal(data, &state); err != nil {
			return false, err
		}
		switch state.Status {
		case "done", "retryable":
			continue
		default:
			return true, nil
		}
	}
	return false, nil
}

func (r *Runner) persistCloseAllTradeIntent(ctx context.Context, previous domain.TradeSet, intent domain.MutationIntent) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", previous.TradeSetID)
		if err != nil {
			return err
		}
		trade, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if trade.Schema != 2 || trade.MutationIntent != nil || trade.RevisionIntent != nil || trade.State != previous.State {
			return errors.New("trade set changed before close-all intent")
		}
		trade.CloseRequestedBy, trade.CloseRequestStatus = "close_all", "ambiguous"
		trade.MutationIntent = &intent
		trade.UpdatedAt = store.ISO(r.cfg.Now())
		updated, err := jsonDocument(trade)
		if err != nil {
			return err
		}
		return tx.Put("trade_sets", trade.TradeSetID, updated)
	})
}

func (r *Runner) hasUnsettledCloseAll(ctx context.Context, commandID string) (bool, error) {
	command, err := r.db.Get(ctx, "admin_commands", commandID)
	if err != nil {
		return false, err
	}
	unsettled, err := adminMutationLedgerUnsettled(command)
	if err != nil || unsettled {
		return unsettled, err
	}
	return r.hasUnsettledCloseAllTradeIntents(ctx)
}

func (r *Runner) hasUnsettledCloseAllTradeIntents(ctx context.Context) (bool, error) {
	return r.walkTradeSets(ctx, nil, func(doc store.Document) (bool, error) {
		trade, err := decodeTrade(doc)
		if err != nil {
			return false, err
		}
		active := trade.State == domain.TradeClaimed || trade.State == domain.TradeSubmitting || trade.State == domain.TradeSubmitUnknown || trade.State == domain.TradePendingOrder || trade.State == domain.TradeOpen || trade.State == domain.TradePartiallyClosed
		linked := active || trade.CloseRequestedBy == "close_all"
		if linked && (trade.MutationIntent != nil || trade.RevisionIntent != nil || trade.CloseRequestStatus == "ambiguous" || trade.CancelRequested != nil && trade.CancelRequested.MutationStatus == "ambiguous") {
			return true, nil
		}
		return false, nil
	})
}

func (r *Runner) walkTradeSets(ctx context.Context, filters []store.Filter, visit func(store.Document) (bool, error)) (bool, error) {
	schema := 2
	var after *store.Cursor
	for {
		page, err := r.db.List(ctx, "trade_sets", store.ListOptions{Filters: filters, Schema: &schema, TimeField: store.CreatedAt, After: after, Limit: closeAllTradePage})
		if err != nil {
			return false, err
		}
		for _, doc := range page {
			stop, err := visit(doc)
			if err != nil || stop {
				return stop, err
			}
		}
		if len(page) < closeAllTradePage {
			return false, nil
		}
		last := page[len(page)-1]
		id, _ := last["_id"].(string)
		createdAt, _ := last["created_at"].(string)
		if id == "" {
			return false, errors.New("trade list page has no cursor id")
		}
		after = &store.Cursor{Time: createdAt, ID: id, TimeField: store.CreatedAt}
	}
}

func (r *Runner) markAdminCommandAwaitingReconciliation(ctx context.Context, id, reason string) error {
	command, err := r.db.Get(ctx, "admin_commands", id)
	if err != nil {
		return err
	}
	result := object(command["result"])
	if result == nil {
		result = map[string]any{}
	}
	result["awaiting_reconciliation"], result["reason"] = true, reason
	return r.saveAdminCommandProgress(ctx, id, result)
}

func (r *Runner) saveAdminCommandProgress(ctx context.Context, id string, result map[string]any) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", id)
		if err != nil {
			return err
		}
		doc["status"], doc["result"], doc["updated_at"] = "running", result, store.ISO(r.cfg.Now())
		delete(doc, "finished_at")
		return tx.Put("admin_commands", id, doc)
	})
}

func tradeForAdminTarget(trades []domain.TradeSet, modes []string, ticket int64, order bool) *domain.TradeSet {
	for i := range trades {
		trade := &trades[i]
		if trade.BrokerRefs == nil || !containsString(modes, trade.Mode) {
			continue
		}
		if order && trade.BrokerRefs.OrderTicket == ticket || !order && trade.BrokerRefs.PositionTicket == ticket {
			return trade
		}
	}
	return nil
}

func (r *Runner) markInFlightCloseAll(ctx context.Context, trades []domain.TradeSet, results *[]closeAllEntry) {
	for _, trade := range trades {
		if trade.State != domain.TradeSubmitting && trade.State != domain.TradeSubmitUnknown {
			continue
		}
		if trade.Mode != "paper" && trade.Mode != "demo" && trade.Mode != "live" {
			continue
		}
		if err := r.updateTrade(ctx, trade.TradeSetID, store.Document{"close_requested_by": "close_all", "close_request_status": "pending"}); err != nil {
			*results = append(*results, closeAllEntry{Mode: trade.Mode, Kind: "mark", Sweep: 2, Error: fmt.Sprintf("mark_failed:%s: %v", trade.TradeSetID, err)})
		}
	}
}

func (r *Runner) updateTrade(ctx context.Context, id string, patch store.Document) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", id)
		if err != nil {
			return err
		}
		for key, value := range patch {
			doc[key] = value
		}
		doc["updated_at"] = store.ISO(r.cfg.Now())
		return tx.Put("trade_sets", id, doc)
	})
}

func (r *Runner) finishAdminCommand(ctx context.Context, id, status string, result map[string]any) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("admin_commands", id)
		if err != nil {
			return err
		}
		if status != "pending" && status != "running" {
			unsettled, err := adminMutationLedgerUnsettled(doc)
			if err != nil {
				return err
			}
			if unsettled {
				if result == nil {
					result = map[string]any{}
				}
				result["awaiting_reconciliation"], result["reason"] = true, "unresolved_admin_mutation_ledger"
				doc["status"], doc["result"], doc["updated_at"] = "running", result, store.ISO(r.cfg.Now())
				delete(doc, "finished_at")
				return tx.Put("admin_commands", id, doc)
			}
		}
		doc["status"], doc["finished_at"], doc["result"] = status, store.ISO(r.cfg.Now()), result
		return tx.Put("admin_commands", id, doc)
	})
}

func closeAllError(err error) (string, int) {
	var ambiguous *broker.AmbiguousError
	if errors.As(err, &ambiguous) {
		return "ambiguous", 0
	}
	var rejected *broker.RejectedError
	if errors.As(err, &rejected) {
		return rejected.Error(), rejected.Retcode
	}
	return err.Error(), 0
}

func containsInt64(values []int64, target int64) bool {
	if target <= 0 {
		return false
	}
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
