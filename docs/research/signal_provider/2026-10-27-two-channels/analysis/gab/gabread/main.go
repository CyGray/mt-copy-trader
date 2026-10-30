// gabread: read-only Telegram history reader for one research study.
//
// Uses its OWN session file (never the forwarder's), refuses every API method
// that is not on a read-only allowlist, never sends, joins, leaves, marks read
// or edits anything. API id/hash are read from the env file and never printed.
//
//	gabread login                      interactive (run by the owner in a terminal)
//	gabread status
//	gabread fetch <channel_id> <outdir>
//	gabread logout                     revokes this tool's own session only
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/query/dialogs"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

const sessionPath = "/tmp/claude-1001/twochan/gab/session/session.json"
const envPath = "/home/kyle/.config/bytrader-go/web.env"

var allowed = map[string]bool{
	"auth.sendCode": true, "auth.signIn": true, "account.getPassword": true,
	"auth.checkPassword": true, "auth.logOut": true, "users.getUsers": true,
	"help.getConfig": true, "messages.getDialogs": true, "messages.getPinnedDialogs": true,
	"channels.getFullChannel": true, "messages.getHistory": true, "channels.getChannels": true,
	"updates.getState": true,
}

func readOnlyGuard() telegram.Middleware {
	return telegram.MiddlewareFunc(func(next tg.Invoker) telegram.InvokeFunc {
		return func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
			name := "?"
			if t, ok := input.(interface{ TypeName() string }); ok {
				name = t.TypeName()
			}
			if !allowed[name] {
				return fmt.Errorf("gabread guard: refused non-allowlisted method %q", name)
			}
			return next.Invoke(ctx, input, output)
		}
	})
}

func apiCreds() (int, string, error) {
	f, err := os.Open(envPath)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	var id int
	var hash string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "TELEGRAM_API_ID":
			id, _ = strconv.Atoi(v)
		case "TELEGRAM_API_HASH":
			hash = v
		}
	}
	if id == 0 || hash == "" {
		return 0, "", errors.New("api credentials missing in env file")
	}
	return id, hash, nil
}

func newClient() (*telegram.Client, error) {
	id, hash, err := apiCreds()
	if err != nil {
		return nil, err
	}
	return telegram.NewClient(id, hash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: sessionPath},
		Middlewares:    []telegram.Middleware{readOnlyGuard()},
		Device:         telegram.DeviceConfig{DeviceModel: "ByTrader research reader", SystemVersion: "linux", AppVersion: "gabread 1"},
	}), nil
}

type term struct{ in *bufio.Reader }

func (t term) line(prompt string) (string, error) {
	fmt.Print(prompt)
	s, err := t.in.ReadString('\n')
	return strings.TrimSpace(s), err
}
func (t term) Phone(context.Context) (string, error) { return t.line("Phone (international, +...): ") }
func (t term) Code(context.Context, *tg.AuthSentCode) (string, error) {
	return t.line("Login code from Telegram: ")
}
func (t term) Password(context.Context) (string, error) {
	_ = exec.Command("stty", "-F", "/dev/tty", "-echo").Run()
	defer func() { _ = exec.Command("stty", "-F", "/dev/tty", "echo").Run(); fmt.Println() }()
	return t.line("2FA cloud password (hidden): ")
}
func (t term) AcceptTermsOfService(context.Context, tg.HelpTermsOfService) error {
	return errors.New("terms of service prompt: refusing (account sign-up is not supported)")
}
func (t term) SignUp(context.Context) (auth.UserInfo, error) {
	return auth.UserInfo{}, errors.New("sign-up refused: log in with the existing account")
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: gabread login|status|fetch <channel_id> <outdir>|logout")
		os.Exit(2)
	}
	client, err := newClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	ctx := context.Background()
	err = client.Run(ctx, func(ctx context.Context) error {
		switch os.Args[1] {
		case "login":
			flow := auth.NewFlow(term{bufio.NewReader(os.Stdin)}, auth.SendCodeOptions{})
			if err := client.Auth().IfNecessary(ctx, flow); err != nil {
				return err
			}
			_ = os.Chmod(sessionPath, 0o600)
			fmt.Println("Logged in. Session stored for the research reader only.")
			return nil
		case "status":
			st, err := client.Auth().Status(ctx)
			if err != nil {
				return err
			}
			fmt.Println("authorized:", st.Authorized)
			return nil
		case "logout":
			_, err := client.API().AuthLogOut(ctx)
			if err == nil {
				_ = os.Remove(sessionPath)
				fmt.Println("research session revoked and file removed")
			}
			return err
		case "fetch":
			if len(os.Args) < 4 {
				return errors.New("fetch needs <channel_id> <outdir>")
			}
			cid, err := strconv.ParseInt(strings.TrimPrefix(os.Args[2], "-100"), 10, 64)
			if err != nil {
				return err
			}
			return fetch(ctx, client.API(), cid, os.Args[3])
		}
		return errors.New("unknown command")
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func retry[T any](ctx context.Context, f func() (T, error)) (T, error) {
	for {
		v, err := f()
		if err == nil {
			return v, nil
		}
		if ok, _ := tgerr.FloodWait(ctx, err); ok {
			continue
		}
		return v, err
	}
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

type entityOut struct {
	Kind, Title, Username string
	ID                    int64
	Broadcast, Megagroup  bool
	Verified, Scam, Fake  bool
	Bot                   bool
}

func collectEntities(m map[int64]entityOut, chats []tg.ChatClass, users []tg.UserClass) {
	for _, c := range chats {
		switch c := c.(type) {
		case *tg.Channel:
			m[c.ID] = entityOut{Kind: "channel", ID: c.ID, Title: c.Title, Username: c.Username, Broadcast: c.Broadcast, Megagroup: c.Megagroup, Verified: c.Verified, Scam: c.Scam, Fake: c.Fake}
		case *tg.ChannelForbidden:
			m[c.ID] = entityOut{Kind: "channel_forbidden", ID: c.ID, Title: c.Title}
		case *tg.Chat:
			m[c.ID] = entityOut{Kind: "chat", ID: c.ID, Title: c.Title}
		}
	}
	for _, u := range users {
		if u, ok := u.(*tg.User); ok {
			m[u.ID] = entityOut{Kind: "user", ID: u.ID, Title: strings.TrimSpace(u.FirstName + " " + u.LastName), Username: u.Username, Bot: u.Bot, Verified: u.Verified, Scam: u.Scam, Fake: u.Fake}
		}
	}
}

type msgOut struct {
	ID          int
	Date        int
	EditDate    int    `json:",omitempty"`
	Kind        string // message | service
	Text        string `json:",omitempty"`
	MediaType   string `json:",omitempty"`
	EntityTypes []string `json:",omitempty"`
	URLs        []string `json:",omitempty"`
	Mentions    []string `json:",omitempty"`
	Buttons     []string `json:",omitempty"`
	Views       int      `json:",omitempty"`
	Forwards    int      `json:",omitempty"`
	Replies     int      `json:",omitempty"`
	Reactions   map[string]int `json:",omitempty"`
	PostAuthor  string `json:",omitempty"`
	GroupedID   int64  `json:",omitempty"`
	Pinned      bool   `json:",omitempty"`
	NoForwards  bool   `json:",omitempty"`
	ReplyTo     int    `json:",omitempty"`
	FromID      string `json:",omitempty"`
	Fwd         any    `json:",omitempty"`
	Action      string `json:",omitempty"`
	Raw         any
}

func peerStr(p tg.PeerClass) string {
	switch p := p.(type) {
	case *tg.PeerChannel:
		return fmt.Sprintf("channel:%d", p.ChannelID)
	case *tg.PeerUser:
		return fmt.Sprintf("user:%d", p.UserID)
	case *tg.PeerChat:
		return fmt.Sprintf("chat:%d", p.ChatID)
	}
	return ""
}

func convert(m tg.MessageClass) msgOut {
	switch m := m.(type) {
	case *tg.Message:
		o := msgOut{ID: m.ID, Date: m.Date, Kind: "message", Text: m.Message, Views: m.Views, Forwards: m.Forwards,
			PostAuthor: m.PostAuthor, GroupedID: m.GroupedID, Pinned: m.Pinned, NoForwards: m.Noforwards, Raw: m}
		if d, ok := m.GetEditDate(); ok {
			o.EditDate = d
		}
		if m.Media != nil {
			o.MediaType = m.Media.TypeName()
			if wp, ok := m.Media.(*tg.MessageMediaWebPage); ok {
				if p, ok := wp.Webpage.(*tg.WebPage); ok {
					o.URLs = append(o.URLs, p.URL)
				}
			}
		}
		runes := []rune(m.Message)
		_ = runes
		for _, e := range m.Entities {
			o.EntityTypes = append(o.EntityTypes, e.TypeName())
			switch e := e.(type) {
			case *tg.MessageEntityTextURL:
				o.URLs = append(o.URLs, e.URL)
			case *tg.MessageEntityURL, *tg.MessageEntityMention:
				off, ln := e.GetOffset(), e.GetLength()
				s := utf16Slice(m.Message, off, ln)
				if _, isMention := e.(*tg.MessageEntityMention); isMention {
					o.Mentions = append(o.Mentions, s)
				} else {
					o.URLs = append(o.URLs, s)
				}
			}
		}
		if rm, ok := m.ReplyMarkup.(*tg.ReplyInlineMarkup); ok {
			for _, row := range rm.Rows {
				for _, b := range row.Buttons {
					desc := b.Text + " [" + typeName(b.Type) + "]"
					if u, ok := b.Type.(*tg.InlineButtonTypeURL); ok {
						desc = b.Text + " -> " + u.URL
					}
					o.Buttons = append(o.Buttons, desc)
				}
			}
		}
		if r, ok := m.GetReplies(); ok {
			o.Replies = r.Replies
		}
		if rs, ok := m.GetReactions(); ok {
			o.Reactions = map[string]int{}
			for _, rc := range rs.Results {
				key := rc.Reaction.TypeName()
				if e, ok := rc.Reaction.(*tg.ReactionEmoji); ok {
					key = e.Emoticon
				}
				o.Reactions[key] += rc.Count
			}
		}
		if rt, ok := m.ReplyTo.(*tg.MessageReplyHeader); ok {
			o.ReplyTo = rt.ReplyToMsgID
		}
		if m.FromID != nil {
			o.FromID = peerStr(m.FromID)
		}
		if f, ok := m.GetFwdFrom(); ok {
			fw := map[string]any{"date": f.Date, "from_name": f.FromName, "channel_post": f.ChannelPost, "post_author": f.PostAuthor}
			if f.FromID != nil {
				fw["from"] = peerStr(f.FromID)
			}
			if f.SavedFromPeer != nil {
				fw["saved_from"] = peerStr(f.SavedFromPeer)
				fw["saved_from_msg"] = f.SavedFromMsgID
			}
			o.Fwd = fw
		}
		return o
	case *tg.MessageService:
		return msgOut{ID: m.ID, Date: m.Date, Kind: "service", Action: m.Action.TypeName(), Raw: m}
	case *tg.MessageEmpty:
		return msgOut{ID: m.ID, Kind: "empty"}
	}
	return msgOut{Kind: "unknown"}
}

func utf16Slice(s string, off, ln int) string {
	u := []uint16{}
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			u = append(u, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			u = append(u, uint16(r))
		}
	}
	if off < 0 || off+ln > len(u) {
		return ""
	}
	seg := u[off : off+ln]
	out := []rune{}
	for i := 0; i < len(seg); i++ {
		c := rune(seg[i])
		if c >= 0xD800 && c < 0xDC00 && i+1 < len(seg) {
			c = 0x10000 + (c-0xD800)<<10 + (rune(seg[i+1]) - 0xDC00)
			i++
		}
		out = append(out, c)
	}
	return string(out)
}

func history(ctx context.Context, api *tg.Client, peer tg.InputPeerClass, ents map[int64]entityOut) ([]msgOut, int, error) {
	var out []msgOut
	offset, total := 0, 0
	for {
		res, err := retry(ctx, func() (tg.MessagesMessagesClass, error) {
			return api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: peer, OffsetID: offset, Limit: 100})
		})
		if err != nil {
			return out, total, err
		}
		var msgs []tg.MessageClass
		switch r := res.(type) {
		case *tg.MessagesChannelMessages:
			msgs, total = r.Messages, r.Count
			collectEntities(ents, r.Chats, r.Users)
		case *tg.MessagesMessagesSlice:
			msgs, total = r.Messages, r.Count
			collectEntities(ents, r.Chats, r.Users)
		case *tg.MessagesMessages:
			msgs, total = r.Messages, len(r.Messages)
			collectEntities(ents, r.Chats, r.Users)
		default:
			return out, total, fmt.Errorf("unexpected history type %T", res)
		}
		if len(msgs) == 0 {
			return out, total, nil
		}
		for _, m := range msgs {
			o := convert(m)
			out = append(out, o)
			if offset == 0 || o.ID < offset {
				offset = o.ID
			}
		}
		fmt.Fprintf(os.Stderr, "  fetched %d (oldest id %d, server count %d)\n", len(out), offset, total)
		if offset <= 1 {
			return out, total, nil
		}
		time.Sleep(700 * time.Millisecond)
	}
}

func fetch(ctx context.Context, api *tg.Client, channelID int64, outdir string) error {
	if err := os.MkdirAll(outdir, 0o700); err != nil {
		return err
	}
	var target *tg.InputPeerChannel
	var dialogTitle string
	err := dialogs.NewQueryBuilder(api).GetDialogs().BatchSize(100).ForEach(ctx, func(ctx context.Context, e dialogs.Elem) error {
		if p, ok := e.Peer.(*tg.InputPeerChannel); ok && p.ChannelID == channelID {
			target = p
			if ch, ok := e.Entities.Channel(channelID); ok {
				dialogTitle = ch.Title
			}
			return errors.New("found")
		}
		return nil
	})
	if target == nil {
		if err != nil {
			return err
		}
		return fmt.Errorf("channel %d not in this account's dialogs", channelID)
	}
	fmt.Fprintf(os.Stderr, "found channel %d (%q)\n", channelID, dialogTitle)
	ents := map[int64]entityOut{}
	full, err := retry(ctx, func() (*tg.MessagesChatFull, error) {
		return api.ChannelsGetFullChannel(ctx, &tg.InputChannel{ChannelID: target.ChannelID, AccessHash: target.AccessHash})
	})
	if err != nil {
		return fmt.Errorf("getFullChannel: %w", err)
	}
	collectEntities(ents, full.Chats, full.Users)
	if err := writeJSON(filepath.Join(outdir, "full_channel.json"), full.FullChat); err != nil {
		return err
	}
	msgs, total, err := history(ctx, api, target, ents)
	if err != nil {
		return fmt.Errorf("history: %w", err)
	}
	if err := writeJSON(filepath.Join(outdir, "messages.json"), msgs); err != nil {
		return err
	}
	meta := map[string]any{"channel_id": channelID, "fetched_at": time.Now().UTC().Format(time.RFC3339), "server_count": total, "returned": len(msgs)}
	if cf, ok := full.FullChat.(*tg.ChannelFull); ok {
		if linked, ok := cf.GetLinkedChatID(); ok && linked != 0 {
			meta["linked_chat_id"] = linked
			for _, c := range full.Chats {
				if ch, ok := c.(*tg.Channel); ok && ch.ID == linked {
					lm, lt, err := history(ctx, api, &tg.InputPeerChannel{ChannelID: ch.ID, AccessHash: ch.AccessHash}, ents)
					if err != nil {
						meta["linked_error"] = err.Error()
					}
					meta["linked_server_count"], meta["linked_returned"] = lt, len(lm)
					if err := writeJSON(filepath.Join(outdir, "linked_messages.json"), lm); err != nil {
						return err
					}
				}
			}
		}
	}
	if err := writeJSON(filepath.Join(outdir, "entities.json"), ents); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(outdir, "meta.json"), meta); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "done: %v\n", meta)
	return nil
}

func typeName(v any) string {
	if t, ok := v.(interface{ TypeName() string }); ok {
		return t.TypeName()
	}
	return fmt.Sprintf("%T", v)
}
