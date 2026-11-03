package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestDueQueueClaimSkipsLargeBackoffPrefixButHonorsSameKeyBlocker(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	oldAt, dueAt := ISO(now.Add(-time.Hour)), ISO(now)
	const seedBatch = 250
	for start := 0; start < maxListLimit+1; start += seedBatch {
		end := min(start+seedBatch, maxListLimit+1)
		if err := s.WithTx(ctx, func(tx *Tx) error {
			for i := start; i < end; i++ {
				chatID := fmt.Sprintf("-100%d", 10000+i)
				hash := fmt.Sprintf("hash-%d", i)
				doc := testSignalEvent(chatID, "1", hash, oldAt, "retry_wait")
				object(doc["autotrader"])["next_attempt_at"] = ISO(now.Add(time.Hour))
				if _, err := tx.Create(queueCollection, chatID+"_1_"+hash, doc); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	due := testSignalEvent("-10019999", "1", "due", dueAt, "pending")
	if err := s.WithTx(ctx, func(tx *Tx) error {
		_, err := tx.Create(queueCollection, "-10019999_1_due", due)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now, Limit: 1})
	if err != nil || len(claimed) != 1 || claimed[0].ID != "-10019999_1_due" {
		t.Fatalf("due event behind a large retry prefix starved: %#v err=%v", claimed, err)
	}

	old := testSignalEvent("-10020000", "9", "old", oldAt, "retry_wait")
	object(old["autotrader"])["next_attempt_at"] = ISO(now.Add(time.Hour))
	later := testSignalEvent("-10020000", "9", "later", dueAt, "pending")
	if err := s.WithTx(ctx, func(tx *Tx) error {
		if _, err := tx.Create(queueCollection, "-10020000_9_old", old); err != nil {
			return err
		}
		_, err := tx.Create(queueCollection, "-10020000_9_later", later)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range claimed {
		if event.ID == "-10020000_9_later" {
			t.Fatal("later due correction bypassed the earlier event's backoff")
		}
	}
	stored, err := s.Get(ctx, queueCollection, "-10020000_9_later")
	if err != nil || stringField(object(stored["autotrader"]), "status") != "pending" {
		t.Fatalf("later same-key event changed despite earlier backoff: %#v err=%v", stored, err)
	}
}

func TestPublishIsIdempotentAndQueueClaimsPreservePerMessageOrder(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	created := ISO(time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
	firstID, secondID := "-1001_77_first", "-1001_77_second"
	first := testSignalEvent("-1001", "77", "first", created, "pending")
	second := testSignalEvent("-1001", "77", "second", ISO(time.Date(2026, 10, 24, 12, 0, 1, 0, time.UTC)), "pending")
	inserted, err := s.PublishSignalEvent(ctx, firstID, first)
	if err != nil || !inserted {
		t.Fatalf("first publish: inserted=%v err=%v", inserted, err)
	}
	first["message"] = "duplicate must not replace snapshot"
	inserted, err = s.PublishSignalEvent(ctx, firstID, first)
	if err != nil || inserted {
		t.Fatalf("duplicate publish: inserted=%v err=%v", inserted, err)
	}
	if inserted, err = s.PublishSignalEvent(ctx, secondID, second); err != nil || !inserted {
		t.Fatalf("second publish: inserted=%v err=%v", inserted, err)
	}

	now := time.Date(2026, 10, 24, 12, 1, 0, 0, time.UTC)
	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker-a", Now: now, Lease: time.Minute, Limit: 10})
	if err != nil || len(claimed) != 1 || claimed[0].ID != firstID {
		t.Fatalf("same Telegram message was claimed out of order: %#v err=%v", claimed, err)
	}
	stored, err := s.Get(ctx, queueCollection, firstID)
	if err != nil || stringField(object(stored["autotrader"]), "status") != "processing" {
		t.Fatalf("claim did not persist before returning: %#v err=%v", stored, err)
	}
	if stringField(claimed[0].Document, "message") != "" {
		t.Fatalf("duplicate publish overwrote original snapshot: %#v", claimed[0].Document)
	}
	finished, err := s.FinishSignalEvent(ctx, firstID, QueueFinish{
		LeaseID: claimed[0].LeaseID,
		State:   Document{"status": "done", "attempts": claimed[0].Attempts, "updated_at": ISO(now)},
	})
	if err != nil || !finished {
		t.Fatalf("finish first event: finished=%v err=%v", finished, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker-a", Now: now.Add(time.Second), Lease: time.Minute, Limit: 10})
	if err != nil || len(claimed) != 1 || claimed[0].ID != secondID {
		t.Fatalf("later correction did not become claimable after terminal first event: %#v err=%v", claimed, err)
	}
}

func TestIngressSequenceKeepsSameMillisecondEditBehindOriginal(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	created := ISO(now)
	// The correction's ID sorts first lexically even though it arrived second.
	originalID, editID := "-1001_777_fff", "-1001_777_000"
	original := testSignalEvent("-1001", "777", "fff", created, "pending")
	edit := testSignalEvent("-1001", "777", "000", created, "pending")
	if inserted, err := s.PublishSignalEvent(ctx, originalID, original); err != nil || !inserted {
		t.Fatalf("publish original: inserted=%v err=%v", inserted, err)
	}
	if inserted, err := s.PublishSignalEvent(ctx, editID, edit); err != nil || !inserted {
		t.Fatalf("publish edit: inserted=%v err=%v", inserted, err)
	}
	originalSequence := testIngressSequence(t, s, originalID)
	editSequence := testIngressSequence(t, s, editID)
	if originalSequence >= editSequence {
		t.Fatalf("first ingress sequence = %d, correction = %d", originalSequence, editSequence)
	}

	duplicate := cloneDocument(edit)
	duplicate["message"] = "duplicate must not replace snapshot"
	if inserted, err := s.PublishSignalEvent(ctx, editID, duplicate); err != nil || inserted {
		t.Fatalf("duplicate publish: inserted=%v err=%v", inserted, err)
	}
	if got := testIngressSequence(t, s, editID); got != editSequence {
		t.Fatalf("duplicate publish changed ingress sequence: got %d want %d", got, editSequence)
	}
	edit["message"] = "ordinary upsert"
	if err := s.Put(ctx, queueCollection, editID, edit); err != nil {
		t.Fatal(err)
	}
	if got := testIngressSequence(t, s, editID); got != editSequence {
		t.Fatalf("upsert changed ingress sequence: got %d want %d", got, editSequence)
	}
	var allocated int64
	if err := s.db.QueryRowContext(ctx, `SELECT CAST(value AS INTEGER) FROM store_meta WHERE key='signal_ingress_sequence'`).Scan(&allocated); err != nil || allocated != 2 {
		t.Fatalf("duplicate/upsert consumed an ingress sequence: counter=%d err=%v", allocated, err)
	}

	// Public list order remains the stable timestamp/ID tuple for pagination.
	listed, err := s.List(ctx, queueCollection, ListOptions{TimeField: CreatedAt, Limit: 10})
	if err != nil || len(listed) != 2 || stringField(listed[0], "_id") != editID {
		t.Fatalf("public timestamp/ID order changed: %#v err=%v", listed, err)
	}

	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now, Limit: 10})
	if err != nil || len(claimed) != 1 || claimed[0].ID != originalID {
		t.Fatalf("correction overtook the original: %#v err=%v", claimed, err)
	}
	if ok, err := s.FinishSignalEvent(ctx, originalID, QueueFinish{
		LeaseID: claimed[0].LeaseID,
		State:   Document{"status": "retry_wait", "attempts": 1, "next_attempt_at": ISO(now.Add(time.Hour))},
	}); err != nil || !ok {
		t.Fatalf("schedule original retry: ok=%v err=%v", ok, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now.Add(time.Second), Limit: 10})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("same-message correction bypassed original retry: %#v err=%v", claimed, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now.Add(time.Hour), Limit: 10})
	if err != nil || len(claimed) != 1 || claimed[0].ID != originalID {
		t.Fatalf("original retry was not first when due: %#v err=%v", claimed, err)
	}
	if ok, err := s.FinishSignalEvent(ctx, originalID, QueueFinish{LeaseID: claimed[0].LeaseID, State: Document{"status": "done", "attempts": 2}}); err != nil || !ok {
		t.Fatalf("finish original: ok=%v err=%v", ok, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now.Add(time.Hour + time.Second), Limit: 10})
	if err != nil || len(claimed) != 1 || claimed[0].ID != editID {
		t.Fatalf("correction did not follow original completion: %#v err=%v", claimed, err)
	}
}

func testIngressSequence(t *testing.T, s *SQLiteStore, id string) int64 {
	t.Helper()
	var sequence int64
	if err := s.db.QueryRowContext(context.Background(), `SELECT ingress_sequence FROM documents WHERE collection=? AND id=?`, queueCollection, id).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	return sequence
}

func TestLeaseRenewalFencingAndExpiredLeaseRecovery(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	id := "-1001_88_hash"
	if _, err := s.PublishSignalEvent(ctx, id, testSignalEvent("-1001", "88", "hash", ISO(now), "pending")); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker-a", Now: now, Lease: time.Minute})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %#v err=%v", claimed, err)
	}
	lease := claimed[0].LeaseID
	renewed, err := s.RenewSignalEventLease(ctx, id, "stale-lease", now.Add(2*time.Minute), now.Add(10*time.Second))
	if err != nil || renewed {
		t.Fatalf("stale renewal accepted: renewed=%v err=%v", renewed, err)
	}
	renewed, err = s.RenewSignalEventLease(ctx, id, lease, now.Add(2*time.Minute), now.Add(10*time.Second))
	if err != nil || !renewed {
		t.Fatalf("valid lease renewal rejected: renewed=%v err=%v", renewed, err)
	}
	finished, err := s.FinishSignalEvent(ctx, id, QueueFinish{LeaseID: "stale-lease", State: Document{"status": "done"}})
	if err != nil || finished {
		t.Fatalf("stale finisher crossed lease fence: finished=%v err=%v", finished, err)
	}
	finished, err = s.FinishSignalEvent(ctx, id, QueueFinish{LeaseID: lease, State: Document{"status": "retry_wait", "attempts": 1, "next_attempt_at": ISO(now)}})
	if err != nil || !finished {
		t.Fatalf("current finisher rejected: finished=%v err=%v", finished, err)
	}

	// A worker that disappears after a committed claim can be reclaimed once its
	// persisted lease has expired; the old lease cannot finish after the reclaim.
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker-b", Now: now.Add(3 * time.Minute), Lease: time.Minute})
	if err != nil || len(claimed) != 1 || claimed[0].Attempts != 2 {
		t.Fatalf("retry claim: %#v err=%v", claimed, err)
	}
	state := object(claimed[0].Document["autotrader"])
	if state["status"] != "retry_wait" {
		t.Fatalf("claimed snapshot must be pre-claim state: %#v", state)
	}
	finished, err = s.FinishSignalEvent(ctx, id, QueueFinish{LeaseID: lease, State: Document{"status": "done"}})
	if err != nil || finished {
		t.Fatalf("old lease finished after reclaim: finished=%v err=%v", finished, err)
	}
}

func TestExpiredFinalLeaseDeadLettersAndBoundsHistory(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	id := "-1001_99_final"
	doc := testSignalEvent("-1001", "99", "final", ISO(now), "processing")
	state := object(doc["autotrader"])
	state["attempts"], state["lease_id"], state["lease_owner"] = 3, "expired", "worker-gone"
	state["lease_expires_at"] = ISO(now.Add(-time.Second))
	state["history"] = []any{Document{"at": ISO(now.Add(-3 * time.Second)), "result": "old-1"}, Document{"at": ISO(now.Add(-2 * time.Second)), "result": "old-2"}}
	if err := s.Put(ctx, queueCollection, id, doc); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "recovery", Now: now, MaxAttempts: 3, HistoryLimit: 2})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("exhausted lease was claimed: %#v err=%v", claimed, err)
	}
	stored, err := s.Get(ctx, queueCollection, id)
	if err != nil {
		t.Fatal(err)
	}
	final := object(stored["autotrader"])
	if final["status"] != "dead_letter" || final["reason"] != "max_attempts" || final["lease_id"] != nil {
		t.Fatalf("expired final attempt not terminally dead-lettered: %#v", final)
	}
	history := arrayValue(final["history"])
	if len(history) != 2 || object(history[0])["result"] != "lease_expired" || object(history[1])["result"] != "dead_letter" {
		t.Fatalf("history was not retained at configured bound: %#v", history)
	}
}

func TestRetryBudgetTerminatesAndRequeueBarrierIsReplaySafe(t *testing.T) {
	s, _ := openTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	oldID := "-1001_111_old"
	old := testSignalEvent("-1001", "111", "old", ISO(now), "pending")
	if _, err := s.PublishSignalEvent(ctx, oldID, old); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now, MaxAttempts: 2})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("first attempt claim: %#v err=%v", claimed, err)
	}
	if ok, err := s.FinishSignalEvent(ctx, oldID, QueueFinish{LeaseID: claimed[0].LeaseID, State: Document{"status": "retry_wait", "attempts": 1, "next_attempt_at": ISO(now)}}); err != nil || !ok {
		t.Fatalf("schedule bounded retry: ok=%v err=%v", ok, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now.Add(time.Second), MaxAttempts: 2})
	if err != nil || len(claimed) != 1 || claimed[0].Attempts != 2 {
		t.Fatalf("second attempt claim: %#v err=%v", claimed, err)
	}
	if ok, err := s.FinishSignalEvent(ctx, oldID, QueueFinish{LeaseID: claimed[0].LeaseID, State: Document{"status": "retry_wait", "attempts": 2, "next_attempt_at": ISO(now)}}); err != nil || !ok {
		t.Fatalf("persist exhausted retry: ok=%v err=%v", ok, err)
	}
	claimed, err = s.ClaimSignalEvents(ctx, ClaimOptions{Owner: "worker", Now: now.Add(2 * time.Second), MaxAttempts: 2})
	if err != nil || len(claimed) != 0 {
		t.Fatalf("exhausted event was claimed: %#v err=%v", claimed, err)
	}
	stored, err := s.Get(ctx, queueCollection, oldID)
	if err != nil || stringField(object(stored["autotrader"]), "status") != "dead_letter" {
		t.Fatalf("retry budget did not dead-letter: %#v err=%v", stored, err)
	}

	for _, status := range []struct{ name, want string }{{"done", "superseded"}, {"ignored", "superseded"}, {"processing", "later_event_in_progress"}, {"retry_wait", ""}} {
		t.Run("later_"+status.name, func(t *testing.T) {
			ss, _ := openTestStore(t)
			defer ss.Close()
			if err := ss.WithTx(ctx, func(tx *Tx) error {
				if _, err := tx.Create(queueCollection, oldID, setQueueState(old, Document{"status": "dead_letter", "attempts": 4, "updated_at": ISO(now)})); err != nil {
					return err
				}
				later := testSignalEvent("-1001", "111", "later", ISO(now.Add(time.Second)), status.name)
				created, err := tx.Create(queueCollection, "-1001_111_later", later)
				if err != nil {
					return err
				}
				if !created {
					return errors.New("later event was not inserted")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			result, err := ss.RequeueDeadLetter(ctx, oldID, "operator", now.Add(2*time.Second))
			wantRequeued := status.want == ""
			if err != nil || result.Requeued != wantRequeued || result.Reason != status.want {
				t.Fatalf("requeue barrier: result=%+v err=%v want=%q", result, err, status.want)
			}
		})
	}
}

func TestRequeueBarrierUsesSameMillisecondIngressOrder(t *testing.T) {
	for _, tc := range []struct{ status, want string }{{"processing", "later_event_in_progress"}, {"done", "superseded"}} {
		t.Run(tc.status, func(t *testing.T) {
			s, _ := openTestStore(t)
			ctx := context.Background()
			now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
			// The later edit sorts first lexically, so only persisted ingress order
			// can enforce this barrier.
			oldID, laterID := "-1001_222_fff", "-1001_222_000"
			old := testSignalEvent("-1001", "222", "fff", ISO(now), "dead_letter")
			later := testSignalEvent("-1001", "222", "000", ISO(now), tc.status)
			if err := s.WithTx(ctx, func(tx *Tx) error {
				if _, err := tx.Create(queueCollection, oldID, old); err != nil {
					return err
				}
				_, err := tx.Create(queueCollection, laterID, later)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			result, err := s.RequeueDeadLetter(ctx, oldID, "operator", now.Add(time.Second))
			if err != nil || result.Requeued || result.Reason != tc.want {
				t.Fatalf("same-ms ingress barrier: result=%+v err=%v want=%q", result, err, tc.want)
			}
		})
	}
}
