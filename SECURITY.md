# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/kryptonhq/loupe/security/advisories/new)
on this repository. If that is unavailable to you, email the maintainers
listed in [MAINTAINERS.md](MAINTAINERS.md).

Please include what you were doing, what happened, and — if you have one
— a minimal reproduction. We will acknowledge your report and keep you
updated as we work on it.

## What is in scope

Loupe runs on your machine and talks to your clusters with your
credentials, so the interesting boundaries are:

- **Credential handling.** Loupe reads your kubeconfig in the Rust
  process and never passes tokens, certificates, or kubeconfig contents
  into the webview. Anything that leaks a credential into the frontend,
  into logs, or off the machine is a vulnerability.
- **The webview boundary.** The frontend is a bundled browser engine.
  Cluster data is rendered as text, never evaluated. A path where
  cluster-controlled content — a pod name, an annotation, a log line —
  results in code execution is a vulnerability.
- **The Tauri command surface.** Commands are the only way the frontend
  reaches the cluster. A command that does more than its name implies,
  or that can be induced to act on a resource the user did not choose,
  is a vulnerability.
- **Supply chain.** Issues in how we pin, fetch, or build dependencies.

## What is not in scope

- **Kubernetes RBAC denials.** Loupe acts as you. If the API server
  refuses a request, that is your cluster's policy working correctly.
- **Loupe showing you data you have access to.** It holds no permissions
  of its own and grants none.
- Vulnerabilities in Kubernetes itself — report those
  [upstream](https://kubernetes.io/docs/reference/issues-security/security/).
