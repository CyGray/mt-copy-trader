package app

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

func BenchmarkDurableIntentCommit(b *testing.B) {
	db, err := store.Open(filepath.Join(b.TempDir(), "state.sqlite"))
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := db.WithTx(ctx, func(tx *store.Tx) error {
			_, err := tx.Create("trade_sets", fmt.Sprintf("intent-%08d", i), store.Document{"schema": 2, "state": "SUBMITTING", "profile_snapshot": nil, "updated_at": store.ISO(time.Now()), "submission": map[string]any{"request_id": fmt.Sprint(i), "expires_at": time.Now().Add(8 * time.Second).Unix()}})
			return err
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}
