package app

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// LockRole holds ownership until Close or process exit, including SIGKILL.
func LockRole(database, role string) (*os.File, error) {
	if role != "executor" && role != "forwarder" {
		return nil, fmt.Errorf("invalid exclusive role %q", role)
	}
	absolute, err := filepath.Abs(database)
	if err != nil {
		return nil, err
	}
	path, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || stat.Nlink != 1 {
		return nil, fmt.Errorf("exclusive role requires a regular SQLite file without hard links")
	}
	f, err := os.OpenFile(path+"."+role+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("%s already owned: %w", role, err)
	}
	return f, nil
}
