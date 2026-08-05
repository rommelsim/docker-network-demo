# Learning roadmap — Docker & network topology

A study map for going from "this repo works" to "I understand every hop." Framed against
what this project already exercises, so you fill real gaps instead of re-reading basics.
See `RUNBOOK.md` for the Podman commands and `NOTES.md` for the older minikube flow.

---

## What this repo already teaches
- Container images & builds (`Dockerfile`), tagging
- Multi-container orchestration via `podman kube play`
- Reverse proxy + round-robin load balancing (nginx → two backends)
- Service discovery by pod name, port publishing (`HOST:CONTAINER`)
- Persistent volumes (`mongo-pvc`)
- Observability (Prometheus scrape + PromQL)

Roughly 60% of a real deployment. The rest is below.

---

## Docker / container gaps

### 1. Image craft
- **Layer caching** — `COPY package.json` before `COPY . .` so deps don't rebuild on every code change.
- **Multi-stage builds** — build in a fat image, ship a tiny runtime one (big win for Node/Go).
- **Image size & security** — `alpine` vs `distroless`, `.dockerignore`, don't run as root (`USER node`).
- **`CMD` vs `ENTRYPOINT`**, and `EXPOSE` (documentation only, ≠ publish).

### 2. Data & config
- **Volumes vs bind mounts** — named volumes (our `mongo-pvc`) vs `-v $(pwd):/app` for live dev.
- **Secrets** — the Mongo URI is plaintext env in `web-deployment.yaml`; learn how *not* to do that.
- **Healthchecks** — `HEALTHCHECK` / k8s liveness+readiness probes. Our stack has none, which is
  why "mongo first" is a manual ordering step instead of automatic.

### 3. Docker vs Podman
We're on Podman and already hit its quirks (ignores Services, ignores `replicas`). Know *why*:
daemonless, rootless, no VIP / kube-proxy. Understanding this sharpens what Kubernetes actually adds.

---

## Networking / topology

### The layered mental model (this stack touches every layer)
| Layer            | In this repo         | Master this                              |
|------------------|----------------------|------------------------------------------|
| L2/L3            | pod IPs              | subnets, CIDR, `10.x` ranges             |
| Container net    | pod-to-pod DNS       | bridge vs host vs none vs overlay        |
| L4 (transport)   | `:8080`, `:27017`    | TCP/UDP, ports, NAT, connection state    |
| L7 (application) | nginx routing        | HTTP, headers, host-based routing, TLS   |
| DNS              | `node-web-a-pod`     | resolution order, CoreDNS, `/etc/hosts`  |

### Concrete next steps
1. **Docker network drivers** — `docker network create`; why containers on a user-defined
   network resolve each other by name (vs the legacy default bridge that doesn't). This is the
   "pod-name DNS" behavior we already rely on, generalized.
2. **Load balancing depth** — we have L7 round-robin. Learn L4 vs L7 LB, health-check-aware
   balancing, sticky sessions, and how a real LB (or k8s Service + kube-proxy) differs from nginx.
3. **NAT & port publishing internals** — what `--publish` actually does (iptables/nftables DNAT).
   Explains why the CONTAINER port must equal the process's `listen` port.
4. **TLS / HTTPS** — the glaring absence. Terminate TLS at nginx, certs, `:443`. Real edges have this.
5. **The full request path** — trace one browser request end-to-end:
   `DNS → TCP handshake → NAT → nginx → upstream selection → backend → Mongo`.
   If you can narrate every hop in *this* stack, you understand topology.

---

## Graduation: real Kubernetes
Podman taught the shapes but faked the substance. Move the same manifests to `kind` / `minikube`
to get what Podman *ignored*:
- **Services** — stable VIP + CoreDNS (no more pod-name-only DNS).
- **Real replicas / scaling** — `replicas: N` actually honored.
- **Ingress** — what nginx is currently faking.
- **NetworkPolicies** — firewalling between pods.

The RUNBOOK's "Podman is not Kubernetes" framing becomes the payoff.

---

## Hands-on experiments to try in this repo
- Add a **multi-stage build** + **healthchecks** to the web image.
- Put **TLS** on nginx (self-signed cert, `:443`).
- Spin the manifests up on **real `kind`** to watch Services actually work.
- Trace and document the **full request path** with `tcpdump` / `curl -v` at each hop.
