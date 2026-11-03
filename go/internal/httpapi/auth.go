package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"github.com/bytrader/bytrader/internal/store"
	"google.golang.org/api/option"
)

type Claims struct {
	UID           string
	Email         string
	EmailVerified bool
	AuthTime      int64
}

type TokenVerifier interface {
	VerifyIDTokenAndCheckRevoked(ctx context.Context, token string) (Claims, error)
	VerifySessionCookieAndCheckRevoked(ctx context.Context, cookie string) (Claims, error)
	CreateSessionCookie(ctx context.Context, idToken string, expiresIn time.Duration) (string, error)
}

var errInvalidCredential = errors.New("invalid or revoked Firebase credential")

type firebaseVerifier struct {
	client *auth.Client
}

// NewFirebaseVerifier uses the same service-account environment as the previous web API.
// Missing credentials returns nil so the web role can still serve its assets and health.
func NewFirebaseVerifier(ctx context.Context) (TokenVerifier, error) {
	projectID := strings.TrimSpace(os.Getenv("FIREBASE_PROJECT_ID"))
	clientEmail := strings.TrimSpace(os.Getenv("FIREBASE_CLIENT_EMAIL"))
	privateKey := strings.ReplaceAll(os.Getenv("FIREBASE_PRIVATE_KEY"), `\n`, "\n")
	if projectID == "" || clientEmail == "" || privateKey == "" {
		return nil, errVerifierUnavailable
	}
	credentials, err := json.Marshal(map[string]string{
		"type": "service_account", "project_id": projectID,
		"client_email": clientEmail, "private_key": privateKey,
		"token_uri": "https://oauth2.googleapis.com/token",
	})
	if err != nil {
		return nil, fmt.Errorf("build Firebase credentials: %w", err)
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID}, option.WithCredentialsJSON(credentials))
	if err != nil {
		return nil, fmt.Errorf("initialize Firebase auth: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("initialize Firebase auth client: %w", err)
	}
	return &firebaseVerifier{client: client}, nil
}

func (v *firebaseVerifier) VerifyIDTokenAndCheckRevoked(ctx context.Context, token string) (Claims, error) {
	decoded, err := v.client.VerifyIDTokenAndCheckRevoked(ctx, token)
	if err != nil {
		if auth.IsIDTokenInvalid(err) {
			return Claims{}, errInvalidCredential
		}
		return Claims{}, err
	}
	return claimsFromFirebase(decoded), nil
}

func (v *firebaseVerifier) VerifySessionCookieAndCheckRevoked(ctx context.Context, cookie string) (Claims, error) {
	decoded, err := v.client.VerifySessionCookieAndCheckRevoked(ctx, cookie)
	if err != nil {
		if auth.IsSessionCookieInvalid(err) {
			return Claims{}, errInvalidCredential
		}
		return Claims{}, err
	}
	return claimsFromFirebase(decoded), nil
}

func (v *firebaseVerifier) CreateSessionCookie(ctx context.Context, idToken string, expiresIn time.Duration) (string, error) {
	return v.client.SessionCookie(ctx, idToken, expiresIn)
}

func claimsFromFirebase(token *auth.Token) Claims {
	email, _ := token.Claims["email"].(string)
	verified, _ := token.Claims["email_verified"].(bool)
	return Claims{UID: token.UID, Email: email, EmailVerified: verified, AuthTime: token.AuthTime}
}

type authenticatedUser struct {
	UID   string
	Email string
}

func (h *Handler) authenticate(r *http.Request) (authenticatedUser, error) {
	if h.verifier == nil {
		return authenticatedUser{}, errVerifierUnavailable
	}
	token, bearer := requestCredential(r)
	if token == "" {
		return authenticatedUser{}, &apiError{Status: http.StatusUnauthorized, Message: "Not signed in"}
	}
	var claims Claims
	var err error
	if bearer {
		claims, err = h.verifier.VerifyIDTokenAndCheckRevoked(r.Context(), token)
	} else {
		claims, err = h.verifier.VerifySessionCookieAndCheckRevoked(r.Context(), token)
	}
	if err != nil {
		if errors.Is(err, errInvalidCredential) {
			return authenticatedUser{}, &apiError{Status: http.StatusUnauthorized, Message: "Invalid or expired token"}
		}
		return authenticatedUser{}, errVerifierUnavailable
	}
	if !claims.EmailVerified {
		return authenticatedUser{}, &apiError{Status: http.StatusForbidden, Message: "Email not verified"}
	}
	email := normalizeEmail(claims.Email)
	if email == "" {
		return authenticatedUser{}, &apiError{Status: http.StatusForbidden, Message: "Email not allowed"}
	}
	if len(h.allowedEmails) == 0 {
		return authenticatedUser{}, &apiError{Status: http.StatusForbidden, Message: "Access allow-list (ALLOWED_EMAILS) is not configured"}
	}
	if _, ok := h.allowedEmails[email]; !ok {
		return authenticatedUser{}, &apiError{Status: http.StatusForbidden, Message: "Email not allowed"}
	}
	if claims.UID == "" {
		return authenticatedUser{}, &apiError{Status: http.StatusUnauthorized, Message: "Invalid or expired token"}
	}
	return authenticatedUser{UID: claims.UID, Email: email}, nil
}

func (h *Handler) requireUser(w http.ResponseWriter, r *http.Request) (authenticatedUser, bool) {
	user, err := h.authenticate(r)
	if err != nil {
		writeAPIError(w, err)
		return authenticatedUser{}, false
	}
	return user, true
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (authenticatedUser, bool) {
	user, ok := h.requireUser(w, r)
	if !ok {
		return authenticatedUser{}, false
	}
	if h.store == nil {
		writeError(w, "Store unavailable", http.StatusServiceUnavailable)
		return authenticatedUser{}, false
	}
	doc, err := h.store.Get(r.Context(), "users", user.UID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, "Role lookup unavailable", http.StatusServiceUnavailable)
		return authenticatedUser{}, false
	}
	if stringField(doc, "role") != "admin" {
		writeError(w, "Admin role required", http.StatusForbidden)
		return authenticatedUser{}, false
	}
	return user, true
}

func requestCredential(r *http.Request) (token string, bearer bool) {
	if header := r.Header.Get("Authorization"); header != "" {
		match := strings.Fields(header)
		if len(match) != 2 || !strings.EqualFold(match[0], "Bearer") || match[1] == "" {
			return "", true
		}
		return match[1], true
	}
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}
	return cookie.Value, false
}

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func (h *Handler) postSession(w http.ResponseWriter, r *http.Request) {
	if h.verifier == nil {
		writeError(w, "Authentication service unavailable", http.StatusServiceUnavailable)
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	idToken, _ := body["token"].(string)
	if idToken == "" {
		writeError(w, "Missing token", http.StatusBadRequest)
		return
	}
	claims, err := h.verifier.VerifyIDTokenAndCheckRevoked(r.Context(), idToken)
	if err != nil {
		if errors.Is(err, errInvalidCredential) {
			writeError(w, "Unauthorized", http.StatusUnauthorized)
		} else {
			writeError(w, "Token verification unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	if err := h.refuseEmail(claims); err != nil {
		writeAPIError(w, err)
		return
	}
	if claims.UID == "" {
		writeError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	cookie, err := h.verifier.CreateSessionCookie(r.Context(), idToken, time.Hour)
	if err != nil {
		if errors.Is(err, errInvalidCredential) {
			writeError(w, "Invalid or expired token", http.StatusUnauthorized)
		} else {
			writeError(w, "Session creation unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: cookie, Path: "/", HttpOnly: true,
		Secure: h.secureCookies, SameSite: http.SameSiteLaxMode,
		MaxAge: int(time.Hour.Seconds()), Expires: h.now().Add(time.Hour),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) deleteSession(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: h.secureCookies, SameSite: http.SameSiteLaxMode,
		MaxAge: -1, Expires: time.Unix(0, 0),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) refuseEmail(claims Claims) error {
	if !claims.EmailVerified {
		return &apiError{Status: http.StatusForbidden, Message: "Email not verified"}
	}
	email := normalizeEmail(claims.Email)
	if email == "" {
		return &apiError{Status: http.StatusForbidden, Message: "Email not allowed"}
	}
	if len(h.allowedEmails) == 0 {
		return &apiError{Status: http.StatusForbidden, Message: "Access allow-list (ALLOWED_EMAILS) is not configured"}
	}
	if _, ok := h.allowedEmails[email]; !ok {
		return &apiError{Status: http.StatusForbidden, Message: "Email not allowed"}
	}
	return nil
}

func sameOrigin(r *http.Request) bool { return isSameOrigin(r) }
