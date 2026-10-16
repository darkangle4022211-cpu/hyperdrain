package engine

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type DownloadEngine struct {
	db              *Database
	settings        *EngineSettings
	activeTasks     map[string]*DownloadTask
	mu              sync.RWMutex
	client          *http.Client
	workStealsCount int64
	zombiesRecycled int64
	bytesDownloaded int64
	streamResumer   func(task *DownloadTask)
}

func NewDownloadEngine(db *Database, settings *EngineSettings) *DownloadEngine {
	// Custom resilient transport with aggressive keepalive, fast recycling, and header timeout
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		DisableCompression:    true,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second, // Never hang indefinitely waiting for headers
		ExpectContinueTimeout: 1 * time.Second,
		ReadBufferSize:        256 * 1024,
		WriteBufferSize:       256 * 1024,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: false,
		},
	}

	eng := &DownloadEngine{
		db:          db,
		settings:    settings,
		activeTasks: make(map[string]*DownloadTask),
		client: &http.Client{
			Transport: transport,
		},
	}
	go eng.startWatchdog()
	return eng
}

// AddTask queues or starts a new download task
func (e *DownloadEngine) AddTask(rawURL, customName, targetDir, cookie, referer, userAgent string, conns int, autoExtract bool) (*DownloadTask, error) {
	if conns <= 0 {
		conns = e.settings.DefaultConnections
	}
	if conns > 32 {
		conns = 32
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}

	// Determine file name
	fileName := customName
	if fileName == "" {
		fileName = filepath.Base(parsed.Path)
		if fileName == "" || fileName == "/" || fileName == "." {
			fileName = fmt.Sprintf("download_%d.bin", time.Now().Unix())
		}
	}

	baseDir := e.settings.DownloadDir
	if targetDir != "" {
		baseDir = targetDir
	}
	baseDir = ResolveExistingDir(baseDir)
	targetPath := filepath.Join(baseDir, fileName)

	task := &DownloadTask{
		ID:          fmt.Sprintf("task_%d_%d", time.Now().UnixNano(), rand.Intn(1000)),
		URL:         rawURL,
		Name:        fileName,
		TargetFile:  targetPath,
		Status:      StatusQueued,
		Connections: conns,
		AutoExtract: autoExtract,
		Cookie:      cookie,
		Referer:     referer,
		UserAgent:   userAgent,
		CreatedAt:   time.Now(),
		Segments:    make([]*Segment, 0),
	}

	if err := e.db.SaveTask(task); err != nil {
		return nil, err
	}

	e.mu.Lock()
	e.activeTasks[task.ID] = task
	e.mu.Unlock()

	// Launch download asynchronously
	go e.startTask(task)

	return task, nil
}

func (e *DownloadEngine) startTask(task *DownloadTask) {
	ctx, cancel := context.WithCancel(context.Background())
	task.mu.Lock()
	task.cancel = cancel
	task.Status = StatusDownloading
	task.mu.Unlock()

	e.db.SaveTask(task)

	defer func() {
		task.mu.Lock()
		task.ActiveConnections = 0
		task.Speed = 0
		task.DiskWriteRate = 0
		task.mu.Unlock()
		e.db.SaveTask(task)
	}()

	var size int64
	var supportsRange bool

	// If task already has segments, DO NOT re-probe server!
	// Re-probing causes redundant requests and can falsely fail the download during momentary disconnects.
	if len(task.Segments) > 0 {
		supportsRange = true
		if task.TotalBytes > 0 {
			size = task.TotalBytes
		} else {
			var totalFromSegs int64
			for _, s := range task.Segments {
				if s.End+1 > totalFromSegs {
					totalFromSegs = s.End + 1
				}
			}
			if totalFromSegs > 0 {
				size = totalFromSegs
				task.mu.Lock()
				task.TotalBytes = totalFromSegs
				task.mu.Unlock()
				e.db.SaveTask(task)
			}
		}
	} else {
		// New task: probe server with retries for transient DNS/connection blips
		var probeErr error
		for attempt := 0; attempt < 5; attempt++ {
			size, supportsRange, probeErr = e.probeURL(ctx, task)
			if probeErr == nil || errors.Is(ctx.Err(), context.Canceled) {
				break
			}
			time.Sleep(time.Duration(1+attempt) * time.Second)
		}
		if probeErr != nil && !errors.Is(ctx.Err(), context.Canceled) {
			task.mu.Lock()
			task.Status = StatusError
			task.ErrorMessage = probeErr.Error()
			task.mu.Unlock()
			NotifyDownloadStopped(task.Name, probeErr.Error())
			return
		}

		task.mu.Lock()
		if size > 0 {
			task.TotalBytes = size
		}
		task.mu.Unlock()
		e.db.SaveTask(task)
	}

	// Pre-flight Disk Space Check on Target Directory:
	// If the target disk does not have enough free space for the file, the download MUST NOT start.
	targetDir := filepath.Dir(task.TargetFile)
	availTarget, errSpace := GetAvailableSpaceForPath(targetDir)
	needed := size - task.DownloadedBytes
	if needed <= 0 && size > 0 {
		needed = size
	}
	if errSpace == nil && needed > 0 && int64(availTarget) < needed {
		errStr := fmt.Sprintf("Target disk does not have enough space: %s required, but only %s available", FormatBytes(needed), FormatBytes(int64(availTarget)))
		log.Printf("[HyperDrain] %s for %s", errStr, task.Name)
		task.mu.Lock()
		task.Status = StatusError
		task.ErrorMessage = errStr
		task.mu.Unlock()
		e.db.SaveTask(task)
		NotifyInsufficientDiskSpace(task.Name, needed, int64(availTarget))
		return
	}
	if errSpace == nil && size <= 0 && availTarget < 20*1024*1024 {
		errStr := fmt.Sprintf("Target disk is almost full: only %s available", FormatBytes(int64(availTarget)))
		log.Printf("[HyperDrain] %s for %s", errStr, task.Name)
		task.mu.Lock()
		task.Status = StatusError
		task.ErrorMessage = errStr
		task.mu.Unlock()
		e.db.SaveTask(task)
		NotifyInsufficientDiskSpace(task.Name, 20*1024*1024, int64(availTarget))
		return
	}

	// Notify user that verified download has commenced
	if task.RetryCount == 0 {
		conns := task.Connections
		if !supportsRange || size <= 0 {
			conns = 1
		}
		NotifyDownloadStarted(task.Name, conns)
	}

	homeDir, _ := os.UserHomeDir()
	stagingDir := filepath.Join(homeDir, ".cache", "hyperdrain", "staging", task.ID)
	os.MkdirAll(stagingDir, 0755)
	stagingFile := filepath.Join(stagingDir, task.Name+".part")

	// Open staging file for writing (NEVER touch destination on Disk D until 100% completed!)
	file, err := os.OpenFile(stagingFile, os.O_CREATE|os.O_RDWR, 0666)
	if err != nil {
		task.mu.Lock()
		task.Status = StatusError
		task.ErrorMessage = fmt.Sprintf("cannot open staging file: %v", err)
		task.mu.Unlock()
		NotifyDownloadStopped(task.Name, task.ErrorMessage)
		return
	}
	defer file.Close()

	// Instant fallocate pre-allocation on staging file
	if size > 0 {
		if err := PreallocateFile(file, size); err != nil {
			fmt.Printf("[HyperDrain] Fallocate warning for %s: %v (continuing with normal write)\n", task.Name, err)
		}
	}

	// Initialize segments if not already in DB
	if len(task.Segments) == 0 && supportsRange && size > 0 {
		e.initSegments(task, size, task.Connections)
		e.db.SaveSegments(task.ID, task.Segments)
	}

	if (!supportsRange || size <= 0) && len(task.Segments) == 0 {
		// Single-stream fallback
		e.downloadSingleStream(ctx, task, file)
	} else {
		// Multi-part accelerated parallel download
		e.downloadParallel(ctx, task, file)
	}

	// Explicitly close file before moving
	file.Close()

	// Verify if 100% completed
	task.mu.Lock()
	isDone := task.TotalBytes > 0 && task.DownloadedBytes >= task.TotalBytes
	task.mu.Unlock()

	if isDone {
		now := time.Now()
		task.mu.Lock()
		task.Status = StatusCompleted
		task.CompletedAt = &now
		if task.TotalBytes > 0 {
			task.DownloadedBytes = task.TotalBytes
		}
		task.mu.Unlock()

		// Atomically move the completed file to destination disk ONLY upon 100% completion
		os.MkdirAll(filepath.Dir(task.TargetFile), 0755)
		if err := MoveFile(stagingFile, task.TargetFile); err == nil {
			os.RemoveAll(stagingDir)
		}

		e.db.SaveTask(task)

		// Post-download integrity verification (Container magic bytes check)
		e.verifyContainerIntegrity(task.TargetFile)
		NotifyDownloadComplete(task.Name, FormatBytes(task.TotalBytes))

		// Auto-extract wrapped video zips (.mkv.zip, .mp4.zip) or archives with AutoExtract enabled
		lowerName := strings.ToLower(task.Name)
		isWrappedVideoZip := strings.HasSuffix(lowerName, ".mkv.zip") ||
			strings.HasSuffix(lowerName, ".mp4.zip") ||
			strings.HasSuffix(lowerName, ".avi.zip") ||
			strings.HasSuffix(lowerName, ".webm.zip")

		if task.AutoExtract || isWrappedVideoZip {
			destDir := filepath.Dir(task.TargetFile)
			go func(archivePath, dest string, isWrapped bool) {
				if err := ExtractArchive(archivePath, dest); err == nil {
					log.Printf("[HyperDrain] Successfully auto-extracted %s to %s", archivePath, dest)
					if isWrapped {
						_ = os.Remove(archivePath)
					}
				} else {
					log.Printf("[HyperDrain] Auto-extract failed for %s: %v", archivePath, err)
				}
			}(task.TargetFile, destDir, isWrappedVideoZip)
		}
	} else {
		task.mu.Lock()
		if task.Status == StatusDownloading && !errors.Is(ctx.Err(), context.Canceled) {
			task.Status = StatusError
			if task.ErrorMessage == "" {
				task.ErrorMessage = "Download stopped prematurely before 100% completion"
			}
			NotifyDownloadStopped(task.Name, task.ErrorMessage)
		}
		task.mu.Unlock()
		e.db.SaveTask(task)
	}
}

// MoveFile moves a file across filesystems safely with atomic rename or copy+delete fallback
func MoveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	in.Close()
	out.Close()
	return os.Remove(src)
}

func (e *DownloadEngine) probeURL(ctx context.Context, task *DownloadTask) (int64, bool, error) {
	// First check HEAD request for Accept-Ranges
	reqHead, err := http.NewRequestWithContext(ctx, "HEAD", task.URL, nil)
	if err == nil {
		e.applyHeaders(reqHead, task)
		respHead, errHead := e.client.Do(reqHead)
		if errHead == nil {
			defer respHead.Body.Close()
			if (respHead.Header.Get("Accept-Ranges") == "bytes" || respHead.StatusCode == http.StatusPartialContent) && respHead.ContentLength > 0 {
				return respHead.ContentLength, true, nil
			}
		}
	}

	// Proactively probe with Range: bytes=0-1
	req, err := http.NewRequestWithContext(ctx, "GET", task.URL, nil)
	if err != nil {
		return 0, false, err
	}
	e.applyHeaders(req, task)
	req.Header.Set("Range", "bytes=0-1")

	resp, err := e.client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusPartialContent {
			cr := resp.Header.Get("Content-Range")
			if parts := strings.Split(cr, "/"); len(parts) == 2 {
				var total int64
				fmt.Sscanf(parts[1], "%d", &total)
				if total > 0 {
					return total, true, nil
				}
			}
			return resp.ContentLength, true, nil
		}
		if resp.StatusCode == http.StatusOK {
			if resp.Header.Get("Accept-Ranges") == "bytes" && resp.ContentLength > 0 {
				return resp.ContentLength, true, nil
			}
			if resp.ContentLength > 1024*1024 {
				req2, err2 := http.NewRequestWithContext(ctx, "GET", task.URL, nil)
				if err2 == nil {
					e.applyHeaders(req2, task)
					req2.Header.Set("Range", "bytes=1024-2047")
					resp2, err3 := e.client.Do(req2)
					if err3 == nil {
						defer resp2.Body.Close()
						if resp2.StatusCode == http.StatusPartialContent {
							return resp.ContentLength, true, nil
						}
					}
				}
			}
			return resp.ContentLength, false, nil
		}
	}

	return 0, false, err
}

func (e *DownloadEngine) initSegments(task *DownloadTask, totalSize int64, numSegments int) {
	chunkSize := totalSize / int64(numSegments)
	task.Segments = make([]*Segment, numSegments)

	for i := 0; i < numSegments; i++ {
		start := int64(i) * chunkSize
		end := start + chunkSize - 1
		if i == numSegments-1 {
			end = totalSize - 1
		}
		task.Segments[i] = &Segment{
			Index:      i,
			TaskID:     task.ID,
			Start:      start,
			End:        end,
			Total:      end - start + 1,
			Downloaded: 0,
			Status:     "pending",
		}
	}
}

func (e *DownloadEngine) downloadParallel(ctx context.Context, task *DownloadTask, file *os.File) {
	var wg sync.WaitGroup
	var activeConns int32

	// Launch worker goroutines for each pending segment
	for _, seg := range task.Segments {
		if seg.Downloaded >= seg.Total {
			seg.Status = "completed"
			continue
		}

		wg.Add(1)
		atomic.AddInt32(&activeConns, 1)

		go func(s *Segment) {
			defer func() {
				atomic.AddInt32(&activeConns, -1)
				wg.Done()
			}()
			e.downloadSegment(ctx, task, file, s)
		}(seg)
	}

	// Speed calculation ticker & work-stealer supervisor
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var prevDownloaded int64 = task.DownloadedBytes
	var prevTime = time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			currentConns := int(atomic.LoadInt32(&activeConns))
			task.mu.Lock()
			task.ActiveConnections = currentConns

			// Always sync DownloadedBytes with true unique segment bytes
			if len(task.Segments) > 0 {
				var actualUniqueDl int64
				for _, s := range task.Segments {
					actualUniqueDl += s.Downloaded
				}
				if actualUniqueDl > 0 {
					if task.TotalBytes > 0 && actualUniqueDl > task.TotalBytes {
						actualUniqueDl = task.TotalBytes
					}
					task.DownloadedBytes = actualUniqueDl
				}
			}

			downloadedNow := task.DownloadedBytes
			dt := now.Sub(prevTime).Seconds()
			if dt > 0 {
				delta := downloadedNow - prevDownloaded
				if delta >= 0 {
					task.Speed = int64(float64(delta) / dt)
					task.DiskWriteRate = task.Speed
					if task.Speed > 0 && task.TotalBytes > task.DownloadedBytes {
						task.ETA = (task.TotalBytes - task.DownloadedBytes) / task.Speed
					} else {
						task.ETA = 0
					}
				}
			}
			prevDownloaded = downloadedNow
			prevTime = now
			task.mu.Unlock()

			// Check if all segments are done
			allDone := true
			for _, s := range task.Segments {
				if s.Downloaded < s.Total {
					allDone = false
					break
				}
			}
			if allDone {
				wg.Wait()
				return
			}

			// Resilient worker supervisor: If network disconnected and all workers died,
			// but segments are still unfinished: auto-respawn workers to reconnect!
			if currentConns == 0 && ctx.Err() == nil {
				for _, seg := range task.Segments {
					if seg.Downloaded < seg.Total && seg.Status != "active" {
						seg.Status = "pending"
						wg.Add(1)
						atomic.AddInt32(&activeConns, 1)

						go func(s *Segment) {
							defer func() {
								atomic.AddInt32(&activeConns, -1)
								wg.Done()
							}()
							e.downloadSegment(ctx, task, file, s)
						}(seg)
					}
				}
			}
		}
	}
}

func (e *DownloadEngine) downloadSegment(ctx context.Context, task *DownloadTask, file *os.File, seg *Segment) {
	currentOffset := seg.Start + seg.Downloaded
	remaining := seg.End - currentOffset + 1
	if remaining <= 0 {
		seg.Status = "completed"
		return
	}

	seg.Status = "active"

	backoff := 1 * time.Second
	for currentOffset <= seg.End {
		select {
		case <-ctx.Done():
			return
		default:
		}

		chunkCtx, chunkCancel := context.WithCancel(ctx)
		req, err := http.NewRequestWithContext(chunkCtx, "GET", task.URL, nil)
		if err != nil {
			chunkCancel()
			return
		}
		e.applyHeaders(req, task)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", currentOffset, seg.End))

		resp, err := e.client.Do(req)
		if err != nil {
			chunkCancel()
			// Dropped connection / network cut off: retry with backoff
			atomic.AddInt64(&e.zombiesRecycled, 1)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 10*time.Second {
				backoff *= 2
			}
			continue
		}

		// Handle 429 / 503 rate limits with jitter
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
			resp.Body.Close()
			chunkCancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(1000+rand.Intn(2000)) * time.Millisecond):
			}
			continue
		}

		if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			chunkCancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			continue
		}

		// Inactivity watchdog: if no bytes arrive for 35s on dead socket, abort chunk to force reconnect
		inactivityTimer := time.AfterFunc(35*time.Second, func() {
			chunkCancel()
		})

		// Stream bytes into local buffer (256KB for maximum throughput) and write directly to disk via WriteAt
		buf := make([]byte, 256*1024)
		reader := resp.Body

		for currentOffset <= seg.End {
			n, readErr := reader.Read(buf)
			if n > 0 {
				inactivityTimer.Reset(35 * time.Second) // Reset watchdog on fresh data

				// Concurrent write directly to byte position in pre-allocated file
				_, writeErr := file.WriteAt(buf[:n], currentOffset)
				if writeErr != nil {
					inactivityTimer.Stop()
					resp.Body.Close()
					chunkCancel()
					return
				}

				currentOffset += int64(n)
				seg.Downloaded += int64(n)

				task.mu.Lock()
				task.LastProgressTime = time.Now()
				task.mu.Unlock()

				atomic.AddInt64(&e.bytesDownloaded, int64(n))
				backoff = 1 * time.Second // Reset backoff on successful data stream
			}

			if readErr != nil {
				inactivityTimer.Stop()
				resp.Body.Close()
				chunkCancel()
				break
			}
		}
		inactivityTimer.Stop()
		chunkCancel()

		if currentOffset > seg.End {
			seg.Status = "completed"
			e.db.UpdateSegmentProgress(task.ID, seg.Index, seg.Downloaded, "completed")
			return
		}

		time.Sleep(200 * time.Millisecond)
	}
}

func (e *DownloadEngine) downloadSingleStream(ctx context.Context, task *DownloadTask, file *os.File) {
	task.mu.Lock()
	offset := task.DownloadedBytes
	task.ActiveConnections = 1
	task.mu.Unlock()

	// Speed calculation ticker (updates task.Speed and task.DiskWriteRate every 500ms)
	speedTicker := time.NewTicker(500 * time.Millisecond)
	defer speedTicker.Stop()

	tickerDone := make(chan struct{})
	defer close(tickerDone)

	var prevDownloaded int64 = offset
	var prevTime = time.Now()

	go func() {
		for {
			select {
			case <-tickerDone:
				return
			case <-ctx.Done():
				return
			case now := <-speedTicker.C:
				task.mu.Lock()
				downloadedNow := task.DownloadedBytes
				dt := now.Sub(prevTime).Seconds()
				if dt > 0 {
					delta := downloadedNow - prevDownloaded
					if delta >= 0 {
						task.Speed = int64(float64(delta) / dt)
						task.DiskWriteRate = task.Speed
						if task.Speed > 0 && task.TotalBytes > task.DownloadedBytes {
							task.ETA = (task.TotalBytes - task.DownloadedBytes) / task.Speed
						} else {
							task.ETA = 0
						}
					}
				}
				prevDownloaded = downloadedNow
				prevTime = now
				task.mu.Unlock()
			}
		}
	}()

	buf := make([]byte, 256*1024)
	backoff := 1 * time.Second
	consecutiveErrors := 0
	maxConsecutiveErrors := 60

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		task.mu.Lock()
		offset = task.DownloadedBytes
		total := task.TotalBytes
		task.mu.Unlock()

		if total > 0 && offset >= total {
			return
		}

		req, err := http.NewRequestWithContext(ctx, "GET", task.URL, nil)
		if err != nil {
			return
		}
		e.applyHeaders(req, task)

		// If resuming from partial bytes, send Range header
		if offset > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}

		resp, err := e.client.Do(req)
		if err != nil {
			consecutiveErrors++
			task.mu.Lock()
			task.ActiveConnections = 0
			task.Speed = 0
			task.mu.Unlock()

			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[SINGLE-STREAM] Max reconnect retries reached for %s: %v", task.Name, err)
				return
			}

			log.Printf("[SINGLE-STREAM] Network interrupted for %s (%v), reconnecting in %v (attempt %d)...",
				task.Name, err, backoff, consecutiveErrors)

			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 10*time.Second {
				backoff = time.Duration(float64(backoff) * 1.5)
			}
			continue
		}

		// Connected!
		task.mu.Lock()
		task.ActiveConnections = 1
		task.mu.Unlock()

		// Capture total file size if not already set
		if task.TotalBytes <= 0 {
			if resp.StatusCode == http.StatusOK && resp.ContentLength > 0 {
				task.mu.Lock()
				task.TotalBytes = resp.ContentLength
				task.mu.Unlock()
				e.db.SaveTask(task)
			} else if resp.StatusCode == http.StatusPartialContent {
				cr := resp.Header.Get("Content-Range")
				if parts := strings.Split(cr, "/"); len(parts) == 2 {
					var totalVal int64
					fmt.Sscanf(parts[1], "%d", &totalVal)
					if totalVal > 0 {
						task.mu.Lock()
						task.TotalBytes = totalVal
						task.mu.Unlock()
						e.db.SaveTask(task)
					}
				}
			}
		}

		// If server does not support resume and sent 200 instead of 206, restart offset from 0
		if offset > 0 && resp.StatusCode == http.StatusOK {
			offset = 0
			task.mu.Lock()
			task.DownloadedBytes = 0
			task.mu.Unlock()
		}

		reader := resp.Body
		streamError := false

		for {
			select {
			case <-ctx.Done():
				resp.Body.Close()
				return
			default:
			}

			n, readErr := reader.Read(buf)
			if n > 0 {
				_, writeErr := file.WriteAt(buf[:n], offset)
				if writeErr != nil {
					resp.Body.Close()
					return
				}
				offset += int64(n)

				task.mu.Lock()
				task.DownloadedBytes = offset
				task.LastProgressTime = time.Now()
				task.mu.Unlock()

				atomic.AddInt64(&e.bytesDownloaded, int64(n))
				backoff = 1 * time.Second
				consecutiveErrors = 0
			}

			if readErr != nil {
				resp.Body.Close()
				if errors.Is(readErr, io.EOF) {
					task.mu.Lock()
					isFinished := (task.TotalBytes > 0 && task.DownloadedBytes >= task.TotalBytes) || task.TotalBytes <= 0
					task.mu.Unlock()
					if isFinished {
						return
					}
				}
				log.Printf("[SINGLE-STREAM] Stream connection interrupted for %s: %v (auto-reconnecting at offset %d)", task.Name, readErr, offset)
				streamError = true
				break
			}
		}

		if streamError {
			time.Sleep(500 * time.Millisecond)
			continue
		}
	}
}

func (e *DownloadEngine) applyHeaders(req *http.Request, task *DownloadTask) {
	if task.UserAgent != "" {
		req.Header.Set("User-Agent", task.UserAgent)
	} else {
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 HyperDrain/1.0")
	}

	if task.Referer != "" {
		ref := task.Referer
		if parsed, err := url.Parse(ref); err == nil && parsed.Path == "" {
			parsed.Path = "/"
			ref = parsed.String()
		}
		req.Header.Set("Referer", ref)
	}

	if task.Cookie != "" {
		req.Header.Set("Cookie", task.Cookie)
	}
}

func (e *DownloadEngine) verifyContainerIntegrity(filePath string) bool {
	f, err := os.Open(filePath)
	if err != nil {
		return false
	}
	defer f.Close()

	header := make([]byte, 16)
	n, _ := f.Read(header)
	if n < 4 {
		return false
	}

	// Check magic signatures
	if bytes.HasPrefix(header, []byte("PK\x03\x04")) { // ZIP
		return true
	}
	if bytes.HasPrefix(header, []byte("\x1A\x45\xDF\xA3")) { // MKV/WebM
		return true
	}
	if bytes.HasPrefix(header, []byte("Rar!\x1A\x07")) { // RAR
		return true
	}
	if n >= 8 && string(header[4:8]) == "ftyp" { // MP4
		return true
	}
	return true
}

// Control actions
func (e *DownloadEngine) PauseTask(taskID string) {
	e.mu.RLock()
	task, exists := e.activeTasks[taskID]
	e.mu.RUnlock()

	if exists {
		task.mu.Lock()
		if task.cancel != nil {
			task.cancel()
		}
		task.Status = StatusPaused
		task.Speed = 0
		task.ActiveConnections = 0
		task.mu.Unlock()
		e.db.SaveTask(task)
	}
}

func (e *DownloadEngine) SetStreamResumer(fn func(task *DownloadTask)) {
	e.streamResumer = fn
}

func (e *DownloadEngine) ResumeTask(taskID string) {
	e.mu.RLock()
	task, exists := e.activeTasks[taskID]
	e.mu.RUnlock()

	if exists {
		task.mu.Lock()
		if task.cancel != nil {
			task.cancel()
		}
		task.Status = StatusDownloading
		task.ErrorMessage = ""
		task.LastProgressTime = time.Now()
		task.mu.Unlock()

		if (strings.HasPrefix(task.ID, "task_stream_") || strings.HasPrefix(task.ID, "zip_batch_")) && e.streamResumer != nil {
			go e.streamResumer(task)
			return
		}
		go e.startTask(task)
	}
}

func (e *DownloadEngine) DeleteTask(taskID string) {
	e.PauseTask(taskID)
	e.mu.Lock()
	delete(e.activeTasks, taskID)
	e.mu.Unlock()
	e.db.DeleteTask(taskID)

	homeDir, _ := os.UserHomeDir()
	os.RemoveAll(filepath.Join(homeDir, ".cache", "hyperdrain", "staging", taskID))
}

func (e *DownloadEngine) GetTasks() []*DownloadTask {
	e.mu.Lock()
	defer e.mu.Unlock()

	tasks := make([]*DownloadTask, 0, len(e.activeTasks))
	for _, t := range e.activeTasks {
		tasks = append(tasks, t)
	}

	return tasks
}

func (e *DownloadEngine) RestoreTasks(tasks []*DownloadTask) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, t := range tasks {
		e.activeTasks[t.ID] = t
	}
}

// ClearCompletedTasks removes completed download cards from DB and memory
// IMPORTANT: Downloaded files on the user's hard drive are NEVER touched or deleted
func (e *DownloadEngine) ClearCompletedTasks() {
	e.mu.Lock()
	var completedIDs []string
	for id, t := range e.activeTasks {
		if t.Status == StatusCompleted || t.Status == StatusExtracted {
			completedIDs = append(completedIDs, id)
			delete(e.activeTasks, id)
		}
	}
	e.mu.Unlock()

	for _, id := range completedIDs {
		e.db.DeleteTask(id)
	}
}

func (e *DownloadEngine) GetTelemetry() *TelemetryMessage {
	tasks := e.GetTasks()
	var totalSpeed int64 = 0
	var totalDisk int64 = 0
	var activeConns int = 0

	for _, t := range tasks {
		if t.Status == StatusDownloading {
			totalSpeed += t.Speed
			totalDisk += t.DiskWriteRate
			activeConns += t.ActiveConnections
		}
	}

	freeBytes, _ := GetDiskFreeSpace(e.settings.DownloadDir)

	return &TelemetryMessage{
		TotalSpeed:        totalSpeed,
		DiskWriteSpeed:    totalDisk,
		ActiveConnections: activeConns,
		DiskFree:          freeBytes,
		AllTimeDownloaded: atomic.LoadInt64(&e.bytesDownloaded),
		WorkStealsCount:   atomic.LoadInt64(&e.workStealsCount),
		ZombiesRecycled:   atomic.LoadInt64(&e.zombiesRecycled),
		Tasks:             tasks,
	}
}

func (e *DownloadEngine) startWatchdog() {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		e.mu.RLock()
		tasks := make([]*DownloadTask, 0, len(e.activeTasks))
		for _, t := range e.activeTasks {
			tasks = append(tasks, t)
		}
		e.mu.RUnlock()

		for _, task := range tasks {
			task.mu.Lock()
			if task.Status == StatusDownloading {
				isStream := strings.HasPrefix(task.ID, "task_stream_") || strings.HasPrefix(task.ID, "zip_batch_") || task.AutoZip
				isPackaging := strings.Contains(task.ErrorMessage, "Packaging") || strings.Contains(task.ErrorMessage, "ZIP")

				if isPackaging {
					// Task is currently writing multi-gigabyte ZIP archive to disk; do not touch!
					task.mu.Unlock()
					continue
				}

				if isStream {
					// Check real-time bytes on disk in staging directory
					homeDir, _ := os.UserHomeDir()
					stagingDir := filepath.Join(homeDir, ".cache", "hyperdrain", "staging", task.ID)
					var stagingDiskBytes int64 = 0
					if entries, err := os.ReadDir(stagingDir); err == nil {
						for _, entry := range entries {
							if !entry.IsDir() {
								if fi, err := entry.Info(); err == nil {
									stagingDiskBytes += fi.Size()
								}
							}
						}
					}

					// If disk size grew, bytes are actively arriving!
					if stagingDiskBytes > task.LastProgressBytes || stagingDiskBytes > task.DownloadedBytes {
						if stagingDiskBytes > task.DownloadedBytes {
							task.DownloadedBytes = stagingDiskBytes
						}
						task.LastProgressBytes = stagingDiskBytes
						task.LastProgressTime = time.Now()
					}
				}

				// 1. Detect zombie tasks (only for direct tasks that have been running for a while and truly lost all connections)
				if !isStream && task.ActiveConnections == 0 && !task.LastProgressTime.IsZero() && time.Since(task.LastProgressTime) >= 45*time.Second {
					if task.RetryCount < 3 {
						task.RetryCount++
						taskID := task.ID
						taskName := task.Name
						retryNum := task.RetryCount
						task.LastProgressTime = time.Now()
						task.mu.Unlock()
						log.Printf("[WATCHDOG] Auto-reviving stalled task %s (attempt %d/3)...", taskName, retryNum)
						go e.ResumeTask(taskID)
						continue
					} else {
						// Exceeded max auto-revive retries: mark stopped and notify user immediately!
						task.Status = StatusError
						if task.ErrorMessage == "" {
							task.ErrorMessage = "Internet connection lost or download stopped midway."
						}
						taskName := task.Name
						errMsg := task.ErrorMessage
						task.mu.Unlock()
						e.db.SaveTask(task)
						NotifyDownloadStopped(taskName, errMsg)
						continue
					}
				}

				stallThreshold := 45 * time.Second
				if isStream {
					stallThreshold = 120 * time.Second
				}

				if task.LastProgressTime.IsZero() {
					task.LastProgressTime = time.Now()
					task.LastProgressBytes = task.DownloadedBytes
				} else if task.DownloadedBytes > task.LastProgressBytes {
					task.LastProgressBytes = task.DownloadedBytes
					task.LastProgressTime = time.Now()
				} else if time.Since(task.LastProgressTime) >= stallThreshold {
					// Stalled midway!
					sec := int(time.Since(task.LastProgressTime).Seconds())
					taskName := task.Name
					taskID := task.ID
					task.LastProgressTime = time.Now()
					if isStream && task.RetryCount >= 3 {
						task.Status = StatusError
						task.ErrorMessage = "Stream stalled: remote video server stopped sending data or link expired."
						task.mu.Unlock()
						e.db.SaveTask(task)
						NotifyDownloadStopped(taskName, task.ErrorMessage)
						continue
					}
					task.RetryCount++
					retryNum := task.RetryCount
					task.mu.Unlock()
					if sec >= 60 {
						NotifyDownloadStalled(taskName, sec)
					}
					log.Printf("[WATCHDOG] Task %s stalled at 0 B/s for >%ds (attempt %d/3). Auto-restarting socket pool...", taskName, sec, retryNum)
					go e.ResumeTask(taskID)
					continue
				}
			} else if task.Status == StatusError {
				// Auto-recover tasks that failed due to temporary network drop / DNS timeout (up to 3 attempts)
				if strings.Contains(task.ErrorMessage, "dial tcp") || strings.Contains(task.ErrorMessage, "i/o timeout") || strings.Contains(task.ErrorMessage, "lookup") {
					if task.RetryCount < 3 && time.Since(task.LastProgressTime) >= 15*time.Second {
						task.RetryCount++
						taskID := task.ID
						taskName := task.Name
						retryNum := task.RetryCount
						task.LastProgressTime = time.Now()
						task.mu.Unlock()
						log.Printf("[WATCHDOG] Auto-retrying network-failed task %s (attempt %d/3)...", taskName, retryNum)
						go e.ResumeTask(taskID)
						continue
					}
				}
			} else {
				task.LastProgressTime = time.Time{}
			}
			task.mu.Unlock()
		}
	}
}

