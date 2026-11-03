package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/bytrader/bytrader/internal/app"
	"github.com/bytrader/bytrader/internal/store"
)

var version = "dev"
var revision = "unknown"

type options struct {
	database, listen, input, output, confirmation string
	insecureCookies, offlineSimulator             bool
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("bytrader_stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: bytrader <forwarder|executor|web|init|check|backup|restore|import-controls|export-controls|seal-cutover|version> [flags]")
	}
	if args[0] == "version" {
		return printJSON(map[string]any{"version": version, "revision": revision, "go": runtime.Version(), "protocol": 2})
	}
	opts := options{}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	defaultDB := os.Getenv("BYTRADER_DB")
	if defaultDB == "" {
		defaultDB = "/var/lib/bytrader/state.sqlite"
	}
	flags.StringVar(&opts.database, "db", defaultDB, "local SQLite database")
	flags.StringVar(&opts.listen, "listen", "127.0.0.1:8080", "web listen address")
	flags.StringVar(&opts.input, "input", "", "input file")
	flags.StringVar(&opts.output, "output", "", "new output file (must not exist)")
	flags.StringVar(&opts.confirmation, "confirm", "", "operator cutover attestation")
	flags.BoolVar(&opts.insecureCookies, "insecure-cookies", false, "local HTTP development only")
	flags.BoolVar(&opts.offlineSimulator, "offline-simulator", false, "synthetic gold PAPER broker; no MT5 connection")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if args[0] == "restore" {
		return app.Restore(ctx, opts.input, opts.output)
	}
	known := map[string]bool{"init": true, "check": true, "backup": true, "import-controls": true, "export-controls": true, "seal-cutover": true, "forwarder": true, "executor": true, "web": true}
	if !known[args[0]] {
		return fmt.Errorf("unknown command %q", args[0])
	}
	if args[0] != "init" {
		if _, err := os.Stat(opts.database); err != nil {
			return fmt.Errorf("database missing; run init with the same --db path: %w", err)
		}
	}
	db, err := store.Open(opts.database)
	if err != nil {
		return err
	}
	defer db.Close()
	if args[0] == "executor" || args[0] == "forwarder" {
		owner, err := app.LockRole(opts.database, args[0])
		if err != nil {
			return err
		}
		defer owner.Close()
	}
	switch args[0] {
	case "init":
		return app.Initialize(ctx, db, time.Now())
	case "check":
		if err := db.Health(ctx); err != nil {
			return err
		}
		info, err := db.RuntimeInfo(ctx)
		if err != nil {
			return err
		}
		settled := app.CheckSettled(ctx, db)
		return printJSON(map[string]any{"storage": info, "local_settled": settled == nil, "broker_flat_verified": false, "settlement_issue": errorString(settled)})
	case "backup":
		if opts.output == "" {
			return errors.New("backup requires --output to a new file")
		}
		return db.Backup(ctx, opts.output)
	case "import-controls", "seal-cutover":
		forwarder, err := app.LockRole(opts.database, "forwarder")
		if err != nil {
			return err
		}
		defer forwarder.Close()
		executor, err := app.LockRole(opts.database, "executor")
		if err != nil {
			return err
		}
		defer executor.Close()
		if args[0] == "seal-cutover" {
			if opts.confirmation != "FLAT AND SETTLED" {
				return errors.New("requires --confirm 'FLAT AND SETTLED' after separate broker/late-request verification")
			}
			return app.SealCutover(ctx, db, time.Now())
		}
		var bundle app.ControlsBundle
		if err := readJSON(opts.input, &bundle); err != nil {
			return err
		}
		return app.ImportControls(ctx, db, bundle, time.Now())
	case "export-controls":
		return exportControls(ctx, db, opts.output)
	case "web":
		return runWeb(ctx, db, opts)
	case "executor":
		return runExecutor(ctx, db, opts)
	case "forwarder":
		return runForwarder(ctx, db)
	}
	return nil
}

func readJSON(path string, into any) error {
	if path == "" {
		return errors.New("--input is required")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 4<<20 {
		return errors.New("input exceeds 4 MiB")
	}
	decoder := json.NewDecoder(io.LimitReader(f, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("invalid input JSON: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("input must contain one JSON value within 4 MiB")
	}
	return nil
}

func exportControls(ctx context.Context, db store.Store, output string) error {
	if output == "" {
		return errors.New("export-controls requires --output")
	}
	bundle := app.ControlsBundle{Schema: 1, Profiles: map[string]store.Document{}, Users: map[string]store.Document{}}
	if err := db.WithTx(ctx, func(tx *store.Tx) error {
		settings, err := tx.Get("settings", "default")
		if err != nil {
			return err
		}
		bundle.Settings = settings
		for collection, destination := range map[string]map[string]store.Document{"execution_profiles": bundle.Profiles, "users": bundle.Users} {
			var cursor *store.Cursor
			for {
				rows, err := tx.List(collection, store.ListOptions{After: cursor, Limit: 200})
				if err != nil {
					return err
				}
				for _, doc := range rows {
					id, ok := doc["_id"].(string)
					if !ok {
						return errors.New("export record missing identifier")
					}
					at, _ := doc["created_at"].(string)
					cursor = &store.Cursor{Time: at, ID: id}
					delete(doc, "_id")
					destination[id] = doc
				}
				if len(rows) < 200 {
					break
				}
			}
		}
		return nil
	}); err != nil {
		return err
	}
	data, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return err
	}
	return writeNewFile(output, append(data, '\n'))
}

func writeNewFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func printJSON(value any) error { return json.NewEncoder(os.Stdout).Encode(value) }
func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
func allowedEmails() []string {
	var result []string
	for _, value := range strings.Split(os.Getenv("ALLOWED_EMAILS"), ",") {
		if email := strings.ToLower(strings.TrimSpace(value)); email != "" {
			result = append(result, email)
		}
	}
	return result
}
