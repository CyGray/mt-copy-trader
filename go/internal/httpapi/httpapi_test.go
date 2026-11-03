package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
	"github.com/bytrader/bytrader/internal/telegram"
)

type fakeVerifier struct {
	idClaims      map[string]Claims
	sessionClaims map[string]Claims
	idCalls       int
	sessionCalls  int
	minted        string
}

func (f *fakeVerifier) VerifyIDTokenAndCheckRevoked(_ context.Context, token string) (Claims, error) {
	f.idCalls++
	claims, ok := f.idClaims[token]
	if !ok {
		return Claims{}, errInvalidCredential
	}
	return claims, nil
}

func (f *fakeVerifier) VerifySessionCookieAndCheckRevoked(_ context.Context, cookie string) (Claims, error) {
	f.sessionCalls++
	claims, ok := f.sessionClaims[cookie]
	if !ok {
		return Claims{}, errInvalidCredential
	}
	return claims, nil
}

func (f *fakeVerifier) CreateSessionCookie(_ context.Context, token string, _ time.Duration) (string, error) {
	f.minted = "server-session:" + token
	return f.minted, nil
}

func testClaims(uid, email string) Claims {
	return Claims{UID: uid, Email: email, EmailVerified: true, AuthTime: time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC).Unix()}
}

func openTestStore(t *testing.T) *store.SQLiteStore {
	t.Helper()
	db, err := store.Open(t.TempDir() + "/state.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func testHandler(t *testing.T, db store.Store, verifier *fakeVerifier) http.Handler {
	t.Helper()
	return New(Config{Store: db, Verifier: verifier, AllowedEmails: []string{"admin@example.com", "viewer@example.com"}, SecureCookies: true, Now: func() time.Time { return time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC) }})
}

func adminTestHandler(t *testing.T, db store.Store) http.Handler {
	t.Helper()
	if err := db.Put(context.Background(), "users", "admin-uid", store.Document{"uid": "admin-uid", "email": "admin@example.com", "role": "admin"}); err != nil {
		t.Fatal(err)
	}
	verifier := &fakeVerifier{idClaims: map[string]Claims{"admin": testClaims("admin-uid", "admin@example.com"), "viewer": testClaims("viewer-uid", "viewer@example.com")}}
	return testHandler(t, db, verifier)
}

func serveJSON(handler http.Handler, method, target, token, body string) *httptest.ResponseRecorder {
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestAuthBearerPriorityAndSessionCookie(t *testing.T) {
	verifier := &fakeVerifier{
		idClaims:      map[string]Claims{"viewer": testClaims("viewer-uid", "viewer@example.com")},
		sessionClaims: map[string]Claims{"browser-session": testClaims("viewer-uid", "viewer@example.com")},
	}
	handler := testHandler(t, openTestStore(t), verifier)

	request := httptest.NewRequest(http.MethodPost, "/api/admin/ping", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer invalid")
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: "browser-session"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid bearer fell back to session: status=%d body=%s", response.Code, response.Body.String())
	}
	if verifier.sessionCalls != 0 {
		t.Fatalf("session cookie was consulted after invalid bearer: calls=%d", verifier.sessionCalls)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(`{"token":"viewer"}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("session mint status=%d body=%s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookie || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie attributes are unsafe: %+v", cookies)
	}
	if cookies[0].Value == "viewer" || cookies[0].Value != verifier.minted {
		t.Fatalf("session cookie is not server minted: %q", cookies[0].Value)
	}
}

func TestAuthAllowListAndSameOrigin(t *testing.T) {
	verifier := &fakeVerifier{idClaims: map[string]Claims{"outsider": testClaims("u", "other@example.com")}}
	handler := testHandler(t, openTestStore(t), verifier)
	request := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/execution/kill-switch", strings.NewReader(`{"engaged":true}`))
	request.Header.Set("Authorization", "Bearer outsider")
	request.Header.Set("Origin", "https://attacker.example")
	request.Header.Set("Host", "localhost")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin mutation status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(`{"token":"outsider"}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-allowlisted session status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSessionMintAcceptsPreviouslyAuthenticatedVerifiedToken(t *testing.T) {
	claims := testClaims("viewer-uid", "viewer@example.com")
	claims.AuthTime = time.Date(2026, 10, 24, 11, 50, 0, 0, time.UTC).Unix()
	verifier := &fakeVerifier{idClaims: map[string]Claims{"aged-token": claims}}
	handler := testHandler(t, openTestStore(t), verifier)
	response := serveJSON(handler, http.MethodPost, "/api/session", "", `{"token":"aged-token"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("valid token older than five minutes failed session mint: status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Result().Cookies(); len(got) != 1 || got[0].Value != verifier.minted {
		t.Fatalf("session cookie was not minted after token verification: %+v", got)
	}
}

func TestExecutionControlsAndSessionDeleteRoutes(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	ping := serveJSON(handler, http.MethodPost, "/api/admin/ping", "admin", "")
	if ping.Code != http.StatusOK || !strings.Contains(ping.Body.String(), `"ok":true`) {
		t.Fatalf("admin ping status=%d body=%s", ping.Code, ping.Body.String())
	}

	mode := serveJSON(handler, http.MethodPost, "/api/execution/mode", "admin", `{"mode":"paper"}`)
	if mode.Code != http.StatusOK || !strings.Contains(mode.Body.String(), `"mode":"paper"`) {
		t.Fatalf("execution mode status=%d body=%s", mode.Code, mode.Body.String())
	}
	safetyJSON, err := json.Marshal(domain.DefaultSafetyLimits)
	if err != nil {
		t.Fatal(err)
	}
	safety := serveJSON(handler, http.MethodPost, "/api/execution/safety", "admin", string(safetyJSON))
	if safety.Code != http.StatusOK {
		t.Fatalf("safety limits status=%d body=%s", safety.Code, safety.Body.String())
	}
	status := serveJSON(handler, http.MethodGet, "/api/execution/status", "viewer", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"mode":"paper"`) || !strings.Contains(status.Body.String(), `"safety_source":"stored"`) {
		t.Fatalf("execution status status=%d body=%s", status.Code, status.Body.String())
	}

	deleted := serveJSON(handler, http.MethodDelete, "/api/session", "", "")
	cookies := deleted.Result().Cookies()
	if deleted.Code != http.StatusOK || len(cookies) != 1 || cookies[0].Name != sessionCookie || cookies[0].MaxAge >= 0 {
		t.Fatalf("session delete did not clear cookie: status=%d cookies=%+v", deleted.Code, cookies)
	}
}

func TestEnsureUserCreatesViewerOnce(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	created := serveJSON(handler, http.MethodPost, "/api/users/ensure", "viewer", "")
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"created":true`) || !strings.Contains(created.Body.String(), `"role":"viewer"`) {
		t.Fatalf("ensure new user status=%d body=%s", created.Code, created.Body.String())
	}
	role := serveJSON(handler, http.MethodPost, "/api/admin/role", "viewer", "")
	if role.Code != http.StatusOK || !strings.Contains(role.Body.String(), `"role":"viewer"`) {
		t.Fatalf("role lookup for ensured user status=%d body=%s", role.Code, role.Body.String())
	}
	again := serveJSON(handler, http.MethodPost, "/api/users/ensure", "viewer", "")
	if again.Code != http.StatusOK || !strings.Contains(again.Body.String(), `"created":false`) {
		t.Fatalf("ensure existing user changed role: status=%d body=%s", again.Code, again.Body.String())
	}
}

func TestTradesPageAndOverviewUseAuthenticatedSQLiteData(t *testing.T) {
	db := openTestStore(t)
	for id, created := range map[string]string{"trade-1": "2026-10-24T10:00:00.000Z", "trade-2": "2026-10-24T11:00:00.000Z"} {
		if err := db.Put(context.Background(), "trade_sets", id, store.Document{"schema": 2, "trade_set_id": id, "state": "OPEN", "created_at": created, "updated_at": created}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Put(context.Background(), "trade_events", "trade-event-1", store.Document{"trade_set_id": "trade-1", "timestamp": "2026-10-24T11:30:00.000Z", "type": "state_change"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "system_logs", "system-log-1", store.Document{"timestamp": "2026-10-24T11:40:00.000Z", "level": "info", "message": "worker ready"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "telegram_messages", "telegram-message-1", store.Document{"timestamp": "2026-10-24T11:45:00.000Z", "message_id": "99", "text": "signal received"}); err != nil {
		t.Fatal(err)
	}
	verifier := &fakeVerifier{idClaims: map[string]Claims{"viewer": testClaims("viewer-uid", "viewer@example.com")}}
	handler := testHandler(t, db, verifier)
	request := httptest.NewRequest(http.MethodGet, "/api/trades?limit=1", nil)
	request.Header.Set("Authorization", "Bearer viewer")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("trade list status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"trade-2"`) || !strings.Contains(response.Body.String(), `"next_cursor"`) {
		t.Fatalf("trade page missing latest result or cursor: %s", response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/overview", nil)
	request.Header.Set("Authorization", "Bearer viewer")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"trades":{"items"`) {
		t.Fatalf("overview contract status=%d body=%s", response.Code, response.Body.String())
	}
	for path, want := range map[string]string{
		"/api/trades/trade-1/events":     "state_change",
		"/api/logs?kind=system":          "worker ready",
		"/api/logs?kind=telegram":        "signal received",
		"/api/telegram/messages?limit=1": "signal received",
	} {
		page := serveJSON(handler, http.MethodGet, path, "viewer", "")
		if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), want) {
			t.Errorf("GET %s status=%d body=%s", path, page.Code, page.Body.String())
		}
	}
}

func TestEmbeddedAssetsSupportDeepLinksWithoutMaskingMissingAssets(t *testing.T) {
	// A typed nil Store leaves static content and application deep links available.
	handler := New(Config{Assets: mapFS(map[string]string{"index.html": "<!doctype html><main>app</main>", "assets/app.js": "console.log(1)"})})
	for path, want := range map[string]string{"/": "app", "/profiles": "app", "/assets/app.js": "console.log"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), want) {
			t.Errorf("GET %s: status=%d body=%q", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing asset fell back to app: status=%d", response.Code)
	}
}

func TestTradesPageIncludesLegacySchema1Records(t *testing.T) {
	db := openTestStore(t)
	if err := db.Put(context.Background(), "trade_sets", "legacy-trade", store.Document{
		"schema": 1, "state": "CLOSED", "symbol": "BTCUSDT", "direction": "LONG",
		"created_at": "2024-01-01T00:00:00.000Z", "bybit": map[string]any{"qty": 0.01},
	}); err != nil {
		t.Fatal(err)
	}
	verifier := &fakeVerifier{idClaims: map[string]Claims{"viewer": testClaims("viewer-uid", "viewer@example.com")}}
	response := serveJSON(testHandler(t, db, verifier), http.MethodGet, "/api/trades?limit=10", "viewer", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"legacy-trade"`) {
		t.Fatalf("legacy trade missing from the authenticated list: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSettingsControlAndRoleRoutesPreserveContractsAndAuditAtomically(t *testing.T) {
	db := openTestStore(t)
	if err := db.Put(context.Background(), "settings", "default", store.Document{
		"execution": map[string]any{"mode": "demo", "active_profile_doc_id": "xau__v1"},
		"trading":   map[string]any{"kill_switch": false},
		"telegram":  map[string]any{"allowed_chat_ids": []string{"-100"}, "blocked_chat_ids": []string{}, "chat_id_labels": map[string]string{"-100": "signals"}},
		"migration": map[string]any{"replay_not_before": "private-barrier"},
	}); err != nil {
		t.Fatal(err)
	}
	handler := adminTestHandler(t, db)

	read := serveJSON(handler, http.MethodGet, "/api/settings", "viewer", "")
	if read.Code != http.StatusOK || strings.Contains(read.Body.String(), "private-barrier") || !strings.Contains(read.Body.String(), `"allowed_chat_ids":["-100"]`) {
		t.Fatalf("sanitized settings response: status=%d body=%s", read.Code, read.Body.String())
	}

	write := serveJSON(handler, http.MethodPost, "/api/settings", "admin", `{"telegram":{"allowed_chat_ids":["-100","-200"],"chat_id_labels":{"-100":"signals","-200":"new"}}}`)
	if write.Code != http.StatusOK {
		t.Fatalf("settings write status=%d body=%s", write.Code, write.Body.String())
	}
	write = serveJSON(handler, http.MethodPost, "/api/execution/kill-switch", "admin", `{"engaged":true}`)
	if write.Code != http.StatusOK {
		t.Fatalf("kill-switch write status=%d body=%s", write.Code, write.Body.String())
	}
	settings, err := db.Get(context.Background(), "settings", "default")
	if err != nil {
		t.Fatal(err)
	}
	if object(settings["execution"])["mode"] != "demo" || object(settings["execution"])["active_profile_doc_id"] != "xau__v1" || object(settings["trading"])["kill_switch"] != true {
		t.Fatalf("settings were overwritten instead of patched: %+v", settings)
	}

	bad := serveJSON(handler, http.MethodPost, "/api/settings", "admin", `{"trading":{"kill_switch":false}}`)
	if bad.Code != http.StatusBadRequest || !strings.Contains(bad.Body.String(), "execution/kill-switch") {
		t.Fatalf("unsafe settings write was accepted: status=%d body=%s", bad.Code, bad.Body.String())
	}

	role := serveJSON(handler, http.MethodPost, "/api/admin/role", "admin", ``)
	if role.Code != http.StatusOK || !strings.Contains(role.Body.String(), `"role":"admin"`) {
		t.Fatalf("role lookup status=%d body=%s", role.Code, role.Body.String())
	}
	ensure := serveJSON(handler, http.MethodPost, "/api/users/ensure", "admin", ``)
	if ensure.Code != http.StatusOK || !strings.Contains(ensure.Body.String(), `"role":"admin"`) {
		t.Fatalf("ensure changed an existing role: status=%d body=%s", ensure.Code, ensure.Body.String())
	}

	audits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 2 {
		t.Fatalf("settings and kill-switch writes should append two audits, got %d", len(audits))
	}
}

func TestTradesCursorUsesDocumentIDForEqualTimestamps(t *testing.T) {
	db := openTestStore(t)
	for _, id := range []string{"trade-a", "trade-b", "trade-c", "trade-d"} {
		if err := db.Put(context.Background(), "trade_sets", id, store.Document{"schema": 2, "trade_set_id": id, "state": "OPEN", "created_at": "2026-10-24T10:00:00.000Z"}); err != nil {
			t.Fatal(err)
		}
	}
	verifier := &fakeVerifier{idClaims: map[string]Claims{"viewer": testClaims("viewer-uid", "viewer@example.com")}}
	handler := testHandler(t, db, verifier)
	first := serveJSON(handler, http.MethodGet, "/api/trades?limit=2", "viewer", "")
	var page struct {
		Items []map[string]any `json:"items"`
		Next  string           `json:"next_cursor"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if first.Code != http.StatusOK || len(page.Items) != 2 || page.Next == "" {
		t.Fatalf("first tied-timestamp page status=%d payload=%s", first.Code, first.Body.String())
	}
	second := serveJSON(handler, http.MethodGet, "/api/trades?limit=2&cursor="+url.QueryEscape(page.Next), "viewer", "")
	var next struct {
		Items []map[string]any `json:"items"`
		Next  any              `json:"next_cursor"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if second.Code != http.StatusOK || len(next.Items) != 2 || next.Next != nil {
		t.Fatalf("second tied-timestamp page status=%d payload=%s", second.Code, second.Body.String())
	}
	seen := map[string]bool{}
	for _, item := range append(page.Items, next.Items...) {
		id := stringValue(item["id"])
		if seen[id] {
			t.Fatalf("duplicate across cursor pages: %q", id)
		}
		seen[id] = true
	}
	if len(seen) != 4 {
		t.Fatalf("cursor skipped tied-timestamp rows: %v", seen)
	}
}

func TestHealthReportsForwarderAndExecutorSeparately(t *testing.T) {
	db := openTestStore(t)
	fixed := store.ISO(time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
	if err := db.Put(context.Background(), "service_status", "forwarder", store.Document{"healthy": true, "updated_at": fixed, "details": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "service_status", "executor", store.Document{"healthy": false, "updated_at": fixed, "issues": []string{"bridge_disconnected"}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "telegram_state", "status", store.Document{"status": "authorized"}); err != nil {
		t.Fatal(err)
	}
	verifier := &fakeVerifier{idClaims: map[string]Claims{"viewer": testClaims("viewer-uid", "viewer@example.com")}}
	handler := testHandler(t, db, verifier)
	response := serveJSON(handler, http.MethodGet, "/api/worker/health", "viewer", "")
	var body struct {
		Status string `json:"status"`
		Data   struct {
			Status   string `json:"status"`
			Telegram string `json:"telegram"`
			Executor struct {
				Status string `json:"status"`
			} `json:"executor"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Status != "error" || body.Data.Status != "ok" || body.Data.Executor.Status != "offline" || body.Data.Telegram != "authorized" {
		t.Fatalf("executor outage was misreported: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProfileLifecycleValidatesAndCommitsBothAuditStreams(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	fixture, err := os.ReadFile(filepath.Join("..", "..", "docs", "project_memory", "examples", "optimal_report_profile.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	if err := json.Unmarshal(fixture, &profile); err != nil {
		t.Fatal(err)
	}
	profile["profile_id"] = "httpapi-test"
	createBody, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	created := serveJSON(handler, http.MethodPost, "/api/profiles", "admin", string(createBody))
	if created.Code != http.StatusCreated {
		t.Fatalf("create profile status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		DocID      string `json:"doc_id"`
		Validation struct {
			OK bool `json:"ok"`
		} `json:"validation"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	if createdBody.DocID != "httpapi-test__v1" || !createdBody.Validation.OK {
		t.Fatalf("profile version or validation contract: %s", created.Body.String())
	}
	profile["name"] = "HTTP API edited draft"
	updatedBody, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	updated := serveJSON(handler, http.MethodPut, "/api/profiles/"+createdBody.DocID, "admin", string(updatedBody))
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"status":"draft"`) {
		t.Fatalf("update draft status=%d body=%s", updated.Code, updated.Body.String())
	}
	listed := serveJSON(handler, http.MethodGet, "/api/profiles", "viewer", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), createdBody.DocID) {
		t.Fatalf("profile list status=%d body=%s", listed.Code, listed.Body.String())
	}
	detail := serveJSON(handler, http.MethodGet, "/api/profiles/"+createdBody.DocID, "viewer", "")
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "HTTP API edited draft") {
		t.Fatalf("profile detail status=%d body=%s", detail.Code, detail.Body.String())
	}
	validated := serveJSON(handler, http.MethodPost, "/api/profiles/validate", "viewer", `{"profile":`+string(createBody)+`}`)
	var validationResult struct {
		Validation struct {
			OK bool `json:"ok"`
		} `json:"validation"`
	}
	if err := json.Unmarshal(validated.Body.Bytes(), &validationResult); err != nil {
		t.Fatal(err)
	}
	if validated.Code != http.StatusOK || !validationResult.Validation.OK {
		t.Fatalf("profile validation status=%d body=%s", validated.Code, validated.Body.String())
	}
	profileAudit := serveJSON(handler, http.MethodGet, "/api/profiles/audit", "viewer", "")
	if profileAudit.Code != http.StatusOK || !strings.Contains(profileAudit.Body.String(), `"action":"update_draft"`) {
		t.Fatalf("profile audit status=%d body=%s", profileAudit.Code, profileAudit.Body.String())
	}
	approved := serveJSON(handler, http.MethodPost, "/api/profiles/"+createdBody.DocID+"/approve", "admin", "")
	if approved.Code != http.StatusOK {
		t.Fatalf("approve status=%d body=%s", approved.Code, approved.Body.String())
	}
	activate := serveJSON(handler, http.MethodPost, "/api/profiles/"+createdBody.DocID+"/activate", "admin", `{"confirm":"ACTIVATE httpapi-test__v1"}`)
	if activate.Code != http.StatusOK {
		t.Fatalf("activate status=%d body=%s", activate.Code, activate.Body.String())
	}
	settings, err := db.Get(context.Background(), "settings", "default")
	if err != nil || stringField(object(settings["execution"]), "active_profile_doc_id") != createdBody.DocID {
		t.Fatalf("activation did not update settings: %v %+v", err, settings)
	}
	profileAudits, err := db.List(context.Background(), "execution_profile_audit", store.ListOptions{Limit: 10})
	if err != nil || len(profileAudits) != 4 {
		t.Fatalf("expected create, edit, approve, activate audit entries: err=%v rows=%d", err, len(profileAudits))
	}
	adminAudits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 10})
	if err != nil || len(adminAudits) != 4 {
		t.Fatalf("profile actions did not share their admin audits: err=%v rows=%d", err, len(adminAudits))
	}
}

func TestProfileRejectAndRollbackRoutes(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	fixture, err := os.ReadFile(filepath.Join("..", "..", "docs", "project_memory", "examples", "optimal_report_profile.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	if err := json.Unmarshal(fixture, &profile); err != nil {
		t.Fatal(err)
	}
	create := func(id string) string {
		t.Helper()
		candidate := make(map[string]any, len(profile))
		for key, value := range profile {
			candidate[key] = value
		}
		candidate["profile_id"] = id
		body, err := json.Marshal(candidate)
		if err != nil {
			t.Fatal(err)
		}
		response := serveJSON(handler, http.MethodPost, "/api/profiles", "admin", string(body))
		if response.Code != http.StatusCreated {
			t.Fatalf("create %s status=%d body=%s", id, response.Code, response.Body.String())
		}
		var created struct {
			DocID string `json:"doc_id"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		return created.DocID
	}
	approve := func(id string) {
		t.Helper()
		response := serveJSON(handler, http.MethodPost, "/api/profiles/"+id+"/approve", "admin", "")
		if response.Code != http.StatusOK {
			t.Fatalf("approve %s status=%d body=%s", id, response.Code, response.Body.String())
		}
	}
	activate := func(id string) {
		t.Helper()
		response := serveJSON(handler, http.MethodPost, "/api/profiles/"+id+"/activate", "admin", `{"confirm":"ACTIVATE `+id+`"}`)
		if response.Code != http.StatusOK {
			t.Fatalf("activate %s status=%d body=%s", id, response.Code, response.Body.String())
		}
	}

	first := create("httpapi-rollback")
	approve(first)
	activate(first)
	second := create("httpapi-rollback")
	approve(second)
	activate(second)
	rolledBack := serveJSON(handler, http.MethodPost, "/api/profiles/rollback", "admin", `{"docId":"`+first+`"}`)
	if rolledBack.Code != http.StatusOK || !strings.Contains(rolledBack.Body.String(), `"status":"active"`) {
		t.Fatalf("rollback status=%d body=%s", rolledBack.Code, rolledBack.Body.String())
	}
	settings, err := db.Get(context.Background(), "settings", "default")
	if err != nil || stringField(object(settings["execution"]), "active_profile_doc_id") != first {
		t.Fatalf("rollback did not restore the prior version: err=%v settings=%+v", err, settings)
	}

	draft := create("httpapi-reject")
	rejected := serveJSON(handler, http.MethodPost, "/api/profiles/"+draft+"/reject", "admin", `{"reason":"operator rejected fixture"}`)
	if rejected.Code != http.StatusOK || !strings.Contains(rejected.Body.String(), `"status":"rejected"`) {
		t.Fatalf("reject status=%d body=%s", rejected.Code, rejected.Body.String())
	}
	stored, err := db.Get(context.Background(), "execution_profiles", draft)
	if err != nil || stringField(stored, "status") != "rejected" {
		t.Fatalf("reject did not persist: err=%v profile=%+v", err, stored)
	}
}

func TestTelegramLoginRoutesQueueEncryptedCommandsAndReturnStatus(t *testing.T) {
	previous, hadPrevious := os.LookupEnv("MASTER_KEY")
	if err := os.Setenv("MASTER_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if hadPrevious {
			_ = os.Setenv("MASTER_KEY", previous)
		} else {
			_ = os.Unsetenv("MASTER_KEY")
		}
	})
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	cases := []struct {
		path, body, commandType, secretField, secret string
	}{
		{"/api/telegram/start", `{"phone":"+15551234567"}`, "start_login", "phone", "+15551234567"},
		{"/api/telegram/verify-otp", `{"code":"13579"}`, "verify_otp", "code", "13579"},
		{"/api/telegram/verify-password", `{"password":" synthetic-2fa "}`, "verify_password", "password", " synthetic-2fa "},
		{"/api/telegram/logout", "", "logout", "", ""},
	}
	commandIDs := make([]string, 0, len(cases))
	for _, test := range cases {
		response := serveTelegramPreferAsync(handler, test.path, test.body)
		if response.Code != http.StatusAccepted {
			t.Fatalf("POST %s status=%d body=%s", test.path, response.Code, response.Body.String())
		}
		if response.Header().Get("Preference-Applied") != "respond-async" {
			t.Fatalf("POST %s did not apply respond-async preference", test.path)
		}
		var queued struct {
			CommandID string `json:"command_id"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil {
			t.Fatal(err)
		}
		commandIDs = append(commandIDs, queued.CommandID)
		command, err := db.Get(context.Background(), "telegram_commands", queued.CommandID)
		if err != nil {
			t.Fatal(err)
		}
		if stringField(command, "type") != test.commandType || stringField(command, "status") != "pending" || stringField(command, "actor_uid") != "admin-uid" || (test.secret != "" && strings.Contains(stringValue(command["payload_enc"]), test.secret)) {
			t.Fatalf("Telegram command was not safely queued for %s", test.path)
		}
		audits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 20})
		if err != nil {
			t.Fatal(err)
		}
		audited := false
		for _, audit := range audits {
			details := object(audit["details"])
			if stringField(audit, "action") != "telegram."+test.commandType || stringField(details, "command_id") != queued.CommandID {
				continue
			}
			encodedDetails, err := json.Marshal(details)
			if err != nil {
				t.Fatal(err)
			}
			if stringField(audit, "actor_uid") != "admin-uid" || len(details) != 2 || stringField(details, "type") != test.commandType || (test.secret != "" && strings.Contains(string(encodedDetails), test.secret)) {
				t.Fatalf("Telegram audit row has unexpected or sensitive details: %+v", audit)
			}
			audited = true
		}
		if !audited {
			t.Fatalf("Telegram command %s has no admin audit row", queued.CommandID)
		}
		plaintext, err := telegram.DecryptCommandPayload(stringField(command, "payload_enc"))
		if err != nil {
			t.Fatalf("worker could not decrypt queued payload for %s: %v", test.path, err)
		}
		var payload map[string]string
		if err := json.Unmarshal(plaintext, &payload); err != nil || payload[test.secretField] != test.secret {
			t.Fatalf("decrypted payload mismatch for %s: err=%v", test.path, err)
		}
		status := serveJSON(handler, http.MethodGet, "/api/telegram/status?command_id="+queued.CommandID, "admin", "")
		if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"command_status":"pending"`) || (test.secret != "" && strings.Contains(status.Body.String(), test.secret)) {
			t.Fatalf("safe command status response for %s: status=%d body=%s", test.path, status.Code, status.Body.String())
		}
	}
	if err := db.Put(context.Background(), "telegram_state", "status", store.Document{"status": "connecting", "phone_masked": "***567", "reauth_required": false}); err != nil {
		t.Fatal(err)
	}
	current := serveJSON(handler, http.MethodGet, "/api/telegram/status", "admin", "")
	if current.Code != http.StatusOK || !strings.Contains(current.Body.String(), `"status":"connecting"`) {
		t.Fatalf("Telegram lifecycle status=%d body=%s", current.Code, current.Body.String())
	}
	if err := db.WithTx(context.Background(), func(tx *store.Tx) error {
		return tx.Put("telegram_commands", commandIDs[0], store.Document{"type": "start_login", "status": "done", "result": map[string]any{"status": "authorized", "phone_masked": "***567", "reauth_required": false}})
	}); err != nil {
		t.Fatal(err)
	}
	done := serveJSON(handler, http.MethodGet, "/api/telegram/status?command_id="+commandIDs[0], "admin", "")
	if done.Code != http.StatusOK || !strings.Contains(done.Body.String(), `"command_status":"done"`) || !strings.Contains(done.Body.String(), `"status":"authorized"`) {
		t.Fatalf("completed Telegram status=%d body=%s", done.Code, done.Body.String())
	}
}

func TestAlertAndQueueActionsCommitAuditsAndEnforceReplayBarrier(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	if err := db.Put(context.Background(), "alerts", "bridge_down", store.Document{"type": "bridge_disconnected", "severity": "critical", "status": "open", "last_seen_at": "2026-10-24T11:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "signal_events", "e1", store.Document{"chat_id": "-100", "message_id": "7", "kind": "signal", "created_at": "2026-10-24T10:00:00.000Z", "text": "raw message", "autotrader": map[string]any{"status": "dead_letter", "attempts": 8, "last_error": "gate_error", "history": []any{}}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(context.Background(), "signal_events", "e2", store.Document{"chat_id": "-100", "message_id": "7", "kind": "edit", "created_at": "2026-10-24T10:01:00.000Z", "autotrader": map[string]any{"status": "done", "attempts": 1}}); err != nil {
		t.Fatal(err)
	}

	alerts := serveJSON(handler, http.MethodGet, "/api/alerts?view=active", "viewer", "")
	if alerts.Code != http.StatusOK || !strings.Contains(alerts.Body.String(), "bridge_down") {
		t.Fatalf("alert read status=%d body=%s", alerts.Code, alerts.Body.String())
	}
	ack := serveJSON(handler, http.MethodPost, "/api/alerts/bridge_down", "admin", `{"action":"acknowledge"}`)
	if ack.Code != http.StatusOK {
		t.Fatalf("alert acknowledgement status=%d body=%s", ack.Code, ack.Body.String())
	}

	events := serveJSON(handler, http.MethodGet, "/api/signal-events?view=dead_letter", "viewer", "")
	if events.Code != http.StatusOK || strings.Contains(events.Body.String(), "raw message") {
		t.Fatalf("signal-event summary exposed raw text: status=%d body=%s", events.Code, events.Body.String())
	}
	blocked := serveJSON(handler, http.MethodPost, "/api/signal-events/e1", "admin", `{"action":"requeue","confirm":"REQUEUE"}`)
	if blocked.Code != http.StatusConflict || !strings.Contains(blocked.Body.String(), "superseded") {
		t.Fatalf("later event did not block replay: status=%d body=%s", blocked.Code, blocked.Body.String())
	}
	current, err := db.Get(context.Background(), "signal_events", "e1")
	if err != nil || stringField(object(current["autotrader"]), "status") != "dead_letter" {
		t.Fatalf("blocked requeue changed queue state: err=%v doc=%+v", err, current)
	}

	if err := db.WithTx(context.Background(), func(tx *store.Tx) error { return tx.Delete("signal_events", "e2") }); err != nil {
		t.Fatal(err)
	}
	requeued := serveJSON(handler, http.MethodPost, "/api/signal-events/e1", "admin", `{"action":"requeue","confirm":"REQUEUE"}`)
	if requeued.Code != http.StatusOK || !strings.Contains(requeued.Body.String(), `"status":"pending"`) {
		t.Fatalf("dead-letter requeue status=%d body=%s", requeued.Code, requeued.Body.String())
	}
	state, err := db.Get(context.Background(), "signal_events", "e1")
	if err != nil || stringField(object(state["autotrader"]), "status") != "pending" {
		t.Fatalf("requeue did not persist pending state: err=%v doc=%+v", err, state)
	}
	audits, err := db.List(context.Background(), "admin_audit", store.ListOptions{Limit: 20})
	if err != nil || len(audits) != 2 {
		t.Fatalf("alert and successful queue actions should each be audited: err=%v rows=%d", err, len(audits))
	}
}

func TestCloseAllOnlyQueuesPendingOperatorCommand(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	bad := serveJSON(handler, http.MethodPost, "/api/admin/close-all", "admin", `{"confirm":"CLOSE"}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("close-all accepted wrong confirmation: %d", bad.Code)
	}
	queued := serveJSON(handler, http.MethodPost, "/api/admin/close-all", "admin", `{"confirm":"CLOSE ALL"}`)
	if queued.Code != http.StatusCreated {
		t.Fatalf("close-all request status=%d body=%s", queued.Code, queued.Body.String())
	}
	var body struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(queued.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ID == "" || body.Status != "pending" {
		t.Fatalf("close-all was not persisted as pending: %s", queued.Body.String())
	}
	settings, err := db.Get(context.Background(), "settings", "default")
	if err != nil || object(settings["trading"])["kill_switch"] != true {
		t.Fatalf("close-all did not atomically engage the kill switch: err=%v settings=%+v", err, settings)
	}
	if _, err := db.Get(context.Background(), "paper_broker", "state"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("web close-all attempted a broker operation: err=%v", err)
	}
	status := serveJSON(handler, http.MethodGet, "/api/admin/close-all?id="+url.QueryEscape(body.ID), "viewer", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"pending"`) {
		t.Fatalf("close-all status read=%d body=%s", status.Code, status.Body.String())
	}
}

func TestTradeResolveRequiresTypedConfirmationAndExpiredSubmit(t *testing.T) {
	db := openTestStore(t)
	handler := adminTestHandler(t, db)
	tradeID := "-100_77"
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if err := db.Put(context.Background(), "trade_sets", tradeID, store.Document{"schema": 2, "trade_set_id": tradeID, "state": "SUBMIT_UNKNOWN", "mode": "demo", "submission": map[string]any{"expires_at": now.Unix() - 30}}); err != nil {
		t.Fatal(err)
	}
	confirm := `{"resolution":"not_executed","confirm":"RESOLVE -100_77"}`
	tooSoon := serveJSON(handler, http.MethodPost, "/api/trades/"+tradeID+"/resolve", "admin", confirm)
	if tooSoon.Code != http.StatusConflict {
		t.Fatalf("trade resolved inside uncertainty window: status=%d body=%s", tooSoon.Code, tooSoon.Body.String())
	}
	if err := db.Put(context.Background(), "trade_sets", tradeID, store.Document{"schema": 2, "trade_set_id": tradeID, "state": "SUBMIT_UNKNOWN", "mode": "demo", "submission": map[string]any{"expires_at": now.Unix() - 600}}); err != nil {
		t.Fatal(err)
	}
	resolved := serveJSON(handler, http.MethodPost, "/api/trades/"+tradeID+"/resolve", "admin", `{"resolution":"handled_manually","confirm":"RESOLVE -100_77","note":"closed in demo MT5"}`)
	if resolved.Code != http.StatusOK || !strings.Contains(resolved.Body.String(), `"state":"ERROR"`) {
		t.Fatalf("trade resolution status=%d body=%s", resolved.Code, resolved.Body.String())
	}
	trade, err := db.Get(context.Background(), "trade_sets", tradeID)
	if err != nil || stringField(trade, "error") != "operator_resolved_handled_manually" {
		t.Fatalf("trade resolution did not persist: err=%v doc=%+v", err, trade)
	}
	if _, err := db.Get(context.Background(), "trade_events", tradeID+"__operator_resolved"); err != nil {
		t.Fatalf("resolution event missing: %v", err)
	}
}

func mapFS(files map[string]string) fs.FS {
	entries := make(map[string]*fstest.MapFile, len(files))
	for name, body := range files {
		entries[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return fstest.MapFS(entries)
}
