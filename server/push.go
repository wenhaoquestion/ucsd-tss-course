package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func (a *app) validateVAPID() error {
	if a.pushPrivate == "" && a.pushPublic == "" && a.subject == "" {
		return nil
	}
	private, err := base64.RawURLEncoding.DecodeString(a.pushPrivate)
	if err != nil {
		return errors.New("invalid VAPID private key")
	}
	key, err := ecdh.P256().NewPrivateKey(private)
	if err != nil {
		return errors.New("invalid VAPID private key")
	}
	if base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()) != a.pushPublic {
		return errors.New("VAPID public/private keys must match")
	}
	if !strings.HasPrefix(a.subject, "mailto:") || !strings.Contains(a.subject, "@") {
		return errors.New("VAPID_SUBJECT must be a mailto: contact")
	}
	return nil
}

// Browser push subscriptions may send traffic only to known browser vendors.
// No URL overrides, redirects, nonstandard ports, proxies, or private IPs.
func allowedPushEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Port() != "" || u.Fragment != "" || len(raw) > 4096 {
		return false
	}
	host := strings.ToLower(u.Host)
	if strings.HasSuffix(host, ".notify.windows.com") {
		return len(u.Path) > 1 || u.Query().Get("token") != ""
	}
	if u.RawQuery != "" || len(u.Path) < 2 {
		return false
	}
	switch {
	case host == "fcm.googleapis.com":
		return strings.HasPrefix(u.Path, "/fcm/send/") || strings.HasPrefix(u.Path, "/wp/")
	case host == "web.push.apple.com" || strings.HasSuffix(host, ".push.apple.com"):
		return true
	case host == "push.services.mozilla.com" || strings.HasSuffix(host, ".push.services.mozilla.com"):
		return strings.HasPrefix(u.Path, "/wpush/")
	}
	return false
}
func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, reserved := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2001:db8::/32", "2002::/16"} {
		if netip.MustParsePrefix(reserved).Contains(ip) {
			return false
		}
	}
	return true
}
func makePushClient() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		dialer := net.Dialer{Timeout: 5 * time.Second}
		for _, ip := range ips {
			if !publicAddress(ip) {
				continue
			}
			c, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return c, nil
			}
		}
		return nil, errors.New("no public push address available")
	}
	return &http.Client{Transport: t, Timeout: 9 * time.Second, CheckRedirect: denyRedirect}
}

type watchRequest struct {
	Term         string               `json:"term"`
	Section      string               `json:"sectionId"`
	Threshold    int                  `json:"threshold"`
	Subscription webpush.Subscription `json:"subscription"`
	Locale       string               `json:"locale"`
}

func (p watchRequest) valid() bool {
	if !validSection(p.Section) || p.Threshold < 1 || p.Threshold > 5000 || !allowedPushEndpoint(p.Subscription.Endpoint) {
		return false
	}
	key, err := base64.RawURLEncoding.DecodeString(p.Subscription.Keys.P256dh)
	if err != nil {
		return false
	}
	if _, err = ecdh.P256().NewPublicKey(key); err != nil {
		return false
	}
	auth, err := base64.RawURLEncoding.DecodeString(p.Subscription.Keys.Auth)
	return err == nil && len(auth) == 16
}
func (a *app) watch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if a.pushPublic == "" {
		problem(w, 503, "Web Push not configured")
		return
	}
	if !a.allowWatch(r.RemoteAddr) {
		w.Header().Set("Retry-After", "60")
		problem(w, 429, "try again later")
		return
	}
	if strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0] != "application/json" {
		problem(w, 415, "application/json required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	var p watchRequest
	dec := json.NewDecoder(r.Body)
	if dec.Decode(&p) != nil || dec.Decode(&struct{}{}) != io.EOF || !a.terms[p.Term] || !p.valid() {
		problem(w, 400, "invalid watch or push subscription")
		return
	}
	if strings.HasPrefix(strings.ToLower(p.Locale), "zh") {
		p.Locale = "zh"
	} else {
		p.Locale = "en"
	}
	// Repeating the same subscription creation is idempotent. The browser's
	// private 128-bit auth secret keeps recovery of its bearer token local.
	hash := sha256.Sum256([]byte(strings.Join([]string{"cancel-watch-v1", p.Subscription.Keys.Auth, p.Subscription.Keys.P256dh, p.Subscription.Endpoint, p.Term, p.Section, strconv.Itoa(p.Threshold)}, "\x00")))
	token := base64.RawURLEncoding.EncodeToString(hash[:])
	tokenHash := sha256.Sum256([]byte(token))
	endpoint := sha256.Sum256([]byte(p.Subscription.Endpoint))
	raw, _ := json.Marshal(p.Subscription)
	bytesID := make([]byte, 16)
	if _, err := rand.Read(bytesID); err != nil {
		problem(w, 503, "random source unavailable")
		return
	}
	id := hex.EncodeToString(bytesID)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.failed(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), "SELECT pg_advisory_xact_lock(hashtext($1))", hex.EncodeToString(endpoint[:])); err != nil {
		a.failed(w, err)
		return
	}
	var exists bool
	var num int
	if err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM seat_current WHERE term=$1 AND section=$2),
	  (SELECT count(*) FROM watches WHERE endpoint_key=$3 AND NOT (term=$1 AND section=$2 AND threshold=$4) AND expires_at>now())`, p.Term, p.Section, endpoint[:], p.Threshold).Scan(&exists, &num); err != nil {
		a.failed(w, err)
		return
	}
	if !exists {
		problem(w, 404, "section observations not available yet")
		return
	}
	if num >= 60 {
		problem(w, 429, "too many watches for this subscription")
		return
	}
	err = tx.QueryRowContext(r.Context(), `INSERT INTO watches (id,token_hash,term,section,threshold,endpoint_key,subscription,locale)
	  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint_key,term,section,threshold)
	  DO UPDATE SET expires_at=now()+interval '120 days',locale=excluded.locale WHERE watches.token_hash=excluded.token_hash
	  RETURNING id`, id, tokenHash[:], p.Term, p.Section, p.Threshold, endpoint[:], string(raw), p.Locale).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, 409, "subscription has changed")
		return
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		a.failed(w, err)
		return
	}
	respond(w, 201, map[string]string{"id": id, "token": token})
}
func (a *app) unwatch(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	id := r.PathValue("id")
	if !ok || len(token) != 43 || len(id) != 32 {
		problem(w, 401, "invalid watch credential")
		return
	}
	key := sha256.Sum256([]byte(token))
	result, err := a.db.ExecContext(r.Context(), "DELETE FROM watches WHERE id=$1 AND token_hash=$2", id, key[:])
	if err != nil {
		a.failed(w, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		problem(w, 404, "watch not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *app) deliveryLoop(ctx context.Context) {
	for ctx.Err() == nil {
		_, err := a.db.ExecContext(ctx, `DELETE FROM watches WHERE expires_at<=now()`)
		if err == nil {
			_, err = a.db.ExecContext(ctx, `DELETE FROM deliveries WHERE observed_at < now() - interval '24 hours' OR attempts>=7`)
		}
		if err == nil {
			for i := 0; i < 60; i++ {
				var sent bool
				sent, err = a.deliverOne(ctx)
				if err != nil || !sent {
					break
				}
			}
		}
		if err != nil && ctx.Err() == nil {
			a.log.Printf("push queue: %v", err)
		}
		if pause(ctx, 5*time.Second) != nil {
			return
		}
	}
}
func (a *app) deliverOne(ctx context.Context) (bool, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var id, term, section, locale, course string
	var raw []byte
	var at time.Time
	var available, attempt, threshold int
	var current *int
	err = tx.QueryRowContext(ctx, `SELECT d.watch_id,w.term,w.section,w.locale,w.subscription,d.observed_at,d.available,d.attempts,
	  w.threshold,c.available,c.course FROM deliveries d JOIN watches w ON w.id=d.watch_id
	  JOIN seat_current c ON c.term=w.term AND c.section=w.section
	  WHERE d.due<=now() AND w.expires_at>now() ORDER BY d.due LIMIT 1 FOR UPDATE OF d,w SKIP LOCKED`).
		Scan(&id, &term, &section, &locale, &raw, &at, &available, &attempt, &threshold, &current, &course)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	deleteJob := func() error {
		_, err := tx.ExecContext(ctx, "DELETE FROM deliveries WHERE watch_id=$1 AND observed_at=$2", id, at)
		return err
	}
	var sub webpush.Subscription
	if err = json.Unmarshal(raw, &sub); err != nil {
		return false, err
	}
	if current == nil || *current < threshold || !allowedPushEndpoint(sub.Endpoint) {
		err = deleteJob()
	} else {
		title := course + " seat update"
		body := fmt.Sprintf("Observed %d open at %s. Verify in TSS.", available, at.UTC().Format(time.RFC3339))
		if locale == "zh" {
			title = course + " 余位更新"
			body = fmt.Sprintf("%s 观测到 %d 个余位，请在 TSS 核实。", at.UTC().Format(time.RFC3339), available)
		}
		payload, _ := json.Marshal(map[string]string{"title": title, "body": body, "url": "?" + url.Values{"term": {term}, "section": {section}}.Encode()})
		response, sendErr := webpush.SendNotificationWithContext(ctx, payload, &sub, &webpush.Options{HTTPClient: a.pushClient, Subscriber: strings.TrimPrefix(a.subject, "mailto:"),
			VAPIDPublicKey: a.pushPublic, VAPIDPrivateKey: a.pushPrivate, Topic: id, TTL: 900})
		status := 0
		if response != nil {
			status = response.StatusCode
			response.Body.Close()
		}
		switch {
		case status == 404 || status == 410:
			_, err = tx.ExecContext(ctx, "DELETE FROM watches WHERE endpoint_key=(SELECT endpoint_key FROM watches WHERE id=$1)", id)
		case sendErr == nil && status >= 200 && status <= 299:
			err = deleteJob()
		case status != 0 && status != 429 && status < 500:
			err = deleteJob()
		default:
			delay := min(60*(1<<min(attempt, 6)), 3600)
			if response != nil {
				delay = max(delay, int(retryAfter(response.Header.Get("Retry-After")).Seconds()))
			}
			_, err = tx.ExecContext(ctx, "UPDATE deliveries SET attempts=attempts+1,due=now()+$3*interval '1 second' WHERE watch_id=$1 AND observed_at=$2", id, at, delay)
		}
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}
