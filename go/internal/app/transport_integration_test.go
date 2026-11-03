package app

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/bytrader/bytrader/internal/bridge"
	"github.com/bytrader/bytrader/internal/broker"
)

// This peer is native libzmq, bound only to a random loopback port; it is not MT5.
const nativeREP = `
import json,sys,time,zmq
context=zmq.Context()
socket=context.socket(zmq.REP)
socket.setsockopt(zmq.LINGER,0)
socket.setsockopt(zmq.RCVTIMEO,5000)
socket.bind('tcp://127.0.0.1:*')
print(socket.getsockopt(zmq.LAST_ENDPOINT).decode(),flush=True)
requests=0
mutations=0
scenario=sys.argv[1]
while True:
    request=socket.recv_json()
    requests+=1
    if request['v']!=2: raise Exception('protocol version')
    if request['action'] in ['ORDER_SEND','CLOSE_POSITION']:
        assert request['expires_at']>int(time.time())
        mutations+=1
    reply={'ok':True,'retcode':0,'request_id':request['request_id'],'data':{'requests':requests,'mutations':mutations}}
    if scenario=='return-only':
        if request['action']=='PING': reply['data'].update(server_time=int(time.time()),gmt_time=int(time.time()),server_time_source='TimeTradeServer')
        if request['action']=='SYMBOL_INFO': reply['data'].update(symbol='XAUUSD',filling_fok=False,filling_ioc=False)
        if request['action']=='GET_POSITIONS': reply['data']['positions']=[{'ticket':91,'identifier':191,'symbol':'XAUUSD','volume':.03,'magic':98801,'type':'BUY','comment':'BT-offline-only'}]
    if scenario=='wrong-first' and requests==1: reply['request_id']='wrong'
    if scenario=='lost-mutation' and request['action']=='ORDER_SEND': time.sleep(.35)
    if scenario=='reject': reply.update(ok=False,retcode=5004,error='invalid volume')
    if scenario=='malformed': socket.send(b'{bad')
    else: socket.send_json(reply)
`

func nativePeer(t testing.TB, scenario string) string {
	t.Helper()
	if os.Getenv("BYTRADER_NATIVE_ZMQ_TEST") != "1" {
		t.Skip("opt-in native loopback transport check")
	}
	cmd := exec.Command("python3", "-u", "-c", nativeREP, scenario)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	reader := bufio.NewReader(stdout)
	line := make(chan string, 1)
	go func() { value, _ := reader.ReadString('\n'); line <- strings.TrimSpace(value) }()
	select {
	case endpoint := <-line:
		if !strings.HasPrefix(endpoint, "tcp://127.0.0.1:") {
			t.Fatalf("native peer failed: %q", endpoint)
		}
		return endpoint
	case <-time.After(5 * time.Second):
		t.Fatal("native peer did not start")
	}
	return ""
}

func TestNativeOutageResources(t *testing.T) {
	if os.Getenv("BYTRADER_NATIVE_ZMQ_TEST") != "1" {
		t.Skip("opt-in isolated loopback outage probe")
	}
	client := bridge.NewClient(bridge.ClientConfig{Endpoint: "tcp://127.0.0.1:1", Timeout: 10 * time.Millisecond})
	countFD := func() int {
		entries, err := os.ReadDir("/proc/self/fd")
		if err != nil {
			t.Fatal(err)
		}
		return len(entries)
	}
	for i := 0; i < 5; i++ {
		_, _ = client.Do(context.Background(), "PING", nil)
	}
	time.Sleep(100 * time.Millisecond)
	initial, initialGoroutines := countFD(), runtime.NumGoroutine()
	peak := initial
	const cases = 1000
	for i := 0; i < cases; i++ {
		if _, err := client.Do(context.Background(), "PING", nil); err == nil {
			t.Fatal("unused port unexpectedly replied")
		}
		if current := countFD(); current > peak {
			peak = current
		}
	}
	time.Sleep(200 * time.Millisecond)
	final, goroutines := countFD(), runtime.NumGoroutine()
	t.Logf("offline cases=%d initial_fds=%d peak_fds=%d final_fds=%d initial_goroutines=%d final_goroutines=%d", cases, initial, peak, final, initialGoroutines, goroutines)
	if peak > initial+8 || final > initial+4 || goroutines > initialGoroutines+5 {
		t.Fatal("transport resources grew after bounded outages")
	}
}

func BenchmarkNativeBridgeRead(b *testing.B) {
	client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(b, "normal"), Timeout: time.Second})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := client.Do(context.Background(), "PING", nil); err != nil {
			b.Fatal(err)
		}
	}
}

func TestNativeZeroMQInteroperability(t *testing.T) {
	ctx := context.Background()
	t.Run("return-only-market-and-close-no-handoff", func(t *testing.T) {
		client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(t, "return-only"), Timeout: time.Second})
		adapter, err := bridge.NewMT5Broker(bridge.MT5BrokerOptions{Magic: 98801, Client: client})
		if err != nil {
			t.Fatal(err)
		}
		_, err = adapter.PlaceOrder(ctx, broker.PlaceOrderRequest{Symbol: "XAUUSD", OrderType: broker.MarketBuy, Volume: .01, SL: 1990, TP: 2010, Comment: "BT-offline-only"})
		var rejected *broker.RejectedError
		if !errors.As(err, &rejected) {
			t.Fatalf("RETURN-only market entry was not rejected before handoff: %v", err)
		}
		volume := .01
		_, err = adapter.ClosePosition(ctx, 91, &volume)
		if !errors.As(err, &rejected) {
			t.Fatalf("RETURN-only close was not rejected before handoff: %v", err)
		}
		stats, err := client.Do(ctx, "PING", nil)
		if err != nil || stats["mutations"] != float64(0) {
			t.Fatalf("unsupported fill policy reached native mutation handoff: %v %v", stats, err)
		}
	})
	t.Run("correlation-read-retry", func(t *testing.T) {
		client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(t, "wrong-first"), Timeout: time.Second})
		data, err := client.Do(ctx, "PING", nil)
		if err != nil {
			t.Fatal(err)
		}
		if data["requests"] != float64(2) {
			t.Fatalf("read retry count: %v", data)
		}
	})
	t.Run("external-success-lost-reply-no-resubmit", func(t *testing.T) {
		client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(t, "lost-mutation"), Timeout: 100 * time.Millisecond})
		_, err := client.Do(ctx, "ORDER_SEND", map[string]any{"comment": "BT-offline-only"})
		var unknown *bridge.AmbiguousError
		if !errors.As(err, &unknown) || unknown.RequestID == "" || unknown.ExpiresAt == 0 {
			t.Fatalf("expected correlated ambiguity, got %v", err)
		}
		time.Sleep(400 * time.Millisecond)
		data, err := client.Do(ctx, "GET_POSITIONS", nil)
		if err != nil {
			t.Fatal(err)
		}
		if data["requests"] != float64(2) || data["mutations"] != float64(1) {
			t.Fatalf("mutation was resubmitted: %v", data)
		}
	})
	t.Run("definite-retcode", func(t *testing.T) {
		client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(t, "reject"), Timeout: time.Second})
		_, err := client.Do(ctx, "ORDER_SEND", nil)
		var rejected *bridge.BridgeError
		if !errors.As(err, &rejected) || rejected.Retcode != 5004 {
			t.Fatalf("retcode lost: %v", err)
		}
	})
	t.Run("malformed-reply-bounded", func(t *testing.T) {
		client := bridge.NewClient(bridge.ClientConfig{Endpoint: nativePeer(t, "malformed"), Timeout: 100 * time.Millisecond})
		started := time.Now()
		if _, err := client.Do(ctx, "PING", nil); err == nil {
			t.Fatal("malformed reply accepted")
		}
		if time.Since(started) > 2*time.Second {
			t.Fatal("unbounded transport retry")
		}
	})
}
