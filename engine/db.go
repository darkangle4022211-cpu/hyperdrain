package engine

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type Database struct {
	db *sql.DB
}

func InitDB(dataDir string) (*Database, error) {
	dbPath := filepath.Join(dataDir, "hyperdrain_state.db")
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	// Create tables
	queries := []string{
		`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			name TEXT NOT NULL,
			target_file TEXT NOT NULL,
			total_bytes INTEGER DEFAULT 0,
			downloaded_bytes INTEGER DEFAULT 0,
			status TEXT NOT NULL,
			connections INTEGER DEFAULT 16,
			auto_extract INTEGER DEFAULT 1,
			cookie TEXT,
			referer TEXT,
			user_agent TEXT,
			created_at DATETIME,
			completed_at DATETIME,
			error_message TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS segments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			seg_index INTEGER NOT NULL,
			start_byte INTEGER NOT NULL,
			end_byte INTEGER NOT NULL,
			downloaded INTEGER DEFAULT 0,
			status TEXT NOT NULL,
			FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_segments_task ON segments(task_id);`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);`,
	}

	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return nil, fmt.Errorf("failed executing schema query: %w", err)
		}
	}

	// Schema migration for format_id, origin, batch_id, auto_zip
	_, _ = db.Exec("ALTER TABLE tasks ADD COLUMN format_id TEXT;")
	_, _ = db.Exec("ALTER TABLE tasks ADD COLUMN origin TEXT;")
	_, _ = db.Exec("ALTER TABLE tasks ADD COLUMN batch_id TEXT;")
	_, _ = db.Exec("ALTER TABLE tasks ADD COLUMN auto_zip INTEGER DEFAULT 0;")

	return &Database{db: db}, nil
}

func (d *Database) SaveTask(task *DownloadTask) error {
	task.mu.Lock()
	defer task.mu.Unlock()

	query := `INSERT INTO tasks (
		id, url, name, target_file, total_bytes, downloaded_bytes, status, 
		connections, auto_extract, cookie, referer, user_agent, created_at, completed_at, error_message,
		format_id, origin, batch_id, auto_zip
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		total_bytes = excluded.total_bytes,
		downloaded_bytes = excluded.downloaded_bytes,
		status = excluded.status,
		completed_at = excluded.completed_at,
		error_message = excluded.error_message,
		format_id = excluded.format_id,
		origin = excluded.origin,
		batch_id = excluded.batch_id,
		auto_zip = excluded.auto_zip;`

	autoExtract := 0
	if task.AutoExtract {
		autoExtract = 1
	}
	autoZip := 0
	if task.AutoZip {
		autoZip = 1
	}

	_, err := d.db.Exec(query,
		task.ID, task.URL, task.Name, task.TargetFile, task.TotalBytes, task.DownloadedBytes,
		string(task.Status), task.Connections, autoExtract, task.Cookie, task.Referer, task.UserAgent,
		task.CreatedAt, task.CompletedAt, task.ErrorMessage, task.FormatID, task.Origin, task.BatchID, autoZip,
	)
	return err
}

func (d *Database) SaveSegments(taskID string, segments []*Segment) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Clear previous segments if any
	if _, err := tx.Exec("DELETE FROM segments WHERE task_id = ?", taskID); err != nil {
		return err
	}

	stmt, err := tx.Prepare(`INSERT INTO segments (task_id, seg_index, start_byte, end_byte, downloaded, status) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, s := range segments {
		total := s.End - s.Start + 1
		s.Total = total
		if _, err := stmt.Exec(taskID, s.Index, s.Start, s.End, s.Downloaded, s.Status); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (d *Database) UpdateSegmentProgress(taskID string, segIndex int, downloaded int64, status string) error {
	query := `UPDATE segments SET downloaded = ?, status = ? WHERE task_id = ? AND seg_index = ?`
	_, err := d.db.Exec(query, downloaded, status, taskID, segIndex)
	return err
}

func (d *Database) LoadTasks() ([]*DownloadTask, error) {
	rows, err := d.db.Query(`SELECT id, url, name, target_file, total_bytes, downloaded_bytes, status, connections, auto_extract, cookie, referer, user_agent, created_at, completed_at, error_message, format_id, origin, COALESCE(batch_id, ''), COALESCE(auto_zip, 0) FROM tasks ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*DownloadTask
	for rows.Next() {
		var t DownloadTask
		var autoExtract, autoZip int
		var compAt sql.NullTime
		var errMsg, cookie, referer, ua, fid, orig, batchId sql.NullString

		err := rows.Scan(
			&t.ID, &t.URL, &t.Name, &t.TargetFile, &t.TotalBytes, &t.DownloadedBytes,
			&t.Status, &t.Connections, &autoExtract, &cookie, &referer, &ua,
			&t.CreatedAt, &compAt, &errMsg, &fid, &orig, &batchId, &autoZip,
		)
		if err != nil {
			return nil, err
		}

		t.AutoExtract = autoExtract == 1
		t.AutoZip = autoZip == 1
		if batchId.Valid {
			t.BatchID = batchId.String
		}
		if compAt.Valid {
			t.CompletedAt = &compAt.Time
		}
		if errMsg.Valid {
			t.ErrorMessage = errMsg.String
		}
		if cookie.Valid {
			t.Cookie = cookie.String
		}
		if referer.Valid {
			t.Referer = referer.String
		}
		if ua.Valid {
			t.UserAgent = ua.String
		}
		if fid.Valid {
			t.FormatID = fid.String
		}
		if orig.Valid {
			t.Origin = orig.String
		}

		if t.TotalBytes > 0 && t.DownloadedBytes > t.TotalBytes {
			t.DownloadedBytes = t.TotalBytes
		}

		// Load segments
		segRows, err := d.db.Query(`SELECT id, seg_index, start_byte, end_byte, downloaded, status FROM segments WHERE task_id = ? ORDER BY seg_index ASC`, t.ID)
		if err == nil {
			for segRows.Next() {
				var s Segment
				s.TaskID = t.ID
				if err := segRows.Scan(&s.ID, &s.Index, &s.Start, &s.End, &s.Downloaded, &s.Status); err == nil {
					s.Total = s.End - s.Start + 1
					t.Segments = append(t.Segments, &s)
				}
			}
			segRows.Close()
		}

		if t.TotalBytes <= 0 && len(t.Segments) > 0 {
			var totalFromSegs int64
			for _, s := range t.Segments {
				if s.End+1 > totalFromSegs {
					totalFromSegs = s.End + 1
				}
			}
			if totalFromSegs > 0 {
				t.TotalBytes = totalFromSegs
			}
		}

		tasks = append(tasks, &t)
	}

	return tasks, nil
}

func (d *Database) DeleteTask(taskID string) error {
	_, err := d.db.Exec(`DELETE FROM tasks WHERE id = ?`, taskID)
	return err
}

func (d *Database) GetSetting(key, defaultVal string) string {
	var val string
	err := d.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val)
	if err != nil {
		return defaultVal
	}
	return val
}

func (d *Database) SetSetting(key, val string) error {
	_, err := d.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, val)
	return err
}
