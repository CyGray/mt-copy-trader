package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/bytrader/bytrader/internal/store"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram/updates"
)

const (
	sessionCollection     = "telegram_session"
	sessionDocumentID     = "current"
	updateStateCollection = "telegram_update_state"
)

var _ session.Storage = (*SessionStorage)(nil)
var _ updates.StateStorage = (*UpdateStorage)(nil)
var _ updates.ChannelAccessHasher = (*AccessHashStorage)(nil)
var _ updates.UserAccessHasher = (*AccessHashStorage)(nil)

// SessionStorage encrypts gotd's complete MTProto session before writing it.
// There is no plaintext session file or session converter in the Go runtime.
type SessionStorage struct{ db store.Store }

func NewSessionStorage(db store.Store) *SessionStorage { return &SessionStorage{db: db} }

func (s *SessionStorage) LoadSession(ctx context.Context) ([]byte, error) {
	doc, err := s.db.Get(ctx, sessionCollection, sessionDocumentID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, session.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load encrypted Telegram session: %w", err)
	}
	envelope, _ := doc["payload_enc"].(string)
	if envelope == "" {
		return nil, errors.New("encrypted Telegram session is empty")
	}
	data, err := DecryptCommandPayload(envelope)
	if err != nil {
		return nil, fmt.Errorf("decrypt Telegram session: %w", err)
	}
	return data, nil
}

func (s *SessionStorage) StoreSession(ctx context.Context, data []byte) error {
	envelope, err := EncryptCommandPayload(data)
	if err != nil {
		return err
	}
	doc := store.Document{"payload_enc": envelope, "updated_at": store.ISO(time.Now())}
	if err := s.db.Put(ctx, sessionCollection, sessionDocumentID, doc); err != nil {
		return fmt.Errorf("persist encrypted Telegram session: %w", err)
	}
	return nil
}

func (s *SessionStorage) Clear(ctx context.Context) error {
	return s.db.WithTx(ctx, func(tx *store.Tx) error { return tx.Delete(sessionCollection, sessionDocumentID) })
}

func (s *SessionStorage) Exists(ctx context.Context) (bool, error) {
	_, err := s.db.Get(ctx, sessionCollection, sessionDocumentID)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

// UpdateStorage persists gotd's common/channel difference cursors. These
// cursors are what let gotd request and dispatch missed updates after reconnect.
type UpdateStorage struct{ db store.Store }

func NewUpdateStorage(db store.Store) *UpdateStorage { return &UpdateStorage{db: db} }

func (s *UpdateStorage) GetState(ctx context.Context, userID int64) (updates.State, bool, error) {
	doc, err := s.db.Get(ctx, updateStateCollection, strconv.FormatInt(userID, 10))
	if errors.Is(err, store.ErrNotFound) {
		return updates.State{}, false, nil
	}
	if err != nil {
		return updates.State{}, false, err
	}
	return updates.State{
		Pts:  intValue(doc["pts"]),
		Qts:  intValue(doc["qts"]),
		Date: intValue(doc["date"]),
		Seq:  intValue(doc["seq"]),
	}, true, nil
}

func (s *UpdateStorage) SetState(ctx context.Context, userID int64, state updates.State) error {
	return s.db.Put(ctx, updateStateCollection, strconv.FormatInt(userID, 10), store.Document{
		"user_id": strconv.FormatInt(userID, 10), "pts": state.Pts, "qts": state.Qts,
		"date": state.Date, "seq": state.Seq, "updated_at": store.ISO(time.Now()),
	})
}

func (s *UpdateStorage) updateState(ctx context.Context, userID int64, update func(*updates.State)) error {
	return s.db.WithTx(ctx, func(tx *store.Tx) error {
		id := strconv.FormatInt(userID, 10)
		doc, err := tx.Get(updateStateCollection, id)
		if err != nil {
			return fmt.Errorf("update Telegram difference state: %w", err)
		}
		state := updates.State{Pts: intValue(doc["pts"]), Qts: intValue(doc["qts"]), Date: intValue(doc["date"]), Seq: intValue(doc["seq"])}
		update(&state)
		doc["pts"], doc["qts"], doc["date"], doc["seq"] = state.Pts, state.Qts, state.Date, state.Seq
		doc["updated_at"] = store.ISO(time.Now())
		return tx.Put(updateStateCollection, id, doc)
	})
}

func (s *UpdateStorage) SetPts(ctx context.Context, userID int64, value int) error {
	return s.updateState(ctx, userID, func(state *updates.State) { state.Pts = value })
}
func (s *UpdateStorage) SetQts(ctx context.Context, userID int64, value int) error {
	return s.updateState(ctx, userID, func(state *updates.State) { state.Qts = value })
}
func (s *UpdateStorage) SetDate(ctx context.Context, userID int64, value int) error {
	return s.updateState(ctx, userID, func(state *updates.State) { state.Date = value })
}
func (s *UpdateStorage) SetSeq(ctx context.Context, userID int64, value int) error {
	return s.updateState(ctx, userID, func(state *updates.State) { state.Seq = value })
}
func (s *UpdateStorage) SetDateSeq(ctx context.Context, userID int64, date, seq int) error {
	return s.updateState(ctx, userID, func(state *updates.State) { state.Date, state.Seq = date, seq })
}

func (s *UpdateStorage) GetChannelPts(ctx context.Context, userID, channelID int64) (int, bool, error) {
	doc, err := s.db.Get(ctx, "telegram_channel_pts", peerStateID(userID, channelID))
	if errors.Is(err, store.ErrNotFound) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return intValue(doc["pts"]), true, nil
}

func (s *UpdateStorage) SetChannelPts(ctx context.Context, userID, channelID int64, pts int) error {
	id := peerStateID(userID, channelID)
	return s.db.Put(ctx, "telegram_channel_pts", id, store.Document{
		"user_id": strconv.FormatInt(userID, 10), "channel_id": strconv.FormatInt(channelID, 10),
		"pts": pts, "updated_at": store.ISO(time.Now()),
	})
}

func (s *UpdateStorage) ForEachChannels(ctx context.Context, userID int64, fn func(context.Context, int64, int) error) error {
	if fn == nil {
		return errors.New("channel state callback is nil")
	}
	userIDText := strconv.FormatInt(userID, 10)
	var cursor *store.Cursor
	for {
		rows, err := s.db.List(ctx, "telegram_channel_pts", store.ListOptions{
			Filters: []store.Filter{{Field: store.UserIDField, Values: []string{userIDText}}},
			After:   cursor, Limit: 5000,
		})
		if err != nil {
			return err
		}
		for _, row := range rows {
			channelID, err := strconv.ParseInt(stringValue(row["channel_id"]), 10, 64)
			if err != nil {
				continue
			}
			if err := fn(ctx, channelID, intValue(row["pts"])); err != nil {
				return err
			}
		}
		if len(rows) < 5000 {
			return nil
		}
		last := rows[len(rows)-1]
		cursor = &store.Cursor{Time: stringValue(last["created_at"]), ID: stringValue(last["_id"]), TimeField: store.CreatedAt}
	}
}

// AccessHashStorage persists the hashes required to replay channel/user update
// gaps. These are authorization metadata, not session credentials, but remain
// private in the same restricted SQLite database.
type AccessHashStorage struct{ db store.Store }

func NewAccessHashStorage(db store.Store) *AccessHashStorage { return &AccessHashStorage{db: db} }

func (s *AccessHashStorage) SetChannelAccessHash(ctx context.Context, userID, channelID, accessHash int64) error {
	return s.setAccessHash(ctx, "telegram_channel_hashes", userID, channelID, accessHash)
}
func (s *AccessHashStorage) GetChannelAccessHash(ctx context.Context, userID, channelID int64) (int64, bool, error) {
	return s.getAccessHash(ctx, "telegram_channel_hashes", userID, channelID)
}
func (s *AccessHashStorage) SetUserAccessHash(ctx context.Context, userID, targetUserID, accessHash int64) error {
	return s.setAccessHash(ctx, "telegram_user_hashes", userID, targetUserID, accessHash)
}
func (s *AccessHashStorage) GetUserAccessHash(ctx context.Context, userID, targetUserID int64) (int64, bool, error) {
	return s.getAccessHash(ctx, "telegram_user_hashes", userID, targetUserID)
}

func (s *AccessHashStorage) setAccessHash(ctx context.Context, collection string, userID, peerID, hash int64) error {
	return s.db.Put(ctx, collection, peerStateID(userID, peerID), store.Document{
		"user_id": strconv.FormatInt(userID, 10), "peer_id": strconv.FormatInt(peerID, 10),
		"access_hash": strconv.FormatInt(hash, 10), "updated_at": store.ISO(time.Now()),
	})
}

func (s *AccessHashStorage) getAccessHash(ctx context.Context, collection string, userID, peerID int64) (int64, bool, error) {
	doc, err := s.db.Get(ctx, collection, peerStateID(userID, peerID))
	if errors.Is(err, store.ErrNotFound) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	hash, err := strconv.ParseInt(stringValue(doc["access_hash"]), 10, 64)
	return hash, err == nil, err
}

func peerStateID(userID, peerID int64) string {
	return strconv.FormatInt(userID, 10) + "_" + strconv.FormatInt(peerID, 10)
}

func intValue(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case int, int64, float64:
		return fmt.Sprint(v)
	}
	return ""
}
