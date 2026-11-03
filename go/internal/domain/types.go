package domain

import "encoding/json"

type Direction string

const (
	Buy  Direction = "buy"
	Sell Direction = "sell"
)

type SignalOrderType string

const (
	MarketOrder SignalOrderType = "market"
	BuyLimit    SignalOrderType = "buy_limit"
	SellLimit   SignalOrderType = "sell_limit"
	BuyStop     SignalOrderType = "buy_stop"
	SellStop    SignalOrderType = "sell_stop"
)

type Signal struct {
	Symbol      string          `json:"symbol"`
	Direction   Direction       `json:"direction"`
	OrderType   SignalOrderType `json:"orderType"`
	EntryLow    float64         `json:"entryLow"`
	EntryHigh   float64         `json:"entryHigh"`
	StopLoss    float64         `json:"stopLoss"`
	TakeProfits []float64       `json:"takeProfits"`
}

type SignalEvent struct {
	EventID          string  `json:"event_id"`
	ChatID           string  `json:"chat_id"`
	MessageID        string  `json:"message_id"`
	MessageDate      string  `json:"message_date"`
	MessageType      string  `json:"message_type"`
	Kind             string  `json:"kind"`
	Signal           *Signal `json:"signal"`
	CancelReason     string  `json:"cancel_reason,omitempty"`
	TextHash         string  `json:"text_hash,omitempty"`
	TriggerMessageID string  `json:"trigger_message_id,omitempty"`
}

type TradeState string

const (
	TradeClaimed         TradeState = "CLAIMED"
	TradeSkipped         TradeState = "SKIPPED"
	TradeSubmitting      TradeState = "SUBMITTING"
	TradeSubmitUnknown   TradeState = "SUBMIT_UNKNOWN"
	TradePendingOrder    TradeState = "PENDING_ORDER"
	TradeOpen            TradeState = "OPEN"
	TradePartiallyClosed TradeState = "PARTIALLY_CLOSED"
	TradeClosed          TradeState = "CLOSED"
	TradeCancelled       TradeState = "CANCELLED"
	TradeRejected        TradeState = "REJECTED"
	TradeError           TradeState = "ERROR"
)

var ActiveTradeStates = []string{string(TradeOpen), string(TradePartiallyClosed), string(TradePendingOrder)}
var InFlightTradeStates = []string{string(TradeClaimed), string(TradeSubmitting), string(TradeSubmitUnknown)}
var TerminalTradeStates = []string{string(TradeSkipped), string(TradeClosed), string(TradeCancelled), string(TradeRejected), string(TradeError)}

type CheckpointState struct {
	TPIndex               int      `json:"tp_index"`
	Price                 float64  `json:"price"`
	CloseVolume           float64  `json:"close_volume"`
	TargetRemainingVolume float64  `json:"target_remaining_volume"`
	Status                string   `json:"status"`
	Attempts              int      `json:"attempts"`
	PartialConfirmed      bool     `json:"partial_confirmed,omitempty"`
	RequestedAt           string   `json:"requested_at,omitempty"`
	AmbiguousUntil        *int64   `json:"ambiguous_until,omitempty"`
	ConfirmedAt           string   `json:"confirmed_at,omitempty"`
	DealTicket            *int64   `json:"deal_ticket,omitempty"`
	RealizedPnL           *float64 `json:"realized_pnl,omitempty"`
	LastError             string   `json:"last_error,omitempty"`
}

type TradeLifecycle struct {
	Checkpoints    []CheckpointState `json:"checkpoints"`
	CurrentVolume  float64           `json:"current_volume"`
	CurrentSL      float64           `json:"current_sl"`
	CurrentTP      float64           `json:"current_tp"`
	BEApplied      bool              `json:"be_applied"`
	TrailingActive bool              `json:"trailing_active"`
	BestPrice      float64           `json:"best_price"`
}

type PlannedCheckpoint struct {
	TPIndex               int     `json:"tpIndex"`
	Price                 float64 `json:"price"`
	ClosePercent          float64 `json:"closePercent"`
	CloseVolume           float64 `json:"closeVolume"`
	TargetRemainingVolume float64 `json:"targetRemainingVolume"`
}

type TradePlan struct {
	Volume        float64             `json:"volume"`
	EntryRefPrice float64             `json:"entry_ref_price"`
	OrderPrice    float64             `json:"order_price"`
	SL            float64             `json:"sl"`
	BrokerTP      float64             `json:"broker_tp"`
	RiskMoney     float64             `json:"risk_money"`
	RiskPercent   float64             `json:"risk_percent"`
	Checkpoints   []PlannedCheckpoint `json:"checkpoints"`
	Warnings      []string            `json:"warnings,omitempty"`
}

type BrokerRefs struct {
	OrderTicket        int64   `json:"order_ticket"`
	PositionTicket     int64   `json:"position_ticket"`
	PositionIdentifier int64   `json:"position_identifier,omitempty"`
	DealTicket         int64   `json:"deal_ticket"`
	FillPrice          float64 `json:"fill_price"`
	FilledVolume       float64 `json:"filled_volume"`
	ExpirationApplied  *bool   `json:"expiration_applied,omitempty"`
}

type TradeResult struct {
	ClosedAt    string  `json:"closed_at"`
	CloseReason string  `json:"close_reason"`
	RealizedPnL float64 `json:"realized_pnl"`
}

type TradeProfileRef struct {
	DocID     string `json:"doc_id"`
	ProfileID string `json:"profile_id"`
	Version   int    `json:"version"`
}

type TradeClaim struct {
	Attempts  int    `json:"attempts"`
	ClaimedAt string `json:"claimed_at"`
	Owner     string `json:"owner"`
}

type Submission struct {
	SubmittedAt      string `json:"submitted_at"`
	ExpiresAt        int64  `json:"expires_at"`
	RequestID        string `json:"request_id"`
	PendingExpiresAt *int64 `json:"pending_expires_at,omitempty"`
}

type CancelRequest struct {
	Reason         string `json:"reason"`
	At             string `json:"at"`
	EventID        string `json:"event_id"`
	MutationStatus string `json:"mutation_status,omitempty"`
}

// MutationIntent is persisted before a broker mutation and resolved from exact
// ticket state after an uncertain result.
type MutationIntent struct {
	Action                string         `json:"action"`
	Ticket                int64          `json:"ticket"`
	At                    string         `json:"at"`
	ExpiresAt             int64          `json:"expires_at"`
	PriorPrice            float64        `json:"prior_price,omitempty"`
	PriorSL               float64        `json:"prior_sl,omitempty"`
	PriorTP               float64        `json:"prior_tp,omitempty"`
	PriorVolume           float64        `json:"prior_volume,omitempty"`
	TargetPrice           float64        `json:"target_price,omitempty"`
	TargetSL              float64        `json:"target_sl,omitempty"`
	TargetTP              float64        `json:"target_tp,omitempty"`
	TargetRemainingVolume float64        `json:"target_remaining_volume,omitempty"`
	PartialConfirmed      bool           `json:"partial_confirmed,omitempty"`
	Reason                string         `json:"reason,omitempty"`
	EventID               string         `json:"event_id,omitempty"`
	SuccessPatch          map[string]any `json:"success_patch,omitempty"`
}

type RevisionIntent struct {
	Entry       SignalRevision `json:"entry"`
	Patch       map[string]any `json:"patch"`
	Reasons     []string       `json:"reasons"`
	SLFrom      *float64       `json:"sl_from,omitempty"`
	SLTo        *float64       `json:"sl_to,omitempty"`
	TargetKind  string         `json:"target_kind"`
	PriorPrice  float64        `json:"prior_price,omitempty"`
	PriorSL     float64        `json:"prior_sl,omitempty"`
	PriorTP     float64        `json:"prior_tp,omitempty"`
	TargetSL    float64        `json:"target_sl"`
	TargetTP    float64        `json:"target_tp"`
	TargetPrice float64        `json:"target_price,omitempty"`
}

type TradeSet struct {
	Schema             int               `json:"schema"`
	TradeSetID         string            `json:"trade_set_id"`
	ChatID             string            `json:"chat_id"`
	MessageID          string            `json:"message_id"`
	EventID            string            `json:"event_id"`
	Signal             Signal            `json:"signal"`
	SignalRevisions    []SignalRevision  `json:"signal_revisions"`
	Symbol             string            `json:"symbol"`
	BrokerSymbol       *string           `json:"broker_symbol"`
	Direction          Direction         `json:"direction"`
	OrderType          *string           `json:"order_type"`
	Mode               string            `json:"mode"`
	Broker             *string           `json:"broker"`
	Profile            *TradeProfileRef  `json:"profile"`
	ProfileSnapshot    *ExecutionProfile `json:"profile_snapshot"`
	LimitsSnapshot     *EffectiveLimits  `json:"limits_snapshot"`
	State              TradeState        `json:"state"`
	SkipReason         string            `json:"skip_reason,omitempty"`
	Error              string            `json:"error,omitempty"`
	CorrelationComment string            `json:"correlation_comment"`
	Claim              TradeClaim        `json:"claim"`
	Plan               *TradePlan        `json:"plan"`
	Submission         *Submission       `json:"submission"`
	BrokerRefs         *BrokerRefs       `json:"broker_refs"`
	Lifecycle          *TradeLifecycle   `json:"lifecycle"`
	Result             *TradeResult      `json:"result"`
	CancelRequested    *CancelRequest    `json:"cancel_requested,omitempty"`
	CloseRequestedBy   string            `json:"close_requested_by,omitempty"`
	CloseRequestStatus string            `json:"close_request_status,omitempty"`
	MutationIntent     *MutationIntent   `json:"mutation_intent,omitempty"`
	RevisionIntent     *RevisionIntent   `json:"revision_intent,omitempty"`
	CreatedAt          string            `json:"created_at"`
	UpdatedAt          string            `json:"updated_at"`
}

type SignalRevision struct {
	EventID    string `json:"event_id"`
	TextHash   string `json:"text_hash"`
	ReceivedAt string `json:"received_at"`
	Outcome    string `json:"outcome"`
	Reason     string `json:"reason"`
}

type TradeEvent struct {
	TradeSetID     string         `json:"trade_set_id"`
	EventKey       string         `json:"event_key"`
	Type           string         `json:"type"`
	Mode           string         `json:"mode,omitempty"`
	ProfileDocID   *string        `json:"profile_doc_id,omitempty"`
	ProfileVersion *int           `json:"profile_version,omitempty"`
	ReasonCode     string         `json:"reason_code,omitempty"`
	Message        string         `json:"message,omitempty"`
	OrderTicket    *int64         `json:"order_ticket,omitempty"`
	PositionTicket *int64         `json:"position_ticket,omitempty"`
	DealTicket     *int64         `json:"deal_ticket,omitempty"`
	Volume         *float64       `json:"volume,omitempty"`
	Price          *float64       `json:"price,omitempty"`
	SL             *float64       `json:"sl,omitempty"`
	TP             *float64       `json:"tp,omitempty"`
	RealizedPnL    *float64       `json:"realized_pnl,omitempty"`
	Retcode        *int           `json:"retcode,omitempty"`
	Details        map[string]any `json:"details,omitempty"`
}

type HandleResult struct {
	Outcome string     `json:"outcome"`
	State   TradeState `json:"state,omitempty"`
	Reason  string     `json:"reason,omitempty"`
}

type JSONDocument map[string]any

func CloneTradeSet(t TradeSet) TradeSet {
	b, _ := json.Marshal(t)
	var out TradeSet
	_ = json.Unmarshal(b, &out)
	return out
}

func TradeSetID(chatID, messageID string) string { return chatID + "_" + messageID }
