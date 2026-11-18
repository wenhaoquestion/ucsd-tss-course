package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/lib/pq"
)

//go:embed schema.sql
var schema string

type app struct {
	db                               *sql.DB
	log                              *log.Logger
	terms                            map[string]bool
	origins                          map[string]bool
	dataDir                          string
	interval                         time.Duration
	sourceClient                     *http.Client
	pushClient                       *http.Client
	pushPrivate, pushPublic, subject string
	limiterMu                        sync.Mutex
	watchRequests                    map[string]int
	window                           time.Time
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func (a *app) failed(w http.ResponseWriter, err error) {
	a.log.Printf("database: %v", err)
	problem(w, 503, "service unavailable")
}
func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("GET /api/seats", a.seats)
	mux.HandleFunc("GET /api/history", a.history)
	mux.HandleFunc("GET /api/catalog", a.catalog)
	mux.HandleFunc("GET /api/push/key", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]string{"publicKey": a.pushPublic})
	})
	mux.HandleFunc("POST /api/watch", a.watch)
	mux.HandleFunc("DELETE /api/watch/{id}", a.unwatch)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if !a.origins[origin] && (err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host != r.Host || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "") {
				problem(w, 403, "origin not enabled")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *app) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	rows, err := a.db.QueryContext(ctx, "SELECT term,observed_at FROM sync_status")
	if err != nil {
		a.failed(w, err)
		return
	}
	defer rows.Close()
	times := map[string]time.Time{}
	for rows.Next() {
		var term string
		var at time.Time
		if err = rows.Scan(&term, &at); err != nil {
			a.failed(w, err)
			return
		}
		times[term] = at.UTC()
	}
	if err = rows.Err(); err != nil {
		a.failed(w, err)
		return
	}
	respond(w, 200, map[string]any{"status": "ok", "lastSync": times, "pushAvailable": a.pushPublic != "", "syncIntervalSeconds": int(a.interval.Seconds())})
}
func (a *app) catalog(w http.ResponseWriter, r *http.Request) {
	// The downloadable catalog has exactly the same schema and data timestamps
	// as the GitHub Pages deployment.
	term := r.URL.Query().Get("term")
	if term != "" && term != "WI27" {
		problem(w, 404, "no bundled catalog for term")
		return
	}
	http.ServeFile(w, r, filepath.Join(a.dataDir, "catalog.json"))
}
func (a *app) seats(w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("term")
	ids, ok := sectionIDs(r.URL.Query().Get("ids"))
	if !a.terms[term] || !ok {
		problem(w, 400, "valid term and 1–300 section IDs required")
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT section,available,capacity,waitlist,observed_at FROM seat_current WHERE term=$1 AND section=ANY($2)`, term, pq.Array(ids))
	if err != nil {
		a.failed(w, err)
		return
	}
	defer rows.Close()
	result := map[string]observation{}
	var latest *time.Time
	for rows.Next() {
		var id string
		var s observation
		if err = rows.Scan(&id, &s.Available, &s.Capacity, &s.Waitlist, &s.ObservedAt); err != nil {
			a.failed(w, err)
			return
		}
		s.ObservedAt = s.ObservedAt.UTC()
		result[id] = s
		if latest == nil || s.ObservedAt.After(*latest) {
			t := s.ObservedAt
			latest = &t
		}
	}
	if err = rows.Err(); err != nil {
		a.failed(w, err)
		return
	}
	respond(w, 200, map[string]any{"source": "UCSD Class Planner", "observedAt": latest, "seats": result})
}
func (a *app) history(w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("term")
	id := r.URL.Query().Get("section")
	if !a.terms[term] || !validSection(id) {
		problem(w, 400, "valid term and section required")
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT observed_at,available,capacity,waitlist FROM
	  (SELECT * FROM seat_history WHERE term=$1 AND section=$2 ORDER BY observed_at DESC LIMIT 2000) x ORDER BY observed_at`, term, id)
	if err != nil {
		a.failed(w, err)
		return
	}
	defer rows.Close()
	type point struct {
		At time.Time `json:"at"`
		counts
	}
	result := []point{}
	for rows.Next() {
		var p point
		if err = rows.Scan(&p.At, &p.Available, &p.Capacity, &p.Waitlist); err != nil {
			a.failed(w, err)
			return
		}
		p.At = p.At.UTC()
		result = append(result, p)
	}
	if err = rows.Err(); err != nil {
		a.failed(w, err)
		return
	}
	respond(w, 200, map[string]any{"points": result})
}
func (a *app) allowWatch(address string) bool {
	host, _, _ := net.SplitHostPort(address)
	a.limiterMu.Lock()
	defer a.limiterMu.Unlock()
	if a.watchRequests == nil || time.Since(a.window) > time.Minute {
		a.watchRequests = map[string]int{}
		a.window = time.Now()
	}
	if a.watchRequests[host] >= 60 || len(a.watchRequests) >= 20000 {
		return false
	}
	a.watchRequests[host]++
	return true
}
func main() {
	if len(os.Args) == 4 && os.Args[1] == "publish-observations" {
		if err := publishCommand(os.Args[2], os.Args[3]); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "generate-vapid" {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			log.Fatal(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"VAPID_PRIVATE_KEY": priv, "VAPID_PUBLIC_KEY": pub})
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(6)
	db.SetConnMaxLifetime(30 * time.Minute)
	startup, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	if _, err = db.ExecContext(startup, schema); err != nil {
		log.Fatal(err)
	}
	interval, err := time.ParseDuration(getenv("SYNC_INTERVAL", "12h"))
	if err != nil || interval < 30*time.Minute {
		log.Fatal("SYNC_INTERVAL must be at least 30m")
	}
	a := &app{db: db, log: log.Default(), terms: map[string]bool{}, origins: map[string]bool{}, dataDir: getenv("DATA_DIR", "../public/data"), interval: interval,
		sourceClient: &http.Client{Timeout: 35 * time.Second, CheckRedirect: denyRedirect}, pushClient: makePushClient(),
		pushPrivate: os.Getenv("VAPID_PRIVATE_KEY"), pushPublic: os.Getenv("VAPID_PUBLIC_KEY"), subject: os.Getenv("VAPID_SUBJECT")}
	if err = a.validateVAPID(); err != nil {
		log.Fatal(err)
	}
	for _, term := range strings.Split(getenv("TERMS", "WI27"), ",") {
		term = strings.TrimSpace(term)
		if !termPattern.MatchString(term) {
			log.Fatal("invalid TERMS")
		}
		a.terms[term] = true
	}
	for _, o := range strings.Split(os.Getenv("CORS_ORIGINS"), ",") {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
			log.Fatal("CORS_ORIGINS requires exact scheme and host")
		}
		a.origins[o] = true
	}
	if err = a.importSeed(ctx); err != nil {
		a.log.Printf("catalog seed: %v", err)
	}
	if os.Getenv("SYNC_ENABLED") != "false" {
		for term := range a.terms {
			go a.syncLoop(ctx, term)
		}
	}
	if a.pushPublic != "" {
		go a.deliveryLoop(ctx)
	}
	srv := &http.Server{Addr: getenv("LISTEN_ADDR", ":8080"), Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		ending, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = srv.Shutdown(ending)
	}()
	if err = srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
func denyRedirect(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
