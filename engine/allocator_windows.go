//go:build windows

package engine

import (
	"os"
	"path/filepath"
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

// GetAvailableSpaceForPath returns available free disk space for any target file or directory path,
// walking up to the nearest existing directory or root drive.
func GetAvailableSpaceForPath(targetPath string) (uint64, error) {
	cleanPath := filepath.Clean(targetPath)
	dir := cleanPath
	for {
		fi, err := os.Stat(dir)
		if err == nil {
			if fi.IsDir() {
				return GetDiskFreeSpace(dir)
			}
			return GetDiskFreeSpace(filepath.Dir(dir))
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "" || parent == "." {
			break
		}
		dir = parent
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if free, err := GetDiskFreeSpace(home); err == nil {
			return free, nil
		}
	}
	return GetDiskFreeSpace(".")
}

