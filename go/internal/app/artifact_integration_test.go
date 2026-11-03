package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/broker"
	"github.com/bytrader/bytrader/internal/store"
)

func TestPackagedExecutorPaperQueueAndRestart(t *testing.T) {
	binary := os.Getenv("BYTRADER_ARTIFACT_BINARY")
	if binary == "" {
		t.Skip("opt-in packaged binary test with isolated PAPER state")
	}
	if !filepath.IsAbs(binary) {
		t.Fatal("artifact binary must be an absolute path")
	}
	w := newPipeline(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	event := w.event("packaged")
	if inserted, err := w.db.PublishSignalEvent(ctx, event.EventID, store.Document{"chat_id": event.ChatID, "message_id": event.MessageID, "message_type": "new", "kind": "signal", "text_hash": "hash", "signal": event.Signal, "message_date": event.MessageDate, "created_at": store.ISO(w.now), "autotrader": map[string]any{"status": "pending", "attempts": 0}}); err != nil || !inserted {
		t.Fatalf("fixture publish: inserted=%v err=%v", inserted, err)
	}
	start := func() *exec.Cmd {
		cmd := exec.CommandContext(ctx, binary, "executor", "--db", w.path, "--offline-simulator")
		for _, entry := range os.Environ() {
			key := strings.SplitN(entry, "=", 2)[0]
			if !strings.HasPrefix(key, "FIREBASE_") && !strings.HasPrefix(key, "GOOGLE_") && !strings.HasPrefix(key, "TELEGRAM_") && !strings.HasPrefix(key, "MT5_") && !strings.HasPrefix(key, "ALERT_") && !strings.HasPrefix(key, "BYTRADER_") && key != "MASTER_KEY" {
				cmd.Env = append(cmd.Env, entry)
			}
		}
		cmd.Env = append(cmd.Env, "ALERT_NOTIFICATIONS=disabled")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		})
		return cmd
	}
	readState := func() broker.SimState {
		doc, err := w.db.Get(ctx, "paper_broker", "state")
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		var state broker.SimState
		if err := json.Unmarshal(data, &state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	first := start()
	deadline := time.Now().Add(12 * time.Second)
	for {
		doc, err := w.db.Get(ctx, "signal_events", event.EventID)
		if err == nil && object(doc["autotrader"])["status"] == "done" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("packaged executor did not complete the synthetic durable event")
		}
		time.Sleep(50 * time.Millisecond)
	}
	before := readState()
	if len(before.Positions) != 1 || len(before.Deals) != 1 || w.trade("packaged")["state"] != "OPEN" {
		t.Fatalf("packaged PAPER fill was not durable: %+v", before)
	}
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	second := start()
	time.Sleep(3500 * time.Millisecond)
	if err := second.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := second.Wait(); err != nil {
		t.Fatalf("packaged executor failed graceful restart/shutdown: %v", err)
	}
	after := readState()
	if len(after.Positions) != 1 || len(after.Deals) != 1 || after.NextOrderTicket != before.NextOrderTicket || after.Positions[0].Ticket != before.Positions[0].Ticket {
		t.Fatalf("packaged restart duplicated or lost the PAPER fill: before=%+v after=%+v", before, after)
	}
	t.Log("packaged binary completed one synthetic PAPER event; SIGKILL/restart preserved one position and one entry deal")
}
