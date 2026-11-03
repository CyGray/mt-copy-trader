package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/go-zeromq/zmq4"
)

const protocolVersion = 2

var mutatingActions = map[string]bool{
	"ORDER_SEND": true, "POSITION_MODIFY": true, "ORDER_MODIFY": true,
	"PENDING_MODIFY": true, "CLOSE_POSITION": true, "CANCEL_ORDER": true,
}

type ClientConfig struct {
	Endpoint    string
	Timeout     time.Duration
	MutationTTL time.Duration
	Now         func() time.Time
}

type Client struct {
	endpoint    string
	timeout     time.Duration
	mutationTTL time.Duration
	now         func() time.Time
	gate        chan struct{}
}

type RequestOptions struct {
	ExpiresAt int64
}

type BridgeError struct {
	Retcode int
	Message string
	Data    map[string]any
}

func (e *BridgeError) Error() string {
	return fmt.Sprintf("MT5 bridge error %d: %s", e.Retcode, e.Message)
}

type AmbiguousError struct {
	Action    string
	RequestID string
	ExpiresAt int64
	Message   string
}

func (e *AmbiguousError) Error() string {
	return fmt.Sprintf("MT5 outcome unknown for %s: %s", e.Action, e.Message)
}

type UnavailableError struct {
	Action  string
	Message string
}

func (e *UnavailableError) Error() string {
	return fmt.Sprintf("MT5 bridge unavailable for %s: %s", e.Action, e.Message)
}

type reply struct {
	OK        bool           `json:"ok"`
	Retcode   int            `json:"retcode"`
	RequestID string         `json:"request_id"`
	Error     string         `json:"error"`
	Data      map[string]any `json:"data"`
}

func NewClient(cfg ClientConfig) *Client {
	if cfg.Endpoint == "" {
		cfg.Endpoint = "tcp://127.0.0.1:5555"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	if cfg.MutationTTL <= 0 {
		cfg.MutationTTL = 8 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Client{endpoint: cfg.Endpoint, timeout: cfg.Timeout, mutationTTL: cfg.MutationTTL, now: cfg.Now, gate: make(chan struct{}, 1)}
}

// Do sends one protocol v2 request and serializes it with all other calls.
func (c *Client) Do(ctx context.Context, action string, params map[string]any) (map[string]any, error) {
	return c.DoWithOptions(ctx, action, params, RequestOptions{})
}

func (c *Client) DoWithOptions(ctx context.Context, action string, params map[string]any, opts RequestOptions) (map[string]any, error) {
	select {
	case c.gate <- struct{}{}:
		defer func() { <-c.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	mutating := mutatingActions[action]
	attempts := 2
	if mutating {
		attempts = 1
	}
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(200 * time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		data, requestID, expiresAt, sent, err := c.exchange(ctx, action, params, mutating, opts)
		if err == nil {
			return data, nil
		}
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) {
			return nil, err
		}
		if mutating {
			if sent {
				return nil, &AmbiguousError{Action: action, RequestID: requestID, ExpiresAt: expiresAt, Message: err.Error()}
			}
			return nil, &UnavailableError{Action: action, Message: err.Error()}
		}
		last = err
	}
	return nil, &UnavailableError{Action: action, Message: last.Error()}
}

func (c *Client) exchange(parent context.Context, action string, params map[string]any, mutating bool, opts RequestOptions) (map[string]any, string, int64, bool, error) {
	requestID, err := newRequestID()
	if err != nil {
		return nil, "", 0, false, fmt.Errorf("create request id: %w", err)
	}
	expiresAt := int64(0)
	if mutating {
		expiresAt = opts.ExpiresAt
		if expiresAt <= 0 {
			expiresAt = c.now().UTC().Unix() + int64(c.mutationTTL/time.Second)
		}
	}
	envelope := make(map[string]any, len(params)+5)
	for key, value := range params {
		envelope[key] = value
	}
	envelope["v"], envelope["request_id"], envelope["action"] = protocolVersion, requestID, action
	if mutating {
		envelope["expires_at"] = expiresAt
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return nil, requestID, expiresAt, false, fmt.Errorf("encode request: %w", err)
	}

	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	sock := zmq4.NewReq(ctx,
		zmq4.WithTimeout(c.timeout),
		zmq4.WithDialerTimeout(c.timeout),
		zmq4.WithDialerMaxRetries(0),
	)
	var closeOnce sync.Once
	closeDone := make(chan struct{})
	closeSocket := func() {
		closeOnce.Do(func() {
			_ = sock.Close()
			close(closeDone)
		})
	}
	defer closeSocket()
	stopClose := context.AfterFunc(ctx, closeSocket)
	defer func() {
		if !stopClose() {
			<-closeDone
		}
	}()
	if err := sock.Dial(c.endpoint); err != nil {
		return nil, requestID, expiresAt, false, fmt.Errorf("connect: %w", err)
	}
	if err := sock.Send(zmq4.NewMsg(payload)); err != nil {
		return nil, requestID, expiresAt, true, fmt.Errorf("send: %w", err)
	}
	msg, err := sock.Recv()
	if err != nil {
		return nil, requestID, expiresAt, true, fmt.Errorf("receive: %w", err)
	}
	var got reply
	if err := json.Unmarshal(msg.Bytes(), &got); err != nil {
		return nil, requestID, expiresAt, true, fmt.Errorf("decode reply: %w", err)
	}
	if got.RequestID != requestID {
		return nil, requestID, expiresAt, true, fmt.Errorf("reply request_id mismatch")
	}
	if !got.OK {
		return nil, requestID, expiresAt, false, &BridgeError{Retcode: got.Retcode, Message: got.Error, Data: got.Data}
	}
	if got.Data == nil {
		got.Data = map[string]any{}
	}
	return got.Data, requestID, expiresAt, false, nil
}

func newRequestID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}
