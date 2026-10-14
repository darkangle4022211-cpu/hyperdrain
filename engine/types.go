package engine

import (
	"context"
	"sync"
	"time"
)

type TaskStatus string

const (
	StatusQueued      TaskStatus = "queued"
	StatusDownloading TaskStatus = "downloading"
	StatusPaused      TaskStatus = "paused"
	StatusCompleted   TaskStatus = "completed"
	StatusExtracted   TaskStatus = "extracted"
	StatusError       TaskStatus = "error"
)

type Segment struct {
	ID         int    `json:"id"`
	TaskID     string `json:"task_id"`
	Index      int    `json:"index"`
	Start      int64  `json:"start"`
	End        int64  `json:"end"`
	Total      int64  `json:"total"`
	Downloaded int64  `json:"downloaded"`
	Status     string `json:"status"` // "pending", "active", "completed", "stealing"
}

type DownloadTask struct {
	ID                string     `json:"id"`
	URL               string     `json:"url"`
	Name              string     `json:"name"`
	TargetFile        string     `json:"target_file"`
	TotalBytes        int64      `json:"total_bytes"`
	DownloadedBytes   int64      `json:"downloaded_bytes"`
	Speed             int64      `json:"speed"`
	DiskWriteRate     int64      `json:"disk_write_rate"`
	Status            TaskStatus `json:"status"`
	Connections       int        `json:"connections"`
	ActiveConnections int        `json:"active_connections"`
	AutoExtract       bool       `json:"auto_extract"`
	Cookie            string     `json:"cookie,omitempty"`
	Referer           string     `json:"referer,omitempty"`
	UserAgent         string     `json:"user_agent,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	CompletedAt       *time.Time `json:"completed_at,omitempty"`
	ErrorMessage      string     `json:"error_message,omitempty"`
	ETA               int64      `json:"eta"`
	RetryCount        int        `json:"retry_count,omitempty"`
	FormatID          string     `json:"format_id,omitempty"`
	Origin            string     `json:"origin,omitempty"`
	BatchID           string     `json:"batch_id,omitempty"`
	AutoZip           bool       `json:"auto_zip,omitempty"`
	Segments          []*Segment `json:"segments"`
	LastProgressTime  time.Time  `json:"last_progress_time,omitempty"`
	LastProgressBytes int64      `json:"-"`

	mu     sync.Mutex         `json:"-"`
	cancel context.CancelFunc `json:"-"`
}

type EngineSettings struct {
	DownloadDir        string `json:"download_dir"`
	DefaultConnections int    `json:"default_connections"`
	MaxConcurrentTasks int    `json:"max_concurrent_tasks"`
	AutoExtract        bool   `json:"auto_extract"`
	AuthToken          string `json:"auth_token"`
}

type TelemetryMessage struct {
	TotalSpeed        int64           `json:"total_speed"`
	DiskWriteSpeed    int64           `json:"disk_write_speed"`
	ActiveConnections int             `json:"active_connections"`
	DiskFree          uint64          `json:"disk_free"`
	AllTimeDownloaded int64           `json:"all_time_downloaded"`
	WorkStealsCount   int64           `json:"work_steals_count"`
	ZombiesRecycled   int64           `json:"zombies_recycled"`
	Tasks             []*DownloadTask `json:"tasks"`
}
