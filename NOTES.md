# Dev Notes — Podman + minikube

We migrated from **Docker (daemon + `docker` CLI)** to **Podman + minikube**.

**Mental model:**
- The **host** now uses `podman` to build images (instead of `docker`).
- **minikube** runs the local cluster using the **podman driver** (the VM runs as a podman container).
- Inside the minikube VM, the container runtime is still **docker** — that's why images must be *transferred in*, not shared.

The only genuinely new step vs. the old pure-Docker flow is **getting the image into minikube** (step 3). All `kubectl` usage is unchanged.

---

## 1. Start the cluster
```bash
minikube start          # boots the cluster (podman driver)
minikube status         # check it's Running
```

## 2. Build the image (`docker build` → `podman build`)
```bash
podman build -t docker-demo-web:latest .
```
⚠️ Podman auto-names it **`localhost/docker-demo-web:latest`** (it prepends `localhost/`).
The k8s manifest must use that exact name.

## 3. Get the image INTO minikube (the new step)
`eval $(minikube docker-env)` is **docker-only — do NOT use on podman.**
Ship the image in via a tarball:
```bash
podman save localhost/docker-demo-web:latest -o web.tar
minikube image load web.tar
rm web.tar
minikube image ls | grep docker-demo-web    # verify it landed
```
> Why a tarball? Host-podman and minikube's-docker are **separate image stores**.
> The tar is just the shipping container to move an image across that boundary.

## 4. Deploy (identical to Docker/K8s)
```bash
kubectl apply -f k8s/                              # apply all manifests
kubectl get pods                                   # watch status
kubectl get svc                                    # list services
kubectl logs -l app=node-web --tail=20             # app logs
kubectl rollout restart deployment/node-web-app    # redeploy after a new image
kubectl rollout status  deployment/node-web-app    # wait for it to finish
```

## 5. Access from the Mac
minikube services aren't on `localhost` automatically — forward them:
```bash
kubectl port-forward service/node-web-service   8081:8080   # app  -> localhost:8081
kubectl port-forward service/prometheus-service 9090:9090   # prom -> localhost:9090
```
Add `&` to run in background. They **die on logout/sleep** — just re-run to restore.

---

## Redeploy loop after a new build (the gotcha)
`:latest` won't refresh on its own. Full loop:
```bash
podman build -t docker-demo-web:latest .
podman save localhost/docker-demo-web:latest -o web.tar && minikube image load web.tar && rm web.tar
kubectl rollout restart deployment/node-web-app
```

---

## Docker -> Podman translation

| Old (Docker)                   | New (Podman + minikube)                                   |
| ------------------------------ | --------------------------------------------------------- |
| `docker build -t app .`        | `podman build -t app .` (-> tagged `localhost/app`)       |
| `docker run ...`               | k8s runs it — `kubectl apply`                             |
| `docker images`                | `podman images` (host) / `minikube image ls` (cluster)    |
| `eval $(minikube docker-env)`  | ❌ not for podman — use `podman save` + `minikube image load` |
| `docker ps`                    | `podman ps` (host) / `kubectl get pods` (cluster)         |
| `docker logs`                  | `kubectl logs -l app=<label>`                             |

---

## Things that broke on 2026-08-03 (and the fixes)
1. **App `ImagePullBackOff`** — image was never inside minikube. Built with podman, loaded via tarball.
   Since podman tags as `localhost/...`, updated `k8s/web-deployment.yaml` image name and added
   `imagePullPolicy: IfNotPresent`.
2. **Prometheus unreachable** — `prometheus-service` was never applied (pod ran, no Service routed to it).
   Fixed with `kubectl apply -f k8s/prometheus.yaml`.
3. **`localhost` access** — ClusterIP + podman driver aren't reachable from macOS; use `kubectl port-forward`.
4. **`nodePort: 9090` removed from prometheus.yaml was correct** — 9090 is below the valid NodePort
   range (30000–32767) and would be rejected. minikube auto-assigns one instead.
