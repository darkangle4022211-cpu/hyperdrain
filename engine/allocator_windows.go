//go:build windows

package engine

import (
	"os"
	"syscall"
	"unsafe"
)

// PreallocateFile on Windows sets file length to reserve space.
func PreallocateFile(file *os.File, size int64) error {
	if size <= 0 {
		return nil
	}
	return file.Truncate(size)
}

// GetDiskFreeSpace returns available free disk space on Windows using GetDiskFreeSpaceExW.
func GetDiskFreeSpace(path string) (uint64, error) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}

	var freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes int64
	r1, _, err := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalNumberOfBytes)),
		uintptr(unsafe.Pointer(&totalNumberOfFreeBytes)),
	)
	if r1 == 0 {
		return 0, err
	}
	return uint64(freeBytesAvailable), nil
}
