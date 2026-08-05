# Runbook — Podman stack, PromQL, and load testing

Quick-reference for running this project under **Podman** (not minikube — see `NOTES.md`
for the older minikube flow). Covers: bringing the pods up/down, the PromQL queries
for the Prometheus UI, and load testing with `hey`.

**Architecture:**
```
browser :8082 ──► nginx :80 ──round-robin──► node-web-a-pod:8080 ─┐
                                          └─► node-web-b-pod:8080 ─┤
                                                                   ▼
                                                        mongo-db-pod:27017
Prometheus :9090 ──scrapes──► node-web-a-pod:8080 + node-web-b-pod:8080
```

---

## 1. Podman / kube commands

`podman kube play` runs k8s YAML, **but Podman is not Kubernetes** — keep these in mind:
- It **ignores Services** (no CoreDNS, no VIP). DNS resolves **pod names**, not Service names.
- It **ignores `replicas`** (caps at 1 container per Deployment) — that's why the web app is
  split into two Deployments (`node-web-a`, `node-web-b`).
- `--publish` lives on the **command**, not in the YAML.

### Build the image
```bash
podman build -t docker-demo-web:latest .    # tagged localhost/docker-demo-web:latest
```

### Bring the whole stack UP (order matters — mongo first)
```bash
podman kube play k8s/mongo-deployment.yaml
podman kube play k8s/web-deployment.yaml
podman kube play --publish 8082:80   k8s/nginx.yaml
podman kube play --publish 9090:9090 k8s/prometheus.yaml
```
- `--publish HOST:CONTAINER` — the two numbers mean different things:
  - **CONTAINER** (right) is fixed by the manifest — it *must* equal the `containerPort`
    the process listens on: nginx `80` (`listen 80;`), prometheus `9090`. Get it wrong and
    the publish points at a dead port.
  - **HOST** (left) is your free pick — the port you hit from the browser. `8082` is just
    a convenient choice for nginx; use anything unused.
  - So `8082:80` = "browser `localhost:8082` → nginx `:80` inside the pod".
- The web backends (`:8080`) are **not** published — nginx fronts them and Prometheus
  scrapes them by pod name; nothing outside needs a direct port.

### Fresh restart from scratch (nuke → rebuild → up)
Wipes all pods, rebuilds the image, then brings the stack up in the correct order.
```bash
podman pod rm -f -a                              # nuke everything
podman build -t docker-demo-web:latest .         # rebuild the web image
podman kube play k8s/mongo-deployment.yaml       # mongo first
podman kube play k8s/web-deployment.yaml         # then the two backends
podman kube play --publish 8082:80   k8s/nginx.yaml
podman kube play --publish 9090:9090 k8s/prometheus.yaml
```
> Mongo data in the `mongo-pvc` volume survives `pod rm`. To wipe it too:
> `podman volume rm mongo-pvc` (after the pods are down).

### Verify the stack is healthy
```bash
# Load balancing — should split evenly across the two backends:
for i in $(seq 1 8); do curl -s -D - -o /dev/null http://localhost:8082/ \
  | awk 'tolower($1)=="x-upstream:"{print $2}'; done | sort | uniq -c

# Prometheus scraping — both backends should report "1":
curl -s 'http://localhost:9090/api/v1/query?query=up{job="node-app"}'
```

### Check status
```bash
podman pod ls                                   # all pods + running state
podman logs node-web-a-pod-web                  # backend a logs
podman logs nginx-pod-nginx                      # nginx logs
```

### Tear the stack DOWN
```bash
# Clean, per-manifest:
podman kube down k8s/nginx.yaml
podman kube down k8s/web-deployment.yaml
podman kube down k8s/prometheus.yaml
podman kube down k8s/mongo-deployment.yaml

# Nuke everything at once:
podman pod rm -f -a

# Pause without deleting (restart later with `podman pod start -a`):
podman pod stop -a
```
> Mongo data lives in the `mongo-pvc` volume and survives pod removal.
> To wipe it too: `podman volume rm mongo-pvc`.

### ⚠️ Gotcha: editing a ConfigMap (nginx/prometheus config)
Editing the YAML and replaying is **NOT enough** — the old config stays mounted.
You must fully remove the pod first so `kube play` re-reads the file:
```bash
podman kube down k8s/prometheus.yaml
podman pod rm -f prometheus-pod                  # ensure it's gone
podman pod ls                                    # confirm — should NOT list it
podman kube play --publish 9090:9090 k8s/prometheus.yaml
# verify the new config actually mounted:
podman exec prometheus-pod-prometheus cat /etc/prometheus/prometheus.yml
```

### DNS sanity checks (the recurring pod-name-vs-Service trap)
```bash
podman exec nginx-pod-nginx getent hosts node-web-a-pod     # should resolve to an IP
podman exec prometheus-pod-prometheus getent hosts node-web-b-pod
```

### Prove load balancing at the nginx layer (response header)
```bash
for i in 1 2 3 4; do curl -s -D - -o /dev/null http://localhost:8082/ | grep -i x-upstream; done
# X-Upstream should alternate between the two backend IPs
```

---

## 2. PromQL queries (Prometheus UI → http://localhost:9090)

The app exposes a histogram `http_request_duration_seconds` (`server.js`), which yields
three series: `_count` (how many), `_sum` (total time), `_bucket{le=...}` (for percentiles).

### UI reminders
- **Left box** (e.g. `5m`, `15m`) = how WIDE the time window is.
- **Date box** = WHERE it ends. Click its `×` to snap to "now" (fixes "graph shows old data").
- Times in the UI are **UTC**. Turn on auto-refresh (top-right) to watch live during a test.
- Custom metrics only appear **after traffic** — generate some first.

### Run a query from the command line (no UI)
Hit the HTTP API directly — handy for scripting or a quick check. URL-encode the query
(`curl --data-urlencode` does this for you); pipe to `jq` to read the result.
```bash
# Instant query (value right now):
curl -s http://localhost:9090/api/v1/query \
  --data-urlencode 'query=up{job="node-app"}' | jq .

# Range query (values over a window — here last 5m, 15s step):
curl -s http://localhost:9090/api/v1/query_range \
  --data-urlencode 'query=sum(rate(http_request_duration_seconds_count[1m]))' \
  --data-urlencode "start=$(date -u -v-5M +%s)" \
  --data-urlencode "end=$(date -u +%s)" \
  --data-urlencode 'step=15' | jq .
```
> Any query below works as the `query=` value. `/query` = one point now; `/query_range` = a series.

### Health — are both backends up?
```promql
up{job="node-app"}
```
Two series, both = 1. Exists even with zero traffic → use this to confirm scraping works.

### Throughput — total requests/sec (all backends combined)
```promql
sum(rate(http_request_duration_seconds_count[1m]))
```

### Load balancing — per-backend requests/sec (TWO lines)
```promql
sum by (instance) (rate(http_request_duration_seconds_count[1m]))
```
Two lines rising together at ~half each = round-robin working under load.

### Load balancing — even-split proof (raw totals, use Table view)
```promql
sum by (instance) (http_request_duration_seconds_count)
```
Two near-equal totals (e.g. ~25k / ~25k) after a run = balanced.

### Traffic shape — break down by status code
```promql
sum by (status_code) (rate(http_request_duration_seconds_count[1m]))
```
200 = OK, 302 = redirect (create/edit/delete routes), 5xx = errors to watch.

### Break down by route
```promql
sum by (route) (rate(http_request_duration_seconds_count[1m]))
```

### Latency — average
```promql
rate(http_request_duration_seconds_sum[1m])
/
rate(http_request_duration_seconds_count[1m])
```

### Latency — p95 (the number that matters)
```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```

### Unit note
`rate(...)` is **per second**. A handful of requests / 60s ≈ 0.13 — small decimals are
normal at low traffic. Multiply by 60 for per-minute, or query the raw `_count` for totals.

---

## 3. Load testing with `hey`

`hey` is a single-binary HTTP load generator. Install natively (simplest):
```bash
brew install hey
```
(The `rakyll/hey` container image is unpublished; use `williamyeh/hey` if you must containerize.)

### Flags
- `-n <N>`  total number of requests
- `-c <N>`  concurrent "users" at a time
- `-z <dur>` run for a duration instead of a fixed count (e.g. `-z 30s`) — best for watching graphs

### Progression — turn the dial up to find the limit
```bash
hey -n 1000  -c 10  http://localhost:8082/       # gentle
hey -n 5000  -c 50  http://localhost:8082/       # moderate
hey -n 50000 -c 500 http://localhost:8082/       # stress
hey -z 30s   -c 300 http://localhost:8082/       # sustained 30s (watch graphs live)
```

### How to watch it
1. Prometheus UI, query: `sum by (instance) (rate(http_request_duration_seconds_count[1m]))`
2. Time range `5m`, clear the date box (`×`), enable auto-refresh `5s`.
3. Run a `hey` command → watch two lines spike together.

### Reading `hey` output
```
Requests/sec:  3312.91          ← throughput (matches the Prometheus sum(rate) line)
Average:       0.0144 secs      ← mean latency
  95% in 0.0387 secs            ← p95 (cross-check vs histogram_quantile query)
Status code distribution:
  [200] 2000 responses          ← all healthy; any non-2xx = something strained
```
Cross-check: `hey`'s reported p95 should ≈ the Prometheus `histogram_quantile(0.95, ...)` value.
If both agree, the measurement pipeline is honest.
