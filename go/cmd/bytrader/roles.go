package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/bytrader/bytrader/internal/app"
	"github.com/bytrader/bytrader/internal/assets"
	"github.com/bytrader/bytrader/internal/bridge"
	"github.com/bytrader/bytrader/internal/engine"
	"github.com/bytrader/bytrader/internal/httpapi"
	"github.com/bytrader/bytrader/internal/notify"
	"github.com/bytrader/bytrader/internal/store"
	"github.com/bytrader/bytrader/internal/telegram"
)

func runWeb(ctx context.Context, db *store.SQLiteStore, opts options) error {
	files := assets.FS()
	if _, err := fs.Stat(files, "index.html"); err != nil {
		return errors.New("embedded UI missing: run deploy/go/build.sh before starting web")
	}
	verifier, err := httpapi.NewFirebaseVerifier(ctx)
	if err != nil {
		slog.Warn("firebase_auth_unavailable", "effect", "authenticated APIs fail closed")
	}
	allowed := allowedEmails()
	authReady := verifier != nil && len(allowed) > 0
	handler := httpapi.New(httpapi.Config{Store: db, Verifier: verifier, AllowedEmails: allowed, SecureCookies: !opts.insecureCookies, Assets: files})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /live", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "service": "web", "version": version})
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ready := db.Health(r.Context()) == nil && authReady
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		writeJSON(w, map[string]any{"ok": ready, "service": "web", "authentication_configured": authReady, "version": version})
	})
	mux.Handle("/", handler)
	server := &http.Server{Addr: opts.listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	return withHeartbeat(ctx, db, "web", func() app.ServiceSnapshot {
		return app.ServiceSnapshot{Healthy: authReady, Details: store.Document{"authentication_configured": authReady}}
	}, func(ctx context.Context) error {
		monitorCtx, stopMonitor := context.WithCancel(ctx)
		monitorDone := make(chan struct{})
		go func() { defer close(monitorDone); app.Monitor(monitorCtx, db, notify.New(db)) }()
		defer func() { stopMonitor(); <-monitorDone }()
		failed := make(chan error, 1)
		go func() { failed <- server.ListenAndServe() }()
		slog.Info("web_listening", "address", opts.listen, "version", version)
		select {
		case err := <-failed:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdown); err != nil {
				_ = server.Close()
				return err
			}
			return nil
		}
	})
}

func runExecutor(ctx context.Context, db *store.SQLiteStore, opts options) error {
	factory := &app.BrokerFactory{DB: db, OfflineSimulator: opts.offlineSimulator}
	if !opts.offlineSimulator {
		timeout := 5 * time.Second
		if raw, err := strconv.Atoi(os.Getenv("MT5_TIMEOUT_MS")); err == nil && raw > 0 {
			timeout = time.Duration(raw) * time.Millisecond
		}
		factory.Client = bridge.NewClient(bridge.ClientConfig{Endpoint: os.Getenv("MT5_ZMQ_ENDPOINT"), Timeout: timeout})
	}
	runner := engine.NewRunner(db, engine.Config{BrokerForMode: factory.ForMode, LiveTradingEnabled: os.Getenv("BYTRADER_LIVE_TRADING") == "enabled"})
	return withHeartbeat(ctx, db, "executor", func() app.ServiceSnapshot {
		ready := runner.Readiness()
		issues := []string{}
		if !ready.Ready {
			issues = append(issues, ready.Reason)
		}
		return app.ServiceSnapshot{Healthy: ready.Ready, Issues: issues, Details: store.Document{"readiness": ready, "offline_simulator": opts.offlineSimulator}}
	}, runner.Run)
}

func runForwarder(ctx context.Context, db *store.SQLiteStore) error {
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	runner := telegram.NewRunner(db, telegram.Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
	return withHeartbeat(ctx, db, "forwarder", func() app.ServiceSnapshot {
		status, err := db.Get(ctx, "telegram_state", "status")
		if err != nil {
			return app.ServiceSnapshot{Issues: []string{"telegram_not_ready"}}
		}
		healthy := status["status"] == "authorized"
		return app.ServiceSnapshot{Healthy: healthy, Details: store.Document{"telegram_status": status["status"]}}
	}, runner.Run)
}

func withHeartbeat(ctx context.Context, db store.Store, role string, snapshot func() app.ServiceSnapshot, run func(context.Context) error) error {
	roleCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); app.Heartbeat(roleCtx, db, role, version, snapshot) }()
	err := run(roleCtx)
	cancel()
	<-done
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return nil
	}
	return err
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
