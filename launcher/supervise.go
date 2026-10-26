//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// runSupervised runs the program as a child and returns the exit code to use.
// If the child is killed by a signal, the launcher re-raises that signal on
// itself so the launching process sees the same outcome.
func runSupervised(program string, args []string, watchStdin bool, grace time.Duration) int {
	cmd := exec.Command(program, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr // no stdin: it is the launcher's liveness pipe
	cmd.Env = environ()
	if err := cmd.Start(); err != nil {
		fail("start %s: %v", program, err)
	}

	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)

	var parentGone <-chan struct{}
	if watchStdin {
		closed := make(chan struct{})
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			close(closed)
		}()
		parentGone = closed
	}

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()

	var killTimer <-chan time.Time
	for {
		select {
		case sig := <-signals:
			_ = cmd.Process.Signal(sig)
		case <-parentGone:
			parentGone = nil
			_ = cmd.Process.Signal(syscall.SIGTERM)
			killTimer = time.After(grace)
		case <-killTimer:
			_ = cmd.Process.Kill()
		case <-done:
			return exitCode(cmd.ProcessState)
		}
	}
}

func exitCode(state *os.ProcessState) int {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		sig := status.Signal()
		signal.Reset(sig)
		_ = syscall.Kill(os.Getpid(), sig)
		time.Sleep(100 * time.Millisecond) // the signal normally ends the process here
		return 128 + int(sig)
	}
	return state.ExitCode()
}
