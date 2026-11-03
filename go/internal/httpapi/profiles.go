package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
)

const profilesCollection = "execution_profiles"
const profileAuditCollection = "execution_profile_audit"

var profileIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,47}$`)
var profileDocIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,47}__v[1-9][0-9]{0,8}$`)
var profileEnvelope = map[string]bool{
	"status": true, "validation": true, "doc_id": true, "created_at": true, "created_by": true, "created_by_uid": true,
	"updated_at": true, "updated_by": true, "updated_by_uid": true, "approved_at": true, "approved_by": true, "approved_by_uid": true,
	"activated_at": true, "activated_by": true, "activated_by_uid": true, "superseded_at": true, "rejected_at": true,
	"rejected_by": true, "rejected_by_uid": true, "rejected_reason": true,
}

func stripProfile(input map[string]any, extra ...string) (map[string]any, []string) {
	ignore := map[string]bool{}
	for _, key := range extra {
		ignore[key] = true
	}
	out, notes := map[string]any{}, []string{}
	for key, value := range input {
		if profileEnvelope[key] || ignore[key] {
			notes = append(notes, fmt.Sprintf("Ignored server-managed field %q.", key))
			continue
		}
		out[key] = value
	}
	sort.Strings(notes)
	return out, notes
}

func profileContent(doc map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range doc {
		if !profileEnvelope[key] && key != "_id" {
			out[key] = value
		}
	}
	return out
}

var profileMetaFields = []string{"validation", "created_at", "created_by", "updated_at", "updated_by", "approved_at", "approved_by", "activated_at", "activated_by", "superseded_at", "rejected_at", "rejected_by", "rejected_reason"}

func profileMeta(doc map[string]any) map[string]any {
	meta := map[string]any{}
	for _, key := range profileMetaFields {
		meta[key] = nullable(doc[key])
	}
	return meta
}

func profileValidationRecord(result domain.ValidationResult[domain.ExecutionProfile], when string) map[string]any {
	return map[string]any{"ok": result.OK, "errors": result.Errors, "warnings": result.Warnings, "validated_at": when}
}

func (h *Handler) writeProfileAudit(tx *store.Tx, user authenticatedUser, action, docID string, when string, details map[string]any, previous any) error {
	profileEntry := store.Document{"action": action, "profile_doc_id": docID, "actor_uid": user.UID, "actor_email": user.Email, "at": when, "details": cloneMap(details)}
	adminDetails := map[string]any{"profile_doc_id": docID}
	if previous != nil || action == "activate" || action == "rollback" {
		profileEntry["previous_active_doc_id"] = previous
		adminDetails["previous_active_doc_id"] = previous
	}
	for key, value := range details {
		adminDetails[key] = value
	}
	if _, err := tx.Create(profileAuditCollection, randomID(), profileEntry); err != nil {
		return err
	}
	_, err := tx.Create("admin_audit", randomID(), store.Document{"action": "profile." + action, "actor_uid": user.UID, "actor_email": user.Email, "at": when, "details": adminDetails})
	return err
}

func (h *Handler) getProfiles(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	docs, err := h.store.List(r.Context(), profilesCollection, store.ListOptions{Limit: 5000})
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	profiles := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		validation := object(doc["validation"])
		errorsCount, warningsCount := 0, 0
		if list, ok := validation["errors"].([]any); ok {
			errorsCount = len(list)
		}
		if list, ok := validation["warnings"].([]any); ok {
			warningsCount = len(list)
		}
		profiles = append(profiles, map[string]any{"doc_id": idOf(doc), "profile_id": nullableString(stringField(doc, "profile_id")), "version": nullable(doc["version"]), "name": nullable(doc["name"]), "status": nullable(doc["status"]), "validation": map[string]any{"ok": boolField(validation, "ok"), "error_count": errorsCount, "warning_count": warningsCount, "validated_at": nullable(validation["validated_at"])}, "created_at": nullable(doc["created_at"]), "approved_at": nullable(doc["approved_at"]), "activated_at": nullable(doc["activated_at"]), "superseded_at": nullable(doc["superseded_at"]), "updated_at": nullable(doc["updated_at"])})
	}
	sort.Slice(profiles, func(i, j int) bool {
		a, b := stringField(profiles[i], "profile_id"), stringField(profiles[j], "profile_id")
		if a != b {
			return a < b
		}
		av, _ := intValue(profiles[i]["version"])
		bv, _ := intValue(profiles[j]["version"])
		return av > bv
	})
	settings, err := h.settingsDoc(r)
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": profiles, "active_profile_doc_id": nullableString(stringField(object(settings["execution"]), "active_profile_doc_id"))})
}

func (h *Handler) postProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	profile, notes := stripProfile(body, "version")
	profileID, valid := profile["profile_id"].(string)
	if !valid || !profileIDRE.MatchString(profileID) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "profile_id is required: 3 to 48 characters, a-z, 0-9 and hyphens, starting with a letter or digit", "issues": []any{map[string]any{"path": "profile_id", "message": "missing or invalid profile_id"}}})
		return
	}
	when := at(h)
	docID := ""
	version := 0
	var validationRecordValue map[string]any
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		// The profile id is not a derived index; inspect the bounded profile set.
		docs, err := tx.List(profilesCollection, store.ListOptions{Limit: 5000})
		if err != nil {
			return err
		}
		for _, doc := range docs {
			if stringField(doc, "profile_id") == profileID {
				v, _ := intValue(doc["version"])
				if v > version {
					version = v
				}
			}
		}
		version++
		docID = fmt.Sprintf("%s__v%d", profileID, version)
		candidate := cloneMap(profile)
		candidate["version"] = version
		validation := domain.ValidateProfile(candidate)
		validationRecordValue = profileValidationRecord(validation, when)
		stored := cloneMap(candidate)
		stored["status"] = "draft"
		stored["validation"] = validationRecordValue
		stored["created_at"] = when
		stored["created_by"] = user.Email
		stored["created_by_uid"] = user.UID
		stored["updated_at"] = when
		stored["updated_by"] = user.Email
		created, err := tx.Create(profilesCollection, docID, store.Document(stored))
		if err != nil {
			return err
		}
		if !created {
			return &apiError{Status: 409, Message: "Profile version already exists"}
		}
		return h.writeProfileAudit(tx, user, "create_draft", docID, when, map[string]any{"profile_id": profileID, "version": version, "validation_ok": validation.OK, "error_count": len(validation.Errors), "warning_count": len(validation.Warnings), "ignored_fields": notes}, nil)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "doc_id": docID, "profile_id": profileID, "version": version, "status": "draft", "validation": validationRecordValue, "notes": notes})
}

func (h *Handler) getProfile(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	id := r.PathValue("docID")
	if !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	doc, err := h.store.Get(r.Context(), profilesCollection, id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, "Not found", 404)
		return
	}
	if err != nil {
		writeError(w, "Read failed", 503)
		return
	}
	writeJSON(w, 200, map[string]any{"doc_id": id, "status": nullableString(stringField(doc, "status")), "profile": profileContent(doc), "meta": profileMeta(doc)})
}

func (h *Handler) putProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("docID")
	if !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	incoming, notes := stripProfile(body)
	when := at(h)
	var validationRecordValue map[string]any
	changed := []string{}
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		data, err := tx.Get(profilesCollection, id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		if stringField(data, "status") != "draft" {
			return &apiError{Status: 409, Message: "Only drafts can be edited (status is " + stringField(data, "status") + ")"}
		}
		if v, exists := incoming["profile_id"]; exists && v != data["profile_id"] {
			return &apiError{Status: 400, Message: "profile_id cannot change", Extra: map[string]any{"issues": []any{map[string]any{"path": "profile_id", "message": "profile_id cannot change on an existing version"}}}}
		}
		if v, exists := incoming["version"]; exists && v != data["version"] {
			return &apiError{Status: 400, Message: "version cannot change", Extra: map[string]any{"issues": []any{map[string]any{"path": "version", "message": "version is assigned by the server and cannot change"}}}}
		}
		next := cloneMap(incoming)
		next["profile_id"] = data["profile_id"]
		next["version"] = data["version"]
		validation := domain.ValidateProfile(next)
		validationRecordValue = profileValidationRecord(validation, when)
		changed = changedProfileKeys(profileContent(data), next)
		stored := cloneMap(next)
		stored["status"] = "draft"
		stored["validation"] = validationRecordValue
		stored["created_at"] = nullable(data["created_at"])
		stored["created_by"] = nullable(data["created_by"])
		stored["created_by_uid"] = nullable(data["created_by_uid"])
		stored["updated_at"] = when
		stored["updated_by"] = user.Email
		stored["updated_by_uid"] = user.UID
		if err := tx.Put(profilesCollection, id, store.Document(stored)); err != nil {
			return err
		}
		return h.writeProfileAudit(tx, user, "update_draft", id, when, map[string]any{"profile_id": data["profile_id"], "version": data["version"], "validation_ok": validation.OK, "error_count": len(validation.Errors), "warning_count": len(validation.Warnings), "changed_keys": changed, "ignored_fields": notes}, nil)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "doc_id": id, "status": "draft", "validation": validationRecordValue, "changed_keys": changed, "notes": notes})
}

func changedProfileKeys(before, after map[string]any) []string {
	keys := map[string]bool{}
	for k := range before {
		keys[k] = true
	}
	for k := range after {
		keys[k] = true
	}
	out := []string{}
	for k := range keys {
		if fmt.Sprint(before[k]) != fmt.Sprint(after[k]) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func safetyFor(settings store.Document) (string, bool, domain.SafetyLimits, []domain.ValidationIssue) {
	raw, exists := settings["safety"]
	if !exists || raw == nil {
		return "default", true, domain.DefaultSafetyLimits, []domain.ValidationIssue{}
	}
	check := domain.ValidateSafetyLimits(raw)
	if !check.OK || check.Value == nil {
		return "stored", false, domain.SafetyLimits{}, check.Errors
	}
	return "stored", true, *check.Value, []domain.ValidationIssue{}
}

func validateAgainstCurrent(doc store.Document, settings store.Document) (domain.ValidationResult[domain.ExecutionProfile], string, bool, domain.SafetyLimits, []domain.ValidationIssue) {
	validation := domain.ValidateProfile(profileContent(doc))
	source, ok, safety, errors := safetyFor(settings)
	if !validation.OK || validation.Value == nil || !ok {
		return validation, source, ok, safety, errors
	}
	return validation, source, ok, safety, domain.ValidateProfileAgainstSafety(*validation.Value, safety)
}

func (h *Handler) postProfileApprove(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("docID")
	if !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get(profilesCollection, id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		if stringField(doc, "status") != "draft" {
			return &apiError{Status: 409, Message: "Only drafts can be approved (status is " + stringField(doc, "status") + ")"}
		}
		settings, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			settings = store.Document{}
		} else if err != nil {
			return err
		}
		validation, source, safe, _, issues := validateAgainstCurrent(doc, settings)
		if !validation.OK || validation.Value == nil {
			return &apiError{Status: 422, Message: "Profile does not validate", Extra: map[string]any{"issues": validation.Errors}}
		}
		if !safe {
			return &apiError{Status: 409, Message: "Stored safety limits are invalid; fix settings.safety first", Extra: map[string]any{"issues": issues}}
		}
		if len(issues) > 0 {
			return &apiError{Status: 422, Message: "Profile exceeds the current safety limits", Extra: map[string]any{"issues": issues}}
		}
		doc["status"], doc["approved_at"], doc["approved_by"], doc["approved_by_uid"], doc["validation"], doc["updated_at"], doc["updated_by"] = "approved", when, user.Email, user.UID, profileValidationRecord(validation, when), when, user.Email
		if err := tx.Put(profilesCollection, id, doc); err != nil {
			return err
		}
		return h.writeProfileAudit(tx, user, "approve", id, when, map[string]any{"profile_id": doc["profile_id"], "version": doc["version"], "warning_count": len(validation.Warnings), "safety_source": source}, nil)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "doc_id": id, "status": "approved"})
}

func (h *Handler) postProfileReject(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("docID")
	if !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	reason := strings.TrimSpace(stringValue(body["reason"]))
	if len(reason) > 500 {
		reason = reason[:500]
	}
	when := at(h)
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		doc, err := tx.Get(profilesCollection, id)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		status := stringField(doc, "status")
		if status != "draft" && status != "approved" {
			return &apiError{Status: 409, Message: "Only drafts or approved versions can be rejected (status is " + status + ")"}
		}
		doc["status"], doc["rejected_at"], doc["rejected_by"], doc["rejected_by_uid"], doc["rejected_reason"], doc["updated_at"], doc["updated_by"] = "rejected", when, user.Email, user.UID, nullableString(reason), when, user.Email
		if err := tx.Put(profilesCollection, id, doc); err != nil {
			return err
		}
		return h.writeProfileAudit(tx, user, "reject", id, when, map[string]any{"profile_id": doc["profile_id"], "version": doc["version"], "from_status": status, "reason": nullableString(reason)}, nil)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "doc_id": id, "status": "rejected"})
}

func (h *Handler) postProfileActivate(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("docID")
	if !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	if body["confirm"] != "ACTIVATE "+id {
		writeError(w, "Type ACTIVATE "+id+" to confirm", 400)
		return
	}
	h.switchProfile(w, r, user, id, false)
}

func (h *Handler) postProfileRollback(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	id := stringValue(body["docId"])
	if id != "" && !profileDocIDRE.MatchString(id) {
		writeError(w, "Invalid doc id", 400)
		return
	}
	h.switchProfile(w, r, user, id, true)
}

func (h *Handler) switchProfile(w http.ResponseWriter, r *http.Request, user authenticatedUser, targetID string, rollback bool) {
	when := at(h)
	previousID := ""
	notes := []string{}
	err := h.store.WithTx(r.Context(), func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if errors.Is(err, store.ErrNotFound) {
			settings = store.Document{}
		} else if err != nil {
			return err
		}
		execution := object(settings["execution"])
		previousID = stringField(execution, "active_profile_doc_id")
		if targetID == "" && rollback {
			docs, err := tx.List(profilesCollection, store.ListOptions{Filters: []store.Filter{{Field: store.StatusField, Values: []string{"superseded"}}}, Limit: 5000})
			if err != nil {
				return err
			}
			bestAt := ""
			for _, candidate := range docs {
				activated := stringField(candidate, "activated_at")
				if activated > bestAt {
					bestAt, targetID = activated, idOf(candidate)
				}
			}
			if targetID == "" {
				return &apiError{Status: 409, Message: "No superseded version to roll back to"}
			}
		}
		if targetID == "" {
			return &apiError{Status: 400, Message: "docId is required"}
		}
		target, err := tx.Get(profilesCollection, targetID)
		if errors.Is(err, store.ErrNotFound) {
			return &apiError{Status: 404, Message: "Not found"}
		}
		if err != nil {
			return err
		}
		status := stringField(target, "status")
		if rollback && status != "superseded" {
			return &apiError{Status: 409, Message: "Only superseded versions can be rolled back to (status is " + status + ")"}
		}
		if !rollback && status != "approved" && status != "superseded" {
			return &apiError{Status: 409, Message: "Only approved or superseded versions can be activated (status is " + status + ")"}
		}
		validation, source, safe, _, issues := validateAgainstCurrent(target, settings)
		if !validation.OK || validation.Value == nil {
			return &apiError{Status: 422, Message: "Profile does not validate", Extra: map[string]any{"issues": validation.Errors}}
		}
		if !safe {
			return &apiError{Status: 409, Message: "Stored safety limits are invalid; fix settings.safety first", Extra: map[string]any{"issues": issues}}
		}
		if len(issues) > 0 {
			return &apiError{Status: 422, Message: "Profile exceeds the current safety limits", Extra: map[string]any{"issues": issues}}
		}
		if previousID != "" && previousID != targetID {
			prev, err := tx.Get(profilesCollection, previousID)
			if err == nil && stringField(prev, "status") == "active" {
				prev["status"], prev["superseded_at"], prev["updated_at"], prev["updated_by"] = "superseded", when, when, user.Email
				if err := tx.Put(profilesCollection, previousID, prev); err != nil {
					return err
				}
			} else if err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
		}
		target["status"], target["activated_at"], target["activated_by"], target["activated_by_uid"], target["validation"], target["updated_at"], target["updated_by"] = "active", when, user.Email, user.UID, profileValidationRecord(validation, when), when, user.Email
		if err := tx.Put(profilesCollection, targetID, target); err != nil {
			return err
		}
		setPath(settings, []string{"execution", "active_profile_doc_id"}, targetID)
		setPath(settings, []string{"execution", "updated_at"}, when)
		setPath(settings, []string{"execution", "updated_by"}, user.Email)
		if err := tx.Put("settings", "default", settings); err != nil {
			return err
		}
		action := "activate"
		if rollback {
			action = "rollback"
		}
		return h.writeProfileAudit(tx, user, action, targetID, when, map[string]any{"profile_id": target["profile_id"], "version": target["version"], "safety_source": source}, nullableString(previousID))
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "doc_id": targetID, "status": "active", "previous_active_doc_id": nullableString(previousID), "notes": notes})
}

func (h *Handler) postProfileValidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	incoming, ok := body["profile"].(map[string]any)
	if !ok {
		writeError(w, "profile must be a JSON object", 400)
		return
	}
	previewRequested := body["preview"] != nil
	var parsed domain.ParsedPreviewInput
	if previewRequested {
		parsed = domain.ParsePreviewInput(body["preview"])
		if !parsed.OK {
			writeError(w, "Invalid preview: "+parsed.Error, 400)
			return
		}
	}
	candidate, ignored := stripProfile(incoming)
	notes := append([]string{}, ignored...)
	if candidate["version"] == nil {
		candidate["version"] = 1
		notes = append(notes, "version was missing, so the profile was validated as version 1 for this check only. The server assigns the real version when the draft is saved.")
	}
	settings, err := h.settingsDoc(r)
	if err != nil {
		writeError(w, "Read failed", 503)
		return
	}
	validation := domain.ValidateProfile(candidate)
	source, safe, safety, safetyErrs := safetyFor(settings)
	safetyIssues := []domain.ValidationIssue{}
	var preview any
	if !validation.OK || validation.Value == nil {
		notes = append(notes, "Safety check and preview are skipped until the profile validates.")
	} else if !safe {
		safetyIssues = append(safetyIssues, domain.ValidationIssue{Path: "settings.safety", Message: "Stored safety limits are invalid, so no profile can be approved or activated."})
		if previewRequested {
			notes = append(notes, "Preview skipped: stored safety limits are invalid.")
		}
	} else {
		safetyIssues = domain.ValidateProfileAgainstSafety(*validation.Value, safety)
		if previewRequested {
			preview = domain.BuildProfilePreview(*validation.Value, safety, *parsed.Value)
		}
	}
	writeJSON(w, 200, map[string]any{"validation": map[string]any{"ok": validation.OK, "errors": validation.Errors, "warnings": validation.Warnings}, "safety": map[string]any{"source": source, "valid": safe, "errors": safetyErrs}, "safetyIssues": safetyIssues, "preview": preview, "notes": notes})
}

func (h *Handler) getProfileAudit(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireUser(w, r); !ok {
		return
	}
	if !h.requireStore(w) {
		return
	}
	limit := queryLimit(r, 50, 200)
	docs, err := h.store.List(r.Context(), profileAuditCollection, store.ListOptions{TimeField: store.At, Descending: true, Limit: limit})
	if err != nil {
		writeError(w, "Read failed", 503)
		return
	}
	entries := make([]map[string]any, 0, len(docs))
	for _, doc := range docs {
		entries = append(entries, map[string]any{"id": idOf(doc), "action": nullable(doc["action"]), "profile_doc_id": nullable(doc["profile_doc_id"]), "previous_active_doc_id": nullable(doc["previous_active_doc_id"]), "actor_email": nullable(doc["actor_email"]), "at": nullable(doc["at"]), "details": nullable(doc["details"])})
	}
	writeJSON(w, 200, map[string]any{"entries": entries})
}
