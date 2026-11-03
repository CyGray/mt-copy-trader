package httpapi

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func (h *Handler) settingsDoc(r *http.Request) (store.Document, error) {
	if h.store == nil {
		return nil, store.ErrInvalidCollection
	}
	doc, err := h.store.Get(r.Context(), "settings", "default")
	if err == store.ErrNotFound {
		return store.Document{}, nil
	}
	return doc, err
}

func safeSettings(doc map[string]any) map[string]any {
	return map[string]any{
		"execution": object(doc["execution"]),
		"trading":   map[string]any{"kill_switch": boolField(object(doc["trading"]), "kill_switch")},
		"safety":    doc["safety"],
		"telegram": func() map[string]any {
			t := object(doc["telegram"])
			out := map[string]any{}
			for _, key := range []string{"allowed_chat_ids", "blocked_chat_ids", "chat_id_labels"} {
				if v, ok := t[key]; ok {
					out[key] = v
				}
			}
			return out
		}(),
	}
}

func (h *Handler) getSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	doc, err := h.settingsDoc(r)
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	result := safeSettings(doc)
	result["as_of"] = at(h)
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) getExecutionStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	doc, err := h.settingsDoc(r)
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	execution := object(doc["execution"])
	trading := object(doc["trading"])
	storedSafety := doc["safety"]
	safety := any(domain.DefaultSafetyLimits)
	safetySource := "default"
	var safetyErrors []domain.ValidationIssue
	if storedSafety != nil {
		safetySource = "stored"
		check := domain.ValidateSafetyLimits(storedSafety)
		safety = storedSafety
		if !check.OK {
			safetyErrors = check.Errors
		}
	}
	var active any
	if id := stringField(execution, "active_profile_doc_id"); id != "" {
		active = id
	}
	mode := stringField(execution, "mode")
	if mode == "" {
		mode = "disabled"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"execution": map[string]any{"mode": mode, "active_profile_doc_id": active, "updated_at": nullable(execution["updated_at"]), "updated_by": nullable(execution["updated_by"])},
		"trading":   map[string]any{"kill_switch": boolField(trading, "kill_switch")},
		"safety":    safety, "safety_source": safetySource, "safety_errors": safetyErrors, "active_profile_doc_id": active,
	})
}

func nullable(v any) any {
	if v == nil {
		return nil
	}
	return v
}

func (h *Handler) getTrades(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	limit := queryLimit(r, 200, 1000)
	cursor, err := decodeCursor(r.URL.Query().Get("cursor"), store.CreatedAt, true)
	if err != nil {
		writeError(w, "Invalid cursor", http.StatusBadRequest)
		return
	}
	items, next, ok := h.listPage(w, r, "trade_sets", store.ListOptions{TimeField: store.CreatedAt, Descending: true, After: cursor}, limit)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": nullableString(next), "as_of": at(h)})
}

func intPtr(v int) *int { return &v }
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (h *Handler) getTradeEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeError(w, "Invalid trade set id", http.StatusBadRequest)
		return
	}
	limit := queryLimit(r, 200, 200)
	cursor, err := decodeCursor(r.URL.Query().Get("cursor"), store.Timestamp, false)
	if err != nil {
		writeError(w, "Invalid cursor", http.StatusBadRequest)
		return
	}
	items, next, ok := h.listPage(w, r, "trade_events", store.ListOptions{Filters: []store.Filter{{Field: store.TradeSetIDField, Values: []string{id}}}, TimeField: store.Timestamp, After: cursor}, limit)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": nullableString(next), "as_of": at(h)})
}

func (h *Handler) getLogs(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "system" && kind != "telegram" {
		writeError(w, "kind must be system or telegram", http.StatusBadRequest)
		return
	}
	collection, field := "system_logs", store.Timestamp
	if kind == "telegram" {
		collection, field = "telegram_messages", store.Timestamp
	}
	limit := queryLimit(r, 200, 1000)
	cursor, err := decodeCursor(r.URL.Query().Get("cursor"), field, true)
	if err != nil {
		writeError(w, "Invalid cursor", http.StatusBadRequest)
		return
	}
	items, next, ok := h.listPage(w, r, collection, store.ListOptions{TimeField: field, Descending: true, After: cursor}, limit)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": nullableString(next), "as_of": at(h)})
}

func (h *Handler) getTelegramMessages(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	limit := queryLimit(r, 12, 200)
	cursor, err := decodeCursor(r.URL.Query().Get("cursor"), store.Timestamp, true)
	if err != nil {
		writeError(w, "Invalid cursor", http.StatusBadRequest)
		return
	}
	items, next, ok := h.listPage(w, r, "telegram_messages", store.ListOptions{TimeField: store.Timestamp, Descending: true, After: cursor}, limit)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": nullableString(next), "as_of": at(h)})
}

func (h *Handler) getOverview(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	trades, _, ok := h.listPage(w, r, "trade_sets", store.ListOptions{TimeField: store.CreatedAt, Descending: true, Schema: intPtr(2)}, 20)
	if !ok {
		return
	}
	logs, _, ok := h.listPage(w, r, "system_logs", store.ListOptions{TimeField: store.Timestamp, Descending: true}, 20)
	if !ok {
		return
	}
	messages, next, ok := h.listPage(w, r, "telegram_messages", store.ListOptions{TimeField: store.Timestamp, Descending: true}, 12)
	if !ok {
		return
	}
	settings, err := h.settingsDoc(r)
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"as_of":  at(h),
		"trades": map[string]any{"items": trades}, "system_logs": map[string]any{"items": logs},
		"telegram_messages": map[string]any{"items": messages, "next_cursor": nullableString(next)}, "settings": safeSettings(settings),
	})
}

func (h *Handler) getWorkerHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	forwarder, fErr := h.store.Get(r.Context(), "service_status", "forwarder")
	executor, eErr := h.store.Get(r.Context(), "service_status", "executor")
	telegramStatus, telegramErr := h.store.Get(r.Context(), "telegram_state", "status")
	forwarderHealth := serviceHealth(forwarder, fErr, h.now())
	executorHealth := serviceHealth(executor, eErr, h.now())
	status := "ok"
	if forwarderHealth["status"] != "ok" || executorHealth["status"] != "ok" {
		status = "error"
	}
	telegram := "disconnected"
	if forwarderHealth["status"] == "ok" && telegramErr == nil {
		telegram = stringField(telegramStatus, "status")
		if telegram == "" {
			telegram = "disconnected"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "data": map[string]any{"status": forwarderHealth["status"], "service": "forwarder", "telegram": telegram, "forwarder": forwarderHealth, "executor": executorHealth}})
}

func serviceHealth(doc store.Document, err error, nowTime time.Time) map[string]any {
	if err != nil {
		return map[string]any{"status": "offline"}
	}
	updatedAt := stringField(doc, "updated_at")
	updated, ok := parseISO(updatedAt)
	healthy := boolField(doc, "healthy") && ok && !updated.Before(nowTime.Add(-30*time.Second)) && !updated.After(nowTime.Add(5*time.Second))
	status := "offline"
	if healthy {
		status = "ok"
	}
	issues := doc["issues"]
	if issues == nil {
		issues = []any{}
	}
	return map[string]any{"status": status, "updated_at": nullableString(updatedAt), "started_at": nullable(doc["started_at"]), "issues": issues, "details": object(doc["details"])}
}

func (h *Handler) getAlerts(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "active"
	}
	statuses := map[string][]string{"active": {"open", "acknowledged"}, "open": {"open"}, "acknowledged": {"acknowledged"}, "resolved": {"resolved"}}[view]
	if statuses == nil {
		writeError(w, "view must be one of active, open, acknowledged, resolved", http.StatusBadRequest)
		return
	}
	if !h.requireStore(w) {
		return
	}
	all := make([]map[string]any, 0, 200)
	for _, status := range statuses {
		docs, err := h.store.List(r.Context(), "alerts", store.ListOptions{Filters: []store.Filter{{Field: store.StatusField, Values: []string{status}}}, TimeField: store.LastSeenAt, Descending: true, Limit: 201})
		if err != nil {
			writeError(w, "Read failed", http.StatusServiceUnavailable)
			return
		}
		for _, d := range docs {
			all = append(all, publicDocument(d))
		}
	}
	sort.Slice(all, func(i, j int) bool {
		ri, rj := severityRank(stringField(all[i], "severity")), severityRank(stringField(all[j], "severity"))
		if ri != rj {
			return ri > rj
		}
		if stringField(all[i], "last_seen_at") != stringField(all[j], "last_seen_at") {
			return stringField(all[i], "last_seen_at") > stringField(all[j], "last_seen_at")
		}
		return stringField(all[i], "id") > stringField(all[j], "id")
	})
	truncated := len(all) > 200
	if len(all) > 200 {
		all = all[:200]
	}
	writeJSON(w, http.StatusOK, map[string]any{"view": view, "alerts": all, "truncated": truncated})
}

func severityRank(value string) int {
	switch strings.ToLower(value) {
	case "critical":
		return 4
	case "error":
		return 3
	case "warning":
		return 2
	case "info":
		return 1
	default:
		return 0
	}
}

func (h *Handler) getSignalEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "dead_letter"
	}
	statuses := map[string][]string{"dead_letter": {"dead_letter"}, "active": {"pending", "processing", "retry_wait"}, "discarded": {"discarded"}}[view]
	if statuses == nil {
		writeError(w, "view must be one of dead_letter, active, discarded", http.StatusBadRequest)
		return
	}
	if !h.requireStore(w) {
		return
	}
	docs, err := h.store.List(r.Context(), "signal_events", store.ListOptions{Filters: []store.Filter{{Field: store.QueueStatusField, Values: statuses}}, TimeField: store.CreatedAt, Limit: 201})
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	truncated := len(docs) > 200
	if len(docs) > 200 {
		docs = docs[:200]
	}
	events := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		data := publicDocument(doc)
		queue := object(data["autotrader"])
		events = append(events, map[string]any{"id": data["id"], "chat_id": data["chat_id"], "message_id": data["message_id"], "kind": data["kind"], "message_type": data["message_type"], "cancel_reason": data["cancel_reason"], "signal": data["signal"], "created_at": data["created_at"], "spooled_at": data["spooled_at"], "queue": queue})
	}
	writeJSON(w, http.StatusOK, map[string]any{"view": view, "events": events, "truncated": truncated})
}
