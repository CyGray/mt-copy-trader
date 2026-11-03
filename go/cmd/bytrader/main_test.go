package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCLIIsolatedBackupRestoreAndNoOverwrite(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db := filepath.Join(dir, "state.sqlite")
	if err := run(ctx, []string{"init", "--db", db}); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, []string{"init", "--db", db}); err == nil {
		t.Fatal("init overwrote existing controls")
	}
	if err := run(ctx, []string{"seal-cutover", "--db", db, "--confirm", "wrong"}); err == nil {
		t.Fatal("cutover accepted missing broker attestation")
	}
	if err := run(ctx, []string{"seal-cutover", "--db", db, "--confirm", "FLAT AND SETTLED"}); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(dir, "backup.sqlite")
	if err := run(ctx, []string{"backup", "--db", db, "--output", backup}); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, []string{"backup", "--db", db, "--output", backup}); err == nil {
		t.Fatal("backup overwrote a previous image")
	}
	restored := filepath.Join(dir, "restored.sqlite")
	if err := run(ctx, []string{"restore", "--input", backup, "--output", restored}); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, []string{"check", "--db", restored}); err != nil {
		t.Fatal(err)
	}
	export := filepath.Join(dir, "controls.json")
	if err := run(ctx, []string{"export-controls", "--db", restored, "--output", export}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(export)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("controls permissions %o", info.Mode().Perm())
	}
	if err := run(ctx, []string{"export-controls", "--db", restored, "--output", export}); err == nil {
		t.Fatal("export overwrote existing file")
	}
}

func TestInvalidCommandDoesNotCreateDatabase(t *testing.T) {
	db := filepath.Join(t.TempDir(), "absent.sqlite")
	if err := run(context.Background(), []string{"unknown", "--db", db}); err == nil {
		t.Fatal("unknown command accepted")
	}
	if _, err := os.Stat(db); !os.IsNotExist(err) {
		t.Fatal("invalid command created a database")
	}
}
