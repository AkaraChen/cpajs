//go:build !windows

// cpa-launcher starts a program (CLIProxyAPI) so that it does not outlive the
// process that launched it, using operating system facilities only.
//
//	cpa-launcher [--supervise] [--watch-stdin] [--grace=10s] -- <program> [args...]
//
// Default (Linux): set PR_SET_PDEATHSIG to SIGTERM and exec the program, so the
// kernel signals it when the launching process dies, however it dies. No extra
// process stays around.
//
// --supervise (macOS, BSD, or where exec mode is unavailable): run the program
// as a child, forward termination signals to it, and relay its exit status.
// With --watch-stdin, the launcher treats EOF on stdin as the launching process
// having died (its end of the pipe closed) and stops the program: SIGTERM, then
// SIGKILL after the grace period.
//
// CPAJS_PARENT_PID, when set, is the pid of the launching process; exec mode
// uses it to detect a parent that died before PR_SET_PDEATHSIG was in place.
package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

const parentPIDEnv = "CPAJS_PARENT_PID"

func main() {
	supervise, watchStdin, grace := false, false, 10*time.Second
	args := os.Args[1:]
	for len(args) > 0 && args[0] != "--" {
		arg := args[0]
		switch {
		case arg == "--supervise":
			supervise = true
		case arg == "--watch-stdin":
			watchStdin = true
		case strings.HasPrefix(arg, "--grace="):
			d, err := time.ParseDuration(strings.TrimPrefix(arg, "--grace="))
			if err != nil || d < 0 {
				fail("invalid --grace: %s", arg)
			}
			grace = d
		default:
			fail("unknown option %q", arg)
		}
		args = args[1:]
	}
	if len(args) < 2 {
		fail("usage: cpa-launcher [--supervise] [--watch-stdin] [--grace=10s] -- <program> [args...]")
	}
	program, programArgs := args[1], args[2:]

	if !supervise {
		// Only returns when exec mode is unavailable on this OS or the exec failed.
		if err := execWithParentDeathSignal(program, programArgs); err != errUnsupported {
			fail("exec %s: %v", program, err)
		}
	}
	os.Exit(runSupervised(program, programArgs, watchStdin, grace))
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "cpa-launcher: "+format+"\n", args...)
	os.Exit(127)
}

// environ returns the environment for the program, without launcher variables.
func environ() []string {
	env := os.Environ()
	out := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, parentPIDEnv+"=") {
			out = append(out, kv)
		}
	}
	return out
}
