package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

const publicSearch = "https://classplanner.apps.ucsd.edu/api/v1/public/catalog/courses/search"

var termPattern = regexp.MustCompile(`^(WI|SP|FA|SU|SA|S[123])[0-9]{2}$`)

type counts struct {
	Available *int `json:"available"`
	Capacity  *int `json:"capacity"`
	Waitlist  *int `json:"waitlist"`
}
type observation struct {
	counts
	ObservedAt time.Time  `json:"observedAt"`
	SourceAt   *time.Time `json:"sourceAt"`
}
type sectionSeat struct {
	Course string
	Counts counts
}
type directoryCourse struct {
	Code     string `json:"module_code"`
	Sections []struct {
		ID        string `json:"section_id"`
		Available *int   `json:"seats_available"`
		Capacity  *int   `json:"capacity"`
		Waitlist  *int   `json:"waitlist_enrolled"`
	} `json:"sections"`
}

// The same E ID can appear in several packages or course listings. Counts belong
// to that section; never add the reported values across repeated appearances.
func collectSections(all map[string]sectionSeat, courses []directoryCourse) error {
	for _, c := range courses {
		if c.Code == "" {
			return errors.New("catalog missing module code")
		}
		for _, section := range c.Sections {
			if !validSection(section.ID) {
				return errors.New("catalog contains invalid section ID")
			}
			v := counts{section.Available, section.Capacity, section.Waitlist}
			if existing, ok := all[section.ID]; ok {
				if !sameCounts(existing.Counts, v) {
					return errors.New("inconsistent counts for repeated section")
				}
				continue
			}
			all[section.ID] = sectionSeat{c.Code, v}
		}
	}
	return nil
}
func sameInt(a, b *int) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func sameCounts(a, b counts) bool {
	return sameInt(a.Available, b.Available) && sameInt(a.Capacity, b.Capacity) && sameInt(a.Waitlist, b.Waitlist)
}
func validSection(id string) bool {
	return len(id) > 0 && len(id) <= 100 && strings.TrimSpace(id) == id && strings.IndexFunc(id, func(r rune) bool { return r < ' ' || r > 126 || r == ',' }) == -1
}
func pause(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func retryAfter(header string) time.Duration {
	if seconds, err := strconv.ParseUint(header, 10, 32); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(header); err == nil {
		return max(0, time.Until(at))
	}
	return 0
}

type sourceError struct {
	status int
	retry  time.Duration
}

func (e *sourceError) Error() string { return fmt.Sprintf("catalog HTTP %d", e.status) }
func readCatalog(ctx context.Context, client *http.Client, term string) (map[string]sectionSeat, error) {
	all := map[string]sectionSeat{}
	const pageSize = 48
	for offset := 0; offset < 20000; {
		body, _ := json.Marshal(map[string]any{"term_code": term, "offset": offset, "limit": pageSize})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, publicSearch, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "UCSD-course-planner/1.0 (public schedule reader)")
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		var page struct {
			Term    string            `json:"term_code"`
			Total   *int              `json:"total"`
			Offset  *int              `json:"offset"`
			Courses []directoryCourse `json:"courses"`
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, &sourceError{resp.StatusCode, retryAfter(resp.Header.Get("Retry-After"))}
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 20<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if page.Term != term || page.Total == nil || page.Offset == nil || *page.Offset != offset || len(page.Courses) == 0 {
			return nil, errors.New("incomplete catalog page")
		}
		if err := collectSections(all, page.Courses); err != nil {
			return nil, err
		}
		offset += len(page.Courses)
		if offset >= *page.Total {
			if len(all) == 0 {
				return nil, errors.New("empty catalog")
			}
			return all, nil
		}
		if err := pause(ctx, 750*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("catalog exceeded maximum page budget")
}

// Full snapshots are committed atomically. Only count changes create history
// or threshold-crossing alerts; repeated observations still update freshness.
type transactionStarter interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}

func storeSnapshot(ctx context.Context, db transactionStarter, term string, at time.Time, all map[string]sectionSeat, live bool) error {
	if len(all) == 0 {
		return errors.New("empty snapshot")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "snapshot:"+term); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `CREATE TEMP TABLE incoming(section text PRIMARY KEY,course text, available integer,capacity integer,waitlist integer) ON COMMIT DROP`); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, pq.CopyIn("incoming", "section", "course", "available", "capacity", "waitlist"))
	if err != nil {
		return err
	}
	defer stmt.Close()
	for id, s := range all {
		if _, err = stmt.ExecContext(ctx, id, s.Course, s.Counts.Available, s.Counts.Capacity, s.Counts.Waitlist); err != nil {
			return err
		}
	}
	if _, err = stmt.ExecContext(ctx); err != nil {
		return err
	}
	if err = stmt.Close(); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM incoming i USING seat_current c WHERE c.term=$1 AND c.section=i.section AND c.observed_at >= $2`, term, at)
	if err != nil {
		return err
	}
	if live {
		// A later drop makes earlier undelivered crossings obsolete, even if
		// another crossing is recorded before the delivery worker wakes up.
		_, err = tx.ExecContext(ctx, `DELETE FROM deliveries d USING watches w,incoming i
		  WHERE d.watch_id=w.id AND w.term=$1 AND w.section=i.section
		  AND (i.available IS NULL OR i.available<w.threshold)`, term)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO deliveries(watch_id,observed_at,available)
		  SELECT w.id,$2,i.available FROM incoming i JOIN watches w ON w.term=$1 AND w.section=i.section
		  JOIN seat_current c ON c.term=$1 AND c.section=i.section
		  WHERE w.expires_at>now() AND c.available<w.threshold AND i.available>=w.threshold
		  ON CONFLICT DO NOTHING`, term, at)
		if err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO seat_history(term,section,observed_at,available,capacity,waitlist)
	  SELECT $1,i.section,$2,i.available,i.capacity,i.waitlist FROM incoming i
	  LEFT JOIN seat_current c ON c.term=$1 AND c.section=i.section
	  WHERE c.section IS NULL OR (c.available,c.capacity,c.waitlist) IS DISTINCT FROM (i.available,i.capacity,i.waitlist)
	  ON CONFLICT DO NOTHING`, term, at)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO seat_current(term,section,course,available,capacity,waitlist,observed_at)
	  SELECT $1,section,course,available,capacity,waitlist,$2 FROM incoming
	  ON CONFLICT(term,section) DO UPDATE SET course=excluded.course, available=excluded.available,
	  capacity=excluded.capacity,waitlist=excluded.waitlist,observed_at=excluded.observed_at`, term, at)
	if err != nil {
		return err
	}
	if live {
		// Old observations remain visible with their original timestamp. Never
		// convert disappeared sections into zero seats or alert on them.
		_, err = tx.ExecContext(ctx, `INSERT INTO sync_status VALUES($1,$2) ON CONFLICT(term) DO UPDATE SET observed_at=greatest(excluded.observed_at,sync_status.observed_at)`, term, at)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (a *app) syncLoop(ctx context.Context, term string) {
	retry := time.Minute
	for ctx.Err() == nil {
		delay := a.interval
		// A session lock avoids duplicate upstream traffic from API replicas.
		conn, err := a.db.Conn(ctx)
		if err == nil {
			var locked bool
			err = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(hashtext($1))", "fetch:"+term).Scan(&locked)
			if err == nil && locked {
				var due bool
				err = conn.QueryRowContext(ctx, `SELECT NOT EXISTS(SELECT 1 FROM sync_status WHERE term=$1 AND observed_at > now()- $2*interval '1 second')`, term, int(a.interval.Seconds())).Scan(&due)
				if err == nil && due {
					var all map[string]sectionSeat
					all, err = readCatalog(ctx, a.sourceClient, term)
					if err == nil {
						err = storeSnapshot(ctx, conn, term, time.Now().UTC(), all, true)
					}
				}
				_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(hashtext($1))", "fetch:"+term)
			}
			conn.Close()
		}
		if err != nil {
			a.log.Printf("sync %s: %v", term, err)
			delay = retry
			var upstream *sourceError
			if errors.As(err, &upstream) {
				delay = max(delay, upstream.retry)
			}
			retry = min(retry*2, a.interval)
		} else {
			retry = time.Minute
		}
		if pause(ctx, delay) != nil {
			return
		}
	}
}

func (a *app) importSeed(ctx context.Context) error {
	file, err := os.Open(filepath.Join(a.dataDir, "seats.json"))
	if err != nil {
		return err
	}
	defer file.Close()
	var seed struct {
		Term       string            `json:"term"`
		ObservedAt time.Time         `json:"observedAt"`
		Seats      map[string]counts `json:"seats"`
	}
	if err = json.NewDecoder(io.LimitReader(file, 24<<20)).Decode(&seed); err != nil {
		return err
	}
	if !a.terms[seed.Term] || seed.ObservedAt.IsZero() || seed.ObservedAt.After(time.Now().Add(5*time.Minute)) {
		return errors.New("invalid seed observation time or term")
	}
	all := make(map[string]sectionSeat, len(seed.Seats))
	for id, v := range seed.Seats {
		if !validSection(id) {
			return errors.New("invalid seed section")
		}
		all[id] = sectionSeat{id, v}
	}
	return storeSnapshot(ctx, a.db, seed.Term, seed.ObservedAt, all, false)
}

func sectionIDs(raw string) ([]string, bool) {
	parts := strings.Split(raw, ",")
	if len(parts) > 300 {
		return nil, false
	}
	for i, id := range parts {
		parts[i] = strings.TrimSpace(id)
		if !validSection(parts[i]) {
			return nil, false
		}
	}
	sort.Strings(parts)
	return slices.Compact(parts), true
}
