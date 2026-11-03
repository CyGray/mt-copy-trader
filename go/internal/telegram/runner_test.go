package telegram

import (
	"context"
	"testing"

	"github.com/bytrader/bytrader/internal/store"
)

func TestConnectionStatusTransitionsAreDurableAndSafe(t *testing.T) {
	db := openTelegramTestStore(t)
	ctx := context.Background()
	runner := NewRunner(db, Config{})
	if err := db.Put(ctx, "telegram_state", statusDocumentID, store.Document{
		"status": "authorized", "phone_masked": "***321", "reauth_required": true,
		"last_error": "previous_safe_error", "last_command_id": "command-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := runner.setConnectingStatus(ctx); err != nil {
		t.Fatal(err)
	}
	connecting, err := db.Get(ctx, "telegram_state", statusDocumentID)
	if err != nil || connecting["status"] != "connecting" || connecting["phone_masked"] != "***321" || connecting["last_error"] != "previous_safe_error" || connecting["last_command_id"] != "command-1" || connecting["reauth_required"] != true {
		t.Fatalf("connecting transition lost safe auth context: %#v err=%v", connecting, err)
	}
	if err := runner.setConnectionFailure(ctx, "telegram_connection_lost"); err != nil {
		t.Fatal(err)
	}
	disconnected, err := db.Get(ctx, "telegram_state", statusDocumentID)
	if err != nil || disconnected["status"] != "disconnected" || disconnected["last_error"] != "telegram_connection_lost" || disconnected["phone_masked"] != "***321" || disconnected["last_command_id"] != "command-1" || disconnected["reauth_required"] != true {
		t.Fatalf("disconnected transition lost safe auth context: %#v err=%v", disconnected, err)
	}
}
