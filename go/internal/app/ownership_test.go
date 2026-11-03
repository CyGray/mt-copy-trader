package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoleOwnershipAndIndependentRestart(t *testing.T) {
	db := filepath.Join(t.TempDir(), "state.sqlite")
	if err := os.WriteFile(db, nil, 0600); err != nil {
		t.Fatal(err)
	}
	executor, err := LockRole(db, "executor")
	if err != nil {
		t.Fatal(err)
	}
	defer executor.Close()
	if second, err := LockRole(db, "executor"); err == nil {
		second.Close()
		t.Fatal("second executor acquired ownership")
	}
	forwarder, err := LockRole(db, "forwarder")
	if err != nil {
		t.Fatal(err)
	}
	forwarder.Close()
	forwarder, err = LockRole(db, "forwarder")
	if err != nil {
		t.Fatal(err)
	}
	forwarder.Close()
	executor.Close()
	executor, err = LockRole(db, "executor")
	if err != nil {
		t.Fatal(err)
	}
	executor.Close()
}

func TestRoleOwnershipRejectsHardLinkedDatabase(t *testing.T) {
	dir := t.TempDir()
	path, alias := filepath.Join(dir, "state.sqlite"), filepath.Join(dir, "alias.sqlite")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{path, alias} {
		if owner, err := LockRole(candidate, "executor"); err == nil {
			owner.Close()
			t.Fatal("hard-link alias bypassed role ownership")
		}
	}
}
