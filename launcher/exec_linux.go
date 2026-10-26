//go:build linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
)

var errUnsupported = errors.New("exec mode is not supported on this platform")

const prSetPdeathsig = 1 // PR_SET_PDEATHSIG from <linux/prctl.h>

// execWithParentDeathSignal makes the kernel send SIGTERM to this process when
// its parent dies, then replaces this process with the program. The setting
// survives execve (it is only cleared for set-user-ID binaries), so the program
// itself receives the signal.
func execWithParentDeathSignal(program string, args []string) error {
	path, err := exec.LookPath(program)
	if err != nil {
		return err
	}
	// The death signal belongs to the calling thread; exec from the same one.
	runtime.LockOSThread()
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetPdeathsig, uintptr(syscall.SIGTERM), 0); errno != 0 {
		return errno
	}
	// If the parent died before prctl took effect, no signal will ever come.
	if expected := os.Getenv(parentPIDEnv); expected != "" && strconv.Itoa(os.Getppid()) != expected {
		os.Exit(1)
	}
	return syscall.Exec(path, append([]string{program}, args...), environ())
}
