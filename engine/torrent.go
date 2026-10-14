package engine

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

// IsMagnetLink checks if a given string is a BitTorrent magnet URI
func IsMagnetLink(uri string) bool {
	return strings.HasPrefix(strings.ToLower(uri), "magnet:?")
}

// ParseMagnetName extracts a human-readable display name from a magnet URI (dn parameter)
func ParseMagnetName(rawMagnet string) string {
	parsed, err := url.Parse(rawMagnet)
	if err != nil {
		return fmt.Sprintf("Torrent_%d", time.Now().Unix())
	}

	values := parsed.Query()
	dn := values.Get("dn")
	if dn != "" {
		return dn
	}

	xt := values.Get("xt")
	if xt != "" {
		parts := strings.Split(xt, ":")
		if len(parts) > 0 {
			return "Torrent_" + parts[len(parts)-1]
		}
	}

	return fmt.Sprintf("Torrent_%d", time.Now().Unix())
}
