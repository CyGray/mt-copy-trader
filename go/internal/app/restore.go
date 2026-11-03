package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/bytrader/bytrader/internal/store"
)

// Restore publishes a new, consistent database only after entries are disabled.
func Restore(ctx context.Context, input, output string) error {
	if input == "" || output == "" {
		return errors.New("restore requires input and new output paths")
	}
	if _, err := os.Lstat(output); !os.IsNotExist(err) {
		return errors.New("restore output already exists or is inaccessible")
	}
	if err := os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(output), ".bytrader-restore-*.sqlite")
	if err != nil {
		return err
	}
	path := temp.Name()
	_ = temp.Close()
	_ = os.Remove(path)
	defer func() { _ = os.Remove(path); _ = os.Remove(path + "-wal"); _ = os.Remove(path + "-shm") }()
	if _, err := os.Stat(input); err != nil {
		return err
	}
	source, err := store.Open(input)
	if err != nil {
		return err
	}
	defer source.Close()
	if err := source.Health(ctx); err != nil {
		return err
	}
	if err := source.Backup(ctx, path); err != nil {
		return err
	}
	restored, err := store.Open(path)
	if err != nil {
		return err
	}
	defer restored.Close()
	if err := restored.WithTx(ctx, func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		execution := object(settings["execution"])
		execution["mode"] = "disabled"
		settings["execution"] = execution
		trading := object(settings["trading"])
		trading["kill_switch"] = true
		settings["trading"] = trading
		if err := tx.Put("settings", "default", settings); err != nil {
			return err
		}
		at := store.ISO(time.Now())
		_, err = tx.Create("admin_audit", "restore-"+at, store.Document{"action": "database_restored_disabled", "actor_uid": "local-operator", "at": at})
		return err
	}); err != nil {
		return err
	}
	if err := restored.Health(ctx); err != nil {
		return err
	}
	return restored.Backup(ctx, output)
}
