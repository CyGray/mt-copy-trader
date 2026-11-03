package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/assets"
	"github.com/bytrader/bytrader/internal/httpapi"
	"github.com/bytrader/bytrader/internal/store"
)

type browserVerifier struct{ token string }

func (v browserVerifier) VerifyIDTokenAndCheckRevoked(_ context.Context, token string) (httpapi.Claims, error) {
	if token != v.token {
		return httpapi.Claims{}, errors.New("invalid offline token")
	}
	return httpapi.Claims{UID: "browser-admin", Email: "operator@example.test", EmailVerified: true, AuthTime: time.Now().Unix()}, nil
}
func (v browserVerifier) VerifySessionCookieAndCheckRevoked(ctx context.Context, cookie string) (httpapi.Claims, error) {
	if cookie != "offline-browser-session" {
		return httpapi.Claims{}, errors.New("invalid offline session")
	}
	return v.VerifyIDTokenAndCheckRevoked(ctx, v.token)
}
func (v browserVerifier) CreateSessionCookie(ctx context.Context, token string, _ time.Duration) (string, error) {
	_, err := v.VerifyIDTokenAndCheckRevoked(ctx, token)
	return "offline-browser-session", err
}

func TestBrowserOperatorRoutes(t *testing.T) {
	if os.Getenv("BYTRADER_BROWSER_TEST") != "1" {
		t.Skip("opt-in browser check with built assets and a test-only Firebase verifier")
	}
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Initialize(ctx, db, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(ctx, "users", "browser-admin", store.Document{"role": "admin", "email": "operator@example.test"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		if err := db.Put(ctx, "telegram_messages", fmt.Sprintf("equal-%03d", i), store.Document{"chat_id": "-100123", "message_id": fmt.Sprint(i), "text": fmt.Sprintf("offline message %d", i), "timestamp": "2026-10-24T12:00:00.000Z", "created_at": "2026-10-24T12:00:00.000Z"}); err != nil {
			t.Fatal(err)
		}
	}
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	now := time.Now().Unix()
	token := encode(map[string]string{"alg": "RS256", "typ": "JWT", "kid": "offline"}) + "." + encode(map[string]any{"iss": "https://securetoken.google.com/offline-bytrader", "aud": "offline-bytrader", "sub": "browser-admin", "user_id": "browser-admin", "email": "operator@example.test", "email_verified": true, "iat": now, "auth_time": now, "exp": now + 3600, "firebase": map[string]any{"sign_in_provider": "google.com"}}) + ".b2ZmbGluZQ"
	server := httptest.NewServer(httpapi.New(httpapi.Config{Store: db, Verifier: browserVerifier{token}, AllowedEmails: []string{"operator@example.test"}, Assets: assets.FS()}))
	defer server.Close()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "migration/browser-check.cjs"), server.URL, token)
	cmd.Dir = root
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
	commands, err := db.List(ctx, "admin_commands", store.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0]["status"] != "pending" {
		t.Fatalf("executor-down command state: %v", commands)
	}
	settings, err := db.Get(ctx, "settings", "default")
	if err != nil {
		t.Fatal(err)
	}
	if object(settings["trading"])["kill_switch"] != true {
		t.Fatal("close-all did not atomically engage kill switch")
	}
}
