package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestTypeScriptGoldenCorpus(t *testing.T) {
	path := filepath.Join("..", "..", "migration", "fixtures", "domain-golden.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var corpus map[string]json.RawMessage
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, category := range []string{"parser", "cancel", "profiles", "safety", "entry", "sizing", "checkpoints", "lifecycle"} {
		t.Run(category, func(t *testing.T) {
			var cases []map[string]any
			if err := json.Unmarshal(corpus[category], &cases); err != nil {
				t.Fatal(err)
			}
			for i, testCase := range cases {
				got, err := runGoldenCase(category, testCase)
				if err != nil {
					t.Fatalf("case %d: %v", i, err)
				}
				want := testCase["expected"]
				gotJSON, err := canonicalJSON(got)
				if err != nil {
					t.Fatalf("case %d encode actual: %v", i, err)
				}
				wantJSON, err := canonicalJSON(want)
				if err != nil {
					t.Fatalf("case %d encode expected: %v", i, err)
				}
				var gotCanonical, wantCanonical bytes.Buffer
				if err := json.Compact(&gotCanonical, gotJSON); err != nil {
					t.Fatal(err)
				}
				if err := json.Compact(&wantCanonical, wantJSON); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(gotCanonical.Bytes(), wantCanonical.Bytes()) {
					t.Errorf("case %d mismatch\n got: %s\nwant: %s", i, gotCanonical.String(), wantCanonical.String())
				}
			}
		})
	}
}

func canonicalJSON(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
}

func runGoldenCase(category string, input map[string]any) (any, error) {
	decode := func(value any, target any) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return json.Unmarshal(data, target)
	}
	number := func(value any) float64 { n, _ := value.(float64); return n }
	text := func(value any) string { s, _ := value.(string); return s }
	switch category {
	case "parser":
		return ParseGoldSignal(text(input["input"])), nil
	case "cancel":
		return DetectCancelIntent(text(input["input"])), nil
	case "profiles":
		return ValidateProfile(input["input"]), nil
	case "safety":
		return ValidateSafetyLimits(input["input"]), nil
	case "entry":
		var signal Signal
		var config EntryConfig
		if err := decode(input["signal"], &signal); err != nil {
			return nil, err
		}
		if err := decode(input["config"], &config); err != nil {
			return nil, err
		}
		return DecideEntry(signal, number(input["bid"]), number(input["ask"]), config), nil
	case "sizing":
		var sizing SizingConfig
		var spec SizingSpec
		var limits EffectiveLimits
		if err := decode(input["sizing"], &sizing); err != nil {
			return nil, err
		}
		if err := decode(input["spec"], &spec); err != nil {
			return nil, err
		}
		if err := decode(input["limits"], &limits); err != nil {
			return nil, err
		}
		return ComputeVolume(sizing, number(input["entryPrice"]), number(input["stopLoss"]), number(input["equity"]), spec, limits), nil
	case "checkpoints":
		var cfg TakeProfitConfig
		var spec SizingSpec
		var tps []float64
		if err := decode(input["takeProfit"], &cfg); err != nil {
			return nil, err
		}
		if err := decode(input["spec"], &spec); err != nil {
			return nil, err
		}
		if err := decode(input["takeProfits"], &tps); err != nil {
			return nil, err
		}
		return PlanCheckpoints(number(input["totalVolume"]), Direction(text(input["direction"])), number(input["entryPrice"]), tps, cfg, spec), nil
	case "lifecycle":
		args, ok := input["args"].([]any)
		if !ok {
			return nil, fmt.Errorf("lifecycle args have type %T", input["args"])
		}
		switch text(input["kind"]) {
		case "checkpointAction":
			if len(args) != 6 {
				return nil, fmt.Errorf("checkpointAction has %d args", len(args))
			}
			var cp CheckpointState
			if err := decode(args[0], &cp); err != nil {
				return nil, err
			}
			return CheckpointDecision(cp, number(args[1]), number(args[2]), Direction(text(args[3])), int64(number(args[4])), number(args[5])), nil
		case "closeVolumeFor":
			if len(args) != 3 {
				return nil, fmt.Errorf("closeVolumeFor has %d args", len(args))
			}
			volume, full := CloseVolumeFor(number(args[0]), number(args[1]), number(args[2]))
			return map[string]any{"volume": volume, "full": full}, nil
		case "desiredStopLoss":
			if len(args) != 1 {
				return nil, fmt.Errorf("desiredStopLoss has %d args", len(args))
			}
			var stopInput StopLossInput
			if err := decode(args[0], &stopInput); err != nil {
				return nil, err
			}
			return DesiredStopLoss(stopInput), nil
		default:
			return nil, fmt.Errorf("unknown lifecycle kind %q", input["kind"])
		}
	default:
		return nil, fmt.Errorf("unknown category %q", category)
	}
}
