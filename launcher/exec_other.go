//go:build !linux && !windows

package main

import "errors"

var errUnsupported = errors.New("exec mode is not supported on this platform")

// execWithParentDeathSignal is Linux-only; other systems use supervise mode.
func execWithParentDeathSignal(string, []string) error { return errUnsupported }
