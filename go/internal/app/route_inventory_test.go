package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/bytrader/bytrader/internal/httpapi"
)

func TestEveryV2HandlerIsRegisteredAndDeniesAnonymousAccess(t *testing.T) {
	data, err := os.ReadFile("../../migration/evidence/route-inventory.json")
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		PageCount    int `json:"page_count"`
		RouteModules int `json:"route_modules"`
		HandlerCount int `json:"handler_count"`
		Routes       []struct {
			Path    string   `json:"path"`
			Methods []string `json:"methods"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	if inventory.PageCount != 11 || inventory.RouteModules != 29 || inventory.HandlerCount != 33 {
		t.Fatal("baseline route inventory changed without updating parity scope")
	}
	handler := httpapi.New(httpapi.Config{})
	parameter := regexp.MustCompile(`\[[^]]+\]`)
	count := 0
	for _, route := range inventory.Routes {
		for _, method := range route.Methods {
			count++
			path := parameter.ReplaceAllString(route.Path, "offline-fixture")
			t.Run(method+" "+path, func(t *testing.T) {
				request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if method == http.MethodDelete && path == "/api/session" {
					if response.Code != http.StatusOK {
						t.Fatalf("public logout contract: %d", response.Code)
					}
					return
				}
				if response.Code != http.StatusUnauthorized && response.Code != http.StatusServiceUnavailable {
					t.Fatalf("unregistered or unauthenticated handler: status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	}
	if count != 33 {
		t.Fatalf("checked %d handlers", count)
	}
}
