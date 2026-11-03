package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/store"
	"github.com/bytrader/bytrader/internal/telegram"
)

const (
	telegramLegacyWait      = 10 * time.Second
	telegramCommandPoll     = 100 * time.Millisecond
	telegramOwnerCollection = "telegram_state"
	telegramOwnerDocument   = "session_owner"
)

var errTelegramForwarderUnavailable = errors.New("Telegram forwarder unavailable")

func (h *Handler) getTelegramStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	id := r.URL.Query().Get("command_id")
	if id != "" {
		if len(id) > 128 || strings.ContainsAny(id, "/\\") {
			writeError(w, "Invalid command id", 400)
			return
		}
		doc, err := h.store.Get(r.Context(), "telegram_commands", id)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, "Not found", 404)
			return
		}
		if err != nil {
			writeError(w, "Read failed", 503)
			return
		}
		result := object(doc["result"])
		writeJSON(w, 200, map[string]any{"id": id, "command_status": doc["status"], "status": nullableString(stringField(result, "status")), "phone": nullable(result["phone_masked"]), "lastError": nullable(result["last_error"]), "reauthRequired": boolField(result, "reauth_required"), "result": result})
		return
	}
	doc, err := h.store.Get(r.Context(), "telegram_state", "status")
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, 200, map[string]any{"status": "disconnected", "phone": nil, "lastError": nil, "reauthRequired": false})
		return
	}
	if err != nil {
		writeError(w, "Read failed", 503)
		return
	}
	writeJSON(w, 200, map[string]any{"status": nullableString(stringField(doc, "status")), "phone": nullable(doc["phone_masked"]), "lastError": nullable(doc["last_error"]), "reauthRequired": boolField(doc, "reauth_required"), "updated_at": nullable(doc["updated_at"]), "last_command_id": nullable(doc["last_command_id"])})
}

func (h *Handler) postTelegramStart(w http.ResponseWriter, r *http.Request) {
	h.enqueueTelegram(w, r, "start_login", "phone")
}
func (h *Handler) postTelegramOTP(w http.ResponseWriter, r *http.Request) {
	h.enqueueTelegram(w, r, "verify_otp", "code")
}
func (h *Handler) postTelegramPassword(w http.ResponseWriter, r *http.Request) {
	h.enqueueTelegram(w, r, "verify_password", "password")
}
func (h *Handler) postTelegramLogout(w http.ResponseWriter, r *http.Request) {
	h.enqueueTelegram(w, r, "logout", "")
}

func (h *Handler) enqueueTelegram(w http.ResponseWriter, r *http.Request, commandType, secretField string) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	respondAsync := prefersRespondAsync(r)
	body := map[string]any{}
	if secretField != "" {
		var ok bool
		body, ok = readObject(w, r)
		if !ok {
			return
		}
	}
	payload := map[string]string{}
	if secretField != "" {
		secret, valid := body[secretField].(string)
		if !valid || strings.TrimSpace(secret) == "" {
			writeError(w, "Missing "+secretField, http.StatusBadRequest)
			return
		}
		if secretField != "password" {
			secret = strings.TrimSpace(secret)
		}
		if len(secret) > 1024 {
			writeError(w, "Invalid "+secretField, http.StatusBadRequest)
			return
		}
		payload[secretField] = secret
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		writeError(w, "Invalid request", 400)
		return
	}
	ciphertext, err := telegram.EncryptCommandPayload(encoded)
	if err != nil {
		writeError(w, "Telegram command encryption unavailable", 503)
		return
	}
	id, when := randomID(), at(h)
	err = h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		if !respondAsync {
			owner, err := tx.Get(telegramOwnerCollection, telegramOwnerDocument)
			if errors.Is(err, store.ErrNotFound) || err == nil && !telegramOwnerLeaseCurrent(owner, h.now()) {
				return errTelegramForwarderUnavailable
			}
			if err != nil {
				return err
			}
		}
		created, err := tx.Create("telegram_commands", id, store.Document{"type": commandType, "status": "pending", "actor_uid": user.UID, "payload_enc": ciphertext, "created_at": when, "updated_at": when})
		if err != nil {
			return err
		}
		if !created {
			return errors.New("Telegram command ID collision")
		}
		return h.audit(tx, user, "telegram."+commandType, when, map[string]any{"command_id": id, "type": commandType})
	})
	if err != nil {
		if errors.Is(err, errTelegramForwarderUnavailable) {
			writeError(w, "Telegram forwarder unavailable", http.StatusServiceUnavailable)
			return
		}
		writeError(w, "Command could not be queued", 503)
		return
	}
	if respondAsync {
		w.Header().Set("Preference-Applied", "respond-async")
		writeTelegramAccepted(w, id, "pending")
		return
	}

	doc, completed, err := h.waitTelegramCommand(r.Context(), id)
	if err != nil || !completed {
		status := stringField(doc, "status")
		if status == "" {
			status = "pending"
		}
		w.Header().Set("Retry-After", "1")
		writeTelegramAccepted(w, id, status)
		return
	}
	h.writeLegacyTelegramResult(w, commandType, doc)
}

func prefersRespondAsync(r *http.Request) bool {
	for _, header := range r.Header.Values("Prefer") {
		for _, preference := range strings.Split(header, ",") {
			if strings.EqualFold(strings.TrimSpace(preference), "respond-async") {
				return true
			}
		}
	}
	return false
}

func telegramOwnerLeaseCurrent(owner store.Document, now time.Time) bool {
	if stringField(owner, "owner_id") == "" {
		return false
	}
	expires, err := time.Parse(time.RFC3339Nano, stringField(owner, "lease_expires_at"))
	return err == nil && expires.After(now)
}

func writeTelegramAccepted(w http.ResponseWriter, id, status string) {
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "command_id": id, "status": status})
}

func (h *Handler) waitTelegramCommand(ctx context.Context, id string) (store.Document, bool, error) {
	deadline := time.NewTimer(telegramLegacyWait)
	defer deadline.Stop()
	poll := time.NewTicker(telegramCommandPoll)
	defer poll.Stop()
	var latest store.Document
	for {
		doc, err := h.store.Get(ctx, "telegram_commands", id)
		if err == nil {
			latest = doc
			status := stringField(doc, "status")
			if status == "done" || status == "error" {
				return doc, true, nil
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			return latest, false, err
		}
		select {
		case <-ctx.Done():
			return latest, false, ctx.Err()
		case <-deadline.C:
			return latest, false, nil
		case <-poll.C:
		}
	}
}

func (h *Handler) writeLegacyTelegramResult(w http.ResponseWriter, commandType string, command store.Document) {
	if stringField(command, "status") == "error" {
		message, status := legacyTelegramError(commandType)
		writeError(w, message, status)
		return
	}
	result := object(command["result"])
	if commandType == "logout" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "disconnected"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": stringField(result, "status"), "phone": nullable(result["phone_masked"]),
		"lastError": nullable(result["last_error"]), "reauthRequired": boolField(result, "reauth_required"),
	})
}

func legacyTelegramError(commandType string) (string, int) {
	switch commandType {
	case "start_login":
		return "Failed to start login", http.StatusInternalServerError
	case "verify_otp":
		return "OTP not accepted", http.StatusBadRequest
	case "verify_password":
		return "Password not accepted", http.StatusBadRequest
	case "logout":
		return "Failed to log out", http.StatusInternalServerError
	default:
		return "Telegram command failed", http.StatusInternalServerError
	}
}
