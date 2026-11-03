package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func (h *Handler) audit(tx *store.Tx, actor authenticatedUser, action, at string, details map[string]any) error {
	_, err := tx.Create("admin_audit", randomID(), store.Document{"action": action, "actor_uid": actor.UID, "actor_email": actor.Email, "at": at, "details": details})
	return err
}

func (h *Handler) postAdminPing(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) postRole(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireUser(w, r)
	if !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	doc, err := h.store.Get(r.Context(), "users", user.UID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, "Role lookup unavailable", http.StatusServiceUnavailable)
		return
	}
	role := stringField(doc, "role")
	if role == "" {
		role = "viewer"
	}
	writeJSON(w, http.StatusOK, map[string]any{"uid": user.UID, "role": role})
}

func (h *Handler) postEnsureUser(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireUser(w, r)
	if !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	created := false
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		_, err := tx.Get("users", user.UID)
		if err == nil {
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		created, err = tx.Create("users", user.UID, store.Document{"uid": user.UID, "email": user.Email, "role": "viewer", "created_at": at(h)})
		return err
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	doc, _ := h.store.Get(r.Context(), "users", user.UID)
	role := stringField(doc, "role")
	if role == "" {
		role = "viewer"
	}
	writeJSON(w, http.StatusOK, map[string]any{"uid": user.UID, "role": role, "created": created})
}

func (h *Handler) postSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	unknown := make([]string, 0)
	for key := range body {
		if key != "trading" && key != "telegram" {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		allHints := map[string]string{"execution": "use POST /api/execution/mode", "safety": "use POST /api/execution/safety", "trading.kill_switch": "use POST /api/execution/kill-switch", "trading.paper_mode": "paper mode is set with POST /api/execution/mode"}
		hints := map[string]string{}
		for _, key := range unknown {
			if hint, exists := allHints[key]; exists {
				hints[key] = hint
			}
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Unknown keys", "unknown": unknown, "hints": hints})
		return
	}
	issues := make([]map[string]string, 0)
	telegram := map[string]any{}
	if raw, exists := body["trading"]; exists {
		input, valid := raw.(map[string]any)
		if !valid {
			issues = append(issues, map[string]string{"path": "trading", "message": "must be an object"})
		} else {
			for key := range input {
				msg := "unknown key"
				switch key {
				case "kill_switch":
					msg = "not allowed here; use POST /api/execution/kill-switch"
				case "paper_mode":
					msg = "not allowed here; use POST /api/execution/mode"
				case "risk_mode", "risk_value", "max_open_positions", "max_positions_per_symbol", "max_signal_delay_sec", "slippage_tol", "tp1_skip_buffer", "bybit_optional", "mt5_optional":
					msg = "no longer used: sizing and limits come from the execution profile and safety limits"
				}
				issues = append(issues, map[string]string{"path": "trading." + key, "message": msg})
			}
		}
	}
	if raw, exists := body["telegram"]; exists {
		input, valid := raw.(map[string]any)
		if !valid {
			issues = append(issues, map[string]string{"path": "telegram", "message": "must be an object"})
		} else {
			for key := range input {
				value := input[key]
				switch key {
				case "allowed_chat_ids", "blocked_chat_ids":
					list, ok := value.([]any)
					good := ok
					out := make([]string, 0)
					seen := map[string]bool{}
					if ok {
						for _, v := range list {
							s, valid := v.(string)
							s = strings.TrimSpace(s)
							if !valid || s == "" || len(s) > 64 {
								good = false
								break
							}
							if !seen[s] {
								seen[s] = true
								out = append(out, s)
							}
						}
					}
					if good {
						telegram[key] = out
					} else {
						issues = append(issues, map[string]string{"path": "telegram." + key, "message": "must be an array of non-empty strings (max 64 chars)"})
					}
				case "chat_id_labels":
					labels, ok := value.(map[string]any)
					good := ok
					out := map[string]string{}
					if ok {
						for k, v := range labels {
							label, valid := v.(string)
							if k == "" || len(k) > 64 || !valid || len(label) > 120 {
								good = false
								break
							}
							out[k] = label
						}
					}
					if good {
						telegram[key] = out
					} else {
						issues = append(issues, map[string]string{"path": "telegram.chat_id_labels", "message": "must be an object of string keys to string labels"})
					}
				default:
					issues = append(issues, map[string]string{"path": "telegram." + key, "message": "unknown key"})
				}
			}
		}
	}
	if len(issues) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid settings", "issues": issues})
		return
	}
	if len(telegram) == 0 {
		writeError(w, "Nothing to update", http.StatusBadRequest)
		return
	}
	updated := make([]string, 0, len(telegram))
	for key := range telegram {
		updated = append(updated, "telegram."+key)
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		doc = store.Document(mergeMap(map[string]any(doc), map[string]any{"telegram": telegram}))
		if err := tx.Put("settings", "default", doc); err != nil {
			return err
		}
		return h.audit(tx, user, "settings.update", when, map[string]any{"patch": map[string]any{"telegram": telegram}})
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": updated})
}

func (h *Handler) postExecutionMode(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	mode, _ := body["mode"].(string)
	if mode != "disabled" && mode != "paper" && mode != "demo" && mode != "live" {
		writeError(w, "mode must be one of disabled, paper, demo, live", http.StatusBadRequest)
		return
	}
	confirm := map[string]string{"demo": "ENABLE DEMO TRADING", "live": "ENABLE LIVE TRADING"}[mode]
	if confirm != "" && body["confirm"] != confirm {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Typed confirmation required for " + mode, "required_confirm": confirm})
		return
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		setPath(doc, []string{"execution", "mode"}, mode)
		setPath(doc, []string{"execution", "updated_at"}, when)
		setPath(doc, []string{"execution", "updated_by"}, user.Email)
		if err := tx.Put("settings", "default", doc); err != nil {
			return err
		}
		return h.audit(tx, user, "execution.mode", when, map[string]any{"mode": mode})
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	response := map[string]any{"ok": true, "mode": mode, "updated_at": when}
	if mode == "live" {
		response["note"] = "Live entries also require BYTRADER_LIVE_TRADING=enabled in the worker environment. Without it the worker refuses new entries (live_not_enabled)."
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) postKillSwitch(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	engaged, valid := body["engaged"].(bool)
	if !valid {
		writeError(w, "engaged must be a boolean", http.StatusBadRequest)
		return
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		setPath(doc, []string{"trading", "kill_switch"}, engaged)
		if err := tx.Put("settings", "default", doc); err != nil {
			return err
		}
		return h.audit(tx, user, "kill_switch.set", when, map[string]any{"engaged": engaged})
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "kill_switch": engaged})
}

func (h *Handler) postSafety(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	result := domain.ValidateSafetyLimits(body)
	if !result.OK || result.Value == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid safety limits", "issues": result.Errors})
		return
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		doc["safety"] = result.Value
		if err := tx.Put("settings", "default", doc); err != nil {
			return err
		}
		return h.audit(tx, user, "safety.set", when, map[string]any{"safety": result.Value})
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "safety": result.Value, "warnings": result.Warnings})
}

func setPath(root map[string]any, keys []string, value any) {
	current := root
	for _, key := range keys[:len(keys)-1] {
		next := object(current[key])
		current[key] = next
		current = next
	}
	current[keys[len(keys)-1]] = value
}

func (h *Handler) postCloseAll(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	if body["confirm"] != "CLOSE ALL" {
		writeError(w, "Type CLOSE ALL to confirm", http.StatusBadRequest)
		return
	}
	id, when := randomID(), at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			settings = store.Document{}
		} else if err != nil {
			return err
		}
		setPath(settings, []string{"trading", "kill_switch"}, true)
		if err := tx.Put("settings", "default", settings); err != nil {
			return err
		}
		if _, err := tx.Create("admin_commands", id, store.Document{"type": "close_all", "status": "pending", "confirm": "CLOSE ALL", "requested_by_uid": user.UID, "requested_by_email": user.Email, "requested_at": when}); err != nil {
			return err
		}
		return h.audit(tx, user, "close_all.request", when, map[string]any{"command_id": id, "kill_switch_engaged": true})
	})
	if err != nil {
		writeError(w, "Write failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "id": id, "status": "pending"})
}

func (h *Handler) getCloseAll(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	id := r.URL.Query().Get("id")
	if len(id) < 1 || len(id) > 128 || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(id) {
		writeError(w, "Invalid id", http.StatusBadRequest)
		return
	}
	doc, err := h.store.Get(r.Context(), "admin_commands", id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, "Not found", http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "type": doc["type"], "status": doc["status"], "requested_at": doc["requested_at"], "requested_by_email": doc["requested_by_email"], "started_at": doc["started_at"], "finished_at": doc["finished_at"], "result": doc["result"]})
}

func (h *Handler) postAlertAction(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if len(id) < 1 || len(id) > 300 || !regexp.MustCompile(`^[A-Za-z0-9_.-]+$`).MatchString(id) {
		writeError(w, "Invalid alert id", http.StatusBadRequest)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	action, _ := body["action"].(string)
	if action != "acknowledge" && action != "resolve" {
		writeError(w, "action must be acknowledge or resolve", http.StatusBadRequest)
		return
	}
	note, _ := body["note"].(string)
	if len(note) > 300 {
		note = note[:300]
	}
	if strings.TrimSpace(note) == "" {
		note = ""
	}
	when := at(h)
	status := ""
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("alerts", id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		from := stringField(doc, "status")
		if action == "acknowledge" {
			if from == "resolved" {
				return &apiError{Status: 409, Message: "Alert is already resolved"}
			}
			doc = store.Document(mergeMap(map[string]any(doc), map[string]any{"status": "acknowledged", "acknowledged_by": user.Email, "acknowledged_at": when, "updated_at": when}))
			status = "acknowledged"
		} else {
			if from == "resolved" {
				status = "resolved"
				return nil
			}
			resolution := "operator"
			if note != "" {
				resolution += ": " + note
			}
			doc = store.Document(mergeMap(map[string]any(doc), map[string]any{"status": "resolved", "resolved_by": user.Email, "resolved_at": when, "resolution": resolution, "updated_at": when}))
			status = "resolved"
		}
		if err := tx.Put("alerts", id, doc); err != nil {
			return err
		}
		return h.audit(tx, user, "alert."+action, when, map[string]any{"alert_id": id, "type": nullable(doc["type"]), "from_status": from, "note": nullableString(note)})
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": status})
}

func (h *Handler) postSignalEventAction(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if len(id) < 1 || len(id) > 300 || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(id) {
		writeError(w, "Invalid event id", http.StatusBadRequest)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	action, _ := body["action"].(string)
	required := map[string]string{"requeue": "REQUEUE", "discard": "DISCARD"}[action]
	if required == "" {
		writeError(w, "action must be requeue or discard", http.StatusBadRequest)
		return
	}
	if body["confirm"] != required {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Type " + required + " to confirm", "required_confirm": required})
		return
	}
	note, _ := body["note"].(string)
	if len(note) > 200 {
		note = note[:200]
	}
	whenTime, when := h.now(), at(h)
	status := ""
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("signal_events", id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		state := object(doc["autotrader"])
		if stringField(state, "status") != "dead_letter" {
			return &apiError{Status: 409, Message: "Only dead-lettered events can be requeued or discarded", Extra: map[string]any{"status": nullableString(stringField(state, "status"))}}
		}
		if action == "requeue" {
			result, err := tx.RequeueDeadLetter(id, user.Email, whenTime)
			if err != nil {
				return err
			}
			if !result.Requeued {
				messages := map[string]string{"not_dead_letter": "Only dead-lettered events can be requeued", "superseded": "A later event of the same trade set was already handled; replaying this one would act out of order", "later_event_in_progress": "A later event of the same trade set is being handled right now"}
				return &apiError{Status: 409, Message: messages[result.Reason], Extra: map[string]any{"reason": result.Reason}}
			}
			status = "pending"
		} else {
			discarded, err := tx.DiscardDeadLetter(id, user.Email, note, whenTime)
			if err != nil {
				return err
			}
			if !discarded {
				return &apiError{Status: 409, Message: "Only dead-lettered events can be discarded"}
			}
			status = "discarded"
		}
		return h.audit(tx, user, "signal_event."+action, when, map[string]any{"event_id": id, "kind": nullable(doc["kind"]), "attempts": object(doc["autotrader"])["attempts"], "last_error": object(doc["autotrader"])["last_error"], "note": nullableString(note)})
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": status})
}

func (h *Handler) postTradeResolve(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !regexp.MustCompile(`^-?[0-9]{1,20}_[0-9]{1,20}$`).MatchString(id) {
		writeError(w, "Invalid trade set id", http.StatusBadRequest)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	resolution, _ := body["resolution"].(string)
	target, valid := map[string]struct{ state, code string }{"not_executed": {"REJECTED", "operator_resolved_not_executed"}, "handled_manually": {"ERROR", "operator_resolved_handled_manually"}}[resolution]
	if !valid {
		writeError(w, "resolution must be not_executed or handled_manually", http.StatusBadRequest)
		return
	}
	confirm := "RESOLVE " + id
	if body["confirm"] != confirm {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Type " + confirm + " to confirm", "required_confirm": confirm})
		return
	}
	note, _ := body["note"].(string)
	if len(note) > 300 {
		note = note[:300]
	}
	whenTime, when := h.now(), at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get("trade_sets", id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		if stringField(doc, "state") != "SUBMIT_UNKNOWN" {
			return &apiError{Status: 409, Message: "Only SUBMIT_UNKNOWN trade sets can be resolved by hand (state is " + stringField(doc, "state") + ")"}
		}
		submission := object(doc["submission"])
		expires, _ := intValue(submission["expires_at"])
		if expires == 0 {
			if n, ok := submission["expires_at"].(float64); ok {
				expires = int(n)
			}
		}
		if expires <= 0 || whenTime.Unix() < int64(expires)+120 {
			return &apiError{Status: 409, Message: "The request expired less than 120 s ago; wait for the reconciler"}
		}
		alertIDs := []string{"submit_unknown__" + id, "correlation_mismatch__" + id}
		alerts := make([]store.Document, len(alertIDs))
		exists := make([]bool, len(alertIDs))
		for i, alertID := range alertIDs {
			doc, err := tx.Get("alerts", alertID)
			if err == nil {
				alerts[i], exists[i] = doc, true
			} else if !errors.Is(err, store.ErrNotFound) {
				return err
			}
		}
		doc["state"], doc["error"], doc["updated_at"] = target.state, target.code, when
		doc["operator_resolution"] = map[string]any{"resolution": resolution, "by": user.Email, "at": when, "note": nullableString(note)}
		if err := tx.Put("trade_sets", id, doc); err != nil {
			return err
		}
		message := fmt.Sprintf("resolved by %s: %s", user.Email, resolution)
		if note != "" {
			message += " (" + note + ")"
		}
		if _, err := tx.Create("trade_events", id+"__operator_resolved", store.Document{"trade_set_id": id, "event_key": "operator_resolved", "type": "reconciliation", "mode": nullable(doc["mode"]), "reason_code": target.code, "message": message, "timestamp": when}); err != nil {
			return err
		}
		if err := h.audit(tx, user, "trade_set.resolve", when, map[string]any{"trade_set_id": id, "resolution": resolution, "from_state": "SUBMIT_UNKNOWN", "to_state": target.state, "note": nullableString(note)}); err != nil {
			return err
		}
		for i, alert := range alerts {
			if !exists[i] || stringField(alert, "status") == "resolved" {
				continue
			}
			alert = store.Document(mergeMap(map[string]any(alert), map[string]any{"status": "resolved", "resolved_by": user.Email, "resolved_at": when, "resolution": "operator: " + resolution, "updated_at": when}))
			if err := tx.Put("alerts", alertIDs[i], alert); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "state": target.state})
}
