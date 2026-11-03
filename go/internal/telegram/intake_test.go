package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/tg"
)

const validSignalText = "BUY XAUUSD\nENTRY: 2000\nSL: 1990\nTP1: 2010"

func openTelegramTestStore(t *testing.T) *store.SQLiteStore {
	t.Helper()
	db, err := store.Open(t.TempDir() + "/telegram.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func putSettings(t *testing.T, db store.Store, barrier time.Time, telegram map[string]any) {
	t.Helper()
	doc := store.Document{"telegram": telegram}
	if !barrier.IsZero() {
		at := store.ISO(barrier)
		doc["migration"] = store.Document{
			"cutover_at": at, "replay_not_before": at,
			"old_queue_disposition": "discarded_at_settled_boundary",
		}
	}
	if err := db.Put(context.Background(), "settings", "default", doc); err != nil {
		t.Fatal(err)
	}
}

func telegramMessage(id int, date time.Time, text string) *tg.Message {
	return &tg.Message{
		ID: id, Date: int(date.Unix()), Message: text, PeerID: &tg.PeerChannel{ChannelID: 1001},
	}
}

func TestReplayBarrierPersistsOldMessageAsIgnoredHistory(t *testing.T) {
	db := openTelegramTestStore(t)
	ctx := context.Background()
	barrier := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	putSettings(t, db, barrier, map[string]any{})
	runner := NewRunner(db, Config{})
	message := telegramMessage(7, barrier.Add(-time.Second), validSignalText)
	if err := runner.handleUpdate(ctx, nil, tg.Entities{}, message, "new"); err != nil {
		t.Fatal(err)
	}
	hash := textHash(validSignalText)
	history, err := db.Get(ctx, "telegram_messages", "-1001001_7_"+hash)
	if err != nil || stringValue(history["ignored_reason"]) != "before_replay_barrier" {
		t.Fatalf("pre-cutover source message was not durably ignored: %#v err=%v", history, err)
	}
	rows, err := db.List(ctx, "signal_events", store.ListOptions{Limit: 10})
	if err != nil || len(rows) != 0 {
		t.Fatalf("pre-cutover message published an executable event: %#v err=%v", rows, err)
	}
}

func TestUnsealedReplayBarrierFailsClosedAndReplyCancelTargetsOriginal(t *testing.T) {
	db := openTelegramTestStore(t)
	ctx := context.Background()
	if err := db.Put(ctx, "settings", "default", store.Document{
		"telegram":  map[string]any{},
		"migration": map[string]any{"replay_not_before": store.ISO(time.Now().Add(-time.Minute))},
	}); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(db, Config{})
	old := telegramMessage(8, time.Now(), validSignalText)
	if err := runner.handleUpdate(ctx, nil, tg.Entities{}, old, "new"); err != nil {
		t.Fatal(err)
	}
	oldHash := textHash(validSignalText)
	oldHistory, err := db.Get(ctx, "telegram_messages", "-1001001_8_"+oldHash)
	if err != nil || stringValue(oldHistory["ignored_reason"]) != "replay_barrier_missing" {
		t.Fatalf("missing replay barrier was not recorded: %#v err=%v", oldHistory, err)
	}
	if rows, err := db.List(ctx, "signal_events", store.ListOptions{Limit: 10}); err != nil || len(rows) != 0 {
		t.Fatalf("missing replay barrier allowed event publication: %#v err=%v", rows, err)
	}

	putSettings(t, db, time.Now().Add(-time.Minute), map[string]any{})
	cancel := telegramMessage(90, time.Now(), "Cancel")
	cancel.SetReplyTo(&tg.MessageReplyHeader{ReplyToMsgID: 8})
	if err := runner.handleUpdate(ctx, nil, tg.Entities{}, cancel, "new"); err != nil {
		t.Fatal(err)
	}
	cancelHash := textHash("Cancel")
	eventID := "-1001001_8_" + cancelHash
	event, err := db.Get(ctx, "signal_events", eventID)
	if err != nil {
		t.Fatal(err)
	}
	if event["kind"] != "cancel" || event["message_id"] != "8" || event["trigger_message_id"] != "90" || event["cancel_reason"] != "explicit_cancel" {
		t.Fatalf("reply cancel did not preserve target/trigger identity: %#v", event)
	}
}

func TestSignalEventCommitsBeforeForwardIntentAndEditsAreSeparateRevisions(t *testing.T) {
	db := openTelegramTestStore(t)
	ctx := context.Background()
	putSettings(t, db, time.Now().Add(-time.Minute), map[string]any{
		"signal_forward_enabled": true,
		"signal_source_chat_ids": []string{"-1001001"},
		"forward_chat_id":        "-1001002",
	})
	runner := NewRunner(db, Config{SourceChatIDs: []string{"-1001001"}, ForwardChatID: "-1001002"})
	date := time.Now()
	message := telegramMessage(10, date, validSignalText)
	if err := runner.handleUpdate(ctx, nil, tg.Entities{}, message, "new"); err != nil {
		t.Fatal(err)
	}
	hash := textHash(validSignalText)
	eventID := "-1001001_10_" + hash
	event, err := db.Get(ctx, "signal_events", eventID)
	if err != nil || object(event["autotrader"])["status"] != "pending" {
		t.Fatalf("event was not committed before forward attempt: %#v err=%v", event, err)
	}
	forward, err := db.Get(ctx, "signal_forwards", "-1001001_10")
	if err != nil || forward["status"] != "sending" || intValue(forward["revision"]) != 0 {
		t.Fatalf("forward intent missing after offline API seam: %#v err=%v", forward, err)
	}

	parsed := domain.ParseGoldSignal(validSignalText)
	if !parsed.OK {
		t.Fatal("test signal stopped parsing")
	}
	first, publish := eventForMessageWithReply("-1001001", "11", "new", validSignalText, "hash-a", date, parsed, "")
	second, edit := eventForMessageWithReply("-1001001", "11", "edit", validSignalText+"\n", "hash-b", date.Add(time.Second), parsed, "")
	if !publish || !edit || first.EventID == second.EventID || second.Document["message_type"] != "edit" {
		t.Fatalf("correction was not represented as a separate event revision: %+v / %+v", first, second)
	}
	if inserted, err := db.PublishSignalEvent(ctx, first.EventID, first.Document); err != nil || !inserted {
		t.Fatalf("publish original signal: inserted=%v err=%v", inserted, err)
	}
	if inserted, err := db.PublishSignalEvent(ctx, second.EventID, second.Document); err != nil || !inserted {
		t.Fatalf("publish signal correction: inserted=%v err=%v", inserted, err)
	}
	corrected, err := db.Get(ctx, "signal_events", second.EventID)
	if err != nil || corrected["message_type"] != "edit" || corrected["text_hash"] != "hash-b" {
		t.Fatalf("correction snapshot was not durably stored: %#v err=%v", corrected, err)
	}
}

func TestForwardRevisionDedupAndFormatting(t *testing.T) {
	db := openTelegramTestStore(t)
	runner := NewRunner(db, Config{})
	signal := domain.ParseGoldSignal(validSignalText).Signal
	first, created, err := runner.prepareForward(context.Background(), "-1001001", "22", "hash-a", *signal, "-1001002")
	if err != nil || !created || first.Revision != 0 || strings.Contains(first.Text, "CORRECTION") {
		t.Fatalf("initial forward intent: %+v created=%v err=%v", first, created, err)
	}
	if first.RandomID == 0 || first.RandomID != deterministicRandomID("-1001001", "22", "hash-a") {
		t.Fatalf("forward retry id is not deterministic: %d", first.RandomID)
	}
	if err := db.WithTx(context.Background(), func(tx *store.Tx) error {
		doc, err := tx.Get("signal_forwards", first.ID)
		if err != nil {
			return err
		}
		doc["status"] = "sent"
		return tx.Put("signal_forwards", first.ID, doc)
	}); err != nil {
		t.Fatal(err)
	}
	if _, created, err := runner.prepareForward(context.Background(), "-1001001", "22", "hash-a", *signal, "-1001002"); err != nil || created {
		t.Fatalf("same revision forwarded twice: created=%v err=%v", created, err)
	}
	correction, created, err := runner.prepareForward(context.Background(), "-1001001", "22", "hash-b", *signal, "-1001002")
	if err != nil || !created || correction.Revision != 1 || !strings.HasPrefix(correction.Text, "♻️ CORRECTION\n\n") {
		t.Fatalf("correction intent: %+v created=%v err=%v", correction, created, err)
	}
	if correction.RandomID == first.RandomID {
		t.Fatal("correction reused the original Telegram random_id")
	}
}

type failingPublisher struct {
	store.Store
	err error
}

func (s failingPublisher) PublishSignalEvent(context.Context, string, store.Document) (bool, error) {
	return false, s.err
}

func TestDurableEventCommitFailureDoesNotAdvanceStoredUpdateCursor(t *testing.T) {
	base := openTelegramTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	putSettings(t, base, time.Now().Add(-time.Minute), map[string]any{})
	commitErr := errors.New("SQLite commit failed")
	runner := NewRunner(failingPublisher{Store: base, err: commitErr}, Config{})
	guard := newIntakeGuard(cancel)
	message := telegramMessage(33, time.Now(), validSignalText)
	err := guard.handle(func() error { return runner.handleUpdate(ctx, nil, tg.Entities{}, message, "new") })
	if !errors.Is(err, commitErr) || ctx.Err() == nil {
		t.Fatalf("failed durable publish did not stop the update-manager context: err=%v ctx=%v", err, ctx.Err())
	}
	updateStore := NewUpdateStorage(base)
	if err := updateStore.SetChannelPts(ctx, 555, 1001, 91); err == nil {
		t.Fatal("gotd update cursor advanced using the cancelled intake context")
	}
	if _, found, err := updateStore.GetChannelPts(context.Background(), 555, 1001); err != nil || found {
		t.Fatalf("failed intake moved the durable replay cursor: found=%v err=%v", found, err)
	}
}

func TestCommandClaimCompletionRemovesEncryptedPayload(t *testing.T) {
	withTestMasterKey(t)
	db := openTelegramTestStore(t)
	ctx := context.Background()
	runner := NewRunner(db, Config{})
	runner.ownerID = "forwarder-owner"
	now := time.Now().UTC()
	if err := db.Put(ctx, "telegram_state", ownerDocumentID, store.Document{"owner_id": runner.ownerID, "lease_expires_at": store.ISO(now.Add(time.Minute))}); err != nil {
		t.Fatal(err)
	}
	payload, err := EncryptCommandPayload([]byte(`{"phone":"+491234567890"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Put(ctx, "telegram_commands", "login-1", store.Document{
		"type": "start_login", "status": "pending", "payload_enc": payload,
		"actor_uid": "admin", "created_at": store.ISO(now), "updated_at": store.ISO(now),
	}); err != nil {
		t.Fatal(err)
	}
	claimed, err := runner.claimCommand(ctx, now)
	if err != nil || claimed == nil || claimed.ID != "login-1" {
		t.Fatalf("claim command: %#v err=%v", claimed, err)
	}
	if err := runner.finishCommand(ctx, claimed, telegramStatus{Status: "awaiting_code", PhoneMasked: "***890"}, nil); err != nil {
		t.Fatal(err)
	}
	stored, err := db.Get(ctx, "telegram_commands", "login-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := stored["payload_enc"]; exists || stored["status"] != "done" {
		t.Fatalf("completed command retained login secret: %#v", stored)
	}
	if fmt.Sprint(stored["result"]) == "" || strings.Contains(fmt.Sprint(stored["result"]), "+491234567890") {
		t.Fatalf("command result exposed a login secret: %#v", stored["result"])
	}
	status, err := db.Get(ctx, "telegram_state", statusDocumentID)
	if err != nil || status["last_command_id"] != "login-1" || status["status"] != "awaiting_code" {
		t.Fatalf("global durable Telegram status not updated with command: %#v err=%v", status, err)
	}
}

func TestHistoryParserRetainsLegacyParsedShape(t *testing.T) {
	parsed := parseTelegramHistory("XAUUSDT NOW LONG\nSL: 1900\nTP: 2010\nTP: 2020\nTP: 2030")
	if !parsed.OK || parsed.Signal["symbol"] != "XAUUSDT" || parsed.Signal["direction"] != "long" {
		t.Fatalf("legacy Telegram history parse failed: %+v", parsed)
	}
	if got := fmt.Sprint(parsed.Signal["takeProfits"]); got != "[2010 2020 2030]" {
		t.Fatalf("legacy Telegram history target shape changed: %s", got)
	}
	if got := parseTelegramHistory("XAUUSDT NOW LONG\nSL: 1900\nTP1: 2010\nTP2: 2020\nTP3: 2030"); got.OK || got.Error != "missing_tp" {
		t.Fatalf("legacy parser's TP token behavior changed: %+v", got)
	}
}

func textHash(text string) string {
	hash := sha256.Sum256([]byte(text))
	return hex.EncodeToString(hash[:])
}

func TestDialogsRequestIncludesOffsetPeer(t *testing.T) {
	// Telegram requires offset_peer on messages.getDialogs; gotd returns an
	// encode error when it is nil, which previously blocked every forward.
	buffer := bin.Buffer{}
	if err := dialogsRequest().Encode(&buffer); err != nil {
		t.Fatalf("messages.getDialogs request must encode: %v", err)
	}
}
