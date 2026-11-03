package domain

import (
	"encoding/json"
	"fmt"
	"math"
)

type EntryDecision struct {
	OK            bool    `json:"ok"`
	OrderType     string  `json:"orderType,omitempty"`
	OrderPrice    float64 `json:"orderPrice,omitempty"`
	EntryRefPrice float64 `json:"entryRefPrice,omitempty"`
	IsPending     bool    `json:"isPending,omitempty"`
	Reason        string  `json:"reason,omitempty"`
	Detail        string  `json:"detail,omitempty"`
}

type StopLossCheck struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
}

func (d EntryDecision) MarshalJSON() ([]byte, error) {
	if d.OK {
		return json.Marshal(struct {
			OK            bool    `json:"ok"`
			OrderType     string  `json:"orderType"`
			OrderPrice    float64 `json:"orderPrice"`
			EntryRefPrice float64 `json:"entryRefPrice"`
			IsPending     bool    `json:"isPending"`
		}{true, d.OrderType, d.OrderPrice, d.EntryRefPrice, d.IsPending})
	}
	return json.Marshal(struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Detail string `json:"detail"`
	}{false, d.Reason, d.Detail})
}

func (c StopLossCheck) MarshalJSON() ([]byte, error) {
	if c.OK {
		return json.Marshal(struct {
			OK bool `json:"ok"`
		}{true})
	}
	return json.Marshal(struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Detail string `json:"detail"`
	}{false, c.Reason, c.Detail})
}

func DecideEntry(signal Signal, bid, ask float64, entry EntryConfig) EntryDecision {
	if !(bid > 0) || !(ask > 0) || math.IsNaN(bid) || math.IsNaN(ask) || math.IsInf(bid, 0) || math.IsInf(ask, 0) || ask < bid {
		return EntryDecision{Reason: "invalid_quote", Detail: fmt.Sprintf("invalid quote bid=%s ask=%s", formatNum(bid), formatNum(ask))}
	}
	buy := signal.Direction == Buy
	price := bid
	if buy {
		price = ask
	}
	low, high, tol := signal.EntryLow, signal.EntryHigh, entry.MarketTolerancePrice
	inRange := price >= low-tol && price <= high+tol
	marketSide := "SELL"
	if buy {
		marketSide = "BUY"
	}
	market := func() EntryDecision { return EntryDecision{OK: true, OrderType: marketSide, EntryRefPrice: price} }
	outside := func() EntryDecision {
		return EntryDecision{Reason: "price_outside_entry_range", Detail: fmt.Sprintf("price %s outside [%s, %s]", formatNum(price), formatNum(low-tol), formatNum(high+tol))}
	}

	if signal.OrderType == MarketOrder {
		if inRange {
			return market()
		}
		if entry.Policy == PendingAtRange {
			if buy && price > high+tol {
				return pendingDecision("BUY_LIMIT", high)
			}
			if !buy && price < low-tol {
				return pendingDecision("SELL_LIMIT", low)
			}
		}
		return outside()
	}

	orderSide := map[SignalOrderType]string{BuyLimit: "buy", SellLimit: "sell", BuyStop: "buy", SellStop: "sell"}[signal.OrderType]
	if orderSide == "" {
		return EntryDecision{Reason: "invalid_pending_price", Detail: "unknown order type " + string(signal.OrderType)}
	}
	if (orderSide == "buy") != buy {
		return EntryDecision{Reason: "invalid_pending_price", Detail: fmt.Sprintf("order type %s disagrees with direction %s", signal.OrderType, signal.Direction)}
	}
	if entry.Policy == MarketOnly {
		if entry.AllowMarketFallback && inRange {
			return market()
		}
		return EntryDecision{Reason: "pending_not_allowed", Detail: fmt.Sprintf("policy market_only does not place %s", signal.OrderType)}
	}

	typeName := stringsUpperOrder(signal.OrderType)
	pendingPrice, valid := pendingPriceFor(typeName, low, high, bid, ask)
	if valid {
		return pendingDecision(typeName, pendingPrice)
	}
	if entry.AllowMarketFallback && inRange {
		return market()
	}
	return EntryDecision{Reason: "invalid_pending_price", Detail: fmt.Sprintf("%s at %s is not valid against bid=%s ask=%s", typeName, formatNum(pendingPrice), formatNum(bid), formatNum(ask))}
}

func stringsUpperOrder(t SignalOrderType) string {
	switch t {
	case BuyLimit:
		return "BUY_LIMIT"
	case SellLimit:
		return "SELL_LIMIT"
	case BuyStop:
		return "BUY_STOP"
	case SellStop:
		return "SELL_STOP"
	default:
		return ""
	}
}

func pendingPriceFor(orderType string, low, high, bid, ask float64) (float64, bool) {
	switch orderType {
	case "BUY_LIMIT":
		return high, high < ask
	case "SELL_LIMIT":
		return low, low > bid
	case "BUY_STOP":
		return low, low > ask
	case "SELL_STOP":
		return high, high < bid
	default:
		return 0, false
	}
}

func pendingDecision(orderType string, price float64) EntryDecision {
	return EntryDecision{OK: true, OrderType: orderType, OrderPrice: price, EntryRefPrice: price, IsPending: true}
}

func ValidateStopLoss(direction Direction, entryPrice, stopLoss float64, cfg StopLossConfig) StopLossCheck {
	if math.IsNaN(stopLoss) || math.IsNaN(entryPrice) || math.IsInf(stopLoss, 0) || math.IsInf(entryPrice, 0) {
		return StopLossCheck{Reason: "sl_wrong_side", Detail: fmt.Sprintf("non-finite entry %s or stop %s", formatNum(entryPrice), formatNum(stopLoss))}
	}
	correct := direction == Buy && stopLoss < entryPrice || direction == Sell && stopLoss > entryPrice
	if !correct {
		side := "above"
		if direction == Buy {
			side = "below"
		}
		return StopLossCheck{Reason: "sl_wrong_side", Detail: fmt.Sprintf("%s stop %s must be %s entry %s", direction, formatNum(stopLoss), side, formatNum(entryPrice))}
	}
	distance := math.Abs(entryPrice - stopLoss)
	if distance < cfg.MinDistancePrice {
		return StopLossCheck{Reason: "sl_too_close", Detail: fmt.Sprintf("stop distance %s below min %s", formatNum(distance), formatNum(cfg.MinDistancePrice))}
	}
	if distance > cfg.MaxDistancePrice {
		return StopLossCheck{Reason: "sl_too_far", Detail: fmt.Sprintf("stop distance %s above max %s", formatNum(distance), formatNum(cfg.MaxDistancePrice))}
	}
	return StopLossCheck{OK: true}
}
