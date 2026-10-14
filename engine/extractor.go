package engine

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ExtractArchive performs non-blocking extraction for web series archives (.zip, .rar, .7z)
func ExtractArchive(archivePath, destDir string) error {
	ext := strings.ToLower(filepath.Ext(archivePath))

	if ext == ".zip" {
		return extractZipNative(archivePath, destDir)
	}

	// For RAR or 7z, check system extractors
	if ext == ".rar" || ext == ".7z" || ext == ".tar" || ext == ".gz" {
		return extractExternal(archivePath, destDir)
	}

	return fmt.Errorf("unsupported archive format: %s", ext)
}

func extractZipNative(archivePath, destDir string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("failed opening zip file: %w", err)
	}
	defer reader.Close()

	// Create target directory if needed
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return err
	}

	buf := make([]byte, 4*1024*1024) // 4MB buffer for high-speed streaming

	for _, file := range reader.File {
		// Prevent ZipSlip vulnerability
		cleaned := filepath.Clean(file.Name)
		if strings.HasPrefix(cleaned, "..") || filepath.IsAbs(cleaned) {
			continue
		}

		targetPath := filepath.Join(destDir, cleaned)
		if file.FileInfo().IsDir() {
			os.MkdirAll(targetPath, file.Mode())
			continue
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}

		srcFile, err := file.Open()
		if err != nil {
			return err
		}

		dstFile, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
		if err != nil {
			srcFile.Close()
			return err
		}

		_, copyErr := io.CopyBuffer(dstFile, srcFile, buf)
		srcFile.Close()
		dstFile.Close()

		if copyErr != nil {
			return copyErr
		}
	}

	return nil
}

func extractExternal(archivePath, destDir string) error {
	// 1. Try 7z
	if path, err := exec.LookPath("7z"); err == nil {
		cmd := exec.Command(path, "x", "-y", fmt.Sprintf("-o%s", destDir), archivePath)
		return cmd.Run()
	}

	// 2. Try unrar
	if path, err := exec.LookPath("unrar"); err == nil {
		cmd := exec.Command(path, "x", "-y", archivePath, destDir)
		return cmd.Run()
	}

	// 3. Try unar
	if path, err := exec.LookPath("unar"); err == nil {
		cmd := exec.Command(path, "-o", destDir, archivePath)
		return cmd.Run()
	}

	// 4. Try tar for tar archives
	if strings.HasSuffix(archivePath, ".tar.gz") || strings.HasSuffix(archivePath, ".tgz") {
		if path, err := exec.LookPath("tar"); err == nil {
			cmd := exec.Command(path, "-xzf", archivePath, "-C", destDir)
			return cmd.Run()
		}
	}

	return fmt.Errorf("no archive extraction utility (7z, unrar, unar) found on system")
}

// ZipDirectory archives an entire directory into a single .zip file.
// It uses zip.Store (no extra recompression) because video files (mp4, mkv, ts)
// are already compressed; this allows packaging multi-gigabyte seasons in seconds.
func ZipDirectory(sourceDir, zipPath string) error {
	// Ensure parent directory for the zip exists
	if err := os.MkdirAll(filepath.Dir(zipPath), 0755); err != nil {
		return fmt.Errorf("failed creating zip destination directory: %w", err)
	}

	zipFile, err := os.Create(zipPath)
	if err != nil {
		return fmt.Errorf("failed creating zip file: %w", err)
	}

	archive := zip.NewWriter(zipFile)
	buf := make([]byte, 4*1024*1024) // 4MB buffer for maximum I/O throughput

	cleanSource := filepath.Clean(sourceDir)
	cleanZip := filepath.Clean(zipPath)

	walkErr := filepath.Walk(cleanSource, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		cleanCurrent := filepath.Clean(path)
		// Avoid including the zip file itself if placed within the same directory
		if cleanCurrent == cleanZip {
			return nil
		}

		relPath, relErr := filepath.Rel(cleanSource, cleanCurrent)
		if relErr != nil {
			return relErr
		}
		if relPath == "." || relPath == "" {
			return nil
		}

		// Don't zip incomplete or temporary download chunks
		if strings.HasSuffix(info.Name(), ".part") || strings.HasSuffix(info.Name(), ".ytdl") || strings.Contains(info.Name(), ".part-Frag") {
			return nil
		}

		header, headErr := zip.FileInfoHeader(info)
		if headErr != nil {
			return headErr
		}
		header.Name = filepath.ToSlash(relPath)
		if info.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Store
		}

		writer, createErr := archive.CreateHeader(header)
		if createErr != nil {
			return createErr
		}

		if !info.IsDir() {
			file, openErr := os.Open(cleanCurrent)
			if openErr != nil {
				return openErr
			}
			_, copyErr := io.CopyBuffer(writer, file, buf)
			file.Close()
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	})

	if walkErr != nil {
		_ = archive.Close()
		_ = zipFile.Close()
		return fmt.Errorf("error during zip archiving: %w", walkErr)
	}

	if err := archive.Close(); err != nil {
		_ = zipFile.Close()
		return fmt.Errorf("failed closing zip writer: %w", err)
	}

	_ = zipFile.Sync()
	if err := zipFile.Close(); err != nil {
		return fmt.Errorf("failed closing zip file: %w", err)
	}

	return nil
}
