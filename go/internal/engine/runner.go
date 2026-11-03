package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/notify"
	"github.com/bytrader/bytrader/internal/store"
)

type Config struct {
	Owner              string
	Controls           ControlProvider
	Alerts             *notify.Manager
	BrokerForMode      func(context.Context, string) (broker.Broker, error)
	Now                func() time.Time
	Random             func() float64
	EventPollInterval  time.Duration
	LifecycleInterval  time.Duration
	ReconcileInterval  time.Duration
	Lease              time.Duration
	ClaimLimit         int
	MaxAttempts        int
	MaxQuoteAge        time.Duration
	MaxClockSkew       time.Duration
	AdminInterval      time.Duration
	CloseAllSettle     time.Duration
	LiveTradingEnabled bool
}

type Readiness struct {
	Ready            bool   `json:"ready"`
	Reason           string `json:"reason,omitempty"`
	LastReconciledAt string `json:"last_reconciled_at,omitempty"`
}

type Runner struct {
	db                *store.SQLiteStore
	cfg               Config
	mu                sync.RWMutex
	adminMu           sync.Mutex
	readiness         Readiness
	marketClosedUntil map[string]int64
	slFailures        map[string]int
	warned            map[string]bool
	orphanSubjects    map[string]bool
	reconcileFailures map[string]int
}

func NewRunner(db *store.SQLiteStore, cfg Config) *Runner {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Random == nil {
		cfg.Random = func() float64 { return 0.5 }
	}
	if cfg.Owner == "" {
		cfg.Owner = defaultOwner()
	}
	if cfg.EventPollInterval <= 0 {
		cfg.EventPollInterval = 3 * time.Second
	}
	if cfg.LifecycleInterval <= 0 {
		cfg.LifecycleInterval = 5 * time.Second
	}
	if cfg.ReconcileInterval <= 0 {
		cfg.ReconcileInterval = 30 * time.Second
	}
	if cfg.Lease <= 0 {
		cfg.Lease = 120 * time.Second
	}
	if cfg.ClaimLimit <= 0 {
		cfg.ClaimLimit = 20
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 8
	}
	if cfg.MaxQuoteAge <= 0 {
		cfg.MaxQuoteAge = 60 * time.Second
	}
	if cfg.MaxClockSkew <= 0 {
		cfg.MaxClockSkew = maxClockSkewFromEnvironment()
	}
	if cfg.AdminInterval <= 0 {
		cfg.AdminInterval = 3 * time.Second
	}
	if cfg.CloseAllSettle == 0 {
		cfg.CloseAllSettle = 10 * time.Second
	}
	if cfg.Controls == nil && db != nil {
		cfg.Controls = StoreControlProvider(db, cfg.LiveTradingEnabled)
	}
	if cfg.Alerts == nil && db != nil {
		cfg.Alerts = notify.New(db)
	}
	return &Runner{db: db, cfg: cfg, readiness: Readiness{Reason: "startup_reconciliation_pending"},
		marketClosedUntil: map[string]int64{}, slFailures: map[string]int{}, warned: map[string]bool{}, orphanSubjects: map[string]bool{}, reconcileFailures: map[string]int{}}
}

func (r *Runner) Readiness() Readiness {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.readiness
}

func (r *Runner) setReadiness(state Readiness) {
	r.mu.Lock()
	r.readiness = state
	r.mu.Unlock()
}

// Run reconciles first. Queue intake remains closed until a complete pass succeeds,
// while protective management and admin recovery continue after a failed pass.
func (r *Runner) Run(ctx context.Context) error {
	if r.db == nil {
		return errors.New("engine store unavailable")
	}
	r.setReadiness(Readiness{Reason: "startup_reconciliation_pending"})
	if err := r.Reconcile(ctx); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		r.setReadiness(Readiness{Reason: "startup_reconciliation_failed"})
		slog.Error("startup reconciliation failed; protective management remains active and intake stays closed", "error", err)
	} else {
		r.setReadiness(Readiness{Ready: true, LastReconciledAt: store.ISO(r.cfg.Now())})
	}
	adminDone := make(chan struct{})
	go func() {
		defer close(adminDone)
		ticker := time.NewTicker(r.cfg.AdminInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := r.ProcessAdminCommands(ctx); err != nil {
					if ctx.Err() == nil {
						r.audit(ctx, "warn", "admin_command_poll_failed", map[string]any{"error": err.Error()})
					}
				}
			}
		}
	}()
	defer func() { <-adminDone }()
	intake := time.NewTicker(r.cfg.EventPollInterval)
	lifecycle := time.NewTicker(r.cfg.LifecycleInterval)
	reconcile := time.NewTicker(r.cfg.ReconcileInterval)
	defer intake.Stop()
	defer lifecycle.Stop()
	defer reconcile.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-intake.C:
			if !r.Readiness().Ready {
				continue
			}
			if err := r.ProcessQueue(ctx); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				r.setReadiness(Readiness{Reason: "queue_unavailable", LastReconciledAt: r.Readiness().LastReconciledAt})
				slog.Error("signal intake failed", "error", err)
			}
		case <-lifecycle.C:
			if err := r.Tick(ctx); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				r.setReadiness(Readiness{Reason: "lifecycle_unavailable", LastReconciledAt: r.Readiness().LastReconciledAt})
				slog.Error("lifecycle tick failed", "error", err)
			}
		case <-reconcile.C:
			if err := r.Reconcile(ctx); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				r.setReadiness(Readiness{Reason: "reconciliation_failed", LastReconciledAt: r.Readiness().LastReconciledAt})
				slog.Error("reconciliation failed", "error", err)
			} else {
				r.setReadiness(Readiness{Ready: true, LastReconciledAt: store.ISO(r.cfg.Now())})
			}
		}
	}
}

func (r *Runner) ProcessQueue(ctx context.Context) error {
	if !r.Readiness().Ready {
		return errors.New("engine is not ready")
	}
	claimed, err := r.db.ClaimSignalEvents(ctx, store.ClaimOptions{
		Owner: r.cfg.Owner, Now: r.cfg.Now(), Lease: r.cfg.Lease, Limit: r.cfg.ClaimLimit,
		MaxAttempts: r.cfg.MaxAttempts, HistoryLimit: 10,
	})
	if err != nil {
		return err
	}
	var first error
	for _, event := range claimed {
		if ctx.Err() != nil {
			break
		}
		if err := r.processClaim(ctx, event); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (r *Runner) processClaim(ctx context.Context, claim store.ClaimedEvent) error {
	leaseCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	renewEvery := r.cfg.Lease / 3
	if renewEvery < time.Second {
		renewEvery = time.Second
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(renewEvery)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				now := r.cfg.Now()
				renewed, err := r.db.RenewSignalEventLease(leaseCtx, claim.ID, claim.LeaseID, now.Add(r.cfg.Lease), now)
				if err != nil || !renewed {
					cancel()
					return
				}
			}
		}
	}()

	event, err := decodeEvent(claim.ID, claim.Document)
	var result domain.HandleResult
	if err != nil {
		result = domain.HandleResult{Outcome: "retry", Reason: "invalid_signal_event"}
	} else {
		result = r.HandleEvent(leaseCtx, event)
	}
	cancel()
	<-done

	current, err := r.db.Get(ctx, "signal_events", claim.ID)
	if err != nil {
		return err
	}
	state := object(current["autotrader"])
	if state == nil {
		state = map[string]any{}
	}
	now := r.cfg.Now()
	transient := result.Outcome == "retry"
	status := "done"
	if result.Outcome == "ignored" {
		status = "ignored"
	}
	if transient {
		status = "retry_wait"
	}
	if transient && claim.Attempts >= r.cfg.MaxAttempts {
		status = "dead_letter"
	}
	history := anyRows(state["history"])
	record := map[string]any{"attempt": claim.Attempts, "at": store.ISO(now), "result": statusResult(status), "detail": truncate(result.Reason, 500)}
	history = append(history, record)
	if len(history) > 10 {
		history = history[len(history)-10:]
	}
	finished := cloneDocument(state)
	finished["status"], finished["lease_id"], finished["lease_owner"], finished["lease_expires_at"] = status, nil, nil, nil
	finished["updated_at"], finished["history"] = store.ISO(now), history
	if result.Outcome != "" {
		finished["outcome"] = result.Outcome
	}
	if result.State != "" {
		finished["state"] = result.State
	}
	if result.Reason != "" {
		finished["reason"] = truncate(result.Reason, 500)
	}
	switch status {
	case "done", "ignored":
		finished["processed_at"], finished["next_attempt_at"] = store.ISO(now), nil
	case "retry_wait":
		delay := r.backoffDelay(claim.Attempts)
		finished["last_error"] = truncate(result.Reason, 500)
		finished["next_attempt_at"] = store.ISO(now.Add(delay))
	case "dead_letter":
		finished["reason"], finished["last_error"] = "max_attempts", truncate(result.Reason, 500)
		finished["dead_lettered_at"], finished["next_attempt_at"] = store.ISO(now), nil
	}
	_, err = r.db.FinishSignalEvent(ctx, claim.ID, store.QueueFinish{LeaseID: claim.LeaseID, State: store.Document(finished)})
	return err
}

func (r *Runner) backoffDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	raw := 5 * time.Second * time.Duration(math.Pow(2, float64(attempt-1)))
	if raw > 5*time.Minute {
		raw = 5 * time.Minute
	}
	rand := math.Min(math.Max(r.cfg.Random(), 0), 1)
	return time.Duration(math.Max(float64(2500*time.Millisecond), math.Round(float64(raw)*(1+(rand-.5)*.4))))
}

func decodeEvent(id string, doc store.Document) (domain.SignalEvent, error) {
	data, err := json.Marshal(doc)
	if err != nil {
		return domain.SignalEvent{}, err
	}
	var event domain.SignalEvent
	if err := json.Unmarshal(data, &event); err != nil {
		return domain.SignalEvent{}, err
	}
	if event.EventID == "" {
		event.EventID = id
	}
	if event.ChatID == "" || event.MessageID == "" {
		return event, errors.New("signal event has no chat_id or message_id")
	}
	return event, nil
}

func defaultOwner() string {
	host, _ := os.Hostname()
	var token [8]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "go-executor"
	}
	return host + ":" + hex.EncodeToString(token[:])
}

func maxClockSkewFromEnvironment() time.Duration {
	value, err := strconv.ParseFloat(os.Getenv("MAX_CLOCK_SKEW_SEC"), 64)
	if err != nil || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return 5 * time.Second
	}
	limit := time.Duration(value * float64(time.Second))
	if limit <= 0 {
		return 5 * time.Second
	}
	return limit
}

func statusResult(status string) string {
	switch status {
	case "done":
		return "done"
	case "ignored":
		return "ignored"
	case "dead_letter":
		return "dead_letter"
	default:
		return "retry"
	}
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit-3] + "..."
}

func anyRows(v any) []any {
	if rows, ok := v.([]any); ok {
		return append([]any(nil), rows...)
	}
	return []any{}
}

func cloneDocument(in map[string]any) map[string]any {
	data, _ := json.Marshal(in)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	if out == nil {
		return map[string]any{}
	}
	return out
}

func jsonDocument(value any) (store.Document, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	return store.Document(doc), nil
}

func decodeTrade(doc store.Document) (domain.TradeSet, error) {
	data, err := json.Marshal(doc)
	if err != nil {
		return domain.TradeSet{}, err
	}
	var trade domain.TradeSet
	if err := json.Unmarshal(data, &trade); err != nil {
		return domain.TradeSet{}, err
	}
	return trade, nil
}

func (r *Runner) getTrade(ctx context.Context, id string) (domain.TradeSet, error) {
	doc, err := r.db.Get(ctx, "trade_sets", id)
	if err != nil {
		return domain.TradeSet{}, err
	}
	return decodeTrade(doc)
}

func (r *Runner) transition(ctx context.Context, id string, from []domain.TradeState, patch any) (bool, error) {
	doc, err := jsonDocument(patch)
	if err != nil {
		return false, err
	}
	states := make([]string, len(from))
	for i, state := range from {
		states[i] = string(state)
	}
	return r.db.TransitionTradeSet(ctx, id, states, doc)
}

func maybeFloat(v float64) *float64 { return &v }
