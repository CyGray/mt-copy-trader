package notify

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

//go:embed actions.json
var actionJSON []byte

var actions = func() map[string]string {
	var result map[string]string
	_ = json.Unmarshal(actionJSON, &result)
	return result
}()
var subjectCharacters = regexp.MustCompile(`[^A-Za-z0-9_.-]`)
var secretKeys = regexp.MustCompile(`(?i)token|secret|passw|private|api[_-]?key|session|authorization|credential|cookie|otp|phone`)
var secretValues = []*regexp.Regexp{
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]+-----.*?-----END [A-Z ]+-----`),
	regexp.MustCompile(`\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b`),
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`\b(?:sk|pk|rk)_[A-Za-z0-9]{16,}\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`),
}

type Alert struct {
	Type, Subject, Severity, Source, Title, Message, Action string
	Details                                                 map[string]any
}
type memo struct {
	at       time.Time
	severity string
	pending  int
}
type Manager struct {
	Store    store.Store
	Client   *http.Client
	Now      func() time.Time
	mu       sync.Mutex
	recent   map[string]memo
	notified map[string]time.Time
}

func New(db store.Store) *Manager {
	return &Manager{Store: db, Client: &http.Client{Timeout: 5 * time.Second}, Now: time.Now, recent: map[string]memo{}, notified: map[string]time.Time{}}
}
func Rank(value string) int {
	return map[string]int{"info": 0, "warning": 1, "error": 2, "critical": 3}[value]
}
func ID(kind, subject string) string {
	subject = truncate(subjectCharacters.ReplaceAllString(subject, "_"), 200)
	if subject == "" {
		return kind
	}
	return kind + "__" + subject
}
func Redact(value string) string {
	for _, pattern := range secretValues {
		value = pattern.ReplaceAllString(value, "[redacted]")
	}
	return value
}
func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

func Sanitize(details map[string]any) map[string]any {
	data, err := json.Marshal(details)
	if err != nil {
		return map[string]any{}
	}
	var input map[string]any
	if json.Unmarshal(data, &input) != nil {
		return map[string]any{}
	}
	return sanitizeMap(input, 0)
}
func sanitizeMap(input map[string]any, depth int) map[string]any {
	out := map[string]any{}
	for key, value := range input {
		if len(out) >= 30 {
			break
		}
		if !secretKeys.MatchString(key) {
			out[key] = sanitizeValue(value, depth)
		}
	}
	return out
}
func sanitizeValue(value any, depth int) any {
	switch v := value.(type) {
	case string:
		return truncate(Redact(v), 500)
	case nil, bool, float64:
		return v
	}
	if depth >= 3 {
		return "[truncated]"
	}
	switch v := value.(type) {
	case map[string]any:
		return sanitizeMap(v, depth+1)
	case []any:
		if len(v) > 20 {
			v = v[:20]
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = sanitizeValue(item, depth+1)
		}
		return out
	}
	return nil
}
func numeric(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// Raise never prevents protective management when alert persistence fails.
func (m *Manager) Raise(ctx context.Context, input Alert) bool {
	input.Subject = truncate(Redact(input.Subject), 200)
	key := ID(input.Type, input.Subject)
	now := m.Now()
	at := store.ISO(now)
	input.Title = truncate(Redact(input.Title), 200)
	input.Message = truncate(Redact(input.Message), 1000)
	if input.Action == "" {
		input.Action = actions[input.Type]
	}
	input.Action = truncate(Redact(input.Action), 1000)
	input.Subject = truncate(Redact(input.Subject), 200)
	input.Details = Sanitize(input.Details)
	m.mu.Lock()
	known := m.recent[key]
	if !known.at.IsZero() && now.Sub(known.at) < time.Minute && Rank(input.Severity) <= Rank(known.severity) {
		known.pending++
		m.recent[key] = known
		m.mu.Unlock()
		return true
	}
	m.mu.Unlock()
	state := "opened"
	severity := input.Severity
	var err error
	if m.Store == nil {
		err = errors.New("operational store unavailable")
	} else {
		err = m.Store.WithTx(ctx, func(tx *store.Tx) error {
			current, err := tx.Get("alerts", key)
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
			if current == nil {
				current = store.Document{"type": input.Type, "subject": input.Subject, "status": "open", "first_seen_at": at, "opened_at": at, "reopened_count": 0, "acknowledged_by": nil, "acknowledged_at": nil, "resolved_at": nil, "resolved_by": nil, "resolution": nil}
			} else {
				previous, _ := current["severity"].(string)
				if current["status"] == "resolved" {
					state = "reopened"
					current["status"] = "open"
					current["opened_at"] = at
					current["reopened_count"] = numeric(current["reopened_count"]) + 1
					current["acknowledged_at"] = nil
					current["acknowledged_by"] = nil
					current["resolved_at"] = nil
					current["resolved_by"] = nil
					current["resolution"] = nil
				} else if Rank(input.Severity) > Rank(previous) {
					state = "escalated"
					current["status"] = "open"
					current["acknowledged_at"] = nil
					current["acknowledged_by"] = nil
				} else {
					state = "refreshed"
					severity = previous
				}
			}
			current["severity"], current["title"], current["message"], current["action"], current["source"], current["details"] = severity, input.Title, input.Message, input.Action, input.Source, input.Details
			current["count"] = numeric(current["count"]) + 1 + known.pending
			current["last_seen_at"], current["updated_at"] = at, at
			if err := tx.Put("alerts", key, current); err != nil {
				return err
			}
			if state != "refreshed" {
				_, err := tx.Create("system_logs", key+"__"+at+"__"+state, store.Document{"timestamp": at, "level": "warn", "source": input.Source, "message": "alert_raised", "details": map[string]any{"alert": key, "severity": severity, "state": state}})
				return err
			}
			return nil
		})
	}
	if err != nil {
		state = "unrecorded"
		slog.Error("alert_write_failed", "alert", key)
	} else {
		m.mu.Lock()
		m.recent[key] = memo{at: now, severity: severity}
		m.mu.Unlock()
	}
	if state != "refreshed" {
		slog.Warn("alert_raised", "alert", key, "severity", severity, "state", state)
		input.Severity = severity
		m.deliver(ctx, key, input, state, now)
	}
	return err == nil
}

func (m *Manager) Resolve(ctx context.Context, kind, subject, resolution string) bool {
	key := ID(kind, subject)
	m.mu.Lock()
	delete(m.recent, key)
	m.mu.Unlock()
	if m.Store == nil {
		return false
	}
	return m.Store.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("alerts", key)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if doc["status"] == "resolved" {
			return nil
		}
		at := store.ISO(m.Now())
		doc["status"], doc["resolved_at"], doc["updated_at"], doc["resolution"] = "resolved", at, at, truncate(Redact(resolution), 500)
		return tx.Put("alerts", key, doc)
	}) == nil
}

func (m *Manager) deliver(ctx context.Context, key string, input Alert, state string, now time.Time) {
	if os.Getenv("ALERT_NOTIFICATIONS") != "enabled" {
		return
	}
	minimum := os.Getenv("ALERT_NOTIFY_MIN_SEVERITY")
	if minimum != "info" && minimum != "warning" && minimum != "error" && minimum != "critical" {
		minimum = "error"
	}
	if Rank(input.Severity) < Rank(minimum) {
		return
	}
	m.mu.Lock()
	last := m.notified[key]
	if !last.IsZero() && now.Sub(last) < 15*time.Minute && state != "escalated" {
		m.mu.Unlock()
		return
	}
	m.notified[key] = now
	m.mu.Unlock()
	post := func(url string, value any) {
		data, err := json.Marshal(value)
		if err != nil {
			return
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
		if err != nil {
			return
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := m.Client.Do(request)
		if err != nil {
			slog.Warn("alert_notification_failed", "alert", key)
			return
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			slog.Warn("alert_notification_failed", "alert", key)
		}
	}
	if url := strings.TrimSpace(os.Getenv("ALERT_WEBHOOK_URL")); strings.HasPrefix(strings.ToLower(url), "https://") {
		post(url, map[string]any{"source": "bytrader", "type": input.Type, "severity": input.Severity, "title": input.Title, "message": input.Message, "action": input.Action, "subject": input.Subject, "state": state, "at": store.ISO(now)})
	}
	if token, chat := os.Getenv("ALERT_TELEGRAM_BOT_TOKEN"), os.Getenv("ALERT_TELEGRAM_CHAT_ID"); token != "" && chat != "" {
		text := "[ByTrader " + strings.ToUpper(input.Severity) + "] " + input.Title + "\n" + input.Message + "\nAction: " + input.Action
		post("https://api.telegram.org/bot"+token+"/sendMessage", map[string]any{"chat_id": chat, "text": truncate(text, 3500), "disable_web_page_preview": true})
	}
}
