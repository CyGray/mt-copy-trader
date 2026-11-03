package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

type apiError struct {
	Status  int
	Message string
	Extra   map[string]any
}

func (e *apiError) Error() string { return e.Message }

func writeError(w http.ResponseWriter, message string, status int) {
	writeJSON(w, status, map[string]any{"error": message})
}

func writeAPIError(w http.ResponseWriter, err error) {
	var api *apiError
	if errors.As(err, &api) {
		body := map[string]any{"error": api.Message}
		for key, value := range api.Extra {
			body[key] = value
		}
		writeJSON(w, api.Status, body)
		return
	}
	if errors.Is(err, errVerifierUnavailable) {
		writeError(w, "Authentication service unavailable", http.StatusServiceUnavailable)
		return
	}
	writeError(w, "Request failed", http.StatusServiceUnavailable)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func readObject(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		writeError(w, "Body must be a JSON object", http.StatusBadRequest)
		return nil, false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		writeError(w, "Body must contain one JSON object", http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

func object(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func stringField(doc map[string]any, key string) string {
	s, _ := doc[key].(string)
	return s
}

func stringValue(v any) string { s, _ := v.(string); return s }

func boolField(doc map[string]any, key string) bool { b, _ := doc[key].(bool); return b }

func intValue(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	}
	return 0, false
}

func cloneMap(doc map[string]any) map[string]any {
	b, _ := json.Marshal(doc)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if out == nil {
		return map[string]any{}
	}
	return out
}

func mergeMap(dst map[string]any, src map[string]any) map[string]any {
	if dst == nil {
		dst = map[string]any{}
	}
	for key, value := range src {
		if child, ok := value.(map[string]any); ok {
			dst[key] = mergeMap(object(dst[key]), child)
		} else {
			dst[key] = value
		}
	}
	return dst
}

func idOf(doc store.Document) string { return stringField(doc, "_id") }

func publicDocument(doc store.Document) map[string]any {
	out := cloneMap(doc)
	id := stringField(out, "_id")
	delete(out, "_id")
	if id != "" {
		out["id"] = id
	}
	return out
}

func isSameOrigin(r *http.Request) bool {
	if site := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); site == "cross-site" {
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	return strings.EqualFold(u.Host, r.Host) && strings.EqualFold(u.Scheme, scheme)
}

func (h *Handler) spa() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.assets == nil {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		f, err := h.assets.Open(name)
		if err == nil {
			info, statErr := f.Stat()
			if statErr == nil && !info.IsDir() {
				data, readErr := io.ReadAll(f)
				_ = f.Close()
				if readErr != nil {
					http.NotFound(w, r)
					return
				}
				if typ := mime.TypeByExtension(path.Ext(name)); typ != "" {
					w.Header().Set("Content-Type", typ)
				}
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				http.ServeContent(w, r, info.Name(), info.ModTime(), bytes.NewReader(data))
				return
			}
			_ = f.Close()
		}
		if strings.HasPrefix(name, "api/") || path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		index, err := h.assets.Open("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		info, err := index.Stat()
		if err != nil {
			_ = index.Close()
			http.NotFound(w, r)
			return
		}
		data, err := io.ReadAll(index)
		_ = index.Close()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", info.ModTime(), bytes.NewReader(data))
	})
}

var cursorIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,300}$`)

func encodeCursor(c store.Cursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string, field store.TimeField, descending bool) (*store.Cursor, error) {
	if raw == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(data) > 2048 {
		return nil, fmt.Errorf("invalid cursor")
	}
	var c store.Cursor
	if json.Unmarshal(data, &c) != nil || !cursorIDPattern.MatchString(c.ID) || c.Time == "" || c.TimeField != field || c.Descending != descending {
		return nil, fmt.Errorf("invalid cursor")
	}
	return &c, nil
}

func queryLimit(r *http.Request, fallback, max int) int {
	value := r.URL.Query().Get("limit")
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		return fallback
	}
	if n > max {
		return max
	}
	return n
}

func (h *Handler) listPage(w http.ResponseWriter, r *http.Request, collection string, opts store.ListOptions, limit int) ([]map[string]any, string, bool) {
	if !h.requireStore(w) {
		return nil, "", false
	}
	opts.Limit = limit + 1
	docs, err := h.store.List(r.Context(), collection, opts)
	if err != nil {
		writeError(w, "Read failed", http.StatusServiceUnavailable)
		return nil, "", false
	}
	hasMore := len(docs) > limit
	if hasMore {
		docs = docs[:limit]
	}
	items := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		items = append(items, publicDocument(d))
	}
	next := ""
	if hasMore && len(docs) > 0 {
		last := docs[len(docs)-1]
		next = encodeCursor(store.Cursor{Time: stringField(last, string(opts.TimeField)), ID: idOf(last), TimeField: opts.TimeField, Descending: opts.Descending})
	}
	return items, next, true
}

func at(h *Handler) string { return store.ISO(h.now()) }

func parseISO(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

func requireBodyFieldString(w http.ResponseWriter, body map[string]any, key string) (string, bool) {
	s, ok := body[key].(string)
	if !ok || strings.TrimSpace(s) == "" {
		writeError(w, "Missing "+key, http.StatusBadRequest)
		return "", false
	}
	return s, true
}
