package httpapi

import (
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

const sessionCookie = "bytrader_session"

type Config struct {
	Store         store.Store
	Verifier      TokenVerifier
	AllowedEmails []string
	SecureCookies bool
	Assets        fs.FS
	Now           func() time.Time
}

type Handler struct {
	store         store.Store
	verifier      TokenVerifier
	allowedEmails map[string]struct{}
	secureCookies bool
	assets        fs.FS
	now           func() time.Time
}

func New(cfg Config) http.Handler {
	allowed := make(map[string]struct{}, len(cfg.AllowedEmails))
	for _, email := range cfg.AllowedEmails {
		if email = normalizeEmail(email); email != "" {
			allowed[email] = struct{}{}
		}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	h := &Handler{
		store: cfg.Store, verifier: cfg.Verifier, allowedEmails: allowed,
		secureCookies: cfg.SecureCookies, assets: cfg.Assets, now: now,
	}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/admin/close-all", h.getCloseAll)
	mux.HandleFunc("POST /api/admin/close-all", h.postCloseAll)
	mux.HandleFunc("POST /api/admin/ping", h.postAdminPing)
	mux.HandleFunc("POST /api/admin/role", h.postRole)
	mux.HandleFunc("GET /api/alerts", h.getAlerts)
	mux.HandleFunc("POST /api/alerts/{id}", h.postAlertAction)
	mux.HandleFunc("GET /api/execution/status", h.getExecutionStatus)
	mux.HandleFunc("POST /api/execution/mode", h.postExecutionMode)
	mux.HandleFunc("POST /api/execution/kill-switch", h.postKillSwitch)
	mux.HandleFunc("POST /api/execution/safety", h.postSafety)
	mux.HandleFunc("GET /api/profiles", h.getProfiles)
	mux.HandleFunc("POST /api/profiles", h.postProfile)
	mux.HandleFunc("GET /api/profiles/audit", h.getProfileAudit)
	mux.HandleFunc("POST /api/profiles/rollback", h.postProfileRollback)
	mux.HandleFunc("POST /api/profiles/validate", h.postProfileValidate)
	mux.HandleFunc("GET /api/profiles/{docID}", h.getProfile)
	mux.HandleFunc("PUT /api/profiles/{docID}", h.putProfile)
	mux.HandleFunc("POST /api/profiles/{docID}/approve", h.postProfileApprove)
	mux.HandleFunc("POST /api/profiles/{docID}/activate", h.postProfileActivate)
	mux.HandleFunc("POST /api/profiles/{docID}/reject", h.postProfileReject)
	mux.HandleFunc("POST /api/session", h.postSession)
	mux.HandleFunc("DELETE /api/session", h.deleteSession)
	mux.HandleFunc("GET /api/settings", h.getSettings)
	mux.HandleFunc("POST /api/settings", h.postSettings)
	mux.HandleFunc("GET /api/signal-events", h.getSignalEvents)
	mux.HandleFunc("POST /api/signal-events/{id}", h.postSignalEventAction)
	mux.HandleFunc("GET /api/telegram/status", h.getTelegramStatus)
	mux.HandleFunc("POST /api/telegram/start", h.postTelegramStart)
	mux.HandleFunc("POST /api/telegram/verify-otp", h.postTelegramOTP)
	mux.HandleFunc("POST /api/telegram/verify-password", h.postTelegramPassword)
	mux.HandleFunc("POST /api/telegram/logout", h.postTelegramLogout)
	mux.HandleFunc("GET /api/trades", h.getTrades)
	mux.HandleFunc("GET /api/trades/{id}/events", h.getTradeEvents)
	mux.HandleFunc("POST /api/trades/{id}/resolve", h.postTradeResolve)
	mux.HandleFunc("POST /api/users/ensure", h.postEnsureUser)
	mux.HandleFunc("GET /api/worker/health", h.getWorkerHealth)
	mux.HandleFunc("GET /api/logs", h.getLogs)
	mux.HandleFunc("GET /api/telegram/messages", h.getTelegramMessages)
	mux.HandleFunc("GET /api/overview", h.getOverview)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, "Not found", http.StatusNotFound)
	})
	mux.Handle("/", h.spa())

	return h.sameOrigin(mux)
}

func (h *Handler) requireStore(w http.ResponseWriter) bool {
	if h.store != nil {
		return true
	}
	writeError(w, "Store unavailable", http.StatusServiceUnavailable)
	return false
}

func (h *Handler) requireVerifier(w http.ResponseWriter) bool {
	if h.verifier != nil {
		return true
	}
	writeError(w, "Authentication service unavailable", http.StatusServiceUnavailable)
	return false
}

func (h *Handler) sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && !isSameOrigin(r) {
			writeError(w, "Cross-origin request refused", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions &&
			r.Header.Get("Authorization") == "" && r.Header.Get("Origin") == "" &&
			r.Header.Get("Sec-Fetch-Site") != "same-origin" {
			if _, err := r.Cookie(sessionCookie); err == nil {
				writeError(w, "Same-origin request metadata is required", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

var errVerifierUnavailable = errors.New("authentication service unavailable")
