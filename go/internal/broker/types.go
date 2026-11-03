package broker

import "context"

type Kind string

const (
	MT5       Kind = "mt5"
	Simulated Kind = "simulated"
)

type OrderSide string
type OrderType string

const (
	Buy        OrderSide = "BUY"
	Sell       OrderSide = "SELL"
	MarketBuy  OrderType = "BUY"
	MarketSell OrderType = "SELL"
	BuyLimit   OrderType = "BUY_LIMIT"
	SellLimit  OrderType = "SELL_LIMIT"
	BuyStop    OrderType = "BUY_STOP"
	SellStop   OrderType = "SELL_STOP"
)

type TradeMode string

const (
	Demo    TradeMode = "DEMO"
	Contest TradeMode = "CONTEST"
	Real    TradeMode = "REAL"
)

type AccountInfo struct {
	Login                int64     `json:"login"`
	TradeMode            TradeMode `json:"tradeMode"`
	MarginMode           string    `json:"marginMode"`
	Currency             string    `json:"currency"`
	Balance              float64   `json:"balance"`
	Equity               float64   `json:"equity"`
	Margin               float64   `json:"margin"`
	MarginFree           float64   `json:"marginFree"`
	MarginLevel          float64   `json:"marginLevel"`
	Leverage             int       `json:"leverage"`
	TradeAllowed         bool      `json:"tradeAllowed"`
	TradeExpert          bool      `json:"tradeExpert"`
	TerminalTradeAllowed bool      `json:"terminalTradeAllowed"`
	Server               string    `json:"server"`
	Company              string    `json:"company"`
}

type SymbolInfo struct {
	Symbol            string  `json:"symbol"`
	Digits            int     `json:"digits"`
	Point             float64 `json:"point"`
	TickSize          float64 `json:"tickSize"`
	TickValue         float64 `json:"tickValue"`
	TickValueProfit   float64 `json:"tickValueProfit"`
	TickValueLoss     float64 `json:"tickValueLoss"`
	ContractSize      float64 `json:"contractSize"`
	VolumeMin         float64 `json:"volumeMin"`
	VolumeMax         float64 `json:"volumeMax"`
	VolumeStep        float64 `json:"volumeStep"`
	VolumeLimit       float64 `json:"volumeLimit"`
	StopsLevelPoints  float64 `json:"stopsLevelPoints"`
	FreezeLevelPoints float64 `json:"freezeLevelPoints"`
	TradeMode         string  `json:"tradeMode"`
	FillingFOK        bool    `json:"fillingFok"`
	FillingIOC        bool    `json:"fillingIoc"`
	Bid               float64 `json:"bid"`
	Ask               float64 `json:"ask"`
	SpreadPoints      float64 `json:"spreadPoints"`
	TickTimeMsc       int64   `json:"tickTimeMsc"`
	CurrencyProfit    string  `json:"currencyProfit"`
	CurrencyMargin    string  `json:"currencyMargin"`
}

type Position struct {
	Ticket       int64     `json:"ticket"`
	Identifier   int64     `json:"identifier"`
	Symbol       string    `json:"symbol"`
	Type         OrderSide `json:"type"`
	Volume       float64   `json:"volume"`
	OpenPrice    float64   `json:"openPrice"`
	PriceCurrent float64   `json:"priceCurrent"`
	SL           float64   `json:"sl"`
	TP           float64   `json:"tp"`
	Profit       float64   `json:"profit"`
	Swap         float64   `json:"swap"`
	Magic        int64     `json:"magic"`
	Comment      string    `json:"comment"`
	TimeOpen     int64     `json:"timeOpen"`
}

type Order struct {
	Ticket         int64     `json:"ticket"`
	Symbol         string    `json:"symbol"`
	Type           OrderType `json:"type"`
	VolumeInitial  float64   `json:"volumeInitial"`
	VolumeCurrent  float64   `json:"volumeCurrent"`
	PriceOpen      float64   `json:"priceOpen"`
	SL             float64   `json:"sl"`
	TP             float64   `json:"tp"`
	Magic          int64     `json:"magic"`
	Comment        string    `json:"comment"`
	TimeSetup      int64     `json:"timeSetup"`
	TimeExpiration int64     `json:"timeExpiration"`
}

type Deal struct {
	Ticket     int64     `json:"ticket"`
	Order      int64     `json:"order"`
	PositionID int64     `json:"positionId"`
	Symbol     string    `json:"symbol"`
	Type       OrderSide `json:"type"`
	Entry      string    `json:"entry"`
	Volume     float64   `json:"volume"`
	Price      float64   `json:"price"`
	Profit     float64   `json:"profit"`
	Commission float64   `json:"commission"`
	Swap       float64   `json:"swap"`
	Fee        float64   `json:"fee"`
	Magic      int64     `json:"magic"`
	Comment    string    `json:"comment"`
	Time       int64     `json:"time"`
	Reason     string    `json:"reason"`
}

type PlaceOrderRequest struct {
	Symbol          string    `json:"symbol"`
	OrderType       OrderType `json:"orderType"`
	Volume          float64   `json:"volume"`
	Price           float64   `json:"price"`
	SL              float64   `json:"sl"`
	TP              float64   `json:"tp"`
	DeviationPoints int       `json:"deviationPoints"`
	Comment         string    `json:"comment"`
	ExpirationGMT   *int64    `json:"expiration,omitempty"`
}

type PlaceOrderResult struct {
	Retcode           int     `json:"retcode"`
	OrderTicket       int64   `json:"orderTicket"`
	DealTicket        int64   `json:"dealTicket"`
	PositionTicket    int64   `json:"positionTicket"`
	Price             float64 `json:"price"`
	Volume            float64 `json:"volume"`
	Duplicate         bool    `json:"duplicate"`
	ExpirationApplied *bool   `json:"expirationApplied,omitempty"`
}

type CloseResult struct {
	Retcode         int     `json:"retcode"`
	DealTicket      int64   `json:"dealTicket"`
	ClosedVolume    float64 `json:"closedVolume"`
	Price           float64 `json:"price"`
	RemainingVolume float64 `json:"remainingVolume"`
}

type OrderCheckResult struct {
	OK         bool    `json:"ok"`
	Retcode    int     `json:"retcode"`
	Margin     float64 `json:"margin"`
	MarginFree float64 `json:"marginFree"`
	Comment    string  `json:"comment"`
}

type PingInfo struct {
	EAVersion         string `json:"eaVersion"`
	TerminalConnected bool   `json:"terminalConnected"`
	TradeAllowed      bool   `json:"tradeAllowed"`
	GMTTime           int64  `json:"gmtTime"`
	ServerTime        int64  `json:"serverTime"`
	ServerTimeSource  string `json:"serverTimeSource"`
}

type DealQuery struct {
	FromSec    int64
	ToSec      *int64
	PositionID *int64
}

type Broker interface {
	Kind() Kind
	Magic() int64
	Ping(context.Context) (PingInfo, error)
	GetAccountInfo(context.Context) (AccountInfo, error)
	GetSymbolInfo(context.Context, string) (SymbolInfo, error)
	GetPositions(context.Context, string) ([]Position, error)
	GetOrders(context.Context, string) ([]Order, error)
	GetDeals(context.Context, DealQuery) ([]Deal, error)
	CheckOrder(context.Context, PlaceOrderRequest) (OrderCheckResult, error)
	PlaceOrder(context.Context, PlaceOrderRequest) (PlaceOrderResult, error)
	ModifyPosition(context.Context, int64, float64, float64) (retcode int, unchanged bool, err error)
	ModifyPendingOrder(context.Context, int64, float64, float64, float64) (retcode int, err error)
	ClosePosition(context.Context, int64, *float64) (CloseResult, error)
	CancelOrder(context.Context, int64) (retcode int, err error)
}

type RejectedError struct {
	Retcode int
	Message string
}

func (e *RejectedError) Error() string { return e.Message }

type AmbiguousError struct {
	Action    string
	RequestID string
	ExpiresAt *int64
	Message   string
}

func (e *AmbiguousError) Error() string { return e.Message }

type UnavailableError struct {
	Action  string
	Message string
}

func (e *UnavailableError) Error() string { return e.Message }
