# Validating a draft against the live Go validator (isolated copy)

The live executor is Go (`/home/kyle/services/bytrader-go`). Its `internal/domain` package (profile validation,
parser) imports only the standard library and `internal/broker`, so a copy of the two packages is enough.
Nothing under `/home/kyle/services` is written: the copy, the build cache and the temp dir live in the scratch
directory.

```
G=/tmp/<scratch>/gocheck; S=/home/kyle/services/bytrader-go/src
mkdir -p $G/internal/domain $G/internal/broker $G/cmd/vp $G/cache $G/tmp
for f in $S/internal/domain/*.go $S/internal/broker/*.go; do case $f in *_test.go) ;; *) cp $f $G/${f#$S/};; esac; done
printf 'module github.com/bytrader/bytrader\n\ngo 1.27.0\n' > $G/go.mod
cp main.go $G/cmd/vp/main.go
cd $G && GOTOOLCHAIN=local GOCACHE=$G/cache GOPATH=$G/gopath GOPROXY=off GOFLAGS=-mod=mod GOTMPDIR=$G/tmp \
  /home/kyle/services/bytrader-go/toolchain/go/bin/go run ./cmd/vp <draft.json> [message_text_file ...]
```

The text files (optional) are run through `domain.ParseGoldSignal`, the live parser. Keep them in the scratch
directory: they hold raw message text.
