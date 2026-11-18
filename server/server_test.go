package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func TestPushBoundaries(t *testing.T) {
	for _, s := range []string{"http://fcm.googleapis.com/fcm/send/test", "https://fcm.googleapis.com.evil.test/fcm/send/x", "https://fcm.googleapis.com@localhost/fcm/send/x", "https://127.0.0.1/x", "https://web.push.apple.com:444/x"} {
		if allowedPushEndpoint(s) {
			t.Errorf("accepted %s", s)
		}
	}
	for _, raw := range []string{"127.0.0.1", "::1", "169.254.169.254", "100.64.0.2", "::ffff:10.2.3.4", "2001:db8::1"} {
		if publicAddress(netip.MustParseAddr(raw)) {
			t.Errorf("accepted %s", raw)
		}
	}
	if !allowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/demo") {
		t.Fatal("rejected Firefox")
	}
	a := app{origins: map[string]bool{"https://planner.github.io": true}}
	for origin, code := range map[string]int{"https://planner.github.io": 204, "https://planner.github.io.bad": 403} {
		req := httptest.NewRequest("OPTIONS", "https://api.example/api/watch", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, req)
		if w.Code != code {
			t.Fatal(w.Code)
		}
		if code == 204 && w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatal("missing exact origin")
		}
	}
}

func TestSectionDuplicates(t *testing.T) {
	var courses []directoryCourse
	_ = json.Unmarshal([]byte(`[{"module_code":"CSE-012","sections":[{"section_id":"E 01","event_package_ids":["A","B"],"seats_available":2},{"section_id":"E 01","event_package_ids":["B"],"seats_available":2}]}]`), &courses)
	all := map[string]sectionSeat{}
	if err := collectSections(all, courses); err != nil || len(all) != 1 || *all["E 01"].Counts.Available != 2 {
		t.Fatal(err, all)
	}
	courses[0].Sections[1].Available = new(int)
	if collectSections(all, courses) == nil {
		t.Fatal("accepted inconsistent snapshot")
	}
}

func TestPublishedShardContinuity(t *testing.T) {
	root := t.TempDir()
	term := "WI27"
	section := "E 00006900"
	at := time.Now().UTC()
	save := func(minutes, value int) manifest {
		t.Helper()
		seats := map[string]sectionSeat{section: {"CSE-012", counts{Available: &value}}}
		if err := exportSnapshot(root, term, at.Add(time.Duration(minutes)*time.Minute), seats); err != nil {
			t.Fatal(err)
		}
		m, err := loadPrevious(filepath.Join(root, term), term)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	first := save(0, 0)
	second := save(10, 2)
	third := save(20, 2)
	if first.Shards["00"] == second.Shards["00"] || second.Shards["00"] != third.Shards["00"] {
		t.Fatal("shards must change only on data changes")
	}
	if !third.ObservedAt.After(second.ObservedAt) {
		t.Fatal("repeated observations still advance freshness")
	}
	data, err := os.ReadFile(filepath.Join(root, term, third.Shards["00"].History))
	if err != nil {
		t.Fatal(err)
	}
	var h staticHistory
	if err = json.Unmarshal(data, &h); err != nil || len(h.Sections[section]) != 2 {
		t.Fatal(err, string(data))
	}
	if err = exportSnapshot(root, term, at, nil); err == nil {
		t.Fatal("accepted empty snapshot")
	}
	post, err := loadPrevious(filepath.Join(root, term), term)
	if err != nil || !post.ObservedAt.Equal(third.ObservedAt) {
		t.Fatal("previous snapshot lost")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TEST_DATABASE_URL points to a disposable Postgres database; all test tables
// live in a unique schema which is removed at the end of the run.
func TestPostgresObservationAndPush(t *testing.T) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx := context.Background()
	admin, err := sql.Open("postgres", raw)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := fmt.Sprintf("planner_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + name); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + name + " CASCADE")
	dsn, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := dsn.Query()
	q.Set("search_path", name)
	dsn.RawQuery = q.Encode()
	db, err := sql.Open("postgres", dsn.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	sends := 0
	a := app{db: db, log: log.Default(), terms: map[string]bool{"WI27": true}, pushPrivate: priv, pushPublic: pub, subject: "mailto:ops@example.org",
		pushClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			sends++
			if r.Header.Get("Authorization") == "" || r.Header.Get("Content-Encoding") != "aes128gcm" {
				t.Fatal("missing VAPID/encryption")
			}
			return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}}
	base := time.Now().UTC().Add(-time.Hour)
	id := "E 00006900"
	save := func(n int, minute int) {
		t.Helper()
		err := storeSnapshot(ctx, db, "WI27", base.Add(time.Duration(minute)*time.Minute), map[string]sectionSeat{id: {"CSE-012", counts{Available: &n}}}, true)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, path string, body []byte, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, req)
		return w
	}
	save(0, 0)
	ec, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	body, _ := json.Marshal(watchRequest{Term: "WI27", Section: id, Threshold: 2, Subscription: webpush.Subscription{Endpoint: "https://fcm.googleapis.com/fcm/send/test", Keys: webpush.Keys{Auth: base64.RawURLEncoding.EncodeToString(auth), P256dh: base64.RawURLEncoding.EncodeToString(ec.PublicKey().Bytes())}}, Locale: "zh"})
	one := request("POST", "/api/watch", body, "")
	two := request("POST", "/api/watch", body, "")
	if one.Code != 201 || two.Body.String() != one.Body.String() {
		t.Fatalf("watch %d %s, %s", one.Code, one.Body, two.Body)
	}
	var watch map[string]string
	_ = json.Unmarshal(one.Body.Bytes(), &watch)
	save(1, 1)
	save(2, 2)
	save(2, 3)
	save(0, 0)
	if ok, err := a.deliverOne(ctx); !ok || err != nil || sends != 1 {
		t.Fatal(ok, err, sends)
	}
	if ok, err := a.deliverOne(ctx); ok || err != nil || sends != 1 {
		t.Fatal(ok, err, sends)
	}
	w := request("GET", "/api/history?term=WI27&section=E%2000006900", nil, "")
	var history struct {
		Points []json.RawMessage `json:"points"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &history); err != nil || len(history.Points) != 3 {
		t.Fatal(w.Body.String(), err)
	}
	w = request("GET", "/api/seats?term=WI27&ids=E%2000006900", nil, "")
	var result struct {
		Seats map[string]observation `json:"seats"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	s := result.Seats[id]
	if s.Available == nil || *s.Available != 2 || s.SourceAt != nil || !s.ObservedAt.Truncate(time.Microsecond).Equal(base.Add(3*time.Minute).Truncate(time.Microsecond)) {
		t.Fatal(w.Body.String())
	}
	save(0, 4)
	save(3, 5)
	save(0, 6)
	if ok, err := a.deliverOne(ctx); ok || err != nil || sends != 1 {
		t.Fatal("delivered obsolete alert", ok, err, sends)
	}
	save(3, 7)
	if ok, err := a.deliverOne(ctx); !ok || err != nil || sends != 2 {
		t.Fatal("new crossing not delivered", ok, err, sends)
	}
	if result := request("DELETE", "/api/watch/"+watch["id"], nil, strings.Repeat("a", 43)); result.Code != 404 {
		t.Fatal(result.Code)
	}
	if result := request("DELETE", "/api/watch/"+watch["id"], nil, watch["token"]); result.Code != 204 {
		t.Fatal(result.Code)
	}
}
