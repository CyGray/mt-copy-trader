package telegram

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/store"
	"github.com/gotd/td/crypto"
	gotd "github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

const (
	ownerDocumentID    = "session_owner"
	statusDocumentID   = "status"
	pendingLoginDocID  = "pending_login"
	commandLease       = 45 * time.Second
	ownerLease         = 35 * time.Second
	ownerHeartbeat     = 10 * time.Second
	defaultCommandPoll = time.Second
	defaultForwardChat = "-1002350471397"
)

var defaultSourceChats = []string{"-1003271337051"}

var errRestartTelegramClient = errors.New("restart Telegram client after authentication boundary")

type Config struct {
	APIID         int
	APIHash       string
	SourceChatIDs []string
	ForwardChatID string
	PollInterval  time.Duration
}

type Runner struct {
	db      store.Store
	cfg     Config
	ownerID string
	updates *UpdateStorage
	hashes  *AccessHashStorage
}

// NewRunner creates the sole Telegram session-owning forwarder. Constructing
// the runner performs no connection or login; Run owns that lifecycle.
func NewRunner(db store.Store, cfg Config) *Runner {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = defaultCommandPoll
	}
	if cfg.ForwardChatID == "" {
		cfg.ForwardChatID = defaultForwardChat
	}
	if len(cfg.SourceChatIDs) == 0 {
		cfg.SourceChatIDs = append([]string(nil), defaultSourceChats...)
	}
	return &Runner{db: db, cfg: cfg, updates: NewUpdateStorage(db), hashes: NewAccessHashStorage(db)}
}

// Run maintains one gotd client, consumes durable login commands, and handles
// reconnect/update-difference recovery. A process lease prevents a second
// forwarder from opening this account session at the same time.
func (r *Runner) Run(ctx context.Context) error {
	if r.db == nil {
		return errors.New("Telegram runner requires the SQLite store")
	}
	if r.cfg.APIID <= 0 || strings.TrimSpace(r.cfg.APIHash) == "" {
		return errors.New("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
	}
	if _, err := masterKey(); err != nil {
		return err
	}
	owner, err := processOwnerID()
	if err != nil {
		return err
	}
	r.ownerID = owner
	if err := r.acquireOwner(ctx, time.Now()); err != nil {
		return err
	}
	defer r.releaseOwner(context.Background())

	leaseCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	heartbeatErr := make(chan error, 1)
	go r.heartbeatOwner(leaseCtx, cancel, heartbeatErr)

	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-heartbeatErr:
			if err != nil {
				return fmt.Errorf("Telegram session owner lease lost: %w", err)
			}
		default:
		}
		if err := r.setConnectingStatus(leaseCtx); err != nil {
			return fmt.Errorf("persist Telegram connecting status: %w", err)
		}
		clientErr := r.runClient(leaseCtx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case leaseErr := <-heartbeatErr:
			return fmt.Errorf("Telegram session owner lease lost: %w", leaseErr)
		default:
		}
		if clientErr == nil {
			clientErr = errors.New("Telegram client stopped unexpectedly")
		}
		if errors.Is(clientErr, errRestartTelegramClient) {
			backoff = time.Second
		} else {
			if err := r.setConnectionFailure(leaseCtx, "telegram_connection_failed"); err != nil {
				return fmt.Errorf("persist Telegram connection failure: %w", err)
			}
			backoff = minDuration(backoff*2, 30*time.Second)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case err := <-heartbeatErr:
			timer.Stop()
			if err != nil {
				return fmt.Errorf("Telegram session owner lease lost: %w", err)
			}
		case <-timer.C:
		}
	}
}

func (r *Runner) runClient(ctx context.Context) error {
	storage := NewSessionStorage(r.db)
	intakeCtx, cancelIntake := context.WithCancel(ctx)
	defer cancelIntake()
	guard := newIntakeGuard(cancelIntake)
	var api *tg.Client
	connectionEvents := make(chan gotd.ConnectionState, 8)
	dispatcher := tg.NewUpdateDispatcher()
	dispatcher.OnNewMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateNewMessage) error {
		return guard.handle(func() error { return r.handleUpdate(ctx, api, entities, update.Message, "new") })
	})
	dispatcher.OnNewChannelMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateNewChannelMessage) error {
		return guard.handle(func() error { return r.handleUpdate(ctx, api, entities, update.Message, "new") })
	})
	dispatcher.OnEditMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateEditMessage) error {
		return guard.handle(func() error { return r.handleUpdate(ctx, api, entities, update.Message, "edit") })
	})
	dispatcher.OnEditChannelMessage(func(ctx context.Context, entities tg.Entities, update *tg.UpdateEditChannelMessage) error {
		return guard.handle(func() error { return r.handleUpdate(ctx, api, entities, update.Message, "edit") })
	})

	updatesManager := updates.New(updates.Config{
		Handler: dispatcher, Storage: r.updates, AccessHasher: r.hashes, UserAccessHasher: r.hashes,
	})
	client := gotd.NewClient(r.cfg.APIID, r.cfg.APIHash, gotd.Options{
		SessionStorage: storage,
		UpdateHandler:  updatesManager,
		OnConnectionState: func(state gotd.ConnectionState) {
			select {
			case connectionEvents <- state:
			default:
				// Keep the newest readiness state if SQLite is temporarily slow
				// and the event loop has not drained earlier transitions.
				select {
				case <-connectionEvents:
				default:
				}
				select {
				case connectionEvents <- state:
				default:
				}
			}
		},
	})
	api = client.API()
	err := client.Run(ctx, func(runCtx context.Context) error {
		status, err := client.Auth().Status(intakeCtx)
		if err != nil {
			return errors.New("Telegram authorization status check failed")
		}
		var updateErrors chan error
		updatesStarted := false
		startUpdates := func(userID int64) {
			if updatesStarted {
				return
			}
			updatesStarted = true
			updateErrors = make(chan error, 1)
			go func() { updateErrors <- updatesManager.Run(intakeCtx, api, userID, updates.AuthOptions{}) }()
		}
		if status.Authorized && status.User != nil {
			if err := r.setGlobalStatus(intakeCtx, telegramStatus{
				Status: "authorized", PhoneMasked: maskPhone(status.User.Phone),
			}); err != nil {
				return err
			}
			startUpdates(status.User.ID)
		} else {
			exists, err := storage.Exists(intakeCtx)
			if err != nil {
				return err
			}
			if exists {
				if err := storage.Clear(intakeCtx); err != nil {
					return err
				}
			}
			if err := r.setDisconnectedStatus(intakeCtx, exists); err != nil {
				return err
			}
		}

		ticker := time.NewTicker(r.cfg.PollInterval)
		defer ticker.Stop()
		authorized := status.Authorized && status.User != nil
		lastForwardSweep := time.Time{}
		for {
			select {
			case state := <-connectionEvents:
				switch state {
				case gotd.ConnectionStateConnecting:
					authorized = false
					if err := r.setConnectingStatus(intakeCtx); err != nil {
						return fmt.Errorf("persist Telegram connecting status: %w", err)
					}
				case gotd.ConnectionStateDisconnected:
					authorized = false
					if err := r.setConnectionFailure(intakeCtx, "telegram_connection_lost"); err != nil {
						return fmt.Errorf("persist Telegram disconnected status: %w", err)
					}
				case gotd.ConnectionStateReady:
					current, err := client.Auth().Status(intakeCtx)
					if err != nil {
						if statusErr := r.setConnectionFailure(intakeCtx, "telegram_status_check_failed"); statusErr != nil {
							return statusErr
						}
						continue
					}
					if current.Authorized && current.User != nil {
						authorized = true
						if err := r.setGlobalStatus(intakeCtx, telegramStatus{Status: "authorized", PhoneMasked: maskPhone(current.User.Phone)}); err != nil {
							return err
						}
					} else {
						authorized = false
						if err := r.setDisconnectedStatus(intakeCtx, false); err != nil {
							return err
						}
					}
				}
			case intakeErr := <-guard.fail:
				return fmt.Errorf("durable Telegram intake failed: %w", intakeErr)
			case <-intakeCtx.Done():
				if intakeErr := guard.failure(); intakeErr != nil {
					return fmt.Errorf("durable Telegram intake failed: %w", intakeErr)
				}
				return nil
			case updateErr := <-updateErrors:
				if intakeCtx.Err() != nil {
					if intakeErr := guard.failure(); intakeErr != nil {
						return fmt.Errorf("durable Telegram intake failed: %w", intakeErr)
					}
					return nil
				}
				if auth.IsUnauthorized(updateErr) {
					_ = storage.Clear(intakeCtx)
					_ = r.setGlobalStatus(intakeCtx, telegramStatus{Status: "disconnected", LastError: stringPtr("session_expired"), ReauthRequired: true})
					return errRestartTelegramClient
				}
				return errors.New("Telegram update gap recovery stopped")
			case <-ticker.C:
				claimed, err := r.claimCommand(intakeCtx, time.Now())
				if err != nil {
					return fmt.Errorf("claim Telegram command: %w", err)
				}
				if claimed != nil {
					result, commandErr, restart := r.executeCommand(intakeCtx, api, claimed)
					if err := r.finishCommand(intakeCtx, claimed, result, commandErr); err != nil {
						return fmt.Errorf("finish Telegram command: %w", err)
					}
					if restart {
						return errRestartTelegramClient
					}
					if result.Status == "authorized" && !updatesStarted {
						authStatus, err := client.Auth().Status(intakeCtx)
						if err != nil || authStatus.User == nil {
							return errors.New("Telegram authorization did not become available after login")
						}
						startUpdates(authStatus.User.ID)
						authorized = true
					}
					if result.Status == "authorized" {
						authorized = true
					}
				}
				if authorized && (lastForwardSweep.IsZero() || time.Since(lastForwardSweep) >= 15*time.Second) {
					lastForwardSweep = time.Now()
					if err := r.replayPendingForwards(intakeCtx, api); err != nil {
						// Forwarding is secondary to the already committed signal event.
						// The durable sending intent will be retried with its same Telegram
						// random_id on a later pass.
						_ = r.writeSystemLog(intakeCtx, "warn", "signal_forward_retry", map[string]any{"error": forwardErrorDetail(err)})
					}
				}
			}
		}
	})
	if intakeErr := guard.failure(); intakeErr != nil {
		return fmt.Errorf("durable Telegram intake failed: %w", intakeErr)
	}
	return err
}

type telegramStatus struct {
	Status         string  `json:"status"`
	PhoneMasked    string  `json:"phone_masked"`
	LastError      *string `json:"last_error"`
	ReauthRequired bool    `json:"reauth_required"`
}

func (r *Runner) setGlobalStatus(ctx context.Context, value telegramStatus) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		previous, err := tx.Get("telegram_state", statusDocumentID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		lastCommandID := previous["last_command_id"]
		return tx.Put("telegram_state", statusDocumentID, store.Document{
			"status": value.Status, "phone_masked": nullIfEmpty(value.PhoneMasked),
			"last_error": value.LastError, "reauth_required": value.ReauthRequired,
			"last_command_id": lastCommandID, "updated_at": store.ISO(time.Now()),
		})
	})
}

func (r *Runner) setDisconnectedStatus(ctx context.Context, requiresReauth bool) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_state", statusDocumentID)
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		doc["status"] = "disconnected"
		doc["reauth_required"] = requiresReauth || boolValue(doc["reauth_required"])
		doc["updated_at"] = store.ISO(time.Now())
		return tx.Put("telegram_state", statusDocumentID, doc)
	})
}

func (r *Runner) setConnectingStatus(ctx context.Context) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_state", statusDocumentID)
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		doc["status"] = "connecting"
		doc["updated_at"] = store.ISO(time.Now())
		return tx.Put("telegram_state", statusDocumentID, doc)
	})
}

func (r *Runner) setConnectionFailure(ctx context.Context, code string) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_state", statusDocumentID)
		if errors.Is(err, store.ErrNotFound) {
			doc = store.Document{}
		} else if err != nil {
			return err
		}
		doc["status"] = "disconnected"
		doc["last_error"] = code
		doc["updated_at"] = store.ISO(time.Now())
		if doc["reauth_required"] == nil {
			doc["reauth_required"] = false
		}
		return tx.Put("telegram_state", statusDocumentID, doc)
	})
}

type claimedCommand struct {
	ID       string
	LeaseID  string
	Document store.Document
}

func (r *Runner) claimCommand(ctx context.Context, now time.Time) (*claimedCommand, error) {
	var claimed *claimedCommand
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		if err := r.checkOwnerTx(tx, now); err != nil {
			return err
		}
		rows, err := tx.List("telegram_commands", store.ListOptions{
			Filters: []store.Filter{{Field: store.StatusField, Values: []string{"pending", "processing"}}},
			Limit:   100,
		})
		if err != nil {
			return err
		}
		for _, row := range rows {
			id := stringValue(row["_id"])
			doc := withoutDocumentID(row)
			status := stringValue(doc["status"])
			if status == "processing" {
				if timeAfter(doc["lease_expires_at"], now) {
					continue
				}
				// A prior process may have sent an OTP or submitted a credential
				// before it died. Never replay such a secret command implicitly.
				doc["status"] = "error"
				doc["result"] = map[string]any{
					"status": "disconnected", "phone_masked": nil,
					"last_error": "command_interrupted", "reauth_required": false,
				}
				delete(doc, "payload_enc")
				doc["lease_owner"], doc["lease_expires_at"] = nil, nil
				doc["updated_at"] = store.ISO(now)
				if err := tx.Put("telegram_commands", id, doc); err != nil {
					return err
				}
				continue
			}
			lease, err := randomOwnerID()
			if err != nil {
				return err
			}
			doc["status"], doc["lease_owner"] = "processing", r.ownerID+":"+lease
			doc["lease_expires_at"], doc["updated_at"] = store.ISO(now.Add(commandLease)), store.ISO(now)
			if err := tx.Put("telegram_commands", id, doc); err != nil {
				return err
			}
			claimed = &claimedCommand{ID: id, LeaseID: stringValue(doc["lease_owner"]), Document: doc}
			return nil
		}
		return nil
	})
	return claimed, err
}

func (r *Runner) executeCommand(ctx context.Context, api *tg.Client, cmd *claimedCommand) (telegramStatus, error, bool) {
	var status telegramStatus
	status.Status = "disconnected"
	if encrypted := stringValue(cmd.Document["payload_enc"]); encrypted != "" {
		plaintext, err := DecryptCommandPayload(encrypted)
		if err != nil {
			status.LastError = stringPtr("invalid_command_payload")
			return status, errors.New("invalid_command_payload"), false
		}
		var payload map[string]string
		if err := json.Unmarshal(plaintext, &payload); err != nil {
			status.LastError = stringPtr("invalid_command_payload")
			return status, errors.New("invalid_command_payload"), false
		}
		defer clear(plaintext)
		return r.handleAuthCommand(ctx, api, stringValue(cmd.Document["type"]), payload)
	}
	status.LastError = stringPtr("missing_command_payload")
	return status, errors.New("missing_command_payload"), false
}

func (r *Runner) handleAuthCommand(ctx context.Context, api *tg.Client, commandType string, payload map[string]string) (telegramStatus, error, bool) {
	login := auth.NewClient(api, crypto.DefaultRand(), r.cfg.APIID, r.cfg.APIHash)
	switch commandType {
	case "start_login":
		phone := strings.TrimSpace(payload["phone"])
		if phone == "" {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("phone_required")}, errors.New("phone_required"), false
		}
		status, err := login.Status(ctx)
		if err != nil {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("telegram_error")}, errors.New("telegram_error"), false
		}
		if status.Authorized {
			phoneMasked := ""
			if status.User != nil {
				phoneMasked = maskPhone(status.User.Phone)
			}
			return telegramStatus{Status: "authorized", PhoneMasked: phoneMasked}, nil, false
		}
		sent, err := login.SendCode(ctx, phone, auth.SendCodeOptions{})
		if err != nil {
			return telegramStatus{Status: "disconnected", PhoneMasked: maskPhone(phone), LastError: stringPtr("telegram_send_code_failed")}, errors.New("telegram_send_code_failed"), false
		}
		code, ok := sent.(*tg.AuthSentCode)
		if !ok || code.PhoneCodeHash == "" {
			return telegramStatus{Status: "disconnected", PhoneMasked: maskPhone(phone), LastError: stringPtr("unsupported_code_response")}, errors.New("unsupported_code_response"), false
		}
		if err := r.savePendingLogin(ctx, pendingLogin{Phone: phone, CodeHash: code.PhoneCodeHash}); err != nil {
			return telegramStatus{Status: "disconnected", PhoneMasked: maskPhone(phone), LastError: stringPtr("storage_error")}, errors.New("storage_error"), false
		}
		return telegramStatus{Status: "awaiting_code", PhoneMasked: maskPhone(phone)}, nil, false
	case "verify_otp":
		pending, err := r.loadPendingLogin(ctx)
		if err != nil {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("login_not_started")}, errors.New("login_not_started"), false
		}
		code := strings.TrimSpace(payload["code"])
		if code == "" {
			return telegramStatus{Status: "awaiting_code", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("code_required")}, errors.New("code_required"), false
		}
		_, err = login.SignIn(ctx, pending.Phone, code, pending.CodeHash)
		if errors.Is(err, auth.ErrPasswordAuthNeeded) {
			return telegramStatus{Status: "awaiting_password", PhoneMasked: maskPhone(pending.Phone)}, nil, false
		}
		if err != nil {
			return telegramStatus{Status: "awaiting_code", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("invalid_code")}, errors.New("invalid_code"), false
		}
		if err := r.deletePendingLogin(ctx); err != nil {
			return telegramStatus{Status: "authorized", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("storage_error")}, errors.New("storage_error"), true
		}
		return telegramStatus{Status: "authorized", PhoneMasked: maskPhone(pending.Phone)}, nil, false
	case "verify_password":
		pending, err := r.loadPendingLogin(ctx)
		if err != nil {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("login_not_started")}, errors.New("login_not_started"), false
		}
		password := payload["password"]
		if password == "" {
			return telegramStatus{Status: "awaiting_password", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("password_required")}, errors.New("password_required"), false
		}
		defer clearString(password)
		if _, err := login.Password(ctx, password); err != nil {
			return telegramStatus{Status: "awaiting_password", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("invalid_password")}, errors.New("invalid_password"), false
		}
		if err := r.deletePendingLogin(ctx); err != nil {
			return telegramStatus{Status: "authorized", PhoneMasked: maskPhone(pending.Phone), LastError: stringPtr("storage_error")}, errors.New("storage_error"), true
		}
		return telegramStatus{Status: "authorized", PhoneMasked: maskPhone(pending.Phone)}, nil, false
	case "logout":
		if _, err := api.AuthLogOut(ctx); err != nil {
			return telegramStatus{Status: "authorized", LastError: stringPtr("telegram_logout_failed")}, errors.New("telegram_logout_failed"), false
		}
		if err := NewSessionStorage(r.db).Clear(ctx); err != nil {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("storage_error"), ReauthRequired: true}, errors.New("storage_error"), true
		}
		if err := r.deletePendingLogin(ctx); err != nil {
			return telegramStatus{Status: "disconnected", LastError: stringPtr("storage_error")}, errors.New("storage_error"), true
		}
		return telegramStatus{Status: "disconnected"}, nil, true
	default:
		return telegramStatus{Status: "disconnected", LastError: stringPtr("unknown_command")}, errors.New("unknown_command"), false
	}
}

func (r *Runner) finishCommand(ctx context.Context, cmd *claimedCommand, result telegramStatus, commandErr error) error {
	status := "done"
	if commandErr != nil {
		status = "error"
	}
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_commands", cmd.ID)
		if err != nil {
			return err
		}
		if stringValue(doc["status"]) != "processing" || stringValue(doc["lease_owner"]) != cmd.LeaseID {
			return errors.New("Telegram command lease was lost before completion")
		}
		resultDoc := store.Document{
			"status": result.Status, "phone_masked": nullIfEmpty(result.PhoneMasked),
			"last_error": result.LastError, "reauth_required": result.ReauthRequired,
		}
		doc["status"], doc["result"] = status, resultDoc
		delete(doc, "payload_enc")
		doc["lease_owner"], doc["lease_expires_at"] = nil, nil
		doc["updated_at"] = store.ISO(time.Now())
		if err := tx.Put("telegram_commands", cmd.ID, doc); err != nil {
			return err
		}
		global := store.Document{
			"status": result.Status, "phone_masked": nullIfEmpty(result.PhoneMasked),
			"last_error": result.LastError, "reauth_required": result.ReauthRequired,
			"last_command_id": cmd.ID, "updated_at": store.ISO(time.Now()),
		}
		return tx.Put("telegram_state", statusDocumentID, global)
	})
}

type pendingLogin struct {
	Phone    string `json:"phone"`
	CodeHash string `json:"code_hash"`
}

func (r *Runner) savePendingLogin(ctx context.Context, pending pendingLogin) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	envelope, err := EncryptCommandPayload(data)
	clear(data)
	if err != nil {
		return err
	}
	return r.db.Put(ctx, "telegram_state", pendingLoginDocID, store.Document{
		"payload_enc": envelope, "updated_at": store.ISO(time.Now()),
	})
}

func (r *Runner) loadPendingLogin(ctx context.Context) (pendingLogin, error) {
	doc, err := r.db.Get(ctx, "telegram_state", pendingLoginDocID)
	if err != nil {
		return pendingLogin{}, err
	}
	data, err := DecryptCommandPayload(stringValue(doc["payload_enc"]))
	if err != nil {
		return pendingLogin{}, err
	}
	defer clear(data)
	var pending pendingLogin
	err = json.Unmarshal(data, &pending)
	return pending, err
}

func (r *Runner) deletePendingLogin(ctx context.Context) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error { return tx.Delete("telegram_state", pendingLoginDocID) })
}

func (r *Runner) acquireOwner(ctx context.Context, now time.Time) error {
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_state", ownerDocumentID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		owner := stringValue(doc["owner_id"])
		if owner != "" && owner != r.ownerID && timeAfter(doc["lease_expires_at"], now) {
			return errors.New("another forwarder owns the Telegram session")
		}
		return tx.Put("telegram_state", ownerDocumentID, store.Document{
			"owner_id": r.ownerID, "lease_expires_at": store.ISO(now.Add(ownerLease)), "updated_at": store.ISO(now),
		})
	})
}

func (r *Runner) heartbeatOwner(ctx context.Context, cancel context.CancelFunc, result chan<- error) {
	ticker := time.NewTicker(ownerHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			err := r.db.WithTx(ctx, func(tx *store.Tx) error {
				doc, err := tx.Get("telegram_state", ownerDocumentID)
				if err != nil {
					return err
				}
				if stringValue(doc["owner_id"]) != r.ownerID {
					return errors.New("owner changed")
				}
				doc["lease_expires_at"], doc["updated_at"] = store.ISO(now.Add(ownerLease)), store.ISO(now)
				return tx.Put("telegram_state", ownerDocumentID, doc)
			})
			if err != nil {
				cancel()
				select {
				case result <- err:
				default:
				}
				return
			}
		}
	}
}

func (r *Runner) checkOwnerTx(tx *store.Tx, now time.Time) error {
	doc, err := tx.Get("telegram_state", ownerDocumentID)
	if err != nil {
		return err
	}
	if stringValue(doc["owner_id"]) != r.ownerID || !timeAfter(doc["lease_expires_at"], now) {
		return errors.New("Telegram session owner lease is no longer held")
	}
	return nil
}

func (r *Runner) releaseOwner(ctx context.Context) {
	_ = r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("telegram_state", ownerDocumentID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil
			}
			return err
		}
		if stringValue(doc["owner_id"]) == r.ownerID {
			return tx.Delete("telegram_state", ownerDocumentID)
		}
		return nil
	})
}

func (r *Runner) writeSystemLog(ctx context.Context, severity, event string, details map[string]any) error {
	when := time.Now()
	id, err := randomOwnerID()
	if err != nil {
		return err
	}
	return r.db.Put(ctx, "system_logs", store.ISO(when)+"_telegram_"+id, store.Document{
		"severity": severity, "component": "telegram", "event": event,
		"details": details, "timestamp": store.ISO(when),
	})
}

func processOwnerID() (string, error) { return randomOwnerID() }
func randomOwnerID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", errors.New("generate Telegram owner token")
	}
	return hex.EncodeToString(data[:]), nil
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}
func stringPtr(value string) *string { return &value }
func maskPhone(value string) string {
	digits := make([]rune, 0, len(value))
	for _, char := range value {
		if char >= '0' && char <= '9' {
			digits = append(digits, char)
		}
	}
	if len(digits) > 3 {
		digits = digits[len(digits)-3:]
	}
	return "***" + string(digits)
}
func clearString(value string) {
	// Go strings are immutable; the best practical effort is to clear a copy
	// immediately after use. Avoid retaining secrets in command result structs.
	bytes := []byte(value)
	clear(bytes)
}
// forwardErrorDetail keeps operator visibility into why a forward failed while
// bounding the value written to the durable log.
func forwardErrorDetail(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
func timeAfter(value any, now time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, stringValue(value))
	return err == nil && parsed.After(now)
}
func withoutDocumentID(doc store.Document) store.Document {
	copyDoc := make(store.Document, len(doc))
	for key, value := range doc {
		if key != "_id" {
			copyDoc[key] = value
		}
	}
	return copyDoc
}
