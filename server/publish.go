package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type shardFiles struct {
	Seats   string `json:"seats"`
	History string `json:"history"`
}
type manifest struct {
	Version    int                   `json:"version"`
	Term       string                `json:"term"`
	Source     string                `json:"source"`
	ObservedAt time.Time             `json:"observedAt"`
	Shards     map[string]shardFiles `json:"shards"`
}
type historyPoint struct {
	At time.Time `json:"at"`
	counts
}
type staticHistory struct {
	Sections map[string][]historyPoint `json:"sections"`
}
type staticSeats struct {
	Seats map[string]counts `json:"seats"`
}

var shardName = regexp.MustCompile(`^(?:[0-9]{2}|other)\.[a-f0-9]{24}\.json$`)

func shardFor(id string) string {
	if n := len(id); n >= 2 && id[n-1] >= '0' && id[n-1] <= '9' && id[n-2] >= '0' && id[n-2] <= '9' {
		return id[n-2:]
	}
	return "other"
}
func loadPrevious(dir, term string) (manifest, error) {
	var m manifest
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.Term != term || m.Version != 1 || len(m.Shards) == 0 {
		return m, errors.New("invalid previous manifest")
	}
	for key, files := range m.Shards {
		for kind, f := range map[string]string{"seats": files.Seats, "history": files.History} {
			name := filepath.Base(f)
			shard, _, _ := strings.Cut(name, ".")
			if !shardName.MatchString(name) || f != kind+"/"+name || shard != key {
				return m, errors.New("invalid previous shard path")
			}
		}
	}
	return m, nil
}
func writeShard(dir, kind, key string, v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(b)
	name := fmt.Sprintf("%s/%s.%s.json", kind, key, hex.EncodeToString(hash[:12]))
	path := filepath.Join(dir, filepath.FromSlash(name))
	if _, err = os.Stat(path); os.IsNotExist(err) {
		err = os.WriteFile(path, b, 0644)
	}
	return name, err
}

// An immutable shard name lets the Pages client safely cache a previous
// response. Publish the manifest last after every referenced shard is ready.
func exportSnapshot(root, term string, at time.Time, all map[string]sectionSeat) error {
	if !termPattern.MatchString(term) || len(all) == 0 {
		return errors.New("invalid snapshot")
	}
	dir := filepath.Join(root, term)
	for _, kind := range []string{"seats", "history"} {
		if err := os.MkdirAll(filepath.Join(dir, kind), 0755); err != nil {
			return err
		}
	}
	old, err := loadPrevious(dir, term)
	if err != nil {
		return err
	}
	if !old.ObservedAt.IsZero() && !at.After(old.ObservedAt) {
		return errors.New("out-of-order observation")
	}
	m := manifest{1, term, "UCSD Class Planner", at.UTC(), map[string]shardFiles{}}
	byShard := map[string]map[string]counts{}
	for id, s := range all {
		key := shardFor(id)
		if byShard[key] == nil {
			byShard[key] = map[string]counts{}
		}
		byShard[key][id] = s.Counts
	}
	for key := range old.Shards {
		if byShard[key] == nil {
			byShard[key] = map[string]counts{}
		}
	}
	keep := map[string]bool{}
	for key, sections := range byShard {
		h := staticHistory{Sections: map[string][]historyPoint{}}
		if previous, ok := old.Shards[key]; ok {
			keep[previous.Seats] = true
			keep[previous.History] = true
			b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(previous.History)))
			if err != nil {
				return err
			}
			if err = json.Unmarshal(b, &h); err != nil {
				return err
			}
			if h.Sections == nil {
				return errors.New("invalid history shard")
			}
		}
		for id, c := range sections {
			points := h.Sections[id]
			if len(points) == 0 || !sameCounts(points[len(points)-1].counts, c) {
				h.Sections[id] = append(points, historyPoint{at.UTC(), c})
			}
		}
		for id, points := range h.Sections {
			start := sort.Search(len(points), func(i int) bool { return !points[i].At.Before(at.Add(-70 * 24 * time.Hour)) })
			// Keep the point immediately preceding the visible window, too.
			start = max(0, start-1, len(points)-336)
			h.Sections[id] = points[start:]
		}
		sfile, err := writeShard(dir, "seats", key, staticSeats{sections})
		if err != nil {
			return err
		}
		hfile, err := writeShard(dir, "history", key, h)
		if err != nil {
			return err
		}
		keep[sfile] = true
		keep[hfile] = true
		m.Shards[key] = shardFiles{sfile, hfile}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".manifest-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(b)
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp.Name(), filepath.Join(dir, "manifest.json")); err != nil {
		return err
	}
	for _, kind := range []string{"seats", "history"} {
		files, err := os.ReadDir(filepath.Join(dir, kind))
		if err != nil {
			return err
		}
		for _, f := range files {
			if f.Type().IsRegular() && shardName.MatchString(f.Name()) && !keep[kind+"/"+f.Name()] {
				if err = os.Remove(filepath.Join(dir, kind, f.Name())); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func publishCommand(term, out string) error {
	if !termPattern.MatchString(term) {
		return errors.New("invalid term")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	all, err := readCatalog(ctx, &http.Client{Timeout: 35 * time.Second, CheckRedirect: denyRedirect}, term)
	if err != nil {
		return err
	}
	return exportSnapshot(out, term, time.Now().UTC(), all)
}
