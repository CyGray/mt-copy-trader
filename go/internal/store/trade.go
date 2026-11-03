package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const tradeCollection = "trade_sets"

func (s *SQLiteStore) CreateTradeSet(ctx context.Context, id string, doc Document) (bool, error) {
	var created bool
	err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		created, err = tx.CreateTradeSet(id, doc)
		return err
	})
	return created, err
}

func (tx *Tx) CreateTradeSet(id string, doc Document) (bool, error) {
	if intValue(doc["schema"]) != 2 || stringField(doc, "trade_set_id") != id {
		return false, fmt.Errorf("%w: trade set must have schema 2 and matching ID", ErrInvalidDocument)
	}
	return tx.Create(tradeCollection, id, doc)
}

func (s *SQLiteStore) TransitionTradeSet(ctx context.Context, id string, from []string, patch Document) (bool, error) {
	var changed bool
	err := s.WithTx(ctx, func(tx *Tx) error {
		var err error
		changed, err = tx.TransitionTradeSet(id, from, patch)
		return err
	})
	return changed, err
}

func (tx *Tx) TransitionTradeSet(id string, from []string, patch Document) (bool, error) {
	if patch == nil {
		return false, fmt.Errorf("%w: trade set patch is nil", ErrInvalidDocument)
	}
	doc, err := tx.Get(tradeCollection, id)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if intValue(doc["schema"]) != 2 {
		return false, nil
	}
	current := stringField(doc, "state")
	allowed := false
	for _, state := range from {
		if current == state {
			allowed = true
			break
		}
	}
	if !allowed {
		return false, nil
	}
	merged := mergeDocument(doc, patch)
	merged["updated_at"] = ISO(time.Now())
	if _, hasID := merged["_id"]; hasID {
		return false, fmt.Errorf("%w: _id is reserved list metadata", ErrInvalidDocument)
	}
	if err := tx.Put(tradeCollection, id, merged); err != nil {
		return false, err
	}
	return true, nil
}

func (s *SQLiteStore) ListTradeSetsByState(ctx context.Context, states []string, limit int) ([]Document, error) {
	if len(states) == 0 {
		return []Document{}, nil
	}
	schema := 2
	return s.List(ctx, tradeCollection, ListOptions{
		Filters: []Filter{{Field: StateField, Values: states}},
		Schema:  &schema,
		Limit:   limit,
	})
}

func mergeDocument(destination, patch Document) Document {
	merged := cloneDocument(destination)
	for key, value := range patch {
		patchMap, isMap := value.(map[string]any)
		if isMap {
			merged[key] = mergeDocument(object(merged[key]), Document(patchMap))
		} else {
			merged[key] = value
		}
	}
	return merged
}
