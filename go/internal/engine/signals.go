package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	claimStaleAfter  = time.Minute
	maxClaimAttempts = 3
	priceEpsilon     = 1e-9
)

var openRiskStates = []string{"OPEN", "PARTIALLY_CLOSED", "PENDING_ORDER", "SUBMITTING", "SUBMIT_UNKNOWN"}
var inflightStates = map[domain.TradeState]bool{domain.TradeSubmitting: true, domain.TradeSubmitUnknown: true}

type prepared struct {
	mode         string
	broker       broker.Broker
	profile      domain.ExecutionProfile
	profileDocID string
	limits       domain.EffectiveLimits
	brokerSymbol string
	spec         broker.SymbolInfo
	direction    domain.Direction
	decision     domain.EntryDecision
	sizing       domain.SizingResult
	checkpoints  []domain.PlannedCheckpoint
	brokerTP     float64
	sl           float64
	request      broker.PlaceOrderRequest
	warnings     []string
}

type skipSignal struct{ reason, detail string }

func (e *Runner) HandleEvent(ctx context.Context, event domain.SignalEvent) domain.HandleResult {
	if event.ChatID == "" || event.MessageID == "" {
		return domain.HandleResult{Outcome: "noop", Reason: "missing_ids"}
	}
	sources, err := e.sourceChatIDs(ctx)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "source_config_unavailable"}
	}
	if !containsString(sources, event.ChatID) {
		return domain.HandleResult{Outcome: "noop", Reason: "chat_not_configured"}
	}
	if event.Kind == "cancel" {
		return e.handleCancel(ctx, event)
	}
	if event.Kind != "signal" {
		return domain.HandleResult{Outcome: "noop", Reason: "unknown_kind"}
	}
	if event.Signal == nil {
		return domain.HandleResult{Outcome: "noop", Reason: "missing_signal"}
	}
	control, err := e.control(ctx)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "control_unavailable"}
	}
	control = control.ForChat(event.ChatID)
	tradeID := domain.TradeSetID(event.ChatID, event.MessageID)
	corr := correlationComment(tradeID)
	nowISO := store.ISO(e.cfg.Now())
	initial := domain.TradeSet{
		Schema: 2, TradeSetID: tradeID, ChatID: event.ChatID, MessageID: event.MessageID, EventID: event.EventID,
		Signal: *event.Signal, SignalRevisions: []domain.SignalRevision{}, Symbol: event.Signal.Symbol,
		Direction: event.Signal.Direction, Mode: control.Mode, State: domain.TradeClaimed,
		CorrelationComment: corr, Claim: domain.TradeClaim{Attempts: 1, ClaimedAt: nowISO, Owner: e.cfg.Owner},
		CreatedAt: nowISO, UpdatedAt: nowISO,
	}
	createdDoc, err := jsonDocument(initial)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "claim_encode_failed"}
	}
	created, err := e.db.CreateTradeSet(ctx, tradeID, createdDoc)
	if err != nil {
		e.audit(ctx, "error", "trade_claim_failed", map[string]any{"trade_set_id": tradeID, "error": err.Error()})
		return domain.HandleResult{Outcome: "retry", Reason: "claim_failed"}
	}
	if !created {
		existing, err := e.getTrade(ctx, tradeID)
		if err != nil {
			return domain.HandleResult{Outcome: "retry", Reason: "claim_read_failed"}
		}
		if existing.EventID != event.EventID {
			return e.handleRevision(ctx, event, existing)
		}
		if existing.State != domain.TradeClaimed {
			return domain.HandleResult{Outcome: "noop", State: existing.State, Reason: "already_processed"}
		}
		claimedAt, err := time.Parse(time.RFC3339Nano, existing.Claim.ClaimedAt)
		if err != nil || e.cfg.Now().Sub(claimedAt) <= claimStaleAfter {
			return domain.HandleResult{Outcome: "retry", State: domain.TradeClaimed, Reason: "claim_in_progress"}
		}
		if existing.Claim.Attempts >= maxClaimAttempts {
			return domain.HandleResult{Outcome: "noop", State: domain.TradeClaimed, Reason: "claim_attempts_exhausted"}
		}
		reclaimed, err := e.reclaim(ctx, existing, control.Mode)
		if err != nil {
			return domain.HandleResult{Outcome: "retry", Reason: "reclaim_failed"}
		}
		if !reclaimed {
			return domain.HandleResult{Outcome: "retry", Reason: "reclaim_lost_race"}
		}
	}
	e.tradeEvent(ctx, tradeID, control.Mode, "signal_received", "signal_received", map[string]any{"event_id": event.EventID, "message_type": event.MessageType})
	p, refused, err := e.prepare(ctx, event, control, tradeID, corr)
	if refused != nil {
		return e.recordSkip(ctx, tradeID, control.Mode, *refused, event)
	}
	if err != nil {
		e.audit(ctx, "warn", "signal_gate_retry", map[string]any{"trade_set_id": tradeID, "error": err.Error()})
		return domain.HandleResult{Outcome: "retry", Reason: "gate_error"}
	}
	e.tradeEvent(ctx, tradeID, p.mode, "signal_validated", "signal_validated", map[string]any{
		"profile_doc_id": p.profileDocID, "profile_version": p.profile.Version, "volume": p.sizing.Volume,
		"sl": p.sl, "tp": p.brokerTP, "details": map[string]any{"order_type": p.decision.OrderType,
			"entry_ref_price": p.decision.EntryRefPrice, "risk_money": p.sizing.RiskMoney, "warnings": p.warnings},
	})
	fresh, err := e.control(ctx)
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "control_recheck_failed"}
	}
	fresh = fresh.ForChat(event.ChatID)
	if reason, detail := recheckControl(p, fresh); reason != "" {
		return e.recordSkip(ctx, tradeID, p.mode, skipSignal{reason, detail}, event)
	}
	return e.persistAndSend(ctx, tradeID, corr, p)
}

func (e *Runner) sourceChatIDs(ctx context.Context) ([]string, error) {
	if e.db == nil {
		return nil, errors.New("engine store unavailable")
	}
	settings, err := e.db.Get(ctx, "settings", "default")
	if errors.Is(err, store.ErrNotFound) {
		return []string{"-1003271337051"}, nil
	}
	if err != nil {
		return nil, err
	}
	return normalizeSourceChatIDs(settings), nil
}

func (e *Runner) control(ctx context.Context) (Control, error) {
	if e.cfg.Controls == nil {
		return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "control_provider_missing"}, nil
	}
	return e.cfg.Controls(ctx)
}

func (e *Runner) reclaim(ctx context.Context, previous domain.TradeSet, mode string) (bool, error) {
	changed := false
	err := e.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", previous.TradeSetID)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		current, err := decodeTrade(doc)
		if err != nil {
			return err
		}
		if current.Schema != 2 || current.State != domain.TradeClaimed || current.EventID != previous.EventID || current.Claim.ClaimedAt != previous.Claim.ClaimedAt || current.Claim.Attempts >= maxClaimAttempts {
			return nil
		}
		at, err := time.Parse(time.RFC3339Nano, current.Claim.ClaimedAt)
		if err != nil || e.cfg.Now().Sub(at) <= claimStaleAfter {
			return nil
		}
		current.Claim = domain.TradeClaim{Attempts: current.Claim.Attempts + 1, ClaimedAt: store.ISO(e.cfg.Now()), Owner: e.cfg.Owner}
		current.Mode, current.UpdatedAt = mode, store.ISO(e.cfg.Now())
		updated, err := jsonDocument(current)
		if err != nil {
			return err
		}
		if err := tx.Put("trade_sets", previous.TradeSetID, updated); err != nil {
			return err
		}
		changed = true
		return nil
	})
	return changed, err
}

func (e *Runner) prepare(ctx context.Context, event domain.SignalEvent, control Control, tradeID, corr string) (*prepared, *skipSignal, error) {
	refuse := func(reason, detail string) (*prepared, *skipSignal, error) {
		return nil, &skipSignal{reason, detail}, nil
	}
	allowed, reason := control.CanOpenNewEntries()
	if !allowed {
		return refuse(reason, "execution control refused entries: "+reason)
	}
	if control.Mode == "disabled" {
		return refuse("execution_disabled", "execution mode is disabled")
	}
	if control.FailClosedReason != "" {
		return refuse("config_unavailable", control.FailClosedReason)
	}
	if control.ReplayNotBefore != "" {
		barrier, err := time.Parse(time.RFC3339Nano, control.ReplayNotBefore)
		messageDate, parseErr := time.Parse(time.RFC3339Nano, event.MessageDate)
		if err != nil || parseErr != nil || !messageDate.After(barrier) {
			return refuse("before_replay_barrier", "source message is at or before, or cannot be checked against, the settled cutover boundary")
		}
	}
	if control.ActiveProfile == nil || control.Safety == nil {
		return refuse("invalid_profile", "active profile or safety limits unavailable")
	}
	profileChecked := domain.ValidateProfile(*control.ActiveProfile)
	if !profileChecked.OK || profileChecked.Value == nil {
		return refuse("invalid_profile", summarizeIssues(profileChecked.Errors))
	}
	safetyChecked := domain.ValidateSafetyLimits(*control.Safety)
	if !safetyChecked.OK || safetyChecked.Value == nil {
		return refuse("invalid_safety", summarizeIssues(safetyChecked.Errors))
	}
	profile, safety := *profileChecked.Value, *safetyChecked.Value
	if issues := domain.ValidateProfileAgainstSafety(profile, safety); len(issues) > 0 {
		return refuse("invalid_profile", summarizeIssues(issues))
	}
	limits := domain.ResolveEffectiveLimits(profile, safety)
	brokerSymbol, mapped := domain.ResolveBrokerSymbol(profile, event.Signal.Symbol)
	if !mapped {
		return refuse("symbol_not_mapped", fmt.Sprintf("%s has no broker symbol in profile %s", event.Signal.Symbol, profile.ProfileID))
	}
	allowedSymbol := false
	for _, symbol := range safety.AllowedSignalSymbols {
		if strings.EqualFold(symbol, event.Signal.Symbol) {
			allowedSymbol = true
			break
		}
	}
	if !allowedSymbol {
		return refuse("symbol_not_allowed", event.Signal.Symbol+" is not in allowed_signal_symbols")
	}
	messageTime, err := time.Parse(time.RFC3339Nano, event.MessageDate)
	if err != nil {
		return refuse("signal_missing_date", "signal has no usable message date")
	}
	age := e.cfg.Now().Sub(messageTime).Seconds()
	if age < -30 {
		return refuse("signal_missing_date", fmt.Sprintf("message date is %.0fs in the future", -age))
	}
	if age > float64(limits.MaxSignalAgeSec) {
		return refuse("signal_too_old", fmt.Sprintf("signal is %.0fs old; limit %ds", age, limits.MaxSignalAgeSec))
	}
	if e.cfg.BrokerForMode == nil {
		return nil, nil, errors.New("broker factory unavailable")
	}
	br, err := e.cfg.BrokerForMode(ctx, control.Mode)
	if err != nil {
		return nil, nil, err
	}
	if br == nil {
		return nil, nil, errors.New("broker unavailable")
	}
	account, err := br.GetAccountInfo(ctx)
	if err != nil {
		return nil, nil, err
	}
	if control.Mode == "demo" && account.TradeMode != broker.Demo {
		return refuse("account_not_demo", "account is not a demo account")
	}
	if control.Mode == "live" {
		if account.TradeMode != broker.Real {
			return refuse("account_not_real", "account is not a real account")
		}
		if !control.LiveTradingEnabled {
			return refuse("live_not_enabled", "live trading environment gate is disabled")
		}
	}
	if control.Mode != "paper" {
		if !(account.TradeAllowed && account.TradeExpert && account.TerminalTradeAllowed) {
			return refuse("trading_not_allowed", "broker account or terminal disallows trading")
		}
		if account.MarginMode != "HEDGING" {
			return refuse("account_netting", "engine requires a hedging account")
		}
	}
	if br.Kind() == broker.MT5 {
		ping, err := br.Ping(ctx)
		if err != nil {
			return nil, nil, err
		}
		if ping.GMTTime <= 0 || math.Abs(float64(e.cfg.Now().Unix()-ping.GMTTime)) > e.cfg.MaxClockSkew.Seconds() {
			return refuse("clock_skew", fmt.Sprintf("EA TimeGMT differs from the local clock by more than %.3g seconds or is unavailable", e.cfg.MaxClockSkew.Seconds()))
		}
	}
	spec, err := br.GetSymbolInfo(ctx, brokerSymbol)
	if err != nil {
		var rejected *broker.RejectedError
		if errors.As(err, &rejected) && rejected.Retcode == 5007 {
			return refuse("symbol_not_mapped", "terminal does not know symbol "+brokerSymbol)
		}
		return nil, nil, err
	}
	modeOK := event.Signal.Direction == domain.Buy && (spec.TradeMode == "FULL" || spec.TradeMode == "LONGONLY") || event.Signal.Direction == domain.Sell && (spec.TradeMode == "FULL" || spec.TradeMode == "SHORTONLY")
	if !modeOK {
		return refuse("symbol_trade_disabled", fmt.Sprintf("%s trade mode %s does not permit %s", brokerSymbol, spec.TradeMode, event.Signal.Direction))
	}
	if !(spec.Bid > 0) || !(spec.Ask > 0) || spec.Ask < spec.Bid {
		return refuse("invalid_quote", fmt.Sprintf("invalid quote bid=%v ask=%v", spec.Bid, spec.Ask))
	}
	quoteAgeMS := e.cfg.Now().UnixMilli() - spec.TickTimeMsc
	if spec.TickTimeMsc <= 0 || quoteAgeMS < 0 || quoteAgeMS > e.cfg.MaxQuoteAge.Milliseconds() {
		return refuse("quote_stale", fmt.Sprintf("last %s tick is %.0fs old; limit %.0fs", brokerSymbol, float64(quoteAgeMS)/1000, e.cfg.MaxQuoteAge.Seconds()))
	}
	spread := spec.SpreadPoints * spec.Point
	if spread > limits.MaxSpreadPrice+priceEpsilon {
		return refuse("spread_too_wide", fmt.Sprintf("spread %v above max %v", spread, limits.MaxSpreadPrice))
	}
	decision := domain.DecideEntry(*event.Signal, spec.Bid, spec.Ask, profile.Entry)
	if !decision.OK {
		return refuse(decision.Reason, decision.Detail)
	}
	signal := domain.ApplyProfileToSignal(*event.Signal, profile, decision.EntryRefPrice)
	slCheck := domain.ValidateStopLoss(signal.Direction, decision.EntryRefPrice, signal.StopLoss, profile.StopLoss)
	if !slCheck.OK {
		return refuse(slCheck.Reason, slCheck.Detail)
	}
	warnings := []string{}
	tickValueLoss := spec.TickValueLoss
	if !(tickValueLoss > 0) {
		tickValueLoss = spec.TickValue
		warnings = append(warnings, fmt.Sprintf("tickValueLoss %v missing; sized with tickValue %v", spec.TickValueLoss, spec.TickValue))
	}
	sizingSpec := domain.SizingSpec{TickSize: spec.TickSize, TickValueLoss: tickValueLoss, VolumeMin: spec.VolumeMin, VolumeMax: spec.VolumeMax, VolumeStep: spec.VolumeStep}
	sized := domain.ComputeVolume(profile.Sizing, decision.EntryRefPrice, signal.StopLoss, account.Equity, sizingSpec, limits)
	if !sized.OK {
		return refuse(sized.Reason, sized.Detail)
	}
	planned := domain.PlanCheckpoints(sized.Volume, signal.Direction, decision.EntryRefPrice, signal.TakeProfits, profile.TakeProfit, sizingSpec)
	if !planned.OK {
		return refuse(planned.Reason, planned.Detail)
	}
	warnings = append(warnings, planned.Warnings...)
	positions, err := br.GetPositions(ctx, "")
	if err != nil {
		return nil, nil, err
	}
	orders, err := br.GetOrders(ctx, "")
	if err != nil {
		return nil, nil, err
	}
	setDocs, err := e.db.ListTradeSetsByState(ctx, openRiskStates, 10000)
	if err != nil {
		return nil, nil, err
	}
	sameMode := []domain.TradeSet{}
	inflight := []domain.TradeSet{}
	for _, doc := range setDocs {
		trade, err := decodeTrade(doc)
		if err != nil {
			continue
		}
		if trade.Mode != control.Mode || trade.TradeSetID == tradeID {
			continue
		}
		sameMode = append(sameMode, trade)
		if inflightStates[trade.State] {
			inflight = append(inflight, trade)
		}
	}
	if len(positions)+len(orders)+len(inflight) >= limits.MaxConcurrent {
		return refuse("max_concurrent_positions", fmt.Sprintf("%d positions/orders open; limit %d", len(positions)+len(orders)+len(inflight), limits.MaxConcurrent))
	}
	symbolCount := 0
	for _, p := range positions {
		if p.Symbol == brokerSymbol {
			symbolCount++
		}
	}
	for _, o := range orders {
		if o.Symbol == brokerSymbol {
			symbolCount++
		}
	}
	for _, t := range inflight {
		if t.BrokerSymbol != nil && *t.BrokerSymbol == brokerSymbol {
			symbolCount++
		}
	}
	if symbolCount >= limits.MaxPerSymbol {
		return refuse("max_positions_per_symbol", fmt.Sprintf("%d positions/orders on %s; limit %d", symbolCount, brokerSymbol, limits.MaxPerSymbol))
	}
	if spec.VolumeLimit > 0 {
		volume := 0.0
		for _, p := range positions {
			if p.Symbol == brokerSymbol {
				volume += p.Volume
			}
		}
		for _, o := range orders {
			if o.Symbol == brokerSymbol {
				volume += o.VolumeCurrent
			}
		}
		if volume+sized.Volume > spec.VolumeLimit+spec.VolumeStep/2 {
			return refuse("symbol_volume_limit", fmt.Sprintf("%v + %v lots exceeds %s volume limit %v", volume, sized.Volume, brokerSymbol, spec.VolumeLimit))
		}
	}
	startDay := time.Date(e.cfg.Now().UTC().Year(), e.cfg.Now().UTC().Month(), e.cfg.Now().UTC().Day(), 0, 0, 0, 0, time.UTC).Unix()
	deals, err := br.GetDeals(ctx, broker.DealQuery{FromSec: startDay})
	if err != nil {
		return nil, nil, err
	}
	realized := 0.0
	for _, deal := range deals {
		if deal.Entry == "OUT" || deal.Entry == "OUT_BY" || deal.Entry == "INOUT" {
			realized += deal.Profit + deal.Commission + deal.Swap + deal.Fee
		}
	}
	if -realized >= limits.DailyLossLimit {
		return refuse("daily_loss_limit", fmt.Sprintf("realized loss %.2f reached limit %v", -realized, limits.DailyLossLimit))
	}
	openRisk := 0.0
	for _, trade := range sameMode {
		if trade.Lifecycle == nil || !trade.Lifecycle.BEApplied {
			if trade.Plan != nil {
				openRisk += trade.Plan.RiskMoney
			}
		}
	}
	riskCap := account.Equity * limits.MaxTotalRiskPercent / 100
	if openRisk+sized.RiskMoney > riskCap+priceEpsilon {
		return refuse("total_risk_limit", fmt.Sprintf("open risk %.2f + new %.2f exceeds %.2f", openRisk, sized.RiskMoney, riskCap))
	}
	request := broker.PlaceOrderRequest{Symbol: brokerSymbol, OrderType: broker.OrderType(decision.OrderType), Volume: sized.Volume, Price: decision.OrderPrice, SL: signal.StopLoss, TP: planned.BrokerTP, DeviationPoints: limits.MaxDeviationPoints, Comment: corr}
	if decision.IsPending {
		exp := e.cfg.Now().Unix() + int64(profile.Entry.PendingExpiryMinutes*60)
		request.ExpirationGMT = &exp
	}
	check, err := br.CheckOrder(ctx, request)
	if err != nil {
		return nil, nil, err
	}
	if !check.OK {
		return refuse("margin_check_failed", fmt.Sprintf("%s (retcode %d)", check.Comment, check.Retcode))
	}
	if limits.MinMarginLevelPercent > 0 {
		margin := account.Margin + check.Margin
		if margin > 0 {
			level := account.Equity / margin * 100
			if level < limits.MinMarginLevelPercent {
				return refuse("margin_level_too_low", fmt.Sprintf("post-trade margin level %.0f%% below %v%%", level, limits.MinMarginLevelPercent))
			}
		}
	}
	return &prepared{mode: control.Mode, broker: br, profile: profile, profileDocID: control.ActiveProfileDocID, limits: limits, brokerSymbol: brokerSymbol,
		spec: spec, direction: event.Signal.Direction, decision: decision, sizing: sized, checkpoints: planned.Checkpoints,
		brokerTP: planned.BrokerTP, sl: signal.StopLoss, request: request, warnings: warnings}, nil, nil
}

func (e *Runner) recordSkip(ctx context.Context, tradeID, mode string, refusal skipSignal, event domain.SignalEvent) domain.HandleResult {
	patch := map[string]any{"state": string(domain.TradeSkipped), "skip_reason": refusal.reason}
	_, err := e.db.TransitionTradeSet(ctx, tradeID, []string{"CLAIMED"}, store.Document(patch))
	if err != nil {
		return domain.HandleResult{Outcome: "retry", Reason: "skip_write_failed"}
	}
	e.tradeEvent(ctx, tradeID, mode, "skipped_"+refusal.reason, "execution_skipped", map[string]any{"reason_code": refusal.reason, "message": refusal.detail, "details": map[string]any{"event_id": event.EventID}})
	e.audit(ctx, "info", "execution_skipped", map[string]any{"trade_set_id": tradeID, "reason": refusal.reason, "detail": refusal.detail, "mode": mode})
	return domain.HandleResult{Outcome: "skipped", State: domain.TradeSkipped, Reason: refusal.reason}
}

func (e *Runner) persistAndSend(ctx context.Context, tradeID, corr string, p *prepared) domain.HandleResult {
	now := e.cfg.Now()
	expires := now.Unix() + 8
	checkpoints := lifecycleCheckpoints(p.checkpoints)
	lifecycle := domain.TradeLifecycle{Checkpoints: checkpoints, CurrentVolume: 0, CurrentSL: p.sl, CurrentTP: p.brokerTP, BestPrice: p.decision.EntryRefPrice}
	submitted := store.ISO(now)
	plan := map[string]any{"volume": p.sizing.Volume, "entry_ref_price": p.decision.EntryRefPrice, "order_price": p.decision.OrderPrice,
		"sl": p.sl, "broker_tp": p.brokerTP, "risk_money": p.sizing.RiskMoney, "risk_percent": p.sizing.RiskPercent, "checkpoints": p.checkpoints}
	if len(p.warnings) > 0 {
		plan["warnings"] = p.warnings
	}
	submission := map[string]any{"submitted_at": submitted, "expires_at": expires, "request_id": ""}
	if p.request.ExpirationGMT != nil {
		submission["pending_expires_at"] = *p.request.ExpirationGMT
	}
	profileRef := domain.TradeProfileRef{DocID: p.profileDocID, ProfileID: p.profile.ProfileID, Version: p.profile.Version}
	patch := map[string]any{"state": string(domain.TradeSubmitting), "broker_symbol": p.brokerSymbol, "order_type": p.decision.OrderType,
		"broker": string(p.broker.Kind()), "profile": profileRef, "profile_snapshot": p.profile, "limits_snapshot": p.limits,
		"plan": plan, "submission": submission, "lifecycle": lifecycle}
	persisted, err := e.db.TransitionTradeSet(ctx, tradeID, []string{"CLAIMED"}, store.Document(patch))
	if err != nil || !persisted {
		if err != nil {
			e.audit(ctx, "error", "entry_intent_persist_failed", map[string]any{"trade_set_id": tradeID, "error": err.Error()})
		}
		_, _ = e.db.TransitionTradeSet(ctx, tradeID, []string{"CLAIMED"}, store.Document{"state": "ERROR", "error": "persist_intent_failed"})
		return domain.HandleResult{Outcome: "retry", Reason: "persist_intent_failed"}
	}
	e.tradeEvent(ctx, tradeID, p.mode, "entry_submitted", "entry_submitted", map[string]any{"volume": p.sizing.Volume,
		"price": p.decision.OrderPrice, "sl": p.sl, "tp": p.brokerTP, "details": map[string]any{"order_type": p.decision.OrderType, "correlation_comment": corr, "expires_at": expires}})
	result, err := p.broker.PlaceOrder(ctx, p.request)
	if err != nil {
		var rejected *broker.RejectedError
		var unavailable *broker.UnavailableError
		var ambiguous *broker.AmbiguousError
		switch {
		case errors.As(err, &rejected):
			_, _ = e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document{"state": "REJECTED", "error": "broker_rejected: " + err.Error()})
			e.tradeEvent(ctx, tradeID, p.mode, "entry_rejected", "entry_rejected", map[string]any{"reason_code": "broker_rejected", "message": err.Error(), "retcode": rejected.Retcode})
			return domain.HandleResult{Outcome: "submitted", State: domain.TradeRejected, Reason: "broker_rejected"}
		case errors.As(err, &unavailable):
			_, _ = e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document{"state": "REJECTED", "error": "bridge_unavailable: " + err.Error()})
			e.tradeEvent(ctx, tradeID, p.mode, "entry_bridge_unavailable", "entry_rejected", map[string]any{"reason_code": "bridge_unavailable", "message": err.Error()})
			return domain.HandleResult{Outcome: "submitted", State: domain.TradeRejected, Reason: "bridge_unavailable"}
		default:
			unknownPatch := map[string]any{"state": "SUBMIT_UNKNOWN"}
			if errors.As(err, &ambiguous) {
				unknownPatch["submission"] = map[string]any{"submitted_at": submitted, "expires_at": valueOr(ambiguous.ExpiresAt, expires), "request_id": ambiguous.RequestID}
			}
			_, _ = e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document(unknownPatch))
			e.tradeEvent(ctx, tradeID, p.mode, "entry_unknown", "entry_unknown", map[string]any{"reason_code": "ambiguous_send", "message": err.Error(), "details": map[string]any{"expires_at": expires}})
			e.raiseAlert(ctx, "submit_unknown", tradeID, "error", "Entry outcome unknown", "The broker request was not confirmed. It will be resolved from broker state and is never resent.", map[string]any{"trade_set_id": tradeID, "mode": p.mode, "correlation_comment": corr, "expires_at": expires})
			return domain.HandleResult{Outcome: "submitted", State: domain.TradeSubmitUnknown, Reason: "entry_unknown"}
		}
	}
	if p.decision.IsPending {
		if result.OrderTicket <= 0 {
			return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "pending_order_ticket_missing")
		}
		return e.recordPending(ctx, tradeID, corr, p, result, lifecycle, submission)
	}
	if result.Retcode == 10008 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "broker_placed_not_completed")
	}
	positions, readErr := p.broker.GetPositions(ctx, p.brokerSymbol)
	if readErr != nil {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "position_readback_failed")
	}
	orders, orderErr := p.broker.GetOrders(ctx, p.brokerSymbol)
	if orderErr != nil {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "order_readback_failed")
	}
	for _, order := range orders {
		if order.Magic == p.broker.Magic() && order.Comment == corr {
			return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "correlated_order_still_working")
		}
	}
	matched := []broker.Position{}
	for _, position := range positions {
		if position.Magic == p.broker.Magic() && position.Comment == corr {
			matched = append(matched, position)
		}
	}
	if len(matched) != 1 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "exact_correlated_position_not_unique")
	}
	position := matched[0]
	if result.PositionTicket > 0 && result.PositionTicket != position.Ticket && result.PositionTicket != position.Identifier {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "position_identity_readback_mismatch")
	}
	if position.Ticket <= 0 || position.Volume <= 0 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "exact_position_has_invalid_ticket_or_volume")
	}
	// A successful OrderSend reply can carry DEAL_POSITION_ID, which is not
	// necessarily the current position ticket. Persist the live ticket and use
	// its authoritative volume; result.volume may be zero or stale.
	result.PositionTicket, result.Volume = position.Ticket, position.Volume
	if result.Price <= 0 {
		result.Price = position.OpenPrice
	}
	if result.Price <= 0 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "exact_position_fill_price_unavailable")
	}
	return e.recordFill(ctx, tradeID, corr, p, result, lifecycle, position)
}

func (e *Runner) recordUnknownPlacement(ctx context.Context, tradeID, corr string, p *prepared, result broker.PlaceOrderResult, reason string) domain.HandleResult {
	if _, err := e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document{"state": "SUBMIT_UNKNOWN"}); err != nil {
		e.audit(ctx, "error", "entry_unknown_state_not_recorded", map[string]any{"trade_set_id": tradeID, "error": err.Error(), "reason_code": reason})
	}
	details := map[string]any{"reason_code": reason, "retcode": result.Retcode, "order_ticket": result.OrderTicket, "deal_ticket": result.DealTicket, "reported_position_id": result.PositionTicket, "reported_volume": result.Volume}
	e.tradeEvent(ctx, tradeID, p.mode, "entry_unknown", "entry_unknown", map[string]any{"reason_code": reason, "message": "broker reply did not establish an exact live fill; state remains fenced for correlation-based reconciliation", "details": details})
	e.raiseAlert(ctx, "submit_unknown", tradeID, "error", "Entry outcome needs reconciliation", "The broker reply did not prove an exact live position. The entry is not resent; reconciliation will use the exact correlation comment.", map[string]any{"trade_set_id": tradeID, "mode": p.mode, "correlation_comment": corr, "reason_code": reason, "retcode": result.Retcode, "order_ticket": result.OrderTicket})
	return domain.HandleResult{Outcome: "submitted", State: domain.TradeSubmitUnknown, Reason: reason}
}

func (e *Runner) recordPending(ctx context.Context, tradeID, corr string, p *prepared, result broker.PlaceOrderResult, _ domain.TradeLifecycle, _ map[string]any) domain.HandleResult {
	refs := map[string]any{"order_ticket": result.OrderTicket, "position_ticket": 0, "deal_ticket": 0, "fill_price": 0, "filled_volume": 0}
	if result.ExpirationApplied != nil {
		refs["expiration_applied"] = *result.ExpirationApplied
	}
	_, err := e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document{"state": "PENDING_ORDER", "broker_refs": refs})
	if err != nil {
		e.audit(ctx, "error", "pending_state_not_recorded", map[string]any{"trade_set_id": tradeID, "error": err.Error()})
	}
	e.tradeEvent(ctx, tradeID, p.mode, "pending_order_placed", "pending_order_placed", map[string]any{"order_ticket": result.OrderTicket, "price": p.decision.OrderPrice, "volume": p.sizing.Volume, "sl": p.sl, "tp": p.brokerTP})
	return domain.HandleResult{Outcome: "submitted", State: domain.TradePendingOrder}
}

func (e *Runner) recordFill(ctx context.Context, tradeID, corr string, p *prepared, result broker.PlaceOrderResult, lifecycle domain.TradeLifecycle, position broker.Position) domain.HandleResult {
	filled := position.Volume
	if position.Ticket <= 0 || filled <= 0 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "confirmed_position_volume_unavailable")
	}
	entry := result.Price
	if entry <= 0 {
		entry = position.OpenPrice
	}
	if entry <= 0 {
		return e.recordUnknownPlacement(ctx, tradeID, corr, p, result, "confirmed_position_fill_price_unavailable")
	}
	checkpoints := lifecycle.Checkpoints
	partial := math.Abs(filled-p.sizing.Volume) > p.spec.VolumeStep/2
	if partial {
		checkpoints = domain.FillCheckpoints(p.direction, entry, filled, &p.sizing.Volume, p.profile, domain.SizingSpec{VolumeMin: p.spec.VolumeMin, VolumeStep: p.spec.VolumeStep}, checkpoints)
		if checkpoints == nil {
			checkpoints = lifecycle.Checkpoints
		}
	}
	lifecycle.Checkpoints, lifecycle.CurrentVolume = checkpoints, filled
	refs := map[string]any{"order_ticket": result.OrderTicket, "position_ticket": position.Ticket, "deal_ticket": result.DealTicket,
		"fill_price": entry, "filled_volume": filled}
	if position.Identifier > 0 {
		refs["position_identifier"] = position.Identifier
	}
	_, err := e.db.TransitionTradeSet(ctx, tradeID, []string{"SUBMITTING"}, store.Document{"state": "OPEN", "broker_refs": refs, "lifecycle": lifecycle})
	if err != nil {
		e.audit(ctx, "error", "open_state_not_recorded", map[string]any{"trade_set_id": tradeID, "error": err.Error(), "position_ticket": position.Ticket})
	}
	e.tradeEvent(ctx, tradeID, p.mode, "entry_confirmed", "entry_confirmed", map[string]any{"order_ticket": result.OrderTicket, "position_ticket": position.Ticket,
		"deal_ticket": result.DealTicket, "volume": filled, "price": entry})
	if partial {
		e.tradeEvent(ctx, tradeID, p.mode, "partial_fill_replanned", "reconciliation", map[string]any{"reason_code": "partial_fill_replanned", "volume": filled})
	}
	e.verifyProtection(ctx, tradeID, corr, p, position.Ticket)
	return domain.HandleResult{Outcome: "submitted", State: domain.TradeOpen}
}

func (e *Runner) verifyProtection(ctx context.Context, tradeID, corr string, p *prepared, ticket int64) {
	positions, err := p.broker.GetPositions(ctx, p.brokerSymbol)
	if err != nil {
		e.executionError(ctx, tradeID, p.mode, "protection_unverified", err.Error())
		return
	}
	var found *broker.Position
	for i := range positions {
		if positions[i].Ticket == ticket {
			found = &positions[i]
			break
		}
	}
	if found == nil {
		e.executionError(ctx, tradeID, p.mode, "protection_unverified", "position not visible after fill")
		return
	}
	if found.Identifier > 0 {
		if err := e.persistPositionIdentifier(ctx, tradeID, found.Identifier); err != nil {
			e.executionError(ctx, tradeID, p.mode, "position_identifier_unrecorded", err.Error())
		}
	}
	if found.Comment != corr {
		e.executionError(ctx, tradeID, p.mode, "comment_not_preserved", "broker stored a different correlation comment")
		e.raiseAlert(ctx, "correlation_mismatch", tradeID, "critical", "Broker did not preserve the order comment", "Duplicate protection and ambiguous-order recovery rely on the correlation comment.", map[string]any{"trade_set_id": tradeID, "position_ticket": ticket, "sent": corr, "stored": found.Comment, "mode": p.mode})
	}
	tol := math.Max(p.spec.Point*0.5, priceEpsilon)
	if math.Abs(found.SL-p.sl) <= tol && (p.brokerTP == 0 || math.Abs(found.TP-p.brokerTP) <= tol) {
		e.tradeEvent(ctx, tradeID, p.mode, "protection_confirmed", "protection_confirmed", map[string]any{"position_ticket": ticket, "sl": found.SL, "tp": found.TP})
		return
	}
	intent := newMutationIntent(e, "POSITION_MODIFY", ticket)
	intent.PriorSL, intent.PriorTP = found.SL, found.TP
	intent.TargetSL, intent.TargetTP = p.sl, p.brokerTP
	intent.Reason = "entry_protection"
	if err := e.persistMutationIntent(ctx, tradeID, intent); err != nil {
		e.executionError(ctx, tradeID, p.mode, "protection_missing", "could not persist protection intent: "+err.Error())
		return
	}
	if _, _, err := p.broker.ModifyPosition(ctx, ticket, p.sl, p.brokerTP); err != nil {
		var rejected *broker.RejectedError
		var unavailable *broker.UnavailableError
		if errors.As(err, &rejected) || errors.As(err, &unavailable) {
			_ = e.clearUnsentMutation(ctx, tradeID)
		} else {
			e.markMutationUnresolved(domain.TradeSet{TradeSetID: tradeID, MutationIntent: &intent})
		}
		e.executionError(ctx, tradeID, p.mode, "protection_missing", err.Error())
		return
	}
	if err := e.completeMutationIntent(ctx, tradeID, nil); err != nil {
		e.markMutationUnresolved(domain.TradeSet{TradeSetID: tradeID, MutationIntent: &intent})
		e.executionError(ctx, tradeID, p.mode, "protection_missing", "protection intent completion failed: "+err.Error())
		return
	}
	e.tradeEvent(ctx, tradeID, p.mode, "protection_confirmed", "protection_confirmed", map[string]any{"position_ticket": ticket, "sl": p.sl, "tp": p.brokerTP})
}

func (e *Runner) persistPositionIdentifier(ctx context.Context, tradeID string, identifier int64) error {
	return e.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", tradeID)
		if err != nil {
			return err
		}
		refs := object(doc["broker_refs"])
		if refs == nil {
			return errors.New("trade set has no broker references")
		}
		refs["position_identifier"] = identifier
		doc["broker_refs"] = refs
		doc["updated_at"] = store.ISO(e.cfg.Now())
		return tx.Put("trade_sets", tradeID, doc)
	})
}

func (e *Runner) executionError(ctx context.Context, tradeID, mode, code, message string) {
	e.tradeEvent(ctx, tradeID, mode, "error_"+code+"_"+store.ISO(e.cfg.Now()), "execution_error", map[string]any{"reason_code": code, "message": message})
	e.audit(ctx, "error", "execution_error", map[string]any{"trade_set_id": tradeID, "reason_code": code, "detail": message})
	if code == "protection_missing" || code == "protection_unverified" {
		e.raiseAlert(ctx, "protection_missing", tradeID, "error", "Filled position protection not confirmed", message, map[string]any{"trade_set_id": tradeID})
	}
}

func recheckControl(p *prepared, fresh Control) (string, string) {
	allowed, reason := fresh.CanOpenNewEntries()
	if !allowed {
		return reason, "execution control refused entries before send: " + reason
	}
	if fresh.Mode != p.mode {
		return "mode_changed", "mode changed before send"
	}
	if fresh.ActiveProfileDocID != p.profileDocID {
		return "profile_changed", "active profile changed before send"
	}
	return "", ""
}

func correlationComment(id string) string {
	sum := sha256.Sum256([]byte(id))
	return "BT-" + hex.EncodeToString(sum[:])[:12]
}

func lifecycleCheckpoints(planned []domain.PlannedCheckpoint) []domain.CheckpointState {
	out := make([]domain.CheckpointState, len(planned))
	for i, cp := range planned {
		out[i] = domain.CheckpointState{TPIndex: cp.TPIndex, Price: cp.Price, CloseVolume: cp.CloseVolume, TargetRemainingVolume: cp.TargetRemainingVolume, Status: "pending"}
	}
	return out
}

func summarizeIssues(issues []domain.ValidationIssue) string {
	parts := []string{}
	for i, issue := range issues {
		if i == 3 {
			break
		}
		parts = append(parts, issue.Path+": "+issue.Message)
	}
	return strings.Join(parts, "; ")
}

func valueOr(value *int64, fallback int64) int64 {
	if value != nil {
		return *value
	}
	return fallback
}
