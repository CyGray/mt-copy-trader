package engine

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

// SourceProfile is a per-source validated execution profile. A missing or
// invalid profile refuses that source without disabling protection of others.
type SourceProfile struct {
	DocID   string
	Profile *domain.ExecutionProfile
	Errors  []string
}

type Control struct {
	Mode                     string
	KillSwitch               bool
	LiveTradingEnabled       bool
	ActiveProfileDocID       string
	ActiveProfile            *domain.ExecutionProfile
	Safety                   *domain.SafetyLimits
	ProfileErrors            []string
	SafetyErrors             []string
	ReplayNotBefore          string
	FailClosedReason         string
	SourceChatIDs            []string
	SourceProfilesConfigured bool
	SourceProfiles           map[string]SourceProfile
	LoadedAt                 time.Time
}

type ControlProvider func(context.Context) (Control, error)

func StoreControlProvider(db store.Store, liveTradingEnabled bool) ControlProvider {
	return func(ctx context.Context) (Control, error) {
		return ReadControl(ctx, db, liveTradingEnabled)
	}
}

func ReadControl(ctx context.Context, db store.Store, liveTradingEnabled bool) (Control, error) {
	if db == nil {
		return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "store_unavailable"}, nil
	}
	settings, err := db.Get(ctx, "settings", "default")
	if errors.Is(err, store.ErrNotFound) {
		return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "settings_missing", SourceChatIDs: []string{"-1003271337051"}}, nil
	}
	if err != nil {
		return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "settings_unavailable"}, err
	}
	control := Control{Mode: "disabled", KillSwitch: true, LiveTradingEnabled: liveTradingEnabled, LoadedAt: time.Now()}
	execution := object(settings["execution"])
	trading := object(settings["trading"])
	migration := object(settings["migration"])
	if raw, ok := execution["mode"].(string); ok && (raw == "disabled" || raw == "paper" || raw == "demo" || raw == "live") {
		control.Mode = raw
	} else {
		raw := execution["mode"]
		if raw != nil && raw != "" {
			control.FailClosedReason = fmt.Sprintf("unknown_mode:%v", raw)
		} else {
			control.FailClosedReason = "mode_missing"
		}
	}
	if raw, exists := trading["kill_switch"]; exists {
		if value, ok := raw.(bool); ok {
			control.KillSwitch = value
		} else {
			control.KillSwitch = true
			control.FailClosedReason = "kill_switch_malformed"
		}
	} else {
		control.KillSwitch = false
	}
	if raw := migration["replay_not_before"]; raw != nil {
		barrier, ok := raw.(string)
		if !ok || !validISO(barrier) {
			control.FailClosedReason = "invalid_replay_barrier"
		} else {
			control.ReplayNotBefore = barrier
		}
	} else {
		control.FailClosedReason = "missing_replay_barrier"
	}
	control.SourceChatIDs = normalizeSourceChatIDs(settings)
	if raw := settings["safety"]; raw == nil {
		def := domain.DefaultSafetyLimits
		control.Safety = &def
	} else {
		checked := domain.ValidateSafetyLimits(raw)
		if checked.OK && checked.Value != nil {
			control.Safety = checked.Value
		} else {
			control.SafetyErrors = validationMessages(checked.Errors)
		}
	}
	profileID := execution["active_profile_doc_id"]
	if raw, ok := profileID.(string); ok && strings.TrimSpace(raw) != "" {
		control.ActiveProfileDocID = raw
	} else if profileID != nil && profileID != "" {
		control.ProfileErrors = []string{"active_profile_doc_id: must be a string"}
	}
	if control.ActiveProfileDocID != "" {
		doc, err := db.Get(ctx, "execution_profiles", control.ActiveProfileDocID)
		if errors.Is(err, store.ErrNotFound) {
			control.ProfileErrors = append(control.ProfileErrors, "active_profile_not_found")
		} else if err != nil {
			return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "profile_unavailable"}, err
		} else {
			status := stringValue(doc["status"])
			if status != "active" && status != "approved" {
				control.ProfileErrors = append(control.ProfileErrors, "profile_status_"+fallback(status, "missing"))
			} else {
				checked := domain.ValidateProfile(domain.StripProfileEnvelope(doc))
				if checked.OK && checked.Value != nil {
					if control.Safety == nil {
						control.ProfileErrors = append(control.ProfileErrors, "safety_unavailable")
					} else if issues := domain.ValidateProfileAgainstSafety(*checked.Value, *control.Safety); len(issues) > 0 {
						control.ProfileErrors = validationMessages(issues)
					} else {
						control.ActiveProfile = checked.Value
					}
				} else {
					control.ProfileErrors = validationMessages(checked.Errors)
				}
			}
		}
	}
	// When present, this map is authoritative for all configured source chats.
	// No implicit fallback to the global active profile is permitted.
	mt5 := object(settings["mt5"])
	if raw, exists := mt5["source_profile_doc_ids"]; exists {
		control.SourceProfilesConfigured = true
		mappings, ok := raw.(map[string]any)
		if !ok {
			control.FailClosedReason = "source_profile_mapping_malformed"
			return control, nil
		}
		control.SourceProfiles = make(map[string]SourceProfile, len(mappings))
		for chatID, rawID := range mappings {
			docID, ok := rawID.(string)
			docID = strings.TrimSpace(docID)
			if !ok || strings.TrimSpace(chatID) == "" || docID == "" {
				control.FailClosedReason = "source_profile_mapping_malformed"
				return control, nil
			}
			source := SourceProfile{DocID: docID}
			doc, err := db.Get(ctx, "execution_profiles", docID)
			if errors.Is(err, store.ErrNotFound) {
				source.Errors = []string{"source_profile_not_found"}
			} else if err != nil {
				return Control{Mode: "disabled", KillSwitch: true, FailClosedReason: "source_profile_unavailable"}, err
			} else {
				status := stringValue(doc["status"])
				if status != "active" && status != "approved" {
					source.Errors = []string{"source_profile_status_" + fallback(status, "missing")}
				} else {
					checked := domain.ValidateProfile(domain.StripProfileEnvelope(doc))
					if !checked.OK || checked.Value == nil {
						source.Errors = validationMessages(checked.Errors)
					} else if control.Safety == nil {
						source.Errors = []string{"safety_unavailable"}
					} else if issues := domain.ValidateProfileAgainstSafety(*checked.Value, *control.Safety); len(issues) > 0 {
						source.Errors = validationMessages(issues)
					} else {
						source.Profile = checked.Value
					}
				}
			}
			control.SourceProfiles[chatID] = source
		}
	}
	return control, nil
}

// ForChat freezes the chosen source-specific profile for entry validation.
// If routing is configured, an unmapped or invalid chat fails closed.
func (c Control) ForChat(chatID string) Control {
	if !c.SourceProfilesConfigured {
		return c
	}
	c.ActiveProfileDocID = ""
	c.ActiveProfile = nil
	c.ProfileErrors = nil
	source, ok := c.SourceProfiles[chatID]
	if !ok {
		c.ProfileErrors = []string{"source_chat_profile_unmapped"}
		return c
	}
	c.ActiveProfileDocID = source.DocID
	c.ActiveProfile = source.Profile
	c.ProfileErrors = append([]string(nil), source.Errors...)
	return c
}

func normalizeSourceChatIDs(settings store.Document) []string {
	const defaultChat = "-1003271337051"
	mt5 := object(settings["mt5"])
	raw, exists := mt5["source_chat_ids"]
	if !exists {
		return []string{defaultChat}
	}
	values, ok := raw.([]any)
	if !ok {
		return []string{defaultChat}
	}
	ids := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		var id string
		switch v := value.(type) {
		case string:
			id = strings.TrimSpace(v)
		case float64:
			id = strconv.FormatFloat(v, 'f', -1, 64)
		case nil:
			id = "null"
		case bool:
			id = strconv.FormatBool(v)
		case int64:
			id = fmt.Sprintf("%d", v)
		case int:
			id = fmt.Sprintf("%d", v)
		}
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

func (c Control) CanOpenNewEntries() (bool, string) {
	switch {
	case c.FailClosedReason != "":
		return false, "config_unavailable"
	case c.Mode == "disabled":
		return false, "execution_disabled"
	case c.KillSwitch:
		return false, "kill_switch"
	case c.Mode == "live" && !c.LiveTradingEnabled:
		return false, "live_not_enabled"
	case c.Safety == nil || len(c.SafetyErrors) > 0:
		return false, "invalid_safety"
	case c.ActiveProfileDocID == "":
		return false, "no_active_profile"
	case c.ActiveProfile == nil || len(c.ProfileErrors) > 0:
		return false, "invalid_profile"
	default:
		return true, ""
	}
}

func object(value any) map[string]any {
	if v, ok := value.(map[string]any); ok {
		return v
	}
	if v, ok := value.(store.Document); ok {
		return v
	}
	return map[string]any{}
}

func stringValue(value any) string { v, _ := value.(string); return v }

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validationMessages(issues []domain.ValidationIssue) []string {
	out := make([]string, len(issues))
	for i, issue := range issues {
		out[i] = issue.Path + ": " + issue.Message
	}
	return out
}

func validISO(value string) bool { _, err := time.Parse(time.RFC3339Nano, value); return err == nil }
func fallback(value, otherwise string) string {
	if value != "" {
		return value
	}
	return otherwise
}
