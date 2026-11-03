package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unicode/utf16"
)

const (
	queueCollection          = "signal_events"
	defaultQueueMaxAttempts  = 8
	defaultQueueHistoryLimit = 10
	defaultQueueLease        = 120 * time.Second
)

var queueStatuses = map[string]bool{
	"pending": true, "processing": true, "retry_wait": true, "done": true,
	"ignored": true, "dead_letter": true, "discarded": true,
}

type ClaimOptions struct {
	Owner        string
	Now          time.Time
	Lease        time.Duration
	Limit        int
	MaxAttempts  int
	HistoryLimit int
}

type ClaimedEvent struct {
	ID       string
	Document Document
	LeaseID  string
	Attempts int
}

type QueueFinish struct {
	LeaseID string
	State   Document
}

type RequeueResult struct {
	Requeued bool
	Reason   string
}

func (s *SQLiteStore) PublishSignalEvent(ctx context.Context, id string, doc Document) (bool, error) {
	chatID, messageID, textHash := stringField(doc, "chat_id"), stringField(doc, "message_id"), stringField(doc, "text_hash")
	if chatID == "" || messageID == "" || textHash == "" || id != chatID+"_"+messageID+"_"+textHash {
		return false, fmt.Errorf("%w: signal event ID does not match chat/message/text hash", ErrInvalidDocument)
	}
	state := queueState(doc)
	if state == nil || stringField(state, "status") != "pending" {
		return false, fmt.Errorf("%w: new signal event needs pending queue state", ErrInvalidDocument)
	}
	created := false
	err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		created, err = tx.Create(queueCollection, id, doc)
		return err
	})
	return created, err
}

func (s *SQLiteStore) ClaimSignalEvents(ctx context.Context, opts ClaimOptions) ([]ClaimedEvent, error) {
	if opts.Owner == "" {
		return nil, errors.New("queue claim owner is empty")
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	if opts.Lease <= 0 {
		opts.Lease = defaultQueueLease
	}
	if opts.Limit <= 0 {
		opts.Limit = 20
	}
	if opts.Limit > 100 {
		opts.Limit = 100
	}
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = defaultQueueMaxAttempts
	}
	if opts.HistoryLimit <= 0 {
		opts.HistoryLimit = defaultQueueHistoryLimit
	}
	claimed := make([]ClaimedEvent, 0, opts.Limit)
	err := s.WithTx(ctx, func(tx *Tx) error {
		now := opts.Now.UTC()
		deadLettered := 0
		for len(claimed) < opts.Limit && deadLettered < 100 {
			batchSize := min(100, opts.Limit-len(claimed)+100-deadLettered)
			rows, err := tx.claimableQueueEvents(now, batchSize)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				break
			}
			for _, listed := range rows {
				if len(claimed) >= opts.Limit || deadLettered >= 100 {
					break
				}
				id := stringField(listed, "_id")
				doc := withoutID(listed)
				state := queueState(doc)
				if id == "" || state == nil {
					continue
				}
				status := stringField(state, "status")
				expiredLease := status == "processing"
				attempts := intValue(state["attempts"])
				history := append([]any(nil), arrayValue(state["history"])...)
				at := ISO(now)
				if expiredLease {
					history = appendHistoryRecord(history, Document{
						"attempt": attempts, "at": at, "result": "lease_expired",
						"detail": truncate(fmt.Sprintf("lease of %s expired", fallback(stringField(state, "lease_owner"), "unknown")), 500),
					})
				}
				if attempts >= opts.MaxAttempts {
					dead := cloneDocument(state)
					dead["status"] = "dead_letter"
					dead["lease_id"], dead["lease_owner"], dead["lease_expires_at"] = nil, nil, nil
					dead["reason"] = "max_attempts"
					dead["last_error"] = fallback(stringField(state, "last_error"), "lease expired on the final attempt")
					dead["dead_lettered_at"], dead["updated_at"] = at, at
					history = appendHistoryRecord(history, Document{"attempt": attempts, "at": at, "result": "dead_letter", "detail": "max_attempts"})
					dead["history"] = trimHistory(history, opts.HistoryLimit)
					if err := tx.Put(queueCollection, id, setQueueState(doc, dead)); err != nil {
						return err
					}
					deadLettered++
					continue
				}
				leaseID, err := randomLeaseID()
				if err != nil {
					return err
				}
				next := cloneDocument(state)
				next["status"] = "processing"
				next["attempts"] = attempts + 1
				next["lease_id"], next["lease_owner"] = leaseID, opts.Owner
				next["lease_expires_at"] = ISO(now.Add(opts.Lease))
				next["updated_at"] = at
				if len(history) > 0 {
					next["history"] = trimHistory(history, opts.HistoryLimit)
				}
				if err := tx.Put(queueCollection, id, setQueueState(doc, next)); err != nil {
					return err
				}
				claimed = append(claimed, ClaimedEvent{ID: id, Document: doc, LeaseID: leaseID, Attempts: attempts + 1})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}

func (tx *Tx) claimableQueueEvents(now time.Time, limit int) ([]Document, error) {
	const query = `
SELECT e.id, e.body
FROM documents AS e
WHERE e.collection = ?
  AND ((e.queue_status IN ('pending', 'retry_wait')
        AND (e.queue_next_attempt_at IS NULL OR e.queue_next_attempt_at <= ?))
    OR (e.queue_status = 'processing'
        AND (e.queue_lease_expires_at IS NULL OR e.queue_lease_expires_at <= ?)))
  AND (e.chat_id IS NULL OR e.message_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM documents AS p
        WHERE p.collection = e.collection
          AND p.chat_id = e.chat_id AND p.message_id = e.message_id
          AND p.queue_status IN ('pending', 'processing', 'retry_wait')
          AND p.ingress_sequence < e.ingress_sequence))
ORDER BY COALESCE(e.created_at, ''), e.id
LIMIT ?`
	rows, err := tx.tx.QueryContext(tx.ctx, query, queueCollection, ISO(now), ISO(now), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Document, 0, limit)
	for rows.Next() {
		var id, body string
		if err := rows.Scan(&id, &body); err != nil {
			return nil, err
		}
		doc, err := decodeDocument(body)
		if err != nil {
			return nil, err
		}
		doc["_id"] = id
		result = append(result, doc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *SQLiteStore) RenewSignalEventLease(ctx context.Context, id, leaseID string, expiresAt, now time.Time) (bool, error) {
	var renewed bool
	err := s.WithTx(ctx, func(tx *Tx) error {
		doc, err := tx.Get(queueCollection, id)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		state := queueState(doc)
		if state == nil || stringField(state, "status") != "processing" || stringField(state, "lease_id") != leaseID {
			return nil
		}
		next := cloneDocument(state)
		next["lease_expires_at"], next["updated_at"] = ISO(expiresAt), ISO(now)
		if err := tx.Put(queueCollection, id, setQueueState(doc, next)); err != nil {
			return err
		}
		renewed = true
		return nil
	})
	return renewed, err
}

func (s *SQLiteStore) FinishSignalEvent(ctx context.Context, id string, finish QueueFinish) (bool, error) {
	var finished bool
	err := s.WithTx(ctx, func(tx *Tx) error {
		var finishErr error
		finished, finishErr = tx.FinishSignalEvent(id, finish)
		return finishErr
	})
	return finished, err
}

func (tx *Tx) FinishSignalEvent(id string, finish QueueFinish) (bool, error) {
	if finish.LeaseID == "" || finish.State == nil || !queueStatuses[stringField(finish.State, "status")] {
		return false, fmt.Errorf("%w: invalid signal queue finish", ErrInvalidDocument)
	}
	doc, err := tx.Get(queueCollection, id)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	state := queueState(doc)
	if state == nil || stringField(state, "status") != "processing" || stringField(state, "lease_id") != finish.LeaseID {
		return false, nil
	}
	return true, tx.Put(queueCollection, id, setQueueState(doc, finish.State))
}

func (s *SQLiteStore) RequeueDeadLetter(ctx context.Context, id, actor string, now time.Time) (RequeueResult, error) {
	var result RequeueResult
	err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		result, err = tx.RequeueDeadLetter(id, actor, now)
		return err
	})
	return result, err
}

func (tx *Tx) RequeueDeadLetter(id, actor string, now time.Time) (RequeueResult, error) {
	doc, err := tx.Get(queueCollection, id)
	if errors.Is(err, ErrNotFound) {
		return RequeueResult{Reason: "not_dead_letter"}, nil
	}
	if err != nil {
		return RequeueResult{}, err
	}
	state := queueState(doc)
	if state == nil || stringField(state, "status") != "dead_letter" {
		return RequeueResult{Reason: "not_dead_letter"}, nil
	}
	chatID, messageID := stringField(doc, "chat_id"), stringField(doc, "message_id")
	var ingressSequence int64
	if err := tx.tx.QueryRowContext(tx.ctx, `SELECT ingress_sequence FROM documents WHERE collection=? AND id=?`, queueCollection, id).Scan(&ingressSequence); err != nil {
		return RequeueResult{}, fmt.Errorf("read signal event ingress sequence: %w", err)
	}
	superseded, err := tx.hasLaterQueueStatus(chatID, messageID, ingressSequence, "done", "ignored")
	if err != nil {
		return RequeueResult{}, err
	}
	if superseded {
		return RequeueResult{Reason: "superseded"}, nil
	}
	inProgress, err := tx.hasLaterQueueStatus(chatID, messageID, ingressSequence, "processing")
	if err != nil {
		return RequeueResult{}, err
	}
	if inProgress {
		return RequeueResult{Reason: "later_event_in_progress"}, nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	next := cloneDocument(state)
	next["status"], next["attempts"], next["next_attempt_at"] = "pending", 0, ISO(now)
	next["lease_id"], next["lease_owner"], next["lease_expires_at"] = nil, nil, nil
	next["updated_at"] = ISO(now)
	next["requeue_count"] = intValue(state["requeue_count"]) + 1
	next["requeued_by"], next["requeued_at"] = actor, ISO(now)
	if err := tx.Put(queueCollection, id, setQueueState(doc, next)); err != nil {
		return RequeueResult{}, err
	}
	return RequeueResult{Requeued: true}, nil
}

func (tx *Tx) hasLaterQueueStatus(chatID, messageID string, ingressSequence int64, statuses ...string) (bool, error) {
	if chatID == "" || messageID == "" || ingressSequence <= 0 || len(statuses) == 0 {
		return false, nil
	}
	const query = `SELECT EXISTS (
  SELECT 1 FROM documents
  WHERE collection=? AND chat_id=? AND message_id=? AND ingress_sequence>? AND queue_status IN (%s)
)`
	statusArgs := make([]any, len(statuses))
	for i, status := range statuses {
		if !queueStatuses[status] {
			return false, fmt.Errorf("invalid queue status %q", status)
		}
		statusArgs[i] = status
	}
	sqlQuery := fmt.Sprintf(query, placeholders(len(statuses)))
	args := []any{queueCollection, chatID, messageID, ingressSequence}
	args = append(args, statusArgs...)
	var found int
	if err := tx.tx.QueryRowContext(tx.ctx, sqlQuery, args...).Scan(&found); err != nil {
		return false, err
	}
	return found == 1, nil
}

func (s *SQLiteStore) DiscardDeadLetter(ctx context.Context, id, actor, note string, now time.Time) (bool, error) {
	var discarded bool
	err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		discarded, err = tx.DiscardDeadLetter(id, actor, note, now)
		return err
	})
	return discarded, err
}

func (tx *Tx) DiscardDeadLetter(id, actor, note string, now time.Time) (bool, error) {
	doc, err := tx.Get(queueCollection, id)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	state := queueState(doc)
	if state == nil || stringField(state, "status") != "dead_letter" {
		return false, nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	next := cloneDocument(state)
	next["status"] = "discarded"
	next["lease_id"], next["lease_owner"], next["lease_expires_at"] = nil, nil, nil
	next["updated_at"], next["discarded_by"], next["discarded_at"] = ISO(now), actor, ISO(now)
	if note = truncate(note, 200); note != "" {
		next["discard_note"] = note
	}
	return true, tx.Put(queueCollection, id, setQueueState(doc, next))
}

func queueState(doc Document) Document {
	state := object(doc["autotrader"])
	if state == nil || !queueStatuses[stringField(state, "status")] {
		return nil
	}
	return state
}

func setQueueState(doc, state Document) Document {
	updated := cloneDocument(doc)
	updated["autotrader"] = state
	return updated
}

func timeAfter(value any, now time.Time) bool {
	str := stringField(Document{"time": value}, "time")
	parsed, err := time.Parse(time.RFC3339Nano, str)
	return err == nil && parsed.After(now)
}

func appendHistoryRecord(history []any, record Document) []any {
	return append(history, record)
}

func trimHistory(history []any, limit int) []any {
	if len(history) <= limit {
		return history
	}
	return append([]any(nil), history[len(history)-limit:]...)
}

func arrayValue(value any) []any {
	values, _ := value.([]any)
	return values
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

func stringField(doc Document, field string) string {
	value, _ := doc[field].(string)
	return value
}

func cloneDocument(doc Document) Document {
	if doc == nil {
		return Document{}
	}
	copyDoc := make(Document, len(doc))
	for key, value := range doc {
		copyDoc[key] = value
	}
	return copyDoc
}

func withoutID(doc Document) Document {
	copyDoc := cloneDocument(doc)
	delete(copyDoc, "_id")
	return copyDoc
}

func fallback(value, valueIfEmpty string) string {
	if value != "" {
		return value
	}
	return valueIfEmpty
}

func truncate(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	if limit <= 1 {
		return "…"
	}
	return string(utf16.Decode(units[:limit-1])) + "…"
}

func randomLeaseID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate queue lease ID: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
