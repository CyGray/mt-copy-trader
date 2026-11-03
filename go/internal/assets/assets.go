package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var bundled embed.FS

func FS() fs.FS {
	files, err := fs.Sub(bundled, "dist")
	if err != nil {
		return emptyFS{}
	}
	return files
}

type emptyFS struct{}

func (emptyFS) Open(string) (fs.File, error) { return nil, fs.ErrNotExist }
