// Isolated, read-only validation of research drafts against a COPY of the live Go domain package.
// usage: vp DRAFT_JSON [TEXT_FILE...]  (text files: messages to run through domain.ParseGoldSignal)
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/bytrader/bytrader/internal/domain"
)

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		panic(err)
	}
	m["version"] = 1.0
	stripped := domain.StripProfileEnvelope(m)
	_, hadRec := m["recommendations"]
	_, keptRec := stripped["recommendations"]
	fmt.Printf("StripProfileEnvelope: recommendations present before=%v after=%v\n", hadRec, keptRec)
	for _, in := range []struct {
		label string
		v     map[string]any
	}{{"as stored (+version)", m}, {"envelope stripped (+version)", stripped}} {
		r := domain.ValidateProfile(in.v)
		fmt.Printf("ValidateProfile[%s]: ok=%v errors=%d warnings=%d\n", in.label, r.OK, len(r.Errors), len(r.Warnings))
		for _, e := range r.Errors {
			fmt.Printf("  - error %s: %s\n", e.Path, e.Message)
		}
		for _, e := range r.Warnings {
			fmt.Printf("  - warning %s: %s\n", e.Path, e.Message)
		}
		if r.OK {
			for _, s := range []struct {
				label string
				lim   domain.SafetyLimits
			}{{"DefaultSafetyLimits", domain.DefaultSafetyLimits}, {"Default with max_spread_price=1.0", func() domain.SafetyLimits { x := domain.DefaultSafetyLimits; x.MaxSpreadPrice = 1.0; return x }()}} {
				iss := domain.ValidateProfileAgainstSafety(*r.Value, s.lim)
				fmt.Printf("  ValidateProfileAgainstSafety vs %s: %d issue(s)\n", s.label, len(iss))
				for _, e := range iss {
					fmt.Printf("    - %s: %s\n", e.Path, e.Message)
				}
			}
			bs, ok := domain.ResolveBrokerSymbol(*r.Value, "XAUUSD")
			fmt.Printf("  ResolveBrokerSymbol(XAUUSD) -> %q ok=%v\n", bs, ok)
		}
	}
	for _, f := range os.Args[2:] {
		t, _ := os.ReadFile(f)
		p := domain.ParseGoldSignal(string(t))
		b, _ := json.Marshal(p)
		fmt.Printf("ParseGoldSignal(%s) -> %s\n", f, b)
	}
}
