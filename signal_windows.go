//go:build windows

package main

import (
	"os"
	"os/signal"
)

func setupSignalHandler() chan os.Signal {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt)
	return sigChan
}
