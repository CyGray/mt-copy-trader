package telegram

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/bytrader/bytrader/internal/store"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram/updates"
)

func withTestMasterKey(t *testing.T) {
	t.Helper()
	t.Setenv("MASTER_KEY", base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
}

func TestEncryptedTelegramPayloadRoundTripAndTamperRejection(t *testing.T) {
	withTestMasterKey(t)
	secret := []byte(`{"code":"12345","password":"not-stored-plain"}`)
	envelope, err := EncryptCommandPayload(secret)
	if err != nil {
		t.Fatal(err)
	}
	if len(envelope) <= len(string(secret)) || envelope[:3] != encryptedPrefix {
		t.Fatalf("unexpected encrypted envelope: %q", envelope)
	}
	decoded, err := DecryptCommandPayload(envelope)
	if err != nil || string(decoded) != string(secret) {
		t.Fatalf("decrypt: %q err=%v", decoded, err)
	}
	tampered := envelope[:len(envelope)-2] + "AA"
	if _, err := DecryptCommandPayload(tampered); err == nil {
		t.Fatal("tampered ciphertext authenticated")
	}
	t.Setenv("MASTER_KEY", base64.StdEncoding.EncodeToString([]byte("fedcba9876543210fedcba9876543210")))
	if _, err := DecryptCommandPayload(envelope); err == nil {
		t.Fatal("ciphertext decrypted with the wrong master key")
	}
}

func TestEncryptedSessionStorageAndDurableUpdateState(t *testing.T) {
	withTestMasterKey(t)
	path := filepath.Join(t.TempDir(), "store.db")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	sessionStore := NewSessionStorage(db)
	if _, err := sessionStore.LoadSession(ctx); !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("empty session should ask gotd to reauthenticate: %v", err)
	}
	plainSession := []byte(`{"dc":2,"auth_key":"test-only"}`)
	if err := sessionStore.StoreSession(ctx, plainSession); err != nil {
		t.Fatal(err)
	}
	stored, err := db.Get(ctx, sessionCollection, sessionDocumentID)
	if err != nil {
		t.Fatal(err)
	}
	if stringValue(stored["payload_enc"]) == string(plainSession) {
		t.Fatal("MTProto session was stored in plaintext")
	}
	got, err := sessionStore.LoadSession(ctx)
	if err != nil || string(got) != string(plainSession) {
		t.Fatalf("load encrypted session: %q err=%v", got, err)
	}
	if exists, err := sessionStore.Exists(ctx); err != nil || !exists {
		t.Fatalf("session Exists: exists=%v err=%v", exists, err)
	}
	if err := sessionStore.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	if exists, err := sessionStore.Exists(ctx); err != nil || exists {
		t.Fatalf("session Clear: exists=%v err=%v", exists, err)
	}

	updatesStore := NewUpdateStorage(db)
	state, found, err := updatesStore.GetState(ctx, 1234)
	if err != nil || found || state != (updates.State{}) {
		t.Fatalf("empty update cursor: state=%+v found=%v err=%v", state, found, err)
	}
	state = updates.State{Pts: 11, Qts: 12, Date: 13, Seq: 14}
	if err := updatesStore.SetState(ctx, 1234, state); err != nil {
		t.Fatal(err)
	}
	if err := updatesStore.SetPts(ctx, 1234, 21); err != nil {
		t.Fatal(err)
	}
	if err := updatesStore.SetDateSeq(ctx, 1234, 31, 41); err != nil {
		t.Fatal(err)
	}
	gotState, found, err := updatesStore.GetState(ctx, 1234)
	if err != nil || !found || gotState != (updates.State{Pts: 21, Qts: 12, Date: 31, Seq: 41}) {
		t.Fatalf("update cursor roundtrip: state=%+v found=%v err=%v", gotState, found, err)
	}
	if err := updatesStore.SetQts(ctx, 999, 3); err == nil {
		t.Fatal("partial state update silently created a missing user cursor")
	}

	if err := updatesStore.SetChannelPts(ctx, 1234, 77, 5); err != nil {
		t.Fatal(err)
	}
	if err := updatesStore.SetChannelPts(ctx, 1234, 88, 8); err != nil {
		t.Fatal(err)
	}
	var seen = map[int64]int{}
	if err := updatesStore.ForEachChannels(ctx, 1234, func(_ context.Context, id int64, pts int) error {
		seen[id] = pts
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 || seen[77] != 5 || seen[88] != 8 {
		t.Fatalf("durable channel cursors: %#v", seen)
	}
	access := NewAccessHashStorage(db)
	if err := access.SetChannelAccessHash(ctx, 1234, 77, 123456); err != nil {
		t.Fatal(err)
	}
	if hash, found, err := access.GetChannelAccessHash(ctx, 1234, 77); err != nil || !found || hash != 123456 {
		t.Fatalf("channel hash: hash=%d found=%v err=%v", hash, found, err)
	}
	if err := access.SetUserAccessHash(ctx, 1234, 55, 98765); err != nil {
		t.Fatal(err)
	}
	if hash, found, err := access.GetUserAccessHash(ctx, 1234, 55); err != nil || !found || hash != 98765 {
		t.Fatalf("user hash: hash=%d found=%v err=%v", hash, found, err)
	}
}

func TestEncryptedSessionCannotBeReadWithoutMasterKey(t *testing.T) {
	withTestMasterKey(t)
	db, err := store.Open(filepath.Join(t.TempDir(), "store.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ss := NewSessionStorage(db)
	if err := ss.StoreSession(context.Background(), []byte("session")); err != nil {
		t.Fatal(err)
	}
	os.Unsetenv("MASTER_KEY")
	if _, err := ss.LoadSession(context.Background()); err == nil {
		t.Fatal("session decrypted without MASTER_KEY")
	}
}
