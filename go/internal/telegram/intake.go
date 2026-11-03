package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bytrader/bytrader/internal/domain"
	"github.com/bytrader/bytrader/internal/store"
	"github.com/gotd/td/tg"
)

func (r *Runner) handleUpdate(ctx context.Context, api *tg.Client, _ tg.Entities, messageClass tg.MessageClass, messageType string) error {
	message, ok := messageClass.(*tg.Message)
	if !ok || message == nil || message.Out {
		return nil
	}
	chatID := telegramChatID(message.PeerID)
	if chatID == "" || message.ID <= 0 {
		return nil
	}
	text := message.Message
	hashBytes := sha256.Sum256([]byte(text))
	hash := hex.EncodeToString(hashBytes[:])
	messageID := strconv.Itoa(message.ID)
	messageTime, sourceDateOK := telegramDate(message.Date)
	var editTime any
	if date, exists := message.GetEditDate(); exists && date > 0 {
		editTime = store.ISO(time.Unix(int64(date), 0))
	}
	parsed := domain.ParseGoldSignal(text)
	historyParsed := parseTelegramHistory(text)
	var parsedSignal any
	if historyParsed.OK {
		parsedSignal = historyParsed.Signal
	}
	debug := debugEnvelope(message)
	raw := safeMessageJSON(message)
	now := time.Now().UTC()

	settings, settingsErr := r.db.Get(ctx, "settings", "default")
	telegram := object(settings["telegram"])
	allowed := normalizeChatIDs(telegram["allowed_chat_ids"])
	blocked := normalizeChatIDs(telegram["blocked_chat_ids"])
	if containsChat(blocked, chatID) || len(allowed) > 0 && !containsChat(allowed, chatID) {
		return nil
	}

	migration := object(settings["migration"])
	replayBarrier := parseTime(migration["replay_not_before"])
	cutoverAt := parseTime(migration["cutover_at"])
	ignoredReason := ""
	if settingsErr != nil || replayBarrier.IsZero() || cutoverAt.IsZero() || !cutoverAt.Equal(replayBarrier) || migration["old_queue_disposition"] != "discarded_at_settled_boundary" {
		ignoredReason = "replay_barrier_missing"
	} else if !sourceDateOK {
		ignoredReason = "source_date_missing"
	} else if messageTime.Before(replayBarrier) {
		ignoredReason = "before_replay_barrier"
	}

	history := store.Document{
		"chat_id": chatID, "message_id": messageID, "hash": hash, "type": messageType,
		"text": text, "date": nullableTime(messageTime, sourceDateOK), "edit_date": editTime,
		"parsed_ok": historyParsed.OK, "parsed": parsedSignal, "parse_error": nullIfEmpty(historyParsed.Error),
		"debug": debug, "raw_message": raw, "timestamp": store.ISO(now),
	}
	if ignoredReason != "" {
		history["ignored_reason"] = ignoredReason
	}
	if _, err := r.createHistory(ctx, chatID+"_"+messageID+"_"+hash, history); err != nil {
		// History is useful but does not gate the durable executable event.
		_ = r.writeSystemLog(ctx, "warn", "telegram_history_write_failed", map[string]any{"chat_id": chatID, "message_id": messageID})
	}
	if ignoredReason != "" {
		if ignoredReason == "replay_barrier_missing" || ignoredReason == "source_date_missing" {
			_ = r.writeSystemLog(ctx, "error", "telegram_replay_barrier_unavailable", map[string]any{"chat_id": chatID, "message_id": messageID})
		}
		return nil
	}

	replyToID := ""
	if header, ok := message.GetReplyTo(); ok {
		if reply, ok := header.(*tg.MessageReplyHeader); ok && reply.ReplyToMsgID > 0 {
			replyToID = strconv.Itoa(reply.ReplyToMsgID)
		}
	}
	event, shouldPublish := eventForMessageWithReply(chatID, messageID, messageType, text, hash, messageTime, parsed, replyToID)
	if !shouldPublish {
		return nil
	}
	publisher, ok := r.db.(interface {
		PublishSignalEvent(context.Context, string, store.Document) (bool, error)
	})
	if !ok {
		return errors.New("SQLite store does not implement durable Telegram event publishing")
	}
	created, err := publisher.PublishSignalEvent(ctx, event.EventID, event.Document)
	if err != nil {
		return fmt.Errorf("persist Telegram signal event before dispatch: %w", err)
	}
	_ = created // duplicate event IDs remain an idempotent no-op.
	if event.Signal != nil {
		if err := r.maybeForwardSignal(ctx, api, event.ChatID, event.MessageID, hash, *event.Signal); err != nil {
			return fmt.Errorf("persist Telegram forward intent: %w", err)
		}
	}
	return nil
}

type intakeEvent struct {
	EventID   string
	ChatID    string
	MessageID string
	Signal    *domain.Signal
	Document  store.Document
}

func eventForMessage(chatID, messageID, messageType, text, hash string, messageDate time.Time, parsed domain.ParseResult) (intakeEvent, bool) {
	kind := ""
	reason := ""
	var signal *domain.Signal
	if parsed.OK {
		kind, signal = "signal", parsed.Signal
	} else if messageType == "edit" {
		kind = "cancel"
		if domain.DetectCancelIntent(text) {
			reason = "explicit_cancel"
		} else {
			reason = "unparseable_edit"
		}
	} else if domain.DetectCancelIntent(text) {
		return intakeEvent{}, false // a new cancel must reply to its target signal.
	} else {
		return intakeEvent{}, false
	}
	if kind == "cancel" && messageType == "new" {
		return intakeEvent{}, false
	}
	created := store.ISO(time.Now())
	messageDateText := any(nil)
	if !messageDate.IsZero() {
		messageDateText = store.ISO(messageDate)
	}
	// Reply cancellation is handled by the caller when the message has a
	// reply_to header; this constructor only handles source-message revisions.
	doc := store.Document{
		"chat_id": chatID, "message_id": messageID, "message_type": messageType,
		"text_hash": hash, "kind": kind, "signal": signal, "message_date": messageDateText,
		"created_at": created,
		"autotrader": store.Document{
			"status": "pending", "attempts": 0, "next_attempt_at": created,
			"lease_id": nil, "lease_owner": nil, "lease_expires_at": nil, "updated_at": created,
		},
	}
	if reason != "" {
		doc["cancel_reason"] = reason
	}
	return intakeEvent{EventID: chatID + "_" + messageID + "_" + hash, ChatID: chatID, MessageID: messageID, Signal: signal, Document: doc}, true
}

func (r *Runner) createHistory(ctx context.Context, id string, doc store.Document) (bool, error) {
	var created bool
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		var err error
		created, err = tx.Create("telegram_messages", id, doc)
		return err
	})
	return created, err
}

func (r *Runner) maybeForwardSignal(ctx context.Context, api *tg.Client, chatID, messageID, hash string, signal domain.Signal) error {
	config, err := r.forwardConfig(ctx)
	if err != nil || !config.Enabled || config.Destination == "" || !containsChat(config.Sources, chatID) {
		return err
	}
	intent, created, err := r.prepareForward(ctx, chatID, messageID, hash, signal, config.Destination)
	if err != nil || !created {
		return err
	}
	// The sending intent and deterministic Telegram random_id are committed
	// before the external send. Leave it pending on network/API failure; the
	// forwarder sweep retries the exact same request after reconnect.
	_ = r.sendForward(ctx, api, intent)
	return nil
}

type forwardConfig struct {
	Enabled     bool
	Destination string
	Sources     []string
}

func (r *Runner) forwardConfig(ctx context.Context) (forwardConfig, error) {
	doc, err := r.db.Get(ctx, "settings", "default")
	if err != nil {
		return forwardConfig{}, err
	}
	telegram := object(doc["telegram"])
	enabled := true
	if value, exists := telegram["signal_forward_enabled"]; exists {
		enabled = value != false && value != "false"
	}
	destination := r.cfg.ForwardChatID
	if value, exists := telegram["forward_chat_id"]; exists {
		destination = strings.TrimSpace(stringValue(value))
	}
	sources := normalizeChatIDs(r.cfg.SourceChatIDs)
	if value, exists := telegram["signal_source_chat_ids"]; exists {
		sources = normalizeChatIDs(value)
	}
	return forwardConfig{Enabled: enabled, Destination: destination, Sources: sources}, nil
}

type forwardIntent struct {
	ID          string
	SourceChat  string
	MessageID   string
	Destination string
	Text        string
	RandomID    int64
	Hash        string
	Revision    int
	Signal      domain.Signal
}

func (r *Runner) prepareForward(ctx context.Context, chatID, messageID, hash string, signal domain.Signal, destination string) (forwardIntent, bool, error) {
	id := chatID + "_" + messageID
	intent := forwardIntent{ID: id, SourceChat: chatID, MessageID: messageID, Destination: destination, Hash: hash, Signal: signal}
	err := r.db.WithTx(ctx, func(tx *store.Tx) error {
		previous, err := tx.Get("signal_forwards", id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err == nil {
			if stringValue(previous["last_hash"]) == hash {
				if stringValue(previous["status"]) == "sent" {
					return errForwardAlreadySent
				}
				if stringValue(previous["status"]) == "sending" {
					intent = forwardIntentFromDoc(id, previous)
					return nil
				}
			}
			if stringValue(previous["status"]) == "sending" {
				return errors.New("previous Telegram forward has an unresolved outcome")
			}
			intent.Revision = intValue(previous["revision"]) + 1
		}
		intent.Text = formatForward(signal, intent.Revision > 0)
		intent.RandomID = deterministicRandomID(chatID, messageID, hash)
		doc := store.Document{
			"source_chat_id": chatID, "message_id": messageID, "forward_chat_id": destination,
			"symbol": signal.Symbol, "direction": signal.Direction, "entry_low": signal.EntryLow,
			"entry_high": signal.EntryHigh, "stop_loss": signal.StopLoss, "take_profits": signal.TakeProfits,
			"revision": intent.Revision, "correction": intent.Revision > 0, "last_hash": hash,
			"text": intent.Text, "random_id": intent.RandomID, "status": "sending", "timestamp": store.ISO(time.Now()),
		}
		return tx.Put("signal_forwards", id, doc)
	})
	if errors.Is(err, errForwardAlreadySent) {
		return intent, false, nil
	}
	return intent, err == nil, err
}

var errForwardAlreadySent = errors.New("forward already sent")

func (r *Runner) replayPendingForwards(ctx context.Context, api *tg.Client) error {
	rows, err := r.db.List(ctx, "signal_forwards", store.ListOptions{
		Filters: []store.Filter{{Field: store.StatusField, Values: []string{"sending"}}}, Limit: 100,
	})
	if err != nil {
		return err
	}
	for _, row := range rows {
		intent := forwardIntentFromDoc(stringValue(row["_id"]), withoutDocumentID(row))
		if err := r.sendForward(ctx, api, intent); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) sendForward(ctx context.Context, api *tg.Client, intent forwardIntent) error {
	if api == nil {
		return errors.New("Telegram API unavailable")
	}
	peer, err := resolvePeer(ctx, api, intent.Destination)
	if err != nil {
		return err
	}
	if _, err := api.MessagesSendMessage(ctx, &tg.MessagesSendMessageRequest{
		Peer: peer, Message: intent.Text, RandomID: intent.RandomID,
	}); err != nil {
		return err
	}
	return r.db.WithTx(ctx, func(tx *store.Tx) error {
		doc, err := tx.Get("signal_forwards", intent.ID)
		if err != nil {
			return err
		}
		if stringValue(doc["status"]) != "sending" || int64Value(doc["random_id"]) != intent.RandomID {
			return errors.New("signal forward intent changed while sending")
		}
		doc["status"], doc["sent_at"], doc["timestamp"] = "sent", store.ISO(time.Now()), store.ISO(time.Now())
		return tx.Put("signal_forwards", intent.ID, doc)
	})
}

func resolvePeer(ctx context.Context, api *tg.Client, chatID string) (tg.InputPeerClass, error) {
	dialogs, err := api.MessagesGetDialogs(ctx, dialogsRequest())
	if err != nil {
		return nil, err
	}
	var chats []tg.ChatClass
	switch result := dialogs.(type) {
	case *tg.MessagesDialogs:
		chats = result.Chats
	case *tg.MessagesDialogsSlice:
		chats = result.Chats
	default:
		return nil, fmt.Errorf("unsupported Telegram dialogs response %T", dialogs)
	}
	wanted := strings.TrimSpace(chatID)
	for _, raw := range chats {
		switch item := raw.(type) {
		case *tg.Channel:
			if telegramChatID(&tg.PeerChannel{ChannelID: item.ID}) == wanted {
				return &tg.InputPeerChannel{ChannelID: item.ID, AccessHash: item.AccessHash}, nil
			}
		case *tg.Chat:
			if telegramChatID(&tg.PeerChat{ChatID: item.ID}) == wanted {
				return &tg.InputPeerChat{ChatID: item.ID}, nil
			}
		}
	}
	return nil, fmt.Errorf("forward destination %s was not found in Telegram dialogs", wanted)
}

// dialogsRequest builds a full dialog page. Telegram requires offset_peer to be
// present even on the first page; gotd refuses to encode the request otherwise,
// which silently blocked every forward before the fix.
func dialogsRequest() *tg.MessagesGetDialogsRequest {
	return &tg.MessagesGetDialogsRequest{OffsetPeer: &tg.InputPeerEmpty{}, Limit: 300}
}

func forwardIntentFromDoc(id string, doc store.Document) forwardIntent {
	signal := domain.Signal{
		Symbol: stringValue(doc["symbol"]), Direction: domain.Direction(stringValue(doc["direction"])),
		EntryLow: floatValue(doc["entry_low"]), EntryHigh: floatValue(doc["entry_high"]),
		StopLoss: floatValue(doc["stop_loss"]), TakeProfits: floatSlice(doc["take_profits"]),
	}
	return forwardIntent{
		ID: id, SourceChat: stringValue(doc["source_chat_id"]), MessageID: stringValue(doc["message_id"]),
		Destination: stringValue(doc["forward_chat_id"]), Text: stringValue(doc["text"]),
		RandomID: int64Value(doc["random_id"]), Hash: stringValue(doc["last_hash"]),
		Revision: intValue(doc["revision"]), Signal: signal,
	}
}

func formatForward(signal domain.Signal, correction bool) string {
	header := "🔴 SELL"
	if signal.Direction == domain.Buy {
		header = "🟢 BUY"
	}
	entry := strconv.FormatFloat(signal.EntryLow, 'f', -1, 64)
	if signal.EntryLow != signal.EntryHigh {
		entry += " - " + strconv.FormatFloat(signal.EntryHigh, 'f', -1, 64)
	}
	lines := make([]string, 0, len(signal.TakeProfits)+5)
	if correction {
		lines = append(lines, "♻️ CORRECTION", "")
	}
	lines = append(lines, header+" "+signal.Symbol, "", "Entry: "+entry, "SL: "+strconv.FormatFloat(signal.StopLoss, 'f', -1, 64))
	for index, target := range signal.TakeProfits {
		lines = append(lines, fmt.Sprintf("TP%d: %s", index+1, strconv.FormatFloat(target, 'f', -1, 64)))
	}
	return strings.Join(lines, "\n")
}

func deterministicRandomID(chatID, messageID, hash string) int64 {
	value := sha256.Sum256([]byte(chatID + "\x00" + messageID + "\x00" + hash))
	id := int64(binary.BigEndian.Uint64(value[:8]))
	if id == 0 {
		return 1
	}
	return id
}

func eventForMessageWithReply(chatID, messageID, messageType, text, hash string, messageDate time.Time, parsed domain.ParseResult, replyToID string) (intakeEvent, bool) {
	if messageType == "new" && !parsed.OK && domain.DetectCancelIntent(text) && replyToID != "" {
		created := store.ISO(time.Now())
		dateText := any(nil)
		if !messageDate.IsZero() {
			dateText = store.ISO(messageDate)
		}
		doc := store.Document{
			"chat_id": chatID, "message_id": replyToID, "message_type": "new", "text_hash": hash,
			"kind": "cancel", "signal": nil, "message_date": dateText,
			"cancel_reason": "explicit_cancel", "trigger_message_id": messageID,
			"created_at": created,
			"autotrader": store.Document{
				"status": "pending", "attempts": 0, "next_attempt_at": created,
				"lease_id": nil, "lease_owner": nil, "lease_expires_at": nil, "updated_at": created,
			},
		}
		return intakeEvent{EventID: chatID + "_" + replyToID + "_" + hash, ChatID: chatID, MessageID: replyToID, Document: doc}, true
	}
	return eventForMessage(chatID, messageID, messageType, text, hash, messageDate, parsed)
}

func telegramChatID(peer tg.PeerClass) string {
	switch item := peer.(type) {
	case *tg.PeerChannel:
		return "-100" + strconv.FormatInt(item.ChannelID, 10)
	case *tg.PeerChat:
		return "-" + strconv.FormatInt(item.ChatID, 10)
	case *tg.PeerUser:
		return strconv.FormatInt(item.UserID, 10)
	default:
		return ""
	}
}

func telegramDate(value int) (time.Time, bool) {
	if value <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(value), 0).UTC(), true
}

func debugEnvelope(message *tg.Message) map[string]any {
	_, hasMedia := message.GetMedia()
	forward, isForward := message.GetFwdFrom()
	_ = forward
	reply, isReply := message.GetReplyTo()
	replyID := any(nil)
	if header, ok := reply.(*tg.MessageReplyHeader); ok && header.ReplyToMsgID > 0 {
		replyID = header.ReplyToMsgID
	}
	group, hasGroup := message.GetGroupedID()
	via, hasVia := message.GetViaBotID()
	author, hasAuthor := message.GetPostAuthor()
	return map[string]any{
		"has_text": message.Message != "", "has_media": hasMedia, "media_file_name": nil,
		"is_forward": isForward, "is_reply": isReply, "reply_to_msg_id": replyID,
		"is_post":    message.Post,
		"grouped_id": nullableInt64(group, hasGroup), "via_bot_id": nullableInt64(via, hasVia),
		"post_author": nullableString(author, hasAuthor), "action_type": nil,
	}
}

func safeMessageJSON(message *tg.Message) any {
	data, err := json.Marshal(message)
	if err != nil {
		return map[string]any{"id": message.ID, "message": message.Message, "date": message.Date}
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return map[string]any{"id": message.ID, "message": message.Message, "date": message.Date}
	}
	return value
}

func normalizeChatIDs(value any) []string {
	values := []string{}
	switch list := value.(type) {
	case []string:
		values = append(values, list...)
	case []any:
		for _, item := range list {
			if id := stringValue(item); id != "" {
				values = append(values, id)
			}
		}
	default:
		if item, ok := value.(string); ok {
			values = append(values, item)
		}
	}
	set := map[string]struct{}{}
	for _, raw := range values {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		set[id] = struct{}{}
		if len(id) > 0 && id[0] != '-' {
			set["-100"+id] = struct{}{}
			set["-"+id] = struct{}{}
		}
	}
	result := make([]string, 0, len(set))
	for id := range set {
		result = append(result, id)
	}
	return result
}

func containsChat(values []string, id string) bool {
	for _, value := range values {
		if value == id {
			return true
		}
	}
	return false
}

func parseTime(value any) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, stringValue(value))
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func nullableTime(value time.Time, ok bool) any {
	if !ok {
		return nil
	}
	return store.ISO(value)
}

func nullableInt64(value int64, ok bool) any {
	if !ok {
		return nil
	}
	return strconv.FormatInt(value, 10)
}
func nullableString(value string, ok bool) any {
	if !ok {
		return nil
	}
	return value
}

func object(value any) map[string]any {
	if doc, ok := value.(map[string]any); ok {
		return doc
	}
	if doc, ok := value.(store.Document); ok {
		return map[string]any(doc)
	}
	return map[string]any{}
}

func int64Value(value any) int64 {
	switch item := value.(type) {
	case int64:
		return item
	case int:
		return int64(item)
	case float64:
		return int64(item)
	case json.Number:
		parsed, _ := item.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(item, 10, 64)
		return parsed
	}
	return 0
}
func floatValue(value any) float64 {
	switch item := value.(type) {
	case float64:
		return item
	case int:
		return float64(item)
	case json.Number:
		parsed, _ := item.Float64()
		return parsed
	}
	return 0
}
func floatSlice(value any) []float64 {
	var list []float64
	switch values := value.(type) {
	case []float64:
		return values
	case []any:
		for _, item := range values {
			list = append(list, floatValue(item))
		}
	}
	return list
}
